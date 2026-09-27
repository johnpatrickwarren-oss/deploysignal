// test/twin-argo-template.test.ts — Plan B Task 6: service/gate-http/argo/twin-analysis-template.yaml.
//
// While TWIN_ARM_AUTHORITY is 'advisory' the template records the twin verdict and never fails
// the analysis:
//   - the metric is listed in spec.dryRun (Argo records it; it never decides the AnalysisRun);
//   - successCondition is the literal "true", with no failureCondition or inconclusiveCondition;
//   - consecutiveErrorLimit exceeds count, so an unreachable gate cannot error the run either;
//   - jsonPath reads the `twin.verdict` block a live GET /v1/verdict serves for a twin session.
// The example Rollout's experiment step runs a baseline ReplicaSet (stable spec) and a canary
// ReplicaSet at the same weight, the ADR 0036 topology (a fresh control arm, not the warm fleet).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { TWIN_ARM_AUTHORITY } from '../dist/engine/guarantees';
import { TWIN_PROFILE, twinTicks, toSnake } from './_twin-fixture';
import { start, stop, req, twinBody } from './_twin-http-harness';

const DIR = path.resolve(__dirname, '..', 'service', 'gate-http');
const docs = yaml.loadAll(fs.readFileSync(path.join(DIR, 'argo', 'twin-analysis-template.yaml'), 'utf8')) as any[];
const template = docs.find((d) => d?.kind === 'AnalysisTemplate');
const rollout = docs.find((d) => d?.kind === 'Rollout');

test('twin template: while advisory, the metric is dry-run and its conditions cannot fail', () => {
  assert.equal(TWIN_ARM_AUTHORITY, 'advisory', 'flip this test with the authority ADR, not before');
  assert.ok(template, 'an AnalysisTemplate document');
  const metric = template.spec.metrics[0];
  const dry = (template.spec.dryRun ?? []).map((d: any) => d.metricName);
  assert.ok(dry.includes(metric.name), `metric ${metric.name} is in spec.dryRun`);
  assert.equal(String(metric.successCondition), 'true');
  assert.equal(metric.failureCondition, undefined);
  assert.equal(metric.inconclusiveCondition, undefined);
  assert.ok(metric.consecutiveErrorLimit > metric.count, 'errors cannot trip the run either');
  assert.equal(metric.provider.web.method, 'GET');
  assert.match(metric.provider.web.url, /\/v1\/verdict\/\{\{args\.deploy-ref\}\}$/);
  assert.equal(metric.provider.web.jsonPath, '{$.twin.verdict}');
});

test('twin template: the example Rollout runs baseline and canary ReplicaSets at the same weight', () => {
  assert.ok(rollout, 'an example Rollout document');
  const steps = rollout.spec.strategy.canary.steps as any[];
  const exp = steps.find((s) => s.experiment)?.experiment;
  assert.ok(exp, 'an experiment step');
  const byName = Object.fromEntries(exp.templates.map((t: any) => [t.name, t]));
  assert.equal(byName.baseline.specRef, 'stable', 'the control arm runs the OLD version, fresh');
  assert.equal(byName.canary.specRef, 'canary');
  assert.ok(byName.baseline.weight > 0);
  assert.equal(byName.baseline.weight, byName.canary.weight, 'equal weights: canary_weight 0.5 within the experiment');
  assert.equal(byName.baseline.replicas, byName.canary.replicas);
  const analysis = exp.analyses.find((a: any) => a.templateName === template.metadata.name);
  assert.ok(analysis, 'the experiment runs the twin AnalysisTemplate');
  assert.notEqual(analysis.requiredForCompletion, true);
  assert.ok(rollout.spec.strategy.canary.trafficRouting, 'weighted experiment templates need traffic routing');
});

test('twin template: jsonPath resolves on a live GET /v1/verdict for a twin session, before and after a verdict', async () => {
  const s = await start();
  try {
    const created = await req(s.baseUrl, 'POST', '/v1/sessions', twinBody(TWIN_PROFILE as never, { deploy_ref: 'rev-argo' }));
    const read = async (): Promise<unknown> => (await req(s.baseUrl, 'GET', '/v1/verdict/rev-argo')).json?.twin?.verdict;
    assert.equal(await read(), 'extend');
    const next = twinTicks(11, { canaryOdds: 3, latencyShift: 2 });
    for (let t = 0; t < 60; t++) {
      const r = await req(s.baseUrl, 'POST', `/v1/sessions/${created.json.session_id}/ticks`, toSnake(next()));
      if (r.json.engine_verdict !== 'extend') break;
    }
    assert.equal(await read(), 'rollback');
  } finally { await stop(s); }
});

test('twin template: the README documents twin mode and the advisory posture of the template', () => {
  const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
  assert.match(readme, /## Twin mode/);
  assert.match(readme, /twin-analysis-template\.yaml/);
  assert.match(readme, /dryRun/);
  assert.match(readme, /TWIN_ARM_AUTHORITY/);
});
