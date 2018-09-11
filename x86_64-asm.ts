export type Register
	= 'rax' | 'rbx' | 'rcx' | 'rdx'
	| 'rsp' | 'rbp'
	| 'rdi' | 'rsi'
	| 'r8' | 'r9' | 'r10' | 'r11' | 'r12' | 'r13' | 'r14' | 'r15'
const LETTER_REGISTERS = new Set<Register>(['rax', 'rbx', 'rcx', 'rdx'])
const X64_REGISTERS = new Set<Register>(['r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'])
export type Width = 'b' | 'w' | 'l' | 'q'
export interface Offset {
	register: Register
	scale: number
}
export type Datum
	= {type: 'register', register: Register, width?: Width}
	| {type: 'indirect', register: Register, immediate?: number | bigint, offset?: Offset}
	| {type: 'label', label: string}
	| {type: 'immediate', value: number | bigint}

export type JumpCond
	= 'e' | 'ne'
	| 'l' | 'g'
	| 'le' | 'ge'
	| 'a' | 'b'
	| 'ae' | 'be'

function registerToString(register: Register, width: Width = 'q') {
	switch (width) {
		case 'b':
			return X64_REGISTERS.has(register)
				? register + 'b'
				: (LETTER_REGISTERS.has(register) ? register[1] : register.slice(1)) + 'l'
		case 'w':
			return X64_REGISTERS.has(register)
				? register + 'w'
				: register.slice(1)
		case 'l':
			return X64_REGISTERS.has(register)
				? register + 'd'
				: 'e' + register.slice(1)
		case 'q':
		case undefined:
			return register
	}
}

function datumToString(datum: Datum): string {
	switch (datum.type) {
		case 'register': {
			const {register, width} = datum
			return '%' + registerToString(register, width)
		}
		case 'indirect': {
			const {register, immediate, offset} = datum
			let result = ''
			if (immediate) result += `${immediate}`
			result += '(%' + register
			if (offset) result += `, %${offset.register}, ${offset.scale}`
			return result + ')'
		}
		case 'label': return datum.label
		case 'immediate': return `$${datum.value}`
	}
}

export interface AssemblyInstruction {
	readonly str: string
}

abstract class SrcDestInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	abstract readonly op: string
	get str() {
		return `${this.op} ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
abstract class FullRegisterInstruction {
	constructor(readonly register: Register) {}
	get registerStr() {
		return datumToString({type: 'register', register: this.register})
	}
}
export class Label {
	constructor(readonly label: string) {}
	get str() { return this.label + ':' }
}
export class Comment {
	constructor(readonly comment: string) {}
	get str() { return '; ' + this.comment }
}
export class AddInstruction extends SrcDestInstruction {
	get op() { return 'add' }
}
export class AndInstruction extends SrcDestInstruction {
	get op() { return 'and' }
}
export class CallInstruction {
	constructor(readonly target: Datum) {}
	get str() { return `call ${datumToString(this.target)}` }
}
export class CMoveInstruction extends SrcDestInstruction {
	constructor(src: Datum, dest: Datum, readonly cond: JumpCond) {
		super(src, dest)
	}
	get op() { return 'cmov' + this.cond }
}
export class CmpInstruction extends SrcDestInstruction {
	get op() { return 'cmp' }
}
export class JumpInstruction {
	constructor(readonly target: Datum, readonly cond?: JumpCond) {}
	get str() { return `j${this.cond || 'mp'} ${datumToString(this.target)}` }
}
export class MoveInstruction extends SrcDestInstruction {
	get op() { return 'mov' }
}
export class MoveExtendInstruction extends SrcDestInstruction {
	constructor(
		src: Datum,
		dest: Datum,
		readonly srcWidth: Width,
		readonly destWidth: Width,
		readonly signed: boolean
	) {
		super(src, dest)
	}
	get op() {
		return `mov${this.signed ? 's' : 'z'}${this.srcWidth}${this.destWidth}`
	}
}
export class OrInstruction extends SrcDestInstruction {
	get op() { return 'or' }
}
export class PopInstruction extends FullRegisterInstruction {
	get str() { return `pop ${this.registerStr}` }
}
// TODO: allow pushing a Datum, not just a register
export class PushInstruction extends FullRegisterInstruction {
	get str() { return `push ${this.registerStr}` }
}
export class RetInstruction {
	get str() { return 'ret' }
}
export class RorInstruction extends SrcDestInstruction {
	get op() { return 'ror' }
}
export class SetInstruction {
	constructor(readonly dest: Datum, readonly cond: JumpCond) {}
	get str() { return `set${this.cond} ${datumToString(this.dest)}` }
}
export class ShlInstruction extends SrcDestInstruction {
	get op() { return 'shl' }
}
export class ShrInstruction extends SrcDestInstruction {
	get op() { return 'shr' }
}
export class SubInstruction extends SrcDestInstruction {
	get op() { return 'sub' }
}
export class SysCallInstruction {
	get str() { return 'syscall' }
}
export class TestInstruction extends SrcDestInstruction {
	get op() { return 'test' }
}
export class XorInstruction extends SrcDestInstruction {
	get op() { return 'xor' }
}

export const SYSCALL = {
	exit: 60,
	mmap: 9
}