// 정차 자리 선택 규칙 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseStop, dwellSeconds, stopCandidates, stopLabel } from './stop-select.js';
import { AMR_DROP, AMR_DROP_CANDIDATES } from '../workcell.js';

const ev = (o) => ({ stop: AMR_DROP, reachable: true, contactLegs: 0, dwellSec: 30, reachMm: 1300, why: null, ...o });

test('후보 = 채택 1 + 후보 6 · 라벨 문법 하나', () => {
  const c = stopCandidates();
  assert.equal(c.length, 1 + AMR_DROP_CANDIDATES.length);
  assert.equal(stopLabel(AMR_DROP), '180° · 앞 200mm');
  assert.match(stopLabel(AMR_DROP_CANDIDATES[3]), /^270° · 뒤 50mm$/);
});

test('빠르게 = 정차 시간 최소 · 덜 뻗게 = 팔 뻗음 최소', () => {
  const evals = [ev({ dwellSec: 25, reachMm: 1340 }), ev({ dwellSec: 39, reachMm: 1178 }), ev({ dwellSec: 24, reachMm: 1306 })];
  assert.equal(chooseStop(evals, 'fast').index, 2);
  assert.equal(chooseStop(evals, 'short').index, 1);
});

test('닿지 않거나 부딪히는 후보는 아무리 빨라도 안 고른다 · 전부 막히면 null', () => {
  const evals = [ev({ dwellSec: 10, reachable: false }), ev({ dwellSec: 12, contactLegs: 1 }), ev({ dwellSec: 40 })];
  assert.equal(chooseStop(evals, 'fast').index, 2);
  assert.equal(chooseStop(evals.slice(0, 2), 'fast'), null);
});

test('같은 값이면 채택값(앞 번호)이 이긴다', () => {
  const evals = [ev({ dwellSec: 30 }), ev({ dwellSec: 30 })];
  assert.equal(chooseStop(evals, 'fast').index, 0);
});

test('정차 시간은 칸 사이 관절 이동 합 — 관절해가 하나라도 없으면 null', () => {
  const steps = [{ grip: 100 }, { grip: 100 }, { grip: 40 }];
  const j0 = [0, 0, 0, 0, 0, 0];
  assert.ok(dwellSeconds(steps, [j0, [0, 28.9, 0, 0, 0, 0], [0, 28.9, 0, 0, 0, 0]], 10) > 10);
  assert.equal(dwellSeconds(steps, [j0, null, j0], 10), null);
});
