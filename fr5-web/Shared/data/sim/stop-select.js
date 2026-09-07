// 정차 자리 선택 — **후보를 평가한 결과에서 하나를 고른다** (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 2).
//
// 후보는 `workcell.AMR_DROP`(채택) + `AMR_DROP_CANDIDATES` 6 — 08-31·09-04 무조코 스윕이 낸 「가능한 자리」 격자다. 거치대를
// 옮기면 각 후보의 「닿나·부딪히나·얼마나 걸리나」가 달라지므로 매번 다시 평가한다(스윕을 다시 돌리지 않는다 — 입력마다 2~3분).
// 고르는 규칙은 코드가 적어 둔 맞바꿈 그대로다 — 270° 는 팔이 덜 뻗고 180° 는 빨리 끝난다 (`workcell.js` §AMR_DROP_CANDIDATES).
// 이 파일은 순수 산술이다 — IK·접촉은 부르는 쪽이 채워 넣는다.
import { AMR_DROP, AMR_DROP_CANDIDATES } from '../workcell.js';
import { stepSeconds } from './cycle.js';

export const PRIORITIES = {
  fast: { label: '빠르게', hint: '정차 시간이 제일 짧은 자리' },
  short: { label: '덜 뻗게', hint: '팔이 제일 덜 뻗는 자리 (여유가 커진다)' },
};

/** 평가할 후보 전부 — 채택값이 0번이다 */
export const stopCandidates = () => [AMR_DROP, ...AMR_DROP_CANDIDATES];

/** 9칸 관절해에서 팔이 서 있는 시간(초) — 실기 상한 10% 기준 하한 (`cycle.stepSeconds`) */
export function dwellSeconds(steps, joints, speedPct) {
  let s = 0;
  for (let k = 1; k < steps.length; k += 1) {
    if (!joints[k - 1] || !joints[k]) return null;
    s += stepSeconds(joints[k - 1], joints[k], steps[k - 1].grip, steps[k].grip, speedPct);
  }
  return s;
}

/**
 * 후보 하나의 평가 결과 모양. 부르는 쪽이 채운다.
 * @typedef {{ stop:object, reachable:boolean, contactLegs:number, dwellSec:number|null, reachMm:number|null, why:string|null }} StopEval
 */

/**
 * 고른다. 순서: ① 닿고 부딪히지 않는 것 → ② 우선순위(빠르게=dwell 오름차순 · 덜 뻗게=reach 오름차순) → ③ 채택값(0번) 우선.
 * 전부 막히면 「그나마」가 아니라 **null** — 안 되는 자리를 골라 주면 그림이 거짓말한다.
 * @param {StopEval[]} evals
 * @param {'fast'|'short'} priority
 * @returns {{index:number, eval:StopEval, why:string}|null}
 */
export function chooseStop(evals, priority = 'fast') {
  const ok = evals.map((e, i) => ({ e, i })).filter(({ e }) => e.reachable && e.contactLegs === 0);
  if (!ok.length) return null;
  const key = priority === 'short'
    ? ({ e }) => [e.reachMm ?? Infinity, e.dwellSec ?? Infinity]
    : ({ e }) => [e.dwellSec ?? Infinity, e.reachMm ?? Infinity];
  ok.sort((a, b) => {
    const ka = key(a); const kb = key(b);
    return (ka[0] - kb[0]) || (ka[1] - kb[1]) || (a.i - b.i);
  });
  const best = ok[0];
  const why = priority === 'short'
    ? `팔 ${Math.round(best.e.reachMm)}mm 로 제일 덜 뻗음 · 정차 ${best.e.dwellSec?.toFixed(1)}초`
    : `정차 ${best.e.dwellSec?.toFixed(1)}초로 제일 빠름 · 팔 ${Math.round(best.e.reachMm)}mm`;
  return { index: best.i, eval: best.e, why };
}

/** 후보 한 줄 라벨 — 단위·순서를 한 곳에서 (감사 2026-09-06 「라벨 문법 넷」) */
export const stopLabel = (s) => `${s.yawDeg}° · ${s.fromHomeMm >= 0 ? '앞' : '뒤'} ${Math.abs(s.fromHomeMm)}mm`;
