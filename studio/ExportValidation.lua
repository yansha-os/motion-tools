local ExportValidation = {}

local function conversionCounts(sequence, recipe, jointMap)
    local keyframes = sequence:GetKeyframes()
    local poseCount, markerCount, poseNamesByFrame = 0, 0, {}
    for frameIndex, frame in keyframes do
        markerCount += #frame:GetMarkers()
        local framePoseNames = {}
        for _, descendant in frame:GetDescendants() do
            if descendant:IsA("Pose") then
                poseCount += 1
                framePoseNames[descendant.Name] = true
            end
        end
        poseNamesByFrame[frameIndex] = framePoseNames
    end

    local animatedTargets = {}
    for _, track in recipe.tracks do animatedTargets[jointMap[track.joint] or track.joint] = true end
    for _, layer in recipe.layers or {} do
        for _, track in layer.tracks do animatedTargets[jointMap[track.joint] or track.joint] = true end
    end
    if recipe.rootMotion then
        local joint = recipe.rootMotion.joint
        animatedTargets[jointMap[joint] or joint] = true
    end
    local mappedTargetJoints = {}
    for name in animatedTargets do table.insert(mappedTargetJoints, name) end
    table.sort(mappedTargetJoints)
    local missingTargets = {}
    for frameIndex, frame in keyframes do
        for _, name in mappedTargetJoints do
            if not poseNamesByFrame[frameIndex][name] then
                table.insert(missingTargets, string.format("%s at %.3fs", name, frame.Time))
            end
        end
    end
    if #missingTargets > 0 then
        local shown = {}
        for index = 1, math.min(16, #missingTargets) do table.insert(shown, missingTargets[index]) end
        local omitted = #missingTargets - #shown
        error("Mapped target joints are absent from the converted KeyframeSequence poses: " .. table.concat(shown, ", ")
            .. (omitted > 0 and string.format(" (+%d more)", omitted) or ""), 0)
    end
    return { frameCount = #keyframes, poseCount = poseCount, markerCount = markerCount,
        animatedTrackCount = #mappedTargetJoints, mappedTargetJoints = mappedTargetJoints }
end

ExportValidation.measure = conversionCounts

function ExportValidation.batch(model, payload, Rig, Authoring)
    local function assertRig()
        assert(Rig.active() == model and Rig.id(model) == payload.rigId,
            "The active rig changed during batch validation. Discard this batch and retry.")
        assert(Rig.signature(model) == payload.rigSignature,
            "The rig topology changed during batch validation. Discard this batch and retry.")
    end

    assertRig()
    local results = {}
    for _, candidate in payload.candidates do
        assertRig()
        local sequence
        local ok, result = pcall(function()
            sequence = Authoring.sequence(model, candidate.recipe, payload.jointMap or {})
            return conversionCounts(sequence, candidate.recipe, payload.jointMap or {})
        end)
        local cleanupOk, cleanupError = true, nil
        if sequence then cleanupOk, cleanupError = pcall(function() sequence:Destroy() end) end
        if ok and cleanupOk then
            table.insert(results, { status = "valid", assetId = candidate.assetId, assetFingerprint = candidate.assetFingerprint,
                frameCount = result.frameCount, poseCount = result.poseCount, markerCount = result.markerCount,
                animatedTrackCount = result.animatedTrackCount, mappedTargetJoints = result.mappedTargetJoints })
        else
            local message = not ok and tostring(result) or ("Temporary conversion cleanup failed: " .. tostring(cleanupError))
            table.insert(results, { status = "invalid", assetId = candidate.assetId, assetFingerprint = candidate.assetFingerprint,
                error = string.sub(message, 1, 2000) })
        end
    end
    assertRig()
    return { rigId = payload.rigId, rigSignature = payload.rigSignature, candidates = results, saved = false,
        note = "Each result is an independent local KeyframeSequence conversion. No sequence was saved or authorized for saving." }
end

return ExportValidation
