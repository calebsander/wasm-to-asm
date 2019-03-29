const WHITESPACE = /\s/

export interface SExpression {
	op: string
	args: SExpression[]
}
interface ParseResult {
	result: SExpression
	rest: string
}

export function parse(text: string): ParseResult {
	if (text[0] === '(') {
		let i = 1
		while (WHITESPACE.test(text[i])) i++
		const opStart = i
		while (!(text[i] === ')' || WHITESPACE.test(text[i]))) i++
		const op = text.slice(opStart, i)
		const args: SExpression[] = []
		text = text.slice(i)
		while (true) {
			i = 0
			while (WHITESPACE.test(text[i])) i++
			if (text[i] === ')') break

			const {result, rest} = parse(text.slice(i))
			args.push(result)
			text = rest
		}
		return {result: {op, args}, rest: text.slice(i + 1)}
	}
	let i = 1
	while (!(text[i] === ')' || WHITESPACE.test(text[i]))) i++
	return {result: {op: text.slice(0, i), args: []}, rest: text.slice(i)}
}