import {FunctionDeclaration, getCType, GlobalDeclaration, HeaderDeclaration} from './c-header'
import {Instruction, ResultType} from './parse-instruction'
import {CodeSection, Export, FunctionType, Global, GlobalType, Import, Section} from './parse-module'
import {ValueType} from './parse-value-type'
import * as asm from './x86_64-asm'

function* reverse<A>(arr: A[]) {
	for (let i = arr.length - 1; i >= 0; i--) yield arr[i]
}
const flatten = <A>(sections: A[][]) => ([] as A[]).concat(...sections)

const INT_INTERMEDIATE_REGISTERS: asm.Register[] = ['rax', 'rcx', 'rdx']
const [INT_RESULT_REGISTER] = INT_INTERMEDIATE_REGISTERS
const INT_GENERAL_REGISTERS: asm.Register[] = [
	'rdi', 'rsi',
	'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
	'rbx', 'rbp'
]
const SHIFT_REGISTER: asm.Register = 'rcx'
const SHIFT_REGISTER_DATUM: asm.Datum = {type: 'register', register: SHIFT_REGISTER}
const SHIFT_REGISTER_BYTE: asm.Datum = {...SHIFT_REGISTER_DATUM, width: 'b'}
const DIV_LOWER_REGISTER: asm.Register = 'rax'
const DIV_LOWER_DATUM = {type: 'register' as const, register: DIV_LOWER_REGISTER}
const DIV_UPPER_REGISTER: asm.Register = 'rdx'
const DIV_UPPER_DATUM = {type: 'register' as const, register: DIV_UPPER_REGISTER}
const SYSV_INT_PARAM_REGISTERS: asm.Register[] =
	['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9']
const SYSV_FLOAT_PARAM_REGISTERS =
	new Array(8).fill(0).map((_, i) => `xmm${i}` as asm.Register)
const SYSV_CALLEE_SAVE_REGISTERS: asm.Register[] =
	['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15']
const SYSV_CALLEE_SAVE_SET = new Set(SYSV_CALLEE_SAVE_REGISTERS)
const FLOAT_INTERMEDIATE_COUNT = 3
const FLOAT_INTERMEDIATE_REGISTERS: asm.Register[] = ['xmm0', 'xmm1', 'xmm15']
const [FLOAT_RESULT_REGISTER] = FLOAT_INTERMEDIATE_REGISTERS
const FLOAT_GENERAL_REGISTERS = new Array(16 - FLOAT_INTERMEDIATE_COUNT)
	.fill(0).map((_, i) => `xmm${i + 2}` as asm.Register)

export const INVALID_EXPORT_CHAR = /[^A-Za-z0-9_]/g

class SPRelative {
	private readonly stackOffset: number
	constructor(index: number, stackValues: number) {
		this.stackOffset = stackValues - index - 1
	}
	get datum(): asm.Datum {
		return {...STACK_TOP, immediate: this.stackOffset << 3}
	}
}

const typeWidth = (type: ValueType): asm.Width =>
	type === 'i32' ? 'l' :
	type === 'i64' ? 'q' :
	type === 'f32' ? 's' : 'd'
const isFloat = (type: ValueType): boolean =>
	type[0] === 'f'

interface BlockReference {
	loop: boolean // whether inside a loop
	label: string
	intStackHeight: number
	floatStackHeight: number
	result?: ValueType
}
interface FunctionStats {
	params: ValueType[]
	locals: ValueType[]
	result?: ValueType
}
interface LocalLocation {
	float: boolean
	index: number
}
interface StackState {
	intStackHeight: number
	floatStackHeight: number
	stackFloats: boolean[]
}

const getFunctionStats =
	({params, results}: FunctionType, locals: ValueType[] = []): FunctionStats => ({
		params,
		locals,
		result: (results as [ValueType?])[0]
	})
const getGeneralRegisters = (float: boolean) =>
	float ? FLOAT_GENERAL_REGISTERS : INT_GENERAL_REGISTERS

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
	private types: FunctionType[] | undefined
	private readonly functionStats = new Map<number, FunctionStats>()
	private memoryMax: number | undefined

	constructor(
		readonly index: number,
		readonly moduleIndices: ModuleIndices
	) {}

	addGlobals(globals: Global[]): void {
		this.globalTypes.push(...globals.map(({type}) => type))
	}
	addExports(exportSection: Export[]): void {
		for (let {name, description: {type, index}} of exportSection) {
			name = name.replace(INVALID_EXPORT_CHAR, '_')
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
	setTypes(types: FunctionType[]): void {
		this.types = types
	}
	getType(index: number): FunctionType {
		if (!this.types) throw new Error('No types defined')
		return this.types[index]
	}
	getFunctionIndex(segmentIndex: number): number {
		return this.baseFunctionIndex + segmentIndex
	}
	setFunctionStats(segmentIndex: number, stats: FunctionStats): void {
		this.functionStats.set(this.getFunctionIndex(segmentIndex), stats)
	}
	makeFunctionContext(functionIndex: number): CompilationContext {
		// TODO: can this context be cached to avoid recomputing the context for the same function?
		const thisStats = this.functionStats.get(functionIndex)
		if (!thisStats) throw new Error(`No function stats for function ${functionIndex}`)
		return new CompilationContext(this, thisStats, functionIndex)
	}
	private get baseFunctionIndex(): number {
		return this.importFunctions.length
	}
	private get baseGlobalIndex(): number {
		return this.importGlobals.length
	}
	resolveGlobalType(index: number): ValueType {
		const moduleGlobalIndex = index - this.baseGlobalIndex
		return moduleGlobalIndex < 0
			? this.importGlobalTypes[index]
			: this.globalTypes[moduleGlobalIndex].type
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
	tableLabel(index: number): string {
		return `${this.modulePrefix}_TABLE${index}`
	}
	get memorySizeLabel(): string {
		return `${this.modulePrefix}_MEMSIZE`
	}
	get memoryStart(): number {
		return 0x100000000 * (this.index + 1)
	}
	setMemoryMax(max?: number): void {
		this.memoryMax = max
	}
	get maxPages(): number {
		// Can't have more than 2 ** 32 / 2 ** 16 == 2 ** 16 pages
		return this.memoryMax === undefined ? 1 << 16 : this.memoryMax
	}
}
class CompilationContext {
	readonly params: LocalLocation[]
	readonly locals: LocalLocation[]
	readonly result?: ValueType
	private intLocalCount = 0
	private floatLocalCount = 0
	private stackFloats: boolean[] = []
	private intStackHeight = 0
	private floatStackHeight = 0
	private maxIntStackHeight = 0
	private maxFloatStackHeight = 0
	private labelCount = 0
	private readonly containingLabels: BlockReference[] = []

	constructor(
		readonly moduleContext: ModuleContext,
		{params, locals, result}: FunctionStats,
		private readonly index?: number
	) {
		const getLocalLocation = (param: ValueType): LocalLocation => {
			const float = isFloat(param)
			return {
				float,
				index: float ? this.floatLocalCount++ : this.intLocalCount++
			}
		}
		this.params = params.map(getLocalLocation)
		this.locals = locals.map(getLocalLocation)
		this.result = result
	}

	push(float: boolean): void {
		this.stackFloats.push(float)
		if (float) {
			this.maxFloatStackHeight =
				Math.max(++this.floatStackHeight, this.maxFloatStackHeight)
		}
		else {
			this.maxIntStackHeight =
				Math.max(++this.intStackHeight, this.maxIntStackHeight)
		}
	}
	pop(): boolean {
		const float = this.peek()
		this.stackFloats.pop()
		if (float) this.floatStackHeight--
		else this.intStackHeight--
		return float
	}
	peek(): boolean {
		const stackHeight = this.stackFloats.length
		if (!stackHeight) throw new Error('Empty stack')
		return this.stackFloats[stackHeight - 1]
	}
	private localsAndStackHeight(float: boolean): number {
		return float
			? this.floatLocalCount + this.floatStackHeight
			: this.intLocalCount + this.intStackHeight
	}
	private getValuesAfterRegisters(totalValues: number, float: boolean): number {
		return Math.max(totalValues - getGeneralRegisters(float).length, 0)
	}
	getValuesOnStack(float: boolean): number {
		return this.getValuesAfterRegisters(this.localsAndStackHeight(float), float)
	}
	getParam(paramIndex: number) {
		const localIndex = paramIndex - this.params.length
		return localIndex < 0 ? this.params[paramIndex] : this.locals[localIndex]
	}
	resolveParam(paramIndex: number): asm.Register | SPRelative {
		const {float, index} = this.getParam(paramIndex)
		const generalRegisters = getGeneralRegisters(float)
		const stackIndex = index - generalRegisters.length
		return stackIndex < 0
			? generalRegisters[index]
			: new SPRelative( // all floats are stored after all ints
					float ? this.stackIntLocals + stackIndex : stackIndex,
					this.getValuesOnStack(false) + this.getValuesOnStack(true)
				)
	}
	resolveParamDatum(index: number): asm.Datum {
		const resolved = this.resolveParam(index)
		return resolved instanceof SPRelative
			? resolved.datum
			: {type: 'register', register: resolved}
	}
	resolveLocal(index: number): asm.Register | SPRelative {
		return this.resolveParam(this.params.length + index)
	}
	resolveLocalDatum(index: number): asm.Datum {
		return this.resolveParamDatum(this.params.length + index)
	}
	private resolveStackTop(float: boolean): asm.Register | undefined {
		return (getGeneralRegisters(float) as (asm.Register | undefined)[])
			[this.localsAndStackHeight(float)]
	}
	resolvePush(float: boolean): asm.Register | undefined {
		const resolved = this.resolveStackTop(float)
		this.push(float)
		return resolved
	}
	resolvePop(): asm.Register | undefined {
		const float = this.pop()
		return this.resolveStackTop(float)
	}
	// If wholeFunction is true, maxStackHeight is used and params are excluded
	registersUsed(wholeFunction?: true): asm.Register[] {
		const toSave: asm.Register[] = []
		if (!wholeFunction) {
			const {params} = this
			for (let i = 0; i < params.length; i++) {
				const resolved = this.resolveParam(i)
				if (!(resolved instanceof SPRelative)) toSave.push(resolved)
			}
		}
		const {
			locals,
			intStackHeight: originalIntHeight,
			floatStackHeight: originalFloatHeight
		} = this
		for (let i = 0; i < locals.length; i++) {
			const resolved = this.resolveLocal(i)
			if (!(resolved instanceof SPRelative)) toSave.push(resolved)
		}
		let intStackHeight: number, floatStackHeight: number
		if (wholeFunction) {
			({maxIntStackHeight: intStackHeight, maxFloatStackHeight: floatStackHeight} = this)
		}
		else {
			({intStackHeight, floatStackHeight} = this)
		}
		for (let stackHeight = 0; stackHeight < intStackHeight; stackHeight++) {
			this.intStackHeight = stackHeight
			const resolved = this.resolveStackTop(false)
			if (resolved) toSave.push(resolved)
		}
		for (let stackHeight = 0; stackHeight < floatStackHeight; stackHeight++) {
			this.floatStackHeight = stackHeight
			const resolved = this.resolveStackTop(true)
			if (resolved) toSave.push(resolved)
		}
		this.intStackHeight = originalIntHeight
		this.floatStackHeight = originalFloatHeight
		return toSave
	}
	get functionIndex(): number {
		if (this.index === undefined) throw new Error('Outside function context')
		return this.index
	}
	makeLabel(prefix: string): string {
		const functionLabel = this.index === undefined
			? 'GLOBAL'
			: this.moduleContext.functionLabel(this.index)
		return `${functionLabel}_${prefix}${++this.labelCount}`
	}
	getStackHeight(float: boolean): number {
		return float ? this.floatStackHeight : this.intStackHeight
	}
	get stackState(): StackState {
		return {
			intStackHeight: this.intStackHeight,
			floatStackHeight: this.floatStackHeight,
			stackFloats: this.stackFloats.slice()
		}
	}
	restoreStackState({intStackHeight, floatStackHeight, stackFloats}: StackState) {
		this.intStackHeight = intStackHeight
		this.floatStackHeight = floatStackHeight
		this.stackFloats = stackFloats.slice()
	}
	pushLabel(loop: boolean, label: string, returns: ResultType): void {
		this.containingLabels.push({
			loop,
			label,
			intStackHeight: this.intStackHeight,
			floatStackHeight: this.floatStackHeight,
			result: returns === 'empty' ? undefined : returns
		})
	}
	popLabel(): void {
		this.containingLabels.pop()
	}
	getNestedLabel(nesting: number): BlockReference | undefined {
		return (this.containingLabels as (BlockReference | undefined)[])
			[this.containingLabels.length - nesting - 1]
	}
	private get stackIntLocals(): number {
		return this.getValuesAfterRegisters(this.intLocalCount, false)
	}
	private get stackFloatLocals(): number {
		return this.getValuesAfterRegisters(this.floatLocalCount, true)
	}
	get stackLocals(): number {
		return this.stackIntLocals + this.stackFloatLocals
	}
}

function unwindStack(
	intStackHeight: number,
	floatStackHeight: number,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
) {
	let popCount = 0
	while (
		context.getStackHeight(false) > intStackHeight ||
		context.getStackHeight(true) > floatStackHeight
	) {
		if (!context.resolvePop()) popCount++
	}
	if (popCount) {
		output.push(new asm.AddInstruction(
			{type: 'immediate', value: popCount << 3},
			{type: 'register', register: 'rsp'}
		))
	}
}
function relocateArguments(
	moves: Map<asm.Register, asm.Datum>,
	stackParams: asm.Datum[],
	saveRegisters: Set<asm.Register>
) {
	let evicted: {original: asm.Register, current: asm.Register} | undefined
	const toRestore: asm.Register[] = []
	const instructions: asm.AssemblyInstruction[] = []
	while (moves.size) {
		let source: asm.Register, target: asm.Datum
		if (evicted) {
			const {original, current} = evicted
			source = current
			const maybeTarget = moves.get(original)
			if (!maybeTarget) throw new Error('Expected a parameter target')
			target = maybeTarget
			moves.delete(original)
		}
		else {
			[source, target] = moves.entries().next().value
			moves.delete(source)
		}
		if (target.type === 'register') {
			const {register} = target
			if (moves.has(register)) {
				// %rax and %xmm15 are not used for SysV params
				let [evictTo] = INT_INTERMEDIATE_REGISTERS
				if (evictTo === source) evictTo = FLOAT_INTERMEDIATE_REGISTERS[2]
				evicted = {original: register, current: evictTo}
				instructions.push(new asm.MoveInstruction(
					target, {type: 'register', register: evictTo}, 'q'
				))
			}
			else evicted = undefined
			if (saveRegisters.has(register)) toRestore.push(register)
		}
		else evicted = undefined
		if (!(target.type === 'register' && target.register === source)) {
			instructions.push(new asm.MoveInstruction(
				{type: 'register', register: source}, target, 'q'
			))
		}
	}
	for (const datum of stackParams) {
		let register: asm.Register
		let intermediate: boolean
		if (datum.type === 'register') {
			({register} = datum)
			intermediate = false
			if (saveRegisters.has(register)) toRestore.push(register)
		}
		else {
			[register] = INT_INTERMEDIATE_REGISTERS // can't move directly to SIMD
			intermediate = true
		}
		instructions.push(new asm.PopInstruction(register))
		if (intermediate) {
			instructions.push(new asm.MoveInstruction(
				{type: 'register', register}, datum, 'q'
			))
		}
	}
	return {toRestore, instructions}
}
function compileBranch(nesting: number, context: CompilationContext, output: asm.AssemblyInstruction[]): string | undefined {
	const block = context.getNestedLabel(nesting)
	if (!block) {
		compileReturn(context, output)
		return
	}

	const {loop, label, intStackHeight, floatStackHeight, result} = block
	let resultRegister: asm.Register | undefined
	let float: boolean
	const saveResult = !(loop || !result)
	if (saveResult) {
		float = isFloat(result!)
		const toPop = context.resolvePop()
		if (
			// If the relevant stack needs to be unwound,
			context.getStackHeight(float) > (float ? floatStackHeight : intStackHeight) ||
			// or if the other stack needs to be unwound and the result value is on the stack
			context.getStackHeight(!float) > (float ? intStackHeight : floatStackHeight)
				&& context.getValuesOnStack(float)
		) {
			// Result is going to be moved
			[resultRegister] =
				float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
			output.push(toPop
				? new asm.MoveInstruction(
						{type: 'register', register: toPop},
						{type: 'register', register: resultRegister},
						'q'
					)
				: new asm.PopInstruction(resultRegister)
			)
		}
	}
	unwindStack(intStackHeight, floatStackHeight, context, output)
	if (saveResult) {
		const target = context.resolvePush(float!)
		if (resultRegister) {
			output.push(target
				? new asm.MoveInstruction(
						{type: 'register', register: resultRegister},
						{type: 'register', register: target},
						'q'
					)
				: new asm.PushInstruction(resultRegister)
			)
		}
	}
	output.push(new asm.JumpInstruction(label))
	return label
}
function popResultAndUnwind(context: CompilationContext, output: asm.AssemblyInstruction[]) {
	const {result} = context
	if (result) {
		const register = context.resolvePop()
		const resultRegister =
			isFloat(result) ? FLOAT_RESULT_REGISTER : INT_RESULT_REGISTER
		output.push(register
			? new asm.MoveInstruction(
					{type: 'register', register},
					{type: 'register', register: resultRegister},
					'q'
				)
			: new asm.PopInstruction(resultRegister)
		)
	}
	unwindStack(0, 0, context, output)
}
function compileReturn(context: CompilationContext, output: asm.AssemblyInstruction[]) {
	popResultAndUnwind(context, output)
	output.push(new asm.JumpInstruction(
		context.moduleContext.returnLabel(context.functionIndex)
	))
}

const STACK_TOP = {type: 'indirect' as const, register: 'rsp' as asm.Register}
const MMAP_SYSCALL_REGISTERS =
	new Array<asm.Register>('rax', 'rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9', 'rcx', 'r11')
	.filter(register => INT_GENERAL_REGISTERS.includes(register))
const MMAP_SYSCALL_REGISTER_SET = new Set(MMAP_SYSCALL_REGISTERS)
const SYSCALL_DATUM: asm.Datum = {type: 'register', register: 'rax'},
	MMAP_ADDR_DATUM = {type: 'register' as const, register: 'rdi' as asm.Register},
	MMAP_ADDR_INTERMEDIATE: asm.Datum =
		{type: 'register', register: INT_INTERMEDIATE_REGISTERS[2]},
	MMAP_LENGTH_DATUM = {type: 'register' as const, register: 'rsi' as asm.Register},
	MMAP_PROT_DATUM: asm.Datum = {type: 'register', register: 'rdx'},
	MMAP_FLAGS_DATUM: asm.Datum = {type: 'register', register: 'r10'},
	MMAP_FD_DATUM: asm.Datum = {type: 'register', register: 'r8'},
	MMAP_OFFSET_DATUM: asm.Datum = {type: 'register', register: 'r9'}
const PAGE_BITS: asm.Datum = {type: 'immediate', value: 16}
// PROT_READ | PROT_WRITE
const PROT_READ_WRITE: asm.Datum = {type: 'immediate', value: 0x1 | 0x2}
// MAP_SHARED | MAP_FIXED | MAP_ANONYMOUS
const MMAP_FLAGS: asm.Datum = {type: 'immediate', value: 0x01 | 0x10 | 0x20}
const compareOperations = new Map<string, asm.JumpCond>([
	['eqz', 'e'], ['eq', 'e'],
	['ne', 'ne'],
	['lt_s', 'l'],
	['lt_u', 'b'], ['lt', 'b'],
	['le_s', 'le'],
	['le_u', 'be'], ['le', 'be'],
	['gt_s', 'g'],
	['gt_u', 'a'], ['gt', 'a'],
	['ge_s', 'ge'],
	['ge_u', 'ae'], ['ge', 'ae']
])
const intArithmeticOperations = new Map([
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
const floatBinaryOperations = new Map([
	['add', asm.AddInstruction],
	['sub', asm.SubInstruction],
	['mul', asm.MulInstruction],
	['div', asm.DivBinaryInstruction],
	['min', asm.MinInstruction],
	['max', asm.MaxInstruction]
])
const roundModes = new Map([
	['nearest', 0],
	['floor', 1],
	['ceil', 2],
	['trunc', 3]
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
WASM_TYPE_DIRECTIVES.set('f32', WASM_TYPE_DIRECTIVES.get('i32')!)
WASM_TYPE_DIRECTIVES.set('f64', WASM_TYPE_DIRECTIVES.get('i64')!)
interface BranchResult {
	/** The possible block/loop/if labels that could be branched to */
	branches: Set<string>
	/** Whether a branch will definitely occur */
	definitely: boolean
}
function compileInstruction(
	instruction: Instruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): BranchResult {
	// output.push(new asm.Comment(
	// 	JSON.stringify(instruction, (_, v) => typeof v === 'bigint' ? String(v) : v)
	// ))
	const branches = new Set<string>()
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
			return {branches, definitely: true}
		case 'nop':
		case 'i64.extend_u': // 32-bit values are already stored with upper bits zeroed
			break
		case 'block':
		case 'loop': {
			const {type, returns, instructions} = instruction
			const {stackState} = context
			const blockLabel = context.makeLabel(type.toUpperCase())
			const loop = type === 'loop'
			if (loop) output.push(new asm.Label(blockLabel))
			context.pushLabel(loop, blockLabel, returns)
			const branch = compileInstructions(instructions, context, output)
			context.popLabel()
			if (!loop) output.push(new asm.Label(blockLabel))
			if (branch.definitely) {
				if (!branch.branches.has(blockLabel)) return branch
				if (loop && branch.branches.size === 1) { // infinite loop
					return {branches, definitely: true}
				}
			}

			for (const label of branch.branches) {
				if (label !== blockLabel) branches.add(label)
			}
			context.restoreStackState(stackState)
			if (returns !== 'empty') context.push(isFloat(returns))
			break
		}
		case 'if': {
			const {returns, ifInstructions, elseInstructions} = instruction
			const endLabel = context.makeLabel('IF_END')
			const hasElse = elseInstructions.length
			let elseLabel: string
			if (hasElse) elseLabel = context.makeLabel('ELSE')
			let cond = context.resolvePop()
			if (!cond) { // cond is on the stack
				[cond] = INT_INTERMEDIATE_REGISTERS
				output.push(new asm.PopInstruction(cond))
			}
			const {stackState} = context
			const datum: asm.Datum = {type: 'register', register: cond, width: 'l'}
			output.push(
				new asm.TestInstruction(datum, datum),
				new asm.JumpInstruction(hasElse ? elseLabel! : endLabel, 'e')
			)
			context.pushLabel(false, endLabel, returns)
			const branch = compileInstructions(ifInstructions, context, output)
			if (hasElse) {
				context.restoreStackState(stackState)
				if (!branch.definitely) output.push(new asm.JumpInstruction(endLabel))
				output.push(new asm.Label(elseLabel!))
				const {branches, definitely} =
					compileInstructions(elseInstructions, context, output)
				branch.definitely = branch.definitely && definitely
				for (const label of branches) branch.branches.add(label)
			}
			else branch.definitely = false
			context.popLabel()
			output.push(new asm.Label(endLabel))
			if (branch.definitely && !branch.branches.has(endLabel)) return branch

			for (const label of branch.branches) {
				if (label !== endLabel) branches.add(label)
			}
			context.restoreStackState(stackState)
			if (returns !== 'empty') context.push(isFloat(returns))
			break
		}
		case 'br':
		case 'br_if': {
			const {type, label} = instruction
			let endLabel: string | undefined
			let stackState: StackState
			if (type === 'br_if') {
				endLabel = context.makeLabel('BR_IF_END')
				let cond = context.resolvePop()
				if (!cond) {
					[cond] = INT_INTERMEDIATE_REGISTERS
					output.push(new asm.PopInstruction(cond))
				}
				({stackState} = context)
				const datum: asm.Datum = {type: 'register', register: cond, width: 'l'}
				output.push(
					new asm.TestInstruction(datum, datum),
					new asm.JumpInstruction(endLabel, 'e')
				)
			}
			const branch = compileBranch(label, context, output)
			if (branch) branches.add(branch)
			if (!endLabel) return {branches, definitely: true}

			context.restoreStackState(stackState!)
			output.push(new asm.Label(endLabel))
			break
		}
		case 'br_table': {
			const {cases, defaultCase} = instruction
			const numCases = cases.length
			let value = context.resolvePop()
			if (!value) {
				value = INT_INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(value))
			}
			const valueDatum: asm.Datum = {type: 'register', register: value}
			const tableLabel = context.makeLabel('BR_TABLE'),
			      defaultLabel = context.makeLabel('BR_TABLE_DEFAULT')
			const tableAddress = INT_INTERMEDIATE_REGISTERS[1]
			const addressDatum: asm.Datum = {type: 'register', register: tableAddress}
			output.push(
				new asm.CmpInstruction(
					{type: 'immediate', value: numCases}, {...valueDatum, width: 'l'}
				),
				new asm.JumpInstruction(defaultLabel, 'ae'),
				new asm.LeaInstruction({type: 'label', label: tableLabel}, addressDatum),
				new asm.MoveExtendInstruction(
					{type: 'indirect', register: tableAddress, offset: {register: value, scale: 4}},
					valueDatum,
					true, {src: 'l', dest: 'q'}
				),
				new asm.AddInstruction(valueDatum, addressDatum),
				new asm.JumpInstruction(addressDatum),
				new asm.Directive({type: 'section', args: ['.rodata']}),
				new asm.Directive({type: 'balign', args: [4]}),
				new asm.Label(tableLabel)
			)
			const {stackState} = context
			const caseInstructions: asm.AssemblyInstruction[] = []
			cases.forEach((nesting, i) => {
				const caseLabel = `${tableLabel}_${i}`
				output.push(new asm.Directive(
					{type: 'long', args: [caseLabel + ' - ' + tableLabel]}
				))
				caseInstructions.push(new asm.Label(caseLabel))
				const branch = compileBranch(nesting, context, caseInstructions)
				if (branch) branches.add(branch)
				context.restoreStackState(stackState)
			})
			output.push(
				new asm.Directive({type: 'text'}),
				...caseInstructions,
				new asm.Label(defaultLabel)
			)
			const branch = compileBranch(defaultCase, context, output)
			if (branch) branches.add(branch)
			return {branches, definitely: true}
		}
		case 'call':
		case 'call_indirect': {
			// TODO: need to know other modules' functionsStats
			const {moduleContext} = context
			let otherContext: CompilationContext
			let indexRegister: asm.Register
			if (instruction.type === 'call') {
				otherContext = moduleContext.makeFunctionContext(instruction.func)
			}
			else { // call_indirect
				otherContext = new CompilationContext(
					moduleContext,
					getFunctionStats(moduleContext.getType(instruction.funcType))
				)
				// Skip %rax since it may be clobbered by relocation
				indexRegister = INT_INTERMEDIATE_REGISTERS[1]
				const value = context.resolvePop()
				output.push(value
					? new asm.MoveInstruction(
							{type: 'register', register: value},
							{type: 'register', register: indexRegister}
						)
					: new asm.PopInstruction(indexRegister)
				)
			}
			const {params, result} = otherContext
			const registersUsed = new Set(context.registersUsed())
			const moves = new Map<asm.Register, asm.Datum>()
			const stackParams: asm.Datum[] = []
			for (let i = params.length - 1; i >= 0; i--) {
				const source = context.resolvePop()
				const target = otherContext.resolveParam(i)
				const datum: asm.Datum = target instanceof SPRelative
					? target.datum
					: {type: 'register', register: target}
				if (source) moves.set(source, datum)
				else stackParams.push(datum)
			}
			const {toRestore, instructions: relocateInstructions} =
				relocateArguments(moves, stackParams, registersUsed)
			const pushedRegisters = toRestore.length
			toRestore.forEach((register, i) => {
				output.push(new asm.MoveInstruction(
					{type: 'register', register},
					{type: 'indirect', register: 'rsp', immediate: -(i + 1) << 3},
					'q'
				))
			})
			output.push(...relocateInstructions)
			const stackPopped = stackParams.length
			if (pushedRegisters) { // point to end of pushedRegisters
				output.push(new asm.SubInstruction(
					{type: 'immediate', value: (stackPopped + pushedRegisters) << 3},
					{type: 'register', register: 'rsp'}
				))
			}
			if (instruction.type === 'call') {
				output.push(new asm.CallInstruction(
					moduleContext.getFunctionLabel(instruction.func)
				))
			}
			else {
				const table = {register: INT_INTERMEDIATE_REGISTERS[2]}
				output.push(
					new asm.LeaInstruction(
						{type: 'label', label: moduleContext.tableLabel(0)},
						{type: 'register', ...table}
					),
					new asm.CallInstruction({
						type: 'indirect',
						...table,
						offset: {register: indexRegister!, scale: 8}
					})
				)
			}
			for (const register of reverse(toRestore)) {
				output.push(new asm.PopInstruction(register))
			}
			if (pushedRegisters && stackPopped) { // point to actual stack location
				output.push(new asm.AddInstruction(
					{type: 'immediate', value: stackPopped << 3},
					{type: 'register', register: 'rsp'}
				))
			}
			if (result) {
				const float = isFloat(result)
				const resultRegister = float ? FLOAT_RESULT_REGISTER : INT_RESULT_REGISTER
				const pushTo = context.resolvePush(float)
				output.push(pushTo
					? new asm.MoveInstruction(
							{type: 'register', register: resultRegister},
							{type: 'register', register: pushTo},
							'q'
						)
					: new asm.PushInstruction(resultRegister)
				)
			}
			break
		}
		case 'return':
			compileReturn(context, output)
			return {branches, definitely: true}
		case 'drop':
			if (!context.resolvePop()) {
				output.push(new asm.AddInstruction(
					{type: 'immediate', value: 8},
					{type: 'register', register: 'rsp'}
				))
			}
			break
		case 'select': {
			let cond = context.resolvePop()
			if (!cond) {
				cond = INT_INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(cond))
			}
			const condDatum: asm.Datum = {type: 'register', register: cond, width: 'l'}
			const float = context.peek()
			const ifFalse = context.resolvePop()
			let ifFalseDatum: asm.Datum
			if (ifFalse) {
				ifFalseDatum = {type: 'register', register: ifFalse}
				if (float) {
					// Put floats in an int register so we can use a cmov instruction
					const newIfFalse = INT_INTERMEDIATE_REGISTERS[1]
					const newDatum: asm.Datum = {type: 'register', register: newIfFalse}
					output.push(new asm.MoveInstruction(ifFalseDatum, newDatum, 'q'))
					ifFalseDatum = newDatum
				}
			}
			else {
				output.push(new asm.AddInstruction(
					{type: 'immediate', value: 8},
					{type: 'register', register: 'rsp'}
				))
				ifFalseDatum = {...STACK_TOP, immediate: -8}
			}
			const ifTrue = context.resolvePop() // also where the result will go
			const ifTrueDatum: asm.Datum =
				ifTrue ? {type: 'register', register: ifTrue} : STACK_TOP
			let ifTrueNewDatum: asm.Datum | undefined
			if (float || !ifTrue) {
				// Move result to an int register so we can use a cmov instruction
				const newIfTrue = INT_INTERMEDIATE_REGISTERS[2]
				ifTrueNewDatum = {type: 'register', register: newIfTrue}
				output.push(new asm.MoveInstruction(ifTrueDatum, ifTrueNewDatum, 'q'))
			}
			output.push(
				new asm.TestInstruction(condDatum, condDatum),
				new asm.CMoveInstruction(ifFalseDatum, ifTrueNewDatum || ifTrueDatum, 'e')
			)
			if (ifTrueNewDatum) {
				output.push(new asm.MoveInstruction(ifTrueNewDatum, ifTrueDatum, 'q'))
			}
			context.push(float)
			break
		}
		case 'get_local': {
			const {local} = instruction
			const {float} = context.getParam(local)
			const resolvedLocal = context.resolveParam(local)
			let target = context.resolvePush(float)
			if (resolvedLocal instanceof SPRelative) {
				const push = !target
				if (push) {
					[target] = float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
				}
				output.push(new asm.MoveInstruction(
					resolvedLocal.datum,
					{type: 'register', register: target!},
					'q'
				))
				if (push) output.push(new asm.PushInstruction(target!))
			}
			else {
				output.push(target
					? new asm.MoveInstruction(
							{type: 'register', register: resolvedLocal},
							{type: 'register', register: target},
							'q'
						)
					: new asm.PushInstruction(resolvedLocal)
				)
			}
			break
		}
		case 'set_local':
		case 'tee_local': {
			const {type, local} = instruction
			const {float} = context.getParam(local)
			const tee = type === 'tee_local'
			let value = context.resolvePop()
			if (!value) {
				[value] = float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
				output.push(tee
					? new asm.MoveInstruction(
							STACK_TOP, {type: 'register', register: value}, 'q'
						)
					: new asm.PopInstruction(value)
				)
			}
			if (tee) context.push(float)
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value!},
				context.resolveParamDatum(local),
				'q'
			))
			break
		}
		case 'get_global': {
			const {global} = instruction
			const type = context.moduleContext.resolveGlobalType(global)
			const float = isFloat(type)
			let target = context.resolvePush(float)
			const push = !target
			if (push) {
				[target] = float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
			}
			const width = typeWidth(type)
			output.push(new asm.MoveInstruction(
				{type: 'label', label: context.moduleContext.resolveGlobalLabel(global)},
				{type: 'register', register: target!, width},
				width
			))
			if (push) output.push(new asm.PushInstruction(target!))
			break
		}
		case 'set_global': {
			const {global} = instruction
			const type = context.moduleContext.resolveGlobalType(global)
			const float = isFloat(type)
			let value = context.resolvePop()
			if (!value) {
				[value] = float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
				output.push(new asm.PopInstruction(value))
			}
			const width = typeWidth(type)
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value, width},
				{type: 'label', label: context.moduleContext.resolveGlobalLabel(global)},
				width
			))
			break
		}
		case 'i32.load':
		case 'i64.load':
		case 'f32.load':
		case 'f64.load':
		case 'i32.load8_s':
		case 'i32.load8_u':
		case 'i32.load16_s':
		case 'i32.load16_u':
		case 'i64.load8_s':
		case 'i64.load8_u':
		case 'i64.load16_s':
		case 'i64.load16_u':
		case 'i64.load32_s':
		case 'i64.load32_u': {
			const {offset} = instruction.access
			let index = context.resolvePop()
			if (!index) {
				index = INT_INTERMEDIATE_REGISTERS[0]
				output.push(new asm.PopInstruction(index))
			}
			const address: asm.Datum =
				{type: 'register', register: INT_INTERMEDIATE_REGISTERS[1]}
			output.push(new asm.MoveInstruction(
				{type: 'immediate', value: context.moduleContext.memoryStart + offset},
				address
			))
			const source: asm.Datum =
				{type: 'indirect', register: address.register, offset: {register: index}}
			const [type, operation] = instruction.type.split('.') as [ValueType, string]
			const isLoad32U = operation === 'load32_u'
			const width = isLoad32U ? 'l' : typeWidth(type)
			const float = isFloat(type)
			let target = context.resolvePush(float)
			const toPush = !target
			if (toPush) {
				[target] = float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
			}
			const targetDatum: asm.Datum =
				{type: 'register', register: target!, width}
			output.push(operation === 'load' || isLoad32U
				? new asm.MoveInstruction(source, targetDatum, width)
				: new asm.MoveExtendInstruction(
						source,
						targetDatum,
						operation.endsWith('_s'),
						{
							src: operation.startsWith('load8') ? 'b' :
								operation.startsWith('load16') ? 'w' : 'l',
							dest: width
						}
					)
			)
			if (toPush) output.push(new asm.PushInstruction(target!))
			break
		}
		case 'i32.store':
		case 'i64.store':
		case 'f32.store':
		case 'f64.store':
		case 'i32.store8':
		case 'i32.store16':
		case 'i64.store8':
		case 'i64.store16':
		case 'i64.store32': {
			const {offset} = instruction.access
			const [type, operation] = instruction.type.split('.') as [ValueType, string]
			const float = isFloat(type)
			let value = context.resolvePop()
			if (!value) {
				[value] = float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
				output.push(new asm.PopInstruction(value))
			}
			let index = context.resolvePop()
			if (!index) {
				index = INT_INTERMEDIATE_REGISTERS[1]
				output.push(new asm.PopInstruction(index))
			}
			const address: asm.Datum =
				{type: 'register', register: INT_INTERMEDIATE_REGISTERS[2]}
			output.push(new asm.MoveInstruction(
				{type: 'immediate', value: context.moduleContext.memoryStart + offset},
				address
			))
			const width = operation === 'store8' ? 'b' :
				operation === 'store16' ? 'w' :
				operation === 'store32' ? 'l' :
				typeWidth(type)
			output.push(new asm.MoveInstruction(
				{type: 'register', register: value, width},
				{type: 'indirect', register: address.register, offset: {register: index}},
				width
			))
			break
		}
		case 'memory.size': {
			let target = context.resolvePush(false)
			const push = !target
			if (push) [target] = INT_INTERMEDIATE_REGISTERS
			output.push(new asm.MoveInstruction(
				{type: 'label', label: context.moduleContext.memorySizeLabel},
				{type: 'register', register: target!, width: 'l'}
			))
			if (push) output.push(new asm.PushInstruction(target!))
			break
		}
		case 'memory.grow': {
			let pages = context.resolvePop()
			if (!pages || MMAP_SYSCALL_REGISTER_SET.has(pages)) {
				// %rax and %rdx are used for mmap() arguments
				const newPages = INT_INTERMEDIATE_REGISTERS[1]
				output.push(pages
					? new asm.MoveInstruction(
							{type: 'register', register: pages},
							{type: 'register', register: newPages}
						)
					: new asm.PopInstruction(newPages)
				)
				pages = newPages
			}
			const pagesDatum: asm.Datum = {type: 'register', register: pages, width: 'l'}
			const totalPagesDatum: asm.Datum =
				{type: 'register', register: INT_INTERMEDIATE_REGISTERS[0], width: 'l'}
			const {moduleContext} = context
			const sizeLabel: asm.Datum = {type: 'label', label: moduleContext.memorySizeLabel}
			const failLabel = context.makeLabel('MMAP_FAIL'),
			      skipLabel = context.makeLabel('MMAP_SKIP'),
			      endLabel = context.makeLabel('MMAP_END')
			output.push(
				new asm.TestInstruction(pagesDatum, pagesDatum),
				new asm.JumpInstruction(skipLabel, 'e'), // mmap() of 0 pages isn't allowed
				new asm.MoveInstruction(sizeLabel, totalPagesDatum),
				new asm.AddInstruction(pagesDatum, totalPagesDatum),
				new asm.CmpInstruction(
					{type: 'immediate', value: moduleContext.maxPages}, totalPagesDatum
				),
				new asm.JumpInstruction(failLabel, 'a')
			)
			const registersUsed = new Set(context.registersUsed())
			const toRestore = [pages]
			for (const register of MMAP_SYSCALL_REGISTERS) {
				if (registersUsed.has(register)) toRestore.push(register)
			}
			for (const register of toRestore) {
				output.push(new asm.PushInstruction(register))
			}
			output.push(
				new asm.MoveInstruction(
					{type: 'immediate', value: asm.SYSCALL.mmap},
					SYSCALL_DATUM
				),
				new asm.MoveInstruction(sizeLabel, {...MMAP_ADDR_DATUM, width: 'l'}),
				new asm.ShlInstruction(PAGE_BITS, MMAP_ADDR_DATUM),
				new asm.MoveInstruction( // must mov 64-bit immediate to intermediate register
					{type: 'immediate', value: context.moduleContext.memoryStart},
					MMAP_ADDR_INTERMEDIATE
				),
				new asm.AddInstruction(MMAP_ADDR_INTERMEDIATE, MMAP_ADDR_DATUM),
				new asm.MoveInstruction(pagesDatum, {...MMAP_LENGTH_DATUM, width: 'l'}),
				new asm.ShlInstruction(PAGE_BITS, MMAP_LENGTH_DATUM),
				new asm.MoveInstruction(PROT_READ_WRITE, MMAP_PROT_DATUM),
				new asm.MoveInstruction(MMAP_FLAGS, MMAP_FLAGS_DATUM),
				new asm.MoveInstruction({type: 'immediate', value: -1}, MMAP_FD_DATUM),
				new asm.XorInstruction(MMAP_OFFSET_DATUM, MMAP_OFFSET_DATUM),
				new asm.SysCallInstruction
			)
			for (const register of reverse(toRestore)) {
				output.push(new asm.PopInstruction(register))
			}
			let result = context.resolvePush(false)
			const push = !result
			if (push) result = INT_INTERMEDIATE_REGISTERS[0]
			const datum: asm.Datum = {type: 'register', register: result!, width: 'l'}
			output.push(
				new asm.TestInstruction(SYSCALL_DATUM, SYSCALL_DATUM), // mmap() == -1 indicates failure
				new asm.JumpInstruction(failLabel, 'l'),
				new asm.MoveInstruction(sizeLabel, datum),
				new asm.AddInstruction(pagesDatum, sizeLabel),
				new asm.JumpInstruction(endLabel),
				new asm.Label(failLabel),
				new asm.MoveInstruction({type: 'immediate', value: -1}, datum),
				new asm.JumpInstruction(endLabel),
				new asm.Label(skipLabel),
				new asm.MoveInstruction(sizeLabel, datum),
				new asm.Label(endLabel)
			)
			if (push) output.push(new asm.PushInstruction(result!))
			break
		}
		case 'i32.const':
		case 'i64.const':
		case 'f32.const':
		case 'f64.const': {
			const [type] = instruction.type.split('.') as [ValueType, string]
			let {value} = instruction
			// Immediates cannot be loaded directly into SIMD registers
			const float = isFloat(type)
			if (float) {
				const double = type === 'f64'
				const dataView = new DataView(new ArrayBuffer(double ? 8 : 4))
				if (double) dataView.setFloat64(0, value as number, true)
				else dataView.setFloat32(0, value as number, true)
				value = double ? dataView.getBigInt64(0, true) : dataView.getInt32(0, true)
			}
			const target = context.resolvePush(float)
			const intermediate = !target || float
				? INT_INTERMEDIATE_REGISTERS[0]
				: target
			const intermediateDatum: asm.Datum = {type: 'register', register: intermediate}
			output.push(new asm.MoveInstruction(
				{type: 'immediate', value},
				{...intermediateDatum, width: type.endsWith('32') ? 'l' : 'q'}
			))
			if (target) {
				if (float) {
					output.push(new asm.MoveInstruction(
						intermediateDatum, {type: 'register', register: target}, 'q'
					))
				}
			}
			else output.push(new asm.PushInstruction(intermediate))
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
		case 'i64.ge_u':
		case 'f32.eq':
		case 'f32.ne':
		case 'f32.lt':
		case 'f32.gt':
		case 'f32.le':
		case 'f32.ge':
		case 'f64.eq':
		case 'f64.ne':
		case 'f64.lt':
		case 'f64.gt':
		case 'f64.le':
		case 'f64.ge': {
			const [type, operation] = instruction.type.split('.') as [ValueType, string]
			const width = typeWidth(type)
			const float = isFloat(type)
			let datum2: asm.Datum
			if (operation === 'eqz') datum2 = {type: 'immediate', value: 0}
			else {
				let arg2 = context.resolvePop()
				if (!arg2) {
					[arg2] = float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
					output.push(new asm.PopInstruction(arg2))
				}
				datum2 = {type: 'register', register: arg2, width}
			}
			const arg1 = context.resolvePop()
			const datum1: asm.Datum = arg1
				? {type: 'register', register: arg1, width}
				: STACK_TOP
			let resultRegister = context.resolvePush(false)
			const toPush = !resultRegister
			if (toPush) {
				[resultRegister] = INT_INTERMEDIATE_REGISTERS
			}
			const cond = compareOperations.get(operation)
			if (!cond) throw new Error(`No comparison value found for ${instruction.type}`)
			const result8: asm.Datum =
				{type: 'register', register: resultRegister!, width: 'b'}
			const result32: asm.Datum = {...result8, width: 'l'}
			let parityDatum: asm.Datum,
			    parityCond: asm.JumpCond,
			    parityInstruction: typeof asm.OrInstruction
			if (float) {
				parityDatum =
					{type: 'register', register: INT_INTERMEDIATE_REGISTERS[1], width: 'b'}
				if (operation === 'ne') { // negative comparison returns true on nan
					parityCond = 'p'
					parityInstruction = asm.OrInstruction
				}
				else { // positive comparison returns false on nan
					parityCond = 'np'
					parityInstruction = asm.AndInstruction
				}
			}
			output.push(
				new asm.CmpInstruction(datum2, datum1, width),
				new asm.SetInstruction(result8, cond)
			)
			if (float) {
				output.push(
					new asm.SetInstruction(parityDatum!, parityCond!),
					new parityInstruction!(parityDatum!, result8)
				)
			}
			output.push(new asm.MoveExtendInstruction(result8, result32, false))
			if (toPush) output.push(new asm.MoveInstruction(result32, STACK_TOP))
			break
		}
		case 'i32.clz':
		case 'i32.ctz':
		case 'i32.popcnt':
		case 'i64.clz':
		case 'i64.ctz':
		case 'i64.popcnt': {
			const [type, operation] = instruction.type.split('.') as [ValueType, string]
			const width = typeWidth(type)
			const asmInstruction = bitCountOperations.get(operation)
			if (!asmInstruction) throw new Error('No instruction found for ' + instruction.type)
			const arg = context.resolvePop()
			if (arg) {
				const datum: asm.Datum = {type: 'register', register: arg, width}
				output.push(new asmInstruction(datum, datum))
			}
			else {
				const result: asm.Datum =
					{type: 'register', register: INT_INTERMEDIATE_REGISTERS[0], width}
				output.push(
					new asmInstruction(STACK_TOP, result),
					new asm.MoveInstruction(result, STACK_TOP)
				)
			}
			context.push(false)
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
				// Using intermediate register 1 instead of 0 to avoid extra mov for shifts
				operand2 = INT_INTERMEDIATE_REGISTERS[1]
				output.push(new asm.PopInstruction(operand2))
			}
			const operand1 = context.resolvePop()
			const [type, operation] = instruction.type.split('.') as [ValueType, string]
			const shift = SHIFT_OPERATIONS.has(operation)
			const arithmeticInstruction = intArithmeticOperations.get(operation)
			if (!arithmeticInstruction) {
				throw new Error('No arithmetic instruction found for ' + instruction.type)
			}
			const width = typeWidth(type)
			let datum2: asm.Datum = {type: 'register', register: operand2}
			if (shift) {
				if (operand2 !== SHIFT_REGISTER) {
					output.push(new asm.MoveInstruction(datum2, SHIFT_REGISTER_DATUM))
				}
				datum2 = SHIFT_REGISTER_BYTE
			}
			else datum2.width = width
			output.push(new arithmeticInstruction(
				datum2,
				operand1
					? {type: 'register', register: operand1, width}
					: STACK_TOP,
				width
			))
			context.push(false)
			break
		}
		case 'i32.mul':
		case 'i64.mul': {
			let operand2 = context.resolvePop()
			if (!operand2) {
				[operand2] = INT_INTERMEDIATE_REGISTERS
				output.push(new asm.PopInstruction(operand2))
			}
			const operand1 = context.resolvePop()
			const width = instruction.type === 'i32.mul' ? 'l' : 'q'
			if (operand1) {
				output.push(new asm.ImulInstruction(
					{type: 'register', register: operand2, width},
					{type: 'register', register: operand1, width}
				))
			}
			else {
				const datum2: asm.Datum = {type: 'register', register: operand2, width}
				output.push(
					new asm.ImulInstruction(STACK_TOP, datum2),
					new asm.MoveInstruction(datum2, STACK_TOP)
				)
			}
			context.push(false)
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
			const [type, operation] = instruction.type.split('.')
			const [op, signedness] = operation.split('_')
			const i32 = type === 'i32'
			const width = i32 ? 'l' : 'q'
			const signed = signedness === 's'
			const datum2: asm.Datum = operand2
				? {type: 'register', register: operand2, width}
				: STACK_TOP
			if (op === 'rem' && signed) {
				// Special case for INT_MIN % -1, since the remainder
				// is 0 but the quotient (INT_MAX + 1) won't fit.
				// So, if the divisor is -1, set it to 1.
				const oneRegister: asm.Datum =
					{type: 'register', register: INT_INTERMEDIATE_REGISTERS[1], width}
				output.push(
					new asm.MoveInstruction({type: 'immediate', value: 1}, oneRegister),
					new asm.CmpInstruction({type: 'immediate', value: -1}, datum2, width),
					new asm.CMoveInstruction(oneRegister, datum2, 'e')
				)
			}
			const result = op === 'div' ? DIV_LOWER_DATUM : DIV_UPPER_DATUM
			if (operand1 !== DIV_LOWER_REGISTER) {
				output.push(new asm.MoveInstruction(datum1, DIV_LOWER_DATUM))
			}
			output.push(
				signed
					? i32 ? new asm.CdqoInstruction : new asm.CqtoInstruction
					: new asm.XorInstruction(DIV_UPPER_DATUM, DIV_UPPER_DATUM),
				new asm.DivInstruction(datum2, signed, width)
			)
			if (result.register !== datum1.register) {
				output.push(new asm.MoveInstruction(result, datum1))
			}
			context.push(false)
			break
		}
		case 'f32.abs':
		case 'f32.neg':
		case 'f32.copysign':
		case 'f64.abs':
		case 'f64.neg':
		case 'f64.copysign': {
			const [type, operation] = instruction.type.split('.') as [ValueType, string]
			const width = typeWidth(type)
			const wide = width === 'd'
			const highBitLoadDatum: asm.Datum =
				{type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
			const negZeroDatum: asm.Datum =
				{type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[0]}
			let negZero = 1n << (wide ? 63n : 31n)
			const setSignBit = operation === 'neg'
			if (!setSignBit) negZero ^= -1n // a bitmask to exclude the sign bit
			output.push(
				new asm.MoveInstruction(
					{type: 'immediate', value: negZero},
					{...highBitLoadDatum, width: wide ? 'q' : 'l'}
				),
				new asm.MoveInstruction(highBitLoadDatum, negZeroDatum, 'q')
			)
			let signDatum: asm.Datum | undefined
			if (operation === 'copysign') {
				let signOperand = context.resolvePop()
				if (!signOperand) {
					signOperand = FLOAT_INTERMEDIATE_REGISTERS[1]
					output.push(new asm.PopInstruction(signOperand))
				}
				signDatum = {type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[2]}
				output.push(
					new asm.MoveInstruction(negZeroDatum, signDatum, width),
					new asm.AndNotPackedInstruction(
						{type: 'register', register: signOperand}, signDatum, width
					)
				)
			}
			const operand = context.resolvePop()
			let datum: asm.Datum
			if (operand) datum = {type: 'register', register: operand}
			else {
				datum = {type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[1]}
				output.push(new asm.MoveInstruction(STACK_TOP, datum, width))
			}
			const maskInstruction =
				setSignBit ? asm.XorPackedInstruction : asm.AndPackedInstruction
			output.push(new maskInstruction(negZeroDatum, datum, width))
			if (signDatum) {
				// Doesn't matter whether this is OR or XOR, since bits are distinct
				output.push(new asm.XorPackedInstruction(signDatum, datum, width))
			}
			if (!operand) output.push(new asm.MoveInstruction(datum, STACK_TOP, width))
			context.push(true)
			break
		}
		case 'f32.ceil':
		case 'f32.floor':
		case 'f32.trunc':
		case 'f32.nearest':
		case 'f32.sqrt':
		case 'f64.ceil':
		case 'f64.floor':
		case 'f64.trunc':
		case 'f64.nearest':
		case 'f64.sqrt': {
			const [type, operation] = instruction.type.split('.') as [ValueType, string]
			const width = typeWidth(type)
			const operand = context.resolvePop()
			let datum: asm.Datum, result: asm.Datum
			if (operand) datum = result = {type: 'register', register: operand}
			else {
				datum = STACK_TOP
				result = {type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[0]}
			}
			if (operation === 'sqrt') {
				output.push(new asm.SqrtInstruction(datum, result, width))
			}
			else {
				const mode = roundModes.get(operation)
				if (mode === undefined) throw new Error('Unknown round type: ' + operation)
				output.push(new asm.RoundInstruction(mode, datum, result, width))
			}
			if (!operand) output.push(new asm.MoveInstruction(result, STACK_TOP, 'q'))
			context.push(true)
			break
		}
		case 'f32.add':
		case 'f32.sub':
		case 'f32.mul':
		case 'f32.div':
		case 'f32.min':
		case 'f32.max':
		case 'f64.add':
		case 'f64.sub':
		case 'f64.mul':
		case 'f64.div':
		case 'f64.min':
		case 'f64.max': {
			const [type, operation] = instruction.type.split('.') as [ValueType, string]
			const arithmeticInstruction = floatBinaryOperations.get(operation)
			if (!arithmeticInstruction) {
				throw new Error('No arithmetic instruction found for ' + instruction.type)
			}
			const width = typeWidth(type)
			const operand2 = context.resolvePop()
			let operand1 = context.resolvePop()
			const onStack = !operand1
			if (onStack) {
				[operand1] = FLOAT_INTERMEDIATE_REGISTERS
				output.push(new asm.MoveInstruction(
					{...STACK_TOP, immediate: 8}, {type: 'register', register: operand1}, 'q'
				))
			}
			const datum1: asm.Datum = {type: 'register', register: operand1!}
			output.push(new arithmeticInstruction(
				operand2 ? {type: 'register', register: operand2} : STACK_TOP,
				datum1,
				width
			))
			if (!operand2) {
				output.push(new asm.AddInstruction(
					{type: 'immediate', value: 8}, {type: 'register', register: 'rsp'}
				))
			}
			context.push(true)
			if (onStack) {
				output.push(new asm.MoveInstruction(datum1, STACK_TOP, 'q'))
			}
			break
		}
		case 'i32.wrap': {
			let value = context.resolvePop()
			const onStack = !value
			if (onStack) {
				[value] = INT_INTERMEDIATE_REGISTERS
				output.push(new asm.PopInstruction(value))
			}
			const register: asm.Datum = {type: 'register', register: value!, width: 'l'}
			output.push(new asm.MoveInstruction(register, register))
			context.push(false)
			if (onStack) output.push(new asm.PushInstruction(value!))
			break
		}
		case 'i32.trunc_s/f32':
		case 'i32.trunc_u/f32':
		case 'i32.trunc_s/f64':
		case 'i32.trunc_u/f64':
		case 'i64.trunc_s/f32':
		case 'i64.trunc_u/f32':
		case 'i64.trunc_s/f64':
		case 'i64.trunc_u/f64': {
			let [resultType, fullOperation] = instruction.type.split('.') as [ValueType, string]
			const [operation, sourceType] = fullOperation.split('/') as [string, ValueType]
			const sourceWidth = typeWidth(sourceType)
			const signed = operation.endsWith('_s')
			let operand = context.resolvePop()
			const onStack = !operand
			let datum: asm.Datum =
				operand ? {type: 'register', register: operand} : STACK_TOP
			let wrapTo32 = false
			let highBitDatum: asm.Datum | undefined
			if (!signed) {
				if (resultType === 'i32') {
					resultType = 'i64'
					wrapTo32 = true
				}
				else { // i64
					if (onStack) {
						operand = FLOAT_INTERMEDIATE_REGISTERS[0]
						datum = {type: 'register', register: operand}
						output.push(new asm.MoveInstruction(STACK_TOP, datum, 'q'))
					}
					const highBitThreshold = 2 ** 63
					const wideSource = sourceWidth === 'd'
					const dataView = new DataView(new ArrayBuffer(wideSource ? 8 : 4))
					if (wideSource) dataView.setFloat64(0, highBitThreshold, true)
					else dataView.setFloat32(0, highBitThreshold, true)
					const thresholdInt =
						wideSource ? dataView.getBigUint64(0, true) : dataView.getUint32(0, true)
					const thresholdIntDatum: asm.Datum =
						{type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
					const thresholdDatum: asm.Datum =
						{type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[0]}
					const label = context.makeLabel('CONVERT_U64_END')
					highBitDatum = {type: 'register', register: INT_INTERMEDIATE_REGISTERS[1]}
					output.push(
						new asm.XorInstruction(highBitDatum, highBitDatum),
						new asm.MoveInstruction(
							{type: 'immediate', value: thresholdInt},
							{...thresholdIntDatum, width: wideSource ? 'q' : 'l'}
						),
						new asm.MoveInstruction(thresholdIntDatum, thresholdDatum, 'q'),
						new asm.CmpInstruction(thresholdDatum, datum, sourceWidth),
						new asm.JumpInstruction(label, 'b'),
						new asm.MoveInstruction(
							{type: 'immediate', value: BigInt(highBitThreshold)}, highBitDatum
						),
						new asm.SubInstruction(thresholdDatum, datum, sourceWidth),
						new asm.Label(label)
					)
				}
			}
			let resultRegister = context.resolvePush(false)
			const toPush = !resultRegister
			if (toPush) [resultRegister] = INT_INTERMEDIATE_REGISTERS
			const resultDatum: asm.Datum =
				{type: 'register', register: resultRegister!, width: typeWidth(resultType)}
			output.push(new asm.CvtToIntInstruction(datum, resultDatum, sourceWidth))
			if (wrapTo32) {
				// i32 needs to be stored with upper 32 bits zeroed
				const lowDatum: asm.Datum = {...resultDatum, width: 'l'}
				output.push(new asm.MoveInstruction(lowDatum, lowDatum))
			}
			if (highBitDatum) {
				output.push(new asm.XorInstruction(highBitDatum, resultDatum))
			}
			const stackHeightChange = Number(toPush) - Number(onStack)
			if (stackHeightChange) {
				output.push(new asm.SubInstruction(
					{type: 'immediate', value: stackHeightChange << 3},
					{type: 'register', register: 'rsp'}
				))
			}
			if (toPush) output.push(new asm.MoveInstruction(resultDatum, STACK_TOP))
			break
		}
		case 'i64.extend_s': {
			let value = context.resolvePop()
			const onStack = !value
			if (onStack) {
				[value] = INT_INTERMEDIATE_REGISTERS
				output.push(new asm.PopInstruction(value))
			}
			output.push(new asm.MoveExtendInstruction(
				{type: 'register', register: value!, width: 'l'},
				{type: 'register', register: value!, width: 'q'},
				true
			))
			context.push(false)
			if (onStack) output.push(new asm.PushInstruction(value!))
			break
		}
		case 'f32.convert_s/i32':
		case 'f32.convert_u/i32':
		case 'f32.convert_s/i64':
		case 'f32.convert_u/i64':
		case 'f64.convert_s/i32':
		case 'f64.convert_u/i32':
		case 'f64.convert_s/i64':
		case 'f64.convert_u/i64': {
			const [resultType, fullOperation] = instruction.type.split('.') as [ValueType, string]
			let [operation, sourceType] = fullOperation.split('/') as [string, ValueType]
			const signed = operation.endsWith('_s')
			let operand = context.resolvePop()
			const onStack = !operand
			let datum: asm.Datum =
				operand ? {type: 'register', register: operand} : STACK_TOP
			let doubleNeededDatum: asm.Datum | undefined
			if (!signed) {
				if (sourceType === 'i32') sourceType = 'i64'
				else { // i64
					if (onStack) {
						operand = INT_INTERMEDIATE_REGISTERS[0]
						datum = {type: 'register', register: operand}
						output.push(new asm.MoveInstruction(STACK_TOP, datum))
					}
					const lowBitDatum: asm.Datum =
						{type: 'register', register: INT_INTERMEDIATE_REGISTERS[1]}
					doubleNeededDatum =
						{type: 'register', register: INT_INTERMEDIATE_REGISTERS[2]}
					const label = context.makeLabel('CONVERT_U64_END')
					output.push(
						// Modified from https://stackoverflow.com/a/11725575
						new asm.XorInstruction(doubleNeededDatum, doubleNeededDatum),
						new asm.TestInstruction(datum, datum),
						new asm.JumpInstruction(label, 'ns'),
						new asm.NotInstruction(doubleNeededDatum),
						new asm.MoveInstruction(datum, lowBitDatum),
						new asm.AndInstruction({type: 'immediate', value: 1}, lowBitDatum),
						new asm.ShrInstruction({type: 'immediate', value: 1}, datum),
						new asm.OrInstruction(lowBitDatum, datum),
						new asm.Label(label)
					)
				}
			}
			if (datum.type === 'register') datum.width = typeWidth(sourceType)
			const resultWidth = typeWidth(resultType)
			let resultRegister = context.resolvePush(true)
			const toPush = !resultRegister
			if (toPush) resultRegister = FLOAT_INTERMEDIATE_REGISTERS[0]
			const resultDatum: asm.Datum = {type: 'register', register: resultRegister!}
			output.push(new asm.CvtToFloatInstruction(datum, resultDatum, resultWidth))
			if (doubleNeededDatum) {
				const addDatum: asm.Datum =
					{type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[1]}
				const maskDatum: asm.Datum =
					{type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[2]}
				output.push(
					new asm.MoveInstruction(resultDatum, addDatum, resultWidth),
					new asm.MoveInstruction(doubleNeededDatum, maskDatum, 'q'),
					new asm.AndPackedInstruction(maskDatum, addDatum, resultWidth),
					new asm.AddInstruction(addDatum, resultDatum, resultWidth)
				)
			}
			const stackHeightChange = Number(toPush) - Number(onStack)
			if (stackHeightChange) {
				output.push(new asm.SubInstruction(
					{type: 'immediate', value: stackHeightChange << 3},
					{type: 'register', register: 'rsp'}
				))
			}
			if (toPush) output.push(new asm.MoveInstruction(resultDatum, STACK_TOP))
			break
		}
		case 'f32.demote':
		case 'f64.promote': {
			const operand = context.resolvePop()
			let source: asm.Datum, target: asm.Datum
			if (operand) source = target = {type: 'register', register: operand}
			else {
				source = STACK_TOP
				target = {type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[0]}
			}
			const [type] = instruction.type.split('.') as [ValueType]
			const targetWidth = typeWidth(type)
			output.push(new asm.CvtFloatInstruction(
				source, target, targetWidth === 's' ? 'd' : 's', targetWidth
			))
			if (!operand) {
				output.push(new asm.MoveInstruction(target, STACK_TOP, targetWidth))
			}
			context.push(true)
			break
		}
		case 'i32.reinterpret':
		case 'i64.reinterpret':
		case 'f32.reinterpret':
		case 'f64.reinterpret': {
			const operand = context.resolvePop()
			const [type] = instruction.type.split('.') as [ValueType]
			const float = isFloat(type)
			const result = context.resolvePush(float)
			if (operand) {
				output.push(result
					? new asm.MoveInstruction(
							{type: 'register', register: operand},
							{type: 'register', register: result},
							'q'
						)
					: new asm.PushInstruction(operand)
				)
			}
			else if (result) output.push(new asm.PopInstruction(result))
			break
		}
		default:
			const unreachable: never = instruction
			unreachable
	}
	return {branches, definitely: false}
}
function compileInstructions(
	instructions: Instruction[],
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): BranchResult {
	const allBranches = new Set<string>()
	for (const instruction of instructions) {
		const {branches, definitely} = compileInstruction(instruction, context, output)
		for (const label of branches) allBranches.add(label)
		if (definitely) return {branches: allBranches, definitely}
	}
	return {branches: allBranches, definitely: false}
}

function addSysvLabel(module: string, label: string, instructions: asm.AssemblyInstruction[]): string {
	const sysvLabel = `wasm_${module.replace(INVALID_EXPORT_CHAR, '_')}_${label}`
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
	let functionsTypes: FunctionType[] | undefined
	let functionsLocals: ValueType[][] | undefined
	const moduleContext = new ModuleContext(index, moduleIndices)
	const globalContext = new CompilationContext(moduleContext, {params: [], locals: []})
	let codeSection: CodeSection | undefined
	let memoriesCount = 0
	const initInstructions: Instruction[] = []
	const globalInstructions: asm.AssemblyInstruction[] =
		[new asm.Directive({type: 'data'})]
	const tableInitInstructions: asm.AssemblyInstruction[] = []
	let startFunc: number | undefined
	for (const section of module) {
		switch (section.type) {
			case 'type':
				moduleContext.setTypes(section.types)
				break
			case 'import':
				moduleContext.addImports(section.imports)
				break
			case 'function':
				functionsTypes = section.typeIndices
					.map(index => moduleContext.getType(index))
				break
			case 'table':
				globalInstructions.push(new asm.Directive({type: 'balign', args: [8]}))
				section.tables.forEach(({min}, i) => globalInstructions.push(
					new asm.Label(moduleContext.tableLabel(i)),
					...new Array<asm.Directive>(min).fill(
						new asm.Directive({type: 'quad', args: [0]})
					)
				))
				break
			case 'memory':
				const {memories} = section
				memoriesCount += memories.length
				if (memoriesCount > 1) throw new Error('Multiple memories')
				if (!memoriesCount) break
				const [{min, max}] = memories
				if (min) {
					initInstructions.push(
						{type: 'i32.const', value: min},
						{type: 'memory.grow'},
						{type: 'drop'}
					)
				}
				moduleContext.setMemoryMax(max)
				break
			case 'global':
				const {globals} = section
				moduleContext.addGlobals(globals)
				for (let global = 0; global < globals.length; global++) {
					initInstructions.push(
						...globals[global].initializer,
						{type: 'set_global', global}
					)
				}
				break
			case 'export':
				moduleContext.addExports(section.exports)
				break
			case 'start':
				startFunc = section.functionIndex
				break
			case 'element':
				for (const {tableIndex, offset, functionIndices} of section.initializers) {
					compileInstructions(offset, globalContext, tableInitInstructions)
					const tableRegister = INT_INTERMEDIATE_REGISTERS[0]
					tableInitInstructions.push(new asm.LeaInstruction(
						{type: 'label', label: moduleContext.tableLabel(tableIndex)},
						{type: 'register', register: tableRegister}
					))
					const addressDatum: asm.Datum =
						{type: 'register', register: INT_INTERMEDIATE_REGISTERS[1]}
					const offsetRegister = globalContext.resolvePop()!
					functionIndices.forEach((functionIndex, i) => {
						tableInitInstructions.push(
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
				break
			case 'code':
				codeSection = section
				functionsLocals = section.segments.map(({locals}) => locals)
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

						initInstructions.push(
							...offset,
							{type: 'i64.const', value: dataView.getBigUint64(byte, true)},
							{type: 'i64.store', access: {align: 0, offset: byte}}
						)
						byte = nextIndex
					}
					while (byte < byteLength) {
						initInstructions.push(
							...offset,
							{type: 'i32.const', value: dataView.getUint8(byte)},
							{type: 'i32.store8', access: {align: 0, offset: byte}}
						)
						byte++
					}
				}
		}
	}
	if (!(functionsTypes && functionsLocals && codeSection)) {
		throw new Error('Expected function and code sections')
	}
	for (let i = 0; i < functionsTypes.length; i++) {
		moduleContext.setFunctionStats(i, getFunctionStats(functionsTypes[i], functionsLocals[i]))
	}
	const declarations: HeaderDeclaration[] = []
	const {exportFunctions, exportGlobals, exportMemory, globalTypes} = moduleContext
	globalInstructions.push(new asm.Directive({type: 'balign', args: [4]}))
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
	const initAssembly: asm.AssemblyInstruction[] = []
	// Add initialization instructions if there is initialization to be done
	if (initInstructions.length || tableInitInstructions.length || startFunc !== undefined) {
		declarations.push(new FunctionDeclaration(
			'void',
			addSysvLabel(moduleName, 'init_module', initAssembly),
			['void']
		))
		for (const register of SYSV_CALLEE_SAVE_REGISTERS) {
			initAssembly.push(new asm.PushInstruction(register))
		}
		compileInstructions(initInstructions, globalContext, initAssembly)
		initAssembly.push(...tableInitInstructions)
		if (startFunc !== undefined) {
			compileInstruction(
				{type: 'call', func: startFunc}, globalContext, initAssembly
			)
		}
		for (const register of reverse(SYSV_CALLEE_SAVE_REGISTERS)) {
			initAssembly.push(new asm.PopInstruction(register))
		}
		initAssembly.push(new asm.RetInstruction)
	}
	const assemblySections = [
		globalInstructions,
		[new asm.Directive({type: 'text'})],
		initAssembly
	]
	codeSection.segments.forEach((segment, i) => {
		const functionIndex = moduleContext.getFunctionIndex(i)
		const context = moduleContext.makeFunctionContext(functionIndex)
		const bodyAssembly: asm.AssemblyInstruction[] = []
		const branches =
			compileInstructions(segment.instructions, context, bodyAssembly).definitely
		const registersUsed = context.registersUsed(true)
		const setupInstructions: asm.AssemblyInstruction[] = []
		for (const register of registersUsed) {
			setupInstructions.push(new asm.PushInstruction(register))
		}
		const {stackLocals} = context
		if (stackLocals) {
			setupInstructions.push(new asm.SubInstruction(
				{type: 'immediate', value: stackLocals << 3},
				{type: 'register', register: 'rsp'}
			))
		}
		context.locals.forEach(({float}, i) => {
			const datum = context.resolveLocalDatum(i)
			const zeroDatum: asm.Datum = float
				? {type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
				: datum
			setupInstructions.push(new asm.MoveInstruction(
				{type: 'immediate', value: 0}, zeroDatum, 'q'
			))
			if (float) {
				setupInstructions.push(new asm.MoveInstruction(zeroDatum, datum, 'q'))
			}
		})
		const returnInstructions: asm.AssemblyInstruction[] = []
		if (!branches) popResultAndUnwind(context, returnInstructions)
		returnInstructions.push(new asm.Label(moduleContext.returnLabel(functionIndex)))
		if (stackLocals) {
			returnInstructions.push(new asm.AddInstruction(
				{type: 'immediate', value: stackLocals << 3},
				{type: 'register', register: 'rsp'}
			))
		}
		for (const register of reverse(registersUsed)) {
			returnInstructions.push(new asm.PopInstruction(register))
		}
		returnInstructions.push(new asm.RetInstruction)
		const labels: asm.AssemblyInstruction[] = []
		const sysvInstructions: asm.AssemblyInstruction[] = []
		for (const label of exportFunctions.get(functionIndex) || []) {
			const exportLabel = moduleContext.exportLabel('FUNC', label)
			labels.push(
				new asm.Directive({type: 'globl', args: [exportLabel]}),
				new asm.Label(exportLabel)
			)
			const functionType = functionsTypes![i]
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
			const moves = new Map<asm.Register, asm.Datum>()
			let intParam = 0, floatParam = 0
			const stackParams: asm.Datum[] = []
			for (let param = 0; param < params.length; param++) {
				const {float} = params[param]
				const source: asm.Register | undefined = float
					? SYSV_FLOAT_PARAM_REGISTERS[floatParam++]
					: SYSV_INT_PARAM_REGISTERS[intParam++]
				const datum = context.resolveParamDatum(param)
				if (source) moves.set(source, datum)
				else stackParams.push(datum)
			}
			const {toRestore, instructions} =
				relocateArguments(moves, stackParams, SYSV_CALLEE_SAVE_SET)
			for (const register of toRestore) {
				sysvInstructions.push(new asm.PushInstruction(register))
			}
			sysvInstructions.push(...instructions)
			if (toRestore.length) {
				sysvInstructions.push(new asm.CallInstruction(functionLabel))
				for (const register of reverse(toRestore)) {
					sysvInstructions.push(new asm.PopInstruction(register))
				}
				sysvInstructions.push(new asm.RetInstruction)
			}
			else sysvInstructions.push(new asm.JumpInstruction(functionLabel))
		}
		assemblySections.push(
			labels,
			setupInstructions,
			bodyAssembly,
			returnInstructions,
			sysvInstructions
		)
	})
	return {
		instructions: flatten(assemblySections),
		declarations
	}
}