// studies/twin-aa-local/harness/_keyed.mjs — the counter-based generator every process draws from
// (PREREGISTRATION.md §1): a draw is a pure function of (seed, run, tick, idx, stream), so routing,
// 5xx outcomes and drawn latencies are reproducible whatever order requests arrive in.

function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in (0, 1) keyed on the integers given. */
export function keyedUniform(seed, ...parts) {
  let h = fmix32((seed ^ 0x9e3779b9) >>> 0);
  for (const x of parts) h = fmix32((h + Math.imul((x | 0) + 0x632be5ab, 0x9e3779b1)) >>> 0);
  return (h + 0.5) / 4294967296;
}

/** Standard normal by Box–Muller from two keyed uniforms. */
export function keyedNormal(seed, ...parts) {
  const u1 = keyedUniform(seed, ...parts, 101);
  const u2 = keyedUniform(seed, ...parts, 202);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Stream ids, so the 5xx and latency draws of one request are independent. */
export const STREAM = { ROUTE: 1, ERR: 2, LAT: 3 };

/** Parse `--key value` argv pairs. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
