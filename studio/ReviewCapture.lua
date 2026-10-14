local ReviewCapture = {}
local captures = {}
local captureOrder = {}
local HttpService = game:GetService("HttpService")

local function assertSelectedRig(model, payload)
    assert(Rig.active() == model and Rig.id(model) == payload.rigId, "The selected Motion Tools rig changed during visual capture.")
    assert(type(payload.rigSignature) == "string" and Rig.signature(model) == payload.rigSignature, "The selected rig topology changed before capture.")
end

local function assertCaptureState(model, payload)
    assertSelectedRig(model, payload)
    if payload.validateCaptureState then
        assert(type(payload.validateCaptureState) == "function", "Capture state validator is invalid.")
        payload.validateCaptureState()
    end
end

local function focusNodeFor(model, focusJoint)
    if not focusJoint then return nil end
    local _, byName = Rig.nodes(model)
    local node = byName[focusJoint]
    assert(node and node.target and node.object and node.object:IsA("BasePart"),
        "Capture focus must be an exact animated BasePart node from the current rig inspection; root-only and Bone-only nodes cannot be tightly framed.")
    return node
end

function ReviewCapture.preflight(model, payload)
    assertSelectedRig(model, payload)
    local function report(result)
        assertSelectedRig(model, payload)
        result.sessionId, result.rigId, result.rigSignature = payload.sessionId, payload.rigId, payload.rigSignature
        return result
    end
    local serviceOk, service = pcall(function() return game:GetService("StudioCaptureService") end)
    if not serviceOk then
        return report({ status = "unsupported", serviceAvailable = false, permissionGranted = false, canCapture = false,
            note = "StudioCaptureService is unavailable in this Studio runtime. Use manual screenshot evidence instead." })
    end
    local permissionOk, permissionGranted = pcall(function() return service:RequestScreenshotPermissionAsync() end)
    assertSelectedRig(model, payload)
    if not permissionOk then
        return report({ status = "unknown", serviceAvailable = true, permissionGranted = false, canCapture = false,
            error = string.sub(tostring(permissionGranted), 1, 1000), note = "Studio could not determine screenshot permission." })
    end
    if permissionGranted ~= true then
        return report({ status = "permission_denied", serviceAvailable = true, permissionGranted = false, canCapture = false,
            note = "Screenshot permission was not granted. No screenshot was taken." })
    end
    local captureOk, canCapture = pcall(function() return service:CanCaptureScreenshot() end)
    assertSelectedRig(model, payload)
    if not captureOk then
        return report({ status = "unknown", serviceAvailable = true, permissionGranted = true, canCapture = false,
            error = string.sub(tostring(canCapture), 1, 1000), note = "Studio could not determine whether the current viewport can be captured." })
    end
    local camera = workspace.CurrentCamera
    local viewport = camera and camera.ViewportSize or Vector2.new(0, 0)
    local drawable = viewport.X > 0 and viewport.Y > 0
    return report({ status = canCapture == true and drawable and "ready" or "temporarily_unavailable", serviceAvailable = true,
        permissionGranted = true, canCapture = canCapture == true, viewport = { width = viewport.X, height = viewport.Y }, drawable = drawable,
        note = canCapture == true and drawable and "Studio reports that screenshot capture is currently available. This preflight did not take or validate an image." or "Studio cannot capture the current viewport right now. Retry after restoring a drawable Studio viewport, or attach a screenshot manually." })
end

function ReviewCapture.frame(model, payload)
    assert(type(payload.assetFingerprint) == "string" and #payload.assetFingerprint == 64, "Capture is missing its exact animation fingerprint.")
    assertCaptureState(model, payload)
    focusNodeFor(model, payload.focusJoint)
    local service = game:GetService("StudioCaptureService")
    assert(service:RequestScreenshotPermissionAsync(), "Studio screenshot permission was not granted.")
    assertCaptureState(model, payload)
    assert(service:CanCaptureScreenshot(), "Studio cannot capture the viewport right now.")
    assertCaptureState(model, payload)
    local camera = workspace.CurrentCamera
    assert(camera, "No active viewport camera.")
    local previous = { kind = camera.CameraType, frame = camera.CFrame, focus = camera.Focus,
        fieldOfViewMode = camera.FieldOfViewMode }
    local ownedFrame
    local ownedFocus
    local ownedClone
    local stage
    local guidePositions = {}
    local changedFieldOfViewMode = false
    local ok, result = pcall(function()
        -- Preserve the selected rig's rest orientation when relocating the
        -- disposable clone. PivotTo(CFrame.new(...)) would also reset rotation.
        local rigFrame = model:GetPivot()
        local clone, appliedJointMap = Preview.capturePose(model, { animation = payload.recipe, jointMap = payload.jointMap, sampleTime = payload.time })
        ownedClone = clone
        local stagingFrame = CFrame.fromMatrix(Vector3.new(0, 10000, 0), rigFrame.RightVector, rigFrame.UpVector, -rigFrame.LookVector)
        clone:PivotTo(stagingFrame)
        task.wait(0.1)
        local bounds, size = clone:GetBoundingBox()
        local guideColors = {
            LeftHand = Color3.fromRGB(255, 190, 72),
            RightHand = Color3.fromRGB(255, 112, 96),
            LeftFoot = Color3.fromRGB(173, 126, 255),
            RightFoot = Color3.fromRGB(88, 223, 175),
        }
        local guideColorNames = { LeftHand = "amber", RightHand = "coral", LeftFoot = "violet", RightFoot = "mint" }
        local includedGuideLimbs = {}
        stage = Instance.new("Part")
        stage.Name = "MotionReviewGround"
        stage.Anchored, stage.CanCollide, stage.CanQuery, stage.CanTouch = true, false, false, false
        stage.Size = Vector3.new(100, 1, 100)
        stage.Color = Color3.fromRGB(75, 78, 85)
        stage.Position = bounds.Position - Vector3.new(0, size.Y / 2 + 0.5, 0)
        stage.Parent = clone
        assert(payload.ikTargetGuides == nil or (type(payload.ikTargetGuides) == "table" and #payload.ikTargetGuides <= 4),
            "IK screenshot guides must contain at most four verified targets.")
        for _, guide in payload.ikTargetGuides or {} do
            if payload.time >= guide.startTime and payload.time <= guide.endTime then
                local position
                if type(guide.targetWorldPath) == "table" then
                    position = IKContact.targetAt(guide.targetWorldPath, payload.time, guide.targetPathInterpolation)
                    local offset = guide.offset or { 0, 0, 0 }
                    position = Vector3.new(position[1] + offset[1], position[2] + offset[2], position[3] + offset[3])
                else
                    local fixed = guide.targetWorldPosition
                    assert(type(fixed) == "table" and #fixed == 3, "Fixed IK screenshot guide has no exact target position.")
                    local offset = guide.offset or { 0, 0, 0 }
                    position = Vector3.new(fixed[1] + offset[1], fixed[2] + offset[2], fixed[3] + offset[3])
                end
                -- The capture clone preserves rig orientation but is translated
                -- to an isolated staging area. Translate the target by the same
                -- delta so the screenshot depicts the exact rig-relative goal.
                local stagedPosition = position + stagingFrame.Position - rigFrame.Position
                local marker = Instance.new("Part")
                marker.Name = "MotionReviewRequestedTarget_" .. guide.limb
                marker.Shape = Enum.PartType.Ball
                marker.Size = Vector3.new(0.3, 0.3, 0.3)
                marker.Anchored = true
                marker.CanCollide, marker.CanTouch, marker.CanQuery = false, false, false
                marker.Material = Enum.Material.Neon
                marker.Color = guideColors[guide.limb]
                assert(marker.Color, "Unknown IK screenshot-guide limb.")
                marker.Position = stagedPosition
                marker.Parent = clone
                table.insert(guidePositions, stagedPosition)
                includedGuideLimbs[guide.limb] = true
            end
        end
        local framingViewport = camera.ViewportSize
        assert(framingViewport.X > 0 and framingViewport.Y > 0, "Viewport has no drawable area.")
        if camera.FieldOfViewMode ~= Enum.FieldOfViewMode.Vertical then
            camera.FieldOfViewMode = Enum.FieldOfViewMode.Vertical
            changedFieldOfViewMode = true
        end
        local captureAspect = 16 / 9
        local viewportAspect = framingViewport.X / framingViewport.Y
        local cropHeightFraction = math.min(1, viewportAspect / captureAspect)
        local verticalTangent = math.tan(math.rad(camera.FieldOfView) / 2) * cropHeightFraction
        local verticalHalfAngle = math.atan(verticalTangent)
        local horizontalHalfAngle = math.atan(verticalTangent * captureAspect)
        local limitingHalfAngle = math.min(verticalHalfAngle, horizontalHalfAngle)
        assert(limitingHalfAngle > 0 and limitingHalfAngle < math.pi / 2, "Camera field of view cannot frame the rig.")
        local boundingRadius = size.Magnitude / 2
        -- Named views are rig-relative. World-axis cameras silently become the
        -- wrong anatomical views when a custom rig is rotated in Studio.
        local right, forward, up = rigFrame.RightVector, rigFrame.LookVector, rigFrame.UpVector
        local directions = {
            front = forward, side = right, back = -forward,
            three_quarter = (right + forward).Unit, overhead = up,
        }
        local direction = directions[payload.view]
        assert(direction, "Unsupported capture view.")
        local target = bounds.Position + Vector3.new(0, size.Y * 0.05, 0)
        if #guidePositions > 0 and not payload.focusJoint then
            local minX, minY, minZ = bounds.Position.X - size.X / 2, bounds.Position.Y - size.Y / 2, bounds.Position.Z - size.Z / 2
            local maxX, maxY, maxZ = bounds.Position.X + size.X / 2, bounds.Position.Y + size.Y / 2, bounds.Position.Z + size.Z / 2
            for _, point in guidePositions do
                minX, minY, minZ = math.min(minX, point.X), math.min(minY, point.Y), math.min(minZ, point.Z)
                maxX, maxY, maxZ = math.max(maxX, point.X), math.max(maxY, point.Y), math.max(maxZ, point.Z)
            end
            target = Vector3.new((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
            boundingRadius = Vector3.new(maxX - minX, maxY - minY, maxZ - minZ).Magnitude / 2
        end
        if payload.focusJoint then
            local _, byName = Rig.nodes(clone)
            local focusNode = byName[payload.focusJoint]
            assert(focusNode and focusNode.target and focusNode.object and focusNode.object:IsA("BasePart"),
                "Capture focus node was not preserved on the posed preview clone.")
            local _, childPart, _, childOffset = Rig.jointParts(focusNode.target)
            assert(childPart == focusNode.object and childOffset,
                "Capture focus joint no longer resolves to its inspected part-backed animation pivot.")
            target = (childPart.CFrame * childOffset).Position
            local focusRadius = 0
            local function includeFocusNode(node)
                if node and node.object and node.object:IsA("BasePart") then
                    focusRadius = math.max(focusRadius, (node.object.Position - target).Magnitude + node.object.Size.Magnitude / 2)
                end
            end
            includeFocusNode(focusNode)
            includeFocusNode(focusNode.parent)
            for _, child in focusNode.children do includeFocusNode(child) end
            boundingRadius = math.max(focusRadius, 0.25)
            for _, point in guidePositions do boundingRadius = math.max(boundingRadius, (point - target).Magnitude + 0.2) end
        end
        local distance = boundingRadius / math.sin(limitingHalfAngle) * (payload.focusJoint and 1.18 or 1.12)
        local cameraPosition = target + direction * distance
        local cameraUp = payload.view == "overhead" and forward or up
        ownedFrame = CFrame.lookAt(cameraPosition, target, cameraUp)
        camera.CameraType = Enum.CameraType.Scriptable
        camera.CFrame = ownedFrame
        ownedFocus = CFrame.new(target)
        camera.Focus = ownedFocus
        task.wait(0.1)
        local viewport = camera.ViewportSize
        assert(viewport.X > 0 and viewport.Y > 0, "Viewport has no drawable area.")
        local width = math.min(viewport.X, viewport.Y * 16 / 9)
        local crop = Vector2.new(math.floor(width), math.floor(width * 9 / 16))
        local screenshot = service:CaptureScreenshot({
            Position = Vector2.new(math.floor((viewport.X - crop.X) / 2), math.floor((viewport.Y - crop.Y) / 2)),
            CaptureSize = crop, OutputSize = Vector2.new(960, 540),
            ResampleMode = Enum.ResamplerMode.Default,
            Format = Enum.StudioCaptureScreenshotFormat.PNG, UICaptureMode = Enum.UICaptureMode.None,
        })
        local deadline = os.clock() + 10
        while screenshot.BufferStatus.Name ~= "Ready" do
            assert(clone.Parent, "Review capture cancelled.")
            assertCaptureState(model, payload)
            assert(workspace.CurrentCamera == camera and camera.CFrame == ownedFrame, "Camera changed during capture.")
            assert(screenshot.BufferStatus.Name ~= "Error", "Studio screenshot failed: " .. tostring(screenshot:GetErrors()))
            assert(os.clock() < deadline, "Studio screenshot timed out.")
            task.wait(0.05)
        end
        local bytes = buffer.tostring(screenshot:GetBuffer())
        assert(#bytes <= 1400000, "Capture exceeds the 1.4 MB review attachment limit.")
        assert(string.sub(bytes, 1, 8) == "\137PNG\13\10\26\10", "Capture did not return PNG bytes.")
        assertCaptureState(model, payload)
        local id = HttpService:GenerateGUID(false)
        captures[id] = { bytes = bytes, expires = os.clock() + 180 }
        table.insert(captureOrder, id)
        while #captureOrder > 16 do
            local oldest = table.remove(captureOrder, 1)
            captures[oldest] = nil
        end
        local guideLegend = {}
        for _, limb in { "LeftHand", "RightHand", "LeftFoot", "RightFoot" } do
            if includedGuideLimbs[limb] then table.insert(guideLegend, limb .. "=" .. guideColorNames[limb]) end
        end
        return { captureId = id, sessionId = payload.sessionId, assetId = payload.assetId, assetFingerprint = payload.assetFingerprint, rigId = payload.rigId, rigSignature = payload.rigSignature, time = payload.time, view = payload.view, focusJoint = payload.focusJoint, appliedJointMap = appliedJointMap, byteCount = #bytes, chunks = math.ceil(#bytes / 32768), width = 960, height = 540, note = #guidePositions > 0 and ("Unreviewed viewport capture. Requested target dots are colored spheres (" .. table.concat(guideLegend, ", ") .. "); inspect the PNG. They are intent markers, not a visual-quality verdict.") or "Unreviewed viewport capture. Retrieve hex chunks locally; inspect image before provider review." }
    end)
    if workspace.CurrentCamera == camera and ownedFrame and camera.CameraType == Enum.CameraType.Scriptable then
        if camera.CFrame == ownedFrame then
            camera.CFrame, camera.Focus = previous.frame, previous.focus
        elseif camera.Focus == ownedFocus then
            camera.Focus = previous.focus
        end
        -- If the user moved the camera while capture yielded, keep that view but
        -- return control to Studio's previous camera mode so it is not stranded Scriptable.
        camera.CameraType = previous.kind
    end
    if changedFieldOfViewMode then
        camera.FieldOfViewMode = previous.fieldOfViewMode
    end
    if ownedClone then pcall(function() ownedClone:Destroy() end) end
    if ok then assertCaptureState(model, payload) end
    assert(ok, result)
    return result
end

function ReviewCapture.frames(model, payload)
    assert(type(payload.frames) == "table" and #payload.frames >= 1 and #payload.frames <= 8, "Capture set must contain 1–8 frames.")
    local output = {}
    for index, frame in payload.frames do
        assertCaptureState(model, payload)
        assert(frame.time <= payload.recipe.duration, "Capture frame " .. index .. " is outside the animation.")
        local ok, result = pcall(ReviewCapture.frame, model, {
            recipe = payload.recipe, jointMap = payload.jointMap, assetId = payload.assetId, assetFingerprint = payload.assetFingerprint, rigId = payload.rigId, rigSignature = payload.rigSignature,
            time = frame.time, view = frame.view, focusJoint = frame.focusJoint, ikTargetGuides = payload.ikTargetGuides,
            validateCaptureState = payload.validateCaptureState,
        })
        if not ok then
            return { assetId = payload.assetId, rigId = payload.rigId, sessionId = payload.sessionId, complete = false, failedIndex = index, frames = output, error = string.sub(tostring(result), 1, 8000), note = "Capture set stopped at the first failure. Earlier frames remain retrievable by captureId; no visual verdict was made." }
        end
        table.insert(output, result)
    end
    return { assetId = payload.assetId, rigId = payload.rigId, sessionId = payload.sessionId, complete = true, frames = output, note = "Capture set is unreviewed evidence. Retrieve each PNG locally and inspect it before attaching to a review." }
end

function ReviewCapture.compare(model, payload)
    assert(type(payload.candidates) == "table" and #payload.candidates >= 2 and #payload.candidates <= 4, "Candidate comparison requires 2–4 alternatives.")
    assert(type(payload.frames) == "table" and #payload.frames >= 2 and #payload.frames <= 4, "Candidate comparison requires 2–4 shared view/time pairs.")
    assert(#payload.candidates * #payload.frames <= 16, "Candidate comparison exceeds the sixteen-image temporary capture budget.")
    local output = {}
    for candidateIndex, candidate in payload.candidates do
        local capturedFrames = {}
        local entry = { label = candidate.label, assetId = candidate.assetId, assetFingerprint = candidate.assetFingerprint, frames = capturedFrames }
        table.insert(output, entry)
        for frameIndex, frame in payload.frames do
            local ok, result = pcall(ReviewCapture.frame, model, {
                recipe = candidate.recipe, jointMap = payload.jointMap, assetId = candidate.assetId,
                assetFingerprint = candidate.assetFingerprint, rigId = payload.rigId, rigSignature = payload.rigSignature,
                sessionId = payload.sessionId, time = frame.time, view = frame.view, focusJoint = frame.focusJoint,
            })
            if not ok then
                return { sessionId = payload.sessionId, rigId = payload.rigId, complete = false,
                    failedCandidateIndex = candidateIndex, failedFrameIndex = frameIndex, candidates = output,
                    error = string.sub(tostring(result), 1, 8000), note = "Visual comparison stopped at the first capture failure. Earlier images remain available by captureId; no candidate was saved or quality-ranked." }
            end
            table.insert(capturedFrames, result)
        end
    end
    return { sessionId = payload.sessionId, rigId = payload.rigId, complete = true, candidates = output,
        note = "All alternatives were captured with the same requested views and timestamps. Images are unreviewed evidence; inspect them without treating capture order as a quality ranking." }
end

function ReviewCapture.chunk(payload)
    local capture = captures[payload.captureId]
    assert(capture and os.clock() < capture.expires, "Capture expired or was evicted. Capture it again.")
    local first = payload.index * 32768 + 1
    assert(first <= #capture.bytes, "Capture chunk index out of range.")
    local bytes = string.sub(capture.bytes, first, first + 32767)
    return { captureId = payload.captureId, index = payload.index, hex = (bytes:gsub(".", function(c) return string.format("%02x", string.byte(c)) end)) }
end

return ReviewCapture
