// 배치안을 실제 공간에 놓는 계산 — **DOM 도 XR 세션도 안 건드린다.**
//
// 화면(`screens/xr.js`)에서 떼어낸 이유는 하나다: 여기 셋이 틀리면 화면이 **조용히 거짓말**을
// 하는데, `immersive-ar` 은 폰에서만 열려 게이트가 그걸 절대 못 본다. 순수 함수로 빼 두면
// `scripts/check/xr-web-verify.mjs` 가 브라우저 없이 숫자로 판정한다.
//
// 실제로 여기 있는 것들에서 한 번씩 사고가 났다 —
//   · 회전 부호를 뒤집어 맵이 반대로 돌 뻔했다 (2026-08-05, 배포 전 손계산이 잡았다)
//   · 계기가 확대해도 `실물 1:1` 이라 적었다 (2026-08-06 `/감사`)
//   · 벽이 불투명해 1:1 로 들어가면 실제 방을 통째로 가렸다 (2026-08-06)
//   · 벽 히트가 바닥값에 섞여 맵이 바닥 **밑으로** 파묻힐 뻔했다 (2026-08-07 `/감사` F3)
//
// **예외 하나 — `readiness` 는 한글 문구까지 낸다.** 나머지는 순수 기하인데 이것만 카피를
// 갖는다. 상태와 문구를 갈라 두면 "노랑인데 초록 문구" 를 게이트가 못 보기 때문이다.
// 붙여 두면 검증기가 그 조합을 전부 훑는다 — 그 이득이 순수성보다 크다고 봤다 (F12).

import * as THREE from 'three';

/**
 * 히트가 **바닥 쪽인가 벽 쪽인가**. 법선의 Y 성분만 보면 된다.
 *
 * `'floor'` 가 아니라 `'horizontal'` 이라 부르는 이유 — 책상 상판도 여기 들어온다.
 * "수평인 것들 중 어느 게 바닥인가" 는 다른 질문이고, 화면이 **세션 최저면**으로 따로 푼다.
 *
 * 사이(0.35~0.85)는 **일부러 버린다.** 경사로·기울어진 판때기에서 나온 법선으로
 * 맵을 돌리면 조용히 비뚤어진다 — 애매하면 안 쓰는 쪽이 싸다.
 *
 * @param {number} normalY 세계 좌표 법선의 Y (−1~1)
 * @returns {'horizontal'|'vertical'|'other'}
 */
export function classifyHit(normalY) {
  const a = Math.abs(normalY);
  if (a >= 0.85) return 'horizontal';        // 수평에서 ±32° 안
  if (a <= 0.35) return 'vertical';          // 수직에서 ±20° 안
  return 'other';
}

/**
 * 벽 법선 → 맵을 그 벽에 나란히 놓는 **yaw**.
 *
 * 규약: 맵의 `z=0` 쪽 벽(로컬 +Z 법선)이 이 벽과 **같은 쪽을 보게** 하는 각도다.
 * three.js 의 Y 회전은 로컬 (0,0,1) 을 세계 (sin yaw, cos yaw) 로 보내므로 `atan2(x, z)` 다.
 * — `solveCorners` 의 부호와 **방향이 반대라는 점에 주의**. 거기는 방위각을 빼는 쪽이고
 * 여기는 방위각 그 자체다. 검증기가 왕복으로 재서 이 구분을 지킨다.
 *
 * 벽 하나는 yaw 를 **4지선다까지만** 좁힌다 (직사각형이라 90°씩 네 자리가 다 유효하다).
 * 나머지는 사람이 `↺`/`↻` 로 고른다 — 그래서 그 버튼을 지우지 않았다.
 *
 * @param {{x:number, z:number}} n 세계 좌표 법선 (Y 는 안 쓴다)
 * @returns {number|null} 라디안. 바닥 투영이 너무 짧으면 `null` (벽이 아니었다)
 */
export function yawFromWallNormal(n) {
  const len = Math.hypot(n.x, n.z);
  if (!(len > 1e-3)) return null;
  return Math.atan2(n.x / len, n.z / len);
}

/**
 * 아는 맵의 **마주보는 두 모서리**에서 배율과 회전을 한 번에 낸다.
 *
 * 실물 대각선을 우리가 알고 있으니 **맵 자체가 자(尺)**가 된다. 잰 거리와 참값의 비가
 * 곧 이 방·이 세션의 WebXR 축척 오차이고, 그걸 그대로 곱해 지운다.
 *
 * **부호에 주의.** three.js 의 Y 회전은 `atan2(z,x)` 를 그만큼 **깎는다**
 * (x' = x·cos + z·sin, z' = −x·sin + z·cos). 빼는 순서를 뒤집으면 맵이 반대로 돈다.
 *
 * @param {{x:number,z:number}} a 첫 모서리 (배치안 원점에 해당하는 쪽)
 * @param {{x:number,z:number}} b 대각선 반대편 모서리
 * @param {number} widthM  배치안 가로 (m)
 * @param {number} depthM  배치안 세로 (m)
 * @returns {{scale:number, yaw:number, measuredM:number, diagM:number}}
 */
export function solveCorners(a, b, widthM, depthM) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const measuredM = Math.hypot(dx, dz);          // 바닥 평면 거리만 쓴다
  const diagM = Math.hypot(widthM, depthM);
  // 로컬 대각선 방향 — `layout-view.js` 의 Z 가 거울이라 −depth 다
  const yawLocal = Math.atan2(-depthM, widthM);
  return { scale: measuredM / diagM, yaw: yawLocal - Math.atan2(dz, dx), measuredM, diagM };
}

/**
 * 벽이 준 각도를 **사람이 서 있는 쪽**으로 90° 단위로 돌린다.
 *
 * 직사각형은 90° 네 자리가 전부 유효하고 기하학은 어느 것인지 안 알려준다 — 벽 법선도
 * 직선 맞춤도 yaw 를 거기까지만 좁힌다. 그 마지막 한 칸을 사람 손(`↺↻`)에 미루지 않고
 * **사람이 어디 서서 어디를 보는지**로 고른다: 걸어 들어갈 면이 앞에 와야 하기 때문이다.
 *
 * 정밀함은 `yaw` 가, 방향은 `towardYaw` 가 낸다 — 둘을 섞지 않는다.
 *
 * @param {number} yaw       벽·훑기가 낸 각도 (정밀)
 * @param {number} towardYaw 사람을 마주 보게 하는 각도 (거칠지만 방향은 맞다)
 * @returns {number} `yaw + k·90°` 중 `towardYaw` 에 가장 가까운 것
 */
export function snapQuadrant(yaw, towardYaw) {
  const q = Math.PI / 2;
  return yaw + Math.round((towardYaw - yaw) / q) * q;
}

/** 훑기로 인정하는 최소 표본. 이보다 적으면 **그냥 탭**이다 (60fps 에서 ≈0.2초) */
export const SWEEP_MIN = 12;
/** 이보다 짧은 훑기는 각도를 낼 자격이 없다 (m) */
const SWEEP_SPAN_M = 0.4;

/**
 * 훑어서 모은 바닥점들에 **직선을 맞춰** 그 선에 나란한 yaw 를 낸다.
 *
 * 왜 탭보다 나은가 — 점 N개 최소제곱의 기울기 오차는 `σ·√12/(L·√N)` 이고 탭 2회는
 * `σ·√2/L` 이다. 갈리는 지점이 N=6 이라, 2초만 훑어도(≈120표본) 탭을 압도한다.
 * **짧은 기저에서 긴 기저의 정확도를 얻는 것**이 이 방식의 값어치다.
 *
 * 그리고 이게 **잘못됐다고 말해 주는 첫 방법**이다 — 탭은 엉뚱한 데를 찍어도 아무 말이
 * 없지만, 잔차가 크면 손이 떨렸거나 곡선을 그은 것이다.
 *
 * **한계 (F8): 잔차는 제자리 팬을 못 잡는다.** 서서 폰만 돌려도 점들은 여전히 바닥 평면
 * 위 직선이라 잔차가 작게 나온다. 먼 쪽 깊이 오차는 큰데도 그렇다 — 그래서 잔차는
 * *필요조건일 뿐*이고, 부르는 쪽이 **사람이 실제로 이동했는지를 따로 잰다**.
 * 그 값은 여기서 알 수가 없어 반환하지 않는다 (히트점만으로는 눈의 이동을 모른다).
 *
 * @param {Array<{x:number, z:number}>} pts
 * @returns {{yaw:number, residualMm:number, spanM:number}|null} 자격 미달이면 `null`
 */
export function fitLine(pts) {
  if (!pts || pts.length < SWEEP_MIN) return null;
  const n = pts.length;
  let cx = 0; let cz = 0;
  for (const p of pts) { cx += p.x; cz += p.z; }
  cx /= n; cz /= n;
  let sxx = 0; let sxz = 0; let szz = 0;
  for (const p of pts) {
    const dx = p.x - cx; const dz = p.z - cz;
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
  }
  // 분산이 가장 큰 방향 = 선의 방향 (주성분). 최소제곱과 달리 **축을 안 고른다** —
  // z 축에 나란한 벽에서 `z = ax + b` 로 맞추면 기울기가 무한대로 튄다.
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const dx = Math.cos(th); const dz = Math.sin(th);
  let lo = Infinity; let hi = -Infinity; let sq = 0;
  for (const p of pts) {
    const ax = p.x - cx; const az = p.z - cz;
    const along = ax * dx + az * dz;
    const perp = -ax * dz + az * dx;
    lo = Math.min(lo, along); hi = Math.max(hi, along);
    sq += perp * perp;
  }
  const spanM = hi - lo;
  if (!(spanM >= SWEEP_SPAN_M)) return null;
  // 선의 법선으로 바꿔 **벽 법선과 같은 규약**을 태운다 — 각도를 내는 곳은 한 군데뿐이다
  const yaw = yawFromWallNormal({ x: dz, z: -dx });
  if (yaw === null) return null;
  return { yaw, residualMm: Math.sqrt(sq / n) * 1000, spanM };
}

/**
 * 놓아도 되는가 — 그리고 **아니라면 무엇을 하면 되는가.**
 *
 * 예전엔 `WARMUP_MS` 1.5초 타이머였다. 시간은 틀린 것을 재고 있었다: ARCore 를 수렴시키는
 * 건 **시차**(옆으로 움직여 생기는 각도 차)라, 가만히 서서 기다리면 얻는 게 없다.
 *
 * **절대 영구 차단하지 않는다.** 조건을 "0.3m 이동" 으로 두면 삼각대에 얹은 폰은 영영
 * 초록이 안 된다 — 그 고정 카메라 시연이 `xr.js` 머리말에 적힌 용도다. 타이머를 조건으로
 * 바꾸다 **도달 불가 상태**를 만드는 게 이 종류의 전형적 사고라, `GRACE_MS` 뒤엔 노랑인
 * 채로 통과시키고 정확도가 낮을 수 있다고 말한다 (2026-08-07 `/감사` F4).
 *
 * 점수는 세 관문의 **최솟값**이다 — 그래야 차오른 정도와 문구가 언제나 같은 것을 가리킨다.
 * 숫자 셋을 늘어놓지 않는다: 폰을 들고 바닥을 보는 사람은 계기를 읽을 손도 눈도 없다.
 *
 * **문구를 여기서 낸다.** 이 파일은 그 외에는 순수 기하지만, 상태와 문구를 갈라 두면
 * "노랑인데 초록 문구" 같은 어긋남을 게이트가 못 본다 — 붙여 두면 검증기가 잡는다.
 *
 * @param {object} o
 * @param {number}      o.pathM         세션 시작 후 사람이 실제로 움직인 누적 거리 (m)
 * @param {number|null} o.floorSpreadMm 최근 바닥값의 흔들림. `null` 이면 아직 바닥이 없다
 * @param {number}      o.extentM       훑은 히트점들이 퍼진 범위 (m)
 * @param {number}      o.aboveFloorMm  지금 겨냥한 면이 바닥보다 얼마나 높은가
 * @param {number}      o.speedMps      지금 폰이 움직이는 속도
 * @param {number}      o.elapsedMs     평면을 처음 찾은 뒤 흐른 시간
 * @returns {{score:number, state:'gray'|'yellow'|'green'|'red', ok:boolean, say:string}}
 */
export const NEED = { pathM: 0.3, spreadMm: 10, extentM: 1.0 };
export const GRACE_MS = 6000;     // 이 뒤엔 무슨 일이 있어도 놓을 수 있다 (F4)
const DESK_MM = 150;              // 이보다 높으면 바닥이 아니라 상판을 겨냥한 것이다
const FAST_MPS = 1.2;             // 이보다 빠르면 흐려져서 특징점이 끊긴다

export function readiness({
  pathM = 0, floorSpreadMm = null, extentM = 0, aboveFloorMm = 0, speedMps = 0, elapsedMs = 0,
} = {}) {
  // 아직 바닥이 없다. **빨강이 아니라 회색이다** — 실패가 아니라 아직 안 한 것이다.
  if (floorSpreadMm === null) return { score: 0, state: 'gray', ok: false, say: '바닥을 비추세요' };
  // 이 자리는 안 된다. 빨강은 여기에만 쓴다 — 진행률에 쓰면 늘 빨강이라 사람이 무시한다.
  if (aboveFloorMm > DESK_MM) {
    return {
      score: 0,
      state: 'red',
      ok: false,
      say: `바닥보다 ${Math.round(aboveFloorMm / 10)}cm 높습니다. 바닥을 겨냥하세요`,
    };
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const gates = [
    { s: clamp01(pathM / NEED.pathM), say: '폰을 든 채 옆으로 두 걸음' },
    { s: clamp01(extentM / NEED.extentM), say: '바닥을 좌우로 천천히 훑으세요' },
    { s: clamp01((40 - floorSpreadMm) / (40 - NEED.spreadMm)), say: '거의 다 됐어요' },
  ];
  const weakest = gates.reduce((a, b) => (b.s < a.s ? b : a));
  const score = weakest.s;

  if (speedMps > FAST_MPS) return { score, state: 'yellow', ok: false, say: '조금 천천히' };
  if (score >= 1) return { score: 1, state: 'green', ok: true, say: '지금 탭하세요' };
  // 도달 불가 방지 — 조건은 못 채웠지만 시간은 채웠다 (F4)
  if (elapsedMs >= GRACE_MS) {
    return { score, state: 'yellow', ok: true, say: '지금 탭하세요. 정확도가 낮을 수 있습니다' };
  }
  return { score, state: 'yellow', ok: false, say: weakest.say };
}

const pct = (s) => `${s >= 1 ? '+' : ''}${((s - 1) * 100).toFixed(1)}%`;

/**
 * 계기 문자열. **크기는 언제나 배율을 곱한 실제 값**이다 — 배치안 치수를 그대로 적으면
 * 확대·축소한 뒤에도 같은 숫자가 남아 계기가 거짓말을 한다.
 *
 * `zoomed`(손으로 늘림)와 촬영의 `보정`(1:1 을 **맞추려고** 곱한 값)은 다른 것이라 라벨이 갈린다.
 */
export function hudText({ mode, scale, widthM, depthM, yaw = 0, zoomed = false }) {
  const deg = Math.round((yaw * 180) / Math.PI);
  const size = `${(widthM * scale).toFixed(2)}×${(depthM * scale).toFixed(2)}m`;
  if (mode === 'fit') return `1:${(1 / scale).toFixed(1)} 축소 · ${size} · ${deg}°`;
  return `${zoomed ? `1:1 아님 ${pct(scale)}` : '실물 1:1'} · ${size}`
    + `${mode === 'real' && !zoomed ? ` · 보정 ${pct(scale)}` : ''} · ${deg}°`;
}

/**
 * 벽을 유령으로 바꾸고 모서리만 긋는다. **겹치기 전용** — 불투명한 벽 넉 장은 1:1 로
 * 들어가면 실제 방을 통째로 가려, 그건 겹치기가 아니라 VR 이 된다.
 *
 * 벽을 고르는 근거: `layout-view.js` 는 벽 조각을 `root` **직속 메시**로 넣고 문·창·소품은
 * `contents` 로 넣는다. 그래서 슬래브를 뺀 직속 메시가 곧 벽이다.
 *
 * @returns {{walls:number, ghost:THREE.Material, edge:THREE.Material}} 재질은 부르는 쪽이 지운다
 */
export function ghostWalls(root, slab) {
  const ghost = new THREE.MeshStandardMaterial({
    color: 0xf4f4f5, roughness: 0.95, transparent: true, opacity: 0.16,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const edge = new THREE.LineBasicMaterial({ color: 0x8fb6d9, transparent: true, opacity: 0.75 });
  let walls = 0;
  for (const o of [...root.children]) {
    if (!o.isMesh || o === slab) continue;
    o.material = ghost;
    o.castShadow = false;                 // 유령이 그림자를 던지면 방이 어두워진다
    o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry), edge));
    walls += 1;
  }
  return { walls, ghost, edge };
}
