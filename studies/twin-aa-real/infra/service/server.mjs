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

// 2026-10-twin-aa-real-2 §1.1: an optional seeded lognormal delay per non-health request so the
// service's p99 sits well above task-placement noise. LATENCY_MEDIAN_MS (default 0 = no delay, the
// first study's behaviour) and LATENCY_SIGMA (default 0.4). The generator is mulberry32 seeded from
// ARM and the process start time; the seed is reported on /healthz. Same image in every arm.
const LATENCY_MEDIAN_MS = Number(process.env.LATENCY_MEDIAN_MS ?? 0);
const LATENCY_SIGMA = Number(process.env.LATENCY_SIGMA ?? 0.4);
if (!(LATENCY_MEDIAN_MS >= 0 && LATENCY_MEDIAN_MS < 10_000)) { console.error(`LATENCY_MEDIAN_MS must be in [0, 10000), got ${process.env.LATENCY_MEDIAN_MS}`); process.exit(2); }
if (!(LATENCY_SIGMA >= 0 && LATENCY_SIGMA < 3)) { console.error(`LATENCY_SIGMA must be in [0, 3), got ${process.env.LATENCY_SIGMA}`); process.exit(2); }

// 2026-10-twin-fault-shapes AB-reset: RESET_FRACTION (default 0) destroys the socket without a reply on an
// evenly spaced fraction of requests, half a period away from the 503 schedule so the two never coincide.
// The ALB then answers the client with an ELB-generated 502, which HTTPCode_Target_5XX_Count does not count.
const RESET_FRACTION = Number(process.env.RESET_FRACTION ?? 0);
if (!(RESET_FRACTION >= 0 && RESET_FRACTION < 1)) { console.error(`RESET_FRACTION must be in [0, 1), got ${process.env.RESET_FRACTION}`); process.exit(2); }

let n = 0;
const startedAt = new Date().toISOString();
const seed = (() => { let h = 2166136261 >>> 0; for (const c of `${ARM}|${startedAt}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; })();
const rng = (() => { let a = seed; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const gaussian = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
const delayMs = () => (LATENCY_MEDIAN_MS > 0 ? LATENCY_MEDIAN_MS * Math.exp(LATENCY_SIGMA * gaussian()) : 0);

/** A little CPU per request so latency is a real quantity, deterministic in the request counter. */
function work(k) { let x = 0; for (let i = 0; i < 2000 + (k % 500); i++) x += Math.sqrt(i); return x; }

const server = createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, arm: ARM, fault_503_fraction: FRACTION, reset_fraction: RESET_FRACTION, latency_median_ms: LATENCY_MEDIAN_MS, latency_sigma: LATENCY_SIGMA, seed, started_at: startedAt }) + '\n'); return; }
  n++;
  if (RESET_FRACTION > 0 && Math.floor(n * RESET_FRACTION + 0.5) > Math.floor((n - 1) * RESET_FRACTION + 0.5)) { req.socket.destroy(); return; }
  const fault = Math.floor(n * FRACTION) > Math.floor((n - 1) * FRACTION);
  const x = work(n);
  const body = JSON.stringify({ arm: ARM, n, x: Math.round(x), fault, started_at: startedAt });
  const reply = () => { res.writeHead(fault ? 503 : 200, { 'content-type': 'application/json', 'x-arm': ARM }); res.end(body); };
  const d = delayMs();
  if (d > 0) setTimeout(reply, d); else reply();
});
server.keepAliveTimeout = 65000;   // above the ALB's 60 s idle timeout, so the ALB closes first
server.listen(PORT, () => console.log(`twin-aa service arm=${ARM} port=${PORT} fault_503_fraction=${FRACTION} latency_median_ms=${LATENCY_MEDIAN_MS} latency_sigma=${LATENCY_SIGMA} reset_fraction=${RESET_FRACTION} seed=${seed}`));
