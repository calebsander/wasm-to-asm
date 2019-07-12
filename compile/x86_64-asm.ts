import {STACK_TOP} from './conventions'
import {growStack, shrinkStack} from './helpers'

export type Register
	= 'rax' | 'rbx' | 'rcx' | 'rdx'
	| 'rsp' | 'rbp'
	| 'rdi' | 'rsi'
	| 'r8' | 'r9' | 'r10' | 'r11' | 'r12' | 'r13' | 'r14' | 'r15'
	| 'xmm0' | 'xmm1' | 'xmm2' | 'xmm3' | 'xmm4' | 'xmm5' | 'xmm6' | 'xmm7'
	| 'xmm8' | 'xmm9' | 'xmm10' | 'xmm11' | 'xmm12' | 'xmm13' | 'xmm14' | 'xmm15'
const LETTER_REGISTERS = new Set<Register>(['rax', 'rbx', 'rcx', 'rdx'])
const X64_REGISTERS = new Set<Register>(['r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'])
export type Width = 'b' | 'w' | 'l' | 'q' | 's' | 'd'
export interface Offset {
	register: Register
	scale?: number
}
export type Datum
	= {type: 'register', register: Register, width?: Width}
	| {type: 'indirect', register: Register, immediate?: number | bigint, offset?: Offset}
	| {type: 'label', label: string}
	| {type: 'immediate', value: number | bigint}
const FLOAT_WIDTHS = new Set<Width | undefined>(['s', 'd'])

export type JumpCond
	= 'e' | 'ne'
	| 'l' | 'g'
	| 'le' | 'ge'
	| 'a' | 'b'
	| 'ae' | 'be'
	| 'p' | 'np'
	| 's' | 'ns'

export type GASDirective
	= {type: 'text' | 'data', args?: void}
	| {type: 'globl', args: [string]}
	| {type: 'long' | 'quad', args: [number | string]}
	| {type: 'balign', args: [number]}
	| {type: 'section', args: ['.rodata']}

const isSIMDRegister = (register: Register) => register.startsWith('xmm')

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
		case 's':
		case 'd':
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
			let result = `${immediate || ''}`
			result += '(%' + register
			if (offset) {
				const {register, scale} = offset
				result += ', %' + register
				if (scale) result += `, ${scale}`
			}
			return result + ')'
		}
		case 'label': return datum.label + '(%rip)'
		case 'immediate': return `$${datum.value}`
	}
}

export interface AssemblyInstruction {
	readonly str: string
}

abstract class SrcDestInstruction {
	constructor(
		readonly src: Datum,
		readonly dest: Datum,
		readonly width?: Width
	) {}
	abstract readonly op: string
	get packed() { return false }
	get str() {
		const {src, dest, width, op} = this
		const simdExtension = FLOAT_WIDTHS.has(width)
			? this.packed ? 'p' : 's'
			: ''
		return `${op}${simdExtension}${width || ''} ${
			datumToString(src)
		}, ${datumToString(dest)}`
	}
}
abstract class FullRegisterInstruction {
	constructor(readonly register: Register) {}
	get registerStr() {
		return datumToString({type: 'register', register: this.register})
	}
}
abstract class JumpLikeInstruction {
	constructor(readonly target: string | Datum) {}
	abstract readonly op: string
	get str() {
		const {target} = this
		const targetString = typeof target === 'string'
			? target
			: '*' + datumToString(target)
		return this.op + ' ' + targetString
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
export class AndPackedInstruction extends AndInstruction {
	get packed() { return true }
}
export class AndNotPackedInstruction extends SrcDestInstruction {
	get op() { return 'andn' }
	get packed() { return true }
}
export class CallInstruction extends JumpLikeInstruction {
	get op() { return 'call' }
}
export class CdqoInstruction {
	get str() { return 'cdq' }
}
export class CqtoInstruction {
	get str() { return 'cqto' }
}
export class CMoveInstruction extends SrcDestInstruction {
	constructor(src: Datum, dest: Datum, readonly cond: JumpCond) {
		super(src, dest)
	}
	get op() { return 'cmov' + this.cond }
}
export class CmpInstruction extends SrcDestInstruction {
	get op() {
		return FLOAT_WIDTHS.has(this.width) ? 'ucomi' : 'cmp'
	}
}
export class CvtFloatInstruction extends SrcDestInstruction {
	constructor(
		src: Datum,
		dest: Datum,
		readonly srcWidth: Width,
		destWidth: Width
	) { super(src, dest, destWidth) }
	get op() { return `cvts${this.srcWidth}2` }
}
export class CvtToFloatInstruction extends SrcDestInstruction {
	get op() { return 'cvtsi2' }
}
export class CvtToIntInstruction extends SrcDestInstruction {
	constructor(src: Datum, dest: Datum, readonly srcWidth: Width) {
		super(src, dest)
	}
	get op() { return `cvtts${this.srcWidth}2si` }
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
export class DivBinaryInstruction extends SrcDestInstruction {
	get op() { return 'div' }
}
export class ImulInstruction extends SrcDestInstruction {
	get op() { return 'imul' }
}
export class JumpInstruction extends JumpLikeInstruction {
	constructor(target: string | Datum, readonly cond?: JumpCond) {
		super(target)
	}
	get op() { return `j${this.cond || 'mp'}` }
}
export class LeaInstruction extends SrcDestInstruction {
	get op() { return 'lea' }
}
export class LzcntInstruction extends SrcDestInstruction {
	get op() { return 'lzcnt' }
}
export class MaxInstruction extends SrcDestInstruction {
	get op() { return 'max' }
}
export class MinInstruction extends SrcDestInstruction {
	get op() { return 'min' }
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
export class MulInstruction extends SrcDestInstruction {
	get op() { return 'mul' }
}
export class NotInstruction {
	constructor(readonly datum: Datum) {}
	get str() { return 'not ' + datumToString(this.datum) }
}
export class OrInstruction extends SrcDestInstruction {
	get op() { return 'or' }
}
export class PopInstruction extends FullRegisterInstruction {
	get str() {
		if (isSIMDRegister(this.register)) {
			return new MoveInstruction(
				STACK_TOP, {type: 'register', register: this.register}, 'd'
			).str + '\n' + shrinkStack(1).str
		}
		else return 'pop ' + this.registerStr
	}
}
export class PopcntInstruction extends SrcDestInstruction {
	get op() { return 'popcnt' }
}
// TODO: allow pushing a Datum, not just a register
export class PushInstruction extends FullRegisterInstruction {
	get str() {
		if (isSIMDRegister(this.register)) {
			return growStack(1).str + '\n' + new MoveInstruction(
				{type: 'register', register: this.register}, STACK_TOP, 'd'
			).str
		}
		else return 'push ' + this.registerStr
	}
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
export class RoundInstruction extends SrcDestInstruction {
	constructor(mode: number, src: Datum, readonly target: Datum, width: Width) {
		super({type: 'immediate', value: mode}, src, width)
	}
	get op() { return 'round' }
	get str() { return `${super.str}, ${datumToString(this.target)}` }
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
export class SqrtInstruction extends SrcDestInstruction {
	get op() { return 'sqrt' }
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
export class XorPackedInstruction extends XorInstruction {
	get packed() { return true }
}