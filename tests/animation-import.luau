-- INSERT_ANIMATION_IMPORT_HERE

CFrame = { identity = { Lerp = function(_, target) return target end } }

local function frame(x, y, z, rx, ry, rz)
    return { Position = { X = x or 0, Y = y or 0, Z = z or 0 },
        ToEulerAnglesXYZ = function() return rx or 0, ry or 0, rz or 0 end }
end
local function instance(className, name, children)
    local value = { ClassName = className, Name = name or className, children = children or {} }
    for _, child in value.children do child.Parent = value end
    function value:IsA(expected) return self.ClassName == expected end
    function value:GetChildren() return self.children end
    function value:GetDescendants()
        local descendants = {}
        local function visit(parent)
            for _, child in parent.children do table.insert(descendants, child); visit(child) end
        end
        visit(self)
        return descendants
    end
    function value:GetFullName()
        local names, current = {}, self
        while current do table.insert(names, 1, current.Name); current = current.Parent end
        return table.concat(names, ".")
    end
    return value
end
local function pose(name, cframe, style, direction, children)
    local value = instance("Pose", name, children)
    value.CFrame, value.Weight = cframe, 1
    value.EasingStyle, value.EasingDirection = { Name = style or "Linear" }, { Name = direction or "Out" }
    function value:GetSubPoses() return self.children end
    return value
end
local function childNamed(parent, name)
    for _, child in parent:GetChildren() do if child.Name == name then return child end end
end
local function findChild(self, name)
    return childNamed(self, name)
end
local function attachFindChild(value)
    function value:FindFirstChild(name) return findChild(self, name) end
    return value
end
local firstPose = pose("UpperTorso", frame(0, 0, 0))
local inactiveDuplicatePose = pose("UpperTorso", frame(100, 100, 100))
inactiveDuplicatePose.Weight = 0
local secondPose = pose("UpperTorso", frame(1, 0, 0, 0, math.rad(90), 0), "Cubic", "InOut")
local marker = { Name = "Footstep", Value = "left" }
local keyframes = {
    { Time = 0, GetPoses = function() return { firstPose, inactiveDuplicatePose } end, GetMarkers = function() return {} end },
    { Time = 1, GetPoses = function() return { secondPose } end, GetMarkers = function() return { marker } end },
}
local legacy = instance("KeyframeSequence", "Legacy Kick")
legacy.Length, legacy.Loop, legacy.Priority = 1, true, { Name = "Action2" }
function legacy:GetKeyframes() return keyframes end
local converted = AnimationImport.convert(legacy, { sampleRate = 30 })
assert(converted.name == "Legacy Kick" and converted.loop and converted.priority == "Action2")
assert(#converted.tracks == 1 and converted.tracks[1].joint == "UpperTorso")
assert(converted.tracks[1].keys[2].position[1] == 1)
assert(math.abs(converted.tracks[1].keys[2].rotation[2] - 90) < 1e-6)
assert(converted.tracks[1].keys[2].easingStyle == "CubicV2" and converted.tracks[1].keys[2].easingDirection == "InOut")
assert(converted.markers[1].name == "Footstep" and converted.markers[1].value == "left" and converted.markers[1].time == 1)
local overridden = AnimationImport.convert(legacy, { name = "Imported Kick", loopOverride = false })
assert(overridden.name == "Imported Kick" and not overridden.loop)

local unsupportedPose = pose("UpperTorso", frame(0, 0, 0, 0, math.rad(30), 0), "Sine", "Mirrored")
local unsupportedClip = instance("KeyframeSequence", "Unsupported Easing")
unsupportedClip.Length, unsupportedClip.Loop, unsupportedClip.Priority = 1, false, { Name = "Action" }
function unsupportedClip:GetKeyframes()
    return { { Time = 0, GetPoses = function() return { unsupportedPose } end, GetMarkers = function() return {} end } }
end
local unsupportedRecipe, unsupportedDiagnostics = AnimationImport.convert(unsupportedClip, { sampleRate = 30 })
assert(unsupportedRecipe.tracks[1].keys[1].easingStyle == "Linear")
assert(unsupportedDiagnostics.fidelity == "approximated" and unsupportedDiagnostics.conversionMode == "keyframe_sequence_pose_tracks")
assert(#unsupportedDiagnostics.warnings == 2 and string.find(unsupportedDiagnostics.warnings[1], "Sine", 1, true)
    and string.find(unsupportedDiagnostics.warnings[2], "Mirrored", 1, true))

local partialPose = pose("UpperTorso", frame(0, 0, 0, 0, math.rad(30), 0))
partialPose.Weight = 0.5
local partialClip = instance("KeyframeSequence", "Partial Weight")
partialClip.Length, partialClip.Loop, partialClip.Priority = 1, false, { Name = "Action" }
function partialClip:GetKeyframes()
    return { { Time = 0, GetPoses = function() return { partialPose } end, GetMarkers = function() return {} end } }
end
local _, partialDiagnostics = AnimationImport.convert(partialClip, { sampleRate = 30 })
assert(#partialDiagnostics.warnings == 1 and string.find(partialDiagnostics.warnings[1], "Partial-weight pose", 1, true))

local collisionClip = instance("KeyframeSequence", "Mapped Collision")
collisionClip.Length, collisionClip.Loop, collisionClip.Priority = 1, false, { Name = "Action" }
local sourceA, sourceB = pose("SourceA", frame()), pose("SourceB", frame())
function collisionClip:GetKeyframes()
    return { { Time = 0, GetPoses = function() return { sourceA, sourceB } end, GetMarkers = function() return {} end } }
end
local saves = attachFindChild(instance("Folder", "AnimSaves", { collisionClip }))
local model = attachFindChild(instance("Model", "Import Rig", { saves }))
local inventory = AnimationImport.listLocal(model)
assert(inventory.totalCount == 1 and inventory.returnedCount == 1 and not inventory.truncated)
assert(inventory.clips[1].sequenceName == "Mapped Collision" and inventory.clips[1].className == "KeyframeSequence")
assert(inventory.clips[1].sequenceLocator == "1")
assert(inventory.clips[1].trackCount == 2 and inventory.clips[1].poseCount == 2 and inventory.clips[1].keyframeCount == 1)
assert(not inventory.clips[1].ambiguousName and inventory.clips[1].nameMatchCount == 1)
local duplicateClip = instance("KeyframeSequence", "Mapped Collision")
duplicateClip.Length, duplicateClip.Loop, duplicateClip.Priority = 1, false, { Name = "Action" }
local selectedPose = pose("Target", frame(0, 0, 0))
function duplicateClip:GetKeyframes() return { { Time = 0, GetPoses = function() return { selectedPose } end, GetMarkers = function() return {} end } } end
table.insert(saves.children, duplicateClip)
duplicateClip.Parent = saves
local duplicateInventory = AnimationImport.listLocal(model)
assert(duplicateInventory.totalCount == 2 and duplicateInventory.clips[1].ambiguousName and duplicateInventory.clips[2].ambiguousName)
assert(duplicateInventory.clips[1].sequenceLocator == "1" and duplicateInventory.clips[2].sequenceLocator == "2")
local selected, selectedUnmapped = AnimationImport.load({ nodes = function() return {}, { Target = { target = true } } end }, model,
    { sequenceName = "Mapped Collision", sequenceLocator = "2", jointMap = {}, allowPartial = false })
assert(selected.name == "Mapped Collision" and #selected.tracks == 1 and selected.tracks[1].joint == "Target" and #selectedUnmapped == 0,
    "A source locator should load the exact clip even when sibling clips have the same name.")
local ambiguousLoaded, ambiguousError = pcall(function()
    return AnimationImport.load({}, model, { sequenceName = "Mapped Collision", jointMap = {}, allowPartial = true })
end)
assert(not ambiguousLoaded and string.find(tostring(ambiguousError), "Use the exact sequenceLocator", 1, true),
    "Import must never silently choose among duplicate source clip names.")
table.remove(saves.children, 2)
local rig = { nodes = function() return {}, { Target = { target = true } } end }
local loaded, loadError = pcall(function()
    return AnimationImport.load(rig, model, { sequenceName = "Mapped Collision", jointMap = { SourceA = "Target", SourceB = "Target" }, allowPartial = false })
end)
assert(not loaded and string.find(tostring(loadError), "SourceA and SourceB both map to target joint Target", 1, true),
    "Import should reject colliding source-to-target joint maps with an actionable message; received: " .. tostring(loadError))

local function floatCurve(values)
    local curve = instance("FloatCurve")
    function curve:GetKeys() return { { Time = 0 }, { Time = 1 } } end
    function curve:GetValueAtTime(time) return values(time) end
    return curve
end
local xCurve, yCurve, zCurve = floatCurve(function(time) return time end), floatCurve(function() return 0 end), floatCurve(function() return 0 end)
local positionCurve = instance("Vector3Curve", "Position")
function positionCurve:X() return xCurve end
function positionCurve:Y() return yCurve end
function positionCurve:Z() return zCurve end
function positionCurve:GetValueAtTime(time) return xCurve:GetValueAtTime(time), 0, 0 end
local rx, ry, rz = floatCurve(function() return 0 end), floatCurve(function(time) return time * math.rad(45) end), floatCurve(function() return 0 end)
local rotationCurve = instance("EulerRotationCurve", "Rotation")
function rotationCurve:X() return rx end
function rotationCurve:Y() return ry end
function rotationCurve:Z() return rz end
function rotationCurve:GetRotationAtTime(time) return frame(0, 0, 0, 0, time * math.rad(45), 0) end
local jointFolder = instance("Folder", "RightArm", { positionCurve, rotationCurve })
local curveClip = instance("CurveAnimation", "Curve Walk", { jointFolder })
curveClip.Length, curveClip.Loop, curveClip.Priority = 1, false, { Name = "Movement" }
function curveClip:GetDescendants() return { jointFolder } end
local curveRecipe, curveDiagnostics = AnimationImport.convert(curveClip, { sampleRate = 15 })
assert(curveDiagnostics.conversionMode == "curve_animation_sampled_linear" and curveDiagnostics.fidelity == "approximated")
assert(#curveDiagnostics.warnings == 1 and string.find(curveDiagnostics.warnings[1], "sampled into linear", 1, true))
assert(curveRecipe.name == "Curve Walk" and not curveRecipe.loop and curveRecipe.priority == "Movement")
assert(#curveRecipe.tracks == 1 and curveRecipe.tracks[1].joint == "RightArm")
assert(#curveRecipe.tracks[1].keys >= 15 and #curveRecipe.tracks[1].keys <= 128)
local final = curveRecipe.tracks[1].keys[#curveRecipe.tracks[1].keys]
assert(math.abs(final.position[1] - 1) < 1e-6 and math.abs(final.rotation[2] - 45) < 1e-6)
curveClip.Length = 5
local boundedCurve, boundedDiagnostics = AnimationImport.convert(curveClip, { sampleRate = 60 })
assert(#boundedCurve.tracks[1].keys == 128)
assert(boundedDiagnostics.curveSampling.requestedInteriorSamples == 300 and boundedDiagnostics.curveSampling.addedInteriorSamples == 125)
assert(#boundedDiagnostics.warnings == 2 and string.find(boundedDiagnostics.warnings[2], "sampling was reduced", 1, true))
print("Animation import converts KeyframeSequence and CurveAnimation clips, easing, loop, priority and markers")
