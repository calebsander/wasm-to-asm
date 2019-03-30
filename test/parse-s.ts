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
	let i = 0
	if (text.slice(0, 2) == ';;') {
		for (i = 2; text[i] !== '\n'; i++);
		while (WHITESPACE.test(text[++i]));
	}

	if (text[i] === '(') {
		while (WHITESPACE.test(text[++i]));
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
	if (text[i] === '"') {
		while (text[++i] !== '"') {
			if (text[i] === '\\') i++ // skip escaped character
		}
		i++
	}
	else {
		while (!(text[++i] === ')' || WHITESPACE.test(text[i])));
	}
	return {result: {op: text.slice(0, i), args: []}, rest: text.slice(i)}
}