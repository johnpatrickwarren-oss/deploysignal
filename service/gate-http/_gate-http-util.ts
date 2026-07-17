// service/gate-http/_gate-http-util.ts — Task 7 (WS4 session-durability-
// argo plan): zero-dep node:http helpers. Conventions copied from
// tools/claude-proxy.js (size-capped readBody, JSON response helper) —
// the plan's own precedent for "zero new deps confirmed feasible".

import type * as http from 'http';
import * as crypto from 'crypto';

/** Same cap as tools/claude-proxy.js's readBody. */
export const MAX_BODY_BYTES = 200_000;

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds 200KB limit');
    this.name = 'BodyTooLargeError';
  }
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return; // already rejected; keep draining so the
      // socket isn't left backpressured, but don't destroy it — the
      // caller still needs to write a 413 response on this connection.
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** Constant-time-ish token compare for the optional shared-secret
 *  boundary (DS_GATE_SHARED_SECRET). Length is compared via
 *  crypto.timingSafeEqual on equal-length buffers only; a length
 *  mismatch still burns a comparable timingSafeEqual call (against the
 *  token itself) before returning false, so a length probe doesn't get a
 *  materially cheaper code path than a full mismatch. This is a
 *  localhost-grade boundary (see server.ts header), not a claim of
 *  rigorous side-channel security. */
// m4 fix (final-review): deploy_ref and session_id both flow into
// filenames (SessionStore's `sess-${deploy_ref}-${ts}` id convention,
// `sessions/<id>.json` / `<id>.verdicts.jsonl`) — an unrestricted value
// is a path-traversal vector (`../../etc/passwd`, a URL-encoded `%2F`
// that decodes to a literal `/`, etc). Restrict both to a safe charset
// at the router/handler boundary, before either value reaches the
// store. `.` and `..` alone are rejected too (defense in depth — no
// slash is required for `..` to be meaningful once embedded in a
// caller-controlled path).
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER_RE.test(value) && value !== '.' && value !== '..';
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
