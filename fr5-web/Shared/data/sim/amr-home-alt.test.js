// `AMR_HOME_ALT` 가 쌍 파일에서 다시 풀린다 — 숫자를 베낀 상수가 원본과 갈라지면 여기서 붉어진다 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AMR_HOME, AMR_HOME_ALT } from '../workcell.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const pairs = JSON.parse(readFileSync(join(ROOT, 'scripts/robot/amr-pairs.json'), 'utf8')).pairs;

// 홈 = user1 − R(yaw)·odom  (요각 180 고정 · `frames.js` odom→user1 갈래와 같은 식)
const homeFrom = (p) => {
  const th = (AMR_HOME_ALT.yawDeg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  return [p.user1[0] - (p.odom[0] * c - p.odom[1] * s), p.user1[1] - (p.odom[0] * s + p.odom[1] * c)];
};

test('첫 쌍(홈 · odom ≈ 0)에서 푼 홈이 AMR_HOME_ALT 와 1mm 안', () => {
  const h = homeFrom(pairs[0]);
  assert.ok(Math.hypot(h[0] - AMR_HOME_ALT.xMm, h[1] - AMR_HOME_ALT.yMm) < 1, `${h}`);
});

test('나머지 쌍도 같은 홈으로 20mm 안에 맞는다 — 요각 180 이 대체로 맞다는 뜻', () => {
  for (const p of pairs.slice(1)) {
    const h = homeFrom(p);
    assert.ok(Math.hypot(h[0] - AMR_HOME_ALT.xMm, h[1] - AMR_HOME_ALT.yMm) < 20, `${h}`);
  }
});

test('정본과 두 번째 후보는 140mm 급으로 갈린다 — 그래서 둘 다 그린다', () => {
  const d = Math.hypot(AMR_HOME.xMm - AMR_HOME_ALT.xMm, AMR_HOME.yMm - AMR_HOME_ALT.yMm);
  assert.ok(d > 120 && d < 160, `${d.toFixed(1)}mm`);
});
