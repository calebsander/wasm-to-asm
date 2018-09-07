import {
	Parser,
	parseAndThen,
	parseByte,
	parseChoice,
	parseExact,
	parseMap,
	parseReturn,
	parseTimes
} from './parse'

type ValueType
	= 'i32'
	| 'i64'
	| 'f32'
	| 'f64'
type ResultType = 'empty' | ValueType
type Label = number
type FunctionIndex = number
type TypeIndex = number
type LocalIndex = number
type GlobalIndex = number
interface MemoryAccess {
	align: number
	offset: number
}
type ControlInstruction
	= {type: 'unreachable' | 'nop' | 'return'}
	| {type: 'block' | 'loop', returns: ResultType, instructions: Instruction[]}
	| {
			type: 'if',
			returns: ResultType,
			ifInstructions: Instruction[],
			elseInstructions: Instruction[]
		}
	| {type: 'br' | 'br_if', label: Label}
	| {type: 'br_table', cases: Label[], defaultCase: Label}
	| {type: 'call', func: FunctionIndex}
	| {type: 'call_indirect', funcType: TypeIndex}
type ParametricInstruction = {type: 'drop' | 'select'}
type VariableInstruction
	= {type: 'get_local' | 'set_local' | 'tee_local', local: LocalIndex}
	| {type: 'get_global' | 'set_global', global: GlobalIndex}
type MemoryInstruction
	=	{
			type:
				'i32.load' |
				'i64.load' |
				'f32.load' |
				'f64.load' |
				'i32.load8_s' |
				'i32.load8_u' |
				'i32.load16_s' |
				'i32.load16_u' |
				'i64.load8_s' |
				'i64.load8_u' |
				'i64.load16_s' |
				'i64.load16_u' |
				'i64.load32_s' |
				'i64.load32_u' |
				'i32.store' |
				'i64.store' |
				'f32.store' |
				'f64.store' |
				'i32.store8' |
				'i32.store16' |
				'i64.store8' |
				'i64.store16' |
				'i64.store32',
			access: MemoryAccess
		}
	| {type: 'memory.size' | 'memory.grow'}
type NumericInstruction
	= {type: 'i32.const' | 'f32.const' | 'f64.const', value: number}
	| {type: 'i64.const', value: bigint}
	| {type:
			'i32.eqz' |
			'i32.eq' |
			'i32.ne' |
			'i32.lt_s' |
			'i32.lt_u' |
			'i32.gt_s' |
			'i32.gt_u' |
			'i32.le_s' |
			'i32.le_u' |
			'i32.ge_s' |
			'i32.ge_u' |

			'i64.eqz' |
			'i64.eq' |
			'i64.ne' |
			'i64.lt_s' |
			'i64.lt_u' |
			'i64.gt_s' |
			'i64.gt_u' |
			'i64.le_s' |
			'i64.le_u' |
			'i64.ge_s' |
			'i64.ge_u' |

			'f32.eq' |
			'f32.ne' |
			'f32.lt' |
			'f32.gt' |
			'f32.le' |
			'f32.ge' |

			'f64.eq' |
			'f64.ne' |
			'f64.lt' |
			'f64.gt' |
			'f64.le' |
			'f64.ge' |

			'i32.clz' |
			'i32.ctz' |
			'i32.popcnt' |
			'i32.add' |
			'i32.sub' |
			'i32.mul' |
			'i32.div_s' |
			'i32.div_u' |
			'i32.rem_s' |
			'i32.rem_u' |
			'i32.and' |
			'i32.or' |
			'i32.xor' |
			'i32.shl' |
			'i32.shr_s' |
			'i32.shr_u' |
			'i32.rotl' |
			'i32.rotr' |

			'i64.clz' |
			'i64.ctz' |
			'i64.popcnt' |
			'i64.add' |
			'i64.sub' |
			'i64.mul' |
			'i64.div_s' |
			'i64.div_u' |
			'i64.rem_s' |
			'i64.rem_u' |
			'i64.and' |
			'i64.or' |
			'i64.xor' |
			'i64.shl' |
			'i64.shr_s' |
			'i64.shr_u' |
			'i64.rotl' |
			'i64.rotr' |

			'f32.abs' |
			'f32.neg' |
			'f32.ceil' |
			'f32.floor' |
			'f32.trunc' |
			'f32.nearest' |
			'f32.sqrt' |
			'f32.add' |
			'f32.sub' |
			'f32.mul' |
			'f32.div' |
			'f32.min' |
			'f32.max' |
			'f32.copysign' |

			'f64.abs' |
			'f64.neg' |
			'f64.ceil' |
			'f64.floor' |
			'f64.trunc' |
			'f64.nearest' |
			'f64.sqrt' |
			'f64.add' |
			'f64.sub' |
			'f64.mul' |
			'f64.div' |
			'f64.min' |
			'f64.max' |
			'f64.copysign' |

			'i32.wrap' |
			'i32.trunc_s/f32' |
			'i32.truns_u/f32' |
			'i32.trunc_s/f64' |
			'i32.truns_u/f64' |
			'i64.extend_s' |
			'i64.extend_u' |
			'i64.trunc_s/f32' |
			'i64.truns_u/f32' |
			'i64.trunc_s/f64' |
			'i64.truns_u/f64' |
			'f32.convert_s/i32' |
			'f32.convert_u/i32' |
			'f32.convert_s/i64' |
			'f32.convert_u/i64' |
			'f32.demote' |
			'f64.convert_s/i32' |
			'f64.convert_u/i32' |
			'f64.convert_s/i64' |
			'f64.convert_u/i64' |
			'f64.promote' |
			'i32.reinterpret' |
			'i64.reinterpret' |
			'f32.reinterpret' |
			'f64.reinterpret'
		}
type Instruction
	= ControlInstruction
	| ParametricInstruction
	| VariableInstruction
	| MemoryInstruction
	| NumericInstruction

const instructionParsers = new Map<number, Parser<Instruction>>()
export const parseInstruction = parseAndThen(
	parseByte,
	opcode => {
		const parser = instructionParsers.get(opcode)
		if (!parser) throw new Error(`Unexpected opcode 0x${opcode.toString(16)}`)
		return parser
	}
)
const parseBody: Parser<Instruction[]> = parseChoice([
	parseMap(parseExact(0x0B), _ => []),
	parseAndThen(
		parseInstruction,
		instruction => parseMap(
			parseBody,
			instructions => [instruction, ...instructions]
		)
	)
])
interface IfBody {
	ifInstructions: Instruction[]
	elseInstructions: Instruction[]
}
const parseIfBody: Parser<IfBody> = parseChoice([
	parseMap(
		parseExact(0x0B),
		_ => ({ifInstructions: [], elseInstructions: []})
	),
	parseAndThen(
		parseExact(0x05),
		_ => parseMap(
			parseBody,
			elseInstructions => ({ifInstructions: [], elseInstructions})
		)
	),
	parseAndThen(
		parseInstruction,
		instruction => parseMap(
			parseIfBody,
			({ifInstructions, elseInstructions}) => ({
				ifInstructions: [instruction, ...ifInstructions],
				elseInstructions
			})
		)
	)
])
const parseValueType = parseChoice([
	parseMap(parseExact(0x7F), (_): ValueType => 'i32'),
	parseMap(parseExact(0x7E), (_): ValueType => 'i64'),
	parseMap(parseExact(0x7D), (_): ValueType => 'f32'),
	parseMap(parseExact(0x7C), (_): ValueType => 'f64')
])
const parseResultType = parseChoice([
	parseMap(parseExact(0x40), (_): ResultType => 'empty'),
	parseValueType
])
const parseBlockLike = (type: 'block' | 'loop') =>
	parseAndThen(
		parseResultType,
		returns => parseMap(
			parseBody,
			(instructions): Instruction => ({type, returns, instructions})
		)
	)
const parseFixedInstruction = <TYPE extends string>(type: TYPE) =>
	parseReturn({type})
const parseUnsigned: Parser<number> = parseAndThen(
	parseByte,
	n =>
		n & 0b10000000
			? parseMap(
					parseUnsigned,
					m => (m << 7 | (n & 0b01111111)) >>> 0
				)
			: parseReturn(n)
)
// TODO: verify that this computation is correct
const parseSigned: Parser<bigint> = data => {
	let value = 0n
	let shift = 0
	let length = 0
	let byte: number;
	do {
		byte = data.getUint8(length++)
		value |= BigInt(byte & 0b01111111) << BigInt(shift)
		shift += 7
	} while (byte & 0b10000000)
	if (byte & 0b01000000) value |= -1n << BigInt(shift)
	return {value, length}
}
const parseVector = <A>(parser: Parser<A>) => parseAndThen(
	parseUnsigned,
	parseTimes(parser)
)
const parseLocalInstruction = <TYPE extends string>(type: TYPE) =>
	parseMap(parseUnsigned, local => ({type, local}))
const parseGlobalInstruction = <TYPE extends string>(type: TYPE) =>
	parseMap(parseUnsigned, global => ({type, global}))
const parseMemoryAccess = parseAndThen(
	parseUnsigned,
	align => parseMap(
		parseUnsigned,
		offset => ({align, offset})
	)
)
const parseMemoryInstruction = <TYPE extends string>(type: TYPE) =>
	parseMap(parseMemoryAccess, access => ({type, access}))

instructionParsers
	.set(0x00, parseFixedInstruction('unreachable'))
	.set(0x01, parseFixedInstruction('nop'))
	.set(0x02, parseBlockLike('block'))
	.set(0x03, parseBlockLike('loop'))
	.set(0x04, parseAndThen(
		parseResultType,
		returns => parseMap(
			parseIfBody,
			(ifBody): Instruction =>
				({type: 'if', returns, ...ifBody})
		)
	))
	.set(0x0C, parseMap(
		parseUnsigned,
		(label): Instruction => ({type: 'br', label})
	))
	.set(0x0D, parseMap(
		parseUnsigned,
		(label): Instruction => ({type: 'br_if', label})
	))
	.set(0x0E, parseAndThen(
		parseVector(parseUnsigned),
		cases => parseMap(
			parseUnsigned,
			(defaultCase): Instruction =>
				({type: 'br_table', cases, defaultCase})
		)
	))
	.set(0x0F, parseReturn<Instruction>({type: 'return'}))
	.set(0x10, parseMap(
		parseUnsigned,
		(func): Instruction => ({type: 'call', func})
	))
	.set(0x11, parseAndThen(
		parseUnsigned,
		funcType => parseMap(
			parseExact(0x00),
			(_): Instruction => ({type: 'call_indirect', funcType})
		)
	))

	.set(0x1A, parseFixedInstruction('drop'))
	.set(0x1B, parseFixedInstruction('select'))

	.set(0x20, parseLocalInstruction('get_local'))
	.set(0x21, parseLocalInstruction('set_local'))
	.set(0x22, parseLocalInstruction('tee_local'))
	.set(0x23, parseGlobalInstruction('get_global'))
	.set(0x24, parseGlobalInstruction('set_global'))

	.set(0x28, parseMemoryInstruction('i32.load'))
	.set(0x29, parseMemoryInstruction('i64.load'))
	.set(0x2A, parseMemoryInstruction('f32.load'))
	.set(0x2B, parseMemoryInstruction('f64.load'))
	.set(0x2C, parseMemoryInstruction('i32.load8_s'))
	.set(0x2D, parseMemoryInstruction('i32.load8_u'))
	.set(0x2E, parseMemoryInstruction('i32.load16_s'))
	.set(0x2F, parseMemoryInstruction('i32.load16_u'))
	.set(0x30, parseMemoryInstruction('i64.load8_s'))
	.set(0x31, parseMemoryInstruction('i64.load8_u'))
	.set(0x32, parseMemoryInstruction('i64.load16_s'))
	.set(0x33, parseMemoryInstruction('i64.load16_u'))
	.set(0x34, parseMemoryInstruction('i64.load32_s'))
	.set(0x35, parseMemoryInstruction('i64.load32_u'))
	.set(0x36, parseMemoryInstruction('i32.store'))
	.set(0x37, parseMemoryInstruction('i64.store'))
	.set(0x38, parseMemoryInstruction('f32.store'))
	.set(0x39, parseMemoryInstruction('f64.store'))
	.set(0x3A, parseMemoryInstruction('i32.store8'))
	.set(0x3B, parseMemoryInstruction('i32.store16'))
	.set(0x3C, parseMemoryInstruction('i64.store8'))
	.set(0x3D, parseMemoryInstruction('i64.store16'))
	.set(0x3E, parseMemoryInstruction('i64.store32'))
	.set(0x3F, parseMap(
		parseExact(0x00),
		(_): Instruction => ({type: 'memory.size'})
	))
	.set(0x40, parseMap(
		parseExact(0x00),
		(_): Instruction => ({type: 'memory.grow'})
	))

	.set(0x41, parseMap(
		parseSigned,
		(n): Instruction => ({type: 'i32.const', value: Number(n)})
	))
	.set(0x42, parseMap(
		parseSigned,
		(value): Instruction => ({type: 'i64.const', value})
	))
	.set(0x43, parseMap(
		data => ({value: data.getFloat32(0, true), length: 4}),
		(value): Instruction => ({type: 'f32.const', value})
	))
	.set(0x44, parseMap(
		data => ({value: data.getFloat64(0, true), length: 8}),
		(value): Instruction => ({type: 'f64.const', value})
	))

	.set(0x45, parseFixedInstruction('i32.eqz'))
	.set(0x46, parseFixedInstruction('i32.eq'))
	.set(0x47, parseFixedInstruction('i32.ne'))
	.set(0x48, parseFixedInstruction('i32.lt_s'))
	.set(0x49, parseFixedInstruction('i32.lt_u'))
	.set(0x4A, parseFixedInstruction('i32.gt_s'))
	.set(0x4B, parseFixedInstruction('i32.gt_u'))
	.set(0x4C, parseFixedInstruction('i32.le_s'))
	.set(0x4D, parseFixedInstruction('i32.le_u'))
	.set(0x4E, parseFixedInstruction('i32.ge_s'))
	.set(0x4F, parseFixedInstruction('i32.ge_u'))