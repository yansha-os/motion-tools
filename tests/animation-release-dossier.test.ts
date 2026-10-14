import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAnimationReleaseDossier } from '../src/animation-release-dossier.js';

const complete = [
  { id: 'recipe_integrity', status: 'passed' as const, detail: 'Exact recipe validated.' },
  { id: 'native_export', status: 'passed' as const, detail: 'Studio converted it.' },
  { id: 'studio_acceptance', status: 'passed' as const, detail: 'Declared checks passed.' },
];

test('release dossier only marks the exact three required technical checks verified', () => {
  const result = summarizeAnimationReleaseDossier(complete);
  assert.equal(result.technicalStatus, 'technically_verified');
  assert.equal(result.humanApproval, 'required');
  assert.equal(result.canPublish, false);
  assert.match(result.nextActions[0]!, /explicit user approval/i);
});

test('missing or unknown live evidence remains incomplete, never implicitly passed', () => {
  const result = summarizeAnimationReleaseDossier([
    complete[0]!,
    { id: 'native_export', status: 'not_requested', detail: 'No live rig.' },
    { id: 'studio_acceptance', status: 'unknown', detail: 'No persisted run.' },
  ]);
  assert.equal(result.technicalStatus, 'incomplete');
  assert.equal(result.nextActions.length, 2);
});

test('failed or stale evidence blocks technical verification even if other checks pass', () => {
  for (const status of ['failed', 'stale'] as const) {
    const result = summarizeAnimationReleaseDossier([...complete.slice(0, 2),
      { id: 'studio_acceptance', status, detail: 'Evidence does not match.' }]);
    assert.equal(result.technicalStatus, 'blocked');
  }
});

test('duplicate required checks cannot stand in for missing evidence and missing checks get explicit next actions', () => {
  const duplicate = summarizeAnimationReleaseDossier([
    complete[0]!,
    { ...complete[0]!, detail: 'Duplicate recipe check.' },
    complete[2]!,
  ]);
  assert.equal(duplicate.technicalStatus, 'blocked');
  assert.ok(duplicate.nextActions.some(action => /duplicate required-check entries/i.test(action)));
  assert.equal(duplicate.nextActions.some(action => /native_export/.test(action)), true);

  const missing = summarizeAnimationReleaseDossier([]);
  assert.equal(missing.technicalStatus, 'incomplete');
  assert.equal(missing.nextActions.length, 3);
  assert.ok(missing.nextActions.every(action => /required evidence is missing/i.test(action)));
});
