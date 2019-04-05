;; Copied from https://github.com/calebsander/structure-bytes/blob/master/lib/sha256.wast
(module
	;; Memory layout:
	;; 0 - 255: w; once hash has been computed, 0 - 31 is replaced with the result
	;; 256 - 511: K
	;; 512 - : buf to be hashed
	(global $K i32 (i32.const 256))
	(global $INPUT_START (export "INPUT_START") i32 (i32.const 512))
	(memory (export "memory") 1)
	(data (i32.const 256) "\98\2f\8a\42\91\44\37\71\cf\fb\c0\b5\a5\db\b5\e9\5b\c2\56\39\f1\11\f1\59\a4\82\3f\92\d5\5e\1c\ab\98\aa\07\d8\01\5b\83\12\be\85\31\24\c3\7d\0c\55\74\5d\be\72\fe\b1\de\80\a7\06\dc\9b\74\f1\9b\c1\c1\69\9b\e4\86\47\be\ef\c6\9d\c1\0f\cc\a1\0c\24\6f\2c\e9\2d\aa\84\74\4a\dc\a9\b0\5c\da\88\f9\76\52\51\3e\98\6d\c6\31\a8\c8\27\03\b0\c7\7f\59\bf\f3\0b\e0\c6\47\91\a7\d5\51\63\ca\06\67\29\29\14\85\0a\b7\27\38\21\1b\2e\fc\6d\2c\4d\13\0d\38\53\54\73\0a\65\bb\0a\6a\76\2e\c9\c2\81\85\2c\72\92\a1\e8\bf\a2\4b\66\1a\a8\70\8b\4b\c2\a3\51\6c\c7\19\e8\92\d1\24\06\99\d6\85\35\0e\f4\70\a0\6a\10\16\c1\a4\19\08\6c\37\1e\4c\77\48\27\b5\bc\b0\34\b3\0c\1c\39\4a\aa\d8\4e\4f\ca\9c\5b\f3\6f\2e\68\ee\82\8f\74\6f\63\a5\78\14\78\c8\84\08\02\c7\8c\fa\ff\be\90\eb\6c\50\a4\f7\a3\f9\be\f2\78\71\c6")
	(func $load32BE (param $loc i32) (result i32)
		(i32.or
			(i32.or
				(i32.shl (i32.load8_u (get_local $loc)) (i32.const 24))
				(i32.shl (i32.load8_u offset=1 (get_local $loc)) (i32.const 16))
			)
			(i32.or
				(i32.shl (i32.load8_u offset=2 (get_local $loc)) (i32.const 8))
				(i32.load8_u offset=3 (get_local $loc))
			)
		)
	)
	(func $store32BE (param $loc i32) (param $val i32)
		(i32.store8 offset=0 (get_local $loc) (i32.shr_u (get_local $val) (i32.const 24)))
		(i32.store8 offset=1 (get_local $loc) (i32.shr_u (get_local $val) (i32.const 16)))
		(i32.store8 offset=2 (get_local $loc) (i32.shr_u (get_local $val) (i32.const 8)))
		(i32.store8 offset=3 (get_local $loc) (get_local $val))
	)
	(func $store64BE (param $loc i32) (param $val i64)
		(call $store32BE ;; store32BE(loc, val >>> 32)
			(get_local $loc)
			(i32.wrap/i64 (i64.shr_u (get_local $val) (i64.const 32)))
		)
		(call $store32BE ;; store32BE(loc + 4, val)
			(i32.add (get_local $loc) (i32.const 4))
			(i32.wrap/i64 (get_local $val))
		)
	)
	(func (export "fitInput") (param $byteLength i32)
		(local $needed i32)
		(set_local $needed ;; needed = INPUT_START + byteLength + 63
			;; Could use up to 63 extra bytes
			(i32.add (get_local $byteLength) (i32.const 575)) ;; INPUT_START + 63 == 575
		)
		(if ;; if (needed > 0) memory.grow(needed)
			(i32.gt_s
				(tee_local $needed ;; needed = (needed >> 16) + !!(needed % (1 << 16)) - memory.size
					(i32.sub
						(i32.add
							(i32.shr_u (get_local $needed) (i32.const 16))
							(i32.ne (i32.and (get_local $needed) (i32.const 0xffff)) (i32.const 0))
						)
						(current_memory)
					)
				)
				(i32.const 0)
			)
			(drop (grow_memory (get_local $needed)))
		)
	)
	(func (export "sha256") (param $byteLength i32)
		(local $messageLength i32)
		(local $i i32) (local $i4 i32)
		(local $temp1 i32) (local $temp2 i32)
		(local $a i32) (local $b i32) (local $c i32) (local $d i32)
			(local $e i32) (local $f i32) (local $g i32) (local $h i32)
		(local $chunkOrLengthStart i32) ;; used for both chunkStart and lengthStart
		(local $h0 i32) (local $h1 i32) (local $h2 i32) (local $h3 i32)
			(local $h4 i32) (local $h5 i32) (local $h6 i32) (local $h7 i32)
		(set_local $messageLength ;; messageLength = byteLength + extraBytes
			(i32.add
				;; byteLength
				(get_local $byteLength)
				;; extraBytes (== 72 - ((lBytes + 72) % 64))
				(i32.sub
					(i32.const 72)
					(i32.and
						(i32.add (get_local $byteLength) (i32.const 72))
						(i32.const 63)
					)
				)
			)
		)
		(set_local $i (get_local $byteLength))
		(i32.store8 offset=512 (get_local $i) (i32.const 128)) ;; buf[byteLength] = (i8)128
		(set_local $chunkOrLengthStart ;; lengthStart = messageLength - 8
			(i32.sub (get_local $messageLength) (i32.const 8))
		)
		;; for (i = byteLength + 1; i < lengthStart; i++)
		(loop $zeroBytes
			;; if (++i < lengthStart)
			(i32.lt_u
				(tee_local $i (i32.add (get_local $i) (i32.const 1)))
				(get_local $chunkOrLengthStart)
			)
			(if (then
				(i32.store8 offset=512 (get_local $i) (i32.const 0)) ;; buf[i] = 0
				(br $zeroBytes) ;; continue
			))
		)
		(call $store64BE ;; buf[lengthStart] = (i64)byteLength << 3
			(i32.add (get_global $INPUT_START) (get_local $chunkOrLengthStart))
			(i64.shl (i64.extend_u/i32 (get_local $byteLength)) (i64.const 3))
		)
		(set_local $h0 (i32.const 0x6a09e667))
		(set_local $h1 (i32.const 0xbb67ae85))
		(set_local $h2 (i32.const 0x3c6ef372))
		(set_local $h3 (i32.const 0xa54ff53a))
		(set_local $h4 (i32.const 0x510e527f))
		(set_local $h5 (i32.const 0x9b05688c))
		(set_local $h6 (i32.const 0x1f83d9ab))
		(set_local $h7 (i32.const 0x5be0cd19))
		;; for (chunkStart = 0; chunkStart < messageLength; chunkStart += 64)
		(set_local $chunkOrLengthStart (i32.const 0))
		(loop $chunkLoop
			;; for (i = 0; i < 16; i++)
			(set_local $i (i32.const 0))
			(loop $initializeW
				(set_local $i4 (i32.shl (get_local $i) (i32.const 2))) ;; i4 = i << 2
				(i32.store align=2 ;; w[i] = buf.slice(chunkStart)[i]
					(get_local $i4)
					(call $load32BE
						(i32.add
							(get_global $INPUT_START)
							(i32.add (get_local $chunkOrLengthStart) (get_local $i4))
						)
					)
				)
				(br_if $initializeW ;; if (++i < 16) continue
					(i32.lt_u
						(tee_local $i (i32.add (get_local $i) (i32.const 1)))
						(i32.const 16)
					)
				)
			)
			;; for (i = 16; i < 64; i++)
			(loop $extendW
				(set_local $i4 (i32.shl (get_local $i) (i32.const 2))) ;; i4 = i << 2
				(set_local $temp1 ;; temp1 = w[i - 15]
					(i32.load align=2 (i32.sub (get_local $i4) (i32.const 60)))
				)
				(set_local $temp2 ;; temp2 = w[i - 2]
					(i32.load align=2 (i32.sub (get_local $i4) (i32.const 8)))
				)
				(i32.store align=2 ;; w[i] = w[i - 16] + s0 + w[i - 7] + s1
					(get_local $i4)
					(i32.add
						(i32.add
							;; w[i - 16]
							(i32.load align=2 (i32.sub (get_local $i4) (i32.const 64)))
							;; s0 (== rotr(temp1, 7) ^ rotr(temp1, 18) ^ (temp1 >>> 3))
							(i32.xor
								(i32.rotr (get_local $temp1) (i32.const 7))
								(i32.xor
									(i32.rotr (get_local $temp1) (i32.const 18))
									(i32.shr_u (get_local $temp1) (i32.const 3))
								)
							)
						)
						(i32.add
							;; w[i - 7]
							(i32.load align=2 (i32.sub (get_local $i4) (i32.const 28)))
							;; s1 (== rotr(temp2, 17) ^ rotr(temp2, 19) ^ (temp2 >>> 10))
							(i32.xor
								(i32.rotr (get_local $temp2) (i32.const 17))
								(i32.xor
									(i32.rotr (get_local $temp2) (i32.const 19))
									(i32.shr_u (get_local $temp2) (i32.const 10))
								)
							)
						)
					)
				)
				(br_if $extendW ;; if (++i < 64) continue
					(i32.lt_u
						(tee_local $i (i32.add (get_local $i) (i32.const 1)))
						(i32.const 64)
					)
				)
			)
			(set_local $a (get_local $h0))
			(set_local $b (get_local $h1))
			(set_local $c (get_local $h2))
			(set_local $d (get_local $h3))
			(set_local $e (get_local $h4))
			(set_local $f (get_local $h5))
			(set_local $g (get_local $h6))
			(set_local $h (get_local $h7))
			;; for (i = 0; i < 64; i++)
			(set_local $i (i32.const 0))
			(loop $updateHash
				(set_local $i4 (i32.shl (get_local $i) (i32.const 2))) ;; i4 = i << 2
				(set_local $temp1 ;; temp1 = h + S1 + ch + K[i] + w[i]
					(i32.add
						(get_local $h)
						(i32.add
							(i32.add
								;; S1 (== rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25))
								(i32.xor
									(i32.rotr (get_local $e) (i32.const 6))
									(i32.xor
										(i32.rotr (get_local $e) (i32.const 11))
										(i32.rotr (get_local $e) (i32.const 25))
									)
								)
								;; ch (== (e & f) ^ (~e & g))
								(i32.xor
									(i32.and (get_local $e) (get_local $f))
									(i32.and
										(i32.xor (get_local $e) (i32.const -1)) ;; ~e
										(get_local $g)
									)
								)
							)
							(i32.add
								;; K[i]
								(i32.load align=2 (i32.add (get_global $K) (get_local $i4)))
								;; w[i]
								(i32.load align=2 (get_local $i4))
							)
						)
					)
				)
				(set_local $h (get_local $g)) ;; h = g
				(set_local $g (get_local $f)) ;; g = f
				(set_local $f (get_local $e)) ;; f = e
				(set_local $e (i32.add (get_local $d) (get_local $temp1))) ;; e = d + temp1
				(set_local $d (get_local $c)) ;; d = c
				(get_local $a) ;; preserve value of a
				(set_local $a ;; a = temp1 + temp2
					(i32.add
						(get_local $temp1)
						;; temp2 (== S0 + maj)
						(i32.add
							;; S0 (== rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22))
							(i32.xor
								(i32.rotr (get_local $a) (i32.const 2))
								(i32.xor
									(i32.rotr (get_local $a) (i32.const 13))
									(i32.rotr (get_local $a) (i32.const 22))
								)
							)
							;; maj (== (a & b) ^ (a & c) ^ (b & c))
							(i32.xor
								(i32.and (get_local $a) (get_local $b))
								(i32.xor
									(i32.and (get_local $a) (get_local $c))
									(i32.and (get_local $b) (get_local $c))
								)
							)
						)
					)
				)
				(set_local $c (get_local $b)) ;; c = b
				(set_local $b) ;; b = a
				(br_if $updateHash ;; if (++i < 64) continue
					(i32.lt_u
						(tee_local $i (i32.add (get_local $i) (i32.const 1)))
						(i32.const 64)
					)
				)
			)
			(set_local $h0 (i32.add (get_local $h0) (get_local $a))) ;; h0 += a
			(set_local $h1 (i32.add (get_local $h1) (get_local $b))) ;; h1 += b
			(set_local $h2 (i32.add (get_local $h2) (get_local $c))) ;; h2 += c
			(set_local $h3 (i32.add (get_local $h3) (get_local $d))) ;; h3 += d
			(set_local $h4 (i32.add (get_local $h4) (get_local $e))) ;; h4 += e
			(set_local $h5 (i32.add (get_local $h5) (get_local $f))) ;; h5 += f
			(set_local $h6 (i32.add (get_local $h6) (get_local $g))) ;; h6 += g
			(set_local $h7 (i32.add (get_local $h7) (get_local $h))) ;; h7 += h
			(br_if $chunkLoop ;; if ((chunkStart += 64) < messageLength) continue
				(i32.lt_u
					(tee_local $chunkOrLengthStart (i32.add (get_local $chunkOrLengthStart) (i32.const 64)))
					(get_local $messageLength)
				)
			)
		)
		;; Write out result
		(call $store32BE (i32.const  0) (get_local $h0))
		(call $store32BE (i32.const  4) (get_local $h1))
		(call $store32BE (i32.const  8) (get_local $h2))
		(call $store32BE (i32.const 12) (get_local $h3))
		(call $store32BE (i32.const 16) (get_local $h4))
		(call $store32BE (i32.const 20) (get_local $h5))
		(call $store32BE (i32.const 24) (get_local $h6))
		(call $store32BE (i32.const 28) (get_local $h7))
	)
)