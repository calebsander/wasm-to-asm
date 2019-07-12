import {ResultType} from '../parse/instruction'
import {Export, FunctionType, Global, GlobalType, Import} from '../parse/module'
import {ValueType} from '../parse/value-type'
import {INVALID_EXPORT_CHAR, STACK_TOP, getGeneralRegisters, isFloat} from './conventions'
import {Datum, Register} from './x86_64-asm'

export class SPRelative {
	private readonly stackOffset: number

	constructor(index: number, stackValues: number) {
		this.stackOffset = stackValues - index - 1
	}

	get datum(): Datum {
		return {...STACK_TOP, immediate: this.stackOffset << 3}
	}
}

export const getFunctionStats =
	({params, results}: FunctionType, locals: ValueType[] = []): FunctionStats => ({
		params,
		locals,
		result: (results as [ValueType?])[0]
	})

const makeModulePrefix = (moduleIndex: number) => `MODULE${moduleIndex}`
const makeExportLabel = (modulePrefix: string, type: string, name: string) =>
	`${modulePrefix}_EXPORT_${type}_${name}`

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
export interface StackState {
	intStackHeight: number
	floatStackHeight: number
	stackFloats: boolean[]
}
interface ImportReference {
	modulePrefix: string
	name: string
}
export interface ModuleIndices {
	[module: string]: number
}
export class ModuleContext {
	readonly exportMemory: string[] = []
	readonly exportFunctions = new Map<number, string[]>()
	readonly exportGlobals = new Map<number, string[]>()
	readonly globalTypes: GlobalType[] = []
	private readonly importFunctions: ImportReference[] = []
	private readonly importGlobals: ImportReference[] = []
	private readonly importGlobalTypes: ValueType[] = []
	private readonly types: FunctionType[] = []
	private readonly functionStats = new Map<number, FunctionStats>()
	private memoryMax: number | undefined

	constructor(
		readonly index: number,
		readonly moduleIndices: ModuleIndices
	) {}

	addGlobals(globals: Global[]): void {
		for (const {type} of globals) this.globalTypes.push(type)
	}
	addExports(exportSection: Export[]): void {
		for (let {name, description: {type, index}} of exportSection) {
			name = name.replace(INVALID_EXPORT_CHAR, '_')
			let exportMap: Map<Number, string[]>
			switch (type) {
				case 'memory':
					if (index) throw new Error('Invalid memory index')
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
	addImports(imports: Import[]): void {
		for (const {module, name, description} of imports) {
			const moduleIndex = this.moduleIndices[module] as number | undefined
			if (moduleIndex === undefined) throw new Error('No such module: ' + module)
			const modulePrefix = makeModulePrefix(moduleIndex)
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
	addTypes(types: FunctionType[]): void {
		this.types.push(...types)
	}
	getType(index: number): FunctionType {
		const type = this.types[index] as FunctionType | undefined
		if (!type) throw new Error(`No function type ${index}`)
		return type
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
			return makeExportLabel(importRef.modulePrefix, 'GLOBAL', importRef.name)
		}
		return this.globalLabel(moduleGlobalIndex)
	}
	getFunctionLabel(index: number): string {
		const moduleFunctionIndex = index - this.baseFunctionIndex
		if (moduleFunctionIndex < 0) {
			const importRef = this.importFunctions[index]
			return makeExportLabel(importRef.modulePrefix, 'FUNC', importRef.name)
		}
		return this.functionLabel(moduleFunctionIndex)
	}
	private get modulePrefix(): string {
		return makeModulePrefix(this.index)
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
		return makeExportLabel(this.modulePrefix, type, name)
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
export class CompilationContext {
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
	getParam(paramIndex: number): LocalLocation {
		const localIndex = paramIndex - this.params.length
		return localIndex < 0 ? this.params[paramIndex] : this.locals[localIndex]
	}
	resolveParam(paramIndex: number): Register | SPRelative {
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
	resolveParamDatum(index: number): Datum {
		const resolved = this.resolveParam(index)
		return resolved instanceof SPRelative
			? resolved.datum
			: {type: 'register', register: resolved}
	}
	resolveLocal(index: number): Register | SPRelative {
		return this.resolveParam(this.params.length + index)
	}
	resolveLocalDatum(index: number): Datum {
		return this.resolveParamDatum(this.params.length + index)
	}
	private resolveStackTop(float: boolean): Register | undefined {
		return (getGeneralRegisters(float) as (Register | undefined)[])
			[this.localsAndStackHeight(float)]
	}
	resolvePush(float: boolean): Register | undefined {
		const resolved = this.resolveStackTop(float)
		this.push(float)
		return resolved
	}
	resolvePop(): Register | undefined {
		return this.resolveStackTop(this.pop())
	}
	// If wholeFunction is true, maxStackHeight is used and params are excluded
	registersUsed(wholeFunction?: true): Register[] {
		const toSave: Register[] = []
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
			intStackHeight = this.maxIntStackHeight
			floatStackHeight = this.maxFloatStackHeight
		}
		else {
			({intStackHeight, floatStackHeight} = this)
		}
		for (let stackHeight = 0; stackHeight < intStackHeight; stackHeight++) {
			this.intStackHeight = stackHeight
			const resolved = this.resolveStackTop(false)
			if (resolved) toSave.push(resolved)
			else break
		}
		for (let stackHeight = 0; stackHeight < floatStackHeight; stackHeight++) {
			this.floatStackHeight = stackHeight
			const resolved = this.resolveStackTop(true)
			if (resolved) toSave.push(resolved)
			else break
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