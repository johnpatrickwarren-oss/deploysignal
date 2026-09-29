// studies/gwdg-gate/harness/smoke.mjs — PREREGISTRATION §6 instrument checks. Not scored, not a result.
// Usage: node studies/gwdg-gate/harness/smoke.mjs [--file ggpu142_2025-07-03_gpu-problem_tidy.csv] [--gpu 0]
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseManifest, parseIncidents, eventsByNode, fileWindows, unitWindows, loadTidy, writeBundle, compileBundle,
  loadEngine, runWindow, SIGNALS, ARMS, isoUtc,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DATA = process.env.GWDG_DATA ?? join(REPO, '..', '..', 'concord', 'tessera', 'runs', 'gwdg-data', 'gwdg-gpu-node-telemetry-gpu-detachment-failures-2025-2026-v1.0.0');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const file = arg('--file', 'ggpu142_2025-07-03_gpu-problem_tidy.csv');
const gpu = arg('--gpu', '0');
const injectFrom = Number(arg('--inject-from', '50'));
const tmp = join(HERE, '..', 'results', '_smoke');
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });

const manifest = parseManifest(readFileSync(join(DATA, 'manifest.csv'), 'utf8'));
const incidents = parseIncidents(readFileSync(join(DATA, 'incident_events.csv'), 'utf8'));
const events = eventsByNode(manifest, incidents);
const fw = fileWindows(file, manifest, events);
console.log('file windows:', { ...fw, spanStart: isoUtc(fw.spanStart), spanEnd: isoUtc(fw.spanEnd), I: isoUtc(fw.I), eFirst: fw.eFirst && isoUtc(fw.eFirst), detStart: isoUtc(fw.detStart), detEnd: isoUtc(fw.detEnd), others: fw.others.map((e) => isoUtc(e.dayMs)) });

const t0 = Date.now();
const tidy = await loadTidy(join(DATA, 'telemetry', file));
console.log(`loaded ${file}: rows ${tidy.rows} kept ${tidy.kept} gpus ${tidy.gpus} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const gs = tidy.series[gpu];
const uw = unitWindows(fw, gs);
console.log('unit windows:', JSON.stringify({ ...uw, calibration: uw.calibration && { ...uw.calibration, start: isoUtc(uw.calibration.start), end: isoUtc(uw.calibration.end) }, nullWin: uw.nullWin && { ...uw.nullWin, start: isoUtc(uw.nullWin.start), end: isoUtc(uw.nullWin.end) }, detection: uw.detection && { ...uw.detection, start: isoUtc(uw.detection.start), end: isoUtc(uw.detection.end) } }, null, 1));
if (!uw.eligible) throw new Error('smoke unit not eligible');

const unitId = `${file.replace(/_tidy\.csv$/, '')}__gpu${gpu}`;
const bdir = join(tmp, 'bundles', unitId);
const b = writeBundle(bdir, unitId, tidy.uuid[gpu], gs, uw.calibration);
console.log('bundle:', b);

const engine = loadEngine(REPO);
for (const arm of Object.keys(ARMS)) {
  const t1 = Date.now();
  const c = compileBundle(REPO, bdir, arm, join(tmp, `${unitId}.${arm}.json`));
  console.log(`compile ${arm}: ok=${c.ok} in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  if (!c.ok) { console.log(c.error, c.stderr.slice(-2000)); continue; }
  const agg = c.config.baseline_cells?.aggregate_fallback;
  const per = agg?.family_A?.per_signal ?? {};
  for (const s of SIGNALS) {
    const p = per[s];
    console.log(`  ${arm} ${s}: mean_raw=${p?.baseline_mean_raw ?? p?.baseline_mean} sigma2_raw=${p?.baseline_sigma_squared_raw ?? p?.baseline_sigma_squared} phi=${p?.ar1_phi} floor=${p?.sigma_floor_applied ?? false} bettingThr=${p?.betting_sliding_buffer_threshold}`);
  }
  console.log(`  ${arm} cells=${c.config.baseline_cells?.cells?.length} family_C=${!!agg?.family_C} family_a_signals=${c.config.family_a_signals?.length} family_c_signals=${c.config.family_c_signals?.length} warnings=${(c.config.compile_warnings ?? []).length}`);
  for (const w of (c.config.compile_warnings ?? []).slice(0, 5)) console.log('   warn:', w.code, w.message?.slice(0, 160));
  const win = uw.nullWin ?? uw.detection;
  // (ii) a real fire on an obvious signal: +5σ step on GPU_TEMP from tick 50
  const sigma = Math.sqrt(per.DCGM_FI_DEV_GPU_TEMP?.baseline_sigma_squared_raw ?? per.DCGM_FI_DEV_GPU_TEMP?.baseline_sigma_squared ?? 1);
  const fired = runWindow(engine, c.config, gs, win, { inject: { signal: 'DCGM_FI_DEV_GPU_TEMP', fromTick: injectFrom, delta: 5 * sigma } });
  console.log(`  ${arm} (ii) +5sigma step from tick ${injectFrom}: outcome=${fired.outcome} fireTick=${fired.fireTick} families=${fired.firingFamilies} ids=${fired.rollbackIds.slice(0, 4)} signal=${fired.firstSignal}`);
  // (iii) unmodified: detectors ran every tick
  const plain = runWindow(engine, c.config, gs, win);
  console.log(`  ${arm} (iii) unmodified: outcome=${plain.outcome} fireTick=${plain.fireTick} evaluated=${plain.evaluated} outlookEmpty=${plain.outlookEmpty} missingTicks=${plain.missingTicks} families=${plain.firingFamilies} signal=${plain.firstSignal}`);
}
