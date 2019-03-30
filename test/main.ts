import {strict as assert} from 'assert'
import * as childProcess from 'child_process'
import * as fs from 'fs'
import {promisify} from 'util'
import {INVALID_EXPORT_CHAR} from '../compile-code'
import {parse, SExpression} from './parse-s'

const CC = 'gcc'
const TESTS = [
	// 'address', won't work until f32 and f64 support is implemented
	'fac',
	'forward',
	'i32',
	'i64',
	'int_exprs'
]
const FUNC_NAME = /^"(.+)"$/

const execFile = promisify(childProcess.execFile),
      readFile = promisify(fs.readFile),
      writeFile = promisify(fs.writeFile)

function getValue({op, args}: SExpression) {
	switch (op) {
		case 'i32.const':
		case 'i64.const': {
			assert.equal(args.length, 1)
			const [arg] = args
			assert.equal(arg.args.length, 0)
			return op === 'i32.const' ? arg.op : arg.op + 'L'
		}
		default:
			throw new Error('Unknown value type: ' + op)
	}
}

;(async () => {
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
						cFile += `
							assert(${funcName}(${args.map(getValue).join(', ')}) == ${getValue(expected)});
						`
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
				}
			`
			testFile = testFile.slice(nextModule)
			const sFilePath = hFilePath.replace('.h', '.s'),
			      cFilePath = sFilePath.replace('.s', '-test.c'),
			      runPath = cFilePath.replace('.c', '')
			await writeFile(cFilePath, cFile)
			try { await execFile(CC, ['-g', sFilePath, cFilePath, '-o', runPath]) }
			catch (e) {
				console.error(e)
				return
			}

			try { await execFile(runPath) }
			catch (e) {
				console.error(e)
				return
			}
		}
		return {testCount}
	}))

	let passes = 0
	TESTS.forEach((test, i) => {
		const result = results[i]
		if (result) {
			const {testCount} = result
			console.log(test, `PASS ${testCount} test${testCount === 1 ? '' : 's'}`)
			passes++
		}
		else console.log(test, 'FAIL')
	})
	console.log(`${passes} of ${TESTS.length} tests passed (${Math.floor(passes / TESTS.length * 100)}%)`)
	process.exit(TESTS.length - passes)
})()