// 2단 조준 — **글로벌캠 대강 → 손목 뎁스 정밀(거울 쌍) → 융합** 의 상태와 판정 (2026-09-07 · D192 · `plan/LAB-STEP-TEST-PLAN.md` Phase 0-3).
//
// 좌표를 만들지 않는다 — 스캔이 낸 user1 값을 **평균·판정**만 한다. 판정선의 근거:
//   · 거울 쌍의 **평균**은 편향이 툴 프레임에 고정이면 그 크기와 무관하게 진값이다. 쌍의 차/2(`halfDiffMm`)는 **편향의 크기**라
//     다시 중심을 잡아도 줄지 않는다 — 그래서 게이트가 아니라 진단값이다(2026-09-07 실렌더: 목업 편향 14.4 가 두 패스 그대로 14.4)
//   · 통과 = ① 정확한 거울(rz 차 180±2°) 그리고 ② 편향이 **작다**(차/2 ≤ `HALF_DIFF_MAX_MM`) **또는** 두 패스의 평균이 `PASS_AGREE_MM` 안에서 **일치**
//     (자리를 옮겨 다시 재도 같은 답 = 편향이 자세와 무관한 고정 편향이라는 증거 · 랩 킬실험 (A−B) 불변성과 같은 논리)
//   · `PASS_AGREE_MM` 3 — 손가락↔바구니 테두리 여유 4.5mm(`load-steps.js` ⑨) 안에서 융합 오차가 놀아야 한다
//   · 요각은 거울 쌍이 **못 지운다**(카메라 롤 오차는 rz 와 무관하게 더해진다) — 두 값의 원형 평균만 내고, 상수 보정은 Phase 1 각도기 대조가 준다
export const HALF_DIFF_MAX_MM = 3;
export const PASS_AGREE_MM = 3;
export const MAX_PASSES = 2;
export const TARGETS = ['carrier', 'basketFloor', 'carrierInBasket'];

/** 180° 대칭 물체의 요각을 `[−90, 90)` 로 접는다 */
export const foldYaw = (d) => ((((d + 90) % 180) + 180) % 180) - 90;

/** 접힌 요각 둘의 원형 평균(주기 180). −89 와 89 의 평균은 0 이 아니라 ±90 이다 */
export function meanYaw180(a, b) {
  if (!Number.isFinite(a)) return Number.isFinite(b) ? foldYaw(b) : null;
  if (!Number.isFinite(b)) return foldYaw(a);
  const r = Math.PI / 90;                 // 180° 주기 → 2π
  const x = Math.cos(a * r) + Math.cos(b * r); const y = Math.sin(a * r) + Math.sin(b * r);
  if (Math.hypot(x, y) < 1e-9) return foldYaw(a);   // 정확히 90° 갈리면 정의 불가 — 첫 값
  return foldYaw(Math.atan2(y, x) / r);
}

export const newAim = (target = 'carrier') => ({ target, coarse: null, views: [], fused: null, pass: 1, why: null });

/**
 * 거울 쌍 융합. `a`·`b` 는 `/scan` 의 `view`(`user1Mm`·`yawDeg`·`rzDeg`).
 * @returns {{user1Mm:number[], yawDeg:number|null, halfDiffMm:number, yawDiffDeg:number|null, rzGapDeg:number, n:2}|null}
 */
export function fusePair(a, b) {
  if (!a?.user1Mm || !b?.user1Mm) return null;
  const p = [0, 1, 2].map((i) => (a.user1Mm[i] + b.user1Mm[i]) / 2);
  const halfDiffMm = Math.hypot(a.user1Mm[0] - b.user1Mm[0], a.user1Mm[1] - b.user1Mm[1]) / 2;
  const yawDeg = meanYaw180(a.yawDeg, b.yawDeg);
  const yawDiffDeg = Number.isFinite(a.yawDeg) && Number.isFinite(b.yawDeg) ? Math.abs(foldYaw(a.yawDeg - b.yawDeg)) : null;
  // 180° 에서 얼마나 벗어났나 — 0 이면 정확한 거울, 180 이면 같은 자세(거울이 아니다)
  const rzGapDeg = Math.abs(180 - Math.abs((((a.rzDeg - b.rzDeg) % 360) + 540) % 360 - 180));
  return { user1Mm: p.map((v) => Math.round(v * 100) / 100), yawDeg, halfDiffMm: Math.round(halfDiffMm * 100) / 100, yawDiffDeg, rzGapDeg, n: 2 };
}

/**
 * 융합 결과의 판정 — 「집을 자리로 써도 되나 · 한 번 더 재나 · 멈추나」.
 * `prevFused` 는 앞 패스의 융합값(자리를 그 평균으로 옮겨 다시 잰 것). 거울 쌍이 180° 에서 2° 넘게 어긋나면 상쇄 전제가 깨진 것이라 **평균을 믿지 않는다**.
 */
export function judge(fused, pass = 1, { prevFused = null, maxHalfDiffMm = HALF_DIFF_MAX_MM, agreeMm = PASS_AGREE_MM, maxPasses = MAX_PASSES } = {}) {
  if (!fused) return { ok: false, retry: false, why: '융합할 쌍이 없어요 — 스캔 둘이 다 있어야 해요' };
  if (fused.rzGapDeg > 2) return { ok: false, retry: false, why: `두 자세가 180° 거울이 아니에요 (차 ${fused.rzGapDeg.toFixed(1)}°) — 평균이 편향을 못 지워요` };
  if (fused.halfDiffMm <= maxHalfDiffMm) return { ok: true, retry: false, why: `편향 ${fused.halfDiffMm}mm ≤ ${maxHalfDiffMm} — 작아서 한 패스로 충분해요` };
  if (prevFused?.user1Mm) {
    const drift = Math.hypot(fused.user1Mm[0] - prevFused.user1Mm[0], fused.user1Mm[1] - prevFused.user1Mm[1]);
    if (drift <= agreeMm) return { ok: true, retry: false, driftMm: drift, why: `편향 ${fused.halfDiffMm}mm 를 지운 평균이 두 패스에서 ${drift.toFixed(2)}mm 일치 — 고정 편향이라 지워졌어요` };
    return { ok: false, retry: false, driftMm: drift, why: `두 패스의 평균이 ${drift.toFixed(1)}mm 갈려요 (> ${agreeMm}) — 자세 따라 변하는 오차예요. 집지 않아요 (hand-eye 회전 캘리브가 필요)` };
  }
  if (pass < maxPasses) return { ok: false, retry: true, why: `편향 ${fused.halfDiffMm}mm > ${maxHalfDiffMm} — 평균 자리로 옮겨 한 번 더 재서 고정인지 봐요 (${pass + 1}/${maxPasses})` };
  return { ok: false, retry: false, why: `편향 ${fused.halfDiffMm}mm > ${maxHalfDiffMm} 인데 비교할 앞 패스가 없어요 — 처음부터` };
}
