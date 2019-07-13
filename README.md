# wasm-to-asm

[![Build Status](https://travis-ci.org/calebsander/wasm-to-asm.svg?branch=master)](https://travis-ci.org/calebsander/wasm-to-asm)

This project compiles [WebAssembly](https://webassembly.org) modules to x86_64 assembly code.
This allows WebAssembly code to be linked with C, C++, assembly, Rust or any other language that supports the [SysV ABI calling convention](https://wiki.osdev.org/System_V_ABI#x86-64).

## Example

Condier the following WebAssembly module to compute Fibonacci numbers:
```lisp
(module
  (func (export "fib") (param $n i32) (result i64)
    (local $prevPrev i64)
    (local $prev i64)
    (set_local $prevPrev (i64.const 1))
    (loop $computeNext
      (if (get_local $n) (then
        (i64.add (get_local $prevPrev) (get_local $prev))
        (set_local $prevPrev (get_local $prev))
        (set_local $prev)
        (set_local $n (i32.sub (get_local $n) (i32.const 1)))
        (br $computeNext)
      ))
    )
    (get_local $prev)
  )
)
```
It exports a function `fib` which takes an 32-bit integer `n` and returns the 64-bit integer storing the `n`th Fibonacci number.
We can convert this `.wast` (WebAssembly text) file to a `.wasm` (WebAssembly binary) file using [`wat2wasm`](https://github.com/WebAssembly/wabt).
We can then use this project to compile the `.wasm` file to x86_64 assembly:
```bash
npm i
npm run build
node main fib.wasm
```
This creates a `fib.s` assembly file and a `fib.h` C header file:
```asm
MODULE0_FUNC0:
  push %rsi
  push %r8
  push %r9
  push %r10
  mov $0, %rsi
  mov $0, %r8
  # {"type":"i64.const","value":"1"}
  mov $1, %r9
  # {"type":"set_local","local":1}
  mov %r9, %rsi
  # {"type":"loop","returns":"empty","instructions":[...]}
  MODULE0_FUNC0_LOOP1:
  # {"type":"get_local","local":0}
  mov %rdi, %r9
  # {"type":"if","returns":"empty","ifInstructions":[...],"elseInstructions":[]}
  test %r9d, %r9d
  je MODULE0_FUNC0_IF_END2
  # {"type":"get_local","local":1}
  mov %rsi, %r9
  # {"type":"get_local","local":2}
  mov %r8, %r10
  # {"type":"i64.add"}
  add %r10, %r9
  # {"type":"get_local","local":2}
  mov %r8, %r10
  # {"type":"set_local","local":1}
  mov %r10, %rsi
  # {"type":"set_local","local":2}
  mov %r9, %r8
  # {"type":"get_local","local":0}
  mov %rdi, %r9
  # {"type":"i32.const","value":1}
  mov $1, %r10d
  # {"type":"i32.sub"}
  sub %r10d, %r9d
  # {"type":"set_local","local":0}
  mov %r9, %rdi
  # {"type":"br","label":1}
  jmp MODULE0_FUNC0_LOOP1
  MODULE0_FUNC0_IF_END2:
  # {"type":"get_local","local":2}
  mov %r8, %r9
  MODULE0_RETURN0:
  mov %r9, %rax
  pop %r10
  pop %r9
  pop %r8
  pop %rsi
  ret
.globl wasm_fib_fib
wasm_fib_fib:
  jmp MODULE0_FUNC0
```
```c
long wasm_fib_fib(int);
```
We can now call this `wasm_fib_fib()` function from C code:
```c
#include <stdio.h>
#include "fib.h"

int main() {
  for (int i = 0; i <= 93; i++) { // fib(94) doesn't fit in 64 bits
    printf("%d: %lu\n", i, wasm_fib_fib(i));
  }
}
```
We can simply compile against the assembly code and run the executable:
```bash
$ gcc fib.s fib.c -o fib
$ ./fib
0: 0
1: 1
2: 1
3: 2
4: 3
5: 5
6: 8
7: 13
8: 21
9: 34
10: 55
...
91: 4660046610375530309
92: 7540113804746346429
93: 12200160415121876738
```
Pretty nifty!

## Compatibility

The assembly code produced should be compatible with any AT&T-syntax assembler for x86_64, such as [gas](https://en.wikipedia.org/wiki/GNU_Assembler).
Currently, `unreachable` and the linear growable memory are implemented with Linux system calls, so WebAssembly code using these features will only work on Linux.
To call WebAssembly functions from C or similar languages, the compiler must use the SysV ABI calling convention.

## TODO

There are several features that aren't supported yet:
- Linking multiple WebAssembly modules to each other
- Functions taking more than 12 int params or 13 float params
- Runtime traps (out-of-bounds memory access, division by 0, etc.)
- Optimizations for multiple-instruction sequences (e.g. incrementing a local)
- Support for `mmap()` syscalls on Mac OS

## Calling convention

The calling convention is similar to SysV ABI but doesn't have any caller-save registers.

### Use of registers

#### `i32`/`i64` registers
`%rax`, `%rcx`, and `%rdx` are used to store integer intermediates, e.g. when moving values between locations in memory.
(These registers were chosen because bitshift instructions (`shl`, `ror`, etc.) and division instructions (`div` and `idiv`) require an operand to be stored in them. Also, `%rax` is needed to store integer return values.)
The rest of the general-purpose registers (`%rdi`, `%rsi`, `%r8` to `%r15`, `%rbx`, and `%rbp`) are used to store local variables and the bottom of the integer computation stack.

#### `f32`/`f64` registers
Floats are stored individually in the lower 32 or 64 bits of the SIMD registers.
`%xmm0`, `%xmm1`, and `%xmm15` are used to store intermediate values for float computations.
(`%xmm0` was chosen because float return values are placed there. `%xmm15` was chosen because it is not used for function arguments in SysV, so params can be temporarily placed there while being moved between registers.)
Registers `%xmm2` to `%xmm14` are used to store local variables and the bottom of the float computation stack.

#### Example
Consider a function with the following local variables:
- `(param $f f64) (param $i i32)`
- `(local $i1 i64) ($local $i2 i32) (local $f1 f32)`

The register usage will be:
- Integer: `$i` in `%edi`, `$i1` in `%rsi`, and `$i2` in `%r8d`. The stack will be stored in `%r9` through `%r15`, `%rbx`, `%rbp`, and then `(%rsp)`.
- Float: `$f` in `%xmm2` and `$f1` in `%xmm3`. The stack will be stored in `%xmm4` through `%xmm14`, and then `(%rsp)`.

### Caller-callee handoff

The caller first sets up the param registers for the callee, saving any that were in use onto the stack.
The caller then invokes the `call` instruction to push `%rip` to the stack.
The callee pushes all registers it will modify, does its work, and then restores those registers.
If the callee returns a value, it is placed in `%rax` if it is an integer and `%xmm0` if it is a float.
The callee invokes the `ret` instruction to return control to the caller.
Finally, the caller restores any registers it saved to the stack and moves the return value onto the computation stack.