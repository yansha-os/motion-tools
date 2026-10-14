local EditorContext = {}

local function finiteNumber(value)
    return type(value) == "number" and value == value and math.abs(value) < math.huge
end

local function boundedString(value, maximumLength)
    if type(value) ~= "string" or #value == 0 then return nil end
    return string.sub(value, 1, maximumLength)
end

local function optionalNumber(value, minimum, maximum)
    if not finiteNumber(value) then return nil end
    return math.clamp(value, minimum, maximum)
end

local function validCameraTarget(value)
    return type(value) == "table"
        and finiteNumber(value.x) and math.abs(value.x) <= 1000000
        and finiteNumber(value.y) and math.abs(value.y) <= 1000000
        and finiteNumber(value.z) and math.abs(value.z) <= 1000000
end

function EditorContext.applyDisposition(isDirty, matchesExpectedBase, matchesCandidate)
    if isDirty == true and matchesCandidate == true then return "already_applied" end
    if matchesExpectedBase == true then return "apply" end
    return "stale_draft"
end

function EditorContext.snapshot(state)
    local layout = state.layout
    local panels = { none = true, pose = true, layers = true, easing = true, poses = true, settings = true }
    local validLayout = type(layout) == "table" and layout.version == 1 and panels[layout.inspector] == true
        and type(layout.libraryExpanded) == "boolean" and type(layout.libraryPinned) == "boolean"
        and finiteNumber(layout.timelineHeightPixels) and layout.timelineHeightPixels >= 100 and layout.timelineHeightPixels <= 1000
        and finiteNumber(layout.viewportWidthPixels) and layout.viewportWidthPixels >= 1 and layout.viewportWidthPixels <= 20000
        and finiteNumber(layout.viewportHeightPixels) and layout.viewportHeightPixels >= 1 and layout.viewportHeightPixels <= 20000
    local duration = state.durationSeconds
    local validDuration = finiteNumber(duration) and duration > 0 and duration <= 30
    local validPlayhead = state.clipLoaded == true and validDuration
        and finiteNumber(state.playheadSeconds) and state.playheadSeconds >= 0 and state.playheadSeconds <= duration
    local validTimeline = state.clipLoaded == true and validDuration
        and finiteNumber(state.timelineStartSeconds) and state.timelineStartSeconds >= 0
        and finiteNumber(state.timelineEndSeconds) and state.timelineEndSeconds > state.timelineStartSeconds
        and state.timelineEndSeconds <= duration
    local validViewportCamera = state.viewportOpen == true
        and finiteNumber(state.cameraYawDegrees) and math.abs(state.cameraYawDegrees) <= 360000
        and finiteNumber(state.cameraPitchDegrees) and state.cameraPitchDegrees >= -90 and state.cameraPitchDegrees <= 90
        and finiteNumber(state.cameraDistanceStuds) and state.cameraDistanceStuds >= 0.05 and state.cameraDistanceStuds <= 100000
        and finiteNumber(state.cameraFieldOfView) and state.cameraFieldOfView >= 1 and state.cameraFieldOfView <= 120
        and validCameraTarget(state.cameraTargetStuds)
    local result = {
        schemaVersion = 1,
        viewportOpen = state.viewportOpen == true,
        rigLoaded = state.rigLoaded == true,
        clipLoaded = state.clipLoaded == true,
        isPlaying = state.isPlaying == true,
        isDirty = state.isDirty == true,
        isEphemeralCandidate = state.isEphemeralCandidate == true,
        looping = state.looping == true,
        interpretation = "Sampled with the Studio heartbeat; use the containing session heartbeatAgeMs to judge freshness. This is editor/viewport state only, not an image, and does not prove the rendered pose is visible or correct.",
        fieldAvailability = {
            layout = validLayout and "available" or "unavailable",
            rig = state.rigLoaded == true and boundedString(state.rigId, 256) ~= nil and "available" or "unavailable",
            clip = state.clipLoaded == true and boundedString(state.clipId, 256) ~= nil and "available" or "no_clip",
            selection = state.clipLoaded ~= true and "no_clip"
                or (boundedString(state.selectedJoint, 256) and "joint_selected" or "none_selected"),
            playhead = validPlayhead and "available" or (state.clipLoaded == true and "unavailable" or "no_clip"),
            timeline = validTimeline and "available" or (state.clipLoaded == true and "unavailable" or "no_clip"),
            viewportCamera = validViewportCamera and "available" or "viewport_closed_or_camera_unavailable",
            loadedSourceFingerprint = boundedString(state.loadedAssetFingerprint, 256) and (state.isDirty == true and "source_only_dirty_draft" or "available")
                or "requires_fresh_editor_draft_read",
        },
    }
    if validLayout then
        result.layout = { version = 1, inspector = layout.inspector, libraryExpanded = layout.libraryExpanded,
            libraryPinned = layout.libraryPinned, timelineHeightPixels = layout.timelineHeightPixels,
            viewportWidthPixels = layout.viewportWidthPixels, viewportHeightPixels = layout.viewportHeightPixels }
    end
    for _, field in { "rigId", "clipId", "clipName", "loadedAssetFingerprint", "activeLayerId", "selectedJoint" } do
        local value = boundedString(state[field], 256)
        if value then result[field] = value end
    end
    local numberBounds = {
        playheadSeconds = { 0, 3600 }, durationSeconds = { 0, 3600 }, playbackSpeed = { 0, 16 }, selectedKeyTime = { 0, 3600 },
        timelineStartSeconds = { 0, 3600 }, timelineEndSeconds = { 0, 3600 }, cameraYawDegrees = { -360000, 360000 },
        cameraPitchDegrees = { -90, 90 }, cameraDistanceStuds = { 0.05, 100000 }, cameraFieldOfView = { 1, 120 },
    }
    for field, bounds in pairs(numberBounds) do
        local value = optionalNumber(state[field], bounds[1], bounds[2])
        if value ~= nil then result[field] = value end
    end
    local target = state.cameraTargetStuds
    if validCameraTarget(target) then
        result.cameraTargetStuds = { x = math.clamp(target.x, -1000000, 1000000),
            y = math.clamp(target.y, -1000000, 1000000), z = math.clamp(target.z, -1000000, 1000000) }
    end
    return result
end

return EditorContext
