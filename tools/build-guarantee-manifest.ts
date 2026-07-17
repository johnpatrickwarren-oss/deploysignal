// tools/build-guarantee-manifest.ts — machine-readable guarantee-manifest
// generator (WS2). Thin facade + CLI entrypoint; the pure generator and
// per-family join logic live in cohesive `tools/_guarantee-manifest-*.ts`
// submodules (arch-invariants.json god-file/complexity limits) — see:
//
//   engine/guarantees.ts                    — static per-detector table (source of truth)
//   tools/_guarantee-manifest-types.ts       — GuaranteeManifest + section types
//   tools/_guarantee-manifest-family-ab.ts   — Family A + B sections
//   tools/_guarantee-manifest-family-c.ts    — Family C section (Hotelling + MMD join)
//   tools/_guarantee-manifest-family-d.ts    — Family D section (spectral join)
//   tools/_guarantee-manifest-family-e.ts    — Family E section (conformal-kind join)
//   tools/_guarantee-manifest-effective.ts   — effective_validity computation
//   tools/_guarantee-manifest-limitations.ts — known_limitations + fallback_behavior content
//   tools/_guarantee-manifest-build.ts       — pure buildGuaranteeManifest(cfg, opts)
//   tools/_guarantee-manifest-cli.ts         — argv parsing + main()
//
// CLI:
//   node tools/build-guarantee-manifest.ts --config runs/compiled-configs/v7-demos.json \
//                                          --out runs/compiled-configs/v7-demos.guarantee-manifest.json
//
// tools/calibrate.ts also calls writeGuaranteeManifest() directly so every
// `calibrate` invocation emits a `<config-basename>.guarantee-manifest.json`
// sidecar next to the CompiledConfig it writes (see
// tools/calibrate/_calibrate-main.ts).

import { isMainThread } from 'node:worker_threads';

export { buildGuaranteeManifest } from './_guarantee-manifest-build';
export type {
  GuaranteeManifest, ManifestFamilySection, ManifestDetectorEntry,
  ManifestEffectiveValidity, BuildGuaranteeManifestOpts,
} from './_guarantee-manifest-types';
export { loadCompiledConfig, writeGuaranteeManifest, parseArgs } from './_guarantee-manifest-cli';
export type { CliArgs } from './_guarantee-manifest-cli';

import { main } from './_guarantee-manifest-cli';

// Auto-run main() only in CLI mode, mirroring tools/calibrate.ts's gate:
// tests and tools/calibrate's direct import of writeGuaranteeManifest()
// must not trigger a stray CLI invocation.
if (isMainThread && process.argv.some((a) => a === '--config')) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
