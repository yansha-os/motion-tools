local Authoring = {}

local function cubicIn(t) return t * t * t end
local function cubicOut(t) return 1 - cubicIn(1 - t) end
local function cubicInOut(t)
    if t < 0.5 then return 4 * t * t * t end
    return 1 - ((-2 * t + 2) ^ 3) / 2
end
local function bounceOut(t)
    local n, d = 7.5625, 2.75
    if t < 1 / d then return n * t * t end
    if t < 2 / d then return n * (t - 1.5 / d) ^ 2 + 0.75 end
    if t < 2.5 / d then return n * (t - 2.25 / d) ^ 2 + 0.9375 end
    return n * (t - 2.625 / d) ^ 2 + 0.984375
end
local function elasticIn(t)
    if t == 0 or t == 1 then return t end
    return -(2 ^ (10 * t - 10)) * math.sin((t * 10 - 10.75) * (2 * math.pi / 3))
end
local function elasticOut(t)
    if t == 0 or t == 1 then return t end
    return (2 ^ (-10 * t)) * math.sin((t * 10 - 0.75) * (2 * math.pi / 3)) + 1
end
local function elasticInOut(t)
    if t == 0 or t == 1 then return t end
    local sine = math.sin((20 * t - 11.125) * (2 * math.pi / 4.5))
    if t < 0.5 then return -((2 ^ (20 * t - 10)) * sine) / 2 end
    return ((2 ^ (-20 * t + 10)) * sine) / 2 + 1
end

local function bezierAlpha(curve, progress)
    curve = curve or { outTime = 0.25, outValue = 0.1, inTime = 0.75, inValue = 0.9 }
    local function cubic(t, first, second)
        return 3 * (1 - t) ^ 2 * t * first + 3 * (1 - t) * t ^ 2 * second + t ^ 3
    end
    local target = math.clamp(progress, 0, 1)
    if target == 0 or target == 1 then return target end
    local low, high, parameter = 0, 1, target
    for _ = 1, 24 do
        parameter = (low + high) / 2
        if cubic(parameter, curve.outTime, curve.inTime) < target then low = parameter else high = parameter end
    end
    return cubic(parameter, curve.outValue, curve.inValue)
end

function Authoring.easeAlpha(style, direction, progress, curve)
    local t = math.clamp(progress, 0, 1)
    style = style or "Linear"
    if style == "Bezier" then return bezierAlpha(curve, t) end
    direction = direction or "Out"
    -- Pose easing directions are reversed from the convention used by most animation tools.
    if direction == "In" then direction = "Out"
    elseif direction == "Out" then direction = "In" end
    if style == "Constant" then return t < 1 and 0 or 1 end
    if style == "Linear" then return t end
    if style == "CubicV2" then
        if direction == "Out" then return cubicOut(t) end
        if direction == "InOut" then return cubicInOut(t) end
        return cubicIn(t)
    end
    if style == "Bounce" then
        if direction == "Out" then return bounceOut(t) end
        if direction == "In" then return 1 - bounceOut(1 - t) end
        if t < 0.5 then return (1 - bounceOut(1 - 2 * t)) / 2 end
        return (1 + bounceOut(2 * t - 1)) / 2
    end
    if direction == "Out" then return elasticOut(t) end
    if direction == "In" then return elasticIn(t) end
    return elasticInOut(t)
end

function Authoring.transform(key)
    return CFrame.new(unpack(key.position)) * CFrame.Angles(math.rad(key.rotation[1]), math.rad(key.rotation[2]), math.rad(key.rotation[3]))
end

function Authoring.sample(track, time)
    local keys = track.keys
    if time <= keys[1].time then return Authoring.transform(keys[1]) end
    for index = 2, #keys do
        local right, left = keys[index], keys[index - 1]
        if time <= right.time then
            local alpha = (time - left.time) / (right.time - left.time)
            alpha = Authoring.easeAlpha(left.easingStyle, left.easingDirection, alpha, left.curve)
            return Authoring.transform(left):Lerp(Authoring.transform(right), alpha)
        end
    end
    return Authoring.transform(keys[#keys])
end

function Authoring.tracks(model, recipe, mapping)
    local roots, byName, nodes = Rig.nodes(model)
    local tracks = {}
    local resolvedJointMap = {}
    local function addTrack(track, layer)
        local name = mapping[track.joint] or track.joint
        assert(byName[name] and byName[name].target, "Animation joint not found: " .. name .. ". Inspect the rig and supply jointMap.")
        resolvedJointMap[track.joint] = name
        local stack = tracks[name]
        if not stack then stack = { layers = {} }; tracks[name] = stack end
        if layer then
            table.insert(stack.layers, { track = track, weight = layer.weight, blendMode = layer.blendMode, enabled = layer.enabled })
        else
            assert(not stack.base, "Two base animation tracks map to " .. name)
            stack.base = track
        end
    end
    for _, track in recipe.tracks do addTrack(track, nil) end
    for _, layer in recipe.layers or {} do
        for _, track in layer.tracks do addTrack(track, layer) end
    end
    if recipe.rootMotion then
        addTrack(recipe.rootMotion, { weight = 1, blendMode = "Additive", enabled = true })
    end
    return roots, nodes, tracks, resolvedJointMap
end

function Authoring.sampleStack(stack, time)
    if not stack then return CFrame.identity end
    if stack.keys then return Authoring.sample(stack, time) end -- Preserve callers that still pass a single legacy track.
    local value = stack.base and Authoring.sample(stack.base, time) or CFrame.identity
    for _, layer in stack.layers do
        if layer.enabled and layer.weight > 0 then
            local offset = Authoring.sample(layer.track, time)
            if layer.blendMode == "Additive" then
                value = value * CFrame.identity:Lerp(offset, layer.weight)
            else
                value = value:Lerp(offset, layer.weight)
            end
        end
    end
    return value
end

-- Preview and inspection must evaluate exactly the same local joint transforms.
function Authoring.apply(nodes, tracks, time)
    for _, node in nodes do
        if node.target then
            local value = Authoring.sampleStack(tracks[node.name], time)
            if node.target:IsA("Motor6D") then
                node.target.Part1.CFrame = node.target.Part0.CFrame * node.target.C0 * value * node.target.C1:Inverse()
            elseif node.target:IsA("AnimationConstraint") then
                local parentPart, childPart, parentOffset, childOffset = Rig.jointParts(node.target)
                assert(parentPart and childPart and parentOffset and childOffset, "AnimationConstraint needs valid Attachment0/Attachment1 BasePart endpoints.")
                childPart.CFrame = parentPart.CFrame * parentOffset * value * childOffset:Inverse()
            else node.target.Transform = value end
        end
    end
end

function Authoring.sequence(model, recipe, mapping)
    local roots, _, tracks = Authoring.tracks(model, recipe, mapping)
    local timeSet = {}
    local allTracks = {}
    for _, track in recipe.tracks do table.insert(allTracks, track) end
    for _, layer in recipe.layers or {} do for _, track in layer.tracks do table.insert(allTracks, track) end end
    if recipe.rootMotion then table.insert(allTracks, recipe.rootMotion) end
    for _, track in allTracks do for _, key in track.keys do timeSet[key.time] = true end end
    for _, marker in recipe.markers do timeSet[marker.time] = true end
    local baseTimes = {}
    for time in timeSet do table.insert(baseTimes, time) end
    table.sort(baseTimes)
    local sorted = { baseTimes[1] }
    local function hasNonlinear(stack, time)
        local function trackIsNonlinear(track)
            for index = 1, #track.keys - 1 do
                if time >= track.keys[index].time and time < track.keys[index + 1].time then
                    return (track.keys[index].easingStyle or "Linear") ~= "Linear"
                end
            end
            return false
        end
        if stack.base and trackIsNonlinear(stack.base) then return true end
        for _, layer in stack.layers do if layer.enabled and layer.weight > 0 and trackIsNonlinear(layer.track) then return true end end
        return false
    end
    local function needsBaking(startTime, endTime)
        local middleTime = (startTime + endTime) / 2
        for _, stack in tracks do
            if hasNonlinear(stack, middleTime) then
                local first = Authoring.sampleStack(stack, startTime)
                local last = Authoring.sampleStack(stack, endTime)
                local actual = Authoring.sampleStack(stack, middleTime)
                local errorFrame = first:Lerp(last, 0.5):ToObjectSpace(actual)
                local _, angle = errorFrame:ToAxisAngle()
                if errorFrame.Position.Magnitude > 0.005 or angle > math.rad(0.25) then return true end
            end
        end
        return false
    end
    local function appendInterval(startTime, endTime, depth)
        if depth < 8 and needsBaking(startTime, endTime) then
            local middleTime = (startTime + endTime) / 2
            appendInterval(startTime, middleTime, depth + 1)
            appendInterval(middleTime, endTime, depth + 1)
            return
        end
        assert(#sorted < 2048, "Easing export exceeded 2048 sampled keyframes; simplify the motion or use fewer easing segments.")
        table.insert(sorted, endTime)
    end
    for index = 1, #baseTimes - 1 do appendInterval(baseTimes[index], baseTimes[index + 1], 0) end
    assert(#sorted <= 2048, "Animation export exceeded 2048 keyframes.")
    local sequence = Instance.new("KeyframeSequence")
    sequence.Name, sequence.Loop, sequence.Priority = recipe.name, recipe.loop, Enum.AnimationPriority[recipe.priority or "Action"]
    local function poseFor(node, time)
        local pose = Instance.new("Pose")
        pose.Name = node.name
        local sourceStack = tracks[node.name]
        pose.Weight = sourceStack and 1 or 0
        -- Bake all non-linear behavior into bounded samples so keyframes/markers cannot restart a curve.
        pose.EasingStyle = Enum.PoseEasingStyle.Linear
        pose.EasingDirection = Enum.PoseEasingDirection.Out
        pose.CFrame = Authoring.sampleStack(sourceStack, time)
        for _, child in node.children do pose:AddSubPose(poseFor(child, time)) end
        return pose
    end
    for _, time in sorted do
        local frame = Instance.new("Keyframe")
        frame.Time = time
        for _, root in roots do frame:AddPose(poseFor(root, time)) end
        for _, event in recipe.markers do
            if event.time == time then
                local marker = Instance.new("KeyframeMarker")
                marker.Name, marker.Value = event.name, event.value or ""
                frame:AddMarker(marker)
            end
        end
        sequence:AddKeyframe(frame)
    end
    return sequence
end

function Authoring.saveDestination(model)
    local reference = model:FindFirstChild("AnimSaves")
    if reference then
        if reference:IsA("Folder") then return reference end -- Legacy Studio saves.
        assert(reference:IsA("ObjectValue"), "AnimSaves exists but is not an animation save reference.")
        if reference.Value then
            assert(reference.Value:IsA("Folder"), "AnimSaves reference must target a Folder.")
            return reference.Value
        end
    end
    local folder = Instance.new("Folder")
    folder.Name = model.Name .. "_Motion_" .. game:GetService("HttpService"):GenerateGUID(false)
    folder.Parent = game:GetService("ServerStorage")
    if not reference then
        reference = Instance.new("ObjectValue")
        reference.Name = "AnimSaves"
        reference.Parent = model
    end
    reference.Value = folder
    return folder
end

function Authoring.reconcileExports(sequences, expected)
    local matches, related, matchCount, relatedCount = {}, {}, 0, 0
    for _, sequence in sequences do
        if sequence:IsA("KeyframeSequence") then
            local assetId = sequence:GetAttribute("MotionAssetId")
            local assetFingerprint = sequence:GetAttribute("MotionAssetFingerprint")
            local rigSignature = sequence:GetAttribute("MotionRigSignature")
            local exportFingerprint = sequence:GetAttribute("MotionExportFingerprint")
            local entry = { name = sequence.Name, assetId = assetId, assetFingerprint = assetFingerprint, rigSignature = rigSignature }
            if exportFingerprint == expected.preflightFingerprint then
                matchCount += 1
                if #matches < 64 then table.insert(matches, entry) end
            elseif assetId == expected.assetId or assetFingerprint == expected.assetFingerprint then
                relatedCount += 1
                if #related < 64 then table.insert(related, entry) end
            end
        end
    end
    local count = matchCount > 0 and matchCount or relatedCount
    local candidates = matchCount > 0 and matches or related
    local result = { matches = candidates, totalMatchCount = count, matchesTruncated = count > #candidates }
    if matchCount > 1 then result.status = "duplicate_identity"; result.found = false; return result end
    local match = matches[1]
    if match then
        if match.assetId ~= expected.assetId or match.assetFingerprint ~= expected.assetFingerprint or match.rigSignature ~= expected.rigSignature then
            result.status = "identity_conflict"; result.found = false; return result
        end
        result.status = "saved"; result.found = true; return result
    end
    if relatedCount > 0 then result.status = "related_candidates"; result.found = false; return result end
    result.status = "not_found"; result.found = false; return result
end

function Authoring.effect(parent, recipe, active)
    local attachment = Instance.new("Attachment")
    attachment.Name = recipe.name
    attachment.Position = Vector3.new(unpack(recipe.offset))
    if recipe.column then
        attachment:SetAttribute("MotionColumnRecipe", game:GetService("HttpService"):JSONEncode(recipe))
        attachment.Parent = parent
        return attachment, active and EnergyColumn.create(attachment, recipe) or nil
    end
    if recipe.beam then
        local endpoint = Instance.new("Attachment")
        endpoint.Name = "Endpoint"
        endpoint.Position = Vector3.new(0, 0, -recipe.beam.length)
        endpoint.Parent = attachment
        local beams = {}
        for _, layer in { { "Glow", 1, Color3.new(unpack(recipe.color)), 0.25 }, { "Core", 0.35, Color3.new(0.85, 0.97, 1), 0 } } do
            local beam = Instance.new("Beam")
            beam.Name = layer[1]
            beam.Attachment0, beam.Attachment1 = attachment, endpoint
            beam.Width0, beam.Width1 = recipe.size * layer[2], recipe.size * layer[2]
            beam.Color = ColorSequence.new(layer[3])
            beam.Transparency = NumberSequence.new(layer[4])
            beam.FaceCamera = true
            beam.LightEmission, beam.LightInfluence = recipe.lightEmission, 0
            beam.Segments = 1
            beam.Enabled = active
            beam.Parent = attachment
            table.insert(beams, beam)
        end
        attachment:SetAttribute("Duration", recipe.lifetime)
        attachment.Parent = parent
        if active then
            task.delay(recipe.lifetime, function()
                for _, beam in beams do
                    if beam.Parent then beam.Enabled = false end
                end
            end)
        end
        return attachment
    end
    local emitter = Instance.new("ParticleEmitter")
    emitter.Name = "Particles"
    emitter.Texture = recipe.texture or "rbxasset://textures/particles/sparkles_main.dds"
    emitter.Color = ColorSequence.new(Color3.new(unpack(recipe.color)))
    emitter.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, recipe.size), NumberSequenceKeypoint.new(1, 0) })
    emitter.Transparency = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.05), NumberSequenceKeypoint.new(1, 1) })
    emitter.Lifetime = NumberRange.new(recipe.lifetime)
    emitter.Speed = NumberRange.new(recipe.speed)
    emitter.SpreadAngle = Vector2.new(recipe.spread, recipe.spread)
    emitter.LightEmission = recipe.lightEmission
    emitter.Rate, emitter.Enabled = recipe.rate, active
    emitter:SetAttribute("EmitCount", recipe.count)
    emitter.Parent = attachment
    attachment.Parent = parent
    if active then emitter:Emit(recipe.count) end
    return attachment
end

return Authoring
