local IKContact = (function()
-- INSERT_IK_CONTACT_HERE
end)()

local scheduled = IKContact.schedule(0.2, 0.8, 15, {
    { joint = "LeftFoot", keys = { { time = 0.43 }, { time = 0.8 } } },
})
assert(#scheduled >= 10 and #scheduled <= 128, "Contact schedule should remain within its sample bounds")
assert(table.find(scheduled, 0.43), "Authored key times should join the uniform sample schedule")
assert(scheduled[1] == 0.2 and scheduled[#scheduled] == 0.8)
for index = 2, #scheduled do assert(scheduled[index] > scheduled[index - 1], "Sample times must be strictly increasing") end

local movingTarget = {
    { time = 0.2, position = { 0, 0, 0 } },
    { time = 0.5, position = { 3, 1, -2 } },
    { time = 0.8, position = { 6, 0, 4 } },
}
local atStart = IKContact.targetAt(movingTarget, 0.2)
local between = IKContact.targetAt(movingTarget, 0.35)
local atEnd = IKContact.targetAt(movingTarget, 0.8)
assert(atStart[1] == 0 and atStart[2] == 0 and atStart[3] == 0)
assert(math.abs(between[1] - 1.5) < 1e-9 and math.abs(between[2] - 0.5) < 1e-9 and math.abs(between[3] + 1) < 1e-9)
assert(atEnd[1] == 6 and atEnd[2] == 0 and atEnd[3] == 4)
assert(not pcall(IKContact.targetAt, movingTarget, 0.1), "Target path must cover every requested sample")
assert(not pcall(IKContact.targetAt, { movingTarget[1], movingTarget[1] }, 0.2), "Target path times must be strictly increasing")
assert(not pcall(IKContact.targetAt, movingTarget, math.huge), "Infinite query times must be rejected")
assert(not pcall(IKContact.targetAt, { { time = math.huge, position = { 0, 0, 0 } }, { time = math.huge, position = { 1, 0, 0 } } }, 0), "Infinite path times must be rejected")
local curvedPath = {
    { time = 0, position = { 0, 0, 0 } },
    { time = 1, position = { 1, 1, 0 } },
    { time = 2, position = { 2, 3, 0 } },
    { time = 3, position = { 3, 0, 0 } },
}
local linearMidpoint = IKContact.targetAt(curvedPath, 1.5)
local smoothStart = IKContact.targetAt(curvedPath, 1, "centripetal_catmull_rom")
local smoothMidpoint = IKContact.targetAt(curvedPath, 1.5, "centripetal_catmull_rom")
local smoothEnd = IKContact.targetAt(curvedPath, 2, "centripetal_catmull_rom")
assert(smoothStart[1] == 1 and smoothStart[2] == 1 and smoothEnd[1] == 2 and smoothEnd[2] == 3, "Centripetal interpolation must preserve authored waypoint positions")
assert(math.abs(linearMidpoint[2] - 2) < 1e-9 and math.abs(smoothMidpoint[2] - linearMidpoint[2]) > 0.01, "Centripetal interpolation should shape the path between sparse authored waypoints")
assert(not pcall(IKContact.targetAt, movingTarget, 0.35, "unknown"), "Unsupported target interpolation must fail closed")
local orientationPath = {
    { time = 0.2, orientationDegrees = { 0, 350, 0 } },
    { time = 0.5, orientationDegrees = { 0, 10, 0 } },
    { time = 0.8, orientationDegrees = { 0, 90, 0 } },
}
local function fixtureRotationFrame(degrees)
    return {
        degrees = table.clone(degrees),
        Lerp = function(self, goal, alpha)
            return { Rotation = { start = self.degrees, finish = goal.degrees, alpha = alpha, shortestArc = true } }
        end,
    }
end
local orientationStart = IKContact.orientationAt(orientationPath, 0.2, fixtureRotationFrame)
local orientationBetween = IKContact.orientationAt(orientationPath, 0.35, fixtureRotationFrame)
local orientationEnd = IKContact.orientationAt(orientationPath, 0.8, fixtureRotationFrame)
assert(orientationStart.alpha == 0 and orientationStart.shortestArc and orientationStart.finish[2] == 10,
    "Orientation interpolation must preserve exact authored endpoints and delegate shortest-arc rotation to CFrame:Lerp")
assert(math.abs(orientationBetween.alpha - 0.5) < 1e-9 and orientationBetween.start[2] == 350 and orientationBetween.finish[2] == 10,
    "Orientation interpolation must use the exact linear time fraction between waypoints without Euler-component blending")
assert(orientationEnd.alpha == 1 and orientationEnd.finish[2] == 90, "Orientation paths must preserve the exact terminal waypoint")
assert(not pcall(IKContact.orientationAt, orientationPath, 0.1, fixtureRotationFrame), "Orientation paths must cover every requested sample")
assert(not pcall(IKContact.orientationAt, { orientationPath[1], orientationPath[1] }, 0.2, fixtureRotationFrame), "Orientation path times must be strictly increasing")
assert(not pcall(IKContact.orientationAt, { orientationPath[1], { time = 0.8, orientationDegrees = { 0, 361, 0 } } }, 0.8, fixtureRotationFrame),
    "Orientation paths must reject angles beyond the bounded XYZ degree range")
assert(not pcall(IKContact.orientationAt, orientationPath, 0.2, nil), "Orientation interpolation must require the Roblox frame conversion function")
local twoPointSmooth = IKContact.targetAt({ movingTarget[1], movingTarget[3] }, 0.5, "centripetal_catmull_rom")
assert(math.abs(twoPointSmooth[1] - 3) < 1e-9 and math.abs(twoPointSmooth[2]) < 1e-9 and math.abs(twoPointSmooth[3] - 2) < 1e-9, "Two-point paths should remain linear when smooth interpolation is requested")
local repeatedWaypointPath = {
    { time = 0, position = { 0, 0, 0 } },
    { time = 1, position = { 1, 1, 0 } },
    { time = 2, position = { 1, 1, 0 } },
    { time = 3, position = { 2, 0, 0 } },
}
for _, time in { 0.5, 1, 1.5, 2, 2.5 } do
    local point = IKContact.targetAt(repeatedWaypointPath, time, "centripetal_catmull_rom")
    for _, coordinate in point do assert(coordinate == coordinate and math.abs(coordinate) < math.huge, "Repeated waypoints must never create non-finite target coordinates") end
end
local repeatedWaypoint = IKContact.targetAt(repeatedWaypointPath, 1, "centripetal_catmull_rom")
assert(repeatedWaypoint[1] == 1 and repeatedWaypoint[2] == 1 and repeatedWaypoint[3] == 0, "Degenerate smooth segments must preserve exact authored positions")

local converged = IKContact.classifyResiduals({ { time = 0, residual = 0.01 }, { time = 0.1, residual = 0.05 } }, 0.05)
assert(converged.status == "converged" and converged.samplesWithinTolerance == 2 and converged.unmetSampleTimes[1] == nil)
local partial = IKContact.classifyResiduals({ { time = 0, residual = 0.01 }, { time = 0.1, residual = 0.04 }, { time = 0.2, residual = 0.3 } }, 0.05)
assert(partial.status == "partial" and partial.samplesWithinTolerance == 2 and #partial.unmetSampleTimes == 1)
local unmet = IKContact.classifyResiduals({ { time = 0, residual = 0.2 }, { time = 0.1, residual = 0.3 }, { time = 0.2, residual = 0.4 } }, 0.05)
assert(unmet.status == "unmet" and unmet.withinToleranceRatio == 0 and math.abs(unmet.maximumResidualStuds - 0.4) < 1e-9)
assert(not pcall(IKContact.classifyResiduals, {}, 0.05), "Empty residual series must fail closed")

local poleReport = IKContact.summarizePoleErrors({ { time = 0, errorDegrees = 10 }, { time = 0.5, errorDegrees = 30 }, { time = 1, unavailableReason = "straight_limb" } })
assert(poleReport.status == "partial" and poleReport.sampleCount == 3 and poleReport.measuredSampleCount == 2)
assert(poleReport.maximumErrorDegrees == 30 and poleReport.maximumErrorTime == 0.5 and math.abs(poleReport.rmsErrorDegrees - math.sqrt(500)) < 1e-9)
assert(#poleReport.unmeasuredTimes == 1 and poleReport.unmeasuredTimes[1] == 1)
local noPolePlane = IKContact.summarizePoleErrors({ { time = 0, unavailableReason = "rig_has_no_two_segment_chain" } })
assert(noPolePlane.status == "unavailable" and noPolePlane.measuredSampleCount == 0 and noPolePlane.rmsErrorDegrees == 0)
assert(not pcall(IKContact.summarizePoleErrors, { { time = 0, errorDegrees = 181 } }), "Pole angular errors above 180 degrees must fail closed")
assert(not pcall(IKContact.summarizePoleErrors, { { time = 1, errorDegrees = 10 }, { time = 1, errorDegrees = 20 } }), "Pole measurements must be strictly time ordered")

local coordinatedJoints, coordinatedSharedJoints = IKContact.planConstraints({
    { limb = "LeftHand", chainNames = { "LeftHand", "LeftUpperArm" } },
    { limb = "RightFoot", chainNames = { "RightFoot", "RightUpperLeg" } },
})
assert(#coordinatedJoints == 4 and coordinatedJoints[1] == "LeftHand" and coordinatedJoints[4] == "RightUpperLeg")
local singleLimbJoints, singleLimbSharedJoints = IKContact.planConstraints({
    { limb = "LeftHand", chainNames = { "LeftHand", "LeftUpperArm" } },
})
assert(table.concat(singleLimbJoints, ",") == "LeftHand,LeftUpperArm" and #singleLimbSharedJoints == 0,
    "A single IK effector should use the same deterministic preview/apply planner")
local singleLimbResiduals, singleLimbSweeps, singleLimbConverged = IKContact.solveAlternating({ { limb = "LeftHand" } }, { {} }, 0.05, 1,
    function() end,
    function() return 0.01 end)
assert(singleLimbConverged and singleLimbSweeps == 1 and singleLimbResiduals[1] == 0.01,
    "A single IK goal should converge and report its measured residual")
assert(not pcall(IKContact.planConstraints, {}), "IK planning must reject an empty effector set")
local reorderedJoints, reorderedSharedJoints = IKContact.planConstraints({
    { limb = "RightFoot", chainNames = { "RightFoot", "RightUpperLeg" } },
    { limb = "LeftHand", chainNames = { "LeftHand", "LeftUpperArm" } },
})
assert(table.concat(coordinatedJoints, ",") == table.concat(reorderedJoints, ","), "Constraint planning must be deterministic regardless of request order")
assert(#coordinatedSharedJoints == 0 and #reorderedSharedJoints == 0)
assert(not pcall(IKContact.planConstraints, { { limb = "LeftHand", chainNames = { "LeftHand" } }, { limb = "LeftHand", chainNames = { "LeftArm" } } }), "A limb cannot be targeted twice")
local sharedChainJoints, sharedChainNames = IKContact.planConstraints({
    { limb = "LeftFoot", chainNames = { "LeftFoot", "LeftUpperLeg", "HumanoidRootPart" } },
    { limb = "RightFoot", chainNames = { "RightFoot", "RightUpperLeg", "HumanoidRootPart" } },
})
assert(table.concat(sharedChainJoints, ",") == "LeftFoot,LeftUpperLeg,HumanoidRootPart,RightFoot,RightUpperLeg")
assert(#sharedChainNames == 1 and sharedChainNames[1] == "HumanoidRootPart", "Shared ancestors must be identified for alternating solves")
assert(not pcall(IKContact.planConstraints, { { limb = "LeftHand", chainNames = { "LeftHand", "Shoulder", "Shoulder" } }, { limb = "RightFoot", chainNames = { "RightFoot" } } }), "A chain cannot repeat a joint internally")
local coupledResiduals = { LeftFoot = 1, RightFoot = 1 }
local finalCoupledResiduals, coupledSweeps, coupledConverged = IKContact.solveAlternating({ { limb = "LeftFoot" }, { limb = "RightFoot" } }, { {}, {} }, 0.05, 6,
    function(constraint)
        if constraint.limb == "LeftFoot" then coupledResiduals.LeftFoot = coupledResiduals.RightFoot * 0.4
        else coupledResiduals.RightFoot = coupledResiduals.LeftFoot * 0.4 end
    end,
    function(constraint) return coupledResiduals[constraint.limb] end)
assert(coupledConverged and coupledSweeps == 3 and finalCoupledResiduals[1] <= 0.05 and finalCoupledResiduals[2] <= 0.05,
    "Alternating CCD orchestration must remeasure all effectors after each shared-joint sweep")
assert(not pcall(IKContact.solveAlternating, { { limb = "LeftFoot" }, { limb = "RightFoot" } }, { {}, {} }, 0.05, 0,
    function() end, function() return 0 end), "Invalid coordinated solve budgets must fail closed")

local plan = IKContact.preflight({ "LeftLowerLeg", "LeftFoot" }, {
    { joint = "LeftFoot", keys = { { time = 0 }, { time = 1 } } },
}, {
    { joint = "LeftFoot", keys = { { time = 0 }, { time = 1 } } },
}, { 0, 0.5, 1 }, 1)
assert(plan.totalKeys == 6, "Preflight should account for inserted keys and a new chain track")
assert(plan.tracks[1].isNewTrack and plan.tracks[1].projectedKeys == 3)
assert(not plan.tracks[2].isNewTrack and plan.tracks[2].projectedKeys == 3)

local bakePlan = IKContact.planBake({
    { effector = "LeftFoot", kind = "support", start = 0.1, ["end"] = 0.8 },
    { effector = "RightFoot", kind = "support", start = 0.8, ["end"] = 1.6 },
    { effector = "LeftFoot", kind = "support", start = 1.2, ["end"] = 1.9 },
}, { "LeftFoot", "RightFoot" }, 2, 15, {
    { joint = "LeftFoot", keys = { { time = 0 }, { time = 0.4 }, { time = 2 } } },
})
assert(#bakePlan.windows == 3 and bakePlan.windows[1].index == 0 and bakePlan.windows[3].index == 2)
local authoredTimeFound, overlapFound, abuttingBoundaryFound = false, false, false
for _, sample in bakePlan.samples do
    if math.abs(sample.time - 0.4) < 1e-6 and sample.windowIndices[1] == 0 then authoredTimeFound = true end
    if #sample.windowIndices == 2 and sample.windowIndices[1] == 1 and sample.windowIndices[2] == 2 then overlapFound = true end
    if math.abs(sample.time - 0.8) < 1e-6 and #sample.windowIndices == 2 and sample.windowIndices[1] == 0 and sample.windowIndices[2] == 1 then abuttingBoundaryFound = true end
end
assert(authoredTimeFound and overlapFound and abuttingBoundaryFound, "Bake schedules should retain authored keys, coordinate overlaps, and preserve abutting contact continuity")
local bakeWindowsByIndex, preparedTimes, solveGroups = {}, {}, {}
for _, window in bakePlan.windows do bakeWindowsByIndex[window.index] = window end
IKContact.solveBake(bakePlan, bakeWindowsByIndex, {
    preparePose = function(time) table.insert(preparedTimes, time) end,
    captureAnchor = function(window, time)
        assert(math.abs(preparedTimes[#preparedTimes] - time) < 1e-6, "Each contact anchor must be captured from its exact composed start pose")
        return { contactIndex = window.index, anchoredAt = time }
    end,
    solve = function(active, time)
        local indices, residuals = {}, {}
        for _, window in active do
            assert(window.fixedGoal and math.abs(window.fixedGoal.anchoredAt - window.start) < 1e-6, "Every active window must retain its own start anchor")
            table.insert(indices, window.index)
            residuals[window.index] = 0.01
        end
        table.insert(solveGroups, { time = time, indices = indices })
        return residuals
    end,
})
assert(#preparedTimes == #bakePlan.samples and #solveGroups > 0)
local overlapSolveFound, secondLeftAnchorFound = false, false
for _, group in solveGroups do
    if #group.indices == 2 and group.indices[1] == 1 and group.indices[2] == 2 then overlapSolveFound = true end
end
for _, window in bakePlan.windows do
    if window.index == 2 and window.fixedGoal and math.abs(window.fixedGoal.anchoredAt - 1.2) < 1e-6 then secondLeftAnchorFound = true end
    assert(#window.samples > 1, "Every selected contact must return sampled residual evidence")
end
assert(overlapSolveFound and secondLeftAnchorFound, "Alternating contacts must be anchored separately and solved as one group while overlapping")
local preciseBake = IKContact.planBake({
    { effector = "LeftFoot", kind = "support", start = 0.2, ["end"] = 1 },
    { effector = "LeftFoot", kind = "support", start = 1.00005, ["end"] = 1.8 },
}, { "LeftFoot" }, 2, 15, {
    { joint = "LeftFoot", keys = { { time = 0.5 }, { time = 0.50005 } } },
})
local preciseTimes = {}
for _, sample in preciseBake.samples do preciseTimes[sample.time] = sample.windowIndices end
assert(preciseTimes[0.5] and preciseTimes[0.50005], "Distinct nearby authored keys must survive the Studio contact schedule")
assert(#preciseTimes[0.5] == 1 and preciseTimes[0.5][1] == 0)
assert(preciseTimes[1] and #preciseTimes[1] == 1 and preciseTimes[1][1] == 0, "The outgoing contact must not activate the next contact early")
assert(preciseTimes[1.00005] and #preciseTimes[1.00005] == 1 and preciseTimes[1.00005][1] == 1)
for index = 2, #preciseBake.samples do assert(preciseBake.samples[index].time > preciseBake.samples[index - 1].time) end
local denseAuthoredKeys = {}
for index = 0, 129 do table.insert(denseAuthoredKeys, { time = 0.4 + index * 0.000001 }) end
assert(not pcall(IKContact.planBake, {
    { effector = "RightFoot", kind = "support", start = 0.2, ["end"] = 1.8 },
}, { "RightFoot" }, 2, 15, { { joint = "RightFoot", keys = denseAuthoredKeys } }, 128),
    "The Studio scheduler must reject a budget overflow rather than discard close authored keys")
assert(not pcall(IKContact.planBake, {
    { effector = "LeftFoot", kind = "support", start = 0.1, ["end"] = 0.9 },
    { effector = "LeftFoot", kind = "support", start = 0.8, ["end"] = 1.2 },
}, { "LeftFoot" }, 2, 15, {}), "Overlapping contacts for one effector must fail before solving")
assert(not pcall(IKContact.planBake, {
    { effector = "LeftFoot", kind = "support", start = 0.1, ["end"] = 0.8 },
}, { "RightFoot" }, 2, 15, {}), "Every selected effector must have a declared contact")

local schedulePreflight = IKContact.preflightSchedule({ LeftFoot = { 0.25, 0.5, 0.75 }, LeftLowerLeg = { 0.25, 0.5, 0.75 } }, {
    { joint = "LeftFoot", keys = { { time = 0 }, { time = 1 } } },
}, {
    { joint = "LeftFoot", keys = { { time = 0 }, { time = 1 } } },
}, 1)
assert(schedulePreflight.totalKeys == 10 and schedulePreflight.tracks[1].joint == "LeftFoot" and schedulePreflight.tracks[1].projectedKeys == 5)
assert(not pcall(IKContact.preflightSchedule, { LeftFoot = { 0.5 } }, {
    { joint = "LeftFoot", keys = (function() local keys = {}; for index = 0, 127 do table.insert(keys, { time = index / 127 }) end; return keys end)() },
}, {}, 1), "Bake schedule preflight must reject per-track key overflow")

assert(not pcall(IKContact.schedule, 0, 20, 15, {}, 128), "Oversized contact schedules must fail before editing")
assert(not pcall(IKContact.schedule, 1, 1, 30, {}), "Empty contact ranges must fail")
assert(not pcall(IKContact.preflight, { "LeftFoot" }, {
    { joint = "LeftFoot", keys = (function() local keys = {}; for index = 0, 127 do table.insert(keys, { time = index / 127 }) end; return keys end)() },
}, {}, { 0, 0.5, 1 }, 1), "Per-track key overflow must fail closed")
assert(not pcall(IKContact.preflight, { "LeftFoot", "LeftFoot" }, {}, {}, { 0, 1 }, 1), "Duplicate IK chain joints must fail closed")
print("IK contact schedule includes authored poses, stays bounded, and preflights track/clip key budgets")
