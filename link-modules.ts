import {Section} from './parse/module'
import {ModuleIndices} from './compile/context'
import {compileModule} from './compile/module'

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
interface Stringable {
	readonly str: string
}

const makeString = (elements: Stringable[]): string =>
	elements.map(({str}) => str + '\n').join('')

export function linkModules(modules: NamedModules): CompiledModules {
	const moduleIndices: ModuleIndices = {}
	let moduleIndex = 0
	for (const moduleName in modules) moduleIndices[moduleName] = moduleIndex
	const compiledModules: CompiledModules = {}
	for (const moduleName in modules) {
		const {instructions, declarations} = compileModule({
			module: modules[moduleName],
			index: moduleIndices[moduleName],
			moduleIndices,
			moduleName: moduleName
		})
		compiledModules[moduleName] = {
			assembly: makeString(instructions),
			header: makeString(declarations)
		}
	}
	return compiledModules
}