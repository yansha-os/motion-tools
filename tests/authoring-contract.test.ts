import assert from 'node:assert/strict';
import test from 'node:test';
import { authoringSystemPrompt } from '../src/authoring.js';

test('animation authoring instructions describe Bezier curves and pose layers supported by the recipe schema', () => {
  assert.match(authoringSystemPrompt, /easingStyle\?:"Linear"\|"Constant"\|"CubicV2"\|"Bounce"\|"Elastic"\|"Bezier"/);
  assert.match(authoringSystemPrompt, /curve\?:\{outTime:number,outValue:number,inTime:number,inValue:number\}/);
  assert.match(authoringSystemPrompt, /layers\?:\[\{id:uuid,name:string,blendMode:"Override"\|"Additive"/);
  assert.match(authoringSystemPrompt, /Loop endpoints must have identical position and rotation for ordinary pose tracks, including layer tracks/);
  assert.match(authoringSystemPrompt, /For an in-place loop, match ordinary base\/layer endpoint poses.*for a traveling root-motion loop, preserve intentional endpoint displacement.*instead of forcing positional closure/);
  assert.match(authoringSystemPrompt, /1024 total joint tracks, 4096 total keys/);
});

test('rig-aware authoring uses segment scale as a review cue, not a universal translation limit', () => {
  assert.match(authoringSystemPrompt, /compare local position offsets with segment lengths as a scale-review cue, never as a universal clamp or joint limit/i);
});

test('animation authoring prompt uses analyzer-recognized semantic phase markers without forcing irrelevant phases', () => {
  assert.match(authoringSystemPrompt, /semantic marker names the analyzer recognizes/);
  assert.match(authoringSystemPrompt, /Anticipation\/WindUp\/Preparation, Action\/Attack\/Strike\/Impact\/Release\/Cast, FollowThrough, and Recovery\/Settle\/Return/);
  assert.match(authoringSystemPrompt, /Put each marker at that phase's start, use only phases the action needs/);
  assert.match(authoringSystemPrompt, /phase-aware diagnostics and capture planning; they are Motion Tools recipe metadata only/);
});

test('animation authoring leaves runtime playback priority to the user unless context is specified', () => {
  assert.match(authoringSystemPrompt, /Treat priority as a runtime playback\/blending setting, not a pose-quality choice.*only when the user specifies the intended playback context; otherwise omit it and leave that policy to the game/i);
});

test('animation authoring tags marker intent to disambiguate event names from phase boundaries', () => {
  assert.match(authoringSystemPrompt, /Set marker\.phase to the matching phase label/);
  assert.match(authoringSystemPrompt, /set phase:"event" on ordinary gameplay\/event markers even when their name matches a phase alias/);
  assert.match(authoringSystemPrompt, /not written to native Roblox KeyframeMarker objects/);
  assert.match(authoringSystemPrompt, /phase:"anticipation"\|"main_action"\|"follow_through"\|"recovery"\|"event"/);
});

test('animation authoring distinguishes an unreviewed library draft from Studio save and visual approval', () => {
  assert.match(authoringSystemPrompt, /stores an unreviewed draft in the Motion Tools library; that is not a Roblox Studio save, export, approval, or quality pass/);
  assert.match(authoringSystemPrompt, /evaluate the exact recipe against a freshly inspected target rig, open that exact candidate in the Motion Tools viewport/);
  assert.match(authoringSystemPrompt, /if it is unavailable or permission is not granted, leave rendered quality unknown/);
  assert.match(authoringSystemPrompt, /passing caller-defined mechanical checks is not proof of artistic quality/);
});
