// 컨베이어 사이클 — 시간축·자리·거치대 주인이 규약대로인가 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCycle, unloadSteps, stepSeconds, observedStop, DEMO_SPEED_PCT } from './cycle.js';
import { AMR_HOME, AMR_DROP, AMR_DRIVE_MM_S, AMR_SHUTTLE_MM, AMR_ARRIVE_ERR_MM, AMR_TURN_DEFICIT_DEG, JOINT_DEG_S_AT_FULL, MOVE_FIXED_S } from '../workcell.js';

// 시뮬 탭 `makeSteps` 와 같은 id 아홉 — 자세는 시험용 (좌표를 지어내는 것이 아니라 **모양**만 맞춘 것)
const G = [657.2, -1103.0, -366.0, 178.8, -1.3, -90.3];
const at = (x, y, z) => [x, y, z, G[3], G[4], G[5]];
const LOAD = [
  { id: 'approach', grip: 100, pose: at(G[0], G[1], G[2] + 120) },
  { id: 'grasp', grip: 100, pose: at(G[0], G[1], G[2]) },
  { id: 'close', grip: 40, pose: at(G[0], G[1], G[2]) },
  { id: 'lift', grip: 40, pose: at(G[0], G[1], G[2] + 120) },
  { id: 'carry', grip: 40, pose: at(500, -900, G[2] + 120) },
  { id: 'over', grip: 40, pose: at(500, -900, -250) },
  { id: 'insert', grip: 40, pose: at(500, -900, -300) },
  { id: 'release', grip: 100, pose: at(500, -900, -300) },
  { id: 'retreat', grip: 100, pose: at(500, -900, -250) },
];
const J = (k) => [80 + k, -54, 129, -167, -89, 8];
const SOLVED = LOAD.map((_, k) => ({ jointsDeg: J(k * 3) }));
const USER = [-401.846, 497.329, 342.076, -0.005, 0, 0.001];

test('내리기 8칸은 싣기 자세의 되쓰기다 — 새 좌표 0', () => {
  const u = unloadSteps(LOAD);
  assert.equal(u.length, 8);
  assert.deepEqual(u[0].pose, LOAD[5].pose);            // 바구니 위 = over
  assert.deepEqual(u[5].pose, LOAD[1].pose);            // 판에 내려놓기 = grasp
  assert.equal(u[2].grip, 40);                          // 문는 값은 싣기 ③ 과 같다
  assert.equal(unloadSteps(LOAD.slice(0, 4)), null);    // 칸이 모자라면 못 만든다
});

test('관절 시간은 제일 많이 도는 관절 ÷ (28.9 × 10%) + 고정비용', () => {
  const s = stepSeconds([0, 0, 0, 0, 0, 0], [0, 28.9, 0, 0, 0, 0], 100, 100, DEMO_SPEED_PCT);
  assert.ok(Math.abs(s - (MOVE_FIXED_S + 28.9 / (JOINT_DEG_S_AT_FULL * 0.1))) < 1e-9);
  assert.equal(stepSeconds([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], 100, 100), 0);   // 안 움직이면 0
  assert.ok(stepSeconds([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], 100, 40) > 0);       // 그리퍼만 움직여도 시간이 든다
});

test('사이클 21구간(주행 4 + 싣기 9 + 내리기 8) · 주행 시간은 거리 ÷ 실측 속도 · 시작·끝은 홈', () => {
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop: AMR_DROP, userDef: USER });
  assert.equal(c.why, null);
  assert.equal(c.acts.length, 1 + 9 + 2 + 8 + 1);
  const dOut = c.acts.find((a) => a.id === 'd-out');
  assert.ok(Math.abs(dOut.durMs / 1000 - (AMR_SHUTTLE_MM / AMR_DRIVE_MM_S + 0.3)) < 0.01);
  const s0 = c.sample(0);
  assert.deepEqual(s0.amrUser1, [AMR_HOME.xMm, AMR_HOME.yMm]);
  assert.deepEqual(s0.carrierHeldTcp, LOAD[1].pose.slice(0, 3));   // 판 위
  assert.ok(s0.pose && Math.abs(s0.pose.xMm) < 1e-6 && Math.abs(s0.pose.yMm) < 1e-6, 'odom 원점 = 홈');
  const end = c.sample(c.totalMs);
  assert.deepEqual(end.amrUser1, [AMR_HOME.xMm, AMR_HOME.yMm]);
  assert.deepEqual(end.carrierHeldTcp, LOAD[1].pose.slice(0, 3));  // 다시 판 위
  assert.equal(s0.trail.length, 2, '예정 경로 리본 = 홈 → 먼 끝');
});

test('실은 채 갈 때 거치대는 바구니와 같이 움직이고, 앞으로 500mm 는 요각 방향이다', () => {
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop: AMR_DROP, userDef: USER });
  const dOut = c.acts.find((a) => a.id === 'd-out');
  const far = c.sample(dOut.t0Ms + dOut.durMs - 1);
  const dx = far.amrUser1[0] - AMR_DROP.xMm;
  assert.ok(Math.abs(dx + AMR_SHUTTLE_MM) < 2, `요각 180° 라 −x 로 ${AMR_SHUTTLE_MM} — 실제 ${dx.toFixed(1)}`);
  // 거치대는 **실제** 바구니에 있다 — 명령 자리 + 유령의 도착 오차(짧게 선 만큼 되돌아온 쪽). 명령 자리와의 차가 곧 driftMm (2026-09-06)
  const offX = far.carrierHeldTcp[0] - (LOAD[6].pose[0] + dx);
  assert.ok(Math.abs(Math.abs(offX) - far.driftMm) < 0.5 && far.driftMm > 30, `거치대가 실제 바구니와 같이 갔다 — 명령 자리와 ${offX.toFixed(1)} · 유령 ${far.driftMm.toFixed(1)}`);
  assert.equal(far.carrierHeldTcp[2], LOAD[6].pose[2]);
  assert.deepEqual(far.armJoints, SOLVED[8].jointsDeg);                 // 팔은 ⑨ 자세로 기다린다
  assert.deepEqual(far.tcpMmDeg, LOAD[8].pose);                         // 손끝 자세도 ⑨ — 시야 발자국 재료
  // 도착 오차 유령 — 주행 끝에서 실측 37.5mm 만큼 주행 방향으로 짧다 (odom 으로 준다)
  assert.ok(Math.abs(far.driftMm - 37.5) < 0.5, `${far.driftMm}`);
  assert.ok(far.driftPose && Math.abs(Math.hypot(far.driftPose.xMm - far.pose.xMm, far.driftPose.yMm - far.pose.yMm) - 37.5) < 0.5);
  const s0 = c.sample(0);
  assert.equal(s0.driftMm, 0, '출발 전엔 오차 0');
  const mid = c.sample(c.acts[2].t0Ms + c.acts[2].durMs / 2);            // 싣기 ② 한가운데
  assert.equal(mid.tcpMmDeg.length, 6);
});

test('유령은 구간 경계에서 순간이동하지 않는다 — 1ms 앞뒤 차가 1mm 안 (감사 ②-1)', () => {
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop: AMR_DROP, userDef: USER });
  for (const a of c.acts.slice(1)) {
    const b = c.sample(a.t0Ms - 1); const n = c.sample(a.t0Ms);
    const d = Math.hypot(b.driftPose.xMm - n.driftPose.xMm, b.driftPose.yMm - n.driftPose.yMm);
    assert.ok(d < 1, `${a.id} 경계에서 ${d.toFixed(1)}mm 점프`);
  }
});

test('모든 구간이 재생에서 한 번은 잡힌다 — 0ms 칸이 건너뛰어지지 않는다 (감사 ②-3)', () => {
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop: AMR_DROP, userDef: USER });
  const seen = new Set();
  for (let t = 0; t <= c.totalMs; t += 1) seen.add(c.sample(t).actIndex);
  assert.equal(seen.size, c.acts.length, `잡힌 구간 ${seen.size}/${c.acts.length}`);
});

test('제자리 회전 정차 후보(요각 270)는 유령 요각이 덜 돈 각만큼 어긋난다 (감사 ②-2)', () => {
  const stop = { xMm: AMR_HOME.xMm, yMm: AMR_HOME.yMm, yawDeg: 270, fromHomeMm: 0, turnFromHomeDeg: 90 };
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop, userDef: USER });
  const din = c.acts[0];
  assert.ok(din.durMs > 0, '회전만 있는 구간도 시간이 있다');
  const afterTurn = c.sample(din.t0Ms + din.durMs);
  assert.ok(Math.abs(Math.abs(afterTurn.driftYawDeg) - AMR_TURN_DEFICIT_DEG) < 1e-9, `${afterTurn.driftYawDeg}`);
  assert.equal(afterTurn.driftMm, 0, '자리 오차는 직진에서만 — 회전 구간엔 실측이 없다');
  const dOut = c.acts.find((a) => a.id === 'd-out');
  const far = c.sample(dOut.t0Ms + dOut.durMs - 1);
  assert.ok(Math.abs(far.amrUser1[1] - (AMR_HOME.yMm - AMR_SHUTTLE_MM)) < 2, '요각 270 이라 −y 로 앞');
});

test('안 풀린 칸이 있으면 사이클을 안 만든다 — 사유를 준다', () => {
  const half = SOLVED.map((o, i) => (i === 4 ? { jointsDeg: null } : o));
  const c = buildCycle({ load: LOAD, solved: half, stop: AMR_DROP, userDef: USER });
  assert.ok(c.why && c.why.includes('시뮬 풀기'));
});

test('좌표계(user1)가 없으면 터틀봇 자리는 안 주고 팔·거치대는 준다', () => {
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop: AMR_DROP, userDef: null });
  const s = c.sample(1000);
  assert.equal(s.pose, undefined);
  assert.ok(Array.isArray(s.armJoints) && s.carrierHeldTcp.length === 3);
});

test('⑩ 관측 자리 = 유령이 되돌아와 선 자리 — 같은 모델 (0.01mm · 0.01°)', () => {
  const stop = { xMm: 633.1, yMm: -948.2, yawDeg: AMR_HOME.yawDeg + 90 };     // 제자리 회전이 있는 후보 — 각 오차까지 본다
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop, userDef: USER });
  const back = c.acts.find((a) => a.id === 'd-back');
  const s = c.sample(back.t0Ms + back.durMs - 1);
  const o = observedStop(stop);
  assert.ok(Math.abs(s.amrUser1[0] + s.driftMm * 0 - stop.xMm) < 1);            // 명령 자리는 정차 자리
  const realX = stop.xMm + back.driftTo[0]; const realY = stop.yMm + back.driftTo[1];
  assert.ok(Math.abs(o.xMm - realX) < 0.01 && Math.abs(o.yMm - realY) < 0.01, `${o.xMm},${o.yMm} vs ${realX},${realY}`);
  assert.ok(Math.abs(o.yawErrDeg - s.driftYawDeg) < 0.01, `${o.yawErrDeg} vs ${s.driftYawDeg}`);
  assert.equal(o.missMm, AMR_ARRIVE_ERR_MM);
});

test('관측을 반영하면 바구니 쪽 4칸만 실제 자리로 옮겨지고 판 쪽 4칸은 그대로다', () => {
  const stop = AMR_DROP;
  const o = observedStop(stop);
  const u0 = unloadSteps(LOAD); const u = unloadSteps(LOAD, { stop, observed: o });
  for (const id of ['u-over', 'u-reach', 'u-close', 'u-lift']) {
    const a = u0.find((s) => s.id === id); const b = u.find((s) => s.id === id);
    assert.ok(b.fixed);
    assert.ok(Math.abs(b.pose[0] - a.pose[0] - o.dxMm) < 1e-9 && Math.abs(b.pose[1] - a.pose[1] - o.dyMm) < 1e-9, id);
    assert.equal(b.pose[2], a.pose[2]);
    assert.ok(Math.abs(Math.hypot(b.pose[0] - a.pose[0], b.pose[1] - a.pose[1]) - AMR_ARRIVE_ERR_MM) < 1e-9);
  }
  for (const id of ['u-carry', 'u-place', 'u-release', 'u-retreat']) {
    assert.deepEqual(u.find((s) => s.id === id).pose, u0.find((s) => s.id === id).pose, id);
  }
  // 관측을 받았는데 그 자세의 해가 없으면 사이클을 만들지 않는다 — 옛 관절값이 새 자리인 척하지 않게
  assert.ok(buildCycle({ load: LOAD, solved: SOLVED, stop, userDef: USER, observed: o }).why);
  const uj = { 'u-over': J(50), 'u-reach': J(51), 'u-close': J(51), 'u-lift': J(50) };
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop, userDef: USER, observed: o, unloadSolved: uj });
  assert.equal(c.why, null);
  assert.deepEqual(c.acts.find((a) => a.id === 'u-reach').nextJ, J(51));
  assert.deepEqual(c.acts.find((a) => a.id === 'u-place').nextJ, SOLVED[1].jointsDeg);   // 판 쪽은 싣기 되쓰기 그대로
});

test('바구니 속 거치대는 실제 바구니(유령)에 있다 — 되돌아온 뒤 도착 오차만큼 명령 자리와 다르다', () => {
  const c = buildCycle({ load: LOAD, solved: SOLVED, stop: AMR_DROP, userDef: USER });
  const back = c.acts.find((a) => a.id === 'd-back');
  const s = c.sample(back.t0Ms + back.durMs - 1);
  const dx = s.carrierHeldTcp[0] - LOAD[6].pose[0]; const dy = s.carrierHeldTcp[1] - LOAD[6].pose[1];
  assert.ok(Math.abs(Math.hypot(dx, dy) - AMR_ARRIVE_ERR_MM) < 0.5, `${Math.hypot(dx, dy)}`);
});

test('⓪ 도착 자리(in) = 유령이 들어와 선 자리 · 싣기를 그 자리로 풀면 놓는 순간 거치대가 뛰지 않는다', () => {
  const stop = AMR_DROP;
  const oIn = observedStop(stop, AMR_HOME, { leg: 'in' });
  const c0 = buildCycle({ load: LOAD, solved: SOLVED, stop, userDef: USER });
  const dIn = c0.acts.find((a) => a.id === 'd-in');
  assert.ok(Math.abs(oIn.dxMm - dIn.driftTo[0]) < 0.01 && Math.abs(oIn.dyMm - dIn.driftTo[1]) < 0.01, `${oIn.dxMm},${oIn.dyMm} vs ${dIn.driftTo}`);
  // 열린 루프: 놓고 손을 뺀 순간(retreat · 바구니 상태 시작) 바구니 속 자리가 손끝이 놓은 자리와 도착 오차만큼 다르다 — 카메라 없는 싣기의 빗나감
  const rel0 = c0.acts.find((a) => a.id === 'retreat');
  const s0 = c0.sample(rel0.t0Ms + rel0.durMs - 1);
  const jump0 = Math.hypot(s0.carrierHeldTcp[0] - LOAD[6].pose[0], s0.carrierHeldTcp[1] - LOAD[6].pose[1]);
  assert.ok(Math.abs(jump0 - AMR_ARRIVE_ERR_MM) < 0.5, `열린 루프 튐 ${jump0}`);
  // 관측 반영: 싣기 9칸이 도착 자리 기준으로 풀렸다고 치면(loadAmr) 놓는 순간 튐 0
  const LOAD_IN = LOAD.map((s) => (['carry', 'over', 'insert', 'release', 'retreat'].includes(s.id)
    ? { ...s, pose: [s.pose[0] + oIn.dxMm, s.pose[1] + oIn.dyMm, ...s.pose.slice(2)] } : s));
  // 내릴 때 자리(관측 없음 = 명령 자리)가 싣기 자리와 다르므로 바구니 쪽 내리기 해를 같이 준다 — 없으면 사이클이 거부하는 게 규약
  const uj = { 'u-over': J(50), 'u-reach': J(51), 'u-close': J(51), 'u-lift': J(50) };
  assert.ok(buildCycle({ load: LOAD_IN, solved: SOLVED, stop, userDef: USER, loadAmr: oIn }).why, '내리기 해 없이는 거부');
  const c1 = buildCycle({ load: LOAD_IN, solved: SOLVED, stop, userDef: USER, loadAmr: oIn, unloadSolved: uj });
  const rel1 = c1.acts.find((a) => a.id === 'retreat');
  const s1 = c1.sample(rel1.t0Ms + rel1.durMs - 1);
  const jump1 = Math.hypot(s1.carrierHeldTcp[0] - LOAD_IN[6].pose[0], s1.carrierHeldTcp[1] - LOAD_IN[6].pose[1]);
  assert.ok(jump1 < 0.01, `관측 반영 튐 ${jump1}`);
  // pose = 실제 자리 · driftPose = 명령 자리 — 둘 사이가 도착 오차
  assert.ok(Math.abs(s1.driftMm - AMR_ARRIVE_ERR_MM) < 0.01);
  assert.deepEqual(s1.realUser1.map((v) => +v.toFixed(3)), [oIn.xMm, oIn.yMm].map((v) => +v.toFixed(3)));
});
