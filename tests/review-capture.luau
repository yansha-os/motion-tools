-- Unit harness for ReviewCapture. Studio services, preview rig, and screenshot buffers are deterministic mocks.
local vectorMeta = {}
local function vector3(x, y, z) return setmetatable({ X = x, Y = y, Z = z }, vectorMeta) end
vectorMeta.__add = function(a, b) return vector3(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
vectorMeta.__sub = function(a, b) return vector3(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
vectorMeta.__unm = function(a) return vector3(-a.X, -a.Y, -a.Z) end
vectorMeta.__mul = function(a, b) if type(a) == "number" then return vector3(a * b.X, a * b.Y, a * b.Z) end return vector3(a.X * b, a.Y * b, a.Z * b) end
vectorMeta.__index = function(self, key)
    if key == "Magnitude" then return math.sqrt(self.X * self.X + self.Y * self.Y + self.Z * self.Z) end
    if key == "Unit" then local length = self.Magnitude; return vector3(self.X / length, self.Y / length, self.Z / length) end
end
local Vector3 = { new = vector3 }
local Vector2 = { new = function(x, y) return { X = x, Y = y } end }
local Color3 = { fromRGB = function(r, g, b) return { R = r, G = g, B = b } end }
local cframeId = 0
local cframeMeta = {}
cframeMeta.__mul = function(a, b) return setmetatable({ Position = a.Position + b.Position }, cframeMeta) end
local CFrame = {
    new = function(position)
        cframeId += 1
        return setmetatable({ id = cframeId, Position = typeof(position) == "table" and position or Vector3.new(position or 0, 0, 0) }, cframeMeta)
    end,
    fromMatrix = function(position, right, up, back)
        cframeId += 1
        return { id = cframeId, Position = position, RightVector = right, UpVector = up, LookVector = -back }
    end,
    lookAt = function(position, target, up)
        cframeId += 1
        return { id = cframeId, Position = position, Target = target, Up = up }
    end,
}
local Enum = {
    CameraType = { Scriptable = "Scriptable", Custom = "Custom" },
    FieldOfViewMode = { Vertical = "Vertical", Horizontal = "Horizontal" },
    ResamplerMode = { Default = "Default" },
    StudioCaptureScreenshotFormat = { PNG = "PNG" },
    UICaptureMode = { None = "None" },
    PartType = { Ball = "Ball" }, Material = { Neon = "Neon" }, Font = { RobotoMono = "RobotoMono" },
}
local UDim2 = { fromOffset = function(x, y) return { X = x, Y = y } end, fromScale = function(x, y) return { X = x, Y = y } end }
local task = { wait = function() end }
local png = "\137PNG\13\10\26\10fixture"
buffer = { tostring = function() return png end }
local camera = { CameraType = "Custom", FieldOfViewMode = Enum.FieldOfViewMode.Horizontal, FieldOfView = 70,
    CFrame = CFrame.new(Vector3.new(1, 2, 3)), Focus = CFrame.new(Vector3.new(1, 2, 3)), ViewportSize = Vector2.new(1920, 1080) }
local workspace = { CurrentCamera = camera }
local currentClone
local lastStagingFrame
local boundingSize = Vector3.new(2, 5, 1)
local rigOrientation = { Position = Vector3.new(0, 0, 0), RightVector = Vector3.new(0, 0, 1), LookVector = Vector3.new(0.8, -0.6, 0), UpVector = Vector3.new(0.6, 0.8, 0) }
local capturePoseCalls = 0
local activePreview = { name = "existing user preview" }
local Preview = {
    capturePose = function(_, payload)
        capturePoseCalls += 1
        assert(payload.animation.kind == "animation" and payload.sampleTime <= payload.animation.duration)
        currentClone = {
            Parent = true,
            PivotTo = function(_, frame) lastStagingFrame = frame end,
            GetBoundingBox = function() return { Position = Vector3.new(0, 10000, 0) }, boundingSize end,
            Destroy = function(self) self.Parent = nil; self.destroyed = true end,
        }
        return currentClone, { UpperTorso = "Torso" }
    end,
    model = function() return activePreview end,
    stop = function() error("screenshot capture must not stop the shared preview") end,
}
local signature = "rig-signature"
local model = { GetPivot = function() return rigOrientation end }
local activeModel = model
local changeSelectionAtScreenshot = false
local changeSelectionAtPermission = false
local changeDraftAtScreenshot = false
local editorDraftCurrent = true
local Rig = { signature = function() return signature end, active = function() return activeModel end, id = function() return "rig" end,
    nodes = function() return {}, {}, {} end,
    jointParts = function(target) return target.parentPart, target.childPart, target.parentOffset, target.childOffset end }
local permission = true
local serviceAvailable = true
local captureError = false
local userMovesCameraDuringCapture = false
local screenshotCount, permissionRequestCount, failAtScreenshot = 0, 0, nil
local lastOptions
local lastCaptureFrame
local studioCaptureService = {
    RequestScreenshotPermissionAsync = function()
        permissionRequestCount += 1
        if changeSelectionAtPermission then activeModel = {} end
        return permission
    end,
    CanCaptureScreenshot = function() return permission end,
    CaptureScreenshot = function(_, options)
        screenshotCount += 1
        lastOptions = options
        lastCaptureFrame = camera.CFrame
        if changeSelectionAtScreenshot then activeModel = {} end
        if changeDraftAtScreenshot then editorDraftCurrent = false end
        if userMovesCameraDuringCapture then
            camera.CFrame = CFrame.new(Vector3.new(9, 8, 7))
            return {
                BufferStatus = { Name = "Working" },
                GetBuffer = function() return {} end,
                GetErrors = function() return { "fixture capture error" } end,
            }
        end
        return {
            BufferStatus = { Name = (captureError or failAtScreenshot == screenshotCount) and "Error" or "Ready" },
            GetBuffer = function() return {} end,
            GetErrors = function() return { "fixture capture error" } end,
        }
    end,
}
local guid = 0
local HttpService = { GenerateGUID = function() guid += 1; return "capture-" .. guid end }
local game = { GetService = function(_, name)
    if name == "HttpService" then return HttpService end
    if name == "StudioCaptureService" and serviceAvailable then return studioCaptureService end
    error("Unexpected service " .. name)
end }
local createdInstances = {}
local Instance = { new = function(className)
    local object = { ClassName = className }
    table.insert(createdInstances, object)
    return object
end }
local originalCameraType, originalCameraFrame, originalCameraFocus = camera.CameraType, camera.CFrame, camera.Focus

-- INSERT_REVIEW_CAPTURE_HERE

local payload = { assetId = "asset", assetFingerprint = string.rep("a", 64), rigId = "rig", rigSignature = signature,
    sessionId = "session", recipe = { kind = "animation", duration = 1 }, jointMap = {}, time = 0.5, view = "front" }
local function validateEditorDraft()
    assert(editorDraftCurrent, "The editor draft changed during capture.")
end

local screenshotCountBeforeProbe = screenshotCount
local probe = ReviewCapture.preflight(model, payload)
assert(probe.status == "ready" and probe.serviceAvailable and probe.permissionGranted and probe.canCapture and probe.drawable)
assert(probe.sessionId == payload.sessionId and probe.rigId == payload.rigId and probe.rigSignature == payload.rigSignature,
    "preflight evidence must identify the exact live session and rig topology")
assert(screenshotCount == screenshotCountBeforeProbe, "capture preflight must not take a screenshot")
assert(camera.CameraType == originalCameraType and camera.CFrame == originalCameraFrame and camera.Focus == originalCameraFocus,
    "capture preflight must not move the camera")
permission = false
local deniedProbe = ReviewCapture.preflight(model, payload)
assert(deniedProbe.status == "permission_denied" and not deniedProbe.canCapture)
permission = true
serviceAvailable = false
local unsupportedProbe = ReviewCapture.preflight(model, payload)
assert(unsupportedProbe.status == "unsupported" and not unsupportedProbe.serviceAvailable)
serviceAvailable = true
changeSelectionAtPermission = true
local changedRigOk, changedRigError = pcall(ReviewCapture.preflight, model, payload)
assert(not changedRigOk and string.find(tostring(changedRigError), "selected Motion Tools rig changed", 1, true),
    "preflight must reject a rig change while the permission prompt yields")
changeSelectionAtPermission = false
activeModel = model

payload.validateCaptureState = validateEditorDraft
local screenshotsBeforeDraftPermissionChange = screenshotCount
local originalRequestScreenshotPermissionAsync = studioCaptureService.RequestScreenshotPermissionAsync
studioCaptureService.RequestScreenshotPermissionAsync = function(...)
    editorDraftCurrent = false
    return originalRequestScreenshotPermissionAsync(...)
end
local changedDraftAtPermission, changedDraftPermissionError = pcall(ReviewCapture.frame, model, payload)
studioCaptureService.RequestScreenshotPermissionAsync = originalRequestScreenshotPermissionAsync
editorDraftCurrent = true
assert(not changedDraftAtPermission and string.find(tostring(changedDraftPermissionError), "editor draft changed during capture", 1, true),
    "capture must reject an editor draft changed while screenshot permission yields")
assert(screenshotCount == screenshotsBeforeDraftPermissionChange, "a stale draft must be rejected before any screenshot is taken")
payload.validateCaptureState = nil

local frame = ReviewCapture.frame(model, payload)
assert(frame.appliedJointMap.UpperTorso == "Torso", "capture metadata must report the resolved names returned by the pose evaluator")
assert(frame.byteCount == #png and frame.chunks == 1 and frame.width == 960 and frame.height == 540)
assert(frame.assetFingerprint == payload.assetFingerprint and frame.rigSignature == signature)
assert(lastOptions.Format == "PNG" and lastOptions.UICaptureMode == "None")
assert(lastOptions.CaptureSize.X == 1920 and lastOptions.CaptureSize.Y == 1080)
assert(camera.CameraType == originalCameraType and camera.CFrame == originalCameraFrame and camera.Focus == originalCameraFocus)
assert(camera.FieldOfViewMode == Enum.FieldOfViewMode.Horizontal and camera.FieldOfView == 70,
    "capture must restore the user's original field-of-view mode and value")
assert(capturePoseCalls == 1 and currentClone.destroyed and Preview.model() == activePreview,
    "capture must destroy only its disposable pose clone and preserve an existing interactive preview")
local targetGuidedPayload = table.clone(payload)
targetGuidedPayload.time = 0.5
targetGuidedPayload.ikTargetGuides = {
    { limb = "LeftHand", startTime = 0.25, endTime = 0.75,
        targetWorldPath = { { time = 0, position = { 0, 0, 0 } }, { time = 1, position = { 4, 0, 0 } } },
        targetPathInterpolation = "linear", offset = { 1, 0, 0 } },
}
local targetGuided = ReviewCapture.frame(model, targetGuidedPayload)
local targetMarker
for _, object in createdInstances do if object.Name == "MotionReviewRequestedTarget_LeftHand" then targetMarker = object end end
assert(targetMarker and targetMarker.Position.X == 3 and targetMarker.Position.Y == 10000 and targetMarker.Position.Z == 0,
    "AI captures must render the exact interpolated IK target, offset consistently with the isolated rig staging transform")
assert(targetMarker.Color.R == 255 and targetMarker.Color.G == 190
    and string.find(targetGuided.note, "LeftHand=amber", 1, true),
    "capture must color-code the 3D endpoint guide and return its limb legend because UI layers are excluded")
local fixedGuidedPayload = table.clone(payload)
fixedGuidedPayload.time = 0.5
fixedGuidedPayload.ikTargetGuides = {
    { limb = "RightHand", startTime = 0.25, endTime = 0.75, targetWorldPosition = { 4, 1, 2 }, offset = { 1, 2, 3 } },
}
ReviewCapture.frame(model, fixedGuidedPayload)
local fixedTargetMarker
for _, object in createdInstances do if object.Name == "MotionReviewRequestedTarget_RightHand" then fixedTargetMarker = object end end
assert(fixedTargetMarker and fixedTargetMarker.Position.X == 5 and fixedTargetMarker.Position.Y == 10003 and fixedTargetMarker.Position.Z == 5,
    "fixed IK screenshot targets must apply their solver offset before translating into the isolated staging frame")
local markersBeforeInactiveFrame = 0
for _, object in createdInstances do if object.Name == "MotionReviewRequestedTarget_RightFoot" then markersBeforeInactiveFrame += 1 end end
local inactiveGuidePayload = table.clone(payload)
inactiveGuidePayload.time = 0.5
inactiveGuidePayload.ikTargetGuides = {
    { limb = "RightFoot", startTime = 0.1, endTime = 0.4, targetWorldPosition = { 0, 0, 0 }, offset = { 0, 0, 0 } },
}
ReviewCapture.frame(model, inactiveGuidePayload)
local markersAfterInactiveFrame = 0
for _, object in createdInstances do if object.Name == "MotionReviewRequestedTarget_RightFoot" then markersAfterInactiveFrame += 1 end end
assert(markersAfterInactiveFrame == markersBeforeInactiveFrame,
    "captures outside the solved contact window must not depict an inactive requested target")
local chunk = ReviewCapture.chunk({ captureId = frame.captureId, index = 0 })
assert(chunk.hex == (png:gsub(".", function(value) return string.format("%02x", string.byte(value)) end)))

permission = false
local denied = pcall(ReviewCapture.frame, model, payload)
assert(not denied and capturePoseCalls == 4 and Preview.model() == activePreview, "denied permission must not stage a clone or disturb a preview")
assert(camera.CFrame == originalCameraFrame and camera.Focus == originalCameraFocus)

permission, captureError = true, true
local failed = pcall(ReviewCapture.frame, model, payload)
assert(not failed, "Studio capture errors must be surfaced")
assert(camera.CameraType == originalCameraType and camera.CFrame == originalCameraFrame and camera.Focus == originalCameraFocus)
assert(capturePoseCalls == 5 and currentClone.destroyed and Preview.model() == activePreview,
    "failed capture must restore camera, remove its clone and preserve the shared preview")

captureError = false
userMovesCameraDuringCapture = true
local cameraInterrupted = pcall(ReviewCapture.frame, model, payload)
userMovesCameraDuringCapture = false
assert(not cameraInterrupted, "capture must stop when the user changes the camera during screenshot acquisition")
assert(camera.CameraType == originalCameraType and camera.CFrame.Position.X == 9 and camera.Focus == originalCameraFocus,
    "interrupted capture must restore Studio camera control without overwriting the user's new camera position")
assert(currentClone.destroyed and Preview.model() == activePreview,
    "camera interruption must clean up the temporary rig and preserve the shared preview")
camera.CFrame, camera.Focus = originalCameraFrame, originalCameraFocus

changeSelectionAtScreenshot = true
local selectionChanged = pcall(ReviewCapture.frame, model, payload)
assert(not selectionChanged, "capture must reject when the selected rig changes during screenshot acquisition")
changeSelectionAtScreenshot = false
activeModel = model
assert(camera.CameraType == originalCameraType and camera.CFrame == originalCameraFrame and camera.Focus == originalCameraFocus)
assert(currentClone.destroyed and Preview.model() == activePreview, "selection changes must not leak the temporary rig or stop the shared preview")

captureError = false
local beforeBatch = screenshotCount
local batch = ReviewCapture.frames(model, { assetId = "asset", sessionId = "session", rigId = "rig", rigSignature = signature,
    assetFingerprint = payload.assetFingerprint, recipe = { kind = "animation", duration = 1 }, jointMap = {}, frames = {
        { time = 0.2, view = "front" }, { time = 0.8, view = "side" },
    } })
assert(batch.complete and #batch.frames == 2 and screenshotCount == beforeBatch + 2)
assert(batch.frames[1].captureId ~= batch.frames[2].captureId)

local beforeSingleRetry = screenshotCount
local singleRetry = ReviewCapture.frames(model, { assetId = "asset", sessionId = "session", rigId = "rig", rigSignature = signature,
    assetFingerprint = payload.assetFingerprint, recipe = { kind = "animation", duration = 1 }, jointMap = {}, frames = {
        { time = 0.8, view = "side" },
    } })
assert(singleRetry.complete and #singleRetry.frames == 1 and screenshotCount == beforeSingleRetry + 1,
    string.format("a single exact missing frame must capture once (complete=%s frames=%d screenshotDelta=%d error=%s)",
        tostring(singleRetry.complete), #singleRetry.frames, screenshotCount - beforeSingleRetry, tostring(singleRetry.error)))
assert(singleRetry.frames[1].time == 0.8 and singleRetry.frames[1].view == "side")

local comparison = ReviewCapture.compare(model, { sessionId = "session", rigId = "rig", rigSignature = signature, jointMap = {}, frames = {
        { time = 0.2, view = "front" }, { time = 0.8, view = "side" },
    }, candidates = {
        { label = "Anticipation", assetId = "asset-a", assetFingerprint = string.rep("a", 64), recipe = { kind = "animation", duration = 1 } },
        { label = "Direct", assetId = "asset-b", assetFingerprint = string.rep("b", 64), recipe = { kind = "animation", duration = 1 } },
    } })
assert(comparison.complete and #comparison.candidates == 2)
assert(#comparison.candidates[1].frames == 2 and #comparison.candidates[2].frames == 2)
assert(comparison.candidates[1].frames[1].time == comparison.candidates[2].frames[1].time)
assert(comparison.candidates[1].frames[1].view == comparison.candidates[2].frames[1].view)
assert(comparison.candidates[1].frames[1].assetFingerprint ~= comparison.candidates[2].frames[1].assetFingerprint)

local maximumFrames = {
    { time = 0.1, view = "front" }, { time = 0.3, view = "side" },
    { time = 0.6, view = "back" }, { time = 0.9, view = "three_quarter" },
}
local maximumCandidates = {}
for index = 1, 4 do
    local fingerprint = string.rep(string.char(96 + index), 64)
    table.insert(maximumCandidates, { label = "Alternative " .. index, assetId = "asset-" .. index,
        assetFingerprint = fingerprint, recipe = { kind = "animation", duration = 1 } })
end
local maximumComparison = ReviewCapture.compare(model, { sessionId = "session", rigId = "rig", rigSignature = signature,
    jointMap = {}, frames = maximumFrames, candidates = maximumCandidates })
assert(maximumComparison.complete and #maximumComparison.candidates == 4)
local maximumCaptureIds = {}
for _, candidate in maximumComparison.candidates do
    assert(#candidate.frames == 4)
    for _, captured in candidate.frames do table.insert(maximumCaptureIds, captured.captureId) end
end
assert(#maximumCaptureIds == 16)
assert(ReviewCapture.chunk({ captureId = maximumCaptureIds[1], index = 0 }).captureId == maximumCaptureIds[1],
    "the oldest image in a 16-frame comparison must remain available")
assert(ReviewCapture.chunk({ captureId = maximumCaptureIds[16], index = 0 }).captureId == maximumCaptureIds[16],
    "the newest image in a 16-frame comparison must remain available")

failAtScreenshot = screenshotCount + 3
local comparisonPartial = ReviewCapture.compare(model, { sessionId = "session", rigId = "rig", rigSignature = signature, jointMap = {}, frames = {
        { time = 0.2, view = "front" }, { time = 0.8, view = "side" },
    }, candidates = {
        { label = "Anticipation", assetId = "asset-a", assetFingerprint = string.rep("a", 64), recipe = { kind = "animation", duration = 1 } },
        { label = "Direct", assetId = "asset-b", assetFingerprint = string.rep("b", 64), recipe = { kind = "animation", duration = 1 } },
    } })
assert(not comparisonPartial.complete and comparisonPartial.failedCandidateIndex == 2 and comparisonPartial.failedFrameIndex == 1)
assert(#comparisonPartial.candidates == 2 and #comparisonPartial.candidates[1].frames == 2 and #comparisonPartial.candidates[2].frames == 0)
failAtScreenshot = nil

local screenshotsBeforeDraftChange = screenshotCount
changeDraftAtScreenshot = true
local staleDraftBatch = ReviewCapture.frames(model, { assetId = "asset", sessionId = "session", rigId = "rig", rigSignature = signature,
    assetFingerprint = payload.assetFingerprint, recipe = { kind = "animation", duration = 1 }, jointMap = {}, validateCaptureState = validateEditorDraft,
    frames = { { time = 0.1, view = "front" }, { time = 0.9, view = "back" } } })
changeDraftAtScreenshot = false
editorDraftCurrent = true
assert(not staleDraftBatch.complete and staleDraftBatch.failedIndex == 1 and #staleDraftBatch.frames == 0,
    "a draft changed during screenshot acquisition must not produce a returned stale frame")
assert(screenshotCount == screenshotsBeforeDraftChange + 1, "batch capture must stop instead of capturing later frames from a stale draft")

local partialFailureAt = screenshotCount + 2
failAtScreenshot = partialFailureAt
local partial = ReviewCapture.frames(model, { assetId = "asset", sessionId = "session", rigId = "rig", rigSignature = signature,
    assetFingerprint = payload.assetFingerprint, recipe = { kind = "animation", duration = 1 }, jointMap = {}, frames = {
        { time = 0.1, view = "front" }, { time = 0.9, view = "back" },
    } })
assert(not partial.complete and partial.failedIndex == 2 and #partial.frames == 1)
assert(camera.CameraType == originalCameraType and camera.CFrame == originalCameraFrame and camera.Focus == originalCameraFocus)
assert(currentClone.destroyed and currentClone.Parent == nil and Preview.model() == activePreview,
    "batch failure must destroy only its disposable capture clone and preserve the shared preview")

local function assertFramingDistance(expectedSize)
    local radius = expectedSize.Magnitude / 2
    local captureAspect = 16 / 9
    local viewportAspect = camera.ViewportSize.X / camera.ViewportSize.Y
    local cropHeightFraction = math.min(1, viewportAspect / captureAspect)
    local verticalTangent = math.tan(math.rad(70) / 2) * cropHeightFraction
    local verticalHalfAngle = math.atan(verticalTangent)
    local horizontalHalfAngle = math.atan(verticalTangent * captureAspect)
    local expectedDistance = radius / math.sin(math.min(verticalHalfAngle, horizontalHalfAngle)) * 1.12
    local position, target = lastCaptureFrame.Position, lastCaptureFrame.Target
    local dx, dy, dz = position.X - target.X, position.Y - target.Y, position.Z - target.Z
    local actualDistance = math.sqrt(dx * dx + dy * dy + dz * dz)
    assert(math.abs(actualDistance - expectedDistance) < 1e-6,
        "capture camera distance must fit the full model bounds using the output aspect ratio and vertical field of view")
end

boundingSize = Vector3.new(2, 5, 1)
ReviewCapture.frame(model, payload)
assertFramingDistance(boundingSize)
assert(camera.FieldOfViewMode == Enum.FieldOfViewMode.Horizontal and camera.FieldOfView == 70,
    "normal-rig framing must restore the user's camera optics")
boundingSize = Vector3.new(2, 20, 1)
ReviewCapture.frame(model, payload)
assertFramingDistance(boundingSize)
assert(camera.FieldOfViewMode == Enum.FieldOfViewMode.Horizontal and camera.FieldOfView == 70,
    "tall-rig framing must restore the user's camera optics")
boundingSize = Vector3.new(2, 5, 1)
camera.ViewportSize = Vector2.new(1440, 1080)
ReviewCapture.frame(model, payload)
assertFramingDistance(boundingSize)
camera.ViewportSize = Vector2.new(720, 1280)
ReviewCapture.frame(model, payload)
assertFramingDistance(boundingSize)
camera.ViewportSize = Vector2.new(1920, 1080)

local function assertViewDirection(view, expected, expectedCameraUp)
    local viewPayload = table.clone(payload)
    viewPayload.view = view
    ReviewCapture.frame(model, viewPayload)
    local direction = (lastCaptureFrame.Position - lastCaptureFrame.Target).Unit
    assert(math.abs(direction.X - expected.X) < 1e-6 and math.abs(direction.Y - expected.Y) < 1e-6
        and math.abs(direction.Z - expected.Z) < 1e-6,
        view .. " camera direction must follow the rotated rig coordinate frame")
    local function sameVector(left, right)
        return math.abs(left.X - right.X) < 1e-6 and math.abs(left.Y - right.Y) < 1e-6 and math.abs(left.Z - right.Z) < 1e-6
    end
    assert(lastStagingFrame.Position.X == 0 and lastStagingFrame.Position.Y == 10000 and lastStagingFrame.Position.Z == 0
        and sameVector(lastStagingFrame.RightVector, rigOrientation.RightVector)
        and sameVector(lastStagingFrame.UpVector, rigOrientation.UpVector)
        and sameVector(lastStagingFrame.LookVector, rigOrientation.LookVector),
        "capture clone staging must preserve the selected rig's original orientation")
    local expectedUp = view == "overhead" and rigOrientation.LookVector or rigOrientation.UpVector
    assert(lastCaptureFrame.Up == expectedUp, view .. " camera roll must follow the rig's anatomical up axis")
end
assertViewDirection("front", rigOrientation.LookVector)
assertViewDirection("side", Vector3.new(0, 0, 1))
assertViewDirection("back", -rigOrientation.LookVector)
assertViewDirection("three_quarter", (rigOrientation.RightVector + rigOrientation.LookVector).Unit)
assertViewDirection("overhead", rigOrientation.UpVector)

local parentPart = { Position = Vector3.new(0, 10000, 0), CFrame = CFrame.new(Vector3.new(0, 10000, 0)), Size = Vector3.new(2, 4, 2),
    IsA = function(_, kind) return kind == "BasePart" end }
local focusPart = { Position = Vector3.new(3, 10002, -1), CFrame = CFrame.new(Vector3.new(3, 10002, -1)), Size = Vector3.new(0.6, 0.8, 0.5),
    IsA = function(_, kind) return kind == "BasePart" end }
local childPart = { Position = Vector3.new(4, 10002, -1), CFrame = CFrame.new(Vector3.new(4, 10002, -1)), Size = Vector3.new(0.4, 0.4, 0.4),
    IsA = function(_, kind) return kind == "BasePart" end }
local focusOffset = CFrame.new(Vector3.new(0, 0.5, 0))
local focusTarget = { parentPart = parentPart, childPart = focusPart, parentOffset = CFrame.new(Vector3.new(0, 2, 0)), childOffset = focusOffset }
local focusNode = { object = focusPart, target = focusTarget, parent = { object = parentPart }, children = { { object = childPart } } }
Rig.nodes = function() return {}, { RightHand = focusNode }, { focusNode } end
local focusedPayload = table.clone(payload)
focusedPayload.focusJoint = "RightHand"
local focusedFrame = ReviewCapture.frame(model, focusedPayload)
local focusPivot = (focusPart.CFrame * focusOffset).Position
assert(focusedFrame.focusJoint == "RightHand" and (lastCaptureFrame.Target - focusPivot).Magnitude < 1e-6
    and (lastCaptureFrame.Target - focusPart.Position).Magnitude > 0.49,
    "focused capture should aim at the animated joint pivot, not the center of its part")
local focusedRadius = math.max(parentPart.Size.Magnitude / 2 + (parentPart.Position - focusPivot).Magnitude,
    focusPart.Size.Magnitude / 2 + (focusPart.Position - focusPivot).Magnitude,
    childPart.Size.Magnitude / 2 + (childPart.Position - focusPivot).Magnitude)
local focusedDistance = focusedRadius / math.sin(math.min(math.atan(math.tan(math.rad(70) / 2)), math.atan(math.tan(math.rad(70) / 2) * 16 / 9))) * 1.18
local focusedActual = (lastCaptureFrame.Position - lastCaptureFrame.Target).Magnitude
assert(math.abs(focusedActual - focusedDistance) < 1e-6, "focused camera should frame the selected segment with immediate parent/child context")
local permissionsBeforeBoneFocus = permissionRequestCount
local boneNode = { object = { IsA = function(_, kind) return kind == "Bone" end }, target = {}, children = {}, parent = nil }
Rig.nodes = function() return {}, { HandBone = boneNode }, { boneNode } end
local bonePayload = table.clone(payload)
bonePayload.focusJoint = "HandBone"
local boneFocusOk, boneFocusError = pcall(ReviewCapture.frame, model, bonePayload)
assert(not boneFocusOk and string.find(tostring(boneFocusError), "Bone-only nodes cannot be tightly framed", 1, true),
    "focused capture should fail clearly for a Bone with no independently measurable visible bounds")
assert(permissionRequestCount == permissionsBeforeBoneFocus, "invalid Bone focus must be rejected before requesting screenshot permission")
Rig.nodes = function() return {}, {}, {} end
local missingPayload = table.clone(payload)
missingPayload.focusJoint = "MissingPart"
local permissionsBeforeMissingFocus = permissionRequestCount
local missingFocusOk, missingFocusError = pcall(ReviewCapture.frame, model, missingPayload)
assert(not missingFocusOk and string.find(tostring(missingFocusError), "exact animated BasePart node", 1, true),
    "focused capture should reject unknown or non-animated names: " .. tostring(missingFocusError))
assert(permissionRequestCount == permissionsBeforeMissingFocus, "unknown focus must be rejected before requesting screenshot permission")
local rootOnlyNode = { object = parentPart, children = {}, parent = nil }
Rig.nodes = function() return {}, { HumanoidRootPart = rootOnlyNode }, { rootOnlyNode } end
local rootPayload = table.clone(payload)
rootPayload.focusJoint = "HumanoidRootPart"
local permissionsBeforeRootFocus = permissionRequestCount
local rootFocusOk, rootFocusError = pcall(ReviewCapture.frame, model, rootPayload)
assert(not rootFocusOk and string.find(tostring(rootFocusError), "root-only and Bone-only nodes", 1, true),
    "root-only nodes must not be treated as animated focus targets: " .. tostring(rootFocusError))
assert(permissionRequestCount == permissionsBeforeRootFocus, "root-only focus must be rejected before requesting screenshot permission")
assert(camera.CameraType == originalCameraType and camera.CFrame == originalCameraFrame and camera.Focus == originalCameraFocus,
    "focused and rejected captures must restore the user's camera")
assert(camera.FieldOfViewMode == Enum.FieldOfViewMode.Horizontal and camera.FieldOfView == 70,
    "non-16:9 viewport framing must restore the user's camera optics")

print("Studio screenshot preflight, permission, stale draft/rig rejection, aspect-aware framing, PNG chunks, camera restoration, candidate bake-offs, and partial-failure recovery passed")
