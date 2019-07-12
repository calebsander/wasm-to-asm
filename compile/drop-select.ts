import {CompilationContext} from './context'
import {INT_INTERMEDIATE_REGISTERS, STACK_TOP} from './conventions'
import {shrinkStack} from './helpers'
import * as asm from './x86_64-asm'

export function compileDropInstruction(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	if (!context.resolvePop()) output.push(shrinkStack(1))
}
export function compileSelectInstruction(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
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
	else ifFalseDatum = STACK_TOP
	const ifTrue = context.resolvePop() // also where the result will go
	const ifTrueDatum: asm.Datum =
		ifTrue ? {type: 'register', register: ifTrue} : {...STACK_TOP, immediate: 8}
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
	if (!ifFalse) output.push(shrinkStack(1))
}