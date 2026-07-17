// tools/_guarantee-manifest-cli.ts — CLI argument parsing + main() for
// tools/build-guarantee-manifest.ts. Split out per the repo's
// tools/_<tool>-cli.ts convention (see tools/_ingest-public-dataset-cli.ts).

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompiledConfig } from '../engine/types';
import { buildGuaranteeManifest } from './_guarantee-manifest-build';

export interface CliArgs {
  configPath: string;
  outPath: string;
}

const USAGE = 'Usage: node tools/build-guarantee-manifest.js --config <compiled-config.json> --out <manifest.json>';

export function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--config':
        out.configPath = v;
        i++;
        break;
      case '--out':
        out.outPath = v;
        i++;
        break;
      default:
        if (k.startsWith('--')) throw new Error(`Unknown flag: ${k}. ${USAGE}`);
    }
  }
  if (!out.configPath || !out.outPath) {
    throw new Error(`Required flags: --config <path> --out <path>. ${USAGE}`);
  }
  return out as CliArgs;
}

/** Read a CompiledConfig JSON file from disk. Shared by the CLI and by
 *  tools/calibrate integration so both go through one parse path. */
export function loadCompiledConfig(configPath: string): CompiledConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw) as CompiledConfig;
}

/** Build a manifest for `cfg` and write it to `outPath` (pretty JSON,
 *  trailing newline — matches tools/calibrate's CompiledConfig write
 *  convention). `generatedAt` defaults to wall-clock now(); callers that
 *  need determinism (tests, or calibrate's own deterministic
 *  `compiled_at`) should pass it explicitly. */
export function writeGuaranteeManifest(
  cfg: CompiledConfig,
  outPath: string,
  generatedAt: string = new Date().toISOString(),
): void {
  const manifest = buildGuaranteeManifest(cfg, { generatedAt });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadCompiledConfig(args.configPath);
  writeGuaranteeManifest(cfg, args.outPath);
  console.log(`Wrote guarantee manifest to ${args.outPath}`);
}
