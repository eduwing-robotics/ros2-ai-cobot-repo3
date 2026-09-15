// ar.html 엔트리 — 폰이 실물 위에 겹쳐 보는 화면. **이 프로젝트에서 유일하게 동작하는 슬라이스다.**
//
// 이관 시 지킨 것 (수렴 루프 · rnd/MIGRATION-CONVERGE-LOOP-legacy-2026-08-05.md)
//   · **URL 파라미터를 그대로 옮긴다.** 슬롯형 config 을 여기 섞지 않는다 —
//     폰에서 실패하면 원인이 두 배가 된다 (D15 의 교훈)
//   · **window 노출을 빼지 않는다.** 기준값 7개 대조가 거기 걸려 있다
//     (archive/evidence-2026-07/2026-07-30/ar-baseline.md)

import './ar.css';
import * as THREE from 'three';
import { loadConfig, loadRobot, mountRobotYUp, setJointsDeg } from '@fr5/shared/view3d/robot.js';
import { subscribeRobotState } from '@fr5/shared/data/datasource/state-stream.js';
import {
  interpolateJoints, tipPath, pathLength, makeTube, createPlayer,
} from '@fr5/shared/view3d/path.js';
import { makeReachZone, FR5_REACH_M } from '@fr5/shared/view3d/reach-zone.js';
import { initAR } from '../features/marker/ar-marker.js';
import { bindNumberPair } from '../features/ui/number-pair.js';
import { createRecorder } from '../features/record/screen-record.js';

const $ = (id) => document.getElementById(id);
const setStatus = (s, cls = '') => { $('status').className = cls; $('status').textContent = s; };

// ---- 렌더러. alpha 필수 — 뒤의 카메라 영상이 보여야 한다.
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x404850, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(1, 2, 1.5);
scene.add(key);

// ---- 설정 (마커 크기·바코드 번호는 인쇄물 실측값이다. 코드에 박지 않는다.)
// fetch 가 아니라 빌드 시 import 다 — 파일이 깨지면 빌드가 실패한다 (D18).
const { gripper: gcfg, marker: mcfg } = loadConfig();

// URL 로 덮어쓸 수 있게 한다 — 현장에서 파일을 고치지 않고 값을 바꿔야 할 때가 있고,
// QR·링크로 팀원에게 "이 값으로 열어봐"를 넘길 수 있다.
//   ?mm=143   마커 실측 크기
//   ?bc=2     바코드 번호
//   ?sm=강    깜빡임 억제 (off·low·mid·high 도 받는다)
//   ?diag=1   진단 수치 켜고 시작
// **`has()` 로 먼저 확인한다.** `Q.get('bc')` 는 없을 때 `null` 을 주고
// `Number(null) === 0` 이다. 하한이 0 인 값(바코드 번호)은 그 0 이 검사를 통과해
// **파라미터를 안 줬는데 마커 번호가 0 으로 덮어써졌다.** 인쇄물이 #2 였으므로
// 아무것도 검출되지 않아 로봇이 통째로 안 떴다 — 실제로 겪은 버그다 (D15).
const Q = new URLSearchParams(location.search);
if (Q.has('mm')) {
  const v = Number(Q.get('mm'));
  // 하한은 ⚙ 슬라이더와 같아야 한다. 40 으로 두면 `?mm=35` 가 **조용히 무시**되고
  // 설정 기본값이 그대로 쓰여, 크기를 바꿨다고 믿은 채 엉뚱한 값을 재게 된다.
  if (Number.isFinite(v) && v >= 10 && v <= 400) mcfg.markerSizeMm = v;
}
if (Q.has('bc')) {
  const v = Number(Q.get('bc'));
  if (Number.isInteger(v) && v >= 0 && v <= 7) mcfg.barcodeValue = v;
}
// **기본은 '없음'** — 스무딩을 기본으로 켰다가 로봇이 통째로 안 뜨는 일을 겪었다.
// AR 경로는 로컬(카메라 없는 자동화)에서 검증할 수 없어서, 검증 못 한 것을 기본으로 두지 않는다.
// 깜빡이면 ⚙ 에서 약→중→강 으로 올리고 진단 수치로 효과를 확인한다.
// 폰에서 URL 에 한글을 타이핑하는 것은 고통이다 → 영문 별칭도 받는다.
// **검출 캔버스 폭** (`?cv=640`). 0 이면 AR.js 자동 — 폰에서는 320 을 고른다.
// 검출 한계가 "마커가 검출 캔버스에서 24px" 이라 이 값이 곧 검출 거리다 (ar-marker.js §검출 해상도).
// 올리면 픽셀이 4배라 fps 를 먹는다. 그래서 기본을 바꾸지 않고 URL 로 재 본 뒤 정한다.
const num = (k, lo, hi) => {
  const v = Number(Q.get(k));
  return Number.isInteger(v) && v >= lo && v <= hi ? v : 0;
};
// **카메라에 요청할 영상 크기** (`?src=1280`). AR.js 기본이 640×480 이다.
// 소스가 검출 상한을 정한다 — 이걸 안 올리면 `cv` 를 키워도 소용없다.
//
// **기본을 AR.js 기본값에 맡기지 않는다.** 맡기면 카메라 640×480 · 검출 320×240 으로
// 두 번 깎여 **인식률 58%** 가 나온다. 폰 실기에서 둘을 올려 **100%** 를 봤고
// (35mm · 1.8m · `docs/archive/evidence-2026-07/2026-07-31/marker-live-phone.md`), 그 값이 여기 기본이다.
// 측정해서 알아낸 값을 URL 에만 남겨 두면, 주소를 모르는 사람에게는 그냥 안 되는 화면이다.
//
// 대가는 **fps 13~14** 다 (GAP-MATRIX OPEN). 끊김보다 안 잡히는 쪽이 나쁘다고 보고 고른다.
// 되돌리려면 `?src=640&cv=320`.
const SOURCE_W = num('src', 320, 3840) || 1280;
// 검출 캔버스 폭 (`?cv=640`). 소스보다 작게 두는 게 기본이다 — 실기에서 960 으로 100% 였고
// 소스와 같게(1280) 두면 픽셀이 더 늘어 fps 만 더 먹는다.
const DETECT_CV = num('cv', 240, 3840) || Math.min(960, SOURCE_W);

const SM_ALIAS = { off: '없음', low: '약', mid: '중', high: '강' };
const qSm = Q.get('sm');
let smoothing = SM_ALIAS[qSm] ?? (['없음', '약', '중', '강'].includes(qSm) ? qSm : '없음');

// ---- 모델. AR 을 켜기 전에 먼저 읽는다 — 카메라 권한 창과 10MB 다운로드가
//      겹치면 무엇 때문에 멈춘 건지 구분이 안 된다.
// 자산은 Shared/assets 가 publicDir 이라 루트에서 서빙된다 → '/FAIRINO_FR5/…'
const { robot } = await loadRobot({
  urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf',
  gripperCfg: gcfg,
  gripperDir: '/PGEA_100_40/',
  onProgress: (a, b) => { $('pct').textContent = `${Math.round((a / b) * 100)}%`; },
});
$('pct').textContent = '100%';

// ---- 마커 좌표계 구성
//   AR.js 예제에서 마커 위 평면이 PlaneGeometry(1,1) 이다 → **마커가 1×1 단위를 차지한다.**
//
// **카메라 요청은 사용자가 "시작"을 누른 뒤에 한다.** 모듈 평가 시점에 요청하면
// 화면에는 아직 안내가 떠 있는데 권한 창이 먼저 뜬다 — 사용자가 무엇을 허용하는지 모른다.
let ar = null;
const markerRoot = new THREE.Group();
scene.add(markerRoot);
// AR 이 붙기 전에도 렌더는 돌아야 하므로 임시 카메라를 둔다.
let activeCamera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 100);
activeCamera.position.set(0, 2.2, 3.2);
activeCamera.lookAt(0, 0.4, 0);

function startAR() {
  ar = initAR({
    renderer,
    scene,
    markerRoot,
    cameraParametersUrl: '/marker/camera_para.dat',
    barcodeValue: mcfg.barcodeValue,
    smoothing,
    detectCanvasWidth: DETECT_CV,
    sourceWidth: SOURCE_W,
    onStatus: (s) => setStatus(s),
  });
  activeCamera = ar.camera;
}

// markerRoot(1×1 단위) → scaleRoot(미터) → stage(Z-up→Y-up) → robot
//
// 마커 좌표계는 **마커 한 변 = 1 단위**다. URDF 는 미터라 그대로 놓으면
// 1m 로봇이 마커 크기로 보인다. 그래서 1/마커크기 를 곱한다 —
// 즉 **이 한 값이 로봇 크기를 결정하고, 인쇄물 실측값과 같아야 맞는다.**
const scaleRoot = new THREE.Group();
function applyMarkerSize(mm) {
  mcfg.markerSizeMm = mm;
  scaleRoot.scale.setScalar(1 / (mm / 1000));
}
applyMarkerSize(mcfg.markerSizeMm);
markerRoot.add(scaleRoot);

// Z-up→Y-up 은 `Shared` 한 곳에서만 한다 (`mountRobotYUp`). `stage` 라는 이름과
// `window` 노출은 그대로 둔다 — 이관 기준값 대조가 거기 걸려 있다 (`AGENTS.md`).
const stage = mountRobotYUp(null);
scaleRoot.add(stage);

// 마커 원점 → 로봇 원점 (실물 옆 시연에서 자로 재서 설정에 넣는다)
const [ox, oy, oz] = mcfg.markerToRobotMm;
stage.position.set(ox / 1000, oy / 1000, oz / 1000);
stage.add(robot);

// ---- ① 상자 — 로봇을 올리기 전 인식률·떨림만 본다.
const box = new THREE.Mesh(
  new THREE.BoxGeometry(0.6, 0.6, 0.6),
  new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.65 }),
);
box.position.y = 0.3;
const axes = new THREE.AxesHelper(0.7);
const testGroup = new THREE.Group();
testGroup.add(box, axes);
testGroup.visible = false;
markerRoot.add(testGroup); // 마커 단위 그대로 — 스케일 영향을 안 받게 한다

// ---- ③ 궤적. FK 보간만 쓴다. IK 없음.
//
// **j1(허리)만 크게 돌린다.** 여러 관절을 동시에 움직이면 손끝 경로가 팔 실루엣과
// 겹쳐 화면에서 가려진다 — 실제로 그랬다. 팔꿈치를 고정하면 손끝이
// 반경 649mm · 높이 586mm 의 깨끗한 호를 그려 팔 밖에서 또렷이 보인다.
// 도달거리(922mm)보다 안쪽이라 ④ 안전 범위와 함께 켜면
// **"경로가 범위 안에 있다"** 가 한 장면으로 읽힌다.
const ELBOW = { j2: -70, j3: 65, j4: -85, j5: -90, j6: 0 };
const POSE_A = { j1: -55, ...ELBOW };
const POSE_B = { j1: 55, ...ELBOW };
const frames = interpolateJoints(POSE_A, POSE_B, 60);
const points = tipPath(robot, frames);
const tube = makeTube(points, { radius: 0.024, opacity: 0.7 });
tube.visible = false;
// **stage 가 아니라 robot 에 붙인다.** 점이 로봇 로컬 좌표로 계산됐기 때문이다
// (trajectory.js §tipPath). stage 에 붙이면 마커 스케일이 한 번 더 곱해진다.
robot.add(tube);
const player = createPlayer(robot, frames, { secondsPerLoop: 4 });

// ---- 라이브 미러. **실물(브리지)의 현재 관절각을 그대로 얹는다** — FR5 조작 화면이
// 움직이면 폰의 로봇도 같이 움직인다 (2026-08-07 요청). 스냅샷이 들어오는 동안은 데모
// 궤적(player)을 멈추고 실물 자세를 그린다. 2초간 소식이 없으면 데모로 돌아간다.
//
// **읽기 전용이다** — subscribeRobotState 에는 명령 통로가 없다 (하드룰 4). AR 은 관전만.
// 주소: dev 는 vite 프록시로 same-origin(`wss`)을 쓰므로 파라미터가 필요 없다. 프록시가
// 없는 곳에선 `?bridge=192.168.30.240:5055` 로 한 번 주면 기억한다(`?bridge=` 빈 값이면 잊는다).
// cam(`?cam=`)·depth(`?depth=`) 와 같은 규약이다.
const BRIDGE_KEY = 'fr5.bridgeHost';
let bridgeHost = null;
try {
  const q = Q.get('bridge');
  if (q === null) {
    bridgeHost = localStorage.getItem(BRIDGE_KEY) || null;
  } else {
    const v = q.trim().replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (v) localStorage.setItem(BRIDGE_KEY, v); else localStorage.removeItem(BRIDGE_KEY);
    bridgeHost = v || null;
  }
} catch { /* 프라이빗 모드 — 파라미터로만 준다 */ }

const LIVE_STALE_MS = 2000;
let liveJoints = null;
let liveAt = 0;
subscribeRobotState({
  host: bridgeHost || undefined,
  onSnapshot: (st) => {
    const j = st.jointsDeg;
    // 미연결 스냅샷도 같은 스키마로 온다(D40) — 6축 배열일 때만, 연결됐을 때만 얹는다.
    // 안 그러면 실물이 없는데 0° 홈 자세를 실물인 양 그린다.
    if (st.connected && Array.isArray(j) && j.length >= 6) {
      liveJoints = j;
      liveAt = performance.now();
    }
  },
});
const liveActive = (now) => liveJoints && now - liveAt < LIVE_STALE_MS;

// ---- ④ 안전 범위. 반지름 = FR5 도달거리 922mm.
// 그리는 코드는 shared 로 내렸다 — 대시보드도 같은 링으로 스테이션을 검사한다.
const REACH = FR5_REACH_M;
const zone = makeReachZone();
zone.visible = false;
stage.add(zone);

// ---- 버튼
const modes = { test: false, robot: true, path: false, zone: false };
function applyModes() {
  testGroup.visible = modes.test;
  scaleRoot.visible = modes.robot || modes.path || modes.zone;
  robot.visible = modes.robot;
  tube.visible = modes.path;
  zone.visible = modes.zone;
  $('bPlay').disabled = !modes.robot;
  for (const [k, id] of [['test', 'bTest'], ['robot', 'bRobot'], ['path', 'bPath'], ['zone', 'bZone']]) {
    $(id).classList.toggle('on', modes[k]);
  }
}
for (const [k, id] of [['test', 'bTest'], ['robot', 'bRobot'], ['path', 'bPath'], ['zone', 'bZone']]) {
  $(id).onclick = () => { modes[k] = !modes[k]; applyModes(); };
}
$('bPlay').onclick = (e) => {
  const on = player.toggle();
  e.target.textContent = on ? '❙❙ 정지' : '▶ 재생';
};
applyModes();

// ---- 조정판 (⚙)
//
// **폰에서는 콘솔을 못 본다.** 그래서 크기·스무딩·진단을 화면에서 다룬다.
// 값은 기억한다 — 마커를 다시 인쇄할 때까지 같은 값을 쓴다.
const TUNE_KEY = 'fr5web.ar.tune';
const saveTune = () => {
  try {
    localStorage.setItem(TUNE_KEY, JSON.stringify({ mm: mcfg.markerSizeMm, sm: smoothing }));
  } catch { /* 프라이빗 모드 */ }
};
// URL 로 명시한 값이 저장값을 이긴다 — 링크로 넘긴 의도가 우선이다.
if (!Q.has('mm') || !Q.has('sm')) {
  try {
    const saved = JSON.parse(localStorage.getItem(TUNE_KEY) || '{}');
    if (!Q.has('mm') && saved.mm >= 40 && saved.mm <= 400) applyMarkerSize(saved.mm);
    if (!Q.has('sm') && ['없음', '약', '중', '강'].includes(saved.sm)) smoothing = saved.sm;
  } catch { /* 저장값이 깨졌으면 무시 */ }
}

$('bTune').onclick = () => {
  $('tune').hidden = !$('tune').hidden;
  $('bTune').classList.toggle('on', !$('tune').hidden);
};

// 되쓰기 규칙은 bindNumberPair 안에 있다 — 여기서 `$('mmN').value = n` 을 하면
// 40mm 미만을 접두사로도 못 치는 그 버그가 돌아온다.
const mmPair = bindNumberPair({
  range: $('mmR'),
  number: $('mmN'),
  round: Math.round,          // 마커 크기는 정수 mm 다
  onValue: (n) => { applyMarkerSize(n); saveTune(); },
});
const setMm = (v) => mmPair.set(v);   // window 노출 계약 유지 (AGENTS.md)
setMm(mcfg.markerSizeMm);

function setSm(level) {
  smoothing = level;
  ar?.setSmoothing(level);
  for (const b of $('smRow').children) b.classList.toggle('on', b.dataset.sm === level);
  saveTune();
}
for (const b of $('smRow').children) b.onclick = () => setSm(b.dataset.sm);
setSm(smoothing);

let showDiag = Q.get('diag') === '1';

/**
 * 진단 수치를 dev 서버로 흘려 `.diag/<날짜>.jsonl` 에 쌓는다 (`?log=1&tag=80mm-2m`).
 *
 * **`import.meta.env.DEV` 로 감싸서 배포 번들에서는 통째로 사라진다.**
 * 받는 쪽(vite.config.js 의 diagSink)도 dev 서버에만 있다.
 *
 * `sendBeacon` 을 쓰는 이유 — 응답을 안 기다리고, 화면이 가려지거나 꺼져도
 * 마지막 한 건이 나간다. `fetch` 로 하면 렌더 루프에 지연이 섞이고
 * 폰을 주머니에 넣는 순간 끊긴다. **재는 도구가 재는 대상을 느리게 하면 안 된다.**
 */
const LOG_EVERY_MS = 1000;   // 화면 갱신(250ms)보다 성기게 — 파일이 4배 얇아진다
// **기록은 진단판 표시와 별개다.** 처음엔 `showDiag` 안에 넣었다가
// 진단판을 끈 순간 로그가 조용히 끊겼다 — 재는 사람이 화면을 정리하면
// 데이터가 사라지는 설계였다.
const logging = import.meta.env.DEV && Q.get('log') === '1';
let sendDiag = () => {};
if (logging) {
  const tag = Q.get('tag') ?? '';
  let lastSentAt = 0;
  sendDiag = (st, now) => {
    if (now - lastSentAt < LOG_EVERY_MS) return;
    // 카메라가 열리기 전(`0×0`) 구간은 버린다 — 인식률 0% 가 "못 잡았다" 로 읽혀
    // 나중에 표를 만들 때 성적을 깎는다. 실제로 158줄 중 37줄이 이것이었다.
    if (!st.카메라?.[0]) return;
    lastSentAt = now;
    navigator.sendBeacon?.('/__diag', JSON.stringify({
      t: new Date().toISOString(),
      tag,
      mm: mcfg.markerSizeMm,
      bc: mcfg.barcodeValue,
      sm: smoothing,
      cv: DETECT_CV || 'auto',
      src: SOURCE_W || 'auto',
      // 사람이 선언한 구간. 0 이면 측정 버튼을 안 누른 채 흘러가는 줄이다
      run: measureUntil ? runNo : 0,
      sid: SID,   // 페이지를 다시 연 판을 가른다 (위 §SID)
      ...st,
    }));
  };
}
function applyDiag() {
  $('diag').hidden = !showDiag;
  $('bDiag').textContent = showDiag ? '진단 수치 숨기기' : '진단 수치 보기';
  $('bDiag').classList.toggle('on', showDiag);
  if (showDiag) $('tune').hidden = false;
}
$('bDiag').onclick = () => { showDiag = !showDiag; applyDiag(); };

// ---- 실험 측정 — **한 판을 폰에서 끝낸다.**
//
// 구간을 무엇으로 가르나가 이 기능의 전부다. 처음엔 URL 의 `tag` 로 갈랐는데
// 폰에서 URL 을 고치는 게 고통이라 실제로는 안 바뀌었고, 결과가 한 태그에
// 0.46m 부터 2.05m 까지 섞여 들어왔다 — **한 거리의 값이 아닌 숫자**가 된다.
// 그래서 사람이 "지금부터 잰다" 를 누르게 하고, 로그에 `run` 번호를 박는다.
// report-diag.py 가 그 번호로 구간을 가른다 — 추론이 아니라 선언이다.
const MEASURE_MS = 30_000;
// **페이지를 다시 열면 `run` 이 1 부터 다시 센다.** 그래서 판 번호만으로는
// 어제의 #1 과 방금의 #1 이 구분되지 않는다 — 실제로 두 판이 한 구간으로 합쳐져
// 성적이 91% 에서 0% 로 뒤집혔다. 열 때마다 도장을 하나 찍어 같이 보낸다.
const SID = Date.now().toString(36).slice(-5);
let runNo = 0;
let measureUntil = 0;
let measureMm = 0;
let lastSt = null;

function tickMeasure(st, now) {
  if (!measureUntil) return;
  const left = measureUntil - now;
  if (left > 0) {
    $('mState').textContent = `재는 중 ${Math.ceil(left / 1000)}s · 움직이지 마세요`;
    return;
  }
  measureUntil = 0;
  $('bMeasure').disabled = false;
  // 끝난 판의 성적을 화면에 남긴다. 폰만 보고 다음 판을 판단할 수 있어야 한다.
  $('mState').textContent = `#${runNo} ${measureMm}mm · ${st.마커px ?? '?'}px`
    + ` · 인식률 ${st.인식률}% · 기울기 ${st.기울기도 ?? '?'}°`
    + (st.회전급변도 > 30 ? ' · ⚠뒤집힘' : '');
}

$('bMeasure').onclick = () => {
  if (!ar?.ready()) { $('mState').textContent = '카메라가 아직 안 열렸다'; return; }
  if (measureUntil) return;                 // 이미 재는 중이다
  runNo += 1;
  measureMm = mcfg.markerSizeMm;
  ar.resetStats();                          // 누적값을 전부 비운다 — 앞 판이 섞이면 안 된다
  measureUntil = performance.now() + MEASURE_MS;
  $('bMeasure').disabled = true;
  $('mState').textContent = `재는 중 ${MEASURE_MS / 1000}s`;
};
$('bReset').onclick = () => ar?.resetStats();
applyDiag();

// ---- 화면 녹화
//
// 폰 내장 화면 녹화로도 되지만 **버튼바와 진단판까지 같이 찍힌다.** 시연 영상에는
// 그게 없어야 하고, 증거로 남길 때도 UI 가 화면 아래를 가린 판이 남는다.
// 여기서는 카메라 영상과 겹침만 합치므로 그 문제가 없다 (features/record/).
const recorder = createRecorder({
  canvas: renderer.domElement,
  getVideo: () => ar?.video() ?? null,
  onState: ({ on, sec, msg }) => {
    $('bRec').textContent = on ? '■ 정지' : '● 녹화';
    $('bRec').classList.toggle('on', on);
    $('rState').textContent = msg || (on ? `녹화 중 ${sec}s` : '');
  },
});
if (recorder.supported) {
  $('bRec').onclick = () => recorder.toggle();
} else {
  // 되는 척하지 않는다. 이 브라우저에서 안 되면 폰 내장 녹화를 쓰라고 알린다.
  $('bRec').disabled = true;
  $('rState').textContent = '이 브라우저는 녹화를 지원하지 않습니다. 폰 내장 화면 녹화를 쓰세요';
}

// ---- 패널 숨기기
//
// 폰에서 하단 버튼바가 카메라 화면 아래쪽을 가린다. 마커를 실물 옆에 놓고 겹쳐 볼 때
// 정작 봐야 할 곳이 거기다. 사진·영상으로 남길 때도 UI 없는 화면이 필요하다.
//
// 되돌릴 길을 남긴다 — 토글 버튼은 숨김 상태에서도 보이고, **화면 두 번 탭**으로도 된다.
// 한 번 탭으로 하지 않는 이유: AR 화면을 손으로 잡고 움직이다 스치기만 해도 꺼진다.
const CLEAN_KEY = 'fr5web.ar.clean';

function setClean(on) {
  document.body.classList.toggle('clean', on);
  $('toggle').textContent = on ? '⤡' : '⤢';
  $('toggle').setAttribute('aria-pressed', String(on));
  $('toggle').setAttribute('aria-label', on ? '화면 표시 보이기' : '화면 표시 숨기기');
  try { localStorage.setItem(CLEAN_KEY, on ? '1' : '0'); } catch { /* 사파리 프라이빗 모드 */ }
}
const toggleClean = () => setClean(!document.body.classList.contains('clean'));

$('toggle').onclick = (e) => { e.stopPropagation(); toggleClean(); };

// 캔버스 두 번 탭 — 버튼바가 숨겨진 상태에서 되돌리는 가장 빠른 길
renderer.domElement.addEventListener('dblclick', toggleClean);
let lastTap = 0;
renderer.domElement.addEventListener('touchend', (e) => {
  if (e.touches.length) return;              // 멀티터치는 무시
  const now = performance.now();
  if (now - lastTap < 320) { toggleClean(); lastTap = 0; } else { lastTap = now; }
}, { passive: true });

try { setClean(localStorage.getItem(CLEAN_KEY) === '1'); } catch { setClean(false); }

// ---- 시작 (사용자 제스처 뒤에 카메라를 요청해야 iOS 가 허용한다)
$('bootBtn').onclick = () => {
  $('boot').hidden = true;
  setStatus('카메라 여는 중…');
  startAR();   // 사용자 제스처 안에서 요청한다
};
$('bootMsg').innerHTML = `마커 <b>#${mcfg.barcodeValue}</b> · 검은 사각형 ${mcfg.markerSizeMm}mm<br>`
  + '인식까지 <b>2~3초</b> 걸린다. 마커를 들고 기다린다.<br>'
  + '화면을 <b>두 번 탭</b>하거나 <b>⤢</b>를 누르면 표시가 숨는다.<br>'
  + '안 뜨거나 깜빡이면 <b>⚙</b> → <b>진단 수치 보기</b>.<br>'
  + (mcfg.verified ? '' : '<span class="err">markerSizeMm 이 인쇄물 실측값이 아니다</span>');
$('bootBtn').disabled = false;

// ---- 렌더 루프
let last = performance.now();
let wasVisible = null;
let lastDiagAt = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;

  ar?.update();
  // 실물 스냅샷이 흐르는 동안은 실물 자세를 얹는다. 없으면 데모 궤적을 돈다.
  if (liveActive(now)) {
    const j = liveJoints;
    setJointsDeg(robot, { j1: j[0], j2: j[1], j3: j[2], j4: j[3], j5: j[4], j6: j[5] });
  } else {
    player.update(dt);
  }

  // 마커를 보고 있는지 HUD 로 알린다 — 안 보이면 왜 안 뜨는지 사람이 못 안다.
  const vis = Boolean(ar) && markerRoot.visible;
  if (vis !== wasVisible) {
    wasVisible = vis;
    $('dot').classList.toggle('on', vis);
    if (ar?.ready()) setStatus(vis ? `마커 #${mcfg.barcodeValue} 인식 중` : '마커를 찾는 중…');
  }

  // 진단 수치는 초당 4회만 갱신한다 — 매 프레임 DOM 을 고치면 그 자체가 느려진다
  if (ar && now - lastDiagAt > 250) {
    lastDiagAt = now;
    const st = ar.stats(mcfg.markerSizeMm);
    lastSt = st;
    tickMeasure(st, now);
    sendDiag(st, now);
    if (showDiag) $('diag').textContent = [
      `fps ${st.fps}   인식률 ${st.인식률}%   놓침 ${st.놓침}회 / ${st.프레임}프레임`,
      `지금  원시 ${st.보임 ? '인식' : '놓침'} · 표시 ${st.표시중 ? 'ON' : 'OFF'}`
        + (st.거리m !== null ? `   거리 ${st.거리m}m` : ''),
      `마커 ${st.마커px ?? '—'}px (한계 24)   기울기 ${st.기울기도 ?? '—'}°`
        + `   급변 ${st.회전급변도}°   최장끊김 ${(st.최장끊김ms / 1000).toFixed(1)}s`,
      `카메라 ${st.카메라?.join('×') ?? '?'}   검출캔버스 ${st.캔버스?.join('×') ?? '?'}`,
      `마커 #${mcfg.barcodeValue} · ${mcfg.markerSizeMm}mm · 스케일 ${scaleRoot.scale.x.toFixed(2)}배 · 억제 ${smoothing}`,
    ].join('\n');
  }

  renderer.render(scene, activeCamera);

  // **렌더 바로 다음이어야 한다.** preserveDrawingBuffer:false 라 이 자리를 벗어나
  // 캔버스를 읽으면 빈 화면이 녹화된다. 녹화 중이 아니면 즉시 되돌아간다.
  recorder.capture(now);
});

// 헤드리스 검증용 노출.
// **빼지 않는다** — 기준값 7개 대조가 여기 걸려 있다 (archive/evidence-2026-07/2026-07-30/ar-baseline.md).
// 빼면 판정이 다시 "폰에서 되는 것 같다" 로 내려앉는다.
Object.assign(window, {
  THREE, robot, scene, renderer, stage, scaleRoot, tube, zone, player,
  points, mcfg, gcfg,
  markerRoot, startAR, setClean, toggleClean, setMm, setSm, applyMarkerSize,
  // ar·activeCamera 는 나중에 바뀌므로 **함수로** 내보낸다.
  // Object.assign 은 getter 를 그 시점 값으로 복사해버려 낡은 스냅샷이 된다.
  getAR: () => ar,
  getCamera: () => activeCamera,
  // 라이브 미러 상태 — 헤드리스 검증이 구독 배선을 브리지 없이도 확인한다
  getLive: () => ({ joints: liveJoints, at: liveAt, bridgeHost }),
  recorder,   // 헤드리스 검증 — 카메라 없이도 녹화 경로를 끝까지 돌려볼 수 있다
  /**
   * 카메라를 열지 않고 3D 내용만 눈으로 확인한다 (헤드리스 검증용).
   * AR 을 켜면 markerRoot 가 카메라 영상에 맞춰 움직이므로 이 시점은 버려진다.
   */
  debugView() {
    $('boot').hidden = true;
    scene.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(markerRoot);
    const c = b.getCenter(new THREE.Vector3());
    const r = b.getSize(new THREE.Vector3()).length();
    const cam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, r / 100, r * 4);
    cam.position.copy(c).add(new THREE.Vector3(r * 0.5, r * 0.3, r * 0.55));
    cam.lookAt(c);
    activeCamera = cam;
    return { 중심: c.toArray(), 크기: r };
  },
  measure: () => ({
    마커크기_mm: mcfg.markerSizeMm,
    스케일: scaleRoot.scale.x,
    궤적_점: points.length,
    궤적_길이_m: +pathLength(points).toFixed(3),
    도달거리_m: REACH,
    ar준비: Boolean(ar?.ready()),
    마커보임: markerRoot.visible,
  }),
});
