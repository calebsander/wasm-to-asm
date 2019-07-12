import {ConstInstruction} from '../parse/instruction'
import {ValueType} from '../parse/value-type'
import {convertFloatToInt} from '../util'
import {CompilationContext} from './context'
import {
	DIV_LOWER_DATUM,
	DIV_LOWER_REGISTER,
	DIV_UPPER_DATUM,
	FLOAT_INTERMEDIATE_REGISTERS,
	INT_INTERMEDIATE_REGISTERS,
	SHIFT_REGISTER,
	SHIFT_REGISTER_BYTE,
	SHIFT_REGISTER_DATUM,
	STACK_TOP,
	isFloat,
	typeWidth,
	getIntermediateRegisters
} from './conventions'
import {growStack, shrinkStack} from './helpers'
import * as asm from './x86_64-asm'

const COMPARE_OPERATIONS = new Map<string, asm.JumpCond>([
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
const INT_ARITHMETIC_OPERATIONS = new Map([
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
const SHIFT_OPERATIONS = new Set(['shl', 'shr_s', 'shr_u', 'rotl', 'rotr'])
const BIT_COUNT_OPERATIONS = new Map([
	['clz', asm.LzcntInstruction],
	['ctz', asm.TzcntInstruction],
	['popcnt', asm.PopcntInstruction]
])
const FLOAT_BINARY_OPERATIONS = new Map([
	['add', asm.AddInstruction],
	['sub', asm.SubInstruction],
	['mul', asm.MulInstruction],
	['div', asm.DivBinaryInstruction],
	['min', asm.MinInstruction],
	['max', asm.MaxInstruction]
])
const ROUNDING_MODES = new Map([
	['nearest', 0],
	['floor', 1],
	['ceil', 2],
	['trunc', 3]
])

export function compileConstInstruction(
	{type, value}: ConstInstruction,
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [constType] = type.split('.') as [ValueType, string]
	// Immediates cannot be loaded directly into SIMD registers
	const float = isFloat(constType)
	const wide = constType.endsWith('64')
	if (float) value = convertFloatToInt(value as number, wide)
	const target = context.resolvePush(float)
	const intermediate = !target || float
		? INT_INTERMEDIATE_REGISTERS[0]
		: target
	const intermediateDatum: asm.Datum = {type: 'register', register: intermediate}
	output.push(new asm.MoveInstruction(
		{type: 'immediate', value}, {...intermediateDatum, width: wide ? 'q' : 'l'}
	))
	if (target) {
		if (float) {
			output.push(new asm.MoveInstruction(
				intermediateDatum, {type: 'register', register: target}, 'q'
			))
		}
	}
	else output.push(new asm.PushInstruction(intermediate))
}
export function compileCompareInstruction(
	instruction:
		'i32.eqz' | 'i32.eq' | 'i32.ne' | 'i32.lt_s' | 'i32.lt_u' |
		'i32.le_s' | 'i32.le_u' | 'i32.gt_s' | 'i32.gt_u' | 'i32.ge_s' | 'i32.ge_u' |
		'i64.eqz' | 'i64.eq' | 'i64.ne' | 'i64.lt_s' | 'i64.lt_u' |
		'i64.le_s' | 'i64.le_u' | 'i64.gt_s' | 'i64.gt_u' | 'i64.ge_s' | 'i64.ge_u' |
		'f32.eq' | 'f32.ne' | 'f32.lt' | 'f32.gt' | 'f32.le' | 'f32.ge' |
		'f64.eq' | 'f64.ne' | 'f64.lt' | 'f64.gt' | 'f64.le' | 'f64.ge',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [type, operation] = instruction.split('.') as [ValueType, string]
	const width = typeWidth(type)
	const float = isFloat(type)
	let datum2: asm.Datum
	if (operation === 'eqz') datum2 = {type: 'immediate', value: 0}
	else {
		let arg2 = context.resolvePop()
		if (!arg2) {
			[arg2] = getIntermediateRegisters(float)
			output.push(new asm.PopInstruction(arg2))
		}
		datum2 = {type: 'register', register: arg2, width}
	}
	const arg1 = context.resolvePop()
	const datum1: asm.Datum = arg1
		? {type: 'register', register: arg1, width}
		: STACK_TOP
	let resultRegister = context.resolvePush(false)
	const push = !resultRegister
	if (push) resultRegister = INT_INTERMEDIATE_REGISTERS[0]
	const cond = COMPARE_OPERATIONS.get(operation)
	if (!cond) throw new Error('No comparison value found for ' + instruction)
	const result8: asm.Datum =
		{type: 'register', register: resultRegister!, width: 'b'}
	const result32: asm.Datum = {...result8, width: 'l'}
	output.push(
		new asm.CmpInstruction(datum2, datum1, width),
		new asm.SetInstruction(result8, cond)
	)
	if (float) {
		const parityDatum: asm.Datum =
			{type: 'register', register: INT_INTERMEDIATE_REGISTERS[1], width: 'b'}
		let parityCond: asm.JumpCond, parityInstruction: typeof asm.OrInstruction
		if (operation === 'ne') { // negative comparison returns true on nan
			parityCond = 'p'
			parityInstruction = asm.OrInstruction
		}
		else { // positive comparison returns false on nan
			parityCond = 'np'
			parityInstruction = asm.AndInstruction
		}
		output.push(
			new asm.SetInstruction(parityDatum, parityCond),
			new parityInstruction(parityDatum, result8)
		)
	}
	output.push(new asm.MoveExtendInstruction(result8, result32, false))
	if (push) output.push(new asm.MoveInstruction(result32, STACK_TOP))
}
export function compileBitCountInstruction(
	instruction:
		'i32.clz' | 'i32.ctz' | 'i32.popcnt' | 'i64.clz' | 'i64.ctz' | 'i64.popcnt',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [type, operation] = instruction.split('.') as [ValueType, string]
	const width = typeWidth(type)
	const asmInstruction = BIT_COUNT_OPERATIONS.get(operation)
	if (!asmInstruction) throw new Error('No instruction found for ' + instruction)

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
}
export function compileIntArithmeticInstruction(
	instruction: 'i32.add' | 'i32.sub' | 'i32.and' | 'i32.or' | 'i32.xor' |
		'i32.shl' | 'i32.shr_s' | 'i32.shr_u' | 'i32.rotl' | 'i32.rotr' |
		'i64.add' | 'i64.sub' | 'i64.and' | 'i64.or' | 'i64.xor' |
		'i64.shl' | 'i64.shr_s' | 'i64.shr_u' | 'i64.rotl' | 'i64.rotr',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	let operand2 = context.resolvePop()
	if (!operand2) {
		// Using intermediate register 1 instead of 0 to avoid extra mov for shifts
		operand2 = INT_INTERMEDIATE_REGISTERS[1]
		output.push(new asm.PopInstruction(operand2))
	}
	const operand1 = context.resolvePop()
	const [type, operation] = instruction.split('.') as [ValueType, string]
	const arithmeticInstruction = INT_ARITHMETIC_OPERATIONS.get(operation)
	if (!arithmeticInstruction) {
		throw new Error('No arithmetic instruction found for ' + instruction)
	}
	const width = typeWidth(type)
	let datum2: asm.Datum = {type: 'register', register: operand2}
	if (SHIFT_OPERATIONS.has(operation)) {
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
}
export function compileIntMulInstruction(
	instruction: 'i32.mul' | 'i64.mul',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const width = instruction === 'i32.mul' ? 'l' : 'q'
	let operand2 = context.resolvePop()
	if (!operand2) {
		[operand2] = INT_INTERMEDIATE_REGISTERS
		output.push(new asm.PopInstruction(operand2))
	}
	const datum2: asm.Datum = {type: 'register', register: operand2, width}
	const operand1 = context.resolvePop()
	if (operand1) {
		output.push(new asm.ImulInstruction(
			datum2, {type: 'register', register: operand1, width}
		))
	}
	else {
		output.push(
			new asm.ImulInstruction(STACK_TOP, datum2),
			new asm.MoveInstruction(datum2, STACK_TOP)
		)
	}
	context.push(false)
}
export function compileIntDivInstruction(
	instruction: 'i32.div_s' | 'i32.div_u' | 'i32.rem_s' | 'i32.rem_u' |
		'i64.div_s' | 'i64.div_u' | 'i64.rem_s' | 'i64.rem_u',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [type, operation] = instruction.split('.') as [ValueType, string]
	const [op, signedness] = operation.split('_')
	const width = typeWidth(type)
	const wide = width === 'q'
	const signed = signedness === 's'
	const operand2 = context.resolvePop()
	const datum2: asm.Datum = operand2
		? {type: 'register', register: operand2, width}
		: STACK_TOP
	if (operation === 'rem_s') {
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
	const operand1 = context.resolvePop()
	const datum1: asm.Datum = operand1
		? {type: 'register', register: operand1}
		: {...STACK_TOP, immediate: 8}
	const result = op === 'div' ? DIV_LOWER_DATUM : DIV_UPPER_DATUM
	if (operand1 !== DIV_LOWER_REGISTER) {
		output.push(new asm.MoveInstruction(datum1, DIV_LOWER_DATUM))
	}
	output.push(
		signed
			? wide ? new asm.CqtoInstruction : new asm.CdqoInstruction
			: new asm.XorInstruction(DIV_UPPER_DATUM, DIV_UPPER_DATUM),
		new asm.DivInstruction(datum2, signed, width)
	)
	if (!operand2) output.push(shrinkStack(1))
	if (result.register !== operand1) {
		output.push(new asm.MoveInstruction(result, operand1 ? datum1 : STACK_TOP))
	}
	context.push(false)
}
export function compileSignInstruction(
	instruction: 'f32.abs' | 'f32.neg' | 'f32.copysign' |
		'f64.abs' | 'f64.neg' | 'f64.copysign',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [type, operation] = instruction.split('.') as [ValueType, string]
	const width = typeWidth(type)
	const wide = width === 'd'
	const negZeroLoadDatum: asm.Datum =
			{type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]},
		negZeroDatum: asm.Datum =
			{type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[0]}
	let negZero = 1n << (wide ? 63n : 31n)
	const setSignBit = operation === 'neg'
	if (!setSignBit) negZero ^= -1n // a bitmask to exclude the sign bit
	output.push(
		new asm.MoveInstruction(
			{type: 'immediate', value: negZero},
			{...negZeroLoadDatum, width: wide ? 'q' : 'l'}
		),
		new asm.MoveInstruction(negZeroLoadDatum, negZeroDatum, 'q')
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
}
export function compileFloatUnaryInstruction(
	instruction:
		'f32.ceil' | 'f32.floor' | 'f32.trunc' | 'f32.nearest' | 'f32.sqrt' |
		'f64.ceil' | 'f64.floor' | 'f64.trunc' | 'f64.nearest' | 'f64.sqrt',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [type, operation] = instruction.split('.') as [ValueType, string]
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
		const mode = ROUNDING_MODES.get(operation)
		if (mode === undefined) throw new Error('Unknown round type: ' + operation)
		output.push(new asm.RoundInstruction(mode, datum, result, width))
	}
	if (!operand) output.push(new asm.MoveInstruction(result, datum, 'q'))
	context.push(true)
}
export function compileFloatBinaryInstruction(
	instruction:
		'f32.add' | 'f32.sub' | 'f32.mul' | 'f32.div' | 'f32.min' | 'f32.max' |
		'f64.add' | 'f64.sub' | 'f64.mul' | 'f64.div' | 'f64.min' | 'f64.max',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [type, operation] = instruction.split('.') as [ValueType, string]
	const arithmeticInstruction = FLOAT_BINARY_OPERATIONS.get(operation)
	if (!arithmeticInstruction) {
		throw new Error('No arithmetic instruction found for ' + instruction)
	}
	const width = typeWidth(type)
	const operand2 = context.resolvePop()
	const datum2 : asm.Datum = operand2
		? {type: 'register', register: operand2}
		: STACK_TOP
	let operand1 = context.resolvePop()
	const onStack = !operand1
	if (onStack) {
		[operand1] = FLOAT_INTERMEDIATE_REGISTERS
		output.push(new asm.MoveInstruction(
			{...STACK_TOP, immediate: 8}, {type: 'register', register: operand1}, 'q'
		))
	}
	const datum1: asm.Datum = {type: 'register', register: operand1!}
	output.push(new arithmeticInstruction(datum2, datum1, width))
	if (!operand2) output.push(shrinkStack(1))
	if (onStack) output.push(new asm.MoveInstruction(datum1, STACK_TOP, 'q'))
	context.push(true)
}
export function compileWrapInstruction(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	let value = context.resolvePop()
	const onStack = !value
	if (onStack) [value] = INT_INTERMEDIATE_REGISTERS
	const datum: asm.Datum = {type: 'register', register: value!, width: 'l'}
	if (onStack) output.push(new asm.MoveInstruction(STACK_TOP, datum))
	output.push(new asm.MoveInstruction(datum, datum))
	if (onStack) output.push(new asm.MoveInstruction(datum, STACK_TOP))
	context.push(false)
}
export function compileTruncateInstruction(
	instruction:
		'i32.trunc_s/f32' | 'i32.trunc_u/f32' | 'i32.trunc_s/f64' | 'i32.trunc_u/f64' |
		'i64.trunc_s/f32' | 'i64.trunc_u/f32' | 'i64.trunc_s/f64' | 'i64.trunc_u/f64',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	let [resultType, fullOperation] = instruction.split('.') as [ValueType, string]
	const [operation, sourceType] = fullOperation.split('/') as [string, ValueType]
	const sourceWidth = typeWidth(sourceType)
	const signed = operation.endsWith('s')
	let operand = context.resolvePop()
	const pop = !operand
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
			if (pop) {
				operand = FLOAT_INTERMEDIATE_REGISTERS[0]
				datum = {type: 'register', register: operand}
				output.push(new asm.MoveInstruction(STACK_TOP, datum, 'q'))
			}
			const highBitThreshold = 2 ** 63
			const wideSource = sourceWidth === 'd'
			const highBitInt = convertFloatToInt(highBitThreshold, wideSource)
			const thresholdIntDatum: asm.Datum =
				{type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
			const thresholdDatum: asm.Datum =
				{type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[1]}
			const label = context.makeLabel('CONVERT_U64_END')
			highBitDatum = {type: 'register', register: INT_INTERMEDIATE_REGISTERS[1]}
			output.push(
				new asm.XorInstruction(highBitDatum, highBitDatum),
				new asm.MoveInstruction(
					{type: 'immediate', value: highBitInt},
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
	const push = !resultRegister
	if (push) [resultRegister] = INT_INTERMEDIATE_REGISTERS
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
	const stackHeightChange = Number(push) - Number(pop)
	if (stackHeightChange) output.push(growStack(stackHeightChange))
	if (push) output.push(new asm.MoveInstruction(resultDatum, STACK_TOP))
}
export function compileExtendInstruction(
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const value = context.resolvePop()
	let datum: asm.Datum, result: asm.Datum
	if (value) {
		result = {type: 'register', register: value}
		datum = {...result, width: 'l'}
	}
	else {
		datum = STACK_TOP
		result = {type: 'register', register: INT_INTERMEDIATE_REGISTERS[0]}
	}
	output.push(new asm.MoveExtendInstruction(
		datum, result, true, {src: 'l', dest: 'q'}
	))
	if (!value) output.push(new asm.MoveInstruction(result, datum))
	context.push(false)
}
export function compileConvertInstruction(
	instruction:
		'f32.convert_s/i32' | 'f32.convert_u/i32' | 'f32.convert_s/i64' | 'f32.convert_u/i64' |
		'f64.convert_s/i32' | 'f64.convert_u/i32' | 'f64.convert_s/i64' | 'f64.convert_u/i64',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const [resultType, fullOperation] = instruction.split('.') as [ValueType, string]
	let [operation, sourceType] = fullOperation.split('/') as [string, ValueType]
	const signed = operation.endsWith('_s')
	let operand = context.resolvePop()
	const pop = !operand
	let datum: asm.Datum =
		operand ? {type: 'register', register: operand} : STACK_TOP
	let doubleNeededDatum: asm.Datum | undefined
	if (!signed) {
		if (sourceType === 'i32') sourceType = 'i64'
		else { // i64
			if (pop) {
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
	const push = !resultRegister
	if (push) resultRegister = FLOAT_INTERMEDIATE_REGISTERS[0]
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
	const stackHeightChange = Number(push) - Number(pop)
	if (stackHeightChange) output.push(shrinkStack(stackHeightChange))
	if (push) output.push(new asm.MoveInstruction(resultDatum, STACK_TOP))
}
export function compileFConvertInstruction(
	instruction: 'f32.demote' | 'f64.promote',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const operand = context.resolvePop()
	let source: asm.Datum, target: asm.Datum
	if (operand) source = target = {type: 'register', register: operand}
	else {
		source = STACK_TOP
		target = {type: 'register', register: FLOAT_INTERMEDIATE_REGISTERS[0]}
	}
	const [type] = instruction.split('.') as [ValueType, string]
	const targetWidth = typeWidth(type)
	output.push(new asm.CvtFloatInstruction(
		source, target, targetWidth === 's' ? 'd' : 's', targetWidth
	))
	if (!operand) output.push(new asm.MoveInstruction(target, source, targetWidth))
	context.push(true)
}
export function compileReinterpretInstruction(
	instruction:
		'i32.reinterpret' | 'i64.reinterpret' | 'f32.reinterpret' | 'f64.reinterpret',
	context: CompilationContext,
	output: asm.AssemblyInstruction[]
): void {
	const operand = context.resolvePop()
	const [type] = instruction.split('.') as [ValueType, string]
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
}