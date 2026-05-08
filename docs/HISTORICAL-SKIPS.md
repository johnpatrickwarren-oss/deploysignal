# Historical test skips (preserved rationale)

## family-c-coship-ville: safe-Hotelling fire-horizon parity (REPLY-43d)

Test was originally drafted to assert "safe-Hotelling fire-horizon
within ±5 ticks of chi_square on moderate 2-dim drift." Test lived
in test/family-c-coship-ville.test.ts as it.skip() until reviewer-09
cleanup (2026-04-29).

Rationale for permanent removal: per ARCHITECT-REPLY-43d, e-process
wealth accumulation and chi_square single-tick threshold-crossing
have fundamentally different fire-time distributions by construction;
expecting tick-level parity is a category error. Tolerance was
removed from acceptance as wrong-framed comparison; tick-parity will
not be re-asserted.

Removal preserves no-skip policy on statistical-invariant tests
(feedback_no_skip_test_policy).
