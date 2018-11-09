import {
	Parser,
	ParseResult,
	parseAndThen,
	parseByte,
	parseChoice,
	parseExact,
	parseIgnore,
	parseMap,
	parseReturn,
	parseUnsigned,
	parseVector,
	parseByOpcode
} from './parse'
import {Instruction, parseBody} from './parse-instruction'
import {ValueType, parseValueType} from './parse-value-type'

const VERSION = 1

export interface FunctionType {
	params: ValueType[]
	results: ValueType[]
}
interface Limits {
	min: number
	max?: number
}
interface GlobalType {
	type: ValueType
	mutable: boolean
}
type ImportDescription
	= {type: 'function', index: number}
	| {type: 'table' | 'memory', limits: Limits}
	| {type: 'global', valueType: GlobalType}
interface Import {
	module: string
	name: string
	description: ImportDescription
}
export interface Global {
	type: GlobalType
	initializer: Instruction[]
}
interface ExportDescription {
	type: 'function' | 'table' | 'memory' | 'global'
	index: number
}
export interface Export {
	name: string
	description: ExportDescription
}
interface TableInitializer {
	tableIndex: number
	offset: Instruction[]
	functionIndices: number[]
}
interface CodeSegment {
	locals: ValueType[]
	instructions: Instruction[]
}
interface MemoryInitializer {
	memoryIndex: number
	offset: Instruction[]
	data: ArrayBuffer
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
interface FunctionSection {
	type: 'function'
	typeIndices: number[]
}
interface TableSection {
	type: 'table'
	tables: Limits[]
}
interface MemorySection {
	type: 'memory'
	memories: Limits[]
}
interface GlobalSection {
	type: 'global'
	globals: Global[]
}
interface ExportSection {
	type: 'export'
	exports: Export[]
}
interface StartSection {
	type: 'start'
	functionIndex: number
}
interface ElementSection {
	type: 'element'
	initializers: TableInitializer[]
}
export interface CodeSection {
	type: 'code'
	segments: CodeSegment[]
}
interface DataSection {
	type: 'data'
	initializers: MemoryInitializer[]
}
export type Section
	= CustomSection
	| TypeSection
	| ImportSection
	| FunctionSection
	| TableSection
	| MemorySection
	| GlobalSection
	| ExportSection
	| StartSection
	| ElementSection
	| CodeSection
	| DataSection

const parseByteVector = parseAndThen(
	parseUnsigned,
	length => ({buffer, byteOffset}) =>
		({value: buffer.slice(byteOffset, byteOffset + length), length})
)
const parseName = parseMap(
	parseByteVector,
	utf8 => Buffer.from(utf8).toString()
)
const parseValueTypes = parseVector(parseValueType)
const parseFuncType = parseIgnore(
	parseExact(0x60),
	parseAndThen(
		parseValueTypes,
		params => parseMap(
			parseValueTypes,
			results => ({params, results})
		)
	)
)
const parseLimits = parseAndThen(
	parseByte,
	hasMax => parseAndThen(
		parseUnsigned,
		min => parseMap(
			hasMax ? parseUnsigned : parseReturn(undefined),
			max => ({min, max})
		)
	)
)
const parseTableType = parseIgnore(parseExact(0x70), parseLimits)
const parseGlobalType = parseAndThen(
	parseValueType,
	type => parseMap(
		parseByte,
		mutable => ({type, mutable: !!mutable})
	)
)
const parseImportDescription = parseByOpcode(new Map([
	[0x00, parseMap(
		parseUnsigned,
		(index): ImportDescription => ({type: 'function', index})
	)],
	[0x01, parseMap(
		parseTableType,
		(limits): ImportDescription => ({type: 'table', limits})
	)],
	[0x02, parseMap(
		parseLimits,
		(limits): ImportDescription => ({type: 'memory', limits})
	)],
	[0x03, parseMap(
		parseGlobalType,
		(valueType): ImportDescription => ({type: 'global', valueType})
	)]
]))
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
const parseExportDescription = parseByOpcode(new Map([
	[0x00, parseMap(
		parseUnsigned,
		(index): ExportDescription => ({type: 'function', index})
	)],
	[0x01, parseMap(
		parseUnsigned,
		(index): ExportDescription => ({type: 'table', index})
	)],
	[0x02, parseMap(
		parseUnsigned,
		(index): ExportDescription => ({type: 'memory', index})
	)],
	[0x03, parseMap(
		parseUnsigned,
		(index): ExportDescription => ({type: 'global', index})
	)]
]))
const parseExport = parseAndThen(
	parseName,
	name => parseMap(
		parseExportDescription,
		description => ({name, description})
	)
)
const parseTableInitializer = parseAndThen(
	parseUnsigned,
	tableIndex => parseAndThen(
		parseBody,
		offset => parseMap(
			parseVector(parseUnsigned),
			functionIndices => ({tableIndex, offset, functionIndices})
		)
	)
)
const parseLocal = parseAndThen(
	parseUnsigned,
	count => parseMap(
		parseValueType,
		type => ({count, type})
	)
)
const parseCodeSegment = parseIgnore(
	parseUnsigned,
	parseAndThen(
		parseVector(parseLocal),
		localRanges => parseMap(
			parseBody,
			instructions => {
				const locals: ValueType[] = []
				for (let {count, type} of localRanges) {
					while (count--) locals.push(type)
				}
				return {locals, instructions}
			}
		)
	)
)
const parseMemoryInitializer = parseAndThen(
	parseUnsigned,
	memoryIndex => parseAndThen(
		parseBody,
		offset => parseMap(
			parseByteVector,
			data => ({memoryIndex, offset, data})
		)
	)
)

const sectionParsers = new Map<number, Parser<Section>>()
	.set(0, parseAndThen(
		parseUnsigned,
		length => parseAndThen(
			parseName,
			name => ({buffer, byteOffset}): ParseResult<Section> => ({
				value: {
					type: 'custom',
					name,
					contents: buffer.slice(byteOffset, byteOffset + length)
				},
				length
			})
		)
	));
for (const [id, parser] of [
	[1, parseMap(
		parseVector(parseFuncType),
		(types): Section => ({type: 'type', types})
	)],
	[2, parseMap(
		parseVector(parseImport),
		(imports): Section => ({type: 'import', imports})
	)],
	[3, parseMap(
		parseVector(parseUnsigned),
		(typeIndices): Section => ({type: 'function', typeIndices})
	)],
	[4, parseMap(
		parseVector(parseTableType),
		(tables): Section => ({type: 'table', tables})
	)],
	[5, parseMap(
		parseVector(parseLimits),
		(memories): Section => ({type: 'memory', memories})
	)],
	[6, parseMap(
		parseVector(
			parseAndThen(
				parseGlobalType,
				type => parseMap(
					parseBody,
					initializer => ({type, initializer})
				)
			)
		),
		(globals): Section => ({type: 'global', globals})
	)],
	[7, parseMap(
		parseVector(parseExport),
		(exports): Section => ({type: 'export', exports})
	)],
	[8, parseMap(
		parseUnsigned,
		(functionIndex): Section => ({type: 'start', functionIndex})
	)],
	[9, parseMap(
		parseVector(parseTableInitializer),
		(initializers): Section => ({type: 'element', initializers})
	)],
	[10, parseMap(
		parseVector(parseCodeSegment),
		(segments): Section => ({type: 'code', segments})
	)],
	[11, parseMap(
		parseVector(parseMemoryInitializer),
		(initializers): Section => ({type: 'data', initializers})
	)]
] as [number, Parser<Section>][]) {
	sectionParsers.set(id, parseIgnore(
		parseUnsigned,
		parser
	))
}
const parseSection = parseByOpcode(sectionParsers)
const parseMagic: Parser<void> = data => {
	if (data.getUint32(0) !== 0x0061736D) {
		throw new Error('Invalid magic bytes');
	}
	return {value: undefined, length: 4}
}
const parseVersion: Parser<number> = data =>
	({value: data.getUint32(0, true), length: 4})
const parseUntilEnd = <A>(parser: Parser<A>): Parser<A[]> => parseChoice([
	parseAndThen(
		parser,
		first => parseMap(
			parseUntilEnd(parser),
			rest => [first, ...rest]
		)
	),
	parseReturn([])
])
export const parseModule = parseIgnore(
	parseMagic,
	parseIgnore(
		parseAndThen(
			parseVersion,
			version => {
				if (version !== VERSION) throw new Error(`Unsupported version ${version}`)
				return parseReturn(undefined)
			}
		),
		parseUntilEnd(parseSection)
	)
)