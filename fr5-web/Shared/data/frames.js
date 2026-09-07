// 좌표계 SSOT — **숫자가 어디 기준인지 아는 유일한 곳.**
//
// 뜻은 `docs/ref/contract/FRAMES.md` 가 적고, 값은 여기가 든다. 둘은 같은 표다.
//
// 왜 있나 — 이 저장소는 좌표계 **라벨**을 잘못 읽어 네 번 다쳤다 (D87 하루 · 벽 342mm ·
// 터틀봇 342.1mm · 터틀봇 전진 반대). 네 번 다 **계산은 맞았다.** 변환이 여덟 갈래인데
// 사는 곳이 여덟 군데라서 난 사고다. 그래서 갈래를 여기 한 곳에 모은다.
//
// ⛔ **여기 없는 변환을 화면 코드에서 새로 만들지 않는다.** 만들면 다섯 번째다.
import { AMR_HOME } from './workcell.js';

/** 회전 문턱 — `workspace.js` 의 `toBase()`(상자·벽 뭉치)와 **같은 값**이어야 한다 */
export const ROT_TOL_DEG = 0.5;

/** 프레임 등재. 여기 없는 이름은 이 저장소에서 좌표계가 아니다. */
export const FRAMES = {
  base:   { origin: '로봇 베이스 (= 카트 상판 ±7mm)', owner: 'URDF · workcell.js' },
  user1:  { origin: '작업물이 놓인 판 · 화면 손끝 숫자의 원점', owner: '실기 coordDefs.user' },
  tcp:    { origin: '손끝 = 플랜지 +135mm (핑거 끝)', owner: '실기 tl_cur_pos · D108' },
  lab:    { origin: '실험실 바닥 (평면도 원점)', owner: 'presets.js realmap' },
  // ⛔ **`lab` 이 두 개다.** 이름이 같고 자리가 다르다 — 2026-08-28 에 여기서 또 틀렸다
  // (계산에 두 lab 을 섞어 「태그가 카메라보다 높다」는 말이 안 되는 답이 나왔다).
  camLab: { origin: '글로벌캠이 쓰는 lab — **태그0 · 카트 덱 평면**. z 는 덱 위가 +',
    owner: 'scripts/map/marker_follow.py · scene-anchors.json' },
  table:  { origin: '작업대 상판 — **원점 미정의**', owner: '(없음)' },
  odom:   { origin: '터틀봇이 브링업한 자리 = 홈. **축도 그때 향한 쪽**', owner: 'TB 브리지' },
  map:    { origin: 'SLAM 맵 원점 (맵마다 다름)', owner: 'TB 브리지 · 미사용 D134' },
  tag:    { origin: '글로벌캠 기준 태그', owner: 'robot-base-in-tag.json' },
  camera: { origin: '카메라 광학 원점', owner: 'handeye' },
};

/**
 * 변환 한 갈래. **`p_to = R(yawDeg)·p_from + deltaMm`**.
 *
 * `kind` 가 곧 신뢰도다:
 *   `live`     실기가 매 상태마다 준다 — 값을 **넘겨받아야** 한다 (모듈이 지어내지 않는다)
 *   `measured` 사람·로봇이 잰 값
 *   `derived`  잰 값 둘에서 나온 값 (근거를 `note` 에 적는다)
 *   `unknown`  **모른다.** 이 갈래를 지나는 변환은 `null` 이다 — 0 으로 채우지 않는다
 */
export const EDGES = [
  {
    from: 'user1', to: 'base', kind: 'live', liveKey: 'user1',
    note: '실측 (−401.8, +497.3, +342.1) · 회전 0 · 거리 725.1mm. D87 이 만든 값',
  },
  {
    from: 'odom', to: 'user1', kind: 'measured',
    deltaMm: [AMR_HOME.xMm, AMR_HOME.yMm, AMR_HOME.topZMm], yawDeg: AMR_HOME.yawDeg,
    // ⚠ **회전이 진짜로 있다.** odom 은 브링업 순간의 자세를 기준축으로 잡으므로
    // odom +x = 홈에서 로봇이 본 쪽 = user1 −x 다. 자리만 더하면 전진이 반대로 그려진다.
    note: '자리 = 줄자 2026-08-28 · 회전 = 「벽을 등지고」에서 유도(각도기 아님)',
  },
  {
    // ⛔ **`base` 가 아니라 `user1` 이다** (2026-08-28 감사에서 잡혔다 — 다섯 번째 라벨 사고,
    // 그것도 라벨 사고를 막으려고 만든 이 파일 안에서 냈다).
    //
    // 이 값은 **같은 작업대를 두 프레임으로 잰 것의 차**다:
    //   `config.yaml` 작업대1 중앙 (688.1, −1048.2) — **user1 프레임**(게이트 값은 user1 기준)
    //   `presets.js` realmap 의 table1  (2204.2, 1750.0) — lab 프레임
    //   차 = (1516.1, 2798.2) → 따라서 **user1 → lab** 이다.
    // `presets.js` 는 이 자리를 「로봇 베이스」라 적었는데, 실제로 더한 숫자는 user1 값이라
    // **그 주석이 프레임을 잘못 말한다** (같은 사고의 원본으로 보인다).
    //
    // z 는 바닥까지의 거리다 — 카트 상판(base −3.7) − 카트 높이 1000 = 바닥(base −1003.7),
    // user1 로는 −1345.8. 검산: 작업대 상판 user1 −380.9 + 1345.8 = **964.9** 이고
    // presets 의 작업대 높이 `hMm 965` 와 0.1mm 안에서 맞는다.
    from: 'user1', to: 'lab', kind: 'derived', deltaMm: [1516.1, 2798.2, 1345.8], yawDeg: 0,
    note: '같은 작업대를 user1·lab 두 프레임으로 잰 값의 차. z 는 바닥까지 (검산 965와 0.1mm)',
  },
  // ── 아래는 **모른다.** 적어 두는 이유는 「없다」와 「안 찾아봤다」를 가르기 위해서다.
  { from: 'table', to: 'user1', kind: 'unknown',
    note: '판 상자 자리는 실측이지만 **판 좌표계 원점을 아무도 정의 안 했다**. TB 경로의 tableToOdom 이 전부 null' },
  {
    // ⚠ **z 는 안다, x·y 를 모른다.** 카트 덱은 base −3.7 이고 `camLab` 의 z 원점이 바로 그 면이라
    // z 오프셋은 −3.7 이다 (검산: 작업대 상판이 `camLab` 에서 −35 로 나온다는 기록과 base 계산
    // −38.8 − (−3.7) = −35.1 이 맞는다). **막는 것은 태그0 이 base 에서 어디냐**가 미측정인 것.
    // 그때까지 이 갈래는 `unknown` 이고, 두 좌표를 **섞어 쓰면 안 된다.**
    from: 'camLab', to: 'base', kind: 'unknown',
    note: 'z 오프셋 −3.7 은 유도됐으나(카트 덱) 태그0 의 base x·y 가 미측정 — 그래서 아직 못 잇는다',
  },
  { from: 'map', to: 'lab', kind: 'unknown',
    note: 'mapToLab 미측정 — GAP-MATRIX 「이번 트랙 최대 관문」. SLAM 미사용이라 지금은 안 쓴다 (D134)' },
  { from: 'tag', to: 'base', kind: 'unknown',
    note: 'robot-base-in-tag.json 은 있으나 yaw 재측정 대기 (anchor-pose.py 주석) — 낡은 값을 믿지 않는다. '
      + '⚠ 터틀봇 태그(id18)는 2026-08-28 에 붙었고 로봇 기준 오프셋도 잰다(workcell.js AMR_TAG) — '
      + '막는 것은 **글로벌캠이 그 태그를 찾아내는 검출기가 아직 0줄**이라는 것이다' },
  { from: 'camera', to: 'tcp', kind: 'unknown',
    note: 'handeye. 6-DOF 라 이 표의 평면 yaw 모델로는 못 적는다 — 필요해지면 모델부터 늘린다' },
  { from: 'tcp', to: 'base', kind: 'unknown',
    note: '실기가 매 틱 주지만 6-DOF 다. 위와 같은 이유로 아직 이 표에 못 넣는다' },
];

const DEG = Math.PI / 180;

/** `live` 정의 하나를 평행이동으로 읽는다. 회전이 문턱을 넘으면 `null` (규약 3) */
function fromLive(def) {
  if (!Array.isArray(def) || def.length < 6) return null;
  // ⛔ **`Number()` 를 씌우기 **전에** 원본을 본다.** 씌운 뒤에 검사하면 이미 늦다 —
  // `Number(null)` 이 `0` 이라 **값 없음이 「회전 0」으로 둔갑**하고, 계약이 금지한
  // 「0 으로 채워 아는 척하기」가 여기서 일어난다 (2026-08-28 감사).
  // `NaN` 도 문턱을 못 잡는다 — **`NaN > 0.5` 는 항상 false** 다.
  // 그래서 검사는 **타입부터**다: 여섯 칸 전부 유한한 **숫자**여야 한다.
  // 실기 `coordDefs` 는 JSON 숫자로 오므로 이 문턱이 정상 데이터를 막지 않는다.
  if (!def.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const v = def.map(Number);
  if (Math.max(...v.slice(3, 6).map(Math.abs)) > ROT_TOL_DEG) return null;
  return { deltaMm: [v[0], v[1], v[2]], yawDeg: 0 };
}

/** 갈래 하나를 실제 값으로. 못 풀면 `null` */
function resolve(edge, live) {
  if (edge.kind === 'unknown') return null;
  if (edge.kind === 'live') return fromLive(live?.[edge.liveKey]);
  return { deltaMm: edge.deltaMm, yawDeg: edge.yawDeg ?? 0 };
}

const fwd = (p, d, yaw) => {
  const c = Math.cos(yaw * DEG); const s = Math.sin(yaw * DEG);
  return {
    xMm: p.xMm * c - p.yMm * s + d[0],
    yMm: p.xMm * s + p.yMm * c + d[1],
    zMm: p.zMm + d[2],
  };
};
const inv = (p, d, yaw) => {
  const x = p.xMm - d[0]; const y = p.yMm - d[1];
  const c = Math.cos(-yaw * DEG); const s = Math.sin(-yaw * DEG);
  return { xMm: x * c - y * s, yMm: x * s + y * c, zMm: p.zMm - d[2] };
};

/**
 * 점 하나를 프레임 사이로 옮긴다.
 *
 * **못 옮기면 `null` 이다** (규약 3 — fail-closed). 셋 중 하나면 `null`:
 *   ① 경로에 `unknown` 갈래가 있다  ② `live` 값을 안 넘겼다  ③ 회전이 0.5° 를 넘는다
 * 부르는 쪽은 그때 **안 그린다.** 반쯤 맞는 자리는 없는 것보다 나쁘다.
 *
 * @param {{xMm:number,yMm:number,zMm:number}} p
 * @param {string} from 프레임 이름 (`FRAMES` 의 키)
 * @param {string} to
 * @param {{[liveKey:string]: number[]}} [live] 실기가 주는 정의 — 예 `{ user1: coordDefs.user }`
 * @returns {{xMm:number,yMm:number,zMm:number}|null}
 */
export function toFrame(p, from, to, live = {}) {
  if (!p || !Number.isFinite(p.xMm) || !Number.isFinite(p.yMm) || !Number.isFinite(p.zMm)) return null;
  if (!FRAMES[from] || !FRAMES[to]) return null;
  if (from === to) return { ...p };

  // 너비 우선 — 갈래가 열 개 남짓이라 이걸로 충분하다. 최단 경로가 곧 가정이 제일 적은 길이다.
  const queue = [[from, p]];
  const seen = new Set([from]);
  while (queue.length) {
    const [at, cur] = queue.shift();
    for (const e of EDGES) {
      let next = null; let pt = null;
      if (e.from === at && !seen.has(e.to)) {
        const r = resolve(e, live); if (!r) continue;
        next = e.to; pt = fwd(cur, r.deltaMm, r.yawDeg);
      } else if (e.to === at && !seen.has(e.from)) {
        const r = resolve(e, live); if (!r) continue;
        next = e.from; pt = inv(cur, r.deltaMm, r.yawDeg);
      }
      if (!next) continue;
      if (next === to) return pt;
      seen.add(next);
      queue.push([next, pt]);
    }
  }
  return null;
}

/**
 * 자세(요각)를 프레임 사이로 옮긴다 — 자리와 **따로** 부른다.
 *
 * 자리와 자세를 한 값에 섞으면 한쪽만 고쳐진다 (2026-08-28 에 `deg` 하나가 「로봇이 어디를
 * 보나」와 「모델이 어떻게 구워졌나」를 같이 들고 있다가 90° 틀렸다).
 */
export function yawToFrame(yawDeg, from, to, live = {}) {
  if (!Number.isFinite(yawDeg)) return null;
  const o = toFrame({ xMm: 0, yMm: 0, zMm: 0 }, from, to, live);
  const n = toFrame({ xMm: Math.cos(yawDeg * DEG), yMm: Math.sin(yawDeg * DEG), zMm: 0 }, from, to, live);
  if (!o || !n) return null;
  return Math.atan2(n.yMm - o.yMm, n.xMm - o.xMm) / DEG;
}

/** 사람·게이트가 읽는 요약 — 문서(`FRAMES.md`)와 어긋나면 게이트가 잡는다 */
export function frameStatus() {
  return EDGES.map((e) => ({ edge: `${e.from}→${e.to}`, kind: e.kind, note: e.note }));
}
