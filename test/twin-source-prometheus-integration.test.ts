// test/twin-source-prometheus-integration.test.ts — Plan C task 3, opt-in: the Prometheus twin
// source against a real prom/prometheus container scraping a synthetic exporter on the host.
//
// Skipped unless DS_PROM_INTEGRATION=1 (needs a running Docker daemon and the prom/prometheus
// image or network to pull it). Takes about 30 s. With DS_PROM_BIN set to a prometheus binary,
// the same test runs that binary on the host instead of a container.
//
//   DS_PROM_INTEGRATION=1 node --test test/twin-source-prometheus-integration.test.js
//   DS_PROM_INTEGRATION=1 DS_PROM_BIN=/path/to/prometheus node --test test/twin-source-prometheus-integration.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

import { PrometheusTwinSource, histogramExceedance } from '../service/sources/prometheus';
import { assertTwinTickBody, isRateObservationBody } from '../service/sources/twin-contract';

const ENABLED = process.env.DS_PROM_INTEGRATION === '1';
const IMAGE = process.env.DS_PROM_IMAGE ?? 'prom/prometheus:latest';
const BIN = process.env.DS_PROM_BIN;

function writeConfig(dir: string, target: string): void {
  fs.writeFileSync(path.join(dir, 'prometheus.yml'), [
    'global: { scrape_interval: 1s, evaluation_interval: 1s }',
    'scrape_configs:',
    '  - job_name: twin',
    `    static_configs: [{ targets: ["${target}"] }]`,
  ].join('\n'));
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** Start Prometheus scraping the exporter; returns its base URL and a stop function. */
async function startPrometheus(dir: string, exporterPort: number): Promise<{ baseUrl: string; stop: () => void }> {
  if (BIN) {
    writeConfig(dir, `127.0.0.1:${exporterPort}`);
    const port = await freePort();
    const child = spawn(BIN, [
      `--config.file=${path.join(dir, 'prometheus.yml')}`,
      `--storage.tsdb.path=${path.join(dir, 'data')}`,
      `--web.listen-address=127.0.0.1:${port}`,
    ], { stdio: 'ignore' });
    return { baseUrl: `http://127.0.0.1:${port}`, stop: () => { child.kill(); } };
  }
  writeConfig(dir, `host.docker.internal:${exporterPort}`);
  const container = execFileSync('docker', [
    'run', '-d', '--rm', '-p', '127.0.0.1::9090', '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${dir}:/etc/prometheus-it:ro`, IMAGE, '--config.file=/etc/prometheus-it/prometheus.yml',
  ], { encoding: 'utf8' }).trim();
  const stop = (): void => { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); };
  try {
    const mapped = execFileSync('docker', ['port', container, '9090/tcp'], { encoding: 'utf8' }).trim().split('\n')[0];
    return { baseUrl: `http://${mapped}`, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

/** Exposition text: per arm, 20 req/s; canary 5% 5xx and 30% slower than 0.5 s, control 2% and 10%. */
function exposition(startMs: number): string {
  const s = (Date.now() - startMs) / 1000;
  const lines: string[] = [
    '# TYPE http_requests_total counter',
    '# TYPE http_request_duration_seconds histogram',
  ];
  const arms = { canary: { err: 0.05, slow: 0.3 }, baseline: { err: 0.02, slow: 0.1 } };
  for (const [track, p] of Object.entries(arms)) {
    const total = Math.floor(20 * s);
    const errors = Math.floor(total * p.err);
    const fast = total - Math.floor(total * p.slow);
    lines.push(`http_requests_total{track="${track}",code="200"} ${total - errors}`);
    lines.push(`http_requests_total{track="${track}",code="500"} ${errors}`);
    lines.push(`http_request_duration_seconds_bucket{track="${track}",le="0.5"} ${fast}`);
    lines.push(`http_request_duration_seconds_bucket{track="${track}",le="+Inf"} ${total}`);
    lines.push(`http_request_duration_seconds_count{track="${track}"} ${total}`);
    lines.push(`http_request_duration_seconds_sum{track="${track}"} ${total * 0.3}`);
  }
  return lines.join('\n') + '\n';
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timed out waiting for Prometheus');
}

test('Prometheus twin source against a real prom/prometheus container', { skip: !ENABLED && 'set DS_PROM_INTEGRATION=1' }, async () => {
  const startMs = Date.now();
  const exporter = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(exposition(startMs));
  });
  await new Promise<void>((r) => exporter.listen(0, '0.0.0.0', r));
  const exporterPort = (exporter.address() as AddressInfo).port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-prom-it-'));
  let prom: { baseUrl: string; stop: () => void } | undefined;
  try {
    prom = await startPrometheus(dir, exporterPort);
    const baseUrl = prom.baseUrl;

    const src = new PrometheusTwinSource({
      baseUrl,
      fetch: (url, init) => fetch(url, init),
      arms: { canary: 'track="canary"', control: 'track="baseline"' },
      requests: 'sum(increase(http_requests_total{$arm}[$window]))',
      metrics: [
        { id: 'http_5xx', kind: 'rate', events: 'sum(increase(http_requests_total{$arm,code="500"}[$window]))', total: 'sum(increase(http_requests_total{$arm}[$window]))' },
        histogramExceedance('slow', 'http_request_duration_seconds', '0.5'),
        { id: 'inflight', kind: 'sign', expr: 'sum(rate(http_request_duration_seconds_sum{$arm}[$window]))' },
      ],
    });

    // 20 s of scrapes, then a 15 s window ending now.
    await waitFor(async () => {
      const r = await fetch(`${baseUrl}/api/v1/query?query=${encodeURIComponent('count_over_time(up[30s])')}`);
      const j = (await r.json()) as { data?: { result?: Array<{ value: [number, string] }> } };
      return Number(j.data?.result?.[0]?.value[1] ?? 0) >= 20;
    }, 90_000);

    const end = Math.floor(Date.now() / 1000) * 1000;
    const body = await src.fetchTick(end - 15_000, end);
    assertTwinTickBody(body);
    assert.ok(body.canary_requests > 150 && body.control_requests > 150, JSON.stringify(body));
    const err = body.observations.http_5xx;
    const slow = body.observations.slow;
    assert.ok(err && isRateObservationBody(err) && slow && isRateObservationBody(slow), JSON.stringify(body));
    assert.ok(err.canary_events > err.control_events, JSON.stringify(err));
    assert.ok(slow.canary_events > slow.control_events, JSON.stringify(slow));
    assert.ok('inflight' in body.observations);
  } finally {
    prom?.stop();
    exporter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
