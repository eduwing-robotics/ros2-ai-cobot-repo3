// 배치안 모델 — **AR 과 Dashboard 의 유일한 합의점** (SHARED-CORE.md).
//
// 여기가 갈라지면 두 화면이 다른 배치를 보는데 **양쪽 다 정상으로 보인다.**
// 대시보드가 측정한 배치와 AR 이 겹쳐 보여주는 배치가 다른데 에러가 안 난다 (D17).
//
// **원점은 실험실 바닥의 한 점이다. 로봇 베이스가 아니다** (SR_23).
// 로봇 위치가 배치안의 **변수**라서, 로봇을 원점으로 삼으면 배치를 바꿀 때
// 좌표계가 따라 움직여 A·B 를 비교할 수 없다. 실험 자체가 무의미해진다.
//
// 축·단위 — x·y = 바닥 평면 · **z = 위**(Z-up) · **밀리미터 · 도(°)**

import { REACH_MM } from '../motion/limits.js';
import { distMm } from '../units/units.js';

/** 구역 종류 — **이 셋뿐이다** (`SHARED-CORE.md` §zones). 늘리려면 계약이 먼저다. */
export const ZONE_KINDS = ['keepout', 'charge', 'restricted'];

/** 배치안 하나의 빈 골격. 값은 전부 mm·도다. */
export function emptyLayout(id = 'A', name = '이름 없는 배치안') {
  return {
    id,
    name,
    unit: 'mm-deg',                       // 고정. 다른 값을 쓰지 않는다
    floor: { widthMm: 6000, depthMm: 4000, heightMm: 2700 },
    // **배열이다** — 해체 셀에 이송팔이 따로 서면서 단일 필드로는 못 적는다 (2026-08-04).
    // `role: 'transfer'` 는 **실물이 없는 팔**이라 `model` 을 FR5 로 두지 않는다.
    arms: [{
      id: 'fr5',
      model: 'FR5',
      role: 'process',
      basePosMm: [3000, 2000, 900],       // 바닥 원점 기준. z = 작업대 높이
      baseYawDeg: 0,
      reachMm: REACH_MM,                  // FR5 스펙값 — 편집 대상이 아니다 (`motion/limits.js`)
    }],
    stations: [],                         // { id, name, posMm:[x,y,z], sizeMm:[w,d,h] }
    amrs: [],                             // { id, model, reachMm, dockPosMm, waypointsMm }
    zones: [],                            // { id, kind, name, polygonMm:[[x,y],…] } — §zones
    // **가리키기만 한다.** 시나리오 전문은 `Shared/data/scenario/` 가 들고, 여기 넣으면
    // 배치안을 편집할 때마다 딸려 와 저장이 부푼다 (`LAYOUT-METRICS-CONTRACT.md`).
    // 없으면 프리셋으로 떨어진다 — **A·B 가 같은 id 를 가리켜도 된다** (F8 이 그걸 쓴다).
    scenarioId: null,
    // 자세 보관함도 **가리키기만** 한다 — A·B 가 같은 것을 가리켜야 동작을 견줄 수 있다
    poseSetId: null,
    verified: false,
  };
}

/**
 * 옛 모양을 지금 모양으로. **읽는 길목 한 곳에서만 부른다** (하드 룰 5).
 *
 * 2026-08-04 에 `arm` 하나가 `arms[]` 가 됐다. 저장분이 브라우저에 남아 있으므로
 * 손으로 고치게 하지 않는다 — 읽을 때 조용히 배열로 만든다.
 * **원본을 안 건드린다.** 부른 쪽 객체가 발밑에서 바뀌면 되돌리기가 어긋난다.
 */
export function migrateLayout(L) {
  if (!L || typeof L !== 'object' || Array.isArray(L.arms)) return L;
  if (!L.arm) return L;
  const { arm, ...rest } = L;
  return { ...rest, arms: [{ id: 'fr5', role: 'process', ...arm }] };
}

/**
 * 배치안이 쓸 수 있는 모양인지 본다.
 *
 * **던지지 않고 목록을 돌려준다** — 편집 중에는 잠깐 틀린 상태가 정상이고,
 * 화면이 그때마다 죽으면 못 쓴다. 저장할 때만 막는다.
 */
export function validateLayout(L) {
  const bad = [];
  if (!L || typeof L !== 'object') return ['배치안이 객체가 아니다'];
  if (L.unit !== 'mm-deg') bad.push(`unit 이 'mm-deg' 가 아니다: ${L.unit}`);
  if (!L.floor?.widthMm || !L.floor?.depthMm) bad.push('floor 치수가 없다');
  // **가리키는 것만 본다** — 그 시나리오가 실재하는지는 datasource 몫이다.
  // 여기서 존재까지 보면 배치안 검사가 저장소를 알게 되고 경계가 무너진다.
  if (L.scenarioId != null && typeof L.scenarioId !== 'string') bad.push('scenarioId 가 문자열이 아니다');
  if (L.poseSetId != null && typeof L.poseSetId !== 'string') bad.push('poseSetId 가 문자열이 아니다');
  if (!Array.isArray(L.arms) || L.arms.length === 0) bad.push('arms 가 비었다');
  const seen = new Set();
  for (const a of L.arms ?? []) {
    if (!a.id) bad.push('팔에 id 가 없다');
    else if (seen.has(a.id)) bad.push(`팔 id 가 겹친다: ${a.id}`);
    seen.add(a.id);
    if (!Array.isArray(a.basePosMm) || a.basePosMm.length !== 3) {
      bad.push(`${a.id}: basePosMm 이 [x,y,z] 가 아니다`);
    }
    if (!(a.reachMm > 0)) bad.push(`${a.id}: reachMm 이 없다`);
    // **실물이 있는 팔은 FR5 하나뿐이다.** 같은 모형을 둘 세우면 어느 쪽이 진짜인지
    // 화면이 말하지 못한다 (SR_24 · `SHARED-CORE.md` §arms).
    if (a.role === 'transfer' && a.model === 'FR5') {
      bad.push(`${a.id}: 이송팔은 실물이 없다 — model 을 FR5 로 두지 않는다`);
    }
  }
  for (const s of L.stations ?? []) {
    if (!Array.isArray(s.posMm) || s.posMm.length !== 3) bad.push(`${s.id}: posMm 이 [x,y,z] 가 아니다`);
  }
  for (const a of L.amrs ?? []) {
    if (!Array.isArray(a.waypointsMm)) bad.push(`${a.id}: waypointsMm 이 배열이 아니다`);
  }
  const zseen = new Set();
  for (const z of L.zones ?? []) {
    if (!z.id) bad.push('구역에 id 가 없다');
    else if (zseen.has(z.id)) bad.push(`구역 id 가 겹친다: ${z.id}`);
    zseen.add(z.id);
    // **종류는 셋뿐이다.** 늘리려면 계약(`SHARED-CORE.md` §zones)을 먼저 고친다 —
    // 화면·브리지가 모르는 종류가 들어오면 조용히 안 그려지고 조용히 안 막힌다
    if (!ZONE_KINDS.includes(z.kind)) bad.push(`${z.id}: kind 가 ${ZONE_KINDS.join('·')} 가 아니다: ${z.kind}`);
    if (!Array.isArray(z.polygonMm) || z.polygonMm.length < 3) {
      bad.push(`${z.id}: polygonMm 이 3점 이상이 아니다`);
    } else if (z.polygonMm.some((p) => !Array.isArray(p) || p.length !== 2)) {
      bad.push(`${z.id}: polygonMm 의 점이 [x,y] 가 아니다`);
    }
  }
  return bad;
}

/**
 * 스테이션이 **어느 팔의** 도달 범위 안인가 (UR_24).
 *
 * **배치가 좋은지 판단하는 유일한 기하학적 근거다.** 나머지 지표는 팀원이 낸다.
 * 높이 차이도 센다 — 평면에서만 재면 선반 위 스테이션을 놓친다.
 *
 * 팔이 여럿이면 **가장 여유가 많은 팔**로 판정한다. 하나라도 닿으면 그 스테이션은
 * 일이 되기 때문이다 — 어느 팔인지는 `armId` 로 같이 돌려준다.
 */
export function reachCheck(L) {
  const arms = L.arms ?? [];
  return (L.stations ?? []).map((s) => {
    let best = null;
    for (const a of arms) {
      const d = distMm(a.basePosMm, s.posMm);
      const margin = a.reachMm - d;
      if (!best || margin > best.marginMm) {
        best = { armId: a.id, distMm: Math.round(d), inReach: d <= a.reachMm, marginMm: Math.round(margin) };
      }
    }
    return { id: s.id, name: s.name, armId: null, distMm: 0, inReach: false, marginMm: 0, ...best };
  });
}

/**
 * 폴리라인 위에서 진행률 `u`(0~1) 지점의 좌표. **거리 비례**다 — 점 개수 비례로 하면
 * 짧은 구간과 긴 구간을 같은 시간에 지나 로봇이 구간마다 속도가 달라진다.
 *
 * 점이 없으면 `null`, 하나면 그 점. 범위 밖은 끝으로 자른다 (재생이 안 깨져야 한다).
 */
export function pointAlong(waypointsMm, u) {
  const w = Array.isArray(waypointsMm) ? waypointsMm.filter((p) => Array.isArray(p) && p.length >= 2) : [];
  if (!w.length) return null;
  if (w.length === 1) return [w[0][0], w[0][1]];
  const total = pathLengthMm(w);
  if (total <= 0) return [w[0][0], w[0][1]];
  let want = Math.min(1, Math.max(0, Number(u) || 0)) * total;
  for (let i = 1; i < w.length; i += 1) {
    const [ax, ay] = w[i - 1]; const [bx, by] = w[i];
    const seg = Math.hypot(bx - ax, by - ay);
    if (want <= seg || i === w.length - 1) {
      const t = seg > 0 ? Math.min(1, want / seg) : 1;
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    }
    want -= seg;
  }
  return [w[w.length - 1][0], w[w.length - 1][1]];
}

/**
 * 폴리라인에서 어떤 자리에 **가장 가까운 지점의 진행률**(0~1).
 *
 * 재생은 사건이 부르는 **스테이션 이름**으로 목적지를 말한다(§1.5 — 좌표를 안 든다).
 * 그 이름을 경로 위 진행률로 바꾸는 것이 이 함수다. 경로가 스테이션을 안 지나면
 * 가장 가까운 지점이 나오고, **얼마나 빗나갔는지도 같이 낸다** — 그 값이 크면
 * 화면이 경로 대신 직선으로 가야 한다(안 그러면 로봇이 목적지 옆에서 멈춘다).
 */
export function nearestU(waypointsMm, atMm) {
  const w = Array.isArray(waypointsMm) ? waypointsMm.filter((p) => Array.isArray(p) && p.length >= 2) : [];
  if (!w.length || !Array.isArray(atMm)) return null;
  if (w.length === 1) return { u: 0, offMm: Math.round(Math.hypot(atMm[0] - w[0][0], atMm[1] - w[0][1])) };
  const total = pathLengthMm(w);
  let acc = 0; let best = null;
  for (let i = 1; i < w.length; i += 1) {
    const [ax, ay] = w[i - 1]; const [bx, by] = w[i];
    const seg = Math.hypot(bx - ax, by - ay);
    const c = ptSeg(atMm[0], atMm[1], ax, ay, bx, by);
    if (!best || c.d < best.d) {
      const along = Math.hypot(c.at[0] - ax, c.at[1] - ay);
      best = { d: c.d, u: total > 0 ? (acc + along) / total : 0 };
    }
    acc += seg;
  }
  return { u: best.u, offMm: Math.round(best.d) };
}

/** AMR 한 대의 경로 길이 (mm). 이동거리 지표의 근거다. */
export function pathLengthMm(waypointsMm) {
  let sum = 0;
  for (let i = 1; i < waypointsMm.length; i += 1) {
    const [ax, ay] = waypointsMm[i - 1];
    const [bx, by] = waypointsMm[i];
    sum += Math.hypot(bx - ax, by - ay);
  }
  return Math.round(sum);
}

/**
 * AMR 두 대의 경로가 어디서 겹치나 — **교착이 나는 자리다.**
 *
 * 좁은 실험실에서 2대는 서로 막고, 그게 시연 당일 가장 잘 깨지는 지점이다
 * (`rnd/AMR-TWIN-DIRECTION-2026-07-30.md` §4). 배치 단계에서 미리 보여준다.
 *
 * 선분 교차를 정확히 풀지 않고 **표본점 사이 거리**로 근사한다 —
 * 경로가 만나지 않아도 **가까이 지나가면 이미 위험**하기 때문이다.
 */
/** 점 → 다각형까지의 거리(mm)와 안팎. 안이면 `dMm` 이 음수다. */
function signedDistToPoly(px, py, poly) {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    // 홀짝 규칙 — 볼록이 아니어도 맞는다
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    // 변까지의 거리 (선분에 사영)
    const dx = xj - xi;
    const dy = yj - yi;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(px - (xi + t * dx), py - (yi + t * dy)));
  }
  return inside ? -best : best;
}

/**
 * AMR 이 지금 어느 구역에 걸쳐 있나 — **실물이 그 공간에 들어왔는지 판정하는 곳.**
 *
 * **로봇은 점이 아니다.** 중심으로만 보면 몸통이 반쯤 들어간 상태가 "밖"으로 읽힌다.
 * 그래서 `구역까지의 거리 < 반경` 이면 걸친 것으로 본다.
 *
 * **들어가는 문턱과 나오는 문턱을 다르게 둔다.** pose 는 1Hz 이고 떨려서, 같은 문턱이면
 * 경계에서 진입/이탈이 깜빡인다 — 경보가 깜빡이면 사람이 경보를 끈다.
 * 이미 안에 있던 구역(`wasIn`)은 **여유만큼 더 나가야** 벗어난 것으로 친다.
 *
 * ⚠ `posMm` 은 **실험실 바닥 원점** 기준이다. 로봇 pose 는 SLAM 맵 원점 기준이므로
 * `mapToLab` 을 거쳐 들어와야 한다 — 변환은 **브리지 경계 한 곳**에서만
 * (`TB-CONTRACT.md` §미래 접점 ③). 여기서 다시 변환하지 않는다 (하드 룰 5).
 *
 * @param wasIn 직전 판정에서 걸쳐 있던 구역 id 들 — 이탈 문턱을 여기에 적용한다
 */
export function zoneHits(L, posMm, { radiusMm = 0, exitMarginMm = 60, wasIn = [] } = {}) {
  const [px, py] = posMm;
  const out = [];
  for (const z of L.zones ?? []) {
    if (!Array.isArray(z.polygonMm) || z.polygonMm.length < 3) continue;
    const d = signedDistToPoly(px, py, z.polygonMm);
    const limit = radiusMm + (wasIn.includes(z.id) ? exitMarginMm : 0);
    if (d < limit) out.push({ id: z.id, kind: z.kind, name: z.name, dMm: Math.round(d) });
  }
  return out;
}

/** 점에서 선분까지 — 가장 가까운 점과 그 거리. 선분이 한 점이면 점 거리다. */
function ptSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const cx = ax + dx * t; const cy = ay + dy * t;
  return { d: Math.hypot(px - cx, py - cy), at: [cx, cy] };
}

/**
 * 두 선분이 얼마나 가까운가. **엇갈리면 거리 0 이고 그 교점**을 낸다.
 *
 * 2026-08-04 까지는 **꼭짓점끼리만** 비교했다. 그래서 가운데서 대각으로 완전히 교차하는
 * 두 경로가 **검출 0건**이었다 (꼭짓점 사이가 5657mm 라서). 교착이 날 자리를 미리 보여주는
 * 것이 이 함수의 목적인데 정작 교차를 못 잡았다.
 */
function segSeg(p1, p2, q1, q2) {
  const r = [p2[0] - p1[0], p2[1] - p1[1]];
  const t = [q2[0] - q1[0], q2[1] - q1[1]];
  const den = r[0] * t[1] - r[1] * t[0];
  if (Math.abs(den) > 1e-9) {
    const w = [q1[0] - p1[0], q1[1] - p1[1]];
    const u = (w[0] * t[1] - w[1] * t[0]) / den;
    const v = (w[0] * r[1] - w[1] * r[0]) / den;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      return { d: 0, at: [p1[0] + r[0] * u, p1[1] + r[1] * u] };
    }
  }
  // 안 엇갈리면 **네 끝점 중 가장 가까운 것**이 최단이다 (평행·짧게 스치는 경우 포함)
  let best = null;
  for (const [px, py, a, b2] of [
    [p1[0], p1[1], q1, q2], [p2[0], p2[1], q1, q2],
    [q1[0], q1[1], p1, p2], [q2[0], q2[1], p1, p2],
  ]) {
    const c = ptSeg(px, py, a[0], a[1], b2[0], b2[1]);
    // 두 점의 **가운데**를 자리로 낸다 — 한쪽 경로 위가 아니라 사이가 위험한 지점이다
    const mid = [(px + c.at[0]) / 2, (py + c.at[1]) / 2];
    if (!best || c.d < best.d) best = { d: c.d, at: mid };
  }
  return best;
}

/** 폴리라인을 선분 목록으로. **점이 하나면 길이 0 짜리 선분** — 그래도 비교 대상이다. */
function segsOf(pts) {
  const w = Array.isArray(pts) ? pts.filter((p) => Array.isArray(p) && p.length >= 2) : [];
  if (w.length === 0) return [];
  if (w.length === 1) return [[w[0], w[0]]];
  const out = [];
  for (let i = 1; i < w.length; i += 1) out.push([w[i - 1], w[i]]);
  return out;
}

/**
 * AMR 경로가 서로 가까워지는 자리 — **교착이 나는 곳**이다.
 *
 * `gapMm === 0` 이면 실제로 엇갈린다. 그보다 크면 스치는 거리다.
 * **가까운 것들은 한 점으로 묶는다** — 선분 하나가 다른 선분과 길게 나란하면 표시가
 * 수십 개 쏟아져 바닥이 구슬밭이 된다.
 */
export function crossings(L, nearMm = 600) {
  const hits = [];
  const amrs = L.amrs ?? [];
  for (let i = 0; i < amrs.length; i += 1) {
    for (let j = i + 1; j < amrs.length; j += 1) {
      for (const [p1, p2] of segsOf(amrs[i].waypointsMm)) {
        for (const [q1, q2] of segsOf(amrs[j].waypointsMm)) {
          const c = segSeg(p1, p2, q1, q2);
          if (c && c.d <= nearMm) {
            hits.push({ a: amrs[i].id, b: amrs[j].id, atMm: c.at, gapMm: Math.round(c.d) });
          }
        }
      }
    }
  }
  // 묶기 — 같은 쌍이고 자리가 `nearMm` 안이면 **더 가까운 쪽만** 남긴다
  const out = [];
  for (const h of hits.sort((x, y) => x.gapMm - y.gapMm)) {
    const near = out.some((o) => o.a === h.a && o.b === h.b
      && Math.hypot(o.atMm[0] - h.atMm[0], o.atMm[1] - h.atMm[1]) <= nearMm);
    if (!near) out.push({ ...h, atMm: [Math.round(h.atMm[0]), Math.round(h.atMm[1])] });
  }
  return out;
}
