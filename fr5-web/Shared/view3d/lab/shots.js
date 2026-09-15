// 샷 목록 — **한 시나리오를 카메라만 바꿔 여러 번 찍는다.**
//
// `stateAt(series, t)` 이 결정론적이라(`timeline.js` 머리) 서로 다른 패스에서 같은 `t` 를
// 물으면 팔도 AMR 도 탄두도 **같은 자리**에 있다. 실촬영 다중 카메라의 최대 난제인
// **동기가 아예 없다** — 컷이 프레임 단위로 맞고, 마음에 안 드는 샷 하나만 다시 구울 수 있다.
// 근거와 수렴 과정은 `docs/ref/rnd/CINEMATIC-DEMO-CONVERGE-LOOP-2026-08-10.md` §R8.
//
// **새 SSOT 가 아니다.** 영상 하나를 만드는 데 데이터 모델을 세우는 것은 YAGNI 라 R1 에서
// 기각됐다 (`scenario/presets.js` 가 데이터로 승격된 이유는 "배치안마다 다르게 줘야 해서"
// 였고 샷에는 그 요구가 없다). 상수 배열이라 **하드 룰 1 이 안 걸린다** — 새 최상위 폴더도
// 새 엔드포인트도 없다. 두 번째 영상이 필요해지면 그때 승격한다.
//
// **좌표는 평면도 mm 다.** 씬으로 옮기는 것은 `units.js` 의 `planToScene` 한 곳만 한다
// (하드 룰 5). 여기서 미터를 쓰거나 부호를 뒤집지 않는다.
//
// **카메라 자리는 계산이 아니라 화면에서 정한 값이다** — 커밋 `90aead4` 와 같은 규약.
// 접점 시트(`cine-probe.mjs --contact`)로 첫 프레임만 한 장에 굽고, 눈으로 고쳐 여기 박는다.

import { planToScene } from '../../data/units/units.js';

/** 출력 프레임률. 슬로우모션은 **여기를 올리는 게 아니라 `speed` 를 내려서** 만든다 */
export const FPS = 30;

/**
 * 영상의 기본 레이어. **편집기 기본값과 다르다.**
 *
 * 도달 링(초록/빨강)과 도달 범위 원판은 배치를 정할 때의 판정 근거인데, 영상에서는
 * **에러 마커처럼 읽힌다** — 1차 접점 시트에서 빨간 링이 여러 장에 깔려 있었다 (2026-08-10).
 * 작업물 표식만 남긴다. 흰 모형 안의 흰 탄체는 그것 없이는 눈에 안 걸린다.
 */
export const DEFAULT_LAYERS = { judge: false, reach: false, path: false, workMark: true };

/** 패스의 레이어 = 기본값 위에 그 패스가 덮어쓴 것 */
export function layersOf(shot) {
  return { ...DEFAULT_LAYERS, ...(shot.layers ?? {}) };
}

/**
 * 패스 하나.
 *
 * - `fromSec`·`toSec` — 시나리오 시각(초). 겹쳐도 된다 — **같은 구간을 다른 각도로 두 번**
 *   보여주는 것이 이 구조로 얻는 것이다 (gif 에서는 불가능했고 유튜브에서만 자연스럽다).
 * - `speed` — 1 보다 작으면 느리게. 없던 프레임을 **새로 그리므로** 뭉개지지 않는다.
 * - `eye`·`aim` — 평면도 mm `[x, y, z]`.
 * - `layers` — 이 패스에서만 켜는 것. 강조를 후처리 없이 내는 자리다 (D57).
 */
export const SHOTS = [
  { id: 'establish', fromSec: 0, toSec: 6, speed: 1,
    eye: [7600, -1200, 4200], aim: [3200, 4200, 800],
    note: '무대 전체. **짧게 쓴다** — 기본 와이드는 로봇이 화면의 10% 도 안 된다(2026-08-10 실측)' },

  { id: 'amr', fromSec: 0, toSec: 5, speed: 1,
    // 자리를 두 번 옮겼다 (2026-08-10 접점 시트) — ①`x=3375` 에 서니 리프터 원기둥이
    // 화면을 통째로 막았고 ②방 **밖**(y<0)으로 빼니 유리벽 너머라 뿌옇게 씻겼다.
    // 안쪽 낮은 자리가 답이다.
    eye: [400, 600, 800], aim: [1300, 1800, 200], layers: { reach: true },
    // **`path` 는 켜지만 쓰지 않는다.** 켜 봤더니 경로 기즈모는 **편집용**이라 번호 손잡이
    // (1·2·3·4)가 화면을 덮고 터틀봇을 통째로 가렸다 (2026-08-10 접점 시트). 플래그는
    // 정직하게 동작하지만 영상에는 안 맞는다 — 로봇이 바닥을 지나가는 것으로 충분하다.
    note: '터틀봇이 팔레트로 들어온다. **도달 범위는 이 패스에서만** — 왜 거기로 가는지가 여기서만 필요하다' },

  { id: 'feed', fromSec: 7, toSec: 14, speed: 1,
    eye: [6200, 1800, 1500], aim: [2600, 900, 800],
    note: '투입 팔이 집어 컨베이어에 놓는다. 저각 — B각 계열' },

  { id: 'convey', fromSec: 13, toSec: 18, speed: 1,
    // 작업물이 지나는 한가운데를 겨눈다. 탄체는 t=14~17 에 y 900→6000 을 지나므로
    // 겨눔은 그 중간이다 — 1차 렌더는 y=4400 을 봐서 탄체가 아직 화면 밖이었다
    eye: [5300, 2900, 1150], aim: [3375, 3400, 700],
    note: '컨베이어 이송. 대각으로 화면을 가른다' },

  { id: 'join1', fromSec: 19, toSec: 26, speed: 0.5,
    eye: [5200, 5200, 1700], aim: [3375, 5900, 1100],
    note: '신관 1차 결합. **절반 속도** — 이 영상에서 제일 중요한 동작이다' },

  { id: 'join2', fromSec: 26, toSec: 37, speed: 1,
    eye: [1500, 6800, 1700], aim: [3375, 6000, 1100],
    note: '2·3차 결합을 반대편에서. 같은 일을 다른 각도로 보여주는 자리' },

  { id: 'final', fromSec: 35.5, toSec: 38, speed: 0.4,
    eye: [4600, 5300, 1400], aim: [3375, 5950, 1100],
    // 1차는 4초를 0.35배로 늘려 11.4초였는데, 그동안 화면이 거의 안 바뀌어 **멈춘 것처럼
    // 보였다** (2026-08-10 샘플 시트에서 연속 두 장이 같았다). 느린 것과 멈춘 것은 다르다.
    note: '완성되는 순간. 제일 느리게 — 다만 **6초를 넘기지 않는다**' },

  { id: 'crane', fromSec: 38, toSec: 45, speed: 1,
    // **거더보다 낮게 선다.** 3.6m 에 두니 거더가 화면을 대각으로 잘라 피사체를 덮었다
    eye: [6000, 7400, 1900], aim: [3375, 6600, 1200],
    note: '크레인이 들어 배출로. 갈고리와 거더가 위에 걸린다 — 수직을 쓴다(D62)' },

  { id: 'out', fromSec: 43, toSec: 49, speed: 1,
    // 출구(y=11200)를 겨누면 빈 복도만 나온다 — **작업물이 지나는 구간**을 본다.
    // 탄체는 t=43~49 에 y 7200→11200 을 지난다: 겨눔을 앞쪽으로 당겨야 등장이 잡힌다
    eye: [5800, 7000, 1600], aim: [3375, 8600, 900],
    note: '완성품이 실험실 밖으로' },
];

/** 이 패스가 낼 프레임 수. `speed` 가 낮을수록 많아진다 */
export function frameCountOf(shot, fps = FPS) {
  return Math.max(1, Math.round(((shot.toSec - shot.fromSec) / shot.speed) * fps));
}

/** 패스 `i` 의 프레임 `n` 이 가리키는 시나리오 시각(초) */
export function timeAt(shot, n, fps = FPS) {
  return shot.fromSec + (n * shot.speed) / fps;
}

/** 카메라 자리·표적을 **씬 좌표(미터)** 로. 변환은 `planToScene` 한 곳만 지난다 */
export function cameraOf(shot) {
  return { eye: planToScene(shot.eye), aim: planToScene(shot.aim) };
}

/** 전부 이어 붙였을 때 몇 초·몇 프레임인가. 예산(90~120초 · ≤3,600프레임) 확인용 */
export function budget(shots = SHOTS, fps = FPS) {
  const frames = shots.reduce((a, s) => a + frameCountOf(s, fps), 0);
  return { frames, sec: +(frames / fps).toFixed(1), shots: shots.length };
}
