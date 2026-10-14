import test from 'node:test';
import assert from 'node:assert/strict';
import { auditAnimation } from '../src/animation-quality.js';
import { evaluateAnimationTestCase } from '../src/animation-tests.js';
import { inspectMotion } from '../src/inspection.js';
import { createReviewPilotCases, type PilotCase } from './review/fixtures/pilot-cases.js';

const cases = createReviewPilotCases();
const byId = (id: PilotCase['id']) => cases.find(item => item.id === id)!;

function contactChecks(item: PilotCase, effector: string, kind: 'support' | 'grip', start: number, end: number) {
  const assetId = item.telemetry.assetId;
  const testCase = {
    assetId, expectedFingerprint: undefined, motionMode: 'stationary' as const,
    requiredTracks: [effector], contacts: [{ effector, kind, start, end, maxDriftStuds: 0.05, minSamples: 5, maxSampleGapSeconds: 0.25 }],
    requiredMarkers: [],
  };
  const studio = inspectMotion(item.recipe, item.telemetry, 'stationary').report;
  return evaluateAnimationTestCase(item.recipe, testCase, auditAnimation(item.recipe), studio, item.telemetry);
}

test('six executable review-pilot cases distinguish three injected technical defects from controls', () => {
  assert.deepEqual(cases.map(item => item.id), ['idle-control', 'idle-flawed', 'run-control', 'run-flawed', 'guard-control', 'guard-flawed']);

  const idleControl = auditAnimation(byId('idle-control').recipe);
  const idleFlawed = auditAnimation(byId('idle-flawed').recipe);
  const hasLoopSeamAdvisory = (audit: ReturnType<typeof auditAnimation>) => audit.advisories.some(item => item.id === 'loop-angular-seam');
  assert.equal(hasLoopSeamAdvisory(idleControl), false,
    'the clean idle control must not trigger the loop-seam advisory');
  assert.equal(hasLoopSeamAdvisory(idleFlawed), true,
    'the injected idle loop snap must trigger the production loop-seam advisory');
  const controlAngularPeak = Math.max(...idleControl.curveMotion.filter(metric => metric.joint === 'UpperTorso').map(metric => metric.peakLocalAngularSpeed.degreesPerSecond));
  const flawedAngularPeak = Math.max(...idleFlawed.curveMotion.filter(metric => metric.joint === 'UpperTorso').map(metric => metric.peakLocalAngularSpeed.degreesPerSecond));
  assert.ok(flawedAngularPeak > controlAngularPeak * 10, `loop-snap detector signal should separate variants: control=${controlAngularPeak}, flawed=${flawedAngularPeak}`);

  const runControl = contactChecks(byId('run-control'), 'LeftFoot', 'support', 0.1, 0.3);
  const runFlawed = contactChecks(byId('run-flawed'), 'LeftFoot', 'support', 0.1, 0.3);
  assert.equal(runControl.status, 'passed');
  assert.equal(runFlawed.status, 'failed');
  assert.equal(runControl.checks.find(check => check.id === 'contact:LeftFoot:1')?.status, 'passed',
    'the clean planted-foot control must pass its exact contact check');
  const footSlideCheck = runFlawed.checks.find(check => check.id.startsWith('contact:LeftFoot') && check.status === 'failed');
  assert.ok(footSlideCheck && typeof footSlideCheck.observed === 'number' && Math.abs(footSlideCheck.observed - 0.4) < 1e-6);

  const guardControl = contactChecks(byId('guard-control'), 'LeftHand', 'grip', 0, 3.2);
  const guardFlawed = contactChecks(byId('guard-flawed'), 'LeftHand', 'grip', 0, 3.2);
  assert.equal(guardControl.status, 'passed');
  assert.equal(guardFlawed.status, 'failed');
  assert.equal(guardControl.checks.find(check => check.id === 'contact:LeftHand:1')?.status, 'passed',
    'the clean guard control must pass its exact grip check');
  const gripSeparationCheck = guardFlawed.checks.find(check => check.id.startsWith('contact:LeftHand') && check.status === 'failed');
  assert.ok(gripSeparationCheck && typeof gripSeparationCheck.observed === 'number' && Math.abs(gripSeparationCheck.observed - 0.5) < 1e-6);
});

test('pilot fixtures validate as complete looping recipes and exact-duration telemetry', () => {
  for (const item of cases) {
    assert.equal(item.recipe.loop, true, item.id);
    assert.equal(item.telemetry.duration, item.recipe.duration, item.id);
    assert.equal(item.telemetry.samples[0]!.time, 0, item.id);
    assert.equal(item.telemetry.samples.at(-1)!.time, item.recipe.duration, item.id);
    assert.ok(item.telemetry.samples.length <= 128, `${item.id} stays inside Studio telemetry bounds`);
  }
});
