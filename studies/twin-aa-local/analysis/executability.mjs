// studies/twin-aa-local/analysis/executability.mjs — Amendment 1 (PREREGISTRATION.md, 2026-09-27):
// (c) the void rule for host suspension, and (d) the report-only upstream-error split check.
// Pure functions; the harness uses powerLogWindow to write power-log.txt, and summarize.mjs uses the
// rest on the run directory.

/** Amendment 1 (c)2: a scored tick longer than this voids the run. */
export const TICK_WALL_BOUND_MS = 2000;

const LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) (\S+)/;

function lineTime(line) {
  const m = LINE.exec(line);
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : null;
}

/** The lines of `pmset -g log` stamped within [start, end] (ms since epoch), compared to the second. */
export function powerLogWindow(text, startMs, endMs) {
  const lo = Math.floor(startMs / 1000) * 1000;
  const hi = Math.ceil(endMs / 1000) * 1000;
  const kept = [];
  for (const line of text.split('\n')) {
    const t = lineTime(line);
    if (t !== null && t >= lo && t <= hi) kept.push(line);
  }
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** Lines whose event type (the column after the timezone) is Sleep or DarkWake. */
export function suspensionEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m && (m[5] === 'Sleep' || m[5] === 'DarkWake')) out.push({ at: `${m[1]} ${m[2]} ${m[3]}${m[4]}`, type: m[5], line });
  }
  return out;
}

/**
 * Why the run is void under Amendment 1 (c); empty means executable.
 * powerLog: the text of power-log.txt, or null if it is missing. cells: the raw cell objects.
 */
export function voidReasons({ powerLog, cells }) {
  const reasons = [];
  if (powerLog === null) reasons.push('power log unavailable (power-log.txt missing)');
  else for (const e of suspensionEvents(powerLog)) reasons.push(`power log: ${e.type} at ${e.at}`);
  for (const c of cells) {
    for (const r of c.runs) {
      for (const t of r.ticks) {
        if (typeof t.ms !== 'number') reasons.push(`${c.name} run ${r.run} tick ${t.t}: no wall duration recorded`);
        else if (t.ms > TICK_WALL_BOUND_MS) reasons.push(`${c.name} run ${r.run} tick ${t.t}: ${t.ms} ms > ${TICK_WALL_BOUND_MS} ms`);
      }
    }
  }
  return reasons;
}

/** Amendment 1 (d): per-arm upstream-error totals and, per error tick, z against the tick's traffic share. */
export function upstreamSplit(runs) {
  let canary = 0;
  let control = 0;
  const ticks = [];
  for (const r of runs) {
    for (const t of r.ticks) {
      canary += t.uc;
      control += t.uk;
      const U = t.uc + t.uk;
      if (U === 0) continue;
      const s = t.nc / (t.nc + t.nk);
      const sd = Math.sqrt(U * s * (1 - s));
      const z = sd > 0 ? (t.uc - U * s) / sd : null;
      ticks.push({ run: r.run, t: t.t, uc: t.uc, uk: t.uk, nc: t.nc, nk: t.nk, z, near: z !== null && Math.abs(z) <= 3 });
    }
  }
  return { canary, control, ticks };
}
