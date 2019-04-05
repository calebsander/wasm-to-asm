#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "trig.h"

#define SIN_TOLERANCE 7e-16
#define COS_TOLERANCE (2 * SIN_TOLERANCE)

int main() {
	wasm_trig_init_module();
	for (double x = -10.0; x <= 10.0; x += 1e-4) {
		assert(fabs(wasm_trig_sin(x) - sin(x)) < SIN_TOLERANCE);
		assert(fabs(wasm_trig_cos(x) - cos(x)) < COS_TOLERANCE);
	}
	printf("success");
}