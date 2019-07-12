import {LocalInstruction} from '../parse/instruction'
import {CompilationContext, SPRelative} from './context'
import {INT_INTERMEDIATE_REGISTERS, STACK_TOP, isFloat} from './conventions'
import {memoryMoveWidth} from './helpers'
import * as asm from './x86_64-asm'

export function compileGetLocalInstruction(
	local: number,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const {float} = context.getParam(local)
	const resolvedLocal = context.resolveParam(local)
	let target = context.resolvePush(float)
	if (resolvedLocal instanceof SPRelative) {
		const push = !target
		if (push) [target] = INT_INTERMEDIATE_REGISTERS // push requires an int register
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
}
export function compileStoreLocalInstruction(
	{type, local}: LocalInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
) {
	const tee = type === 'tee_local'
	let value = context.resolvePop()
	if (!value) {
		[value] = INT_INTERMEDIATE_REGISTERS // pop requires an int register
		output.push(tee
			? new asm.MoveInstruction(STACK_TOP, {type: 'register', register: value})
			: new asm.PopInstruction(value)
		)
	}
	if (tee) context.push(context.getParam(local).float)
	output.push(new asm.MoveInstruction(
		{type: 'register', register: value},
		context.resolveParamDatum(local),
		'q'
	))
}
export function compileGetGlobalInstruction(
	global: number,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const {moduleContext} = context
	const type = moduleContext.resolveGlobalType(global)
	let target = context.resolvePush(isFloat(type))
	const push = !target
	if (push) [target] = INT_INTERMEDIATE_REGISTERS // push requires an int register
	const width = memoryMoveWidth(type, push)
	output.push(new asm.MoveInstruction(
		{type: 'label', label: moduleContext.resolveGlobalLabel(global)},
		{type: 'register', register: target!, width},
		width
	))
	if (push) output.push(new asm.PushInstruction(target!))
}
export function compileSetGlobalInstruction(
	global: number,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const {moduleContext} = context
	const type = moduleContext.resolveGlobalType(global)
	let value = context.resolvePop()
	const pop = !value
	if (pop) {
		[value] = INT_INTERMEDIATE_REGISTERS // pop requires an int register
		output.push(new asm.PopInstruction(value))
	}
	const width = memoryMoveWidth(type, pop)
	output.push(new asm.MoveInstruction(
		{type: 'register', register: value!, width},
		{type: 'label', label: moduleContext.resolveGlobalLabel(global)},
		width
	))
}