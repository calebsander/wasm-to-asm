import {ValueType} from '../parse/value-type'
import {makeArray} from '../util'
import {Datum, Register, Width} from './x86_64-asm'

export const INT_INTERMEDIATE_REGISTERS: Register[] = ['rax', 'rcx', 'rdx']
export const [INT_RESULT_REGISTER] = INT_INTERMEDIATE_REGISTERS
export const INT_GENERAL_REGISTERS: Register[] = [
	'rdi', 'rsi',
	'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
	'rbx', 'rbp'
]
export const SHIFT_REGISTER: Register = 'rcx'
export const SHIFT_REGISTER_DATUM: Datum =
	{type: 'register', register: SHIFT_REGISTER}
export const SHIFT_REGISTER_BYTE: Datum = {...SHIFT_REGISTER_DATUM, width: 'b'}
export const DIV_LOWER_REGISTER: Register = 'rax'
export const DIV_LOWER_DATUM =
	{type: 'register' as const, register: DIV_LOWER_REGISTER}
const DIV_UPPER_REGISTER: Register = 'rdx'
export const DIV_UPPER_DATUM =
	{type: 'register' as const, register: DIV_UPPER_REGISTER}

export const FLOAT_INTERMEDIATE_REGISTERS: Register[] =
	['xmm0', 'xmm1', 'xmm15']
export const [FLOAT_RESULT_REGISTER] = FLOAT_INTERMEDIATE_REGISTERS
export const FLOAT_GENERAL_REGISTERS = makeArray(
	16 - FLOAT_INTERMEDIATE_REGISTERS.length,
	i => `xmm${i + 2}` as Register
)

export const getGeneralRegisters = (float: boolean): Register[] =>
	float ? FLOAT_GENERAL_REGISTERS : INT_GENERAL_REGISTERS
export const getIntermediateRegisters = (float: boolean): Register[] =>
	float ? FLOAT_INTERMEDIATE_REGISTERS : INT_INTERMEDIATE_REGISTERS
export const getResultRegister = (float: boolean): Register =>
	float ? FLOAT_RESULT_REGISTER : INT_RESULT_REGISTER

export const SYSV_INT_PARAM_REGISTERS: Register[] =
	['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9']
export const SYSV_FLOAT_PARAM_REGISTERS = makeArray(8, i => `xmm${i}` as Register)
export const SYSV_CALLEE_SAVE_REGISTERS: Register[] =
	['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15']
export const SYSV_CALLEE_SAVE_SET = new Set(SYSV_CALLEE_SAVE_REGISTERS)
// %rax and %xmm15 are not used for SysV params and are intermediate registers
export const SYSV_UNUSED_REGISTERS: Register[] = ['rax', 'xmm15']

export const STACK_TOP = {type: 'indirect' as const, register: 'rsp' as Register}

export const MMAP_SYSCALL_REGISTERS = new Set(
	new Array<Register>('rax', 'rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9', 'rcx', 'r11')
		.filter(register => INT_GENERAL_REGISTERS.includes(register))
)
export const SYSCALL_DATUM: Datum = {type: 'register', register: 'rax'},
	MMAP_ADDR_DATUM = {type: 'register' as const, register: 'rdi' as Register},
	MMAP_ADDR_INTERMEDIATE: Datum =
		{type: 'register', register: INT_INTERMEDIATE_REGISTERS[2]},
	MMAP_LENGTH_DATUM = {type: 'register' as const, register: 'rsi' as Register},
	MMAP_PROT_DATUM: Datum = {type: 'register', register: 'rdx'},
	MMAP_FLAGS_DATUM: Datum = {type: 'register', register: 'r10'},
	MMAP_FD_DATUM: Datum = {type: 'register', register: 'r8'},
	MMAP_OFFSET_DATUM: Datum = {type: 'register', register: 'r9'}
export const PAGE_BITS: Datum = {type: 'immediate', value: 16}
// PROT_READ | PROT_WRITE
export const PROT_READ_WRITE: Datum = {type: 'immediate', value: 0x1 | 0x2}
// MAP_SHARED | MAP_FIXED | MAP_ANONYMOUS
export const MMAP_FLAGS: Datum = {type: 'immediate', value: 0x01 | 0x10 | 0x20}

export const SYSCALL = {
	exit: 60,
	mmap: 9
}

export const INVALID_EXPORT_CHAR = /[^A-Za-z\d_]/g

export function typeWidth(type: ValueType): Width {
	switch (type) {
		case 'i32': return 'l'
		case 'i64': return 'q'
		case 'f32': return 's'
		case 'f64': return 'd'
	}
}
export const isFloat = (type: ValueType): boolean => type[0] === 'f'