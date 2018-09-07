import {
	Parser,
	ParseResult,
	parseAndThen,
	parseByte,
	parseChoice,
	parseExact,
	parseMap,
	parseVector
} from './parse'
import {ValueType, parseValueType} from './parse-value-type'

interface FunctionType {
	parameters: ValueType[]
	results: ValueType[]
}
interface Limits {
	min: number
	max?: number
}
type ImportDescription
	= {type: 'function', index: number}
	| {type: 'table' | 'memory', limits: Limits}
	| {type: 'global', valueType: ValueType, mutable: boolean}
interface Import {
	module: string
	name: string
	description: ImportDescription
}
interface CustomSection {
	type: 'custom'
	name: string
	contents: ArrayBuffer
}
interface TypeSection {
	type: 'type'
	types: FunctionType[]
}
interface ImportSection {
	type: 'import'
	imports: Import[]
}
type Section
	= CustomSection
	| TypeSection
	| ImportSection

const parseName = parseMap(
	parseVector(parseByte),
	bytes => Buffer.from(bytes).toString()
)
const parseValueTypes = parseVector(parseValueType)
const parseFuncType = parseAndThen(
	parseExact(0x60),
	_ => parseAndThen(
		parseValueTypes,
		parameters => parseMap(
			parseValueTypes,
			results => ({parameters, results})
		)
	)
)
const parseImportDescription: Parser<ImportDescription> = parseChoice([])
const parseImport = parseAndThen(
	parseName,
	module => parseAndThen(
		parseName,
		name => parseMap(
			parseImportDescription,
			description => ({module, name, description})
		)
	)
)

const sectionParsers = new Map<number, Parser<Section>>([
	[0, parseAndThen(
		parseName,
		name => ({buffer, byteOffset, byteLength}): ParseResult<Section> => ({
			value: {
				type: 'custom',
				name,
				contents: buffer.slice(byteOffset, byteOffset + byteLength)
			},
			length: byteLength
		})
	)],
	[1, parseMap(
		parseVector(parseFuncType),
		(types): Section => ({type: 'type', types})
	)],
	[2, parseMap(
		parseVector(parseImport),
		(imports): Section => ({type: 'import', imports})
	)]
])