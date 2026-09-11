// 싣기 9자세 + 사전 성형 1칸 — **정본은 여기 하나다** (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 1).
//
// 전엔 `FR5/src/features/sim/SimPanel.jsx` `makeSteps` 와 `scripts/dev/amr-stop-mujoco.mjs` 가 같은 순서를 **각자** 적었다 —
// 한쪽만 고치면 화면과 무조코가 다른 자리를 본다(하드 룰 5). 화면·게이트·스크립트가 전부 이 함수를 부른다.
//
// 좌표는 전부 실측 SSOT 에서 온다 — 파지 자세 `props.CARRIER_GRASP_TRUTH`(높이는 `carrierGraspNow` 로 지금 상판 기준),
// 정차 자리 `workcell.AMR_DROP*`, 바구니 `props.AMR_BASKET`, 터틀봇 치수 `catalog.AMR_MM`. **여기서 새 좌표를 만들지 않는다.**
import { CARRIER_GRASP_TRUTH, AMR_BASKET, carrierBodyOffset, carrierGraspNow } from '../props.js';
import { AMR_MM } from '../layout/catalog.js';
import { AMR_HOME, AMR_DROP } from '../workcell.js';

/** 집기 전·후로 떠서 오가는 높이(보기용). 실기 경로는 게이트가 정한다 */
export const LIFT_MM = 120;
/** 들린 거치대 바닥이 라이다 윗면 위로 이만큼 지나간다 — 2026-09-06 실렌더에서 ④→⑤ 가 몸통 모서리를 쓸어 정한 여유 */
export const CLEAR_MM = 20;
/** 바구니 테두리 위에서 접근·탈출하는 높이 */
export const OVER_RIM_MM = 40;
/** 하강 전 사전 벌림 — 28mm. 첫 S4 완주에서 24mm가 거의 닿을 뻔해 한쪽 2mm씩만 더 열었다(D220). */
export const PREGRIP_PCT = 70;
export const GRIPPER_STROKE_MM = 40;
export const PREGRIP_OPEN_MM = PREGRIP_PCT * GRIPPER_STROKE_MM / 100;
const wrapDeg = (deg) => (deg >= -180 && deg < 180 ? deg : ((deg % 360) + 540) % 360 - 180);

/** 바구니 바닥 높이(user1 z) — 그려진 상판(`AMR_HOME.topZMm`) 위 `floorAboveGroundMm` */
export const basketFloorZ = () => AMR_HOME.topZMm + (AMR_BASKET.floorAboveGroundMm ?? 0);

/**
 * 싣기 9자세 + 사전 성형 1칸. `stop` 은 정차 자리(`AMR_DROP` 또는 후보). 각 칸이 「왜 거기인가」를 든다.
 * @returns {Array<{id:string,label:string,grip:number,pose:number[],why:string}>}
 */
/** 180° 대칭 물체의 접힌 요각 `[−90, 90)` 을 사전값(odom 요각)에 가장 가까운 대표로 편다 — 110 vs 120 · 69 vs 85 의 90° 모호는 여기서 안 푼다, 반 바퀴 모호만 푼다 */
export function nearestYaw(foldedDeg, priorDeg) {
  if (!Number.isFinite(foldedDeg)) return priorDeg;
  let best = foldedDeg; let bestD = Infinity;
  for (let k = -2; k <= 2; k += 1) {
    const c = foldedDeg + 180 * k;
    const d = Math.abs(c - priorDeg);            // 수치로 가장 가까운 대표 — 같은 각의 다른 표현(−175 vs 185)이 손목을 355° 돌리지 않게
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

export function makeLoadSteps(stop = AMR_DROP, { tableTopZMm = AMR_HOME.topZMm, graspXyMm = null, graspRzDeg = null, basket = null, graspFlip = false } = {}) {
  const g = carrierGraspNow(tableTopZMm);
  // 거치대 **입력** (phase 4) — 자리(x·y)만 바꾼다. 높이·각도(사람이 손으로 맞춘 파지 자세)는 그대로다. 실측 표적이 오면 부르는 쪽이 넣는다
  if (Array.isArray(graspXyMm) && graspXyMm.length >= 2 && graspXyMm.every(Number.isFinite)) { g[0] = graspXyMm[0]; g[1] = graspXyMm[1]; }
  // 요각 입력 (2026-09-07 · D192) — 색 검출·손목 스캔이 낸 거치대 요각. 파지 정본 rz 는 「거치대 가로 85 가 x 축과 평행(요각 0)일 때」의 손목 각이므로
  // 거치대가 θ 돌아 있으면 손목도 θ 만큼 돈다(`CARRIER.yawFromGraspDeg` 규약 · 거치대는 180° 대칭이라 [−90,90) 로 접힌 값). 없으면 정본 그대로
  if (Number.isFinite(graspRzDeg)) g[5] = CARRIER_GRASP_TRUTH.tcpMmDeg[5] + graspRzDeg;
  const rzGrasp = g[5];
  // 바구니 **관측** (2026-09-07) — 손목 스캔이 낸 바구니 바닥 중심·요각. 있으면 정차 자리+오프셋 유도 대신 그 자리에 넣는다.
  // 요각은 접힌 값이라 정차 요각(odom)에 가장 가까운 대표로 편다 — 그래야 손목이 반 바퀴 헛돌지 않는다
  const basketYaw = basket && Number.isFinite(basket.yawDeg) ? nearestYaw(basket.yawDeg, stop.yawDeg) : stop.yawDeg;
  const rzPlace = rzGrasp + (basketYaw - AMR_HOME.yawDeg);     // 바구니는 로봇 등에 붙어 같이 돈다
  // FAIRINO는 같은 자세여도 ±180° 밖 Euler 표기에 해 없음을 낼 수 있다(D209).
  const at = (x, y, z, rz) => [x, y, z, g[3], g[4], wrapDeg(rz)];
  // 바구니 중심 = 정차 자리 + 등 뒤 오프셋(실측 −115 · 없으면 유도)
  const back = Number.isFinite(AMR_BASKET.offsetMm?.x)
    ? AMR_BASKET.offsetMm.x
    : -(AMR_MM.depthMm / 2 + (AMR_BASKET.innerDMm + 2 * (AMR_BASKET.wallMm ?? 3)) / 2);
  const th = (stop.yawDeg * Math.PI) / 180;
  const observed = basket && Number.isFinite(basket.xMm) && Number.isFinite(basket.yMm);
  const bx0 = observed ? basket.xMm : stop.xMm + back * Math.cos(th);
  const by0 = observed ? basket.yMm : stop.yMm + back * Math.sin(th);
  // 손끝은 거치대 중심이 아니라 벽 — 몸통이 뻗는 만큼 반대로 민다 (`props.carrierBodyOffset` 한 곳). 관측 바구니면 넣을 때의 손목 각으로
  const bodyOff = carrierBodyOffset(observed ? rzPlace : g[5], graspFlip);   // 반대 벽을 물었으면 놓을 때도 거치대가 손끝 반대쪽에 매달려 있다
  const bx = bx0 - bodyOff.dxMm;
  const by = by0 - bodyOff.dyMm;
  const floor = basketFloorZ();
  const graspLift = CARRIER_GRASP_TRUTH.tcpAboveTableMm;      // 손끝이 거치대 바닥에서 얼마 위인가 — 첫 S4 뒤 보정 33.3
  const hover = Math.max(g[2] + LIFT_MM, tableTopZMm + AMR_MM.heightMm + graspLift + CLEAR_MM);
  const overRim = tableTopZMm + (AMR_BASKET.rimAboveGroundMm ?? 0) + OVER_RIM_MM;
  const G = CARRIER_GRASP_TRUTH.gripperPct;
  return [
    { id: 'approach', label: '① 위에서 접근', grip: 100, pose: at(g[0], g[1], g[2] + LIFT_MM, rzGrasp), why: `파지점 위 ${LIFT_MM}mm` },
    { id: 'pregrip', label: '①b 내려가기 전 손 맞춤', grip: PREGRIP_PCT, pose: at(g[0], g[1], g[2] + LIFT_MM, rzGrasp), why: `그리퍼 ${PREGRIP_PCT}% = ${PREGRIP_OPEN_MM.toFixed(1)}mm · 총알 침범을 줄이고 벽 진입 여유는 남김` },
    { id: 'grasp', label: '② 무는 자세', grip: PREGRIP_PCT, pose: at(g[0], g[1], g[2], rzGrasp), why: `그리퍼 ${PREGRIP_PCT}% 유지한 채 수직 하강 · 사람이 손으로 맞춘 높이` },
    { id: 'close', label: '③ 문다', grip: G, pose: at(g[0], g[1], g[2], rzGrasp), why: `그리퍼 ${G}% = ${(G * 0.4).toFixed(1)}mm` },
    { id: 'lift', label: '④ 들어올린다', grip: G, pose: at(g[0], g[1], hover, rzGrasp), why: `${(hover - g[2]).toFixed(0)}mm 들기 — 거치대 바닥이 라이다 위 ${CLEAR_MM}mm` },
    { id: 'carry', label: '⑤ 터틀봇 위로', grip: G, pose: at(bx, by, hover, rzPlace), why: `손목 ${(rzPlace - rzGrasp).toFixed(0)}° 돌려 · ${observed ? `관측 바구니 (${basket.xMm.toFixed(0)}, ${basket.yMm.toFixed(0)}) ${basketYaw.toFixed(1)}°` : `정차 (${stop.xMm}, ${stop.yMm}) ${stop.yawDeg}°`}` },
    { id: 'over', label: '⑥ 바구니 위', grip: G, pose: at(bx, by, overRim, rzPlace), why: `테두리 위 ${OVER_RIM_MM}mm` },
    { id: 'insert', label: '⑦ 넣는다', grip: G, pose: at(bx, by, floor + graspLift, rzPlace), why: `바닥(${floor.toFixed(1)}) + 문 자리 높이 ${graspLift.toFixed(1)}` },
    { id: 'release', label: '⑧ 놓는다', grip: 100, pose: at(bx, by, floor + graspLift, rzPlace), why: '그리퍼 연다 — 거치대는 바구니 안에 남는다' },
    // 곧게 위로만 뺀다 — 옆으로 움직이면 벌린 손가락이 테두리를 친다 (한쪽 여유 4.5mm)
    { id: 'retreat', label: '⑨ 빠져나온다', grip: 100, pose: at(bx, by, overRim, rzPlace), why: '벌린 채 곧게 위로 — 옆으로 빼면 손가락이 테두리를 친다 (한쪽 여유 4.5mm)' },
  ];
}

/** 몇 칸부터 거치대가 손을 따라가나 (③ 문다). ⑨ 빠져나온다에서는 안 따라온다 */
export const HOLD_FROM = 3;
export const isHeld = (steps, i) => i >= HOLD_FROM && steps[i]?.id !== 'retreat';
