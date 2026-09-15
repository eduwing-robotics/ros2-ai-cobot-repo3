// 긴 벽 중앙 파지의 순수 기하 — 화면·자동 실행·회귀검사가 같은 계산을 쓴다.
// 손가락은 높은 곳에서 100% 열지만, 거치대 안으로 내려갈 때는 PREGRIP_OPEN_MM으로 고정된다(D210·D220).
import { carrierBodyOffset } from '../props.js';
import { PREGRIP_OPEN_MM } from './load-steps.js';

export const GRASP_INSET_CANDIDATES_MM = Object.freeze(Array.from({ length: 11 }, (_, i) => 10 - i));

const FINGER_T_MM = 10;
const FINGER_W_MM = 25;
const BULLET_R_MM = 6;
const BULLET_MARGIN_MM = 5;

export function carrierOffsetAtInset(rzDeg, flip = false, insetMm = 0) {
  const o = carrierBodyOffset(rzDeg, flip);
  const half = Math.hypot(o.dxMm, o.dyMm);
  const inset = Math.min(Math.max(Number(insetMm) || 0, 0), half);
  const scale = half ? (half - inset) / half : 0;
  return { dxMm: o.dxMm * scale, dyMm: o.dyMm * scale };
}

export function graspFromCenter(center, rzDeg, flip = false, insetMm = 0) {
  if (!Array.isArray(center)) return null;
  const o = carrierOffsetAtInset(rzDeg, flip, insetMm);
  return [center[0] - o.dxMm, center[1] - o.dyMm];
}

/** 사전 성형한 손가락이 하강할 때 총알과 겹치는가. openingMm 인자는 과거 40mm 회귀만 비교한다. */
export function bulletsNearGraspWall(center, bullets, rzDeg, flip, openingMm = PREGRIP_OPEN_MM) {
  if (!Array.isArray(center) || !Array.isArray(bullets)) return [];
  const o = carrierBodyOffset(rzDeg, flip);
  const half = Math.hypot(o.dxMm, o.dyMm) || 1;
  const nx = -o.dxMm / half; const ny = -o.dyMm / half;             // 손끝 쪽 벽의 바깥 방향
  const inner = half - openingMm / 2;                               // 안쪽 손가락 안면의 중심 기준 위치
  const lo = inner - FINGER_T_MM - BULLET_R_MM - BULLET_MARGIN_MM;
  const hi = inner + BULLET_R_MM + BULLET_MARGIN_MM;
  return bullets.filter((b) => {
    const dx = b[0] - center[0]; const dy = b[1] - center[1];
    const along = dx * nx + dy * ny;
    const across = Math.abs(-dx * ny + dy * nx);
    return along >= lo && along <= hi && across <= FINGER_W_MM / 2 + BULLET_R_MM + BULLET_MARGIN_MM;
  });
}
