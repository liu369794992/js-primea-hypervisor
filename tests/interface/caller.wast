;; starts with an caller of 5d48c1018904a172886829bbbd9c6f4a2d06c47b
(module
  (import "ethereum" "getCaller"  (func $caller (param i32)))
  (memory 1)
  (export "main" (func $main))
  (export "a" (memory 0))
  (func $main 
    (block
      ;; loads the caller into memory
      (call $caller (i32.const 0))
      (if (i64.eq (i64.load (i32.const 0)) (i64.const 0x72a1048901c1485d))
        (return)
      )
      (unreachable)
    )
  )
)
