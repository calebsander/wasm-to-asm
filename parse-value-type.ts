import {parseChoice, parseExact, parseMap} from './parse'

export type ValueType
	= 'i32'
	| 'i64'
	| 'f32'
	| 'f64'

export const parseValueType = parseChoice([
	parseMap(parseExact(0x7F), (_): ValueType => 'i32'),
	parseMap(parseExact(0x7E), (_): ValueType => 'i64'),
	parseMap(parseExact(0x7D), (_): ValueType => 'f32'),
	parseMap(parseExact(0x7C), (_): ValueType => 'f64')
])