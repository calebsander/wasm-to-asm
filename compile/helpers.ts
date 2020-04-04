import {ValueType} from '../parse/value-type'
import {CompilationContext, SPRelative} from './context'
import {
	INT_INTERMEDIATE_REGISTERS,
	SYSV_UNUSED_REGISTERS,
	getIntermediateRegisters,
	getResultRegister,
	isFloat,
	typeWidth
} from './conventions'
import * as asm from './x86_64-asm'

export type ParamTarget = asm.Register | SPRelative
interface EvictedState {
	original: asm.Register
	current: asm.Register
}
interface RelocationResult {
	toRestore: asm.Register[]
	output: asm.AssemblyInstruction[]
}

export const shrinkStack = (count: number): asm.AssemblyInstruction =>
	new asm.AddInstruction(
		{type: 'immediate', value: count << 3},
		{type: 'register', register: 'rsp'}
	)
export const growStack = (count: number): asm.AssemblyInstruction =>
	shrinkStack(-count)
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
	if (popCount) output.push(shrinkStack(popCount))
}

export function relocateArguments(
	moves: Map<asm.Register, ParamTarget>,
	stackParams: ParamTarget[],
	saveRegisters: Set<asm.Register>,
	stackOffset = 0
): RelocationResult {
	let evicted: EvictedState | undefined
	const toRestore: asm.Register[] = []
	const output: (() => asm.AssemblyInstruction)[] = []
	while (moves.size) {
		let source: asm.Register, target: ParamTarget
		if (evicted) {
			const {original, current} = evicted
			source = current
			const maybeTarget = moves.get(original)
			if (!maybeTarget) throw new Error('Expected a parameter target')
			target = maybeTarget
			moves.delete(original)
		}
		else {
			// TODO: optimize order of moves to avoid conflicts
			[[source, target]] = moves
			moves.delete(source)
		}
		let needsMove = true
		evicted = undefined
		if (!(target instanceof SPRelative)) {
			if (moves.has(target)) {
				const evictTo = SYSV_UNUSED_REGISTERS
					.find(register => register !== source)!
				evicted = {original: target, current: evictTo}
				const move = new asm.MoveInstruction(
					{type: 'register', register: target},
					{type: 'register', register: evictTo},
					'q'
				)
				output.push(() => move)
			}
			if (saveRegisters.has(target)) toRestore.push(target)
			if (source === target) needsMove = false
		}
		if (needsMove) {
			const move = new asm.MoveInstruction(
				{type: 'register', register: source},
				target instanceof SPRelative
					? target.datum
					: {type: 'register', register: target},
				'q'
			)
			output.push(() => move)
		}
	}
	stackParams.forEach((target, i) => {
		let register: asm.Register
		if (target instanceof SPRelative) [register] = INT_INTERMEDIATE_REGISTERS
		else {
			register = target
			if (saveRegisters.has(target)) toRestore.push(target)
		}
		const datum: asm.Datum = {type: 'register', register}
		output.push(() => new asm.MoveInstruction(
			new SPRelative(stackOffset + savedValues + i).datum, datum)
		)
		if (target instanceof SPRelative) {
			const move = new asm.MoveInstruction(datum, target.datum)
			output.push(() => move)
		}
	})
	const savedValues = toRestore.length
	return {toRestore, output: output.map(instruction => instruction())}
}
export function compileBranch(
	nesting: number,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): string | undefined {
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
			[resultRegister] = getIntermediateRegisters(float)
			const resultDatum: asm.Datum = {type: 'register', register: resultRegister}
			output.push(toPop
				? new asm.MoveInstruction({type: 'register', register: toPop}, resultDatum, 'q')
				: new asm.PopInstruction(resultDatum)
			)
		}
	}
	unwindStack(intStackHeight, floatStackHeight, context, output)
	if (saveResult) {
		const target = context.resolvePush(float!)
		if (resultRegister) {
			const resultDatum: asm.Datum = {type: 'register', register: resultRegister}
			output.push(target
				? new asm.MoveInstruction(resultDatum, {type: 'register', register: target}, 'q')
				: new asm.PushInstruction(resultDatum)
			)
		}
	}
	output.push(new asm.JumpInstruction(label))
	return label
}
export function popResultAndUnwind(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const {result} = context
	if (result) {
		const register = context.resolvePop()
		const resultDatum: asm.Datum =
			{type: 'register', register: getResultRegister(isFloat(result))}
		output.push(register
			? new asm.MoveInstruction({type: 'register', register}, resultDatum, 'q')
			: new asm.PopInstruction(resultDatum)
		)
	}
	unwindStack(0, 0, context, output)
}
export function compileReturn(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	popResultAndUnwind(context, output)
	output.push(new asm.JumpInstruction(
		context.moduleContext.returnLabel(context.functionIndex)
	))
}

export function memoryMoveWidth(type: ValueType, intermediate: boolean): asm.Width {
	if (isFloat(type) && intermediate) type = 'i' + type.slice(1) as ValueType
	return typeWidth(type)
}