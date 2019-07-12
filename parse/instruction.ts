import {
	Parser,
	parseAndThen,
	parseByOpcode,
	parseByte,
	parseChoice,
	parseExact,
	parseIgnore,
	parseMap,
	parseReturn,
	parseUnsigned,
	parseUntil,
	parseVector,
	parseWhile
} from '.'
import {ValueType, parseValueType} from './value-type'

export type ResultType = ValueType | 'empty'
type Label = number
type FunctionIndex = number
type TypeIndex = number
type LocalIndex = number
type GlobalIndex = number
interface MemoryAccess {
	align: number
	offset: number
}
export interface BlockInstruction {
	type: 'block' | 'loop'
	returns: ResultType
	instructions: Instruction[]
}
export interface IfInstruction {
	type: 'if'
	returns: ResultType
	ifInstructions: Instruction[]
	elseInstructions: Instruction[]
}
export interface BranchInstruction {
	type: 'br' | 'br_if'
	label: Label
}
export interface BranchTableInstruction {
	type: 'br_table'
	cases: Label[]
	defaultCase: Label
}
export interface CallInstruction {
	type: 'call'
	func: FunctionIndex
}
export interface CallIndirectInstruction {
	type: 'call_indirect'
	funcType: TypeIndex
}
type ControlInstruction
	= {type: 'unreachable' | 'nop' | 'return'}
	| BlockInstruction
	| IfInstruction
	| BranchInstruction
	| BranchTableInstruction
	| CallInstruction
	| CallIndirectInstruction
type ParametricInstruction = {type: 'drop' | 'select'}
export interface LocalInstruction {
	type: 'get_local' | 'set_local' | 'tee_local'
	local: LocalIndex
}
type VariableInstruction
	= LocalInstruction
	| {type: 'get_global' | 'set_global', global: GlobalIndex}
export interface LoadStoreInstruction {
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
		'i64.store32'
	access: MemoryAccess
}
type MemoryInstruction
	= LoadStoreInstruction
	| {type: 'memory.size' | 'memory.grow'}
export type ConstInstruction
	= {type: 'i32.const' | 'f32.const' | 'f64.const', value: number}
	| {type: 'i64.const', value: bigint}
type NumericInstruction
	= ConstInstruction
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
			'i32.trunc_u/f32' |
			'i32.trunc_s/f64' |
			'i32.trunc_u/f64' |
			'i64.extend_s' |
			'i64.extend_u' |
			'i64.trunc_s/f32' |
			'i64.trunc_u/f32' |
			'i64.trunc_s/f64' |
			'i64.trunc_u/f64' |
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
export type Instruction
	= ControlInstruction
	| ParametricInstruction
	| VariableInstruction
	| MemoryInstruction
	| NumericInstruction

const BODY_END = 0x0B

const instructionParsers = new Map<number, Parser<Instruction>>()
export const parseInstruction = parseByOpcode(instructionParsers)
export const parseBody = parseUntil(parseInstruction, parseExact(BODY_END))
const parseIfBody =
	parseAndThen(parseWhile(parseInstruction), ifInstructions =>
		parseByOpcode(new Map([
			[0x05, parseMap(parseBody, elseInstructions =>
				({ifInstructions, elseInstructions})
			)],
			[BODY_END, parseReturn({ifInstructions, elseInstructions: []})]
		]))
	)
const parseResultType = parseChoice([
	parseIgnore(parseExact(0x40), parseReturn('empty')),
	parseValueType
])
const parseBlockLike = (type: 'block' | 'loop') =>
	parseAndThen(parseResultType, returns =>
		parseMap(parseBody, instructions => ({type, returns, instructions}))
	)
const parseBranchLike = (type: 'br' | 'br_if') =>
	parseMap(parseUnsigned, label => ({type, label}))
const parseFixedInstruction = <TYPE extends string>(type: TYPE) =>
	parseReturn({type})
const parseSigned: Parser<bigint> = parseAndThen(parseByte, n =>
	n & 0b10000000
		? parseMap(parseSigned, m =>
				m << 7n | BigInt.asUintN(7, BigInt(n))
			)
		: parseReturn(BigInt.asIntN(7, BigInt(n))) // sign-extend lower 7 bits
)
const parseLocalInstruction = <TYPE extends string>(type: TYPE) =>
	parseMap(parseUnsigned, local => ({type, local}))
const parseGlobalInstruction = <TYPE extends string>(type: TYPE) =>
	parseMap(parseUnsigned, global => ({type, global}))
const parseMemoryAccess = parseAndThen(parseUnsigned, align =>
	parseMap(parseUnsigned, offset => ({align, offset}))
)
const parseMemoryInstruction = <TYPE extends string>(type: TYPE) =>
	parseMap(parseMemoryAccess, access => ({type, access}))

const opcodeParsers: [number, Parser<Instruction>][] = [
	[0x00, parseFixedInstruction('unreachable')],
	[0x01, parseFixedInstruction('nop')],
	[0x02, parseBlockLike('block')],
	[0x03, parseBlockLike('loop')],
	[0x04, parseAndThen(parseResultType, returns =>
		parseMap(parseIfBody, ifBody => ({type: 'if', returns, ...ifBody}))
	)],
	[0x0C, parseBranchLike('br')],
	[0x0D, parseBranchLike('br_if')],
	[0x0E, parseAndThen(parseVector(parseUnsigned), cases =>
		parseMap(parseUnsigned, defaultCase =>
			({type: 'br_table', cases, defaultCase})
		)
	)],
	[0x0F, parseFixedInstruction('return')],
	[0x10, parseMap(parseUnsigned, func => ({type: 'call', func}))],
	[0x11, parseAndThen(parseUnsigned, funcType =>
		parseIgnore(parseExact(0x00),
			parseReturn({type: 'call_indirect', funcType})
		)
	)],

	[0x1A, parseFixedInstruction('drop')],
	[0x1B, parseFixedInstruction('select')],

	[0x20, parseLocalInstruction('get_local')],
	[0x21, parseLocalInstruction('set_local')],
	[0x22, parseLocalInstruction('tee_local')],
	[0x23, parseGlobalInstruction('get_global')],
	[0x24, parseGlobalInstruction('set_global')],

	[0x28, parseMemoryInstruction('i32.load')],
	[0x29, parseMemoryInstruction('i64.load')],
	[0x2A, parseMemoryInstruction('f32.load')],
	[0x2B, parseMemoryInstruction('f64.load')],
	[0x2C, parseMemoryInstruction('i32.load8_s')],
	[0x2D, parseMemoryInstruction('i32.load8_u')],
	[0x2E, parseMemoryInstruction('i32.load16_s')],
	[0x2F, parseMemoryInstruction('i32.load16_u')],
	[0x30, parseMemoryInstruction('i64.load8_s')],
	[0x31, parseMemoryInstruction('i64.load8_u')],
	[0x32, parseMemoryInstruction('i64.load16_s')],
	[0x33, parseMemoryInstruction('i64.load16_u')],
	[0x34, parseMemoryInstruction('i64.load32_s')],
	[0x35, parseMemoryInstruction('i64.load32_u')],
	[0x36, parseMemoryInstruction('i32.store')],
	[0x37, parseMemoryInstruction('i64.store')],
	[0x38, parseMemoryInstruction('f32.store')],
	[0x39, parseMemoryInstruction('f64.store')],
	[0x3A, parseMemoryInstruction('i32.store8')],
	[0x3B, parseMemoryInstruction('i32.store16')],
	[0x3C, parseMemoryInstruction('i64.store8')],
	[0x3D, parseMemoryInstruction('i64.store16')],
	[0x3E, parseMemoryInstruction('i64.store32')],
	[0x3F, parseIgnore(parseExact(0x00), parseFixedInstruction('memory.size'))],
	[0x40, parseIgnore(parseExact(0x00), parseFixedInstruction('memory.grow'))],

	[0x41, parseMap(parseSigned, n => ({type: 'i32.const', value: Number(n)}))],
	[0x42, parseMap(parseSigned, value => ({type: 'i64.const', value}))],
	[0x43, parseMap(
		data => ({value: data.getFloat32(0, true), length: 4}),
		value => ({type: 'f32.const', value})
	)],
	[0x44, parseMap(
		data => ({value: data.getFloat64(0, true), length: 8}),
		value => ({type: 'f64.const', value})
	)],

	[0x45, parseFixedInstruction('i32.eqz')],
	[0x46, parseFixedInstruction('i32.eq')],
	[0x47, parseFixedInstruction('i32.ne')],
	[0x48, parseFixedInstruction('i32.lt_s')],
	[0x49, parseFixedInstruction('i32.lt_u')],
	[0x4A, parseFixedInstruction('i32.gt_s')],
	[0x4B, parseFixedInstruction('i32.gt_u')],
	[0x4C, parseFixedInstruction('i32.le_s')],
	[0x4D, parseFixedInstruction('i32.le_u')],
	[0x4E, parseFixedInstruction('i32.ge_s')],
	[0x4F, parseFixedInstruction('i32.ge_u')],

	[0x50, parseFixedInstruction('i64.eqz')],
	[0x51, parseFixedInstruction('i64.eq')],
	[0x52, parseFixedInstruction('i64.ne')],
	[0x53, parseFixedInstruction('i64.lt_s')],
	[0x54, parseFixedInstruction('i64.lt_u')],
	[0x55, parseFixedInstruction('i64.gt_s')],
	[0x56, parseFixedInstruction('i64.gt_u')],
	[0x57, parseFixedInstruction('i64.le_s')],
	[0x58, parseFixedInstruction('i64.le_u')],
	[0x59, parseFixedInstruction('i64.ge_s')],
	[0x5A, parseFixedInstruction('i64.ge_u')],

	[0x5B, parseFixedInstruction('f32.eq')],
	[0x5C, parseFixedInstruction('f32.ne')],
	[0x5D, parseFixedInstruction('f32.lt')],
	[0x5E, parseFixedInstruction('f32.gt')],
	[0x5F, parseFixedInstruction('f32.le')],
	[0x60, parseFixedInstruction('f32.ge')],

	[0x61, parseFixedInstruction('f64.eq')],
	[0x62, parseFixedInstruction('f64.ne')],
	[0x63, parseFixedInstruction('f64.lt')],
	[0x64, parseFixedInstruction('f64.gt')],
	[0x65, parseFixedInstruction('f64.le')],
	[0x66, parseFixedInstruction('f64.ge')],

	[0x67, parseFixedInstruction('i32.clz')],
	[0x68, parseFixedInstruction('i32.ctz')],
	[0x69, parseFixedInstruction('i32.popcnt')],
	[0x6A, parseFixedInstruction('i32.add')],
	[0x6B, parseFixedInstruction('i32.sub')],
	[0x6C, parseFixedInstruction('i32.mul')],
	[0x6D, parseFixedInstruction('i32.div_s')],
	[0x6E, parseFixedInstruction('i32.div_u')],
	[0x6F, parseFixedInstruction('i32.rem_s')],
	[0x70, parseFixedInstruction('i32.rem_u')],
	[0x71, parseFixedInstruction('i32.and')],
	[0x72, parseFixedInstruction('i32.or')],
	[0x73, parseFixedInstruction('i32.xor')],
	[0x74, parseFixedInstruction('i32.shl')],
	[0x75, parseFixedInstruction('i32.shr_s')],
	[0x76, parseFixedInstruction('i32.shr_u')],
	[0x77, parseFixedInstruction('i32.rotl')],
	[0x78, parseFixedInstruction('i32.rotr')],

	[0x79, parseFixedInstruction('i64.clz')],
	[0x7A, parseFixedInstruction('i64.ctz')],
	[0x7B, parseFixedInstruction('i64.popcnt')],
	[0x7C, parseFixedInstruction('i64.add')],
	[0x7D, parseFixedInstruction('i64.sub')],
	[0x7E, parseFixedInstruction('i64.mul')],
	[0x7F, parseFixedInstruction('i64.div_s')],
	[0x80, parseFixedInstruction('i64.div_u')],
	[0x81, parseFixedInstruction('i64.rem_s')],
	[0x82, parseFixedInstruction('i64.rem_u')],
	[0x83, parseFixedInstruction('i64.and')],
	[0x84, parseFixedInstruction('i64.or')],
	[0x85, parseFixedInstruction('i64.xor')],
	[0x86, parseFixedInstruction('i64.shl')],
	[0x87, parseFixedInstruction('i64.shr_s')],
	[0x88, parseFixedInstruction('i64.shr_u')],
	[0x89, parseFixedInstruction('i64.rotl')],
	[0x8A, parseFixedInstruction('i64.rotr')],

	[0x8B, parseFixedInstruction('f32.abs')],
	[0x8C, parseFixedInstruction('f32.neg')],
	[0x8D, parseFixedInstruction('f32.ceil')],
	[0x8E, parseFixedInstruction('f32.floor')],
	[0x8F, parseFixedInstruction('f32.trunc')],
	[0x90, parseFixedInstruction('f32.nearest')],
	[0x91, parseFixedInstruction('f32.sqrt')],
	[0x92, parseFixedInstruction('f32.add')],
	[0x93, parseFixedInstruction('f32.sub')],
	[0x94, parseFixedInstruction('f32.mul')],
	[0x95, parseFixedInstruction('f32.div')],
	[0x96, parseFixedInstruction('f32.min')],
	[0x97, parseFixedInstruction('f32.max')],
	[0x98, parseFixedInstruction('f32.copysign')],

	[0x99, parseFixedInstruction('f64.abs')],
	[0x9A, parseFixedInstruction('f64.neg')],
	[0x9B, parseFixedInstruction('f64.ceil')],
	[0x9C, parseFixedInstruction('f64.floor')],
	[0x9D, parseFixedInstruction('f64.trunc')],
	[0x9E, parseFixedInstruction('f64.nearest')],
	[0x9F, parseFixedInstruction('f64.sqrt')],
	[0xA0, parseFixedInstruction('f64.add')],
	[0xA1, parseFixedInstruction('f64.sub')],
	[0xA2, parseFixedInstruction('f64.mul')],
	[0xA3, parseFixedInstruction('f64.div')],
	[0xA4, parseFixedInstruction('f64.min')],
	[0xA5, parseFixedInstruction('f64.max')],
	[0xA6, parseFixedInstruction('f64.copysign')],

	[0xA7, parseFixedInstruction('i32.wrap')],
	[0xA8, parseFixedInstruction('i32.trunc_s/f32')],
	[0xA9, parseFixedInstruction('i32.trunc_u/f32')],
	[0xAA, parseFixedInstruction('i32.trunc_s/f64')],
	[0xAB, parseFixedInstruction('i32.trunc_u/f64')],
	[0xAC, parseFixedInstruction('i64.extend_s')],
	[0xAD, parseFixedInstruction('i64.extend_u')],
	[0xAE, parseFixedInstruction('i64.trunc_s/f32')],
	[0xAF, parseFixedInstruction('i64.trunc_u/f32')],
	[0xB0, parseFixedInstruction('i64.trunc_s/f64')],
	[0xB1, parseFixedInstruction('i64.trunc_u/f64')],
	[0xB2, parseFixedInstruction('f32.convert_s/i32')],
	[0xB3, parseFixedInstruction('f32.convert_u/i32')],
	[0xB4, parseFixedInstruction('f32.convert_s/i64')],
	[0xB5, parseFixedInstruction('f32.convert_u/i64')],
	[0xB6, parseFixedInstruction('f32.demote')],
	[0xB7, parseFixedInstruction('f64.convert_s/i32')],
	[0xB8, parseFixedInstruction('f64.convert_u/i32')],
	[0xB9, parseFixedInstruction('f64.convert_s/i64')],
	[0xBA, parseFixedInstruction('f64.convert_u/i64')],
	[0xBB, parseFixedInstruction('f64.promote')],
	[0xBC, parseFixedInstruction('i32.reinterpret')],
	[0xBD, parseFixedInstruction('i64.reinterpret')],
	[0xBE, parseFixedInstruction('f32.reinterpret')],
	[0xBF, parseFixedInstruction('f64.reinterpret')]
]
for (const [opcode, parser] of opcodeParsers) {
	instructionParsers.set(opcode, parser)
}