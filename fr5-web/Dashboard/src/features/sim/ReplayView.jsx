// 3층 재생 — **인스턴스 하나를 실제 팔로 다시 걷는다.**
//
// ⛔ **three.js 렌더를 새로 짜지 않는다** (`SIM-CONTRACT.md` §폴더). 팔·구역·궤적은
//    `Shared/view3d` 것을 그대로 쓴다 — 어제 여기서 손으로 와이어프레임을 그렸다가
//    「로봇이 없는 그림」이 됐다 (2026-08-12).
//
// 두 겹으로 그린다:
//   ① **재생** — URDF 팔 + 판정면 + 손끝 궤적. 프로그램이 무엇을 하는지 본다
//   ② **시뮬레이션이 보는 것**(토글) — 엔진이 판정에 쓰는 **충돌 형상**과 **접촉 개수**.
//      ①은 엔진이 없어도 똑같이 나오지만 ②는 엔진만 안다. 그래서 토글이 증거다.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { createStage } from '@fr5/shared/view3d/lab/stage.js';
import { loadConfig, loadRobot, setJointsDeg, mountRobotYUp } from '@fr5/shared/view3d/robot.js';
import { makeWorkspace, toBase } from '@fr5/shared/view3d/workspace.js';
import { tipPath, makeTube } from '@fr5/shared/view3d/path.js';
import { URDF_BASE_Z_MM } from '@fr5/shared/data/workcell.js';
import { mm } from '@fr5/shared/data/units/units.js';
import { simSource } from '@fr5/shared/data/datasource/index.js';

const JOINTS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
/** 궤적 관은 표본을 솎아 만든다 — 120프레임을 다 쓰면 관이 톱니처럼 접힌다 */
const TUBE_EVERY = 2;

/** 프레임 k 의 관절각을 `{j1..j6}` 로. `deg` 는 instance→frame→joint 평평한 배열이다. */
const frameAt = (deg, k, nj) => Object.fromEntries(
  JOINTS.slice(0, nj).map((n, j) => [n, deg[k * nj + j]]),
);

export function ReplayView({ deg, frameCount, jointCount, robotId, workspace, userDef, showSim, onToggleSim }) {
  const host = useRef(null);
  const api = useRef(null);                 // 렌더 루프가 읽는 손잡이 (리렌더를 안 태운다)
  const [k, setK] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [simState, setSimState] = useState({ on: false, ncon: null, err: null, loading: false });
  const kRef = useRef(0); kRef.current = k;
  const playRef = useRef(playing); playRef.current = playing;

  // ── 장면은 한 번만 세운다 ────────────────────────────────────────────────
  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    // **무대는 `Shared` 한 벌** (phase 2 · 2026-09-05) — FR5 `RobotTwin` 과 같은 조명·환경·그림자다.
    const stage = createStage(el, { background: 0xeae8e5 });   // 밝은 테마 (D38) — 어둡게 하지 않는다
    const { scene, camera: cam, renderer, controls: ctl } = stage;
    cam.fov = 45; cam.near = 0.01; cam.far = 100; cam.updateProjectionMatrix();
    cam.position.set(1.9, 1.5, 1.9);
    ctl.target.set(0, 0.1, 0);

    // Z-up→Y-up 은 `Shared` 한 곳에서만 (`mountRobotYUp`) — 여기서 축을 바꾸지 않는다
    const holder = mountRobotYUp(null);
    scene.add(holder);
    // 판정면 — 게이트 값은 사용자 좌표계라 베이스로 환산해서 준다. 환산이 안 되면 안 그린다
    holder.add(makeWorkspace(toBase(workspace ?? null, userDef ?? null)));
    // 엔진 형상은 같은 홀더에 넣는다 — 엔진도 Z-up·미터라 **좌표 변환이 필요 없다**
    const simGroup = new THREE.Group();
    simGroup.visible = false;
    holder.add(simGroup);

    let robot = null;
    let disposed = false;
    let last = 0;
    const { gripper } = loadConfig();
    loadRobot({ urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf', gripperCfg: gripper, gripperDir: '/PGEA_100_40/' })
      .then((r) => {
        if (disposed) return;
        robot = r.robot;
        robot.position.z = mm(URDF_BASE_Z_MM);
        holder.add(robot);
        // 손끝 궤적 — **관은 로봇의 자식으로** 붙인다 (`path.js` 주석: 월드로 붙이면 스케일이 섞인다)
        const path = [];
        for (let f = 0; f < frameCount; f += TUBE_EVERY) path.push(frameAt(deg, f, jointCount));
        if (path.length > 1) robot.add(makeTube(tipPath(robot, path)));
        el.dataset.ready = '1';                     // 실렌더 검증이 이 깃발을 본다
      })
      .catch((e) => { el.dataset.error = String(e.message || e); });

    const tick = () => {
      const t = performance.now();
      // 재생 속도는 **한 바퀴 6초** 고정 — 실기 속도로 돌리면 45초짜리를 끝까지 볼 사람이 없다
      if (playRef.current && frameCount > 1) {
        if (!last) last = t;
        if (t - last > 6000 / frameCount) { last = t; setK((v) => (v + 1) % frameCount); }
      } else { last = 0; }
      if (robot) setJointsDeg(robot, frameAt(deg, kRef.current, jointCount));
    };
    stage.onTick(tick);   // 궤도 갱신·렌더는 무대가 한다

    api.current = { scene, simGroup, holder, render: () => renderer.render(scene, cam) };
    return () => {
      disposed = true;
      stage.dispose();          // 컨텍스트까지 놓는다 (stage.js §dispose · 2026-08-12 의 교훈이 무대로 갔다)
      el.replaceChildren();
      api.current = null;
    };
  }, [deg, frameCount, jointCount, workspace, userDef]);

  // ── 「시뮬레이션이 보는 것」 — 엔진을 **누를 때 처음** 받는다 (9.7MB) ──────────
  const simRef = useRef(null);
  useEffect(() => {
    const g = api.current?.simGroup;
    if (!g) return;
    g.visible = showSim;
    if (!showSim || simRef.current || simState.loading) return;
    setSimState((s) => ({ ...s, loading: true }));
    // 장면은 **datasource 로** 받는다 — 이 화면은 `Sim/out/…` 이라는 경로를 모른다
    Promise.all([import('@fr5/shared/view3d/sim-scene.js'), simSource.getSceneXml(robotId)])
      .then(([{ openSimScene }, xml]) => openSimScene(xml))
      .then((s) => { simRef.current = s; setSimState({ on: true, ncon: null, err: null, loading: false }); })
      .catch((e) => setSimState({ on: false, ncon: null, err: String(e.message || e), loading: false }));
  }, [showSim, simState.loading, robotId]);

  // 프레임이 바뀔 때마다 엔진에 그 자세를 물어 형상을 다시 놓는다
  useEffect(() => {
    const s = simRef.current;
    const g = api.current?.simGroup;
    if (!showSim || !s || !g) return;
    const { geoms, ncon, contacts } = s.at(JOINTS.slice(0, jointCount).map((_, j) => deg[k * jointCount + j]));
    syncGeoms(g, geoms, contacts);
    api.current.render();
    setSimState((v) => (v.ncon === ncon ? v : { ...v, ncon }));
  }, [k, showSim, deg, jointCount, simState.on]);

  useEffect(() => () => { simRef.current?.dispose(); simRef.current = null; }, []);

  const pct = frameCount > 1 ? Math.round((k / (frameCount - 1)) * 100) : 0;
  return (
    <div className="replay">
      <div className="replay-3d" ref={host} data-t="replay" />
      <div className="replay-bar">
        <button type="button" onClick={() => setPlaying((v) => !v)} aria-pressed={playing}>
          {playing ? '❙❙ 멈춤' : '▶ 재생'}
        </button>
        <input
          type="range" min="0" max={Math.max(0, frameCount - 1)} value={k}
          aria-label="진행률"
          onChange={(e) => { setPlaying(false); setK(Number(e.target.value)); }}
        />
        <b className="pct">{pct}%</b>
        <label className="simtoggle">
          {/* ⚠ **불리언 하나로 받는다.** 객체를 그대로 받았더니 `if (!showSim)` 이 늘 거짓이라
              토글과 무관하게 엔진(9.7MB)이 매번 즉시 로드됐다 (2026-08-12 게이트가 잡았다) */}
          <input type="checkbox" checked={showSim} onChange={(e) => onToggleSim(e.target.checked)} />
          시뮬레이션 형상
        </label>
      </div>
      <p className="replay-note">
        {simState.err && <b className="warn">엔진 실패: {simState.err}</b>}
        {!simState.err && simState.loading && '엔진 받는 중 9.7MB'}
        {!simState.err && !simState.loading && showSim && simState.on && (
          <>판정용 충돌 형상 · <b className="dot">●</b> 접촉 <b>{simState.ncon ?? '—'}</b>곳</>
        )}
        {!simState.err && !simState.loading && !showSim && 'URDF 팔 · 판정면 · 손끝 궤적'}
      </p>
    </div>
  );
}

/**
 * 엔진 geom 목록 → three.js. **개수가 그대로면 자리만 옮긴다** (매 프레임 새로 만들면
 * 스크럽할 때 GC 가 튄다). 메시(7)·평면(0)은 건너뛴다 — 재생 층이 이미 그린 것이다.
 */
function syncGeoms(group, geoms, contacts = []) {
  // 접촉점은 **작은 구 하나**로 붙여 같은 목록에서 관리한다 — 드로우콜을 나누지 않는다
  const want = geoms.filter((g) => g.type !== 7 && g.type !== 0)
    .concat(contacts.map((pos) => ({ type: 2, pos, mat: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      size: [0.012, 0.012, 0.012], contact: true })));
  while (group.children.length > want.length) {
    const m = group.children.pop();
    m.geometry?.dispose?.(); m.material?.dispose?.();
  }
  want.forEach((g, i) => {
    let m = group.children[i];
    const geo = shapeFor(g);
    if (!m) {
      m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false }));
      group.add(m);
    } else if (m.userData.key !== geo.userData.key) {
      m.geometry.dispose(); m.geometry = geo;
    } else { geo.dispose(); }
    m.userData.key = m.geometry.userData.key;
    m.position.set(g.pos[0], g.pos[1], g.pos[2]);
    // 엔진은 **행 우선** 3×3 을 준다. three 는 `Matrix4.set` 이 행 우선이라 그대로 넣는다
    m.setRotationFromMatrix(new THREE.Matrix4().set(
      g.mat[0], g.mat[1], g.mat[2], 0,
      g.mat[3], g.mat[4], g.mat[5], 0,
      g.mat[6], g.mat[7], g.mat[8], 0,
      0, 0, 0, 1,
    ));
    // 접촉점은 **채워서 진하게** — 충돌 형상(반투명 와이어)과 한눈에 갈려야 한다
    m.material.wireframe = !g.contact;
    m.material.color.setRGB(...(g.contact ? [0.15, 0.6, 0.35] : [0.85, 0.22, 0.16]));
    m.material.opacity = g.contact ? 1 : 0.5;
  });
}

/** 매핑 근거 — `zalo/mujoco_wasm` `src/mujocoUtils.js`. **캡슐·상자는 size 가 반값**이다. */
function shapeFor(g) {
  const [a, b, c] = g.size;
  let geo;
  let key;
  switch (g.type) {
    case 2: geo = new THREE.SphereGeometry(a, 12, 8); key = `s${a}`; break;
    case 3: geo = new THREE.CapsuleGeometry(a, b * 2, 6, 10); key = `c${a},${b}`; break;
    case 4: geo = new THREE.SphereGeometry(1, 12, 8); geo.scale(a, b, c); key = `e${a},${b},${c}`; break;
    case 5: geo = new THREE.CylinderGeometry(a, a, b * 2, 12); key = `y${a},${b}`; break;
    default: geo = new THREE.BoxGeometry(a * 2, b * 2, c * 2); key = `b${a},${b},${c}`; break;
  }
  // 엔진의 캡슐·원기둥은 **z 축**이 길이 방향인데 three 는 y 축이다 — 눕혀 둔다
  if (g.type === 3 || g.type === 5) geo.rotateX(Math.PI / 2);
  geo.userData.key = key;
  return geo;
}
