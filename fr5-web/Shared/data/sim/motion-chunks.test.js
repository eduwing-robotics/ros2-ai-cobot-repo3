import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkJoints, maxJointDelta, chunkSeconds, arrived, CHUNK_DEG } from './motion-chunks.js';

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
test('시간 — 5° 조각은 전역 30 에서 6초 · 전역 10 에서도 60초 안 (5° 상한이 정착 상한보다 엄하다)', () => {
  assert.ok(chunkSeconds(CHUNK_DEG, 10, 30) < 6); assert.ok(chunkSeconds(CHUNK_DEG, 10, 10) < 60);
});
test('도착 판정 1°', () => {
  assert.equal(arrived([0, 0, 0, 0, 0, 0.9], [0, 0, 0, 0, 0, 0]), true);
  assert.equal(arrived([0, 0, 0, 0, 0, 1.1], [0, 0, 0, 0, 0, 0]), false);
  assert.equal(arrived(null, [0]), false);
});
