// tools/_ingest-public-dataset-parsers.ts — Q60 Slice 1 public-dataset
// ingestion: raw-file parsers (extracted verbatim from
// tools/ingest-public-dataset.ts during a behavior-preserving split).

import * as fs from 'node:fs';

import {
  type BurstGPTRawRow, type AzureLLMRawRow, type MooncakeRawRow,
  type HuggingFaceLMSYSArenaRawRow,
} from './ingest-real-trace.js';

// ── Raw-file parsers ─────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  // Minimal CSV split — handles unquoted fields. Real datasets here
  // (BurstGPT + Azure) don't use quoted fields with commas, so the
  // simple split is correct.
  return line.split(',').map((s) => s.trim());
}

export function parseBurstGPTCsv(filePath: string, rowLimit?: number): BurstGPTRawRow[] {
  // Schema: Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = {
    timestamp: header.indexOf('Timestamp'),
    model: header.indexOf('Model'),
    requestTokens: header.indexOf('Request tokens'),
    responseTokens: header.indexOf('Response tokens'),
    totalTokens: header.indexOf('Total tokens'),
    logType: header.indexOf('Log Type'),
  };
  if (idx.timestamp < 0 || idx.requestTokens < 0 || idx.responseTokens < 0) {
    throw new Error(
      `BurstGPT CSV header missing required columns: ${JSON.stringify(header)}. `
      + 'Expected Timestamp + Request tokens + Response tokens at minimum.',
    );
  }
  const rows: BurstGPTRawRow[] = [];
  const limit = rowLimit ?? lines.length;
  for (let i = 1; i < lines.length && rows.length < limit; i++) {
    const f = parseCsvLine(lines[i]);
    rows.push({
      timestamp_s: parseFloat(f[idx.timestamp]),
      model: idx.model >= 0 ? f[idx.model] : undefined,
      request_tokens: parseInt(f[idx.requestTokens], 10),
      response_tokens: parseInt(f[idx.responseTokens], 10),
      total_tokens: idx.totalTokens >= 0 ? parseInt(f[idx.totalTokens], 10) : undefined,
      log_type: idx.logType >= 0 ? f[idx.logType] : undefined,
    });
  }
  return rows;
}

export function parseAzureLLMCsv(filePath: string, rowLimit?: number): AzureLLMRawRow[] {
  // Schema: TIMESTAMP,ContextTokens,GeneratedTokens
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = {
    timestamp: header.indexOf('TIMESTAMP'),
    contextTokens: header.indexOf('ContextTokens'),
    generatedTokens: header.indexOf('GeneratedTokens'),
  };
  if (idx.timestamp < 0 || idx.generatedTokens < 0) {
    throw new Error(
      `Azure LLM CSV header missing required columns: ${JSON.stringify(header)}. `
      + 'Expected TIMESTAMP + GeneratedTokens at minimum.',
    );
  }
  const rows: AzureLLMRawRow[] = [];
  const limit = rowLimit ?? lines.length;
  for (let i = 1; i < lines.length && rows.length < limit; i++) {
    const f = parseCsvLine(lines[i]);
    rows.push({
      // Pass raw CamelCase fields; mapAzureLLMRows normalizes via
      // Phase-1.2 field-aliasing (parseAzureTimestamp handles ISO
      // datetime parsing).
      TIMESTAMP: f[idx.timestamp],
      ContextTokens: idx.contextTokens >= 0 ? parseInt(f[idx.contextTokens], 10) : 0,
      GeneratedTokens: parseInt(f[idx.generatedTokens], 10),
    });
  }
  return rows;
}

export function parseMooncakeJsonl(filePath: string, rowLimit?: number): MooncakeRawRow[] {
  // Each line is a JSON object: {"timestamp": ..., "input_length": ...,
  // "output_length": ..., "hash_ids": [...]}
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').filter((l) => l.trim().length > 0);
  const rows: MooncakeRawRow[] = [];
  const limit = rowLimit ?? lines.length;
  for (let i = 0; i < lines.length && rows.length < limit; i++) {
    const obj = JSON.parse(lines[i]);
    rows.push({
      timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : undefined,
      timestamp_ms: typeof obj.timestamp_ms === 'number' ? obj.timestamp_ms : undefined,
      input_length: obj.input_length ?? 0,
      output_length: obj.output_length ?? 0,
      hash_ids: Array.isArray(obj.hash_ids) ? obj.hash_ids : [],
    });
  }
  return rows;
}

// ── Q62 Slice 2 H1 raw-file parser (HF-only) ─────────────────────

/** RFC-4180 CSV streaming record parser via per-row callback. Handles
 *  quoted fields with embedded commas + newlines + escaped double-
 *  quotes (`""`). Streams per-record via callback to avoid 176MB+
 *  whole-file allocation on large datasets like HF LMSYS Arena
 *  train.csv (lmsys-arena-human-preference-55k 57k rows × ~3KB each).
 *  Caller returns false to short-circuit (e.g., when rowLimit reached). */
function streamRfc4180Records(filePath: string, onRecord: (row: string[]) => boolean): void {
  const buf = Buffer.alloc(64 * 1024);  // 64KB read chunks
  const fd = fs.openSync(filePath, 'r');
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let prevWasQuote = false;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      const chunk = buf.toString('utf8', 0, bytesRead);
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (inQuotes) {
          if (ch === '"') {
            // Possible escaped quote — peek next char.
            if (i + 1 < chunk.length) {
              if (chunk[i + 1] === '"') {
                cell += '"';
                i++;
              } else {
                inQuotes = false;
              }
            } else {
              // Quote at chunk boundary: defer decision to next chunk.
              prevWasQuote = true;
            }
          } else if (prevWasQuote) {
            // Previous chunk ended on a quote in inQuotes; this char
            // resolves it. If this char is also " → escaped quote.
            if (ch === '"') {
              cell += '"';
            } else {
              inQuotes = false;
              i--;  // re-process this char in the !inQuotes branch
            }
            prevWasQuote = false;
          } else {
            cell += ch;
          }
        } else {
          if (ch === '"') {
            inQuotes = true;
          } else if (ch === ',') {
            row.push(cell);
            cell = '';
          } else if (ch === '\n' || ch === '\r') {
            // CRLF: skip the \n if previous was \r and we're at chunk boundary.
            if (ch === '\r' && i + 1 < chunk.length && chunk[i + 1] === '\n') i++;
            row.push(cell);
            cell = '';
            if (row.length > 1 || row[0] !== '') {
              if (!onRecord(row)) return;
            }
            row = [];
          } else {
            cell += ch;
          }
        }
      }
    }
    // Final cell + row (no trailing newline).
    if (cell.length > 0 || row.length > 0) {
      row.push(cell);
      if (row.length > 1 || row[0] !== '') {
        onRecord(row);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** HuggingFace LMSYS Arena CSV parser (post-Q62 LS-1 schema-drift
 *  H1 redraft). Expected format: CSV with header
 *  `id,model_a,model_b,prompt,response_a,response_b,winner_model_a,
 *  winner_model_b,winner_tie` (verified empirically at
 *  lmsys/lmsys-arena-human-preference-55k train.csv 176MB; per Q62 LS-1
 *  Phase 1.2 schema-drift diagnostic). */
export function parseHuggingFaceLMSYSArenaCsv(
  filePath: string, rowLimit?: number,
): HuggingFaceLMSYSArenaRawRow[] {
  const rows: HuggingFaceLMSYSArenaRawRow[] = [];
  const limit = rowLimit ?? Infinity;
  let header: string[] | null = null;
  let idx: Record<string, number> = {};
  streamRfc4180Records(filePath, (record) => {
    if (header === null) {
      header = record.map((s) => s.trim());
      idx = {
        id: header.indexOf('id'),
        model_a: header.indexOf('model_a'),
        model_b: header.indexOf('model_b'),
        prompt: header.indexOf('prompt'),
        response_a: header.indexOf('response_a'),
        response_b: header.indexOf('response_b'),
        winner_model_a: header.indexOf('winner_model_a'),
        winner_model_b: header.indexOf('winner_model_b'),
        winner_tie: header.indexOf('winner_tie'),
      };
      if (idx.winner_model_a < 0 || idx.winner_model_b < 0 || idx.winner_tie < 0
          || idx.prompt < 0 || idx.response_a < 0 || idx.response_b < 0) {
        throw new Error(
          `HuggingFace LMSYS Arena CSV header missing required columns: ${JSON.stringify(header)}. `
          + 'Expected id, model_a, model_b, prompt, response_a, response_b, winner_model_a, '
          + 'winner_model_b, winner_tie per lmsys-arena-human-preference-55k schema (Q62 LS-1 H1).',
        );
      }
      return true;  // continue
    }
    if (rows.length >= limit) return false;  // short-circuit
    rows.push({
      id: idx.id >= 0 ? record[idx.id] : '',
      model_a: record[idx.model_a],
      model_b: record[idx.model_b],
      prompt: record[idx.prompt],
      response_a: record[idx.response_a],
      response_b: record[idx.response_b],
      winner_model_a: parseInt(record[idx.winner_model_a], 10) === 1,
      winner_model_b: parseInt(record[idx.winner_model_b], 10) === 1,
      winner_tie: parseInt(record[idx.winner_tie], 10) === 1,
    });
    return rows.length < limit;
  });
  return rows;
}
