import {ResultType} from '../parse/instruction'

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

export interface HeaderDeclaration {
	readonly str: string
}
export class GlobalDeclaration {
	constructor(
		readonly type: CType | 'pointer',
		readonly constant: boolean,
		readonly name: string
	) {}

	get str() {
		const pointer = this.type === 'pointer'
		const constAttribute = this.constant ? 'const ' : ''
		return pointer
			? `void * ${constAttribute}${this.name};`
			: `${constAttribute}${this.type} ${this.name};`
	}
}
export class FunctionDeclaration {
	constructor(
		readonly returnType: CType,
		readonly name: string,
		readonly argTypes: CType[]
	) {}

	get str() {
		return `${this.returnType} ${this.name}(${this.argTypes.join(', ')});`
	}
}