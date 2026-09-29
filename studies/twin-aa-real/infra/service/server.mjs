// studies/twin-aa-real/infra/service/server.mjs — the synthetic "old version" behind the ALB.
//
// One code path in every arm. `FAULT_503_FRACTION` (default 0) makes the process return 503 on an
// evenly spaced fraction of its requests, counted per process: request n is a 503 iff
// floor(n·f) > floor((n−1)·f). Both arms run the same fraction in the A/A (R4, disclosed); the
// AB-5xx cell raises it on the canary service only. `ARM` is a label echoed in the body and a header
// so a request can be attributed in logs; it changes nothing else.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const FRACTION = Number(process.env.FAULT_503_FRACTION ?? 0);
const ARM = process.env.ARM ?? 'unlabelled';
if (!(FRACTION >= 0 && FRACTION < 1)) { console.error(`FAULT_503_FRACTION must be in [0, 1), got ${process.env.FAULT_503_FRACTION}`); process.exit(2); }

let n = 0;
const startedAt = new Date().toISOString();

/** A little CPU per request so latency is a real quantity, deterministic in the request counter. */
function work(k) { let x = 0; for (let i = 0; i < 2000 + (k % 500); i++) x += Math.sqrt(i); return x; }

const server = createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok\n'); return; }
  n++;
  const fault = Math.floor(n * FRACTION) > Math.floor((n - 1) * FRACTION);
  const x = work(n);
  const body = JSON.stringify({ arm: ARM, n, x: Math.round(x), fault, started_at: startedAt });
  res.writeHead(fault ? 503 : 200, { 'content-type': 'application/json', 'x-arm': ARM });
  res.end(body);
});
server.keepAliveTimeout = 65000;   // above the ALB's 60 s idle timeout, so the ALB closes first
server.listen(PORT, () => console.log(`twin-aa service arm=${ARM} port=${PORT} fault_503_fraction=${FRACTION}`));
