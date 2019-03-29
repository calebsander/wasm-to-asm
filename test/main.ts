import {strict as assert} from 'assert'
import * as childProcess from 'child_process'
import * as fs from 'fs'
import {promisify} from 'util'
import {parse, SExpression} from './parse-s'

const CC = 'clang'
const TESTS = ['fac']
const FUNC_NAME = /^"(.+)"$/

const execFile = promisify(childProcess.execFile),
      readFile = promisify(fs.readFile),
      writeFile = promisify(fs.writeFile)

function getValue({op, args}: SExpression) {
	switch (op) {
		case 'i64.const':
			assert.equal(args.length, 1)
			const [arg] = args
			assert.equal(arg.args.length, 0)
			return arg.op + 'L'
		default:
			throw new Error('Unknown value type: ' + op)
	}
}

;(async () => {
	const results = await Promise.all(TESTS.map(async test => {
		const wastPath = `${__dirname}/spec/test/core/${test}.wast`
		const testFile = await readFile(wastPath, 'utf8')
		const assertsStart = testFile.indexOf('(assert')
		if (assertsStart < 0) throw new Error(`Test file ${wastPath} does not have asserts`)

		const modulePath = wastPath.replace('.wast', '-module.wast')
		await writeFile(modulePath, testFile.slice(0, assertsStart))
		const wasmPath = wastPath.replace('.wast', '.wasm')
		try {
			await execFile(__dirname + '/wabt/bin/wat2wasm', [modulePath, '-o', wasmPath])
		}
		catch (e) {
			console.error(e)
			return
		}
		try { await execFile(__dirname + '/../main.js', [wasmPath]) }
		catch (e) {
			console.error(e)
			return
		}

		let cFile = `
			#include <assert.h>
			#include "${test}.h"

			int main() {
		`
		let asserts = testFile.slice(assertsStart)
		let count = 0
		while (asserts = asserts.trim()) {
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
					const funcName = `wasm_${test}_${funcNameMatch[1].replace(/-/g, '_')}`
					cFile += `
						assert(${funcName}(${args.map(getValue).join(', ')}) == ${getValue(expected)});
					`
					break
				case 'assert_exhaustion':
					processed = false
					break
				default:
					throw new Error('Unknown assertion type: ' + result.op)
			}
			if (processed) count++
			asserts = rest
		}
		cFile += `
			}
		`
		const sFilePath = wasmPath.replace('.wasm', '.s'),
		      cFilePath = sFilePath.replace('.s', '-test.c'),
		      runPath = cFilePath.replace('.c', '')
		await writeFile(cFilePath, cFile)
		try { await execFile(CC, [sFilePath, cFilePath, '-o', runPath]) }
		catch (e) {
			console.error(e)
			return
		}

		try {
			await execFile(runPath)
			return {count}
		}
		catch (e) {
			console.error(e)
			return
		}
	}))

	let passes = 0
	TESTS.forEach((test, i) => {
		const result = results[i]
		if (result) {
			const {count} = result
			console.log(test, `PASS ${count} test${count === 1 ? '' : 's'}`)
			passes++
		}
		else console.log(test, 'FAIL')
	})
	console.log(`${passes} of ${TESTS.length} tests passed (${Math.floor(passes / TESTS.length * 100)}%)`)
	process.exit(TESTS.length - passes)
})()