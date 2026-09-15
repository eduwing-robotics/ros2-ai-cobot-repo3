// 글로벌캠 시야 예측 — **카메라 자기 좌표계(camLab · 태그0 카트 덱 평면) 안에서만** (2026-09-06 · `GRILL-conveyor-twin` #9).
//
// 무엇을 답하나: camLab 의 한 점이 ① 카메라 앞인가 ② 영상 안 어디에 찍히나 ③ 거기 놓인 태그가 몇 픽셀인가.
// 재료는 `Shared/data/config/global-cam.json` (내부 fx·fy·cx·cy · 외부 rvec·tvec · 2026-08-31 · rms 0.46px) 하나다.
//
// ⛔ **로봇 베이스로 못 옮긴다.** `frames.js` 에서 `camLab → base` 는 unknown(태그0 의 base 자리 미측정)이고,
//    `robot-base-in-tag.json`(08-19 · yaw 오차 1.73° 재측정 대기)으로 이으면 터틀봇 태그 실측(`amr-pose.json`)과
//    (85, 167, 164)mm 어긋난다 — 그 갈래로 트윈에 카메라를 세우면 실측과 모순되는 그림이다. 그래서 이 모듈은
//    camLab 좌표를 받기만 하고, 그 좌표를 어디서 얻는지는 부르는 쪽이 책임진다.
// ⚠ 렌즈 왜곡(`intrinsics.dist`)은 안 넣는다 — `global-cam.js` 와 같은 한계. 가장자리에서 몇 px 어긋난다.

/** 로드리게스 회전 벡터 → 3x3 (행 배열). `global-cam.js` 와 같은 식 — 여기서는 three 없이 순수 배열이다 */
export function rodrigues([rx, ry, rz]) {
  const th = Math.hypot(rx, ry, rz);
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = [rx / th, ry / th, rz / th];
  const c = Math.cos(th), s = Math.sin(th), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

const mul = (r, p) => [0, 1, 2].map((i) => r[i][0] * p[0] + r[i][1] * p[1] + r[i][2] * p[2]);
const T = (r) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => r[j][i]));

/** 카메라 광학 원점의 camLab 자리(mm) = −Rᵀ·t. 파일의 `camPosMm` 과 같아야 한다 — 시험이 그걸 잰다 */
export function cameraPosMm(calib) {
  const R = rodrigues(calib.labToCam.rvec);
  const t = calib.labToCam.tvecMm;
  return mul(T(R), t).map((v) => -v);
}

/**
 * camLab 점(mm) → 영상 픽셀. 카메라 뒤(z≤0)면 `null`.
 * @returns {{uPx:number, vPx:number, depthMm:number, inImage:boolean}|null}
 */
export function projectCamLab(calib, pMm) {
  const I = calib.intrinsics;
  const R = rodrigues(calib.labToCam.rvec);
  const t = calib.labToCam.tvecMm;
  const c = mul(R, pMm).map((v, i) => v + t[i]);
  if (!(c[2] > 1e-6)) return null;
  const uPx = I.fx * c[0] / c[2] + I.cx;
  const vPx = I.fy * c[1] / c[2] + I.cy;
  return { uPx, vPx, depthMm: c[2], inImage: uPx >= 0 && uPx <= I.widthPx && vPx >= 0 && vPx <= I.heightPx };
}

/** 그 깊이에서 한 변 `sizeMm` 짜리 태그가 몇 px 인가 (정면 기준 · 기울면 더 작다) */
export const tagPx = (calib, depthMm, sizeMm) => (depthMm > 0 ? calib.intrinsics.fx * sizeMm / depthMm : 0);

/**
 * 태그 검출 가능성 — 영상 안이고 최소 픽셀폭을 넘나. `minPx` 정본은 `docs/ref/arch/AR-MARKER.md`(16px).
 * 명도차·기울기·모션블러는 안 본다 — 그건 실영상이 답한다.
 */
export function tagVisibility(calib, pMm, sizeMm, minPx = 16) {
  const pr = projectCamLab(calib, pMm);
  if (!pr) return { ok: false, why: '카메라 뒤', px: 0, uPx: null, vPx: null, depthMm: null };
  const px = tagPx(calib, pr.depthMm, sizeMm);
  if (!pr.inImage) return { ok: false, why: '영상 밖', px, ...pr };
  if (px < minPx) return { ok: false, why: `${px.toFixed(1)}px < ${minPx}px`, px, ...pr };
  return { ok: true, why: null, px, ...pr };
}

/** 시야 피라미드 — 카메라 원점 + 깊이 `depthMm` 의 영상 네 귀퉁이, camLab mm. 트윈은 camLab→base 가 생기면 이걸 그린다 */
export function frustumCamLab(calib, depthMm) {
  const I = calib.intrinsics;
  const R = rodrigues(calib.labToCam.rvec);
  const Rt = T(R);
  const cam = cameraPosMm(calib);
  const corner = (u, v) => {
    const d = [(u - I.cx) / I.fx * depthMm, (v - I.cy) / I.fy * depthMm, depthMm];   // 카메라 좌표
    return mul(Rt, d).map((x, i) => x + cam[i]);
  };
  return {
    apex: cam,
    corners: [corner(0, 0), corner(I.widthPx, 0), corner(I.widthPx, I.heightPx), corner(0, I.heightPx)],
  };
}
