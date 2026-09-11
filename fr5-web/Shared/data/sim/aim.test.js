// 2단 조준 융합 — 거울 쌍이 툴 프레임 고정 편향을 지우나 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulletEvidence, bulletSearchSpecs, closerObservationTarget, fusePair, judge, singleViewFused, meanYaw180, foldYaw, preferLiveCoarse, HALF_DIFF_MAX_MM } from './aim.js';
import { makeLoadSteps, nearestYaw } from './load-steps.js';
import { mirrorPair } from './view-pose.js';
import { AMR_DROP, AMR_HOME } from '../workcell.js';
import { CARRIER_GRASP_TRUTH } from '../props.js';

const T_HE = [-25.9, -76.1, -81.7];
const truth = [657.2, -1103.0, -311.0];
const rot = (v, deg) => { const r = (deg * Math.PI) / 180; return [v[0] * Math.cos(r) - v[1] * Math.sin(r), v[0] * Math.sin(r) + v[1] * Math.cos(r), v[2]]; };
const view = (rz, bias) => { const b = rot(bias, rz); return { rzDeg: rz, user1Mm: truth.map((v, i) => v + b[i]), yawDeg: -0.3 }; };

test('편향 +b(rz) 와 +b(rz+180) 의 평균은 진값 · 차/2 = |b|', () => {
  const bias = [12, -8, 0];
  const f = fusePair(view(0, bias), view(180, bias));
  assert.ok(Math.hypot(f.user1Mm[0] - truth[0], f.user1Mm[1] - truth[1]) < 1e-6, `${f.user1Mm}`);
  assert.ok(Math.abs(f.halfDiffMm - Math.hypot(12, 8)) < 0.01);
  assert.equal(f.rzGapDeg, 0);
  assert.equal(judge(f).ok, false, '편향 14.4 > 3 — 첫 패스는 고정인지 모른다 → 한 번 더');
  assert.equal(judge(f).retry, true);
  // 둘째 패스 — 자리를 평균으로 옮겨 다시 잰 값이 같으면(고정 편향) 통과, 갈리면(자세 따라 변함) 멈춤
  const f2 = fusePair(view(90, bias), view(270, bias));
  assert.equal(judge(f2, 2, { prevFused: f }).ok, true, '두 패스 평균 일치 → 고정 편향 → 통과');
  const shifted = { ...f2, user1Mm: [f2.user1Mm[0] + 6, f2.user1Mm[1], f2.user1Mm[2]] };
  const bad = judge(shifted, 2, { prevFused: f });
  assert.equal(bad.ok, false); assert.equal(bad.retry, false); assert.match(bad.why, /갈려요/);
});

test('거울이 아닌 쌍(90° 차)은 평균을 믿지 않는다', () => {
  const f = fusePair(view(0, [12, -8, 0]), view(90, [12, -8, 0]));
  assert.equal(f.rzGapDeg, 90);
  assert.match(judge(f).why, /거울이 아니에요/);
});

test('편향 작으면 ok — 3mm 판정선은 손가락 여유 4.5 의 안', () => {
  const f = fusePair(view(-0.3 + 90, [2, 1, 0]), view(-0.3 - 90, [2, 1, 0]));
  assert.ok(f.halfDiffMm <= HALF_DIFF_MAX_MM); assert.equal(judge(f).ok, true);
});

test('요각 원형 평균 — −89 와 89 는 0 이 아니라 ±90', () => {
  assert.ok(Math.abs(Math.abs(meanYaw180(-89, 89)) - 90) < 1e-6);
  assert.ok(Math.abs(meanYaw180(10, 20) - 15) < 1e-9);
  assert.equal(meanYaw180(null, 30), 30);
  assert.equal(foldYaw(180), 0); assert.equal(foldYaw(-90), -90); assert.equal(foldYaw(95), -85);
});

test('mirrorPair — tilt 0 · rz 가 파지 rz ±90 에서 0.5° 안 · 두 자세가 180° 차 · 카메라는 표적 바로 위', () => {
  const rzG = CARRIER_GRASP_TRUTH.tcpMmDeg[5];
  const m = mirrorPair(truth, T_HE, rzG, { distMm: 300 });
  assert.ok(m, '쌍이 나온다');
  const wrap = (d) => ((d % 360) + 540) % 360 - 180;
  assert.ok(Math.abs(wrap(m.a[5] - (rzG + 90))) < 0.5, `a rz ${m.a[5]}`);
  assert.ok(Math.abs(wrap(m.b[5] - (rzG - 90))) < 0.5, `b rz ${m.b[5]}`);
  assert.ok(Math.abs(Math.abs(wrap(m.a[5] - m.b[5])) - 180) < 1.0);
  // 손끝이 아니라 **카메라**가 표적 위 300 에 서야 한다 — hand-eye 를 되더한 카메라 자리로 검산
  for (const p of [m.a, m.b]) assert.ok(Math.abs(p[3]) > 170, `rx ${p[3]} — 아래를 본다(수직)`);
});

test('요각 입력 — graspRzDeg θ 면 손목 rz 가 정본 + θ · 없으면 정본', () => {
  const s0 = makeLoadSteps(AMR_DROP); const s1 = makeLoadSteps(AMR_DROP, { graspRzDeg: 30 });
  assert.equal(s0[1].pose[5], CARRIER_GRASP_TRUTH.tcpMmDeg[5]);
  assert.ok(Math.abs(s1[1].pose[5] - (CARRIER_GRASP_TRUTH.tcpMmDeg[5] + 30)) < 1e-9);
  assert.ok(Math.abs((s1[4].pose[5] - s1[1].pose[5]) - (s0[4].pose[5] - s0[1].pose[5])) < 1e-9, '⑤ 상대 회전은 그대로');
});

test('바구니 관측 — 자리·요각을 주면 ⑥~⑨ 가 그 자리로 · 요각 5° 면 ⑦ 손목이 5° 돈다', () => {
  const s0 = makeLoadSteps(AMR_DROP);
  const basket = { xMm: 700, yMm: -1000, yawDeg: foldYaw(AMR_DROP.yawDeg + 5) };
  const s1 = makeLoadSteps(AMR_DROP, { basket });
  const ins0 = s0.find((x) => x.id === 'insert'); const ins1 = s1.find((x) => x.id === 'insert');
  assert.ok(Math.abs(ins1.pose[5] - ins0.pose[5] - 5) < 1e-9, `⑦ rz ${ins1.pose[5]} vs ${ins0.pose[5]}`);
  assert.ok(Math.hypot(ins1.pose[0] - 700, ins1.pose[1] + 1000) < 60, '⑦ 자리는 관측 중심에서 몸통 오프셋(34.5) 안');
  assert.equal(ins1.pose[2], ins0.pose[2], '높이는 그대로');
  assert.equal(nearestYaw(0, 180), 180); assert.equal(nearestYaw(5, 180), 185); assert.equal(nearestYaw(-85, 90), 95);
  assert.ok(Math.abs(nearestYaw(89.9, -75.9) + 90.1) < 1e-9, '실기 경계 케이스: +89.9° 축은 관측 -75.9° 쪽의 같은 대표 -90.1°');
  assert.equal(nearestYaw(NaN, AMR_HOME.yawDeg), AMR_HOME.yawDeg);
});

test('센터링 — 축에서 50mm 넘게 벗어나 본 평균은 비교에 안 쓴다(옮기기만) · 중앙에서 본 두 패스가 맞으면 통과', () => {
  const bias = [12, -8, 0];
  const off = (rz, cam) => ({ ...view(rz, bias), camMm: cam });
  const f1 = fusePair(off(0, [-61.8, -20.3, 359]), off(180, [34.5, 51.8, 358]));
  assert.ok(Math.abs(f1.offCenterMm - Math.hypot(61.8, 20.3)) < 0.1, `${f1.offCenterMm}`);   // 두 눈 중 큰 쪽
  const j1 = judge(f1); assert.equal(j1.ok, false); assert.equal(j1.retry, true); assert.match(j1.why, /축에서/);
  // 2패스는 중앙(14mm) — 1패스가 12mm 갈려도 비교하지 않고 한 번 더
  const f2 = fusePair(off(90, [-3.5, 14.3, 302]), off(270, [-27.5, 10.4, 300]));
  const shifted1 = { ...f1, user1Mm: [f1.user1Mm[0] + 12, f1.user1Mm[1], f1.user1Mm[2]] };
  const j2 = judge(f2, 2, { prevFused: shifted1 }); assert.equal(j2.ok, false); assert.equal(j2.retry, true); assert.match(j2.why, /한 번 더/);
  // 3패스도 중앙이고 2패스와 맞으면 통과 · 상한 3
  const j3 = judge(fusePair(off(0, [2, 1, 300]), off(180, [1, -2, 300])), 3, { prevFused: f2 }); assert.equal(j3.ok, true);
  const j3bad = judge({ ...f2, user1Mm: [f2.user1Mm[0] + 6, f2.user1Mm[1], f2.user1Mm[2]] }, 3, { prevFused: f2 }); assert.equal(j3bad.ok, false); assert.equal(j3bad.retry, false);
});

test('한 눈 판정 — 프로필 singleView 가 있어야만 · 없으면 null(두 눈)', () => {
  const v = { rzDeg: 180, user1Mm: [370.7, -1114.7, -327], yawDeg: -1.1, camMm: [-11.8, 43.4, 358], bulletsUser1Mm: [[365, -1110]] };
  assert.equal(singleViewFused(v, { tMm: [0, 0, 0] }), null);
  const f = singleViewFused(v, { tMm: [0, 0, 0], singleView: true, residualMm: 1.9, biasCorrectedAt: '2026-09-07' });
  assert.equal(f.ok, true); assert.equal(f.n, 1); assert.deepEqual(f.user1Mm, v.user1Mm); assert.deepEqual(f.bulletsUser1Mm, v.bulletsUser1Mm);
  assert.match(f.why, /한 번 보고/); assert.equal(f.offCenterMm, 45);
});

test('총알 증거 — 기대 1개인데 빈 배열·결측이면 차단, 1개를 찾았을 때만 통과', () => {
  assert.deepEqual(bulletEvidence({ bulletsUser1Mm: [] }, 1), { ok: false, expected: 1, detected: 0, why: '총알 0/1개 검출 — 위치 미확인이라 하강·닫기 금지' });
  assert.equal(bulletEvidence({}, 1).ok, false);
  assert.equal(bulletEvidence({ bulletsUser1Mm: [[1, 2]] }, 1).ok, true);
  assert.equal(bulletEvidence({ bulletsUser1Mm: [] }, 0).ok, true);
});

test('총알 근접 재관측 — xy는 깊이 중심으로 맞추되 안쪽 바닥 z로 더 내려가지 않는다', () => {
  assert.deepEqual(closerObservationTarget(
    { user1Mm: [-177.1, -1026.7, -269] },
    { user1Mm: [-189.35, -1032.96, -323.4] },
  ), [-189.35, -1032.96, -269]);
  assert.equal(closerObservationTarget(null, { user1Mm: [1, 2, 3] }), null);
});

test('총알 자동 탐색 — 최대 4후보·Min-Z+30mm 이상에서 거리와 광축 요각을 바꾼다', () => {
  const specs = bulletSearchSpecs(-89.8);
  assert.equal(specs.length, 4);
  assert.deepEqual(specs.map(({ distMm, yawOffsetDeg }) => [distMm, yawOffsetDeg]), [
    [250, 0], [225, 0], [250, 90], [250, -90],
  ]);
  assert.ok(specs.every((spec) => spec.distMm >= 225));
  assert.deepEqual(specs.map((spec) => spec.index), [1, 2, 3, 4]);
  assert.equal(bulletSearchSpecs(NaN).length, 0);
});

test('거울 쌍 총알 — 두 눈 모두 필드를 냈을 때만 더 많이 본 한 눈을 보존한다', () => {
  const a = { ...view(0, [1, 0, 0]), bulletsUser1Mm: [[10, 20]] };
  const b = { ...view(180, [1, 0, 0]), bulletsUser1Mm: [[11, 20], [30, 40]] };
  assert.deepEqual(fusePair(a, b).bulletsUser1Mm, b.bulletsUser1Mm);
  assert.equal(fusePair(a, view(180, [1, 0, 0])).bulletsUser1Mm, null);
});

test('이어 찾기 — 첫 폴링 전 fallback은 신선한 color로 승격하고 depth 재센터링은 보존한다', () => {
  const color = { user1Mm: [-58, -1085, -277], yawDeg: 1.4, source: 'color(0s)' };
  assert.equal(preferLiveCoarse(null, color), color);
  assert.equal(preferLiveCoarse({ source: 'truth-0831' }, color), color);
  assert.equal(preferLiveCoarse({ source: 'input' }, color), color);
  const depth = { user1Mm: [-57, -1086, -328], source: 'depth-pass1' };
  assert.equal(preferLiveCoarse(depth, color), depth);
});
