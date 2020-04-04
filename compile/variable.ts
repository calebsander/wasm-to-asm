import {LocalInstruction} from '../parse/instruction'
import {CompilationContext} from './context'
import {INT_INTERMEDIATE_REGISTERS, STACK_TOP, isFloat} from './conventions'
import {memoryMoveWidth} from './helpers'
import * as asm from './x86_64-asm'

export function compileGetLocalInstruction(
	local: number,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const {float} = context.getParam(local)
	const localDatum = context.resolveParamDatum(local)
	const target = context.resolvePush(float)
	if (target) {
		output.push(new asm.MoveInstruction(
			localDatum, {type: 'register', register: target}, 'q'
		))
	}
	else {
		let sourceDatum: asm.Datum
		if (float && localDatum.type === 'register') {
			// push requires an int register
			sourceDatum = {type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
			output.push(new asm.MoveInstruction(localDatum, sourceDatum, 'q'))
		}
		else sourceDatum = localDatum
		output.push(new asm.PushInstruction(sourceDatum))
	}
}
export function compileStoreLocalInstruction(
	{type, local}: LocalInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
) {
	const tee = type === 'tee_local'
	// We need to pop before resolving the local since pop references %rsp after increment
	const value = context.resolvePop()
	const {float} = context.getParam(local)
	if (tee) context.push(float)
	const localDatum = context.resolveParamDatum(local)
	if (value) {
		output.push(new asm.MoveInstruction(
			{type: 'register', register: value}, localDatum, 'q'
		))
	}
	else if (tee) {
		if (localDatum.type === 'register') {
			output.push(new asm.MoveInstruction(STACK_TOP, localDatum, 'q'))
		}
		else {
			const intermediate: asm.Datum =
				{type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
			output.push(
				new asm.MoveInstruction(STACK_TOP, intermediate),
				new asm.MoveInstruction(intermediate, localDatum)
			)
		}
	}
	else {
		// pop requires an int register
		const target: asm.Datum = float && localDatum.type === 'register'
			? {type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
			: localDatum
		output.push(new asm.PopInstruction(target))
		if (target !== localDatum) {
			output.push(new asm.MoveInstruction(target, localDatum, 'q'))
		}
	}
}
export function compileGetGlobalInstruction(
	global: number,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const {moduleContext} = context
	const type = moduleContext.resolveGlobalType(global)
	const sourceDatum: asm.Datum =
		{type: 'label', label: moduleContext.resolveGlobalLabel(global)}
	let target = context.resolvePush(isFloat(type))
	const push = !target
	if (push && type.endsWith('64')) output.push(new asm.PushInstruction(sourceDatum))
	else {
		if (push) [target] = INT_INTERMEDIATE_REGISTERS // push requires an int register
		const targetDatum: asm.Datum = {type: 'register', register: target!}
		const width = memoryMoveWidth(type, push)
		output.push(new asm.MoveInstruction(sourceDatum, {...targetDatum, width}, width))
		if (push) output.push(new asm.PushInstruction(targetDatum))
	}
}
export function compileSetGlobalInstruction(
	global: number,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const {moduleContext} = context
	const type = moduleContext.resolveGlobalType(global)
	const targetDatum: asm.Datum =
		{type: 'label', label: moduleContext.resolveGlobalLabel(global)}
	let value = context.resolvePop()
	const pop = !value
	if (pop && type.endsWith('64')) output.push(new asm.PopInstruction(targetDatum))
	else {
		if (pop) {
			[value] = INT_INTERMEDIATE_REGISTERS // pop requires an int register
			output.push(new asm.PopInstruction({type: 'register', register: value}))
		}
		const width = memoryMoveWidth(type, pop)
		output.push(new asm.MoveInstruction(
			{type: 'register', register: value!, width}, targetDatum, width
		))
	}
}