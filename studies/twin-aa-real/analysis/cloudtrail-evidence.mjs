// analysis/cloudtrail-evidence.mjs — V6/V7 evidence for 2026-10-twin-aa-real (PREREGISTRATION.md §7).
//
// Pulls every CloudTrail WRITE event from the ELB and ECS sources over [--start, --end] (the whole
// cell, account-wide), parses each event's request parameters, assigns it to a lane by the listener,
// target-group, or cluster it names, and writes one redacted JSON file. analyze.mjs then lays these
// events over each run's [arm-ready, runner-exit] interval. The driver's own `rotate-arms.sh events`
// lookup is account-wide and runs 120 s after the stop, before CloudTrail has settled, so this file
// is the evidence of record; the driver's lines are the operator's contemporaneous note.
//
//   AWS_PROFILE=twin-aa node studies/twin-aa-real/analysis/cloudtrail-evidence.mjs \
//     --region us-east-1 --start 2026-09-29T06:00:00Z --end 2026-09-29T21:00:00Z \
//     --out studies/twin-aa-real/results/evidence/cloudtrail-write-events.json
//
// Needs the AWS CLI on PATH with cloudtrail:LookupEvents. The account id is redacted to <acct>
// everywhere (§8: account id withheld from the repo). Fails loudly on any CLI error; no bare catch.
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
for (const k of ['region', 'start', 'end', 'out']) if (!args[k]) { console.error(`--${k} required`); process.exit(2); }
if (existsSync(args.out)) { console.error(`${args.out} exists; evidence files are never overwritten`); process.exit(3); }

const ACCT = /\b\d{12}\b/g;
const redact = (s) => s.replace(ACCT, '<acct>');
const laneOf = (s) => { const m = /twin-aa-l(\d)\b/.exec(s || ''); return m ? Number(m[1]) : null; };

const events = []; let next = null; let pages = 0;
do {
  const argv = ['cloudtrail', 'lookup-events', '--region', args.region, '--start-time', args.start, '--end-time', args.end,
    '--lookup-attributes', 'AttributeKey=ReadOnly,AttributeValue=false', '--max-results', '50', '--output', 'json'];
  if (next) argv.push('--next-token', next);
  const page = JSON.parse(execFileSync('aws', argv, { encoding: 'utf8', maxBuffer: 64 << 20 }));
  pages++;
  for (const e of page.Events ?? []) {
    if (!/elasticloadbalancing|ecs/.test(e.EventSource)) continue;
    const ct = JSON.parse(e.CloudTrailEvent);
    const p = ct.requestParameters ?? {};
    const resources = (e.Resources ?? []).map((r) => redact(r.ResourceName ?? ''));
    // the lane is whichever of the request's identifiers names a lane stack resource
    const named = [p.listenerArn, p.targetGroupArn, p.cluster, p.service, ...resources].filter(Boolean).map(String);
    const lanes = [...new Set(named.map(laneOf).filter((l) => l !== null))];
    events.push({
      t: e.EventTime, name: e.EventName, src: e.EventSource, id: e.EventId,
      identity: redact(ct.userIdentity?.arn ?? ct.userIdentity?.invokedBy ?? ct.userIdentity?.type ?? ''),
      lane: lanes.length === 1 ? lanes[0] : null, lanes_named: lanes,
      params: redact(JSON.stringify({ listenerArn: p.listenerArn, targetGroupArn: p.targetGroupArn, cluster: p.cluster, service: p.service, desiredCount: p.desiredCount, taskDefinition: p.taskDefinition, targets: p.targets?.length })),
      resources,
    });
  }
  next = page.NextToken ?? null;
} while (next);

events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
const out = { generated_at: new Date().toISOString(), region: args.region, start: args.start, end: args.end, pages, sources: ['elasticloadbalancing.amazonaws.com', 'ecs.amazonaws.com'], read_only: false, count: events.length, events };
writeFileSync(args.out, JSON.stringify(out, null, 1) + '\n');
console.log(`cloudtrail-evidence: ${events.length} write events over ${pages} page(s) → ${args.out}`);
