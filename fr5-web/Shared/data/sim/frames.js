// 시뮬 재생 자세 — `Sim/out/<batch>/frames.json` 의 평평한 관절각 배열을 프레임 단위로 읽는다.
//
// **한 벌이다** (phase 4 · 2026-09-05). 전엔 `Dashboard/src/features/sim/ReplayView.jsx` 안에만 있었고 폰 XR(`AR/src/screens/xr.js`)은
// 시뮬 궤적을 재생할 길이 없었다 — 수렴 루프 D3: `events.jsonl` 은 접촉 사건뿐이고 자세는 여기(frames)에 있다.
// `timeline.js`(스테이션 이벤트 series)와는 다른 축이다 — 좌표·자세를 series 에 박지 않는다(SHARED-CORE §1.5).
export const JOINTS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];

/** 프레임 k 의 관절각을 `{j1..j6}` 로. `deg` 는 frame→joint 평평한 배열(인스턴스 하나)이다. */
export const frameAt = (deg, k, nj = 6) => Object.fromEntries(
  JOINTS.slice(0, nj).map((n, j) => [n, deg[k * nj + j]]),
);

/** 벽시계 t(ms) 를 **한 바퀴 cycleMs** 로 접어 프레임 번호로. 재생 속도는 보는 쪽이 정한다 —
 *  ReplayView 는 한 바퀴 6초 고정(실기 속도로 45초짜리를 끝까지 볼 사람이 없다). */
export const frameIndexAt = (tMs, frameCount, cycleMs = 6000) =>
  Math.max(0, Math.min(frameCount - 1, Math.floor(((tMs % cycleMs) / cycleMs) * frameCount)));
