# 2026-09-contrast-arm — report (run-20260905T064241Z)

Repo `13ec0c1fcb48be5f933e1e4ae6cb13ae4cc6dbb3`; engine 0.6.12-pre (pin `git+https://github.com/johnpatrickwarren-oss/deploysignal-engine.git#v0.6.12-pre`); scenarios 131 (sha `dd15a08e246c…`); node v25.9.0; 2131 ms; exceptions 0; voided cells 0.
Fit 500, canary 100, injection at 30, steps 1.5σ̂ / 3σ̂; q = 0.05; α primary 3.333e-5, secondary 0.05; monitor α_cal 0.01; fit-ratio floor 10.
Smoke: {"null":{"temporal":null,"contrast":null},"canary-3":{"temporal":38,"contrast":34}}.

## Endpoints

| endpoint | measured | bar | verdict |
|---|---|---|---|
| E1 false would-be rollback under the null, contrast at q (primary α card) | 0.0076 (temporal 0.0000 primary / 0.1069 at 0.05) | ≤ 0.0881 | HELD |
| E2 detection on the canary-only 1.5σ̂ step, contrast | 1.0000 (TTD 17) vs temporal 1.0000 (TTD 18) | ≥ 0.5 | HELD |
| E2 (reported) the 3σ̂ row | contrast 1.0000 (TTD 7) vs temporal 1.0000 (TTD 8) | — | reported |
| E3 a shared outage, contrast | 0.0076 (null 0.0076); temporal shared 1.0000 vs its canary 1.0000 | ≤ 0.0457 | HELD |
| E4 cohort-monitor revocation on a contaminated control by t = 100 | p99_latency 0.328 (med 84; null 0.000); ttft 0.344 (med 65; null 0.000); cost_req 0.290 (med 75; null 0.000); downstream_err 0.290 (med 75; null 0.000); contrast would-be rollback 0.0076 | ≥ 0.5 on p99_latency, ttft | FAILED |
| E5 the shipped gate's reading | fit ratio 5 vs floor 10: {"refused_fit_ratio":655,"asserted_m_much_greater_than_n":0}; authority advisory | — | reported |

## Cells

| arm | variant | α | trials | would-be rollbacks | rate | median TTD | exceptions |
|---|---|---|---|---|---|---|---|
| contrast | null | 0.000033333333333333335 | 131 | 1 | 0.0076 | -7 | 0 |
| contrast | null | 0.05 | 131 | 1 | 0.0076 | -7 | 0 |
| contrast | canary | 0.000033333333333333335 | 131 | 131 | 1.0000 | 17 | 0 |
| contrast | canary | 0.05 | 131 | 131 | 1.0000 | 17 | 0 |
| contrast | shared | 0.000033333333333333335 | 131 | 1 | 0.0076 | -7 | 0 |
| contrast | shared | 0.05 | 131 | 1 | 0.0076 | -7 | 0 |
| contrast | contaminated | 0.000033333333333333335 | 131 | 1 | 0.0076 | -7 | 0 |
| contrast | contaminated | 0.05 | 131 | 1 | 0.0076 | -7 | 0 |
| contrast | canary-3 | 0.000033333333333333335 | 131 | 131 | 1.0000 | 7 | 0 |
| contrast | canary-3 | 0.05 | 131 | 131 | 1.0000 | 7 | 0 |
| temporal | null | 0.000033333333333333335 | 131 | 0 | 0.0000 | — | 0 |
| temporal | null | 0.05 | 131 | 14 | 0.1069 | -17 | 0 |
| temporal | canary | 0.000033333333333333335 | 131 | 131 | 1.0000 | 18 | 0 |
| temporal | canary | 0.05 | 131 | 131 | 1.0000 | 9 | 0 |
| temporal | shared | 0.000033333333333333335 | 131 | 131 | 1.0000 | 18 | 0 |
| temporal | shared | 0.05 | 131 | 131 | 1.0000 | 9 | 0 |
| temporal | contaminated | 0.000033333333333333335 | 131 | 0 | 0.0000 | — | 0 |
| temporal | contaminated | 0.05 | 131 | 14 | 0.1069 | -17 | 0 |
| temporal | canary-3 | 0.000033333333333333335 | 131 | 131 | 1.0000 | 8 | 0 |
| temporal | canary-3 | 0.05 | 131 | 131 | 1.0000 | 4 | 0 |

## Interpretation decisions made in code (registered as open)

- The contrast arm's e-BH reads the mixture card's running wealth at the PRIMARY α card; the card's α sets only its own threshold.
- A scenario's would-be rollback tick is the first canary tick with a non-empty selected set among pairs whose cohort monitor is passing, under the study flag `asserted_by_study_flag` (the shipped gate reads `refused_fit_ratio` at m/T = 5).
- The temporal arm is C64 (d)'s mixture arm verbatim (plug-in μ̂/σ̂² from the canary's 500-tick calibration, ar1_phi 0), first crossing across the four signals.
- The cohort monitor's revocation tick is the first canary tick `passing` is false; its fit is on the cohort pair's own 500-tick baseline.
