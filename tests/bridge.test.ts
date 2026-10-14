import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobNextAction, Queue } from '../src/bridge.js';

test('job next-action guidance distinguishes polling, completed results, and safe versus ambiguous retries', () => {
  assert.match(jobNextAction({ status: 'queued' }), /poll this same job ID/i);
  assert.match(jobNextAction({ status: 'running' }), /do not submit a duplicate/i);
  assert.match(jobNextAction({ status: 'succeeded' }), /use the returned result/i);
  assert.match(jobNextAction({ status: 'failed' }), /may have partially applied/i);
  assert.match(jobNextAction({ status: 'unknown' }), /reconcile.*before any retry/i);
  assert.match(jobNextAction({ status: 'expired' }), /was not delivered/i);
  assert.match(jobNextAction({ status: 'cancelled' }), /only if the operation is still needed/i);
  assert.match(jobNextAction({ status: 'expired', recoveredFromJournal: true, lastKnownStatus: 'running' }), /may have been applied/i);
  assert.match(jobNextAction({ status: 'succeeded', recoveredFromJournal: true, lastKnownStatus: 'succeeded' }), /result is unavailable/i);
});

test('Studio session diagnostics report heartbeat freshness and pending job pressure without changing snapshot fields', () => {
  let now = 1_800_000_000_000;
  const queue = new Queue(() => now);
  const sessionId = randomUUID();
  const rig = { id: randomUUID(), rigSignature: 'R15|fixture' };
  queue.heartbeat(sessionId, { activeRig: rig, pluginVersion: 'test', motionEditor: {
    viewportOpen: true, clipName: 'Walk', isDirty: true, playheadSeconds: 0.45, isPlaying: false,
    cameraYawDegrees: 35, interpretation: 'Editor state only; not visual proof.',
  } });
  const queued = queue.enqueue(sessionId, 'inspect', { rigId: rig.id });
  const running = queue.enqueue(sessionId, 'sample_animation', { rigId: rig.id });
  assert.equal(queue.poll(sessionId)?.id, queued.id);
  now += 12_000;
  const session = queue.listSessions()[0]!;
  assert.equal(session.online, false);
  assert.equal(session.heartbeatAgeMs, 12_000);
  const listedRig = session.snapshot.activeRig as { id: string };
  assert.equal(listedRig.id, rig.id);
  assert.equal(session.snapshot.pluginVersion, 'test');
  const editor = session.snapshot.motionEditor as { viewportOpen: boolean; clipName: string; isDirty: boolean;
    playheadSeconds: number; isPlaying: boolean; cameraYawDegrees: number; interpretation: string };
  assert.equal(editor.viewportOpen, true);
  assert.equal(editor.clipName, 'Walk');
  assert.equal(editor.isDirty, true);
  assert.equal(editor.playheadSeconds, 0.45);
  assert.equal(editor.isPlaying, false);
  assert.equal(editor.cameraYawDegrees, 35);
  assert.match(editor.interpretation, /not visual proof/i);
  assert.equal(session.jobs.running, 1);
  assert.equal(session.jobs.queued, 1);
  assert.equal(session.jobs.unknown, 0);
  assert.equal(session.jobs.oldestPendingAgeMs, 12_000);
  assert.equal(session.seenAt, 1_800_000_000_000);
  assert.equal(session.seenAtIso, new Date(1_800_000_000_000).toISOString());
  assert.equal(running.status, 'queued');
});

test('Studio session diagnostics mark lost job responses as unknown and expire undelivered commands', () => {
  let now = 1_800_000_000_000;
  const queue = new Queue(() => now);
  const sessionId = randomUUID();
  queue.heartbeat(sessionId, {});
  const delivered = queue.enqueue(sessionId, 'inspect', {});
  const neverDelivered = queue.enqueue(sessionId, 'sample_animation', {});
  assert.equal(queue.poll(sessionId)?.id, delivered.id);
  now += 60_001;
  const session = queue.listSessions()[0]!;
  assert.equal(session.jobs.unknown, 1);
  assert.equal(session.jobs.queued, 0);
  assert.equal(queue.get(neverDelivered.id).status, 'expired');
  assert.equal(queue.complete(sessionId, delivered.id, true, { ok: true }), undefined);
  assert.equal(queue.get(delivered.id).status, 'succeeded');
});

test('Studio heartbeats and diagnostic snapshots are isolated from caller mutation', () => {
  const queue = new Queue();
  const sessionId = randomUUID();
  const snapshot = { activeRig: { id: randomUUID(), nested: { label: 'before' } } };
  queue.heartbeat(sessionId, snapshot);
  snapshot.activeRig.nested.label = 'mutated after heartbeat';
  const listed = queue.listSessions()[0]!;
  const listedRig = listed.snapshot.activeRig as { nested: { label: string } };
  assert.equal(listedRig.nested.label, 'before');
  listedRig.nested.label = 'mutated after listing';
  const latestRig = queue.listSessions()[0]!.snapshot.activeRig as { nested: { label: string } };
  assert.equal(latestRig.nested.label, 'before');
});

test('job recovery lists compact statuses without exposing command payloads or results', () => {
  let now = 1_800_000_000_000;
  const queue = new Queue(() => now);
  const sessionId = randomUUID();
  queue.heartbeat(sessionId, {});
  const active = queue.enqueue(sessionId, 'sample_animation', { recipe: { tracks: ['large'] } });
  const terminal = queue.enqueue(sessionId, 'inspect', { secret: 'not returned' });
  assert.equal(queue.poll(sessionId)?.id, active.id);
  queue.complete(sessionId, active.id, true, { telemetry: 'large result' });
  queue.cancelQueued(terminal.id);
  const next = queue.enqueue(sessionId, 'capture_frame', { png: 'large bytes' });
  queue.cancelQueued(next.id);

  const activeJobs = queue.listJobs(sessionId);
  assert.equal(activeJobs.returned, 0, 'terminal jobs are excluded by default');
  const history = queue.listJobs(sessionId, 10, true);
  assert.equal(history.returned, 3);
  const recovered = history.jobs.find(job => job.id === active.id)!;
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.operation, 'sample_animation');
  assert.equal('payload' in recovered, false);
  assert.equal('result' in recovered, false);
  assert.equal(history.jobs.find(job => job.id === next.id)?.status, 'cancelled');
  assert.equal(history.jobs.find(job => job.id === terminal.id)?.status, 'cancelled');
  assert.equal(history.online, true);
  assert.equal(history.heartbeatAgeMs, 0);
  now += 5_000;
  assert.equal(queue.listJobs(sessionId).heartbeatAgeMs, 5_000);
});

test('durable Studio job journal recovers safe statuses without persisting payloads or results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-studio-job-journal-'));
  try {
    let now = 1_800_000_000_000;
    const journalPath = join(root, 'artifacts', 'studio-jobs.json');
    const original = new Queue(() => now, journalPath);
    const oldSessionId = randomUUID();
    original.heartbeat(oldSessionId, {});
    const running = original.enqueue(oldSessionId, 'save_vfx', { secretVfx: 'DO_NOT_PERSIST_PAYLOAD' });
    assert.equal(original.poll(oldSessionId)?.id, running.id);
    const succeeded = original.enqueue(oldSessionId, 'inspect', { secretInspection: 'DO_NOT_PERSIST_PAYLOAD' });
    assert.equal(original.poll(oldSessionId)?.id, succeeded.id);
    original.complete(oldSessionId, succeeded.id, true, { privateResult: 'DO_NOT_PERSIST_RESULT' });
    const queued = original.enqueue(oldSessionId, 'save_animation', { secretRecipe: 'DO_NOT_PERSIST_PAYLOAD' });

    const persisted = await readFile(journalPath, 'utf8');
    assert.doesNotMatch(persisted, /DO_NOT_PERSIST/);
    assert.doesNotMatch(persisted, /payload|result/i);

    now += 1000;
    const restarted = new Queue(() => now, journalPath);
    const recovered = restarted.listRecoveredJobs(10);
    assert.equal(recovered.total, 3);
    assert.equal(recovered.jobs.find(job => job.id === queued.id)?.status, 'expired');
    assert.equal(recovered.jobs.find(job => job.id === running.id)?.status, 'unknown');
    assert.equal(recovered.jobs.find(job => job.id === succeeded.id)?.status, 'succeeded');
    assert.equal(recovered.jobs.find(job => job.id === succeeded.id)?.resultAvailable, false);
    assert.match(recovered.jobs.find(job => job.id === running.id)!.recoveryNote, /inspect the scene/i);
    assert.match(recovered.jobs.find(job => job.id === running.id)!.nextAction, /reconcile.*before any retry/i);
    assert.match(recovered.jobs.find(job => job.id === queued.id)!.nextAction, /had not been delivered/i);
    const loadedSucceeded = restarted.get(succeeded.id);
    assert.equal(loadedSucceeded.recoveredFromJournal, true);
    assert.equal(loadedSucceeded.result, undefined);

    const restartedAgain = new Queue(() => now, journalPath);
    assert.equal(restartedAgain.listRecoveredJobs(10).jobs.find(job => job.id === running.id)?.lastKnownStatus, 'running');
    restarted.complete(oldSessionId, running.id, true, { confirmedAfterRestart: true });
    const lateResult = restarted.get(running.id);
    assert.equal(lateResult.status, 'succeeded');
    assert.deepEqual(lateResult.result, { confirmedAfterRestart: true });
    assert.equal(lateResult.recoveredFromJournal, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('durable Studio job journal fails closed on corruption instead of pretending no prior jobs exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'motion-studio-job-journal-corrupt-'));
  try {
    const journalPath = join(root, 'studio-jobs.json');
    await writeFile(journalPath, '{not valid JSON');
    assert.throws(() => new Queue(Date.now, journalPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('full queue reclaims only known-terminal history and refuses to drop potentially applied work', () => {
  let now = 1_800_000_000_000;
  const queue = new Queue(() => now);
  const sessionId = randomUUID();
  queue.heartbeat(sessionId, {});
  const jobs = Array.from({ length: 256 }, (_, index) => queue.enqueue(sessionId, 'inspect', { index }));
  assert.equal(queue.poll(sessionId)?.id, jobs[0]!.id);
  queue.complete(sessionId, jobs[0]!.id, true, { ok: true });
  const replacement = queue.enqueue(sessionId, 'inspect', { replacement: true });
  assert.equal(queue.get(replacement.id).status, 'queued');
  assert.throws(() => queue.get(jobs[0]!.id), /not present in the retained local Studio job journal/i);
  assert.equal(queue.get(jobs[1]!.id).status, 'queued', 'queued work remains intact while terminal history is pruned');

  let activeNow = now;
  const activeQueue = new Queue(() => activeNow);
  const activeSession = randomUUID();
  activeQueue.heartbeat(activeSession, {});
  const activeJobs = Array.from({ length: 256 }, () => {
    const job = activeQueue.enqueue(activeSession, 'sample_animation', {});
    assert.equal(activeQueue.poll(activeSession)?.id, job.id);
    return job;
  });
  activeNow += 60_001;
  activeQueue.heartbeat(activeSession, {});
  assert.throws(() => activeQueue.enqueue(activeSession, 'inspect', {}), /full of queued, running, or unknown/i);
  assert.equal(activeQueue.get(activeJobs[0]!.id).status, 'unknown', 'potentially applied work is never evicted to make room');
});
