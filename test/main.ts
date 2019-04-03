import {strict as assert} from 'assert'
import * as childProcess from 'child_process'
import * as fs from 'fs'
import {promisify} from 'util'
import {INVALID_EXPORT_CHAR} from '../compile-code'
import {parse, SExpression} from './parse-s'

const CC = 'gcc', C_STD = '-std=c11'
const SUCCESS = 'success'
const TESTS = [
	'address',
	'endianness',
	'fac',
	'forward',
	'i32',
	'i64',
	'int_exprs'
]
const FUNC_NAME = /^"(.+)"$/

const exec = promisify(childProcess.exec),
      execFile = promisify(childProcess.execFile),
      readFile = promisify(fs.readFile),
      writeFile = promisify(fs.writeFile)

async function compileTest(test: string, ...ccArgs: string[]) {
	const baseFile = `${__dirname}/${test}`
	const wasmFile = baseFile + '.wasm'
	await execFile(__dirname + '/wabt/bin/wat2wasm', [baseFile + '.wast', '-o', wasmFile])
	await execFile('node', [__dirname + '/../main.js', wasmFile])
	const runPath = baseFile + '-test'
	await execFile(CC, [C_STD, baseFile + '.s', runPath + '.c', '-o', runPath, ...ccArgs])
	return {baseFile, runPath}
}
async function fibTest() {
	const test = 'fib'
	try {
		const {baseFile, runPath} = await compileTest(test)
		await exec(`${runPath} | diff ${baseFile}-expected.txt -`)
	}
	catch (e) {
		console.error(e)
		return {test}
	}

	return {test, testCount: 1}
}
async function sha256Test() {
	const test = 'sha256'
	try {
		const {runPath} = await compileTest(test, '-lcrypto')
		await execFile(runPath)
	}
	catch (e) {
		console.error(e)
		return {test}
	}

	return {test, testCount: 1}
}

function getValue({op, args}: SExpression) {
	switch (op) {
		case 'i32.const':
		case 'i64.const':
		case 'f32.const':
		case 'f64.const': {
			assert.equal(args.length, 1)
			const [arg] = args
			assert.equal(arg.args.length, 0)
			let value = arg.op
			if (op === 'i64.const') value += 'L'
			else if (op[0] === 'f') {
				try {
					BigInt(value)
					value += '.'
				}
				catch {}
				if (op === 'f32.const') value += 'F'
			}
			return value
		}
		default:
			throw new Error('Unknown value type: ' + op)
	}
}

(async () => {
	const results = await Promise.all(TESTS.map(async test => {
		const wastPath = `${__dirname}/spec/test/core/${test}.wast`
		let testFile = await readFile(wastPath, 'utf8')
		let assertsStart: number
		let testCount = 0
		while ((assertsStart = testFile.indexOf('(assert')) >= 0) {
			const modulePath = wastPath.replace('.wast', '-module.wast')
			await writeFile(modulePath, testFile.slice(0, assertsStart))
			const wasmPath = wastPath.replace('.wast', '.wasm')
			try {
				await execFile(__dirname + '/wabt/bin/wat2wasm', [modulePath, '-o', wasmPath])
				await execFile('node', [__dirname + '/../main.js', wasmPath])
			}
			catch (e) {
				console.error(e)
				return {test}
			}

			let cFile = `
				#include <assert.h>
				#include <math.h>
				#include <stdio.h>
				#include "${test}.h"

				int main() {
			`
			const hFilePath = wasmPath.replace('.wasm', '.h')
			const headerFile = await readFile(hFilePath, 'utf8')
			const initFunction = `wasm_${test}_init`
			const hasInit = headerFile.includes(`void ${initFunction}(void);`)
			if (hasInit) cFile += initFunction + '();\n'
			const nextModule = testFile.indexOf('\n(module', assertsStart)
			let asserts = nextModule < 0
				? testFile.slice(assertsStart)
				: testFile.slice(assertsStart, nextModule)
			while (asserts.startsWith('(assert')) {
				const {result, rest} = parse(asserts)
				let processed = true
				switch (result.op) {
					case 'assert_return':
						const [invoke, expected] = result.args
						assert.equal(invoke.op, 'invoke')
						const [func, ...args] = invoke.args
						assert.equal(func.args.length, 0)
						const funcNameMatch = FUNC_NAME.exec(func.op)
						if (!funcNameMatch) throw new Error('Not a funtion name: ' + func.op)
						const funcName =
							`wasm_${test}_${funcNameMatch[1].replace(INVALID_EXPORT_CHAR, '_')}`
						const functionCall = `${funcName}(${args.map(getValue).join(', ')})`
						const value = getValue(expected)
						cFile += value.startsWith('nan')
							? `assert(isnan(${functionCall}));\n`
							: `assert(${functionCall} == ${value});\n`
						break
					case 'assert_exhaustion':
					case 'assert_invalid':
					case 'assert_malformed':
					case 'assert_trap':
						processed = false
						break
					default:
						throw new Error('Unknown assertion type: ' + result.op)
				}
				if (processed) testCount++
				asserts = rest.trim()
			}
			cFile += `
					printf("${SUCCESS}");
				}
			`
			testFile = testFile.slice(nextModule)
			const sFilePath = hFilePath.replace('.h', '.s'),
			      cFilePath = sFilePath.replace('.s', '-test.c'),
			      runPath = cFilePath.replace('.c', '')
			await writeFile(cFilePath, cFile)
			try {
				await execFile(CC, [C_STD, sFilePath, cFilePath, '-o', runPath])
				const {stdout} = await execFile(runPath)
				if (stdout !== SUCCESS) throw new Error('Unexpected output:\n' + stdout)
			}
			catch (e) {
				console.error(e)
				return {test}
			}
		}
		return {test, testCount}
	}).concat([
		fibTest(),
		sha256Test()
	]))

	let passes = 0
	for (const {test, testCount} of results) {
		if (testCount) {
			console.log(test, `PASS ${testCount} test${testCount === 1 ? '' : 's'}`)
			passes++
		}
		else console.log(test, 'FAIL')
	}
	const testsCount = results.length
	console.log(`${passes} of ${testsCount} tests passed (${Math.floor(passes / testsCount * 100)}%)`)
	process.exit(testsCount - passes)
})()