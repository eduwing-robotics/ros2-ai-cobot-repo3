// **여유(clearance)** — 손끝이 제한구역에서 얼마나 떨어져 있나 (mm).
//
// ⛔ **이건 판정이 아니다.** 판정의 정본은 `judge.mjs`(=`safety.check_workspace` 의 사본)이고
//    이 파일은 **시뮬만의 계측값**이다. 그래서 일부러 갈라 뒀다 — `judge.mjs` 에 섞으면
//    「사본이 원본과 같은가」를 재는 대조 게이트가 사본에만 있는 코드를 안게 된다.
//
// 왜 필요한가 — 화면 §화면이 **「정렬된 표 — 최소여유 오름차순」** 을 규약으로 정했고,
// 이상치 승격 기준도 이 값이다. 위반이 0건인 회차에서도 **얼마나 아슬아슬했나**를 이 값만이
// 말한다("위반 0" 은 여유 1mm 와 여유 500mm 를 구분하지 못한다).
//
// 부호 — **양수면 밖(안전), 음수면 안(침범)**. 판정 결과와 어긋나면 둘 중 하나가 틀린 것이라
// 게이트가 대조한다(`sim-batch.mjs`).

/** 상자 = 밑이 열린 사각기둥 {x0≤x≤x1, y0≤y≤y1, z ≤ topZ+여유} — `safety.py:187` 과 같은 모양. */
function boxClearMm(p, b) {
  const [x, y, z] = p;
  const [x0, x1] = b.xMm;
  const [y0, y1] = b.yMm;
  const top = b.topZMm + (b.marginMm ?? 0);
  const dx = Math.max(x0 - x, 0, x - x1);
  const dy = Math.max(y0 - y, 0, y - y1);
  const dz = Math.max(z - top, 0);
  if (dx > 0 || dy > 0 || dz > 0) return Math.hypot(dx, dy, dz);   // 밖 — 구역까지의 거리
  // 안 — 제일 가까운 면으로 빠져나가는 거리를 침투로 본다
  return -Math.min(x - x0, x1 - x, y - y0, y1 - y, top - z);
}

/** 벽 = 선분 + 여유. 관통(원점 반대편)이면 음수. */
function wallClearMm(p, w) {
  const [x, y] = p;
  const [ax, ay] = w.aMm;
  const [bx, by] = w.bMm;
  const m = w.marginMm ?? 0;
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  if (!(L2 > 0)) return null;                       // 망가진 프로필 — 잴 수 없다
  const t = ((x - ax) * dx + (y - ay) * dy) / L2;
  const tc = Math.max(0, Math.min(1, t));
  const dist = Math.hypot(x - (ax + tc * dx), y - (ay + tc * dy));
  const side = (x - ax) * dy - (y - ay) * dx;
  const originSide = (0 - ax) * dy - (0 - ay) * dx;
  // 원점 반대편으로 넘어갔으면(선분 구간 안에서) 이미 지나간 것이다 — 거리를 음수로 준다
  if (t >= 0 && t <= 1 && side * originSide < 0) return -(dist + m);
  return dist - m;
}

/**
 * 손끝 한 점의 여유 — **모든 구역 중 가장 작은 값**. 구역이 없으면 `null`.
 * `tcpMm` 은 `workspace.frame` 좌표계(user1) 밀리미터다 — 베이스가 아니다.
 */
export function clearanceMm(tcpMm, ws) {
  if (!ws || !Array.isArray(tcpMm) || tcpMm.length < 3) return null;
  if (!tcpMm.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  let worst = Infinity;
  for (const b of ws.boxes ?? []) worst = Math.min(worst, boxClearMm(tcpMm, b));
  for (const w of ws.walls ?? []) {
    const c = wallClearMm(tcpMm, w);
    if (c !== null) worst = Math.min(worst, c);
  }
  return Number.isFinite(worst) ? worst : null;
}
