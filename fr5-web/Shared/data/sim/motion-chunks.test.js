import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkJoints, maxJointDelta, chunkSeconds, arrived, CHUNK_DEG, BIG_CHUNK_DEG } from './motion-chunks.js';

test('106° 이동은 5° 조각 22개(WS moveJ 상한) · 마지막이 정확히 목표 · 각 조각 ≤5°', () => {
  const cur = [91.5, -55, 23.7, -111.9, -90, -17.2]; const tgt = cur.map((v, i) => v + [106.4, -30, 12, 5, 0, 80][i]);
  const ch = chunkJoints(cur, tgt);
  assert.equal(ch.length, 22);
  assert.deepEqual(ch[ch.length - 1], tgt);
  let prev = cur; for (const c of ch) { assert.ok(maxJointDelta(prev, c) <= CHUNK_DEG + 1e-9); prev = c; }
});
test('이동이 작으면 조각 하나 · 목표 그대로', () => {
  const cur = [0, 0, 0, 0, 0, 0]; assert.deepEqual(chunkJoints(cur, [1, 2, 3, 4, 4.5, 4.9]), [[1, 2, 3, 4, 4.5, 4.9]]);   // 최대 4.9° ≤ 5 → 조각 하나
});
test('시간 — 전역을 곱하지 않는다 (실기 09-07: 63° 24초 · 2.7°/s) · 5° 조각 2초 안', () => {
  assert.ok(Math.abs(chunkSeconds(63, 10) - 21.8) < 0.5); assert.ok(chunkSeconds(CHUNK_DEG, 10) < 2);
});
test('큰 조각(경로 훑는 창구) — 손목 189° 는 2조각 · 각 조각 ≤120° · 예상 42초 미만(정착 상한 60 안)', () => {
  const cur = [77, -67, 69, -92, -90, -22]; const tgt = [77, -67, 69, -92, -90, 167.2];
  const ch = chunkJoints(cur, tgt, BIG_CHUNK_DEG);
  assert.equal(ch.length, 2); assert.deepEqual(ch[1], tgt);
  let prev = cur; for (const c of ch) { assert.ok(maxJointDelta(prev, c) <= BIG_CHUNK_DEG + 1e-9); prev = c; }
  assert.ok(chunkSeconds(BIG_CHUNK_DEG, 10) < 42);
});
test('도착 판정 1°', () => {
  assert.equal(arrived([0, 0, 0, 0, 0, 0.9], [0, 0, 0, 0, 0, 0]), true);
  assert.equal(arrived([0, 0, 0, 0, 0, 1.1], [0, 0, 0, 0, 0, 0]), false);
  assert.equal(arrived(null, [0]), false);
});
