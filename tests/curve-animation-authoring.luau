local Enum = {KeyInterpolationMode={Linear="Linear"}, AnimationPriority={Core="Core", Action="Action"}}
local function cframe(x)
    return setmetatable({Position={X=x,Y=0,Z=0}, ToAxisAngle=function() return {X=0,Y=0,Z=1}, 0 end},
        {__mul=function(self) return self end})
end
local CFrame = {identity=cframe(0), new=cframe}
local workspace = {children={}}
local function fakeInstance(className)
    local value = {ClassName=className, children={}}
    function value:IsA(name) return name == className end
    function value:Destroy() self.destroyed=true end
    return setmetatable(value, {__newindex=function(self, key, child)
        rawset(self, key, child)
        if key == "Parent" and child and child.children then table.insert(child.children, self) end
    end})
end
local function floatCurve()
    local value = fakeInstance("FloatCurve")
    value.keys = {}
    function value:InsertKey(key) table.insert(self.keys, key) end
    return value
end
local Instance = {new=function(className)
    local value = fakeInstance(className)
    if className == "Vector3Curve" then
        function value:X() self.x=self.x or floatCurve(); return self.x end
        function value:Y() self.y=self.y or floatCurve(); return self.y end
        function value:Z() self.z=self.z or floatCurve(); return self.z end
    elseif className == "RotationCurve" then
        value.keys = {}
        function value:InsertKey(key) table.insert(self.keys, key) end
    end
    return value
end}
local FloatCurveKey = {new=function(time, value, interpolation) return {Time=time, Value=value, Interpolation=interpolation} end}
local RotationCurveKey = {new=function(time, value, interpolation) return {Time=time, Value=value, Interpolation=interpolation} end}

local CurveAnimationAuthoring = (function()
-- INSERT_CURVE_ANIMATION_AUTHORING_HERE
end)()

local function pose(name, cframe, children)
    return {Name=name, CFrame=cframe, GetSubPoses=function() return children or {} end}
end
local c0 = {Position={X=0,Y=0,Z=0}, id="root"}
local c1 = {Position={X=1,Y=2,Z=3}, id="arm"}
local c2 = {Position={X=4,Y=5,Z=6}, id="hand"}
local frames = {
    {Time=0, GetPoses=function() return {pose("Root", c0, {pose("Arm", c1, {pose("Hand", c2)})})} end},
    {Time=1, GetPoses=function() return {pose("Root", c0, {pose("Arm", c1, {pose("Hand", c2)})})} end},
}
local sequence = {Name="BoneClip", Loop=true, Priority="Action",
    IsA=function(_, name) return name == "KeyframeSequence" end, GetKeyframes=function() return frames end}
local root, arm, hand = {name="Root", children={}}, {name="Arm", children={}}, {name="Hand", children={}}
local bone = {IsA=function(_, name) return name == "Bone" end}
root.target, arm.target, hand.target = nil, bone, bone
arm.parent, hand.parent = root, arm
local clip = CurveAnimationAuthoring.fromKeyframeSequence(sequence, {root, arm, hand})
assert(clip.ClassName == "CurveAnimation" and clip.Name == "BoneClip" and clip.Loop and clip.Priority == "Action")
local armFolder = clip.children[1]
local handFolder
for _, child in armFolder.children do if child.Name == "Hand" then handFolder = child end end
assert(armFolder.Name == "Arm" and handFolder and handFolder.Parent == armFolder, "Bone hierarchy must map into nested curve folders")
local armPosition, armRotation
for _, child in armFolder.children do
    if child.Name == "Position" then armPosition = child elseif child.Name == "Rotation" then armRotation = child end
end
assert(armPosition and armPosition.x.keys[2].Value == 1 and armPosition.y.keys[2].Value == 2 and armPosition.z.keys[2].Value == 3)
assert(armRotation and armRotation.keys[2].Value == c1 and armRotation.keys[2].Interpolation == "Linear")

local crowdedNodes, manyFrames = {}, {}
for index=1,257 do table.insert(crowdedNodes, {name="Bone"..index, target=bone}) end
for index=1,256 do table.insert(manyFrames, {Time=index, GetPoses=function() return {} end}) end
local overBudget, budgetError = pcall(function()
    CurveAnimationAuthoring.fromKeyframeSequence({IsA=sequence.IsA, GetKeyframes=function() return manyFrames end}, crowdedNodes)
end)
assert(not overBudget and string.find(tostring(budgetError), "per-clip limit", 1, true), "curve authoring must reject work above its per-clip budget")

local missingPoseSequence = {IsA=sequence.IsA, GetKeyframes=function() return {{Time=0, GetPoses=function() return {} end}} end}
local missingOk = pcall(function() CurveAnimationAuthoring.fromKeyframeSequence(missingPoseSequence, {root, arm}) end)
assert(not missingOk, "missing Bone pose samples must fail conversion")

local registeredSequences = {}
local calibrationServices = {
    RunService={IsRunning=function() return false end},
    AnimationClipProvider={RegisterAnimationClip=function(_, clip) return "clip:" .. clip.Name end},
    KeyframeSequenceProvider={RegisterActiveKeyframeSequence=function(_, sequence)
        local id="sequence:" .. sequence.Name
        registeredSequences[id]=sequence
        return id
    end},
}
local game = {GetService=function(_, name) return calibrationServices[name] or {} end}
local GraphMotionInspection = (function()
-- INSERT_GRAPH_MOTION_INSPECTION_HERE
end)()
assert(type(GraphMotionInspection.sample) == "function")

-- Exercise the native blend sampler's orchestration with deterministic Roblox fakes.
local function makeTrack(stateId, transformX, animator)
    local track = { Name=stateId, IsPlaying=false, WeightCurrent=0, TimePosition=0, transformX=transformX }
    function track:Play() self.IsPlaying=true; table.insert(animator.tracks, self) end
    function track:AdjustWeight(weight) self.WeightCurrent=weight end
    function track:Destroy()
        self.destroyed=true
        for index, candidate in animator.tracks do if candidate == self then table.remove(animator.tracks, index); break end end
    end
    return track
end
local function runCalibration(extraTrack, includeZeroWeightTrack, jointClass)
    local target = { Name="Root", Transform=cframe(0), IsA=function(_, name) return name == (jointClass or "Motor6D") end }
    local model = { Name="FixtureRig", Archivable=true, GetPivot=function() return cframe(0) end,
        GetDescendants=function() return {} end, FindFirstChildOfClass=function() return nil end,
        PivotTo=function() end, Destroy=function() end }
    local animator = { tracks={}, GetPlayingAnimationTracks=function(self) return self.tracks end }
    function animator:LoadAnimation(animation)
        local sequence = registeredSequences[animation.AnimationId]
        local value = makeTrack(animation.Name, sequence and sequence.transformX or 0, self)
        return value
    end
    function animator:StepAnimations()
        local x=0
        local retained={}
        for _, track in self.tracks do x += track.transformX * track.WeightCurrent end
        for _, track in self.tracks do
            if track.WeightCurrent > 0 then table.insert(retained, track) else track.IsPlaying=false end
        end
        self.tracks=retained
        target.Transform=cframe(x)
        if extraTrack then table.insert(self.tracks, extraTrack) end
    end
    local controller = { FindFirstChildOfClass=function(_, name) if name == "Animator" then return animator end end }
    local clone = { Name="Clone", Parent=nil, GetDescendants=function() return {} end,
        FindFirstChildOfClass=function(_, name) if name == "AnimationController" then return controller end end,
        PivotTo=function() end, Destroy=function(self)
            self.destroyed=true
            table.clear(animator.tracks)
        end }
    local originalFind = model.FindFirstChildOfClass
    local payload = { rigId="rig", rigSignature="signature", graphFingerprint=string.rep("a",64), jointMap={},
        states={{stateId="idle", recipe={duration=1, priority="Core"}}, {stateId="action", recipe={duration=1, priority="Action"}}},
        samples={{caseId="blend", at=0.5, joints={"Root"}, tracks={
            {stateId="idle", weight=0.25, playbackTimeSeconds=0.4},
            {stateId="action", weight=0.75, playbackTimeSeconds=0.2}}}} }
    if includeZeroWeightTrack then
        table.insert(payload.states, {stateId="fading", recipe={duration=1, priority="Core"}})
        table.insert(payload.samples[1].tracks, {stateId="fading", weight=0, playbackTimeSeconds=0.3})
    end
    local createdSequences = {}
    local authoring = { sequence=function(_, recipe)
        local sequence={Name=recipe.priority, transformX=recipe.priority == "Core" and 0 or 4,
            Destroy=function(self) self.destroyed=true end}
        table.insert(createdSequences, sequence)
        return sequence
    end }
    local rig = { id=function() return "rig" end, signature=function() return "signature" end,
        studioBuildIdentity=function() return {status="captured", value="fixture-studio-build", source="roblox_version_global_deprecated"} end,
        nodes=function() return {}, {}, {{name="Root", target=target}} end }
    local preview = { copy=function() return clone end }
    local resultOk, result = pcall(function()
        return GraphMotionInspection.sample(model, payload, authoring, rig, preview, {})
    end)
    assert(originalFind ~= nil)
    return resultOk, result, clone, createdSequences, animator
end
local blendOk, blendResult, cleanClone, cleanSequences, cleanAnimator = runCalibration(nil)
assert(blendOk, tostring(blendResult))
assert(blendResult.studioBuildIdentity.status == "captured" and blendResult.studioBuildIdentity.value == "fixture-studio-build",
    "native blend evidence must retain exact Studio engine-build provenance")
assert(string.find(blendResult.limitation, "AdjustWeight(weight, 0)", 1, true)
    and string.find(blendResult.limitation, "not Roblox Play/Stop fade trajectories", 1, true),
    "native calibration evidence must state that it checks fixed weights, not runtime crossfade trajectories")
assert(string.find(blendResult.limitation, "identity-relative local animation deltas", 1, true)
    and string.find(blendResult.limitation, "not world transforms or the rig's authored rest CFrames", 1, true),
    "native calibration evidence must declare its identity-relative local-animation basis")
assert(math.abs(blendResult.samples[1].joints.Root.position[1] - 3) < 0.00001,
    "two simultaneous weighted tracks must produce the weighted local-space joint pose")
assert(#blendResult.samples[1].tracks == 2 and blendResult.samples[1].tracks[1].weight == 0.25
    and blendResult.samples[1].tracks[2].weight == 0.75, "calibration must return observed per-track weights")
assert(cleanClone.destroyed and #cleanSequences == 2 and cleanSequences[1].destroyed and cleanSequences[2].destroyed,
    "successful calibration must destroy its clone and temporary sequences")
assert(#cleanAnimator.tracks == 0, "successful calibration must destroy its temporary animation tracks")
local foreignTrack = { WeightCurrent=1 }
local foreignOk, foreignError, failedClone, failedSequences, failedAnimator = runCalibration(foreignTrack)
assert(not foreignOk and string.find(tostring(foreignError), "Unexpected animation track", 1, true),
    "an unexpected track must invalidate the native blend sample")
assert(failedClone.destroyed and #failedSequences == 2 and failedSequences[1].destroyed and failedSequences[2].destroyed
    and #failedAnimator.tracks == 0, "failed calibration must clean up the clone, temporary sequences and tracks")
local zeroWeightOk, zeroWeightResult = runCalibration(nil, true)
assert(zeroWeightOk, tostring(zeroWeightResult))
assert(zeroWeightResult.samples[1].tracks[3].weight == 0
    and zeroWeightResult.samples[1].tracks[3].playbackTimeSeconds == 0.3,
    "a stopped zero-weight track may be absent from Animator active tracks without invalidating the pose sample")
local constraintBlendOk, constraintBlendResult = runCalibration(nil, false, "AnimationConstraint")
assert(constraintBlendOk and constraintBlendResult.source == "studio_animator_native_blend"
    and constraintBlendResult.calibrationProtocol == "identity_local_animation_delta_v1",
    "native KeyframeSequence blend calibration must accept AnimationConstraint rig joints")

-- Capture empirical Play/Stop/AdjustWeight fade curves on a detached test rig using controlled Animator steps.
local function runFadeCalibration()
    local target = {Name="Root", Transform=cframe(0), IsA=function(_, name) return name == "Motor6D" end}
    local model = {Name="FixtureRig", Archivable=true, GetPivot=function() return cframe(0) end,
        GetDescendants=function() return {} end, FindFirstChildOfClass=function() return nil end, PivotTo=function() end}
    local animator = {tracks={}}
    function animator:LoadAnimation()
        local track = {IsPlaying=false, WeightCurrent=0, WeightTarget=0, TimePosition=0, Length=1, Looped=false}
        track.Ended = {Connect=function(_, callback)
            track.endedCallback=callback
            return {Disconnect=function() track.endedCallback=nil end}
        end}
        function track:Play(fadeTime, weight, speed)
            if not self.IsPlaying then self.TimePosition=0 end
            self.IsPlaying=true
            self.stopsAfterFade=false
            self.playbackSpeed=speed or 1
            self.naturalFadeElapsed=nil
            self.startWeight=self.WeightCurrent
            self.WeightTarget=weight or 1
            self.fadeDuration=fadeTime or 0
            self.fadeElapsed=0
            if not self.registered then
                table.insert(animator.tracks, self)
                self.registered=true
            end
        end
        function track:Stop(fadeTime)
            self.startWeight=self.WeightCurrent
            self.WeightTarget=0
            self.stopsAfterFade=true
            self.fadeDuration=fadeTime or 0
            self.fadeElapsed=0
            if self.fadeDuration <= 0 then self.IsPlaying=false end
        end
        function track:AdjustWeight(weight, fadeTime)
            self.startWeight=self.WeightCurrent
            self.WeightTarget=weight
            self.stopsAfterFade=false
            self.fadeDuration=fadeTime or 0
            self.fadeElapsed=0
            if self.fadeDuration <= 0 then self.WeightCurrent=weight end
        end
        function track:Destroy() self.destroyed=true end
        return track
    end
    function animator:StepAnimations(delta)
        for _, track in self.tracks do
            local justStoppedNaturally = false
            if track.IsPlaying then
                track.TimePosition += delta * track.playbackSpeed
                if not track.Looped and track.TimePosition >= track.Length then
                    track.IsPlaying=false
                    track.WeightTarget=0
                    track.naturalFadeElapsed=0
                    track.naturalFadeStartWeight=track.WeightCurrent
                    justStoppedNaturally = true
                end
            end
            if track.naturalFadeElapsed ~= nil and not justStoppedNaturally then
                track.naturalFadeElapsed += delta
                local alpha = math.clamp(track.naturalFadeElapsed / 0.2, 0, 1)
                track.WeightCurrent=track.naturalFadeStartWeight * (1-alpha)
                if alpha >= 1 then
                    track.naturalFadeElapsed=nil
                    if track.endedCallback then track.endedCallback() end
                end
            else
                track.fadeElapsed += delta
                local alpha = track.fadeDuration <= 0 and 1 or math.clamp(track.fadeElapsed / track.fadeDuration, 0, 1)
                track.WeightCurrent = track.startWeight + (track.WeightTarget - track.startWeight) * alpha
                if alpha >= 1 and track.stopsAfterFade then track.IsPlaying=false end
            end
        end
    end
    local controller = {FindFirstChildOfClass=function(_, name) if name == "Animator" then return animator end end}
    local clone = {GetDescendants=function() return {} end,
        FindFirstChildOfClass=function(_, name) if name == "AnimationController" then return controller end end,
        PivotTo=function() end, Destroy=function(self) self.destroyed=true end}
    local rig = {id=function() return "rig" end, signature=function() return "signature" end,
        studioBuildIdentity=function() return {status="unavailable", value=nil, source="unavailable"} end,
        nodes=function() return {}, {}, {{name="Root", target=target}} end}
    local preview = {copy=function() return clone end}
    local authoring = {sequence=function() return {Name="FadeFixture", Destroy=function(self) self.destroyed=true end} end}
    local payload = {rigId="rig", rigSignature="signature", graphFingerprint=string.rep("b",64), stateId="idle",
        recipe={duration=1, priority="Core"}, playbackSpeed=1, fadeSeconds=0.5, sampleRateHz=10}
    local ok, result = pcall(function()
        return GraphMotionInspection.captureFade(model, payload, authoring, rig, preview, {})
    end)
    return ok, result, clone, animator
end
local fadeOk, fadeResult, fadeClone, fadeAnimator = runFadeCalibration()
assert(fadeOk, tostring(fadeResult))
assert(fadeResult.source == "studio_animator_fade_calibration" and #fadeResult.playIn == 6 and #fadeResult.stopOut == 6
    and #fadeResult.adjustWeightIn == 6 and #fadeResult.adjustWeightOut == 6,
    "fade calibration must return bounded Play/Stop/AdjustWeight curves at the requested sample rate")
assert(fadeResult.studioBuildIdentity.status == "unavailable" and fadeResult.studioBuildIdentity.source == "unavailable",
    "calibration must represent unavailable Studio build identity explicitly")
assert(fadeResult.playIn[1].weightCurrent == 0 and fadeResult.playIn[1].weightTarget == 1
    and fadeResult.playIn[6].at == 0.5 and fadeResult.playIn[6].weightCurrent == 1,
    "fade-in evidence must preserve initial/final observed AnimationTrack weights")
assert(fadeResult.stopOut[1].weightCurrent == 1 and fadeResult.stopOut[1].weightTarget == 0
    and fadeResult.stopOut[6].at == 0.5 and fadeResult.stopOut[6].weightCurrent == 0,
    "fade-out evidence must preserve initial/final observed AnimationTrack weights")
assert(fadeResult.adjustWeightIn[1].weightCurrent == 0 and fadeResult.adjustWeightIn[1].weightTarget == 1
    and fadeResult.adjustWeightIn[6].weightCurrent == 1 and fadeResult.adjustWeightOut[1].weightCurrent == 1
    and fadeResult.adjustWeightOut[1].weightTarget == 0 and fadeResult.adjustWeightOut[6].weightCurrent == 0,
    "AdjustWeight evidence must independently measure both target directions")
assert(fadeResult.playRetrigger.observedClockBehavior == "preserved"
    and fadeResult.playRetrigger.timePositionBefore > 0
    and fadeResult.playRetrigger.timePositionImmediatelyAfter == fadeResult.playRetrigger.timePositionBefore
    and fadeResult.playRetrigger.timePositionAfterStep > fadeResult.playRetrigger.timePositionImmediatelyAfter,
    "repeated Play evidence must distinguish a preserved clock from a reset and confirm controlled post-call advancement")
assert(math.abs(fadeResult.naturalCompletion.endedAfterStoppedSeconds - 0.2) < 0.00001
    and fadeResult.naturalCompletion.animationLengthSeconds == 1
    and #fadeResult.naturalCompletion.samples == 3
    and fadeResult.naturalCompletion.samples[1].at == 0
    and fadeResult.naturalCompletion.samples[2].weightCurrent == 0.5
    and fadeResult.naturalCompletion.samples[3].weightCurrent == 0,
    "natural-completion calibration must sample the non-looping track's measured fade through AnimationTrack.Ended")
assert(fadeClone.destroyed and fadeAnimator.tracks[1].destroyed,
    "fade calibration must destroy the detached rig and temporary AnimationTrack")
print("Bone CurveAnimation authoring preserves hierarchy, sampled transforms, metadata and bounded failure behavior")
