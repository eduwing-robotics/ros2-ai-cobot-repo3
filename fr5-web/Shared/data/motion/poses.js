// 자세 — **배치안은 공간, series 는 시간, 여기는 팔이 어떤 모양인가.**
//
// 2026-08-04 까지 이 표는 `Dashboard/src/features/layout/LayoutView.jsx` 안에 있었다.
// React 파일 안이라 **AR 도 게이트도 못 봤다** — 자세 이름에 오타가 나도 화면이 조용히
// 대기 자세로 넘어갔고 아무도 몰랐다. 데이터로 내리는 순간 검사가 가능해진다
// (`scripts/check/motion.sh`).
//
// **순수 데이터 + 순수 함수만.** three·React·DOM 을 안 쓴다. 그려 주는 것은 화면 몫이다.
//
// **키프레임이지 역기구학이 아니다.** 손끝 좌표를 넣으면 각도를 푸는 것(IK)은 PRD 범위
// 밖이라, 자세를 손으로 적고 **순기구학으로 어디에 닿는지 재서** 화면에 낸다 — 지어낸
// 각도가 아니라 잰 각도다. 실기 시연 녹화가 오면 이 표를 그 값으로 바꿔 끼운다
// (`GOAL-imitation-demo.md`).
//
// **`j1` 은 여기 없다** — 목표를 겨누는 각도라 배치안이 정한다 (`view.armAim()`).
// 나머지 다섯 개만 자세가 들고, `j1` 은 화면이 `easeAngle` 로 따라가게 얹는다.

// **자세표는 여기 없다** — `presets.js` 가 출하 기본값을 들고, 저장분은 datasource 가 든다
// (2026-08-04 · 사람이 관절을 잡아 자세를 만들려면 먼저 저장되는 데이터여야 한다).
// 이 파일은 **자세를 가지고 무엇을 하나**만 안다.
import { buildPoseSet, DEFAULT_POSE_SET } from './presets.js';
import { JOINTS, clampPose } from './limits.js';

export { POSE_PRESETS, DEFAULT_POSE_SET, buildPoseSet } from './presets.js';

/**
 * 저장분이 없을 때 쓰는 자세 이름표. **화면은 보통 자기 보관함을 넘겨준다** —
 * 이건 게이트와 AR 처럼 보관함이 없는 쪽을 위한 기본값이다.
 */
export const PRESET_POSES = buildPoseSet(DEFAULT_POSE_SET).poses;


/** 사건 → 그 구간에서 쓸 자세 두 벌. 구간 안에서 `k` 만큼 섞는다. */
export const POSE_AT = {
  feed: ['home', 'home'],
  move: ['home', 'approach'],
  hold: ['approach', 'grip'],
  join: ['grip', 'unscrew'],
  hoist: ['retreat', 'home'],
  drop:  ['home', 'home'],
  out:   ['home', 'home'],
};

/**
 * 투입 팔의 자세표 — **역할이 다르면 뻗는 방향이 다르다.**
 *
 * **한 칸 앞서 움직인다.** `pick` 이 시작될 때 이미 팔레트 자세여야 집는 것으로 보인다 —
 * 그때부터 내려가기 시작하면 손끝이 작업물을 1.7m 뒤에서 쫓아간다 (실렌더가 잡았다).
 */
export const FEED_POSE_AT = {
  haul:  ['lowIdle', 'lowPile'],   // AMR 이 오는 동안 팔이 미리 내려간다
  pick:  ['lowPile', 'lowBelt'],   // 집어서 컨베이어로 — 작업물과 같이 간다
  feed:  ['lowBelt', 'lowIdle'],   // 놓고 물러난다
  move:  ['lowIdle', 'lowIdle'],
};

/** 팔이 쉬는 자세. 사건에 자세가 없으면 여기로 간다 */
export const IDLE = { feed: 'lowIdle', process: 'home' };

/**
 * **어느 사건에서 팔이 물건을 들고 있나.** 값은 어느 쪽 팔인지다.
 *
 * 컨베이어가 나르는 구간(`move`)과 크레인이 드는 구간(`hoist`·`drop`)은 여기 없다 —
 * 거기선 팔이 물건을 안 잡는다.
 */
export const CARRY_BY_ARM = { pick: 'feed' };

/**
 * 두 자세를 섞는다. **각도끼리 보간** — `MoveJ` 가 실제로 하는 계산과 같다.
 *
 * 단 **선형이 아니라 가감속을 넣는다.** 실기 `MoveJ` 는 사다리꼴 속도 프로파일로 움직여서
 * 출발할 때 서서히 붙고 도착할 때 서서히 잦아든다. 선형으로 두면 등속으로 가다가
 * 딱 멈춰 **기계가 아니라 슬라이드쇼처럼 보인다** — 실기 담당자가 "단조롭다" 고 한 것의 절반이다.
 */
export const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2);

/**
 * **숫자가 아닌 `k` 는 0 으로 본다.** `Math.max(0, NaN)` 이 NaN 이라 그냥 두면 NaN 이
 * 관절까지 흘러가고, NaN 을 URDF 에 얹으면 **팔이 화면에서 사라진다 — 에러는 안 난다.**
 * `stateAt` 은 늘 유한한 `k` 를 내지만, 자세를 손으로 만드는 화면이 오면 여기가 첫 입구다
 * (`scripts/check/motion.sh` 가 첫 실행에서 잡았다 · 2026-08-04).
 */
const clamp01 = (k) => (Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 0);

export function mixPose(a, b, k) {
  const t = ease(clamp01(k));
  const out = {};
  // **관절만 섞는다.** 자세는 `source` 같은 이름 칸도 들고 있어서 키를 통째로 훑으면
  // 문자열에 산술이 걸려 `'hand' + NaN` 이 관절 값으로 흘러간다 (2026-08-04).
  for (const n of JOINTS) out[n] = (a?.[n] ?? 0) + ((b?.[n] ?? 0) - (a?.[n] ?? 0)) * t;
  return out;
}

/**
 * 한 시각에 팔이 취할 자세. **어느 표를 볼지 고르는 규칙을 화면에서 빼낸다** —
 * 화면이 표를 직접 뒤지면 팔 역할이 늘 때마다 화면을 고쳐야 한다.
 *
 * `st` 는 `stateAt()` 의 결과이고 `null` 이면 대기 자세다 (재생 안 하는 중이 정상이다).
 * `poses` 는 **보관함**이다 — 화면이 저장분을 넘기고, 안 넘기면 프리셋을 쓴다.
 * **모르는 사건은 던지지 않고 대기 자세로 간다** — 계약상 `event` 는 자유 문자열이다.
 */
export function poseFor(st, { feed = false, poses = PRESET_POSES } = {}) {
  const idle = feed ? IDLE.feed : IDLE.process;
  const P = poses ?? PRESET_POSES;
  const at = (n) => P[n] ?? P[idle] ?? PRESET_POSES[idle];
  // **한계 안으로 자른다.** 저장분에는 사람이 만든 자세가 들어오고, `urdf-loader` 는
  // 말없이 자르므로 여기서 자르지 않으면 화면과 데이터가 갈라진다 (`limits.js` 주석).
  const only = (p) => clampPose(Object.fromEntries(JOINTS.map((j) => [j, p?.[j] ?? 0]))).pose;
  if (!st) return only(at(idle));
  // **사건이 든 자세가 먼저다.** 전역 표는 사건 이름을 아는 옛 판을 위한 폴백이다 —
  // 이름을 자유롭게 지으면 표가 그 이름을 모른다 (2026-08-04).
  const role = feed ? 'feed' : 'process';
  const own = st.pose?.[role];
  const pair = own ?? (feed ? FEED_POSE_AT : POSE_AT)[st.event] ?? [idle, idle];
  // 이름 하나면 그 자세로 머문다 — 두 벌이면 구간 안에서 섞는다
  const [from, to] = typeof pair === 'string' ? [pair, pair] : pair;
  return only(mixPose(at(from), at(to ?? from), st.k));
}

/**
 * `j1` 을 **따라가게** 한다 — 목표가 튀어도 관절은 서서히 돈다.
 *
 * 겨눔각을 그대로 얹으면 작업물이 팔레트→컨베이어로 넘어가는 순간 **j1 이 순간이동한다.**
 * 실물은 그렇게 못 돈다. 프레임마다 남은 각의 일부만 좁히는 1차 지연을 건다 —
 * `MAX_DPS` 로 상한도 둔다 (안전 규칙의 각속도 상한과 같은 발상 · `SAFETY-RULES.md`).
 */
export const J1_MAX_DPS = 70;

export function easeAngle(cur, want, dt) {
  let d = ((want - cur + 540) % 360) - 180;          // 짧은 쪽으로 돈다
  const lim = J1_MAX_DPS * Math.max(0.001, dt);
  d = Math.max(-lim, Math.min(lim, d * 0.18 + Math.sign(d) * Math.min(Math.abs(d), 0.6)));
  return cur + d;
}
