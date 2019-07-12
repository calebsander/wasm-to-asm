import * as childProcess from 'child_process'
import * as fs from 'fs'
import {promisify} from 'util'
import {INVALID_EXPORT_CHAR} from '../compile/conventions'
import {parse, SExpression} from './parse-s'

const CC = 'gcc', C_STD = '-std=c11'
const C_NAN = 'NAN'
const SUCCESS = 'success'
const TESTS = [
	'address',
	'block',
	'br',
	'br_if',
	'br_table',
	'break-drop',
	'call',
	'call_indirect',
	// 'conversions', requires support for nan:0x123abc expressions
	'endianness',
	'f32',
	'f32_bitwise',
	'f32_cmp',
	'f64',
	'f64_bitwise',
	'f64_cmp',
	'fac',
	'float_exprs',
	// 'float_memory', requires support for nan:0x123abc expressions
	'float_misc',
	'forward',
	'func',
	'globals',
	'i32',
	'i64',
	'if',
	'int_exprs',
	'int_literals',
	'labels',
	'left-to-right',
	'load',
	'local_get',
	'local_set',
	'local_tee',
	'loop',
	'memory',
	'memory_grow',
	'memory_redundancy',
	'memory_size',
	'memory_trap',
	'nop',
	'return',
	'select',
	'stack',
	'store',
	'switch',
	'unwind'
]
const FUNC_NAME = /^"(.+)"$/
const TESTS_START = /\n\((?:assert_return|assert_trap|invoke)/

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
function checkSuccessOutput({stdout}: {stdout: string}) {
	if (stdout !== SUCCESS) throw new Error('Unexpected output:\n' + stdout)
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
		checkSuccessOutput(await execFile(runPath))
	}
	catch (e) {
		console.error(e)
		return {test}
	}

	return {test, testCount: 1}
}
async function trigTest() {
	const test = 'trig'
	try {
		const {runPath} = await compileTest(test, '-lm')
		checkSuccessOutput(await execFile(runPath))
	}
	catch (e) {
		console.error(e)
		return {test}
	}

	return {test, testCount: 2}
}

function getValue(expression: SExpression) {
	if (expression.type === 'atom') {
		throw new Error('Invalid expression: ' + JSON.stringify(expression))
	}
	let [op, value] = expression.items.map(item => {
		if (item.type !== 'atom') {
			throw new Error('Invalid expression: ' + JSON.stringify(expression))
		}
		return item.atom
	})
	switch (op) {
		case 'i32.const':
		case 'i64.const':
		case 'f32.const':
		case 'f64.const': {
			value = value.replace(/_/g, '')
			if (value === 'inf' || value === '-inf') {
				return value.replace('inf', 'INFINITY')
			}
			if (value.startsWith('nan')) return C_NAN
			if (value.startsWith('-nan')) return '-' + C_NAN

			if (op === 'i64.const') value += 'L'
			else if (op[0] === 'f') {
				try {
					BigInt(value)
					value += (value.startsWith('0x') ? 'p' : 'e') + '0'
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
		let assertStartMatch: RegExpMatchArray | null
		let testCount = 0
		while (assertStartMatch = TESTS_START.exec(testFile)) {
			const assertsStart = assertStartMatch.index!
			const modulePath = wastPath.replace('.wast', '-module.wast')
			const nextModule = testFile.indexOf('\n(module', testFile.indexOf('(module'))
			if (nextModule >= 0 && nextModule < assertsStart) { // no asserts to test
				testFile = testFile.slice(nextModule)
				continue
			}
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
			const initFunction = `wasm_${test.replace(INVALID_EXPORT_CHAR, '_')}_init_module`
			const hasInit = headerFile.includes(`void ${initFunction}(void);`)
			if (hasInit) cFile += initFunction + '();\n'
			let asserts = nextModule < 0
				? testFile.slice(assertsStart)
				: testFile.slice(assertsStart, nextModule)
			makeTests: while (TESTS_START.test(asserts)) {
				const {result, rest} = parse(asserts)
				if (result.type === 'atom') throw new Error('Not a test: ' + JSON.stringify(result))
				const [op, ...args] = result.items
				if (op.type !== 'atom') throw new Error('Not a test: ' + JSON.stringify(result))
				let processed = true
				switch (op.atom) {
					case 'module':
						break makeTests
					case 'assert_return':
					case 'invoke':
						let invoke: SExpression, expected: SExpression | undefined
						if (op.atom === 'invoke') invoke = result
						else [invoke, expected] = args as [SExpression, SExpression?]
						if (invoke.type === 'atom') throw new Error('Expected an invocation')
						const [invokeOp, func, ...funcArgs] = invoke.items
						if (!(invokeOp.type === 'atom' && invokeOp.atom === 'invoke') || func.type === 'list') {
							throw new Error('Expected an invocation')
						}
						const funcNameMatch = FUNC_NAME.exec(func.atom)
						if (!funcNameMatch) throw new Error('Not a function name: ' + func.atom)
						const funcName =
							`wasm_${test}_${funcNameMatch[1]}`.replace(INVALID_EXPORT_CHAR, '_')
						const functionCall = `${funcName}(${funcArgs.map(getValue).join(', ')})`
						if (expected) {
							const value = getValue(expected)
							cFile += value.includes(C_NAN)
								? `assert(isnan(${functionCall}));\n`
								: `assert(${functionCall} == ${value});\n`
						}
						else cFile += functionCall + ';\n'
						break
					case 'assert_exhaustion':
					case 'assert_invalid':
					case 'assert_malformed':
					case 'assert_return_arithmetic_nan':
					case 'assert_return_canonical_nan':
					case 'assert_trap':
						processed = false
						break
					default:
						throw new Error('Unknown assertion type: ' + op.atom)
				}
				if (processed) testCount++
				asserts = rest
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
				checkSuccessOutput(await execFile(runPath))
			}
			catch (e) {
				console.error(e)
				return {test}
			}
		}
		return {test, testCount}
	}).concat([
		fibTest(),
		sha256Test(),
		trigTest()
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