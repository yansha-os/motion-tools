local KeyframeSelection = {}

function KeyframeSelection.toggleSelection(selectedKeys, key)
    if selectedKeys[key] then
        selectedKeys[key] = nil
        return false
    end
    selectedKeys[key] = true
    return true
end

function KeyframeSelection.captureSelectionIndices(tracks, selectedKeys)
    local indices = {}
    for trackIndex, track in ipairs(tracks) do
        for keyIndex, key in ipairs(track.keys) do
            if selectedKeys[key] then table.insert(indices, { trackIndex = trackIndex, keyIndex = keyIndex }) end
        end
    end
    return indices
end

function KeyframeSelection.restoreSelection(tracks, indices)
    local selectedKeys = {}
    for _, entry in ipairs(indices or {}) do
        local track = tracks[entry.trackIndex]
        local key = track and track.keys[entry.keyIndex]
        if key then selectedKeys[key] = true end
    end
    return selectedKeys
end

function KeyframeSelection.findKeyIndexAtTime(keys, time, tolerance)
    if type(keys) ~= "table" or type(time) ~= "number" or time ~= time or math.abs(time) == math.huge then return nil end
    tolerance = tolerance or 0.000001
    for index, key in ipairs(keys) do
        if math.abs(key.time - time) <= tolerance then return index end
    end
    return nil
end

function KeyframeSelection.planRetiming(tracks, selectedKeys, originalTimes, requestedDelta)
    if type(requestedDelta) ~= "number" or requestedDelta ~= requestedDelta or math.abs(requestedDelta) == math.huge then
        return nil, "Requested keyframe movement must be finite."
    end

    local minimumDelta, maximumDelta = -math.huge, math.huge
    local selectedCount, affectedTrackCount = 0, 0
    for _, track in ipairs(tracks) do
        local keys = track.keys
        local index, trackHasSelection = 1, false
        while index <= #keys do
            if selectedKeys[keys[index]] then
                local firstIndex = index
                while index <= #keys and selectedKeys[keys[index]] do
                    if index == 1 or index == #keys then
                        return nil, "Track endpoints are fixed; deselect endpoint keys before moving a group."
                    end
                    selectedCount += 1
                    index += 1
                end
                local lastIndex = index - 1
                local leftTime = keys[firstIndex - 1].time
                local rightTime = keys[lastIndex + 1].time
                local firstTime = originalTimes[keys[firstIndex]]
                local lastTime = originalTimes[keys[lastIndex]]
                if type(firstTime) ~= "number" or type(lastTime) ~= "number" then
                    return nil, "A selected keyframe is missing its drag-start time."
                end
                local gap = math.min(0.001, (rightTime - leftTime) / 4)
                minimumDelta = math.max(minimumDelta, leftTime + gap - firstTime)
                maximumDelta = math.min(maximumDelta, rightTime - gap - lastTime)
                trackHasSelection = true
            else
                index += 1
            end
        end
        if trackHasSelection then affectedTrackCount += 1 end
    end

    if selectedCount == 0 then return nil, "Select one or more keyframes before dragging." end
    if minimumDelta > maximumDelta then return nil, "The selected keys cannot move without crossing a neighboring key." end
    local delta = math.clamp(requestedDelta, minimumDelta, maximumDelta)
    return {
        delta = delta,
        requestedDelta = requestedDelta,
        selectedCount = selectedCount,
        affectedTrackCount = affectedTrackCount,
        clamped = math.abs(delta - requestedDelta) > 0.0000001,
    }
end

local function isFinite(value)
    return type(value) == "number" and value == value and math.abs(value) < math.huge
end

local function cloneValue(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for key, child in pairs(value) do result[key] = cloneValue(child) end
    return result
end

function KeyframeSelection.planMirrorInsertion(keys, insertionIndex)
    if type(keys) ~= "table" or #keys == 0 then
        return nil, "The matching track needs at least one key so its existing pose can be sampled."
    end
    if type(insertionIndex) ~= "number" or insertionIndex % 1 ~= 0 or insertionIndex < 1 or insertionIndex > #keys + 1 then
        return nil, "Mirror key insertion index is outside the target track."
    end
    local outgoing = keys[insertionIndex - 1] or keys[insertionIndex]
    return {
        easingStyle = outgoing and outgoing.easingStyle or "Linear",
        easingDirection = outgoing and outgoing.easingDirection or "Out",
        curve = outgoing and outgoing.curve and cloneValue(outgoing.curve) or nil,
    }
end

function KeyframeSelection.copyKeyframes(tracks, selectedKeys, anchorTrackIndex, anchorKeyIndex)
    local anchorTrack = tracks[anchorTrackIndex]
    local anchorKey = anchorTrack and anchorTrack.keys[anchorKeyIndex]
    if not anchorKey then return nil, "Select a keyframe to anchor the copied group." end

    selectedKeys = selectedKeys or {}
    local copied, containsAnchor = {}, false
    for trackIndex, track in ipairs(tracks) do
        for keyIndex, key in ipairs(track.keys) do
            if selectedKeys[key] then
                table.insert(copied, {
                    joint = track.joint,
                    timeOffset = key.time - anchorKey.time,
                    key = cloneValue(key),
                    isAnchor = trackIndex == anchorTrackIndex and keyIndex == anchorKeyIndex,
                })
                if trackIndex == anchorTrackIndex and keyIndex == anchorKeyIndex then containsAnchor = true end
            end
        end
    end
    if not containsAnchor then copied = { { joint = anchorTrack.joint, timeOffset = 0, key = cloneValue(anchorKey), isAnchor = true } } end
    return { entries = copied, sourceAnchorTime = anchorKey.time }, nil
end

function KeyframeSelection.planKeyframePaste(tracks, clipboard, targetTime, duration, maximumKeysPerTrack, existingKeyCount, maximumTotalKeys)
    if type(clipboard) ~= "table" or type(clipboard.entries) ~= "table" or #clipboard.entries == 0 then
        return nil, "Copy one or more keyframes before pasting."
    end
    if not isFinite(targetTime) or not isFinite(duration) or duration <= 0 or targetTime < 0 or targetTime > duration then
        return nil, "Paste time must be finite and inside the animation duration."
    end
    maximumKeysPerTrack = maximumKeysPerTrack or 128
    existingKeyCount = existingKeyCount or 0
    maximumTotalKeys = maximumTotalKeys or 4096
    if not isFinite(existingKeyCount) or existingKeyCount < 0 or existingKeyCount % 1 ~= 0
        or not isFinite(maximumKeysPerTrack) or maximumKeysPerTrack < 2 or maximumKeysPerTrack % 1 ~= 0
        or not isFinite(maximumTotalKeys) or maximumTotalKeys < 2 or maximumTotalKeys % 1 ~= 0 then
        return nil, "Keyframe paste limits must be non-negative integer counts."
    end

    local tracksByJoint = {}
    for index, track in ipairs(tracks) do
        if tracksByJoint[track.joint] then return nil, "Cannot paste into duplicate joint tracks." end
        tracksByJoint[track.joint] = { index = index, track = track }
    end

    local plan, plannedTimes = {}, {}
    for _, entry in ipairs(clipboard.entries) do
        local destination = tracksByJoint[entry.joint]
        if not destination then return nil, "The active animation layer has no track for " .. tostring(entry.joint) .. "." end
        if type(entry.key) ~= "table" or not isFinite(entry.timeOffset) then return nil, "Copied keyframe data is invalid." end
        local pastedTime = targetTime + entry.timeOffset
        if not isFinite(pastedTime) or pastedTime <= 0 or pastedTime >= duration then
            return nil, "Pasted keyframes must remain strictly inside the clip; move the playhead or shorten the copied range."
        end
        for _, existing in ipairs(destination.track.keys) do
            if math.abs(existing.time - pastedTime) <= 0.0001 then
                return nil, string.format("Paste would overlap an existing %s key at %.3fs; no keys were changed.", entry.joint, existing.time)
            end
        end
        local jointPlan = plannedTimes[destination.index] or {}
        for _, plannedTime in ipairs(jointPlan) do
            if math.abs(plannedTime - pastedTime) <= 0.0001 then return nil, "Copied keys would overlap each other; no keys were changed." end
        end
        if #destination.track.keys + #jointPlan + 1 > maximumKeysPerTrack then
            return nil, entry.joint .. " would exceed the per-track keyframe limit; no keys were changed."
        end
        if existingKeyCount + #plan + 1 > maximumTotalKeys then
            return nil, "Pasting these keyframes would exceed the total animation keyframe limit; no keys were changed."
        end
        table.insert(jointPlan, pastedTime)
        plannedTimes[destination.index] = jointPlan
        local key = cloneValue(entry.key)
        key.time = pastedTime
        table.insert(plan, { trackIndex = destination.index, key = key, isAnchor = entry.isAnchor == true })
    end
    return plan, nil
end

return KeyframeSelection
