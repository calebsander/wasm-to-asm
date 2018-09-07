import {parseByOpcode, parseReturn} from './parse'

export type ValueType
	= 'i32'
	| 'i64'
	| 'f32'
	| 'f64'

export const parseValueType = parseByOpcode(new Map([
	[0x7F, parseReturn<ValueType>('i32')],
	[0x7E, parseReturn<ValueType>('i64')],
	[0x7D, parseReturn<ValueType>('f32')],
	[0x7C, parseReturn<ValueType>('f64')]
]))