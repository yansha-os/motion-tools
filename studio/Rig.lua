local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local ServerStorage = game:GetService("ServerStorage")
local ids = setmetatable({}, { __mode = "k" })
local objects = {}
local Rig = {}
local activeModel

local function managedFolder()
    local folder = ServerStorage:FindFirstChild("MotionToolsRigs")
    if folder then assert(folder:IsA("Folder"), "ServerStorage.MotionToolsRigs must be a Folder.") end
    if not folder then
        folder = Instance.new("Folder")
        folder.Name = "MotionToolsRigs"
        folder.Parent = ServerStorage
    end
    return folder
end

function Rig.storageFolder()
    return managedFolder()
end

function Rig.isManaged(instance)
    local folder = ServerStorage:FindFirstChild("MotionToolsRigs")
    return folder ~= nil and folder:IsA("Folder") and instance:IsA("Model") and instance:IsDescendantOf(folder)
end

function Rig.setActive(model)
    assert(model and model:IsA("Model"), "Choose a rig model.")
    assert(model:IsDescendantOf(workspace) or Rig.isManaged(model), "Choose a Workspace rig or a rig in MotionToolsRigs.")
    activeModel = model
    Rig.id(model)
end

function Rig.active()
    if activeModel and (activeModel:IsDescendantOf(workspace) or Rig.isManaged(activeModel)) then
        return activeModel
    end
    activeModel = nil
    return nil
end

function Rig.managedRigs()
    local folder = ServerStorage:FindFirstChild("MotionToolsRigs")
    if not folder then return {} end
    local result = {}
    for _, child in folder:GetChildren() do
        if child:IsA("Model") then table.insert(result, child) end
    end
    table.sort(result, function(a, b) return a.Name:lower() < b.Name:lower() end)
    return result
end

function Rig.isPartJoint(item)
    return item:IsA("Motor6D") or item:IsA("AnimationConstraint")
end

function Rig.jointParts(item)
    if item:IsA("Motor6D") then return item.Part0, item.Part1, item.C0, item.C1 end
    if item:IsA("AnimationConstraint") then
        local attachment0, attachment1 = item.Attachment0, item.Attachment1
        if not attachment0 or not attachment1 then return nil, nil, nil, nil end
        local parent, child = attachment0.Parent, attachment1.Parent
        if not parent or not parent:IsA("BasePart") or not child or not child:IsA("BasePart") then return nil, nil, nil, nil end
        return parent, child, attachment0.CFrame, attachment1.CFrame
    end
    return nil, nil, nil, nil
end

-- Anchored previews need to carry rigid accessories explicitly.
function Rig.accessoryBindings(model)
    local bindings, bodyAttachments = {}, {}
    for _, item in model:GetDescendants() do
        if item:IsA("Attachment") and item.Parent:IsA("BasePart") and not item:FindFirstAncestorOfClass("Accessory") then
            bodyAttachments[item.Name] = bodyAttachments[item.Name] or {}
            table.insert(bodyAttachments[item.Name], item.Parent)
        end
    end
    for _, accessory in model:GetDescendants() do
        if accessory:IsA("Accessory") then
            local handle = accessory:FindFirstChild("Handle")
            if handle and handle:IsA("BasePart") then
                local body
                for _, joint in model:GetDescendants() do
                    local a, b
                    if joint:IsA("Weld") or joint:IsA("WeldConstraint") then
                        a, b = joint.Part0, joint.Part1
                    elseif joint:IsA("RigidConstraint") or joint:IsA("AnimationConstraint") then
                        a = joint.Attachment0 and joint.Attachment0.Parent
                        b = joint.Attachment1 and joint.Attachment1.Parent
                    end
                    local candidate = a == handle and b or (b == handle and a)
                    if candidate and candidate:IsA("BasePart") and candidate:IsDescendantOf(model) and not candidate:FindFirstAncestorOfClass("Accessory") then
                        body = candidate
                        break
                    end
                end
                if not body then
                    for _, attachment in handle:GetChildren() do
                        local matches = bodyAttachments[attachment.Name]
                        if attachment:IsA("Attachment") and matches and #matches == 1 then
                            body = matches[1]
                            break
                        end
                    end
                end
                if body then
                    for _, part in accessory:GetDescendants() do
                        if part:IsA("BasePart") then
                            table.insert(bindings, { handle = part, body = body, offset = body.CFrame:ToObjectSpace(part.CFrame) })
                        end
                    end
                end
            end
        end
    end
    return bindings
end

function Rig.id(instance)
    if not ids[instance] then
        local id = HttpService:GenerateGUID(false)
        ids[instance] = id
        objects[id] = instance
        instance.Destroying:Connect(function()
            if objects[id] == instance then objects[id] = nil end
        end)
    end
    return ids[instance]
end

function Rig.resolve(id)
    local model = objects[id]
    assert(model and model:IsA("Model") and (model:IsDescendantOf(workspace) or Rig.isManaged(model)), "Rig is no longer available. Choose it again in Motion Tools.")
    return model
end

function Rig.part(model, name)
    local found
    for _, item in model:GetDescendants() do
        if item:IsA("BasePart") and item.Name == name then
            assert(not found, "Duplicate part name: " .. name)
            found = item
        end
    end
    assert(found, "Part not found: " .. name)
    return found
end

function Rig.nodes(model)
    local joints, bones = {}, {}
    for _, item in model:GetDescendants() do
        if Rig.isPartJoint(item) then table.insert(joints, item) end
        if item:IsA("Bone") then table.insert(bones, item) end
    end
    assert(#joints + #bones <= 256, "Rig exceeds the 256-joint limit.")
    assert(not (#joints > 0 and #bones > 0), "Mixed Motor6D/AnimationConstraint/Bone rigs need a separate selected sub-rig in this version.")
    local nodes, byObject, byName = {}, {}, {}
    local function node(part)
        if byObject[part] then return byObject[part] end
        assert(not byName[part.Name], "Duplicate animated name: " .. part.Name .. ". Give joints/parts unique names.")
        local entry = { name = part.Name, object = part, children = {} }
        byObject[part], byName[part.Name] = entry, entry
        table.insert(nodes, entry)
        return entry
    end
    if #joints > 0 then
        for _, joint in joints do
            local parentPart, childPart = Rig.jointParts(joint)
            assert(parentPart and childPart, "Disconnected Motor6D or AnimationConstraint: " .. joint.Name)
            assert(parentPart:IsDescendantOf(model) and childPart:IsDescendantOf(model), "Joint connects outside the selected rig.")
            local parent, child = node(parentPart), node(childPart)
            assert(not child.target, "Multiple animation joints drive " .. child.name)
            child.target, child.parent = joint, parent
            table.insert(parent.children, child)
        end
    else
        for _, bone in bones do
            local parent = bone.Parent
            assert(parent and (parent:IsA("Bone") or parent:IsA("BasePart")), "Bone needs a Bone or BasePart parent.")
            local parentNode, child = node(parent), node(bone)
            child.target, child.parent = bone, parentNode
            table.insert(parentNode.children, child)
        end
    end
    local roots = {}
    for _, item in nodes do if not item.parent then table.insert(roots, item) end end
    local visited, ordered = {}, {}
    local function visit(item)
        assert(not visited[item], "Rig contains a joint cycle.")
        visited[item] = true
        table.insert(ordered, item)
        for _, child in item.children do visit(child) end
    end
    for _, root in roots do visit(root) end
    local count = 0
    for _ in visited do count += 1 end
    assert(count == #nodes, "Rig contains a disconnected joint cycle.")
    return roots, byName, ordered
end

function Rig.signature(model)
    local humanoid = model:FindFirstChildOfClass("Humanoid")
    local rigType = humanoid and (humanoid.RigType == Enum.HumanoidRigType.R15 and "R15" or "R6") or "custom"
    local _, _, nodes = Rig.nodes(model)
    local edges = {}
    for _, node in nodes do
        if node.target then table.insert(edges, string.format("%s>%s:%s", node.parent and node.parent.name or "", node.name, node.target.ClassName)) end
    end
    table.sort(edges)
    return HttpService:JSONEncode({ rigType, edges })
end

local function rotationQuaternion(frame)
    local axis, angle = frame:ToAxisAngle()
    local sine = math.sin(angle / 2)
    return { axis.X * sine, axis.Y * sine, axis.Z * sine, math.cos(angle / 2) }
end

function Rig.inspect(model)
    local result = { id = Rig.id(model), name = model.Name, parts = {}, joints = {}, issues = {} }
    for _, item in model:GetDescendants() do
        if item:IsA("BasePart") and #result.parts < 256 then
            table.insert(result.parts, { name = item.Name, anchored = item.Anchored })
        elseif (Rig.isPartJoint(item) or item:IsA("Bone")) and #result.joints < 256 then
            table.insert(result.joints, { name = item.Name, kind = item.ClassName })
        end
    end
    local ok, roots, _, nodes = pcall(Rig.nodes, model)
    if ok then
        result.rigSignature = Rig.signature(model)
        local humanoid = model:FindFirstChildOfClass("Humanoid")
        local rigType = humanoid and (humanoid.RigType == Enum.HumanoidRigType.R15 and "R15" or "R6") or "custom"
        result.animatedNames = {}
        local retargetJoints = {}
        local restFrames = {}
        local pivot = model:GetPivot()
        for _, item in nodes do
            local animatedEntry = { name = item.name, parent = item.parent and item.parent.name or "", driven = item.target ~= nil,
                targetKind = item.target and item.target.ClassName or nil,
                captureFocusEligible = item.target ~= nil and Rig.isPartJoint(item.target) and item.object:IsA("BasePart") }
            if item.object:IsA("BasePart") then
                local size = item.object.Size
                animatedEntry.visualGeometry = {
                    source = "BasePart.Size",
                    dimensionsStuds = { size.X, size.Y, size.Z },
                    partClass = item.object.ClassName,
                    transparency = item.object.Transparency,
                    shape = item.object:IsA("Part") and tostring(item.object.Shape) or nil,
                }
            end
            table.insert(result.animatedNames, animatedEntry)
            local restFrame
            if item.target and Rig.isPartJoint(item.target) then
                local parentPart, _, parentOffset = Rig.jointParts(item.target)
                -- The next joint is relative to the actual parent part frame, not
                -- the previous joint's attachment/pivot frame.
                restFrame = parentPart.CFrame * parentOffset
            elseif item.target and item.target:IsA("Bone") then
                local parentFrame = restFrames[item.parent] or item.target.Parent.CFrame
                restFrame = parentFrame * item.target.CFrame
            else
                restFrame = item.object.CFrame
            end
            restFrames[item] = restFrame
            table.insert(retargetJoints, {
                name = item.name,
                parent = item.parent and item.parent.name or "",
                driven = item.target ~= nil,
                targetKind = item.target and item.target.ClassName or nil,
                basis = rotationQuaternion(pivot:ToObjectSpace(restFrame).Rotation),
                segmentLength = item.parent and (item.object.Position - item.parent.object.Position).Magnitude or 0,
            })
        end
        result.retargetProfile = { version = 1, rigId = result.id, rigName = result.name, rigType = rigType, rigSignature = result.rigSignature, joints = retargetJoints }
        if #roots == 0 then table.insert(result.issues, "No animation joints. Use motion_studio_connect_parts or the Blender rigging tool.") end
    else table.insert(result.issues, tostring(roots)) end
    return result
end

function Rig.snapshot()
    local selected, seen = {}, {}
    local active = Rig.active()
    local activeRig
    if active then
        seen[active] = true
        table.insert(selected, { id = Rig.id(active), name = active.Name })
        local ok, signature = pcall(Rig.signature, active)
        activeRig = { id = Rig.id(active), name = active.Name, rigSignature = ok and signature or nil }
    end
    for _, item in Selection:Get() do
        local model = item:IsA("Model") and item or item:FindFirstAncestorOfClass("Model")
        if model and model:IsDescendantOf(workspace) and not seen[model] and #selected < 8 then
            seen[model] = true
            table.insert(selected, { id = Rig.id(model), name = model.Name })
        end
    end
    return { place = game.Name, placeId = tostring(game.PlaceId), selection = selected, activeRig = activeRig,
        pluginVersion = "1.0.0", studioBuildIdentity = Rig.studioBuildIdentity(),
        features = { poseSampling = true, animationLibrary = true, fullBodySnapshots = true, inverseKinematics = true, editorDraft = true },
        operations = { inspectRig = true, sampleAnimation = true, browseLocalAnimations = true, openAnimation = true, saveAnimation = true,
            validateAnimationExport = true, readEditorDraft = true, applyEditorCandidate = true, captureCandidateViews = true,
            captureEditorDraftViews = true, inverseKinematics = true } }
end

local cachedStudioBuildIdentity
function Rig.studioBuildIdentity()
    if cachedStudioBuildIdentity then
        return table.clone(cachedStudioBuildIdentity)
    end
    local ok, value = pcall(function() return version() end)
    if ok and type(value) == "string" and value ~= "" and #value <= 128 then
        cachedStudioBuildIdentity = { status = "captured", value = value, source = "roblox_version_global_deprecated" }
    else
        cachedStudioBuildIdentity = { status = "unavailable", value = nil, source = "unavailable" }
    end
    return table.clone(cachedStudioBuildIdentity)
end

function Rig.connect(model, payload)
    local parent = Rig.part(model, payload.parentPart)
    local child = Rig.part(model, payload.childPart)
    assert(parent ~= child, "A part cannot be its own parent.")
    local upward = {}
    for _, item in model:GetDescendants() do
        if Rig.isPartJoint(item) then
            local parentPart, childPart = Rig.jointParts(item)
            if parentPart and childPart then
                assert(childPart ~= child, "Child already has an animation joint. Inspect or edit the existing joint.")
                upward[childPart] = parentPart
            end
        end
        if (item:IsA("Weld") or item:IsA("WeldConstraint")) and (item.Part0 == child or item.Part1 == child) then
            error("Child has a weld. Remove the conflicting weld before creating its animation joint.")
        end
    end
    local cursor, visited = parent, {}
    while cursor do
        assert(cursor ~= child and not visited[cursor], "Connection would create a joint cycle.")
        visited[cursor] = true
        cursor = upward[cursor]
    end
    local pivot = payload.pivot and Vector3.new(unpack(payload.pivot)) or child.Position
    local joint = Instance.new("Motor6D")
    joint.Name = payload.name
    joint.Part0, joint.Part1 = parent, child
    joint.C0 = parent.CFrame:ToObjectSpace(CFrame.new(pivot))
    joint.C1 = child.CFrame:ToObjectSpace(CFrame.new(pivot))
    joint.Parent = parent
    return { name = joint.Name, childAnchored = child.Anchored, note = "Joint created. Anchoring was preserved; check anchors before gameplay." }
end

return Rig
