(module
	(func $helper
		(param $index i32)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(result i32)

		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
		(block
			(block
				(br_table 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 (local.get $index))
			)
		(return (local.get 1)))
		(return (i32.trunc_f32_u (local.get 2))))
		(return (i32.wrap_i64 (local.get 3))))
		(return (i32.trunc_f64_u (local.get 4))))
		(return (local.get 5)))
		(return (i32.trunc_f32_u (local.get 6))))
		(return (i32.wrap_i64 (local.get 7))))
		(return (i32.trunc_f64_u (local.get 8))))
		(return (local.get 9)))
		(return (i32.trunc_f32_u (local.get 10))))
		(return (i32.wrap_i64 (local.get 11))))
		(return (i32.trunc_f64_u (local.get 12))))
		(return (local.get 13)))
		(return (i32.trunc_f32_u (local.get 14))))
		(return (i32.wrap_i64 (local.get 15))))
		(return (i32.trunc_f64_u (local.get 16))))
		(return (local.get 17)))
		(return (i32.trunc_f32_u (local.get 18))))
		(return (i32.wrap_i64 (local.get 19))))
		(return (i32.trunc_f64_u (local.get 20))))
		(return (local.get 21)))
		(return (i32.trunc_f32_u (local.get 22))))
		(return (i32.wrap_i64 (local.get 23))))
		(return (i32.trunc_f64_u (local.get 24))))
		(return (local.get 25)))
		(return (i32.trunc_f32_u (local.get 26))))
		(return (i32.wrap_i64 (local.get 27))))
		(return (i32.trunc_f64_u (local.get 28))))
		(return (local.get 29)))
		(return (i32.trunc_f32_u (local.get 30))))
		(return (i32.wrap_i64 (local.get 31))))
		(return (i32.trunc_f64_u (local.get 32))))
		unreachable
	)
	(func (export "select_param")
		(param $index i32)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(param i32)
		(param f32)
		(param i64)
		(param f64)
		(result i32)

		(local $i32_sum i32)
		(local $f32_sum f32)
		(local $i64_sum i64)
		(local $f64_sum f64)

		(local.set $i32_sum
			(i32.add
				(i32.add
					(i32.add
						(i32.add
							(i32.add
								(i32.add
									(i32.add
										(local.get 1)
										(local.get 5)
									)
									(local.get 9)
								)
								(local.get 13)
							)
							(local.get 17)
						)
						(local.get 21)
					)
					(local.get 25)
				)
				(local.get 29)
			)
		)
		(local.set $f32_sum
			(f32.add
				(f32.add
					(f32.add
						(f32.add
							(f32.add
								(f32.add
									(f32.add
										(local.get 2)
										(local.get 6)
									)
									(local.get 10)
								)
								(local.get 14)
							)
							(local.get 18)
						)
						(local.get 22)
					)
					(local.get 26)
				)
				(local.get 30)
			)
		)
		(local.set $i64_sum
			(i64.add
				(i64.add
					(i64.add
						(i64.add
							(i64.add
								(i64.add
									(i64.add
										(local.get 3)
										(local.get 7)
									)
									(local.get 11)
								)
								(local.get 15)
							)
							(local.get 19)
						)
						(local.get 23)
					)
					(local.get 27)
				)
				(local.get 31)
			)
		)
		(local.set $f64_sum
			(f64.add
				(f64.add
					(f64.add
						(f64.add
							(f64.add
								(f64.add
									(f64.add
										(local.get 4)
										(local.get 8)
									)
									(local.get 12)
								)
								(local.get 16)
							)
							(local.get 20)
						)
						(local.get 24)
					)
					(local.get 28)
				)
				(local.get 32)
			)
		)
		(i32.add
			(call $helper
				(local.get $index)
				(local.get 1)
				(local.get 2)
				(local.get 3)
				(local.get 4)
				(local.get 5)
				(local.get 6)
				(local.get 7)
				(local.get 8)
				(local.get 9)
				(local.get 10)
				(local.get 11)
				(local.get 12)
				(local.get 13)
				(local.get 14)
				(local.get 15)
				(local.get 16)
				(local.get 17)
				(local.get 18)
				(local.get 19)
				(local.get 20)
				(local.get 21)
				(local.get 22)
				(local.get 23)
				(local.get 24)
				(local.get 25)
				(local.get 26)
				(local.get 27)
				(local.get 28)
				(local.get 29)
				(local.get 30)
				(local.get 31)
				(local.get 32)
			)
			(i32.mul
				(i32.mul
					(i32.mul
						(local.get $i32_sum)
						(i32.trunc_f32_u (local.get $f32_sum))
					)
					(i32.wrap_i64 (local.get $i64_sum))
				)
				(i32.trunc_f64_u (local.get $f64_sum))
			)
		)
	)
)
