import test from 'node:test';
import assert from 'node:assert/strict';
import { planContactBake } from '../src/contact-bake.js';

test('contact bake schedules alternating foot plants and retains authored breakdown times', () => {
  const plan = planContactBake({
    duration: 2,
    sampleRateHz: 15,
    contacts: [
      { effector: 'LeftFoot', kind: 'support', start: 0.1, end: 0.8 },
      { effector: 'RightFoot', kind: 'support', start: 0.8, end: 1.6 },
      { effector: 'LeftFoot', kind: 'support', start: 1.2, end: 1.9 },
    ],
    authoredTimes: [0.4, 1.1, 1.5],
  });

  assert.deepEqual(plan.windows.map(window => window.index), [0, 1, 2]);
  assert.ok(plan.samples.some(sample => sample.time === 0.4 && sample.windowIndices.includes(0)));
  assert.ok(plan.samples.some(sample => sample.time === 1.1 && sample.windowIndices.includes(1)));
  assert.ok(plan.samples.some(sample => sample.time === 1.5 && sample.windowIndices.includes(1) && sample.windowIndices.includes(2)));
  assert.ok(plan.samples.every((sample, index) => index === 0 || plan.samples[index - 1]!.time < sample.time));
});

test('contact bake solves overlapping supports together and assigns abutting boundaries to the new window', () => {
  const overlap = planContactBake({
    duration: 2, sampleRateHz: 15,
    contacts: [
      { effector: 'LeftFoot', kind: 'support', start: 0.2, end: 1 },
      { effector: 'RightFoot', kind: 'support', start: 0.6, end: 1.4 },
      { effector: 'LeftHand', kind: 'grip', start: 1.4, end: 1.8 },
    ],
  });

  assert.deepEqual(overlap.samples.find(sample => sample.time === 0.6)?.windowIndices, [0, 1]);
  assert.deepEqual(overlap.samples.find(sample => sample.time === 1.4)?.windowIndices, [1, 2]);

  const abutting = planContactBake({
    duration: 2, sampleRateHz: 15,
    contacts: [
      { effector: 'LeftFoot', kind: 'support', start: 0.2, end: 1 },
      { effector: 'LeftFoot', kind: 'support', start: 1, end: 1.8 },
    ],
  });
  assert.deepEqual(abutting.samples.find(sample => sample.time === 1)?.windowIndices, [1]);
});

test('contact bake preserves distinct near-coincident authored and boundary times without activating contacts early', () => {
  const plan = planContactBake({
    duration: 2,
    sampleRateHz: 15,
    contacts: [
      { effector: 'LeftFoot', kind: 'support', start: 0.2, end: 1 },
      { effector: 'LeftFoot', kind: 'support', start: 1.00005, end: 1.8 },
    ],
    authoredTimes: [0.5, 0.50005],
  });

  assert.ok(plan.samples.some(sample => sample.time === 0.5 && sample.windowIndices.includes(0)));
  assert.ok(plan.samples.some(sample => sample.time === 0.50005 && sample.windowIndices.includes(0)));
  assert.deepEqual(plan.samples.find(sample => sample.time === 1)?.windowIndices, [0]);
  assert.deepEqual(plan.samples.find(sample => sample.time === 1.00005)?.windowIndices, [1]);
  assert.ok(plan.samples.every((sample, index) => index === 0 || plan.samples[index - 1]!.time < sample.time));

  assert.throws(() => planContactBake({
    duration: 2,
    sampleRateHz: 15,
    maximumSamples: 128,
    contacts: [{ effector: 'RightFoot', kind: 'support', start: 0.2, end: 1.8 }],
    authoredTimes: Array.from({ length: 130 }, (_, index) => 0.4 + index * 0.000001),
  }), /combined contact bake needs .* samples; maximum is 128/i);
});

test('contact bake rejects same-effector overlap and invalid or out-of-clip contacts', () => {
  const base = { duration: 2, sampleRateHz: 15 };
  assert.throws(() => planContactBake({ ...base, contacts: [
    { effector: 'LeftFoot', kind: 'support', start: 0.2, end: 1 },
    { effector: 'LeftFoot', kind: 'support', start: 0.9, end: 1.5 },
  ] }), /overlap/i);
  assert.throws(() => planContactBake({ ...base, contacts: [
    { effector: 'RightHand', kind: 'grip', start: 1, end: 1 },
  ] }), /positive duration/i);
  assert.throws(() => planContactBake({ ...base, contacts: [
    { effector: 'RightFoot', kind: 'support', start: 1.5, end: 2.1 },
  ] }), /inside the animation/i);
});

test('contact bake bounds the union schedule, not just each individual contact', () => {
  assert.throws(() => planContactBake({
    duration: 10, sampleRateHz: 15, maximumSamples: 128,
    contacts: [
      { effector: 'LeftFoot', kind: 'support', start: 0, end: 5 },
      { effector: 'RightFoot', kind: 'support', start: 5.1, end: 10 },
    ],
  }), /combined contact bake needs .* samples; maximum is 128/i);

  assert.throws(() => planContactBake({
    duration: 2, sampleRateHz: 30, maximumSamples: 8,
    contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.1, end: 0.9 }],
  }), /exceeds the 8-sample limit/i);
});
