// studies/twin-aa-local/harness/router.mjs — randomized per-request routing (PREREGISTRATION.md §1).
// Request (run, tick, idx) goes to the canary iff keyedUniform(seed, run, tick, idx) < w, a function
// of the key only. Forwards over localhost HTTP, measures upstream latency with hrtime, and
// aggregates per (run, tick, arm). An upstream error or a 2000 ms timeout is a 5xx and an
// upstream_error.
//
//   node router.mjs --port 18200 --control-port 18201 --canary-port 18202 --w 0.5 --seed 123
//   GET /agg?run=R&tick=T   -> {canary:{requests,e5xx,upstream_errors,p99,latency_sum}, control:{…}}
//                              (removes the aggregate)

import http from 'node:http';
import { keyedUniform, parseArgs, STREAM } from './_keyed.mjs';

const UPSTREAM_TIMEOUT_MS = 2000;

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port);
const ports = { control: Number(args['control-port']), canary: Number(args['canary-port']) };
const w = Number(args.w);
const seed = Number(args.seed);
if (![port, ports.control, ports.canary, w, seed].every(Number.isFinite)) throw new Error('router: numeric arguments required');

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const aggs = new Map(); // "run:tick" -> {canary: ArmAgg, control: ArmAgg}

function armAgg() {
  return { requests: 0, e5xx: 0, upstream_errors: 0, latencies: [] };
}

function record(run, tick, arm, status, ms, upstreamError) {
  const key = `${run}:${tick}`;
  let a = aggs.get(key);
  if (!a) {
    a = { canary: armAgg(), control: armAgg() };
    aggs.set(key, a);
  }
  const x = a[arm];
  x.requests += 1;
  if (status >= 500) x.e5xx += 1;
  if (upstreamError) x.upstream_errors += 1;
  x.latencies.push(ms);
}

/** Nearest-rank p99; null for an empty arm. */
function p99(xs) {
  if (xs.length === 0) return null;
  const s = Float64Array.from(xs).sort();
  return s[Math.ceil(0.99 * s.length) - 1];
}

function summarize(x) {
  let sum = 0;
  for (const v of x.latencies) sum += v;
  return { requests: x.requests, e5xx: x.e5xx, upstream_errors: x.upstream_errors, p99: p99(x.latencies), latency_sum: sum };
}

function forward(req, res) {
  const run = Number(req.headers['x-aa-run']);
  const tick = Number(req.headers['x-aa-tick']);
  const idx = Number(req.headers['x-aa-idx']);
  if (![run, tick, idx].every(Number.isInteger)) {
    res.writeHead(400);
    res.end('missing x-aa-run/x-aa-tick/x-aa-idx');
    return;
  }
  const arm = keyedUniform(seed, run, tick, idx, STREAM.ROUTE) < w ? 'canary' : 'control';
  const t0 = process.hrtime.bigint();
  let done = false;
  const finish = (status, upstreamError) => {
    if (done) return;
    done = true;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    record(run, tick, arm, status, ms, upstreamError);
    res.writeHead(status, { 'x-aa-arm': arm });
    res.end();
  };
  const up = http.request({
    host: '127.0.0.1', port: ports[arm], path: '/work', method: 'GET', agent,
    headers: { 'x-aa-run': String(run), 'x-aa-tick': String(tick), 'x-aa-idx': String(idx) },
  }, (ur) => {
    ur.resume();
    ur.on('end', () => finish(ur.statusCode, false));
    ur.on('error', () => finish(502, true));
  });
  up.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    up.destroy();
    finish(504, true);
  });
  up.on('error', () => finish(502, true));
  up.end();
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/agg')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const key = `${Number(q.get('run'))}:${Number(q.get('tick'))}`;
    const a = aggs.get(key) ?? { canary: armAgg(), control: armAgg() };
    aggs.delete(key);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ canary: summarize(a.canary), control: summarize(a.control) }));
    return;
  }
  forward(req, res);
});
server.keepAliveTimeout = 60_000;
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${port}\n`);
});
const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
