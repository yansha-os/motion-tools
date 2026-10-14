local AnimationImport = {}

local function number(value, fallback)
    return type(value) == "number" and value == value and math.abs(value) < math.huge and value or fallback
end

local function vector(value)
    return { value.X, value.Y, value.Z }
end

local function transform(frame)
    local x, y, z = frame:ToEulerAnglesXYZ()
    return { position = vector(frame.Position), rotation = { math.deg(x), math.deg(y), math.deg(z) } }
end

local function addWarning(options, message)
    options.warningSet = options.warningSet or {}
    if not options.warningSet[message] then
        options.warningSet[message] = true
        table.insert(options.warnings, message)
    end
end

local function easingName(style, options)
    local name = style and style.Name or "Linear"
    if name == "Cubic" then return "CubicV2" end
    if name == "Linear" or name == "Constant" or name == "Elastic" or name == "Bounce" or name == "CubicV2" then return name end
    addWarning(options, "Unsupported Roblox easing style '" .. tostring(name) .. "' was approximated as Linear.")
    return "Linear"
end

local function directionName(direction, options)
    local name = direction and direction.Name or "Out"
    if name == "In" or name == "Out" or name == "InOut" then return name end
    addWarning(options, "Unsupported Roblox easing direction '" .. tostring(name) .. "' was approximated as Out.")
    return "Out"
end

local function framePoses(keyframe, destination)
    local function visit(pose)
        if pose.Weight == nil or pose.Weight > 0 then
            assert(not destination[pose.Name], "Imported animation contains duplicate pose name " .. pose.Name .. "; map the source rig to unique joint names before importing.")
            destination[pose.Name] = pose
        end
        for _, child in pose:GetSubPoses() do visit(child) end
    end
    for _, pose in keyframe:GetPoses() do visit(pose) end
end

local function keyframeRecipe(clip, options)
    local frames = clip:GetKeyframes()
    table.sort(frames, function(a, b) return a.Time < b.Time end)
    local duration = number(clip.Length, 0)
    for _, frame in frames do duration = math.max(duration, frame.Time) end
    assert(duration >= 0.1 and duration <= 30, "Imported animation duration must be between 0.1 and 30 seconds.")
    assert(#frames > 0, "The source KeyframeSequence has no keyframes.")
    for index = 2, #frames do assert(frames[index].Time > frames[index - 1].Time, "Source keyframes must have unique, increasing times.") end

    local names, states, keysByJoint, times = {}, {}, {}, { [0] = true, [duration] = true }
    for _, frame in frames do
        assert(frame.Time >= 0 and frame.Time <= 30, "Source keyframe lies outside the supported 0–30 second range.")
        times[frame.Time] = true
        local poses = {}
        framePoses(frame, poses)
        for name, pose in poses do
            if pose.Weight == nil or pose.Weight > 0 then
                names[name] = true
                if pose.Weight ~= nil and pose.Weight < 1 then
                    addWarning(options, "Partial-weight pose '" .. name .. "' was baked into its local transform; review blending behavior against the source.")
                end
                local poseFrame = pose.Weight ~= nil and pose.Weight < 1 and CFrame.identity:Lerp(pose.CFrame, math.clamp(pose.Weight, 0, 1)) or pose.CFrame
                local value = transform(poseFrame)
                value.easingStyle, value.easingDirection = easingName(pose.EasingStyle, options), directionName(pose.EasingDirection, options)
                states[name] = value
            end
        end
        for _, marker in frame:GetMarkers() do
            options.markers[#options.markers + 1] = { name = marker.Name, value = marker.Value, time = frame.Time }
        end
        for name in names do
            local state = states[name] or { position = { 0, 0, 0 }, rotation = { 0, 0, 0 }, easingStyle = "Linear", easingDirection = "Out" }
            keysByJoint[name] = keysByJoint[name] or {}
            keysByJoint[name][frame.Time] = { time = frame.Time, position = table.clone(state.position), rotation = table.clone(state.rotation), easingStyle = state.easingStyle, easingDirection = state.easingDirection }
        end
    end
    local sortedTimes = {}
    for time in times do table.insert(sortedTimes, time) end
    table.sort(sortedTimes)
    local tracks = {}
    local orderedNames = {}
    for name in names do table.insert(orderedNames, name) end
    table.sort(orderedNames)
    assert(#orderedNames * #sortedTimes <= 4096, "Imported animation exceeds the 4096-key recipe limit.")
    for _, name in orderedNames do
        local existing = keysByJoint[name] or {}
        local keys, current = {}, { position = { 0, 0, 0 }, rotation = { 0, 0, 0 }, easingStyle = "Linear", easingDirection = "Out" }
        for _, time in sortedTimes do
            local exact = existing[time]
            if exact then current = exact end
            table.insert(keys, { time = time, position = table.clone(current.position), rotation = table.clone(current.rotation), easingStyle = current.easingStyle, easingDirection = current.easingDirection })
        end
        assert(#keys <= 128, name .. " has more than 128 source keyframes; simplify the source animation in Roblox Studio before importing.")
        table.insert(tracks, { joint = name, keys = keys })
    end
    return tracks
end

local function addCurveTimes(curve, times)
    if not curve then return end
    for _, key in curve:GetKeys() do
        assert(key.Time >= 0 and key.Time <= 30, "Source curve key lies outside the supported 0–30 second range.")
        times[key.Time] = true
    end
end

local function curveChannels(folder)
    local channels = {}
    for _, child in folder:GetChildren() do
        if child.Name == "Position" and child:IsA("Vector3Curve") then channels.position = child
        elseif child.Name == "Rotation" and (child:IsA("EulerRotationCurve") or child:IsA("RotationCurve")) then channels.rotation = child end
    end
    return channels
end

local function curveRecipe(clip, options)
    local duration = number(clip.Length, 0)
    local folders, times = {}, { [0] = true, [duration] = true }
    for _, item in clip:GetDescendants() do
        if item:IsA("Folder") then
            local channels = curveChannels(item)
            if channels.position or channels.rotation then
                local entry = { name = item.Name, channels = channels }
                table.insert(folders, entry)
                local p, r = channels.position, channels.rotation
                if p then addCurveTimes(p:X(), times); addCurveTimes(p:Y(), times); addCurveTimes(p:Z(), times) end
                if r then
                    if r:IsA("EulerRotationCurve") then addCurveTimes(r:X(), times); addCurveTimes(r:Y(), times); addCurveTimes(r:Z(), times)
                    else addCurveTimes(r, times) end
                end
            end
        elseif item:IsA("MarkerCurve") then
            for _, marker in item:GetMarkers() do
                local time = number(marker.Time or marker.time or marker[1], nil)
                local value = marker.Value or marker.value or marker[2]
                assert(time and type(value) == "string", "Unsupported CurveAnimation marker data.")
                options.markers[#options.markers + 1] = { name = value, time = time }
                times[time] = true
            end
        end
    end
    assert(duration >= 0.1 and duration <= 30, "Imported animation duration must be between 0.1 and 30 seconds.")
    assert(#folders > 0, "The source CurveAnimation has no supported joint position or rotation curves.")
    assert(#folders <= 256, "CurveAnimation exceeds the 256 joint track limit.")
    local requiredTimes = 0
    for _ in times do requiredTimes += 1 end
    local maxKeysPerTrack = math.min(128, math.floor(4096 / #folders))
    assert(requiredTimes <= maxKeysPerTrack, "CurveAnimation has more unique source key or marker times than the recipe can represent.")
    local requestedSampleCount = math.ceil(duration * options.sampleRate)
    local sampleCount = math.min(requestedSampleCount, maxKeysPerTrack - requiredTimes)
    options.curveSampling = { requestedRateHz = options.sampleRate, requestedInteriorSamples = requestedSampleCount,
        addedInteriorSamples = sampleCount, sourceTimeCount = requiredTimes, maxKeysPerTrack = maxKeysPerTrack }
    if sampleCount < requestedSampleCount then
        addWarning(options, string.format("CurveAnimation sampling was reduced from %d to %d interior samples by the %d-key-per-track limit; inspect fast motion for lost detail.",
            requestedSampleCount, sampleCount, maxKeysPerTrack))
    end
    for index = 1, sampleCount do times[duration * index / (sampleCount + 1)] = true end
    local sortedTimes = {}
    for time in times do table.insert(sortedTimes, time) end
    table.sort(sortedTimes)
    local tracks = {}
    for _, entry in folders do
        assert(#sortedTimes <= maxKeysPerTrack, entry.name .. " exceeds the supported key count.")
        local keys = {}
        for _, time in sortedTimes do
            local position = { 0, 0, 0 }
            if entry.channels.position then
                local x, y, z = entry.channels.position:GetValueAtTime(time)
                position = { number(x, 0), number(y, 0), number(z, 0) }
            end
            local rotation = { 0, 0, 0 }
            if entry.channels.rotation then
                local frame
                if entry.channels.rotation:IsA("EulerRotationCurve") then frame = entry.channels.rotation:GetRotationAtTime(time)
                else frame = entry.channels.rotation:GetValueAtTime(time) end
                if frame then
                    local x, y, z = frame:ToEulerAnglesXYZ()
                    rotation = { math.deg(x), math.deg(y), math.deg(z) }
                end
            end
            table.insert(keys, { time = time, position = position, rotation = rotation, easingStyle = "Linear", easingDirection = "Out" })
        end
        table.insert(tracks, { joint = entry.name, keys = keys })
    end
    return tracks
end

local function saveFolder(model)
    local reference = model:FindFirstChild("AnimSaves")
    if reference and reference:IsA("ObjectValue") then reference = reference.Value end
    assert(reference and reference:IsA("Folder"), "No AnimSaves folder is linked to this rig. Save a Motion Tools animation first or use asset-ID import.")
    return reference
end

function AnimationImport.listLocal(model)
    local folder = saveFolder(model)
    local clips, locators = {}, {}
    local function indexChildren(parent, path)
        for index, item in parent:GetChildren() do
            local childPath = table.clone(path)
            table.insert(childPath, index)
            if item:IsA("KeyframeSequence") or item:IsA("CurveAnimation") then
                locators[item] = table.concat(childPath, ".")
            end
            if not item:IsA("KeyframeSequence") and not item:IsA("CurveAnimation") then indexChildren(item, childPath) end
        end
    end
    indexChildren(folder, {})
    for _, item in folder:GetDescendants() do
        if item:IsA("KeyframeSequence") or item:IsA("CurveAnimation") then
            local entry = { sequenceName = item.Name, className = item.ClassName, duration = number(item.Length, 0),
                path = item:GetFullName(), sequenceLocator = locators[item], trackCount = 0, keyframeCount = 0, poseCount = 0, markerCount = 0 }
            if item:IsA("KeyframeSequence") then
                local names = {}
                local frames = item:GetKeyframes()
                entry.keyframeCount = #frames
                for _, frame in frames do
                    entry.markerCount += #frame:GetMarkers()
                    local function visit(pose)
                        if pose.Weight == nil or pose.Weight > 0 then
                            names[pose.Name] = true
                            entry.poseCount += 1
                        end
                        for _, child in pose:GetSubPoses() do visit(child) end
                    end
                    for _, pose in frame:GetPoses() do visit(pose) end
                end
                for _ in names do entry.trackCount += 1 end
            else
                local names = {}
                for _, descendant in item:GetDescendants() do
                    if descendant:IsA("Folder") then
                        local hasPosition, hasRotation = false, false
                        for _, channel in descendant:GetChildren() do
                            if channel.Name == "Position" and channel:IsA("Vector3Curve") then hasPosition = true end
                            if channel.Name == "Rotation" and (channel:IsA("EulerRotationCurve") or channel:IsA("RotationCurve")) then hasRotation = true end
                        end
                        if hasPosition or hasRotation then names[descendant.Name] = true end
                    end
                end
                for _ in names do entry.trackCount += 1 end
                entry.keyframeCount = entry.trackCount
            end
            table.insert(clips, entry)
        end
    end
    table.sort(clips, function(a, b)
        if a.sequenceName == b.sequenceName then return a.path < b.path end
        return a.sequenceName < b.sequenceName
    end)
    local counts = {}
    for _, clip in clips do counts[clip.sequenceName] = (counts[clip.sequenceName] or 0) + 1 end
    for _, clip in clips do
        clip.ambiguousName = counts[clip.sequenceName] > 1
        clip.nameMatchCount = counts[clip.sequenceName]
    end
    local totalCount = #clips
    while #clips > 200 do table.remove(clips) end
    return { rigName = model.Name, folderName = folder.Name, totalCount = totalCount, returnedCount = #clips,
        truncated = totalCount > #clips, clips = clips,
        note = "Read-only inventory of local KeyframeSequence and CurveAnimation clips. Entries with ambiguousName=true must be renamed before importing by sequenceName; no clip was loaded or changed." }
end

function AnimationImport.convert(clip, options)
    options = options or {}
    options.sampleRate = math.clamp(options.sampleRate or 30, 15, 60)
    options.markers = {}
    options.warnings, options.warningSet, options.curveSampling = {}, {}, nil
    local tracks
    local conversionMode
    if clip:IsA("KeyframeSequence") then
        conversionMode = "keyframe_sequence_pose_tracks"
        tracks = keyframeRecipe(clip, options)
    elseif clip:IsA("CurveAnimation") then
        conversionMode = "curve_animation_sampled_linear"
        addWarning(options, "CurveAnimation curves were sampled into linear recipe keys; interpolation between samples may differ from the source.")
        tracks = curveRecipe(clip, options)
    else error("Unsupported Roblox animation clip type: " .. clip.ClassName .. ". Expected KeyframeSequence or CurveAnimation.") end
    assert(#tracks > 0 and #tracks <= 256, "Imported animation contains no supported joint tracks or exceeds 256 tracks.")
    assert(#options.markers <= 100, "Imported animation exceeds the 100 event-marker limit.")
    local duration = number(clip.Length, 0)
    for _, track in tracks do for _, key in track.keys do duration = math.max(duration, key.time) end end
    duration = math.max(duration, 0.1)
    assert(duration <= 30, "Imported animation exceeds the 30 second recipe limit.")
    local priority = clip.Priority and clip.Priority.Name or "Action"
    if priority ~= "Core" and priority ~= "Idle" and priority ~= "Movement" and priority ~= "Action" and priority ~= "Action2" and priority ~= "Action3" and priority ~= "Action4" then priority = "Action" end
    local recipe = {
        kind = "animation", name = options.name or (clip.Name ~= "" and clip.Name or "Imported Animation"), duration = duration,
        loop = options.loopOverride == nil and clip.Loop or options.loopOverride, priority = priority, tracks = tracks, markers = options.markers,
    }
    return recipe, { conversionMode = conversionMode, fidelity = #options.warnings > 0 and "approximated" or "source_keyframes_preserved",
        warnings = options.warnings, curveSampling = options.curveSampling }
end

function AnimationImport.load(Rig, model, payload)
    local clip
    if payload.sourceAssetId then
        local provider = game:GetService("AnimationClipProvider")
        local ok, loaded = pcall(function() return provider:GetAnimationClipAsync("rbxassetid://" .. payload.sourceAssetId) end)
        assert(ok and loaded, "Roblox could not load this animation asset. Check its ID, ownership/permissions, and Studio animation access.")
        clip = loaded
    else
        local folder = saveFolder(model)
        if payload.sequenceLocator then
            local indices = {}
            for component in string.gmatch(payload.sequenceLocator, "[^%.]+") do
                local index = tonumber(component)
                assert(index and index >= 1 and index % 1 == 0, "Local animation source locator is malformed. Refresh the AnimSaves inventory.")
                table.insert(indices, index)
            end
            local current = folder
            for _, index in indices do
                local children = current:GetChildren()
                current = children[index]
                assert(current, "Local animation source locator is stale. Refresh the AnimSaves inventory and select the clip again.")
            end
            assert(current.Name == payload.sequenceName and (current:IsA("KeyframeSequence") or current:IsA("CurveAnimation")),
                "Local animation source locator no longer identifies the selected clip. Refresh the AnimSaves inventory and preview again.")
            clip = current
        else
            local matches = {}
            for _, item in folder:GetDescendants() do
                if item.Name == payload.sequenceName and (item:IsA("KeyframeSequence") or item:IsA("CurveAnimation")) then
                    table.insert(matches, item)
                end
            end
            assert(#matches <= 1, "Multiple KeyframeSequence or CurveAnimation clips are named " .. payload.sequenceName .. ". Use the exact sequenceLocator from motion_studio_list_local_animations; no clip was chosen.")
            clip = matches[1]
        end
        assert(clip and (clip:IsA("KeyframeSequence") or clip:IsA("CurveAnimation")), "No KeyframeSequence or CurveAnimation named " .. payload.sequenceName .. " was found under this rig's AnimSaves folder.")
    end
    local recipe, diagnostics = AnimationImport.convert(clip, payload)
    local _, byName = Rig.nodes(model)
    local unmapped, mappedSources = {}, {}
    for _, track in recipe.tracks do
        local mapped = payload.jointMap[track.joint] or track.joint
        local node = byName[mapped]
        if node and node.target then
            local priorSource = mappedSources[mapped]
            if priorSource then error("Source joints " .. priorSource .. " and " .. track.joint .. " both map to target joint " .. mapped .. "; provide a unique jointMap.") end
            mappedSources[mapped] = track.joint
            track.joint = mapped
        else table.insert(unmapped, track.joint) end
    end
    if #unmapped > 0 and not payload.allowPartial then
        error("Source animation joints not driven by the selected rig: " .. table.concat(unmapped, ", ") .. ". Provide jointMap entries, select its source rig, or explicitly enable partial import.")
    end
    local kept = {}
    for _, track in recipe.tracks do if byName[track.joint] and byName[track.joint].target then table.insert(kept, track) end end
    assert(#kept > 0, "No imported tracks match driven joints on the selected rig.")
    recipe.tracks = kept
    return recipe, unmapped, clip.ClassName, diagnostics
end

return AnimationImport
