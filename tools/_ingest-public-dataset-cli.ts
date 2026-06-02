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
}

export function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
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
