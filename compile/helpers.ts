import {ValueType} from '../parse/value-type'
import {CompilationContext} from './context'
import {
	INT_INTERMEDIATE_REGISTERS,
	SYSV_UNUSED_REGISTERS,
	getIntermediateRegisters,
	getResultRegister,
	isFloat,
	typeWidth
} from './conventions'
import * as asm from './x86_64-asm'

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
	moves: Map<asm.Register, asm.Datum>,
	stackParams: asm.Datum[],
	saveRegisters: Set<asm.Register>
): RelocationResult {
	let evicted: EvictedState | undefined
	const toRestore: asm.Register[] = []
	const output: asm.AssemblyInstruction[] = []
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
			[[source, target]] = moves
			moves.delete(source)
		}
		let needsMove = true
		if (target.type === 'register') {
			const {register} = target
			if (moves.has(register)) {
				const evictTo = SYSV_UNUSED_REGISTERS
					.find(register => register !== source)!
				evicted = {original: register, current: evictTo}
				output.push(new asm.MoveInstruction(
					target, {type: 'register', register: evictTo}, 'q'
				))
			}
			else evicted = undefined
			if (saveRegisters.has(register)) toRestore.push(register)
			if (register === source) needsMove = false
		}
		else evicted = undefined
		if (needsMove) {
			output.push(new asm.MoveInstruction(
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
		output.push(new asm.PopInstruction(register))
		if (intermediate) {
			output.push(new asm.MoveInstruction(
				{type: 'register', register}, datum, 'q'
			))
		}
	}
	return {toRestore, output}
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
export function popResultAndUnwind(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const {result} = context
	if (result) {
		const register = context.resolvePop()
		const resultRegister = getResultRegister(isFloat(result))
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