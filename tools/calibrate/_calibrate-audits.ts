// tools/calibrate/_calibrate-audits.ts — Q2.B.6.x integration-state audits
// (AR(1)/Cholesky/Σ_C consistency, sliding-buffer Hotelling, betting). Logic
// extracted VERBATIM from the pre-split tools/calibrate.ts god-file (D-54-3
// god-file decomposition); the ~210-line auditAR1FactorizationConsistency is
// decomposed into module-level helpers, each < 100 lines, with identical
// behavior, side effects, and halt semantics.

import type {
  BaselineCellsConfig, FamilyCPerCell, FamilyDPerSignal,
  FamilyAPerSignalParams, TenantTier,
} from '../../engine/types';
import { projectPSD, minEigenvalue } from '../calibrators/_shared.js';
import { chiSqQuantile975 } from '../calibrators/family-c.js';
import { AUDIT_TOL, Q2_B_6_1_PSD_EPS_RELATIVE } from './_calibrate-constants.js';

function _frobeniusNorm(M: number[][]): number {
  let s = 0;
  for (const row of M) for (const v of row) s += v * v;
  return Math.sqrt(s);
}

// ── Q2.B.6.1 integration-state-audit ─────────────────────────────────
//
// Per-cell + aggregate verification of the three AR(1)/Cholesky/Σ_C
// invariants that connect calibration to the parametric_ar1 runtime:
//
//   (a) cholesky_L · L^T ≈ Σ_C            (Family C structural)
//   (b) cholesky_L_eps · L_eps^T ≈ Σ_C_eps (white-noise structural)
//   (c) Σ_C_eps[i,j] ≈ (1 − ρ_i·ρ_j) · Σ_C[i,j]  (Lyapunov bridge)
//
// where ρ comes from the cell's tier (entry.key.tenant_tier; or
// 'aggregate' for the fallback). Halts the compile if any violation
// exceeds AUDIT_TOL relative to ‖Σ_C‖_∞.

interface AR1DiagStats {
  cellsChecked: number;
  cellsViolatingA: number;
  cellsViolatingBC: number;
  cellsViolatingPSD: number;
  cellsWithProjectedNegEig: number;
  maxAbsDiffA: number;
  maxAbsDiffBC: number;
  minProjectedEig: number;
  maxFroebRelDelta: number;
  worstBCCellLabel: string;
  worstBCRho: number[];
  sampleViolations: Array<{label: string; i: number; j: number; got: number; expected: number; rhoI: number; rhoJ: number; sigmaCij: number}>;
}

function newAR1DiagStats(): AR1DiagStats {
  return {
    cellsChecked: 0,
    cellsViolatingA: 0,
    cellsViolatingBC: 0,
    cellsViolatingPSD: 0,
    cellsWithProjectedNegEig: 0,
    maxAbsDiffA: 0,
    maxAbsDiffBC: 0,
    minProjectedEig: Infinity,
    maxFroebRelDelta: 0,
    worstBCCellLabel: '',
    worstBCRho: [],
    sampleViolations: [],
  };
}

/** (a) cholesky_L · L^T ≈ Σ_C structural round-trip. Mutates diagStats. */
function auditCheckA(
  L: number[][], sigmaC: number[][], p: number, tolAbs: number,
  label: string, diagMode: boolean, diagStats: AR1DiagStats,
): void {
  let aViolatedThisCell = false;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let acc = 0;
      for (let k = 0; k <= Math.min(i, j); k++) acc += L[i][k] * L[j][k];
      const expected = sigmaC[i][j];
      const diff = Math.abs(acc - expected);
      if (diff > diagStats.maxAbsDiffA) diagStats.maxAbsDiffA = diff;
      if (diff > tolAbs) {
        aViolatedThisCell = true;
        if (!diagMode) {
          throw new Error(
            `[calibrate] Q2.B.6.1 audit FAILED at ${label} (a): `
            + `cholesky_L · L^T[${i},${j}] = ${acc.toExponential(6)} `
            + `but Σ_C[${i},${j}] = ${expected.toExponential(6)} `
            + `(|Δ| = ${diff.toExponential(3)} > tol ${tolAbs.toExponential(3)})`,
          );
        }
      }
    }
  }
  if (aViolatedThisCell) diagStats.cellsViolatingA += 1;
}

/** (b') cholesky_L_eps · L_eps^T ≈ Σ_eps_psd post-projection round-trip.
 *  Mutates diagStats. */
function auditCheckBC(
  LEps: number[][], sigmaEpsPSD: number[][], sigmaC: number[][], rhoVec: number[],
  p: number, tolAbsBC: number, label: string, diagMode: boolean, diagStats: AR1DiagStats,
): void {
  let bcViolatedThisCell = false;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let acc = 0;
      for (let k = 0; k <= Math.min(i, j); k++) acc += LEps[i][k] * LEps[j][k];
      const expected = sigmaEpsPSD[i][j];
      const diff = Math.abs(acc - expected);
      if (diff > diagStats.maxAbsDiffBC) {
        diagStats.maxAbsDiffBC = diff;
        diagStats.worstBCCellLabel = label;
        diagStats.worstBCRho = rhoVec.slice();
      }
      if (diff > tolAbsBC) {
        bcViolatedThisCell = true;
        if (diagStats.sampleViolations.length < 12) {
          diagStats.sampleViolations.push({
            label, i, j, got: acc, expected,
            rhoI: rhoVec[i], rhoJ: rhoVec[j], sigmaCij: sigmaC[i][j],
          });
        }
        if (!diagMode) {
          throw new Error(
            `[calibrate] Q2.B.6.1 audit FAILED at ${label} (b): `
            + `cholesky_L_eps · L_eps^T[${i},${j}] = ${acc.toExponential(6)} `
            + `but Σ_eps_psd[${i},${j}] = ${expected.toExponential(6)} `
            + `(ρ_i = ${rhoVec[i].toFixed(4)}, ρ_j = ${rhoVec[j].toFixed(4)}, `
            + `Σ_C[${i},${j}] = ${sigmaC[i][j].toExponential(6)}) `
            + `(|Δ| = ${diff.toExponential(3)} > tol ${tolAbsBC.toExponential(3)})`,
          );
        }
      }
    }
  }
  if (bcViolatedThisCell) diagStats.cellsViolatingBC += 1;
}

/** (PSD coverage) min-eigenvalue floor + Frobenius residual diagnostic.
 *  Mutates diagStats. */
function auditCheckPSDCoverage(
  sigmaEpsPSD: number[][], sigmaEpsRaw: number[][], psdEpsFloor: number,
  p: number, label: string, diagMode: boolean, diagStats: AR1DiagStats,
): void {
  const minEig = minEigenvalue(sigmaEpsPSD);
  if (minEig < diagStats.minProjectedEig) diagStats.minProjectedEig = minEig;
  if (minEig < 0) diagStats.cellsWithProjectedNegEig += 1;
  // Allow eigendecomposition FP slack: floor at half the prescribed
  // ε (worst-case Jacobi convergence residual on p=11 is ~1e-14).
  const minEigTol = 0.5 * psdEpsFloor - 1e-12;
  if (minEig < minEigTol) {
    diagStats.cellsViolatingPSD += 1;
    if (!diagMode) {
      throw new Error(
        `[calibrate] Q2.B.6.1 audit FAILED at ${label} (PSD coverage): `
        + `min eig(Σ_eps_psd) = ${minEig.toExponential(3)} `
        + `< ε_relative · trace / 2p = ${minEigTol.toExponential(3)} `
        + `(post-projectPSD min-eigenvalue floor breached; projection '
        + 'numerical instability or eps-relative tuning gap)`,
      );
    }
  }

  // (Frobenius residual) ‖Σ_eps_psd − Σ_eps_raw‖_F / ‖Σ_eps_raw‖_F —
  // diagnostic only; recorded for sanity logging when DIAG mode is on.
  let normRaw = 0, normDelta = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
    const r = sigmaEpsRaw[i][j];
    const d = sigmaEpsPSD[i][j] - r;
    normRaw += r * r;
    normDelta += d * d;
  }
  if (normRaw > 0) {
    const rel = Math.sqrt(normDelta) / Math.sqrt(normRaw);
    if (rel > diagStats.maxFroebRelDelta) diagStats.maxFroebRelDelta = rel;
  }
}

/** Verify the three invariants on a single Family C cell. Mutates
 *  diagStats; halts (unless diagMode) on first violation. */
function auditAR1Cell(
  fc: FamilyCPerCell, tier: TenantTier, label: string,
  perTierFamilyD: Record<TenantTier, Record<string, FamilyDPerSignal>>,
  aggFD: Record<string, FamilyDPerSignal>,
  familyCSignals: readonly string[], diagMode: boolean, diagStats: AR1DiagStats,
): void {
  if (!fc.covariance || !fc.cholesky_L || !fc.cholesky_L_eps) return;
  const p = fc.covariance.length;
  if (p !== familyCSignals.length) return;
  if (fc.cholesky_L.length !== p || fc.cholesky_L_eps.length !== p) {
    throw new Error(
      `[calibrate] Q2.B.6.1 audit FAILED at ${label}: `
      + `cholesky factor dim mismatch (Σ_C ${p}×${p}, `
      + `cholesky_L ${fc.cholesky_L.length}×?, `
      + `cholesky_L_eps ${fc.cholesky_L_eps.length}×?)`,
    );
  }
  const tierFD = perTierFamilyD[tier];
  const rhoVec: number[] = familyCSignals.map((sig) =>
    tierFD[sig]?.ar1_phi ?? aggFD[sig]?.ar1_phi ?? 0,
  );
  const sigmaC = fc.covariance;
  const sigmaCNorm = _frobeniusNorm(sigmaC);
  const tolAbs = Math.max(AUDIT_TOL, AUDIT_TOL * sigmaCNorm);
  // Reproduce the calibrate-time pipeline: Σ_eps_raw → projectPSD → cholesky.
  const sigmaEpsRaw: number[][] = [];
  for (let i = 0; i < p; i++) {
    sigmaEpsRaw.push(new Array(p));
    for (let j = 0; j < p; j++) {
      sigmaEpsRaw[i][j] = (1 - rhoVec[i] * rhoVec[j]) * sigmaC[i][j];
    }
  }
  const sigmaEpsPSD = projectPSD(sigmaEpsRaw, Q2_B_6_1_PSD_EPS_RELATIVE);
  let psdTrace = 0;
  for (let i = 0; i < p; i++) psdTrace += sigmaEpsPSD[i][i];
  const psdEpsFloor = Q2_B_6_1_PSD_EPS_RELATIVE * Math.abs(psdTrace) / p;
  const sigmaEpsPSDNorm = _frobeniusNorm(sigmaEpsPSD);
  const tolAbsBC = Math.max(AUDIT_TOL, AUDIT_TOL * sigmaEpsPSDNorm);

  auditCheckA(fc.cholesky_L, sigmaC, p, tolAbs, label, diagMode, diagStats);
  auditCheckBC(fc.cholesky_L_eps, sigmaEpsPSD, sigmaC, rhoVec, p, tolAbsBC, label, diagMode, diagStats);
  auditCheckPSDCoverage(sigmaEpsPSD, sigmaEpsRaw, psdEpsFloor, p, label, diagMode, diagStats);
}

function reportAR1DiagStats(diagStats: AR1DiagStats): void {
  console.log(
    `[calibrate] Q2.B.6.1 audit (DIAG mode): `
    + `${diagStats.cellsChecked} cells checked; `
    + `(a) violations=${diagStats.cellsViolatingA} max|Δ|=${diagStats.maxAbsDiffA.toExponential(3)}; `
    + `(b) violations=${diagStats.cellsViolatingBC} max|Δ|=${diagStats.maxAbsDiffBC.toExponential(3)}; `
    + `(PSD-coverage) violations=${diagStats.cellsViolatingPSD} `
    + `min_proj_eig=${diagStats.minProjectedEig.toExponential(3)} `
    + `cells_with_neg_proj_eig=${diagStats.cellsWithProjectedNegEig}; `
    + `max_frob_rel_delta_raw_to_psd=${(diagStats.maxFroebRelDelta * 100).toFixed(2)}%.`,
  );
  if (diagStats.sampleViolations.length > 0) {
    console.log(`  worst_cell=${diagStats.worstBCCellLabel}`);
    console.log(`  ρ at worst: [${diagStats.worstBCRho.map(r => r.toFixed(3)).join(', ')}]`);
    console.log(`  first ${diagStats.sampleViolations.length} violations:`);
    for (const v of diagStats.sampleViolations) {
      console.log(`    ${v.label} [${v.i},${v.j}]: got=${v.got.toExponential(3)} `
        + `expected=${v.expected.toExponential(3)} ρ_i=${v.rhoI.toFixed(3)} ρ_j=${v.rhoJ.toFixed(3)} Σ_C=${v.sigmaCij.toExponential(3)}`);
    }
  }
}

export function auditAR1FactorizationConsistency(
  baselineCells: BaselineCellsConfig,
  perTierFamilyD: Record<TenantTier, Record<string, FamilyDPerSignal>>,
  familyCSignals: readonly string[],
): void {
  const aggFD = perTierFamilyD.aggregate;
  // Q2.B.6.1 diagnostic mode — set CALIBRATE_Q2B61_DIAG=1 to log audit
  // misses without halting. Used for one-shot widening surveys to
  // characterize the magnitude of post-PSD-projection residual.
  // Default: halt on first miss (architect halt-on-violation discipline).
  const diagMode = process.env.CALIBRATE_Q2B61_DIAG === '1';
  const diagStats = newAR1DiagStats();

  for (const entry of baselineCells.cells) {
    if (!entry.family_C) continue;
    diagStats.cellsChecked += 1;
    const tier = (entry.key.tenant_tier as TenantTier | undefined) ?? 'aggregate';
    const label = `cell key=${JSON.stringify(entry.key)}`;
    auditAR1Cell(entry.family_C, tier, label, perTierFamilyD, aggFD, familyCSignals, diagMode, diagStats);
  }
  if (baselineCells.aggregate_fallback.family_C) {
    diagStats.cellsChecked += 1;
    auditAR1Cell(baselineCells.aggregate_fallback.family_C, 'aggregate',
      'aggregate_fallback', perTierFamilyD, aggFD, familyCSignals, diagMode, diagStats);
  }

  if (diagMode) reportAR1DiagStats(diagStats);
}

/** Q2.B.6.2 — Verify sliding-buffer-aware Hotelling thresholds were
 *  stamped on every Family C cell, with strictly positive values and
 *  (chi_square variant only) values strictly exceeding the single-window
 *  Wilson-Hilferty χ²_p quantile baseline. Halts the compile on miss to
 *  surface stamping-pipeline drift before substrate ships. */
export function auditSlidingBufferHotellingConsistency(
  baselineCells: BaselineCellsConfig,
  familyCSignals: readonly string[],
): void {
  const p = familyCSignals.length;
  const singleWindowChiSq = chiSqQuantile975(p);
  const checkCell = (
    fc: FamilyCPerCell, label: string,
  ): void => {
    const variant = fc.hotelling_variant ?? 'chi_square';
    if (variant === 'safe_test') {
      const t = fc.safe_hotelling_params?.sliding_buffer_threshold;
      if (t === undefined || !Number.isFinite(t) || t <= 0) {
        throw new Error(
          `[calibrate] Q2.B.6.2 audit FAILED at ${label}: `
          + `safe_test variant cell missing or non-positive `
          + `safe_hotelling_params.sliding_buffer_threshold (got ${t}). `
          + `Recompile pipeline must stamp sliding-buffer threshold post-`
          + `cholesky_L_eps factorization.`,
        );
      }
      const scope = fc.safe_hotelling_params?.calibration_scope;
      if (scope !== 'sliding_buffer_ar1') {
        throw new Error(
          `[calibrate] Q2.B.6.2 audit FAILED at ${label}: `
          + `safe_test variant cell calibration_scope='${scope ?? 'unset'}'; `
          + `expected 'sliding_buffer_ar1'.`,
        );
      }
    } else {
      const t = fc.hotelling_sliding_buffer_threshold;
      if (t === undefined || !Number.isFinite(t) || t <= 0) {
        throw new Error(
          `[calibrate] Q2.B.6.2 audit FAILED at ${label}: `
          + `chi_square variant cell missing or non-positive `
          + `hotelling_sliding_buffer_threshold (got ${t}).`,
        );
      }
      // Sliding-buffer MAX statistic is ≥ single-window statistic by
      // construction (max over many ticks ≥ any single tick). Strict
      // inequality holds whenever AR(1) coefficients drive any non-trivial
      // dynamic — which is every realistic cell in synthetic-v1.
      if (t <= singleWindowChiSq) {
        throw new Error(
          `[calibrate] Q2.B.6.2 audit FAILED at ${label}: `
          + `chi_square variant cell sliding-buffer threshold ${t.toExponential(3)} `
          + `≤ single-window χ²_p(0.975) ${singleWindowChiSq.toExponential(3)}. `
          + `Sliding-buffer MAX statistic should strictly exceed single-tick `
          + `χ²_p quantile under any non-trivial AR(1) trajectory.`,
        );
      }
    }
  };
  for (const entry of baselineCells.cells) {
    if (!entry.family_C) continue;
    if (!entry.family_C.covariance) continue;
    if (entry.family_C.covariance.length !== p) continue;
    checkCell(entry.family_C, `cell key=${JSON.stringify(entry.key)}`);
  }
  if (baselineCells.aggregate_fallback.family_C
      && baselineCells.aggregate_fallback.family_C.covariance
      && baselineCells.aggregate_fallback.family_C.covariance.length === p) {
    checkCell(baselineCells.aggregate_fallback.family_C, 'aggregate_fallback');
  }
}

/** Q2.B.6.3 — Verify sliding-buffer betting wealth thresholds were
 *  stamped on every Family A per_signal entry with strictly positive
 *  finite values. Halts compile on miss to surface stamping-pipeline
 *  drift before substrate ships. Mirrors Q2.B.6.2's
 *  auditSlidingBufferHotellingConsistency on the family_A path. */
export function auditBettingSlidingBufferConsistency(
  baselineCells: BaselineCellsConfig,
): void {
  const checkPerSignal = (
    perSignal: Record<string, FamilyAPerSignalParams> | undefined,
    label: string,
  ): void => {
    if (!perSignal) return;
    for (const sig of Object.keys(perSignal)) {
      const p = perSignal[sig];
      if (!p) continue;
      const t = p.betting_sliding_buffer_threshold;
      if (t === undefined || !Number.isFinite(t) || t <= 0) {
        throw new Error(
          `[calibrate] Q2.B.6.3 audit FAILED at ${label} signal=${sig}: `
          + `betting_sliding_buffer_threshold missing or non-positive (got ${t}). `
          + `Recompile pipeline must stamp sliding-buffer betting threshold post-`
          + `family_D ar1_phi stamping.`,
        );
      }
      const scope = p.betting_calibration_scope;
      if (scope !== 'sliding_buffer_ar1') {
        throw new Error(
          `[calibrate] Q2.B.6.3 audit FAILED at ${label} signal=${sig}: `
          + `betting_calibration_scope='${scope ?? 'unset'}'; expected 'sliding_buffer_ar1'.`,
        );
      }
    }
  };
  for (const entry of baselineCells.cells) {
    if (entry.family_A?.per_signal) {
      checkPerSignal(entry.family_A.per_signal, `cell key=${JSON.stringify(entry.key)}`);
    }
  }
  if (baselineCells.aggregate_fallback.family_A?.per_signal) {
    checkPerSignal(baselineCells.aggregate_fallback.family_A.per_signal, 'aggregate_fallback');
  }
}
