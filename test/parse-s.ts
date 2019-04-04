const WHITESPACE = /\s/

export type SExpression
	= {type: 'atom', atom: string}
	| {type: 'list', items: SExpression[]}
export interface ParseResult<T> {
	result: T
	rest: string
}

function parseSpace(text: string): string {
	let i = 0
	while (true) {
		if (text[i] === ';') {
			while (text[++i] !== '\n');
		}
		else if (!WHITESPACE.test(text[i])) break
		i++
	}
	return text.slice(i)
}
function parseAtom(text: string): ParseResult<SExpression> {
	let i = 1
	if (text[0] === '"') {
		while (text[i++] !== '"') {
			if (text[i] === '\\') i++ // skip escaped character
		}
	}
	else {
		while (!(text[i] === ')' || text[i] === ';' || WHITESPACE.test(text[i]))) i++
	}
	return {result: {type: 'atom', atom: text.slice(0, i)},rest: text.slice(i)}
}
function parseList(text: string): ParseResult<SExpression> {
	const items: SExpression[] = []
	while (true) {
		text = parseSpace(text)
		if (text[0] === ')') break

		const {result, rest} = parse(text)
		items.push(result)
		text = rest
	}
	return {result: {type: 'list', items}, rest: text.slice(1)}
}
export function parse(text: string): ParseResult<SExpression> {
	text = parseSpace(text)
	return text[0] === '(' ? parseList(text.slice(1)) : parseAtom(text)
}