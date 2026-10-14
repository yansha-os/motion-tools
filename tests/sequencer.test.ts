import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Library } from '../src/library.js';
import { fingerprint } from '../src/inspection.js';
import { animationPreset } from '../src/recipes.js';
import { compileSequence, previewSequence, SequenceLibrary } from '../src/sequencer.js';

test('clip sequences validate source ranges, fades, references, and duration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-'));
  const animations = new Library(join(root, 'animations'));
  const first = await animations.save(animationPreset('idle', 'Idle A', 2, 1));
  const sequences = new SequenceLibrary(join(root, 'sequences'), animations);
  await assert.rejects(() => sequences.save({ kind: 'sequence', name: 'Bad range', sampleRate: 30, loop: false, clips: [{ animationId: first.id, start: 0, sourceStart: 1, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 }] }), /source range/);
  await assert.rejects(() => previewSequence({ kind: 'sequence', name: 'Bad preview', sampleRate: 30, loop: false, clips: [{ animationId: first.id, start: 0, sourceStart: 1, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 }] }, animations), /source range/);
  await assert.rejects(() => sequences.save({ kind: 'sequence', name: 'Too much fade', sampleRate: 30, loop: false, clips: [{ animationId: first.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0.7, fadeOut: 0.4 }] }), /fade durations/);
  await assert.rejects(() => sequences.save({ kind: 'sequence', name: 'Missing asset', sampleRate: 30, loop: false, clips: [{ animationId: '00000000-0000-4000-8000-000000000000', start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 }] }));
});

test('compile retimes and crossfades overlapping animation clips into a normal animation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-'));
  const animations = new Library(join(root, 'animations'));
  const make = (name: string, degrees: number) => animations.save({
    kind: 'animation', name, duration: 1, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [0, 0, 0], rotation: [degrees, 0, 0] },
      { time: 1, position: [0, 0, 0], rotation: [degrees, 0, 0] },
    ] }], markers: [{ name: 'Hit', time: 0.75, phase: 'event' }],
  });
  const left = await make('Left', 10), right = await make('Right', 20);
  const sequence = {
    kind: 'sequence' as const, name: 'Combo', sampleRate: 30, loop: false,
    clips: [
      { animationId: left.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0.5 },
      { animationId: right.id, start: 0.5, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0.5, fadeOut: 0 },
    ],
  };
  const compiled = await compileSequence(sequence, animations);
  const preview = await previewSequence(sequence, animations);
  assert.deepEqual(preview.animation, compiled);
  assert.deepEqual(preview.diagnostics.overlaps, [{ firstClip: 0, secondClip: 1, start: 0.5, end: 1, duration: 0.5 }]);
  assert.deepEqual(preview.diagnostics.gaps, []);
  assert.equal(preview.diagnostics.clips[0]!.jointCoverage, 1);
  assert.match(preview.diagnostics.clips[0]!.sourceFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(compiled.kind, 'animation');
  assert.equal(compiled.duration, 1.5);
  assert.equal(compiled.tracks.length, 1);
  const midpoint = compiled.tracks[0]!.keys.find(key => Math.abs(key.time - 0.75) < 1e-9)!;
  assert.ok(Math.abs(midpoint.rotation[0] - 15) < 1e-9);
  assert.ok(compiled.markers.some(marker => marker.name === 'Left: Hit' && marker.time === 0.75));
  assert.ok(compiled.markers.some(marker => marker.name === 'Right: Hit' && marker.time === 1.25));
  assert.ok(compiled.markers.every(marker => marker.phase === 'event'), 'compiled sequences preserve Motion Tools marker classification metadata');
  assert.ok(compiled.tracks[0]!.keys.length <= 128);
});

test('sequence sampling preserves compound XYZ Euler rotations through quaternion conversion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-compound-rotation-'));
  const animations = new Library(join(root, 'animations'));
  const source = animationPreset('idle', 'Compound source', 2, 1);
  source.loop = false;
  const expected: [number, number, number] = [20, 30, 40];
  source.tracks.find(track => track.joint === 'UpperTorso')!.keys.forEach(key => { key.rotation = [...expected]; });
  const saved = await animations.save(source);
  const compiled = await compileSequence({ kind: 'sequence', name: 'Compound sequence', sampleRate: 30, loop: false, clips: [
    { animationId: saved.id, start: 0, sourceStart: 0, sourceEnd: 2, speed: 1, fadeIn: 0, fadeOut: 0 },
  ] }, animations);
  const midpoint = compiled.tracks.find(track => track.joint === 'UpperTorso')!.keys.find(key => Math.abs(key.time - 1) < 1e-9)!;
  assert.ok(midpoint.rotation.every((value, axis) => Math.abs(value - expected[axis]!) < 1e-8),
    `sampling an unchanged compound rotation should be lossless, got ${midpoint.rotation}`);
});

test('sequence preview measures source-pose discontinuities and contact changes at clip boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-seams-'));
  const animations = new Library(join(root, 'animations'));
  const make = (name: string, x: number, degrees: number, contactKind: 'support' | 'grip') => animations.save({
    kind: 'animation', name, duration: 1, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [x, 0, 0], rotation: [degrees, 0, 0] },
      { time: 1, position: [x, 0, 0], rotation: [degrees, 0, 0] },
    ] }], markers: [], contacts: [{ effector: 'RightHand', kind: contactKind, start: 0, end: 1 }],
  });
  const first = await make('Windup', 1, 0, 'grip');
  const second = await make('Strike', 3, 90, 'support');
  const result = await previewSequence({ kind: 'sequence', name: 'Action seam', sampleRate: 30, loop: false, clips: [
    { animationId: first.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
    { animationId: second.id, start: 1, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
  ] }, animations);
  const [boundary] = result.diagnostics.transitionBoundaries;
  assert.equal(boundary?.relation, 'touching');
  assert.equal(boundary?.boundaryTime, 1);
  assert.equal(boundary?.maximumPositionGapStuds, 2);
  assert.ok(Math.abs(boundary!.maximumAngularGapDegrees - 90) < 1e-6);
  assert.deepEqual(boundary?.contactBoundaryChanges, [{ effector: 'righthand', leftKind: 'grip', rightKind: 'support' }]);
  assert.equal(boundary?.largestPositionGaps[0]?.joint, 'UpperTorso');
  assert.match(boundary?.limitation ?? '', /not pass\/fail thresholds/);
});

test('sequence preview detects linear and angular velocity reversals across a pose-matched seam', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-velocity-seam-'));
  const animations = new Library(join(root, 'animations'));
  const make = (name: string, startX: number, endX: number, startAngle: number, endAngle: number) => animations.save({
    kind: 'animation', name, duration: 1, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [
      { time: 0, position: [startX, 0, 0], rotation: [startAngle, 0, 0] },
      { time: 1, position: [endX, 0, 0], rotation: [endAngle, 0, 0] },
    ] }], markers: [],
  });
  const outgoing = await make('Approach', 0, 1, 0, 30);
  const incoming = await make('Reverse', 1, 0, 30, 0);
  const result = await previewSequence({ kind: 'sequence', name: 'Matched but abrupt', sampleRate: 30, loop: false, clips: [
    { animationId: outgoing.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
    { animationId: incoming.id, start: 1, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
  ] }, animations);
  const boundary = result.diagnostics.transitionBoundaries[0]!;
  const joint = boundary.largestLinearVelocityGaps[0]!;
  assert.equal(boundary.maximumPositionGapStuds, 0);
  assert.ok(boundary.maximumAngularGapDegrees < 1e-6);
  assert.ok(Math.abs(boundary.maximumLinearVelocityGapStudsPerSecond - 2) < 1e-6);
  assert.ok(Math.abs(boundary.maximumAngularVelocityGapDegreesPerSecond - 60) < 1e-5);
  assert.ok(Math.abs(boundary.maximumComposedLinearVelocityGapStudsPerSecond! - 2) < 1e-6);
  assert.ok(Math.abs(boundary.maximumComposedAngularVelocityGapDegreesPerSecond! - 60) < 1e-5);
  assert.equal(joint.joint, 'UpperTorso');
  assert.ok(Math.abs(joint.outgoingVelocityStudsPerSecond[0] - 1) < 1e-12);
  assert.ok(Math.abs(joint.incomingVelocityStudsPerSecond[0] + 1) < 1e-12);
  assert.deepEqual(joint.outgoingVelocityStudsPerSecond.slice(1), [0, 0]);
  assert.deepEqual(joint.incomingVelocityStudsPerSecond.slice(1), [0, 0]);
  assert.match(boundary.limitation, /composed velocity samples the compiled blend/);

  const blended = await previewSequence({ kind: 'sequence', name: 'Blended reversal', sampleRate: 30, loop: false, clips: [
    { animationId: outgoing.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0.5 },
    { animationId: incoming.id, start: 0.5, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0.5, fadeOut: 0 },
  ] }, animations);
  const blendedBoundary = blended.diagnostics.transitionBoundaries[0]!;
  assert.ok(blendedBoundary.maximumComposedLinearVelocityGapStudsPerSecond !== null);
  assert.ok(blendedBoundary.maximumComposedLinearVelocityGapStudsPerSecond! < blendedBoundary.maximumLinearVelocityGapStudsPerSecond,
    'the compiled crossfade should report its measured velocity change separately from the raw source seam');
  assert.equal(blendedBoundary.largestComposedLinearVelocityGaps[0]!.joint, 'UpperTorso');
  assert.ok(blendedBoundary.largestComposedLinearVelocityGaps[0]!.composedOutgoingVelocityStudsPerSecond !== null);
  assert.ok(blendedBoundary.largestComposedLinearVelocityGaps[0]!.composedIncomingVelocityStudsPerSecond !== null);
});

test('sequence preview measures nonlinear source motion lost by the linear key bake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-bake-fidelity-'));
  const animations = new Library(join(root, 'animations'));
  const source = await animations.save({
    kind: 'animation', name: 'Bouncy source', duration: 1, loop: false,
    tracks: [{ joint: 'RightUpperArm', keys: [
      { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bounce', easingDirection: 'Out' },
      { time: 1, position: [1, 0, 0], rotation: [90, 0, 0] },
    ] }], markers: [],
  });
  const preview = await previewSequence({ kind: 'sequence', name: 'Baked bounce', sampleRate: 15, loop: false, clips: [
    { animationId: source.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
  ] }, animations);
  const fidelity = preview.diagnostics.samplingFidelity;
  assert.equal(fidelity.outputIntervalCount, 15);
  assert.equal(fidelity.probesPerInterval, 3);
  assert.equal(fidelity.jointProbeCount, 45);
  assert.equal(fidelity.actualKeyCountPerTrack, 16);
  assert.equal(fidelity.expectedUniformKeyCount, 16);
  assert.equal(fidelity.atTrackKeyBudget, false);
  assert.ok(fidelity.maximumOutputIntervalSeconds >= 1 / 15);
  assert.ok(fidelity.maximumPositionErrorStuds > 0.01);
  assert.ok(fidelity.maximumAngularErrorDegrees > 0.1);
  assert.equal(fidelity.largestPositionErrors[0]!.joint, 'RightUpperArm');
  assert.ok(fidelity.largestPositionErrors[0]!.position.time > 0 && fidelity.largestPositionErrors[0]!.position.time < 1);
  assert.ok([0.25, 0.5, 0.75].includes(fidelity.largestPositionErrors[0]!.position.probeFraction));
  assert.ok(Math.abs(fidelity.largestPositionErrors[0]!.position.time - (fidelity.largestPositionErrors[0]!.position.intervalStart
    + (fidelity.largestPositionErrors[0]!.position.intervalEnd - fidelity.largestPositionErrors[0]!.position.intervalStart) * fidelity.largestPositionErrors[0]!.position.probeFraction)) < 1e-12);
  assert.match(fidelity.limitation, /do not bound error between probes/);
  const denser = await previewSequence({ kind: 'sequence', name: 'Baked bounce', sampleRate: 30, loop: false, clips: [
    { animationId: source.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
  ] }, animations);
  assert.ok(denser.diagnostics.samplingFidelity.maximumPositionErrorStuds < fidelity.maximumPositionErrorStuds);
  assert.ok(denser.diagnostics.samplingFidelity.maximumAngularErrorDegrees < fidelity.maximumAngularErrorDegrees);
});

test('adaptive sequence baking allocates keys across translation and rotation peaks while preserving markers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-adaptive-balance-'));
  const animations = new Library(join(root, 'animations'));
  const source = await animations.save({
    kind: 'animation', name: 'Separate motion peaks', duration: 1, loop: false,
    tracks: [
      { joint: 'RightUpperArm', keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Bounce', easingDirection: 'Out' },
        { time: 0.5, position: [1, 0, 0], rotation: [0, 0, 0] },
        { time: 1, position: [1, 0, 0], rotation: [0, 0, 0] },
      ] },
      { joint: 'LeftUpperLeg', keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { time: 0.5, position: [0, 0, 0], rotation: [0, 0, 0], easingStyle: 'Elastic', easingDirection: 'Out' },
        { time: 1, position: [0, 0, 0], rotation: [90, 0, 0] },
      ] },
    ],
    markers: [{ name: 'Impact', time: 0.37 }],
  });
  const preview = await previewSequence({ kind: 'sequence', name: 'Separated peaks', sampleRate: 15, loop: false, clips: [
    { animationId: source.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
  ] }, animations);
  const times = preview.animation.tracks[0]!.keys.map(key => key.time);
  assert.equal(times.length, 16, 'adaptive placement must retain the requested key budget');
  assert.ok(times.includes(0.37), 'authored marker time must remain an exact bake key');
  assert.ok(times.some(time => time > 0 && time < 0.5), 'translation peak region should receive adaptive keys');
  assert.ok(times.some(time => time > 0.5 && time < 1), 'rotation peak region should receive adaptive keys');
  const positionError = preview.diagnostics.samplingFidelity.largestPositionErrors.find(item => item.joint === 'RightUpperArm');
  const rotationError = preview.diagnostics.samplingFidelity.largestRotationErrors.find(item => item.joint === 'LeftUpperLeg');
  assert.ok(positionError && positionError.position.errorStuds > 0.01);
  assert.ok(rotationError && rotationError.rotation.errorDegrees > 0.1);
});

test('saved sequences pin exact source contents, report stale timelines, and allow an explicit adopting revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-integrity-'));
  const animations = new Library(join(root, 'animations'));
  const source = await animations.save(animationPreset('idle', 'Pinned idle', 2, 1));
  const sequences = new SequenceLibrary(join(root, 'sequences'), animations);
  const sequence = await sequences.save({ kind: 'sequence', name: 'Pinned timeline', sampleRate: 30, loop: false, clips: [
    { animationId: source.id, start: 0, sourceStart: 0, sourceEnd: 2, speed: 1, fadeIn: 0, fadeOut: 0 },
  ] });
  assert.deepEqual(sequence.sourceFingerprints, [fingerprint(source.recipe)]);
  assert.equal((await sequences.list()).sequences[0]!.sourceIntegrity, 'verified');

  const sourcePath = join(root, 'animations', `${source.id}.json`);
  const editedSource = JSON.parse(await readFile(sourcePath, 'utf8')) as typeof source;
  editedSource.recipe.name = 'Externally changed idle';
  await writeFile(sourcePath, JSON.stringify(editedSource, null, 2));

  await assert.rejects(() => sequences.get(sequence.id), /stale source assets/);
  const listing = await sequences.list();
  assert.equal(listing.sequences[0]!.sourceIntegrity, 'stale');
  assert.match(listing.sequences[0]!.sourceIntegrityIssue ?? '', /changed since this sequence was saved/);

  const adoptedRevision = await sequences.save(sequence.recipe, sequence.id);
  assert.equal(adoptedRevision.parentId, sequence.id);
  assert.deepEqual(adoptedRevision.sourceFingerprints, [fingerprint(editedSource.recipe)]);
  assert.equal((await sequences.get(adoptedRevision.id)).id, adoptedRevision.id);
});

test('pre-fingerprint sequence records remain readable and are clearly marked unverified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-legacy-'));
  const animations = new Library(join(root, 'animations'));
  const source = await animations.save(animationPreset('idle', 'Legacy source', 2, 1));
  const sequences = new SequenceLibrary(join(root, 'sequences'), animations);
  const legacyId = '00000000-0000-4000-8000-000000000001';
  await mkdir(join(root, 'sequences'), { recursive: true });
  await writeFile(join(root, 'sequences', `${legacyId}.json`), JSON.stringify({
    id: legacyId, createdAt: new Date().toISOString(),
    recipe: { kind: 'sequence', name: 'Legacy timeline', sampleRate: 30, loop: false, clips: [
      { animationId: source.id, start: 0, sourceStart: 0, sourceEnd: 2, speed: 1, fadeIn: 0, fadeOut: 0 },
    ] },
  }));
  assert.equal((await sequences.get(legacyId)).id, legacyId);
  assert.equal((await sequences.list()).sequences[0]!.sourceIntegrity, 'legacy_unverified');
});

test('adjacent clips cut at the placement boundary instead of being unintentionally averaged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-cut-'));
  const animations = new Library(join(root, 'animations'));
  const make = (name: string, degrees: number) => animations.save({
    kind: 'animation', name, duration: 1, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [degrees, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [degrees, 0, 0] }] }], markers: [],
  });
  const first = await make('First', 10), second = await make('Second', 30);
  const compiled = await compileSequence({ kind: 'sequence', name: 'Cut', sampleRate: 15, loop: false, clips: [
    { animationId: first.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
    { animationId: second.id, start: 1, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 },
  ] }, animations);
  const boundary = compiled.tracks[0]!.keys.find(key => key.time === 1)!;
  assert.ok(Math.abs(boundary.rotation[0] - 30) < 1e-8);
});

test('sequence revisions are immutable, persistent, and compile into reusable library animations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-'));
  const animations = new Library(join(root, 'animations'));
  const source = await animations.save(animationPreset('slash', 'Slash', 2, 0.7));
  const sequences = new SequenceLibrary(join(root, 'sequences'), animations);
  const initial = await sequences.save({ kind: 'sequence', name: 'Attack', sampleRate: 24, loop: false, clips: [{ animationId: source.id, start: 0, sourceStart: 0, sourceEnd: 2, speed: 1, fadeIn: 0, fadeOut: 0 }] });
  const revision = await sequences.save({ ...initial.recipe, name: 'Attack Faster', clips: [{ ...initial.recipe.clips[0]!, speed: 2 }] }, initial.id);
  assert.equal((await sequences.get(initial.id)).recipe.clips[0]!.speed, 1);
  assert.equal(revision.parentId, initial.id);
  const results = await sequences.list();
  assert.equal(results.total, 2);
  assert.deepEqual(results.sequences.map(item => item.duration).sort(), [1, 2]);
  const compiled = await compileSequence(revision.recipe, animations);
  const asset = await animations.save(compiled);
  assert.equal((await animations.get(asset.id)).recipe.kind, 'animation');
});

test('sequence compiler evaluates non-destructive source layers before assembling clips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-layers-'));
  const animations = new Library(join(root, 'animations'));
  const base = await animations.save({
    kind: 'animation', name: 'Layered', duration: 1, loop: false,
    tracks: [{ joint: 'UpperTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] }],
    layers: [{ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Secondary', blendMode: 'Additive', weight: 1, enabled: true, tracks: [{ joint: 'UpperTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [12, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [12, 0, 0] }] }] }],
    markers: [],
  });
  const compiled = await compileSequence({ kind: 'sequence', name: 'Layer check', sampleRate: 15, loop: false, clips: [{ animationId: base.id, start: 0, sourceStart: 0, sourceEnd: 1, speed: 1, fadeIn: 0, fadeOut: 0 }] }, animations);
  assert.ok(compiled.tracks[0]!.keys.every(key => Math.abs(key.rotation[0] - 12) < 1e-5));
});

test('sequence compilation bakes root travel and remaps clipped contact windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-root-'));
  const animations = new Library(join(root, 'animations'));
  const source = await animations.save({
    kind: 'animation', name: 'Rooted', duration: 1, loop: false,
    tracks: [{ joint: 'LowerTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [0, 0, 0], rotation: [0, 0, 0] }] }],
    rootMotion: { joint: 'LowerTorso', keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 1, position: [1, 0, 0], rotation: [0, 0, 0] }] },
    contacts: [{ effector: 'LeftFoot', kind: 'support', start: 0.2, end: 0.8 }], markers: [],
  });
  const sequence = { kind: 'sequence' as const, name: 'Rooted excerpt', sampleRate: 15, loop: false, clips: [
    { animationId: source.id, start: 0.25, sourceStart: 0.1, sourceEnd: 0.9, speed: 2, fadeIn: 0, fadeOut: 0 },
  ] };
  const compiled = await compileSequence(sequence, animations);
  const preview = await previewSequence(sequence, animations);
  assert.deepEqual(preview.diagnostics.gaps, [{ start: 0, end: 0.25, duration: 0.25 }]);
  assert.deepEqual(preview.animation, compiled);
  const track = compiled.tracks.find(candidate => candidate.joint === 'LowerTorso')!;
  const first = track.keys.find(key => Math.abs(key.time - 0.25) < 1e-9)!;
  const last = track.keys.find(key => Math.abs(key.time - 0.65) < 1e-9)!;
  assert.ok(Math.abs(first.position[0] - 0.1) < 1e-8);
  assert.ok(Math.abs(last.position[0] - 0.9) < 1e-8);
  assert.deepEqual(compiled.contacts, [{ effector: 'LeftFoot', kind: 'support', start: 0.3, end: 0.6 }]);
});

test('compile rejects timelines that cannot be represented by Roblox animation limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-sequence-'));
  const animations = new Library(join(root, 'animations'));
  const source = await animations.save(animationPreset('idle', 'Long', 30, 1));
  await assert.rejects(() => compileSequence({ kind: 'sequence', name: 'Too long', sampleRate: 60, loop: false, clips: [{ animationId: source.id, start: 0, sourceStart: 0, sourceEnd: 30, speed: 0.5, fadeIn: 0, fadeOut: 0 }] }, animations), /limited to 30 seconds/);
});
