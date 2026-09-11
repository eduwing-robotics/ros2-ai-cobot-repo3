// 싣기 9칸 정본 — 높이가 실측 기하와 맞물리나 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLoadSteps, CLEAR_MM, PREGRIP_PCT, basketFloorZ } from './load-steps.js';
import { AMR_HOME, AMR_DROP, AMR_DROP_CANDIDATES } from '../workcell.js';
import { CARRIER, CARRIER_GRASP_TRUTH, AMR_BASKET } from '../props.js';
import { AMR_MM } from '../layout/catalog.js';

test('9자세+사전성형 · id 고정 · 높은 곳 100→70% 뒤 70% 유지 하강', () => {
  const s = makeLoadSteps(AMR_DROP);
  assert.deepEqual(s.map((x) => x.id), ['approach', 'pregrip', 'grasp', 'close', 'lift', 'carry', 'over', 'insert', 'release', 'retreat']);
  const approach = s.find((x) => x.id === 'approach'); const pregrip = s.find((x) => x.id === 'pregrip'); const grasp = s.find((x) => x.id === 'grasp');
  assert.deepEqual(pregrip.pose, approach.pose, '새 좌표 없이 높은 접근 자세를 재사용');
  assert.equal(approach.grip, 100); assert.equal(pregrip.grip, PREGRIP_PCT); assert.equal(grasp.grip, PREGRIP_PCT);
  assert.ok(Math.abs(grasp.pose[2] - (AMR_HOME.topZMm + CARRIER_GRASP_TRUTH.tcpAboveTableMm)) < 1e-9);
  assert.equal(grasp.pose[5], CARRIER_GRASP_TRUTH.tcpMmDeg[5], '손목 각은 실측 그대로');
});

test('D220 — 파지 손끝은 안쪽 바닥 상한보다 5mm 넘게 높고 직전값보다 7mm 깊다', () => {
  const floorTop = CARRIER.depthSignature.innerFloorAboveTableMm[1];
  assert.equal(CARRIER_GRASP_TRUTH.tcpAboveTableMm, 33.3);
  assert.ok(CARRIER_GRASP_TRUTH.tcpAboveTableMm - floorTop >= 5);
  assert.equal(40.3 - CARRIER_GRASP_TRUTH.tcpAboveTableMm, 7);
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
    assert.equal(s.length, 10);
    const dRz = s.find((x) => x.id === 'carry').pose[5] - s.find((x) => x.id === 'grasp').pose[5];
    assert.ok(Math.abs(dRz - (c.yawDeg - AMR_HOME.yawDeg)) < 1e-9, `${c.yawDeg}: ${dRz}`);
  }
});

test('D209 — 후보에서 접은 ±180° 경계가 실행 10칸에서 다시 펴지지 않는다', () => {
  const s = makeLoadSteps(AMR_DROP, { graspRzDeg: -89.8 });
  assert.equal(s.find((x) => x.id === 'grasp').pose[5], 179.899);
  for (const step of s) {
    assert.ok(step.pose[5] >= -180 && step.pose[5] < 180, `${step.id}: rz ${step.pose[5]}`);
  }
});
