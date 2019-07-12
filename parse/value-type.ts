import {parseByOpcode, parseReturn, Parser} from '.'

export type ValueType
	= 'i32'
	| 'i64'
	| 'f32'
	| 'f64'

export const parseValueType: Parser<ValueType> =
	parseByOpcode(new Map<number, Parser<ValueType>>([
		[0x7F, parseReturn('i32')],
		[0x7E, parseReturn('i64')],
		[0x7D, parseReturn('f32')],
		[0x7C, parseReturn('f64')]
	]))