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

abstract class FullRegisterInstruction {
	constructor(readonly register: Register) {}
	get registerStr() {
		return datumToString({type: 'register', register: this.register})
	}
}
export class Label implements AssemblyInstruction {
	constructor(readonly label: string) {}
	get str() { return this.label + ':' }
}
export class AddInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `add ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class AndInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `and ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class CallInstruction implements AssemblyInstruction {
	constructor(readonly target: Datum) {}
	get str() { return `call ${datumToString(this.target)}` }
}
export class CMoveInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum, readonly cond: JumpCond) {}
	get str() {
		return `cmov${this.cond} ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class CmpInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `cmp ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class DecInstruction implements AssemblyInstruction {
	constructor(readonly target: Datum) {}
	get str() { return `dec ${datumToString(this.target)}` }
}
export class IncInstruction implements AssemblyInstruction {
	constructor(readonly target: Datum) {}
	get str() { return `inc ${datumToString(this.target)}` }
}
export class JumpInstruction implements AssemblyInstruction {
	constructor(readonly target: Datum, readonly cond?: JumpCond) {}
	get str() { return `j${this.cond || 'mp'} ${datumToString(this.target)}` }
}
export class MoveInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `mov ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class MoveExtendInstruction implements AssemblyInstruction {
	constructor(
		readonly src: Datum,
		readonly dest: Datum,
		readonly srcWidth: Width,
		readonly destWidth: Width,
		readonly signed: boolean
	) {}
	get str() {
		return `mov${this.signed ? 's' : 'z'}${this.srcWidth}${this.destWidth} ` +
			`${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class OrInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `or ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class PopInstruction extends FullRegisterInstruction implements AssemblyInstruction {
	get str() { return `pop ${this.registerStr}` }
}
export class PushInstruction extends FullRegisterInstruction implements AssemblyInstruction {
	get str() { return `push ${this.registerStr}` }
}
export class RetInstruction implements AssemblyInstruction {
	get str() { return 'ret' }
}
export class RorInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `ror ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class SetInstruction implements AssemblyInstruction {
	constructor(readonly dest: Datum, readonly cond: JumpCond) {}
	get str() { return `set${this.cond} ${datumToString(this.dest)}` }
}
export class ShlInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `shl ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class ShrInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `shr ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class SubInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `sub ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
export class SysCallInstruction implements AssemblyInstruction {
	get str() { return 'syscall' }
}
export class TestInstruction implements AssemblyInstruction {
	constructor(readonly op1: Datum, readonly op2: Datum) {}
	get str() {
		return `test ${datumToString(this.op1)}, ${datumToString(this.op2)}`
	}
}
export class XorInstruction implements AssemblyInstruction {
	constructor(readonly src: Datum, readonly dest: Datum) {}
	get str() {
		return `xor ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}

export const SYSCALL = {
	exit: 60,
	mmap: 9
}