import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import { dirname, join } from 'node:path';
const executable = process.env.LUAU_EXECUTABLE || '.local/tools/luau-0.737/luau.exe';
const compiler = process.env.LUAU_COMPILER_EXECUTABLE || join(dirname(executable), 'luau-compile.exe');
const shippedPluginCompilation = spawnSync(compiler, ['--null', '-O0', 'dist/RobloxMotion.plugin.lua'], { encoding: 'utf8' });
if (shippedPluginCompilation.error) throw shippedPluginCompilation.error;
if (shippedPluginCompilation.status !== 0) {
  process.stderr.write(shippedPluginCompilation.stderr);
  throw new Error('The complete shipped plugin failed Luau compilation. Module fixtures cannot verify the combined register budget.');
}
process.stdout.write('Complete shipped plugin passes Luau compilation including register limits\n');
await mkdir('.local', {recursive:true});
const source = await readFile('studio/Rig.lua','utf8');
const tests = await readFile('tests/accessories.luau','utf8');
const editorContext = await readFile('studio/EditorContext.lua', 'utf8');
const editorTransaction = await readFile('studio/EditorTransaction.lua', 'utf8');
const editorContextTests = (await readFile('tests/editor-context.luau', 'utf8'))
  .replace('-- INSERT_EDITOR_CONTEXT_HERE', () => editorContext)
  .replace('-- INSERT_EDITOR_TRANSACTION_HERE', () => editorTransaction);
const column = await readFile('studio/EnergyColumn.lua', 'utf8');
const columnTests = await readFile('tests/energy-column.luau', 'utf8');
await writeFile('.local/studio-tests.luau', `fixtureServerStorage = { ClassName = "ServerStorage", children = {} }
function fixtureServerStorage:IsA(className) return className == "ServerStorage" end
function fixtureServerStorage:FindFirstChild(name) for _, child in self.children do if child.Name == name then return child end end end
local Instance = { new = function(className)
  local item = { ClassName = className, children = {} }
  function item:IsA(expected) return self.ClassName == expected end
  function item:IsDescendantOf(ancestor) local parent = self.Parent; while parent do if parent == ancestor then return true end; parent = parent.Parent end; return false end
  function item:FindFirstChild(name) for _, child in self.children do if child.Name == name then return child end end end
  setmetatable(item, { __newindex = function(self, key, value)
    rawset(self, key, value)
    if key == "Parent" and value and value.children then table.insert(value.children, self) end
  end })
  return item
end }
local game = {GetService=function(_, name)
  if name == "HttpService" then return {GenerateGUID=function() return "fixture-rig-id" end, JSONEncode=function(_, value) return tostring(value[1]) .. "|" .. table.concat(value[2], ",") end} end
  if name == "ServerStorage" then return fixtureServerStorage end
  return {}
end}
local Rig = (function()
${source}
end)()
${tests}
local EnergyColumn = (function()
${column}
end)()
${columnTests}`);
const result = spawnSync(executable, ['.local/studio-tests.luau'], {encoding:'utf8'});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
await writeFile('.local/editor-context-tests.luau', editorContextTests);
const editorContextResult = spawnSync(executable, ['.local/editor-context-tests.luau'], { encoding: 'utf8' });
if (editorContextResult.error) throw editorContextResult.error;
process.stdout.write(editorContextResult.stdout);
process.stderr.write(editorContextResult.stderr);
if (editorContextResult.status !== 0) process.exitCode = editorContextResult.status ?? 1;
const animationImport = await readFile('studio/AnimationImport.lua', 'utf8');
const animationImportTests = (await readFile('tests/animation-import.luau', 'utf8')).replace('-- INSERT_ANIMATION_IMPORT_HERE', `local AnimationImport = (function()\n${animationImport}\nend)()`);
await writeFile('.local/animation-import-tests.luau', animationImportTests);
const animationImportResult = spawnSync(executable, ['.local/animation-import-tests.luau'], { encoding: 'utf8' });
if (animationImportResult.error) throw animationImportResult.error;
process.stdout.write(animationImportResult.stdout);
process.stderr.write(animationImportResult.stderr);
if (animationImportResult.status !== 0) process.exitCode = animationImportResult.status ?? 1;
const exportValidation = await readFile('studio/ExportValidation.lua', 'utf8');
const exportValidationTests = (await readFile('tests/export-validation.luau', 'utf8')).replace('-- INSERT_EXPORT_VALIDATION_HERE', () => exportValidation);
await writeFile('.local/export-validation-tests.luau', exportValidationTests);
const exportValidationResult = spawnSync(executable, ['.local/export-validation-tests.luau'], { encoding: 'utf8' });
if (exportValidationResult.error) throw exportValidationResult.error;
process.stdout.write(exportValidationResult.stdout);
process.stderr.write(exportValidationResult.stderr);
if (exportValidationResult.status !== 0) process.exitCode = exportValidationResult.status ?? 1;
const manipulator = await readFile('studio/Manipulator.lua', 'utf8');
const manipulatorTests = (await readFile('tests/manipulator.luau', 'utf8')).replace('-- INSERT_MANIPULATOR_HERE', () => manipulator);
await writeFile('.local/manipulator-tests.luau', manipulatorTests);
const manipulatorResult = spawnSync(executable, ['.local/manipulator-tests.luau'], { encoding: 'utf8' });
if (manipulatorResult.error) throw manipulatorResult.error;
process.stdout.write(manipulatorResult.stdout);
process.stderr.write(manipulatorResult.stderr);
if (manipulatorResult.status !== 0) process.exitCode = manipulatorResult.status ?? 1;
const ikSolver = await readFile('studio/IKSolver.lua', 'utf8');
const ikTests = (await readFile('tests/ik-solver.luau', 'utf8')).replace('-- INSERT_IK_SOLVER_HERE', () => ikSolver);
await writeFile('.local/ik-solver-tests.luau', ikTests);
const ikResult = spawnSync(executable, ['.local/ik-solver-tests.luau'], { encoding: 'utf8' });
if (ikResult.error) throw ikResult.error;
process.stdout.write(ikResult.stdout);
process.stderr.write(ikResult.stderr);
if (ikResult.status !== 0) process.exitCode = ikResult.status ?? 1;
const ikContact = await readFile('studio/IKContact.lua', 'utf8');
const ikContactTests = (await readFile('tests/ik-contact.luau', 'utf8')).replace('-- INSERT_IK_CONTACT_HERE', () => ikContact);
await writeFile('.local/ik-contact-tests.luau', ikContactTests);
const ikContactResult = spawnSync(executable, ['.local/ik-contact-tests.luau'], { encoding: 'utf8' });
if (ikContactResult.error) throw ikContactResult.error;
process.stdout.write(ikContactResult.stdout);
process.stderr.write(ikContactResult.stderr);
if (ikContactResult.status !== 0) process.exitCode = ikContactResult.status ?? 1;
const plugin = await readFile('studio/Plugin.lua', 'utf8');
const keyframeSelection = await readFile('studio/KeyframeSelection.lua', 'utf8');
const mirror = await readFile('studio/Mirror.lua', 'utf8');
const packagedPlugin = await readFile('dist/RobloxMotion.plugin.lua', 'utf8');
const previewModule = await readFile('studio/Preview.lua', 'utf8');
const rigModule = await readFile('studio/Rig.lua', 'utf8');
const serverSource = await readFile('src/server.ts', 'utf8');
const capabilityManifest = rigModule.match(/features = \{([^}]+)\}/)?.[1];
const operationManifest = rigModule.match(/operations = \{([^}]+)\}/)?.[1];
const serverFeatureManifest = serverSource.match(/requiredStudioFeatures:\s*z\.array\(z\.enum\(\[([\s\S]*?)\]\)\)/)?.[1];
const serverOperationManifest = serverSource.match(/const studioOperationNames = \[([\s\S]*?)\] as const/)?.[1];
const quotedNames = (source) => [...source.matchAll(/['"]([A-Za-z][A-Za-z0-9]*)['"]/g)].map(match => match[1]).sort();
const trueFieldNames = (source) => [...source.matchAll(/\b([A-Za-z][A-Za-z0-9]*)\s*=\s*true\b/g)].map(match => match[1]).sort();
const assertSameNames = (label, expected, actual) => {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} differs across the MCP server and Roblox Studio plugin: server=[${expected.join(', ')}], plugin=[${actual.join(', ')}].`);
  }
};
if (!serverFeatureManifest || !serverOperationManifest) {
  throw new Error('The server readiness feature and exact-operation schemas must remain discoverable for Studio manifest consistency checks.');
}
assertSameNames('Studio readiness feature manifest', quotedNames(serverFeatureManifest), trueFieldNames(capabilityManifest ?? ''));
assertSameNames('Studio readiness operation manifest', quotedNames(serverOperationManifest), trueFieldNames(operationManifest ?? ''));
for (const [label, source] of [['source', plugin], ['packaged', packagedPlugin]]) {
  if (source.includes(':ToOrientation()')) {
    throw new Error(`The ${label} plugin must round-trip Motion Tools XYZ Euler recipe channels with ToEulerAnglesXYZ, not the YXZ ToOrientation accessor.`);
  }
  if (!source.includes('applyIKEndpointOrientation') || !source.includes('endpoint position')
    || !source.includes('orientationResidualDegrees') || !source.includes('orientationWithinTolerance')
    || !source.includes('orientationToleranceDegrees') || !source.includes('ToEulerAnglesXYZ()')) {
    throw new Error(`The ${label} plugin must preserve IK endpoint position while applying and measuring fingerprinted orientation targets.`);
  }
}
if (!ikContact.includes('function IKContact.orientationAt') || !ikContact.includes('leftFrame:Lerp(rightFrame, alpha).Rotation')
  || !plugin.includes('IKContact.orientationAt(constraint.targetOrientationPath')
  || !packagedPlugin.includes('IKContact.orientationAt(constraint.targetOrientationPath')
  || !plugin.includes('targetOrientationPath = constraint.targetOrientationPath and table.clone(constraint.targetOrientationPath)')
  || !packagedPlugin.includes('targetOrientationPath = constraint.targetOrientationPath and table.clone(constraint.targetOrientationPath)')) {
  throw new Error('Studio source and packaged plugin must interpolate fingerprinted orientation waypoints with Roblox shortest-arc CFrame rotation interpolation and preserve the exact path in solve evidence.');
}
if (!plugin.includes('EditorContext.snapshot({') || !plugin.includes('snapshot.motionEditor = UI.editorViewportSnapshot()')
  || !packagedPlugin.includes('local EditorContext = (function()') || !packagedPlugin.includes('snapshot.motionEditor = UI.editorViewportSnapshot()')) {
  throw new Error('The live Studio heartbeat and packaged plugin must both expose the recipe-free Motion Tools editor/viewport context.');
}
if (!plugin.includes('EditorContext.applyDisposition(recipeDirty,') || !plugin.includes('alreadyApplied = true')
  || !plugin.includes('The exact requested candidate is already open as the dirty unsaved draft')) {
  throw new Error('Editor candidate retries must reconcile an exact already-applied draft without duplicating the undo step.');
}
for (const [label, source] of [['source', plugin], ['packaged', packagedPlugin]]) {
  if (!source.includes('MotionTools_IKRequestedTargets_VisualOnly') || !source.includes('RequestedTarget_')
    || !source.includes('IKContact.targetAt(target.targetWorldPath, time, target.targetPathInterpolation)')
    || !source.includes('CYAN · SOLVED   AMBER · TARGET')
    || !source.includes('if ikCandidatePreview.targetFolder then ikCandidatePreview.targetFolder:Destroy()')) {
    throw new Error(`The ${label} plugin must visualize exact animated IK targets beside the non-mutating candidate ghost and clean them up together.`);
  }
}
if (!plugin.includes('EditorTransaction.run(function()') || !packagedPlugin.includes('local EditorTransaction = (function()')
  || !packagedPlugin.includes('EditorTransaction.run(function()')
  || !plugin.includes('Candidate apply failed and rollback was incomplete; inspect the current draft before any retry.')
  || !plugin.includes('UI.reviewMarkerNameBox.Visible = hasSelectedMarker or selectedEvent ~= nil')
  || !plugin.includes('selectKey(selectedKeyTrackIndex, selectedKeyIndex, true, true)')) {
  throw new Error('Editor candidate application must use the tested transaction boundary and report rollback failures without implying state recovery.');
}
if (!plugin.includes('previewLoop = previewLoop') || !plugin.includes('timelineViewStart = timelineViewStart')
  || !plugin.includes('local sourceBefore, destinationBefore = table.clone(source), table.clone(destination)')
  || !plugin.includes('Undo/redo was rolled back; the previous editor draft and history were restored.')) {
  throw new Error('Editor undo/redo must preserve loop/timeline presentation and restore the draft/history after a failed state transition.');
}
if (!capabilityManifest || !packagedPlugin.includes(`features = {${capabilityManifest}}`)) {
  throw new Error('The live and packaged Studio plugins must report the same explicit capability manifest.');
}
if (!operationManifest || !packagedPlugin.includes(`operations = {${operationManifest}}`)) {
  throw new Error('The live and packaged Studio plugins must report the same exact-operation manifest.');
}
for (const [feature, implementations] of [
  ['poseSampling', ['if op == "sample_animation" then return MotionInspection.sample(model, payload, Rig, Authoring, Preview) end']],
  ['animationLibrary', ['if op == "list_local_animations" then', 'if op == "save_animation" then']],
  ['fullBodySnapshots', ['UI.captureSnapshotButton.Activated:Connect(function()', 'assetType = "snapshot"']],
  ['inverseKinematics', ['if op == "ik_constraints" or op == "ik_constraints_preview" or op == "ik_constraints_apply" then']],
  ['editorDraft', ['if op == "read_editor_draft" then', 'if op == "apply_editor_candidate" then']],
]) {
  if (!capabilityManifest.includes(`${feature} = true`) || implementations.some(implementation =>
    !plugin.includes(implementation) || !packagedPlugin.includes(implementation))) {
    throw new Error(`Studio advertises ${feature} without its required implementation in both source and packaged plugin.`);
  }
}
for (const [operation, implementation] of [
  ['inspectRig', 'if op == "inspect" then return Rig.inspect(model) end'],
  ['sampleAnimation', 'if op == "sample_animation" then return MotionInspection.sample(model, payload, Rig, Authoring, Preview) end'],
  ['browseLocalAnimations', 'if op == "list_local_animations" then'],
  ['openAnimation', 'if op == "open_animation" then'],
  ['saveAnimation', 'if op == "save_animation" then'],
  ['validateAnimationExport', 'if op == "validate_animation_export" then'],
  ['readEditorDraft', 'if op == "read_editor_draft" then'],
  ['applyEditorCandidate', 'if op == "apply_editor_candidate" then'],
  ['captureCandidateViews', 'if op == "capture_frames" then'],
  ['captureEditorDraftViews', 'if op == "capture_editor_draft_views" then'],
  ['inverseKinematics', 'if op == "ik_constraints" or op == "ik_constraints_preview" or op == "ik_constraints_apply" then'],
]) {
  if (!operationManifest.includes(`${operation} = true`) || !plugin.includes(implementation) || !packagedPlugin.includes(implementation)) {
    throw new Error(`Studio advertises ${operation} without its required implementation in both source and packaged plugin.`);
  }
}
if (!plugin.includes('world.Parent = UI.viewport')
  || !plugin.includes('clone.Parent = world')
  || !plugin.includes('model.Parent = Rig.storageFolder()')
  || !packagedPlugin.includes('model.Parent = Rig.storageFolder()')) {
  throw new Error('Motion Tools rigs must stay in the private Rig Library while only a clone enters the isolated plugin viewport, including in the packaged plugin.');
}
if (!plugin.includes('KeyframeSelection.planRetiming') || !packagedPlugin.includes(keyframeSelection)
  || !plugin.includes('KeyframeSelection.planKeyframePaste')
  || !plugin.includes('if controlHeld and input.KeyCode == Enum.KeyCode.C then')
  || !plugin.includes('elseif controlHeld and input.KeyCode == Enum.KeyCode.V then')
  || !plugin.includes('pushUndoSnapshot()\n    local tracks = editableTracks()')
  || !plugin.includes('KeyframeSelection.findKeyIndexAtTime(targetTrack.keys, sourceKey.time)')
  || !plugin.includes('pcall(Authoring.sample, targetTrack, sourceKey.time)')
  || !plugin.includes('KeyframeSelection.Mirror.pose')
  || !plugin.includes('KeyframeSelection.planMirrorInsertion(targetTrack.keys, insertionIndex)')
  || !plugin.includes('if not sampleOk then')
  || !plugin.includes('Rig.inspect, previewRigModel')
  || !plugin.includes('if currentRecipe.loop and (targetKeyIndex == 1 or targetKeyIndex == #targetTrack.keys) then')) {
  throw new Error('Multi-keyframe retiming and clipboard editing must be wired into the Studio plugin and included in the packaged plugin.');
}
if (!packagedPlugin.includes(mirror) || plugin.includes('targetKey.position = { -sourceKey.position[1]')) {
  throw new Error('Rig-aware reflection must be included in the packaged plugin and replace the fixed-axis sign flip.');
}
if (!packagedPlugin.includes('function MotionInspection.sample(model, payload, Rig, Authoring, Preview)')
  || !packagedPlugin.includes('MotionInspection.sample(model, payload, Rig, Authoring, Preview)')) {
  throw new Error('Packaged animation inspection must receive its module dependencies explicitly.');
}
const graphMotionInspection = await readFile('studio/GraphMotionInspection.lua', 'utf8');
const curveAnimationAuthoring = await readFile('studio/CurveAnimationAuthoring.lua', 'utf8');
for (const invariant of [
  'RegisterActiveKeyframeSequence(sequence)',
  'AnimationClipProvider:RegisterAnimationClip(curveAnimation)',
  'CurveAnimationAuthoring.fromKeyframeSequence(sequence, rigNodes)',
  'animator:LoadAnimation(animation)',
  'track:AdjustWeight(math.clamp(active.weight, 0, 1), 0)',
  'track.TimePosition = math.clamp(active.playbackTimeSeconds, 0, entry.duration)',
  'animator:GetPlayingAnimationTracks()',
  'target:IsA("Motor6D") or target:IsA("AnimationConstraint") or target:IsA("Bone")',
  'Unexpected animation track is active on the calibration Animator.',
  'local weight, playbackTime = track.WeightCurrent, track.TimePosition',
  'tracks = observedTracks',
  'animator:StepAnimations(0)',
  'totalJointSamples <= 4096',
  'source = "studio_animator_native_blend"',
  'Each returned joint Transform is sampled after resetting that Transform to CFrame.identity',
  'identity-relative local animation deltas, not world transforms or the rig\'s authored rest CFrames',
  'calibrationProtocol = "identity_local_animation_delta_v1"',
]) {
  if (!graphMotionInspection.includes(invariant)) throw new Error(`Native graph blend calibration invariant missing from Studio evaluator: ${invariant}`);
}
if (graphMotionInspection.includes('entry.track:Stop(0)')) throw new Error('Native graph blend calibration must verify zero-weight tracks instead of relying on immediate Stop(0) cleanup.');
if (!plugin.includes('if op == "sample_animation_graph_blend" then return GraphMotionInspection.sample(model, payload, Authoring, Rig, Preview, CurveAnimationAuthoring) end')) {
  throw new Error('Native graph blend calibration is not connected to the Studio plugin operation dispatcher.');
}
if (!graphMotionInspection.includes('function GraphMotionInspection.captureFade')
  || !graphMotionInspection.includes('track:Stop(payload.fadeSeconds)')
  || !graphMotionInspection.includes('track:AdjustWeight(targetWeight, payload.fadeSeconds)')
  || !graphMotionInspection.includes('adjustWeightIn = captureAdjustWeight(0, 1')
  || !graphMotionInspection.includes('adjustWeightOut = captureAdjustWeight(1, 0')
  || !graphMotionInspection.includes('timePositionImmediatelyAfter = rounded(track.TimePosition)')
  || !graphMotionInspection.includes('timePositionAfterStep = rounded(track.TimePosition)')
  || !graphMotionInspection.includes('observedClockBehavior =')
  || !graphMotionInspection.includes('source = "studio_animator_fade_calibration"')) {
  throw new Error('Native AnimationTrack fade calibration is missing Play/Stop/AdjustWeight curves or its repeated-Play clock probe.');
}
if (!graphMotionInspection.includes('local loadDeadline = os.clock() + 5')
  || !graphMotionInspection.includes('while track.Length <= 0 and os.clock() < loadDeadline do task.wait() end')
  || !graphMotionInspection.includes('Studio did not load a valid AnimationTrack.Length')) {
  throw new Error('Fade calibration must wait briefly for AnimationTrack.Length to load, then fail closed rather than persisting zero as a clip duration.');
}
if (!plugin.includes('if op == "sample_animation_graph_fade" then return GraphMotionInspection.captureFade(model, payload, Authoring, Rig, Preview, CurveAnimationAuthoring) end')) {
  throw new Error('Native AnimationTrack fade calibration is not connected to the Studio plugin operation dispatcher.');
}
await writeFile('.local/graph-motion-inspection-tests.luau', `local Enum = {KeyInterpolationMode={Linear="Linear"}}\nlocal function fakeInstance(className)\n  local value = {ClassName=className, children={}}\n  function value:IsA(name) return name == className end\n  function value:Destroy() self.destroyed=true end\n  return setmetatable(value, {__newindex=function(self, key, child) rawset(self, key, child); if key == "Parent" and child and child.children then table.insert(child.children, self) end end})\nend\nlocal function floatCurve()\n  local value = fakeInstance("FloatCurve")\n  value.keys = {}\n  function value:InsertKey(key) table.insert(self.keys, key) end\n  return value\nend\nlocal Instance = {new=function(className)\n  local value = fakeInstance(className)\n  if className == "Vector3Curve" then\n    function value:X() self.x=self.x or floatCurve(); return self.x end\n    function value:Y() self.y=self.y or floatCurve(); return self.y end\n    function value:Z() self.z=self.z or floatCurve(); return self.z end\n  elseif className == "RotationCurve" then\n    value.keys = {}\n    function value:InsertKey(key) table.insert(self.keys, key) end\n  end\n  return value\nend}\nlocal FloatCurveKey = {new=function(time, value, interpolation) return {Time=time, Value=value, Interpolation=interpolation} end}\nlocal RotationCurveKey = {new=function(time, value, interpolation) return {Time=time, Value=value, Interpolation=interpolation} end}\nlocal CurveAnimationAuthoring = (function()\n${curveAnimationAuthoring}\nend)()\nlocal function pose(name, cframe, children)\n  return {Name=name, CFrame=cframe, GetSubPoses=function() return children or {} end}\nend\nlocal c0, c1, c2 = {Position={X=0,Y=0,Z=0}, id="start"}, {Position={X=1,Y=2,Z=3}, id="arm"}, {Position={X=4,Y=5,Z=6}, id="hand"}\nlocal frames = {{Time=0, GetPoses=function() return {pose("Root", c0, {pose("Arm", c1, {pose("Hand", c2)})})} end},\n  {Time=1, GetPoses=function() return {pose("Root", c0, {pose("Arm", c1, {pose("Hand", c2)})})} end}}\nlocal sequence = {Name="BoneClip", Loop=true, Priority="Action", IsA=function(_, name) return name == "KeyframeSequence" end, GetKeyframes=function() return frames end}\nlocal root, arm, hand = {name="Root", children={}}, {name="Arm", children={}}, {name="Hand", children={}}\nlocal bone = {IsA=function(_, name) return name == "Bone" end}\nroot.target, arm.target, hand.target = nil, bone, bone\narm.parent, hand.parent = root, arm\nlocal clip = CurveAnimationAuthoring.fromKeyframeSequence(sequence, {root, arm, hand})\nassert(clip.ClassName == "CurveAnimation" and clip.Name == "BoneClip" and clip.Loop and clip.Priority == "Action")\nlocal armFolder, handFolder = clip.children[1], clip.children[1].children[2]\nassert(armFolder.Name == "Arm" and handFolder.Name == "Hand" and handFolder.Parent == armFolder, "Bone hierarchy must map into nested curve folders")\nlocal armPosition, armRotation = armFolder.children[1], armFolder.children[2]\nassert(armPosition.Name == "Position" and armPosition.x.keys[2].Value == 1 and armPosition.y.keys[2].Value == 2 and armPosition.z.keys[2].Value == 3)\nassert(armRotation.Name == "Rotation" and armRotation.keys[2].Value == c1 and armRotation.keys[2].Interpolation == "Linear")\nlocal crowdedNodes = {}\nfor index=1,257 do table.insert(crowdedNodes, {name="Bone"..index, target=bone}) end\nlocal manyFrames = {}\nfor index=1,256 do table.insert(manyFrames, {Time=index, GetPoses=function() return {} end}) end\nlocal overBudget, budgetError = pcall(function() CurveAnimationAuthoring.fromKeyframeSequence({IsA=sequence.IsA, GetKeyframes=function() return manyFrames end}, crowdedNodes) end)\nassert(not overBudget and string.find(tostring(budgetError), "per-clip limit", 1, true), "curve authoring must reject work above its per-clip budget")\nlocal badClip = CurveAnimationAuthoring.fromKeyframeSequence\nlocal missingPoseSequence = {IsA=sequence.IsA, GetKeyframes=function() return {{Time=0, GetPoses=function() return {} end}} end}\nlocal missingOk = pcall(function() badClip(missingPoseSequence, {root, arm}) end)\nassert(not missingOk, "missing Bone pose samples must fail conversion")\nlocal game = {GetService=function(_, name) if name == "RunService" then return {IsRunning=function() return false end} end return {} end}\nlocal GraphMotionInspection = (function()\n${graphMotionInspection}\nend)()\nassert(type(GraphMotionInspection.sample) == "function")\nprint("Bone CurveAnimation authoring preserves hierarchy, sampled transforms, metadata and bounded failure behavior")\n`);
let graphMotionTests = await readFile('tests/curve-animation-authoring.luau', 'utf8');
graphMotionTests = graphMotionTests.replace('-- INSERT_CURVE_ANIMATION_AUTHORING_HERE', curveAnimationAuthoring)
  .replace('-- INSERT_GRAPH_MOTION_INSPECTION_HERE', graphMotionInspection);
await writeFile('.local/graph-motion-inspection-tests.luau', graphMotionTests);
const graphMotionResult = spawnSync(executable, ['.local/graph-motion-inspection-tests.luau'], { encoding: 'utf8' });
if (graphMotionResult.error) throw graphMotionResult.error;
process.stdout.write(graphMotionResult.stdout);
process.stderr.write(graphMotionResult.stderr);
if (graphMotionResult.status !== 0) process.exitCode = graphMotionResult.status ?? 1;
for (const invariant of ['if op == "open_candidate" then', 'selectedAssetIsEphemeral = asset.ephemeral == true', 'saveRequest.sourceRigProfile = selectedSourceRigProfile',
  'assert(not recipeDirty or sameDraft,', 'The Motion Tools viewport contains unsaved edits. Read the current editor draft',
  'UI.draftStateBadge.Name = "DraftState"', 'CANDIDATE · EDITED', 'UNSAVED CANDIDATE', 'UNSAVED EDITS', 'SAVED REVISION',
  'setRecipeDirty = function(dirty)', 'setRecipeDirty(true)',
  'local sourceRigProfile = Rig.inspect(model).retargetProfile', 'or { kind = "anim_saves", sequenceName = payload.sequenceName, sequenceLocator = payload.sequenceLocator }',
  'if op == "list_local_animations" then', 'return AnimationImport.listLocal(model)',
  'if op == "import_animation_batch_preview" then', 'for index, source in payload.sources do',
  'if payload.previewOnly then', 'return { previewOnly = true, recipe = recipe, sourceRigProfile = sourceRigProfile, sourceIdentity = sourceIdentity',
  'request("/library/import-save", { recipe = recipe, sourceRigProfile = sourceRigProfile, sourceIdentity = sourceIdentity })',
  'idempotent = true',
  'markerCount = #recipe.markers, unmapped = unmapped, diagnostics = diagnostics',
  'sequence:SetAttribute("MotionAssetFingerprint", selectedAssetFingerprint)']) {
  if (!plugin.includes(invariant)) throw new Error(`Studio candidate-preview invariant missing from plugin: ${invariant}`);
}
for (const invariant of [
  'if op == "capture_editor_draft_views" then',
  'selectedAssetId == payload.editorAssetId',
  'structurallyEqual(currentRecipe, payload.expectedDraftRecipe)',
  'The editor draft changed after it was read. No screenshot was captured',
  'local captured = ReviewCapture.frames(model, capturePayload)',
  'The editor draft changed during capture. Captured images were not returned',
  'if op == "read_editor_draft" then',
  'if op == "apply_editor_candidate" then',
  'structurallyEqual(currentRecipe, payload.expectedDraftRecipe)',
  'pushUndoSnapshot()',
  'setRecipeDirty(true)',
  'saved = false, exportAuthorized = false',
  'The editor draft changed after it was read. No candidate was applied',
]) {
  if (!plugin.includes(invariant) || !packagedPlugin.includes(invariant)) {
    throw new Error(`AI editor-draft safety invariant missing from source or packaged Studio plugin: ${invariant}`);
  }
}
for (const invariant of [
  'function Preview.capturePose(model, payload)',
  'local clone = Preview.copy(model)',
  'Authoring.apply(nodes, tracks, payload.sampleTime)',
]) {
  if (!previewModule.includes(invariant) || !packagedPlugin.includes(invariant)) {
    throw new Error(`Isolated screenshot-pose invariant missing from source or packaged Studio plugin: ${invariant}`);
  }
}
for (const invariant of [
  'if candidateId then\n                local opened, openError = pcall(function()',
  'setSelectedAnimation({ id = candidateId, recipe = result.recipe, ephemeral = true,',
  'ephemeralBaseRecipe = cloneRecipe(payload.recipe)',
  'structurallyEqual(candidateRecipe, payload.expectedCandidateRecipe)',
  'Retarget + contact-bake candidate loaded for review.',
]) {
  if (!plugin.includes(invariant)) throw new Error(`Retarget/contact-bake viewport invariant missing from plugin: ${invariant}`);
}
for (const invariant of [
  'if op == "validate_vfx_timeline" then',
  'Authoring.apply(nodes, tracks, cue.time)',
  'result.temporaryCloneDestroyed = true',
  'if op == "preview" then',
  'local attachment, controller = Authoring.effect(cue.partInstance, cue.recipe, true)',
  'if op == "stop_preview" then',
  'playEditorAnimation(effectCues, payload.seconds)',
  'playEditorEffectsOnly(effectCues, payload.seconds)',
]) {
  if (!plugin.includes(invariant)) throw new Error(`Managed animation/VFX preview invariant missing from plugin: ${invariant}`);
}
const pluginTests = (await readFile('tests/plugin-library.luau', 'utf8')).replace('-- INSERT_PLUGIN_HERE', `local KeyframeSelection = (function()\n${keyframeSelection}\nend)()\nKeyframeSelection.Mirror = (function()\n${mirror}\nend)()\n${plugin}`);
await writeFile('.local/plugin-library-tests.luau', pluginTests);
const panelResult = spawnSync(executable, ['.local/plugin-library-tests.luau'], { encoding: 'utf8' });
if (panelResult.error) throw panelResult.error;
process.stdout.write(panelResult.stdout);
process.stderr.write(panelResult.stderr);
if (panelResult.status !== 0) process.exitCode = panelResult.status ?? 1;
const keyframeSelectionTests = (await readFile('tests/keyframe-selection.luau', 'utf8')).replace('-- INSERT_KEYFRAME_SELECTION_HERE', `local KeyframeSelection = (function()\n${keyframeSelection}\nend)()`);
await writeFile('.local/keyframe-selection-tests.luau', keyframeSelectionTests);
const keyframeSelectionResult = spawnSync(executable, ['.local/keyframe-selection-tests.luau'], { encoding: 'utf8' });
if (keyframeSelectionResult.error) throw keyframeSelectionResult.error;
process.stdout.write(keyframeSelectionResult.stdout);
process.stderr.write(keyframeSelectionResult.stderr);
if (keyframeSelectionResult.status !== 0) process.exitCode = keyframeSelectionResult.status ?? 1;
const keyframeClipboardTests = (await readFile('tests/keyframe-clipboard.luau', 'utf8')).replace('-- INSERT_KEYFRAME_CLIPBOARD_HERE', `local KeyframeSelection = (function()\n${keyframeSelection}\nend)()`);
await writeFile('.local/keyframe-clipboard-tests.luau', keyframeClipboardTests);
const keyframeClipboardResult = spawnSync(executable, ['.local/keyframe-clipboard-tests.luau'], { encoding: 'utf8' });
if (keyframeClipboardResult.error) throw keyframeClipboardResult.error;
process.stdout.write(keyframeClipboardResult.stdout);
process.stderr.write(keyframeClipboardResult.stderr);
if (keyframeClipboardResult.status !== 0) process.exitCode = keyframeClipboardResult.status ?? 1;
const mirrorTests = (await readFile('tests/mirror.luau', 'utf8')).replace('-- INSERT_MIRROR_HERE', `local Mirror = (function()\n${mirror}\nend)()`);
await writeFile('.local/mirror-tests.luau', mirrorTests);
const mirrorResult = spawnSync(executable, ['.local/mirror-tests.luau'], { encoding: 'utf8' });
if (mirrorResult.error) throw mirrorResult.error;
process.stdout.write(mirrorResult.stdout);
process.stderr.write(mirrorResult.stderr);
if (mirrorResult.status !== 0) process.exitCode = mirrorResult.status ?? 1;
let inspectionTests = await readFile('tests/motion-inspection.luau', 'utf8');
for (const [marker, file] of [['AUTHORING', 'Authoring'], ['PREVIEW', 'Preview'], ['INSPECTION', 'MotionInspection']]) {
  const module = await readFile(`studio/${file}.lua`, 'utf8');
  inspectionTests = inspectionTests.replace(`-- INSERT_${marker}_HERE`, () => module);
}
await writeFile('.local/motion-inspection-tests.luau', inspectionTests);
const inspectionResult = spawnSync(executable, ['.local/motion-inspection-tests.luau'], { encoding: 'utf8' });
if (inspectionResult.error) throw inspectionResult.error;
process.stdout.write(inspectionResult.stdout);
process.stderr.write(inspectionResult.stderr);
if (inspectionResult.status !== 0) process.exitCode = inspectionResult.status ?? 1;
if (!packagedPlugin.includes('MotionInspection.sample(model, payload, Rig, Authoring, Preview)')) {
  throw new Error('Packaged animation inspection must receive its module dependencies explicitly.');
}
const reviewCapture = await readFile('studio/ReviewCapture.lua', 'utf8');
const packagedIKContactIndex = packagedPlugin.indexOf('local IKContact = (function()');
const packagedReviewCaptureIndex = packagedPlugin.indexOf('local ReviewCapture = (function()');
if (packagedIKContactIndex < 0 || packagedReviewCaptureIndex < 0 || packagedIKContactIndex > packagedReviewCaptureIndex) {
  throw new Error('Packaged IK screenshot capture must load the shared IK target-path evaluator before ReviewCapture.');
}
for (const invariant of [
  'IKContact.targetAt(guide.targetWorldPath, payload.time, guide.targetPathInterpolation)',
  'fixed[1] + offset[1], fixed[2] + offset[2], fixed[3] + offset[3]',
  'MotionReviewRequestedTarget_',
  'guidePositions',
  'stagingFrame.Position - rigFrame.Position',
  'Requested target dots are colored spheres',
]) {
  if (!reviewCapture.includes(invariant) || !packagedPlugin.includes(invariant)) {
    throw new Error(`AI-readable IK target guides must be rendered on the disposable screenshot clone and included in the packaged plugin: ${invariant}`);
  }
}
const reviewCaptureTests = (await readFile('tests/review-capture.luau', 'utf8')).replace('-- INSERT_REVIEW_CAPTURE_HERE', `local IKContact = (function()\n${ikContact}\nend)()\nlocal ReviewCapture = (function()\n${reviewCapture}\nend)()`);
await writeFile('.local/review-capture-tests.luau', reviewCaptureTests);
const reviewCaptureResult = spawnSync(executable, ['.local/review-capture-tests.luau'], { encoding: 'utf8' });
if (reviewCaptureResult.error) throw reviewCaptureResult.error;
process.stdout.write(reviewCaptureResult.stdout);
process.stderr.write(reviewCaptureResult.stderr);
if (reviewCaptureResult.status !== 0) process.exitCode = reviewCaptureResult.status ?? 1;
