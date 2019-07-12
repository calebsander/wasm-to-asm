#!/usr/bin/env node

import * as fs from 'fs'
import * as path from 'path'
import {promisify} from 'util'
import {linkModules, NamedModules} from './link-modules'
import {parseModule} from './parse/module'

const WASM_EXTENSION = '.wasm',
      ASM_EXTENSION = '.s',
      HEADER_EXTENSION = '.h'

const readFile = promisify(fs.readFile),
      writeFile = promisify(fs.writeFile)

interface ModuleFiles {
	[module: string]: string
}

(async () => {
	const modules = await Promise.all(process.argv.slice(2).map(async file => {
		if (!file.endsWith(WASM_EXTENSION)) {
			throw new Error(`File ${file} is not a .wasm file`)
		}

		const wasm = await readFile(file)
		const dataView = new DataView(wasm.buffer, wasm.byteOffset, wasm.byteLength)
		return {file, module: parseModule(dataView).value}
	}))
	const namedModules: NamedModules = {}
	const files: ModuleFiles = {}
	for (const {file, module} of modules) {
		const baseFile = file.slice(0, -WASM_EXTENSION.length)
		const name = path.basename(baseFile)
		namedModules[name] = module
		files[name] = baseFile
	}
	const compiledModules = linkModules(namedModules)
	await Promise.all(Object.keys(compiledModules).map(name => {
		const {assembly, header} = compiledModules[name]
		const baseFile = files[name]
		return Promise.all([
			writeFile(baseFile + ASM_EXTENSION, assembly),
			writeFile(baseFile + HEADER_EXTENSION, header)
		])
	}))
})().catch(e => {
	console.error(e)
	process.exit(1)
})