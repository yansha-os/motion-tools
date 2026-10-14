-- INSERT_KEYFRAME_SELECTION_HERE

local left = {time = 0}
local first = {time = 0.25}
local second = {time = 0.5}
local right = {time = 1}
local track = {keys = {left, first, second, right}}
local selected = {[first] = true, [second] = true}
local originalTimes = {[first] = first.time, [second] = second.time}
assert(not KeyframeSelection.toggleSelection(selected, first) and not selected[first], "Shift-click must remove an already-selected key")
assert(KeyframeSelection.toggleSelection(selected, first) and selected[first], "Shift-click must add an unselected key")
assert(KeyframeSelection.findKeyIndexAtTime(track.keys, 0.5) == 3 and KeyframeSelection.findKeyIndexAtTime(track.keys, 0.5000005) == 3,
    "exact-time lookup may absorb only the configured floating-point tolerance")
assert(KeyframeSelection.findKeyIndexAtTime(track.keys, 0.50005) == nil and KeyframeSelection.findKeyIndexAtTime(track.keys, 0 / 0) == nil,
    "exact-time lookup must not silently retarget a nearby or non-finite time")
local originalCurve = {outTime = 0.3}
local beginningMetadata = KeyframeSelection.planMirrorInsertion({
    {time = 0.2, easingStyle = "CubicV2", easingDirection = "In", curve = originalCurve},
    {time = 1, easingStyle = "Bounce", easingDirection = "Out"},
}, 1)
assert(beginningMetadata.easingStyle == "CubicV2" and beginningMetadata.easingDirection == "In"
    and beginningMetadata.curve ~= originalCurve,
    "a key inserted before the first target key must inherit valid outgoing metadata instead of indexing a missing previous key")
beginningMetadata.curve.outTime = 0.9
assert(KeyframeSelection.planMirrorInsertion({{time = 0, curve = {outTime = 0.2}}, {time = 1}}, 2).curve.outTime == 0.2,
    "planned mirror metadata must clone the source curve rather than aliasing it")
local endMetadata = KeyframeSelection.planMirrorInsertion({{time = 0, easingStyle = "Linear"}}, 2)
assert(endMetadata.easingStyle == "Linear" and endMetadata.easingDirection == "Out",
    "a key inserted after the last target key must inherit the previous outgoing metadata")
local emptyMirrorPlan, emptyMirrorError = KeyframeSelection.planMirrorInsertion({}, 1)
assert(not emptyMirrorPlan and string.find(emptyMirrorError, "at least one key", 1, true),
    "mirroring into an unsampleable empty track must fail before mutation")
local invalidMirrorPlan, invalidMirrorError = KeyframeSelection.planMirrorInsertion(track.keys, 0)
assert(not invalidMirrorPlan and string.find(invalidMirrorError, "outside", 1, true),
    "mirror insertion must reject invalid indices")
local capturedSelection = KeyframeSelection.captureSelectionIndices({track}, selected)
assert(#capturedSelection == 2 and capturedSelection[1].trackIndex == 1 and capturedSelection[1].keyIndex == 2
    and capturedSelection[2].keyIndex == 3, "undo snapshots must retain stable key indices")
local clonedTrack = {keys = {{time = 0}, {time = 0.25}, {time = 0.5}, {time = 1}}}
local restoredSelection = KeyframeSelection.restoreSelection({clonedTrack}, capturedSelection)
assert(restoredSelection[clonedTrack.keys[2]] and restoredSelection[clonedTrack.keys[3]] and not restoredSelection[first],
    "undo/redo must rebind the selection to cloned recipe keys rather than stale table identities")
local plan, err = KeyframeSelection.planRetiming({track}, selected, originalTimes, 0.6)
assert(plan and not err and plan.delta > 0.2 and plan.clamped, "group retiming must clamp as one unit before crossing the fixed endpoint")
assert(plan.selectedCount == 2 and plan.affectedTrackCount == 1)

local exactPlan = KeyframeSelection.planRetiming({track}, selected, originalTimes, -0.1)
assert(exactPlan and math.abs(exactPlan.delta + 0.1) < 1e-9 and not exactPlan.clamped,
    "group retiming must preserve the requested shared offset when neighbors allow it")

local secondTrackLeft = {time = 0}
local secondTrackKey = {time = 0.1}
local secondTrackRight = {time = 0.2}
local secondTrack = {keys = {secondTrackLeft, secondTrackKey, secondTrackRight}}
selected[secondTrackKey] = true
originalTimes[secondTrackKey] = secondTrackKey.time
local multiTrackPlan = KeyframeSelection.planRetiming({track, secondTrack}, selected, originalTimes, 0.3)
assert(multiTrackPlan and multiTrackPlan.affectedTrackCount == 2 and multiTrackPlan.delta < 0.1,
    "the tightest selected track must clamp all tracks to the same delta")

local endpointSelection = {[left] = true, [first] = true}
local endpointPlan, endpointError = KeyframeSelection.planRetiming({track}, endpointSelection, {[first] = first.time}, 0.1)
assert(not endpointPlan and string.find(endpointError, "endpoints are fixed", 1, true), "endpoint selection must fail closed")

local emptyPlan, emptyError = KeyframeSelection.planRetiming({track}, {}, {}, 0.1)
assert(not emptyPlan and string.find(emptyError, "Select one or more", 1, true))
local nonFinitePlan, nonFiniteError = KeyframeSelection.planRetiming({track}, selected, originalTimes, 0 / 0)
assert(not nonFinitePlan and string.find(nonFiniteError, "finite", 1, true))

print("Keyframe group retiming and mirror insertion preserve timing metadata and reject invalid edits")
