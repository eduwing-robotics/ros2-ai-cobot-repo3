// robot.html 엔트리 — 카메라 없이 3D 로봇만. 그리퍼 장착값을 눈으로 맞추는 도구다.
//
// 이 화면이 `AR/` 에 있는 이유 — 맞추는 값(마커 스케일·그리퍼 장착)이
// 제일 먼저 걸리는 화면이 AR 이다 (BUILD-VITE.md §각 폴더 안).
//
// **카메라가 없어 자동 검증이 되는 유일한 화면이다.** 그래서 이관을 여기서 먼저 한다.

import './robot.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  loadConfig, loadRobot, applyMount, countTriangles, mountRobotYUp,
} from '@fr5/shared/view3d/robot.js';
import { bindNumberPair } from '../features/ui/number-pair.js';

const $ = (id) => document.getElementById(id);

// ---- 씬
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171a);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(1.4, 1.1, 1.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.45, 0);

scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x20262b, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(2, 3, 2);
scene.add(key);

scene.add(new THREE.GridHelper(2, 20, 0x2c3439, 0x21272b));

function resize() {
  const w = innerWidth; const h = innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', resize); resize();

// ---- 로봇
// 설정은 fetch 가 아니라 빌드 시 import 다 — 파일이 깨지면 빌드가 실패한다 (D18).
const { gripper: gripperConfig } = loadConfig();

// Z-up→Y-up 은 `Shared` 한 곳에서만 한다 (`mountRobotYUp`).
const zUpToYUp = mountRobotYUp(null);
scene.add(zUpToYUp);

// 자산은 Shared/assets 가 publicDir 이라 루트에서 서빙된다 → '/FAIRINO_FR5/…'
const { robot, gripperGroup } = await loadRobot({
  urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf',
  gripperCfg: gripperConfig,
  gripperDir: '/PGEA_100_40/',
  onProgress: (a, b) => { $('pct').textContent = `${Math.round((a / b) * 100)}%`; },
});
zUpToYUp.add(robot);

// 손목 좌표축 — 이걸 봐야 플랜지가 어디고 +Z 가 어느 쪽인지 **추측 없이** 안다.
const axes = new THREE.AxesHelper(0.12);
robot.links.wrist3_link.add(axes);

$('loading').hidden = true;
$('panel').hidden = false;
$('fold').hidden = false;

// ---- 패널 접기.
// 폰에서 패널이 화면을 거의 덮어 로봇이 안 보인다. 접기 버튼은 **접힌 뒤에도 보인다** —
// 다 사라지면 되돌릴 방법이 없다. 상태를 기억해 다음에 열 때 그대로 둔다.
const FOLD_KEY = 'fr5web.robot.folded';
function setFolded(on) {
  document.body.classList.toggle('folded', on);
  $('fold').textContent = on ? '☰' : '✕';
  $('fold').setAttribute('aria-pressed', String(on));
  $('fold').setAttribute('aria-label', on ? '패널 펼치기' : '패널 접기');
  try { localStorage.setItem(FOLD_KEY, on ? '1' : '0'); } catch { /* 프라이빗 모드 */ }
}
$('fold').onclick = () => setFolded(!document.body.classList.contains('folded'));
try { setFolded(localStorage.getItem(FOLD_KEY) === '1'); } catch { setFolded(false); }

// ---- 실측 표시. 게이트 기준값(팔 58,482 + 그리퍼 70,102 = 128,584)과 대조한다.
const ARM = 58482; const GRIP = 70102;
function refreshStats() {
  const all = countTriangles(robot);
  const g = countTriangles(gripperGroup);
  // 뎁스카메라는 **STL 이 아니라 절차적 박스**다 (Shared/view3d/robot.js §buildDepthCam).
  // 같이 세면 기준값 70,102 가 카메라 박스 수만큼 어긋나 STL 무결성 경고가 늘 켜진다 —
  // 그러면 진짜로 STL 이 바뀐 날에도 아무도 안 본다. 그래서 **빼고 센다.**
  const camObj = gripperGroup.getObjectByName('depthCam');
  const cam = camObj ? countTriangles(camObj) : { triangles: 0, meshes: 0 };
  const grip = g.triangles - cam.triangles;
  const arm = all.triangles - g.triangles;
  const size = new THREE.Box3().setFromObject(robot).getSize(new THREE.Vector3());
  const ok = (v, want) => (v === want
    ? `<b>${v.toLocaleString()}</b>`
    : `<span class="warn">${v.toLocaleString()} (기준 ${want.toLocaleString()})</span>`);
  $('stats').innerHTML = [
    `팔 삼각형    ${ok(arm, ARM)}`,
    `그리퍼      ${ok(grip, GRIP)}`,
    `STL 합계    ${ok(arm + grip, ARM + GRIP)} / 메시 ${all.meshes}개`,
    `뎁스카메라   ${cam.triangles.toLocaleString()} (박스 ${cam.meshes}개 · 기준값 없음)`,
    `전체 크기    ${size.toArray().map((v) => (v * 1000).toFixed(0)).join(' × ')} mm`,
  ].join('\n');
}

// ---- 마운트 조정
const FIELDS = [
  ['positionMm', 0, 'px', 'nx'], ['positionMm', 1, 'py', 'ny'], ['positionMm', 2, 'pz', 'nz'],
  ['rotationDeg', 0, 'rx', 'mx'], ['rotationDeg', 1, 'ry', 'my'], ['rotationDeg', 2, 'rz', 'mz'],
];
function apply() {
  applyMount(gripperGroup, gripperConfig);
  // 값이 맞으면 이 JSON 이 아니라 **`.env` 를 고친다** — JSON 은 산출물이다 (D18).
  $('out').textContent = JSON.stringify({
    FR5_GRIPPER_POSITION_MM: gripperConfig.positionMm.join(','),
    FR5_GRIPPER_ROTATION_DEG: gripperConfig.rotationDeg.join(','),
    FR5_GRIPPER_PARENT_LINK: gripperConfig.parentLink,
    FR5_GRIPPER_MESH_SCALE: gripperConfig.meshScale,
    FR5_GRIPPER_VERIFIED: true,
  }, null, 2);
  refreshStats();
}
// 되쓰기 규칙은 bindNumberPair 안에 있다 — 여기서 `$(num).value = n` 을 하면
// `0.` 의 소수점이 지워져 0.5 를 못 치는 그 버그가 돌아온다.
// min·max 는 슬라이더 쪽 속성에서 읽는다 (숫자칸에는 안 걸려 있다).
for (const [key, i, slider, num] of FIELDS) {
  bindNumberPair({
    range: $(slider),
    number: $(num),
    onValue: (n) => { gripperConfig[key][i] = n; apply(); },
  }).set(gripperConfig[key][i]);
}
apply();

// ---- 자세·표시 전환
const BENT = { j1: 0, j2: -60, j3: 70, j4: -100, j5: -90, j6: 0 };
const DEG = Math.PI / 180;
function pose(deg) {
  for (const [j, v] of Object.entries(deg)) robot.setJointValue(j, v * DEG);
  refreshStats(); // 자세가 바뀌면 전체 크기도 바뀐다. 안 부르면 낡은 숫자를 보고 오판한다.
}
$('poseZero').onclick = () => pose({ j1: 0, j2: 0, j3: 0, j4: 0, j5: 0, j6: 0 });
$('poseBent').onclick = () => pose(BENT);
$('toggleAxes').onclick = () => { axes.visible = !axes.visible; };
$('toggleGrip').onclick = (e) => {
  gripperGroup.visible = !gripperGroup.visible;
  e.target.textContent = gripperGroup.visible ? '그리퍼 숨기기' : '그리퍼 보이기';
};
$('copy').onclick = () => navigator.clipboard?.writeText($('out').textContent);

// ---- 렌더 루프
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// 헤드리스 검증용 노출. 카메라·컨트롤까지 내보내야 콘솔에서 시점을 잡아
// 스크린샷 증거를 남길 수 있다 (docs/evidence/).
Object.assign(window, {
  robot, gripperGroup, gripperConfig, THREE, countTriangles,
  scene, camera, controls, renderer, setFolded,
  /** 손목을 화면 가운데에 크게 놓는다. dist 는 미터. */
  focusWrist(dist = 0.42) {
    const p = new THREE.Vector3();
    robot.links.wrist3_link.getWorldPosition(p);
    controls.target.copy(p);
    camera.position.copy(p).add(new THREE.Vector3(dist, dist * 0.55, dist));
    controls.update();
  },
});
