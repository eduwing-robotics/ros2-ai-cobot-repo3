// 편집 인터랙션 — 고르고 · 끌고 · 돌린다.
//
// 패턴 출처: 실기 담당자의 `Jason-hub-star/ArduinoDT`
// (`src/features/breadboard-3d/three/picking/createInteraction.ts`).
// 거기서 가져온 것 넷 —
//   ① **Raycaster 피킹을 React 밖 독립 모듈로** 둔다
//   ② **호버 링 / 선택 링**으로 상태를 바닥에 표시한다 (우리 도달 링과 표현이 일관된다)
//   ③ **그리드 스냅** (`round(v/pitch)*pitch`) — 손으로 놓아도 정렬된다
//   ④ 끄는 동안은 **메시만 움직이고**, 놓을 때 데이터에 커밋한다
//
// ④ 가 중요하다. 매 프레임 배치안을 갱신해 씬을 다시 만들면 끌기가 끊긴다.
// 대신 **판정(도달 여부)은 끄는 중에도 갱신**한다 — 거리 계산 한 번이라 싸고,
// "여기 놓으면 닿나" 를 손이 움직이는 동안 알려주는 게 이 화면의 값어치다.

import * as THREE from 'three';
import { mm, toMm } from '../../data/units/units.js';

const HOVER = 0xb06d00;
const SELECT = 0x1f5f9e;

export function createInteraction({
  renderer, camera, scene, controls, pickRoot, gridMm = 100, onCommit, onPick, onMenu, bounds,
}) {
  // `pickRoot` 는 함수로도 받는다 — 배치안이 갈리면 내용물 그룹이 새로 만들어지는데,
  // 값으로 잡아두면 **죽은 그룹을 계속 겨눈다** (골라지지 않는다). 매번 물어본다.
  const rootOf = () => (typeof pickRoot === 'function' ? pickRoot() : pickRoot);
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const grab = new THREE.Vector3();       // 잡은 지점과 원점의 차이 — 안 빼면 물체가 커서로 순간이동한다

  /** 바닥 교점(월드)을 **그 물체의 부모 좌표계**로 옮긴다.
   *  `position` 은 부모 기준인데 레이캐스트 결과는 월드다 — 방 그룹이 (-6, 0, -4) 만큼
   *  밀려 있어 그냥 빼면 6m 어긋난다. 지금은 평행이동뿐이라 상수가 상쇄돼 맞아 보이지만,
   *  회전·스케일이 하나만 끼면 조용히 틀린다. */
  const toLocal = (node, v) => (node.parent ? node.parent.worldToLocal(v) : v);

  let hovered = null;
  let selected = null;            // 대표(마지막에 누른 것). 숫자칸·회전은 이걸 본다
  const group = new Set();        // 다중 선택. 대표도 여기 들어 있다
  let dragging = null;
  let dragStart = null;           // 다중 이동용 — 잡은 순간의 자리들
  let dragBox = null;             // 묶음 전체의 시작 발자국 — 방 밖으로 못 나가게 자를 기준
  // **끌기가 시작되는 문턱.** 이게 없으면 고르려고 누른 손이 1px 만 흔들려도 끌기로 쳐서
  // 격자에 스냅해 커밋한다 — 예시 좌표에 100mm 배수가 아닌 값이 여럿이라
  // **고를 때마다 물건이 최대 50mm 밀린다** (2026-07-31 배포본 실사용에서 발견).
  // 손가락은 마우스보다 흔들리므로 폰까지 덮는 값으로 잡는다.
  const SLOP_PX = 4;
  let moved = false;
  let downX = 0;
  let downY = 0;

  // 바닥 표식 — 호버·선택. **물체에 윤곽선을 그리는 것보다 싸고, 겹쳐도 안 가린다.**
  //
  // **원이 아니라 발자국 사각형이다.** 처음엔 외접원이었는데 3.8m × 0.62m 컨베이어의
  // 반대각선이 1.93m 라 좁은 쪽으로 3배 넘쳤다 (실기 담당자 지적 · 2026-08-04).
  // 비율로 줄여도 모양이 틀린 건 그대로다 — **발자국을 그리면 조절할 값이 아예 없다.**
  //
  // 물체를 빛나게 하는 길은 막혀 있다 — `parts.js` 의 재질은 전 부품이 **공유**해서
  // 하나를 물들이면 그 재질을 쓰는 게 전부 빛난다. 인스턴스마다 복제하면 공유 규약이
  // 깨진다. `OutlinePass` 는 `EffectComposer` 가 필요한데 이 화면엔 없다.
  const unitSquare = () => new THREE.BufferGeometry().setFromPoints(
    [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]]
      .map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  );

  const mkRing = (color, tick) => {
    const g = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.95, depthTest: false,
    });
    const outline = new THREE.LineLoop(unitSquare(), lineMat);
    g.add(outline);

    // **정면 표식.** 어느 쪽을 보고 있는지가 안 보이면 90° 회전이 됐는지 알 수 없다.
    // 기즈모를 붙이는 대신 눈금 하나를 둔다 — 붙잡을 게 없으니 피킹과 안 싸운다.
    let tickMesh = null;
    if (tick) {
      tickMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.15, 0.15),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide,
        }),
      );
      tickMesh.rotation.x = -Math.PI / 2;
      g.add(tickMesh);
    }
    g.renderOrder = 10;
    g.visible = false;
    scene.add(g);
    return {
      g, outline, tickMesh,
      mats: [lineMat, tickMesh?.material].filter(Boolean),
      geoms: [outline.geometry, tickMesh?.geometry].filter(Boolean),
    };
  };
  const hoverRing = mkRing(HOVER, false);
  const selectRing = mkRing(SELECT, true);

  // 다중 선택의 **나머지**를 표시할 여분 윤곽. 필요할 때 늘리고 안 지운다 (재사용).
  const extraRings = [];
  const extraRing = (i) => {
    while (extraRings.length <= i) extraRings.push(mkRing(SELECT, false));
    return extraRings[i];
  };

  // 치수 가이드 — 끄는 동안 **가장 가까운 벽·이웃까지** 선을 긋는다.
  // 3D 글자는 안 쓴다(비싸다) — 숫자는 `onPick` 으로 보내 화면 패널이 적는다.
  const guideMat = new THREE.LineBasicMaterial({
    color: HOVER, transparent: true, opacity: 0.9, depthTest: false,
  });
  const guides = [0, 1].map(() => {
    const l = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      guideMat,
    );
    l.renderOrder = 11; l.visible = false; scene.add(l); return l;
  });
  const hideGuides = () => { for (const g of guides) g.visible = false; };
  const setGuide = (i, x1, z1, x2, z2) => {
    const g = guides[i];
    g.geometry.setFromPoints([new THREE.Vector3(x1, 0.014, z1), new THREE.Vector3(x2, 0.014, z2)]);
    g.geometry.computeBoundingSphere();
    g.visible = true;
  };

  const snap = (v) => Math.round(v / gridMm) * gridMm;

  /** 맞은 메시에서 위로 올라가며 **편집 단위**(userData.item 이 붙은 노드)를 찾는다. */
  function itemOf(obj, root) {
    let n = obj;
    while (n && n !== root) {
      if (n.userData?.item) return n;
      n = n.parent;
    }
    return null;
  }

  /** 편집 단위 목록. 내용물이 갈리면 새로 모은다 — 죽은 노드를 겨누면 안 골라진다. */
  let itemCache = { root: null, list: [] };
  function itemsOf(root) {
    if (itemCache.root !== root) {
      const list = [];
      root.traverse((o) => { if (o.userData?.item) list.push(o); });
      itemCache = { root, list };
    }
    return itemCache.list;
  }

  /**
   * 고른다 — **레이캐스트 먼저, 화면 근접이 이긴다.**
   *
   * 레이캐스트만 쓰면 작은 것(터틀봇 280mm)이 큰 가구 뒤에 있을 때 영영 못 고른다.
   * 커서가 어떤 물건의 **가운데에서 SNAP_PX 안**이면 그쪽을 준다 — 그 자리를 가리켰다는
   * 뜻이기 때문이다 (`thebuggeddev/anatomy` `hotspots.ts` 의 `pick()` 과 같은 발상).
   * 큰 물건은 가운데가 멀어 이 규칙에 안 걸리므로 평소 조작은 그대로다.
   */
  const SNAP_PX = 20;
  // **작은 것만 도와준다.** 처음엔 크기를 안 가렸더니 벤치와 그 위 상부장처럼 가운데가
  // 가까운 큰 것끼리 서로 클릭을 훔쳤다 (실렌더에서 잡았다 · 2026-08-04).
  // 큰 물건은 어디를 눌러도 레이캐스트로 잡히므로 도와줄 이유가 없다.
  const SMALL_M = 1.0;
  const _p = new THREE.Vector3();
  function pickAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    const px = ev.clientX - r.left; const py = ev.clientY - r.top;
    ptr.x = (px / r.width) * 2 - 1;
    ptr.y = -(py / r.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    const root = rootOf();
    if (!root) return null;

    let near = null; let nearD = SNAP_PX;
    for (const o of itemsOf(root)) {
      const f = fitOf(o);
      o.getWorldPosition(_p);
      _p.set(_p.x + f.dx, 0.1, _p.z + f.dz).project(camera);
      if (_p.z > 1) continue;
      const d = Math.hypot(((_p.x + 1) / 2) * r.width - px, ((1 - _p.y) / 2) * r.height - py);
      if (d < nearD) { nearD = d; near = o; }
    }
    if (near) {
      const f = fitOf(near);
      if (Math.max(f.w, f.d) < SMALL_M) return near;
    }

    const hits = ray.intersectObject(root, true);
    for (const h of hits) {
      const it = itemOf(h.object, root);
      if (it) return it;
    }
    return near;                        // 아무것도 안 맞았으면 가까운 것이라도 준다
  }

  // 링은 `scene` 에 직접 붙는다 — 그러니 **월드 좌표**로 놔야 한다.
  // 물체의 `position` 을 그대로 쓰면 방 그룹 오프셋만큼 어긋난 자리에 링이 뜬다.
  //
  // **원점이 아니라 상자 가운데를 쓴다.** 문·창 그룹은 원점이 (0,0,0) 이고 자식이 절대좌표를
  // 들고 있어서, 원점에 링을 놓으면 방 구석에 떴다 (실기 담당자 지적 · 2026-08-04).
  // 상자는 **고를 때 한 번만** 재고 그 뒤로는 옮긴 만큼 따라간다 — 끄는 동안 매 프레임
  // 33개 메시를 다시 재면 손이 무거워진다.
  const _w = new THREE.Vector3();
  const _box = new THREE.Box3();
  const _c = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const fits = new WeakMap();          // 노드 → { dx, dz, w, d } · 노드가 갈리면 같이 사라진다
  const MIN_M = 0.32;                  // 320mm 척도 눈에 보이게 — 이보다 작아지지 않는다

  /**
   * 발자국 상자. **고를 때 한 번만** 재고 그 뒤로는 옮긴 만큼 따라간다 —
   * 끄는 동안 매 프레임 33개 메시를 다시 재면 손이 무거워진다.
   *
   * 원점이 아니라 **상자 가운데**를 쓴다. 문·창 그룹은 원점이 (0,0,0) 이고 자식이
   * 절대좌표를 들고 있어서, 원점에 표식을 놓으면 방 구석에 떴다.
   *
   * 상자는 **월드 축 정렬**이다. 우리 회전은 90° 단위뿐이라 그게 곧 돌아간 발자국이다
   * (자유 각도를 쓰게 되면 그때는 조금 넘친다 — 그 값이 필요해지면 로컬 상자로 바꾼다).
   */
  function fitOf(node) {
    let f = fits.get(node);
    if (!f) {
      // **발자국을 대신 재는 자식**을 지정할 수 있다. 팔이 그 경우다 — 도달 링(1.8m)과
      // URDF 까지 재면 선택 윤곽이 방만 해진다. 베이스 판만 재면 실제 점유 면적이 나온다.
      _box.setFromObject(node.userData?.fitFrom ?? node);
      _box.getCenter(_c); _box.getSize(_s);
      node.getWorldPosition(_w);
      f = {
        dx: _c.x - _w.x, dz: _c.z - _w.z,
        w: Math.max(MIN_M, _s.x), d: Math.max(MIN_M, _s.z),
      };
      fits.set(node, f);
    }
    return f;
  }

  function ringTo(ring, node) {
    if (!node) { ring.g.visible = false; return; }
    const f = fitOf(node);
    node.getWorldPosition(_w);
    ring.g.position.set(_w.x + f.dx, 0.012, _w.z + f.dz);
    ring.outline.scale.set(f.w, 1, f.d);
    if (ring.tickMesh) {
      // 정면은 물체의 **로컬 +z** (rotDeg 0 기준). 그 방향 반 칸 밖에 눈금을 둔다 —
      // 상자가 월드 정렬이라 앞으로 나가는 거리도 축별로 섞어 낸다.
      const a = node.rotation.y;
      const sa = Math.sin(a); const ca = Math.cos(a);
      const out = Math.abs(sa) * (f.w / 2) + Math.abs(ca) * (f.d / 2) + 0.09;
      ring.tickMesh.position.set(sa * out, 0, ca * out);
      ring.tickMesh.rotation.z = -a;
    }
    ring.g.visible = true;
  }

  /** 선택 표시를 통째로 다시 그린다 — 대표는 정면 눈금까지, 나머지는 윤곽만. */
  function showSelection() {
    ringTo(selectRing, selected);
    const rest = [...group].filter((n) => n !== selected);
    rest.forEach((n, i) => ringTo(extraRing(i), n));
    for (let i = rest.length; i < extraRings.length; i += 1) ringTo(extraRings[i], null);
  }

  /**
   * 끄는 동안 **가장 가까운 벽·이웃까지의 빈 거리**를 낸다.
   *
   * 배치를 정하는 일은 "이 벤치를 벽에서 얼마나 띄우나" 가 전부다. 지금까지는 숫자칸에
   * 좌표를 넣어 역산해야 했다 — 좌표가 아니라 **틈**이 알고 싶은 값이다.
   */
  function gapsOf(node) {
    const B = bounds?.();
    const f = fitOf(node);
    node.getWorldPosition(_w);
    const cx = _w.x + f.dx; const cz = _w.z + f.dz;
    const a0 = { x1: cx - f.w / 2, x2: cx + f.w / 2, z1: cz - f.d / 2, z2: cz + f.d / 2 };
    const out = { xMm: null, zMm: null };
    // 축마다 **더 가까운 쪽 하나**만 본다. 양쪽을 다 그리면 화면이 선으로 덮인다.
    const best = { x: null, z: null };
    const consider = (ax, gap, seg) => {
      if (gap < -0.001) return;                     // 이미 겹쳤다 — 가이드로 말할 게 없다
      if (!best[ax] || gap < best[ax].gap) best[ax] = { gap, seg };
    };
    if (B) {
      const w = B.widthMm / 1000; const d = B.depthMm / 1000;
      consider('x', a0.x1 - 0, [0, cz, a0.x1, cz]);
      consider('x', w - a0.x2, [a0.x2, cz, w, cz]);
      consider('z', -0 - a0.z2, [cx, a0.z2, cx, 0]);          // 씬 Z 는 음수쪽이 방 안 (D43)
      consider('z', a0.z1 + d, [cx, -d, cx, a0.z1]);
    }
    for (const o of itemsOf(rootOf())) {
      if (o === node || group.has(o)) continue;
      const g2 = fitOf(o);
      o.getWorldPosition(_p);
      const bx = _p.x + g2.dx; const bz = _p.z + g2.dz;
      const b0 = { x1: bx - g2.w / 2, x2: bx + g2.w / 2, z1: bz - g2.d / 2, z2: bz + g2.d / 2 };
      if (Math.min(a0.z2, b0.z2) - Math.max(a0.z1, b0.z1) > 0) {      // z 가 겹치면 x 이웃
        if (b0.x2 <= a0.x1) consider('x', a0.x1 - b0.x2, [b0.x2, cz, a0.x1, cz]);
        if (b0.x1 >= a0.x2) consider('x', b0.x1 - a0.x2, [a0.x2, cz, b0.x1, cz]);
      }
      if (Math.min(a0.x2, b0.x2) - Math.max(a0.x1, b0.x1) > 0) {      // x 가 겹치면 z 이웃
        if (b0.z2 <= a0.z1) consider('z', a0.z1 - b0.z2, [cx, b0.z2, cx, a0.z1]);
        if (b0.z1 >= a0.z2) consider('z', b0.z1 - a0.z2, [cx, a0.z2, cx, b0.z1]);
      }
    }
    hideGuides();
    let i = 0;
    for (const ax of ['x', 'z']) {
      if (!best[ax]) continue;
      out[`${ax}Mm`] = Math.round(best[ax].gap * 1000);
      setGuide(i, ...best[ax].seg); i += 1;
    }
    return out;
  }

  function onMove(ev) {
    if (dragging) {
      // 문턱을 넘기 전에는 **아무것도 건드리지 않는다.** 여기서 막아야 메시도 안 움직이고
      // 데이터도 안 바뀐다 — 놓을 때만 막으면 화면과 배치안이 갈라진다
      if (!moved) {
        if (Math.hypot(ev.clientX - downX, ev.clientY - downY) < SLOP_PX) return;
        moved = true;
      }
      const r = renderer.domElement.getBoundingClientRect();
      ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ptr, camera);
      if (!ray.ray.intersectPlane(floor, hit)) return;
      toLocal(dragging, hit);
      const it0 = dragging.userData.item;

      // **벽에 붙은 것(문·창)은 벽을 따라서만 미끄러진다.**
      // 좌표가 `[x,y]` 가 아니라 `어느 벽 · 벽 위 몇 mm` 라서, 자유 이동은 표현할 데가 없다.
      // 벽을 바꾸는 것은 옆 패널의 드롭다운이 한다.
      if (it0?.wall) {
        const along = it0.axis === 'x' ? toMm(hit.x) : -toMm(hit.z);   // 씬 Z → 평면도 Y (D43)
        const half = (it0.widthMm ?? 900) / 2;
        const at = Math.min(Math.max(snap(along), half), (it0.spanMm ?? 0) - half);
        // 그룹을 통째로 밀어 **끄는 동안에도 보이게** 한다. 놓으면 데이터가 다시 그린다.
        const d = mm(at - it0.atMm);
        dragging.position.set(it0.axis === 'x' ? d : 0, 0, it0.axis === 'x' ? 0 : -d);
        ringTo(selectRing, dragging);
        onPick?.({ ...it0, atMm: at, live: true });
        return;
      }

      // **그리드 스냅.** 손으로 놓아도 줄이 맞는다 (ArduinoDT 의 2.54mm 스냅과 같은 발상)
      let xMm = snap(toMm(hit.x - grab.x));
      let zMm = snap(-toMm(hit.z - grab.z));      // 씬 Z → 평면도 Y (부호 반전 · D43)

      // **하나든 여럿이든 같은 길로 간다** — 대표의 이동량을 내고, 묶음 전체가 방을
      // 안 넘도록 그 이동량을 자른 뒤, 모두에게 똑같이 적용한다.
      // 각자 스냅하면 줄이 흐트러지고, 단일만 클램프하면 여럿일 때 방을 넘는다
      // (둘 다 실렌더에서 잡았다 · 2026-08-04).
      const p0 = dragStart.get(dragging);
      let dx = mm(xMm) - p0.x;
      let dz = -mm(zMm) - p0.z;                 // 평면도 Y → 씬 Z (부호 반전 · D43)
      const B = bounds?.();
      if (B && dragBox) {
        const W = mm(B.widthMm); const D = mm(B.depthMm);
        // 씬 Z 는 방 안이 음수다 — z ∈ [−D, 0]
        dx = Math.min(Math.max(dx, -dragBox.x1), Math.max(-dragBox.x1, W - dragBox.x2));
        dz = Math.min(Math.max(dz, -D - dragBox.z1), Math.max(-D - dragBox.z1, -dragBox.z2));
      }
      for (const n of group) {
        const q = dragStart.get(n);
        n.position.set(q.x + dx, n.position.y, q.z + dz);
      }
      xMm = Math.round(toMm(dragging.position.x));
      zMm = Math.round(-toMm(dragging.position.z));
      showSelection();
      // 끄는 중에도 판정을 갱신한다 — "여기 놓으면 닿나" 를 손이 움직일 때 알려준다
      onPick?.({
        ...dragging.userData.item, posMm: [xMm, zMm], live: true,
        gapsMm: group.size > 1 ? null : gapsOf(dragging),
        count: group.size,
      });
      return;
    }
    const it = pickAt(ev);
    if (it !== hovered) {
      hovered = it;
      ringTo(hoverRing, it && it !== selected ? it : null);
      renderer.domElement.style.cursor = it ? 'grab' : '';
    }
  }

  function onDown(ev) {
    if (ev.button !== 0) return;
    onMenu?.(null);                       // 어디를 누르든 열린 메뉴는 닫는다
    const it = pickAt(ev);

    // **Shift 는 묶는다.** 이미 묶여 있으면 뺀다 — 잘못 넣었을 때 되돌릴 길이 있어야 한다.
    if (ev.shiftKey && it) {
      if (group.has(it) && it !== selected) group.delete(it);
      else { group.add(it); selected = it; }
      if (!group.has(selected)) selected = [...group][group.size - 1] ?? null;
    } else if (it && group.has(it)) {
      // **이미 묶인 것을 잡으면 묶음을 유지한다.** 안 그러면 여럿을 골라 놓고
      // 끌려는 순간 묶음이 풀려 하나만 움직인다 (실렌더에서 잡았다 · 2026-08-04).
      selected = it;
    } else {
      group.clear();
      selected = it;
      if (it) group.add(it);
    }
    showSelection();
    ringTo(hoverRing, null);
    if (!it) { onPick?.(null); return; }

    // 잡은 지점과 물체 원점의 차이를 기억한다 — 안 하면 물체가 커서로 튄다
    const r = renderer.domElement.getBoundingClientRect();
    ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    if (ray.ray.intersectPlane(floor, hit)) {
      toLocal(it, hit);
      grab.set(hit.x - it.position.x, 0, hit.z - it.position.z);
    }

    dragging = it;
    dragStart = new Map([...group].map((n) => [n, n.position.clone()]));
    dragBox = null;
    for (const n of group) {
      const f = fitOf(n);
      n.getWorldPosition(_w);
      const cx = _w.x + f.dx; const cz = _w.z + f.dz;
      const b2 = { x1: cx - f.w / 2, x2: cx + f.w / 2, z1: cz - f.d / 2, z2: cz + f.d / 2 };
      dragBox = dragBox ? {
        x1: Math.min(dragBox.x1, b2.x1), x2: Math.max(dragBox.x2, b2.x2),
        z1: Math.min(dragBox.z1, b2.z1), z2: Math.max(dragBox.z2, b2.z2),
      } : b2;
    }
    moved = false;
    downX = ev.clientX;
    downY = ev.clientY;
    renderer.domElement.style.cursor = 'grabbing';
    // **여기서 즉시 끈다.** 틱에서 끄면 늦다 — OrbitControls 가 먼저 등록돼 있어
    // 같은 pointerdown 으로 이미 궤도를 시작해 버린다. 실제로 카메라가 55m 밖으로 날아갔다.
    // 그래서 이 리스너를 **캡처 단계**에 걸고(아래) 여기서 동기로 끈다.
    if (controls) controls.enabled = false;
    ev.stopPropagation();
    // 합성 이벤트(헤드리스 검증)에서는 pointerType 이 없어 던진다 — 검증을 막지 않는다
    try { ev.target.setPointerCapture?.(ev.pointerId); } catch { /* 합성 이벤트 */ }
    onPick?.({
      ...it.userData.item, posMm: [toMm(it.position.x), -toMm(it.position.z)],
      count: group.size,
    });
  }

  function onUp(ev) {
    if (!dragging) return;
    const it = dragging;
    dragging = null;
    dragStart = null;
    dragBox = null;
    hideGuides();
    renderer.domElement.style.cursor = 'grab';
    if (controls) controls.enabled = true;
    try { ev.target.releasePointerCapture?.(ev.pointerId); } catch { /* 합성 이벤트 */ }
    // **고르기만 한 것은 편집이 아니다.** 문턱을 안 넘었으면 배치안을 건드리지 않는다 —
    // 안 그러면 클릭 한 번에 저장 배지가 뜨고 되돌리기 기록이 쌓인다
    if (!moved) return;
    // **여기서 데이터에 커밋한다.** 끄는 동안은 메시만 움직였다.
    const it1 = it.userData.item;
    if (it1?.wall) {
      // 그룹을 민 거리를 되돌려 읽는다 — 원래 `atMm` + 민 거리
      const moveMm = it1.axis === 'x' ? toMm(it.position.x) : -toMm(it.position.z);
      onCommit?.({ ...it1, atMm: Math.round(it1.atMm + moveMm) });
      return;
    }
    if (group.size > 1) {
      // **한 번에 보낸다** — 하나씩 보내면 되돌리기가 물건 수만큼 쌓인다
      onCommit?.({
        many: [...group].map((n) => ({
          ...n.userData.item, posMm: [toMm(n.position.x), -toMm(n.position.z)],
        })),
      });
      return;
    }
    onCommit?.({ ...it1, posMm: [toMm(it.position.x), -toMm(it.position.z)] });
  }

  /** 90° 씩 돌린다. 벽에 붙이는 가구라 자유 각도는 쓸 일이 없다.
   *  **키가 아니라 함수로 뺐다** — 폰에는 키보드가 없어 버튼에서도 같은 걸 불러야 한다. */
  function rotate() {
    if (!selected) return false;
    selected.rotation.y -= Math.PI / 2;
    fits.delete(selected);                    // 돌면 상자가 바뀐다 — 다시 잰다
    ringTo(selectRing, selected);
    const deg = Math.round((-selected.rotation.y * 180) / Math.PI) % 360;
    onCommit?.({ ...selected.userData.item, rotDeg: deg });
    return true;
  }
  function onKey(ev) {
    if (ev.key === 'r' || ev.key === 'R') rotate();
    if (ev.key === 'Escape') {
      selected = null; group.clear(); showSelection(); hideGuides();
      onPick?.(null); onMenu?.(null);
    }
  }

  /**
   * 우클릭 — **고르고 메뉴를 연다.** 고르기를 같이 하는 이유는, 안 그러면 다른 것이
   * 선택된 채로 메뉴만 떠서 어느 것에 대한 메뉴인지 알 수 없기 때문이다.
   * 빈 곳에서는 브라우저 기본 메뉴를 그대로 둔다 — 새로고침·검사를 막지 않는다.
   */
  function onContext(ev) {
    const it = pickAt(ev);
    if (!it) { onMenu?.(null); return; }
    ev.preventDefault();
    selected = it;
    ringTo(selectRing, it);
    ringTo(hoverRing, null);
    onPick?.({ ...it.userData.item, posMm: [toMm(it.position.x), -toMm(it.position.z)] });
    // **캔버스 기준 좌표로 준다.** 메뉴는 3D 컨테이너 안에 얹히므로 뷰포트 좌표를
    // 그대로 주면 컨테이너가 밀린 만큼(팔레트 폭·머리글 높이) 화면 밖으로 나간다.
    const r = renderer.domElement.getBoundingClientRect();
    onMenu?.({ item: it.userData.item, x: ev.clientX - r.left, y: ev.clientY - r.top });
  }

  const el = renderer.domElement;
  // **터치에서 브라우저 제스처를 끈다.** 안 하면 손가락으로 끌 때 페이지가 스크롤되고
  // pointercancel 이 날아와 끌기가 중간에 끊긴다 (폰에서만 재현되는 종류의 버그다).
  el.style.touchAction = 'none';
  // **캡처 단계**로 건다. OrbitControls 는 버블 단계라 우리가 먼저 돌고,
  // 물체를 집었으면 `stopPropagation()` 으로 궤도 시작 자체를 막는다.
  el.addEventListener('pointermove', onMove, true);
  el.addEventListener('pointerdown', onDown, true);
  el.addEventListener('pointerup', onUp, true);
  el.addEventListener('contextmenu', onContext);
  addEventListener('keydown', onKey);

  return {
    /** 끄는 중에는 궤도를 막아야 한다 — 화면 쪽에서 이 값을 보고 controls 를 끈다 */
    isDragging: () => Boolean(dragging),
    /**
     * 화면 좌표 → **바닥의 배치안 좌표(mm)**. 팔레트에서 끌어다 놓을 때 쓴다.
     *
     * 끌기가 쓰는 **같은 평면·같은 레이**를 쓴다 — 변환을 또 만들면 놓는 자리와
     * 끄는 자리가 미묘하게 어긋난다 (하드 룰 5). 격자에도 같이 붙인다.
     * 바닥을 안 맞으면(하늘을 가리키면) `null` 이다.
     */
    floorAtMm(clientX, clientY) {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.x = ((clientX - r.left) / r.width) * 2 - 1;
      ptr.y = -((clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ptr, camera);
      if (!ray.ray.intersectPlane(floor, hit)) return null;
      const snap = (v) => Math.round((v * 1000) / gridMm) * gridMm;
      return [snap(hit.x), snap(-hit.z)];      // 씬 z → 평면도 y (부호가 뒤집힌다)
    },
    rotate,
    /** 지금 고른 것들의 id — 삭제·복제가 이걸 쓴다. */
    selectedIds: () => [...group].map((n) => n.userData.item.id),
    /**
     * 내용물이 새로 만들어진 뒤 **id 로 다시 잡는다.**
     *
     * 배치안이 바뀌면 3D 노드가 통째로 새로 만들어진다. 안 다시 잡으면 선택 표식이
     * **죽은 노드**를 가리켜, 크기를 바꿔도 윤곽이 옛 크기로 남는다 (2026-08-04).
     */
    reselect(ids = [], primaryId = null) {
      const root = rootOf();
      group.clear(); selected = null;
      if (root && ids.length) {
        const want = new Set(ids);
        for (const o of itemsOf(root)) {
          if (!want.has(o.userData.item.id)) continue;
          group.add(o);
          if (!selected || o.userData.item.id === primaryId) selected = o;
        }
      }
      showSelection();
    },
    clear() {
      selected = null; hovered = null; group.clear();
      showSelection(); ringTo(hoverRing, null); hideGuides(); onPick?.(null);
    },
    dispose() {
      el.removeEventListener('pointermove', onMove, true);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointerup', onUp, true);
      el.removeEventListener('contextmenu', onContext);
      removeEventListener('keydown', onKey);
      for (const g of guides) { g.geometry.dispose(); g.removeFromParent(); }
      guideMat.dispose();
      for (const r of [hoverRing, selectRing, ...extraRings]) {
        for (const g of r.geoms) g.dispose();
        for (const m of r.mats) m.dispose();
        r.g.removeFromParent();
      }
      el.style.cursor = '';
    },
  };
}
