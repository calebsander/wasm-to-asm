import * as childProcess from 'child_process'
import * as fs from 'fs'
import {promisify} from 'util'
import test, {ExecutionContext} from 'ava'
import {INVALID_EXPORT_CHAR} from '../compile/conventions'
import {parse, SExpression} from './parse-s'

process.chdir(__dirname)

const CC = 'clang'
const OPENSSL_CFLAGS = [
	'-I/usr/local/opt/openssl/include',
	'-L/usr/local/opt/openssl/lib',
	'-lcrypto'
]
const C_NAN = 'NAN'
const SUCCESS = 'success'
const SPEC_TESTS = [
	'align',
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
	'global',
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
const PROGRAM_TESTS = [
	{name: 'sha256', flags: OPENSSL_CFLAGS},
	{name: 'trig', flags: ['-lm']},
	{name: 'params', flags: []}
]
const FUNC_NAME = /^"(.+)"$/
const TESTS_START = /\n\((?:assert_return|assert_trap|invoke)/
const C_FILE_START = (test: string) => `
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "${test}.h"

int main() {
`
const C_FILE_END = `
	puts("${SUCCESS}");
}
`

const exec = promisify(childProcess.exec),
      execFile = promisify(childProcess.execFile),
      readFile = promisify(fs.readFile),
      writeFile = promisify(fs.writeFile)

async function compileTest(test: string, ...ccArgs: string[]): Promise<string> {
	const wasmFile = test + '.wasm'
	await execFile('wabt/bin/wat2wasm', [test + '.wast', '-o', wasmFile])
	await execFile('node', ['../main.js', wasmFile])
	const runPath = test + '-test'
	await execFile(CC, [test + '.s', runPath + '.c', '-o', runPath, ...ccArgs])
	return './' + runPath
}
const checkSuccessOutput = (t: ExecutionContext, {stdout}: {stdout: string}) =>
	t.is(stdout, SUCCESS + '\n', 'Unexpected output:\n' + stdout)
const exportName = (name: string): string => name.replace(INVALID_EXPORT_CHAR, '_')
function getValue(expression: SExpression): string {
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

for (const testName of SPEC_TESTS) {
	test(testName, async t => {
		const wastPath = `spec/test/core/${testName}.wast`
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
			await execFile('wabt/bin/wat2wasm', [modulePath, '-o', wasmPath])
			await execFile('node', ['../main.js', wasmPath])

			let cFile = C_FILE_START(testName)
			const hFilePath = wasmPath.replace('.wasm', '.h')
			const headerFile = await readFile(hFilePath, 'utf8')
			const initFunction = `wasm_${exportName(testName)}_init_module`
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
				let processed: boolean
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
						const funcName = exportName(`wasm_${testName}_${funcNameMatch[1]}`)
						const functionCall = `${funcName}(${funcArgs.map(getValue).join(', ')})`
						if (expected) {
							const value = getValue(expected)
							cFile += value.includes(C_NAN)
								? `\tassert(isnan(${functionCall}));\n`
								: `\tassert(${functionCall} == ${value});\n`
						}
						else cFile += functionCall + ';\n'
						processed = true
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
			cFile += C_FILE_END
			testFile = testFile.slice(nextModule)
			const sFilePath = hFilePath.replace('.h', '.s'),
			      cFilePath = sFilePath.replace('.s', '-test.c'),
			      runPath = cFilePath.replace('.c', '')
			await writeFile(cFilePath, cFile)
			await execFile(CC, [sFilePath, cFilePath, '-o', runPath])
			checkSuccessOutput(t, await execFile(runPath))
		}
		t.log(`Passed ${testCount} tests`)
	})
}

test('fib', async t => {
	const {title} = t
	const runPath = await compileTest(title)
	await exec(`${runPath} | diff ${title}-expected.txt -`)
	t.pass()
})
for (const {name, flags} of PROGRAM_TESTS) {
	test(name, async t => {
		const runPath = await compileTest(name, ...flags)
		checkSuccessOutput(t, await execFile(runPath))
	})
}