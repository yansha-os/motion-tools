type EditorAvailability = Record<string, unknown>;
const HEARTBEAT_FRESHNESS_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validCameraTarget(value: unknown) {
  return isRecord(value) && ['x', 'y', 'z'].every(axis => finiteNumber(value[axis]) && Math.abs(value[axis]) <= 1_000_000);
}

function validViewportCamera(snapshot: Record<string, unknown>) {
  return snapshot.viewportOpen === true
    && finiteNumber(snapshot.cameraYawDegrees) && Math.abs(snapshot.cameraYawDegrees) <= 360_000
    && finiteNumber(snapshot.cameraPitchDegrees) && snapshot.cameraPitchDegrees >= -90 && snapshot.cameraPitchDegrees <= 90
    && finiteNumber(snapshot.cameraDistanceStuds) && snapshot.cameraDistanceStuds >= 0.05 && snapshot.cameraDistanceStuds <= 100_000
    && finiteNumber(snapshot.cameraFieldOfView) && snapshot.cameraFieldOfView >= 1 && snapshot.cameraFieldOfView <= 120
    && validCameraTarget(snapshot.cameraTargetStuds);
}

function validDuration(snapshot: Record<string, unknown>): snapshot is Record<string, unknown> & { durationSeconds: number } {
  return finiteNumber(snapshot.durationSeconds) && snapshot.durationSeconds > 0 && snapshot.durationSeconds <= 30;
}

function validPlayhead(snapshot: Record<string, unknown>) {
  return snapshot.clipLoaded === true && validDuration(snapshot)
    && finiteNumber(snapshot.playheadSeconds) && snapshot.playheadSeconds >= 0 && snapshot.playheadSeconds <= snapshot.durationSeconds;
}

function validTimeline(snapshot: Record<string, unknown>) {
  return snapshot.clipLoaded === true && validDuration(snapshot)
    && finiteNumber(snapshot.timelineStartSeconds) && snapshot.timelineStartSeconds >= 0
    && finiteNumber(snapshot.timelineEndSeconds) && snapshot.timelineEndSeconds > snapshot.timelineStartSeconds
    && snapshot.timelineEndSeconds <= snapshot.durationSeconds;
}

function validLayout(value: unknown) {
  return isRecord(value) && value.version === 1
    && typeof value.inspector === 'string' && ['none', 'pose', 'layers', 'easing', 'poses', 'settings'].includes(value.inspector)
    && typeof value.libraryExpanded === 'boolean' && typeof value.libraryPinned === 'boolean'
    && finiteNumber(value.timelineHeightPixels) && value.timelineHeightPixels >= 100 && value.timelineHeightPixels <= 1000
    && finiteNumber(value.viewportWidthPixels) && value.viewportWidthPixels >= 1 && value.viewportWidthPixels <= 20000
    && finiteNumber(value.viewportHeightPixels) && value.viewportHeightPixels >= 1 && value.viewportHeightPixels <= 20000;
}

/** Independently checks only positive availability claims; absent or sanitized values remain unverified. */
export function assessEditorContext(snapshotValue: unknown, heartbeat?: { online: boolean; heartbeatAgeMs: number }) {
  const freshness = !heartbeat || !finiteNumber(heartbeat.heartbeatAgeMs) || heartbeat.heartbeatAgeMs < 0
    ? { status: 'unknown' as const, maximumAgeMs: HEARTBEAT_FRESHNESS_MS,
      interpretation: 'Heartbeat freshness was not supplied; do not treat editor state as current.' }
    : heartbeat.online && heartbeat.heartbeatAgeMs < HEARTBEAT_FRESHNESS_MS
      ? { status: 'fresh' as const, heartbeatAgeMs: heartbeat.heartbeatAgeMs, maximumAgeMs: HEARTBEAT_FRESHNESS_MS,
        interpretation: 'The Studio heartbeat is within the live-session freshness window; exact draft identity still requires a fresh editor-draft read.' }
      : { status: 'stale' as const, heartbeatAgeMs: heartbeat.heartbeatAgeMs, maximumAgeMs: HEARTBEAT_FRESHNESS_MS,
        interpretation: 'The Studio heartbeat is offline or outside the live-session freshness window; refresh Studio context before relying on viewport state.' };
  if (!isRecord(snapshotValue)) return { status: 'absent' as const, freshness, contradictedAvailableFields: [], interpretation: 'No motionEditor heartbeat snapshot was reported.' };
  if (snapshotValue.schemaVersion !== 1) return { status: 'unsupported_schema' as const, schemaVersion: snapshotValue.schemaVersion ?? null,
    freshness, contradictedAvailableFields: [], interpretation: 'The editor-context schema is unsupported; treat its fieldAvailability claims as unverified.' };

  const reported = isRecord(snapshotValue.fieldAvailability) ? snapshotValue.fieldAvailability as EditorAvailability : {};
  const predicates: Record<string, boolean> = {
    layout: validLayout(snapshotValue.layout),
    rig: snapshotValue.rigLoaded === true && nonEmptyString(snapshotValue.rigId),
    clip: snapshotValue.clipLoaded === true && nonEmptyString(snapshotValue.clipId),
    selection: snapshotValue.clipLoaded === true && nonEmptyString(snapshotValue.selectedJoint),
    playhead: validPlayhead(snapshotValue),
    timeline: validTimeline(snapshotValue),
    viewportCamera: validViewportCamera(snapshotValue),
    loadedSourceFingerprint: nonEmptyString(snapshotValue.loadedAssetFingerprint),
  };
  const contradictedAvailableFields = Object.entries(predicates)
    .filter(([field, valid]) => reported[field] === 'available' && !valid)
    .map(([field]) => field)
    .sort();
  return {
    status: contradictedAvailableFields.length ? 'inconsistent' as const : 'consistent' as const,
    schemaVersion: 1 as const,
    freshness,
    contradictedAvailableFields,
    interpretation: contradictedAvailableFields.length
      ? 'The server found fields marked available without sufficient matching heartbeat values. Treat those fields as unavailable and refresh Studio context.'
      : 'No contradictory available-field claims were found. This checks metadata consistency only; it does not verify rendered appearance or heartbeat freshness.',
  };
}
