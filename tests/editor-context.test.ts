import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEditorContext } from '../src/editor-context.js';

test('layout availability requires bounded recognized panel and geometry metadata while legacy absence remains unknown', () => {
  const layout = { version: 1, inspector: 'settings', libraryExpanded: true, libraryPinned: false,
    timelineHeightPixels: 260, viewportWidthPixels: 800, viewportHeightPixels: 400 };
  const snapshot = { schemaVersion: 1, layout, fieldAvailability: { layout: 'available' } };
  assert.equal(assessEditorContext(snapshot).status, 'consistent');
  for (const changed of [{ inspector: 'invented' }, { viewportWidthPixels: 0 }, { timelineHeightPixels: Number.NaN },
    { libraryPinned: 'true' }, { version: 2 }]) {
    assert.deepEqual(assessEditorContext({ ...snapshot, layout: { ...layout, ...changed } }).contradictedAvailableFields, ['layout']);
  }
  assert.equal(assessEditorContext({ schemaVersion: 1, fieldAvailability: {} }).status, 'consistent');
  assert.deepEqual(assessEditorContext({ schemaVersion: 1, fieldAvailability: { layout: 'available' } }).contradictedAvailableFields, ['layout']);
});

test('server editor-context assessment flags contradictory available claims without upgrading unknown fields', () => {
  const validSnapshot = {
    schemaVersion: 1,
    viewportOpen: true,
    rigLoaded: true,
    rigId: 'rig-1',
    clipLoaded: true,
    clipId: 'clip-1',
    selectedJoint: 'RightHand',
    isDirty: true,
    loadedAssetFingerprint: 'source-fingerprint',
    durationSeconds: 2,
    playheadSeconds: 0.5,
    timelineStartSeconds: 0.25,
    timelineEndSeconds: 1.75,
    cameraYawDegrees: 20,
    cameraPitchDegrees: 10,
    cameraDistanceStuds: 12,
    cameraFieldOfView: 40,
    cameraTargetStuds: { x: 0, y: 2, z: 0 },
    fieldAvailability: {
      rig: 'available', clip: 'available', selection: 'joint_selected', playhead: 'available', timeline: 'available',
      viewportCamera: 'available', loadedSourceFingerprint: 'source_only_dirty_draft',
    },
  };
  assert.equal(assessEditorContext(validSnapshot).status, 'consistent');

  const malformed = { ...validSnapshot,
    playheadSeconds: 3,
    timelineStartSeconds: 1.5,
    timelineEndSeconds: 1,
    cameraTargetStuds: { x: Number.NaN, y: 2, z: 0 },
    fieldAvailability: { ...validSnapshot.fieldAvailability, playhead: 'available', timeline: 'available', viewportCamera: 'available' },
  };
  const assessment = assessEditorContext(malformed);
  assert.equal(assessment.status, 'inconsistent');
  assert.deepEqual(assessment.contradictedAvailableFields, ['playhead', 'timeline', 'viewportCamera']);

  const sanitizedButUnavailable = { ...validSnapshot,
    cameraPitchDegrees: 90,
    fieldAvailability: { ...validSnapshot.fieldAvailability, viewportCamera: 'viewport_closed_or_camera_unavailable' },
  };
  assert.equal(assessEditorContext(sanitizedButUnavailable).status, 'consistent',
    'the server must not upgrade unavailable values just because their sanitized form looks valid');
});

test('server editor-context assessment treats absent and unsupported snapshots as unverified', () => {
  assert.equal(assessEditorContext(undefined).status, 'absent');
  assert.equal(assessEditorContext({ schemaVersion: 2, fieldAvailability: { viewportCamera: 'available' } }).status, 'unsupported_schema');
});

test('editor-context assessment classifies heartbeat freshness separately from metadata consistency', () => {
  const validSnapshot = { schemaVersion: 1, fieldAvailability: { viewportCamera: 'available' }, viewportOpen: true,
    cameraYawDegrees: 0, cameraPitchDegrees: 0, cameraDistanceStuds: 10, cameraFieldOfView: 70,
    cameraTargetStuds: { x: 0, y: 0, z: 0 } };
  const fresh = assessEditorContext(validSnapshot, { online: true, heartbeatAgeMs: 9_999 });
  assert.equal(fresh.status, 'consistent');
  assert.equal(fresh.freshness.status, 'fresh');
  assert.equal(fresh.freshness.maximumAgeMs, 10_000);
  assert.match(fresh.freshness.interpretation, /exact draft identity still requires a fresh editor-draft read/i);

  const stale = assessEditorContext(validSnapshot, { online: true, heartbeatAgeMs: 10_000 });
  assert.equal(stale.status, 'consistent', 'staleness must not be confused with contradictory metadata');
  assert.equal(stale.freshness.status, 'stale');
  assert.equal(assessEditorContext(undefined, { online: false, heartbeatAgeMs: 0 }).freshness.status, 'stale');
  assert.equal(assessEditorContext(validSnapshot).freshness.status, 'unknown');
  assert.equal(assessEditorContext({ schemaVersion: 9 }, { online: true, heartbeatAgeMs: 1 }).freshness.status, 'fresh');
});
