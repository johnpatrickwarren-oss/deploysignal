#!/usr/bin/env node
'use strict';
// tools/claude-proxy.js — Minimal local http proxy that lets the demo
// (opened from file:// or any localhost origin) call api.anthropic.com
// for the live "Situation summary" without CORS pain or exposing the
// API key to the browser.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node tools/claude-proxy.js
//   Then open demos/demo.html?live=1 — the browser will POST per-tick
//   context to http://localhost:8787/situation and render the result.
//
// Env vars:
//   ANTHROPIC_API_KEY  required
//   CLAUDE_MODEL       optional, default claude-sonnet-4-6
//   CLAUDE_MAX_TOKENS  optional, default 600
//   PORT               optional, default 8787
//
// Endpoints:
//   POST /situation  — body: structured context, response: JSON per schema
//   GET  /health     — sanity check, returns { ok: true, model }
//   OPTIONS *        — CORS preflight allow-all
//
// No external dependencies. Pure Node http/https.

const http  = require('http');
const https = require('https');

const PORT    = parseInt(process.env.PORT || '8787', 10);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOK = parseInt(process.env.CLAUDE_MAX_TOKENS || '600', 10);

if (!API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY env var is not set.');
  console.error('  Run: ANTHROPIC_API_KEY=sk-... node tools/claude-proxy.js');
  process.exit(1);
}

const SYSTEM_PROMPT =
  'You are DeploySignal, an AI deployment decision engine for AI inference systems. ' +
  'Respond ONLY in this exact JSON, no markdown:\n' +
  '{"situation":"2-3 direct sentences: what is wrong, what caused it, how serious",' +
  '"trend":"DETERIORATING|STABLE|RECOVERING|UNKNOWN","trendReason":"short phrase",' +
  '"action":"one specific action right now — include kubectl command if ROLLBACK",' +
  '"actionType":"ROLLBACK|EXTEND|WAIT|PROMOTE|ESCALATE",' +
  '"causalNarrative":"1 sentence on which signal fired first and what cascaded, or null",' +
  '"confidence":"HIGH|MEDIUM|LOW","confidenceReason":"short phrase"}\n' +
  'Be direct. No hedging. Use detector names (slowbleed, mfu_collapse, kv_saturation, etc.).';

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let bytes = 0;
    req.on('data', function (c) {
      bytes += c.length;
      if (bytes > 200000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

const CORS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age':       '600',
};

function callClaude(context) {
  const payload = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOK,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: 'Current deployment state:\n' + JSON.stringify(context, null, 2) }],
  });
  return new Promise(function (resolve, reject) {
    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'content-length':    Buffer.byteLength(payload),
      },
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { return reject(new Error('non-JSON response: ' + body.slice(0, 200))); }
        if (res.statusCode >= 400) {
          return reject(new Error('API ' + res.statusCode + ': ' + ((parsed.error && parsed.error.message) || body.slice(0, 200))));
        }
        const content = parsed.content && parsed.content[0] && parsed.content[0].text;
        if (!content) return reject(new Error('no content in API response'));
        // Trim markdown fences defensively in case the model wraps the JSON.
        const trimmed = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        try { resolve(JSON.parse(trimmed)); }
        catch (e) { reject(new Error('model returned non-JSON: ' + content.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
    return res.end(JSON.stringify({ ok: true, model: MODEL }));
  }
  if (req.method !== 'POST' || req.url !== '/situation') {
    res.writeHead(404, CORS);
    return res.end();
  }
  readBody(req).then(function (body) {
    let ctx;
    try { ctx = JSON.parse(body || '{}'); }
    catch (e) {
      res.writeHead(400, Object.assign({ 'content-type': 'application/json' }, CORS));
      return res.end(JSON.stringify({ error: 'invalid JSON body' }));
    }
    callClaude(ctx).then(function (json) {
      res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
      res.end(JSON.stringify(json));
    }).catch(function (err) {
      console.error('Claude call failed:', err.message);
      res.writeHead(502, Object.assign({ 'content-type': 'application/json' }, CORS));
      res.end(JSON.stringify({ error: err.message }));
    });
  }).catch(function (err) {
    res.writeHead(500, CORS);
    res.end('error: ' + err.message);
  });
});

server.listen(PORT, function () {
  console.error('DeploySignal Claude proxy listening on http://localhost:' + PORT);
  console.error('  Model:    ' + MODEL);
  console.error('  Endpoint: POST /situation');
  console.error('  Health:   GET  /health');
  console.error('Open demos/demo.html?live=1 in your browser.');
});
