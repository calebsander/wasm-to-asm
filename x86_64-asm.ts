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
	scale?: number
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

export type GASDirective
	= {type: 'text' | 'data', args?: void}
	| {type: 'globl', args: [string]}
	| {type: 'long' | 'quad', args: [number]}
	| {type: 'balign', args: [number]}

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
			if (offset) {
				result += ', %' + offset.register
				const {scale} = offset
				if (scale) result += `, ${scale}`
			}
			return result + ')'
		}
		case 'label': return `${datum.label}(%rip)`
		case 'immediate': return `$${datum.value}`
	}
}

export interface AssemblyInstruction {
	readonly str: string
}

abstract class SrcDestInstruction {
	constructor(readonly src: Datum, readonly dest: Datum, readonly width?: Width) {}
	abstract readonly op: string
	get str() {
		return `${this.op}${this.width || ''} ${datumToString(this.src)}, ${datumToString(this.dest)}`
	}
}
abstract class FullRegisterInstruction {
	constructor(readonly register: Register) {}
	get registerStr() {
		return datumToString({type: 'register', register: this.register})
	}
}
export class Directive {
	constructor(readonly directive: GASDirective) {}
	get str() {
		const {type, args} = this.directive
		return `.${type}${args ? ' ' + args.join(' ') : ''}`
	}
}
export class Label {
	constructor(readonly label: string) {}
	get str() { return this.label + ':' }
}
export class Comment {
	constructor(readonly comment: string) {}
	get str() { return '# ' + this.comment }
}
export class AddInstruction extends SrcDestInstruction {
	get op() { return 'add' }
}
export class AndInstruction extends SrcDestInstruction {
	get op() { return 'and' }
}
export class CallInstruction {
	constructor(readonly target: string) {}
	get str() { return 'call ' + this.target }
}
export class CdqInstruction {
	get str() { return 'cdq' }
}
export class CqoInstruction {
	get str() { return 'cqo' }
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
export class DivInstruction {
	constructor(
		readonly src: Datum,
		readonly signed: boolean,
		readonly width: Width
	) {}
	get str() {
		return `${this.signed ? 'i' : ''}div${this.width} ${datumToString(this.src)}`
	}
}
export class EnterInstruction {
	constructor(readonly frameSize: number) {}
	get str() { return `enter $${this.frameSize}, $0` }
}
export class JumpInstruction {
	constructor(readonly target: string, readonly cond?: JumpCond) {}
	get str() { return `j${this.cond || 'mp'} ${this.target}` }
}
export class LeaveInstruction {
	get str() { return 'leave' }
}
export class LzcntInstruction extends SrcDestInstruction {
	get op() { return 'lzcnt' }
}
export class MoveInstruction extends SrcDestInstruction {
	get op() { return 'mov' }
}
export class MoveExtendInstruction extends SrcDestInstruction {
	constructor(
		src: Datum,
		dest: Datum,
		readonly signed: boolean,
		readonly widths?: {src: Width, dest: Width}
	) { super(src, dest) }
	get op() {
		const movPrefix = `mov${this.signed ? 's' : 'z'}`
		if (this.widths) {
			const {src, dest} = this.widths
			return movPrefix + src + dest
		}
		return movPrefix + 'x'
	}
}
export class ImulInstruction extends SrcDestInstruction {
	get op() { return 'imul' }
}
export class OrInstruction extends SrcDestInstruction {
	get op() { return 'or' }
}
export class PopInstruction extends FullRegisterInstruction {
	get str() { return `pop ${this.registerStr}` }
}
export class PopcntInstruction extends SrcDestInstruction {
	get op() { return 'popcnt' }
}
// TODO: allow pushing a Datum, not just a register
export class PushInstruction extends FullRegisterInstruction {
	get str() { return `push ${this.registerStr}` }
}
export class RetInstruction {
	get str() { return 'ret' }
}
export class RolInstruction extends SrcDestInstruction {
	get op() { return 'rol' }
}
export class RorInstruction extends SrcDestInstruction {
	get op() { return 'ror' }
}
export class SarInstruction extends SrcDestInstruction {
	get op() { return 'sar' }
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
export class TzcntInstruction extends SrcDestInstruction {
	get op() { return 'tzcnt' }
}
export class XorInstruction extends SrcDestInstruction {
	get op() { return 'xor' }
}

export const SYSCALL = {
	exit: 60,
	mmap: 9
}