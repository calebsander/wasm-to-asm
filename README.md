# wasm-to-asm

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

## TODO

There are several features that aren't supported yet:
- `br_table` and `call_indirect` instructions
- Linking multiple WebAssembly modules to each other
- `start` functions in modules
- Functions taking more than 13 int params or 14 float params
- Stopping compilation at `unreachable` and `br` instructions

## Calling convention

The calling convention is similar to SysV ABI but doesn't have any caller-save registers.

### Use of registers

`rax`, `rcx`, and `rdx` are used to store intermediate values, e.g. when moving values between locations in memory and for the `select` instruction.
(These registers were chosen because bitshift instructions (`shl`, `ror`, etc.) and division instructions (`div` and `idiv`) require an operand to be stored in them.)
The rest of the general-purpose registers (`rdi`, `rsi`, `r8` to `r15`, `rbx`, and `rbp`) are used to store local variables and the bottom of the computation stack.
If the local variables or computation stack overflow the registers, the rest are stored on the stack and `rbp` is used as a base pointer instead of a general-purpose register.
This means that functions with few locals can have most of their computations performed on registers instead of the stack.

### Caller-callee handoff

The caller first sets up the param registers for the callee, saving any that it was using onto the stack.
The caller then invokes the `call` instruction to push `rip` to the stack.
The callee pushes all registers it will modify, does its work, and then restores those registers.
The callee places its return value in `rax` and invokes the `ret` instruction to return control to the caller.
Finally, the caller restores any registers it saved to the stack and moves the return value onto the computation stack.