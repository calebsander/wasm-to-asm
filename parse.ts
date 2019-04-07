const slice = ({buffer, byteOffset}: DataView, offset: number) =>
	new DataView(buffer, byteOffset + offset)

export interface ParseResult<A> {
	value: A
	length: number
}
export type Parser<A> = (data: DataView) => ParseResult<A>

export const parseReturn = <A>(value: A): Parser<A> =>
	_ => ({value, length: 0})
export const parseAndThen =
	<A, B>(parser: Parser<A>, f: (a: A) => Parser<B>): Parser<B> => data => {
		const {value: a, length} = parser(data)
		const {value, length: length2} = f(a)(slice(data, length))
		return {value, length: length + length2}
	}
export const parseMap = <A, B>(parser: Parser<A>, f: (a: A) => B) =>
	parseAndThen(parser, a => parseReturn(f(a)))
export const parseIgnore = <A>(parser1: Parser<any>, parser2: Parser<A>) =>
	parseAndThen(parser1, _ => parser2)
export const parseByte: Parser<number> =
	data => ({value: data.getUint8(0), length: 1})
export const parseExact = (byte: number) =>
	parseMap(parseByte, readByte => {
		if (readByte !== byte) throw new Error('Mismatched bytes')
	})
export const parseChoice = <A>(parsers: Parser<A>[]): Parser<A> => data => {
	for (const parser of parsers) {
		try { return parser(data) }
		catch {}
	}
	throw new Error('No parser succeeded')
}
export const parseEnd: Parser<void> = ({byteLength}) => {
	if (byteLength) throw new Error(`Buffer still has ${byteLength} bytes`)
	return {value: undefined, length: 0}
}
// These parse functions are implemented iteratively for efficiency,
// and because V8 only allows a stack height of ~10,000
const parseTimes = <A>(parser: Parser<A>) => (times: number): Parser<A[]> =>
	data => {
		const arr = new Array<A>(times)
		let offset = 0
		for (let i = 0; i < times; i++) {
			const {value, length} = parser(slice(data, offset))
			arr[i] = value
			offset += length
		}
		return {value: arr, length: offset}
	}
export const parseWhile = <A>(parser: Parser<A>): Parser<A[]> => data => {
	const arr: A[] = []
	let offset = 0
	while (true) {
		try {
			const {value, length} = parser(slice(data, offset))
			arr.push(value)
			offset += length
		}
		catch { break }
	}
	return {value: arr, length: offset}
}
export const parseUntil = <A>(parser: Parser<A>, end: Parser<any>) =>
	parseAndThen(parseWhile(parser), result =>
		parseIgnore(end, parseReturn(result))
	)

export const parseByOpcode = <A>(parsers: Map<number, Parser<A>>) =>
	parseAndThen(parseByte, opcode => {
		const parser = parsers.get(opcode)
		if (!parser) throw new Error(`Unexpected opcode ${opcode}`)
		return parser
	})
export const parseUnsigned: Parser<number> = parseAndThen(parseByte, n =>
	n & 0b10000000
		? parseMap(parseUnsigned, m => (m << 7 | (n & 0b01111111)) >>> 0)
		: parseReturn(n)
)
export const parseVector = <A>(parser: Parser<A>) =>
	parseAndThen(parseUnsigned, parseTimes(parser))