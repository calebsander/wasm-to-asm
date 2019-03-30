import {FunctionDeclaration, getCType, GlobalDeclaration, HeaderDeclaration} from './c-header'
import {Instruction} from './parse-instruction'
import {CodeSection, Export, FunctionType, Global, GlobalType, Import, Section} from './parse-module'
import {ValueType} from './parse-value-type'
import * as asm from './x86_64-asm'

function* reverse<A>(arr: A[]) {
	for (let i = arr.length - 1; i >= 0; i--) yield arr[i]
}
const flatten = <A>(sections: A[][]) => ([] as A[]).concat(...sections)

const INTERMEDIATE_REGISTERS: asm.Register[] = ['rdi', 'rsi', 'rax']
const RESULT_REGISTER: asm.Register = 'rax'
const BASE_POINTER_REGISTER: asm.Register = 'rbp'
const GENERAL_REGISTERS: asm.Register[] = [
	'rbx', 'rcx', 'rdx',
	'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
	'rbp'
]
const SHIFT_REGISTER: asm.Register = 'rcx'
const SHIFT_REGISTER_DATUM = {type: 'register' as 'register', register: SHIFT_REGISTER}
const DIV_LOWER_DATUM = {type: 'register' as 'register', register: 'rax' as asm.Register}
const DIV_UPPER_REGISTER: asm.Register = 'rdx'
const DIV_UPPER_DATUM = {type: 'register' as 'register', register: DIV_UPPER_REGISTER}
const SYSV_PARAM_REGISTERS: asm.Register[] =
	['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9']
const SYSV_CALLEE_SAVE_REGISTERS: asm.Register[] =
	['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15']

class BPRelative {
	constructor(public readonly index: number) {}
	get datum(): asm.Datum {
		return {type: 'indirect', register: 'rbp', immediate: -(this.index + 1) << 3}
	}
}

const typeWidth = (type: ValueType): asm.Width =>
	type === 'i32' ? 'l' : 'q'

interface BlockReference {
	label: string
	stackHeight: number
	result: boolean
}
interface FunctionStats {
	params: ValueType[]
	locals: ValueType[]
	result: boolean
}

interface ImportReference {
	modulePrefix: string
	name: string
}
export interface ModuleIndices {
	[module: string]: number
}
class ModuleContext {
	readonly exportMemory: string[] = []
	readonly exportFunctions = new Map<number, string[]>()
	readonly exportGlobals = new Map<number, string[]>()
	readonly globalTypes: GlobalType[] = []
	private readonly importFunctions: ImportReference[] = []
	private readonly importGlobals: ImportReference[] = []
	private readonly importGlobalTypes: ValueType[] = []

	constructor(
		readonly index: number,
		readonly moduleIndices: ModuleIndices
	) {}

	addGlobals(globals: Global[]): void {
		this.globalTypes.push(...globals.map(({type}) => type))
	}
	addExports(exports: Export[]): void {
		for (let {name, description: {type, index}} of exports) {
			name = name.replace(/-/g, '_')
			let exportMap: Map<Number, string[]>
			switch (type) {
				case 'memory':
					if (index !== 0) throw new Error('Invalid memory index')
					this.exportMemory.push(name)
					continue
				case 'function':
					exportMap = this.exportFunctions
					break
				case 'global':
					exportMap = this.exportGlobals
					break
				default:
					throw new Error('Unexpected export type: ' + type)
			}
			const names = exportMap.get(index)
			if (names) names.push(name)
			else exportMap.set(index, [name])
		}
	}
	addImports(imports: Import[]) {
		for (const {module, name, description} of imports) {
			const moduleIndex = this.moduleIndices[module] as number | undefined
			if (moduleIndex === undefined) throw new Error('No such module: ' + module)
			const modulePrefix = ModuleContext.modulePrefix(moduleIndex)
			let importMap: ImportReference[] | undefined
			switch (description.type) {
				case 'function':
					importMap = this.importFunctions
					break
				case 'global':
					importMap = this.importGlobals
					this.importGlobalTypes.push(description.valueType.type)
			}
			if (importMap) importMap.push({modulePrefix, name})
		}
	}
	private get baseFunctionIndex(): number {
		return this.importFunctions.length
	}
	private get baseGlobalIndex(): number {
		return this.importGlobals.length
	}
	resolveGlobalWidth(index: number): asm.Width {
		const moduleGlobalIndex = index - this.baseGlobalIndex
		return typeWidth(moduleGlobalIndex < 0
			? this.importGlobalTypes[index]
			: this.globalTypes[moduleGlobalIndex].type
		)
	}
	resolveGlobalLabel(index: number): string {
		const moduleGlobalIndex = index - this.baseGlobalIndex
		if (moduleGlobalIndex < 0) {
			const importRef = this.importGlobals[index]
			return ModuleContext.exportLabel(importRef.modulePrefix, 'GLOBAL', importRef.name)
		}
		return this.globalLabel(moduleGlobalIndex)
	}
	getFunctionLabel(index: number): string {
		const moduleFunctionIndex = index - this.baseFunctionIndex
		if (moduleFunctionIndex < 0) {
			const importRef = this.importFunctions[index]
			return ModuleContext.exportLabel(importRef.modulePrefix, 'FUNC', importRef.name)
		}
		return this.functionLabel(moduleFunctionIndex)
	}
	static modulePrefix(moduleIndex: number): string {
		return `MODULE${moduleIndex}`
	}
	static exportLabel(modulePrefix: string, type: string, name: string): string {
		return `${modulePrefix}_EXPORT_${type}_${name}`
	}
	private get modulePrefix(): string {
		return ModuleContext.modulePrefix(this.index)
	}
	globalLabel(index: number): string {
		return `${this.modulePrefix}_GLOBAL${index}`
	}
	functionLabel(index: number): string {
		return `${this.modulePrefix}_FUNC${index}`
	}
	returnLabel(index: number): string {
		return `${this.modulePrefix}_RETURN${index}`
	}
	exportLabel(type: string, name: string): string {
		return ModuleContext.exportLabel(this.modulePrefix, type, name)
	}
	get memorySizeLabel(): string {
		return `${this.modulePrefix}_MEMSIZE`
	}
	get memoryStart(): number {
		return 0x100000000 * (this.index + 1)
	}
}
// TODO: support f32 and f64 values
class CompilationContext {
	readonly params: number
	readonly locals: number
	readonly result: boolean
	readonly localTypes: ReadonlyArray<ValueType>
	public stackHeight = 0
	private maxStackHeight = 0
	private generalRegisters: ReadonlyArray<asm.Register>
	private labelCount = 0
	readonly containingLabels: BlockReference[] = []

	constructor(
		readonly moduleContext: ModuleContext,
		readonly functionsStats: Map<number, FunctionStats>,
		readonly functionIndex: number
	) {
		const thisStats = functionsStats.get(functionIndex)!
		const {params, locals, result} = thisStats
		this.params = params.length
		this.locals = locals.length
		this.result = result
		this.localTypes = params.concat(locals)
		this.generalRegisters = GENERAL_REGISTERS
		if (this.usesBP) {
			this.generalRegisters = this.generalRegisters.filter(
				register => register !== BASE_POINTER_REGISTER
			)
		}
	}

	push(): void {
		const newStackHeight = ++this.stackHeight
		if (newStackHeight > this.maxStackHeight) this.maxStackHeight = newStackHeight
	}
	pop(): void {
		this.stackHeight--
	}
	resolveParam(index: number): asm.Register | BPRelative {
		return (this.generalRegisters as (asm.Register | undefined)[])[index] ||
			new BPRelative(index - this.generalRegisters.length)
	}
	resolveParamDatum(index: number): asm.Datum {
		const resolved = this.resolveParam(index)
		return resolved instanceof BPRelative
			? resolved.datum
			: {type: 'register', register: resolved}
	}
	resolveLocal(index: number): asm.Register | BPRelative {
		return this.resolveParam(this.params + index)
	}
	resolveStack(index: number): asm.Register | BPRelative {
		return this.resolveLocal(this.locals + index)
	}
	resolvePush(): asm.Register | undefined {
		const resolvedIndex = this.resolveStack(this.stackHeight)
		this.push()
		return resolvedIndex instanceof BPRelative ? undefined : resolvedIndex
	}
	resolvePop(): asm.Register | undefined {
		this.pop()
		const resolvedIndex = this.resolveStack(this.stackHeight)
		return resolvedIndex instanceof BPRelative ? undefined : resolvedIndex
	}
	// If wholeFunction is true, maxStackHeight is used and params are excluded
	registersUsed(wholeFunction?: true): asm.Register[] {
		const toSave: asm.Register[] = []
		if (!wholeFunction) {
			const {params} = this
			for (let i = 0; i < params; i++) {
				const resolved = this.resolveParam(i)
				if (resolved instanceof BPRelative) return toSave
				toSave.push(resolved)
			}
		}
		const {locals} = this
		for (let i = 0; i < locals; i++) {
			const resolved = this.resolveLocal(i)
			if (resolved instanceof BPRelative) return toSave
			toSave.push(resolved)
		}
		const stackHeight = wholeFunction ? this.maxStackHeight : this.stackHeight
		for (let i = 0; i < stackHeight; i++) {
			const resolved = this.resolveStack(i)
			if (resolved instanceof BPRelative) return toSave
			toSave.push(resolved)
		}
		return toSave
	}
	makeLabel(prefix: string): string {
		return `${this.moduleContext.functionLabel(this.functionIndex)}_${prefix}${++this.labelCount}`
	}
	get usesBP(): boolean {
		return this.resolveLocal(this.locals - 1) instanceof BPRelative
	}
}

function executePush(context: CompilationContext, output: asm.AssemblyInstruction[], source: asm.Register) {
	const target = context.resolvePush()
	output.push(target
		? new asm.MoveInstruction(
				{type: 'register', register: source},
				{type: 'register', register: target}
			)
		: new asm.PushInstruction(source)
	)
}

const MMAP_SYSCALL_REGISTERS = new Array<asm.Register>('rax', 'rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9', 'rcx', 'r11')
	.filter(register => !GENERAL_REGISTERS.includes(register))
const PAGE_BITS: asm.Datum = {type: 'immediate', value: 16}
// PROT_READ | PROT_WRITE
const PROT_READ_WRITE: asm.Datum = {type: 'immediate', value: 0x1 | 0x2}
// MAP_SHARED | MAP_FIXED | MAP_ANONYMOUS
const MMAP_FLAGS: asm.Datum = {type: 'immediate', value: 0x01 | 0x10 | 0x20}
const compareOperations = new Map<string, asm.JumpCond>([
	['eqz', 'e'],
	['eq', 'e'],
	['ne', 'ne'],
	['lt_s', 'l'],
	['lt_u', 'b'],
	['le_s', 'le'],
	['le_u', 'be'],
	['gt_s', 'g'],
	['gt_u', 'a'],
	['ge_s', 'ge'],
	['ge_u', 'ae']
])
const arithmeticOperations = new Map([
	['add', asm.AddInstruction],
	['sub', asm.SubInstruction],
	['and', asm.AndInstruction],
	['or', asm.OrInstruction],
	['xor', asm.XorInstruction],
	['shl', asm.ShlInstruction],
	['shr_s', asm.SarInstruction],
	['shr_u', asm.ShrInstruction],
	['rotl', asm.RolInstruction],
	['rotr', asm.RorInstruction]
])
const bitCountOperations = new Map([
	['clz', asm.LzcntInstruction],
	['ctz', asm.TzcntInstruction],
	['popcnt', asm.PopcntInstruction]
])
const SHIFT_OPERATIONS = new Set(['shl', 'shr_s', 'shr_u', 'rotl', 'rotr'])
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
function compileInstruction(instruction: Instruction, context: CompilationContext, output: asm.AssemblyInstruction[]) {
	// output.push(new asm.Comment(
	// 	JSON.stringify(instruction, (_, v) => typeof v === 'bigint' ? String(v) : v)
	// ))
	switch (instruction.type) {
		case 'unreachable':
			// exit(0xFF)
			output.push(
				new asm.MoveInstruction(
					{type: 'immediate', value: asm.SYSCALL.exit},
					{type: 'register', register: 'rax'}
				),
				new asm.MoveInstruction(
					{type: 'immediate', value: 0xFF},
					{type: 'register', register: 'rdi'}
				),
				new asm.SysCallInstruction
			)
			break
		case 'nop':
			break
		case 'return':
			output.push(new asm.JumpInstruction(
				context.moduleContext.returnLabel(context.functionIndex)
			))
			break
		case 'block':
		case 'loop': {
			const {type, returns, instructions} = instruction
			const {containingLabels, stackHeight} = context
			const blockLabel = context.makeLabel(type.toUpperCase())
			containingLabels.push({
				label: blockLabel,
				stackHeight,
				result: returns !== 'empty'
			})
			if (type === 'loop') output.push(new asm.Label(blockLabel))
			for (const instruction of instructions) compileInstruction(instruction, context, output)
			if (type === 'block') output.push(new asm.Label(blockLabel))
			containingLabels.pop()
			break
		}
		case 'if': {
			const {returns, ifInstructions, elseInstructions} = instruction
			const endLabel = context.makeLabel('IF_END')
			const hasElse = elseInstructions.length
			let elseLabel: string
			if (hasElse) elseLabel = context.makeLabel('ELSE')
			const {containingLabels, stackHeight} = context
			containingLabels.push({
				label: endLabel,
				stackHeight,
				result: returns !== 'empty'
			})
			let cond = context.resolvePop()
			if (!cond) { // cond is on the stack
				cond = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(cond))
			}
			const datum: asm.Datum = {type: 'register', register: cond, width: 'l'}
			output.push(
				new asm.TestInstruction(datum, datum),
				new asm.JumpInstruction(hasElse ? elseLabel! : endLabel, 'e')
			)
			compileInstructions(ifInstructions, context, output)
			if (hasElse) {
				containingLabels.pop()
				containingLabels.push({
					label: elseLabel!,
					stackHeight,
					result: returns !== 'empty'
				})
				output.push(
					new asm.JumpInstruction(endLabel),
					new asm.Label(elseLabel!)
				)
				if (instruction.returns !== 'empty') context.pop()
				compileInstructions(elseInstructions, context, output)
			}
			output.push(new asm.Label(endLabel))
			containingLabels.pop()
			break
		}
		case 'br':
		case 'br_if': {
			let endLabel: string | undefined
			if (instruction.type === 'br_if') {
				endLabel = context.makeLabel('BR_IF_END')
				let cond = context.resolvePop()
				if (!cond) {
					cond = INTERMEDIATE_REGISTERS[0]
					output.push(new asm.PopInstruction(cond))
				}
				const datum: asm.Datum = {type: 'register', register: cond, width: 'l'}
				output.push(
					new asm.TestInstruction(datum, datum),
					new asm.JumpInstruction(endLabel, 'e')
				)
			}
			const {containingLabels} = context
			const {label, result, stackHeight} = containingLabels[containingLabels.length - 1 - instruction.label]
			const moveResult = result && context.stackHeight > stackHeight
			if (moveResult) {
				const toPop = context.resolvePop()
				output.push(toPop
					? new asm.MoveInstruction(
							{type: 'register', register: toPop},
							{type: 'register', register: INTERMEDIATE_REGISTERS[0]}
						)
					: new asm.PopInstruction(INTERMEDIATE_REGISTERS[0])
				)
			}
			let popCount = 0
			while (context.stackHeight > stackHeight) {
				if (!context.resolvePop()) popCount++
			}
			if (popCount) {
				output.push(new asm.AddInstruction(
					{type: 'immediate', value: popCount << 3},
					{type: 'register', register: 'rsp'}
				))
			}
			if (moveResult) executePush(context, output, INTERMEDIATE_REGISTERS[0])
			output.push(new asm.JumpInstruction(label))
			if (endLabel) output.push(new asm.Label(endLabel))
			break
		}
		case 'call': {
			// TODO: need to know other modules' functionsStats
			const {func} = instruction
			// TODO: can this context be cached to avoid recomputing the context for the same function?
			const otherContext = new CompilationContext(context.moduleContext, context.functionsStats, func)
			const {params, result} = otherContext
			const registersUsed = new Set(context.registersUsed())
			const toPush: asm.Register[] = []
			// TODO: support passing params on the stack if too many are used
			const argRegisters = new Array<asm.Register>(params)
			for (let i = 0; i < params; i++) {
				const register = otherContext.resolveParam(i)
				if (register instanceof BPRelative) {
					throw new Error(`Function ${func}'s params don't fit in registers`)
				}
				if (registersUsed.has(register)) toPush.push(register)
				argRegisters[i] = register
			}
			const pushedRegisters = toPush.length
			for (let i = 0; i < pushedRegisters; i++) {
				output.push(new asm.MoveInstruction(
					{type: 'register', register: toPush[i]},
					{type: 'indirect', register: 'rsp', immediate: -(i + 1) << 3}
				))
			}
			let stackPopped = 0
			for (const register of reverse(argRegisters)) {
				const param = context.resolvePop()
				if (param) {
					if (param !== register) { // don't move if already there
						output.push(new asm.MoveInstruction(
							{type: 'register', register: param},
							{type: 'register', register}
						))
					}
				}
				else {
					output.push(new asm.PopInstruction(register))
					stackPopped++
				}
			}
			const spSub = stackPopped + pushedRegisters // point to end of pushedRegisters
			if (spSub) {
				output.push(new asm.SubInstruction(
					{type: 'immediate', value: spSub << 3},
					{type: 'register', register: 'rsp'}
				))
			}
			output.push(new asm.CallInstruction(context.moduleContext.getFunctionLabel(func)))
			for (const register of reverse(toPush)) output.push(new asm.PopInstruction(register))
			if (stackPopped) { // point to actual stack location
				output.push(new asm.AddInstruction(
					{type: 'immediate', value: stackPopped << 3},
					{type: 'register', register: 'rsp'}
				))
			}
			if (result) {
				const pushTo = context.resolvePush()
				if (pushTo) {
					output.push(new asm.MoveInstruction(
						{type: 'register', register: RESULT_REGISTER},
						{type: 'register', register: pushTo}
					))
				}
				else output.push(new asm.PushInstruction(RESULT_REGISTER))
			}
			break
		}
		case 'drop': {
			const operand = context.resolvePop()
			if (!operand) {
				output.push(new asm.AddInstruction(
					{type: 'immediate', value: 8},
					{type: 'register', register: 'rsp'}
				))
			}
			break
		}
		case 'select': {
			let cond = context.resolvePop()
			if (!cond) {
				cond = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(cond))
			}
			let ifFalse = context.resolvePop()
			if (!ifFalse) {
				ifFalse = INTERMEDIATE_REGISTERS[1]
				output.push(new asm.PopInstruction(ifFalse))
			}
			const ifFalseDatum: asm.Datum = {type: 'register', register: ifFalse}
			let ifTrue = context.resolvePop() // also where the result will go
			const onStack = !ifTrue
			if (onStack) {
				ifTrue = INTERMEDIATE_REGISTERS[2]
				output.push(new asm.PopInstruction(ifTrue))
			}
			const condDatum: asm.Datum = {type: 'register', register: cond, width: 'l'}
			output.push(
				new asm.TestInstruction(condDatum, condDatum),
				new asm.CMoveInstruction(
					ifFalseDatum,
					{type: 'register', register: ifTrue!},
					'e'
				)
			)
			if (onStack) output.push(new asm.PushInstruction(ifTrue!))
			context.push()
			break
		}
		case 'get_local': {
			const {local} = instruction
			const resolvedLocal = context.resolveParam(local)
			let target = context.resolvePush()
			if (resolvedLocal instanceof BPRelative) {
				const push = !target
				if (push) target = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.MoveInstruction(
					resolvedLocal.datum,
					{type: 'register', register: target!}
				))
				if (push) output.push(new asm.PushInstruction(target!))
			}
			else {
				output.push(target
					? new asm.MoveInstruction(
							{type: 'register', register: resolvedLocal},
							{type: 'register', register: target}
						)
					: new asm.PushInstruction(resolvedLocal)
				)
			}
			break
		}
		case 'set_local':
		case 'tee_local': {
			const {type, local} = instruction
			const tee = type === 'tee_local'
			let value = context.resolvePop()
			if (!value) {
				value = INTERMEDIATE_REGISTERS[0]
				if (tee) {
					output.push(new asm.MoveInstruction(
						{type: 'indirect', register: 'rsp'},
						{type: 'register', register: value}
					))
				}
				else output.push(new asm.PopInstruction(value))
			}
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value!},
				context.resolveParamDatum(local)
			))
			if (tee) context.push()
			break
		}
		case 'get_global': {
			const {global} = instruction
			const width = context.moduleContext.resolveGlobalWidth(global)
			let target = context.resolvePush()
			const push = !target
			if (push) target = INTERMEDIATE_REGISTERS[0]
			output.push(new asm.MoveInstruction(
				{type: 'label', label: context.moduleContext.resolveGlobalLabel(global)},
				{type: 'register', register: target!, width}
			))
			if (push) output.push(new asm.PushInstruction(target!))
			break
		}
		case 'set_global': {
			const {global} = instruction
			const width = context.moduleContext.resolveGlobalWidth(global)
			let value = context.resolvePop()
			if (!value) {
				value = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(value))
			}
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value, width},
				{type: 'label', label: context.moduleContext.resolveGlobalLabel(global)}
			))
			break
		}
		case 'i32.load':
		case 'i32.load8_s':
		case 'i32.load8_u':
		case 'i32.load16_s':
		case 'i32.load16_u':
		case 'i64.load':
		case 'i64.load8_s':
		case 'i64.load8_u':
		case 'i64.load16_s':
		case 'i64.load16_u':
		case 'i64.load32_s':
		case 'i64.load32_u': {
			const {offset} = instruction.access
			let register = context.resolvePop()
			const onStack = !register
			if (!register) {
				register = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(register))
			}
			const address: asm.Datum = {type: 'register', register: INTERMEDIATE_REGISTERS[1]}
			output.push(new asm.MoveInstruction(
				{type: 'immediate', value: context.moduleContext.memoryStart + offset},
				address
			))
			const source: asm.Datum =
				{type: 'indirect', register: address.register, offset: {register}}
			const [type, operation] = instruction.type.split('.')
			const isLoad32U = operation === 'load32_u'
			const width = type === 'i32' || isLoad32U ? 'l' : 'q'
			const targetDatum: asm.Datum = {type: 'register', register, width}
			output.push(operation === 'load' || isLoad32U
				? new asm.MoveInstruction(source, targetDatum)
				: new asm.MoveExtendInstruction(
						source,
						targetDatum,
						operation.startsWith('load8') ? 'b' :
							operation.startsWith('load16') ? 'w' : 'l',
						width,
						operation.endsWith('_s')
					)
			)
			if (onStack) output.push(new asm.PushInstruction(register))
			context.push()
			break
		}
		case 'i32.store':
		case 'i32.store8':
		case 'i32.store16':
		case 'i64.store8':
		case 'i64.store16':
		case 'i64.store32':
		case 'i64.store': {
			const {offset} = instruction.access
			let value = context.resolvePop()
			if (!value) {
				value = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(value))
			}
			let index = context.resolvePop()
			if (!index) {
				index = INTERMEDIATE_REGISTERS[1]
				output.push(new asm.PopInstruction(index))
			}
			const address: asm.Datum = {type: 'register', register: INTERMEDIATE_REGISTERS[2]}
			output.push(new asm.MoveInstruction(
				{type: 'immediate', value: context.moduleContext.memoryStart + offset},
				address
			))
			const [type, operation] = instruction.type.split('.')
			const width = operation === 'store8' ? 'b' :
				operation === 'store16' ? 'w' :
				operation === 'store32' || type === 'i32' ? 'l' : 'q'
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value, width},
				{type: 'indirect', register: address.register, offset: {register: index}}
			))
			break
		}
		case 'memory.size': {
			let target = context.resolvePush()
			const push = !target
			if (push) target = INTERMEDIATE_REGISTERS[0]
			output.push(new asm.MoveInstruction(
				{type: 'label', label: context.moduleContext.memorySizeLabel},
				{type: 'register', register: target!}
			))
			if (push) output.push(new asm.PushInstruction(target!))
			break
		}
		case 'memory.grow': {
			const pagesAddRegister = 'rsi'
			let pages = context.resolvePop()
			if (!pages) {
				pages = pagesAddRegister
				output.push(new asm.PopInstruction(pages))
			}
			const registersUsed = new Set(context.registersUsed())
			const toRestore: asm.Register[] = []
			for (const register of MMAP_SYSCALL_REGISTERS) {
				if (registersUsed.has(register)) {
					output.push(new asm.PushInstruction(register))
					toRestore.push(register)
				}
			}
			const sizeLabel: asm.Datum = {type: 'label', label: context.moduleContext.memorySizeLabel}
			const addrDatum: asm.Datum = {type: 'register', register: 'rdi'}
			const addrDatum32: asm.Datum = {...addrDatum, width: 'l'}
			output.push(
				new asm.MoveInstruction(
					{type: 'immediate', value: asm.SYSCALL.mmap},
					{type: 'register', register: 'rax'}
				),
				new asm.MoveInstruction(sizeLabel, addrDatum32),
				new asm.ShlInstruction(PAGE_BITS, addrDatum),
				new asm.MoveInstruction( // must mov 64-bit immediate to intermediate register
					{type: 'immediate', value: context.moduleContext.memoryStart},
					{type: 'register', register: 'rsi'}
				),
				new asm.AddInstruction({type: 'register', register: 'rsi'}, addrDatum)
			)
			if (pages !== pagesAddRegister) {
				output.push(new asm.MoveInstruction(
					{type: 'register', register: pages},
					{type: 'register', register: pagesAddRegister}
				))
			}
			const offset: asm.Datum = {type: 'register', register: 'r9'}
			output.push(
				new asm.PushInstruction(pagesAddRegister), // save the number of pages added
				new asm.ShlInstruction(PAGE_BITS, {type: 'register', register: 'rsi'}),
				new asm.MoveInstruction(PROT_READ_WRITE, {type: 'register', register: 'rdx'}),
				new asm.MoveInstruction(MMAP_FLAGS, {type: 'register', register: 'r10'}),
				new asm.MoveInstruction(
					{type: 'immediate', value: -1},
					{type: 'register', register: 'r8'}
				),
				new asm.XorInstruction(offset, offset),
				new asm.SysCallInstruction,
				new asm.PopInstruction(pagesAddRegister)
			)
			for (const register of reverse(toRestore)) output.push(new asm.PopInstruction(register))
			let target = context.resolvePush()
			const push = !target
			if (push) target = INTERMEDIATE_REGISTERS[0]
			output.push(
				new asm.MoveInstruction(sizeLabel, {type: 'register', register: target!, width: 'l'}),
				new asm.AddInstruction({type: 'register', register: pagesAddRegister, width: 'l'}, sizeLabel)
			)
			if (push) output.push(new asm.PushInstruction(target!))
			// TODO: handle mmap failure (return -1)
			break
		}
		case 'i32.const':
		case 'i64.const': {
			const {value} = instruction
			let target = context.resolvePush()
			const pushResult = !target
			if (pushResult) target = INTERMEDIATE_REGISTERS[0]
			const type = instruction.type.slice(0, instruction.type.indexOf('.'))
			output.push(new asm.MoveInstruction(
				{type: 'immediate', value},
				{
					type: 'register',
					register: target!,
					width: typeWidth(type as ValueType)
				}
			))
			if (pushResult) output.push(new asm.PushInstruction(target!))
			break
		}
		case 'i32.eqz':
		case 'i32.eq':
		case 'i32.ne':
		case 'i32.lt_s':
		case 'i32.lt_u':
		case 'i32.le_s':
		case 'i32.le_u':
		case 'i32.gt_s':
		case 'i32.gt_u':
		case 'i32.ge_s':
		case 'i32.ge_u':
		case 'i64.eqz':
		case 'i64.eq':
		case 'i64.ne':
		case 'i64.lt_s':
		case 'i64.lt_u':
		case 'i64.le_s':
		case 'i64.le_u':
		case 'i64.gt_s':
		case 'i64.gt_u':
		case 'i64.ge_s':
		case 'i64.ge_u': {
			const [type, operation] = instruction.type.split('.')
			const width = typeWidth(type as ValueType)
			let datum2: asm.Datum
			if (operation === 'eqz') datum2 = {type: 'immediate', value: 0}
			else {
				let arg2 = context.resolvePop()
				if (!arg2) {
					arg2 = INTERMEDIATE_REGISTERS[0]
					output.push(new asm.PopInstruction(arg2))
				}
				datum2 = {type: 'register', register: arg2, width}
			}
			let arg1 = context.resolvePop()
			const onStack = !arg1
			if (onStack) {
				arg1 = INTERMEDIATE_REGISTERS[1]
				output.push(new asm.PopInstruction(arg1))
			}
			const cond = compareOperations.get(operation)
			if (!cond) throw new Error(`No comparison value found for ${instruction.type}`)
			const datum1: asm.Datum = {type: 'register', register: arg1!, width}
			const datum1Byte: asm.Datum = {...datum1, width: 'b'}
			output.push(
				new asm.CmpInstruction(datum2, datum1),
				new asm.SetInstruction(datum1Byte, cond),
				new asm.MoveExtendInstruction(datum1Byte, {...datum1, width: 'l'}, 'b', 'l', false)
			)
			context.push()
			if (onStack) output.push(new asm.PushInstruction(arg1!))
			break
		}
		case 'i32.clz':
		case 'i32.ctz':
		case 'i32.popcnt':
		case 'i64.clz':
		case 'i64.ctz':
		case 'i64.popcnt': {
			const arg = context.resolvePop()
			const [type, operation] = instruction.type.split('.')
			const width = type === 'i32' ? 'l' : 'q'
			const asmInstruction = bitCountOperations.get(operation)
			if (!asmInstruction) throw new Error('No instruction found for ' + instruction.type)
			if (arg) {
				const datum: asm.Datum = {type: 'register', register: arg, width}
				output.push(new asmInstruction(datum, datum))
			}
			else {
				const datum: asm.Datum = {type: 'indirect', register: 'rsp'}
				const result: asm.Datum =
					{type: 'register', register: INTERMEDIATE_REGISTERS[0], width}
				output.push(
					new asmInstruction(datum, result),
					new asm.MoveInstruction(result, datum)
				)
			}
			context.push()
			break
		}
		case 'i32.add':
		case 'i32.sub':
		case 'i32.and':
		case 'i32.or':
		case 'i32.xor':
		case 'i32.shl':
		case 'i32.shr_s':
		case 'i32.shr_u':
		case 'i32.rotl':
		case 'i32.rotr':
		case 'i64.add':
		case 'i64.sub':
		case 'i64.and':
		case 'i64.or':
		case 'i64.xor':
		case 'i64.shl':
		case 'i64.shr_s':
		case 'i64.shr_u':
		case 'i64.rotl':
		case 'i64.rotr': {
			let operand2 = context.resolvePop()
			if (!operand2) {
				[operand2] = INTERMEDIATE_REGISTERS
				output.push(new asm.PopInstruction(operand2))
			}
			const [type, operation] = instruction.type.split('.')
			/*
				Shifts are tricky because the second operand MUST be stored in %cl.
				If the second operand is already in %rcx, this is fine.
				Otherwise, evict %rcx to an intermediate register and restore it after the shift.
				If %rcx had the first operand, the shift needs to go against the intermediate register.
			*/
			const shift = SHIFT_OPERATIONS.has(operation)
			const shiftRelocate = shift && operand2 !== SHIFT_REGISTER
			const saveShiftRegister = shiftRelocate && context.registersUsed().includes(SHIFT_REGISTER)
				? INTERMEDIATE_REGISTERS[1]
				: undefined
			if (saveShiftRegister) {
				output.push(new asm.MoveInstruction(
					SHIFT_REGISTER_DATUM,
					{type: 'register', register: saveShiftRegister}
				))
			}
			let operand1 = context.resolvePop()
			if (saveShiftRegister && operand1 === SHIFT_REGISTER) {
				operand1 = saveShiftRegister
			}
			const arithmeticInstruction = arithmeticOperations.get(operation)
			if (!arithmeticInstruction) throw new Error(`No arithmetic instruction found for ${instruction.type}`)
			const width = typeWidth(type as ValueType)
			let datum2: asm.Datum
			if (shift) {
				if (shiftRelocate) {
					output.push(new asm.MoveInstruction(
						{type: 'register', register: operand2},
						SHIFT_REGISTER_DATUM
					))
				}
				datum2 = {...SHIFT_REGISTER_DATUM, width: 'b'}
			}
			else datum2 = {type: 'register', register: operand2, width}
			output.push(new arithmeticInstruction(
				datum2,
				operand1
					? {type: 'register', register: operand1, width}
					: {type: 'indirect', register: 'rsp'},
				width
			))
			context.push()
			if (saveShiftRegister) {
				output.push(new asm.MoveInstruction(
					{type: 'register', register: saveShiftRegister},
					SHIFT_REGISTER_DATUM
				))
			}
			break
		}
		case 'i32.mul':
		case 'i64.mul': {
			let operand2 = context.resolvePop()
			const operand1 = context.resolvePop()
			const width = instruction.type === 'i32.mul' ? 'l' : 'q'
			if (operand1) {
				output.push(new asm.ImulInstruction(
					operand2
						? {type: 'register', register: operand2, width}
						: {type: 'indirect', register: 'rsp'},
					{type: 'register', register: operand1, width}
				))
			}
			else {
				if (!operand2) {
					[operand2] = INTERMEDIATE_REGISTERS
					output.push(new asm.PopInstruction(operand2))
				}
				const datum2: asm.Datum = {type: 'register', register: operand2, width},
				      stack: asm.Datum = {type: 'indirect', register: 'rsp'}
				output.push(
					new asm.ImulInstruction(stack, datum2),
					new asm.MoveInstruction(datum2, stack)
				)
			}
			context.push()
			break
		}
		case 'i32.div_s':
		case 'i32.div_u':
		case 'i32.rem_s':
		case 'i32.rem_u':
		case 'i64.div_s':
		case 'i64.div_u':
		case 'i64.rem_s':
		case 'i64.rem_u': {
			const operand2 = context.resolvePop(),
			      operand1 = context.resolvePop()
			const datum1: asm.Datum = operand1
				? {type: 'register', register: operand1}
				: {type: 'indirect', register: 'rsp', immediate: 1 << 3}
			let upperEvict: asm.Datum | undefined
			if (context.registersUsed().includes(DIV_UPPER_REGISTER)) {
				upperEvict = {type: 'register', register: INTERMEDIATE_REGISTERS[0]}
			}
			if (upperEvict) {
				output.push(new asm.MoveInstruction(DIV_UPPER_DATUM, upperEvict))
			}
			const [type, operation] = instruction.type.split('.')
			const [op, signedness] = operation.split('_')
			const i32 = type === 'i32'
			const width = i32 ? 'l' : 'q'
			const signed = signedness === 's'
			const datum2: asm.Datum = operand2
				? {type: 'register', register: operand2, width}
				: {type: 'indirect', register: 'rsp'}
			if (op === 'rem' && signed) {
				// Special case for INT_MIN % -1, since the remainder
				// is 0 but the quotient (INT_MAX + 1) won't fit.
				// So, if the divisor is -1, set it to 1.
				const oneRegister: asm.Datum =
					{type: 'register', register: INTERMEDIATE_REGISTERS[1], width}
				output.push(
					new asm.MoveInstruction({type: 'immediate', value: 1}, oneRegister),
					new asm.CmpInstruction({type: 'immediate', value: -1}, datum2, width),
					new asm.CMoveInstruction(oneRegister, datum2, 'e')
				)
			}
			const result = op === 'div' ? DIV_LOWER_DATUM : DIV_UPPER_DATUM
			output.push(
				new asm.MoveInstruction(datum1, DIV_LOWER_DATUM),
				signed
					? i32 ? new asm.CdqInstruction : new asm.CqoInstruction
					: new asm.XorInstruction(DIV_UPPER_DATUM, DIV_UPPER_DATUM),
				new asm.DivInstruction(datum2, signed, width)
			)
			if (result.register !== datum1.register) {
				output.push(new asm.MoveInstruction(result, datum1))
			}
			context.resolvePush()
			if (upperEvict) {
				output.push(new asm.MoveInstruction(upperEvict, DIV_UPPER_DATUM))
			}
			break
		}
		case 'i32.wrap': {
			let value = context.resolvePop()
			const onStack = !value
			if (onStack) {
				value = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(value))
			}
			const register: asm.Datum = {type: 'register', register: value!, width: 'l'}
			output.push(new asm.MoveInstruction(register, register))
			context.push()
			if (onStack) output.push(new asm.PushInstruction(value!))
			break
		}
		case 'i64.extend_u':
			break // 32-bit values are already stored with upper bits zeroed
		default:
			throw new Error(`Unable to compile instruction of type ${instruction.type}`)
	}
}
function compileInstructions(instructions: Instruction[], context: CompilationContext, output: asm.AssemblyInstruction[]) {
	for (const instruction of instructions) {
		compileInstruction(instruction, context, output)
	}
}

function addSysvLabel(module: string, label: string, instructions: asm.AssemblyInstruction[]): string {
	const sysvLabel = `wasm_${module}_${label}`
	instructions.push(
		new asm.Directive({type: 'globl', args: [sysvLabel]}),
		new asm.Label(sysvLabel)
	)
	return sysvLabel
}

interface Modules {
	module: Section[]
	index: number
	moduleIndices: ModuleIndices
	moduleName: string
}
interface CompiledModule {
	instructions: asm.AssemblyInstruction[]
	declarations: HeaderDeclaration[]
}

export function compileModule(
	{module, index, moduleIndices, moduleName}: Modules
): CompiledModule {
	let types: FunctionType[] | undefined
	let functionsTypes: FunctionType[] | undefined
	let functionsLocals: ValueType[][] | undefined
	const moduleContext = new ModuleContext(index, moduleIndices)
	const globalContext = new CompilationContext(
		moduleContext,
		new Map([[0, {params: [], locals: [], result: false}]]),
		0
	)
	let codeSection: CodeSection | undefined
	let memoriesCount = 0
	let initInstructions: asm.AssemblyInstruction[] = []
	const dataInstructions: asm.AssemblyInstruction[] = []
	for (const section of module) {
		switch (section.type) {
			case 'type':
				({types} = section)
				break
			case 'function':
				if (!types) throw new Error('Expected type section')
				const {typeIndices} = section
				functionsTypes = new Array(typeIndices.length)
				for (let i = 0; i < typeIndices.length; i++) {
					functionsTypes[i] = types[typeIndices[i]]
				}
				break
			case 'code':
				codeSection = section
				const {segments} = section
				functionsLocals = new Array(segments.length)
				for (let i = 0; i < segments.length; i++) {
					functionsLocals[i] = segments[i].locals
				}
				break
			case 'memory':
				const {memories} = section
				memoriesCount += memories.length
				if (memoriesCount > 1) throw new Error('Multiple memories')
				if (!memoriesCount) break
				compileInstructions([
					{type: 'i32.const', value: memories[0].min},
					{type: 'memory.grow'},
					{type: 'drop'}
				], globalContext, initInstructions)
				break
			case 'global':
				const {globals} = section
				moduleContext.addGlobals(globals)
				for (let global = 0; global < globals.length; global++) {
					compileInstructions(globals[global].initializer, globalContext, initInstructions)
					compileInstruction({type: 'set_global', global}, globalContext, initInstructions)
				}
				break
			case 'export':
				moduleContext.addExports(section.exports)
				break
			case 'data':
				for (const {memoryIndex, offset, data} of section.initializers) {
					if (memoryIndex !== 0) throw new Error('Invalid memory index')
					const {byteLength} = data
					const dataView = new DataView(data)
					let byte = 0
					while (true) { // store 8 bytes at a time
						const nextIndex = byte + 8
						if (nextIndex > byteLength) break

						compileInstructions(offset, globalContext, dataInstructions)
						compileInstructions([
							{type: 'i64.const', value: dataView.getBigUint64(byte, true)},
							{type: 'i64.store', access: {align: 0, offset: byte}}
						], globalContext, dataInstructions)
						byte = nextIndex
					}
					while (byte < byteLength) {
						compileInstructions(offset, globalContext, dataInstructions)
						compileInstructions([
							{type: 'i32.const', value: dataView.getUint8(byte)},
							{type: 'i32.store8', access: {align: 0, offset: byte}}
						], globalContext, dataInstructions)
						byte++
					}
				}
		}
	}
	initInstructions.push(...dataInstructions)
	const declarations: HeaderDeclaration[] = []
	const {exportMemory, exportFunctions, exportGlobals} = moduleContext
	const globalInstructions: asm.AssemblyInstruction[] = [
		new asm.Directive({type: 'data'}),
		new asm.Directive({type: 'balign', args: [4]})
	]
	for (const label of exportMemory) {
		const exportLabel = `wasm_${moduleName}_${label}_size`
		globalInstructions.push(
			new asm.Directive({type: 'globl', args: [exportLabel]}),
			new asm.Label(exportLabel)
		)
		declarations.push(new GlobalDeclaration('int', true, exportLabel))
	}
	globalInstructions.push(
		new asm.Label(moduleContext.memorySizeLabel),
		new asm.Directive({type: 'long', args: [0]})
	)
	if (exportMemory.length) {
		globalInstructions.push(new asm.Directive({type: 'balign', args: [8]}))
		for (const label of exportMemory) {
			const exportLabel = `wasm_${moduleName}_${label}_memory`
			globalInstructions.push(
				new asm.Directive({type: 'globl', args: [exportLabel]}),
				new asm.Label(exportLabel)
			)
			declarations.push(new GlobalDeclaration('pointer', true, exportLabel))
		}
		globalInstructions.push(
			new asm.Directive({type: 'quad', args: [moduleContext.memoryStart]})
		)
	}
	const {globalTypes} = moduleContext
	for (let i = 0; i < globalTypes.length; i++) {
		const {type, mutable} = globalTypes[i]
		const directives = WASM_TYPE_DIRECTIVES.get(type)
		if (!directives) throw new Error('Unable to emit global of type ' + type)
		globalInstructions.push(directives.align)
		for (const label of exportGlobals.get(i) || []) {
			const exportLabel = moduleContext.exportLabel('GLOBAL', label)
			const headerLabel = `wasm_${moduleName}_${label}`
			globalInstructions.push(
				new asm.Directive({type: 'globl', args: [exportLabel]}),
				new asm.Label(exportLabel),
				new asm.Directive({type: 'globl', args: [headerLabel]}),
				new asm.Label(headerLabel)
			)
			declarations.push(new GlobalDeclaration(getCType(type), !mutable, headerLabel))
		}
		globalInstructions.push(
			new asm.Label(moduleContext.globalLabel(i)),
			directives.data
		)
	}
	if (initInstructions.length) { // not an empty function
		const newInitInstructions: asm.AssemblyInstruction[] = []
		declarations.push(new FunctionDeclaration(
			'void',
			addSysvLabel(moduleName, 'init', newInitInstructions),
			['void']
		))
		for (const register of SYSV_CALLEE_SAVE_REGISTERS) {
			newInitInstructions.push(new asm.PushInstruction(register))
		}
		newInitInstructions.push(...initInstructions)
		for (const register of reverse(SYSV_CALLEE_SAVE_REGISTERS)) {
			newInitInstructions.push(new asm.PopInstruction(register))
		}
		newInitInstructions.push(new asm.RetInstruction)
		initInstructions = newInitInstructions
	}
	else initInstructions = []
	if (!(functionsTypes && functionsLocals && codeSection)) {
		throw new Error('Expected function and code sections')
	}
	const functionsStats = new Map<number, FunctionStats>()
	for (let i = 0; i < functionsTypes.length; i++) {
		const {params, results} = functionsTypes[i]
		functionsStats.set(i, {
			params,
			locals: functionsLocals[i],
			result: !!results.length
		})
	}
	const assemblySections = [
		globalInstructions,
		[new asm.Directive({type: 'text'})],
		initInstructions
	]
	const {segments} = codeSection
	for (let i = 0; i < segments.length; i++) {
		const context = new CompilationContext(moduleContext, functionsStats, i)
		const bodyAssembly: asm.AssemblyInstruction[] = []
		compileInstructions(segments[i].instructions, context, bodyAssembly)
		const registersUsed = context.registersUsed(true)
		const saveInstructions: asm.AssemblyInstruction[] = []
		for (const register of registersUsed) {
			saveInstructions.push(new asm.PushInstruction(register))
		}
		if (context.usesBP) {
			const stackStart = context.resolveStack(0)
			saveInstructions.push(new asm.EnterInstruction(
				stackStart instanceof BPRelative ? stackStart.index << 3 : 0
			))
		}
		const returnInstructions: asm.AssemblyInstruction[] = [
			new asm.Label(context.moduleContext.returnLabel(i))
		]
		if (context.result) {
			const result = context.resolvePop()
			returnInstructions.push(result
				? new asm.MoveInstruction(
						{type: 'register', register: result},
						{type: 'register', register: RESULT_REGISTER}
					)
				: new asm.PopInstruction(RESULT_REGISTER)
			)
		}
		let popCount = 0
		while (context.stackHeight && !context.resolvePop()) popCount++
		if (popCount) {
			returnInstructions.push(new asm.AddInstruction(
				{type: 'immediate', value: popCount << 3},
				{type: 'register', register: 'rsp'}
			))
		}
		if (context.usesBP) returnInstructions.push(new asm.LeaveInstruction)
		for (const register of reverse(registersUsed)) {
			returnInstructions.push(new asm.PopInstruction(register))
		}
		returnInstructions.push(new asm.RetInstruction)
		const labels: asm.AssemblyInstruction[] = []
		const sysvInstructions: asm.AssemblyInstruction[] = []
		for (const label of exportFunctions.get(i) || []) {
			const exportLabel = moduleContext.exportLabel('FUNC', label)
			labels.push(
				new asm.Directive({type: 'globl', args: [exportLabel]}),
				new asm.Label(exportLabel)
			)
			const functionType = functionsTypes[i]
			const {params} = functionType
			declarations.push(new FunctionDeclaration(
				getCType(functionType.results[0] || 'empty'),
				addSysvLabel(moduleName, label, sysvInstructions),
				params.length ? params.map(getCType) : ['void']
			))
		}
		const functionLabel = context.moduleContext.functionLabel(i)
		labels.push(new asm.Label(functionLabel))
		if (sysvInstructions.length) {
			const {params} = context
			const registerParams = Math.min(params, SYSV_PARAM_REGISTERS.length)
			const targetMoves = new Map<asm.Register, asm.Datum>()
			for (let param = 0; param < registerParams; param++) {
				targetMoves.set(SYSV_PARAM_REGISTERS[param], context.resolveParamDatum(param))
			}
			let evicted: {register: asm.Register, inFirst: boolean} | undefined
			while (targetMoves.size) {
				let source: asm.Register, target: asm.Datum, inFirst: boolean
				if (evicted) {
					({inFirst} = evicted)
					source = INTERMEDIATE_REGISTERS[Number(inFirst)]
					const {register} = evicted
					const maybeTarget = targetMoves.get(register)
					if (!maybeTarget) throw new Error('Expected a parameter target')
					target = maybeTarget
					targetMoves.delete(register)
				}
				else {
					[source, target] = targetMoves.entries().next().value
					targetMoves.delete(source)
					inFirst = false
				}
				if (target.type === 'register' && targetMoves.has(target.register)) {
					const newEvicted = target.register
					const newInFirst = !inFirst
					evicted = {register: newEvicted, inFirst: newInFirst}
					sysvInstructions.push(new asm.MoveInstruction(
						target,
						{type: 'register', register: INTERMEDIATE_REGISTERS[Number(newInFirst)]}
					))
				}
				else evicted = undefined
				sysvInstructions.push(
					new asm.MoveInstruction({type: 'register', register: source}, target)
				)
			}
			for (let param = registerParams; param < params; param++) {
				const target = context.resolveParamDatum(param)
				const register = target.type === 'register'
					? target.register
					: INTERMEDIATE_REGISTERS[0]
				sysvInstructions.push(new asm.PopInstruction(register))
				if (target.type !== 'register') {
					sysvInstructions.push(
						new asm.MoveInstruction({type: 'register', register}, target)
					)
				}
			}
			sysvInstructions.push(new asm.JumpInstruction(functionLabel))
		}
		assemblySections.push(
			labels,
			saveInstructions,
			bodyAssembly,
			returnInstructions,
			sysvInstructions
		)
	}
	return {
		instructions: flatten(assemblySections),
		declarations
	}
}