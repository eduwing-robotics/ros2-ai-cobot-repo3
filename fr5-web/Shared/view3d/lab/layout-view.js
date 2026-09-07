// 배치안 하나를 3D 로 그린다 — 대시보드 메인뷰의 본체.
//
// **방 껍데기는 에셋이 아니라 배치안에서 나온다** (`floor` 치수).
// 배치를 바꾸면 공간도 따라 바뀌어야 하기 때문이다 (`rnd/AMR-TWIN-DIRECTION` §5).
//
// **React 를 쓰지 않는다.** 좌표 변환은 `Shared/data/units` 한 곳만 쓴다 (하드 룰 5).

import * as THREE from 'three';
import { loadBurger, mountBurgerYUpXForward } from '../burger.js';
import { mm } from '../../data/units/units.js';
import { reachCheck, crossings, pointAlong, nearestU } from '../../data/layout/schema.js';
import { createPathGizmo } from './path-gizmo.js';
import { makeReachZone } from '../reach-zone.js';
import { assembleProps, PROPS } from '../parts.js';
import { AMR_MM } from '../../data/layout/catalog.js';

/**
 * 실물 TurtleBot3 Burger 메시 — **한 번만 받아서 돌려 쓴다.**
 *
 * 물건 하나를 옮길 때마다 이 뷰가 통째로 다시 만들어진다 (`LayoutView.jsx` §②).
 * 그때마다 750KB 를 다시 받으면 편집이 멈춘다 — FR5 팔의 `getArm` 과 같은 규약이다.
 *
 * 자산은 `Shared/assets/turtlebot3_burger/` 에 있고 세 화면이 같은 `publicDir` 을 쓴다
 * (Dashboard·AR·FR5 의 `vite.config.js`). 출처·라이선스·굽는 법은 그 폴더의 `ATTRIBUTION.md`.
 *
 * **조용히 실패하지 않는다** (D15·D18) — 못 받으면 이유를 콘솔에 남기고 `null` 을 돌려주며,
 * 부르는 쪽은 대체 상자를 그대로 둔다. 발자국·도달 링은 메시가 없어도 판단 근거로 남는다.
 */
// 토큰과 같은 의미의 색. 상태 색은 두 화면에서 같아야 한다 (D21).
// 평면도 Y(미터) → 씬 Z. **부호가 뒤집힌다.**
//
// 축을 그냥 맞바꾸면(planY → +sceneZ) 행렬식이 −1 인 거울 사상이라 씬이 실제의
// 좌우 반전이 된다. 배치안만 볼 때는 아무도 눈치채지 못하지만 글로벌 카메라 영상에
// 겹치는 순간 드러나고, 카메라로는 흡수할 수 없다 (D43).
// **이 파일에서 평면도 Y 를 씬에 넣는 곳은 전부 이 함수를 지난다** (하드 룰 5).
// 회전도 같이 뒤집힌다 — 평면도 yaw θ 는 씬에서 rotation.y = +θ 다.
const Z = (planYMeters) => -planYMeters;

/**
 * 부드럽게 들어가고 나온다 (smoothstep). **급출발·급정지를 없애는 최소 곡선이다.**
 *
 * `stateAt` 의 `k` 는 시간에 선형이라 사건 경계에서 속도가 0→최대로 튄다. 실물 AMR 은
 * 그렇게 안 움직이고, 화면에서는 그게 제일 먼저 "가짜" 로 읽힌다.
 *
 * **시간축이 아니라 여기서 한다.** 시간축은 물리적 진실(선형)을 들고 연출은 화면 몫이다 —
 * `stateAt` 에 넣으면 `timeline.sh` 가 판정하는 값이 바뀌어 게이트가 회귀한다.
 */
const ease = (k) => k * k * (3 - 2 * k);

const C = { ok: 0x2f7d32, warn: 0xb06d00, danger: 0xba1a1a, path: 0x2f7d32, virtual: 0x4a90d9,
  hazard: 0xd9a323 };   // 바닥 안전 표시 — 공장의 그 노랑

const mat = {
  floor: new THREE.MeshStandardMaterial({ color: 0xeeeff0, roughness: 0.8, metalness: 0.0 }),
  wall:  new THREE.MeshStandardMaterial({ color: 0xf4f4f5, roughness: 0.95 }),
  bench: new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.28, metalness: 0.75 }), // 스테인리스
  amr:   new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.5, metalness: 0.2 }),
  frame: new THREE.MeshStandardMaterial({ color: 0xb9bfc5, roughness: 0.55, metalness: 0.25 }),
};

// 문 유리는 부품 유리와 같은 톤을 쓴다 — 실물 판이 무색 투명이라 파란 모형 유리를 뺐다 (2026-09-01)
const matGlassDoor = new THREE.MeshStandardMaterial({
  color: 0xdfe4e8, roughness: 0.08, metalness: 0,
  transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
});

/**
 * 이송팔 — **실물이 없는 팔이다.** 그래서 FR5 모형을 안 쓴다.
 *
 * 형태를 일부러 다르게 뒀다 — 관절형 6축이 아니라 **기둥 + 수평 붐 + 수직 그리퍼**의
 * 갠트리형이다. 화면에서 "이건 FR5 가 아니다" 가 한눈에 보여야 실측 수치를 여기 붙이는
 * 오해가 안 생긴다 (`SHARED-CORE.md` §arms).
 *
 * 부품 팩토리(`parts.js`)에 안 넣는다 — 팔은 배치안에서 `props` 가 아니라 `arms` 다.
 * 팔레트에 뜨면 소품처럼 놓을 수 있게 되어 두 모델이 갈린다.
 */
function procArm() {
  const g = new THREE.Group();
  g.name = 'transferArm';
  const put = (geo, mtl, x, y, z) => {
    const m = new THREE.Mesh(geo, mtl);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  put(new THREE.CylinderGeometry(0.13, 0.16, 0.06, 16), mat.frame, 0, 0.03, 0);   // 베이스
  put(new THREE.BoxGeometry(0.14, 0.62, 0.14), mat.bench, 0, 0.37, 0);            // 기둥
  put(new THREE.BoxGeometry(0.62, 0.11, 0.13), mat.bench, 0.26, 0.66, 0);         // 수평 붐
  put(new THREE.BoxGeometry(0.08, 0.26, 0.08), mat.frame, 0.5, 0.5, 0);           // 수직 축
  for (const s of [-1, 1]) {                                                       // 두 손가락
    put(new THREE.BoxGeometry(0.03, 0.12, 0.03), mat.amr, 0.5, 0.33, s * 0.045);
  }
  return g;
}

/**
 * 배치안을 그린다. 반환값의 `dispose()` 를 반드시 부른다.
 *
 * `mountArm(group, layout)` 을 주면 그 자리에 팔을 붙인다 — URDF 로딩이 비동기라
 * 이 모듈이 직접 하지 않는다. 그래야 방이 먼저 뜨고 팔이 나중에 붙는다.
 */
export function createLayoutView(layout, { mountArm } = {}) {
  const root = new THREE.Group();
  root.name = 'layoutView';
  // **방 껍데기와 내용물을 나눈다.** 시점을 방(6m)에 맞추면 내용물이 작아져 안 보인다.
  const contents = new THREE.Group();
  contents.name = 'contents';
  root.add(contents);
  const disposables = [];
  const track = (g) => { disposables.push(g); return g; };

  const W = mm(layout.floor.widthMm);
  const D = mm(layout.floor.depthMm);
  const H = mm(layout.floor.heightMm ?? 2700);

  // ── 방 — **두께 있는 벽**으로 만든다.
  //
  // 얇은 면(PlaneGeometry)은 건축 모형으로 안 읽힌다. `pascalorg/editor` 의 화이트 모형이
  // 그럴듯한 이유 중 하나가 **벽 단면이 보이는 것**이다 — 잘린 두께가 "건물" 신호를 준다.
  //
  // 컷어웨이는 따로 안 한다. 카메라가 방 밖 위쪽에 있으면 **앞쪽 벽이 뒷면이 되어
  // 저절로 안 보인다** (아래 `side: BackSide` 가 아니라 벽마다 바깥을 향하게 두면 된다).
  const T = 0.12;                       // 벽 두께 120mm
  const SLAB = 0.16;                    // 바닥 슬래브 160mm
  const slab = new THREE.Mesh(track(new THREE.BoxGeometry(W + T * 2, SLAB, D + T * 2)), mat.floor);
  slab.position.set(W / 2, -SLAB / 2, Z(D / 2));
  slab.name = 'slab';        // AR 오버레이는 바닥을 숨긴다 — 실제 바닥이 뒤에 있다
  slab.receiveShadow = true;
  root.add(slab);

  // 벽 네 장. 각 벽은 **개구부(문)를 가질 수 있다** — AMR 이 드나들 입구가 있어야 한다.
  // CSG 로 구멍을 뚫지 않고 **조각으로 나눈다** — 훨씬 싸고 단면이 깨끗하다.
  //
  // side: 벽 이름 · axis: 개구부 위치가 어느 축을 따라가나 · len: 그 축 길이
  const SIDES = [
    { name: 'south', axis: 'x', len: W, fixed: -T / 2,     size: [0, H, T] },
    { name: 'north', axis: 'x', len: W, fixed: D + T / 2,  size: [0, H, T] },
    { name: 'west',  axis: 'z', len: D, fixed: -T / 2,     size: [T, H, 0] },
    { name: 'east',  axis: 'z', len: D, fixed: W + T / 2,  size: [T, H, 0] },
  ];

  const wallMeshes = [];
  // **편집기의 판정 표식.** 영상에서는 꺼야 한다 — 도달 링(초록/빨강)과 도달 범위 원판은
  // 배치를 정할 때의 근거이지, 라인이 도는 것을 보여주는 영상에서는 **에러 마커처럼 읽힌다**
  // (2026-08-10 접점 시트가 잡았다). `setLayers` 가 패스마다 켜고 끈다.
  const judgeRings = [];
  const reachZones = [];
  const center = new THREE.Vector3(W / 2, 0, Z(D / 2));

  /** 한 벽을 개구부를 피해 조각으로 만든다. 개구부 위는 인방(lintel)으로 덮는다. */
  function buildWall(side) {
    // 문과 창을 같은 방식으로 뚫는다 — 창은 **아래에 벽이 남는다**(sill)
    const holes = [...(layout.doors ?? []), ...(layout.windows ?? [])]
      .filter((d) => d.wall === side.name)
      .map((d) => ({
        a: mm(d.atMm - d.widthMm / 2), b: mm(d.atMm + d.widthMm / 2),
        sill: mm(d.sillMm ?? 0), head: mm((d.sillMm ?? 0) + (d.heightMm ?? 2100)),
      }))
      .sort((p, q) => p.a - q.a);

    const pieces = [];
    let cursor = side.axis === 'x' ? -T : -T;          // 벽은 모서리에서 T 만큼 더 나간다
    const end = side.len + T;
    for (const h of holes) {
      if (h.a > cursor) pieces.push({ from: cursor, to: h.a, h: H, y: H / 2 });
      // 개구부 위 인방
      pieces.push({ from: h.a, to: h.b, h: H - h.head, y: h.head + (H - h.head) / 2 });
      // 창턱 아래 벽 (문은 sill=0 이라 안 생긴다)
      if (h.sill > 0.001) pieces.push({ from: h.a, to: h.b, h: h.sill, y: h.sill / 2 });
      cursor = h.b;
    }
    if (cursor < end) pieces.push({ from: cursor, to: end, h: H, y: H / 2 });

    for (const pc of pieces) {
      const span = pc.to - pc.from;
      if (span <= 0.001 || pc.h <= 0.001) continue;
      const mid = pc.from + span / 2;
      const dims = side.axis === 'x' ? [span, pc.h, T] : [T, pc.h, span];
      const m = new THREE.Mesh(track(new THREE.BoxGeometry(...dims)), mat.wall);
      if (side.axis === 'x') m.position.set(mid, pc.y, Z(side.fixed));
      else m.position.set(side.fixed, pc.y, Z(mid));
      m.castShadow = true; m.receiveShadow = true;
      // 컷어웨이 판정용 — 벽 중심에서 방 중심으로 가는 방향(=안쪽)
      m.userData.inward = center.clone().sub(m.position).setY(0).normalize();
      root.add(m);
      wallMeshes.push(m);
    }
  }
  for (const side of SIDES) buildWall(side);

  // 문틀 — 개구부 테두리를 진하게 두면 "입구" 로 읽힌다.
  //
  // **문·창은 `contents` 에 넣는다.** 고를 수 있어야 팔레트로 놓은 것을 다시 고치기 때문이다
  // (피킹 루트가 `contents`). 대신 `fixed: true` 로 **끌리지는 않게** 한다 —
  // 벽에 뚫린 구멍이라 바닥 좌표가 없다 (`interaction.js` 의 가드).
  for (const d of layout.doors ?? []) {
    const side = SIDES.find((x) => x.name === d.wall);
    if (!side) continue;
    const dg = new THREE.Group();
    dg.name = d.id ?? 'door';
    // 끌 때 **벽을 따라 미끄러지려면** 축과 벽 길이를 알아야 한다 (`interaction.js`)
    dg.userData.item = {
      kind: 'door', id: d.id, name: '문', wall: d.wall, axis: side.axis,
      atMm: d.atMm, widthMm: d.widthMm, spanMm: side.axis === 'x' ? layout.floor.widthMm : layout.floor.depthMm,
    };
    contents.add(dg);
    const root = dg;                       // 아래 조각들이 이 그룹으로 들어간다
    const w = mm(d.widthMm); const h = mm(d.heightMm ?? 2100); const at = mm(d.atMm);
    const jamb = 0.09;
    for (const s of [-1, 1]) {
      const dims = side.axis === 'x' ? [jamb, h, T * 1.3] : [T * 1.3, h, jamb];
      const m = new THREE.Mesh(track(new THREE.BoxGeometry(...dims)), mat.frame);
      if (side.axis === 'x') m.position.set(at + s * (w / 2), h / 2, Z(side.fixed));
      else m.position.set(side.fixed, h / 2, Z(at + s * (w / 2)));
      m.castShadow = true;
      root.add(m);
    }
    // **유리 문짝.** 개구부만 있으면 "구멍" 이고, 문짝이 있어야 "입구" 로 읽힌다.
    // 레퍼런스(Codex 생성)에서 이게 가장 눈에 띄는 차이였다.
    const leafW = w / 2 - 0.02;
    for (const s2 of [-1, 1]) {
      const dims = side.axis === 'x' ? [leafW, h - 0.06, 0.05] : [0.05, h - 0.06, leafW];
      const leaf = new THREE.Mesh(track(new THREE.BoxGeometry(...dims)), matGlassDoor);
      const off = s2 * (w / 4);
      if (side.axis === 'x') leaf.position.set(at + off, h / 2, Z(side.fixed));
      else leaf.position.set(side.fixed, h / 2, Z(at + off));
      root.add(leaf);
      // 손잡이 — 세로 막대 하나가 "문" 신호를 완성한다
      const hd = new THREE.Mesh(track(new THREE.CylinderGeometry(0.016, 0.016, 0.55, 8)), mat.frame);
      const hoff = s2 * (w / 4 - leafW / 2 + 0.09);
      if (side.axis === 'x') hd.position.set(at + hoff, h * 0.45, Z(side.fixed + 0.05));
      else hd.position.set(side.fixed + 0.05, h * 0.45, Z(at + hoff));
      root.add(hd);
    }

    // 바닥 문턱 — 입구 위치가 바닥에서도 읽힌다
    const sill = new THREE.Mesh(
      track(new THREE.BoxGeometry(...(side.axis === 'x' ? [w, 0.012, T * 1.6] : [T * 1.6, 0.012, w]))),
      mat.frame,
    );
    if (side.axis === 'x') sill.position.set(at, 0.006, Z(side.fixed));
    else sill.position.set(side.fixed, 0.006, Z(at));
    root.add(sill);
  }

  /**
   * 컷어웨이 — **카메라와 방 사이를 막는 벽을 숨긴다.**
   *
   * 두께 있는 벽은 안을 완전히 가린다. 참고한 화면(`pascalorg/editor`)이
   * 안이 보이는 이유가 이 처리다. 매 프레임 카메라 방향으로 판정한다 —
   * 궤도를 돌리면 숨는 벽이 바뀐다.
   */
  const _v = new THREE.Vector3();
  function updateCutaway(camera) {
    camera.getWorldDirection(_v).setY(0).normalize();   // 카메라가 보는 방향
    for (const m of wallMeshes) {
      // 안쪽 방향과 시선이 같은 쪽 = 카메라가 그 벽을 등 뒤에서 통과해 보고 있다 → 숨긴다
      m.visible = _v.dot(m.userData.inward) < 0.35;
    }
  }

  // ── 창 유리. 레퍼런스에 있고 우리에게 없던 것 — **벽면이 살아난다.**
  for (const wd of layout.windows ?? []) {
    const side = SIDES.find((x) => x.name === wd.wall);
    if (!side) continue;
    const wg = new THREE.Group();
    wg.name = wd.id ?? 'window';
    wg.userData.item = {
      kind: 'window', id: wd.id, name: '창', wall: wd.wall, axis: side.axis,
      atMm: wd.atMm, widthMm: wd.widthMm, spanMm: side.axis === 'x' ? layout.floor.widthMm : layout.floor.depthMm,
    };
    contents.add(wg);
    const root = wg;                       // 아래 조각들이 이 그룹으로 들어간다
    const w = mm(wd.widthMm); const h = mm(wd.heightMm); const at = mm(wd.atMm);
    const yc = mm(wd.sillMm ?? 900) + h / 2;
    const dims = side.axis === 'x' ? [w, h, 0.04] : [0.04, h, w];
    const g2 = new THREE.Mesh(track(new THREE.BoxGeometry(...dims)), matGlassDoor);
    // **여기가 `Z()` 를 빼먹고 있었다** (2026-08-03 발견). 창 유리·창틀 9개가 방 반대편
    // 밖(z +1.6·+3.6·+1.4)에 떠 있었고, 대시보드 첫 화면에서 판때기로 보였다.
    // D43 이 잡은 거울 사상과 같은 종류다 — 평면도 Y 는 **예외 없이** 이 함수를 지난다.
    if (side.axis === 'x') g2.position.set(at, yc, Z(side.fixed));
    else g2.position.set(side.fixed, yc, Z(at));
    root.add(g2);
    // 창틀
    const fd = side.axis === 'x' ? [w + 0.08, 0.06, T * 1.2] : [T * 1.2, 0.06, w + 0.08];
    for (const sy of [-1, 1]) {
      const f = new THREE.Mesh(track(new THREE.BoxGeometry(...fd)), mat.frame);
      if (side.axis === 'x') f.position.set(at, yc + sy * h / 2, Z(side.fixed));
      else f.position.set(side.fixed, yc + sy * h / 2, Z(at));
      root.add(f);
    }
  }

  // ── 내부 부품. **배치안이 이름과 좌표만 들고 있고 형태는 props/ 에 있다.**
  // `img2threejs` 로 만든 부품도 같은 계약이면 그대로 조립된다.
  contents.add(assembleProps(layout.props));

  // ── 스테이션. **회색 박스를 걷어냈다** — 부품 형태로 그린다(`prop` 필드).
  // 판정은 바닥 링으로만 한다. 그래야 중앙이 깔끔하고 무엇이 범위 밖인지가 또렷하다.
  const reach = Object.fromEntries(reachCheck(layout).map((r) => [r.id, r]));
  for (const st of layout.stations ?? []) {
    const px = mm(st.posMm[0]); const pz = mm(st.posMm[1]);
    if (st.prop) {
      const grp = assembleProps([{
        // **z 는 `posMm[2]` 다.** 전에는 `baseMm ?? 0` 이라 z 를 버리고 바닥에 그렸는데,
        // 도달 판정(`schema.js` `reachCheck`)은 같은 `posMm` 을 3D 로 재고 있었다 —
        // **링은 900mm 기준으로 켜지는데 물건은 바닥에 있었다.** `baseMm` 은 명시 override 로 남긴다.
        id: st.id, type: st.prop, posMm: [st.posMm[0], st.posMm[1], st.baseMm ?? st.posMm[2] ?? 0],
        rotDeg: st.rotDeg ?? 0, opts: st.opts,
      }]);
      // 스테이션은 판정 대상이라 표식을 따로 준다 — 끌면 도달 여부가 실시간으로 바뀐다
      grp.children[0].userData.item = { kind: 'station', id: st.id, name: st.name };
      contents.add(grp);
    }
    // 바닥 표식 — 닿으면 초록, 못 닿으면 빨강. **이게 배치 판정의 전부다.**
    const ok = reach[st.id]?.inReach;
    const ring = new THREE.Mesh(
      track(new THREE.RingGeometry(0.34, 0.42, 32)),
      new THREE.MeshBasicMaterial({
        color: ok ? C.ok : C.danger, transparent: true,
        opacity: ok ? 0.55 : 0.95, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(px, 0.005, Z(pz));
    contents.add(ring);
    judgeRings.push(ring);
  }

  // ── 팔 자리 + 도달 범위. 링이 이 화면의 주인공이다.
  //
  // **팔은 여럿일 수 있다** (`SHARED-CORE.md` §arms). 실물 모형(URDF)은 `model: 'FR5'`
  // 에만 붙이고, 나머지는 **절차적 팔**로 그린다 — 같은 모형을 둘 세우면 어느 쪽이
  // 진짜인지 화면이 말하지 못한다 (SR_24).
  const armSlots = (layout.arms ?? []).map((a) => {
    const slot = new THREE.Group();
    slot.name = a.id ?? 'arm';
    slot.position.set(mm(a.basePosMm[0]), mm(a.basePosMm[2]), Z(mm(a.basePosMm[1])));
    slot.rotation.y = (a.baseYawDeg ?? 0) * Math.PI / 180;   // Z 부호와 함께 뒤집힌다
    slot.userData.arm = a;
    contents.add(slot);

    const zone = makeReachZone({
      radius: mm(a.reachMm), height: 0.9,
      ...(a.role === 'transfer' ? { color: C.virtual } : {}),   // 실물 없는 팔은 파랑
    });
    zone.rotation.x = -Math.PI / 2;   // reach-zone 은 Z-up 으로 만든다
    zone.position.y = -mm(a.basePosMm[2]) + 0.005;  // 링은 바닥에 놓는다
    zone.traverse((o) => { o.raycast = () => {}; });   // 링을 눌러 팔이 잡히면 안 된다
    slot.add(zone);
    reachZones.push(zone);

    // **팔도 배치안의 편집 단위다** (2026-08-04). 팔 위치가 배치의 변수인데 화면에서
    // 못 옮기면 배치안을 손으로 고쳐야 한다.
    //
    // 잡는 자리는 **베이스 판 하나**다 — URDF 전체를 피킹 대상으로 두면 팔이 커서
    // 뒤의 물건을 전부 가려 아무것도 못 고른다. 링도 이 판을 기준으로 그린다(`fitFrom`).
    //
    // 받침대를 **팔이 직접 들고 있다.** 전에는 배치안 소품(`bench`)을 밑에 깔았는데,
    // 같은 자리에 편집 단위가 둘이라 팔을 누르면 받침이 잡혔다 (실렌더가 잡았다).
    // 받침 높이는 `basePosMm[2]` 하나가 정한다 — 팔을 옮기면 받침이 따라온다.
    const standH = mm(a.basePosMm[2] ?? 0);
    const pad = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.19, standH > 0.05 ? 0.26 : 0.22, Math.max(0.05, standH), 20)),
      mat.frame,
    );
    pad.position.y = -standH / 2 + 0.025;
    pad.castShadow = true;
    pad.receiveShadow = true;
    slot.add(pad);
    slot.userData.item = {
      kind: 'arm', id: a.id, type: a.model, name: `${a.model} ${a.id}`,
      posMm: [a.basePosMm[0], a.basePosMm[1]],
    };
    slot.userData.fitFrom = pad;

    // ── 바닥 작업영역 표시. **화이트 모형에서 유일하게 강한 그래픽이다.**
    //
    // 장식이 아니라 **데이터다** — 한 변이 `reachMm × 2` 라 팔을 옮기거나 도달이 바뀌면
    // 같이 바뀐다. 실제 공장이 로봇 둘레에 노란 테이프를 붙이는 그 사각이고,
    // 반투명 도달 원(`reachZone`)이 "어디까지 닿나", 이 사각이 "어디부터 위험한가" 다.
    if (a.role !== 'transfer') {
      const R = mm(a.reachMm);
      const BAND = 0.14;
      const zoneMat = new THREE.MeshBasicMaterial({
        color: C.hazard, transparent: true, opacity: 0.75,
        side: THREE.DoubleSide, depthWrite: false,
      });
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const len = R * 2 + BAND;
        const dims = sx ? [BAND, 0.001, len] : [len, 0.001, BAND];
        const bar = new THREE.Mesh(track(new THREE.BoxGeometry(...dims)), zoneMat);
        bar.position.set(sx * R, -mm(a.basePosMm[2] ?? 0) + 0.004, sz * R);
        bar.raycast = () => {};
        slot.add(bar);
      }
    }

    if (a.model === 'FR5') mountArm?.(slot, layout, a);
    else {
      const arm = procArm();
      arm.traverse((o) => { o.raycast = () => {}; });   // 잡는 자리는 베이스 판뿐이다
      slot.add(arm);
    }
    return slot;
  });
  // 실물 팔이 붙는 자리. 화면·검증이 이걸 계속 부른다 — 팔이 없어도 널이 아니어야 한다
  let armSlot = armSlots.find((s) => s.userData.arm?.model === 'FR5') ?? armSlots[0];
  if (!armSlot) { armSlot = new THREE.Group(); contents.add(armSlot); }

  // ── AMR. 가상 팔의 도달 범위도 같이 — 이게 "이동하는 도달 범위" 다.
  //
  // **경로 선을 안 그린다** (실기 담당자 요청 · 2026-08-04). 배치를 정하는 화면에서 선 두 줄이
  // 바닥을 가로질러 가구보다 눈에 띄었다. 이동거리는 숫자줄이 계속 말한다.
  // 대신 **도킹 자리에 세우고 고를 수 있게** 한다 — 도킹존이 배치의 변수이기 때문이다.
  for (const a of layout.amrs ?? []) {
    const g = new THREE.Group();
    const at = a.dockPosMm ?? a.waypointsMm?.[0] ?? [0, 0];
    g.position.set(mm(at[0]), 0, Z(mm(at[1])));
    g.name = a.id ?? 'amr';
    g.userData.item = { kind: 'amr', id: a.id, type: 'amr', name: a.model ?? 'AMR' };
    contents.add(g);

    // 몸통. **실물 Burger 메시**(GLB)가 오면 갈아 끼우고, 오기 전까지는 상자로 버틴다.
    //
    // **치수는 `AMR_MM` 이 정본이다** (Burger 실물 · `STACK.md` 등재). 여기 숫자를 박지 않는다 —
    // 발자국은 간섭·통로 판정의 입력이라 화면이 제 값을 지어내면 판정이 조용히 거짓말을 한다.
    //
    // 상자를 **지우지 않고 남긴다.** GLB 는 네트워크를 타므로 늦게 오거나 안 올 수 있고,
    // 그때 AMR 이 사라지면 배치 판단의 근거(발자국·도달)가 같이 사라진다 — 팔이 실패하면
    // 도달 링만 그리는 것과 같은 규약이다 (D15·D18 · `LayoutView.jsx` §getArm).
    const LIDAR_H = 0.04;                       // LDS-01 두께 — 사양 등재 안 됨(미확인)
    const bodyH = mm(AMR_MM.heightMm) - LIDAR_H;

    // ⚠ **투명 히트박스를 두지 않는다** — 넣어 보고 지웠다 (2026-08-07 실측).
    // GLB 가 이미 같은 부피(178×138×192)를 채우므로 과녁이 하나도 안 넓어졌고,
    // 픽 격자 지도가 넣기 전과 **한 칸도 다르지 않았다.** 고르기가 어려운 진짜 이유는
    // 메시 모양이 아니라 **축척**이다 — 기본 시점에서 1px ≈ 28mm 라 AMR 이 화면에서
    // 6~8px 이고, `interaction.js` 의 20px 근접 보조가 기하보다 크다.
    // 근거·처방은 `docs/evidence/2026-08-07/amr-burger-mm.md` §5.
    const fallback = new THREE.Group();
    const body = new THREE.Mesh(track(new THREE.BoxGeometry(
      mm(AMR_MM.widthMm), bodyH, mm(AMR_MM.depthMm),
    )), mat.amr);
    body.position.y = bodyH / 2;
    body.castShadow = true;
    fallback.add(body);
    // ponytail: 몸통/라이다 **쪼개는 비율**은 실측이 아니다 — 잰 것은 겉면(178·138·192)뿐이다.
    // 천장(ceiling): 대체 상자는 "실물이 안 왔을 때의 발자국" 이지 외형 근거가 아니다.
    const lidar = new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.035, LIDAR_H, 12)), mat.amr);
    lidar.position.set(0, bodyH + LIDAR_H / 2, 0);
    lidar.castShadow = true;
    fallback.add(lidar);
    g.add(fallback);

    // 실물 메시 — **형태만 쓰고 재질은 `mat.amr` 로 덮는다.** GLB 가 자기 색·텍스처를 들고
    // 오면 화이트 모형 규약(D62)이 깨진다. 굽는 단계에서 재질을 안 실었고(`ATTRIBUTION.md`),
    // 여기서 한 번 더 덮어 **자산이 바뀌어도 화면 스타일이 안 흔들리게** 한다.
    loadBurger().then((proto) => {
      if (!proto || !g.parent) return;          // 늦게 와서 무대가 이미 치워졌으면 버린다
      const real = proto.clone(true);
      // **피킹에 남긴다.** FR5 팔은 피킹에서 뺐지만(URDF 가 뒤를 다 가린다) 터틀봇은
      // 178mm 라 가리는 것이 없고, 빼면 과녁이 20px 근접 보조 원만 남는다.
      real.traverse((o) => {
        if (!o.isMesh) return;
        // **지오메트리를 복사한다.** `clone()` 은 지오메트리를 공유하는데, 아래 `dispose()` 가
        // root 를 훑어 전부 지운다 — 공유본을 지우면 **두 번째 편집부터 터틀봇이 빈 껍데기**가
        // 된다. FR5 팔이 정확히 이 함정을 밟았다 (`LayoutView.jsx` §armCache 경고).
        o.geometry = o.geometry.clone();
        o.material = mat.amr;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      g.remove(fallback);                       // 실물이 왔으니 대체 상자를 내린다
      // **정면 정렬을 거친다** — GLB 정면(+Z)은 평면도 −Y 라, 그냥 붙이면 θ=0 인데도
      // 로봇이 옆(−Y)을 본 채 +X 로 미끄러진다. 90° 어긋남 (2026-08-28 감사).
      // 0점을 정하는 곳은 `burger.js` 하나다 — 여기서 오일러를 만들지 않는다.
      g.add(mountBurgerYUpXForward(real));
    }).catch((err) => {
      // **거부가 새어 나가지 않게 한다.** 게이트를 Node 에서 돌리면 미처리 거부가 프로세스를
      // 죽인다 — 화면에서는 대체 상자가 남아 배치 판단이 계속 된다.
      console.warn('터틀봇 메시를 붙이다 실패했다 — 대체 상자로 간다:', err?.message ?? err);
    });

    if (a.reachMm) {
      const r = makeReachZone({ radius: mm(a.reachMm), height: 0.5, color: C.virtual });
      r.rotation.x = -Math.PI / 2;
      r.position.y = 0.006;
      g.add(r);
      reachZones.push(r);
    }
  }

  // ── 경로 기즈모. **평소엔 안 보인다** — `[경로]` 를 켤 때만 화면이 켠다.
  // 여기서 만드는 이유는 `mm`·`Z` 규약이 이 파일에 있기 때문이다 (하드 룰 5).
  const pathGiz = createPathGizmo({ mm, Z, color: C.virtual });
  contents.add(pathGiz.root);

  // ── 경로 교차 — **교착이 나는 자리다.** 배치 단계에서 미리 보여준다.
  for (const x of crossings(layout)) {
    const m = new THREE.Mesh(
      track(new THREE.SphereGeometry(0.07, 16, 12)),
      new THREE.MeshBasicMaterial({ color: C.warn, transparent: true, opacity: 0.85 }),
    );
    m.position.set(mm(x.atMm[0]), 0.07, Z(mm(x.atMm[1])));
    contents.add(m);
  }

  // ── 재생 (사다리 2 · `SHARED-CORE.md` §1.5) ─────────────────────────────────
  //
  // **시간은 여기서 흐르지 않는다.** 밖에서 `stateAt(series, t)` 로 계산한 상태를 받아
  // 그리기만 한다 — 그래야 같은 상태를 되감고, 두 배치안에 같은 시각을 물어 나란히 볼 수 있다.
  const stationAt = Object.fromEntries((layout.stations ?? []).map((s) => [s.id, s.posMm]));

  // 팔이 지금 무엇을 겨누나 — `{ armId: { relDeg, distMm } }`.
  //
  // **베이스는 안 돈다.** 실물 FR5 는 바닥에 볼트로 고정이고 도는 것은 **j1** 이다.
  // 전에는 슬롯을 통째로 돌렸는데(2026-08-04), 그러면 받침대까지 같이 도는 거짓말이 된다.
  // 여기서는 **각도만 내고**, 그 각도를 관절에 얹는 것은 화면 쪽 몫이다 (URDF 가 거기 있다).
  // AMR 손잡이 — 재생 중에는 스테이션 쪽으로 붙었다가, 재생을 끄면 도킹 자리로 돌아온다
  const amrNodes = [];
  for (const a2 of layout.amrs ?? []) {
    const n = contents.getObjectByName(a2.id);
    if (n) amrNodes.push({ node: n, dock: a2.dockPosMm ?? a2.waypointsMm?.[0] ?? [0, 0], amr: a2 });
  }
  // 실기 AMR 자세 — `setAmrLivePose` 가 채운다 (`TB-CONTRACT.md` §미래 접점 ④ · 읽기 전용 소비).
  // **비면 도킹 자리다.** 스트림이 없거나 끊긴 화면은 여태 동작 그대로 남는다 —
  // 실기가 안 붙었을 때 로봇이 사라지거나 원점에 처박히면 배치 판단의 근거가 같이 사라진다
  // (GLB 대신 상자를 남기는 것과 같은 규약 · D15·D18).
  const amrLive = new Map();       // 배치안 amr id → { xMm, yMm, thetaDeg } · 평면도 좌표
  let amrScripted = false;         // 재생이 AMR 을 몰고 있나 — 각본이 주인일 때 실기가 끼어들지 않는다

  function restAmrs() {
    for (const a2 of amrNodes) {
      const live = amrLive.get(a2.amr.id);
      const at = live ?? { xMm: a2.dock[0], yMm: a2.dock[1], thetaDeg: 0 };
      a2.node.position.set(mm(at.xMm), 0, Z(mm(at.yMm)));
      // 평면도 yaw θ 는 씬에서 rotation.y = +θ 다 (파일 머리 `Z` 규약과 한 짝 · D43).
      // **여기를 그냥 -θ 로 두면 3D 만 볼 땐 멀쩡하고 AR 겹침에서만 좌우가 뒤집힌다.**
      a2.node.rotation.y = (at.thetaDeg * Math.PI) / 180;
      a2.node.visible = true;      // 재생을 끄면 도킹 자리에 **보이게** 세운다
    }
  }

  /**
   * 실기 AMR 자세를 씬에 얹는다 — **평면도 좌표(mm·도)로 받는다.**
   *
   * **프레임 변환을 여기서 하지 않는다.** 터틀봇 브리지가 내는 `pose` 는 맵(또는 브링업 자리)
   * 원점 기준이고, 실험실 바닥 원점으로 옮기는 것은 `mapToLab` 의 일이다 — 계약이 그 변환을
   * **브리지 경계 한 곳**으로 못 박았다 (`TB-CONTRACT.md` §미래 접점 ③). 뷰가 제 나름의
   * 변환을 또 만들면 그 한 곳이 셋이 된다.
   *
   * `pose` 에 `null` 을 주면 그 로봇을 놓아 준다 = 도킹 자리로 돌아간다(스트림 끊김).
   * 배치안에 없는 id 는 **조용히 무시하지 않고 `false`** 를 돌려준다 — 부르는 쪽이
   * 「id 를 잘못 짝지었다」와 「아직 안 왔다」를 갈라야 한다.
   *
   * @returns {boolean} 얹었나
   */
  function setAmrLivePose(id, pose) {
    if (!id || !amrNodes.some((a2) => a2.amr.id === id)) return false;
    if (pose === null) {
      if (!amrLive.delete(id)) return false;
    } else {
      if (!Number.isFinite(pose?.xMm) || !Number.isFinite(pose?.yMm)) return false;
      amrLive.set(id, {
        xMm: pose.xMm,
        yMm: pose.yMm,
        thetaDeg: Number.isFinite(pose.thetaDeg) ? pose.thetaDeg : 0,
      });
    }
    // **재생 중에는 자리를 안 건드린다** — 각본이 매 프레임 덮어써서 깜빡일 뿐이다.
    // 값은 받아 두므로 재생을 끄는 순간 실기 자리로 돌아온다.
    if (!amrScripted) restAmrs();
    return true;
  }

  const aim = {};
  function restArms() { for (const k of Object.keys(aim)) delete aim[k]; }

  // 작업물 — **배치안의 소품이 아니다.** 로봇이 집고 옮기는 물건이라 배치안에 좌표가 없다.
  // 그래서 피킹 대상에서도 뺀다 (`userData.item` 없음 · 끌 수도 지울 수도 없다).
  let work = null;
  let workStage = -1;
  // 크레인 손잡이 — `parts.js` 가 트롤리를 부분그룹으로 떼어 `userData.crane` 에 실어 준다.
  // **매 프레임 크레인을 다시 만들지 않는다** (메시 30개다).
  // 컨베이어들 — **작업물이 그 위에 앉게** 하려면 벨트 높이를 물어야 한다.
  // 배치안 좌표 → 프롭 로컬로 돌려서 묻는다 (회전은 부르는 쪽이 하는 규약과 짝).
  const belts = [];
  for (const p2 of layout.props ?? []) {
    const node = contents.getObjectByName(p2.id);
    if (node?.userData?.belt) {
      const a2 = ((p2.rotDeg ?? 0) * Math.PI) / 180;
      belts.push({ belt: node.userData.belt, at: p2.posMm, cos: Math.cos(a2), sin: Math.sin(a2) });
    }
  }
  /** 배치안 (x, y) 위에 벨트가 있으면 그 이송면 높이(mm), 없으면 `null`. */
  function beltTopMm(xMm, yMm) {
    for (const b2 of belts) {
      const dx = xMm - b2.at[0]; const dy = yMm - b2.at[1];
      // 평면도 yaw θ 의 역회전 — 씬 z 부호 규약과 한 짝이다
      const lx = dx * b2.cos + dy * b2.sin;
      const lz = -dx * b2.sin + dy * b2.cos;
      const t = b2.belt.topAtMm(lx, lz);
      if (t !== null) return t;
    }
    return null;
  }

  let craneH = null;
  let craneAt = [0, 0];         // 크레인 프롭의 배치안 좌표(mm) — 트롤리는 그 기준 상대다
  for (const p2 of layout.props ?? []) {
    if (p2.type !== 'crane') continue;
    const node = contents.getObjectByName(p2.id);
    if (node?.userData?.crane) { craneH = node.userData.crane; craneAt = p2.posMm; }
  }

  // 작업물을 따라다니는 바닥 표식.
  //
  // **탄두를 크게 그릴 수는 없다** — 치수가 실물 페트병(Ø65×220) 기준이라 12m 방에서
  // 몇 픽셀이고, 키우면 AR 에서 사람이 충돌 여지를 오판한다 (D51). 그래서 크기 대신
  // **표식**을 준다. 스테이션 링과 같은 시각 문법이고, 색은 `--c-info`(시뮬레이션)다 —
  // 초록(정상)·빨강(경고)과 섞이면 안 된다 (`ARCHITECTURE.md` §상태색은 장식색이 아니다).
  // **재생할 때 만든다.** 미리 만들어 두면 안 보이는 채로 원점에 앉아 방 밖까지 상자를
  // 늘린다 — `stage.frame()` 이 그만큼 넓게 잡고 `scene-axes.sh` 가 실패한다 (게이트가 잡았다).
  let workMark = null;
  let showWorkMark = true;
  function ensureMark() {
    if (workMark) return workMark;
    workMark = new THREE.Mesh(
      track(new THREE.RingGeometry(0.2, 0.3, 32)),
      new THREE.MeshBasicMaterial({
        color: C.virtual, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    workMark.rotation.x = -Math.PI / 2;
    workMark.raycast = () => {};
    contents.add(workMark);
    return workMark;
  }

  /** 탄두 단계가 바뀔 때만 다시 만든다 — 형태가 바뀌므로 위치처럼 매 프레임 못 고친다. */
  function buildWork(stage) {
    if (work) { work.traverse((o) => o.geometry?.dispose?.()); work.removeFromParent(); }
    work = PROPS.warhead({ stage });
    work.name = 'work';
    work.traverse((o) => { o.raycast = () => {}; });
    contents.add(work);
    workStage = stage;
  }

  /**
   * 재생 상태를 그린다. `null` 이면 **재생 아님** — 작업물을 숨기고 팔을 원래 자세로.
   *
   * 스테이션 id 를 좌표로 푸는 것이 여기 몫이다 (series 는 좌표를 모른다).
   * 배치안에 그 스테이션이 없으면 **아무것도 안 움직인다** — 빈 방에서 정상이다.
   */
  function setPlayback(st) {
    const a = st && !st.empty ? stationAt[st.from] : null;
    const b = st && !st.empty ? stationAt[st.to] : null;
    if (!a || !b) {
      if (work) work.visible = false;
      if (workMark) workMark.visible = false;
      restArms();
      amrScripted = false;
      restAmrs();
      if (craneH) {
        craneH.trolley.position.x = mm(craneH.baseXMm);
        craneH.bridge.position.z = 0;
      }
      return false;
    }
    amrScripted = true;            // 아래부터 AMR 은 각본이 몬다 (`setAmrLivePose` 는 값만 받아 둔다)
    if (st.warheadStage !== workStage) buildWork(st.warheadStage);
    const k = Math.min(1, Math.max(0, st.k));
    const x = a[0] + (b[0] - a[0]) * k;
    const y = a[1] + (b[1] - a[1]) * k;
    // **높이는 벨트가 정한다.** 스테이션 z 끼리 직선 보간하면 램프 구간에서 작업물이
    // 벨트를 뚫거나 공중에 뜬다 — 사선에서 보면 컨베이어 위에 안 얹혀 보인다
    // (실기 담당자 지적 · 2026-08-04). 벨트가 없는 구간에서만 스테이션 값을 쓴다.
    const lerpZ = (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * k;
    const belt = beltTopMm(x, y);
    // **크레인이 드는 구간에는 갈고리에 매달린다.** 안 그러면 크레인만 따라가고
    // 작업물은 바닥 높이로 미끄러져 "들고 간다" 가 안 보인다 (2026-08-04).
    const carried = (st.event === 'hoist' || st.event === 'drop') && craneH;
    const z = carried ? craneH.hookYMm - 120
      : (belt === null ? lerpZ : belt + 40);        // 벨트 위면 탄체 반지름만큼 얹는다
    work.position.set(mm(x), mm(z), Z(mm(y)));
    work.visible = true;
    // **작업물과 같은 높이에 둔다.** 바닥에 깔면 작업대 상판 밑으로 들어가 안 보인다 —
    // 스테이션이 900mm 높이라 이 화면에서는 거의 언제나 가려진다 (실렌더가 잡았다).
    // **크레인이 작업물을 따라간다** — 트롤리를 거더 위에서 옮긴다.
    // 거더는 x 축이고 트롤리는 그 위를 달리므로 **x 만** 따라간다. 스팬 밖으로는 안 나간다.
    if (craneH) {
      // **축이 둘이다** — 트롤리는 거더 위(x), 브리지는 레일 위(y). 완성품을 리프터에서
      // 배출 컨베이어로 옮기는 것은 **y 이동**이라 트롤리만 움직이면 크레인이 가만히 있다
      // (실렌더가 잡았다 — 32~38초에 트롤리 x 가 계속 0 이었다).
      const clampTo = (v, lim) => Math.max(-lim, Math.min(lim, v));
      craneH.trolley.position.x = mm(clampTo(x - craneAt[0], craneH.halfSpanMm - 400));
      // 평면도 y → 씬 z 는 부호가 뒤집힌다 (파일 머리의 `Z` 규약)
      craneH.bridge.position.z = -mm(clampTo(y - craneAt[1], craneH.halfRailMm - 400));
    }

    const mark = ensureMark();
    mark.position.set(mm(x), mm(z) + 0.006, Z(mm(y)));
    // **매 프레임 다시 켜므로 스위치를 봐야 한다** — `setLayers` 로 끈 것이 다음 프레임에
    // 되살아나면 그 API 는 거짓말을 하는 셈이다
    mark.visible = showWorkMark;

    // 팔은 **베이스가 어느 쪽을 보나까지만** 돈다. 관절 궤적(6축)은 시연 녹화가 있어야 하고,
    // **없는 궤적을 지어내지 않는다** — 움직이는 로봇은 숫자보다 훨씬 강하게 실물로 읽힌다.
    //
    // **닿는 팔만 돈다.** 팔이 여럿이면 자기 범위 밖의 작업물까지 쳐다보는 게 더 이상하다 —
    // 투입 컨베이어의 탄두를 FR5 가 바라보고 있으면 라인이 거짓말을 한다.
    // 평면도 yaw θ 는 씬에서 rotation.y = +θ 다 (파일 머리의 `Z` 규약과 한 짝).
    restArms();
    // **AMR 은 자기 시간표대로 움직인다** — 작업물과 다른 시각에 다른 곳으로 간다.
    // `from` 이 없으면 아직 출발 전이라 도킹 자리에 세워 둔다.
    for (const a2 of amrNodes) {
      const seg = st.amr?.[a2.node.name];
      const src = seg?.from ? stationAt[seg.from] : null;
      const dst = seg?.to ? stationAt[seg.to] : null;
      if (!dst) { a2.node.position.set(mm(a2.dock[0]), 0, Z(mm(a2.dock[1]))); a2.node.visible = true; continue; }
      const s0 = src ?? a2.dock;
      // **부드럽게 서고 부드럽게 뜬다** — 곡선의 근거는 위 `ease`
      const kk = ease(Math.min(1, Math.max(0, seg.k)));

      // **경로를 따라간다.** 전에는 스테이션 사이를 직선으로 갔고, 그래서 화면 하단이
      // 적는 `경로 길이` 와 실제 이동이 달랐다 (실측 0.8m 대 1.9m · 2026-08-04).
      //
      // **빗나가면 직선으로 떨어진다.** 경로가 목적지를 안 지나면 따라갈수록 목적지에서
      // 멀어져 로봇이 엉뚱한 데서 멈춘다 — 그건 직선보다 나쁘다. 도달거리를 문턱으로 쓴다.
      const wp = a2.amr?.waypointsMm;
      const uTo = nearestU(wp, dst);
      const uFrom = src ? nearestU(wp, src) : { u: 0, offMm: 0 };
      const lim = a2.amr?.reachMm ?? 400;
      // ⭐ **`laneOnly` — 이 로봇은 제 경로를 절대 안 벗어난다** (2026-08-20 · 실기 담당자).
      //
      // 시나리오는 자리를 `amrAt` 으로도 쓰는데, 무대에 따라 그 자리가 **컨베이어 위**일 수
      // 있다(`defense-line` 은 자리를 통로 줄·컨베이어 줄 둘로 갈랐다). 그대로 두면 터틀봇이
      // **컨베이어를 타고 다니는 그림**이 된다.
      //
      // 한때 그럴 때 **안 그렸는데**(같은 날 1차), 실물은 사라지지 않고 **컨베이어 옆에 선다** —
      // 실기 담당자 지적. 그래서 지우는 대신 **경로 위 가장 가까운 점**에 세운다. 화면에서 로봇이
      // 계속 보이고, 갈 수 없는 자리에 서지도 않는다.
      //
      // ⚠ **기본값이 아니다.** 경로가 목적지를 통째로 빗나간 배치안(`cell` 의 옛 경로가 1664mm
      // 빗나갔다)에서 이걸 켜면 로봇이 엉뚱한 데 서 놓고 「도착했다」고 말한다. 배치안이
      // **경로를 목적지 옆으로 그렸다고 선언할 때만** 켠다.
      const laneOnly = a2.amr?.laneOnly === true;
      const onPath = Boolean(uTo && uFrom
        && (laneOnly || (uTo.offMm <= lim && uFrom.offMm <= lim)));
      // **자리를 `u` 의 함수로 뽑는다** — 아래에서 접선을 재려면 같은 식을 두 번 더 물어야 한다.
      // **AMR 은 바닥을 다닌다** — 스테이션 z 를 따라가면 팔레트 높이로 떠오른다
      const at = (u) => (onPath
        ? pointAlong(wp, uFrom.u + (uTo.u - uFrom.u) * u)
        : [s0[0] + (dst[0] - s0[0]) * u, s0[1] + (dst[1] - s0[1]) * u]);

      const [ax, ay] = at(kk);
      a2.node.position.set(mm(ax), 0, Z(mm(ay)));


      // **가는 쪽을 보고 간다.** 전에는 자리만 옮겨서 터틀봇이 늘 같은 방향을 본 채
      // **옆으로 미끄러졌다** (2026-08-10 실렌더가 잡았다). 평면도 yaw θ 는 씬에서
      // rotation.y = +θ 다 (파일 머리의 `Z` 규약과 한 짝).
      //
      // **이력이 아니라 접선으로 낸다.** 직전 자리와 비교해 각을 내면 그 값이 프레임
      // 이력에 묶여 **같은 시각을 두 번 그려도 그림이 달라진다** — 다중 패스 컷에서
      // 로봇이 튄다 (`GOAL-cine-probe` V3 가 재는 것이 정확히 이것이다). 지금 시각 좌우를
      // 한 번씩 더 물으면 각이 **`t` 의 순수 함수**가 된다.
      //
      // **거의 안 움직이면 안 돌린다** — 정지 구간에서 잔떨림이 각으로 증폭돼 로봇이
      // 제자리에서 빙빙 돈다. 그때는 직전 방향을 그대로 둔다(멈춘 로봇은 향을 지킨다).
      const E = 0.01;
      const [bx, by] = at(Math.min(1, kk + E));
      const [cx, cy] = at(Math.max(0, kk - E));
      if (Math.hypot(bx - cx, by - cy) >= 1) a2.node.rotation.y = Math.atan2(by - cy, bx - cx);
    }
    // **팔이 보는 곳** — `armAt` 이 있으면 그쪽이다 (신관을 가지러 갈 때 탄두는 안 움직인다)
    const look = (st.armAt && stationAt[st.armAt]) || [x, y, z];
    for (const slot of armSlots) {
      const A = slot.userData.arm;
      // **3D 로 잰다** — 팔은 받침 위, 작업물은 공중이라 평면 거리로는 도달을 못 판정한다
      const dx = look[0] - A.basePosMm[0]; const dy = look[1] - A.basePosMm[1];
      const dz = (look[2] ?? 0) - (A.basePosMm[2] ?? 0);
      const d = Math.hypot(dx, dy, dz);
      if (d > A.reachMm || Math.hypot(dx, dy) < 1) continue;
      // 평면도 yaw θ 가 씬 rotation.y = +θ 인 것과 같은 규약. 베이스 요각을 뺀 **상대각**이다
      const rel = Math.atan2(dy, dx) - ((A.baseYawDeg ?? 0) * Math.PI) / 180;
      aim[A.id] = {
        relDeg: Math.round((((rel * 180) / Math.PI + 540) % 360) - 180),
        distMm: Math.round(d),
        // **목표를 같이 싣는다** — 겨눔각만으로는 손끝이 자리를 안 지난다.
        // 「닿는 척」이 이 값을 받아 손끝을 당긴다 (`Shared/view3d/reach.js`)
        targetMm: [look[0], look[1], look[2] ?? 0],
      };
    }
    return true;
  }

  return {
    root,
    contents,          // 피킹 루트이자 시점 대상
    updateCutaway,   // 시점을 여기에 맞춘다 — 방까지 담으면 내용물이 작아진다
    armSlot,           // 실물(FR5) 이 붙는 자리
    armSlots,          // 전부. 이송팔은 절차적으로 이미 서 있다
    /** 지금 팔이 겨누는 상대각(도)과 거리(mm). 관절에 얹는 것은 화면 몫이다 */
    armAim: () => aim,
    /**
     * 겨눔 목표를 **월드 좌표(미터)** 로. 「닿는 척」 솔버가 쓴다 (`reach.js`).
     *
     * **변환을 여기서 한다** — 평면도 Y→씬 Z 뒤집기는 이 파일만 안다 (하드 룰 5 · §Z).
     * 화면이 직접 뒤집으면 D43(거울 사상) 이 한 번 더 난다.
     */
    aimTargetWorld(armId) {
      const g = aim[armId]?.targetMm;
      if (!g) return null;
      return contents.localToWorld(
        new THREE.Vector3(mm(g[0]), mm(g[2] ?? 0), Z(mm(g[1]))));
    },
    /**
     * **패스마다 무엇을 보일지.** 영상은 편집기와 목적이 다르다 — 도달 링·도달 범위는
     * 배치를 정할 때의 판정 근거이지, 라인이 도는 것을 보여주는 영상에서는
     * **에러 마커처럼 읽힌다** (2026-08-10 접점 시트).
     *
     * 이게 강조를 내는 자리이기도 하다. D57 이 후처리(`emissive`·`OutlinePass`)를 막았으므로
     * **무엇을 켜고 끄느냐**로 시선을 만든다 — 경로 선은 AMR 패스에서만, 작업물 표식은
     * 결합 패스에서만 (`Shared/view3d/lab/shots.js`).
     *
     * 안 준 칸은 **안 건드린다** — 화면이 쓰는 기본값을 영상 설정이 조용히 덮으면 안 된다.
     */
    setLayers(o = {}) {
      if (o.judge !== undefined) for (const r of judgeRings) r.visible = o.judge;
      if (o.reach !== undefined) for (const z of reachZones) z.visible = o.reach;
      if (o.path !== undefined) {
        // **경로 점은 편집기가 고른 AMR 을 따라간다** (`LayoutView.jsx` §amrPicked). 영상에는
        // 고른 것이 없으므로 첫 AMR 의 경로를 직접 실어 준다 — 안 그러면 `show(true)` 가
        // **빈 기즈모를 켜서** 이 플래그가 거짓말을 한다 (2026-08-10 접점 시트에서 잡았다).
        if (o.path) pathGiz.setPoints(layout.amrs?.[0]?.waypointsMm ?? []);
        pathGiz.show(o.path);
      }
      if (o.workMark !== undefined) {
        showWorkMark = o.workMark;
        if (workMark) workMark.visible = o.workMark;
      }
    },
    /**
     * 작업물을 **손끝 자리로 옮긴다** — 팔이 실제로 들고 가는 것처럼 보이게.
     *
     * `setPlayback` 은 작업물을 *자리와 자리 사이*에 둔다. 그건 "어디쯤 가고 있나" 이지
     * "누가 들고 있나" 가 아니다. 관절을 얹은 **뒤에** 이걸 부르면 같은 프레임에서 손끝에 붙는다
     * (URDF 는 화면 쪽에 있어 여기서 손끝을 알 수 없다).
     */
    setWorkAtWorld(v3) {
      if (!work?.visible || !v3) return;
      work.position.copy(v3);
      if (workMark) workMark.position.set(v3.x, v3.y - 0.06, v3.z);
    },
    /**
     * **투입 팔이 누구인가 — 배치안이 정한다.** `load` 스테이션에 닿는 팔이 투입 팔이다.
     * 이름(`fr5b`)으로 가르면 배치안을 고칠 때마다 화면 코드를 같이 고쳐야 한다.
     */
    feedArmIds: () => {
      const L2 = stationAt.load;
      if (!L2) return [];
      return (layout.arms ?? []).filter((a) => {
        const d = Math.hypot(L2[0] - a.basePosMm[0], L2[1] - a.basePosMm[1],
          (L2[2] ?? 0) - (a.basePosMm[2] ?? 0));
        return d <= a.reachMm;
      }).map((a) => a.id);
    },
    setPlayback,
    /** 실기 AMR 자세 주입 — 위 `setAmrLivePose` 참고. 평면도 좌표(mm·도) */
    setAmrLivePose,
    /** 지금 실기 자세가 얹힌 AMR id 들 — 헤드리스 판정용 */
    amrLiveIds: () => [...amrLive.keys()],
    /** 경로 편집 손잡이 — 화면이 포인터를 넘겨준다 (`path-gizmo.js`) */
    pathGizmo: pathGiz,
    /**
     * 헤드리스 판정용 — 지금 작업물이 어디 있고 몇 단계인가.
     *
     * **평면도 좌표(mm)로 되돌려 낸다.** 씬 z 를 그대로 내면 판정하는 쪽이 부호를 또 뒤집어야
     * 하고, 그 혼동이 D43(거울 사상)을 낳은 바로 그 자리다 — 이름도 `yMm` 이어야 한다.
     */
    workState: () => (work?.visible
      ? { stage: workStage, xMm: Math.round(work.position.x * 1000),
          yMm: Math.round(-work.position.z * 1000), aim: { ...aim } }
      : null),
    /** 화면 옆에 띄울 판정값. 3D 와 같은 데이터에서 나온다. */
    report: () => ({ reach: reachCheck(layout), crossings: crossings(layout) }),
    dispose() {
      // **경로 기즈모를 먼저 지운다.** 번호 라벨은 `CanvasTexture` 라 아래 `traverse` 의
      // 지오메트리 정리로는 안 없어진다 — 배치안을 고칠 때마다 이 뷰가 새로 만들어지므로
      // 안 지우면 **점을 한 번 끌 때마다 텍스처가 점 개수만큼 GPU 에 쌓인다**
      // (실측: 10번 끌자 10→50 · 2026-08-04).
      pathGiz.dispose();
      for (const g of disposables) g.dispose();
      root.traverse((o) => { if (o.isMesh || o.isLine) o.geometry?.dispose?.(); });
      root.removeFromParent();
    },
  };
}
