import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheEphemeralCapturePng } from '../src/ephemeral-capture-cache.js';

test('ephemeral capture byte budget evicts oldest image bytes but preserves capture metadata', () => {
  const captures = new Map([
    ['oldest', { expiresAt: 100, png: Buffer.alloc(5) }],
    ['middle', { expiresAt: 100, png: Buffer.alloc(5) }],
    ['newest', { expiresAt: 100 }],
  ]);
  const result = cacheEphemeralCapturePng(captures, 'newest', Buffer.alloc(5), 9);
  assert.equal(result.totalBytes, 5);
  assert.deepEqual(result.evictedCaptureIds, ['oldest', 'middle']);
  assert.equal(captures.get('oldest')?.expiresAt, 100);
  assert.equal(captures.get('oldest')?.png, undefined);
  assert.equal(captures.get('newest')?.png?.length, 5);
});

test('ephemeral capture byte budget accepts replacement bytes without double counting and rejects oversized images', () => {
  const captures = new Map([
    ['first', { expiresAt: 100, png: Buffer.alloc(5) }],
    ['second', { expiresAt: 100, png: Buffer.alloc(3) }],
  ]);
  const replaced = cacheEphemeralCapturePng(captures, 'first', Buffer.alloc(4), 7);
  assert.equal(replaced.totalBytes, 7);
  assert.deepEqual(replaced.evictedCaptureIds, []);
  assert.throws(() => cacheEphemeralCapturePng(captures, 'first', Buffer.alloc(8), 7), /exceeds the 7-byte/i);
  assert.equal(captures.get('first')?.png?.length, 4);
});

test('ephemeral capture byte budget requires an existing capture and a valid limit', () => {
  const captures = new Map<string, { expiresAt: number; png?: Buffer }>();
  assert.throws(() => cacheEphemeralCapturePng(captures, 'missing', Buffer.alloc(1)), /no longer available/i);
  captures.set('present', { expiresAt: 100 });
  assert.throws(() => cacheEphemeralCapturePng(captures, 'present', Buffer.alloc(1), 0), /positive safe integer/i);
});
