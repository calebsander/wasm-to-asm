#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <openssl/sha.h>
#include "sha256.h"

unsigned char *wasm_SHA256(unsigned char *data, unsigned length) {
	wasm_sha256_fitInput(length);
	memcpy(wasm_sha256_memory_memory + wasm_sha256_INPUT_START, data, length);
	wasm_sha256_sha256(length);
	return wasm_sha256_memory_memory;
}

void verify_hash(unsigned length) {
	unsigned char *data = malloc(length);
	memset(data, 'a', length);
	unsigned char *hash = SHA256(data, length, NULL);
	unsigned char *wasm_hash = wasm_SHA256(data, length);
	free(data);
	for (unsigned i = 0; i < SHA256_DIGEST_LENGTH; i++) {
		assert(hash[i] == wasm_hash[i]);
	}
}

int main() {
	wasm_sha256_init_module();
	for (unsigned length = 0; length < 1 << 12; length++) verify_hash(length);
	verify_hash(1 << 24);
	printf("success");
}