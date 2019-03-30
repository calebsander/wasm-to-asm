#include <stdio.h>
#include "fib.h"

int main() {
	for (int i = 0; i <= 93; i++) {
		printf("%d: %lu\n", i, wasm_fib_fib(i));
	}
}