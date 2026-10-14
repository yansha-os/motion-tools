import assert from 'node:assert/strict';
import test from 'node:test';
import { animationPreset, recipeSchema } from '../src/recipes.js';
import { compareContactStability, inspectMotion, sampleTimes, telemetrySchema, type Inspection } from '../src/inspection.js';

const key = (time: number, x: number) => ({ time, position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] });
function parseAnimation(input: unknown) {
  const parsed = recipeSchema.parse(input);
  if (parsed.kind !== 'animation') throw new Error('Expected animation recipe');
  return parsed;
}

test('root travel remains a separate additive channel and can intentionally cross a looping seam', () => {
  const base = animationPreset('walk', 'Travel walk', 1, 1);
  const parsed = parseAnimation({ ...base, rootMotion: { joint: 'LowerTorso', keys: [key(0, 0), key(1, 3)] } });
  assert.equal(parsed.rootMotion?.joint, 'LowerTorso');
  assert.equal(parsed.rootMotion?.keys.at(-1)?.position[0], 3);
});

test('declared contact intervals are bounded, ordered and non-overlapping per effector', () => {
  const base = animationPreset('idle', 'Contact test', 1, 1);
  assert.throws(() => recipeSchema.parse({ ...base, contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.8, end: 0.4 }] }), /contact interval/);
  assert.throws(() => recipeSchema.parse({ ...base, contacts: [
    { effector: 'LeftFoot', kind: 'support', start: 0.1, end: 0.6 },
    { effector: 'LeftFoot', kind: 'support', start: 0.5, end: 0.9 },
  ] }), /cannot overlap/);
  assert.throws(() => recipeSchema.parse({ ...base, contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.1, end: 1.1 }] }), /stay within/);
});

test('contact and marker sampling stays within Studio limits and includes declared windows', () => {
  const base = animationPreset('walk', 'Many contacts', 1, 1);
  const contacts = Array.from({ length: 16 }, (_, index) => ({
    effector: `Foot${index}`, kind: 'support' as const, start: index / 20, end: 0.5 + index / 40,
  }));
  const markers = Array.from({ length: 100 }, (_, index) => ({ name: `event-${index}`, time: (index + 1) / 101 }));
  const recipe = parseAnimation({ ...base, contacts, markers });
  const times = sampleTimes(recipe);
  assert.ok(times.length <= 128);
  for (const contact of contacts) {
    assert.ok(times.includes(contact.start) && times.includes(contact.end));
    const midpoint = (contact.start + contact.end) / 2;
    assert.ok(times.some(time => Math.abs(time - midpoint) <= Number.EPSILON * Math.max(1, Math.abs(time), Math.abs(midpoint)) * 4));
  }
  for (const marker of markers.slice(0, 15)) assert.ok(times.includes(marker.time));
});

test('Studio motion report measures root path and declared contact drift with explicit caveats', () => {
  const base = animationPreset('walk', 'Measured travel', 1, 1);
  const recipe = parseAnimation({ ...base,
    rootMotion: { joint: 'LowerTorso', keys: [key(0, 0), key(1, 1)] },
    contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.25, end: 0.75 }],
  });
  const raw = telemetrySchema.parse({ version: 1, source: 'studio_pose_evaluator', rigId: '11111111-1111-4111-8111-111111111111', assetId: '22222222-2222-4222-8222-222222222222', duration: 1, loop: true, height: 6, groundSource: 'rest_foot_bounds', note: 'fixture',
    nodes: [{ name: 'HumanoidRootPart', parent: 0, driven: false, foot: false }, { name: 'LowerTorso', parent: 1, driven: true, foot: false }, { name: 'LeftFoot', parent: 2, driven: true, foot: true }],
    samples: [0, 0.25, 0.5, 0.75, 1].map((time, index) => ({ id: `s00${index}`, time, points: [[0, 0, 0], [time, 0, 0], [time * 2, 0, 0]], bottoms: [0, 0, 0] })),
  });
  const result = inspectMotion(recipe, raw);
  assert.equal(result.report.metrics.find(metric => metric.id === 'root-motion-distance')?.value, 1);
  assert.equal(result.report.metrics.find(metric => metric.id === 'declared-contact-0')?.value, 1);
  assert.deepEqual(result.report.metrics.find(metric => metric.id === 'declared-contact-0')?.contactSampling, {
    status: 'complete', sampleTimes: [0.25, 0.5, 0.75], maximumSampleGapSeconds: 0.25,
    exactStart: true, exactMidpoint: true, exactEnd: true,
  });
  assert.ok(result.report.findings.some(finding => finding.id === 'contact-drift-0'));
  assert.match(result.report.metrics.find(metric => metric.id === 'root-motion-distance')!.detail, /not automatic character\/gameplay displacement/);
  const denseTelemetry = structuredClone(raw);
  denseTelemetry.samples = Array.from({ length: 128 }, (_, index) => ({
    id: `s${String(index).padStart(3, '0')}`,
    time: index / 127,
    points: structuredClone(raw.samples[0]!.points),
    bottoms: structuredClone(raw.samples[0]!.bottoms),
  }));
  assert.equal(telemetrySchema.parse(denseTelemetry).samples.length, 128);
  assert.throws(() => telemetrySchema.parse({ ...denseTelemetry, samples: [...denseTelemetry.samples, { ...denseTelemetry.samples.at(-1)!, id: 's128', time: 1.01 }] }));
  const stablePose = structuredClone(raw);
  stablePose.samples.forEach(sample => {
    sample.points[2] = [sample.time, 0, 0];
  });
  const seam = inspectMotion(recipe, stablePose);
  assert.equal(seam.report.metrics.find(metric => metric.id === 'loop-position-gap')?.value, 0);
  assert.match(seam.report.metrics.find(metric => metric.id === 'loop-position-gap')!.detail, /removing the declared root-joint translation/);

  const betweenBoundarySlip = structuredClone(raw);
  betweenBoundarySlip.samples.forEach(sample => {
    sample.points[2] = sample.time === 0.5 ? [1, 0, 0] : [0, 0, 0];
  });
  const slip = inspectMotion(recipe, betweenBoundarySlip);
  assert.equal(slip.report.metrics.find(metric => metric.id === 'declared-contact-0')?.value, 1);
  assert.ok(slip.report.findings.some(finding => finding.id === 'contact-drift-0'));
  const missingMidpoint = structuredClone(raw);
  missingMidpoint.samples = missingMidpoint.samples.filter(sample => sample.time !== 0.5);
  const partialContact = inspectMotion(recipe, missingMidpoint).report.metrics.find(metric => metric.id === 'declared-contact-0')!;
  assert.equal(partialContact.contactSampling?.status, 'partial');
  assert.equal(partialContact.contactSampling?.exactMidpoint, false);
});

test('contact comparisons follow effector and exact interval identity when contact order changes', () => {
  const metric = (id: string, semanticKey: string, label: string, value: number, sampleTimes = [0, 0.25, 0.5, 0.75, 1]) => ({
    id, semanticKey, label, value, unit: 'studs', detail: 'fixture', sampleIds: [id],
    contactSampling: { status: 'complete' as const, sampleTimes, maximumSampleGapSeconds: Math.max(...sampleTimes.slice(1).map((time, index) => time - sampleTimes[index]!)),
      exactStart: true, exactMidpoint: true, exactEnd: true },
  });
  const source: Inspection = { source: 'studio_pose_evaluator', metrics: [
    metric('declared-contact-0', 'contact:["leftfoot","support",0,0.5]:position', 'LeftFoot support drift', 0.8),
    metric('declared-contact-1', 'contact:["rightfoot","support",0,0.5]:position', 'RightFoot support drift', 0.4),
  ], findings: [], questions: [], limitations: [] };
  const reorderedCandidate: Inspection = { ...source, metrics: [
    metric('declared-contact-0', 'contact:["rightfoot","support",0,0.5]:position', 'RightFoot support drift', 0.2),
    metric('declared-contact-1', 'contact:["leftfoot","support",0,0.5]:position', 'LeftFoot support drift', 0.7),
  ] };
  const changes = compareContactStability(source, reorderedCandidate);
  assert.equal(changes.length, 2);
  const left = changes.find(change => change.label === 'LeftFoot support drift');
  const right = changes.find(change => change.label === 'RightFoot support drift');
  assert.equal(left?.status, 'improved');
  assert.equal(right?.status, 'improved');
  assert.ok(Math.abs((left?.delta ?? 0) + 0.1) < 1e-9);
  assert.ok(Math.abs((right?.delta ?? 0) + 0.2) < 1e-9);
  const changedWindow: Inspection = { ...reorderedCandidate, metrics: [
    metric('declared-contact-0', 'contact:["leftfoot","support",0,0.75]:position', 'LeftFoot support drift', 0.1),
  ] };
  assert.ok(compareContactStability(source, changedWindow).every(change => change.status === 'unknown'), 'different contact windows must not be compared as if they were the same contract');

  const identity = 'contact:["leftfoot","support",0,1]:position';
  const baseline: Inspection = { ...source, metrics: [metric('declared-contact-0', identity, 'LeftFoot support drift', 0.8)] };
  const sparseCandidate: Inspection = { ...baseline, metrics: [metric('declared-contact-0', identity, 'LeftFoot support drift', 0.1, [0, 0.5, 1])] };
  const sparseComparison = compareContactStability(baseline, sparseCandidate)[0]!;
  assert.equal(sparseComparison.status, 'unknown', 'a lower value cannot be called improved if candidate samples omit source times');
  assert.match('reason' in sparseComparison ? sparseComparison.reason : '', /did not retain every source sample time/i);
  assert.deepEqual('missingSourceSampleTimes' in sparseComparison ? sparseComparison.missingSourceSampleTimes : [], [0.25, 0.75]);

  const denserCandidate: Inspection = { ...baseline, metrics: [metric('declared-contact-0', identity, 'LeftFoot support drift', 0.7,
    [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1])] };
  const denserComparison = compareContactStability(baseline, denserCandidate)[0]!;
  assert.equal(denserComparison.status, 'improved', 'a denser candidate may compare when it retains every source sample time');
  assert.equal('samplingComparison' in denserComparison ? denserComparison.samplingComparison.candidateRetainsAllSourceSampleTimes : false, true);

  const partialCandidate: Inspection = { ...baseline, metrics: [metric('declared-contact-0', identity, 'LeftFoot support drift', 0.1)] };
  partialCandidate.metrics[0]!.contactSampling!.status = 'partial';
  const partialComparison = compareContactStability(baseline, partialCandidate)[0]!;
  assert.equal(partialComparison.status, 'unknown', 'partial declared-window coverage must not produce an improvement claim');
});
