-- Deterministic transform fixture. Native Studio remains the authority for engine behavior.
local function vector(x, y, z) return {X=x, Y=y, Z=z} end
local CFrame = {}
local frameMeta = {}
local function frame(x, y, z, matrix)
    local m = matrix or {1,0,0, 0,1,0, 0,0,1}
    return setmetatable({X=x,Y=y,Z=z,Position=vector(x,y,z),m=m,
        RightVector=vector(m[1],m[4],m[7]),UpVector=vector(m[2],m[5],m[8]),LookVector=vector(-m[3],-m[6],-m[9])}, frameMeta)
end
function CFrame.new(x, y, z) return frame(x or 0,y or 0,z or 0) end
function CFrame.Angles(x, y, z)
    assert(x == 0 and y == 0 and z == 0, "This interpolation fixture uses translation keys")
    return CFrame.new()
end
CFrame.identity = CFrame.new()
function frameMeta.__mul(a,b)
    local m = {}
    for r=0,2 do for c=0,2 do
        m[r*3+c+1] = a.m[r*3+1]*b.m[c+1] + a.m[r*3+2]*b.m[c+4] + a.m[r*3+3]*b.m[c+7]
    end end
    return frame(a.X+a.m[1]*b.X+a.m[2]*b.Y+a.m[3]*b.Z,
        a.Y+a.m[4]*b.X+a.m[5]*b.Y+a.m[6]*b.Z,
        a.Z+a.m[7]*b.X+a.m[8]*b.Y+a.m[9]*b.Z,m)
end
frameMeta.__index = {
    Inverse = function(a)
        local m={a.m[1],a.m[4],a.m[7],a.m[2],a.m[5],a.m[8],a.m[3],a.m[6],a.m[9]}
        return frame(-m[1]*a.X-m[2]*a.Y-m[3]*a.Z,-m[4]*a.X-m[5]*a.Y-m[6]*a.Z,-m[7]*a.X-m[8]*a.Y-m[9]*a.Z,m)
    end,
    ToObjectSpace = function(a,b) return a:Inverse()*b end,
    ToAxisAngle = function(a)
        local cosine=math.clamp((a.m[1]+a.m[5]+a.m[9]-1)/2,-1,1)
        local angle=math.acos(cosine)
        if angle<1e-8 then return vector(1,0,0),0 end
        local divisor=2*math.sin(angle)
        return vector((a.m[8]-a.m[6])/divisor,(a.m[3]-a.m[7])/divisor,(a.m[4]-a.m[2])/divisor),angle
    end,
    Lerp = function(a,b,t) return frame(a.X+(b.X-a.X)*t,a.Y+(b.Y-a.Y)*t,a.Z+(b.Z-a.Z)*t,a.m) end,
}
local running = false
local game = {GetService=function() return {IsRunning=function() return running end} end}
local Rig = {
    signature=function(model) return model.rigSignature or "fixture-rig-signature" end,
    nodes=function(model) return model.roots,model.byName,model.nodes end,
    isPartJoint=function(target) return target.Part0 ~= nil or target.Attachment0 ~= nil end,
    jointParts=function(target)
        if target.Part0 then return target.Part0,target.Part1,target.C0,target.C1 end
        if target.Attachment0 and target.Attachment1 then
            return target.Attachment0.Parent,target.Attachment1.Parent,target.Attachment0.CFrame,target.Attachment1.CFrame
        end
    end,
}
local Authoring = (function()
-- INSERT_AUTHORING_HERE
end)()
assert(math.abs(Authoring.easeAlpha("Linear", "Out", 0.3) - 0.3) < 1e-6)
assert(math.abs(Authoring.easeAlpha("CubicV2", "Out", 0.5) - 0.125) < 1e-6)
assert(math.abs(Authoring.easeAlpha("CubicV2", "In", 0.5) - 0.875) < 1e-6)
local customCurve = {outTime=0.05,outValue=1.2,inTime=0.2,inValue=1.2}
assert(math.abs(Authoring.easeAlpha("Bezier", "Out", 0) - 0) < 1e-6)
assert(math.abs(Authoring.easeAlpha("Bezier", "Out", 1) - 1) < 1e-6)
assert(math.abs(Authoring.easeAlpha("Bezier", "Out", 0.5, customCurve) - 0.5) > 0.05)
assert(Authoring.easeAlpha("Constant", "Out", 0.5) == 0)
assert(Authoring.easeAlpha("Constant", "Out", 1) == 1)
local function savedSequence(name, attributes)
    return { Name = name, IsA = function(_, className) return className == "KeyframeSequence" end,
        GetAttribute = function(_, key) return attributes[key] end }
end
local exportIdentity = { assetId="asset-1", assetFingerprint=string.rep("a",64), rigSignature="rig-signature", preflightFingerprint=string.rep("b",64) }
local exactSaved = savedSequence("Exact", { MotionAssetId=exportIdentity.assetId, MotionAssetFingerprint=exportIdentity.assetFingerprint,
    MotionRigSignature=exportIdentity.rigSignature, MotionExportFingerprint=exportIdentity.preflightFingerprint })
local reconciled = Authoring.reconcileExports({exactSaved}, exportIdentity)
assert(reconciled.status == "saved" and reconciled.found and #reconciled.matches == 1)
reconciled = Authoring.reconcileExports({savedSequence("Legacy", { MotionAssetId=exportIdentity.assetId })}, exportIdentity)
assert(reconciled.status == "related_candidates" and not reconciled.found and #reconciled.matches == 1)
reconciled = Authoring.reconcileExports({savedSequence("Other rig", { MotionAssetFingerprint=exportIdentity.assetFingerprint,
    MotionExportFingerprint=string.rep("c",64) })}, exportIdentity)
assert(reconciled.status == "related_candidates" and not reconciled.found)
reconciled = Authoring.reconcileExports({savedSequence("Conflict", { MotionAssetId="wrong", MotionAssetFingerprint=exportIdentity.assetFingerprint,
    MotionRigSignature=exportIdentity.rigSignature, MotionExportFingerprint=exportIdentity.preflightFingerprint })}, exportIdentity)
assert(reconciled.status == "identity_conflict" and not reconciled.found)
reconciled = Authoring.reconcileExports({exactSaved, exactSaved}, exportIdentity)
assert(reconciled.status == "duplicate_identity" and not reconciled.found and #reconciled.matches == 2)
reconciled = Authoring.reconcileExports({savedSequence("Unrelated", {})}, exportIdentity)
assert(reconciled.status == "not_found" and not reconciled.found and #reconciled.matches == 0)
local manyRelated = {}
for index=1,80 do table.insert(manyRelated, savedSequence("Legacy "..index, { MotionAssetId=exportIdentity.assetId })) end
reconciled = Authoring.reconcileExports(manyRelated, exportIdentity)
assert(reconciled.status == "related_candidates" and reconciled.totalMatchCount == 80 and reconciled.matchesTruncated and #reconciled.matches == 64)
local manyExact = {}
for index=1,80 do table.insert(manyExact, exactSaved) end
reconciled = Authoring.reconcileExports(manyExact, exportIdentity)
assert(reconciled.status == "duplicate_identity" and reconciled.totalMatchCount == 80 and reconciled.matchesTruncated and #reconciled.matches == 64)
local Preview = (function()
-- INSERT_PREVIEW_HERE
end)()
local MotionInspection = (function()
-- INSERT_INSPECTION_HERE
end)()
local function object(class, properties)
    local result=properties or {}; result.class=class
    function result:IsA(kind) return self.class == kind end
    function result:Destroy() self.destroyed=true end
    return result
end
local lastClone, clones = nil,0
local function makeModel()
    local model={Archivable=false,Parent="Workspace",pivot=CFrame.new(100,10,-50),rigSignature="fixture-rig-signature"}
    function model:GetPivot() return self.pivot end
    local root=object("BasePart",{CFrame=model.pivot*CFrame.new(0,3,0),Size=vector(2,2,1),Anchored=false})
    local body=object("BasePart",{CFrame=model.pivot*CFrame.new(0,3,0),Size=vector(2,2,1),Anchored=false})
    local foot=object("BasePart",{CFrame=model.pivot*CFrame.new(-.5,.5,0),Size=vector(1,1,2),Anchored=false})
    local rootNode={name="Root",object=root,children={}}
    local bodyJoint={Part0=root,Part1=body,C0=CFrame.new(),C1=CFrame.new(),IsA=function(_,name) return name=="Motor6D" end}
    local footJoint={Part0=body,Part1=foot,C0=CFrame.new(-.5,-2.5,0),C1=CFrame.new(),IsA=function(_,name) return name=="Motor6D" end}
    local bodyNode={name="LowerTorso",object=body,parent=rootNode,children={},target=bodyJoint}
    local footNode={name="LeftFoot",object=foot,parent=bodyNode,children={},target=footJoint}
    model.nodes={rootNode,bodyNode,footNode}; model.roots={rootNode}; model.byName={Root=rootNode,LowerTorso=bodyNode,LeftFoot=footNode}
    model.script=object("LuaSourceContainer"); model.effect=object("Beam",{Enabled=true})
    function model:GetDescendants() return {root,body,foot,self.script,self.effect} end
    function model:Clone()
        assert(self.Archivable); clones+=1; lastClone=makeModel(); lastClone.Parent=nil
        for index, node in self.nodes do
            if node.target and lastClone.nodes[index].target then
                lastClone.nodes[index].target.C0=node.target.C0
                lastClone.nodes[index].target.C1=node.target.C1
            end
        end
        return lastClone
    end
    function model:Destroy() self.destroyed=true end
    return model
end
local function near(actual,expected) assert(math.abs(actual-expected)<0.0001, tostring(actual).." ~= "..tostring(expected)) end
local source=makeModel()
local baseLayerTrack={keys={
    {time=0,position={1,0,0},rotation={0,0,0}},
    {time=1,position={1,0,0},rotation={0,0,0}},
}}
local offsetLayerTrack={keys={
    {time=0,position={2,0,0},rotation={0,0,0}},
    {time=1,position={2,0,0},rotation={0,0,0}},
}}
near(Authoring.sampleStack({base=baseLayerTrack,layers={{track=offsetLayerTrack,weight=.5,blendMode="Additive",enabled=true}}},.5).Position.X,2)
near(Authoring.sampleStack({base=baseLayerTrack,layers={{track=offsetLayerTrack,weight=.5,blendMode="Override",enabled=true}}},.5).Position.X,1.5)
near(Authoring.sampleStack({base=baseLayerTrack,layers={{track=offsetLayerTrack,weight=1,blendMode="Additive",enabled=false}}},.5).Position.X,1)
local _, _, composedTracks=Authoring.tracks(source,{duration=1,tracks={{joint="LowerTorso",keys=baseLayerTrack.keys}},layers={{weight=.5,blendMode="Additive",enabled=true,tracks={{joint="LowerTorso",keys=offsetLayerTrack.keys}}}}},{})
near(Authoring.sampleStack(composedTracks.LowerTorso,.5).Position.X,2)
local _, _, rootedTracks=Authoring.tracks(source,{duration=1,tracks={{joint="LowerTorso",keys=baseLayerTrack.keys}},rootMotion={joint="LowerTorso",keys={
    {time=0,position={0,0,0},rotation={0,0,0}},
    {time=1,position={3,0,0},rotation={0,0,0}},
}}}, {})
near(Authoring.sampleStack(rootedTracks.LowerTorso,.5).Position.X,2.5)
local payload={assetId="asset",rigId="rig",rigSignature="fixture-rig-signature",jointMap={},times={0,.25,.5,.75,1},recipe={duration=1,loop=true,
    tracks={{joint="LowerTorso",keys={
        {time=0,position={0,0,0},rotation={0,0,0}},
        {time=.5,position={1,2,0},rotation={0,0,0}},
        {time=1,position={0,0,0},rotation={0,0,0}},
    }}},
}}
local result=MotionInspection.sample(source,payload,Rig,Authoring,Preview)
assert(result.rigSignature==payload.rigSignature,"sampled telemetry must be bound to the exact rig topology")
local easedTrack={keys={
    {time=0,position={0,0,0},rotation={0,0,0},easingStyle="CubicV2",easingDirection="Out"},
    {time=1,position={8,0,0},rotation={0,0,0}},
}}
near(Authoring.sample(easedTrack,.5).Position.X,1)
easedTrack.keys[1].easingStyle="Constant"
near(Authoring.sample(easedTrack,.5).Position.X,0)
easedTrack.keys[1].easingStyle="Bezier"
easedTrack.keys[1].curve=customCurve
near(Authoring.sample(easedTrack,0).Position.X,0)
near(Authoring.sample(easedTrack,1).Position.X,8)
easedTrack.keys[1].easingStyle="Bezier"
easedTrack.keys[1].curve=customCurve
near(Authoring.sample(easedTrack,0).Position.X,0)
near(Authoring.sample(easedTrack,1).Position.X,8)
assert(result.source=="studio_pose_evaluator" and result.groundSource=="rest_foot_bounds")
assert(#result.samples==5 and result.nodes[3].parent==2 and result.nodes[3].foot)
assert(result.nodes[2].targetKind=="Motor6D" and result.nodes[3].targetKind=="Motor6D")
assert(#result.restPose.points==#result.nodes and #result.restPose.orientations==#result.nodes)
near(result.samples[1].orientations[1][4],1)
near(result.samples[1].bottoms[3],0); near(result.samples[3].bottoms[3],2)
near(result.samples[2].points[2][1],.5); near(result.samples[3].points[2][2],5)
near(result.samples[3].pivotPoints[2][2],5)
near(result.samples[3].jointPoints[2][2],5)
near(result.samples[3].points[3][1],.5); near(result.samples[5].points[3][2],.5)
assert(lastClone.destroyed and lastClone.script.destroyed and not lastClone.effect.Enabled)
assert(lastClone.nodes[1].object.Anchored and not lastClone.nodes[1].object.CanCollide)
assert(source.Parent=="Workspace" and source.Archivable==false and not source.nodes[1].object.Anchored and not source.script.destroyed and source.effect.Enabled)
near(source.nodes[2].object.CFrame.Y,13)

-- Part joint offsets and untracked child transforms are evaluated parent first.
local nodes=makeModel().nodes
nodes[2].target.C0=CFrame.new(0,2,0); nodes[2].target.C1=CFrame.new(0,1,0)
Authoring.apply(nodes,{LowerTorso=payload.recipe.tracks[1]},.5)
near(nodes[2].object.CFrame.Y,16); near(nodes[3].object.CFrame.Y,13.5)
local constraintSource=makeModel()
local constraintParent=object("Attachment",{Parent=constraintSource.nodes[1].object,CFrame=CFrame.new(0,2,0)})
local constraintChild=object("Attachment",{Parent=constraintSource.nodes[2].object,CFrame=CFrame.new(0,1,0)})
local animationConstraint={Attachment0=constraintParent,Attachment1=constraintChild,
    IsA=function(_,name) return name=="AnimationConstraint" end}
constraintSource.nodes[2].target=animationConstraint
function constraintSource:Clone()
    assert(self.Archivable)
    clones+=1
    lastClone=makeModel(); lastClone.Parent=nil
    local attachment0=object("Attachment",{Parent=lastClone.nodes[1].object,CFrame=constraintParent.CFrame})
    local attachment1=object("Attachment",{Parent=lastClone.nodes[2].object,CFrame=constraintChild.CFrame})
    lastClone.nodes[2].target={Attachment0=attachment0,Attachment1=attachment1,
        IsA=function(_,name) return name=="AnimationConstraint" end}
    return lastClone
end
local constraintNodes=constraintSource.nodes
Authoring.apply(constraintNodes,{LowerTorso=payload.recipe.tracks[1]},.5)
near(constraintNodes[2].object.CFrame.Y,16)
local constraintSample=MotionInspection.sample(constraintSource,{assetId="asset",rigId="rig",rigSignature="fixture-rig-signature",jointMap={},times={0,.5,1},recipe=payload.recipe},Rig,Authoring,Preview)
assert(constraintSample.nodes[2].targetKind=="AnimationConstraint")
near(constraintSample.samples[2].jointPoints[2][2],7)
local pivotSource=makeModel()
pivotSource.nodes[2].target.C1=CFrame.new(0,1,0)
local pivotSample=MotionInspection.sample(pivotSource,{assetId="asset",rigId="rig",rigSignature="fixture-rig-signature",jointMap={},times={0,.5,1},recipe=payload.recipe},Rig,Authoring,Preview)
near(pivotSample.samples[2].pivotPoints[2][2],4)
near(pivotSample.samples[2].jointPoints[2][2],5)
local bone={IsA=function(_,name) return name=="Bone" end}
Authoring.apply({{name="Bone",target=bone}},{Bone=payload.recipe.tracks[1]},.5)
near(bone.Transform.X,1); near(bone.Transform.Y,2)

-- Rotated bounds use the part axes, not a fixed half-height.
local tilted=makeModel()
function tilted:Clone()
    lastClone=makeModel(); lastClone.Parent=nil
    local foot=lastClone.nodes[3].object
    foot.Size=vector(4,1,2); foot.CFrame=self.pivot*frame(-.5,.5,0,{0,-1,0,1,0,0,0,0,1})
    return lastClone
end
local rotated=MotionInspection.sample(tilted,payload,Rig,Authoring,Preview)
near(rotated.samples[1].bottoms[3],1.5)
near(rotated.samples[1].orientations[1][4],1)

-- Errors restore Archivable and always destroy the detached clone.
local bad=makeModel()
function bad:Clone() error("clone failure") end
assert(not pcall(Preview.copy,bad) and bad.Archivable==false)
local badRecipe=table.clone(payload); badRecipe.jointMap={LowerTorso="missing"}
assert(not pcall(MotionInspection.sample,source,badRecipe,Rig,Authoring,Preview) and lastClone.destroyed)
local mismatchedRig=table.clone(payload); mismatchedRig.rigSignature="different-rig-signature"
local before=clones
assert(not pcall(MotionInspection.sample,source,mismatchedRig,Rig,Authoring,Preview) and clones==before,
    "a stale rig signature must be rejected before cloning or sampling")
before=clones; local badTimes=table.clone(payload); badTimes.times={0,.5,.5,1}
assert(not pcall(MotionInspection.sample,source,badTimes,Rig,Authoring,Preview) and clones==before)
local denseTimes={}
for index=0,127 do table.insert(denseTimes,index/127) end
local densePayload=table.clone(payload); densePayload.times=denseTimes
assert(#MotionInspection.sample(source,densePayload,Rig,Authoring,Preview).samples==128)
local tooManyTimes=table.clone(densePayload); tooManyTimes.times=table.clone(denseTimes); table.insert(tooManyTimes.times,1.01)
assert(not pcall(MotionInspection.sample,source,tooManyTimes,Rig,Authoring,Preview))
before=clones
running=true
assert(not pcall(MotionInspection.sample,source,payload) and clones==before)
print("Motion inspection: shared joint evaluation, ground bounds, interpolation, source preservation and error cleanup passed")
