import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { summarizeDeclaredContactTrajectories, summarizeStudioSpatialTrajectories, telemetrySchema } from '../src/inspection.js';
import { animationPreset } from '../src/recipes.js';

test('Studio spatial trajectory summary follows hierarchy-composed joint pivots and bounds its trace', () => {
  const telemetry = telemetrySchema.parse({
    version: 1, source: 'studio_pose_evaluator', rigId: randomUUID(), rigSignature: 'trajectory-rig', assetId: randomUUID(),
    duration: 2, loop: false, height: 5, groundSource: 'rest_node_bounds', note: 'fixture',
    nodes: [
      { name: 'HumanoidRootPart', parent: 0, driven: false, foot: false },
      { name: 'RightHand', parent: 1, driven: true, foot: false, targetKind: 'Bone' },
    ],
    samples: [
      { id: 's000', time: 0, points: [[0, 0, 0], [0, 0, 0]], pivotPoints: [[0, 0, 0], [0, 0, 0]], jointPoints: [[0, 0, 0], [0, 0, 0]], bottoms: [0, 0] },
      { id: 's001', time: 1, points: [[0, 0, 0], [1, 2, 0]], pivotPoints: [[0, 0, 0], [1, 2, 0]], jointPoints: [[0, 0, 0], [1, 2, 0]], bottoms: [0, 0] },
      { id: 's002', time: 2, points: [[0, 0, 0], [2, 0, 0]], pivotPoints: [[0, 0, 0], [2, 0, 0]], jointPoints: [[0, 0, 0], [2, 0, 0]], bottoms: [0, 0] },
    ],
  });
  const result = summarizeStudioSpatialTrajectories(telemetry, ['RightHand', 'MissingJoint']);
  assert.equal(result.source, 'studio_pose_evaluator');
  assert.equal(result.coordinateFrame, 'rig_pivot_space');
  assert.equal(result.trajectories.length, 1);
  assert.equal(result.trajectories[0]!.parent, 'HumanoidRootPart');
  assert.equal(result.trajectories[0]!.targetKind, 'Bone');
  assert.equal(result.trajectories[0]!.pointSource, 'joint_pivot_or_node_pivot');
  assert.equal(result.trajectories[0]!.orientationFrame, 'rig_pivot_composed');
  assert.deepEqual(result.trajectories[0]!.netDisplacement, [2, 0, 0]);
  assert.equal(result.trajectories[0]!.netDistance, 2);
  assert.ok(Math.abs(result.trajectories[0]!.pathLength - 2 * Math.sqrt(5)) < 1e-12);
  assert.ok(Math.abs(result.trajectories[0]!.maxDistanceFromStart - Math.sqrt(5)) < 1e-12);
  assert.equal(result.trajectories[0]!.peakInterval?.startTime, 0);
  assert.equal(result.trajectories[0]!.traceSelection.orientationEvidence, null, 'rotation evidence is explicitly unavailable when telemetry has no orientations');
  assert.equal(result.unavailable[0]?.status, 'missing');
  assert.deepEqual(result.omittedJoints, []);
  assert.equal(result.omittedJointListTruncatedCount, 0);
  assert.match(result.limitation, /not literal world coordinates.*not continuous paths/i);
  assert.match(result.limitation, /include ancestor motion.*not the joint.*authored local Euler channel/i);

  const legacyTelemetry = telemetrySchema.parse({ ...telemetry, samples: telemetry.samples.map(({ pivotPoints: _pivotPoints, jointPoints: _jointPoints, ...sample }) => sample) });
  const legacy = summarizeStudioSpatialTrajectories(legacyTelemetry, ['RightHand']);
  assert.equal(legacy.coordinateFrame, 'ground_relative_legacy');
  assert.equal(legacy.trajectories[0]!.pointSource, 'ground_relative_legacy');
  assert.match(legacy.limitation, /must not be interpreted as a hierarchy-composed path/i);

  const bounded = summarizeStudioSpatialTrajectories(telemetry, ['RightHand'], 1);
  assert.equal(bounded.trajectories[0]!.trace.length, 3);
  assert.throws(() => summarizeStudioSpatialTrajectories(telemetry, ['RightHand'], 25), /from 1 to 24/);

  const wideRig = telemetrySchema.parse({ ...telemetry,
    nodes: Array.from({ length: 14 }, (_, index) => ({ name: index === 0 ? 'Root' : `Joint${index}`, parent: index, driven: index > 0, foot: false })),
    samples: telemetry.samples.map(sample => ({ ...sample,
      points: Array.from({ length: 14 }, () => [0, 0, 0]), pivotPoints: Array.from({ length: 14 }, () => [0, 0, 0]),
      jointPoints: Array.from({ length: 14 }, () => [0, 0, 0]), bottoms: Array.from({ length: 14 }, () => 0) })) });
  const coverage = summarizeStudioSpatialTrajectories(wideRig, Array.from({ length: 14 }, (_, index) => index === 0 ? 'Root' : `Joint${index}`));
  assert.equal(coverage.trajectories.length, 12);
  assert.equal(coverage.omittedTrajectoryCount, 2);
  assert.deepEqual(coverage.omittedJoints, [
    { requestedJoint: 'Joint12', joint: 'Joint12', resolution: 'exact' },
    { requestedJoint: 'Joint13', joint: 'Joint13', resolution: 'exact' },
  ], 'the AI can see exactly which requested joints did not receive a detailed trace');

  const dense = telemetrySchema.parse({ ...telemetry, samples: Array.from({ length: 30 }, (_, index) => {
    const time = index * 2 / 29;
    const position = [index, 0, 0];
    const id = `s${String(index).padStart(3, '0')}`;
    return { id, time, points: [[0, 0, 0], position], pivotPoints: [[0, 0, 0], position], jointPoints: [[0, 0, 0], position], bottoms: [0, 0] };
  }) });
  const denseSummary = summarizeStudioSpatialTrajectories(dense, ['RightHand'], 1);
  assert.equal(denseSummary.trajectories[0]!.sampleCount, 30);
  assert.equal(denseSummary.trajectories[0]!.trace.length, 24);
  assert.equal(denseSummary.trajectories[0]!.omittedTraceSampleCount, 6);
  assert.equal(denseSummary.trajectories[0]!.trace[0]?.sampleId, 's000');
  assert.equal(denseSummary.trajectories[0]!.trace.at(-1)?.sampleId, 's029');
  assert.ok(Math.abs(denseSummary.maximumSampleGapSeconds - 2 / 29) < 1e-12);

  const spike = telemetrySchema.parse({ ...telemetry, samples: Array.from({ length: 61 }, (_, index) => {
    const time = index / 30;
    const position = [index === 17 ? 8 : 0, 0, 0];
    return { id: `s${String(index).padStart(3, '0')}`, time, points: [[0, 0, 0], position],
      pivotPoints: [[0, 0, 0], position], jointPoints: [[0, 0, 0], position], bottoms: [0, 0] };
  }) });
  const spikeTrace = summarizeStudioSpatialTrajectories(spike, ['RightHand']).trajectories[0]!;
  assert.equal(spikeTrace.trace.length, 24);
  assert.ok(spikeTrace.trace.some(point => point.sampleId === 's017'), 'trace reduction must retain brief positional extrema');
  assert.deepEqual(spikeTrace.traceSelection.peakSpeedIntervalSampleIds, { startSampleId: 's016', endSampleId: 's017' });
  assert.deepEqual(spikeTrace.traceSelection.positionExtremaSampleIds[0], {
    axis: 'x', minimumSampleId: 's000', maximumSampleId: 's017',
  });
  assert.equal(spikeTrace.omittedTraceSampleCount, 37);
  const uneven = telemetrySchema.parse({ ...spike, samples: spike.samples.map((sample, index) => ({ ...sample,
    time: 2 * (index / 60) ** 2 })) });
  const unevenTrace = summarizeStudioSpatialTrajectories(uneven, ['RightHand']).trajectories[0]!;
  assert.equal(unevenTrace.trace.length, 24, 'irregular timestamps must still fill, and terminate at, the trace budget');
  assert.ok(unevenTrace.trace.some(point => point.sampleId === 's017'));

  const rotationOnlySpike = telemetrySchema.parse({ ...spike, samples: spike.samples.map((sample, index) => ({ ...sample,
    points: [[0, 0, 0], [0, 0, 0]], pivotPoints: [[0, 0, 0], [0, 0, 0]], jointPoints: [[0, 0, 0], [0, 0, 0]],
    orientations: [[0, 0, 0, 1], index === 23 ? [0, 0, Math.SQRT1_2, Math.SQRT1_2] : [0, 0, 0, 1]],
  })), restPose: { points: [[0, 0, 0], [0, 0, 0]],
    orientations: [[0, 0, 0, 1], [0, 0, -Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]] } });
  const rotationTrace = summarizeStudioSpatialTrajectories(rotationOnlySpike, ['RightHand']).trajectories[0]!;
  assert.equal(rotationTrace.pathLength, 0, 'the fixture isolates rotation from positional travel');
  assert.ok(rotationTrace.trace.some(point => point.sampleId === 's023'), 'the bounded trace must retain a brief orientation-only change');
  const orientationEvidence = rotationTrace.traceSelection.orientationEvidence!;
  assert.equal(orientationEvidence.referenceSampleId, 's000');
  assert.equal(orientationEvidence.maximumDriftSampleId, 's023');
  assert.equal(orientationEvidence.maximumDriftDegrees, 90);
  assert.deepEqual(orientationEvidence.peakAngularSpeedIntervalSampleIds, { startSampleId: 's022', endSampleId: 's023' });
  assert.ok(Math.abs(orientationEvidence.peakAngularSpeedDegreesPerSecond! - 2700) < 1e-8);
  assert.equal(orientationEvidence.maximumRestDeviation?.sampleId, 's023');
  assert.ok(Math.abs(orientationEvidence.maximumRestDeviation!.degrees - 135) < 1e-8);
  assert.deepEqual(rotationTrace.trace.find(point => point.sampleId === 's023')?.orientation, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);

  const contactRecipe = animationPreset('idle', 'Sparse declared hold', 2, 1);
  contactRecipe.contacts = [{ effector: 'RightHand', kind: 'grip', start: 0.5, end: 1.5 }];
  const contactSummary = summarizeDeclaredContactTrajectories(telemetry, contactRecipe);
  const contactEvidence = contactSummary.contacts[0]!;
  assert.equal(contactSummary.coordinateFrame, 'rig_pivot_space');
  assert.equal(contactEvidence.pointSource, 'joint_pivot_or_node_pivot');
  assert.equal(contactEvidence.status, 'insufficient_samples');
  assert.equal(contactEvidence.sampleCount, 1);
  assert.equal(contactEvidence.startBoundary, null);
  assert.deepEqual(contactEvidence.midpointBoundary, { requestedTime: 1, sampleId: 's001', sampledTime: 1 });
  assert.equal(contactEvidence.endBoundary, null);
  assert.equal(contactEvidence.maxDriftFromFirstObservedStuds, 0);
  assert.match(summarizeDeclaredContactTrajectories(telemetry, contactRecipe).limitation, /Partial\/insufficient coverage is not a pass/);

  const contactSpike = telemetrySchema.parse({ ...spike, samples: spike.samples.map((sample, index) => ({ ...sample,
    orientations: [[0, 0, 0, 1], index === 23 ? [0, 0, Math.SQRT1_2, Math.SQRT1_2] : [0, 0, 0, 1]] })) });
  const fullWindowContact = { ...contactRecipe, contacts: [{ effector: 'RightHand' as const, kind: 'grip' as const, start: 0, end: 2 }] };
  const contactSpikeEvidence = summarizeDeclaredContactTrajectories(contactSpike, fullWindowContact).contacts[0]!;
  assert.equal(contactSpikeEvidence.trace.length, 24);
  assert.ok(contactSpikeEvidence.trace.some(point => point.sampleId === 's017'), 'contact trace must preserve a brief sampled slip');
  assert.ok(contactSpikeEvidence.trace.some(point => point.sampleId === 's023'), 'contact trace must preserve maximum sampled orientation drift');
  assert.equal(contactSpikeEvidence.traceSelection?.orientationEvidence?.maximumDriftSampleId, 's023');
  assert.equal(contactSpikeEvidence.traceSelection?.orientationEvidence?.maximumDriftDegrees, 90);
  assert.equal(contactSpikeEvidence.traceSelection?.orientationEvidence?.maximumRestDeviation, null, 'rest-relative evidence stays unknown without a recorded rest pose');
  assert.ok(Math.abs(contactSpikeEvidence.traceSelection!.orientationEvidence!.peakAngularSpeedDegreesPerSecond! - 2700) < 1e-8);
  assert.deepEqual(contactSpikeEvidence.traceSelection?.orientationEvidence?.peakAngularSpeedIntervalSampleIds,
    { startSampleId: 's022', endSampleId: 's023' });
  assert.equal(contactSpikeEvidence.omittedTraceSampleCount, 37);

  const unavailableContact = summarizeDeclaredContactTrajectories(telemetry, { ...contactRecipe,
    contacts: [{ effector: 'UnknownEffector', kind: 'grip', start: 0.5, end: 1.5 }] }).contacts[0]!;
  assert.equal(unavailableContact.status, 'missing');
  assert.equal(unavailableContact.maxDriftFromFirstObservedStuds, null);
  const legacyContactSummary = summarizeDeclaredContactTrajectories(legacyTelemetry, contactRecipe);
  assert.equal(legacyContactSummary.coordinateFrame, 'ground_relative_legacy');
  assert.equal(legacyContactSummary.contacts[0]!.pointSource, 'ground_relative_legacy');
  assert.match(legacyContactSummary.limitation, /must not be interpreted as hierarchy-composed paths/i);
});
