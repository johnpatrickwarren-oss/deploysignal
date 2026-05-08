#!/usr/bin/env node
// tools/diagnostic/test-shard-partition.js — Tier 2 CI test sharding helper.
//
// Round-robin partition (`(NR-1) % N`) is unstable: 13 of 133 test files
// account for ~96% of total runtime, and round-robin's deterministic
// alphabetical bucketing concentrates them unevenly (3-way local max-shard
// 1.78× min; 4-way CI max-shard 4× min, blowing through the 10-min target).
//
// This script does longest-processing-time (LPT) bin-packing on the heavy
// files using historical durations, then round-robins the remaining light
// files. Result: ~equal shard wall-clock regardless of shard count.
//
// Usage:
//   node tools/diagnostic/test-shard-partition.js <shard> <total>
// Outputs newline-separated test file paths for the given shard.
//
// Re-measure & update HEAVY_BINS when shard variance regresses (run
// `node --test test/X.test.js` per file, capture wall-clock; LPT-pack
// files >15s into bins).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// LPT-packed heavy files per bin (1-indexed). Durations in seconds from
// local Node 25 native .ts; CI Ubuntu Node 24 with compiled .js scales
// proportionally (the relative ranking is what balances shards). Re-derive
// when test/profile/* files churn or new heavies emerge.
//
// Sum per bin (heavy contribution): ~136-144s. Light files distribute
// ~25s total across 4 bins via round-robin → final per-bin: ~140-150s.
const HEAVY_BINS = {
  1: [
    'profile-streaming-byte-identity.test.js',     // 89.2s
    'compile-worker-thread-parallelization.test.js', // 33.3s
    'profile-audit-reproducibility.test.js',        // 16.2s
  ],
  2: [
    'ville-preservation-per-profile.test.js',       // 86.9s
    'calibrator-extraction-parity.test.js',         // 37.2s
    'profile-family-disable-schema-check.test.js',  // 15.4s
  ],
  3: [
    'compile-parity-pre-post-slice2.test.js',       // 63.6s
    'profile-policy-defaults-routing.test.js',      // 43.6s
    'bundle-loader-metadata.test.js',               // 29.0s
  ],
  4: [
    'profile-batch-characterized-diff.test.js',     // 54.3s
    'profile-v1-set-smoke.test.js',                 // 43.9s
    'compiled-config-family-b-optional.test.js',    // 30.2s
    'compile-perf-baseline.test.js',                // 15.1s
  ],
};

const TOTAL_HEAVY = Object.values(HEAVY_BINS).flat().length;

function main() {
  const shard = parseInt(process.argv[2], 10);
  const total = parseInt(process.argv[3], 10);
  if (!Number.isInteger(shard) || !Number.isInteger(total) || shard < 1 || shard > total) {
    process.stderr.write(`Usage: ${path.basename(process.argv[1])} <shard> <total>\n`);
    process.exit(1);
  }
  if (total !== 4) {
    process.stderr.write(
      `Only total=4 supported (HEAVY_BINS hand-tuned for 4 shards). ` +
      `Got total=${total}.\n`,
    );
    process.exit(1);
  }

  const allFiles = fs.readdirSync('test')
    .filter((f) => f.endsWith('.test.js'))
    .sort();

  const heavySet = new Set(Object.values(HEAVY_BINS).flat());
  const heavyForShard = new Set(HEAVY_BINS[shard]);
  const lightFiles = allFiles.filter((f) => !heavySet.has(f));

  // Round-robin light files; bin index = (i % total) + 1 (1-indexed).
  const lightForShard = lightFiles.filter((_f, i) => (i % total) + 1 === shard);

  const shardFiles = [...heavyForShard, ...lightForShard]
    .map((f) => `test/${f}`)
    .sort();

  // Sanity audit: print to stderr; useful in CI logs.
  process.stderr.write(
    `[shard ${shard}/${total}] heavy=${heavyForShard.size} ` +
    `light=${lightForShard.length} total=${shardFiles.length}\n`,
  );

  process.stdout.write(shardFiles.join('\n') + '\n');
}

main();
