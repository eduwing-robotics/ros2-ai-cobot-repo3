// 분할 이동 — 긴 관절 이동을 **조각**으로 잘라 한 조각씩 보내고 도착을 확인한다 (2026-09-07 · GOAL-lab-pick-place-1).
//
// 왜: WS `moveJ` 는 경로를 안 훑는 대신 **한 명령에 관절 5° 까지**만 받는다(`API-CONTRACT` §명령 · `safety.JOINT_DELTA_CAP_DEG` · 실기 2026-09-07
// 「관절 변화 31.5° > 상한 5.0° — 거부」). 정착 상한 60초(D94)도 있지만 5° 가 더 엄해서 그것이 조각 크기다. 조각은 **관절 공간 직선 위**의 점이라
// 새 자세를 만들지 않고, 조각마다 도착을 확인하므로 「응답을 못 보면 성공으로 가정」(09-04 ②)의 함정도 피한다.
// 0.87°/s(10%×30%) 에서 조각 하나 5.7초 · 63° 이동 13조각 ≈ 1.5분 · 손목 반 바퀴 36조각 ≈ 4분. 더 빠른 길은 경로를 훑는 창구(/proposal · 사다리 7)다.
export const CHUNK_DEG = 5;
// ⭐ 경로를 훑는 창구(`/proposal` · 2026-09-07 열림)는 5° 상한이 없고 **정착 상한 60초**(D94)만 있다 — 10% 에서 172°. 여유를 두고 120°(약 42초):
//    손목 반 바퀴 189° 가 2조각(5° 조각 38개 5분 → 약 70초). 조각은 여전히 관절 공간 직선 위의 점이고 조각마다 도착을 확인한다.
export const BIG_CHUNK_DEG = 120;
export const ARRIVE_DEG = 1.0;

/** 관절 최대 차(°) */
export const maxJointDelta = (a, b) => (Array.isArray(a) && Array.isArray(b) && a.length === b.length
  ? Math.max(...b.map((v, i) => Math.abs(v - a[i]))) : NaN);

/**
 * `cur` → `target` 을 `maxDeg` 이하 조각으로. 마지막 조각은 정확히 `target` 이다.
 * @returns {number[][]} 조각 목표들(현재 자세는 안 들어간다) · 이동이 없으면 `[target]`
 */
export function chunkJoints(cur, target, maxDeg = CHUNK_DEG) {
  const d = maxJointDelta(cur, target);
  if (!Number.isFinite(d)) return [];
  const n = Math.max(1, Math.ceil(d / maxDeg));
  return Array.from({ length: n }, (_, k) => (k === n - 1 ? target.slice() : cur.map((v, i) => v + ((target[i] - v) * (k + 1)) / n)));
}

/** 조각 하나의 예상 시간(s) — 관절 각속도 × 명령 %. ⚠ **전역 속도는 곱하지 않는다** — 실기 2026-09-07: 전역 30 · 명령 10 에서 63° 가 24초(2.7°/s) 로
 *  브리지 모델 28.9×10% = 2.89°/s 와 맞았다. 전역을 곱하던 옛 추정(0.87°/s)은 3배 비관적이어서 대기 예산이 부풀었다(GAP 09-07) */
export const chunkSeconds = (deg, cmdPct = 10, degPerSecFull = 28.9) => deg / (degPerSecFull * (cmdPct / 100));

/** 도착했나 — 모든 관절이 `tol` 안 */
export const arrived = (now, target, tol = ARRIVE_DEG) => Number.isFinite(maxJointDelta(now, target)) && maxJointDelta(now, target) <= tol;
