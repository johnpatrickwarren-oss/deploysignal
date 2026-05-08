// engine/verdict-groups.ts — Addition #25 (ARCHITECT-REPLY-47) L3b aggregator.
//
// Post-L3 incident-aggregation layer. Consumes the FusedVerdict stream
// from engine/verdict.ts (unchanged per D1) and produces VerdictGroup
// summaries per (deploy_id, window_start_ts). The gating hot path
// remains untouched — FusedVerdicts flow immediately to the orchestrator
// as before; groups are summary/audit-only (D6, zero latency penalty).
//
// Group-close triggers (D2, D5):
//   (a) Window elapsed: new ingest ts > window_start_ts + window_seconds
//   (b) Terminal verdict: caller passes `{ terminal: true }` on ingest
//       (wired to the evaluation.finished lifecycle event in slice-2).
//   (c) flush(): force-close all open groups on shutdown.
//
// Late-arrival semantics (D5): a verdict for a deploy whose prior group
// just closed, arriving within `grace_seconds` and with no new open
// group yet, attaches via `late_arrival_verdicts` + triggers a
// `verdict_group_updated` event (emission wiring lives in slice-2).
//
// Root-cause (D7) and confidence (D8) are recomputed on every ingest so
// a live group's derived fields are always consistent with its
// `firing_verdicts`.

import type { FusedVerdict, VerdictGroup, VerdictGroupId } from './types';

export interface VerdictGroupOpts {
  /** Default 300 (5 min). Overrides CompilerOptions.verdict_group_window_seconds. */
  window_seconds?: number;
  /** Default 300 (5 min). Overrides CompilerOptions.verdict_group_grace_seconds. */
  grace_seconds?: number;
  /** Default 3. Overrides CompilerOptions.verdict_group_confidence_saturation. */
  confidence_saturation?: number;
}

export type VerdictGroupCloseReason = 'window_elapsed' | 'terminal_verdict';

export interface IngestResult {
  /** Group newly closed by this ingest call (window-elapsed rotation
   *  OR terminal verdict). `null` when no close was triggered. */
  closed: VerdictGroup | null;
  /** True when the ingested verdict was attached as a late-arrival to
   *  a previously-closed group (grace-window attach per D5). Consumers
   *  use this to emit `verdict_group_updated` audit events. */
  late_arrival: boolean;
  /** The group (open or closed) the ingested verdict was attributed
   *  to. Matches `closed` when a terminal/window-elapsed close fired
   *  on the same verdict. */
  attributed_group: VerdictGroup;
}

const DEFAULT_WINDOW_SECONDS = 300;
const DEFAULT_GRACE_SECONDS = 300;
const DEFAULT_CONFIDENCE_SATURATION = 3;

export class VerdictGrouper {
  private readonly windowSeconds: number;
  private readonly graceSeconds: number;
  private readonly confidenceSaturation: number;

  private readonly openByDeploy: Map<string, VerdictGroup> = new Map();
  private readonly recentlyClosed: Map<VerdictGroupId, VerdictGroup> = new Map();

  constructor(opts: VerdictGroupOpts = {}) {
    this.windowSeconds = opts.window_seconds ?? DEFAULT_WINDOW_SECONDS;
    this.graceSeconds = opts.grace_seconds ?? DEFAULT_GRACE_SECONDS;
    this.confidenceSaturation = opts.confidence_saturation ?? DEFAULT_CONFIDENCE_SATURATION;
  }

  ingest(
    verdict: FusedVerdict,
    ts_seconds: number,
    opts: { terminal?: boolean } = {},
  ): IngestResult {
    const deployId = verdict.deploy_ref;
    this.evictStaleClosed(ts_seconds);

    let openGroup = this.openByDeploy.get(deployId);
    let closedByThisCall: VerdictGroup | null = null;
    let lateArrival = false;
    let rotated = false;

    if (openGroup && ts_seconds - openGroup.window_start_ts > this.windowSeconds) {
      closedByThisCall = this.closeDeployGroup(deployId, ts_seconds, 'window_elapsed')!;
      openGroup = undefined;
      rotated = true;
    }

    let attributed: VerdictGroup;

    if (!openGroup) {
      // Late-arrival attach is only considered when this call did NOT
      // just rotate (window-elapsed close). A rotation-triggering
      // verdict always opens a new group — it's the first verdict of
      // the next window, not a straggler for the previous one.
      const lateTarget = rotated ? null : this.findRecentClosedForDeploy(deployId, ts_seconds);
      if (lateTarget) {
        lateTarget.late_arrival_verdicts.push(verdict);
        lateTarget.verdicts.push(verdict);
        if (verdict.firing_families.length > 0) lateTarget.firing_verdicts.push(verdict);
        this.recomputeDerived(lateTarget);
        lateArrival = true;
        attributed = lateTarget;
      } else {
        attributed = this.openGroup(deployId, verdict, ts_seconds);
      }
    } else {
      this.appendToOpen(openGroup, verdict);
      attributed = openGroup;
    }

    if (opts.terminal && !lateArrival && !attributed.closed) {
      const terminalClose = this.closeDeployGroup(deployId, ts_seconds, 'terminal_verdict');
      if (terminalClose && !closedByThisCall) closedByThisCall = terminalClose;
    }

    return { closed: closedByThisCall, late_arrival: lateArrival, attributed_group: attributed };
  }

  flush(ts_seconds: number): VerdictGroup[] {
    const closed: VerdictGroup[] = [];
    for (const deployId of Array.from(this.openByDeploy.keys())) {
      const g = this.closeDeployGroup(deployId, ts_seconds, 'window_elapsed');
      if (g) closed.push(g);
    }
    return closed;
  }

  /** Public for test + orchestrator visibility. Does not mutate. */
  openGroupForDeploy(deploy_id: string): VerdictGroup | undefined {
    return this.openByDeploy.get(deploy_id);
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private groupId(deployId: string, window_start_ts: number): VerdictGroupId {
    return `group-${deployId}-${window_start_ts}`;
  }

  private openGroup(deployId: string, verdict: FusedVerdict, ts: number): VerdictGroup {
    const firing = verdict.firing_families.length > 0;
    const group: VerdictGroup = {
      group_id: this.groupId(deployId, ts),
      deploy_id: deployId,
      window_start_ts: ts,
      window_end_ts: ts + this.windowSeconds,
      verdicts: [verdict],
      firing_verdicts: firing ? [verdict] : [],
      root_cause: null,
      confidence: 0,
      late_arrival_verdicts: [],
      closed: false,
      closed_at_ts: null,
    };
    this.recomputeDerived(group);
    this.openByDeploy.set(deployId, group);
    return group;
  }

  private appendToOpen(group: VerdictGroup, verdict: FusedVerdict): void {
    group.verdicts.push(verdict);
    if (verdict.firing_families.length > 0) group.firing_verdicts.push(verdict);
    this.recomputeDerived(group);
  }

  private closeDeployGroup(
    deployId: string,
    ts: number,
    _reason: VerdictGroupCloseReason,
  ): VerdictGroup | null {
    const group = this.openByDeploy.get(deployId);
    if (!group) return null;
    this.openByDeploy.delete(deployId);
    group.closed = true;
    group.closed_at_ts = ts;
    group.window_end_ts = ts;
    this.recentlyClosed.set(group.group_id, group);
    return group;
  }

  private recomputeDerived(group: VerdictGroup): void {
    if (group.firing_verdicts.length === 0) {
      group.root_cause = null;
      group.confidence = 0;
      return;
    }
    // D7: earliest-firing FusedVerdict by tick; tie-break by
    // total_alpha_spent (highest wins). Within a single deploy each
    // tick emits one FusedVerdict, so intra-group tick ties are
    // unexpected — the tie-break exists as a defensive determinism
    // guard rather than an operational branch.
    let earliest = group.firing_verdicts[0];
    for (let i = 1; i < group.firing_verdicts.length; i++) {
      const v = group.firing_verdicts[i];
      if (v.tick < earliest.tick) earliest = v;
      else if (v.tick === earliest.tick && v.total_alpha_spent > earliest.total_alpha_spent) {
        earliest = v;
      }
    }
    group.root_cause = earliest;

    // D8: confidence = min(1, k / K_saturation) where k = count of
    // distinct firing families across ALL firing verdicts in the group.
    const families = new Set<string>();
    for (const fv of group.firing_verdicts) {
      for (const f of fv.firing_families) families.add(f);
    }
    group.confidence = Math.min(1, families.size / this.confidenceSaturation);
  }

  private findRecentClosedForDeploy(deployId: string, ts: number): VerdictGroup | null {
    let best: VerdictGroup | null = null;
    for (const g of this.recentlyClosed.values()) {
      if (g.deploy_id !== deployId) continue;
      if (g.closed_at_ts === null) continue;
      if (ts - g.closed_at_ts > this.graceSeconds) continue;
      if (best === null || g.closed_at_ts > (best.closed_at_ts ?? -Infinity)) best = g;
    }
    return best;
  }

  private evictStaleClosed(ts: number): void {
    for (const [id, g] of this.recentlyClosed) {
      if (g.closed_at_ts === null || ts - g.closed_at_ts > this.graceSeconds) {
        this.recentlyClosed.delete(id);
      }
    }
  }
}
