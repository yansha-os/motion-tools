local CurveAnimationAuthoring = {}
local MAX_JOINT_SAMPLES_PER_CLIP = 65536

local function findPose(frame, name)
    local found
    local function visit(pose)
        if pose.Name == name then
            assert(not found, "Generated KeyframeSequence contains duplicate pose name " .. name .. ".")
            found = pose
        end
        for _, child in pose:GetSubPoses() do visit(child) end
    end
    for _, pose in frame:GetPoses() do visit(pose) end
    return found
end

function CurveAnimationAuthoring.fromKeyframeSequence(sequence, nodes)
    assert(sequence:IsA("KeyframeSequence"), "Bone calibration requires a generated KeyframeSequence source.")
    local frames = sequence:GetKeyframes()
    assert(#frames > 0, "Generated KeyframeSequence has no samples for CurveAnimation conversion.")
    local boneNodes = {}
    for _, node in nodes do
        if node.target and node.target:IsA("Bone") then table.insert(boneNodes, node) end
    end
    assert(#boneNodes > 0, "CurveAnimation conversion requires at least one Bone joint.")
    assert(#frames * #boneNodes <= MAX_JOINT_SAMPLES_PER_CLIP,
        string.format("Bone native blend calibration needs %d joint samples; the per-clip limit is %d. Reduce animation complexity and retry.",
            #frames * #boneNodes, MAX_JOINT_SAMPLES_PER_CLIP))

    local clip = Instance.new("CurveAnimation")
    local ok, result = pcall(function()
        clip.Name = sequence.Name
        clip.Loop = sequence.Loop
        clip.Priority = sequence.Priority

        local folderByNode = {}
        for _, node in boneNodes do
            local folder = Instance.new("Folder")
            folder.Name = node.name
            folder.Parent = node.parent and folderByNode[node.parent] or clip
            folderByNode[node] = folder

            local position = Instance.new("Vector3Curve")
            position.Name = "Position"
            position.Parent = folder
            local x, y, z = position:X(), position:Y(), position:Z()

            local rotation = Instance.new("RotationCurve")
            rotation.Name = "Rotation"
            rotation.Parent = folder

            for _, frame in frames do
                local pose = findPose(frame, node.name)
                assert(pose, "Generated sequence omitted Bone pose " .. node.name .. ".")
                local positionValue = pose.CFrame.Position
                local time = frame.Time
                x:InsertKey(FloatCurveKey.new(time, positionValue.X, Enum.KeyInterpolationMode.Linear))
                y:InsertKey(FloatCurveKey.new(time, positionValue.Y, Enum.KeyInterpolationMode.Linear))
                z:InsertKey(FloatCurveKey.new(time, positionValue.Z, Enum.KeyInterpolationMode.Linear))
                rotation:InsertKey(RotationCurveKey.new(time, pose.CFrame, Enum.KeyInterpolationMode.Linear))
            end
        end
        return clip
    end)
    if not ok then
        pcall(function() clip:Destroy() end)
        error(result)
    end
    return result
end

return CurveAnimationAuthoring
