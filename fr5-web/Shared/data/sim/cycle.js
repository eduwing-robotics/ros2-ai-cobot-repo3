// 컨베이어 한 사이클 — **터틀봇이 컨베이어다** (2026-09-06 · `docs/archive/GRILL-conveyor-twin-progresslog-2026-09-06.md` #1·#4·#6·#7·#13).
//
//   팔이 거치대를 집어 안전 높이까지 든다 · 홈 → 정차 자리로 온다 · 바구니를 보고 싣는다(9자세+사전성형) · 실은 채 앞으로 갔다 되돌아온다 ·
//   팔이 거치대를 내린다(8칸 · 싣기의 역순) · 홈으로 돌아간다
//
// **시연이다 — 실기 근거가 아니다.** 좌표는 전부 실측 SSOT(`workcell.js`·`props.js`)와 시뮬 탭이 컨트롤러
// `/ik` 로 푼 관절각을 **읽어 쓰기만** 하고, 여기서 새 좌표를 만들지 않는다. 내리기 8칸은 싣기 9칸의 자세를
// 되쓰므로 IK 를 더 묻지 않는다. 시간축은 실기 속도(상한 10% · 관절 28.9°/s@100 · 주행 138.5mm/s 실측)로
// 잰 **실시간**이고, 배속은 보는 쪽(`SimPanel`)이 정한다 (#13).
//
// 트윈(`RobotTwin.jsx`)은 거치대를 「손에 들린 자리」에만 그리므로, 판 위·바구니 안에 있을 때도
// **그 자리의 손끝**을 `carrierHeldTcp` 로 넘겨 계속 보이게 한다 — 트윈 수정 0.
import { AMR_HOME, AMR_DRIVE_MM_S, AMR_SHUTTLE_MM, AMR_ARRIVE_ERR_MM, AMR_TURN_DEFICIT_DEG, JOINT_DEG_S_AT_FULL, MOVE_FIXED_S } from '../workcell.js';
import { toFrame } from '../frames.js';

/** 시연 속도 — 실기 상한과 같은 값 (`SAFETY-RULES.md` §상한 · 하드 룰 3). 더 빠른 그림은 실기가 못 낸다 */
export const DEMO_SPEED_PCT = 10;
/** 그리퍼 전 행정 시간 (최고속 · 2026-08-11 10Hz 실측). 정본 `FR5/bridge/robot_adapter/fairino.py` `GRIPPER_STROKE_S_AT_FULL` */
export const GRIPPER_STROKE_S_AT_FULL = 1.15;
/** 정차 뒤 다음 동작까지 쉬는 시간 — `config.yaml follow.settleMs` 와 같은 300ms */
export const SETTLE_S = 0.3;

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const xyz = (p) => [p[0], p[1], p[2]];

/**
 * 싣기 9자세+사전성형(`SimPanel.makeSteps`)을 뒤집어 **내리기 8칸**을 만든다. 자세는 id 로 되쓴다 — 새 좌표 0.
 * 순서: 바구니 위 → 문 자리 → 문다 → 곧게 위로 → 판 위 → 판에 내려놓기 → 놓는다 → 위로.
 * @returns {Array|null} 싣기에 필요한 칸(approach·grasp·lift·over·insert·close)이 없으면 null
 */
/**
 * ⑩ 관측이 보고할 터틀봇 자리 — 되돌아온 뒤 **실제로 선 자리**. 유령(#12)과 **같은 모델**이다: 도착은 주행 방향으로 `arriveErrMm` 짧고,
 * 제자리 회전이 있었으면 `turnDeficitDeg` 만큼 덜 돌아 있다(실측 08-20 `tb-drift-turn.md`). 집에선 이 값이 「카메라가 본 것」의 자리를 맡고,
 * 랩에선 손목 뎁스 검출값이 이 모양 그대로 들어온다 (2026-09-06 · 주인님 「비전의 역할이 거의 없는 건가」).
 * @returns {{xMm:number,yMm:number,yawDeg:number,dxMm:number,dyMm:number,yawErrDeg:number,missMm:number}}
 */
export function observedStop(stop, home = AMR_HOME, { leg = 'back', arriveErrMm = AMR_ARRIVE_ERR_MM, turnDeficitDeg = AMR_TURN_DEFICIT_DEG } = {}) {
  const th = (stop.yawDeg * Math.PI) / 180;
  const turnDeg = stop.yawDeg - home.yawDeg;
  const yawErrDeg = turnDeg ? -Math.sign(turnDeg) * turnDeficitDeg : 0;
  let dxMm; let dyMm;
  if (leg === 'in') {
    // 홈 → 정차: 온 방향으로 짧게 선다(홈 쪽에 남는다). 홈과 같은 자리(회전만)면 자리 오차 0
    const len = Math.hypot(stop.xMm - home.xMm, stop.yMm - home.yMm);
    dxMm = len > 0 ? -((stop.xMm - home.xMm) / len) * arriveErrMm : 0;
    dyMm = len > 0 ? -((stop.yMm - home.yMm) / len) * arriveErrMm : 0;
  } else {
    dxMm = Math.cos(th) * arriveErrMm; dyMm = Math.sin(th) * arriveErrMm;   // 되돌아올 때 짧게 선다 = 앞쪽(FAR 쪽)에 남는다
  }
  return { xMm: stop.xMm + dxMm, yMm: stop.yMm + dyMm, yawDeg: stop.yawDeg + yawErrDeg, dxMm, dyMm, yawErrDeg, missMm: Math.hypot(dxMm, dyMm), leg };
}

/** 관측이 있으면 바구니 쪽 자리(u-over·u-reach·u-close·u-lift)를 **실제로 선 터틀봇**에 맞춰 옮긴다 — 정차 자리를 축으로 덜 돈 각만큼 돌리고 도착 오차만큼 민다 */
const BASKET_STEPS = new Set(['u-over', 'u-reach', 'u-close', 'u-lift']);
export function unloadSteps(load, { stop = null, observed = null, from = null, to = null } = {}) {
  const by = Object.fromEntries((load ?? []).map((s) => [s.id, s]));
  if (['approach', 'grasp', 'lift', 'over', 'insert', 'close'].some((k) => !by[k])) return null;
  const g = by.close.grip;
  // 싣기 때 터틀봇이 선 자리(from) → 내릴 때 선 자리(to). 둘이 같으면 되쓰기 그대로다
  const f = from ?? stop; const t2 = to ?? observed;
  const dYaw = f && t2 ? (t2.yawDeg - f.yawDeg) : 0;
  const moved = f && t2 && (Math.hypot(t2.xMm - f.xMm, t2.yMm - f.yMm) > 1e-6 || Math.abs(dYaw) > 1e-9);
  const fix = (s) => {
    if (!moved || !BASKET_STEPS.has(s.id)) return s;
    const e = (dYaw * Math.PI) / 180; const c = Math.cos(e); const sn = Math.sin(e);
    const p = s.pose; const dx = p[0] - f.xMm; const dy = p[1] - f.yMm;
    const miss = Math.hypot(t2.xMm - f.xMm, t2.yMm - f.yMm);
    return { ...s, fixed: true,
      pose: [t2.xMm + dx * c - dy * sn, t2.yMm + dx * sn + dy * c, p[2], p[3], p[4], p[5] + dYaw],
      why: `${s.why} · ⑩ 관측 반영 — 터틀봇이 실제로 선 자리로 (${miss.toFixed(1)}mm${dYaw ? ` · ${dYaw.toFixed(1)}°` : ''})` };
  };
  return [
    { id: 'u-over', from: 'over', label: '⑩ 바구니 위', grip: 100, pose: by.over.pose, why: '테두리 위 40mm — 벌린 채 접근' },
    { id: 'u-reach', from: 'insert', label: '⑪ 문 자리로', grip: 100, pose: by.insert.pose, why: '싣기 ⑦ 과 같은 자리 — 거치대 바닥이 거기 있다' },
    { id: 'u-close', from: 'insert', label: '⑫ 문다', grip: g, pose: by.insert.pose, why: '싣기 ③ 과 같은 값' },
    { id: 'u-lift', from: 'over', label: '⑬ 곧게 위로', grip: g, pose: by.over.pose, why: '옆으로 빼면 손가락이 테두리를 친다 (한쪽 여유 4.5mm)' },
    { id: 'u-carry', from: 'lift', label: '⑭ 판 위로', grip: g, pose: by.lift.pose, why: '파지점 위 — 싣기 ④ 자세' },
    { id: 'u-place', from: 'grasp', label: '⑮ 판에 내려놓는다', grip: g, pose: by.grasp.pose, why: '사람이 손으로 맞춘 파지 자세 그 자리' },
    { id: 'u-release', from: 'grasp', label: '⑯ 놓는다', grip: 100, pose: by.grasp.pose, why: '그리퍼 연다 — 거치대는 판 위에 남는다' },
    { id: 'u-retreat', from: 'approach', label: '⑰ 위로 빠진다', grip: 100, pose: by.approach.pose, why: '싣기 ① 자세로' },
  ].map(fix);
}

/** 관절 이동 시간(s) — 제일 많이 도는 관절 ÷ (28.9°/s × 속도%) + 고정비용. 그리퍼만 움직이면 행정 비례 */
export function stepSeconds(fromJ, toJ, fromGrip, toGrip, speedPct = DEMO_SPEED_PCT) {
  const dj = fromJ && toJ ? Math.max(...toJ.map((v, i) => Math.abs(v - fromJ[i]))) : 0;
  const armS = dj > 0.01 ? MOVE_FIXED_S + dj / (JOINT_DEG_S_AT_FULL * speedPct / 100) : 0;
  const gripS = Math.abs((toGrip ?? 100) - (fromGrip ?? 100)) / 100 * GRIPPER_STROKE_S_AT_FULL;
  return Math.max(armS, gripS, dj > 0.01 || gripS > 0 ? SETTLE_S : 0);
}

/**
 * 사이클을 만든다. `load` 는 시뮬 탭의 10칸(9자세+사전성형), `solved[i].jointsDeg` 는 그 칸의 관절각(컨트롤러 IK · 전부 있어야 한다).
 * @returns {{acts, totalMs, sample, why}|{why:string}}  sample(tMs) → 트윈에 넘길 replay 조각
 */
export function buildCycle({ load, solved, stop, userDef, home = AMR_HOME, carrierKnown = false, heldScan = null,
  speedPct = DEMO_SPEED_PCT, driveMmS = AMR_DRIVE_MM_S, shuttleMm = AMR_SHUTTLE_MM, arriveErrMm = AMR_ARRIVE_ERR_MM,
  turnDeficitDeg = AMR_TURN_DEFICIT_DEG, observe = null, loadAmr = null, observed = null, unloadSolved = null,
  startAtStop = false, initialArm = null }) {
  if (!Array.isArray(load) || load.length < 10) return { why: '싣기 10칸이 없어요' };
  if (!Array.isArray(solved) || solved.length !== load.length || solved.some((o) => !o?.jointsDeg)) {
    return { why: '10칸이 전부 풀려야 사이클을 만들 수 있어요 — 「시뮬 풀기」 먼저' };
  }
  if (!stop || !Number.isFinite(stop.xMm) || !Number.isFinite(stop.yMm)) return { why: '정차 자리가 없어요' };
  // ⑩ 관측 반영 — `observed` 가 있으면 바구니 쪽 내리기 자리가 실제로 선 터틀봇으로 옮겨지고, 그 자세의 해는 부르는 쪽이 IK 로 채운다(`unloadSolved`).
  //    없으면 **열린 루프**: 팔은 명령한 자리에 내리고 거치대는 실제 바구니에 있다 — 그 어긋남이 곧 「카메라가 없으면 빗나가는 양」이다
  //    `loadAmr` = 싣기 9칸을 푼 터틀봇 자리(⓪ 관측이 본 도착 자리 · 없으면 명령 자리). 바구니 속 거치대는 그 자리 기준으로 실제 터틀봇을 따른다
  const stopXY = { xMm: stop.xMm, yMm: stop.yMm, yawDeg: stop.yawDeg };
  const amrLoad = loadAmr ?? stopXY;
  const unload = unloadSteps(load, { from: amrLoad, to: observed ?? stopXY });
  if (!unload) return { why: '싣기 칸 이름이 달라 내리기를 못 만들어요' };
  const loadIdx = Object.fromEntries(load.map((s, i) => [s.id, i]));
  if (unload.some((s) => s.fixed && !unloadSolved?.[s.id])) return { why: '⑩ 관측을 반영한 내리기 자세가 안 풀렸어요 — 관측 반영을 끄면 열린 루프로 볼 수 있어요' };
  const unloadJ = unload.map((s) => (s.fixed ? unloadSolved[s.id] : solved[loadIdx[s.from]].jointsDeg));
  const loadJ = solved.map((o) => o.jointsDeg);
  const grasp = xyz(load[loadIdx.grasp].pose);       // 판 위 — 거치대가 쉬는 자리
  const basket = xyz(load[loadIdx.insert].pose);     // 바구니 안 — 실린 거치대의 손끝 자리

  // 터틀봇 자리 (user1). 「앞」은 요각 — 정차 후보들이 홈과 같은 자리에서 요각만 다르기도 하다
  const th = (stop.yawDeg * Math.PI) / 180;
  const fwd = [Math.cos(th), Math.sin(th)];
  const HOME = [home.xMm, home.yMm];
  const STOP = [stop.xMm, stop.yMm];
  const FAR = [STOP[0] + fwd[0] * shuttleMm, STOP[1] + fwd[1] * shuttleMm];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const driveS = (a, b) => dist(a, b) / driveMmS + SETTLE_S;

  const acts = [];
  let t = 0;
  const push = (a) => { acts.push({ ...a, t0Ms: t, durMs: Math.round(a.durS * 1000) }); t += Math.round(a.durS * 1000); };
  // 제자리 회전 — 정차 후보 중 홈과 같은 자리에서 요각만 다른 것(`turnFromHomeDeg` 90)이 있다. 회전 시간은 실측이 없어
  // 도착 정착(SETTLE_S)만 준다 — 0 이면 구간이 재생에서 건너뛰어진다
  const turnDeg = stop.yawDeg - home.yawDeg;
  const drive = (id, label, from, to, arm, grip, tcp, carrier, turn = 0) => push({
    kind: 'drive', id, label, from, to, arm, grip, tcp, carrier, turnDeg: turn,
    durS: dist(from, to) > 0 ? driveS(from, to) : SETTLE_S,
  });
  const armAct = (s, prevJ, nextJ, prevGrip, prevPose, carrier, amr) => push({
    kind: 'arm', id: s.id, label: s.label, why: s.why, prevJ, nextJ, prevGrip, nextGrip: s.grip,
    prevPose, pose: s.pose, carrier, amr,
    // 첫 칸(① 접근)은 이미 그 자세라 이동이 0 — 0 초면 `sample()` 이 그 칸을 영영 건너뛴다(감사 ②-3). 정착 시간만큼 보여 준다
    durS: Math.max(stepSeconds(prevJ, nextJ, prevGrip, s.grip, speedPct), SETTLE_S),
  });

  // ⓪ 관측 — **거치대를 본다** (phase 3 · 손목 뎁스로 자리를 찾는 칸). 팔은 이 자세로 서서 터틀봇이 오길 기다린다.
  //    관측 자세는 `view-pose.js`(시선각 20 · 방위 135 · 거리 300) 이고 관절해는 부르는 쪽이 IK 로 채운다 — 없으면 칸을 안 만든다(결측=차단)
  // ⭐ `carrierKnown`(2026-09-07 · 주인님 「⓪ 거치대 관측 두 칸은 필요 없다」) — 마법사 ①(2단 조준)이 거치대 자리를 이미 냈으면 ⓪ 「거치대 관측 자세로」·「거치대를 본다」를
  //    만들지 않는다. 바구니 쪽 ⓪(터틀봇을 본다)은 남는다 — 거치대를 든 뒤 터틀봇이 도착하면 그 자리에서 본다
  const obsC = (observe?.carrier?.jointsDeg && !carrierKnown) ? observe.carrier : null;
  // ⭐ `heldScan`(2026-09-07 20:35 · 주인님 「든 채로 바구니를 보면 왕복이 준다」) — {pose, jointsDeg}: ④ 들기 뒤 **거치대를 든 채** 바구니 위 관측 자세로 가서 바구니 바닥을 찍는 칸을
  //    넣고, 일반 ⓪(o-amr-in) 대신 같은 목적을 든 채 수행한다. 팔이 터틀봇 쪽으로 가는 건 한 번. 실기 프레임(depth-basket2)에서 든 채로도 바닥 110×114 가 잡혔다
  const obsA = (observe?.amr?.jointsDeg && !heldScan && !startAtStop) ? observe.amr : null;
  // 현장 중간 재개는 현재 readback에서 시작한다. 정차 중인 팔을 계획 자세에 이미 있다고 그리면
  // 첫 접근 시간과 경로가 사라진다 (`PROGRAM-CONTRACT` §실기 마법사의 정차 뒤 이어하기).
  const startJ = startAtStop && Array.isArray(initialArm?.jointsDeg) ? initialArm.jointsDeg : (obsC ? obsC.jointsDeg : loadJ[0]);
  const startPose = startAtStop && Array.isArray(initialArm?.tcpMmDeg) ? initialArm.tcpMmDeg : (obsC ? obsC.pose : load[0].pose);
  const pickAmr = startAtStop ? STOP : HOME;
  if (obsC) {
    push({ kind: 'arm', id: 'o-carrier', label: '⓪ 거치대를 본다', why: `손목 뎁스 · 시선각 ${observe.tiltDeg ?? 20}° · 거리 ${observe.distMm ?? 300}mm — 자리를 찾는다`,
      prevJ: obsC.jointsDeg, nextJ: obsC.jointsDeg, prevGrip: 100, nextGrip: 100, prevPose: obsC.pose, pose: obsC.pose, carrier: { at: 'plate' },
      amr: pickAmr, durS: observe.lookS ?? SETTLE_S });
  }
  // ①~④ 집기·들기 뒤에만 터틀봇을 부른다(D205). 주행 동안 팔·그리퍼는 lift 완료값으로 고정한다.
  // 완전 정차 뒤 든 채 바구니를 관측하고 ⑤~⑨ 놓기를 이어간다.
  const closeK = loadIdx.close;
  const liftK = loadIdx.lift;
  for (let k = 0; k < load.length; k++) {
    const viewAfterLift = k === liftK + 1 ? (heldScan ?? obsA) : null;
    const prevJ = k === 0 ? startJ : (viewAfterLift ? viewAfterLift.jointsDeg : loadJ[k - 1]);
    const prevGrip = k === 0 ? 100 : load[k - 1].grip;
    const prevPose = k === 0 ? startPose : (viewAfterLift ? viewAfterLift.pose : load[k - 1].pose);
    const held = k >= closeK && load[k].id !== 'retreat';
    const carrier = held ? { at: 'hand', from: xyz(prevPose), to: xyz(load[k].pose) }
      : (k < closeK ? { at: 'plate' } : { at: 'basket' });
    armAct(load[k], prevJ, loadJ[k], prevGrip, prevPose, carrier, k <= liftK ? pickAmr : STOP);
    if (load[k].id === 'lift') {
      if (!startAtStop) {
        drive('d-in', '터틀봇 홈 → 정차 자리', HOME, STOP, loadJ[k], load[k].grip, load[k].pose,
          { at: 'hand', from: xyz(load[k].pose), to: xyz(load[k].pose) }, turnDeg);
      }
      if (obsA) {
        push({ kind: 'arm', id: 'o-amr-in-move', label: '⑤a 터틀봇 관측 자세로 — 든 채', why: '터틀봇이 완전히 정차한 뒤 거치대를 든 채 도착 자리를 볼 자세로 간다',
          prevJ: loadJ[k], nextJ: obsA.jointsDeg, prevGrip: load[k].grip, nextGrip: load[k].grip, prevPose: load[k].pose, pose: obsA.pose,
          carrier: { at: 'hand', from: xyz(load[k].pose), to: xyz(obsA.pose) }, amr: STOP,
          durS: Math.max(stepSeconds(loadJ[k], obsA.jointsDeg, load[k].grip, load[k].grip, speedPct), SETTLE_S) });
        push({ kind: 'arm', id: 'o-amr-in', label: '⑤a 터틀봇을 본다 — 도착 자리', why: `손목 뎁스 · 라이다 윗면 — 실제로 선 자리(도착 오차 ${arriveErrMm}mm 실측)를 투입 자리에 반영한다`,
          prevJ: obsA.jointsDeg, nextJ: obsA.jointsDeg, prevGrip: load[k].grip, nextGrip: load[k].grip, prevPose: obsA.pose, pose: obsA.pose,
          carrier: { at: 'hand', from: xyz(obsA.pose), to: xyz(obsA.pose) }, amr: STOP, durS: observe.lookS ?? SETTLE_S });
      }
      if (heldScan) {
      push({ kind: 'arm', id: 'o-basket-held', label: '⑤a 바구니를 본다 — 든 채', scanTarget: 'basketFloor',
        why: '손목 뎁스로 바구니 바닥(상판 위 115 판)을 찍어 ⑤~⑨ 자리를 그 값으로 다시 푼다 — 정차 오차·정본 130mm 어긋남을 여기서 지운다',
        prevJ: loadJ[k], nextJ: heldScan.jointsDeg, prevGrip: load[k].grip, nextGrip: load[k].grip, prevPose: load[k].pose, pose: heldScan.pose,
        carrier: { at: 'hand', from: xyz(load[k].pose), to: xyz(heldScan.pose) }, amr: STOP,
        durS: Math.max(stepSeconds(loadJ[k], heldScan.jointsDeg, load[k].grip, load[k].grip, speedPct), SETTLE_S) + (observe?.lookS ?? SETTLE_S) });
      }
    }
  }
  const afterLoadJ = loadJ[load.length - 1];
  const afterLoadGrip = load[load.length - 1].grip;
  const afterLoadPose = load[load.length - 1].pose;
  // ③ 실은 채 앞으로, 되돌아온다 — 거치대는 바구니와 같이 간다
  drive('d-out', `실은 채 앞으로 ${shuttleMm}mm`, STOP, FAR, afterLoadJ, afterLoadGrip, afterLoadPose, { at: 'basket' });
  drive('d-back', '정차 자리로 되돌아온다', FAR, STOP, afterLoadJ, afterLoadGrip, afterLoadPose, { at: 'basket' });
  // ⓪′ 관측 — **터틀봇을 본다** (라이다 윗면). 되돌아온 터틀봇 자리를 손목 뎁스로 확인한 뒤 내린다
  let beforeUnloadJ = afterLoadJ; let beforeUnloadPose = afterLoadPose;
  if (obsA) {
    push({ kind: 'arm', id: 'o-amr-move', label: '⑩ 관측 자세로', why: '바구니 위에서 물러나 터틀봇을 볼 자리로',
      prevJ: afterLoadJ, nextJ: obsA.jointsDeg, prevGrip: afterLoadGrip, nextGrip: 100, prevPose: afterLoadPose, pose: obsA.pose, carrier: { at: 'basket' },
      amr: STOP, durS: stepSeconds(afterLoadJ, obsA.jointsDeg, afterLoadGrip, 100, speedPct) });
    push({ kind: 'arm', id: 'o-amr', label: '⑩ 터틀봇을 본다', why: `손목 뎁스 · 라이다 윗면 · 시선각 ${observe.tiltDeg ?? 20}° — 되돌아온 자리를 확인한다`,
      prevJ: obsA.jointsDeg, nextJ: obsA.jointsDeg, prevGrip: 100, nextGrip: 100, prevPose: obsA.pose, pose: obsA.pose, carrier: { at: 'basket' },
      amr: STOP, durS: observe.lookS ?? SETTLE_S });
    beforeUnloadJ = obsA.jointsDeg; beforeUnloadPose = obsA.pose;
  }
  // ④ 내리기 8칸 — 문 뒤(⑫)부터 내려놓기(⑮)까지 손을 따라간다
  const uCloseK = unload.findIndex((s) => s.id === 'u-close');
  const uReleaseK = unload.findIndex((s) => s.id === 'u-release');
  for (let k = 0; k < unload.length; k++) {
    const prevJ = k === 0 ? beforeUnloadJ : unloadJ[k - 1];
    const prevGrip = k === 0 ? 100 : unload[k - 1].grip;
    const prevPose = k === 0 ? beforeUnloadPose : unload[k - 1].pose;
    const held = k >= uCloseK && k < uReleaseK;
    const carrier = held ? { at: 'hand', from: xyz(prevPose), to: xyz(unload[k].pose) }
      : (k < uCloseK ? { at: 'basket' } : { at: 'plate' });
    armAct(unload[k], prevJ, unloadJ[k], prevGrip, prevPose, carrier, STOP);
  }
  const endJ = unloadJ[unload.length - 1];
  const endPose = unload[unload.length - 1].pose;
  // ⑤ 홈으로 — 거치대는 판 위에 남는다
  drive('d-home', '터틀봇 홈으로', STOP, HOME, endJ, 100, endPose, { at: 'plate' }, -turnDeg);

  const totalMs = t;
  // 도착 오차 유령 (#12) — 실측 08-20 (`tb-drift-turn.md`): 직진은 완벽하고(842mm 에 0.5mm) **회전이 매번 부족**(1.9~10.7°)하며,
  // 웨이포인트마다 위치를 다시 맞춰 도착 오차는 35~40mm 로 **누적되지 않는다**. 그래서 유령은
  //   ① 자리: 주행 구간 동안 직전 오차에서 「이번 목적지의 도착 오차(주행 방향으로 짧게)」로 **연속** 보간한다 —
  //      구간 경계에서 0 으로 되돌리면 유령이 37.5mm 순간이동한다 (감사 2026-09-06 ②-1)
  //   ② 방향: 제자리 회전이 있는 구간(정차 후보 `turnFromHomeDeg` 90) 뒤에는 **덜 돈 각**(`AMR_TURN_DEFICIT_DEG`)만큼 요각이 어긋난다.
  //      그 방향 오차가 다음 직진에서 자리로 번지는 모양은 실측이 없어 그리지 않는다 (감사 ②-2 · 회전만 있는 구간을 0 으로 두던 것을 정정)
  let cur = [0, 0];
  let yawErr = 0;
  for (const a of acts) {
    if (a.kind === 'drive') {
      const len = dist(a.from, a.to);
      const to = len > 0 ? [-(a.to[0] - a.from[0]) / len * arriveErrMm, -(a.to[1] - a.from[1]) / len * arriveErrMm] : cur;
      a.driftFrom = cur; a.driftTo = to; cur = to;
      if (a.turnDeg) yawErr += -Math.sign(a.turnDeg) * turnDeficitDeg;   // 덜 돈다 — 명령한 회전의 반대 부호
      a.yawErrFrom = yawErr - (a.turnDeg ? -Math.sign(a.turnDeg) * turnDeficitDeg : 0); a.yawErrTo = yawErr;
    } else {
      a.driftFrom = cur; a.driftTo = cur; a.yawErrFrom = yawErr; a.yawErrTo = yawErr;
    }
  }
  // 바구니 속 거치대의 터틀봇-상대 자리 — 싣기 9칸을 푼 터틀봇 자리(amrLoad) 기준. 그 자리의 요각 오차만큼 되돌려 터틀봇 몸 기준으로 둔다
  const eL = ((amrLoad.yawDeg - stop.yawDeg) * Math.PI) / 180;
  const bdx = basket[0] - amrLoad.xMm; const bdy = basket[1] - amrLoad.yMm;
  const basketRel = [bdx * Math.cos(-eL) - bdy * Math.sin(-eL), bdx * Math.sin(-eL) + bdy * Math.cos(-eL)];
  const live = { user1: userDef };
  const odom = (p) => (userDef ? toFrame({ xMm: p[0], yMm: p[1], zMm: 0 }, 'user1', 'odom', live) : null);
  const thetaDeg = stop.yawDeg - home.yawDeg;   // `SimPanel` 이 쓰던 규약 그대로 — 회전 합성은 안 만든다
  const trailPts = [odom(startAtStop ? STOP : HOME), odom(FAR)];
  const trail = trailPts.every(Boolean) ? trailPts.map((p) => ({ xMm: p.xMm, yMm: p.yMm, thetaDeg })) : null;

  const sample = (tMs) => {
    const tt = Math.max(0, Math.min(totalMs, tMs));
    // 0ms 구간이 생겨도 그 시각에는 그 구간이다 (감사 ②-3)
    let i = acts.findIndex((a) => tt < a.t0Ms + a.durMs || (a.durMs === 0 && tt === a.t0Ms));
    if (i < 0) i = acts.length - 1;
    const a = acts[i];
    const u = a.durMs > 0 ? Math.max(0, Math.min(1, (tt - a.t0Ms) / a.durMs)) : 1;
    let amr;
    let armJoints;
    let gripperPct;
    let tcpMmDeg;      // 손끝 자세(user1 · 6) — 트윈이 손목 카메라 시야 발자국을 **고스트의** 카메라로 그리는 재료
    if (a.kind === 'drive') {
      amr = [a.from[0] + (a.to[0] - a.from[0]) * u, a.from[1] + (a.to[1] - a.from[1]) * u];
      armJoints = a.arm;
      gripperPct = a.grip;
      tcpMmDeg = a.tcp;
    } else {
      amr = a.amr ?? STOP;
      armJoints = lerp(a.prevJ, a.nextJ, u);
      gripperPct = a.prevGrip + (a.nextGrip - a.prevGrip) * u;
      tcpMmDeg = lerp(a.prevPose, a.pose, u);
    }
    // 거치대 — 판 위 / 손 안 / 바구니 안(터틀봇과 같이 움직인다)
    let carrierHeldTcp;
    if (a.carrier.at === 'plate') carrierHeldTcp = grasp;
    else if (a.carrier.at === 'hand') carrierHeldTcp = lerp(a.carrier.from, a.carrier.to, u);
    const od = odom(amr);
    // 유령 — 「실제로 선 자리」. 자리는 직전 오차 → 이번 목적지 오차로 연속, 요각은 덜 돈 각을 이어 든다
    const drift = [a.driftFrom[0] + (a.driftTo[0] - a.driftFrom[0]) * u, a.driftFrom[1] + (a.driftTo[1] - a.driftFrom[1]) * u];
    const yawErr = a.yawErrFrom + (a.yawErrTo - a.yawErrFrom) * u;
    const real = [amr[0] + drift[0], amr[1] + drift[1]];
    // 바구니 속 거치대는 **실제** 바구니에 있다 — 명령 자리가 아니라 유령(실제로 선 자리)을 따른다. 정차 자리를 축으로 덜 돈 각만큼 돌린다.
    // 관측을 안 반영한 사이클에선 팔이 명령 자리로 가므로 여기서 어긋남이 그림으로 드러난다 (2026-09-06)
    if (a.carrier.at !== 'plate' && a.carrier.at !== 'hand') {
      // 바구니 속 자리 = 싣기 때 터틀봇(amrLoad)에 상대적인 자리를, 지금 실제 터틀봇(real · yawErr)에 붙인 것
      const e = (yawErr * Math.PI) / 180; const c = Math.cos(e); const s = Math.sin(e);
      carrierHeldTcp = [real[0] + basketRel[0] * c - basketRel[1] * s, real[1] + basketRel[0] * s + basketRel[1] * c, basket[2]];
    }
    const odr = odom(real);
    return {
      actIndex: i, label: a.label, why: a.why ?? null, tMs: tt, totalMs,
      armJoints, gripperPct, carrierHeldTcp, tcpMmDeg,
      // ⛔ 2026-09-06 뒤집음: `pose` = **실제로 선 자리**(실물 메시·바구니가 여기 선다 — 거치대가 그 바구니 안에 있어야 하므로),
      //    `driftPose` = **명령한 자리**(회색 상자). 둘 사이가 driftMm. 전엔 반대였고 그러면 거치대가 상자(바구니 없음) 쪽에 서서 「빠져나온」 것처럼 보였다
      // 손에 들려 있나 — 그림 쪽은 이때 숫자 대신 **고스트의 손끝 노드**에 거치대를 건다. 팔은 관절 보간, 이 숫자는 직선 보간이라
      // 칸 중간에서 둘이 갈린다 (2026-09-06 주인님 「물고 있는 상태로 이동하지 않는다」)
      carrierInHand: a.carrier.at === 'hand',
      ...(odr ? { pose: { xMm: odr.xMm, yMm: odr.yMm, thetaDeg: thetaDeg + yawErr } } : {}),
      ...(od ? { driftPose: { xMm: od.xMm, yMm: od.yMm, thetaDeg } } : {}),
      driftMm: Math.hypot(drift[0], drift[1]),
      driftYawDeg: yawErr,
      ...(trail ? { trail } : {}),
      amrUser1: amr,           // 명령 자리
      realUser1: real,         // 실제로 선 자리
    };
  };
  return { acts, totalMs, sample, why: null, unload, observed, loadAmr: amrLoad };
}
