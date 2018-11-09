import {Instruction} from './parse-instruction'
import {CodeSection, Export, FunctionType, Global, Section} from './parse-module'
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

class ModuleContext {
	readonly globalTypes: ValueType[] = []
	readonly exportFunctions = new Map<number, string[]>()
	readonly exportGlobals = new Map<number, string[]>()

	constructor(readonly index: number) {}

	addGlobals(globals: Global[]): void {
		this.globalTypes.push(...globals.map(({type}) => type.type))
	}
	addExports(exports: Export[]): void {
		for (const {name, description: {type, index}} of exports) {
			const exportMap =
				type === 'function' ? this.exportFunctions :
				type === 'global' ? this.exportGlobals :
				new Map<number, string[]>()
			const names = exportMap.get(index)
			if (names) names.push(name)
			else exportMap.set(index, [name])
		}
	}
	get initLabel(): string {
		return `MODULE${this.index}_INIT`
	}
	globalLabel(index: number): string {
		return `MODULE${this.index}_GLOBAL${index}`
	}
	functionLabel(index: number): string {
		return `MODULE${this.index}_FUNC${index}`
	}
	returnLabel(index: number): string {
		return `MODULE${this.index}_RETURN${index}`
	}
	exportLabel(type: string, name: string): string {
		return `MODULE${this.index}_EXPORT_${type}_${name}`
	}
	get memorySizeLabel(): string {
		return `MODULE${this.index}_MEMSIZE`
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
		const resolvedIndex = this.resolveStack(this.stackHeight - 1)
		this.pop()
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

const MMAP_SYSCALL_REGISTERS = new Array<asm.Register>('rax', 'rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9')
	.filter(register => !GENERAL_REGISTERS.includes(register))
const PAGE_BITS: asm.Datum = {type: 'immediate', value: 16}
// PROT_READ | PROT_WRITE
const PROT_READ_WRITE: asm.Datum = {type: 'immediate', value: 0x1 | 0x2}
// MAP_SHARED | MAP_FIXED | MAP_ANONYMOUS
const MMAP_FLAGS: asm.Datum = {type: 'immediate', value: 0x01 | 0x10 | 0x20}
const compareOperations = new Map<string, asm.JumpCond>([
	['lt_u', 'b'],
	['gt_s', 'g']
])
const arithmeticOperations = new Map([
	['add', asm.AddInstruction],
	['sub', asm.SubInstruction],
	['and', asm.AndInstruction],
	['or', asm.OrInstruction],
	['shl', asm.ShlInstruction],
	['shr_u', asm.ShrInstruction],
	['rotr', asm.RorInstruction],
	['xor', asm.XorInstruction]
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
	output.push(new asm.Comment(
		JSON.stringify(instruction, (_, v) => typeof v === 'bigint' ? Number(v) : v)
	))
	// console.log('Compiling', instruction.type, 'initial height', context.stackHeight)
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
			output.push(new asm.JumpInstruction({
				type: 'label',
				label: context.moduleContext.returnLabel(context.functionIndex)
			}))
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
				new asm.JumpInstruction(
					{type: 'label', label: hasElse ? elseLabel! : endLabel},
					'e'
				)
			)
			for (const instruction of ifInstructions) compileInstruction(instruction, context, output)
			if (hasElse) {
				containingLabels.pop()
				containingLabels.push({
					label: elseLabel!,
					stackHeight,
					result: returns !== 'empty'
				})
				output.push(
					new asm.JumpInstruction({type: 'label', label: endLabel}),
					new asm.Label(elseLabel)
				)
				for (const instruction of elseInstructions) compileInstruction(instruction, context, output)
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
					new asm.JumpInstruction({type: 'label', label: endLabel}, 'e')
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
					{type: 'immediate', value: popCount},
					{type: 'register', register: 'rsp'}
				))
			}
			if (moveResult) executePush(context, output, INTERMEDIATE_REGISTERS[0])
			output.push(new asm.JumpInstruction({type: 'label', label}))
			if (endLabel) output.push(new asm.Label(endLabel))
			break
		}
		case 'call': {
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
			output.push(new asm.CallInstruction({
				type: 'label',
				label: context.moduleContext.functionLabel(func)
			}))
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
			const resolvedLocal = context.resolveParam(local)
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value!},
				resolvedLocal instanceof BPRelative
					? resolvedLocal.datum
					: {type: 'register', register: resolvedLocal}
			))
			if (tee) context.push()
			break
		}
		case 'get_global': {
			const {global} = instruction
			const width = typeWidth(context.moduleContext.globalTypes[global])
			let target = context.resolvePush()
			const push = !target
			if (push) target = INTERMEDIATE_REGISTERS[0]
			output.push(new asm.MoveInstruction(
				{type: 'label', label: context.moduleContext.globalLabel(global)},
				{type: 'register', register: target!, width}
			))
			if (push) output.push(new asm.PushInstruction(target!))
			break
		}
		case 'set_global': {
			const {global} = instruction
			const width = typeWidth(context.moduleContext.globalTypes[global])
			let value = context.resolvePop()
			if (!value) {
				value = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(value))
			}
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value, width},
				{type: 'label', label: context.moduleContext.globalLabel(global)}
			))
			break
		}
		case 'i32.load':
		case 'i32.load8_s':
		case 'i32.load8_u':
		case 'i32.load16_s':
		case 'i32.load16_u': {
			const {offset} = instruction.access
			let register = context.resolvePop()
			const onStack = !register
			if (!register) {
				register = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(register))
			}
			const address: asm.Datum = {type: 'register', register: INTERMEDIATE_REGISTERS[1]}
			output.push(
				new asm.MoveInstruction(
					{type: 'immediate', value: context.moduleContext.memoryStart + offset},
					address
				),
				new asm.AddInstruction({type: 'register', register}, address)
			)
			const source: asm.Datum = {...address, type: 'indirect'}
			const targetDatum: asm.Datum = {type: 'register', register, width: 'l'}
			const {type} = instruction
			if (type === 'i32.load') {
				output.push(new asm.MoveInstruction(source, targetDatum))
			}
			else {
				const signed = type.endsWith('_s')
				const width = type.startsWith('i32.load8') ? 'b' : 'w'
				output.push(new asm.MoveExtendInstruction(source, targetDatum, width, 'l', signed))
			}
			if (onStack) output.push(new asm.PushInstruction(register))
			context.push()
			break
		}
		case 'i32.store':
		case 'i32.store8':
		case 'i32.store16': {
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
			output.push(
				new asm.MoveInstruction(
					{type: 'immediate', value: context.moduleContext.memoryStart + offset},
					address
				),
				new asm.AddInstruction({type: 'register', register: index}, address)
			)
			const width = instruction.type === 'i32.store8' ? 'b' :
				instruction.type === 'i32.store16' ? 'w' : 'l'
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value, width},
				{...address, type: 'indirect'}
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
			const toPush: asm.Register[] = []
			for (const register of MMAP_SYSCALL_REGISTERS) {
				if (registersUsed.has(register)) toPush.push(register)
			}
			for (const register of toPush) output.push(new asm.PushInstruction(register))
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
			for (const register of reverse(toPush)) output.push(new asm.PopInstruction(register))
			let target = context.resolvePush()
			const push = !target
			if (push) target = INTERMEDIATE_REGISTERS[0]
			output.push(
				new asm.MoveInstruction(sizeLabel, {type: 'register', register: target!, width: 'l'}),
				new asm.AddInstruction({type: 'register', register: pagesAddRegister, width: 'l'}, sizeLabel)
			)
			if (push) output.push(new asm.PushInstruction(target!))
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
		case 'i32.lt_u':
		case 'i32.gt_s': {
			let arg2 = context.resolvePop()
			if (!arg2) {
				arg2 = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(arg2))
			}
			let arg1 = context.resolvePop()
			const onStack = !arg1
			if (onStack) {
				arg1 = INTERMEDIATE_REGISTERS[1]
				output.push(new asm.PopInstruction(arg1))
			}
			const [type, operation] = instruction.type.split('.')
			const cond = compareOperations.get(operation)
			if (!cond) throw new Error(`No comparison value found for ${instruction.type}`)
			const width = typeWidth(type as ValueType)
			const datum1: asm.Datum = {type: 'register', register: arg1!, width}
			const datum1Byte: asm.Datum = {...datum1, width: 'b'}
			output.push(
				new asm.CmpInstruction(datum1, {type: 'register', register: arg2, width}),
				new asm.SetInstruction(datum1Byte, cond),
				new asm.MoveExtendInstruction(datum1Byte, datum1, 'b', 'l', false)
			)
			context.push()
			if (onStack) output.push(new asm.PushInstruction(arg1!))
			break
		}
		case 'i32.add':
		case 'i32.sub':
		case 'i32.and':
		case 'i32.or':
		case 'i32.shl':
		case 'i32.shr_u':
		case 'i32.rotr':
		case 'i32.xor':
		case 'i64.shl':
		case 'i64.shr_u': {
			const [type, operation] = instruction.type.split('.')
			const shift = SHIFT_OPERATIONS.has(operation)
			const saveShiftRegister = shift && context.registersUsed().includes(SHIFT_REGISTER)
				? INTERMEDIATE_REGISTERS[2]
				: undefined
			if (saveShiftRegister) {
				output.push(new asm.MoveInstruction(
					{type: 'register', register: SHIFT_REGISTER},
					{type: 'register', register: saveShiftRegister}
				))
			}
			let operand2 = context.resolvePop()
			if (!operand2) {
				operand2 = INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(operand2))
			}
			let operand1 = context.resolvePop()
			const pushResult = !operand1
			if (pushResult) {
				operand1 = INTERMEDIATE_REGISTERS[1]
				output.push(new asm.PopInstruction(operand1))
			}
			const arithmeticInstruction = arithmeticOperations.get(operation)
			if (!arithmeticInstruction) throw new Error(`No arithmetic instruction found for ${instruction.type}`)
			const width = typeWidth(type as ValueType)
			output.push(new arithmeticInstruction(
				shift
					? {type: 'register', register: SHIFT_REGISTER, width: 'b'}
					: {type: 'register', register: operand2, width},
				{type: 'register', register: operand1!, width}
			))
			context.push()
			if (pushResult) output.push(new asm.PushInstruction(operand1!))
			if (saveShiftRegister) {
				output.push(new asm.MoveInstruction(
					{type: 'register', register: saveShiftRegister},
					{type: 'register', register: SHIFT_REGISTER}
				))
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
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value!, width: 'l'},
				{type: 'register', register: value!, width: 'l'}
			))
			context.push()
			if (onStack) output.push(new asm.PushInstruction(value!))
			break
		}
		case 'i64.extend_u':
			break // 32-bit values are already stored with upper bits zeroed
		default:
			throw new Error(`Unable to compile instruction of type ${instruction.type}`)
	}
	// console.log('\t', context.stackHeight)
}

export function compileModule(module: Section[], index: number): asm.AssemblyInstruction[] {
	const initInstructions: asm.AssemblyInstruction[] = [new asm.Directive({type: 'text'})]
	let types: FunctionType[] | undefined
	let functionsTypes: FunctionType[] | undefined
	let functionsLocals: ValueType[][] | undefined
	const moduleContext = new ModuleContext(index)
	let codeSection: CodeSection | undefined
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
			case 'global':
				const {globals} = section
				moduleContext.addGlobals(globals)
				const globalContext = new CompilationContext(
					moduleContext,
					new Map([[0, {params: [], locals: [], result: false}]]),
					0
				)
				initInstructions.push(new asm.Label(moduleContext.initLabel))
				for (let global = 0; global < globals.length; global++) {
					for (const instruction of globals[global].initializer) {
						compileInstruction(instruction, globalContext, initInstructions)
					}
					compileInstruction({type: 'set_global', global}, globalContext, initInstructions)
				}
				initInstructions.push(new asm.RetInstruction)
				break
			case 'export':
				moduleContext.addExports(section.exports)
		}
	}
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
	const {globalTypes} = moduleContext
	const globalInstructions: asm.AssemblyInstruction[] = [new asm.Directive({type: 'data'})]
	for (let i = 0; i < globalTypes.length; i++) {
		const directives = WASM_TYPE_DIRECTIVES.get(globalTypes[i])
		if (!directives) throw new Error('Unable to emit global of type ' + globalTypes[i])
		globalInstructions.push(directives.align)
		for (const label of moduleContext.exportGlobals.get(i) || []) {
			const exportLabel = moduleContext.exportLabel('GLOBAL', label)
			globalInstructions.push(
				new asm.Directive({type: 'globl', args: [exportLabel]}),
				new asm.Label(exportLabel)
			)
		}
		globalInstructions.push(
			new asm.Label(moduleContext.globalLabel(i)),
			directives.data
		)
	}
	const assemblySections = [globalInstructions, initInstructions]
	const {segments} = codeSection
	for (let i = 0; i < segments.length; i++) {
		const context = new CompilationContext(moduleContext, functionsStats, i)
		const bodyAssembly: asm.AssemblyInstruction[] = []
		const {instructions} = segments[i]
		for (const instruction of instructions) {
			compileInstruction(instruction, context, bodyAssembly)
		}
		const registersUsed = context.registersUsed(true)
		const saveInstructions: asm.AssemblyInstruction[] = []
		for (const register of registersUsed) {
			saveInstructions.push(new asm.PushInstruction(register))
		}
		if (context.usesBP) {
			saveInstructions.push(new asm.MoveInstruction(
				{type: 'register', register: 'rsp'},
				{type: 'register', register: 'rbp'}
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
		for (const register of reverse(registersUsed)) {
			returnInstructions.push(new asm.PopInstruction(register))
		}
		returnInstructions.push(new asm.RetInstruction)
		const labels: asm.AssemblyInstruction[] = []
		for (const label of moduleContext.exportFunctions.get(i) || []) {
			const exportLabel = moduleContext.exportLabel('FUNC', label)
			labels.push(
				new asm.Directive({type: 'globl', args: [exportLabel]}),
				new asm.Label(exportLabel)
			)
		}
		labels.push(new asm.Label(context.moduleContext.functionLabel(i)))
		assemblySections.push(
			labels,
			saveInstructions,
			bodyAssembly,
			returnInstructions
		)
	}
	return flatten(assemblySections)
}