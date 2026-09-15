// 관측 자세 — **표적을 손목 카메라로 보는 손끝 자세** (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 3).
//
// 식은 `scripts/dev/view-mujoco.mjs`(2026-09-04 · `VIEW_CANDIDATES` 를 낸 그 스크립트)에서 그대로 옮겼다 — 표적에서 시선각·방위·거리로
// 카메라 자리를 잡고, 카메라 +z 가 표적을 향하게 회전을 만든 뒤, hand-eye(`config.yaml handEye.tMm` · 손끝 프레임의 카메라 원점)의 역으로
// 손끝을 낸다(`follow.cam_to_robot` 의 역 · 같은 규약). 오일러는 고정축 XYZ(`safety._rot_fixed_xyz`).
// 시험(`view-pose.test.js`)이 기록된 `VIEW_CANDIDATES` 다섯을 이 식으로 **재현**해 잠근다 — 스크립트와 갈리면 붉다.
//
// 기본값의 근거(`workcell.js` §VIEW_CANDIDATES): 방위 135°(팔이 덜 뻗는다) · 거리 300(거치대 윗면에서 245 · 250 이면 195 사각지대) ·
// 시선각 **20°**(0° 는 세운 총알이 스테레오 그림자로 자기를 지운다 · 무효 21% · 실용 상한 40°).
const D = Math.PI / 180;

export const VIEW_DEFAULT = { tiltDeg: 20, aziDeg: 135, distMm: 300 };

export const rotFixedXYZ = (rx, ry, rz) => {
  const [cx, sx] = [Math.cos(rx * D), Math.sin(rx * D)];
  const [cy, sy] = [Math.cos(ry * D), Math.sin(ry * D)];
  const [cz, sz] = [Math.cos(rz * D), Math.sin(rz * D)];
  return [[cz * cy, cz * sy * sx - sz * cx, sz * sx + cz * sy * cx],
    [sz * cy, cz * cx + sz * sy * sx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx]];
};
export const eulerOf = (R) => {
  const ry = Math.asin(Math.max(-1, Math.min(1, -R[2][0]))) / D;
  const rx = Math.atan2(R[2][1], R[2][2]) / D;
  const rz = Math.atan2(R[1][0], R[0][0]) / D;
  return [rx, ry, rz];
};
const mul = (R, v) => R.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

/** 카메라 +z 가 `f` 방향을 보게 하는 회전. `roll` 은 그 축 둘레 회전(도) */
export function lookAt(f, roll = 0) {
  const z = f.map((v) => v / Math.hypot(...f));
  const up = Math.abs(z[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1];
  let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  const nx = Math.hypot(...x); x = x.map((v) => v / nx);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const c = Math.cos(roll * D); const s = Math.sin(roll * D);
  const xr = x.map((v, i) => c * v + s * y[i]);
  const yr = y.map((v, i) => -s * x[i] + c * v);
  return [[xr[0], yr[0], z[0]], [xr[1], yr[1], z[1]], [xr[2], yr[2], z[2]]];
}

/**
 * 표적(user1 mm)을 보는 손끝 자세 `[x,y,z,rx,ry,rz]`.
 * @param {number[]} targetMm  보려는 점 (user1)
 * @param {number[]} handEyeTMm hand-eye `tMm` — 손끝 프레임에서 본 카메라 원점. **없으면 null** (결측=차단)
 * @param {{tiltDeg?:number, aziDeg?:number, distMm?:number, rollDeg?:number}} [o]  `rollDeg` — 광축 둘레 회전. 어느 값이든 같은 곳을 본다
 */
export function viewPose(targetMm, handEyeTMm, o = {}) {
  if (!Array.isArray(targetMm) || targetMm.length < 3 || !Array.isArray(handEyeTMm) || handEyeTMm.length < 3) return null;
  const { tiltDeg, aziDeg, distMm, rollDeg } = { ...VIEW_DEFAULT, rollDeg: 0, ...o };
  const n = [Math.sin(tiltDeg * D) * Math.cos(aziDeg * D), Math.sin(tiltDeg * D) * Math.sin(aziDeg * D), Math.cos(tiltDeg * D)];
  const cam = targetMm.map((v, i) => v + distMm * n[i]);
  const R = lookAt(n.map((v) => -v), rollDeg);      // 카메라 +z 가 표적을 향한다
  const [rx, ry, rz] = eulerOf(R);
  const off = mul(rotFixedXYZ(rx, ry, rz), handEyeTMm);
  return [cam[0] - off[0], cam[1] - off[1], cam[2] - off[2], rx, ry, rz];
}

const wrapDeg = (a) => ((a % 360) + 540) % 360 - 180;

/**
 * 같은 곳을 보되 **손목 요각(rz)이 `rzDeg` 에 가장 가까운** 관측 자세. 광축 둘레 회전(roll)은 「본다」에 아무 제약이
 * 없는 자유도인데, 0 으로 못 박으면 rz 가 방위각에 끌려가(135° → rz 45°) 작업 자세(rz −90)와 135° 어긋난 손목이 나온다 —
 * 실측 2026-09-06: 그 손목이 관측 칸마다 j6 224° · 가지 뒤집힘까지 불러 칸 하나에 57초가 들었다. roll 을 15° 씩 훑어
 * rz 차가 최소인 것을 준다(roll 180 이면 이웃 칸과 최대 관절차 32°).
 */
export function viewPoseNearRz(targetMm, handEyeTMm, rzDeg, o = {}) {
  if (!Number.isFinite(rzDeg)) return viewPose(targetMm, handEyeTMm, o);
  let best = null; let bestD = Infinity;
  for (let roll = 0; roll < 360; roll += 15) {
    const p = viewPose(targetMm, handEyeTMm, { ...o, rollDeg: roll });
    if (!p) return null;
    const d = Math.abs(wrapDeg(p[5] - rzDeg));
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** 손목 요각이 `rzDeg` 에 **0.5° 안**으로 맞는 관측 자세 — 거울 쌍은 정확히 180° 차여야 해서 15° 격자(`viewPoseNearRz`)로는 모자란다 */
export function viewPoseAtRz(targetMm, handEyeTMm, rzDeg, o = {}) {
  let best = null; let bestD = Infinity;
  for (let roll = 0; roll < 360; roll += 1) {
    const p = viewPose(targetMm, handEyeTMm, { ...o, rollDeg: roll });
    if (!p) return null;
    const d = Math.abs(wrapDeg(p[5] - rzDeg));
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/**
 * **거울 쌍** (2026-09-07 · D192 · `docs/ref/rnd/AIM2-CONVERGE-LOOP-2026-09-07.md`) — 표적 **바로 위**(tilt 0)에서 손목 요각을
 * 파지 rz ± 90 으로 둔 두 자세. 툴 프레임에 고정된 hand-eye 오차(평행이동·회전)는 툴을 180° 돌리면 부호가 뒤집혀
 * 두 스캔의 평균에서 사라진다. 거리는 카메라가 표적 위 `distMm`(기본 300 · Min-Z 195 밖).
 * @returns {{a:number[], b:number[], rzA:number, rzB:number}|null}
 */
export function mirrorPair(targetMm, handEyeTMm, rzGraspDeg, o = {}) {
  const rzA = wrapDeg(rzGraspDeg + 90); const rzB = wrapDeg(rzGraspDeg - 90);
  const opt = { tiltDeg: 0, aziDeg: 0, distMm: o.distMm ?? VIEW_DEFAULT.distMm };
  const a = viewPoseAtRz(targetMm, handEyeTMm, rzA, opt);
  const b = viewPoseAtRz(targetMm, handEyeTMm, rzB, opt);
  if (!a || !b) return null;
  return { a, b, rzA, rzB };
}
