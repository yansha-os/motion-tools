local IKContact = {}

local function near(left, right)
    return math.abs(left - right) <= 0.0001
end

-- World-space target paths support exact linear segments or optional smooth
-- centripetal Catmull–Rom interpolation. Keep validation here as a second
-- boundary because this module is also used directly by the Studio plugin.
local function pointDistance(left, right)
    local x, y, z = left[1] - right[1], left[2] - right[2], left[3] - right[3]
    return math.sqrt(x * x + y * y + z * z)
end

local function interpolateLinear(left, right, alpha)
    return {
        left[1] + (right[1] - left[1]) * alpha,
        left[2] + (right[2] - left[2]) * alpha,
        left[3] + (right[3] - left[3]) * alpha,
    }
end

local function centripetalCatmullRom(points, leftIndex, alpha)
    local left, right = points[leftIndex].position, points[leftIndex + 1].position
    local previous = points[leftIndex - 1] and points[leftIndex - 1].position or {
        2 * left[1] - right[1], 2 * left[2] - right[2], 2 * left[3] - right[3],
    }
    local following = points[leftIndex + 2] and points[leftIndex + 2].position or {
        2 * right[1] - left[1], 2 * right[2] - left[2], 2 * right[3] - left[3],
    }
    if pointDistance(previous, left) < 1e-8 or pointDistance(left, right) < 1e-8 or pointDistance(right, following) < 1e-8 then
        return interpolateLinear(left, right, alpha)
    end
    local t0 = 0
    local t1 = t0 + math.sqrt(pointDistance(previous, left))
    local t2 = t1 + math.sqrt(pointDistance(left, right))
    local t3 = t2 + math.sqrt(pointDistance(right, following))
    local t = t1 + (t2 - t1) * alpha
    local function blend(a, b, ta, tb)
        local denominator = math.max(tb - ta, 1e-9)
        return interpolateLinear(a, b, (t - ta) / denominator)
    end
    local a1 = blend(previous, left, t0, t1)
    local a2 = blend(left, right, t1, t2)
    local a3 = blend(right, following, t2, t3)
    local b1 = interpolateLinear(a1, a2, (t - t0) / math.max(t2 - t0, 1e-9))
    local b2 = interpolateLinear(a2, a3, (t - t1) / math.max(t3 - t1, 1e-9))
    return interpolateLinear(b1, b2, alpha)
end

function IKContact.targetAt(points, time, interpolation)
    interpolation = interpolation or "linear"
    assert(interpolation == "linear" or interpolation == "centripetal_catmull_rom", "IK target interpolation must be linear or centripetal_catmull_rom.")
    assert(type(points) == "table" and #points >= 2 and #points <= 32, "IK target path needs 2–32 timed world positions.")
    assert(type(time) == "number" and time == time and math.abs(time) < math.huge, "IK target sample time must be finite.")
    for index = 1, #points do
        local point = points[index]
        assert(type(point) == "table" and type(point.time) == "number" and point.time == point.time and math.abs(point.time) < math.huge and type(point.position) == "table" and #point.position == 3, "IK target path contains an invalid sample.")
        for _, component in point.position do assert(type(component) == "number" and component == component and math.abs(component) < math.huge, "IK target position must be finite.") end
        if index > 1 then assert(points[index - 1].time < point.time, "IK target path times must be strictly increasing.") end
    end
    assert(time >= points[1].time and time <= points[#points].time, "IK target path does not cover the requested sample time.")
    for index = 2, #points do
        local right, left = points[index], points[index - 1]
        if time <= right.time then
            local alpha = (time - left.time) / (right.time - left.time)
            if interpolation == "centripetal_catmull_rom" and #points >= 3 then return centripetalCatmullRom(points, index - 1, alpha) end
            return interpolateLinear(left.position, right.position, alpha)
        end
    end
    return table.clone(points[#points].position)
end

-- Orientation waypoints are world-space XYZ Euler angles converted to
-- rotation-only CFrames by the caller. Roblox CFrame:Lerp performs shortest-arc
-- rotational slerp, avoiding component-wise Euler interpolation and wrap jumps.
function IKContact.orientationAt(points, time, frameFromDegrees)
    assert(type(points) == "table" and #points >= 2 and #points <= 32, "IK orientation path needs 2–32 timed world orientations.")
    assert(type(time) == "number" and time == time and math.abs(time) < math.huge, "IK orientation sample time must be finite.")
    assert(type(frameFromDegrees) == "function", "IK orientation interpolation needs a rotation-frame converter.")
    local previousTime = -math.huge
    for _, point in points do
        assert(type(point) == "table" and type(point.time) == "number" and point.time == point.time and math.abs(point.time) < math.huge
            and type(point.orientationDegrees) == "table" and #point.orientationDegrees == 3, "IK orientation path contains an invalid sample.")
        assert(point.time > previousTime, "IK orientation path times must be strictly increasing.")
        previousTime = point.time
        for _, angle in point.orientationDegrees do
            assert(type(angle) == "number" and angle == angle and math.abs(angle) < math.huge and math.abs(angle) <= 360,
                "IK orientation angles must be finite and between -360 and 360 degrees.")
        end
    end
    assert(time >= points[1].time and time <= points[#points].time, "IK orientation path does not cover the requested sample time.")
    for index = 2, #points do
        local left, right = points[index - 1], points[index]
        if time <= right.time then
            local alpha = (time - left.time) / (right.time - left.time)
            local leftFrame = frameFromDegrees(left.orientationDegrees)
            local rightFrame = frameFromDegrees(right.orientationDegrees)
            return leftFrame:Lerp(rightFrame, alpha).Rotation
        end
    end
    return frameFromDegrees(points[#points].orientationDegrees).Rotation
end

function IKContact.classifyResiduals(samples, toleranceStuds)
    assert(type(samples) == "table" and #samples > 0, "IK residual classification needs at least one sample.")
    assert(type(toleranceStuds) == "number" and toleranceStuds == toleranceStuds and toleranceStuds > 0 and toleranceStuds < math.huge, "IK residual tolerance must be positive and finite.")
    local met, squaredTotal, maximum, unmetTimes = 0, 0, 0, {}
    for _, sample in samples do
        assert(type(sample.time) == "number" and sample.time == sample.time and type(sample.residual) == "number" and sample.residual == sample.residual and sample.residual >= 0 and sample.residual < math.huge, "IK residual sample is invalid.")
        squaredTotal += sample.residual * sample.residual
        maximum = math.max(maximum, sample.residual)
        if sample.residual <= toleranceStuds then met += 1 else table.insert(unmetTimes, sample.time) end
    end
    local ratio = met / #samples
    local status = met == #samples and "converged" or ratio >= 0.5 and "partial" or "unmet"
    return {
        status = status,
        toleranceStuds = toleranceStuds,
        sampleCount = #samples,
        samplesWithinTolerance = met,
        withinToleranceRatio = ratio,
        maximumResidualStuds = maximum,
        rmsResidualStuds = math.sqrt(squaredTotal / #samples),
        unmetSampleTimes = unmetTimes,
        limitation = "Classification measures endpoint error only. Unmet samples can indicate target reach limits, local minima, custom joint axes, or insufficient solver iterations; this is not proof of anatomical unreachability or physical contact.",
    }
end

function IKContact.summarizePoleErrors(samples)
    assert(type(samples) == "table" and #samples > 0 and #samples <= 128, "Pole-plane measurement needs 1–128 samples.")
    local measured, squaredTotal, maximum, maximumTime, unmeasuredTimes = 0, 0, 0, nil, {}
    local previousTime = -math.huge
    local normalized = {}
    for _, sample in samples do
        assert(type(sample.time) == "number" and sample.time == sample.time and math.abs(sample.time) < math.huge and sample.time > previousTime,
            "Pole-plane sample times must be finite and strictly increasing.")
        previousTime = sample.time
        if sample.errorDegrees ~= nil then
            assert(type(sample.errorDegrees) == "number" and sample.errorDegrees == sample.errorDegrees and sample.errorDegrees >= 0 and sample.errorDegrees <= 180,
                "Pole-plane error must be between 0 and 180 degrees.")
            measured += 1
            squaredTotal += sample.errorDegrees * sample.errorDegrees
            if sample.errorDegrees > maximum then maximum, maximumTime = sample.errorDegrees, sample.time end
            table.insert(normalized, { time = sample.time, errorDegrees = sample.errorDegrees })
        else
            assert(type(sample.unavailableReason) == "string" and #sample.unavailableReason > 0 and #sample.unavailableReason <= 120,
                "An unavailable pole-plane sample needs a concise reason.")
            table.insert(unmeasuredTimes, sample.time)
            table.insert(normalized, { time = sample.time, unavailableReason = sample.unavailableReason })
        end
    end
    return {
        status = measured == 0 and "unavailable" or measured == #samples and "measured" or "partial",
        sampleCount = #samples,
        measuredSampleCount = measured,
        maximumErrorDegrees = maximum,
        rmsErrorDegrees = measured > 0 and math.sqrt(squaredTotal / measured) or 0,
        maximumErrorTime = maximumTime,
        unmeasuredTimes = unmeasuredTimes,
        samples = normalized,
        limitation = "Angular error compares the projected bend direction with the requested pole direction. It does not judge anatomy, joint comfort, silhouette, or animation quality.",
    }
end

function IKContact.planConstraints(constraints)
    assert(type(constraints) == "table" and #constraints >= 1 and #constraints <= 4, "IK needs 1–4 effectors.")
    local limbs, joints, orderedJoints, sharedJoints = {}, {}, {}, {}
    local orderedConstraints = table.clone(constraints)
    table.sort(orderedConstraints, function(left, right) return left.limb < right.limb end)
    for _, constraint in orderedConstraints do
        assert(type(constraint.limb) == "string" and type(constraint.chainNames) == "table" and #constraint.chainNames > 0, "Every IK constraint needs a limb and a non-empty chain.")
        assert(not limbs[constraint.limb], "A coordinated IK solve can target each limb only once.")
        limbs[constraint.limb] = true
        local chainSeen = {}
        for _, joint in constraint.chainNames do
            assert(type(joint) == "string" and #joint > 0, "IK chain joint names must be non-empty strings.")
            assert(not chainSeen[joint], "IK chain for " .. constraint.limb .. " contains duplicate joint " .. tostring(joint) .. ".")
            chainSeen[joint] = true
            if not joints[joint] then
                joints[joint] = 1
                table.insert(orderedJoints, joint)
            else
                joints[joint] += 1
                if joints[joint] == 2 then table.insert(sharedJoints, joint) end
            end
        end
    end
    table.sort(sharedJoints)
    return orderedJoints, sharedJoints
end

function IKContact.solveAlternating(constraints, goals, toleranceStuds, maximumSweeps, solveEffector, measureResidual)
    assert(type(constraints) == "table" and #constraints >= 1 and #constraints <= 4, "IK needs 1–4 effectors.")
    assert(type(goals) == "table" and #goals == #constraints, "Every coordinated effector needs a target.")
    assert(type(toleranceStuds) == "number" and toleranceStuds == toleranceStuds and toleranceStuds > 0 and toleranceStuds < math.huge, "IK tolerance must be positive and finite.")
    assert(type(maximumSweeps) == "number" and maximumSweeps % 1 == 0 and maximumSweeps >= 1 and maximumSweeps <= 12, "Alternating IK sweep limit must be 1–12.")
    assert(type(solveEffector) == "function" and type(measureResidual) == "function", "Alternating IK requires solver and residual callbacks.")
    local residuals, converged = {}, false
    local sweeps = 0
    for sweep = 1, maximumSweeps do
        sweeps = sweep
        for index, constraint in constraints do solveEffector(constraint, goals[index], sweep) end
        converged = true
        for index, constraint in constraints do
            local residual = measureResidual(constraint, goals[index])
            assert(type(residual) == "number" and residual == residual and residual >= 0 and residual < math.huge, "Coordinated IK produced a non-finite or negative residual.")
            residuals[index] = residual
            if residual > toleranceStuds then converged = false end
        end
        if converged then break end
    end
    return residuals, sweeps, converged
end

function IKContact.schedule(startTime, endTime, sampleRateHz, editableTracks, maximumSamples)
    assert(type(startTime) == "number" and type(endTime) == "number" and startTime >= 0 and endTime > startTime, "IK contact interval must have positive duration.")
    assert(sampleRateHz == 15 or sampleRateHz == 30 or sampleRateHz == 60, "IK contact sampleRateHz must be 15, 30, or 60.")
    maximumSamples = maximumSamples or 128
    local steps = math.ceil((endTime - startTime) * sampleRateHz)
    assert(steps + 1 <= maximumSamples, "IK contact solve exceeds the " .. tostring(maximumSamples) .. " sample limit; lower sampleRateHz or narrow the interval.")
    local times = { startTime, endTime }
    for _, track in editableTracks do
        for _, key in track.keys do
            if key.time > startTime and key.time < endTime then table.insert(times, key.time) end
        end
    end
    for index = 1, steps - 1 do
        table.insert(times, startTime + (endTime - startTime) * index / steps)
    end
    table.sort(times)
    local unique = {}
    for _, time in times do
        if #unique == 0 or not near(time, unique[#unique]) then table.insert(unique, time) end
    end
    assert(#unique <= maximumSamples, "IK contact solve requires " .. tostring(#unique) .. " sample keys; maximum is " .. tostring(maximumSamples) .. ". Lower sampleRateHz or narrow the interval.")
    return unique
end

function IKContact.planBake(contacts, selectedEffectors, duration, sampleRateHz, editableTracks, maximumSamples)
    maximumSamples = maximumSamples or 128
    assert(type(contacts) == "table" and #contacts >= 1 and #contacts <= 16, "Contact bake needs 1–16 declared contact windows.")
    assert(type(selectedEffectors) == "table" and #selectedEffectors >= 1 and #selectedEffectors <= 4, "Select 1–4 hand/foot effectors for the contact bake.")
    assert(type(duration) == "number" and duration > 0 and duration < math.huge, "Contact bake duration must be positive and finite.")
    assert(sampleRateHz == 15 or sampleRateHz == 30 or sampleRateHz == 60, "Contact bake sample rate must be 15, 30, or 60 Hz.")
    local recognized = { LeftHand = true, RightHand = true, LeftFoot = true, RightFoot = true }
    local selected, windows = {}, {}
    for _, effector in selectedEffectors do
        assert(recognized[effector], "Contact bake supports only LeftHand, RightHand, LeftFoot, and RightFoot.")
        assert(not selected[effector], "Each contact-bake effector may be selected only once.")
        selected[effector] = true
    end
    for index, contact in contacts do
        if selected[contact.effector] then
            assert(contact.kind == "support" or contact.kind == "grip", "Contact bake requires support or grip declarations.")
            assert(type(contact.start) == "number" and type(contact["end"]) == "number" and contact.start >= 0 and contact.start < contact["end"] and contact["end"] <= duration,
                "Contact window " .. tostring(index) .. " must have positive duration inside the animation.")
            table.insert(windows, { index = index - 1, effector = contact.effector, kind = contact.kind, start = contact.start, endTime = contact["end"] })
        end
    end
    for effector in selected do
        local found = false
        for _, window in windows do if window.effector == effector then found = true; break end end
        assert(found, "No declared support/grip contacts were found for " .. effector .. ".")
    end
    table.sort(windows, function(left, right)
        if left.start ~= right.start then return left.start < right.start end
        if left.endTime ~= right.endTime then return left.endTime < right.endTime end
        return left.index < right.index
    end)
    for windowIndex, window in windows do
        for priorIndex = 1, windowIndex - 1 do
            local prior = windows[priorIndex]
            if prior.effector == window.effector then
                assert(window.start >= prior.endTime, window.effector .. " contact windows overlap; one effector cannot hold two targets at once.")
            end
        end
    end

    local requiredTimes, generatedTimes = {}, {}
    for _, window in windows do
        local interval = window.endTime - window.start
        local steps = math.ceil(interval * sampleRateHz)
        assert(steps + 1 <= maximumSamples, window.effector .. " contact window exceeds the " .. tostring(maximumSamples) .. " sample limit.")
        requiredTimes[window.start] = true
        requiredTimes[window.endTime] = true
        for _, track in editableTracks do
            for _, key in track.keys do
                if key.time > window.start and key.time < window.endTime then requiredTimes[key.time] = true end
            end
        end
        for index = 1, steps - 1 do table.insert(generatedTimes, window.start + interval * index / steps) end
    end
    local orderedRequiredTimes, uniqueGridTimes = {}, {}
    for time in requiredTimes do table.insert(orderedRequiredTimes, time) end
    table.sort(orderedRequiredTimes)
    table.sort(generatedTimes)
    for _, time in generatedTimes do
        local redundant = false
        for _, required in orderedRequiredTimes do
            if near(time, required) then redundant = true; break end
        end
        if not redundant and (#uniqueGridTimes == 0 or not near(time, uniqueGridTimes[#uniqueGridTimes])) then
            table.insert(uniqueGridTimes, time)
        end
    end
    local uniqueTimes = table.clone(orderedRequiredTimes)
    for _, time in uniqueGridTimes do table.insert(uniqueTimes, time) end
    table.sort(uniqueTimes)
    assert(#uniqueTimes <= maximumSamples, "Combined contact bake exceeds the " .. tostring(maximumSamples) .. " sample limit; lower sample rate or select fewer contacts.")
    local samples = {}
    for _, time in uniqueTimes do
        local byEffector = {}
        for _, window in windows do
            if time >= window.start and time <= window.endTime then
                local current = byEffector[window.effector]
                if not current or window.start > current.start or (window.start == current.start and window.index > current.index) then
                    byEffector[window.effector] = window
                end
            end
        end
        local windowIndices, activeCount = {}, 0
        for _, window in byEffector do activeCount += 1; table.insert(windowIndices, window.index) end
        assert(activeCount <= 4, "Contact bake cannot solve more than four simultaneous effectors.")
        table.sort(windowIndices)
        table.insert(samples, { time = time, windowIndices = windowIndices })
    end
    return { windows = windows, samples = samples, sampleRateHz = sampleRateHz, maximumSamples = maximumSamples }
end

function IKContact.solveBake(plan, windowByIndex, callbacks)
    assert(type(plan) == "table" and type(plan.windows) == "table" and #plan.windows > 0 and type(plan.samples) == "table" and #plan.samples > 0,
        "Contact-bake solve needs a non-empty validated schedule.")
    assert(type(windowByIndex) == "table" and type(callbacks) == "table" and type(callbacks.preparePose) == "function"
        and type(callbacks.captureAnchor) == "function" and type(callbacks.solve) == "function", "Contact-bake solve callbacks are incomplete.")
    for _, window in plan.windows do
        assert(windowByIndex[window.index] == window, "Contact-bake window map does not match its validated schedule.")
        window.fixedGoal, window.samples = nil, {}
    end
    for _, sample in plan.samples do
        callbacks.preparePose(sample.time)
        local active = {}
        for _, index in sample.windowIndices do
            local window = windowByIndex[index]
            assert(window, "Contact-bake sample references an unknown window.")
            if not window.fixedGoal then
                assert(near(sample.time, window.start), "Contact-bake schedule skipped the start of a support window.")
                window.fixedGoal = callbacks.captureAnchor(window, sample.time)
                assert(window.fixedGoal ~= nil, "Contact-bake anchor callback returned no target.")
            end
            table.insert(active, window)
        end
        if #active > 0 then
            local residualByIndex = callbacks.solve(active, sample.time)
            assert(type(residualByIndex) == "table", "Contact-bake solve callback must return residuals keyed by contact index.")
            for _, window in active do
                local residual = residualByIndex[window.index]
                assert(type(residual) == "number" and residual == residual and residual >= 0 and math.abs(residual) < math.huge,
                    window.effector .. " contact IK did not return a finite residual.")
                table.insert(window.samples, { time = sample.time, residual = residual })
            end
        end
    end
    for _, window in plan.windows do assert(#window.samples > 0, "A selected contact window received no IK samples.") end
    return plan.windows
end

function IKContact.preflight(chainNames, editableTracks, allTracks, times, duration, maximumTrackKeys, maximumTotalKeys)
    maximumTrackKeys, maximumTotalKeys = maximumTrackKeys or 128, maximumTotalKeys or 4096
    local editableByName = {}
    for _, track in editableTracks do editableByName[track.joint] = track end
    local totalKeys = 0
    for _, track in allTracks do totalKeys += #track.keys end
    local seen = {}
    local planned = {}
    for _, joint in chainNames do
        assert(not seen[joint], "IK chain contains duplicate joint " .. tostring(joint) .. ".")
        seen[joint] = true
        local track = editableByName[joint]
        local knownTimes = {}
        local projectedCount = 2
        if track then
            projectedCount = #track.keys
            totalKeys -= #track.keys
            for _, key in track.keys do table.insert(knownTimes, key.time) end
        else
            knownTimes = { 0, duration }
        end
        for _, time in times do
            local exists = false
            for _, knownTime in knownTimes do if near(knownTime, time) then exists = true; break end end
            if not exists then projectedCount += 1; table.insert(knownTimes, time) end
        end
        assert(projectedCount <= maximumTrackKeys, joint .. " would exceed the " .. tostring(maximumTrackKeys) .. "-key track limit during IK contact solving.")
        totalKeys += projectedCount
        table.insert(planned, { joint = joint, projectedKeys = projectedCount, isNewTrack = track == nil })
    end
    assert(totalKeys <= maximumTotalKeys, "IK contact solving would exceed the " .. tostring(maximumTotalKeys) .. "-key animation limit.")
    return { totalKeys = totalKeys, tracks = planned }
end

function IKContact.preflightSchedule(jointTimes, editableTracks, allTracks, duration, maximumTrackKeys, maximumTotalKeys)
    maximumTrackKeys, maximumTotalKeys = maximumTrackKeys or 128, maximumTotalKeys or 4096
    assert(type(jointTimes) == "table", "Contact-bake joint schedule must be a table.")
    local editableByName = {}
    for _, track in editableTracks do editableByName[track.joint] = track end
    local totalKeys = 0
    for _, track in allTracks do totalKeys += #track.keys end
    local names, planned = {}, {}
    for joint in jointTimes do table.insert(names, joint) end
    table.sort(names)
    for _, joint in names do
        local times = jointTimes[joint]
        assert(type(joint) == "string" and #joint > 0 and type(times) == "table" and #times > 0, "Every scheduled IK joint needs a non-empty sample-time list.")
        local track = editableByName[joint]
        local known = {}
        local projectedCount = track and #track.keys or 2
        if track then
            totalKeys -= #track.keys
            for _, key in track.keys do table.insert(known, key.time) end
        else
            known = { 0, duration }
        end
        for _, time in times do
            assert(type(time) == "number" and time == time and time >= 0 and time <= duration and math.abs(time) < math.huge, "Contact-bake sample times must be finite and within the animation.")
            local exists = false
            for _, knownTime in known do if near(knownTime, time) then exists = true; break end end
            if not exists then projectedCount += 1; table.insert(known, time) end
        end
        assert(projectedCount <= maximumTrackKeys, joint .. " would exceed the " .. tostring(maximumTrackKeys) .. "-key track limit during contact baking.")
        totalKeys += projectedCount
        table.insert(planned, { joint = joint, projectedKeys = projectedCount, isNewTrack = track == nil })
    end
    assert(totalKeys <= maximumTotalKeys, "Contact baking would exceed the " .. tostring(maximumTotalKeys) .. "-key animation limit.")
    return { totalKeys = totalKeys, tracks = planned }
end

return IKContact
