// 관절 한계 — **URDF 가 정본이고 여기가 그 사본이다.**
//
// 왜 사본을 두나 — URDF 는 `Shared/assets/FAIRINO_FR5/fairino5_v6.urdf` 라 **브라우저가
// 로봇을 다 받은 뒤에야** 읽을 수 있다. 게이트(노드)와 스키마 검사는 그때까지 못 기다린다.
// 그래서 숫자를 한 곳에 두고, **화면·게이트·검증이 같은 값을 본다** (하드 룰 5).
//
// **`scripts/check/motion.sh` 가 이 파일과 URDF 를 대조한다** — 손으로 베낀 값이 원본과
// 갈라지는 순간 게이트가 빨개진다. 사본을 두면서 사본이 거짓말하지 않게 하는 방법이다.
//
// ── 왜 필요했나 (2026-08-04)
// `unscrew` 자세가 **`j6: 300°`** 였는데 j6 한계는 **±175°** 다. `urdf-loader` 는
// `ignoreLimits` 가 아니면 **말없이 자른다**(`URDFClasses.js` revolute 분기) — 그래서
// 표에는 300 이 적혀 있고 화면에는 175 가 서 있었고, 증거 문서에는 **한계에 붙은 값**이
// 자세표 값인 양 적혀 있었다. 사람이 관절을 직접 잡기 시작하면 이런 값이 늘어난다.

/** 관절 → [하한°, 상한°]. `fairino5_v6.urdf` 의 `<limit lower·upper>` 를 도로 옮긴 값. */
export const JOINT_LIMITS_DEG = {
  j1: [-175, 175],
  j2: [-265, 85],
  j3: [-162, 162],
  j4: [-265, 85],
  j5: [-175, 175],
  j6: [-175, 175],
};

/**
 * FR5 도달거리 — **벤더 스펙값**이고 우리가 잰 것이 아니다.
 *
 * 한때 `presets.js`·`schema.js` 두 곳에 따로 박혀 있었다(2026-08-28 정리). 같은 숫자가
 * 두 곳에 살면 한쪽만 고쳐지고, 그 갈래가 오늘 하루 종일 잡은 사고들의 형태다.
 * 관절 한계와 같은 성격(로봇 스펙)이라 여기 둔다.
 */
export const REACH_MM = 922;

export const JOINTS = Object.keys(JOINT_LIMITS_DEG);

/** 한계 안으로 자른다. **숫자가 아니면 0** — NaN 을 URDF 에 얹으면 팔이 사라진다. */
export function clampJoint(name, deg) {
  const lim = JOINT_LIMITS_DEG[name];
  const v = Number(deg);
  if (!Number.isFinite(v)) return 0;
  if (!lim) return v;
  return Math.min(lim[1], Math.max(lim[0], v));
}

/**
 * 자세 하나를 한계 안으로. **무엇을 잘랐는지 같이 돌려준다** —
 * 조용히 자르면 사람이 300 을 적어 놓고 175 를 보면서 300 인 줄 안다.
 *
 * @returns {{ pose: object, clamped: Array<{joint,want,got}> }}
 */
export function clampPose(pose) {
  const out = {};
  const clamped = [];
  for (const [name, deg] of Object.entries(pose ?? {})) {
    const got = clampJoint(name, deg);
    out[name] = got;
    if (Number.isFinite(Number(deg)) && got !== Number(deg)) {
      clamped.push({ joint: name, want: Number(deg), got });
    }
  }
  return { pose: out, clamped };
}

/** 한계 밖 관절을 **전부** 돌려준다. 첫 번째에서 멈추지 않는다. */
export function outOfLimit(pose) {
  const bad = [];
  for (const [name, deg] of Object.entries(pose ?? {})) {
    const lim = JOINT_LIMITS_DEG[name];
    if (!lim) { bad.push(`${name}: 모르는 관절이다`); continue; }
    const v = Number(deg);
    if (!Number.isFinite(v)) { bad.push(`${name}: 숫자가 아니다 — ${deg}`); continue; }
    if (v < lim[0] || v > lim[1]) bad.push(`${name}: ${v}° 는 한계 ${lim[0]}~${lim[1]}° 밖이다`);
  }
  return bad;
}
