import { createHash } from 'node:crypto';
import { z } from 'zod';
import { animationGraphFingerprint, animationGraphSchema, type AnimationGraph } from './animation-graph.js';
import { animationSchema, type AnimationRecipe } from './recipes.js';
import { animationGraphBlendSpace2DTopology } from './animation-graph-blend-space-2d.js';

const stateId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const publishedAnimationId = z.string().trim().regex(/^(?:rbxassetid:\/\/)?[1-9][0-9]{0,19}$/i,
  'Use a positive numeric Roblox animation asset ID, optionally prefixed with rbxassetid://.');

export type RuntimeGraphAnimation = Pick<AnimationRecipe, 'duration' | 'loop' | 'priority' | 'markers'>;
const runtimeAnimationMetadataSchema = animationSchema.pick({ duration: true, loop: true, priority: true, markers: true });

function quoteLuau(value: string): string {
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    switch (character) {
      case '"': result += '\\"'; break;
      case '\\': result += '\\\\'; break;
      case '\n': result += '\\n'; break;
      case '\r': result += '\\r'; break;
      case '\t': result += '\\t'; break;
      case '\b': result += '\\b'; break;
      case '\f': result += '\\f'; break;
      default:
        result += codePoint < 32 || codePoint === 127
          ? `\\${String(codePoint).padStart(3, '0')}`
          : character;
    }
  }
  return `${result}"`;
}

function luauValue(value: unknown): string {
  if (value === null) return 'nil';
  if (typeof value === 'string') return quoteLuau(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Runtime graph data cannot contain non-finite numbers.');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (Array.isArray(value)) return `{ ${value.map(item => luauValue(item)).join(', ')} }`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{ ${entries.map(([key, item]) => `[${quoteLuau(key)}] = ${luauValue(item)}`).join(', ')} }`;
  }
  throw new Error(`Unsupported runtime graph value: ${typeof value}.`);
}

function runtimeConfig(graph: AnimationGraph, animations: RuntimeGraphAnimation[], assetIdsInput: unknown) {
  if (animations.length !== graph.states.length) throw new Error('Runtime animation metadata must have exactly one entry per graph state.');
  const metadataByState = new Map(graph.states.map((state, index) => [state.id, runtimeAnimationMetadataSchema.parse(animations[index])]));
  for (const controller of graph.states.filter(state => state.blendSpace1D || state.blendSpace2D)) {
    const controllerMetadata = metadataByState.get(controller.id)!;
    const markerSignature = (stateId: string) => metadataByState.get(stateId)!.markers
      .map(marker => ({ name: marker.name, value: marker.value ?? '', phase: marker.time / metadataByState.get(stateId)!.duration }))
      .sort((left, right) => left.phase - right.phase || left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
    const expectedMarkers = markerSignature(controller.id);
    const sourceSamples = controller.blendSpace1D?.samples ?? controller.blendSpace2D!.samples;
    for (const sample of sourceSamples) {
      const source = metadataByState.get(sample.stateId)!;
      const blendKind = controller.blendSpace1D ? 'BlendSpace1D' : 'BlendSpace2D';
      if (source.loop !== controllerMetadata.loop) throw new Error(`${blendKind} ${controller.id} source ${sample.stateId} must match the controller loop setting.`);
      if ((source.priority ?? 'Core') !== (controllerMetadata.priority ?? 'Core')) throw new Error(`${blendKind} ${controller.id} source ${sample.stateId} must match the controller animation priority.`);
      const markers = markerSignature(sample.stateId);
      if (markers.length !== expectedMarkers.length || markers.some((marker, index) => marker.name !== expectedMarkers[index]!.name
        || marker.value !== expectedMarkers[index]!.value || Math.abs(marker.phase - expectedMarkers[index]!.phase) > 1e-6)) {
        throw new Error(`${blendKind} ${controller.id} source ${sample.stateId} must have the same normalized marker layout as its controller.`);
      }
    }
  }
  const assetIds = z.record(stateId, publishedAnimationId).parse(assetIdsInput);
  const stateIds = new Set(graph.states.map(state => state.id));
  const missing = graph.states.filter(state => assetIds[state.id] === undefined).map(state => state.id);
  const unknown = Object.keys(assetIds).filter(id => !stateIds.has(id));
  if (missing.length || unknown.length) {
    const problems = [missing.length ? `Missing published animation IDs for states: ${missing.join(', ')}.` : '',
      unknown.length ? `Unknown graph states in asset ID map: ${unknown.join(', ')}.` : ''].filter(Boolean);
    throw new Error(problems.join(' '));
  }

  const states = Object.fromEntries(graph.states.map((state, index) => {
    const animation = metadataByState.get(state.id)!;
    const rawId = publishedAnimationId.parse(assetIds[state.id]!);
    const numericId = rawId.toLowerCase().startsWith('rbxassetid://') ? rawId.slice('rbxassetid://'.length) : rawId;
    const blendSamples = state.blendSpace1D?.samples ?? state.blendSpace2D?.samples;
    const trackChannels = blendSamples
      ? blendSamples.map((sample, sampleIndex) => ({
        trackId: `@blend:${state.id}:${sampleIndex + 1}`,
        sourceStateId: sample.stateId,
        eventStateId: sample.stateId === state.id ? state.id : null,
      }))
      : [{ trackId: state.id, sourceStateId: state.id, eventStateId: state.id }];
    return [state.id, {
      name: state.name,
      animationId: `rbxassetid://${numericId}`,
      speed: state.speed,
      duration: animation.duration,
      looped: animation.loop,
      priority: animation.priority ?? 'Core',
      markers: [...new Set(animation.markers.map(marker => marker.name))],
      trackChannels,
      ...(state.blendSpace1D ? { blendSpace1D: state.blendSpace1D } : {}),
      ...(state.blendSpace2D ? { blendSpace2D: { ...state.blendSpace2D, ...animationGraphBlendSpace2DTopology(state.blendSpace2D) } } : {}),
    }];
  }));
  const parameters = Object.fromEntries(graph.parameters.map(parameter => [parameter.name, {
    type: parameter.type,
    defaultValue: parameter.defaultValue,
    ...(parameter.type === 'number' ? { min: parameter.min, max: parameter.max } : {}),
  }]));
  const transitions = graph.transitions.map(transition => ({
    id: transition.id, from: transition.from, to: transition.to, trigger: transition.trigger,
    blendSeconds: transition.blendSeconds, priority: transition.priority, guards: transition.guards,
  }));
  return { entryState: graph.entryState, stateOrder: graph.states.map(state => state.id), states, parameters, transitions };
}

export function generateAnimationGraphRuntime(graphInput: unknown, animationMetadata: RuntimeGraphAnimation[], assetIdsInput: unknown) {
  const graph = animationGraphSchema.parse(graphInput);
  const baseConfig = runtimeConfig(graph, animationMetadata, assetIdsInput);
  const assetSetFingerprint = createHash('sha256').update(JSON.stringify({ graphFingerprint: animationGraphFingerprint(graph),
    animationAssetIds: Object.fromEntries(Object.entries(baseConfig.states).map(([stateId, state]) => [stateId, state.animationId])) })).digest('hex');
  const config = { ...baseConfig, assetSetFingerprint };
  const trackChannelCount = Object.values(config.states).reduce((total, state) => total + state.trackChannels.length, 0);
  const configSource = luauValue(config);
  const moduleSource = `-- Generated by Motion Tools. Review asset permissions and run on the intended server/client context.
-- Graph: ${graph.name.replace(/[\r\n]/g, ' ')}
-- Each transition is invoked with Controller:Trigger(name). Non-looping tracks also emit "AnimationEnded" after their natural end.
local CONFIG = ${configSource}
local Controller = {}
Controller.__index = Controller

local function validateParameter(name, value)
    local declaration = CONFIG.parameters[name]
    if declaration == nil then
        return false, "Unknown graph parameter: " .. tostring(name)
    end
    if declaration.type == "number" then
        if type(value) ~= "number" or value ~= value or math.abs(value) == math.huge then
            return false, "Parameter " .. name .. " must be a finite number"
        end
        if declaration.min ~= nil and value < declaration.min then
            return false, "Parameter " .. name .. " is below its minimum"
        end
        if declaration.max ~= nil and value > declaration.max then
            return false, "Parameter " .. name .. " is above its maximum"
        end
    elseif declaration.type == "boolean" then
        if type(value) ~= "boolean" then
            return false, "Parameter " .. name .. " must be a boolean"
        end
    elseif type(value) ~= "string" then
        return false, "Parameter " .. name .. " must be a string"
    end
    return true
end

local function guardMatches(guard, values)
    local observed = values[guard.parameter]
    if guard.operator == "eq" then return observed == guard.value end
    if guard.operator == "neq" then return observed ~= guard.value end
    if guard.operator == "gt" then return observed > guard.value end
    if guard.operator == "gte" then return observed >= guard.value end
    if guard.operator == "lt" then return observed < guard.value end
    if guard.operator == "lte" then return observed <= guard.value end
    return false
end

local function guardsMatch(transition, values)
    for _, guard in ipairs(transition.guards) do
        if not guardMatches(guard, values) then
            return false
        end
    end
    return true
end

local function evaluateTrigger(self, triggerName, parameterValues)
    parameterValues = parameterValues or self.parameters
    local candidates = {}
    for _, transition in ipairs(CONFIG.transitions) do
        if transition.from == self.currentState and string.lower(transition.trigger) == string.lower(triggerName) then
            table.insert(candidates, transition)
        end
    end
    table.sort(candidates, function(left, right) return left.priority > right.priority end)
    local branches, selected = {}, nil
    for _, transition in ipairs(candidates) do
        local checks, matched = {}, true
        for _, guard in ipairs(transition.guards) do
            local observed = parameterValues[guard.parameter]
            local guardMatched = guardMatches(guard, parameterValues)
            table.insert(checks, { parameter = guard.parameter, operator = guard.operator,
                expected = guard.value, observed = observed, matched = guardMatched })
            if not guardMatched then matched = false end
        end
        local branch = { transitionId = transition.id, from = transition.from, to = transition.to,
            trigger = transition.trigger, priority = transition.priority, blendSeconds = transition.blendSeconds,
            matched = matched, checks = checks }
        table.insert(branches, branch)
        if matched and selected == nil then selected = branch end
    end
    local destinationLoaded, noTransitionReason = nil, nil
    if selected then
        destinationLoaded = self:IsStateLoaded(selected.to)
        selected.destinationLoaded = destinationLoaded
    else
        noTransitionReason = #candidates == 0 and "no_transition_for_state_and_trigger" or "all_candidate_guards_failed"
    end
    return {
        currentState = self.currentState,
        trigger = triggerName,
        selectedTransition = selected,
        branches = branches,
        destinationLoaded = destinationLoaded,
        noTransitionReason = noTransitionReason,
    }
end

local function connectStateSignals(self, stateId, track, state)
    if not state.looped then
        table.insert(self.connections, track.Ended:Connect(function()
            if not self.destroyed and self.currentState == stateId and not track.IsPlaying then
                self:Trigger("AnimationEnded")
            end
        end))
    end
    for _, markerName in ipairs(state.markers) do
        table.insert(self.connections, track:GetMarkerReachedSignal(markerName):Connect(function(markerValue)
            if self.destroyed or self.currentState ~= stateId then return end
            local subscribers = self.markerCallbacks[markerName]
            if subscribers then
                for _, subscriber in ipairs(subscribers) do
                    if subscriber.connected then
                        local ok, callbackError = pcall(subscriber.callback, markerName, markerValue, stateId)
                        if not ok then warn("Motion Tools marker callback failed: " .. tostring(callbackError)) end
                    end
                end
            end
            if not self.destroyed and self.currentState == stateId then
                self:Trigger(markerName)
            end
        end))
    end
end

local loadTrack

local function stateTrackIds(stateId)
    local state = CONFIG.states[stateId]
    local result = {}
    for _, channel in ipairs(state.trackChannels) do table.insert(result, channel.trackId) end
    return result
end

local function loadGraphStateTracks(self, stateId)
    local loaded, tracks = {}, {}
    for _, channel in ipairs(CONFIG.states[stateId].trackChannels) do
        local track, loadError = loadTrack(self, channel.trackId, channel.sourceStateId, channel.eventStateId)
        if not track then return nil, { stateId = channel.sourceStateId, error = loadError, loadedStateIds = loaded } end
        table.insert(loaded, channel.sourceStateId)
        table.insert(tracks, track)
    end
    return tracks, { loadedStateIds = loaded }
end

local function interpolationAlpha(value, lower, upper)
    local span = upper - lower
    if span ~= math.huge then return (value - lower) / span end
    local scale = math.max(math.abs(value), math.abs(lower), math.abs(upper))
    return (value / scale - lower / scale) / (upper / scale - lower / scale)
end

local function blendWeights(state, parameters)
    local blend = state.blendSpace1D or state.blendSpace2D
    if blend == nil then return nil end
    local samples = blend.samples
    local weights = {}
    for _, sample in ipairs(samples) do weights[sample.stateId] = 0 end
    if state.blendSpace1D ~= nil then
        local value = parameters[blend.parameter]
        local minimum, maximum = samples[1].value, samples[#samples].value
        value = math.max(minimum, math.min(maximum, value))
        if value <= minimum then
            weights[samples[1].stateId] = 1
        elseif value >= maximum then
            weights[samples[#samples].stateId] = 1
        else
            for index = 2, #samples do
                local upper = samples[index]
                if value <= upper.value then
                    local lower = samples[index - 1]
                    local alpha = interpolationAlpha(value, lower.value, upper.value)
                    weights[lower.stateId] = 1 - alpha
                    weights[upper.stateId] = alpha
                    break
                end
            end
        end
        return weights
    end
    local x, y = parameters[blend.xParameter], parameters[blend.yParameter]
    local positionByState = {}
    -- Keep triangle calculations local: global normalization can erase tightly
    -- clustered samples when an unrelated sample is a distant finite outlier.
    for _, sample in ipairs(samples) do
        positionByState[sample.stateId] = sample
    end
    local function triangleWeights(a, b, c, point)
        local magnitude = math.max(math.abs(a.x), math.abs(a.y), math.abs(b.x), math.abs(b.y),
            math.abs(c.x), math.abs(c.y), math.abs(point.x), math.abs(point.y))
        local coordinateScale = magnitude > 8.9e307 and 0.5 or 1
        local abx, aby = b.x * coordinateScale - a.x * coordinateScale, b.y * coordinateScale - a.y * coordinateScale
        local acx, acy = c.x * coordinateScale - a.x * coordinateScale, c.y * coordinateScale - a.y * coordinateScale
        local apx, apy = point.x * coordinateScale - a.x * coordinateScale, point.y * coordinateScale - a.y * coordinateScale
        -- Independent axis scales preserve skinny triangles without overflowing
        -- cross products; all three barycentric determinants share these scales.
        local xScale = math.max(math.abs(abx), math.abs(acx), math.abs(apx))
        local yScale = math.max(math.abs(aby), math.abs(acy), math.abs(apy))
        if xScale == 0 or yScale == 0 then return nil end
        abx, acx, apx = abx / xScale, acx / xScale, apx / xScale
        aby, acy, apy = aby / yScale, acy / yScale, apy / yScale
        local denominator = abx * acy - aby * acx
        if denominator == 0 then return nil end
        local wb = (apx * acy - apy * acx) / denominator
        local wc = (abx * apy - aby * apx) / denominator
        local wa = 1 - wb - wc
        if wa < -1e-10 or wb < -1e-10 or wc < -1e-10 then return nil end
        local ca, cb, cc = math.max(0, wa), math.max(0, wb), math.max(0, wc)
        local total = ca + cb + cc
        if total == 0 then return nil end
        return { ca / total, cb / total, cc / total }
    end
    local selected = nil
    for _, triangle in ipairs(blend.triangles) do
        local a, b, c = positionByState[triangle[1]], positionByState[triangle[2]], positionByState[triangle[3]]
        local point = { x = x, y = y }
        local barycentric = triangleWeights(a, b, c, point)
        if barycentric then
            selected = { { triangle[1], barycentric[1] }, { triangle[2], barycentric[2] }, { triangle[3], barycentric[3] } }
            break
        end
    end
    if selected then
        for _, contribution in ipairs(selected) do weights[contribution[1]] = contribution[2] end
        return weights
    end
    local bestDistanceScale, bestDistanceSquared, bestTie, bestWeights = nil, nil, nil, nil
    for _, edge in ipairs(blend.hullEdges) do
        local a, b = positionByState[edge[1]], positionByState[edge[2]]
        local point = { x = x, y = y }
        local magnitude = math.max(math.abs(a.x), math.abs(a.y), math.abs(b.x), math.abs(b.y), math.abs(x), math.abs(y))
        local coordinateScale = magnitude > 8.9e307 and 0.5 or 1
        local na = { x = a.x * coordinateScale, y = a.y * coordinateScale }
        local nb = { x = b.x * coordinateScale, y = b.y * coordinateScale }
        point = { x = x * coordinateScale, y = y * coordinateScale }
        local dx, dy = nb.x - na.x, nb.y - na.y
        local qx, qy = point.x - na.x, point.y - na.y
        local vectorScale = math.max(math.abs(dx), math.abs(dy), math.abs(qx), math.abs(qy))
        if vectorScale == 0 then vectorScale = 1 end
        dx, dy, qx, qy = dx / vectorScale, dy / vectorScale, qx / vectorScale, qy / vectorScale
        local lengthSquared = dx * dx + dy * dy
        local alpha = lengthSquared == 0 and 0 or math.max(0, math.min(1, (qx * dx + qy * dy) / lengthSquared))
        local closestX, closestY = dx * alpha, dy * alpha
        local distance = (qx - closestX) ^ 2 + (qy - closestY) ^ 2
        local distanceScale = vectorScale / coordinateScale
        local tie = edge[1] < edge[2] and edge[1] .. ":" .. edge[2] or edge[2] .. ":" .. edge[1]
        local closer, tied = bestDistanceScale == nil, false
        if bestDistanceScale ~= nil then
            local comparableDistance, comparableBest
            if distanceScale >= bestDistanceScale then
                local ratio = bestDistanceScale / distanceScale
                comparableDistance, comparableBest = distance, bestDistanceSquared * ratio * ratio
            else
                local ratio = distanceScale / bestDistanceScale
                comparableDistance, comparableBest = distance * ratio * ratio, bestDistanceSquared
            end
            local tolerance = 1e-14 * math.max(math.abs(comparableDistance), math.abs(comparableBest), 1e-300)
            closer = comparableDistance < comparableBest - tolerance
            tied = math.abs(comparableDistance - comparableBest) <= tolerance
        end
        if closer or (tied and (bestTie == nil or tie < bestTie)) then
            bestDistanceScale, bestDistanceSquared, bestTie = distanceScale, distance, tie
            bestWeights = { { edge[1], 1 - alpha }, { edge[2], alpha } }
        end
    end
    for _, contribution in ipairs(bestWeights) do weights[contribution[1]] = contribution[2] end
    return weights
end

local function playbackSpecs(stateId, parameters, synchronizedBlendPlayback, playbackSpeedMultiplier)
    local state = CONFIG.states[stateId]
    local weights = blendWeights(state, parameters)
    if weights == nil then return { { trackId = state.trackChannels[1].trackId, sourceStateId = stateId, weight = 1,
        speed = state.speed * playbackSpeedMultiplier } } end
    local specs = {}
    local synchronizedSpeeds = synchronizedBlendPlayback and synchronizedBlendPlayback[stateId]
    local blend = state.blendSpace1D or state.blendSpace2D
    for index, sample in ipairs(blend.samples) do
        local source = CONFIG.states[sample.stateId]
        table.insert(specs, { trackId = state.trackChannels[index].trackId, sourceStateId = sample.stateId, weight = weights[sample.stateId],
            speed = (synchronizedSpeeds and synchronizedSpeeds[sample.stateId]
                or state.speed * source.duration / state.duration) * playbackSpeedMultiplier })
    end
    return specs
end

local function playGraphState(self, stateId, fadeSeconds)
    local attemptedTrackIds = {}
    for _, spec in ipairs(playbackSpecs(stateId, self.parameters, self.synchronizedBlendPlayback, self.playbackSpeedMultiplier)) do
        local track = self.tracks[spec.trackId]
        if not track then return false, { error = "Animation track is not loaded: " .. spec.trackId,
            stateId = spec.sourceStateId, attemptedTrackIds = attemptedTrackIds } end
        -- Roblox controls how Play affects an already-playing track; never Stop(0) before reusing it.
        table.insert(attemptedTrackIds, spec.trackId)
        local ok, playError = pcall(function() track:Play(fadeSeconds, spec.weight, spec.speed) end)
        if not ok then return false, { error = tostring(playError), stateId = spec.sourceStateId,
            attemptedTrackIds = attemptedTrackIds } end
    end
    return true
end

local function updateCurrentBlendWeights(self, parameters)
    local state = self.currentState and CONFIG.states[self.currentState]
    if not state or (state.blendSpace1D == nil and state.blendSpace2D == nil) then return true end
    local fadeRemaining = self.currentStateFadeEnd and math.max(0, self.currentStateFadeEnd - os.clock()) or 0
    if fadeRemaining == 0 then self.currentStateFadeEnd = nil end
    local previousWeights = {}
    for _, spec in ipairs(playbackSpecs(self.currentState, self.parameters, self.synchronizedBlendPlayback, self.playbackSpeedMultiplier)) do previousWeights[spec.trackId] = spec.weight end
    local normalizedPhase = nil
    local normalizedPhaseSourceStateId = nil
    for _, spec in ipairs(playbackSpecs(self.currentState, self.parameters, self.synchronizedBlendPlayback, self.playbackSpeedMultiplier)) do
        local track, source = self.tracks[spec.trackId], CONFIG.states[spec.sourceStateId]
        local trackLength = track and track.Length or nil
        local phaseDuration = trackLength and trackLength > 0 and trackLength or source.duration
        if track and track.IsPlaying and phaseDuration > 0 then
            normalizedPhase = (track.TimePosition % phaseDuration) / phaseDuration
            normalizedPhaseSourceStateId = spec.sourceStateId
            break
        end
    end
    local attemptedTrackIds, changedTrackIds, startedTrackIds = {}, {}, {}
    for _, spec in ipairs(playbackSpecs(self.currentState, parameters, self.synchronizedBlendPlayback, self.playbackSpeedMultiplier)) do
        local track = self.tracks[spec.trackId]
        if track then
            table.insert(attemptedTrackIds, spec.trackId)
            local ok, operationError = pcall(function()
                if track.IsPlaying then
                    track:AdjustWeight(spec.weight, fadeRemaining)
                elseif spec.weight > 0 then
                    if normalizedPhase == nil then error("Cannot restart a BlendSpace channel because no source playback clock is still running") end
                    track:Play(fadeRemaining, spec.weight, spec.speed)
                    table.insert(startedTrackIds, spec.trackId)
                    local source = CONFIG.states[spec.sourceStateId]
                    local trackLength = track.Length
                    local phaseDuration = trackLength and trackLength > 0 and trackLength or source.duration
                    if phaseDuration > 0 then track.TimePosition = normalizedPhase * phaseDuration end
                end
            end)
            if not ok then
                local restoredTrackIds, rollbackFailures = {}, {}
                for index = #attemptedTrackIds, 1, -1 do
                    local trackId = attemptedTrackIds[index]
                    local previousTrack = self.tracks[trackId]
                    local restored, restoreError = pcall(function()
                        if table.find(startedTrackIds, trackId) then
                            previousTrack:Stop(math.max(fadeRemaining, 1 / 60))
                        elseif previousTrack.IsPlaying then
                            previousTrack:AdjustWeight(previousWeights[trackId], fadeRemaining)
                        end
                    end)
                    local sourceStateId = self.trackSourceStateIds[trackId]
                    if restored then table.insert(restoredTrackIds, sourceStateId)
                    else table.insert(rollbackFailures, { stateId = sourceStateId, error = tostring(restoreError) }) end
                end
                local attemptedStateIds = {}
                local restartedStateIds = {}
                for _, trackId in ipairs(attemptedTrackIds) do table.insert(attemptedStateIds, self.trackSourceStateIds[trackId]) end
                for _, trackId in ipairs(startedTrackIds) do table.insert(restartedStateIds, self.trackSourceStateIds[trackId]) end
                return false, { reason = track.IsPlaying and "blend_weight_update_failed" or "blend_channel_restart_failed",
                    stateId = spec.sourceStateId, error = tostring(operationError), attemptedStateIds = attemptedStateIds,
                    restartedStateIds = restartedStateIds, phaseSourceStateId = normalizedPhaseSourceStateId,
                    restoredStateIds = restoredTrackIds, rollbackFailures = rollbackFailures }
            end
            if spec.weight > 0 or track.IsPlaying then table.insert(changedTrackIds, spec.sourceStateId) end
        end
    end
    local restartedStateIds = {}
    for _, trackId in ipairs(startedTrackIds) do table.insert(restartedStateIds, self.trackSourceStateIds[trackId]) end
    return true, { updatedStateIds = changedTrackIds, restartedStateIds = restartedStateIds,
        phaseSourceStateId = normalizedPhaseSourceStateId }
end

loadTrack = function(self, trackId, sourceStateId, eventStateId)
    local state = CONFIG.states[sourceStateId]
    if not state then return nil, "Unknown graph state: " .. tostring(sourceStateId) end
    if self.tracks[trackId] then return self.tracks[trackId] end
    if self.destroyed then return nil, "Controller is destroyed" end
    if not self.animator:IsDescendantOf(game:GetService("Workspace")) then
        return nil, "Animator is no longer in Workspace"
    end
    local animation = Instance.new("Animation")
    animation.Name = trackId
    animation.AnimationId = state.animationId
    local ok, trackOrError = pcall(function()
        return self.animator:LoadAnimation(animation)
    end)
    if not ok then
        animation:Destroy()
        return nil, tostring(trackOrError)
    end
    local track = trackOrError
    local configured, configurationError = pcall(function()
        track.Looped = state.looped
        track.Priority = Enum.AnimationPriority[state.priority]
    end)
    if not configured then
        track:Stop(0)
        track:Destroy()
        animation:Destroy()
        return nil, tostring(configurationError)
    end
    self.animations[trackId] = animation
    self.tracks[trackId] = track
    self.trackSourceStateIds[trackId] = sourceStateId
    if eventStateId ~= nil then connectStateSignals(self, eventStateId, track, CONFIG.states[eventStateId]) end
    return track
end

local function validateOptions(options)
    if options == nil then return { preloadAll = false } end
    assert(type(options) == "table", "Controller options must be a table")
    for name in pairs(options) do
        assert(name == "preloadAll", "Unknown Controller option: " .. tostring(name))
    end
    local preloadAll = options.preloadAll
    assert(preloadAll == nil or type(preloadAll) == "boolean", "options.preloadAll must be a boolean")
    return { preloadAll = preloadAll == true }
end

function Controller.new(animator, options)
    assert(typeof(animator) == "Instance" and animator:IsA("Animator"), "Controller.new expects an Animator")
    assert(animator:IsDescendantOf(game:GetService("Workspace")), "Animator must be in Workspace before animations are loaded")
    local normalizedOptions = validateOptions(options)

    local self = setmetatable({
        animator = animator,
        tracks = {},
        animations = {},
        trackSourceStateIds = {},
        connections = {},
        markerCallbacks = {},
        parameters = {},
        playbackSpeedMultiplier = 1,
        currentState = nil,
        currentStateFadeEnd = nil,
        synchronizedBlendPlayback = {},
        destroyed = false,
    }, Controller)
    for name, declaration in pairs(CONFIG.parameters) do
        self.parameters[name] = declaration.defaultValue
    end

    table.insert(self.connections, animator.AncestryChanged:Connect(function()
        if not self.destroyed and not animator:IsDescendantOf(game:GetService("Workspace")) then
            self:Destroy()
        end
    end))
    self.currentState = CONFIG.entryState
    local entryTracks, entryError = loadGraphStateTracks(self, self.currentState)
    if not entryTracks then
        self:Destroy()
        error("Could not load entry animation state: " .. tostring(entryError), 2)
    end
    if normalizedOptions.preloadAll then
        local preloaded, preloadResult = self:Preload()
        if not preloaded then
            self:Destroy()
            error("Could not preload animation graph: " .. tostring(preloadResult.error), 2)
        end
    end
    local entryPlayed, entryPlayError = playGraphState(self, self.currentState, 0)
    if not entryPlayed then
        self:Destroy()
        error("Could not play entry animation state: " .. tostring(entryPlayError.error), 2)
    end
    return self
end

function Controller:Preload(stateIds)
    if self.destroyed then return false, { reason = "controller_destroyed", loadedStateIds = {} } end
    local requested = {}
    if stateIds == nil then
        requested = CONFIG.stateOrder
    elseif type(stateIds) == "string" then
        requested = { stateIds }
    elseif type(stateIds) == "table" then
        requested = stateIds
    else
        return false, { reason = "state_ids_must_be_an_array", loadedStateIds = {} }
    end
    local requestedCount, maximumIndex = 0, 0
    for index in pairs(requested) do
        if type(index) ~= "number" or index < 1 or index % 1 ~= 0 then
            return false, { reason = "state_ids_must_be_an_array", loadedStateIds = {} }
        end
        requestedCount += 1
        if index > maximumIndex then maximumIndex = index end
    end
    if requestedCount ~= maximumIndex then
        return false, { reason = "state_ids_must_be_a_dense_array", loadedStateIds = {} }
    end
    local unique, normalized = {}, {}
    for index, stateId in ipairs(requested) do
        if type(stateId) ~= "string" or CONFIG.states[stateId] == nil then
            return false, { reason = "unknown_state", stateId = stateId, loadedStateIds = {} }
        end
        if unique[stateId] then
            return false, { reason = "duplicate_state", stateId = stateId, loadedStateIds = {} }
        end
        unique[stateId] = true
        normalized[index] = stateId
    end
    local loaded = {}
    for _, stateId in ipairs(normalized) do
        local tracks, loadResult = loadGraphStateTracks(self, stateId)
        if not tracks then
            return false, { reason = "animation_load_failed", stateId = loadResult.stateId,
                error = loadResult.error, loadedStateIds = loaded }
        end
        table.insert(loaded, stateId)
    end
    return true, loaded
end

function Controller:GetLoadedStateIds()
    local loaded = {}
    for _, stateId in ipairs(CONFIG.stateOrder) do
        if self:IsStateLoaded(stateId) then table.insert(loaded, stateId) end
    end
    return loaded
end

function Controller:IsStateLoaded(stateId)
    if CONFIG.states[stateId] == nil then return false end
    for _, trackId in ipairs(stateTrackIds(stateId)) do
        if self.tracks[trackId] == nil then return false end
    end
    return true
end

function Controller:GetState()
    return self.currentState
end

function Controller:GetPlaybackSpeed()
    return self.playbackSpeedMultiplier
end

function Controller:EvaluateTrigger(triggerName)
    if self.destroyed then return nil, { reason = "controller_destroyed" } end
    if type(triggerName) ~= "string" or triggerName == "" then
        return nil, { reason = "invalid_trigger" }
    end
    return evaluateTrigger(self, triggerName)
end

function Controller:GetAvailableTriggers()
    if self.destroyed then return nil, { reason = "controller_destroyed" } end
    local triggerNames, seen = {}, {}
    for _, transition in ipairs(CONFIG.transitions) do
        if transition.from == self.currentState then
            local key = string.lower(transition.trigger)
            if not seen[key] then
                seen[key] = true
                table.insert(triggerNames, transition.trigger)
            end
        end
    end
    table.sort(triggerNames, function(left, right) return string.lower(left) < string.lower(right) end)
    local evaluated = {}
    for _, triggerName in ipairs(triggerNames) do
        table.insert(evaluated, evaluateTrigger(self, triggerName))
    end
    return evaluated
end

function Controller:GetParameter(name)
    if CONFIG.parameters[name] == nil then return nil end
    return self.parameters[name]
end

function Controller:GetBlendState()
    if self.destroyed then return nil, { reason = "controller_destroyed" } end
    local state = self.currentState and CONFIG.states[self.currentState]
    if not state or (state.blendSpace1D == nil and state.blendSpace2D == nil) then
        return nil, { reason = "current_state_not_blended", stateId = self.currentState }
    end
    local blend = state.blendSpace1D or state.blendSpace2D
    local parameterValue, sampledValue, clamped, parameterNames
    if state.blendSpace1D ~= nil then
        parameterValue = self.parameters[blend.parameter]
        local firstValue, lastValue = blend.samples[1].value, blend.samples[#blend.samples].value
        sampledValue = math.max(firstValue, math.min(lastValue, parameterValue))
        clamped = sampledValue ~= parameterValue
        parameterNames = { x = blend.parameter }
    else
        parameterValue = { x = self.parameters[blend.xParameter], y = self.parameters[blend.yParameter] }
        parameterNames = { x = blend.xParameter, y = blend.yParameter }
        local weights = blendWeights(state, self.parameters)
        sampledValue = { x = 0, y = 0 }
        for _, sample in ipairs(blend.samples) do
            sampledValue.x += sample.x * weights[sample.stateId]
            sampledValue.y += sample.y * weights[sample.stateId]
        end
        clamped = math.abs(sampledValue.x - parameterValue.x) > 1e-10 or math.abs(sampledValue.y - parameterValue.y) > 1e-10
    end
    local expectedWeights = blendWeights(state, self.parameters)
    local playbackByState = {}
    for _, spec in ipairs(playbackSpecs(self.currentState, self.parameters, self.synchronizedBlendPlayback, self.playbackSpeedMultiplier)) do playbackByState[spec.sourceStateId] = spec end
    local samples, phaseSamples, totalCurrentWeight, totalTargetWeight = {}, {}, 0, 0
    local observedLengthsByStateId, observedSpeedsByStateId, observedPhasesByStateId, animationIdsByStateId, unavailableLengthStateIds, unavailableSpeedStateIds, unavailableObservedStartPhaseStateIds = {}, {}, {}, {}, {}, {}, {}
    for index, sample in ipairs(blend.samples) do
        local track = self.tracks[state.trackChannels[index].trackId]
        local sourceState = CONFIG.states[sample.stateId]
        local playback = playbackByState[sample.stateId]
        local observedLength = track and track.Length or nil
        local observedTime = track and track.TimePosition or nil
        local currentWeight = track and track.WeightCurrent or nil
        local targetWeight = track and track.WeightTarget or nil
        if currentWeight ~= nil then totalCurrentWeight += currentWeight end
        if targetWeight ~= nil then totalTargetWeight += targetWeight end
        local normalizedPhase = observedLength and observedLength > 0 and observedTime
            and (observedTime % observedLength) / observedLength or nil
        animationIdsByStateId[sample.stateId] = sourceState.animationId
        if observedLength ~= nil and observedLength > 0 then
            observedLengthsByStateId[sample.stateId] = observedLength
            if normalizedPhase ~= nil then
                observedPhasesByStateId[sample.stateId] = normalizedPhase
            else
                table.insert(unavailableObservedStartPhaseStateIds, sample.stateId)
            end
            if track and track.Speed ~= nil and track.Speed > 0 then
                observedSpeedsByStateId[sample.stateId] = track.Speed
            else
                table.insert(unavailableSpeedStateIds, sample.stateId)
            end
        else
            table.insert(unavailableLengthStateIds, sample.stateId)
            table.insert(unavailableSpeedStateIds, sample.stateId)
            table.insert(unavailableObservedStartPhaseStateIds, sample.stateId)
        end
        table.insert(samples, { stateId = sample.stateId, animationId = sourceState.animationId,
            value = sample.value or { x = sample.x, y = sample.y },
            expectedWeight = expectedWeights[sample.stateId],
            currentWeight = currentWeight, targetWeight = targetWeight, isPlaying = track ~= nil and track.IsPlaying,
            authoredStateSpeed = sourceState.speed, effectivePlaybackSpeed = playback.speed,
            observedPlaybackSpeed = track and track.Speed or nil,
            observedLengthSeconds = observedLength and observedLength > 0 and observedLength or nil,
            observedTimeSeconds = observedTime,
            observedNormalizedPhase = normalizedPhase,
            authoredSpeedOverridden = math.abs(sourceState.speed - playback.speed) > 1e-9,
            loaded = track ~= nil })
        if track ~= nil and track.IsPlaying and normalizedPhase ~= nil then
            table.insert(phaseSamples, { stateId = sample.stateId, phase = normalizedPhase })
        end
    end
    local maxCircularPhaseDifference, worstPair = 0, nil
    for leftIndex = 1, #phaseSamples do
        for rightIndex = leftIndex + 1, #phaseSamples do
            local left, right = phaseSamples[leftIndex], phaseSamples[rightIndex]
            local difference = math.abs(left.phase - right.phase)
            difference = math.min(difference, 1 - difference)
            if worstPair == nil or difference > maxCircularPhaseDifference then
                maxCircularPhaseDifference = difference
                worstPair = { firstStateId = left.stateId, secondStateId = right.stateId }
            end
        end
    end
    local unavailablePhaseStateIds = {}
    for _, sample in ipairs(samples) do
        if not (sample.isPlaying and sample.observedNormalizedPhase ~= nil) then
            table.insert(unavailablePhaseStateIds, sample.stateId)
        end
    end
    local phaseSync = { observedCount = #phaseSamples, requiredCount = #samples,
        complete = #phaseSamples == #samples,
        maxCircularPhaseDifference = #phaseSamples > 0 and maxCircularPhaseDifference or nil,
        worstPair = worstPair, unavailableStateIds = unavailablePhaseStateIds }
    local unavailableStartPhaseStateIds, unavailableStartPhaseSet = {}, {}
    for _, stateId in ipairs(unavailableObservedStartPhaseStateIds) do unavailableStartPhaseSet[stateId] = true end
    for _, stateId in ipairs(unavailablePhaseStateIds) do unavailableStartPhaseSet[stateId] = true end
    for _, sample in ipairs(samples) do
        if unavailableStartPhaseSet[sample.stateId] then table.insert(unavailableStartPhaseStateIds, sample.stateId) end
    end
    local timingCalibration = { ready = #unavailableLengthStateIds == 0 and #unavailableSpeedStateIds == 0, controllerStateId = self.currentState,
        assetSetFingerprint = CONFIG.assetSetFingerprint, animationIdsByStateId = animationIdsByStateId,
        unavailableStateIds = unavailableLengthStateIds,
        unavailablePlaybackSpeedStateIds = unavailableSpeedStateIds,
        unavailableStartPhaseStateIds = unavailableStartPhaseStateIds,
        observedBlendAnimationLengths = #unavailableLengthStateIds == 0 and #unavailableSpeedStateIds == 0
            and { [self.currentState] = observedLengthsByStateId } or nil,
        observedBlendAnimationPlaybackSpeeds = #unavailableLengthStateIds == 0 and #unavailableSpeedStateIds == 0
            and { [self.currentState] = observedSpeedsByStateId } or nil,
        observedBlendAnimationStartPhases = #unavailableStartPhaseStateIds == 0
            and { [self.currentState] = observedPhasesByStateId } or nil }
    return { stateId = self.currentState, parameter = state.blendSpace1D and blend.parameter or parameterNames,
        parameterValue = parameterValue, sampledValue = sampledValue,
        clamped = clamped, samples = samples, totalCurrentWeight = totalCurrentWeight,
        totalTargetWeight = totalTargetWeight, phaseSync = phaseSync, simulationTimingCalibration = timingCalibration }
end

function Controller:SynchronizeBlendPlayback()
    if self.destroyed then return false, { reason = "controller_destroyed" } end
    local state = self.currentState and CONFIG.states[self.currentState]
    if not state or (state.blendSpace1D == nil and state.blendSpace2D == nil) then
        return false, { reason = "current_state_not_blended", stateId = self.currentState }
    end
    local channels, missingStateIds = {}, {}
    local blend = state.blendSpace1D or state.blendSpace2D
    for index, sample in ipairs(blend.samples) do
        local track = self.tracks[state.trackChannels[index].trackId]
        local length = track and track.Length or nil
        if not track or not track.IsPlaying or length == nil or length <= 0 then
            table.insert(missingStateIds, sample.stateId)
        else
            table.insert(channels, { stateId = sample.stateId, track = track, length = length,
                previousSpeed = track.Speed, previousTime = track.TimePosition })
        end
    end
    if #missingStateIds > 0 then
        return false, { reason = "blend_playback_not_ready", unavailableStateIds = missingStateIds }
    end
    local anchor = channels[1]
    if anchor.previousSpeed == nil or anchor.previousSpeed <= 0 then
        return false, { reason = "blend_anchor_speed_not_positive", stateId = anchor.stateId, speed = anchor.previousSpeed }
    end
    local anchorPhase = (anchor.previousTime % anchor.length) / anchor.length
    local plans = {}
    for _, channel in ipairs(channels) do
        local targetSpeed = state.speed * self.playbackSpeedMultiplier * channel.length / anchor.length
        if targetSpeed ~= targetSpeed or targetSpeed <= 0 or targetSpeed == math.huge then
            return false, { reason = "invalid_synchronized_speed", stateId = channel.stateId, speed = targetSpeed }
        end
        table.insert(plans, { stateId = channel.stateId, track = channel.track, length = channel.length,
            previousSpeed = channel.previousSpeed, previousTime = channel.previousTime,
            targetSpeed = targetSpeed, targetTime = anchorPhase * channel.length })
    end
    local applied, rollbackFailures = {}, {}
    for _, plan in ipairs(plans) do
        table.insert(applied, plan)
        local ok, operationError = pcall(function()
            plan.track:AdjustSpeed(plan.targetSpeed)
            plan.track.TimePosition = plan.targetTime
        end)
        if not ok then
            for index = #applied, 1, -1 do
                local previous = applied[index]
                local restored, restoreError = pcall(function()
                    previous.track:AdjustSpeed(previous.previousSpeed)
                    previous.track.TimePosition = previous.previousTime
                end)
                if not restored then
                    table.insert(rollbackFailures, { stateId = previous.stateId, error = tostring(restoreError) })
                end
            end
            return false, { reason = "blend_playback_sync_failed", stateId = plan.stateId,
                error = tostring(operationError), synchronizedStateIds = {}, rollbackFailures = rollbackFailures }
        end
    end
    self.synchronizedBlendPlayback[self.currentState] = {}
    for _, plan in ipairs(plans) do
        self.synchronizedBlendPlayback[self.currentState][plan.stateId] = plan.targetSpeed / self.playbackSpeedMultiplier
    end
    local synchronizedStateIds, speedChanges = {}, {}
    for _, plan in ipairs(plans) do
        table.insert(synchronizedStateIds, plan.stateId)
        table.insert(speedChanges, { stateId = plan.stateId, previousSpeed = plan.previousSpeed, speed = plan.targetSpeed,
            previousTimeSeconds = plan.previousTime, timeSeconds = plan.targetTime, lengthSeconds = plan.length })
    end
    return true, { anchorStateId = anchor.stateId, normalizedPhase = anchorPhase,
        synchronizedStateIds = synchronizedStateIds, speedChanges = speedChanges }
end

function Controller:ConnectMarker(markerName, callback)
    if self.destroyed then return nil, "Controller is destroyed" end
    if type(markerName) ~= "string" or markerName == "" or type(callback) ~= "function" then
        return nil, "ConnectMarker expects a marker name and callback"
    end
    local knownMarker = false
    for _, state in pairs(CONFIG.states) do
        for _, declaredName in ipairs(state.markers) do
            if declaredName == markerName then knownMarker = true; break end
        end
        if knownMarker then break end
    end
    if not knownMarker then return nil, "Unknown animation marker: " .. markerName end
    local subscribers = self.markerCallbacks[markerName]
    if not subscribers then
        subscribers = {}
        self.markerCallbacks[markerName] = subscribers
    end
    local subscription = { callback = callback, connected = true }
    table.insert(subscribers, subscription)
    return {
        Disconnect = function()
            if not subscription.connected then return end
            subscription.connected = false
            for index, candidate in ipairs(subscribers) do
                if candidate == subscription then table.remove(subscribers, index); break end
            end
        end,
    }
end

function Controller:SetParameter(name, value)
    if self.destroyed then return false, "Controller is destroyed" end
    local valid, reason = validateParameter(name, value)
    if not valid then return false, reason end
    local proposed = {}
    for parameterName, parameterValue in pairs(self.parameters) do proposed[parameterName] = parameterValue end
    proposed[name] = value
    local updated, result = updateCurrentBlendWeights(self, proposed)
    if not updated then return false, result end
    self.parameters[name] = value
    return true, result
end

function Controller:SetParameters(values)
    if self.destroyed then return false, "Controller is destroyed" end
    if type(values) ~= "table" then return false, "Parameter updates must be a table" end
    local updates = {}
    for name, value in pairs(values) do
        local valid, reason = validateParameter(name, value)
        if not valid then return false, reason end
        updates[name] = value
    end
    local proposed = {}
    for name, value in pairs(self.parameters) do proposed[name] = value end
    for name, value in pairs(updates) do proposed[name] = value end
    local updated, result = updateCurrentBlendWeights(self, proposed)
    if not updated then return false, result end
    for name, value in pairs(updates) do self.parameters[name] = value end
    return true, result
end

function Controller:SetPlaybackSpeed(multiplier)
    if self.destroyed then return false, { reason = "controller_destroyed" } end
    if type(multiplier) ~= "number" or multiplier ~= multiplier or multiplier < 0.1 or multiplier > 4 then
        return false, { reason = "invalid_playback_speed", minimum = 0.1, maximum = 4 }
    end
    local specs = playbackSpecs(self.currentState, self.parameters, self.synchronizedBlendPlayback, self.playbackSpeedMultiplier)
    local planned = {}
    for _, spec in ipairs(specs) do
        local track = self.tracks[spec.trackId]
        if not track then
            return false, { reason = "active_track_not_loaded", stateId = spec.sourceStateId, trackId = spec.trackId,
                attemptedStateIds = {}, restoredStateIds = {}, rollbackFailures = {} }
        end
        table.insert(planned, { spec = spec, track = track,
            previousSpeed = track.Speed,
            targetSpeed = spec.speed / self.playbackSpeedMultiplier * multiplier })
    end
    local applied, changes = {}, {}
    for _, plan in ipairs(planned) do
        local spec, track = plan.spec, plan.track
        table.insert(applied, { track = track, stateId = spec.sourceStateId, previousSpeed = plan.previousSpeed })
        local ok, operationError = pcall(function() track:AdjustSpeed(plan.targetSpeed) end)
        if not ok then
            local restoredStateIds, rollbackFailures = {}, {}
            for index = #applied, 1, -1 do
                local previous = applied[index]
                local restored, restoreError = pcall(function() previous.track:AdjustSpeed(previous.previousSpeed) end)
                if restored then table.insert(restoredStateIds, previous.stateId)
                else table.insert(rollbackFailures, { stateId = previous.stateId, error = tostring(restoreError) }) end
            end
            local attemptedStateIds = {}
            for _, previous in ipairs(applied) do table.insert(attemptedStateIds, previous.stateId) end
            return false, { reason = "playback_speed_update_failed", stateId = spec.sourceStateId,
                error = tostring(operationError), attemptedStateIds = attemptedStateIds,
                restoredStateIds = restoredStateIds, rollbackFailures = rollbackFailures }
        end
        table.insert(changes, { stateId = spec.sourceStateId, previousSpeed = plan.previousSpeed, speed = plan.targetSpeed })
    end
    self.playbackSpeedMultiplier = multiplier
    return true, { multiplier = multiplier, changedStateIds = changes }
end

local function triggerWithUpdates(self, triggerName, updates, expectedTransitionId)
    if self.destroyed then return false, { reason = "controller_destroyed" } end
    if type(triggerName) ~= "string" or triggerName == "" then
        return false, { reason = "invalid_trigger" }
    end
    local evaluationValues = {}
    local previousParameters = {}
    for name, value in pairs(self.parameters) do evaluationValues[name] = value; previousParameters[name] = value end
    for name, value in pairs(updates) do evaluationValues[name] = value end
    local evaluation = evaluateTrigger(self, triggerName, evaluationValues)
    local selected = evaluation.selectedTransition
    if selected == nil then return false, evaluation end
    if expectedTransitionId ~= nil and selected.transitionId ~= expectedTransitionId then
        evaluation.reason = "selected_transition_mismatch"
        evaluation.expectedTransitionId = expectedTransitionId
        return false, evaluation
    end
    local chosen = nil
    for _, transition in ipairs(CONFIG.transitions) do
        if transition.id == selected.transitionId then chosen = transition; break end
    end

    local previousState = self.currentState
    local previousTrackIds = stateTrackIds(previousState)
    local nextTracks, loadResult = loadGraphStateTracks(self, chosen.to)
    if not nextTracks then
        evaluation.reason = "animation_load_failed"
        evaluation.error = loadResult.error
        evaluation.stateId = loadResult.stateId
        evaluation.transitionId = chosen.id
        return false, evaluation
    end
    for name, value in pairs(updates) do self.parameters[name] = value end
    self.currentState = chosen.to
    local played, playError = playGraphState(self, chosen.to, chosen.blendSeconds)
    if not played then
        self.currentState = previousState
        for name, _ in pairs(updates) do self.parameters[name] = previousParameters[name] end
        local previousTrackIdSet = {}
        for _, trackId in ipairs(previousTrackIds) do previousTrackIdSet[trackId] = true end
        local cleanedUpTrackIds = {}
        for _, trackId in ipairs(playError.attemptedTrackIds) do
            if not previousTrackIdSet[trackId] then
                local track = self.tracks[trackId]
                if track then
                    local stopped, stopError = pcall(function() track:Stop(0) end)
                    if stopped then table.insert(cleanedUpTrackIds, trackId)
                    else warn("Motion Tools could not roll back partially played track " .. trackId .. ": " .. tostring(stopError)) end
                end
            end
        end
        evaluation.reason = "animation_play_failed"
        evaluation.error = playError.error
        evaluation.stateId = playError.stateId
        evaluation.transitionId = chosen.id
        evaluation.attemptedStateIds = {}
        evaluation.cleanedUpStateIds = {}
        for _, trackId in ipairs(playError.attemptedTrackIds) do
            table.insert(evaluation.attemptedStateIds, self.trackSourceStateIds[trackId])
        end
        for _, trackId in ipairs(cleanedUpTrackIds) do
            table.insert(evaluation.cleanedUpStateIds, self.trackSourceStateIds[trackId])
        end
        return false, evaluation
    end
    self.currentStateFadeEnd = chosen.blendSeconds > 0 and os.clock() + chosen.blendSeconds or nil
    if chosen.to ~= previousState then
        local nextTrackIdSet = {}
        for _, trackId in ipairs(stateTrackIds(chosen.to)) do nextTrackIdSet[trackId] = true end
        for _, trackId in ipairs(previousTrackIds) do
            if not nextTrackIdSet[trackId] then self.tracks[trackId]:Stop(chosen.blendSeconds) end
        end
    end
    return true, {
        transitionId = chosen.id,
        from = previousState,
        to = chosen.to,
        trigger = chosen.trigger,
      blendSeconds = chosen.blendSeconds,
    }
end

function Controller:Trigger(triggerName)
    return triggerWithUpdates(self, triggerName, {})
end

function Controller:TriggerWithParameters(triggerName, updates, expectedTransitionId)
    if self.destroyed then return false, { reason = "controller_destroyed" } end
    if type(updates) ~= "table" then return false, { reason = "parameter_updates_must_be_a_table" } end
    if expectedTransitionId ~= nil and type(expectedTransitionId) ~= "string" then
        return false, { reason = "expected_transition_id_must_be_a_string" }
    end
    local validated = {}
    for name, value in pairs(updates) do
        local valid, reason = validateParameter(name, value)
        if not valid then return false, { reason = "invalid_parameter_update", parameter = name, error = reason } end
        validated[name] = value
    end
    return triggerWithUpdates(self, triggerName, validated, expectedTransitionId)
end

function Controller:Destroy()
    if self.destroyed then return end
    self.destroyed = true
    for _, connection in pairs(self.connections) do connection:Disconnect() end
    for _, track in pairs(self.tracks) do track:Stop(0) end
    for _, track in pairs(self.tracks) do track:Destroy() end
    for _, animation in pairs(self.animations) do animation:Destroy() end
    table.clear(self.connections)
    table.clear(self.markerCallbacks)
    table.clear(self.tracks)
    table.clear(self.animations)
    table.clear(self.trackSourceStateIds)
    table.clear(self.parameters)
    self.currentState = nil
end

local Binding = {}
Binding.__index = Binding

function Binding:_detach(character)
    if character ~= nil and self.character ~= character then return end
    self.generation += 1
    self.character = nil
    if self.controller then
        self.controller:Destroy()
        self.controller = nil
    end
end

function Binding:_attach(character)
    if self.destroyed or self.character == character then return end
    self:_detach()
    self.generation += 1
    local generation = self.generation
    self.character = character
    task.spawn(function()
        local humanoid = character:FindFirstChildOfClass("Humanoid") or character:WaitForChild("Humanoid", 10)
        if not humanoid then
            if not self.destroyed and self.generation == generation then warn("Motion Tools could not find the respawned character Humanoid") end
            return
        end
        local animator = humanoid:FindFirstChildOfClass("Animator") or humanoid:WaitForChild("Animator", 10)
        if not animator then
            if not self.destroyed and self.generation == generation then warn("Motion Tools could not find the character Animator; create it on the server for replication") end
            return
        end
        if self.destroyed or self.generation ~= generation or self.player.Character ~= character
            or character.Parent == nil or not animator:IsDescendantOf(game:GetService("Workspace")) then
            return
        end
        local ok, controllerOrError = pcall(Controller.new, animator, self.controllerOptions)
        if not ok then
            if not self.destroyed and self.generation == generation then warn("Motion Tools could not bind the character animation graph: " .. tostring(controllerOrError)) end
            return
        end
        local controller = controllerOrError
        if self.destroyed or self.generation ~= generation or self.player.Character ~= character then
            controller:Destroy()
            return
        end
        self.controller = controller
        if self.onController then
            local callbackOk, callbackError = pcall(self.onController, controller, character)
            if not callbackOk then warn("Motion Tools onController callback failed: " .. tostring(callbackError)) end
        end
    end)
end

function Binding:GetController()
    if self.destroyed then return nil end
    if self.controller and self.controller.destroyed then self.controller = nil end
    return self.controller
end

function Binding:GetState()
    local controller = self:GetController()
    return controller and controller:GetState() or nil
end

function Binding:GetPlaybackSpeed()
    local controller = self:GetController()
    return controller and controller:GetPlaybackSpeed() or nil
end

function Binding:GetParameter(name)
    local controller = self:GetController()
    if not controller then return nil, { reason = "controller_not_ready" } end
    return controller:GetParameter(name)
end

function Binding:GetBlendState()
    local controller = self:GetController()
    if not controller then return nil, { reason = "controller_not_ready" } end
    return controller:GetBlendState()
end

function Binding:SynchronizeBlendPlayback()
    local controller = self:GetController()
    if not controller then return false, { reason = "controller_not_ready" } end
    return controller:SynchronizeBlendPlayback()
end

function Binding:SetParameter(name, value)
    local controller = self:GetController()
    if not controller then return false, { reason = "controller_not_ready" } end
    return controller:SetParameter(name, value)
end

function Binding:SetParameters(values)
    local controller = self:GetController()
    if not controller then return false, { reason = "controller_not_ready" } end
    return controller:SetParameters(values)
end

function Binding:SetPlaybackSpeed(multiplier)
    local controller = self:GetController()
    if not controller then return false, { reason = "controller_not_ready" } end
    return controller:SetPlaybackSpeed(multiplier)
end

function Binding:GetLoadedStateIds()
    local controller = self:GetController()
    if not controller then return nil, { reason = "controller_not_ready" } end
    return controller:GetLoadedStateIds()
end

function Binding:Preload(stateIds)
    local controller = self:GetController()
    if not controller then return false, { reason = "controller_not_ready", loadedStateIds = {} } end
    return controller:Preload(stateIds)
end

function Binding:EvaluateTrigger(triggerName)
    local controller = self:GetController()
    if not controller then return nil, { reason = "controller_not_ready" } end
    return controller:EvaluateTrigger(triggerName)
end

function Binding:GetAvailableTriggers()
    local controller = self:GetController()
    if not controller then return nil, { reason = "controller_not_ready" } end
    return controller:GetAvailableTriggers()
end

function Binding:Trigger(triggerName)
    local controller = self:GetController()
    if not controller then return false, { reason = "controller_not_ready" } end
    return controller:Trigger(triggerName)
end

function Binding:TriggerWithParameters(triggerName, updates, expectedTransitionId)
    local controller = self:GetController()
    if not controller then return false, { reason = "controller_not_ready" } end
    return controller:TriggerWithParameters(triggerName, updates, expectedTransitionId)
end

function Binding:Destroy()
    if self.destroyed then return end
    self.destroyed = true
    for _, connection in ipairs(self.connections) do connection:Disconnect() end
    table.clear(self.connections)
    self:_detach()
end

function Controller.BindToPlayer(player, onController, options)
    assert(typeof(player) == "Instance" and player:IsA("Player"), "BindToPlayer expects a Player")
    assert(onController == nil or type(onController) == "function", "onController must be a function")
    local normalizedOptions = validateOptions(options)
    local binding = setmetatable({
        player = player,
        onController = onController,
        controllerOptions = normalizedOptions,
        controller = nil,
        character = nil,
        generation = 0,
        connections = {},
        destroyed = false,
    }, Binding)
    table.insert(binding.connections, player.CharacterAdded:Connect(function(character)
        binding:_attach(character)
    end))
    table.insert(binding.connections, player.CharacterRemoving:Connect(function(character)
        binding:_detach(character)
    end))
    if player.Character then binding:_attach(player.Character) end
    return binding
end

return Controller
`;
  const controllerFingerprint = createHash('sha256').update(JSON.stringify({ graph, config, moduleSource })).digest('hex');
  return {
    moduleSource,
    controllerFingerprint,
    assetSetFingerprint,
    stateCount: graph.states.length,
    trackChannelCount,
    transitionCount: graph.transitions.length,
    animationAssetIds: config.states,
    contract: {
      constructor: 'Controller.new(animator, options?)',
      methods: ['GetState()', 'GetPlaybackSpeed()', 'IsStateLoaded(stateId)', 'GetLoadedStateIds()', 'Preload(stateIds?)', 'GetParameter(name)', 'GetBlendState()', 'SynchronizeBlendPlayback()', 'SetPlaybackSpeed(multiplier)', 'SetParameter(name, value)', 'SetParameters(values)', 'EvaluateTrigger(name)', 'GetAvailableTriggers()', 'ConnectMarker(name, callback)', 'Trigger(name)', 'TriggerWithParameters(name, updates, expectedTransitionId?)', 'Destroy()'],
      diagnostics: 'GetBlendState() reports BlendSpace1D numeric values or BlendSpace2D x/y values and projected sample coordinates, per-source expected weight, Roblox WeightCurrent/WeightTarget, play/load state, authored source-state speed, effective controller-derived playback speed, observed AnimationTrack.Speed/Length/TimePosition/normalized phase when available, phaseSync completeness and maximum circular phase difference, total observed weights, and simulationTimingCalibration. When every source AnimationTrack.Length and Speed is available, simulationTimingCalibration is ready and includes controller-keyed observedBlendAnimationLengths and observedBlendAnimationPlaybackSpeeds maps directly consumable by motion_animation_graph_timeline_simulate or a timeline-test case, plus each source state’s actual asset ID. When every sample is playing and each TimePosition is readable, it also returns the complete observedBlendAnimationStartPhases map so simulation can begin at the captured normalized phases. Before length/speed readiness it reports unavailable state IDs and omits partial maps; call GetBlendState() again once ready. The values are live snapshots, not persistent signatures, so use immediately with matching exported assets. SynchronizeBlendPlayback() requires every active sample track to be playing with a positive loaded Length, then uses those actual lengths to set the configured controller speed, equalizes normalized phase to the first sample, and reports applied speeds. GetBlendState() reports actual speeds whether or not synchronization has occurred, so simulation does not infer the sync mode. The measured speeds are retained for this blend state and reused for channel restarts and re-entry. Synchronization is explicit because phase alignment may visibly seek clips. SetPlaybackSpeed(multiplier) scales the current state’s effective playback speed without changing relative BlendSpace phase rates; it applies the change to every active source track and rolls back already-updated tracks if any Roblox speed adjustment fails. The multiplier is bounded to 0.1–4, persists across graph transitions, and can be read with GetPlaybackSpeed(). EvaluateTrigger(name) is read-only and returns priority-ordered branches, observed/expected guard checks, selected transition, and whether its complete destination track group is loaded. GetAvailableTriggers() returns the same evaluation for each distinct trigger from the current state. Trigger(name) uses the same evaluator and returns its diagnostic evidence when no branch matches. TriggerWithParameters(name, updates, expectedTransitionId?) atomically validates proposed parameter changes and commits only if a transition successfully starts. If expectedTransitionId is supplied, a different selected branch returns selected_transition_mismatch without loading or playing its track group and leaves parameters unchanged. A destination Play failure returns animation_play_failed with the failed track, transition, attempted sources, and sources whose partial playback rollback succeeded; the previous logical state and parameters are retained. SetParameter/SetParameters update active blend weights before committing values; a stopped source channel restarts at the normalized phase of a still-playing source and success reports restartedStateIds plus phaseSourceStateId. With no usable source clock the update fails closed; restart or AdjustWeight failures return attempted, restarted, restored, and rollback-failure evidence while retaining the prior parameter values.',
      loading: `The runtime uses ${trackChannelCount} independent AnimationTrack channels across ${graph.states.length} graph states so a source clip used by a BlendSpace cannot inherit another state's weight or duplicate its events. Each channel requires a separate Animator:LoadAnimation call and track; review trackChannelCount when assessing memory and startup cost. A regular entry state loads its track at construction; any 1D or 2D blend-space entry loads all of its source tracks as one group. Other destinations load lazily on first use, and already-loaded channels are cached. Call Preload() for the whole graph or Preload(stateId)/Preload({stateId, ...}) to warm selected states; a blend controller counts as loaded only when every source channel is cached. Pass { preloadAll = true } to Controller.new or Controller.BindToPlayer to load every state before playback. Preload returns true and loaded state IDs, or false and a structured failure result.`,
      playerBinding: 'Controller.BindToPlayer(player, onController?, options?) returns a respawn-aware binding. GetController/GetState/GetPlaybackSpeed/GetParameter/GetBlendState/SynchronizeBlendPlayback/SetPlaybackSpeed/SetParameter/SetParameters/GetLoadedStateIds/Preload/EvaluateTrigger/GetAvailableTriggers/Trigger/TriggerWithParameters delegate to the current spawn; state, parameters, cache and diagnostics always refer to the current character controller. Calls that need a controller before it is ready return controller_not_ready (GetState/GetPlaybackSpeed return nil). onController(controller, character) runs once for each valid spawn so gameplay code can rebind marker callbacks. Binding:Destroy() disconnects player events and destroys its controller. NPCs can continue using Controller.new(animator, options?).',
      markers: 'Published animation markers declared by source recipes are connected automatically. Matching markers first notify ConnectMarker subscribers, then trigger the graph transition with the same case-insensitive name if the controller is still in the source state. A 1D or 2D blend controller uses its own synchronized source clip as the sole marker/Ended event source, preventing duplicate callbacks from simultaneously playing samples. Callback signature: (markerName, parameterString, sourceStateId).',
      automaticTrigger: 'AnimationEnded is emitted for the current non-looping state after its AnimationTrack ends.',
      context: 'Animator must already be parented under Workspace and its Animator instance must be created on the server for tracks started by server code to replicate. For player characters, client-started tracks replicate when the character Animator was created by the server; validate the desired ownership/authority policy in your game.',
      limitation: 'The module plays published animation assets and evaluates this graph. The published asset must contain the same marker names as its source recipe. Gameplay conditions, trigger authorization, networking, character lifecycle, asset ownership/permissions, and visual quality remain the calling game code’s responsibility.',
    },
  };
}
