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
// ⭐ 센터링 (2026-09-07 18:05 실기 · run 175519) — 대강값이 80mm 틀리면(팔이 폰 시야를 가림) 1패스 두 눈이 표적을 카메라 축에서 52~62mm 벗어나 보고,
//    그 평균은 벽 시차·껍질 비대칭으로 12mm 흔들렸다(같은 날 45mm 벗어난 쌍은 2.3mm 일치). 그래서 축에서 CENTER_MAX_MM 넘게 벗어난 눈으로 낸 평균은
//    **자리를 옮기는 데만** 쓰고 두 패스 일치 비교엔 안 넣는다. 그만큼 패스가 하나 더 들 수 있어 상한은 3
export const CENTER_MAX_MM = 50;
export const MAX_PASSES = 3;
export const TARGETS = ['carrier', 'basketFloor', 'carrierInBasket'];

// 총알이 스테레오 그림자에 가리면 같은 프레임만 반복하지 않는다. 225mm는 D435 Min-Z
// 195mm보다 30mm 높고, ±90°는 표적을 그대로 보며 카메라 광축 둘레 방향만 바꾼다.
// ponytail: 네 후보가 천장이다. 더 많은 탐색이 필요하면 실기 성공률을 재고 후보를 늘린다.
const BULLET_SEARCH_VIEW_SPECS = Object.freeze([
  Object.freeze({ distMm: 250, yawOffsetDeg: 0 }),
  Object.freeze({ distMm: 225, yawOffsetDeg: 0 }),
  Object.freeze({ distMm: 250, yawOffsetDeg: 90 }),
  Object.freeze({ distMm: 250, yawOffsetDeg: -90 }),
]);

export function bulletSearchSpecs(baseRzDeg) {
  if (!Number.isFinite(baseRzDeg)) return [];
  return BULLET_SEARCH_VIEW_SPECS.map((spec, index) => ({
    ...spec,
    index: index + 1,
    total: BULLET_SEARCH_VIEW_SPECS.length,
    rzDeg: baseRzDeg + spec.yawOffsetDeg,
  }));
}

/** 옮기는 거치대의 총알 위치 증거. 기대 수를 못 채우면 빈 배열도 안전 통과가 아니다(D206). */
export function bulletEvidence(result, expected) {
  const need = Number.isInteger(expected) && expected >= 0 ? expected : null;
  const detected = Array.isArray(result?.bulletsUser1Mm) ? result.bulletsUser1Mm.length : null;
  if (need == null) return { ok: false, expected: null, detected, why: '거치대의 총알 적재 수를 몰라 하강·닫기 금지' };
  if (detected == null) return { ok: false, expected: need, detected: null, why: `총알 검출 결과가 없어 하강·닫기 금지 (기대 ${need}개)` };
  if (detected < need) return { ok: false, expected: need, detected, why: `총알 ${detected}/${need}개 검출 — 위치 미확인이라 하강·닫기 금지` };
  return { ok: true, expected: need, detected, why: `총알 ${detected}/${need}개 위치 확인` };
}

/** 근접 재관측 표적 — xy는 방금 깊이가 본 중심, z는 대강 검출의 거치대 윗면을 보존한다(D211). */
export function closerObservationTarget(coarse, view) {
  const seen = view?.user1Mm; const zTop = coarse?.user1Mm?.[2];
  if (!Array.isArray(seen) || seen.length < 2 || !seen.slice(0, 2).every(Number.isFinite) || !Number.isFinite(zTop)) return null;
  return [seen[0], seen[1], zTop];
}

/** 첫 폴링 전 fallback을 잡았어도, 이어 찾을 때 신선한 글로벌캠 값이 생기면 그것으로 승격한다. */
export function preferLiveCoarse(current, observed) {
  if (!current) return observed ?? null;
  const fallback = current.source === 'truth-0831' || current.source === 'input';
  const live = typeof observed?.source === 'string' && observed.source.startsWith('color');
  return fallback && live ? observed : current;
}

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
  // 표적이 카메라 축에서 얼마나 벗어나 보였나(두 눈 중 큰 쪽 · mm) — `camMm` 이 없으면(옛 기록·목업) 모른다(null = 중앙으로 친다)
  const off = [a, b].map((v) => (Array.isArray(v.camMm) && v.camMm.length >= 2 ? Math.hypot(v.camMm[0], v.camMm[1]) : null));
  const offCenterMm = off.every((v) => v == null) ? null : Math.round(Math.max(...off.filter((v) => v != null)) * 10) / 10;
  // 두 눈 모두 총알 필드를 냈을 때만 증거로 보존한다. 합쳐서 개수를 부풀리지 않고 더 완전한 한 눈의 실측 위치를 쓴다.
  const bulletSets = [a.bulletsUser1Mm, b.bulletsUser1Mm];
  const bulletsUser1Mm = bulletSets.every(Array.isArray)
    ? bulletSets.reduce((best, cur) => (cur.length > best.length ? cur : best), bulletSets[0]).map((p2) => p2.slice())
    : null;
  return { user1Mm: p.map((v) => Math.round(v * 100) / 100), yawDeg, halfDiffMm: Math.round(halfDiffMm * 100) / 100, yawDiffDeg, rzGapDeg, offCenterMm, bulletsUser1Mm, n: 2 };
}

/**
 * 융합 결과의 판정 — 「집을 자리로 써도 되나 · 한 번 더 재나 · 멈추나」.
 * `prevFused` 는 앞 패스의 융합값(자리를 그 평균으로 옮겨 다시 잰 것). 거울 쌍이 180° 에서 2° 넘게 어긋나면 상쇄 전제가 깨진 것이라 **평균을 믿지 않는다**.
 */
export function judge(fused, pass = 1, { prevFused = null, maxHalfDiffMm = HALF_DIFF_MAX_MM, agreeMm = PASS_AGREE_MM, maxPasses = MAX_PASSES, centerMaxMm = CENTER_MAX_MM } = {}) {
  if (!fused) return { ok: false, retry: false, why: '융합할 쌍이 없어요 — 스캔 둘이 다 있어야 해요' };
  if (fused.rzGapDeg > 2) return { ok: false, retry: false, why: `두 자세가 180° 거울이 아니에요 (차 ${fused.rzGapDeg.toFixed(1)}°) — 평균이 편향을 못 지워요` };
  if (fused.halfDiffMm <= maxHalfDiffMm) return { ok: true, retry: false, why: `편향 ${fused.halfDiffMm}mm ≤ ${maxHalfDiffMm} — 작아서 한 패스로 충분해요` };
  const centered = (f) => !(Number.isFinite(f?.offCenterMm) && f.offCenterMm > centerMaxMm);
  if (!centered(fused)) {
    // 축에서 벗어나 본 평균은 «어디쯤»만 말한다 — 비교엔 안 쓰고 그 자리로 옮겨 다시 본다
    if (pass < maxPasses) return { ok: false, retry: true, centering: true, why: `표적이 카메라 축에서 ${fused.offCenterMm}mm 벗어나 보였어요 (> ${centerMaxMm}) — 평균 자리로 옮겨 중앙에서 다시 봐요 (${pass + 1}/${maxPasses})` };
    return { ok: false, retry: false, why: `표적이 카메라 축에서 ${fused.offCenterMm}mm 벗어난 채 패스가 끝났어요 — 처음부터(팔을 거치대 위에서 치우고 「다시 찾기」)` };
  }
  if (prevFused?.user1Mm && centered(prevFused)) {
    const drift = Math.hypot(fused.user1Mm[0] - prevFused.user1Mm[0], fused.user1Mm[1] - prevFused.user1Mm[1]);
    if (drift <= agreeMm) return { ok: true, retry: false, driftMm: drift, why: `편향 ${fused.halfDiffMm}mm 를 지운 평균이 두 패스에서 ${drift.toFixed(2)}mm 일치 — 고정 편향이라 지워졌어요` };
    return { ok: false, retry: false, driftMm: drift, why: `두 패스의 평균이 ${drift.toFixed(1)}mm 갈려요 (> ${agreeMm}) — 자세 따라 변하는 오차예요. 집지 않아요 (hand-eye 회전 캘리브가 필요)` };
  }
  if (pass < maxPasses) return { ok: false, retry: true, why: `편향 ${fused.halfDiffMm}mm > ${maxHalfDiffMm} — 평균 자리로 옮겨 한 번 더 재서 고정인지 봐요 (${pass + 1}/${maxPasses})` };
  return { ok: false, retry: false, why: `편향 ${fused.halfDiffMm}mm > ${maxHalfDiffMm} 인데 비교할 앞 패스가 없어요 — 처음부터` };
}

/**
 * 한 눈 판정 (2026-09-07 · 계약 §hand-eye `singleView`) — 프로필이 「거울 쌍 실측으로 tMm xy 를 고쳤다」고 말하면 스캔 A 하나가 곧 결과다.
 * 근거: 14눈에서 눈−평균이 툴 좌표계 고정값(+15.2, −13.5)이었고 고친 뒤 잔차 평균 1.9·최대 3.4mm. 프로필에 표시가 없으면 null — 두 눈으로 간다.
 */
export function singleViewFused(view, handEye) {
  if (!handEye?.singleView || !view?.user1Mm) return null;
  const res = Number.isFinite(handEye.residualMm) ? handEye.residualMm : null;
  return { user1Mm: view.user1Mm.slice(), yawDeg: view.yawDeg ?? null, halfDiffMm: null, yawDiffDeg: null, rzGapDeg: null, bulletsUser1Mm: Array.isArray(view.bulletsUser1Mm) ? view.bulletsUser1Mm.map((p) => p.slice()) : null,
    offCenterMm: Array.isArray(view.camMm) ? Math.round(Math.hypot(view.camMm[0], view.camMm[1]) * 10) / 10 : null, n: 1, ok: true, retry: false,
    why: `hand-eye 가 보정돼 있어요(${handEye.biasCorrectedAt ?? '날짜 없음'}${res != null ? ` · 한 눈 잔차 ${res}mm` : ''}) — 한 번 보고 끝` };
}
