import {LoadStoreInstruction} from '../parse/instruction'
import {ValueType} from '../parse/value-type'
import {reverse} from '../util'
import {CompilationContext} from './context'
import {
	INT_INTERMEDIATE_REGISTERS,
	MMAP_ADDR_DATUM,
	MMAP_ADDR_INTERMEDIATE,
	MMAP_FD_DATUM,
	MMAP_FLAGS,
	MMAP_FLAGS_DATUM,
	MMAP_LENGTH_DATUM,
	MMAP_OFFSET_DATUM,
	MMAP_PROT_DATUM,
	MMAP_RESULT_DATUM,
	MMAP_SYSCALL_REGISTERS,
	PAGE_BITS,
	PROT_READ_WRITE,
	SYSCALL,
	SYSCALL_DATUM,
	isFloat
} from './conventions'
import {memoryMoveWidth} from './helpers'
import * as asm from './x86_64-asm'

export function compileLoadInstruction(
	{type, access: {offset}}: LoadStoreInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	let index = context.resolvePop()
	if (!index) {
		index = INT_INTERMEDIATE_REGISTERS[0]
		output.push(new asm.PopInstruction({type: 'register', register: index}))
	}
	const address: asm.Datum =
		{type: 'register', register: INT_INTERMEDIATE_REGISTERS[1]}
	// Constant offset can exceed 32 bits, so must store in register
	output.push(new asm.MoveInstruction(
		{type: 'immediate', value: context.moduleContext.memoryStart + offset},
		address
	))
	const source: asm.Datum =
		{type: 'indirect', register: address.register, offset: {register: index}}
	const [resultType, operation] = type.split('.') as [ValueType, string]
	const isLoad32U = operation === 'load32_u'
	let target = context.resolvePush(isFloat(resultType))
	const push = !target
	if (push && type.endsWith('64.load')) output.push(new asm.PushInstruction(source))
	else {
		if (push) [target] = INT_INTERMEDIATE_REGISTERS // push requires an int register
		const width = isLoad32U ? 'l' : memoryMoveWidth(resultType, push)
		const targetDatum: asm.Datum = {type: 'register', register: target!}
		const targetWidth = {...targetDatum, width}
		if (operation === 'load' || isLoad32U) { // no resize needed
			output.push(new asm.MoveInstruction(source, targetWidth, width))
		}
		else {
			const [op, signedness] = operation.split('_')
			let sourceWidth: asm.Width
			switch (op) {
				case 'load8':
					sourceWidth = 'b'
					break
				case 'load16':
					sourceWidth = 'w'
					break
				default: // 'load32'
					sourceWidth = 'l'
			}
			output.push(new asm.MoveExtendInstruction(
				source, targetWidth, signedness === 's', {src: sourceWidth, dest: width}
			))
		}
		if (push) output.push(new asm.PushInstruction(targetDatum))
	}
}
export function compileStoreInstruction(
	{type, access: {offset}}: LoadStoreInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [sourceType, operation] = type.split('.') as [ValueType, string]
	let value = context.resolvePop()
	const pop = !value
	if (pop) {
		value = INT_INTERMEDIATE_REGISTERS[0] // pop requires an int register
		output.push(new asm.PopInstruction({type: 'register', register: value}))
	}
	let index = context.resolvePop()
	if (!index) {
		index = INT_INTERMEDIATE_REGISTERS[1]
		output.push(new asm.PopInstruction({type: 'register', register: index}))
	}
	const address: asm.Datum =
		{type: 'register', register: INT_INTERMEDIATE_REGISTERS[2]}
	output.push(new asm.MoveInstruction(
		{type: 'immediate', value: context.moduleContext.memoryStart + offset},
		address
	))
	let width: asm.Width
	switch (operation) {
		case 'store8':
			width = 'b'
			break
		case 'store16':
			width = 'w'
			break
		case 'store32':
			width = 'l'
			break
		default:
			width = memoryMoveWidth(sourceType, pop)
	}
	output.push(new asm.MoveInstruction(
		{type: 'register', register: value!, width},
		{type: 'indirect', register: address.register, offset: {register: index}},
		width
	))
}
export function compileSizeInstruction(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const target = context.resolvePush(false)
	const sizeDatum: asm.Datum =
		{type: 'label', label: context.moduleContext.memorySizeLabel}
	output.push(target
		? new asm.MoveInstruction(sizeDatum, {type: 'register', register: target})
		: new asm.PushInstruction(sizeDatum)
	)
}
export function compileGrowInstruction(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	let pages = context.resolvePop()
	if (!pages || MMAP_SYSCALL_REGISTERS.has(pages)) {
		// %rax and %rdx are used for mmap() arguments
		const newPages = INT_INTERMEDIATE_REGISTERS[1]
		const newPagesDatum: asm.Datum = {type: 'register', register: newPages}
		output.push(pages
			? new asm.MoveInstruction({type: 'register', register: pages}, newPagesDatum)
			: new asm.PopInstruction(newPagesDatum)
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
	const pushed: asm.Datum[] = [{type: 'register', register: pages}]
	for (const register of MMAP_SYSCALL_REGISTERS) {
		if (registersUsed.has(register)) pushed.push({type: 'register', register})
	}
	for (const datum of pushed) output.push(new asm.PushInstruction(datum))
	output.push(
		new asm.MoveInstruction(
			{type: 'immediate', value: SYSCALL.mmap}, SYSCALL_DATUM
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
	for (const datum of reverse(pushed)) output.push(new asm.PopInstruction(datum))
	let result = context.resolvePush(false)
	const push = !result
	if (push) [result] = INT_INTERMEDIATE_REGISTERS
	const resultDatum: asm.Datum = {type: 'register', register: result!, width: 'l'}
	output.push(
		// mmap() < 0 indicates failure
		new asm.TestInstruction(MMAP_RESULT_DATUM, MMAP_RESULT_DATUM),
		new asm.JumpInstruction(failLabel, 'l'),
		new asm.MoveInstruction(sizeLabel, resultDatum),
		new asm.AddInstruction(pagesDatum, sizeLabel),
		new asm.JumpInstruction(endLabel),
		new asm.Label(failLabel),
		new asm.MoveInstruction({type: 'immediate', value: -1}, resultDatum),
		new asm.JumpInstruction(endLabel),
		new asm.Label(skipLabel),
		new asm.MoveInstruction(sizeLabel, resultDatum),
		new asm.Label(endLabel)
	)
	if (push) output.push(new asm.PushInstruction(resultDatum))
}