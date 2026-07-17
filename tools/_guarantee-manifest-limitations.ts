// tools/_guarantee-manifest-limitations.ts — known_limitations +
// fallback_behavior content for the guarantee manifest. known_limitations
// is sourced from deploysignal-paper.md §5 ("Limitations") in the paper's
// own wording, kept short; fallback_behavior documents the actual
// sparse-cell/gate fallback mechanisms found in the compiler + detector
// code while building this generator.

/** Verbatim-in-spirit, shortened restatement of deploysignal-paper.md §5.
 *  Kept short + factual per the brief; not a full reproduction of the
 *  paper section. Update this list if §5 changes materially. */
export const KNOWN_LIMITATIONS: readonly string[] = [
  'Baselines are synthetic: the formal Ville bound holds by construction, '
    + 'but empirical FPR is characterized only on synthetic and '
    + 'hand-curated postmortem-reconstruction baselines, not on ≥10^5 '
    + 'healthy production runs (deploysignal-paper.md §5).',
  'Empirical FPR is not yet at the nominal bound under all nulls: under '
    + 'an i.i.d.-bootstrap null, several multivariate detectors show '
    + 'calibration gaps traced to per-cell covariance shrinkage and a '
    + 'μ-coherence issue under remediation (Q2.B); the betting and '
    + 'Page-CUSUM Family A paths are empirically Ville-clean across '
    + '>196,000 trajectories. This is a calibration issue, not a formal-'
    + 'property gap (deploysignal-paper.md §5).',
  'Family B is heuristic: hand-tuned absolute-threshold structural '
    + 'signatures with no anytime-valid or classical guarantee; they '
    + 'consume no α and their false-positive behavior is governed only '
    + 'by empirical sweep results (deploysignal-paper.md §5).',
  'No live orchestrator integration: the engine is runtime-exercised '
    + 'TypeScript with a deterministic test substrate; wiring to Argo '
    + 'Rollouts, Spinnaker, or a custom operator is described but not '
    + 'shipped (deploysignal-paper.md §5).',
  'Multi-metric dependence is handled conservatively via Bonferroni/'
    + 'union bounds, which are loose under strong dependence '
    + '(deploysignal-paper.md §5).',
];

/** Real per-cell/config fallback mechanisms this generator found while
 *  joining engine/guarantees.ts against compiled configs. Kept honest
 *  even where it corrects an assumption the WS2 brief made going in —
 *  see the file-level notes in the family-specific join modules for the
 *  code citations backing each bullet. */
export const FALLBACK_BEHAVIOR: readonly string[] = [
  'Family C Hotelling T²: hotelling_variant defaults to (and falls back '
    + 'to, when safe_hotelling_params is missing) the classical '
    + "chi_square Wilson-Hilferty test — engine/detectors/"
    + '_hotelling-dispatch.ts hotellingVariantForDispatch.',
  'Family C Sequential MMD: a cell needs ≥ MMD_MIN_BASELINE_SAMPLES '
    + '(100; tools/calibrators/_family-c-mmd.ts) baseline samples for the '
    + 'compiler to stamp mmd_params at all; below that, e_mmd_params and '
    + 'betting_e_process_params are both null and NO Sequential-MMD '
    + 'detector runs for that cell at runtime (Hotelling remains the '
    + 'only Family C signal there). This is a coverage gap, not a '
    + 'classical-test fallback — the classical bootstrap-null MMD '
    + 'evaluator was retired from runtime dispatch at Q68 close.',
  'Family D spectral: spectral_variant defaults to the classical '
    + 'bootstrap_null quantile test when unset. A cell configured '
    + 'spectral_variant=e_detector does NOT fall back to bootstrap_null when '
    + 'its null_mean/null_std moments are missing — engine/detectors/'
    + 'spectral.ts spectralVariantForDispatch only falls back to '
    + 'bootstrap_null when the per-(deploy, signal) e-detector wealth-state '
    + "object itself is absent, which the gate lazily allocates for every "
    + 'evaluated cell (a pre-Addition-#21 TrendBuffer compatibility path, '
    + 'not something this compiled config controls). An e_detector cell '
    + 'missing null_mean/null_std instead reaches evaluateSpectralEDetector '
    + 'and returns SUPPRESSED (spectral_e_detector_params_missing) — NO '
    + 'Family-D coverage runs for that cell at runtime. This is a coverage '
    + 'gap, not a classical-test fallback.',
  "Family E conformal: the compiler's default 'auto' variant selector "
    + '(tools/calibrators/family-e.ts resolveFamilyEVariantSelector) '
    + 'silently falls back from the Ville-bounded weighted_e_value wealth '
    + 'process to the classical unweighted parametric-Gaussian-bootstrap '
    + 'conformal p-value test when the baseline span is below '
    + 'FAMILY_E_MIN_SPAN_DAYS (7 days) or the expected/observed effective '
    + 'sample size is below FAMILY_E_ESS_THRESHOLD (0.9) · M. Route (b) '
    + 'real-held-out calibration (Tibshirani/Foygel-Barber/Candès/Ramdas '
    + '2019) is permanently deferred per engine/detectors/conformal.ts — '
    + 'the finite-sample coverage requirement n ≥ ⌈1/α⌉ exceeds typical '
    + 'per-cell sample counts at α = 1e-4.',
  'Q70 Phase-3.d.E self-normalized e-process fallback (engine/detectors/'
    + 'self-normalized-e-process-fallback.ts, §7 EmpiricalProcessLILBound '
    + 'and §6 BetaBinomialMixture): SLICE 1 shipped schema only '
    + '(self_normalized_fallback fields on FamilyCPerCell / '
    + 'FamilyDPerSignal / ConformalParams); calibrator stamping and '
    + 'detector consumption were deferred to SLICE 2, which never '
    + 'landed. DEPRECATED / dormant — no compiled config exercises it.',
];
