// tools/_ingest-public-dataset-cli.ts — Q60 Slice 1 public-dataset
// ingestion: CLI argument parsing (extracted verbatim from
// tools/ingest-public-dataset.ts during a behavior-preserving split).

import type { SupportedDataset } from './_ingest-public-dataset-types.js';

export interface CliArgs {
  dataset: SupportedDataset;
  rawDataPath: string;
  outputBaselineDir: string;
  rowLimit?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
  /** C37: BurstGPT v2 full-tick-range mapper. */
  burstgptV2?: boolean;
  /** C37: repeatable --provenance-line entries for the bundle README. */
  provenanceLine?: string[];
}

/** C37 flags, split from the main switch so parseArgs stays under the
 *  no-complex-functions gate. Returns the argv with the C37 flags consumed. */
function extractC37Flags(argv: string[], out: Partial<CliArgs>): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--burstgpt-v2') {
      out.burstgptV2 = true;
    } else if (argv[i] === '--provenance-line') {
      (out.provenanceLine ??= []).push(argv[i + 1]);
      i++;
    } else {
      rest.push(argv[i]);
    }
  }
  return rest;
}

export function parseArgs(rawArgv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  const argv = extractC37Flags(rawArgv, out);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--dataset':
        if (v !== 'burstgpt' && v !== 'azure_llm_inference' && v !== 'mooncake'
            && v !== 'huggingface_lmsys_arena') {
          throw new Error(
            `--dataset must be one of: burstgpt | azure_llm_inference | mooncake | `
            + `huggingface_lmsys_arena (Q62 Slice 2 H1; alpaserve + deepspeed_fastgen DROPPED); got ${v}`,
          );
        }
        out.dataset = v;
        i++;
        break;
      case '--raw-data-path':
        out.rawDataPath = v;
        i++;
        break;
      case '--output-baseline-dir':
        out.outputBaselineDir = v;
        i++;
        break;
      case '--row-limit':
        out.rowLimit = parseInt(v, 10);
        i++;
        break;
      case '--cost-per-input-token':
        out.costPerInputToken = parseFloat(v);
        i++;
        break;
      case '--cost-per-output-token':
        out.costPerOutputToken = parseFloat(v);
        i++;
        break;

      default:
        if (k.startsWith('--')) throw new Error(`Unknown flag: ${k}`);
    }
  }
  if (!out.dataset || !out.rawDataPath || !out.outputBaselineDir) {
    throw new Error(
      'Required flags: --dataset {burstgpt|azure_llm_inference|mooncake} '
      + '--raw-data-path <path> --output-baseline-dir <dir>. '
      + 'Optional: --row-limit <N> --cost-per-input-token <usd> '
      + '--cost-per-output-token <usd> (BurstGPT cost_req derivation).',
    );
  }
  return out as CliArgs;
}
