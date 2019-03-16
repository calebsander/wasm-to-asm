import {ResultType} from './parse-instruction'

type CType = 'void' | 'int' | 'long' | 'float' | 'double'

export function getCType(type: ResultType): CType {
	switch (type) {
		case 'empty': return 'void'
		case 'i32': return 'int'
		case 'i64': return 'long'
		case 'f32': return 'float'
		case 'f64': return 'double'
	}
}

export class HeaderDeclaration {
	constructor(
		readonly returnType: CType,
		readonly name: string,
		readonly argTypes: CType[]
	) {}

	get str() {
		return `${this.returnType} ${this.name}(${this.argTypes.join(', ')});`
	}
}