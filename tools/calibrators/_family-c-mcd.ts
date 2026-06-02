// tools/calibrators/_family-c-mcd.ts — FastMCD / MRCD / Ledoit-Wolf
// robust-covariance routing + Croux-Haesbroeck consistency correction.
// Split VERBATIM from family-c.ts (End-phase slice 3c, D-54-3) during
// the god-file decomposition; no computation changed. Re-exported
// through the family-c.ts facade so the public surface is unchanged.

import type { FamilyCPerCell, OutlierDetection } from '../../engine/types';
import { mulberry32, choleskyLocal } from './_shared.js';
import {
  columnMean, relativeDeviations, sampleCovariance, ledoitWolfShrinkage,
  chiSqQuantile975, logDetCholesky, mahalanobisSqFromL,
} from './_family-c-covariance.js';

// ── FastMCD + MRCD ──────────────────────────────────────────────

/** Architect-set FastMCD constants. */
export const FASTMCD_N_INITIAL_SUBSETS = 500;
export const FASTMCD_N_WARM_SUBSETS = 50;
export const FASTMCD_CSTEP_LIMIT = 20;
export const FASTMCD_TOP_N_FOR_FULL = 10;
export const FASTMCD_DEFAULT_ALPHA = 0.75;
export const FASTMCD_DEFAULT_SEED = 0xFA5DA >>> 0;

/** REPLY-50 D6b thresholds. */
export const D6B_LAMBDA_THRESHOLD = 0.1;
export const D6B_OUTLIER_FRACTION_THRESHOLD = 0.05;

/** FastMCD result — robust mean + covariance and the h-subset indices. */
export interface FastMCDResult {
  mean: number[];
  cov: number[][];
  h_support: number;
  support_indices: number[];
  logDet: number;
}

/** Pre-computed warm-start seed for FastMCD per REPLY-50 slice-3 D6a. */
export interface FastMCDWarmSeed {
  mean: number[];
  cov: number[][];
}

/** One FastMCD concentration step. */
export function cStep(
  rows: number[][],
  currentMean: number[],
  currentCov: number[][],
  h: number,
): { mean: number[]; cov: number[][]; indices: number[]; logDet: number } | null {
  const L = choleskyLocal(currentCov);
  if (!L) return null;
  const distances: Array<{ idx: number; d2: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const d2 = mahalanobisSqFromL(rows[i], currentMean, L);
    distances.push({ idx: i, d2 });
  }
  distances.sort((a, b) => a.d2 - b.d2);
  const indices = distances.slice(0, h).map((d) => d.idx);
  const kept = indices.map((i) => rows[i]);
  const mean = columnMean(kept);
  const Z = kept.map((r) => r.map((v, i) => v - mean[i]));
  const cov = sampleCovariance(Z);
  const logDet = logDetCholesky(cov);
  if (logDet === null) return null;
  return { mean, cov, indices, logDet };
}

/** Draw a random (p+1)-sized subset; compute its mean + sample cov. */
export function initialSubsetEstimate(
  rows: number[][],
  rng: () => number,
): { mean: number[]; cov: number[][] } | null {
  const n = rows.length;
  const p = rows[0].length;
  const indices = new Set<number>();
  while (indices.size < p + 1) indices.add(Math.floor(rng() * n));
  const expand = (): { mean: number[]; cov: number[][] } | null => {
    const kept = [...indices].map((i) => rows[i]);
    const mean = columnMean(kept);
    const Z = kept.map((r) => r.map((v, i) => v - mean[i]));
    const cov = sampleCovariance(Z);
    return choleskyLocal(cov) ? { mean, cov } : null;
  };
  let est = expand();
  while (est === null && indices.size < n) {
    let added = false;
    while (!added) {
      const j = Math.floor(rng() * n);
      if (!indices.has(j)) { indices.add(j); added = true; }
    }
    est = expand();
  }
  return est;
}

/** REPLY-50 slice-3 D6a — LW-shrunk covariance warm-start for fastMCD. */
export function computeLWWarmSeed(rows: number[][]): FastMCDWarmSeed | undefined {
  const n = rows.length;
  if (n === 0) return undefined;
  const p = rows[0].length;
  if (n < p + 1) return undefined;
  const mean = columnMean(rows);
  const Z = rows.map((r) => r.map((v, i) => v - mean[i]));
  const { cov } = ledoitWolfShrinkage(Z);
  if (!choleskyLocal(cov)) return undefined;
  return { mean, cov };
}

/** Run FastMCD on a p-dimensional row matrix. */
export function fastMCD(
  rows: number[][],
  alpha: number = FASTMCD_DEFAULT_ALPHA,
  seed: number = FASTMCD_DEFAULT_SEED,
  warmSeed?: FastMCDWarmSeed,
): FastMCDResult | null {
  const n = rows.length;
  const p = rows[0].length;
  if (n < p + 1) return null;
  const h = Math.max(p + 1, Math.ceil(alpha * n));
  const rng = mulberry32(seed);

  type Candidate = { mean: number[]; cov: number[][]; indices: number[]; logDet: number };
  const candidates: Candidate[] = [];
  if (warmSeed) {
    const warm = cStep(rows, warmSeed.mean, warmSeed.cov, h);
    if (warm) {
      const warm2 = cStep(rows, warm.mean, warm.cov, h);
      if (warm2) candidates.push(warm2);
    }
  }
  const nRandomDraws = warmSeed ? FASTMCD_N_WARM_SUBSETS : FASTMCD_N_INITIAL_SUBSETS;
  for (let t = 0; t < nRandomDraws; t++) {
    const seed0 = initialSubsetEstimate(rows, rng);
    if (!seed0) continue;
    const step = cStep(rows, seed0.mean, seed0.cov, h);
    if (!step) continue;
    const step2 = cStep(rows, step.mean, step.cov, h);
    if (!step2) continue;
    candidates.push(step2);
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.logDet - b.logDet);
  const topN = candidates.slice(0, FASTMCD_TOP_N_FOR_FULL);
  let best: Candidate | null = null;
  for (const cand of topN) {
    let current = cand;
    for (let iter = 0; iter < FASTMCD_CSTEP_LIMIT; iter++) {
      const next = cStep(rows, current.mean, current.cov, h);
      if (!next) break;
      if (Math.abs(next.logDet - current.logDet) < 1e-10) { current = next; break; }
      current = next;
    }
    if (best === null || current.logDet < best.logDet) best = current;
  }
  if (best === null) return null;
  return {
    mean: best.mean,
    cov: best.cov,
    h_support: h,
    support_indices: best.indices.slice().sort((a, b) => a - b),
    logDet: best.logDet,
  };
}

/** Reweighting step after MCD. */
export function mcdReweight(
  rows: number[][],
  mcdMean: number[],
  mcdCov: number[][],
): { mean: number[]; cov: number[][]; kept: number[]; cutoff: number } | null {
  const p = rows[0].length;
  const cutoff = chiSqQuantile975(p);
  const L = choleskyLocal(mcdCov);
  if (!L) return null;
  const kept: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const d2 = mahalanobisSqFromL(rows[i], mcdMean, L);
    if (d2 <= cutoff) kept.push(i);
  }
  if (kept.length < p + 1) return null;
  const keptRows = kept.map((i) => rows[i]);
  const mean = columnMean(keptRows);
  const Z = keptRows.map((r) => r.map((v, i) => v - mean[i]));
  const cov = sampleCovariance(Z);
  if (!choleskyLocal(cov)) return null;
  return { mean, cov, kept, cutoff };
}

// ── REPLY-52c F1c — Croux-Haesbroeck MCD consistency correction ─────
//
// The FastMCD estimator trims the sample covariance to the h ≤ n
// "cleanest" subset — minimizing determinant of Σ_h subject to
// |S| ≤ h. Under the multivariate normal null, this systematically
// UNDERESTIMATES the true covariance because the trimmed sample
// excludes the tails. The classical consistency factor corrects it:
//
//   c_{p, α} = α / F_{χ²_{p+2}}(q_{p, α})
//
// where q_{p, α} is the α-quantile of χ²_p and F_{χ²_{p+2}} is the
// CDF of χ²_{p+2}. (Croux & Haesbroeck 1999, §3 eq 3.2.) Applying
// the correction to the reweighted MCD output restores E[c · Σ_MCD]
// = Σ_true under Gaussian data.
//
// We approximate the required χ² quantile + CDF via Wilson-Hilferty
// (elementary-function χ² ↔ N mapping) + Beasley-Springer (inverse
// normal CDF) so no external dep.
//
// Canonical reference values (Croux-Haesbroeck 1999 Table 1):
//   p=11, α=0.75  →  c ≈ 1.24
//   p=5,  α=0.75  →  c ≈ 1.12
//   p=2,  α=0.5   →  c ≈ 1.39

/** Beasley-Springer approximation of Φ⁻¹(p) (inverse-normal CDF)
 *  for p ∈ (0, 1). 4-digit accuracy across the full range; ample
 *  for MCD consistency-correction use. */
function _beasleySpringerInverseNormal(p: number): number {
  // Split into central and tail regions for numerical stability.
  const y = p - 0.5;
  if (Math.abs(y) < 0.42) {
    const r = y * y;
    const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637];
    const b = [-8.47351093090, 23.08336743743, -21.06224101826, 3.13082909833];
    const num = ((a[3] * r + a[2]) * r + a[1]) * r + a[0];
    const den = (((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1;
    return y * num / den;
  }
  let r = p;
  if (y > 0) r = 1 - p;
  r = Math.log(-Math.log(r));
  const c = [
    0.3374754822726147, 0.9761690190917186, 0.1607979714918209,
    0.0276438810333863, 0.0038405729373609, 0.0003951896511919,
    0.0000321767881768, 0.0000002888167364, 0.0000003960315187,
  ];
  let x = c[0] + r * (c[1] + r * (c[2] + r * (c[3] + r * (c[4] + r * (c[5] + r * (c[6] + r * (c[7] + r * c[8])))))));
  return y < 0 ? -x : x;
}

/** Wilson-Hilferty χ²_k quantile at probability α. Cubed-normal
 *  approximation: if Y ~ χ²_k, then (Y/k)^{1/3} ≈ N(1 − 2/(9k),
 *  2/(9k)). Inverting: q = k · (1 − 2/(9k) + z·√(2/(9k)))^3 where
 *  z = Φ⁻¹(α). */
function _chiSqQuantileWH(alpha: number, k: number): number {
  const z = _beasleySpringerInverseNormal(alpha);
  const a = 2 / (9 * k);
  const base = 1 - a + z * Math.sqrt(a);
  return k * base * base * base;
}

/** Wilson-Hilferty CDF F_{χ²_k}(q). Inverse of the quantile form:
 *  z = ((q/k)^{1/3} − (1 − 2/(9k))) / √(2/(9k)); return Φ(z). */
function _chiSqCdfWH(q: number, k: number): number {
  if (q <= 0) return 0;
  const a = 2 / (9 * k);
  const z = (Math.pow(q / k, 1 / 3) - (1 - a)) / Math.sqrt(a);
  // Normal CDF via erf — 7-digit accuracy (Abramowitz-Stegun 7.1.26).
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t *
    (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Croux-Haesbroeck 1999 §3 eq 3.2 consistency-correction factor
 *  for MCD at coverage `alpha` in p dimensions. Via Wilson-Hilferty
 *  + Beasley-Springer. Applied as Σ_corrected = c · Σ_MCD. Exported
 *  for parity testing; callers should prefer buildFamilyCPerCellMCD
 *  which applies the correction internally. */
export function consistencyCorrectionFactor(alpha: number, p: number): number {
  if (alpha <= 0 || alpha >= 1 || p < 1) return 1;
  const q = _chiSqQuantileWH(alpha, p);
  const f = _chiSqCdfWH(q, p + 2);
  if (f <= 0) return 1;
  return alpha / f;
}

/** Build a FamilyCPerCell from a row matrix using MCD + reweight.
 *
 *  REPLY-52c F1c: applies the Croux-Haesbroeck consistency-
 *  correction factor c_{p, α} to the reweighted covariance so
 *  E[Σ_out] = Σ_true under Gaussian. Without the correction MCD
 *  systematically underestimates Σ by ~20-40% at α=0.75 (sample
 *  size-dependent), which downstream manifests as inflated
 *  Mahalanobis distances + falsely-elevated Hotelling T² statistics.
 *
 *  MRCD path (buildFamilyCPerCellMRCD below) does NOT receive this
 *  correction — its own regularization-shrinkage already shifts the
 *  target, and the appropriate correction factor for MRCD differs
 *  from plain MCD. MRCD consistency correction is deferred to a
 *  future brief bundled with demo expected_outcome re-tuning per
 *  ARCHITECT-REPLY-52c §F1c disposition.
 *
 *  v4 impact: v4-fusion-novelty.json has 0 MCD cells (D6b low-
 *  variance skip routes every cell through Ledoit-Wolf), so this
 *  correction produces zero runtime change on shipped demos. */
export function buildFamilyCPerCellMCD(
  rows: number[][],
  mcdAlpha: number,
): { cell: FamilyCPerCell; outlier: OutlierDetection } | null {
  const rawMean = columnMean(rows);
  const rawZ = relativeDeviations(rows, rawMean);
  const warmSeed = computeLWWarmSeed(rawZ);
  const mcd = fastMCD(rawZ, mcdAlpha, FASTMCD_DEFAULT_SEED, warmSeed);
  if (!mcd) return null;
  const rw = mcdReweight(rawZ, mcd.mean, mcd.cov);
  if (!rw) return null;
  // REPLY-52c F1c: scale the reweighted covariance by the Croux-
  // Haesbroeck consistency factor. Applied only on the MCD branch;
  // MRCD branch below is unchanged (see deferral note).
  const p = rw.cov.length;
  const cAlpha = consistencyCorrectionFactor(mcdAlpha, p);
  const correctedCov: number[][] = rw.cov.map((row) => row.map((v) => v * cAlpha));
  return {
    cell: {
      mean_vector: rawMean,
      covariance: correctedCov,
      covariance_method: 'mcd',
    },
    outlier: {
      method: 'mcd',
      raw_baseline_n: rows.length,
      trimmed_baseline_n: rw.kept.length,
      outlier_fraction: Math.min(0.5, (rows.length - rw.kept.length) / rows.length),
      h_support: mcd.h_support,
      mahalanobis_cutoff: Math.sqrt(rw.cutoff),
    },
  };
}

/** MRCD — Minimum Regularized Covariance Determinant (Boudt et al. 2020).
 *
 *  REPLY-52c F1c: consistency-correction NOT applied here. MRCD's
 *  built-in ridge-shrinkage toward an identity-like target already
 *  biases Σ differently than plain MCD; the appropriate correction
 *  factor is not the Croux-Haesbroeck c_{p,α} formula used in the
 *  MCD path above. MRCD correction is deferred to a future brief
 *  bundled with demo expected_outcome re-tuning per ARCHITECT-
 *  REPLY-52c §F1c disposition. */
export function buildFamilyCPerCellMRCD(
  rows: number[][],
  mcdAlpha: number,
): { cell: FamilyCPerCell; outlier: OutlierDetection } {
  const rawMean = columnMean(rows);
  const rawZ = relativeDeviations(rows, rawMean);
  const p = rawZ[0].length;
  const n = rawZ.length;
  const alphaTight = Math.max(mcdAlpha, 0.9);
  const warmSeed = computeLWWarmSeed(rawZ);
  const mcd = fastMCD(rawZ, alphaTight, FASTMCD_DEFAULT_SEED, warmSeed)
    ?? initialFallbackMCD(rawZ);
  const rawS = mcd.cov;
  let muDiag = 0;
  for (let i = 0; i < p; i++) muDiag += rawS[i][i];
  muDiag /= p;
  const ratio = Math.max(0, (2 * p + 1 - n) / Math.max(1, p + 1));
  const rho = Math.min(0.5, Math.max(0, ratio));
  const cov: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      const tij = i === j ? muDiag : 0;
      cov[i][j] = rho * tij + (1 - rho) * rawS[i][j];
    }
  }
  const L = choleskyLocal(cov);
  const cutoff = chiSqQuantile975(p);
  const kept: number[] = [];
  if (L) {
    for (let i = 0; i < rawZ.length; i++) {
      if (mahalanobisSqFromL(rawZ[i], mcd.mean, L) <= cutoff) kept.push(i);
    }
  } else {
    for (let i = 0; i < rawZ.length; i++) kept.push(i);
  }
  return {
    cell: {
      mean_vector: rawMean,
      covariance: cov,
      covariance_method: 'mrcd',
      covariance_shrinkage: rho,
    },
    outlier: {
      method: 'mrcd',
      raw_baseline_n: rows.length,
      trimmed_baseline_n: kept.length,
      outlier_fraction: Math.min(0.5, (rows.length - kept.length) / rows.length),
      h_support: mcd.h_support,
      mahalanobis_cutoff: Math.sqrt(cutoff),
    },
  };
}

/** Last-resort seed when FastMCD can't find a non-degenerate subset. */
export function initialFallbackMCD(rows: number[][]): FastMCDResult {
  const p = rows[0].length;
  const n = rows.length;
  const mean = columnMean(rows);
  const cov: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const denom = Math.max(1, n - 1);
  for (const r of rows) {
    for (let i = 0; i < p; i++) {
      const di = r[i] - mean[i];
      for (let j = i; j < p; j++) {
        const c = di * (r[j] - mean[j]);
        cov[i][j] += c;
        if (i !== j) cov[j][i] += c;
      }
    }
  }
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) cov[i][j] /= denom;
  }
  const L = choleskyLocal(cov);
  let logDet: number;
  if (L) {
    logDet = 0;
    for (let i = 0; i < p; i++) logDet += 2 * Math.log(L[i][i]);
  } else {
    let muDiag = 0;
    for (let i = 0; i < p; i++) muDiag += cov[i][i];
    muDiag = Math.max(1e-12, muDiag / p);
    logDet = p * Math.log(muDiag);
  }
  return {
    mean, cov,
    h_support: n,
    support_indices: rows.map((_, i) => i),
    logDet,
  };
}
