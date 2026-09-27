// studies/twin-aa-local/harness/service.mjs — the system under test (PREREGISTRATION.md §1). One
// file, launched twice (control, canary) with the same code. Per request: status 503 with
// probability p · fault-5xx-mult, else 200; wait max(1, round(8 ms · exp(0.5 Z) · fault-latency-mult))
// ms. Draws are keyed on (seed, run, tick, idx) from the headers the router forwards.
//
//   node service.mjs --port 18201 --seed 123 [--fault-5xx-mult 2] [--fault-latency-mult 1.2]

import http from 'node:http';
import { keyedUniform, keyedNormal, parseArgs, STREAM } from './_keyed.mjs';

const P_5XX = 0.02;
const LAT_MEDIAN_MS = 8;
const LAT_SIGMA = 0.5;

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port);
const seed = Number(args.seed);
const errMult = Number(args['fault-5xx-mult'] ?? 1);
const latMult = Number(args['fault-latency-mult'] ?? 1);
if (![port, seed, errMult, latMult].every(Number.isFinite)) throw new Error('service: numeric arguments required');

const server = http.createServer((req, res) => {
  const run = Number(req.headers['x-aa-run']);
  const tick = Number(req.headers['x-aa-tick']);
  const idx = Number(req.headers['x-aa-idx']);
  if (![run, tick, idx].every(Number.isInteger)) {
    res.writeHead(400);
    res.end('missing x-aa-run/x-aa-tick/x-aa-idx');
    return;
  }
  const bad = keyedUniform(seed, run, tick, idx, STREAM.ERR) < P_5XX * errMult;
  const ms = LAT_MEDIAN_MS * Math.exp(LAT_SIGMA * keyedNormal(seed, run, tick, idx, STREAM.LAT)) * latMult;
  setTimeout(() => {
    res.writeHead(bad ? 503 : 200, { 'content-type': 'text/plain' });
    res.end(bad ? 'unavailable' : 'ok');
  }, Math.max(1, Math.round(ms)));
});
server.keepAliveTimeout = 60_000;
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${port}\n`);
});
const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
