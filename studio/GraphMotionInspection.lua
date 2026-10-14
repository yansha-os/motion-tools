local GraphMotionInspection = {}
local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local AnimationClipProvider = game:GetService("AnimationClipProvider")
local RunService = game:GetService("RunService")
local MAX_TOTAL_BONE_JOINT_SAMPLES = 131072

local function rounded(value)
    assert(value == value and math.abs(value) <= 10000, "Graph inspection returned a non-finite or out-of-range joint transform.")
    return math.round(value * 100000) / 100000
end

local function quaternion(frame)
    local axis, angle = frame:ToAxisAngle()
    local sine = math.sin(angle / 2)
    return { rounded(axis.X * sine), rounded(axis.Y * sine), rounded(axis.Z * sine), rounded(math.cos(angle / 2)) }
end

function GraphMotionInspection.sample(model, payload, Authoring, Rig, Preview, CurveAnimationAuthoring)
    assert(not RunService:IsRunning(), "Stop Play/Test mode before calibrating an animation graph blend.")
    assert(type(payload.samples) == "table" and #payload.samples >= 1 and #payload.samples <= 512,
        "Graph blend calibration requires 1-512 declared pose samples.")
    assert(type(payload.states) == "table" and #payload.states <= 64,
        "Graph blend calibration supports at most 64 referenced graph states.")
    assert(type(payload.graphFingerprint) == "string" and #payload.graphFingerprint == 64
        and string.match(payload.graphFingerprint, "^[%da-f]+$"), "Graph blend calibration fingerprint is invalid.")
    assert(Rig.id(model) == payload.rigId, "The graph calibration rig changed. Select the reviewed rig and retry.")
    assert(Rig.signature(model) == payload.rigSignature, "The graph calibration rig topology changed. Inspect it again and retry.")

    local sampleKeys, stateById = {}, {}
    for _, state in payload.states do
        assert(type(state.stateId) == "string" and not stateById[state.stateId], "Graph calibration state IDs must be unique strings.")
        assert(type(state.recipe) == "table" and type(state.recipe.duration) == "number"
            and state.recipe.duration > 0 and state.recipe.duration <= 30, "Graph calibration animation duration is invalid.")
        stateById[state.stateId] = state.recipe
    end
    local totalJointSamples = 0
    for _, sample in payload.samples do
        assert(type(sample.caseId) == "string" and type(sample.at) == "number" and sample.at >= 0 and sample.at <= 120
            and type(sample.joints) == "table" and #sample.joints >= 1 and #sample.joints <= 256
            and type(sample.tracks) == "table" and #sample.tracks <= 64, "Graph calibration sample is malformed or exceeds its budget.")
        local key = sample.caseId .. ":" .. tostring(sample.at)
        assert(not sampleKeys[key], "Graph calibration timestamps must be unique within a case.")
        sampleKeys[key] = true
        totalJointSamples += #sample.joints
        local jointNames = {}
        for _, name in sample.joints do
            assert(type(name) == "string" and #name > 0 and not jointNames[name], "Graph calibration joint names must be unique strings.")
            jointNames[name] = true
        end
        local trackStates = {}
        for _, active in sample.tracks do
            assert(type(active.stateId) == "string" and stateById[active.stateId] and not trackStates[active.stateId],
                "Graph calibration sample references an unknown or duplicate state track.")
            assert(type(active.weight) == "number" and active.weight >= 0 and active.weight <= 1
                and type(active.playbackTimeSeconds) == "number" and active.playbackTimeSeconds >= 0
                and active.playbackTimeSeconds <= stateById[active.stateId].duration,
                "Graph calibration track weight or playback position is invalid.")
            trackStates[active.stateId] = true
        end
    end
    assert(totalJointSamples <= 4096, "Graph blend calibration exceeds the 4,096 joint-sample budget.")

    local clone = Preview.copy(model)
    local owned = {}
    local ok, result = pcall(function()
        clone.Name = "MotionTools_GraphBlendCalibration"
        clone.Parent = workspace
        clone:PivotTo(model:GetPivot() * CFrame.new(100000, 0, 0))
        for _, descendant in clone:GetDescendants() do
            if descendant:IsA("BasePart") then
                descendant.LocalTransparencyModifier = 1
                descendant.CastShadow = false
            end
        end

        local humanoid = clone:FindFirstChildOfClass("Humanoid")
        local controller = clone:FindFirstChildOfClass("AnimationController")
        if not humanoid and not controller then
            controller = Instance.new("AnimationController")
            controller.Name = "MotionToolsGraphCalibrationController"
            controller.Parent = clone
            table.insert(owned, controller)
        end
        local animatorParent = humanoid or controller
        local animator = animatorParent:FindFirstChildOfClass("Animator")
        if not animator then
            animator = Instance.new("Animator")
            animator.Parent = animatorParent
            table.insert(owned, animator)
        end

        local trackByState = {}
        local targetByName = {}
        local _, _, rigNodes = Rig.nodes(clone)
        local hasBones, boneJointCount, totalBoneJointSamples = false, 0, 0
        for _, node in rigNodes do
            if node.target then
                targetByName[node.name] = node.target
                if node.target:IsA("Bone") then hasBones = true; boneJointCount += 1 end
            end
        end
        for _, state in payload.states do
            assert(type(state.stateId) == "string" and type(state.recipe) == "table", "Graph calibration state is malformed.")
            local sequence = Authoring.sequence(clone, state.recipe, payload.jointMap or {})
            table.insert(owned, sequence)
            local temporaryId
            if hasBones then
                totalBoneJointSamples += #sequence:GetKeyframes() * boneJointCount
                assert(totalBoneJointSamples <= MAX_TOTAL_BONE_JOINT_SAMPLES,
                    "Bone native blend calibration exceeds the 131,072 aggregate joint-time sample limit. Split the graph calibration run or simplify its clips.")
                local curveAnimation = CurveAnimationAuthoring.fromKeyframeSequence(sequence, rigNodes)
                table.insert(owned, curveAnimation)
                temporaryId = AnimationClipProvider:RegisterAnimationClip(curveAnimation)
            else
                temporaryId = KeyframeSequenceProvider:RegisterActiveKeyframeSequence(sequence)
            end
            local animation = Instance.new("Animation")
            animation.Name = "MotionToolsGraph_" .. state.stateId
            animation.AnimationId = temporaryId
            table.insert(owned, animation)
            local track = animator:LoadAnimation(animation)
            track.Priority = Enum.AnimationPriority[state.recipe.priority or "Core"]
            track.Looped = state.recipe.loop == true
            trackByState[state.stateId] = { track = track, duration = state.recipe.duration }
            table.insert(owned, track)
        end

        local results = {}
        for _, sample in payload.samples do
            assert(type(sample.at) == "number" and sample.at >= 0 and type(sample.tracks) == "table",
                "Graph calibration sample is malformed.")
            local requestedByState = {}
            for _, active in sample.tracks do
                local entry = trackByState[active.stateId]
                assert(entry, "Graph calibration sample references a state without a loaded sequence: " .. tostring(active.stateId))
                requestedByState[active.stateId] = active
            end
            for stateId, entry in trackByState do
                local active = requestedByState[stateId]
                local track = entry.track
                if active then
                    if not track.IsPlaying then track:Play(0, 0, 0) end
                    track.TimePosition = math.clamp(active.playbackTimeSeconds, 0, entry.duration)
                    track:AdjustWeight(math.clamp(active.weight, 0, 1), 0)
                elseif track.IsPlaying then
                    track:AdjustWeight(0, 0)
                end
            end
            for _, target in targetByName do
                if target:IsA("Motor6D") or target:IsA("AnimationConstraint") or target:IsA("Bone") then target.Transform = CFrame.identity end
            end
            -- Plugin-security stepping evaluates Roblox's native Animator blend without advancing time.
            animator:StepAnimations(0)
            local playingTrackSet, expectedWeights = {}, {}
            for stateId, entry in trackByState do
                expectedWeights[entry.track] = requestedByState[stateId] and requestedByState[stateId].weight or 0
            end
            for _, track in animator:GetPlayingAnimationTracks() do
                local expectedWeight = expectedWeights[track]
                assert(expectedWeight ~= nil, "Unexpected animation track is active on the calibration Animator.")
                assert(math.abs(track.WeightCurrent - expectedWeight) <= 0.0001,
                    string.format("Calibration Animator has residual track weight %.6f; expected %.6f.", track.WeightCurrent, expectedWeight))
                playingTrackSet[track] = true
            end
            local observedTracks = {}
            for _, active in sample.tracks do
                local track = trackByState[active.stateId].track
                local weight, playbackTime = track.WeightCurrent, track.TimePosition
                assert(math.abs(weight - active.weight) <= 0.0001,
                    string.format("Native blend track %s weight readback %.6f differs from requested %.6f.", active.stateId, weight, active.weight))
                -- A zero-weight track contributes nothing and Roblox may omit a stopped
                -- zero-weight track from GetPlayingAnimationTracks(). Positive weights
                -- must remain live and visible or the pose would be incomplete.
                if active.weight > 0.0001 then
                    assert(track.IsPlaying and playingTrackSet[track], "Native blend track stopped before sampling: " .. active.stateId)
                end
                assert(math.abs(playbackTime - active.playbackTimeSeconds) <= 0.001,
                    string.format("Native blend track %s time readback %.6f differs from requested %.6f seconds.", active.stateId, playbackTime, active.playbackTimeSeconds))
                table.insert(observedTracks, { stateId = active.stateId, weight = rounded(weight), playbackTimeSeconds = rounded(playbackTime) })
            end
            local joints = {}
            for _, jointName in sample.joints do
                local mappedName = (payload.jointMap or {})[jointName] or jointName
                local target = targetByName[mappedName]
                assert(target, "Graph calibration joint is not driven by the selected rig: " .. tostring(mappedName))
                assert(target:IsA("Motor6D") or target:IsA("AnimationConstraint") or target:IsA("Bone"),
                    "Native graph blend calibration requires Motor6D, AnimationConstraint, or Bone joints: " .. tostring(mappedName))
                local transform = target.Transform
                local position = transform.Position
                joints[jointName] = { position = { rounded(position.X), rounded(position.Y), rounded(position.Z) },
                    rotationQuaternion = quaternion(transform) }
            end
            table.insert(results, { caseId = sample.caseId, at = sample.at, joints = joints,
                tracks = observedTracks })
        end
        return { source = "studio_animator_native_blend", calibrationProtocol = "identity_local_animation_delta_v1",
            rigId = payload.rigId, rigSignature = payload.rigSignature,
            studioBuildIdentity = Rig.studioBuildIdentity(),
            graphFingerprint = payload.graphFingerprint, sampleCount = #results, samples = results,
            limitation = (hasBones and "Roblox Animator weighted CurveAnimation blending was evaluated on a detached Bone rig clone at the supplied exact track times and weights. "
                or "Roblox Animator weighted KeyframeSequence blending was evaluated on a detached Motor6D/AnimationConstraint rig clone at the supplied exact track times and weights. ")
                .. "Each returned joint Transform is sampled after resetting that Transform to CFrame.identity; positions and rotations are identity-relative local animation deltas, not world transforms or the rig's authored rest CFrames. The harness assigns each track weight immediately with AdjustWeight(weight, 0); this validates native pose composition at fixed weights, not Roblox Play/Stop fade trajectories or runtime crossfade timing. Fade envelopes remain simulator estimates. This does not test gameplay scheduling, replication, physics, or visual mesh deformation." }
    end)
    for _, instance in owned do pcall(function() instance:Destroy() end) end
    clone:Destroy()
    assert(ok, result)
    assert(Rig.id(model) == payload.rigId and Rig.signature(model) == payload.rigSignature,
        "The reviewed graph calibration rig changed during Studio evaluation.")
    return result
end

function GraphMotionInspection.captureFade(model, payload, Authoring, Rig, Preview, CurveAnimationAuthoring)
    assert(not RunService:IsRunning(), "Stop Play/Test mode before calibrating an animation fade.")
    assert(type(payload.stateId) == "string" and type(payload.recipe) == "table"
        and type(payload.recipe.duration) == "number" and payload.recipe.duration > 0 and payload.recipe.duration <= 30,
        "Animation fade calibration requires one valid graph state recipe.")
    assert(type(payload.fadeSeconds) == "number" and payload.fadeSeconds >= 0.05 and payload.fadeSeconds <= 3,
        "Fade calibration duration must be between 0.05 and 3 seconds.")
    assert(type(payload.sampleRateHz) == "number" and payload.sampleRateHz % 1 == 0
        and payload.sampleRateHz >= 10 and payload.sampleRateHz <= 120,
        "Fade calibration sample rate must be an integer between 10 and 120 Hz.")
    assert(type(payload.graphFingerprint) == "string" and #payload.graphFingerprint == 64
        and string.match(payload.graphFingerprint, "^[%da-f]+$"), "Animation fade graph fingerprint is invalid.")
    assert(Rig.id(model) == payload.rigId, "The fade calibration rig changed. Select the reviewed rig and retry.")
    assert(Rig.signature(model) == payload.rigSignature, "The fade calibration rig topology changed. Inspect it again and retry.")

    local clone = Preview.copy(model)
    local owned = {}
    local ownedConnections = {}
    local ok, result = pcall(function()
        clone.Name = "MotionTools_GraphFadeCalibration"
        clone.Parent = workspace
        clone:PivotTo(model:GetPivot() * CFrame.new(100000, 0, 0))
        for _, descendant in clone:GetDescendants() do
            if descendant:IsA("BasePart") then
                descendant.LocalTransparencyModifier = 1
                descendant.CastShadow = false
            end
        end
        local humanoid = clone:FindFirstChildOfClass("Humanoid")
        local controller = clone:FindFirstChildOfClass("AnimationController")
        if not humanoid and not controller then
            controller = Instance.new("AnimationController")
            controller.Name = "MotionToolsGraphFadeCalibrationController"
            controller.Parent = clone
            table.insert(owned, controller)
        end
        local animatorParent = humanoid or controller
        local animator = animatorParent:FindFirstChildOfClass("Animator")
        if not animator then
            animator = Instance.new("Animator")
            animator.Parent = animatorParent
            table.insert(owned, animator)
        end
        local _, _, rigNodes = Rig.nodes(clone)
        local hasBones = false
        for _, node in rigNodes do
            if node.target and node.target:IsA("Bone") then hasBones = true; break end
        end
        local sequence = Authoring.sequence(clone, payload.recipe, payload.jointMap or {})
        table.insert(owned, sequence)
        local temporaryId
        if hasBones then
            local curveAnimation = CurveAnimationAuthoring.fromKeyframeSequence(sequence, rigNodes)
            table.insert(owned, curveAnimation)
            temporaryId = AnimationClipProvider:RegisterAnimationClip(curveAnimation)
        else
            temporaryId = KeyframeSequenceProvider:RegisterActiveKeyframeSequence(sequence)
        end
        local animation = Instance.new("Animation")
        animation.Name = "MotionToolsFade_" .. payload.stateId
        animation.AnimationId = temporaryId
        table.insert(owned, animation)
        local track = animator:LoadAnimation(animation)
        track.Priority = Enum.AnimationPriority[payload.recipe.priority or "Core"]
        track.Looped = payload.recipe.loop == true
        table.insert(owned, track)

        local loadDeadline = os.clock() + 5
        while track.Length <= 0 and os.clock() < loadDeadline do task.wait() end
        assert(track.Length > 0 and track.Length <= 30,
            "Studio did not load a valid AnimationTrack.Length for this clip; calibration was not saved. Retry after the animation data is available.")

        local function resetTrack()
            if track.IsPlaying then track:Stop(0) end
            animator:StepAnimations(0)
        end
        local function capture(mode)
            resetTrack()
            if mode == "play_in" then
                track:Play(payload.fadeSeconds, 1, 0)
            else
                track:Play(0, 1, 0)
                animator:StepAnimations(0)
                assert(math.abs(track.WeightCurrent - 1) <= 0.0001,
                    "Studio did not establish the fade-out starting weight at 1.")
                track:Stop(payload.fadeSeconds)
            end
            local samples = { { at = 0, weightCurrent = rounded(track.WeightCurrent), weightTarget = rounded(track.WeightTarget) } }
            local elapsed = 0
            local step = 1 / payload.sampleRateHz
            while elapsed < payload.fadeSeconds do
                local delta = math.min(step, payload.fadeSeconds - elapsed)
                animator:StepAnimations(delta)
                elapsed += delta
                table.insert(samples, { at = rounded(elapsed), weightCurrent = rounded(track.WeightCurrent),
                    weightTarget = rounded(track.WeightTarget) })
                assert(#samples <= 362, "Fade calibration exceeded its per-curve sample limit.")
            end
            local expectedEnd = mode == "play_in" and 1 or 0
            assert(math.abs(track.WeightCurrent - expectedEnd) <= 0.01,
                string.format("Studio fade %s ended at weight %.5f instead of %.1f.", mode, track.WeightCurrent, expectedEnd))
            return samples
        end

        local playIn = capture("play_in")
        local stopOut = capture("stop_out")
        local function captureAdjustWeight(startWeight, targetWeight, mode)
            resetTrack()
            track.Looped = true
            track:Play(0, startWeight, 1)
            animator:StepAnimations(0)
            assert(math.abs(track.WeightCurrent - startWeight) <= 0.0001,
                string.format("Studio did not establish AdjustWeight %s starting weight %.1f.", mode, startWeight))
            track:AdjustWeight(targetWeight, payload.fadeSeconds)
            local samples = { { at = 0, weightCurrent = rounded(track.WeightCurrent), weightTarget = rounded(track.WeightTarget) } }
            local elapsed = 0
            local step = 1 / payload.sampleRateHz
            while elapsed < payload.fadeSeconds do
                local delta = math.min(step, payload.fadeSeconds - elapsed)
                animator:StepAnimations(delta)
                elapsed += delta
                table.insert(samples, { at = rounded(elapsed), weightCurrent = rounded(track.WeightCurrent),
                    weightTarget = rounded(track.WeightTarget) })
                assert(#samples <= 362, "AdjustWeight calibration exceeded its per-curve sample limit.")
            end
            assert(math.abs(track.WeightTarget - targetWeight) <= 0.0001
                and math.abs(track.WeightCurrent - targetWeight) <= 0.01,
                string.format("Studio AdjustWeight %s ended at current/target weights %.5f/%.5f instead of %.1f.",
                    mode, track.WeightCurrent, track.WeightTarget, targetWeight))
            return samples
        end
        local adjustWeightIn = captureAdjustWeight(0, 1, "in")
        local adjustWeightOut = captureAdjustWeight(1, 0, "out")
        resetTrack()
        track.Looped = true
        track:Play(0, 1, 1)
        animator:StepAnimations(0)
        assert(math.abs(track.WeightCurrent - 1) <= 0.0001, "Studio did not establish the Play-retrigger probe starting weight.")
        local probeElapsedSeconds = math.min(0.05, payload.recipe.duration / 4)
        animator:StepAnimations(probeElapsedSeconds)
        local timePositionBefore = rounded(track.TimePosition)
        local weightCurrentBefore = rounded(track.WeightCurrent)
        track:Play(payload.fadeSeconds, 1, 1)
        animator:StepAnimations(0)
        local timePositionImmediatelyAfter = rounded(track.TimePosition)
        local weightCurrentImmediatelyAfter = rounded(track.WeightCurrent)
        local weightTargetImmediatelyAfter = rounded(track.WeightTarget)
        animator:StepAnimations(math.min(1 / payload.sampleRateHz, probeElapsedSeconds))
        local timePositionAfterStep = rounded(track.TimePosition)
        local observedClockBehavior = timePositionImmediatelyAfter <= 0.005 and timePositionBefore > probeElapsedSeconds / 2
            and "reset_to_zero" or math.abs(timePositionImmediatelyAfter - timePositionBefore) <= 0.005
            and "preserved" or "ambiguous"
        local playRetrigger = { probeElapsedSeconds = rounded(probeElapsedSeconds), timePositionBefore = timePositionBefore,
            timePositionImmediatelyAfter = timePositionImmediatelyAfter, timePositionAfterStep = timePositionAfterStep,
            weightCurrentBefore = weightCurrentBefore, weightCurrentImmediatelyAfter = weightCurrentImmediatelyAfter,
            weightTargetImmediatelyAfter = weightTargetImmediatelyAfter, observedClockBehavior = observedClockBehavior }
        resetTrack()
        track.Looped = false
        local elapsed, stoppedAt, endedAt = 0, nil, nil
        local naturalSamples = {}
        local endedConnection = track.Ended:Connect(function() endedAt = elapsed end)
        table.insert(ownedConnections, endedConnection)
        track:Play(0, 1, payload.playbackSpeed)
        animator:StepAnimations(0)
        local step = 1 / payload.sampleRateHz
        local maximumElapsed = payload.recipe.duration / payload.playbackSpeed + 3 + step
        while elapsed < maximumElapsed and endedAt == nil do
            local delta = math.min(step, maximumElapsed - elapsed)
            elapsed += delta
            animator:StepAnimations(delta)
            if not track.IsPlaying and stoppedAt == nil then
                stoppedAt = elapsed
                table.insert(naturalSamples, { at = 0, weightCurrent = rounded(track.WeightCurrent),
                    weightTarget = rounded(track.WeightTarget) })
            elseif stoppedAt ~= nil then
                local offset = rounded(elapsed - stoppedAt)
                if offset > naturalSamples[#naturalSamples].at then
                    table.insert(naturalSamples, { at = offset, weightCurrent = rounded(track.WeightCurrent),
                        weightTarget = rounded(track.WeightTarget) })
                end
            end
            assert(#naturalSamples <= 362, "Natural-completion calibration exceeded its bounded sample limit.")
        end
        endedConnection:Disconnect()
        assert(stoppedAt ~= nil and endedAt ~= nil,
            "Studio did not observe both natural playback stop and AnimationTrack.Ended within the bounded calibration window.")
        local endedAfterStoppedSeconds = rounded(math.max(0, endedAt - stoppedAt))
        assert(endedAfterStoppedSeconds <= 3.001, "Natural-completion fade exceeded the 3-second calibration limit.")
        if endedAfterStoppedSeconds == 0 then
            naturalSamples = { { at = 0, weightCurrent = rounded(track.WeightCurrent), weightTarget = rounded(track.WeightTarget) } }
        elseif naturalSamples[#naturalSamples].at < endedAfterStoppedSeconds then
            table.insert(naturalSamples, { at = endedAfterStoppedSeconds, weightCurrent = rounded(track.WeightCurrent),
                weightTarget = rounded(track.WeightTarget) })
        end
        assert(math.abs(track.WeightCurrent) <= 0.01,
            string.format("AnimationTrack.Ended fired at nonzero weight %.5f.", track.WeightCurrent))
        local naturalCompletion = { authoredDurationSeconds = payload.recipe.duration,
            animationLengthSeconds = rounded(track.Length), playbackSpeed = payload.playbackSpeed,
            endedAfterStoppedSeconds = endedAfterStoppedSeconds, samples = naturalSamples }
        resetTrack()
        return { source = "studio_animator_fade_calibration", rigId = payload.rigId, rigSignature = payload.rigSignature,
            graphFingerprint = payload.graphFingerprint, stateId = payload.stateId, fadeSeconds = payload.fadeSeconds,
            sampleRateHz = payload.sampleRateHz, playIn = playIn, stopOut = stopOut,
            adjustWeightIn = adjustWeightIn, adjustWeightOut = adjustWeightOut,
            playRetrigger = playRetrigger, naturalCompletion = naturalCompletion,
            studioBuildIdentity = Rig.studioBuildIdentity(),
            limitation = (hasBones and "Play/Stop/AdjustWeight WeightCurrent fade trajectories measured with a detached Bone rig clone. "
                or "Play/Stop/AdjustWeight WeightCurrent fade trajectories measured with a detached Motor6D/AnimationConstraint rig clone. ")
                .. "Animator:StepAnimations advanced the hidden clone in controlled time increments. The Play-retrigger probe records TimePosition and weight immediately before/after calling Play on an already-playing track, then checks advancement after a controlled step. Natural completion records IsPlaying stop, AnimationTrack.Length, WeightCurrent samples, and the delay until AnimationTrack.Ended. This is empirical evidence for this Studio engine build, not a guarantee for other versions, assets, or live gameplay scheduling." }
    end)
    for _, connection in ownedConnections do pcall(function() connection:Disconnect() end) end
    for _, instance in owned do pcall(function() instance:Destroy() end) end
    clone:Destroy()
    assert(ok, result)
    assert(Rig.id(model) == payload.rigId and Rig.signature(model) == payload.rigSignature,
        "The reviewed fade calibration rig changed during Studio evaluation.")
    return result
end

return GraphMotionInspection
