// **파지 기하** — 집게가 물건을 물 자리에 있나 (mm).
//
// ⛔ **이건 판정이 아니라 계측이다.** `clearance.mjs` 와 같은 자리에 산다 — 판정의 정본은
//    `judge.mjs`(=`safety.check_workspace` 의 사본) 하나뿐이고, 여기 코드는 저쪽 대조
//    게이트(`sim-parity`)가 재는 대상이 아니다. 섞으면 「사본이 원본과 같은가」를 재는
//    게이트가 사본에만 있는 코드를 안게 된다.
//
// **시뮬이 답하는 것은 둘뿐이다** (`SIM-CONTRACT.md` §파지는 기하까지만 · D123):
//
//   > 집게 끝이 물건의 높이 띠 안에 들어왔나, 그리고 집게 사이에 물건이 있나
//
// 미끄러짐·유지력·운반 중 낙하는 마찰과 접촉 강성이 필요하고 **그 값에 출처가 없다.**
// 넣으면 계측이 아니라 연출이 된다. 그 판정은 실기 그리퍼 게이트가 한다 — 실기에서
// **완전닫음이면 무엇이든 꽉 잡힌다**가 확인됐으므로(실기 담당자 · 2026-08-12) 쥐는 힘을
// 지어낼 이유도 사라졌다.
//
// ⛔ **문턱을 여기서 만들지 않는다.** 「몇 mm 물려야 잡히나」는 실측이 없다. 그래서 이 파일은
//    **숫자를 내고 사유를 가를 뿐** 합격선을 정하지 않는다 — 합격선과 가중치는 칸 4 의
//    채점 스펙이 값으로 들고 있다 (실기 담당자 2026-08-13 「최적은 언제든 수정될 수 있게」).
//    문턱을 코드에 박으면 그 확장성이 첫 줄에서 죽는다.
//
// 제원은 **정본에서 읽는다** — `gripper-mount.json`(행정·핑거 돌출) · `tool-hull.json`(턱 폭).
// 실기도 같은 파일을 읽으므로 여기 숫자를 적을 자리가 없다.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rotFixedXyz } from './judge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOUNT = join(HERE, '../../Shared/data/config/gripper-mount.json');
const HULL = join(HERE, '../../Shared/data/config/tool-hull.json');

/** 왜 물지 못하나. 통과면 `null`. 칸 4 의 **탈락 사유**가 이 이름 그대로 붙는다. */
export const GRASP = {
  tooHigh: 'tooHigh',       // 손끝이 물건 꼭대기보다 위 — 헛짚는다
  tooLow: 'tooLow',         // 손끝이 물건 밑동보다 아래 — 받침을 문다
  offAxis: 'offAxis',       // 높이는 맞는데 집게 **사이**가 아니다 (옆으로 빗나감)
  notReached: 'notReached', // 사이는 맞는데 깊이가 틀렸다 — 덜 들어갔거나 지나쳤다
  tooWide: 'tooWide',       // 물건이 총 행정보다 굵다 — 벌려도 안 들어간다
  poseUnreadable: 'poseUnreadable',       // 손끝 자세가 6개가 아니다 (결측=차단 · 제1원칙)
  objectUnreadable: 'objectUnreadable',
  gripperUnreadable: 'gripperUnreadable',
};

/**
 * 집게 제원 — **전부 실측 정본에서 온다.** 못 읽으면 `Error` 를 값으로 들고 있는다
 * (`judge.mjs` 의 형상 로딩과 같은 모양 — 결측이 조용히 0 이 되지 않게).
 *
 * TCP 좌표계는 원점이 **핑거 끝**이고 축은 플랜지와 같다. 몸통이 `z ≈ −80` 에 있으므로
 * **집게 사이 공간은 `z ∈ [−bandMm, 0]`** 이다 — 0 이 손끝, 음수 쪽이 몸통이다.
 */
export const JAW = (() => {
  try {
    const m = JSON.parse(readFileSync(MOUNT, 'utf-8'));
    const h = JSON.parse(readFileSync(HULL, 'utf-8'));
    const fingers = h.boxes.filter((b) => /finger/i.test(b.name));
    if (fingers.length !== 2) throw new Error(`핑거 상자가 둘이 아니다: ${fingers.length}`);
    // 턱 폭은 **폭축(Y) 반너비**다 — 여기서만 경계상자를 쓴다. 개폐축(X)은 안 쓴다:
    // 핑거 상자가 X 로 서로 겹쳐 있어(중심 ±10 · 반너비 26.9) 턱 **면**을 못 준다. 그건
    // 상자가 캐리지까지 감싼 경계상자라서고, `tool-hull.json` §_근사 가 이미 적어 뒀다.
    // 개폐는 상자가 아니라 **사양서 행정**에서 온다 — 그쪽이 실측이다.
    const halfWidthMm = Math.min(...fingers.map((b) => b.halfMm[1]));
    const bandMm = Number(m.fingerProtrusionMm);
    const strokeMm = Number(m.fingerHalfStrokeMm) * 2;
    if (!(halfWidthMm > 0) || !(bandMm > 0) || !(strokeMm > 0)) {
      throw new Error('턱 폭·핑거 돌출·행정 중 0 이 있다');
    }
    return { bandMm, strokeMm, halfWidthMm };
  } catch (e) { return e; }
})();

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [0, 1, 2].map((i) => a[i] - b[i]);
/** `Rᵀ · v` — 유저 좌표계 벡터를 TCP 좌표계로. 회전은 직교라 전치가 역이다. */
const toTool = (r, v) => [0, 1, 2].map((i) => r[0][i] * v[0] + r[1][i] * v[1] + r[2][i] * v[2]);
const finite = (a, n) => Array.isArray(a) && a.length >= n
  && a.slice(0, n).every((v) => typeof v === 'number' && Number.isFinite(v));
/** 두 구간의 겹침 길이. 안 겹치면 0. */
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * 원기둥 하나를 집게가 물 자리에 있나.
 *
 * **모델은 상자 하나와 선분 하나다.** 집게 사이 공간을 TCP 좌표계의 상자로 보고
 * (`z ∈ [−band, 0]` · `|x| ≤ stroke/2` · `|y| ≤ halfWidth`), 물건을 축 선분 + 반지름으로 본다.
 * 재는 자리는 **축 위에서 손끝에 제일 가까운 점**이다 — 세워 둔 것을 옆에서 물든 위에서
 * 물든 같은 식이 선다. (축을 tool z 에 투영하는 식으로 짜면 옆에서 무는 자세에서 축이
 * z 에 수직이라 0 으로 나눈다. 그 자세가 지금 우리 자세다 — D122 세워서 꽂는다.)
 *
 * @param {number[]} tcpMmDeg 손끝 `[x, y, z, rx, ry, rz]` — `state.tcpMmDeg` 그대로
 *   (mm·° · `workspace.frame` 좌표계). 6개가 아니면 **차단**한다: 방향을 모르면 집게가
 *   어디를 향하는지 모르므로 통과시킬 근거가 없다 (`SAFETY-RULES.md` §방향이 없으면).
 * @param {{baseMm:number[], lengthMm:number, diaMm:number, axisUnit?:number[]}} obj
 *   물건. `baseMm` 은 **밑동 중심**, `axisUnit` 은 밑동→꼭대기 (기본 `[0,0,1]` = 세움).
 * @param {object} jaw 집게 제원. 기본은 실측 정본(`JAW`).
 * @returns {{reason:string|null, heightMm:number, biteMm:number, lateralMm:number,
 *            sideMm:number, depthMm:number, needOpenMm:number}}
 *   `reason` 이 `null` 이면 물 자리다. **숫자들은 사유와 무관하게 늘 나온다** — 칸 4 가
 *   순위를 매길 때 「왜 떨어졌나」뿐 아니라 「얼마나 아슬아슬했나」를 봐야 하기 때문이다
 *   (`clearance.mjs` 가 「위반 0」과 「여유 1mm」를 가르는 것과 같은 이유).
 *
 *   - `heightMm` 손끝이 물건 밑동에서 몇 mm 위인가 (0 = 밑동 · `lengthMm` = 꼭대기). 띠 밖이면 밖으로 나간다
 *   - `biteMm`   집게 사이 상자가 물건 단면을 덮은 길이 (접근축)
 *   - `lateralMm` 개폐축(X) 편심 · `sideMm` 폭축(Y) 편심 · `depthMm` 접근축(Z) 자리
 *   - `needOpenMm` 축이 사이에 들려면 이만큼 벌려야 한다 = `2·lateral + 지름`
 */
export function judgeGrasp(tcpMmDeg, obj, jaw = JAW) {
  const nil = {
    heightMm: NaN, biteMm: 0, lateralMm: NaN, sideMm: NaN, depthMm: NaN, needOpenMm: NaN,
  };
  if (jaw instanceof Error) return { reason: GRASP.gripperUnreadable, ...nil };
  if (!finite(tcpMmDeg, 6)) return { reason: GRASP.poseUnreadable, ...nil };
  if (!obj || !finite(obj.baseMm, 3) || !(obj.lengthMm > 0) || !(obj.diaMm > 0)) {
    return { reason: GRASP.objectUnreadable, ...nil };
  }
  const raw = obj.axisUnit ?? [0, 0, 1];
  const norm = finite(raw, 3) ? Math.hypot(raw[0], raw[1], raw[2]) : 0;
  if (!(norm > 0)) return { reason: GRASP.objectUnreadable, ...nil };
  const axis = [0, 1, 2].map((i) => raw[i] / norm);

  // ── ① 높이 띠 — 손끝이 밑동에서 축을 따라 몇 mm 위인가.
  // **부호를 살려 둔다.** 음수면 밑동 아래, `lengthMm` 보다 크면 꼭대기 위라 사유가 갈린다.
  const tcpMm = tcpMmDeg.slice(0, 3);
  const heightMm = dot(sub(tcpMm, obj.baseMm), axis);
  const s = Math.max(0, Math.min(obj.lengthMm, heightMm));   // 물건 위의 실제 접점
  const q = [0, 1, 2].map((i) => obj.baseMm[i] + axis[i] * s);

  // ── ② 집게 사이 — 그 접점을 TCP 좌표계로 옮겨 상자와 견준다
  const r = rotFixedXyz(tcpMmDeg[3], tcpMmDeg[4], tcpMmDeg[5]);
  const [lateral, side, depth] = toTool(r, sub(q, tcpMm));
  const lateralMm = Math.abs(lateral);
  const sideMm = Math.abs(side);
  const needOpenMm = 2 * lateralMm + obj.diaMm;

  // ── ③ 물림 — 원기둥이 접근축(툴 Z)으로 집게 사이 구간을 얼마나 덮나.
  //
  // ⛔ **지름으로 재지 않는다.** 2026-08-13 에 실기 참값 자세를 넣어 보고 잡았다 — 그 자세는
  //    **위에서 내려와 잡는 것**이라 축이 접근축과 나란하고, 접근축 방향 두께가 지름(10)이
  //    아니라 **길이(77)** 다. 지름으로 재면 25mm 물린 것을 5mm 라 보고한다. 옆에서 물 때만
  //    맞는 식이었고, 그 한 자세만 보고 짰기 때문에 게이트가 초록인 채로 틀려 있었다.
  //
  // 원기둥을 한 방향으로 투영한 반너비다 (지지함수): 축 성분은 반길이, 직교 성분은 반지름.
  // `au = ±1`(나란함) → 반길이 · `au = 0`(수직) → 반지름. 둘 사이는 매끄럽게 이어진다.
  const aTool = toTool(r, axis);
  const au = Math.max(-1, Math.min(1, aTool[2]));
  const halfSpan = (obj.lengthMm / 2) * Math.abs(au) + (obj.diaMm / 2) * Math.sqrt(1 - au * au);
  const center = [0, 1, 2].map((i) => obj.baseMm[i] + axis[i] * (obj.lengthMm / 2));
  const cz = toTool(r, sub(center, tcpMm))[2];
  const biteMm = overlap(cz - halfSpan, cz + halfSpan, -jaw.bandMm, 0);

  // ── 사유 — **한 자세에 하나만 낸다.** 여럿 내면 칸 4 의 탈락 사유가 표에서 겹친다.
  // 순서는 **되돌리기 비싼 것부터**다: 굵기는 자세를 아무리 고쳐도 안 풀린다.
  let reason = null;
  if (obj.diaMm > jaw.strokeMm) reason = GRASP.tooWide;
  else if (heightMm > obj.lengthMm) reason = GRASP.tooHigh;
  else if (heightMm < 0) reason = GRASP.tooLow;
  else if (needOpenMm > jaw.strokeMm || sideMm > jaw.halfWidthMm) reason = GRASP.offAxis;
  else if (biteMm <= 0) reason = GRASP.notReached;

  return { reason, heightMm, biteMm, lateralMm, sideMm, depthMm: depth, needOpenMm };
}
