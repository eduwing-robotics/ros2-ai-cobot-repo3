// 관측 자세 식 — 09-04 스크립트가 낸 `VIEW_CANDIDATES` 다섯을 같은 표적·hand-eye 로 **재현**한다 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewPose, viewPoseNearRz, rotFixedXYZ, eulerOf, VIEW_DEFAULT } from './view-pose.js';
import { VIEW_CANDIDATES, VIEW_TARGET_MM } from '../workcell.js';

// 09-04 에 스크립트가 쓴 hand-eye (`FR5/bridge/config.yaml handEye.tMm` · 2026-08-13 실측) — 여기 베끼는 게 아니라 **그날의 입력**을 고정하는 것
const T_HE_0904 = [-25.9, -76.1, -81.7];

test('기록된 관측 후보 다섯을 같은 식으로 재현한다 — 위치 0.1mm · 각 0.1°', () => {
  for (const c of VIEW_CANDIDATES) {
    const p = viewPose(VIEW_TARGET_MM, T_HE_0904, { tiltDeg: c.tiltDeg, aziDeg: c.aziDeg, distMm: c.distMm });
    for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(p[i] - c.tcpMmDeg[i]) < 0.1, `tilt ${c.tiltDeg}: ${i} ${p[i]} vs ${c.tcpMmDeg[i]}`);
    for (let i = 3; i < 6; i += 1) {
      const d = ((p[i] - c.tcpMmDeg[i]) % 360 + 540) % 360 - 180;
      assert.ok(Math.abs(d) < 0.1, `tilt ${c.tiltDeg}: 각 ${i} ${p[i]} vs ${c.tcpMmDeg[i]}`);
    }
  }
});

test('오일러 왕복 — rot → euler → rot 이 같다', () => {
  for (const e of [[178.8, -1.3, -90.3], [160, 0, 45], [-172, 3, 120]]) {
    const R = rotFixedXYZ(...e); const back = eulerOf(R); const R2 = rotFixedXYZ(...back);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) assert.ok(Math.abs(R[i][j] - R2[i][j]) < 1e-9);
  }
});

test('기본값은 시선각 20 · 방위 135 · 거리 300 — 근거는 workcell §VIEW_CANDIDATES', () => {
  assert.deepEqual(VIEW_DEFAULT, { tiltDeg: 20, aziDeg: 135, distMm: 300 });
  assert.equal(viewPose(VIEW_TARGET_MM, null), null, 'hand-eye 없으면 null');
});

test('rz 에 가장 가까운 관측 자세 — 같은 곳을 같은 거리에서 보고, 손목 요각만 작업 자세 쪽이다', () => {
  const target = VIEW_TARGET_MM;
  const p0 = viewPose(target, T_HE_0904);
  const p = viewPoseNearRz(target, T_HE_0904, -90.3);
  const wrap = (a) => ((a % 360) + 540) % 360 - 180;
  assert.ok(Math.abs(wrap(p[5] - (-90.3))) <= 7.5, `rz ${p[5]}`);
  assert.ok(Math.abs(wrap(p0[5] - (-90.3))) > 90, `roll 0 은 rz ${p0[5]} — 멀어야 이 함수가 뜻이 있다`);
  // 카메라 원점(= 손끝 + R·tHE)에서 표적까지 거리가 그대로 300 — 「보는 자리」는 안 바뀌었다
  const R = rotFixedXYZ(p[3], p[4], p[5]);
  const cam = [0, 1, 2].map((i) => p[i] + R[i][0] * T_HE_0904[0] + R[i][1] * T_HE_0904[1] + R[i][2] * T_HE_0904[2]);
  assert.ok(Math.abs(Math.hypot(...cam.map((v, i) => v - target[i])) - VIEW_DEFAULT.distMm) < 0.1);
  assert.equal(viewPoseNearRz(target, T_HE_0904, NaN)[5], p0[5], 'rz 없으면 roll 0 그대로');
});
