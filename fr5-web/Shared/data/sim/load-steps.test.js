// 싣기 9칸 정본 — 높이가 실측 기하와 맞물리나 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLoadSteps, CLEAR_MM, basketFloorZ } from './load-steps.js';
import { AMR_HOME, AMR_DROP, AMR_DROP_CANDIDATES } from '../workcell.js';
import { CARRIER_GRASP_TRUTH, AMR_BASKET } from '../props.js';
import { AMR_MM } from '../layout/catalog.js';

test('9칸 · id 고정 · 파지 높이는 그려진 상판 + 실측 14.9', () => {
  const s = makeLoadSteps(AMR_DROP);
  assert.deepEqual(s.map((x) => x.id), ['approach', 'grasp', 'close', 'lift', 'carry', 'over', 'insert', 'release', 'retreat']);
  assert.ok(Math.abs(s[1].pose[2] - (AMR_HOME.topZMm + CARRIER_GRASP_TRUTH.tcpAboveTableMm)) < 1e-9);
  assert.equal(s[1].pose[5], CARRIER_GRASP_TRUTH.tcpMmDeg[5], '손목 각은 실측 그대로');
});

test('④·⑤ 는 들린 거치대 바닥이 라이다 위 CLEAR 이상 — 09-06 충돌의 처방', () => {
  const s = makeLoadSteps(AMR_DROP);
  const lidarTop = AMR_HOME.topZMm + AMR_MM.heightMm;
  for (const id of ['lift', 'carry']) {
    const z = s.find((x) => x.id === id).pose[2];
    const carrierBottom = z - CARRIER_GRASP_TRUTH.tcpAboveTableMm;
    assert.ok(carrierBottom >= lidarTop + CLEAR_MM - 1e-9, `${id}: 거치대 바닥 ${carrierBottom} vs 라이다 ${lidarTop}`);
  }
});

test('⑦ 넣기는 거치대 바닥이 바구니 바닥에 닿는 높이 · ⑥⑨ 는 테두리 위', () => {
  const s = makeLoadSteps(AMR_DROP);
  const insert = s.find((x) => x.id === 'insert').pose[2];
  assert.ok(Math.abs((insert - CARRIER_GRASP_TRUTH.tcpAboveTableMm) - basketFloorZ()) < 1e-9);
  const rim = AMR_HOME.topZMm + AMR_BASKET.rimAboveGroundMm;
  for (const id of ['over', 'retreat']) assert.ok(s.find((x) => x.id === id).pose[2] > rim);
});

test('정차 후보 여섯 전부에서 만들어지고 요각 270 이면 손목이 90° 더 돈다', () => {
  for (const c of AMR_DROP_CANDIDATES) {
    const s = makeLoadSteps(c);
    assert.equal(s.length, 9);
    const dRz = s.find((x) => x.id === 'carry').pose[5] - s[1].pose[5];
    assert.ok(Math.abs(dRz - (c.yawDeg - AMR_HOME.yawDeg)) < 1e-9, `${c.yawDeg}: ${dRz}`);
  }
});
