# Comparator-Baseline Real-Trace Report (SECONDARY)

**SECONDARY per ENDPOINTS.md — real_trace_healthy_fp.** Secondary rows only (ENDPOINTS.md Open Question 4's deferred v8/v9 real-trace healthy-FP-only follow-up). threshold_tuned/canary_tuned parameters are REUSED verbatim from the pre-registered primary run (tuned_params_provenance below), restricted per substrate to the signals that substrate's own compiled config/manifest can resolve (never re-tuned against real-trace data). No injected regression profiles are run against these substrates — false_rollbacks is the only metric reported; escaped_regressions and detection_delay_ticks (the primary endpoints) do not apply here and are intentionally absent, not na/null.

Generated: 2026-07-17T17:08:09.938Z
Endpoints version: `v1` (sha256 `b3105daa20d254770c62c3b28b07ed9b62cada2c7ec5123e6bdb4eb69546397b`)
Engine: `0.6.1-pre`
Tuned params reused from: `runs/comparator-baseline/report-synthetic-v1.json` (sha256 `a7f39a054a405cf3b4709d47f1a7392130769dec1fba33f0e8cf2bdaaddb2de2`)
Window generation: `iid_bootstrap`, 131 windows, seed 42

**All substrates were skipped by the OQ-4 feasibility gate — see below.**

## Skipped substrates (OQ-4 feasibility gate)

| Substrate | Reason |
|---|---|
| `real-burstgpt-v1` | OQ-4 listPopulatedCells(baseline, 20) gate passed (48 populated cells), but every cell has zero rows with ALL baseline.manifest.signals defined — collectCellRows (the frozen bootstrapHealthyWindow dependency) cannot resolve a single row anywhere in this bundle, so the frozen window generator would throw unconditionally on every draw. This bundle likely carries real per-tick data for only a subset of the manifest's signals (the rest undefined at every tick) rather than full per-tick coverage. |
| `real-azure-llm-inference-v1` | OQ-4 listPopulatedCells(baseline, 20) gate passed (1 populated cells), but every cell has zero rows with ALL baseline.manifest.signals defined — collectCellRows (the frozen bootstrapHealthyWindow dependency) cannot resolve a single row anywhere in this bundle, so the frozen window generator would throw unconditionally on every draw. This bundle likely carries real per-tick data for only a subset of the manifest's signals (the rest undefined at every tick) rather than full per-tick coverage. |
| `real-mooncake-v1` | OQ-4 listPopulatedCells(baseline, 20) gate passed (1 populated cells), but every cell has zero rows with ALL baseline.manifest.signals defined — collectCellRows (the frozen bootstrapHealthyWindow dependency) cannot resolve a single row anywhere in this bundle, so the frozen window generator would throw unconditionally on every draw. This bundle likely carries real per-tick data for only a subset of the manifest's signals (the rest undefined at every tick) rather than full per-tick coverage. |
| `real-huggingface-lmsys-arena-v1` | OQ-4 listPopulatedCells(baseline, 20) gate passed (56 populated cells), but every cell has zero rows with ALL baseline.manifest.signals defined — collectCellRows (the frozen bootstrapHealthyWindow dependency) cannot resolve a single row anywhere in this bundle, so the frozen window generator would throw unconditionally on every draw. This bundle likely carries real per-tick data for only a subset of the manifest's signals (the rest undefined at every tick) rather than full per-tick coverage. |

