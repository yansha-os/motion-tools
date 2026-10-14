'use strict';
const $ = id => document.getElementById(id);
const fragment = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(fragment)) sessionStorage.setItem('motion-app-token', fragment);
history.replaceState(null, '', '/app');
const token = sessionStorage.getItem('motion-app-token') || '';
let connections = [], assets = [], targets = [], running = false;
async function api(path, data = {}) {
  const response = await fetch(`/app-api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Local server returned ${response.status}`);
  return result;
}
function status(id, text, error = false) { if ($(id).textContent !== text) $(id).textContent = text; $(id).classList.toggle('error', error); }
function option(value, name) { const node = document.createElement('option'); node.value = value; node.textContent = name; return node; }
function fill(select, items, fallback) {
  if (items.length === select.options.length && items.every((item, index) => item.value === select.options[index].value && item.textContent === select.options[index].textContent)) return;
  const previous = select.value; select.replaceChildren(...items);
  select.value = items.some(item => item.value === previous) ? previous : fallback;
}
function providerChanged() {
  const provider = connections.find(p => p.id === $('provider').value); if (!provider) return;
  $('model').value = provider.model; $('workspace').value = provider.workspace; $('workspace').disabled = provider.id !== 'claude';
  $('apiKey').value = ''; $('apiKey').placeholder = provider.connected ? 'Key configured. Enter a replacement to change it.' : 'Enter key on this device';
  $('remember').disabled = !provider.canRemember; $('remember').checked = provider.source === 'remembered';
  $('keysLink').href = provider.keysUrl;
  status('providerStatus', provider.connected ? `Configured (${provider.source}). Your next generation will verify API access.` : 'No API key connected.');
}
async function refreshState(updateConnections = false) {
  const state = await api('state');
  if (updateConnections) {
    connections = state.providers;
    fill($('provider'), connections.map(p => option(p.id, p.name)), connections[0]?.id || ''); providerChanged();
  }
  targets = state.sessions.flatMap(session => (Array.isArray(session.snapshot.selection) ? session.snapshot.selection : []).map(rig => ({ value: `${session.id}/${rig.id}`, sessionId: session.id, rigId: rig.id, name: `${session.snapshot.place || 'Studio'} / ${rig.name}` })));
  fill($('rig'), [option('', 'Standard R15 draft (no live rig)'), ...targets.map(t => option(t.value, t.name))], targets.length === 1 ? targets[0].value : '');
  status('connectionStatus', state.sessions.length ? `${state.sessions.length} Studio connection${state.sessions.length === 1 ? '' : 's'} · ${targets.length} selected rig${targets.length === 1 ? '' : 's'}${state.sessions.some(s => !s.snapshot.features?.poseSampling) ? ' · Restart Studio to load the v1 inspector' : ''}` : 'Local server ready. Connect Motion Tools in Studio.');
}
function assetChanged() {
  const asset = assets.find(a => a.id === $('asset').value);
  status('assetInfo', asset ? `${asset.kind} · ${new Date(asset.createdAt).toLocaleString()} · ${asset.id.slice(0, 8)}${asset.parentId ? ' · revised draft' : ''}` : 'No saved assets yet. Generate a draft or create one through your MCP client.');
  reviewUI.assetChanged(asset?.id);
}
async function refreshLibrary(selectId) {
  const found = new Map(); let offset = 0;
  do {
    const page = await api('library', { offset, limit: 100 });
    for (const asset of page.assets) found.set(asset.id, asset);
    offset = page.nextOffset;
  } while (offset !== null);
  assets = [...found.values()];
  fill($('asset'), assets.length ? assets.map(a => option(a.id, `${a.kind === 'animation' ? 'Animation' : 'VFX'} / ${a.name} · ${new Date(a.createdAt).toLocaleDateString()} · ${a.id.slice(0, 6)}`)) : [option('', 'No saved assets')], selectId || assets[0]?.id || '');
  if (selectId) $('asset').value = selectId;
  assetChanged();
}
function target() { const chosen = targets.find(t => t.value === $('rig').value); if (!chosen) throw new Error('Connect Studio, select your rig, then choose it under Target rig.'); return { sessionId: chosen.sessionId, rigId: chosen.rigId }; }
function actionInput() {
  if (!$('asset').value) throw new Error('Select a saved asset first.');
  return { ...target(), assetId: $('asset').value, seconds: Number($('seconds').value), part: $('part').value };
}
async function waitForStudioJob(jobId, label) {
  status('studioStatus', `${label}: queued. Waiting for Studio...`);
  for (let i = 0; i < 140; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const current = await api('job', { id: jobId });
    if (current.status === 'succeeded') return current;
    if (!['queued', 'running'].includes(current.status)) throw new Error(`Studio ${current.status}: ${current.result?.error || 'Reconnect and try again. The command will not be retried automatically.'}`);
  }
  throw new Error('Studio has not confirmed completion. Check Studio before retrying.');
}
async function studioAction(path, data) {
  if (path === 'save') {
    const asset = assets.find(item => item.id === data.assetId);
    if (asset?.kind === 'animation') {
      const preflight = await api('save-preflight', data);
      const checked = await waitForStudioJob(preflight.id, 'Export preflight');
      const evidence = checked.result;
      if (!evidence || typeof evidence !== 'object' || evidence.valid !== true || evidence.assetId !== data.assetId || evidence.rigId !== data.rigId
        || evidence.saved !== false || !Array.isArray(evidence.mappedTargetJoints) || evidence.mappedTargetJoints.length !== evidence.animatedTrackCount)
        throw new Error('Studio export preflight did not return verified evidence for the selected animation and rig. No save was queued.');
      const rig = targets.find(item => item.sessionId === data.sessionId && item.rigId === data.rigId);
      const approved = window.confirm(`Studio converted this exact animation successfully.\n\nAnimation: ${asset.name}\nRig: ${rig?.name || data.rigId}\nFrames: ${evidence.frameCount} · Poses: ${evidence.poseCount} · Markers: ${evidence.markerCount}\nMapped recipe targets: ${evidence.mappedTargetJoints.join(', ')}\n\nFingerprint: ${evidence.assetFingerprint}\n\nApprove saving this exact revision to the rig’s AnimSaves folder?`);
      if (!approved) { status('studioStatus', 'Save cancelled. The animation remains unchanged in the library.'); return; }
      const saved = await api('save', { ...data, preflightJobId: preflight.id, userApprovedFingerprint: evidence.assetFingerprint });
      await waitForStudioJob(saved.id, 'Approved save');
      status('studioStatus', 'Saved in Studio. The locally editable KeyframeSequence is in the rig’s AnimSaves folder.');
      return;
    }
  }
  const job = await api(path, data);
  await waitForStudioJob(job.id, path);
  status('studioStatus', path === 'save' ? 'Saved in Studio.' : `${path === 'stop' ? 'Stopped' : 'Preview started'} in Studio.`);
}
function bind(id, handler, output = 'studioStatus') { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await handler(); } catch (error) { status(output, error.message, true); } finally { $(id).disabled = false; } }); }
$('provider').addEventListener('change', providerChanged);
$('asset').addEventListener('change', assetChanged);
$('connectionForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const apiKey = $('apiKey').value.trim(); $('apiKey').value = '';
  try { await api('connect', { provider: $('provider').value, model: $('model').value.trim(), workspace: $('workspace').value.trim(), remember: $('remember').checked, ...(apiKey ? { apiKey } : {}) }); await refreshState(true); }
  catch (error) { status('providerStatus', error.message, true); } finally { button.disabled = false; }
});
bind('disconnect', async () => { const result = await api('disconnect', { provider: $('provider').value }); await refreshState(true); if (result.environmentStillConfigured) status('providerStatus', 'Saved key removed. An environment variable still supplies this provider key.'); }, 'providerStatus');
bind('refresh', async () => { await refreshState(); await refreshLibrary(); });
bind('preview', () => studioAction('preview', actionInput()));
bind('save', () => studioAction('save', actionInput()));
bind('stop', () => studioAction('stop', { sessionId: target().sessionId }));
async function watchDraft(id) {
  running = true; $('generate').disabled = true; $('cancel').disabled = false;
  sessionStorage.setItem('motion-draft-job', id);
  try {
    for (;;) {
      const job = await api('draft', { id });
      status('draftStatus', `${job.phase}\nCalls: ${job.attempts}. Tokens: ${job.usage.inputTokens} input / ${job.usage.outputTokens} output.`, job.status === 'failed');
      if (job.status !== 'running') {
        if (job.error) status('draftStatus', `${job.error}\nCalls: ${job.attempts}. Reported tokens: ${job.usage.inputTokens} input / ${job.usage.outputTokens} output.`, job.status === 'failed');
        if (job.assetId) {
          await refreshLibrary(job.assetId); $('approach').textContent = job.approach || '';
          $('checkpoints').replaceChildren(...(job.checkpoints || []).map(text => { const li = document.createElement('li'); li.textContent = text; return li; })); $('plan').hidden = false;
          if (job.reviewId) await reviewUI.load(job.reviewId);
          if (job.reviewError) status('reviewStatus', job.reviewError, true);
        }
        sessionStorage.removeItem('motion-draft-job'); break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    if (error.message.includes('Draft job not found')) sessionStorage.removeItem('motion-draft-job');
    status('draftStatus', error.message, true); throw error;
  } finally { running = false; $('generate').disabled = false; $('cancel').disabled = true; }
}
$('draftForm').addEventListener('submit', async event => {
  event.preventDefault(); if (running) return; $('generate').disabled = true; $('plan').hidden = true;
  try {
    const chosen = targets.find(t => t.value === $('rig').value);
    const job = await api('generate', { provider: $('provider').value, kind: $('kind').value, prompt: $('prompt').value, maxTokens: Number($('maxTokens').value), repair: $('repair').checked, inspectAfter: $('inspectAfter').checked, aiReview: $('aiReview').checked, motionMode: $('motionMode').value,
      ...($('revise').checked ? { parentId: $('asset').value } : {}), ...(chosen ? { sessionId: chosen.sessionId, rigId: chosen.rigId } : {}) });
    await watchDraft(job.id);
  } catch (error) { status('draftStatus', error.message, true); } finally { $('generate').disabled = false; }
});
$('cancel').addEventListener('click', async () => {
  try {
    const id = sessionStorage.getItem('motion-draft-job');
    if (id) {
      const result = await api('cancel', { id });
      $('cancel').disabled = true;
      status('draftStatus', result.requested ? 'Cancellation requested. Tokens already generated may still be billed.'
        : result.reason === 'draft_already_saved' ? 'The draft is already saved; finishing review setup. You can still inspect or discard it.'
          : 'There is no active draft generation to cancel.');
    }
  }
  catch (error) { status('draftStatus', error.message, true); }
});
const reviewUI = window.MotionReview.initialize({ api, status, currentAsset: () => assets.find(a => a.id === $('asset').value), target, studioAction, watchDraft,
  settings: () => ({ provider: $('provider').value, maxTokens: Number($('maxTokens').value), repair: $('repair').checked, aiReview: $('aiReview').checked }),
  targetOrNone: () => { const chosen = targets.find(t => t.value === $('rig').value); return chosen ? { sessionId: chosen.sessionId, rigId: chosen.rigId } : {}; },
});
(async () => {
  try { await refreshState(true); await refreshLibrary(); const pending = sessionStorage.getItem('motion-draft-job'); if (pending) await watchDraft(pending); }
  catch (error) { status('connectionStatus', error.message, true); }
  setInterval(() => refreshState().catch(error => status('connectionStatus', error.message, true)), 4000);
})();
