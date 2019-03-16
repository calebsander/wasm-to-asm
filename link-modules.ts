import {Section} from './parse-module'
import {compileModule, ModuleIndices} from './compile-code'

export interface NamedModules {
	[name: string]: Section[]
}
interface CompiledModuleString {
	assembly: string
	header: string
}
interface CompiledModules {
	[name: string]: CompiledModuleString
}

const makeString = (elements: {str: string}[]): string =>
	elements.map(instruction => instruction.str + '\n').join('')

export function linkModules(modules: NamedModules) {
	const moduleIndices: ModuleIndices = {}
	let moduleIndex = 0
	for (const module in modules) moduleIndices[module] = moduleIndex
	const compiledModules: CompiledModules = {}
	for (const module in modules) {
		const {instructions, declarations} = compileModule({
			module: modules[module],
			index: moduleIndices[module],
			moduleIndices,
			moduleName: module
		})
		compiledModules[module] = {
			assembly: makeString(instructions),
			header: makeString(declarations)
		}
	}
	return compiledModules
}