(module
	(global $MAX_TERM i32 (i32.const 21))
	(global $HALF_PI f64 (f64.const 1.5707963267948966))
	(global $PI f64 (f64.const 3.141592653589793))
	(global $2PI f64 (f64.const 6.283185307179586))
	;; Computes a Maclaurin series approximation for sin(x) up to the x^MAX_TERM term
	(func $sin (export "sin") (param $x f64) (result f64)
		(local $sum f64)
		(local $pow i32)
		(local $term f64)
		;; sum = 0
		;; pow = 0
		;; Get x in range (-PI, +PI)
		(set_local $x (f64.sub (get_local $x) ;; x -= 2PI * floor((x + PI) / 2PI)
			(f64.mul
				(get_global $2PI)
				(f64.floor (f64.div
					(f64.add (get_local $x) (get_global $PI))
					(get_global $2PI)
				))
			)
		))
		;; Get x in range (-PI / 2, PI / 2)
		(if (f64.gt (f64.abs (get_local $x)) (get_global $HALF_PI)) (then ;; if (abs(x) > HALF_PI)
			(set_local $x (f64.sub ;; x = PI * sgn(x) - x
				(f64.copysign (get_global $PI) (get_local $x))
				(get_local $x)
			))
		))
		(set_local $term (get_local $x)) ;; term = x
		(set_local $x (f64.mul (get_local $x) (get_local $x))) ;; x *= x
		(loop $add_terms (result f64)
			;; sum += term
			(tee_local $sum (f64.add (get_local $sum) (get_local $term)))
			(if ;; if ((pow += 2) < MAX_TERM)
				(i32.le_u
					(tee_local $pow (i32.add (get_local $pow) (i32.const 2)))
					(get_global $MAX_TERM)
				)
				(then
					(set_local $term (f64.mul ;; term *= -x / ((f32) pow * (f32) (pow + 1))
						(get_local $term)
						(f64.div
							(f64.neg (get_local $x))
							(f64.mul
								(f64.convert_s/i32 (get_local $pow))
								(f64.convert_s/i32 (i32.add (get_local $pow) (i32.const 1)))
							)
						)
					))
					(br $add_terms) ;; continue
				)
			)
		)
		;; return sum
	)
	(func (export "cos") (param $x f64) (result f64)
		(call $sin (f64.add (get_local $x) (get_global $HALF_PI)))
	)
)