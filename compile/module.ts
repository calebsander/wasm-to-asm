import {Instruction} from '../parse/instruction'
import {FunctionType, MemoryInitializer, Section, TableInitializer} from '../parse/module'
import {ValueType} from '../parse/value-type'
import {reverse} from '../util'
import {compileInstructions} from './instructions'
import {FunctionDeclaration, getCType, GlobalDeclaration, HeaderDeclaration} from './c-header'
import {CompilationContext, getFunctionStats, ModuleContext, ModuleIndices} from './context'
import {
	INT_INTERMEDIATE_REGISTERS,
	INVALID_EXPORT_CHAR,
	SYSV_CALLEE_SAVE_REGISTERS,
	SYSV_CALLEE_SAVE_SET,
	SYSV_FLOAT_PARAM_REGISTERS,
	SYSV_INT_PARAM_REGISTERS
} from './conventions'
import {growStack, popResultAndUnwind, relocateArguments, shrinkStack} from './helpers'
import * as asm from './x86_64-asm'

interface GlobalDirective {
	align: asm.Directive
	data: asm.Directive
}
const WASM_TYPE_DIRECTIVES = new Map<ValueType, GlobalDirective>([
	['i32', {
		align: new asm.Directive({type: 'balign', args: [4]}),
		data: new asm.Directive({type: 'long', args: [0]})
	}],
	['i64', {
		align: new asm.Directive({type: 'balign', args: [8]}),
		data: new asm.Directive({type: 'quad', args: [0]})
	}]
])
WASM_TYPE_DIRECTIVES.set('f32', WASM_TYPE_DIRECTIVES.get('i32')!)
WASM_TYPE_DIRECTIVES.set('f64', WASM_TYPE_DIRECTIVES.get('i64')!)

export interface Module {
	module: Section[]
	index: number
	moduleIndices: ModuleIndices
	moduleName: string
}
interface ParsedModule {
	context: ModuleContext
	moduleName: string
	tableLengths: number[]
	memoryMin?: number
	memoryInitializers: MemoryInitializer[]
	globalInitializers: Instruction[][]
	tableInitializers: TableInitializer[]
	startFunction?: number
	functionTypes: FunctionType[]
	functionBodies: Instruction[][]
}
export interface CompiledModule {
	instructions: asm.AssemblyInstruction[]
	declarations: HeaderDeclaration[]
}

export function parseSections({module, index, moduleIndices, moduleName}: Module): ParsedModule {
	const context = new ModuleContext(index, moduleIndices)
	const functionTypes: FunctionType[] = []
	const functionLocals: ValueType[][] = []
	const tableLengths: number[] = []
	let memoriesCount = 0
	let memoryMin: number | undefined
	const memoryInitializers: MemoryInitializer[] = []
	const globalInitializers: Instruction[][] = []
	const tableInitializers: TableInitializer[] = []
	let startFunction: number | undefined
	const functionBodies: Instruction[][] = []
	for (const section of module) {
		switch (section.type) {
			case 'type':
				context.addTypes(section.types)
				break
			case 'import':
				context.addImports(section.imports)
				break
			case 'function':
				for (const index of section.typeIndices) {
					functionTypes.push(context.getType(index))
				}
				break
			case 'table':
				for (const {min} of section.tables) tableLengths.push(min)
				break
			case 'memory':
				const {memories} = section
				memoriesCount += memories.length
				if (!memoriesCount) break
				if (memoriesCount > 1) throw new Error('Multiple memories')
				const [{min, max}] = memories
				memoryMin = min
				context.setMemoryMax(max)
				break
			case 'global':
				const {globals} = section
				context.addGlobals(globals)
				for (const {initializer} of globals) {
					globalInitializers.push(initializer)
				}
				break
			case 'export':
				context.addExports(section.exports)
				break
			case 'start':
				startFunction = section.functionIndex
				break
			case 'element':
				tableInitializers.push(...section.initializers)
				break
			case 'code':
				for (const {locals, instructions} of section.segments) {
					functionLocals.push(locals)
					functionBodies.push(instructions)
				}
				break
			case 'data':
				memoryInitializers.push(...section.initializers)
		}
	}
	if (functionTypes.length !== functionLocals.length) {
		throw new Error('Mismatched function counts')
	}
	functionTypes.forEach((type, i) =>
		context.setFunctionStats(i, getFunctionStats(type, functionLocals[i]))
	)
	return {
		context,
		moduleName,
		tableLengths,
		memoryMin,
		memoryInitializers,
		globalInitializers,
		tableInitializers,
		startFunction,
		functionTypes,
		functionBodies
	}
}

function addExportLabel(label: string, output: asm.AssemblyInstruction[]) {
	output.push(
		new asm.Directive({type: 'globl', args: [label]}),
		new asm.Label(label)
	)
}
function addSysvLabel(module: string, label: string, output: asm.AssemblyInstruction[]) {
	const sysvLabel = `wasm_${module.replace(INVALID_EXPORT_CHAR, '_')}_${label}`
	addExportLabel(sysvLabel, output)
	return sysvLabel
}

const TABLE_ITEM = new asm.Directive({type: 'quad', args: [0]})
function compileGlobals(
	{context, moduleName, tableLengths, memoryMin}: ParsedModule,
	output: asm.AssemblyInstruction[],
	declarations: HeaderDeclaration[]
) {
	tableLengths.forEach((length, i) => {
		output.push(new asm.Label(context.tableLabel(i)))
		while (length--) output.push(TABLE_ITEM)
	})

	if (memoryMin !== undefined) {
		const {exportMemory, memorySizeLabel, memoryStart} = context
		if (exportMemory.length) {
			for (const label of exportMemory) {
				const exportLabel = `wasm_${moduleName}_${label}_memory`
				addExportLabel(exportLabel, output)
				declarations.push(new GlobalDeclaration('pointer', true, exportLabel))
			}
			// 8-byte align not necessary
			output.push(new asm.Directive({type: 'quad', args: [memoryStart]}))
		}
		for (const label of exportMemory) {
			const exportLabel = `wasm_${moduleName}_${label}_size`
			addExportLabel(exportLabel, output)
			declarations.push(new GlobalDeclaration('int', true, exportLabel))
		}
		// 4-byte align not necessary
		output.push(
			new asm.Label(memorySizeLabel),
			new asm.Directive({type: 'long', args: [0]})
		)
	}

	const {globalTypes, exportGlobals} = context
	globalTypes.forEach(({type, mutable}, i) => {
		const directives = WASM_TYPE_DIRECTIVES.get(type)
		if (!directives) throw new Error('Unable to emit global of type ' + type)
		output.push(directives.align)
		for (const label of exportGlobals.get(i) || []) {
			addExportLabel(context.exportLabel('GLOBAL', label), output)
			const headerLabel = `wasm_${moduleName}_${label}`
			addExportLabel(headerLabel, output)
			declarations.push(new GlobalDeclaration(getCType(type), !mutable, headerLabel))
		}
		output.push(
			new asm.Label(context.globalLabel(i)),
			directives.data
		)
	})
}

function compileMemoryInitializer(
	{memoryIndex, offset, data}: MemoryInitializer,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	if (memoryIndex) throw new Error('Invalid memory index')
	const {byteLength} = data
	const dataView = new DataView(data)
	let byte = 0
	while (true) { // store 8 bytes at a time
		const nextIndex = byte + 8
		if (nextIndex > byteLength) break

		compileInstructions(offset, context, output)
		compileInstructions([
			{type: 'i64.const', value: dataView.getBigUint64(byte, true)},
			{type: 'i64.store', access: {align: 0, offset: byte}}
		], context, output)
		byte = nextIndex
	}
	while (byte < byteLength) {
		compileInstructions(offset, context, output)
		compileInstructions([
			{type: 'i32.const', value: dataView.getUint8(byte)},
			{type: 'i32.store8', access: {align: 0, offset: byte}}
		], context, output)
		byte++
	}
}
function compileTableInitializer(
	{tableIndex, offset, functionIndices}: TableInitializer,
	moduleContext: ModuleContext,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	compileInstructions(offset, context, output)
	const tableRegister = INT_INTERMEDIATE_REGISTERS[0]
	output.push(new asm.LeaInstruction(
		{type: 'label', label: moduleContext.tableLabel(tableIndex)},
		{type: 'register', register: tableRegister}
	))
	const addressDatum: asm.Datum =
		{type: 'register', register: INT_INTERMEDIATE_REGISTERS[1]}
	const offsetRegister = context.resolvePop()!
	functionIndices.forEach((functionIndex, i) => {
		output.push(
			new asm.LeaInstruction(
				{type: 'label', label: moduleContext.functionLabel(functionIndex)},
				addressDatum
			),
			new asm.MoveInstruction(addressDatum, {
				type: 'indirect',
				register: tableRegister,
				immediate: i << 3,
				offset: {register: offsetRegister, scale: 8}
			})
		)
	})
}
function compileInitInstructions(
	{
		context,
		moduleName,
		memoryMin,
		memoryInitializers,
		globalInitializers,
		tableInitializers,
		startFunction
	}: ParsedModule,
	output: asm.AssemblyInstruction[],
	declarations: HeaderDeclaration[]
) {
	if (!(
		memoryMin ||
		globalInitializers.length ||
		tableInitializers.length ||
		startFunction !== undefined
	)) return

	// TODO: consider a special Instruction for table initialization
	// so we can compile the init as a wasm function and not directly into assembly

	declarations.push(new FunctionDeclaration(
		'void',
		addSysvLabel(moduleName, 'init_module', output),
		['void']
	))

	const initOutput: asm.AssemblyInstruction[] = []
	const globalContext = new CompilationContext(context, {params: [], locals: []})
	const compile = (...instructions: Instruction[]) =>
		compileInstructions(instructions, globalContext, initOutput)

	if (memoryMin) {
		compile(
			{type: 'i32.const', value: memoryMin},
			{type: 'memory.grow'},
			{type: 'drop'}
		)
		for (const initializer of memoryInitializers) {
			compileMemoryInitializer(initializer, globalContext, initOutput)
		}
	}

	globalInitializers.forEach((initializer, global) => {
		compile(...initializer)
		compile({type: 'set_global', global})
	})

	for (const initializer of tableInitializers) {
		compileTableInitializer(initializer, context, globalContext, initOutput)
	}

	if (startFunction !== undefined) compile({type: 'call', func: startFunction})

	const registersUsed = new Set(globalContext.registersUsed(true))
	const toRestore: asm.Register[] = []
	for (const register of SYSV_CALLEE_SAVE_REGISTERS) {
		if (registersUsed.has(register)) {
			output.push(new asm.PushInstruction(register))
			toRestore.push(register)
		}
	}
	output.push(...initOutput)
	for (const register of reverse(toRestore)) {
		output.push(new asm.PopInstruction(register))
	}
	output.push(new asm.RetInstruction)
}

export function compileFunctionBodies(
	{context, moduleName, functionTypes, functionBodies}: ParsedModule,
	output: asm.AssemblyInstruction[],
	declarations: HeaderDeclaration[]
) {
	const {exportFunctions} = context
	functionBodies.forEach((instructions, i) => {
		const functionIndex = context.getFunctionIndex(i)
		const sysvOutput: asm.AssemblyInstruction[] = []
		for (const label of exportFunctions.get(functionIndex) || []) {
			addExportLabel(context.exportLabel('FUNC', label), output)
			const {params, results} = functionTypes[i]
			declarations.push(new FunctionDeclaration(
				getCType((results as [ValueType?])[0] || 'empty'),
				addSysvLabel(moduleName, label, sysvOutput),
				params.length ? params.map(getCType) : ['void']
			))
		}
		const functionLabel = context.functionLabel(i)
		output.push(new asm.Label(functionLabel))

		const functionContext = context.makeFunctionContext(functionIndex)
		const bodyOutput: asm.AssemblyInstruction[] = []
		const branches =
			compileInstructions(instructions, functionContext, bodyOutput).definitely

		const registersUsed = functionContext.registersUsed(true)
		for (const register of registersUsed) {
			output.push(new asm.PushInstruction(register))
		}
		const {stackLocals} = functionContext
		if (stackLocals) output.push(growStack(stackLocals))
		functionContext.locals.forEach(({float}, i) => {
			const datum = functionContext.resolveLocalDatum(i)
			const zeroDatum: asm.Datum = float && datum.type === 'register'
				? {type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
				: datum
			output.push(new asm.MoveInstruction(
				{type: 'immediate', value: 0}, zeroDatum, 'q'
			))
			if (datum !== zeroDatum) {
				output.push(new asm.MoveInstruction(zeroDatum, datum, 'q'))
			}
		})

		output.push(...bodyOutput)

		if (!branches) popResultAndUnwind(functionContext, output)
		output.push(new asm.Label(context.returnLabel(functionIndex)))
		if (stackLocals) output.push(shrinkStack(stackLocals))
		for (const register of reverse(registersUsed)) {
			output.push(new asm.PopInstruction(register))
		}
		output.push(new asm.RetInstruction)

		if (sysvOutput.length) {
			output.push(...sysvOutput)
			const {params} = functionContext
			const moves = new Map<asm.Register, asm.Datum>()
			let intParam = 0, floatParam = 0
			const stackParams: asm.Datum[] = []
			params.forEach(({float}, param) => {
				const source = (float
					? SYSV_FLOAT_PARAM_REGISTERS[floatParam++]
					: SYSV_INT_PARAM_REGISTERS[intParam++]
				) as asm.Register | undefined
				const datum = functionContext.resolveParamDatum(param)
				if (source) moves.set(source, datum)
				else stackParams.push(datum)
			})
			const {toRestore, output: relocateOutput} =
				relocateArguments(moves, stackParams, SYSV_CALLEE_SAVE_SET)
			for (const register of toRestore) {
				output.push(new asm.PushInstruction(register))
			}
			output.push(...relocateOutput)
			if (toRestore.length) {
				output.push(new asm.CallInstruction(functionLabel))
				for (const register of reverse(toRestore)) {
					output.push(new asm.PopInstruction(register))
				}
				output.push(new asm.RetInstruction)
			}
			else output.push(new asm.JumpInstruction(functionLabel))
		}
	})
}

export function compileModule(module: Module): CompiledModule {
	const parsedModule = parseSections(module)
	const output: asm.AssemblyInstruction[] = [
		new asm.Directive({type: 'data'}),
		new asm.Directive({type: 'balign', args: [8]})
	]
	const declarations: HeaderDeclaration[] = []
	const originalOutputLength = output.length
	compileGlobals(parsedModule, output, declarations)
	if (output.length === originalOutputLength) output.length = 0
	output.push(new asm.Directive({type: 'text'}))
	compileInitInstructions(parsedModule, output, declarations)
	compileFunctionBodies(parsedModule, output, declarations)
	return {instructions: output, declarations}
}