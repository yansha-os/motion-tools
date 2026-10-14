-- INSERT_KEYFRAME_CLIPBOARD_HERE

local function key(time, x, easingStyle)
    return {time = time, position = {x, 0, 0}, rotation = {0, x, 0}, easingStyle = easingStyle or "Linear",
        easingDirection = "Out", curve = {outTime = 0.2, outValue = 0.3, inTime = 0.8, inValue = 0.7}}
end
local left, first, second, right = key(0, 0), key(0.25, 10, "CubicV2"), key(0.5, 20, "Bounce"), key(1, 0)
local arm = {joint = "RightUpperArm", keys = {left, first, second, right}}
local root = {joint = "HumanoidRootPart", keys = {key(0, 0), key(0.25, 1), key(0.5, 2), key(1, 0)}}
local selected = {[first] = true, [second] = true, [root.keys[2]] = true, [root.keys[3]] = true}
local clipboard, copyError = KeyframeSelection.copyKeyframes({arm, root}, selected, 1, 2)
assert(clipboard and not copyError and #clipboard.entries == 4, "copy must capture the selected cross-track group")
assert(clipboard.entries[1].isAnchor and clipboard.entries[1].timeOffset == 0 and clipboard.entries[2].timeOffset == 0.25)
assert(clipboard.entries[3].joint == "HumanoidRootPart" and clipboard.entries[3].timeOffset == 0 and clipboard.entries[4].timeOffset == 0.25)
assert(clipboard.entries[1].key.easingStyle == "CubicV2" and clipboard.entries[2].key.easingStyle == "Bounce")
assert(clipboard.entries[1].key.curve ~= first.curve, "clipboard must deep-copy custom easing handles")

local targetArm = {joint = "RightUpperArm", keys = {key(0, 0), key(0.75, 30), key(1, 0)}}
local targetRoot = {joint = "HumanoidRootPart", keys = {key(0, 0), key(0.75, 3), key(1, 0)}}
local plan, planError = KeyframeSelection.planKeyframePaste({targetArm, targetRoot}, clipboard, 0.25, 1, 128)
assert(plan and not planError and #plan == 4, "valid group paste must plan every key atomically")
assert(plan[1].trackIndex == 1 and plan[1].key.time == 0.25 and plan[1].isAnchor)
assert(plan[2].key.time == 0.5 and plan[3].trackIndex == 2 and plan[3].key.time == 0.25)
assert(targetArm.keys[2].time == 0.75 and #targetArm.keys == 3, "planning must not mutate the destination")
assert(plan[1].key.curve ~= clipboard.entries[1].key.curve, "paste output must not alias clipboard easing tables")

local collisionPlan, collisionError = KeyframeSelection.planKeyframePaste({targetArm, targetRoot}, clipboard, 0.5, 1, 128)
assert(not collisionPlan and string.find(collisionError, "overlap an existing", 1, true), "any destination collision must reject the entire group")
local rangePlan, rangeError = KeyframeSelection.planKeyframePaste({targetArm, targetRoot}, clipboard, 0.8, 1, 128)
assert(not rangePlan and string.find(rangeError, "strictly inside", 1, true), "a group extending past the clip must fail closed")
local missingPlan, missingError = KeyframeSelection.planKeyframePaste({targetArm}, clipboard, 0.25, 1, 128)
assert(not missingPlan and string.find(missingError, "no track for HumanoidRootPart", 1, true), "a missing destination track must not partially paste")
local budgetPlan, budgetError = KeyframeSelection.planKeyframePaste({targetArm, targetRoot}, clipboard, 0.25, 1, 4)
assert(not budgetPlan and string.find(budgetError, "per-track keyframe limit", 1, true), "per-track key budgets must be checked before mutation")
local totalBudgetPlan, totalBudgetError = KeyframeSelection.planKeyframePaste({targetArm, targetRoot}, clipboard, 0.25, 1, 128, 4, 7)
assert(not totalBudgetPlan and string.find(totalBudgetError, "total animation keyframe limit", 1, true), "total recipe key budgets must be checked before mutation")
local invalidLimitPlan, invalidLimitError = KeyframeSelection.planKeyframePaste({targetArm, targetRoot}, clipboard, 0.25, 1, 1)
assert(not invalidLimitPlan and string.find(invalidLimitError, "non-negative integer", 1, true), "invalid key budgets must fail closed")

local singleClipboard = assert(KeyframeSelection.copyKeyframes({arm}, {}, 1, 2))
assert(#singleClipboard.entries == 1 and singleClipboard.entries[1].isAnchor, "copy with no group selection must fall back to the active key")
local emptyPlan = KeyframeSelection.planKeyframePaste({arm}, {entries = {}}, 0.5, 1)
assert(not emptyPlan, "empty clipboard must be rejected")

print("Keyframe group copy/paste preserves offsets/easing and rejects collision, range, topology and budget failures atomically")
