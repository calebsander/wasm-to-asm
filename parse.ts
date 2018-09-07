export interface ParseResult<A> {
	value: A
	length: number
}
export type Parser<A> = (data: DataView) => ParseResult<A>

export const parseReturn = <A>(value: A): Parser<A> =>
	_ => ({value, length: 0})
export const parseAndThen = <A, B>(parser: Parser<A>, f: (a: A) => Parser<B>): Parser<B> =>
	data => {
		const {value: a, length} = parser(data)
		const {value, length: length2} = f(a)(slice(data, length))
		return {value, length: length + length2}
	}
export const parseMap = <A, B>(parser: Parser<A>, f: (a: A) => B) =>
	parseAndThen(parser, a => parseReturn(f(a)))
export const parseIgnore = <A>(parser1: Parser<any>, parser2: Parser<A>) =>
	parseAndThen(parser1, _ => parser2)
export const parseExact = (byte: number): Parser<void> => parseMap(
	parseByte,
	readByte => {
		if (readByte !== byte) {
			throw new Error('Mismatched bytes')
		}
	}
)
export const parseChoice = <A>(parsers: Parser<A>[]): Parser<A> =>
	data => {
		for (const parser of parsers) {
			try { return parser(data) }
			catch {}
		}
		throw new Error('No parser succeeded')
	}
const parseTimes = <A>(parser: Parser<A>) => (times: number): Parser<A[]> =>
	times
		? parseAndThen(
				parser,
				a => parseMap(
					parseTimes(parser)(times - 1),
					rest => [a, ...rest]
				)
			)
		: parseReturn([])

export const parseByte: Parser<number> =
	data => ({value: data.getUint8(0), length: 1})

export const parseUnsigned: Parser<number> = parseAndThen(
	parseByte,
	n =>
		n & 0b10000000
			? parseMap(
					parseUnsigned,
					m => (m << 7 | (n & 0b01111111)) >>> 0
				)
			: parseReturn(n)
)
export const parseVector = <A>(parser: Parser<A>) => parseAndThen(
	parseUnsigned,
	parseTimes(parser)
)

export const slice = (data: DataView, offset: number, length?: number) =>
	new DataView(data.buffer, data.byteOffset + offset, length)