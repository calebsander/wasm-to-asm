import {
	Parser,
	ParseResult,
	parseAndThen,
	parseByOpcode,
	parseEnd,
	parseExact,
	parseIgnore,
	parseMap,
	parseReturn,
	parseUnsigned,
	parseUntil,
	parseVector
} from '.'
import {Instruction, parseBody} from './instruction'
import {ValueType, parseValueType} from './value-type'

const VERSION = 1

export interface FunctionType {
	params: ValueType[]
	results: ValueType[]
}
interface Limits {
	min: number
	max?: number
}
export interface GlobalType {
	type: ValueType
	mutable: boolean
}
type ImportDescription
	= {type: 'function', typeIndex: number}
	| {type: 'table' | 'memory', limits: Limits}
	| {type: 'global', valueType: GlobalType}
export interface Import {
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
export interface TableInitializer {
	tableIndex: number
	offset: Instruction[]
	functionIndices: number[]
}
interface CodeSegment {
	locals: ValueType[]
	instructions: Instruction[]
}
export interface MemoryInitializer {
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
interface CodeSection {
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

const parseByteVector = parseAndThen(parseUnsigned, length =>
	({buffer, byteOffset}) =>
		({value: buffer.slice(byteOffset, byteOffset + length), length})
)
const parseName =
	parseMap(parseByteVector, utf8 => Buffer.from(utf8).toString())
const parseValueTypes = parseVector(parseValueType)
const parseFuncType = parseIgnore(parseExact(0x60),
	parseAndThen(parseValueTypes, params =>
		parseMap(parseValueTypes, results => ({params, results}))
	)
)
const parseBoolean = parseByOpcode(new Map([
	[0, parseReturn(false)],
	[1, parseReturn(true)]
]))
const parseLimits = parseAndThen(parseBoolean, hasMax =>
	parseAndThen(parseUnsigned, min =>
		parseMap(
			hasMax ? parseUnsigned : parseReturn(undefined),
			max => ({min, max})
		)
	)
)
const parseTableType = parseIgnore(parseExact(0x70), parseLimits)
const parseGlobalType = parseAndThen(parseValueType, type =>
	parseMap(parseBoolean, mutable => ({type, mutable}))
)
const parseImportDescription =
	parseByOpcode(new Map<number, Parser<ImportDescription>>([
		[0, parseMap(parseUnsigned, typeIndex => ({type: 'function', typeIndex}))],
		[1, parseMap(parseTableType, limits => ({type: 'table', limits}))],
		[2, parseMap(parseLimits, limits => ({type: 'memory', limits}))],
		[3, parseMap(parseGlobalType, valueType => ({type: 'global', valueType}))]
	]))
const parseImport = parseAndThen(parseName, module =>
	parseAndThen(parseName, name =>
		parseMap(parseImportDescription, description =>
			({module, name, description})
		)
	)
)
const parseExportDescription =
	parseByOpcode(new Map<number, Parser<ExportDescription>>([
		[0, parseMap(parseUnsigned, index => ({type: 'function', index}))],
		[1, parseMap(parseUnsigned, index => ({type: 'table', index}))],
		[2, parseMap(parseUnsigned, index => ({type: 'memory', index}))],
		[3, parseMap(parseUnsigned, index => ({type: 'global', index}))]
	]))
const parseExport = parseAndThen(parseName, name =>
	parseMap(parseExportDescription, description => ({name, description}))
)
const parseTableInitializer = parseAndThen(parseUnsigned, tableIndex =>
	parseAndThen(parseBody, offset =>
		parseMap(parseVector(parseUnsigned), functionIndices =>
			({tableIndex, offset, functionIndices})
		)
	)
)
const parseLocal = parseAndThen(parseUnsigned, count =>
	parseMap(parseValueType, type => ({count, type}))
)
const parseCodeSegment = parseIgnore(parseUnsigned,
	parseAndThen(parseVector(parseLocal), localRanges =>
		parseMap(parseBody, instructions => {
			const locals: ValueType[] = []
			for (const {count, type} of localRanges) {
				locals.push(...new Array<ValueType>(count).fill(type))
			}
			return {locals, instructions}
		})
	)
)
const parseMemoryInitializer = parseAndThen(parseUnsigned, memoryIndex =>
	parseAndThen(parseBody, offset =>
		parseMap(parseByteVector, data => ({memoryIndex, offset, data}))
	)
)

const sectionParsers = new Map([
	[0, parseAndThen(parseUnsigned, length =>
		data => parseAndThen(parseName, name =>
			({buffer, byteOffset}): ParseResult<Section> => ({
				value: {
					type: 'custom',
					name,
					contents: buffer.slice(byteOffset, data.byteOffset + length)
				},
				length
			})
		)(data)
	)]
])
const opcodeParsers: [number, Parser<Section>][] = [
	[1, parseMap(parseVector(parseFuncType), types => ({type: 'type', types}))],
	[2, parseMap(parseVector(parseImport), imports =>
		({type: 'import', imports})
	)],
	[3, parseMap(parseVector(parseUnsigned), typeIndices =>
		({type: 'function', typeIndices})
	)],
	[4, parseMap(parseVector(parseTableType), tables =>
		({type: 'table', tables})
	)],
	[5, parseMap(parseVector(parseLimits), memories =>
		({type: 'memory', memories})
	)],
	[6, parseMap(
		parseVector(
			parseAndThen(parseGlobalType, type =>
				parseMap(parseBody, initializer => ({type, initializer}))
			)
		),
		globals => ({type: 'global', globals})
	)],
	[7, parseMap(parseVector(parseExport), exports =>
		({type: 'export', exports})
	)],
	[8, parseMap(parseUnsigned, functionIndex =>
		({type: 'start', functionIndex})
	)],
	[9, parseMap(parseVector(parseTableInitializer), initializers =>
		({type: 'element', initializers})
	)],
	[10, parseMap(parseVector(parseCodeSegment), segments =>
		({type: 'code', segments})
	)],
	[11, parseMap(parseVector(parseMemoryInitializer), initializers =>
		({type: 'data', initializers})
	)]
]
for (const [id, parser] of opcodeParsers) {
	sectionParsers.set(id, parseIgnore(parseUnsigned, parser))
}
const parseSection = parseByOpcode(sectionParsers)
const parseMagic: Parser<void> = data => {
	if (data.getUint32(0) !== 0x0061736D) throw new Error('Invalid magic bytes')
	return {value: undefined, length: 4}
}
const parseVersion: Parser<number> = data =>
	({value: data.getUint32(0, true), length: 4})
export const parseModule = parseIgnore(parseMagic,
	parseIgnore(
		parseMap(parseVersion, version => {
			if (version !== VERSION) throw new Error(`Unsupported version ${version}`)
			return
		}),
		parseUntil(parseSection, parseEnd)
	)
)