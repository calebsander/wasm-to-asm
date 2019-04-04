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