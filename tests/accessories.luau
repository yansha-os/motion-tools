local previousVersion = version
version = function() return "fixture-studio-build" end
local capturedBuild = Rig.studioBuildIdentity()
assert(capturedBuild.status == "captured" and capturedBuild.value == "fixture-studio-build"
    and capturedBuild.source == "roblox_version_global_deprecated", "Studio build capture must identify its exact source")
version = function() return "unexpected-second-build-call" end
local stableBuild = Rig.studioBuildIdentity()
assert(stableBuild.status == "captured" and stableBuild.value == "fixture-studio-build",
    "Studio build identity must remain stable across recurring heartbeats")
stableBuild.value = "caller-mutation"
assert(Rig.studioBuildIdentity().value == "fixture-studio-build", "build identity snapshots must not expose cached state to mutation")
version = function() error("version global unavailable") end
assert(Rig.studioBuildIdentity().value == "fixture-studio-build",
    "subsequent heartbeat calls must not re-query the deprecated Studio build global")
version = previousVersion

local function vector(x, y, z) return { X = x, Y = y, Z = z } end
local function object(kind, name, parent)
    local item = {ClassName=kind, Name=name, Parent=parent, children={}}
    if parent then table.insert(parent.children, item) end
    function item:IsA(k)
        if k == self.ClassName then return true end
        return k == "BasePart" and (self.ClassName == "Part" or self.ClassName == "MeshPart" or self.ClassName == "UnionOperation")
    end
    function item:GetChildren() return self.children end
    function item:GetDescendants()
        local result = {}
        for _, child in self.children do
            table.insert(result, child)
            for _, descendant in child:GetDescendants() do table.insert(result, descendant) end
        end
        return result
    end
    function item:FindFirstChild(n)
        for _, child in self.children do if child.Name == n then return child end end
    end
    function item:FindFirstChildOfClass(k)
        for _, child in self.children do if child:IsA(k) then return child end end
    end
    function item:FindFirstAncestorOfClass(k)
        local ancestor = self.Parent
        while ancestor do if ancestor:IsA(k) then return ancestor end; ancestor = ancestor.Parent end
    end
    function item:IsDescendantOf(root)
        local ancestor = self.Parent
        while ancestor do if ancestor == root then return true end; ancestor = ancestor.Parent end
        return false
    end
    item.CFrame = {ToObjectSpace=function(_, other) return other end}
    return item
end
local rigFolder = Rig.storageFolder()
assert(rigFolder:IsA("Folder") and rigFolder.Name == "MotionToolsRigs", "managed animation rigs must use the dedicated storage folder")
assert(rigFolder:IsDescendantOf(fixtureServerStorage), "managed rigs must be kept outside Workspace in ServerStorage")
local isolatedRig = object("Model", "MotionTools_R15", rigFolder)
isolatedRig.Destroying = { Connect = function() end }
assert(Rig.isManaged(isolatedRig), "the Rig Library must recognize rigs in its isolated ServerStorage folder")
Rig.setActive(isolatedRig)
assert(Rig.active() == isolatedRig and Rig.resolve(Rig.id(isolatedRig)) == isolatedRig,
    "isolated library rigs must remain selectable and addressable without Workspace placement")
print("Motion Tools Rig Library stores active rigs in ServerStorage, outside the game viewport")
for _, kind in {"Weld", "WeldConstraint", "RigidConstraint", "AttachmentFallback"} do
    local model = object("Model", "Rig")
    local body = object("BasePart", "Head", model)
    local bodyAttachment = object("Attachment", "HairAttachment", body)
    local accessory = object("Accessory", "Hair", model)
    local handle = object("BasePart", "Handle", accessory)
    local extra = object("BasePart", "Extra", accessory)
    local attachment = object("Attachment", "HairAttachment", handle)
    if kind ~= "AttachmentFallback" then
        -- Joint deliberately lives outside Handle, and endpoints are reversed.
        local joint = object(kind, "Joint", body)
        joint.Part0, joint.Part1 = body, handle
        joint.Attachment0, joint.Attachment1 = bodyAttachment, attachment
    end
    local bindings = Rig.accessoryBindings(model)
    assert(#bindings == 2, kind .. " must carry all accessory parts")
    assert(bindings[1].body == body and bindings[1].handle == handle)
    assert(bindings[2].handle == extra)
    assert(bindings[1].offset == handle.CFrame, "Must preserve rest offset")
    print(kind .. " accessory binding passed")
end

local topology = object("Model", "TopologyFixture")
local torso = object("BasePart", "Torso", topology)
local arm = object("BasePart", "RightArm", topology)
torso.Size, torso.Transparency = vector(2, 2, 1), 0
arm.ClassName, arm.Size, arm.Transparency, arm.Shape = "Part", vector(1, 3, 1), 0.25, "Enum.PartType.Block"
local shoulder = object("Motor6D", "Shoulder", torso)
shoulder.Part0, shoulder.Part1 = torso, arm
local signature = Rig.signature(topology)
assert(signature == Rig.signature(topology), "Rig topology signatures must be stable")
assert(string.find(signature, "Torso>RightArm:Motor6D", 1, true), "Rig signature should encode parent, driven joint name, and joint kind")
arm.Name = "LeftArm"
assert(signature ~= Rig.signature(topology), "Changing rig topology must change the signature")
local function position(x, y, z)
    local value = { X = x, Y = y, Z = z }
    return setmetatable(value, { __sub = function(a, b)
        local dx, dy, dz = a.X - b.X, a.Y - b.Y, a.Z - b.Z
        return { Magnitude = math.sqrt(dx * dx + dy * dy + dz * dz) }
    end })
end
local restCFrame = { Rotation = true }
restCFrame.Rotation = restCFrame
function restCFrame:ToAxisAngle() return { X = 0, Y = 1, Z = 0 }, 0 end
function restCFrame:ToObjectSpace(other) return other end
setmetatable(restCFrame, { __mul = function() return restCFrame end })
topology.GetPivot = function() return restCFrame end
topology.Destroying = { Connect = function() end }
torso.CFrame, arm.CFrame, shoulder.C0 = restCFrame, restCFrame, restCFrame
torso.Position, arm.Position = position(0, 0, 0), position(1, 0, 0)
local inspected = Rig.inspect(topology)
assert(inspected.retargetProfile.version == 1, "Rig inspection should return a versioned retarget profile")
assert(inspected.retargetProfile.rigSignature == inspected.rigSignature)
assert(#inspected.retargetProfile.joints == 2)
assert(inspected.retargetProfile.joints[2].name == "LeftArm" and inspected.retargetProfile.joints[2].driven)
assert(inspected.retargetProfile.joints[2].targetKind == "Motor6D" and inspected.animatedNames[2].targetKind == "Motor6D",
    "Inspection should bind the exact driver class to its hierarchy node")
assert(math.abs(inspected.retargetProfile.joints[2].segmentLength - 1) < 1e-8)
assert(math.abs(inspected.retargetProfile.joints[2].basis[4] - 1) < 1e-8)
local armGeometry = inspected.animatedNames[2].visualGeometry
assert(inspected.animatedNames[2].captureFocusEligible == true, "driven part-backed joints should be advertised as valid visual close-up targets")
assert(armGeometry.source == "BasePart.Size" and armGeometry.partClass == "Part" and armGeometry.shape == "Enum.PartType.Block")
assert(armGeometry.dimensionsStuds[1] == 1 and armGeometry.dimensionsStuds[2] == 3 and armGeometry.dimensionsStuds[3] == 1
    and armGeometry.transparency == 0.25, "AI rig inspection should expose the animated segment's bounded visible-part proxy")
local rotatedRestFrame = { Rotation = true }
rotatedRestFrame.Rotation = rotatedRestFrame
function rotatedRestFrame:ToAxisAngle() return { X = 0, Y = 0, Z = 1 }, math.pi / 2 end
local rotatedOffset = { restFrame = rotatedRestFrame }
setmetatable(restCFrame, { __mul = function(_, offset) return offset and offset.restFrame or restCFrame end })
shoulder.C0 = rotatedOffset
local rotatedInspection = Rig.inspect(topology)
assert(rotatedInspection.animatedNames[1].captureFocusEligible == false, "non-driven rig roots must not be advertised as visual close-up targets")
local rotatedBasis = rotatedInspection.retargetProfile.joints[2].basis
assert(math.abs(rotatedBasis[1]) < 1e-8 and math.abs(rotatedBasis[2]) < 1e-8
    and math.abs(rotatedBasis[3] - math.sqrt(0.5)) < 1e-8 and math.abs(rotatedBasis[4] - math.sqrt(0.5)) < 1e-8,
    "Rig inspection must preserve a custom Motor6D rest rotation in the exported basis quaternion")
print("Rig inspection exports hierarchy, rest basis, segment lengths and bounded visual geometry cues")

local constraintRig = object("Model", "ConstraintRig")
local constraintRoot = object("BasePart", "RootPart", constraintRig)
local constraintArm = object("BasePart", "ArmPart", constraintRig)
local constraint0 = object("Attachment", "RootJoint", constraintRoot)
local constraint1 = object("Attachment", "RootJoint", constraintArm)
local animationConstraint = object("AnimationConstraint", "RootJoint", constraintRoot)
animationConstraint.Attachment0, animationConstraint.Attachment1 = constraint0, constraint1
local _, constraintByName, constraintNodes = Rig.nodes(constraintRig)
assert(#constraintNodes == 2 and constraintByName.ArmPart.target == animationConstraint
    and constraintByName.ArmPart.parent == constraintByName.RootPart,
    "AnimationConstraint rig topology must follow Attachment0-to-Attachment1 part hierarchy")
local constraintSignature = Rig.signature(constraintRig)
assert(string.find(constraintSignature, "RootPart>ArmPart:AnimationConstraint", 1, true),
    "AnimationConstraint class and attachment-backed hierarchy must be included in the rig signature")
constraintRig.GetPivot, constraintRig.Destroying = function() return restCFrame end, { Connect = function() end }
constraintRoot.CFrame, constraintArm.CFrame = restCFrame, restCFrame
constraintRoot.Position, constraintArm.Position = position(0, 0, 0), position(1, 0, 0)
constraintRoot.Size, constraintArm.Size = vector(1, 1, 1), vector(1, 1, 1)
constraintRoot.Transparency, constraintArm.Transparency = 0, 0
constraint0.CFrame, constraint1.CFrame = restCFrame, restCFrame
local constraintInspection = Rig.inspect(constraintRig)
assert(constraintInspection.retargetProfile.joints[2].targetKind == "AnimationConstraint",
    "Inspection should expose Attachment-backed AnimationConstraint targets per rig joint")
print("AnimationConstraint rig discovery and attachment hierarchy passed")

local boneRig = object("Model", "BoneRig")
local mesh = object("BasePart", "Mesh", boneRig)
local bone = object("Bone", "HandBone", mesh)
boneRig.GetPivot, boneRig.Destroying = function() return restCFrame end, { Connect = function() end }
mesh.CFrame, bone.CFrame = restCFrame, restCFrame
mesh.Position, bone.Position = position(0, 0, 0), position(1, 0, 0)
mesh.Size, mesh.Transparency = vector(1, 1, 1), 0
local boneInspection = Rig.inspect(boneRig)
assert(boneInspection.retargetProfile.joints[2].targetKind == "Bone" and boneInspection.retargetProfile.joints[2].driven,
    "Inspection should expose Bone targets distinctly from part joints")
print("Rig inspection distinguishes Motor6D, AnimationConstraint, and Bone drivers")
print("Full-body snapshot rig topology signatures passed")
