import {
	BranchInstruction,
	BranchTableInstruction,
	BlockInstruction,
	CallIndirectInstruction,
	CallInstruction,
	IfInstruction,
	ResultType
} from '../parse/instruction'
import {reverse} from '../util'
import {CompilationContext, getFunctionStats, SPRelative, StackState} from './context'
import {
	INT_INTERMEDIATE_REGISTERS,
	SYSCALL,
	SYSCALL_DATUM,
	getResultRegister,
	isFloat
} from './conventions'
import {compileBranch, growStack, relocateArguments, shrinkStack} from './helpers'
import {compileInstructions} from './instructions'
import * as asm from './x86_64-asm'

export interface BranchResult {
	/** The possible block/loop/if labels that could be branched to */
	branches: Set<string>
	/** Whether a branch will definitely occur */
	definitely: boolean
}

export const ALWAYS_BRANCHES: BranchResult = {branches: new Set, definitely: true},
	NEVER_BRANCHES: BranchResult = {branches: new Set, definitely: false}

const JUMP_TABLE_ENTRY_SIZE = 8

// exit(0xFF)
export const UNREACHABLE_INSTRUCTIONS: asm.AssemblyInstruction[] = [
	new asm.MoveInstruction(
		{type: 'immediate', value: SYSCALL.exit}, SYSCALL_DATUM
	),
	new asm.MoveInstruction(
		{type: 'immediate', value: 0xFF}, {type: 'register', register: 'rdi'}
	),
	new asm.SysCallInstruction
]

function getBlockEndBranches(
	blockLabel: string,
	subBranches: Set<string>,
	returns: ResultType,
	context: CompilationContext,
	stackState: StackState
): BranchResult {
	const branches = new Set<string>()
	for (const label of subBranches) {
		if (label !== blockLabel) branches.add(label)
	}
	context.restoreStackState(stackState)
	if (returns !== 'empty') context.push(isFloat(returns))
	return {branches, definitely: false}
}

export function compileBlockInstruction(
	instruction: BlockInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): BranchResult {
	const {type, returns, instructions} = instruction
	const {stackState} = context
	const blockLabel = context.makeLabel(type.toUpperCase())
	const loop = type === 'loop'
	if (loop) output.push(new asm.Label(blockLabel))
	context.pushLabel(loop, blockLabel, returns)
	const branch = compileInstructions(instructions, context, output)
	context.popLabel()
	const {branches, definitely} = branch
	if (!loop) output.push(new asm.Label(blockLabel))
	if (definitely) {
		if (!branches.has(blockLabel)) return branch
		if (loop && branches.size === 1) return ALWAYS_BRANCHES // infinite loop
	}

	return getBlockEndBranches(blockLabel, branches, returns, context, stackState)
}
export function compileIfInstruction(
	instruction: IfInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): BranchResult {
	const {returns, ifInstructions, elseInstructions} = instruction
	const endLabel = context.makeLabel('IF_END')
	const elseLabel =
		elseInstructions.length ? context.makeLabel('ELSE') : undefined
	let cond = context.resolvePop()
	if (!cond) { // cond is on the stack
		[cond] = INT_INTERMEDIATE_REGISTERS
		output.push(new asm.PopInstruction(cond))
	}
	const {stackState} = context
	const datum: asm.Datum = {type: 'register', register: cond, width: 'l'}
	output.push(
		new asm.TestInstruction(datum, datum),
		new asm.JumpInstruction(elseLabel || endLabel, 'e')
	)
	context.pushLabel(false, endLabel, returns)
	const branch = compileInstructions(ifInstructions, context, output)
	if (elseLabel) {
		context.restoreStackState(stackState)
		if (!branch.definitely) output.push(new asm.JumpInstruction(endLabel))
		output.push(new asm.Label(elseLabel))
		const {branches, definitely} =
			compileInstructions(elseInstructions, context, output)
		branch.definitely = branch.definitely && definitely
		for (const label of branches) branch.branches.add(label)
	}
	else branch.definitely = false // if statement may be skipped entirely
	context.popLabel()
	output.push(new asm.Label(endLabel))
	return branch.definitely && !branch.branches.has(endLabel)
		? branch
		: getBlockEndBranches(endLabel, branch.branches, returns, context, stackState)
}
export function compileBranchInstruction(
	instruction: BranchInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): BranchResult {
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
	const branches = branch ? new Set([branch]) : new Set<string>()
	if (!endLabel) return {branches, definitely: true}

	context.restoreStackState(stackState!)
	output.push(new asm.Label(endLabel))
	return {branches, definitely: false}
}
export function compileBranchTableInstruction(
	instruction: BranchTableInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): BranchResult {
	const {cases, defaultCase} = instruction
	let value = context.resolvePop()
	if (!value) {
		value = INT_INTERMEDIATE_REGISTERS[0]
		output.push(new asm.PopInstruction(value))
	}

	const tableLabel = context.makeLabel('BR_TABLE')
	const {stackState} = context
	const caseOutput: asm.AssemblyInstruction[] = []
	const branches = new Set<string>()
	const nestingLabels = new Map<number, string>()
	const compileCase = (nesting: number) => {
		let caseLabel = nestingLabels.get(nesting)
		if (!caseLabel) {
			nestingLabels.set(nesting, caseLabel = `${tableLabel}_${nesting}`)
			caseOutput.push(new asm.Label(caseLabel))
			const branch = compileBranch(nesting, context, caseOutput)
			if (branch) branches.add(branch)
			context.restoreStackState(stackState)
		}
		return caseLabel
	}
	const defaultLabel = compileCase(defaultCase)

	const tableAddress = INT_INTERMEDIATE_REGISTERS[1]
	const addressDatum: asm.Datum = {type: 'register', register: tableAddress}
	output.push(
		new asm.CmpInstruction(
			{type: 'immediate', value: cases.length},
			{type: 'register', register: value, width: 'l'}
		),
		new asm.JumpInstruction(defaultLabel, 'ae'),
		new asm.LeaInstruction({type: 'label', label: tableLabel}, addressDatum),
		new asm.AddInstruction(
			{
				type: 'indirect',
				register: tableAddress,
				offset: {register: value, scale: JUMP_TABLE_ENTRY_SIZE}
			},
			addressDatum
		),
		new asm.JumpInstruction(addressDatum),
		new asm.Directive({type: 'section', args: ['.rodata']}),
		new asm.Directive({type: 'balign', args: [JUMP_TABLE_ENTRY_SIZE]}),
		new asm.Label(tableLabel)
	)
	for (const nesting of cases) {
		output.push(new asm.Directive(
			{type: 'quad', args: [compileCase(nesting) + ' - ' + tableLabel]}
		))
	}
	output.push(
		new asm.Directive({type: 'text'}),
		...caseOutput
	)
	return {branches, definitely: true}
}
export function compileCallInstruction(
	instruction: CallInstruction | CallIndirectInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
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
	const {toRestore, output: relocateOutput} =
		relocateArguments(moves, stackParams, registersUsed)
	const pushedRegisters = toRestore.length
	toRestore.forEach((register, i) => {
		output.push(new asm.MoveInstruction(
			{type: 'register', register},
			{type: 'indirect', register: 'rsp', immediate: -(i + 1) << 3},
			'q'
		))
	})
	output.push(...relocateOutput)
	const stackPopped = stackParams.length
	if (pushedRegisters) { // point to end of pushedRegisters
		output.push(growStack(stackPopped + pushedRegisters))
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
		output.push(shrinkStack(stackPopped))
	}
	if (result) {
		const float = isFloat(result)
		const resultRegister = getResultRegister(float)
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
}