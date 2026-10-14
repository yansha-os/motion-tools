local EditorContext = (function()
-- INSERT_EDITOR_CONTEXT_HERE
end)()
local EditorTransaction = (function()
-- INSERT_EDITOR_TRANSACTION_HERE
end)()

local snapshot = EditorContext.snapshot({
    viewportOpen = true, rigLoaded = true, clipLoaded = true, isPlaying = true, isDirty = true,
    isEphemeralCandidate = false, looping = true, rigId = "rig-1", clipId = "asset-1", clipName = "Walk",
    loadedAssetFingerprint = string.rep("a", 64), activeLayerId = "layer-1", selectedJoint = "RightHand",
    selectedKeyTime = 0.75, playheadSeconds = 0.5, durationSeconds = 2, playbackSpeed = 1.25,
    timelineStartSeconds = 0, timelineEndSeconds = 1, cameraYawDegrees = 90, cameraPitchDegrees = 8,
    cameraDistanceStuds = 12, cameraTargetStuds = { x = 1, y = 2, z = 3 }, cameraFieldOfView = 70,
    recipe = { shouldNever = "be copied" },
})
assert(snapshot.schemaVersion == 1 and snapshot.viewportOpen and snapshot.rigLoaded and snapshot.clipLoaded)
assert(snapshot.isPlaying and snapshot.isDirty and snapshot.looping and not snapshot.isEphemeralCandidate)
assert(snapshot.rigId == "rig-1" and snapshot.clipId == "asset-1" and snapshot.clipName == "Walk")
assert(snapshot.selectedJoint == "RightHand" and snapshot.selectedKeyTime == 0.75)
assert(snapshot.cameraTargetStuds.x == 1 and snapshot.cameraTargetStuds.y == 2 and snapshot.cameraTargetStuds.z == 3)
assert(snapshot.recipe == nil, "editor heartbeat must not expose the animation recipe")
assert(string.find(snapshot.interpretation, "heartbeatAgeMs", 1, true))
assert(snapshot.fieldAvailability.rig == "available" and snapshot.fieldAvailability.clip == "available")
assert(snapshot.fieldAvailability.selection == "joint_selected" and snapshot.fieldAvailability.playhead == "available")
assert(snapshot.fieldAvailability.timeline == "available" and snapshot.fieldAvailability.viewportCamera == "available")
assert(snapshot.fieldAvailability.loadedSourceFingerprint == "source_only_dirty_draft")

local layout = { version = 1, inspector = "settings", libraryExpanded = true, libraryPinned = false,
    timelineHeightPixels = 260, viewportWidthPixels = 800, viewportHeightPixels = 400, recipe = { private = true } }
local withLayout = EditorContext.snapshot({ layout = layout })
assert(withLayout.fieldAvailability.layout == "available")
assert(withLayout.layout.inspector == "settings" and withLayout.layout.timelineHeightPixels == 260)
assert(withLayout.layout.recipe == nil, "layout context must not copy recipe or arbitrary fields")
layout.inspector = "invented"
local unknownPanel = EditorContext.snapshot({ layout = layout })
assert(unknownPanel.layout == nil and unknownPanel.fieldAvailability.layout == "unavailable")
layout.inspector = "pose"
layout.viewportHeightPixels = 0
assert(EditorContext.snapshot({ layout = layout }).layout == nil, "unmeasured geometry must remain unavailable")

local malformed = EditorContext.snapshot({
    viewportOpen = 1, rigLoaded = false, playheadSeconds = math.huge, durationSeconds = -2,
    cameraPitchDegrees = 120, cameraDistanceStuds = 0, cameraTargetStuds = { x = 0 / 0, y = 1, z = 2 },
    clipName = string.rep("x", 300),
})
assert(not malformed.viewportOpen and not malformed.rigLoaded)
assert(malformed.playheadSeconds == nil and malformed.durationSeconds == 0)
assert(malformed.cameraPitchDegrees == 90 and malformed.cameraDistanceStuds == 0.05)
assert(malformed.cameraTargetStuds == nil and #malformed.clipName == 256)
assert(malformed.fieldAvailability.clip == "no_clip" and malformed.fieldAvailability.selection == "no_clip")
assert(malformed.fieldAvailability.playhead == "no_clip" and malformed.fieldAvailability.viewportCamera == "viewport_closed_or_camera_unavailable")

local invalidCameraTarget = EditorContext.snapshot({
    viewportOpen = true, cameraYawDegrees = 0, cameraPitchDegrees = 0, cameraDistanceStuds = 12,
    cameraTargetStuds = { x = 0 / 0, y = 1, z = 2 },
})
assert(invalidCameraTarget.cameraTargetStuds == nil)
assert(invalidCameraTarget.fieldAvailability.viewportCamera == "viewport_closed_or_camera_unavailable",
    "camera availability must not claim a complete pose when target telemetry is malformed")

local clampedCamera = EditorContext.snapshot({
    viewportOpen = true, cameraYawDegrees = 0, cameraPitchDegrees = 120, cameraDistanceStuds = 0,
    cameraTargetStuds = { x = 0, y = 0, z = 0 }, cameraFieldOfView = 70,
})
assert(clampedCamera.cameraPitchDegrees == 90 and clampedCamera.cameraDistanceStuds == 0.05)
assert(clampedCamera.fieldAvailability.viewportCamera == "viewport_closed_or_camera_unavailable",
    "sanitized camera coordinates must not be represented as a faithful current camera pose")

local invalidFov = EditorContext.snapshot({
    viewportOpen = true, cameraYawDegrees = 0, cameraPitchDegrees = 0, cameraDistanceStuds = 12,
    cameraTargetStuds = { x = 0, y = 0, z = 0 }, cameraFieldOfView = 150,
})
assert(invalidFov.cameraFieldOfView == 120)
assert(invalidFov.fieldAvailability.viewportCamera == "viewport_closed_or_camera_unavailable",
    "sanitized field of view must not be presented as current camera framing")

local outOfClipEditor = EditorContext.snapshot({
    clipLoaded = true, durationSeconds = 2, playheadSeconds = 2.5,
    timelineStartSeconds = 1.5, timelineEndSeconds = 1,
})
assert(outOfClipEditor.fieldAvailability.playhead == "unavailable",
    "a finite playhead outside the clip must not be reported as usable editor context")
assert(outOfClipEditor.fieldAvailability.timeline == "unavailable",
    "a reversed timeline window must not be reported as usable editor context")

local boundedEditor = EditorContext.snapshot({
    clipLoaded = true, durationSeconds = 2, playheadSeconds = 0.5,
    timelineStartSeconds = 0.25, timelineEndSeconds = 1.75,
})
assert(boundedEditor.fieldAvailability.playhead == "available" and boundedEditor.fieldAvailability.timeline == "available",
    "valid clip-relative playhead and timeline values remain available")

local empty = EditorContext.snapshot({})
assert(not empty.viewportOpen and not empty.rigLoaded and not empty.clipLoaded and not empty.isPlaying)
assert(empty.fieldAvailability.rig == "unavailable" and empty.fieldAvailability.clip == "no_clip")
assert(empty.fieldAvailability.selection == "no_clip" and empty.fieldAvailability.loadedSourceFingerprint == "requires_fresh_editor_draft_read")
assert(EditorContext.applyDisposition(true, false, true) == "already_applied",
    "an exact dirty candidate match must reconcile as already applied, not create another undo entry")
assert(EditorContext.applyDisposition(false, true, false) == "apply")
assert(EditorContext.applyDisposition(true, false, false) == "stale_draft")
local draft = { recipe = "base", dirty = false }
local undo, redo = { "prior" }, { "redoable" }
local applied, applyError, rolledBack = EditorTransaction.run(function()
    draft.recipe, draft.dirty = "candidate", true
    table.insert(undo, "candidate")
    table.clear(redo)
    error("simulated viewport refresh failure")
end, function()
    draft.recipe, draft.dirty = "base", false
    table.remove(undo)
    table.insert(redo, "redoable")
end)
assert(not applied and string.find(tostring(applyError), "simulated viewport refresh failure", 1, true) and rolledBack)
assert(draft.recipe == "base" and not draft.dirty and #undo == 1 and undo[1] == "prior" and #redo == 1 and redo[1] == "redoable",
    "failed candidate application must restore the draft and undo/redo history before returning")
local committed, committedResult = EditorTransaction.run(function() return "applied" end, function()
    error("rollback must not run after success")
end)
assert(committed and committedResult == "applied")
local rejected, _, restored, rollbackError = EditorTransaction.run(function() error("apply failed") end, function()
    error("rollback failed")
end)
assert(not rejected and not restored and string.find(tostring(rollbackError), "rollback failed", 1, true),
    "an incomplete rollback must be distinguishable from a restored draft")
print("AI viewport context snapshot is bounded, recipe-free, and explicit about visual limits")
