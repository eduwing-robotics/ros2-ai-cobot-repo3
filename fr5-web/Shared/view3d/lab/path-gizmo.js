// 경로 기즈모 — **AMR 이 다닐 길을 손으로 짠다.**
//
// **React 를 쓰지 않는다** (`Shared/view3d` 규약). 화면은 이걸 붙이고 포인터만 넘겨준다.
//
// **평소에는 안 그린다.** 경로 선을 상시로 두면 바닥을 가로질러 가구보다 눈에 띈다
// (실기 담당자 요청 · 2026-08-04 · `layout-view.js` §AMR). `[경로]` 를 켤 때만 나온다 —
// 타임라인·자세와 같은 문법이다.
//
// **좌표 변환을 새로 만들지 않는다.** 화면 → 바닥 mm 는 `interaction.js` 의 `floorAtMm()`
// 이 이미 한다 (같은 평면·같은 레이·같은 100mm 격자). 여기서 또 만들면 놓는 자리와 끄는
// 자리가 미묘하게 어긋난다 (하드 룰 5).

import * as THREE from 'three';

const HANDLE_MM = 90;      // 점 손잡이 반지름 — 손가락으로 잡을 만큼
const LABEL_MM = 320;      // 번호 라벨 크기 (월드) — 점보다 커야 읽힌다
const ARROW_MM = 260;      // 진행 화살표 길이

/**
 * 번호 라벨 — **캔버스에 그려 스프라이트로 띄운다.**
 *
 * 왜 스프라이트인가 — 카메라를 돌려도 숫자가 뒤집히면 안 된다. 3D 텍스트를 쓰면
 * 폰트 파일이 필요하고(에셋 0 규약), 평면 메시를 쓰면 궤도를 돌 때 옆에서 사라진다.
 */
function labelSprite(n, color) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 38px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  m.userData.tex = tex;
  return m;
}

/**
 * @param {object} o
 * @param {(mm:number)=>number} o.mm  mm → 씬 단위
 * @param {(v:number)=>number} o.Z    평면도 y → 씬 z (부호가 뒤집힌다)
 * @param {number} [o.color]
 */
export function createPathGizmo({ mm, Z, color = 0x2f6f8f }) {
  const root = new THREE.Group();
  root.name = 'pathGizmo';
  root.visible = false;

  const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
  const dotMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
  const hotMat = new THREE.MeshBasicMaterial({ color: 0xe08a2b, depthTest: false });
  const geo = new THREE.SphereGeometry(mm(HANDLE_MM), 12, 8);

  let line = null;
  let dots = [];
  let extras = [];         // 번호 라벨 · 화살표 — 잡는 대상이 아니다
  let pts = [];
  let hot = -1;

  function clear() {
    if (line) { line.geometry.dispose(); line.removeFromParent(); line = null; }
    for (const d of dots) d.removeFromParent();
    for (const e of extras) {
      e.removeFromParent();
      e.userData.tex?.dispose();
      e.material?.dispose?.();
      if (e.geometry && e.geometry !== geo) e.geometry.dispose();
    }
    dots = [];
    extras = [];
    hot = -1;
  }

  /** 점 목록을 그린다. **다시 부르면 다시 그린다** — 끌 때마다 부른다. */
  function setPoints(next) {
    pts = (next ?? []).filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [p[0], p[1]]);
    clear();
    if (!pts.length) return;
    // 선 — 바닥에서 살짝 띄운다. 0 이면 바닥과 z-fighting 이 난다
    const g = new THREE.BufferGeometry().setFromPoints(
      pts.map(([x, y]) => new THREE.Vector3(mm(x), mm(30), Z(mm(y)))),
    );
    line = new THREE.Line(g, lineMat);
    line.renderOrder = 998;
    line.raycast = () => {};                 // **잡는 것은 점뿐이다** — 선을 잡으면 무엇이 움직이나 모른다
    root.add(line);
    // **진행 화살표** — 선만 있으면 어느 쪽이 출발인지 모른다 (실기 담당자 지적 · 2026-08-04).
    // 선분 가운데에 진행 방향으로 삼각뿔을 세운다. 점 순서를 뒤집으면 같이 뒤집힌다.
    for (let i = 1; i < pts.length; i += 1) {
      const [ax, ay] = pts[i - 1]; const [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1) continue;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(mm(ARROW_MM) * 0.42, mm(ARROW_MM), 10),
        dotMat,
      );
      cone.position.set(mm((ax + bx) / 2), mm(60), Z(mm((ay + by) / 2)));
      // 원뿔은 +y 를 보고 태어난다 — 진행 방향(평면도)으로 눕힌다
      cone.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3((bx - ax) / len, 0, -(by - ay) / len),
      );
      cone.renderOrder = 998;
      cone.raycast = () => {};
      root.add(cone);
      extras.push(cone);
    }

    pts.forEach(([x, y], i) => {
      const d = new THREE.Mesh(geo, dotMat);
      d.position.set(mm(x), mm(30), Z(mm(y)));
      d.renderOrder = 999;
      d.userData.pointIndex = i;
      root.add(d);
      dots.push(d);

      // **번호** — 어느 점이 몇 번인지 화면이 말한다. 출발점(1번)만 색이 다르다
      const lab = labelSprite(i + 1, i === 0 ? '#2e8b57' : '#2f6f8f');
      lab.position.set(mm(x), mm(HANDLE_MM * 2.6), Z(mm(y)));
      lab.scale.setScalar(mm(LABEL_MM));
      lab.renderOrder = 1000;
      lab.userData.labelIndex = i;
      root.add(lab);
      extras.push(lab);
    });

    // **출발점은 크게.** 색만 다르면 흰 모형 위에서 잘 안 읽힌다
    if (dots[0]) dots[0].scale.setScalar(1.45);
  }

  function show(on) { root.visible = Boolean(on); }

  /** 화면 좌표에 있는 점 번호. 없으면 −1. */
  function pickAt(ray) {
    if (!root.visible || !dots.length) return -1;
    const hits = ray.intersectObjects(dots, false);
    return hits.length ? hits[0].object.userData.pointIndex : -1;
  }

  /** 손이 올라간 점을 표시한다 — 무엇을 잡을지 보여야 잡는다. */
  function hover(i) {
    if (hot === i) return;
    if (dots[hot]) dots[hot].material = dotMat;
    hot = i;
    if (dots[hot]) dots[hot].material = hotMat;
  }

  return {
    root,
    setPoints,
    show,
    pickAt,
    hover,
    points: () => pts.map((p) => [...p]),
    /** 점 하나를 옮긴 새 목록. **원본을 안 건드린다** — 되돌리기가 어긋난다 */
    moved: (i, atMm) => pts.map((p, k) => (k === i ? [atMm[0], atMm[1]] : [...p])),
    /**
     * `atMm` 에 가장 가까운 **선분 뒤에** 점을 끼운 새 목록.
     * 점이 하나뿐이면 뒤에 붙인다 — 선분이 없어 끼울 자리가 없다.
     */
    inserted: (atMm) => {
      if (pts.length < 2) return [...pts.map((p) => [...p]), [atMm[0], atMm[1]]];
      let best = 1; let bd = Infinity;
      for (let i = 1; i < pts.length; i += 1) {
        const [ax, ay] = pts[i - 1]; const [bx, by] = pts[i];
        const dx = bx - ax; const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.min(1, Math.max(0, ((atMm[0] - ax) * dx + (atMm[1] - ay) * dy) / l2)) : 0;
        const d = Math.hypot(atMm[0] - (ax + dx * t), atMm[1] - (ay + dy * t));
        if (d < bd) { bd = d; best = i; }
      }
      const out = pts.map((p) => [...p]);
      out.splice(best, 0, [atMm[0], atMm[1]]);
      return out;
    },
    /** 점 하나를 뺀 새 목록. **둘 밑으로는 안 줄인다** — 점 하나는 경로가 아니다 */
    removed: (i) => (pts.length <= 2 ? pts.map((p) => [...p]) : pts.filter((_, k) => k !== i).map((p) => [...p])),
    dispose() { clear(); geo.dispose(); lineMat.dispose(); dotMat.dispose(); hotMat.dispose(); },
  };
}
