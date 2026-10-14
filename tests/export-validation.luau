-- Focused harness for the Studio-side non-mutating batch exporter.
local ExportValidation = (function()
-- INSERT_EXPORT_VALIDATION_HERE
end)()

local model = { id = "target-rig" }
local active = model
local topology = "topology-v1"
local destroyed = 0
local created = 0
local Rig = {
    active = function() return active end,
    id = function(value) return value.id end,
    signature = function() return topology end,
}
local function sequence(raiseDuringCount, poseNames)
    return {
        Parent = nil,
        GetKeyframes = function()
            if raiseDuringCount then error("fixture conversion-count error") end
            return { { Time = 0.5, GetMarkers = function() return { "marker" } end,
                GetDescendants = function()
                    local descendants = {}
                    for _, name in poseNames or { "LeftArm", "Root" } do
                        table.insert(descendants, { Name = name, IsA = function(_, className) return className == "Pose" end })
                    end
                    return descendants
                end } }
        end,
        Destroy = function(self) assert(self.Parent == nil, "temporary sequence must never be parented"); destroyed += 1 end,
    }
end
local Authoring = { sequence = function(_, recipeValue)
    created += 1
    return sequence(recipeValue.failDuringCount)
end }
local recipe = { tracks = { { joint = "Arm" }, { joint = "OtherArm" } }, layers = {}, rootMotion = { joint = "Root" } }
local candidates = {
    { assetId = "a", assetFingerprint = string.rep("a", 64), recipe = recipe },
    { assetId = "b", assetFingerprint = string.rep("b", 64), recipe = { tracks = {}, layers = {}, failDuringCount = true } },
    { assetId = "c", assetFingerprint = string.rep("c", 64), recipe = recipe },
}
local result = ExportValidation.batch(model, { rigId = model.id, rigSignature = topology, jointMap = { Arm = "LeftArm", OtherArm = "LeftArm" }, candidates = candidates }, Rig, Authoring)
assert(result.saved == false and #result.candidates == 3)
assert(result.candidates[1].status == "valid" and result.candidates[1].frameCount == 1 and result.candidates[1].poseCount == 2 and result.candidates[1].markerCount == 1)
assert(result.candidates[1].animatedTrackCount == 2, "joint mapping should deduplicate the two source tracks")
assert(result.candidates[1].mappedTargetJoints[1] == "LeftArm" and result.candidates[1].mappedTargetJoints[2] == "Root",
    "preflight should return sorted, deduplicated mapped target names, including root motion")
local measuredOk, measuredError = pcall(function()
    ExportValidation.measure(sequence(false, { "LeftArm" }), recipe, { Arm = "LeftArm", OtherArm = "LeftArm" })
end)
assert(not measuredOk and string.find(tostring(measuredError), "Root", 1, true),
    "preflight must reject a mapped target that is missing from the converted KeyframeSequence pose tree")
assert(result.candidates[2].status == "invalid" and string.find(result.candidates[2].error, "fixture conversion-count error", 1, true))
assert(result.candidates[3].status == "valid", "a failed clip must not hide later conversion results")
assert(created == 3 and destroyed == 3, "every temporary sequence must be destroyed, including after a count failure")

local changedRig = { id = "changed-rig" }
local processed = 0
local ChangingAuthoring = { sequence = function()
    processed += 1
    active = changedRig
    return sequence(false)
end }
active = model
local ok, err = pcall(function()
    ExportValidation.batch(model, { rigId = model.id, rigSignature = topology, jointMap = {}, candidates = candidates }, Rig, ChangingAuthoring)
end)
assert(not ok and string.find(tostring(err), "active rig changed", 1, true), "rig changes must abort the whole remaining batch")
assert(processed == 1, "no later clip should be converted after the selected rig changes")
print("Studio export batch isolates per-clip conversion errors, cleans temporary sequences, and aborts on rig changes")
