// 판정면 팔레트 — **색을 여기서만 고친다.**
//
// 왜 파일로 뺐나 (2026-08-13): 같은 `makeWorkspace()` 가 **배경이 정반대인 두 화면**에
// 쓰인다. FR5 3D 트윈은 어두운 씬이고, 글로벌캠 겹치기는 **흰 상판 · 밝은 실험실 영상**이다.
// 트윈에 맞춘 값(마진 주황 `0.14`)을 실영상에 얹으면 **거의 안 보인다** — 실측 2026-08-13:
// 겹침 사진에서 확대해야 겨우 보였다. 그렇다고 값을 올리면 트윈이 탁해진다.
//
// `Shared/tokens/tokens.css` 에 안 넣은 이유 — 그쪽은 DOM 전용(CSS 변수)이고 three.js 는
// 숫자를 받는다. 문자열을 파싱해 넘기면 **색이 두 곳에 살게 된다** (하드 룰 5).
//
// **바꾸는 법** — 아래 숫자만 고친다. 렌더 코드는 안 건드린다.
//   · 한 화면만 바꾸려면: 그 화면이 `makeWorkspace(ws, { theme: … })` 로 다른 것을 넘긴다
//   · 둘 다 바꾸려면: 여기 두 벌을 같이 고친다
//
// 색이 **역할**을 가진다 — 이름을 바꿀 때는 역할이 바뀐 것인지 먼저 본다:
//   face   판정면 (게이트가 아는 상판·벽 그 자체)
//   margin **여유 — 여기부터 거부된다.** 판정면과 반드시 다른 색이어야 한다
//   prop   소품 (실물을 흉내 낸 것 · 판정과 무관)
//   floor  바닥
//   stale  **가정값** — 아직 실측 안 된 판정면. 게이트는 막지만 자리를 못 믿는다

/** @typedef {{face:number, margin:number, prop:number, floor:number,
 *             faceA:number, marginA:number, wallA:number, wallMarginA:number,
 *             floorA:number, edge:boolean}} ZoneTheme */

/** 어두운 3D 씬용 (FR5 트윈 · 맵 편집기). **2026-08-13 이전의 값 그대로다.** */
export const TWIN = {
  face: 0x4a86c8, margin: 0xd08a3a, prop: 0x9c9a96, floor: 0xd6d3ce, stale: 0x8f7bb8,
  faceA: 0.30, marginA: 0.14, wallA: 0.22, wallMarginA: 0.12, floorA: 0.35,
  edge: true,
  // 정합을 못 믿을 때(「미확인」) 얼마나 흐리게 하나. **0 에 가까울수록 안 보인다.**
  dimA: 0.35,
};

/**
 * 밝은 실영상 위용 (글로벌캠 겹치기).
 *
 * 두 가지를 바꾼다 — **채도**와 **불투명도**. 흰 상판 위에서는 연한 파랑이 회색으로
 * 읽히므로 색을 진하게 하고, 마진은 트윈의 `0.14` 로는 안 보이므로 올린다.
 * ⚠ 그래도 **마진을 판정면보다 진하게 하지 않는다** — 사람이 「여유」를 「상판」으로 읽는다.
 */
export const VIDEO = {
  face: 0x1f6fd0, margin: 0xff7a1a, prop: 0x9c9a96, floor: 0xd6d3ce, stale: 0x9b6bd6,
  faceA: 0.34, marginA: 0.30, wallA: 0.30, wallMarginA: 0.24, floorA: 0.35,
  edge: true,
  // ⚠ **트윈의 `0.35` 를 그대로 쓰면 안 된다** (2026-08-13 실측). 실영상에서 정합이
  // 「미확인」이면 `0.34 × 0.35 = 0.12` 가 되어 **다시 안 보인다** — 그런데 이 현장에서는
  // 사람이 태그를 자주 가려 미확인이 **평상 상태**다. 안 보이는 표시는 없는 표시다.
  // 흐리게 하는 목적은 「못 믿는다」를 말하는 것이지 **지우는 것이 아니다.**
  dimA: 0.72,
};

export const THEMES = { twin: TWIN, video: VIDEO };

/** 이름이든 객체든 받는다. 모르는 이름이면 **트윈으로 떨어진다** — 화면이 안 죽는다. */
export function resolveTheme(t) {
  if (t && typeof t === 'object') return { ...TWIN, ...t };
  return THEMES[t] ?? TWIN;
}
