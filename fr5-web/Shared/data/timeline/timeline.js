// 시간축 — **배치안은 공간, series 는 시간** (`SHARED-CORE.md` §1.5).
//
// 여기는 **순수 함수만** 있다. 렌더링·React·전역 상태를 안 쓴다. `Shared/view3d/` 가
// 받아서 그리고, 비교 화면이 받아서 재고, 나중에 기록 되감기가 같은 함수를 쓴다.
//
// **결정적이어야 한다** — 같은 `t` 를 두 번 물으면 같은 값이다. 이게 성립해야
// 되감기와 "동작 A·B 를 같은 시각에 나란히" (F10) 가 성립한다. `Date.now()` 를 쓰지 않는다.
//
// **좌표를 여기서 풀지 않는다.** series 는 스테이션 **id** 만 들고, 그 id 가 어디인지는
// 배치안이 안다. 좌표를 series 에 박으면 같은 series 를 배치안 A·B 에 태울 수 없다 — F8 이 무너진다.

/** 아무 일도 없을 때의 상태. **던지는 대신 이걸 돌려준다** — 편집 중 빈 상태가 정상이다. */
const EMPTY = Object.freeze({
  tSec: 0, cycleSec: 0, u: 0, event: null, from: null, to: null, k: 0, armAt: null,
  pose: null, carry: null,
  warheadStage: 0, empty: true, amr: {},
});

/** `tSec` 이 숫자인 항목만 남기고 시각순으로 세운다. **입력 순서를 믿지 않는다.** */
function ordered(series) {
  if (!Array.isArray(series)) return [];
  return series
    .filter((e) => e && Number.isFinite(Number(e.tSec)))
    .map((e) => ({ ...e, tSec: Number(e.tSec) }))
    .sort((a, b) => a.tSec - b.tSec);
}

/** 한 사이클의 길이(초). 마지막 사건의 시각이다. 비면 0. */
export function cycleSecOf(series) {
  const ev = ordered(series);
  return ev.length ? ev[ev.length - 1].tSec : 0;
}

/**
 * **무슨 작업인가**의 지문 — 사건·스테이션·단계의 순서만 남긴다 (F10 · 2026-08-13 신설).
 *
 * ⛔ **시각과 자세를 일부러 뺀다.** 그 둘이 동작마다 달라지는 것이고, 그래서 지문이 같으면
 *    **다른 움직임으로 같은 일을 한 것**이다. 시각을 넣으면 모든 동작이 서로 다른 작업이 된다.
 *
 * 왜 필요한가 — 골 `GOAL-dash-motion-compare` §blocked: *"궤적 두 벌의 작업이 실제로 같은지
 * 보증할 방법이 없으면 멈춘다 — 다른 작업의 시퀀스 타임을 비교하면 숫자가 거짓말을 한다."*
 * 화면이 「몇 % 빨라졌다」를 말하려면 분모가 같아야 하고, **그 같음을 사람 눈이 아니라
 * 이 함수가 보증한다.**
 */
export function taskSignatureOf(series) {
  return ordered(series)
    .map((e) => `${e.event ?? ''}@${e.station ?? ''}#${Number.isFinite(Number(e.stage)) ? e.stage : ''}`)
    .join('|');
}

/**
 * `t` 초일 때 무슨 상태인가.
 *
 * `from`→`to` 를 `k`(0~1) 만큼 간 지점에 작업물이 있다. **좌표가 아니라 스테이션 id** 다.
 * `warheadStage` 는 `stage` 를 적은 **마지막 사건의 값**이 이어진다 — 매 사건마다
 * 다시 적게 하면 하나만 빠뜨려도 탄두가 되살아난다.
 */
/**
 * AMR 마다 `{ from, to, k }`. **작업물과 별개로 흐른다** — AMR 은 자기 사건 사이에서만 움직이고,
 * 사건이 없는 동안은 마지막 자리에 서 있다.
 */
function amrAt(ev, t) {
  const byId = new Map();
  for (const e of ev) {
    if (!e.amr || !e.amrAt) continue;
    if (!byId.has(e.amr)) byId.set(e.amr, []);
    byId.get(e.amr).push(e);
  }
  const out = {};
  for (const [id, list] of byId) {
    let i = 0;
    while (i + 1 < list.length && list[i + 1].tSec <= t) i += 1;
    const cur = list[i]; const next = list[i + 1];
    const span = next ? next.tSec - cur.tSec : 0;
    // 첫 사건 **전에는 도킹 자리에서 출발한다** — `from` 이 비면 화면이 도킹 좌표를 쓴다.
    // 여기서 `k` 를 0 으로 고정하면 AMR 이 시각 0 에 이미 팔레트에 서 있다 (실렌더가 잡았다).
    if (t < cur.tSec) {
      out[id] = { from: null, to: cur.amrAt, k: cur.tSec > 0 ? t / cur.tSec : 0 };
      continue;
    }
    out[id] = { from: cur.amrAt, to: next?.amrAt ?? cur.amrAt, k: span > 0 ? (t - cur.tSec) / span : 1 };
  }
  return out;
}

export function stateAt(series, tSec) {
  const ev = ordered(series);
  if (!ev.length) return EMPTY;

  const cycleSec = ev[ev.length - 1].tSec;
  // 범위 밖은 **자른다.** 재생이 끝을 넘어가도 화면이 깨지지 않아야 한다
  const t = Math.min(Math.max(Number(tSec) || 0, 0), cycleSec);

  let i = 0;
  while (i + 1 < ev.length && ev[i + 1].tSec <= t) i += 1;
  const cur = ev[i];
  const next = ev[i + 1];

  // 같은 시각에 사건이 둘이면 간격이 0 이다 — 나누지 않고 도착한 것으로 본다
  const span = next ? next.tSec - cur.tSec : 0;
  const k = span > 0 ? (t - cur.tSec) / span : 1;

  let warheadStage = 0;
  for (let j = 0; j <= i; j += 1) {
    if (Number.isFinite(Number(ev[j].stage))) warheadStage = Number(ev[j].stage);
  }

  return {
    tSec: t,
    cycleSec,
    u: cycleSec > 0 ? t / cycleSec : 0,
    event: cur.event ?? null,
    from: cur.station ?? null,
    to: next?.station ?? cur.station ?? null,
    k,
    // **팔이 보는 곳은 작업물 자리와 다를 수 있다** — 신관을 가지러 갈 때 탄두는 안 움직인다
    armAt: cur.armAt ?? null,
    // **사건이 자기 자세를 든다.** 사건 이름을 자유롭게 지으면 전역 표가 그 이름을 모르므로
    // (팔이 조용히 대기 자세로 선다), 무엇을 할지는 사건이 직접 말해야 한다 (2026-08-04).
    // 여기는 **이름만 실어 나른다** — 그 이름이 어떤 각인지는 자세 보관함이 안다 (§1.6).
    pose: cur.pose ?? null,
    carry: cur.carry ?? null,
    // AMR 은 **자기 사건만** 본다 — 작업물과 다른 시각에 다른 곳으로 간다
    amr: amrAt(ev, t),
    warheadStage,
    empty: false,
  };
}
