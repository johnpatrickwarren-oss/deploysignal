// studies/twin-aa-real/infra/scripts/loadgen.mjs — the study's traffic source (R3): a seeded, fixed-rate
// HTTP client against one lane's ALB. Records its seed, rate, mix and client timeout (Amendment 2 (a)).
//   node loadgen.mjs --url http://<alb-dns> --rps 40 --seed 20261001 [--duration-s 0] [--timeout-ms 5000] [--log loadgen-l0.ndjson]
// The mix is two paths in a fixed 3:1 ratio drawn from a seeded generator; inter-arrival times are
// exponential at the target rate from the same generator, so a run's request stream is a function of
// (seed, start time). Keep-alive is on. One summary line per minute to the log (counts by status class,
// timeouts, p50/p99 client latency) — these are the client's view, not the ALB's; the ALB's CloudWatch
// series remain the study's metrics.
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url'); const RPS = Number(arg('--rps', '40')); const SEED = Number(arg('--seed', '1'));
const DURATION_S = Number(arg('--duration-s', '0')); const TIMEOUT_MS = Number(arg('--timeout-ms', '5000'));
const LOG = arg('--log', `loadgen-${SEED}.ndjson`);
if (!URL_ || !(RPS > 0) || !Number.isInteger(SEED)) { console.error('usage: --url http://host [--rps N] [--seed K] [--duration-s S] [--timeout-ms M] [--log f]'); process.exit(2); }

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(SEED);
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const base = new URL(URL_);
const paths = ['/', '/', '/', '/work'];
let counts = { total: 0, s2xx: 0, s5xx: 0, other: 0, timeouts: 0, errors: 0 }; let lat = [];
const t0 = Date.now();
appendFileSync(LOG, JSON.stringify({ t: new Date(t0).toISOString(), event: 'start', url: URL_, rps: RPS, seed: SEED, timeout_ms: TIMEOUT_MS, mix: { '/': 0.75, '/work': 0.25 }, node: process.version }) + '\n');

function one() {
  const path = paths[Math.floor(rng() * paths.length)];
  const t = process.hrtime.bigint();
  const req = http.request({ host: base.hostname, port: base.port || 80, path, method: 'GET', agent, timeout: TIMEOUT_MS }, (res) => {
    res.resume(); res.on('end', () => { counts.total++; const ms = Number(process.hrtime.bigint() - t) / 1e6; lat.push(ms); if (res.statusCode >= 200 && res.statusCode < 300) counts.s2xx++; else if (res.statusCode >= 500) counts.s5xx++; else counts.other++; });
  });
  req.on('timeout', () => { counts.timeouts++; req.destroy(new Error('timeout')); });
  req.on('error', () => { counts.errors++; });
  req.end();
}
function schedule() {
  if (DURATION_S > 0 && Date.now() - t0 > DURATION_S * 1000) { flush('end'); process.exit(0); }
  one();
  const gap = -Math.log(1 - rng()) / RPS * 1000;   // exponential inter-arrival at RPS
  setTimeout(schedule, gap);
}
function flush(event = 'minute') {
  const s = lat.slice().sort((a, b) => a - b); const q = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
  appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), event, ...counts, p50_ms: q(0.5), p99_ms: q(0.99) }) + '\n');
  counts = { total: 0, s2xx: 0, s5xx: 0, other: 0, timeouts: 0, errors: 0 }; lat = [];
}
setInterval(flush, 60000);
process.on('SIGINT', () => { flush('sigint'); process.exit(0); });
schedule();
