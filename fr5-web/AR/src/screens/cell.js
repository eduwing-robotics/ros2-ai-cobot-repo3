// cell.html 엔트리 — Phase 1: 시나리오 역할 핸드오프 + 실기 라이브 미러.
// 팔 위치·개수는 **레이아웃 데이터에서 N개**로 온다 — 로봇이 늘면 레이아웃만 편집(코드 무변, 2026-08-08).
// 근거: docs/archive/AR-ROLE-LIVE-ORCHESTRATION-CONVERGE-LOOP-legacy-2026-08-18.md
//   (2026-08-18 보관 — 내용은 그대로다. **결론이 D-번호로 안 올라갔으므로** 역할·라이브를
//    다시 손대기 전에 이 문서를 연다: 관전 모델 · 로봇 수 무하드코딩 · robotId 키잉)
//
// **읽기 전용.** 실기는 자기 프로그램+비전으로 돌고 우리는 구경만(하드룰 4). 종료는 사람이.
//
// ponytail: 방(벽·스테이션)까지 그리는 layout-view 는 "팔 구경"엔 노이즈가 커서(실렌더 확인
// 2026-08-08) 안 쓴다 — 팔 **위치 데이터만** 레이아웃에서 읽어 깔끔한 배경에 세운다.
// 정식 셀 위 겹침은 Phase 3(카메라). 실물이 여러 대면 arm.robotId 로 각자 스트림을 받게 확장한다.
import './cell.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadConfig, loadRobot, setJointsDeg, mountRobotYUp } from '@fr5/shared/view3d/robot.js';
import { buildPreset } from '@fr5/shared/data/layout/presets.js';
import { PRESET_POSES } from '@fr5/shared/data/motion/poses.js';
import { subscribeRobotState } from '@fr5/shared/data/datasource/state-stream.js';
import { mm } from '@fr5/shared/data/units/units.js';

const $ = (id) => document.getElementById(id);
const IDLE_POSE = PRESET_POSES.home;   // 쉬는 자세 — 곧게 선 막대(관절 0)는 로봇으로 안 읽힌다

// ── 씬 (깔끔한 배경)
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('view').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeae8e5);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 5, 3); scene.add(key);

// ── 레이아웃에서 팔 N개를 읽어 제자리에 세운다. 개수를 코드에 박지 않는다.
// 평면도(mm) → 씬: x→x, z(높이)→y, y→-z (layout-view 와 같은 사상). yaw 로 돌린다.
const layout = buildPreset('cell');
const armDefs = (layout.arms ?? []).filter((a) => a.model === 'FR5');
const { gripper } = loadConfig();
const arms = [];   // { id, robot, robotId }
for (const a of armDefs) {
  try {
    const { robot } = await loadRobot({
      urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf', gripperCfg: gripper, gripperDir: '/PGEA_100_40/',
    });
    setJointsDeg(robot, IDLE_POSE);
    const holder = new THREE.Group();
    holder.position.set(mm(a.basePosMm[0]), mm(a.basePosMm[2] ?? 0), -mm(a.basePosMm[1]));
    holder.rotation.y = (a.baseYawDeg ?? 0) * Math.PI / 180;
    holder.add(mountRobotYUp(robot));
    scene.add(holder);
    arms.push({ id: a.id, robot, robotId: a.robotId ?? a.id });
  } catch (e) { console.error(`팔 ${a.id} 실패`, e); }
}
$('loading').hidden = true;

// 팔들이 화면에 차게 카메라 맞춤. **월드 행렬을 먼저 갱신** — 안 하면 팔이 아직 원점에 있어
// 바운딩박스가 0 이 되고 카메라가 원점에 붙는다 (실렌더 2026-08-08).
scene.updateMatrixWorld(true);
{
  const box = new THREE.Box3();
  for (const a of arms) box.expandByObject(a.robot);
  const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const r = box.isEmpty() ? 3 : Math.max(1.5, box.getSize(new THREE.Vector3()).length());
  camera.position.set(c.x + r * 0.7, c.y + r * 0.6, c.z + r * 0.9);
  controls.target.copy(c);
  controls.update();
}

// ── 실기 라이브 — robotId 로 키잉. 스냅샷이 robotId 를 달고 오므로 실물이 늘면 각 스트림이
// 제 아바타를 살린다(브리지가 robotId별 스트림을 줄 때. 지금은 연결 1대).
const liveByRobot = new Map();   // robotId → { joints, at }
let lastRobotId = null;
subscribeRobotState({
  onSnapshot: (st) => {
    const j = st.jointsDeg;
    if (st.connected && st.robotId && Array.isArray(j) && j.length >= 6) {
      liveByRobot.set(st.robotId, { joints: j, at: performance.now() });
      lastRobotId = st.robotId;
    }
  },
});
const liveFor = (robotId, now) => {
  const e = liveByRobot.get(robotId);
  return e && now - e.at < 2000 ? e.joints : null;
};

// ── 시나리오: 스텝마다 활성 팔 하나(지금은 팔 순서·수동 진행). cursor==length 면 종료.
// ceiling(ponytail): 정식 시나리오/역할(scenario/schema ROLES)·완료 자동감지는 Phase 2 —
// 브리지가 프로그램 진행을 실어주는지 확인 후 얹는다.
const STEPS = arms.map((a) => a.id);
let cursor = 0;
const activeId = () => (cursor < STEPS.length ? STEPS[cursor] : null);

// ── 칩 N개 동적 생성
const chipEls = new Map();
for (const a of arms) {
  const el = document.createElement('span');
  el.className = 'chip'; el.dataset.on = 'false'; el.textContent = a.id;
  $('chips').appendChild(el);
  chipEls.set(a.id, el);
}
function paint() {
  const act = activeId();
  for (const [id, el] of chipEls) el.dataset.on = String(id === act);
  $('status').textContent = act
    ? `활성: ${act} · 실기 라이브 (${cursor + 1}/${STEPS.length})`
    : '종료 · 전부 idle';
  $('next').disabled = cursor >= STEPS.length;
}
$('next').onclick = () => { if (cursor < STEPS.length) cursor += 1; paint(); };
$('end').onclick = () => { cursor = STEPS.length; paint(); };   // 사람이 종료
$('reset').onclick = () => { cursor = 0; paint(); };
paint();

// ── 렌더 루프
const resize = () => {
  const w = $('view').clientWidth || 1;
  const h = $('view').clientHeight || 1;
  camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
};
new ResizeObserver(resize).observe($('view'));
resize();

renderer.setAnimationLoop((now) => {
  const act = activeId();
  for (const a of arms) {
    // 활성 팔이 연결된 실물 라이브를 얹는다. 실물이 늘면 liveFor(a.robotId) 로 바꾸면 각자 산다.
    const live = a.id === act ? liveFor(lastRobotId, now) : null;
    if (live) setJointsDeg(a.robot, { j1: live[0], j2: live[1], j3: live[2], j4: live[3], j5: live[4], j6: live[5] });
    else setJointsDeg(a.robot, IDLE_POSE);
  }
  controls.update();
  renderer.render(scene, camera);
});

// 헤드리스 검증 노출
Object.assign(window, {
  THREE, scene, renderer, camera, controls, arms,
  getState: () => ({
    cursor, active: activeId(), armIds: STEPS, lastRobotId,
    liveRobots: [...liveByRobot.keys()],
    liveJoints: liveByRobot.get(lastRobotId)?.joints ?? null,
  }),
  next: () => { if (cursor < STEPS.length) cursor += 1; paint(); },
  end: () => { cursor = STEPS.length; paint(); },
  reset: () => { cursor = 0; paint(); },
});
