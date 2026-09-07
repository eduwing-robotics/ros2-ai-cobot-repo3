// 점군 스윕 볼륨 — 96개 손끝을 3D 점으로 (3층 · 계약 §화면 점군 자리 ①).
//
// **기법은 TailTree DNA 뷰에서, 미학은 안 가져온다** (D109):
//  · **내장 재질만** — 커스텀 `gl_PointSize` 셰이더가 GPU 드라이버를 얼린 전례가 있다
//  · **크기 3버킷** — `Points` 세 개면 드로우콜이 3 으로 고정된다 (점 수와 무관)
//  · 밝기는 **정점색**으로 — 여유가 작을수록 붉고 밝다
//
// ⚠ **어두운 것은 이 카드 안쪽뿐이다.** 페이지는 밝은 아카데믹 그대로다 (`tokens.css` 전례).
// ⚠ **점 하나 = 손끝 위치 하나다.** 궤적선이 아니다 — 96개를 선으로 그으면 검은 뭉치가 된다.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
// **새 의존성이 아니다** — `three` 가 같이 들고 오는 예제 모듈이다 (STACK 등재된 0.185.1).
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// 여유(mm) 기준 버킷 — **경계는 게이트 여유값이 아니라 보기 위한 구간**이라 여기 둔다.
// 판정에 안 쓰이므로 계약값이 아니다 (판정은 `judge.mjs`).
const NEAR = 50;
const MID = 200;

/**
 * 무대 — **점 6천 개만 띄우면 그게 어디인지 못 읽는다** (2026-08-12).
 * 상판은 윗면 사각형, 벽은 선분. **판정이 쓰는 여유선(`marginMm`)까지 그린다** — 점이
 * 「구역 안」인지는 상판이 아니라 **여유선** 기준이라, 상판만 그리면 붉은 점이 왜 붉은지 모른다.
 *
 * 좌표는 점과 같은 user1 mm 다 — 화면이 변환하지 않는다 (하드 룰 5).
 */
function buildStage(stage) {
  const g = new THREE.Group();
  const seg = [];
  const push = (a, b) => seg.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  const rect = (x0, x1, y0, y1, z) => {
    push([x0, y0, z], [x1, y0, z]); push([x1, y0, z], [x1, y1, z]);
    push([x1, y1, z], [x0, y1, z]); push([x0, y1, z], [x0, y0, z]);
  };
  for (const b of stage?.boxes ?? []) {
    rect(b.xMm[0], b.xMm[1], b.yMm[0], b.yMm[1], b.topZMm);
    if (b.marginMm) rect(b.xMm[0], b.xMm[1], b.yMm[0], b.yMm[1], b.topZMm + b.marginMm);
  }
  for (const w of stage?.walls ?? []) {
    const [z0, z1] = w.seenZMm ?? [-400, 400];
    push([w.aMm[0], w.aMm[1], z0], [w.aMm[0], w.aMm[1], z1]);
    push([w.bMm[0], w.bMm[1], z0], [w.bMm[0], w.bMm[1], z1]);
    push([w.aMm[0], w.aMm[1], z0], [w.bMm[0], w.bMm[1], z0]);
    push([w.aMm[0], w.aMm[1], z1], [w.bMm[0], w.bMm[1], z1]);
  }
  if (!seg.length) return null;
  // **`LineSegments` 하나** — 선을 개체마다 만들면 드로우콜이 무대 개수만큼 는다 (D109)
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x6f7b86 });
  g.add(new THREE.LineSegments(geo, mat));
  return { group: g, geo, mat };
}

export function SweepCloud({ sweep, stage, highlight }) {
  const host = useRef(null);
  const note = useRef(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !sweep?.count) return undefined;

    const W = el.clientWidth || 720;
    const H = 380;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14171a);      // 카드 안쪽만 어둡다
    const cam = new THREE.PerspectiveCamera(42, W / H, 10, 20000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(W, H);
    el.replaceChildren(renderer.domElement);

    // 버킷 셋으로 나눠 담는다 — 점 수가 늘어도 드로우콜은 3 이다
    const buckets = [[], [], []];
    const colors = [[], [], []];
    const { p, stride, owner } = sweep;
    let n = 0;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0, k = 0; i < p.length; i += stride, k += 1) {
      const [x, y, z, clear] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
      const b = clear < NEAR ? 0 : clear < MID ? 1 : 2;
      buckets[b].push(x, y, z);
      // 가까울수록 붉고 밝다. **정점색으로만** — 셰이더를 안 짠다
      const t = Math.max(0, Math.min(1, clear / MID));
      const dim = highlight !== null && highlight !== undefined && owner[k] !== highlight ? 0.25 : 1;
      colors[b].push((1 - t * 0.8) * dim, (0.35 + t * 0.6) * dim, (0.3 + t * 0.7) * dim);
      n += 1;
      for (const [d, v] of [[0, x], [1, y], [2, z]]) {
        if (v < lo[d]) lo[d] = v;
        if (v > hi[d]) hi[d] = v;
      }
    }
    const sizes = [7, 4, 2.2];
    const objs = [];
    buckets.forEach((arr, b) => {
      if (!arr.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors[b], 3));
      const m = new THREE.PointsMaterial({ size: sizes[b], vertexColors: true, sizeAttenuation: false });
      const pts = new THREE.Points(g, m);
      scene.add(pts); objs.push([g, m, pts]);
    });

    // **무대를 먼저 넣고 나서 화각을 잡는다** — 점만 감싸면 상판이 화면 밖으로 나간다
    const built = buildStage(stage);
    if (built) {
      scene.add(built.group);
      for (const b of stage.boxes ?? []) {
        for (const [x, y] of [[b.xMm[0], b.yMm[0]], [b.xMm[1], b.yMm[1]]]) {
          for (const [d, v] of [[0, x], [1, y], [2, b.topZMm]]) {
            if (v < lo[d]) lo[d] = v;
            if (v > hi[d]) hi[d] = v;
          }
        }
      }
    }

    // **바운딩 구에 맞춘다.** 앞서 x·y 폭만 보고 거리를 어림했더니 점군이 대각선 가는 띠로
    // 잡혔다 — 96개가 거의 겹쳐 z 로 길쭉한 덩어리인데 그 축을 안 봤기 때문이다 (2026-08-11).
    const mid = new THREE.Vector3(...lo.map((v, d) => (v + hi[d]) / 2));
    const radius = Math.max(1, 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
    const fit = radius / Math.sin((cam.fov * Math.PI) / 360);
    // 처음 보는 방향은 고정 — 로봇 앞쪽 비스듬히 위. 실물과 같은 손잡이(z 위)를 쓴다
    const dir = new THREE.Vector3(0.8, -1, 0.55).normalize();
    cam.position.copy(mid).addScaledVector(dir, fit * 1.05);
    cam.up.set(0, 0, 1);
    cam.lookAt(mid);
    cam.updateProjectionMatrix();

    // **돌려 볼 수 있어야 읽힌다** — 한 각도에서는 겹쳐 보이는 점이 다른 각도에서 갈린다.
    // ⚠ `damping` 을 켜면 매 프레임 `update()` 가 필요해 애니메이션 루프가 생긴다.
    //   안 켠다 — 이 카드는 **정지 화면**이고, 드래그할 때만 그린다 (배터리·GPU).
    const ctl = new OrbitControls(cam, renderer.domElement);
    ctl.enableDamping = false;
    ctl.target.copy(mid);
    ctl.addEventListener('change', () => renderer.render(scene, cam));
    ctl.update();

    renderer.render(scene, cam);
    const calls = objs.length + (built ? 1 : 0);
    if (note.current) note.current.textContent = `${sweep.count.toLocaleString()} · 드로우콜 ${calls}`;

    return () => {
      ctl.dispose();
      for (const [g, m] of objs) { g.dispose(); m.dispose(); }
      if (built) { built.geo.dispose(); built.mat.dispose(); }
      renderer.dispose();
      // ⚠ **`dispose()` 는 컨텍스트를 안 놓는다.** 모달을 여닫으면 컨텍스트가 쌓이고,
      //   브라우저 상한(보통 16)에 닿는 순간 **다음 캔버스가 조용히 안 생긴다** (2026-08-12).
      renderer.forceContextLoss();
      el.replaceChildren();
    };
  }, [sweep, stage, highlight]);

  if (!sweep?.count) return <p className="empty">점군 비어 있음</p>;
  return (
    <figure className="simchart cloud">
      <div ref={host} />
      <figcaption>
        점 <span ref={note} /> · 여유 {sweep.clearMin}–{sweep.clearMax}mm
        {' · '}<b className="near">붉은색</b> 구역에 가까움 · <b>드래그로 회전</b>
        {stage
          ? <> · 회색 선 = 상판과 여유선</>
          : <b className="warn"> · 무대 없는 회차 (다시 구우면 붙는다)</b>}
      </figcaption>
    </figure>
  );
}
