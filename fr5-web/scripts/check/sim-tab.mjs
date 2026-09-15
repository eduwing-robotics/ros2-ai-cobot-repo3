// 시뮬 탭 실렌더 — **게이트가 이 탭을 한 번도 안 열어봤다** (2026-09-04 발견).
//
// `fr5-web-verify.mjs` 는 `nav button` 이 **4개**라고 단정하고 Live·Teach·Program 만 연다.
// 그런데 탭은 **다섯**이다 — 08-31 에 「시뮬」이 늘었는데 그 게이트가 안 따라왔다.
// 그래서 시뮬 탭이 **터져도 초록**이었다. 이 파일이 그 자리를 맡는다.
//
// ⛔ **저쪽 게이트를 고치지 않았다** — `=== 4` 를 손대면 그 99건이 통째로 흔들린다.
// 여기는 시뮬 탭만 열고 닫는 **작은 판**이라 저쪽과 독립이다.
//
// 무엇을 재나 — 「열린다」와 **「읽을 게 적다」** 둘이다. 뒤엣것이 없으면 다음 사람이
// 또 절마다 ⛔ 문구를 붙이고, 그건 09-03 에 실제로 일어난 일이다.
//
// ## ⛔ 이 초록은 **「배포된 것이 맞다」를 증명하지 않는다** (2026-09-04)
//
//     node scripts/check/sim-tab.mjs                       소스 (스스로 띄운 vite)
//     node scripts/check/sim-tab.mjs --url http://<호스트>:5055/   **실제로 나가는 번들(읽기 전용)**
//
// 오늘 주인님이 *"윈도우엔 거치대 바구니 시뮬밖에 없는데"* 라고 하셨는데 이 게이트는
// 10/10 초록이었다. 둘 다 참이었다 — 게이트는 **로컬 vite** 를 봤고, 원격 번들에는 값이
// 들어가 있었으며, 주인님 탭이 **옛 번들을 물고** 있었다. 셋을 못 가른 이유는 하나다:
// **계측기가 사람이 보는 것을 안 봤다.**
//
// ⚠ 기본은 로컬로 둔다 — 게이트는 로봇 없이도 돌아야 한다(`all.sh` 는 실기가 꺼진
//   기계에서도 초록이어야 한다). `--url` 은 **배포 직후 번들만 읽고 끝난다. 원격 UI의
//   버튼은 하나도 누르지 않는다.** 2026-09-10 실기 프로필에서 목업 시나리오를 돌리다
//   읽기 전용 조준 3줄을 만든 뒤 중단했다. 실기 검증과 목업 운전을 다시 섞지 않는다.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// **레포 상대 경로다** — 절대 경로로 박으면 남의 기계에서 죽는다 (fr5-web-verify 와 같은 이유)
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openPage, pixelChanged } from './lib/cdp-harness.mjs';
// 후보 개수의 정본은 데이터다 — 게이트가 숫자를 따로 들지 않는다 (하드 룰 5)
import { AMR_HOME, AMR_DROP, AMR_ARRIVE_ERR_MM } from '../../Shared/data/workcell.js';
import { AMR_WHEEL_R_MM } from '../../Shared/data/layout/catalog.js';
import { PREGRIP_PCT } from '../../Shared/data/sim/load-steps.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const REMOTE = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : null;
const BP = 5158, URL = REMOTE ?? 'http://localhost:5176/';
const DATA = mkdtempSync(join(tmpdir(), 'simux-'));
const shotDir = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : DATA;
mkdirSync(shotDir, { recursive: true });
const killTree = (c) => { try { process.kill(-c.pid, 'SIGKILL'); } catch {} };
const bridge = REMOTE ? null : spawn('uv', ['run', '--with', 'fastapi', '--with', 'uvicorn[standard]', '--with', 'pyyaml',
  'uvicorn', 'main:app', '--port', String(BP)],
  { cwd: join(ROOT, 'FR5/bridge'), stdio: 'ignore', detached: true,
    env: { ...process.env, FR5_DATA_DIR: DATA, FR5_TB_HOST: '' /* 조건 27 끔 — 게이트는 터틀봇 없는 기계에서도 초록이어야 한다 */ } });
const web = REMOTE ? null : spawn('npm', ['run', 'dev:fr5'], { cwd: ROOT, stdio: 'ignore', detached: true,
  env: { ...process.env, FR5_PORT: String(BP) } });
process.on('exit', () => {
  if (bridge) killTree(bridge);
  if (web) killTree(web);
  rmSync(DATA, { recursive: true, force: true });
});
const up = async (u) => { for (let i = 0; i < 150; i++) { if (await fetch(u).then(r => r.ok).catch(() => false)) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
if (!REMOTE && !await up(`http://localhost:${BP}/robots`)) { console.log('FAIL 브리지가 안 떴다'); process.exit(1); }
if (!await up(URL)) { console.log(`FAIL ${REMOTE ? '그 주소가 안 뜬다' : 'vite 가 안 떴다'} — ${URL}`); process.exit(1); }
if (REMOTE) console.log(`== 배포된 화면을 본다 — ${URL} ==`);
// ⛔ **목업에 붙여 둔다** — 「따라가기」 스위치는 `disabled={!state.connected}` 라
// 미연결이면 눌러도 아무 일이 없다. 그 상태로 「눌리나」를 재면 영영 false 다.
// 실기가 없는 기계에서도 **조작이 도는지**를 보려면 목업이 그 자리를 맡아야 한다.
if (!REMOTE) {
  await fetch(`http://localhost:${BP}/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // **실기 좌표계를 빌린 목업**이다 (2026-09-06 · `fr5-mock-lab`). 시뮬 탭은 user1 좌표로 `/ik` 를 묻는데
    // `fr5-mock-a` 는 좌표계가 없어 base 로 읽혀 9칸이 전부 「해가 없다」였다 — 그러면 사이클을 못 잰다
    body: JSON.stringify({ robotId: 'fr5-mock-lab', observeOnly: true }),
  }).catch(() => {});
}

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const httpSource = readFileSync(join(ROOT, 'FR5/src/data/datasource/http.js'), 'utf8');
check('살아 있는 carrier-pose 폴링은 브라우저 캐시를 쓰지 않는다',
  /carrierPose:\s*\(\)\s*=>\s*api\([^\n]+cache:\s*['"]no-store['"]/.test(httpSource));
const simSource = readFileSync(join(ROOT, 'FR5/src/features/sim/SimPanel.jsx'), 'utf8');
const mainSource = readFileSync(join(ROOT, 'FR5/src/screens/main.jsx'), 'utf8');
const twinSource = readFileSync(join(ROOT, 'FR5/src/features/live/RobotTwin.jsx'), 'utf8');
const captureSource = readFileSync(join(ROOT, 'FR5/src/features/live/CaptureTwin.jsx'), 'utf8');
const captureScenarioSource = readFileSync(join(ROOT, 'FR5/src/features/sim/CaptureScenario.jsx'), 'utf8');
const followSimSource = readFileSync(join(ROOT, 'FR5/src/features/live/useFollowSim.js'), 'utf8');
const bridgeMainSource = readFileSync(join(ROOT, 'FR5/bridge/main.py'), 'utf8');
const contactSource = readFileSync(join(ROOT, 'FR5/src/features/sim/contact.js'), 'utf8');
const composeSource = readFileSync(join(ROOT, 'Shared/data/sim/scene-compose.js'), 'utf8');
const graspSource = readFileSync(join(ROOT, 'Shared/data/sim/grasp.js'), 'utf8');
const autoSource = readFileSync(join(ROOT, 'FR5/src/features/sim/automatic/useLimitedAutomatic.js'), 'utf8');
const autoControlsSource = readFileSync(join(ROOT, 'FR5/src/features/sim/automatic/AutoRunControls.jsx'), 'utf8');
const aimDataSource = readFileSync(join(ROOT, 'Shared/data/sim/aim.js'), 'utf8');
check('제한 자동화는 SimPanel 본문이 아니라 automatic 폴더의 훅·화면 컴포넌트가 맡는다',
  /useLimitedAutomatic/.test(simSource) && /<AutoRunControls/.test(simSource)
    && !/const putAutomatic|const failAutomatic|const AUTO_STAGES/.test(simSource)
    && /export function useLimitedAutomatic/.test(autoSource)
    && /export function AutoRunControls/.test(autoControlsSource));
check('S0~S4 실행기는 S3 계획·S3R 준비·S4 접촉을 가르고 S4는 고스트 확인 전 명령 0건이다',
  !/\.gripper\(|runPath\(|approveProposal\(/.test(autoSource)
    && /READY_STEP_IDS\s*=\s*\['approach', 'pregrip'\]/.test(autoSource)
    && /PICK_STEP_IDS\s*=\s*\['approach', 'pregrip', 'grasp', 'close', 'lift'\]/.test(autoSource)
    && /run\.limit === 'S3'[\s\S]*solveRef\.current\(\)[\s\S]*solvePickRef\.current\(\)/.test(autoSource)
    && /async function solvePickPrefix\(/.test(simSource)
    && /status:\s*'PREVIEW'/.test(autoSource) && /auto-preview-confirm/.test(autoSource)
    && /await hold\('S3'/.test(autoSource) && /await hold\('S3R'/.test(autoSource) && /await hold\('S4'/.test(autoSource));
check('뎁스 신선도는 맥↔윈도우 시계 오차를 양방향 6초 안에서 허용한다',
  /Math\.abs\(ageS\) > 6/.test(autoSource));
check('즉시 정지는 FR5의 WS와 HTTP 전송로를 모두 사용한다',
  /stop:\s*async/.test(httpSource) && /sendCmd\(\{ cmd: 'stop' \}\)/.test(httpSource)
    && /api\('POST', '\/stop'\)/.test(httpSource));
check('터틀봇 정차 판정은 실기 조건 27의 5mm/s·3°/s 주차 잡음 데드밴드와 같다',
  /TB_STOP_LINEAR_DEADBAND_MM_S\s*=\s*5/.test(simSource)
    && /TB_STOP_ANGULAR_DEADBAND_DEG_S\s*=\s*3/.test(simSource)
    && /> TB_STOP_LINEAR_DEADBAND_MM_S/.test(simSource)
    && /> TB_STOP_ANGULAR_DEADBAND_DEG_S/.test(simSource));
check('파지벽 2개와 손목 180° 동치 2개를 독립된 후보 4개로 푼다',
  /const GRASP_VARIANTS\s*=\s*\[[\s\S]*flip:\s*false,\s*turnDeg:\s*0[\s\S]*flip:\s*false,\s*turnDeg:\s*180[\s\S]*flip:\s*true,\s*turnDeg:\s*0[\s\S]*flip:\s*true,\s*turnDeg:\s*180[\s\S]*\];/.test(simSource)
    && /wrapDeg\(graspYaw \+ graspTurnDeg\)/.test(simSource)
    && /graspFromCenter\(aimed\.carrier\.user1Mm, rz0, flip\)/.test(simSource)
    && /for \(const \{ flip, turnDeg \} of GRASP_VARIANTS\)/.test(simSource)
    && /wrapDeg\(rz0 \+ turnDeg\)/.test(simSource));
check('총알 하강 띠는 최대 벌림 40mm가 아니라 사전 성형 28mm 정본을 쓴다',
  /bulletsNearGraspWall/.test(simSource)
    && /PREGRIP_OPEN_MM/.test(graspSource)
    && !/GRIP_OPEN_MM\s*=\s*40/.test(simSource));
check('S4 닫힘 확인 후 리프트 명령 전 고스트에 거치대를 먼저 붙인다',
  /step\.id === 'close'[\s\S]*closeConfirmed = true;[\s\S]*previewPickRef\.current\?\.\(step, true, plan\.evidence\)/.test(autoSource)
    && /step\.id === 'lift' && closeConfirmed[\s\S]*previewPickRef\.current\?\.\(step, true, plan\.evidence\)[\s\S]*auto-lift-preview[\s\S]*afterPreview = gate\(cur\.id\)[\s\S]*readyStepRef\.current\?\.\(\{ \.\.\.step, guard: \(\) => gate\(cur\.id\)/.test(autoSource)
    && /carrierHeldTcp:\s*pose\.slice\(0, 3\),\s*carrierInHand:\s*true,\s*carrierHold/.test(simSource)
    && /offsetMm:\s*\[o\.dxMm, o\.dyMm\][\s\S]*graspRzDeg:[\s\S]*yawDeg:\s*graspYaw[\s\S]*graspInsetMm:/.test(simSource)
    && /carrierHold=\{replay\?\.carrierHold/.test(mainSource)
    && /holdRef\.current/.test(twinSource));
check('S4는 벽 안쪽 10→0mm를 그리퍼 개폐형상·IK·게이트로 검사해 첫 안전 후보만 고른다',
  /GRASP_INSET_CANDIDATES_MM/.test(simSource)
    && /makeStepsAtInset\(AMR_HOME, insetMm\)/.test(simSource)
    && /fromGripPct:\s*steps\[k - 1\]\.grip,\s*toGripPct:\s*steps\[k\]\.grip/.test(contactSource)
    && /graspInsetMm:\s*insetMm, insetCandidates:\s*tried/.test(simSource)
    && /벽 안쪽 \$\{evidence\.graspInsetMm\}mm/.test(autoSource));
check('S4 총알 검출 좌표 하나가 트윈과 MuJoCo 접촉 장면에 모두 연결된다',
  /bulletsUser1Mm:\s*v\[3\]/.test(simSource)
    && /carrierBulletsUser1Mm=\{carrierSeen\?\.bulletsUser1Mm/.test(mainSource)
    && /carrier\(\{ rounds:\s*0 \}\)/.test(twinSource)
    && /bulletsRef\.current/.test(twinSource)
    && /carrierUser1:[\s\S]*bulletsUser1Mm:\s*liveBullets/.test(simSource)
    && /sceneKey !== nextKey/.test(contactSource)
    && /prop:live-round-/.test(composeSource));
check('촬영 컴포넌트는 분홍 거치대·실주행 판정·추종 고스트를 URL 하나로 묶는다',
  /const captureMode = captureParams\.get\('capture'\) === '1' \|\| carrierOnAmr/.test(mainSource)
    && /captureMode \|\| captureParams\.get\('follow'\) === 'sim'/.test(mainSource)
    && /const \[captureEnabled, setCaptureEnabled\] = useState\(captureMode\)/.test(mainSource)
    && /<CaptureTwin capture=\{captureEnabled && !replay\}/.test(mainSource)
    && /setCaptureEnabled\(true\); setFollowSim\(true\)/.test(mainSource)
    && /amrMoving=\{!replay && state\.amr\?\.moving === true\}/.test(mainSource)
    && /carrierOnAmr=\{capture\}/.test(captureSource)
    && /amrMoving=\{capture && amrMoving\}/.test(captureSource)
    && /data-t="capture-hud"/.test(captureSource)
    && /basketCarrierNode\.name = 'amr-basket-carrier'/.test(twinSource)
    && /amrNode\.add\(basketCarrierNode\)/.test(twinSource)
    && /src: 'basket-confirmed'/.test(twinSource));
check('촬영 컨베이어는 실맵의 투입 벨트만 재사용하고 실제 터틀봇 odom 이동량만 보낸다',
  /buildPreset\('realmap'\)\.props\.filter\(\(p\) => p\.type === 'conveyor' && p\.id === 'convIn'\)/.test(twinSource)
    && !/p\.id === 'convOut'/.test(twinSource)
    && /holder\.name = `live-conveyor:\$\{spec\.id\}`/.test(twinSource)
    && /if \(amrMovingRef\.current && lastConveyorXY\)/.test(twinSource)
    && /d > 0 && d <= 100/.test(twinSource)
    && /c\.belt\?\.setTravelMm\?\.\(conveyorTravelMm\)/.test(twinSource)
    && /source: 'tb-odom'/.test(twinSource));
check('촬영 시나리오는 한 번의 시작으로 FR5 조준→front430 추종→front860 최종 추종을 직렬로 연다',
  /pathName: 'front430'/.test(simSource) && /pathName: 'front860'/.test(simSource)
    && /const startAutomatic = async/.test(captureScenarioSource)
    && /onMoveInitialGhost\?\.\(initialGhost,[\s\S]*onRunFront430\?\.[\s\S]*followStoppedTarget\(token, initialGhost,[\s\S]*onRunFront860\?\.[\s\S]*followStoppedTarget\(token, firstFollowGhost/.test(captureScenarioSource)
    && /FINAL_STOP_X_MM = 860/.test(captureScenarioSource)
    && /setPhase\('DONE'\); setConfirmed\(false\)/.test(captureScenarioSource)
    && /followStep: \(\) => api\('POST', '\/follow\/step', \{ who, token: ownerToken, confirm: '현장확인' \}\)/.test(httpSource));
check('촬영 고스트는 세 팔 이동 전에 2초 고정되고 각 정차 뒤에만 최신 목표로 교체된다',
  /GHOST_PREVIEW_MS = 2000/.test(captureScenarioSource)
    && /lockPreview\(initialPreview\)[\s\S]*wait\(token, GHOST_PREVIEW_MS\)[\s\S]*onMoveInitialGhost/.test(captureScenarioSource)
    && /NEW_FOLLOW_TARGET_MM = 25/.test(captureScenarioSource)
    && /\['wrist', 'odom'\]\.includes\(liveTarget\?\.source\)/.test(captureScenarioSource)
    && /FOLLOW_TARGET_MAX_AGE_S = 1/.test(captureScenarioSource)
    && /tcpDistance\(p\.tcpMmDeg, previousGhost\.tcpMmDeg\) < NEW_FOLLOW_TARGET_MM/.test(captureScenarioSource)
    && /followStoppedTarget\(token, initialGhost, firstStopWhy/.test(captureScenarioSource)
    && /followStoppedTarget\(token, firstFollowGhost, finalStopWhy/.test(captureScenarioSource)
    && /captureGhost\?\.jointsDeg \?\? sim\?\.jointsDeg/.test(mainSource));
check('두 촬영 추종은 moved:false를 성공 처리하지 않고 실제 TCP 도착 전 다음 단계를 열지 않는다',
  /result\.moved !== true[\s\S]*FR5 추종 실기 이동이 0건/.test(captureScenarioSource)
    && /tcpArrived\(stateRef\.current\?\./.test(captureScenarioSource)
    && /FOLLOW_ARRIVE_MM = 5/.test(captureScenarioSource) && /FOLLOW_ARRIVE_DEG = 2/.test(captureScenarioSource)
    && /await log\('capture-follow'/.test(simSource));
check('촬영 STOP은 실행 토큰을 먼저 폐기하고 대기·터틀봇 명령 경계마다 취소를 다시 본다',
  /runTokenRef\.current \+= 1;[\s\S]*setPhase\('STOPPED'\)/.test(captureScenarioSource)
    && /if \(!tokenAlive\(token\)\) return/.test(captureScenarioSource)
    && /onRunFront430\?\.\(\(\) => tokenAlive\(token\)\)/.test(captureScenarioSource)
    && /onRunFront860\?\.\(\(\) => tokenAlive\(token\)\)/.test(captureScenarioSource)
    && /driveAllowed\(\)[\s\S]*getPath[\s\S]*driveAllowed\(\)[\s\S]*claimOwner[\s\S]*driveAllowed\(\)[\s\S]*startSlot/.test(simSource));
check('새로고침 뒤 Chrome 폼 복원보다 늦게 촬영 현장확인을 다시 잠근다',
  /setConfirmationReady\(false\); setConfirmed\(false\)/.test(captureScenarioSource)
    && /setTimeout\(\(\) => setConfirmationReady\(true\), 100\)/.test(captureScenarioSource)
    && /addEventListener\('pageshow', resetConfirmation\)/.test(captureScenarioSource));
check('같은 추종 목표라도 안전 설정·서보·모드·정착 상태가 바뀌면 IK 게이트를 다시 묻는다',
  /const gateKey = JSON\.stringify/.test(followSimSource)
    && /state\?\.appliedSettings\?\.appliedAt/.test(followSimSource)
    && /const gateChanged = r\.gateKey !== gateKey/.test(followSimSource)
    && /r\.gateKey = gateKey/.test(followSimSource));
check('추종은 관절 경계를 래핑하지 않고 평행 그리퍼 동치 TCP 둘을 IK·경로 게이트에 태운다',
  /followPoseCandidates/.test(followSimSource)
    && /Promise\.all\(followPoseCandidates\(goal\)/.test(followSimSource)
    && /maxJointDelta\(state\?\.jointsDeg/.test(followSimSource)
    && /def _follow_motion_solution\(goal, cfg\)/.test(bridgeMainSource)
    && /cmds\.motion\(joints, cfg\["speedPct"\], True, True\)/.test(bridgeMainSource));
check('촬영 시나리오는 원점·첫 정차점·지오펜스·두 로봇 정차와 FR5 실기 준비를 모두 fail-closed로 본다',
  /ORIGIN_MM = 30/.test(captureScenarioSource) && /ORIGIN_DEG = 3/.test(captureScenarioSource)
    && /FIRST_STOP_X_MM = 430/.test(captureScenarioSource) && /FIRST_STOP_TOL_MM = 80/.test(captureScenarioSource)
    && /t\?\.geofence\?\.inside !== true/.test(captureScenarioSource)
    && /s\.phase === 'ARMED'/.test(captureScenarioSource)
    && /s\.mode === 0/.test(captureScenarioSource)
    && /s\.speedOverridePct >= 10/.test(captureScenarioSource)
    && /!t\.stopped \|\| s\?\.amr\?\.moving !== false/.test(captureScenarioSource));
const aimSource = readFileSync(join(ROOT, 'FR5/src/features/sim/AimBlock.jsx'), 'utf8');
check('자동 S2는 거치대 결측을 최대 3회 다시 보고, 총알 부족이면 4개 자세를 탐색하며 STOP 뒤 승인하지 않는다',
  /AUTO_SCAN_ATTEMPTS\s*=\s*3/.test(aimSource)
    && /\{ distMm: 250, yawOffsetDeg: 0 \}[\s\S]*\{ distMm: 225, yawOffsetDeg: 0 \}[\s\S]*\{ distMm: 250, yawOffsetDeg: 90 \}[\s\S]*\{ distMm: 250, yawOffsetDeg: -90 \}/.test(aimDataSource)
    && /scanAtRest/.test(aimSource) && /aim-scan-a-attempt/.test(aimSource)
    && /aim-bullet-search-plan/.test(aimSource) && /aim-scan-a-bullet-search/.test(aimSource)
    && /for \(const spec of specs\)/.test(aimSource) && /if \(lastEvidence\.ok\) break/.test(aimSource)
    && /pz\.a\.pose, gate/.test(aimSource) && /search\.a\.pose, gate/.test(aimSource)
    && /const beforeApprove = guardStep\('approve 직전'\)/.test(simSource)
    && /guard: \(\) => gate\(run\.id\)/.test(autoSource) && /guard: \(\) => gate\(cur\.id\)/.test(autoSource)
    && /return lastValid \?\? last/.test(aimSource)
    && /if \(!bullets\.ok\) return fail\(`\$\{bullets\.why\}/.test(aimSource)
    && /if \(input\.bulletBlocked\) \{ await fail\(input\.bulletBlocked, 'S2'\)/.test(autoSource));
check('실기 그리퍼는 모델값이 아니라 readback으로 보내고 목표 두 표본 전엔 다음 칸을 막는다',
  /const gripNow = stateRef\.current\?\.gripper\?\.pct/.test(simSource)
    && /steady >= 2/.test(simSource) && /다음 이동을 보내지 않아요/.test(simSource));
check('바구니 관측은 시각·당시 터틀봇 자세를 저장하고 오래되거나 이동하면 버린다',
  /BASKET_OBSERVATION_MAX_AGE_MS/.test(simSource) && /measuredAtMs/.test(simSource)
    && /tbPose:\s*tbPose\(tbRef\.current\)/.test(simSource) && /poseChanged\(b\.tbPose, pose\)/.test(simSource));
check('ARM 전 파지벽 판정은 도달 실패로 말하지 않고 ARM 뒤 다시 평가한다',
  /graspYaw, armed/.test(simSource) && /팔은 닿아요 · ARM 뒤 안전장치를 다시 확인해요/.test(simSource));
check('원점 정차를 싣기 위치 도착으로 오인하지 않는다',
  /const tbAtLoadingStop/.test(simSource) && /disabled=\{!tbAtLoadingStop\}/.test(simSource)
    && /싣기 위치에 이미 도착했어요/.test(simSource) && /원점 정차는 해당하지 않음/.test(simSource));
check('총알 수 미달이면 실행 함수와 순차·상세 버튼이 모두 하강·닫기를 막는다',
  /const bulletStepBlocked/.test(simSource)
    && /const goStep = async \(a\) => \{[\s\S]{0,500}if \(bulletStepBlocked\(a\)\)/.test(simSource)
    && /data-t="sim-next"[^>]+disabled=\{[^}]+bulletStepBlocked\(nextAct\)/.test(simSource)
    && /data-t="sim-go-step"[\s\S]{0,400}disabled=\{[^}]+bulletStepBlocked\(a\)/.test(simSource));
check('한 눈 보정의 null 편향값을 숫자로 출력하지 않는다',
  /Number\.isFinite\(aim\.fused\.halfDiffMm\)/.test(aimSource) && /— \(한 눈 보정\)/.test(aimSource));
if (REMOTE) {
  const html = await fetch(URL, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
  const assetPath = html.match(/(?:src|href)="([^"]*\/assets\/(?:index|main)-[A-Za-z0-9_-]+\.js)"/)?.[1] ?? null;
  const bundle = assetPath ? await fetch(new globalThis.URL(assetPath, URL), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')) : '';
  check('원격 HTML이 해시된 FR5 번들을 가리킨다', !!assetPath, assetPath ?? '번들 없음');
  check('원격 번들에 총알 자동 탐색·S3R·S4 고스트 확인이 들어 있다',
    bundle.includes('aim-bullet-search-plan') && bundle.includes('aim-scan-a-bullet-search')
      && bundle.includes('총알 탐색 자세') && bundle.includes('S3R')
      && bundle.includes('고스트 확인 · 집기 실행') && bundle.includes('아직 실기 명령은 0건입니다'));
  check('원격 번들이 검출 총알 동적 접촉 장면과 기대 개수 차단을 포함한다',
    bundle.includes('prop:live-round-') && bundle.includes('접촉 장면을 만들지 않아요'));
  const bad = out.filter((v) => !v).length;
  console.log(`\n${out.length - bad}/${out.length} PASS — 원격 버튼 클릭 0건`);
  process.exit(bad ? 1 : 0);
}
const p = await openPage(URL);
try {
  await p.waitFor(`document.querySelectorAll('nav button').length >= 5`, { timeoutMs: 15000 });
  check('시뮬 탭이 nav 에 있다',
    !!(await p.eval(`[...document.querySelectorAll('nav button')].some(b => b.textContent === '시뮬레이션')`)));
  await p.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '시뮬레이션').click()`);
  const ok = await p.waitFor(`!!document.querySelector('[data-t="sim-cycle"]')`, { timeoutMs: 8000 });
  check('시뮬 탭이 열린다 (터지지 않는다)', !!ok);
  check('정차 안내가 목표거리와 원점 정차 제외를 함께 말한다',
    /목표 430mm/.test(await p.eval(`document.querySelector('[data-t="sim-already-stopped"]')?.textContent ?? ''`))
      && /원점 정차는 해당하지 않음/.test(await p.eval(`document.querySelector('[data-t="sim-already-stopped"]')?.textContent ?? ''`)));
  check('머리가 자동 실행 상한과 수동 한 칸 실행을 구분해 말한다 (접혀도 보인다)',
    /지정 단계|상한 S3/.test(await p.eval(`document.querySelector('[data-t="sim-cycle-note"]')?.textContent ?? ''`)));
  // ── 4단 마법사 (2026-09-07 · D194) — 질문 하나 · 큰 버튼 하나 · 결과 한 문장. 단계 넷 중 **하나만 보인다**(나머지는 hidden · DOM 엔 있다)
  check('단계 표시 넷이 있고 ① 이 켜져 있다', (await p.eval(`document.querySelectorAll('[data-t="sim-wizard"] button').length === 4 && document.querySelector('[data-t="sim-stage-1"]')?.getAttribute('aria-current') === 'step'`)) === true);
  check('단계 내용 넷 중 하나만 보인다 (나머지는 hidden)', (await p.eval(`[...document.querySelectorAll('[data-t="sim-stage"]')].filter(s => !s.hidden).length`)) === 1);
  check('② ③ 은 앞 단계가 끝나기 전엔 눌리지 않는다', (await p.eval(`document.querySelector('[data-t="sim-stage-2"]').disabled && document.querySelector('[data-t="sim-stage-3"]').disabled`)) === true);
  check('① 의 큰 버튼은 「거치대 찾기」 하나다', (await p.eval(`[...document.querySelectorAll('[data-t="sim-stage"][data-n="1"] button.big')].map(b => b.textContent).join('|')`)).includes('거치대 찾기'));
  const visibleCtl = await p.eval(`[...document.querySelectorAll('[data-t="sim-cycle"] button, [data-t="sim-cycle"] select, [data-t="sim-cycle"] input')].filter(e => e.offsetParent !== null && !e.closest('details:not([open])')).length`);
  check('기본 화면의 조작 요소가 11개 이하다 (자동 상한·확인·시작·정지 포함)', visibleCtl <= 11, `지금 ${visibleCtl}개`);
  // ── 탭 재구성 (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 5 + 촬영 시나리오) — 촬영 절 + 기존 기본 마법사.
  //    「따라간다」 절은 3D 좌상단 스위치 하나로 돌아갔고, 관측 후보는 사이클 관측 칸에 흡수, 되감기는 터틀봇 탭으로 갔다.
  //    지운 게 아니라 옮긴 것이므로 **옮겨간 자리에 살아 있는지**까지 본다(3D 스위치 · 터틀봇 탭은 맨 끝에서).
  check('맨 위가 별도 「촬영 시나리오」 절이다 — front430·front860 두 추종이 먼저 보인다',
    (await p.eval(`document.querySelector('.sim > *')?.dataset.t`)) === 'capture-scenario');
  check('시뮬 탭에 따라가기·관측 후보·되감기 절이 없다 (옮겼다)',
    (await p.eval(`['sim-follow', 'sim-view', 'sim-runs', 'sim-why', 'sim-carrier'].filter((k) => document.querySelector('[data-t="' + k + '"]')).join(',')`)) === '');
  check('절이 둘이다 — 촬영 시나리오와 기존 입력·세 층 답·사이클',
    (await p.eval(`[...document.querySelectorAll('.sim > [data-t]')].map((e) => e.dataset.t).join(',')`)) === 'capture-scenario,sim-cycle');
  check('촬영 시나리오는 여섯 칸이며 시작 전 자동 버튼 1개가 잠기고 STOP만 따로 있다',
    (await p.eval(`document.querySelectorAll('[data-t="capture-scenario"] .capturesteps li').length`)) === 6
      && (await p.eval(`document.querySelectorAll('[data-t="capture-scenario"] .row button').length`)) === 2
      && (await p.eval(`document.querySelector('[data-t="capture-scenario-confirm"]')?.checked`)) === false
      && (await p.eval(`document.querySelector('[data-t="capture-scenario-auto-start"]')?.disabled`)) === true
      && (await p.eval(`!!document.querySelector('[data-t="capture-scenario-stop"]')`)) === true);
  // 따라가기는 3D 스위치 **하나**가 주인이다 — 있는 것과 도는 것은 다르므로 눌러서 바뀌는지까지 본다.
  // 스위치는 `disabled={!state.connected}` 라 WebSocket 첫 판을 기다린다(2026-09-04 실측: 원격이 한 박자 늦어 게이트가 자기 경합을 결함으로 보고했다)
  await p.waitFor(`document.querySelector('[data-t="followsim"] button')?.disabled === false`, { timeoutMs: 15000 });
  await p.eval(`document.querySelector('[data-t="followsim"] button').click()`);
  const followOn = await p.waitFor(`document.querySelector('[data-t="followsim"] button')?.getAttribute('aria-pressed') === 'true'`, { timeoutMs: 5000 });
  check('3D 좌상단 「따라가기」 스위치가 살아 있고 눌리면 켜진다', followOn);
  await p.eval(`document.querySelector('[data-t="followsim"] button').click()`);
  check('풀기 전엔 답 줄이 없다 — 0/10 을 초록으로 그리지 않는다', !(await p.eval(`!!document.querySelector('[data-t="sim-answer"]')`)));
  const propsOk = await p.waitFor(`(() => {
    const s = window.__twin?.stage?.scene;
    return !!s?.getObjectByName('fixture2') && ['작업대1','작업대2','작업대3'].every((n) => !!s.getObjectByName('stand:' + n));
  })()`, { timeoutMs: 8000 });
  check('트윈 작업셀에 거치대2와 작업대 셋이 배열 순서와 무관하게 모두 선다', propsOk);
  const fixtureCounts = JSON.parse(await p.eval(`(() => { const f = window.__twin?.stage?.scene?.getObjectByName('fixture2');
    let holes = 0; let rounds = 0; let rails = 0; f?.traverse((o) => { holes += o.name?.startsWith('fixture2-hole-') ? 1 : 0; rounds += o.name?.startsWith('fixture2-round-') ? 1 : 0; rails += o.name?.startsWith('fixture2-rail-') ? 1 : 0; });
    return JSON.stringify({ holes, rounds, rails }); })()`));
  check('거치대2는 글로벌카메라에서 본 3×3 구멍·총알 2개·클램프 3개다', fixtureCounts.holes === 9 && fixtureCounts.rounds === 2 && fixtureCounts.rails === 3, JSON.stringify(fixtureCounts));
  const matCount = await p.eval(`(() => { const s = window.__twin?.stage?.scene; return ['작업대1','작업대2','작업대3'].filter((n) => {
    let mapped = false; s?.getObjectByName('stand:' + n)?.traverse((o) => { const ms = Array.isArray(o.material) ? o.material : [o.material]; if (ms.some((m) => !!m?.map)) mapped = true; }); return mapped;
  }).length; })()`);
  check('작업대 셋은 기존 글로벌캠 대조 매트 텍스처를 쓴다', matCount === 3, `${matCount}/3`);
  const continuousMats = JSON.parse(await p.eval(`(() => { const s = window.__twin?.stage?.scene; return JSON.stringify(['작업대1','작업대2'].map((n) => {
    const m = s?.getObjectByName('bench-mat:' + n); const p = m?.getWorldPosition(m.position.clone()); const g = m?.geometry?.parameters ?? {};
    return { name: n, widthMm: Math.round((g.width ?? 0) * 1000), depthMm: Math.round((g.depth ?? 0) * 1000), xMm: Math.round((p?.x ?? 0) * 1000), yMm: Math.round((p?.y ?? 0) * 1000), zMm: Math.round((p?.z ?? 0) * 1000) };
  })); })()`));
  const [mat1, mat2] = continuousMats;
  check('작업대1·2 검정 매트가 같은 줄에서 각 상판 가로 800mm를 전부 채우며 맞닿는다',
    continuousMats.length === 2 && continuousMats.every((m) => m.widthMm === 800 && m.depthMm === 96)
      && mat1.yMm === mat2.yMm && mat1.zMm === mat2.zMm
      && Math.abs(mat1.xMm - mat2.xMm) === (mat1.widthMm + mat2.widthMm) / 2,
    JSON.stringify(continuousMats));
  await p.waitFor(`!!window.__twin?.stage?.scene?.getObjectByName('amr-burger')`, { timeoutMs: 8000 });
  const burgerColors = JSON.parse(await p.eval(`(() => { const b = window.__twin?.stage?.scene?.getObjectByName('amr-burger'); const c = []; b?.traverse((o) => { if (o.isMesh && o.material?.color) c.push(o.material.color.getHex()); }); return JSON.stringify([...new Set(c)]); })()`));
  check('실제 터틀봇 모델은 글로벌카메라와 같은 검정/진회색이다', burgerColors.length > 0 && burgerColors.every((c) => c === 0x14181b), burgerColors.map((c) => `#${c.toString(16).padStart(6, '0')}`).join(','));
  const hints = await p.eval(`[...document.querySelectorAll('[data-t="sim-cycle"] .hint, [data-t="sim-cycle"] .sentence')].filter(e => e.offsetParent !== null && !e.closest('details:not([open])')).length`);
  check('기본 화면의 설명 문단이 3개 이하다 (보이는 것만)', hints <= 3, `지금 ${hints}개`);
  check('10칸이 다 있고 사전 성형은 높은 접근 자세다',
    (await p.eval(`document.querySelectorAll('[data-t="sim-cycle"] ol.steps li').length`)) === 10
      && (await p.eval(`document.querySelector('[data-t="sim-cycle"] ol.steps').textContent.includes('내려가기 전 손 맞춤')`)) === true);
  check('⑨ 빠져나온다가 있다',
    !!(await p.eval(`document.querySelector('[data-t="sim-cycle"] ol.steps').textContent.includes('빠져나온다')`)));
  // ── 컨베이어 한 사이클 (2026-09-06 · `GRILL-conveyor-twin`) — **풀고, 돌리고, 그림이 바뀌는지**까지 본다.
  // 9칸은 컨트롤러(여기서는 mock 의 URDF IK)에 묻는다 — 붙은 뒤에만 눌린다.
  // ── 2단 조준 (2026-09-07 · D192 · `plan/LAB-STEP-TEST-PLAN.md` Phase 0) — ⓐ 대강 → ⓑ 거울 쌍 자세 → ⓒⓓ 스캔 → ⓔ 융합.
  //    목업 스캔은 **툴 프레임 고정 편향**(12, −8)을 진값에 얹으므로 한 뷰는 14.4mm 틀리고, rz±90 두 뷰의 평균은 진값이어야 한다.
  //    첫 패스는 「고정인지 모른다 → 한 번 더」, 둘째 패스는 평균 일치(0.00mm) → 통과 → 9칸이 그 자리로. 버튼 순서가 강제되는지(뒤 칸 비활성)도 본다
  const aimBtn = (k) => `document.querySelector('[data-t="sim-aim-${k}"]')`;
  check('2단 조준 블록이 사이클 절 안에 있다 (절은 그대로 하나)', (await p.eval(`!!document.querySelector('[data-t="sim-cycle"] [data-t="sim-aim"]')`)) === true);
  check('앞 칸 없이 뒤 칸은 눌리지 않는다 (ⓑ~ⓔ 비활성)', await p.eval(`['b','c','d','e'].every(k => ${'document.querySelector(`[data-t="sim-aim-${k}"]`)'}?.disabled === true)`));
  const aimStep = async (k, readyK, ms = 15000) => { await p.waitFor(`${aimBtn(k)}?.disabled === false`, { timeoutMs: ms }); await p.eval(`${aimBtn(k)}.click()`); if (readyK) await p.waitFor(`${aimBtn(readyK)}?.disabled === false`, { timeoutMs: ms }); };
  await aimStep('a', 'b');
  const coarse = await p.eval(`document.querySelector('[data-t="sim-aim-coarse"]')?.textContent ?? ''`);
  check('ⓐ 대강값이 출처를 말한다 (목업 = 08-31 정본을 중심으로 되돌린 것)', /출처 truth-0831/.test(coarse), coarse.slice(0, 70));
  await aimStep('b', 'c', 30000);
  const posesTxt = await p.eval(`document.querySelector('[data-t="sim-aim-coarse"]')?.textContent ?? ''`);
  check('ⓑ 거울 쌍 두 자세가 둘 다 닿는다 (rz 가 180° 차)', /자세 A rz .*✓.* \/ B rz .*✓/.test(posesTxt), posesTxt.slice(-80));
  const rzs = JSON.parse(await p.eval(`JSON.stringify([window.__aim?.poses?.rzA, window.__aim?.poses?.rzB])`));
  check('두 자세의 손목 요각 차가 180°±0.5', Math.abs(Math.abs(((rzs[0] - rzs[1]) % 360 + 540) % 360 - 180) - 0) < 0.5 || Math.abs(Math.abs(rzs[0] - rzs[1]) - 180) < 0.5, `${rzs}`);
  await aimStep('c', 'd'); await aimStep('d', 'e'); await aimStep('e', null);
  await new Promise((r) => setTimeout(r, 400));
  const note1 = await p.eval(`document.querySelector('[data-t="sim-aim-note"]')?.textContent ?? ''`);
  const pass2 = await p.eval(`document.querySelector('[data-t="sim-aim"]')?.dataset.pass`);
  check('첫 패스 — 편향 14.4mm 를 보고 「한 번 더」로 돌려보낸다 (고정인지 모르므로 통과시키지 않는다)', /한 번 더/.test(note1) && pass2 === '2', note1.slice(0, 80));
  await aimStep('b', 'c', 30000); await aimStep('c', 'd'); await aimStep('d', 'e'); await aimStep('e', null);
  const fusedOk = await p.waitFor(`document.querySelector('[data-t="sim-aim-fused"]')?.dataset.ok === 'true'`, { timeoutMs: 8000 });
  const fusedTxt = await p.eval(`document.querySelector('[data-t="sim-aim-fused"]')?.textContent ?? ''`);
  check('둘째 패스 — 두 패스의 평균이 일치해 통과 (고정 편향이라 지워졌다)', fusedOk && /두 패스 차 0\.00mm/.test(fusedTxt), fusedTxt.slice(0, 120));
  const fused = JSON.parse(await p.eval(`JSON.stringify(window.__aim?.fused ?? null)`));
  const coarseTruth = JSON.parse(await p.eval(`JSON.stringify(window.__aim?.coarse?.user1Mm ?? null)`));
  check('융합 자리가 진값(대강값)과 0.1mm 안 — 단일 뷰는 편향 14.4mm 만큼 틀렸다', !!fused && Math.hypot(fused.user1Mm[0] - coarseTruth[0], fused.user1Mm[1] - coarseTruth[1]) < 0.1 && fused.halfDiffMm > 10,
    fused ? `융합 (${fused.user1Mm[0].toFixed(1)}, ${fused.user1Mm[1].toFixed(1)}) · 편향 ${fused.halfDiffMm}` : '융합 없음');
  check('통과한 융합값이 10칸 입력으로 흐른다 (거치대 자리는 융합값)', (await p.eval(`!!document.querySelector('[data-t="sim-aimed-carrier"]')`)) === true);
  // 트윈 — 카메라가 본(융합) 거치대는 **분홍·실측**으로 서고(D128 불투명=실기), 조준이 세운 고스트는 9칸 재생성에도 남는다(고스트 주인 규칙 · 2026-09-07)
  const cm = await p.waitFor(`window.__carrierMm && window.__carrierMm.src === 'seen' && window.__carrierMm.paint === 'pink'`, { timeoutMs: 6000 });
  check('트윈의 거치대가 카메라가 본 자리에 분홍(실측)으로 선다', cm, JSON.stringify(await p.eval(`window.__carrierMm && { src: window.__carrierMm.src, paint: window.__carrierMm.paint }`)));
  const drawnRounds = JSON.parse(await p.eval(`JSON.stringify(window.__carrierRoundsMm ?? [])`));
  const carrierNow = JSON.parse(await p.eval(`JSON.stringify(window.__carrierMm ?? null)`));
  const detectedOffset = fused?.bulletsUser1Mm?.[0]
    ? Math.hypot(fused.bulletsUser1Mm[0][0] - fused.user1Mm[0], fused.bulletsUser1Mm[0][1] - fused.user1Mm[1]) : NaN;
  const drawnOffset = drawnRounds[0] && carrierNow
    ? Math.hypot(drawnRounds[0].x - carrierNow.x, drawnRounds[0].y - carrierNow.y) : NaN;
  const brass = await p.eval(`(() => { const n=window.__twin?.stage?.scene?.getObjectByName('carrier-live-round-0'); let c=null; n?.traverse(o=>{ if(c==null && o.material?.color) c=o.material.color.getHex(); }); return c; })()`);
  const hasMockBullet = Array.isArray(fused?.bulletsUser1Mm) && fused.bulletsUser1Mm.length > 0;
  check('트윈은 검출 없는 목업에서 중앙 총알을 만들지 않고, 검출값이 있으면 그 오프셋·황동색만 쓴다',
    hasMockBullet
      ? drawnRounds.length === fused.bulletsUser1Mm.length && Math.abs(drawnOffset - detectedOffset) < 0.5 && brass === 0xa8874f
      : drawnRounds.length === 0 && brass == null,
    hasMockBullet ? `${drawnRounds.length}개 · 검출 ${detectedOffset.toFixed(1)}mm / 그림 ${drawnOffset.toFixed(1)}mm · #${Number(brass).toString(16)}` : '검출 0 · 그림 0');
  check('찾기가 끝난 뒤에도 조준 고스트(자세 B)가 남아 있다', (await p.eval(`!!window.__ghostTcpMm`)) === true);
  // ① 이 끝나면 ② 로 스스로 넘어가고 큰 버튼은 「계획 세우기」 하나
  const stage2 = await p.waitFor(`document.querySelector('[data-t="sim-stage-2"]')?.getAttribute('aria-current') === 'step'`, { timeoutMs: 5000 });
  check('① 이 끝나면 ② 로 스스로 넘어간다', stage2);
  const solveBtn = `document.querySelector('[data-t="sim-plan"]')`;
  await p.waitFor(`${solveBtn}?.disabled === false`, { timeoutMs: 15000 });
  await p.eval(`${solveBtn}.click()`);
  const solvedOk = await p.waitFor(`!!document.querySelector('[data-t="sim-score"]')`, { timeoutMs: 60000 });
  const score = await p.eval(`document.querySelector('[data-t="sim-score"]')?.textContent ?? ''`);
  check('10칸이 풀린다 (mock URDF IK · user1 좌표계)', solvedOk && /닿는 자세 10\/10/.test(score), score.slice(0, 40));
  const targetShown = await p.waitFor(`window.__amrTarget?.visible === true && !!document.querySelector('[data-t="amr-target-note"]')`, { timeoutMs: 8000 });
  const targetInfo = JSON.parse(await p.eval(`JSON.stringify(window.__amrTarget ?? null)`));
  const targetPathVisible = await p.eval(`window.__twin.stage.scene.getObjectByName('amr-target-path')?.visible === true`);
  check('계획 통과 뒤 현재 터틀봇과 별개인 초록 목표 고스트·점선이 선다', targetShown
    && targetInfo.currentMm && targetInfo.targetMm && targetInfo.distanceMm > 1
    && Math.abs(targetInfo.distanceMm - Math.hypot(targetInfo.targetMm.x - targetInfo.currentMm.x, targetInfo.targetMm.y - targetInfo.currentMm.y)) < 1
    && targetPathVisible,
  targetInfo ? `${JSON.stringify(targetInfo)} · 점선 ${targetPathVisible}` : '목표 없음');
  if (argv.includes('--shot')) {
    const targetRect = await p.rect('[data-t="twin"]');
    await p.screenshot(join(shotDir, 'amr-target.png'), targetRect ?? undefined);
  }
  // 둘째 층 — 부딪히나. 브라우저 무조코가 9칸 사이 길을 재고 요약 한 줄을 낸다. 장면(`/sim/scene`)이 있으면 숫자, 없으면 사유
  // 「재는 중…」은 답이 아니다 — 엔진(9.7MB)을 받고 표본을 다 돌 때까지 기다린다(부하에서 수십 초)
  const contactOk = await p.waitFor(`(() => { const s = document.querySelector('[data-t="sim-contact"]')?.textContent ?? ''; return /접촉/.test(s) && !/재는 중/.test(s); })()`, { timeoutMs: 120000 });
  const contactTxt = await p.eval(`document.querySelector('[data-t="sim-contact"]')?.textContent ?? ''`);
  check('접촉 층이 답한다 (숫자 또는 못 재는 사유)', contactOk, contactTxt.slice(0, 90));
  // ── 정차 자리는 사이클이 고른다 (phase 2) — 현장 최소거리 이상 후보를 전부 평가한다. **개수·선택을 박지 않는다** — 되는 자리가
  // 0 이어도 답이다(2026-09-06 실측: 채택값은 거치대 자리와 4.4mm 겹치고, 홈 근처 6 은 팔·카메라가 옆 판·바구니에 5~68mm 파고든다)
  await p.waitFor(`Array.isArray(window.__stopEvals)`, { timeoutMs: 240000 });
  const evals = JSON.parse(await p.eval(`JSON.stringify(window.__stopEvals ?? [])`));
  check('현장 최소거리 이상 정차 후보를 전부 평가한다 (닿나·접촉·시간·뻗음)', evals.length >= 1 && evals.every((e) => typeof e.reachable === 'boolean' && typeof e.contactLegs === 'number' && (e.dwellSec === null || Number.isFinite(e.dwellSec))),
    `후보 ${evals.length} · 닿음 ${evals.filter((e) => e.reachable).length} · 접촉 없는 자리 ${evals.filter((e) => e.reachable && !e.contactLegs).length}`);
  check('접촉이 있는 후보는 어느 구간·무엇·얼마나 파고드는지 든다', evals.filter((e) => e.contactLegs).every((e) => e.hits.length && /−\d+\.\dmm/.test(e.hits[0])),
    (evals.find((e) => e.contactLegs)?.hits[0] ?? '').slice(0, 100));
  const stopWhy = await p.eval(`document.querySelector('[data-t="sim-stop-why"]')?.textContent ?? ''`);
  check('정차 자리 한 줄이 「고른 이유」거나 「되는 자리가 없다」로 말한다', /제일 (빠름|덜 뻗음)|되는 정차 자리가 없어요/.test(stopWhy), stopWhy.slice(0, 110));
  const optTexts = await p.eval(`[...document.querySelectorAll('[data-t="sim-stop"] select option')].map(o => o.textContent).join('|')`);
  check('드롭다운이 후보마다 판정 꼬리표(✗·💥·초)를 단다', optTexts.split('|').length === evals.length && evals.every((e, i) => new RegExp(e.reachable ? (e.contactLegs ? '💥' : '\\d+s') : '✗').test(optTexts.split('|')[i])), optTexts.slice(0, 120));
  await p.eval(`[...document.querySelectorAll('[data-t="sim-stop"] button')].find(b => b.textContent === '덜 뻗게').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const afterStop = await p.eval(`document.querySelector('[data-t="sim-stop-why"]')?.textContent ?? ''`);
  check('우선순위를 바꿔도 다시 풀지 않고 즉시 답한다', /제일 (빠름|덜 뻗음)|되는 정차 자리가 없어요/.test(afterStop) && !/평가 중/.test(afterStop), afterStop.slice(0, 90));
  await p.eval(`[...document.querySelectorAll('[data-t="sim-stop"] button')].find(b => b.textContent === '빠르게').click()`);
  await new Promise((r) => setTimeout(r, 300));
  // 현장 중간 재개 — 사람이 「이미 정차」를 확인하면 후보 전체와 첫 주행을 다시 보내지 않는다.
  await p.eval(`document.querySelector('[data-t="sim-stage-2"]').click(); document.querySelector('[data-t="sim-already-stopped"] input').click()`);
  await p.waitFor(`!document.querySelector('[data-t="sim-score"]')`, { timeoutMs: 5000 });
  await p.eval(`${solveBtn}.click()`);
  await p.waitFor(`Array.isArray(window.__stopEvals) && window.__stopEvals.length === 1 && Array.isArray(window.__cycleActs)`, { timeoutMs: 90000 });
  const resumeIds = JSON.parse(await p.eval(`JSON.stringify((window.__cycleActs ?? []).map(a => a.id))`));
  check('이미 정차했으면 현재 자리 하나만 평가하고 홈→정차 주행을 만들지 않는다',
    resumeIds.length > 0 && resumeIds[0] === 'approach' && !resumeIds.includes('d-in'), `첫 칸 ${resumeIds[0]} · 후보 ${await p.eval(`window.__stopEvals?.length`)}`);
  // 아래 기존 검사는 홈 출발 전체 사이클의 유령·바퀴·후보 선택을 잰다. 재개 검사가 그 전제를 바꾼 채 두지 않는다.
  await p.eval(`document.querySelector('[data-t="sim-stage-2"]').click(); document.querySelector('[data-t="sim-already-stopped"] input').click()`);
  await p.eval(`${solveBtn}.click()`);
  await p.waitFor(`Array.isArray(window.__stopEvals) && window.__stopEvals.length >= 1 && Array.isArray(window.__cycleActs) && window.__cycleActs[0]?.id === 'approach'`, { timeoutMs: 240000 });
  check('사이클 절이 있고 재생 버튼이 선다 (10칸이 다 풀렸다는 뜻)',
    (await p.eval(`!!document.querySelector('[data-t="sim-cycle"] [data-t="sim-cycle-play"]')`)) === true);
  // ② 신호등 셋 — 닿아요 초록 · 부딪히나(숫자 또는 사유) · 안전장치(목업은 빨강 + 「랩에서 ARM 하면」) → ③ 으로 스스로 넘어가고 「다음 칸 ▶」이 한 칸씩 보낸다
  const lightsOk = JSON.parse(await p.eval(`JSON.stringify([...document.querySelectorAll('[data-t="sim-lights"] li')].map(l => [l.dataset.t, l.dataset.ok, l.textContent.slice(0, 60)]))`));
  check('② 신호등 셋 — 닿아요 초록 · 안전장치는 사람 말로 왜 빨간지 말한다', lightsOk.length === 3 && lightsOk[0][1] === 'true' && /ARM|안전장치/.test(lightsOk[2][2]), JSON.stringify(lightsOk).slice(0, 160));
  const stage3 = await p.waitFor(`document.querySelector('[data-t="sim-stage-3"]')?.getAttribute('aria-current') === 'step'`, { timeoutMs: 5000 });
  check('계획이 초록이면 ③ 으로 스스로 넘어간다', stage3);
  const next0 = await p.eval(`document.querySelector('[data-t="sim-next"]')?.textContent ?? ''`);
  check('③ 의 큰 버튼이 「다음 칸 ▶ + 칸 이름」이고 정지 버튼이 옆에 있다', /다음 칸/.test(next0) && !!(await p.eval(`!!document.querySelector('[data-t="sim-stop-btn"]')`)), next0.slice(0, 40));
  check('③ 준비 줄(조종권·ARM·자동·전역 속도)은 실기에서만 — 목업엔 없다', (await p.eval(`!document.querySelector('[data-t="sim-ready"]')`)) === true);
  await p.eval(`document.querySelector('[data-t="sim-next"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const next1 = await p.eval(`document.querySelector('[data-t="sim-next-status"]')?.textContent ?? ''`);
  check('「다음 칸」을 누르면 한 칸 나아가고 지난 칸을 말한다 (목업은 기록만)', /2\/\d+/.test(next1) && /지난 칸/.test(next1), next1.slice(0, 80));
  // ── 한 칸 실기로 (2026-09-07 · D191) — 팔 구간마다 「실기」 버튼. 목업이면 **안 보내고 기록만**. 기록은 브리지 `/runs` 한 줄
  const goN = await p.eval(`document.querySelectorAll('[data-t="sim-go-step"]').length`);
  const armN = await p.eval(`(window.__cycleActs ?? []).filter(a => a.nextJ).length`);
  check('팔 구간마다 「실기」 버튼이 있다 (주행 구간엔 없다)', goN > 0 && goN === armN, `버튼 ${goN} · 팔 구간 ${armN}`);
  check('목업 프로필이면 버튼이 「기록만」이라 말한다', await p.eval(`document.querySelector('[data-t="sim-go-confirm"]')?.dataset.mock === 'true' && /기록만/.test(document.querySelector('[data-t="sim-go-step"]')?.textContent ?? '')`));
  await p.eval(`document.querySelectorAll('[data-t="sim-go-step"]')[1].click()`);
  await new Promise((r) => setTimeout(r, 600));
  if (!REMOTE) {
    const runs = await fetch(`http://localhost:${BP}/runs`).then((r) => r.json()).catch(() => []);
    const last = runs[runs.length - 1];
    const doc = last ? await fetch(`http://localhost:${BP}/runs/${last.runId}`).then((r) => r.json()) : null;
    const steps = (doc?.lines ?? []).map((l) => l.step);
    check('버튼 한 번 = 기록 한 줄 — ⓐ~ⓔ 두 패스·풀기·실기가 전부 장부에 있다', steps.includes('aim-a') && steps.filter((s) => s === 'aim-e').length === 2 && steps.includes('solve') && steps.includes('go'),
      `${last?.runId} · ${steps.length}줄 · ${[...new Set(steps)].join(',')}`);
    const go = (doc?.lines ?? []).find((l) => l.step === 'go' && !l.drive);   // 첫 칸부터 팔의 집기 단계다
    check('목업 실기 줄은 sent=null · mock=true · 해(관절각)와 readback 을 든다', !!go && go.sent === null && go.mock === true && Array.isArray(go.solved?.jointsDeg) && !!go.readback,
      go ? JSON.stringify({ sent: go.sent, mock: go.mock, j: go.solved?.jointsDeg?.length }) : '줄 없음');
    const scanLine = (doc?.lines ?? []).find((l) => l.step === 'aim-scan-a');
    check('스캔 줄이 원값(자세 rz · user1 · source)을 그대로 든다', !!scanLine?.scan?.user1Mm && scanLine.scan.source === 'mock' && Number.isFinite(scanLine.scan.rzDeg));
  }
  await p.eval(`document.querySelector('[data-t="sim-log"]')?.setAttribute('open', ''); document.querySelector('[data-t="sim-log-refresh"]')?.click()`);
  const logOk = await p.waitFor(`document.querySelectorAll('[data-t="sim-log-lines"] li').length >= 10`, { timeoutMs: 8000 });
  check('기록 절이 장부를 되감는다 (줄 10개 이상 · 줄을 누르면 그때 자세)', logOk, String(await p.eval(`document.querySelectorAll('[data-t="sim-log-lines"] li').length`)));
  // **3D 캔버스만 잘라 비교한다** — 전체 화면이면 옆 패널의 「N초 전」 텍스트만 바뀌어도 「3D 가 바뀌었다」로 통과한다 (감사 2026-09-06 ④-1)
  const twinRect = await p.rect('[data-t="twin"]');
  check('3D 캔버스가 있다 (클립 대상)', !!twinRect && twinRect.width > 100);
  const acts = JSON.parse(await p.eval(`JSON.stringify(window.__cycleActs ?? [])`));
  const dIn = acts.find((a) => a.id === 'd-in');
  check('실행 순서가 집기·들기 → 터틀봇 이동 → 놓기다', acts[0]?.id === 'approach'
    && acts.findIndex((a) => a.id === 'lift') < acts.findIndex((a) => a.id === 'd-in')
    && acts.findIndex((a) => a.id === 'd-in') < acts.findIndex((a) => a.id === 'carry'), acts.map((a) => a.id).join(' → '));
  const shot0 = await p.screenshot(join(shotDir, 'sim-cycle-0.png'), twinRect ?? undefined);
  await p.eval(`document.querySelector('[data-t="sim-cycle-play"]').click()`);
  // 배속 5 · 접근·사전성형을 지나 팔이 실제로 움직이는 구간까지 기다린다
  const moved = await p.waitFor(
    `/^(\\d+)\\/\\d+/.test(document.querySelector('[data-t="sim-cycle-cur"]')?.textContent ?? '') && Number(RegExp.$1) >= 3`,
    { timeoutMs: 30000 });
  const cur = await p.eval(`document.querySelector('[data-t="sim-cycle-cur"]')?.textContent ?? ''`);
  check('사이클이 돈다 — 구간이 넘어간다', moved, cur.slice(0, 60));
  const shot1 = await p.screenshot(join(shotDir, 'sim-cycle-1.png'), twinRect ?? undefined);
  check('3D 캔버스 픽셀이 실제로 바뀐다 (팔이 집기 순서를 시작했다)', pixelChanged(shot0, shot1));
  // 아래 바퀴·유령 검사는 d-in 완료 시각을 직접 찍는다. 첫 주행이 뒤로 갔으므로 구간 번호로 추측하지 않는다.
  if (dIn) {
    await p.eval(`window.__cycleSeek(${dIn.t0Ms + dIn.durMs - 1})`);
    await new Promise((r) => setTimeout(r, 300));
  }
  // 바퀴 — 홈→정차 목표거리만큼 굴렀으면 그 거리÷반지름만큼 돌아 있어야 한다 (`burger.js` `rollWheels`).
  // 값이 null 이면 GLB 에 바퀴 노드가 없다(옛 한 덩어리).
  // 도착 오차 유령 — 첫 주행(홈→정차)이 끝난 뒤라 명령 자리와 실측 오차(37.5mm)만큼 벌어져 있어야 한다
  const driftMm = await p.eval(`window.__amrDriftMm ?? null`);
  check('도착 오차 유령이 명령 자리에서 실측 37.5mm 벌어져 선다', driftMm !== null && Math.abs(driftMm - AMR_ARRIVE_ERR_MM) < 1,
    driftMm === null ? '유령 없음' : `${driftMm.toFixed(1)}mm`);
  check('홈 두 후보(정본 실선 · 손목 뎁스 점선)가 바닥에 그려진다',
    (await p.eval(`window.__amrHomeCandidates ?? 0`)) === 2);
  const wheelRad = await p.eval(`window.__amrWheelRad ?? null`);
  // 실물 메시는 **실제로 선 자리**에 선다(2026-09-06 · 명령 자리는 회색 상자) — 바퀴는 목표거리−도착오차만큼 돈다
  const wantRad = (Math.abs(AMR_HOME.xMm - AMR_DROP.xMm) - AMR_ARRIVE_ERR_MM) / AMR_WHEEL_R_MM;
  // 부호까지 본다 — 앞으로 굴렀으면 `wheelSign` −1 이라 **음수**여야 한다. 크기만 보면 거꾸로 도는 바퀴도 통과한다 (감사 ④-2)
  check('바퀴가 실제로 굴러간 거리만큼 앞으로 돈다 ((목표거리 − 도착오차) ÷ 반지름)',
    wheelRad !== null && Math.abs(wheelRad - (-wantRad)) < 0.05,
    wheelRad === null ? '바퀴 노드 없음' : `${wheelRad.toFixed(2)} rad · 기대 ${(-wantRad).toFixed(2)}`);
  // ── 관측 칸 둘 (phase 3) — 「거치대를 본다」「터틀봇을 본다」가 사이클에 있고, 터틀봇 관측 칸에서는 손목 뎁스 발자국이 **초록**이어야 한다
  //    (라이다 윗면을 시선각 20°·거리 300 에서 본다 → 깊이 195~1000 안 · 발자국 안). 시각은 훅으로 옮긴다
  // 2026-09-07 — 마법사 ①(2단 조준)이 거치대 자리를 냈으면 ⓪ 「거치대를 본다」는 안 만든다(`buildCycle carrierKnown`). 남는 관측은 터틀봇 둘(⓪ 도착 · ⑩ 되돌아옴)
  const oC = acts.find((a) => a.id === 'o-carrier'); const oA = acts.find((a) => a.id === 'o-amr'); const oIn = acts.find((a) => a.id === 'o-amr-in');
  check('사이클 관측 칸 — 터틀봇 둘(⓪ 도착 · ⑩ 되돌아옴)은 있고 거치대 관측은 마법사가 대신해 없다', !oC && !!oA && !!oIn, `구간 ${acts.length} · 첫 칸 ${acts[0]?.id}`);
  if (oA) {
    await p.eval(`window.__depthSees = null; window.__cycleSeek(${oA.t0Ms + Math.floor(oA.durMs / 2)})`);
    const seesAmr = await p.waitFor(`window.__depthSees && window.__depthSees.ok === true`, { timeoutMs: 15000 });
    check('⑩ 터틀봇을 본다 — 손목 뎁스 발자국이 초록(보인다 · 깊이 195~1000)', seesAmr,
      await p.eval(`JSON.stringify(window.__depthSees ?? null)`).then((s) => s.slice(0, 100)));
  }
  await p.eval(`document.querySelector('[data-t="sim-cycle-off"]').click()`);
  const nRows = await p.eval(`document.querySelectorAll('[data-t="sim-cycle"] ol.steps li').length`);
  check('사이클을 꺼도 구간 목록은 그대로다 — 10칸+관측+내리기 (데이터 개수와 같다)', nRows === (await p.eval(`window.__cycleActs?.length ?? -1`)) && nRows >= 10, `${nRows}`);
  // 손목 뎁스 발자국 — 9칸 ⑥ 「바구니 위」에서는 팔이 라이다보다 **낮아** 카메라 뒤(또는 Min-Z 안)가 정답이다.
  // 발자국이 고스트 손끝을 따라가야 이 값이 나온다(실물 자세면 발자국이 딴 데 있다) — 그걸 재는 검사다.
  // 클릭의 **인과**를 잰다 — 옛 값을 먼저 지우고, 클릭 뒤에 새 값이 생기는지 본다 (감사 ④-3). 부하에서 rAF 가 늦어 15초
  // ⛔ 풀린 사이클 위에서만 뜻이 있다 — 해가 없으면 버튼이 죽어 있고 발자국은 **실물** 자세 것이라 값이 나와도 남의 것이다 (2026-09-06: 입력 되돌리기 뒤로 밀려 그렇게 통과한 적 있다)
  check('⑥ 검사 전제 — 풀린 사이클이 살아 있다', !!(await p.eval(`!!window.__cycleActs`)));
  await p.eval(`window.__depthSees = null`);
  await p.eval(`[...document.querySelectorAll('[data-t="sim-cycle"] ol.steps li button')].find(b => b.textContent.includes('바구니 위')).click()`);
  const seesOk = await p.waitFor(`window.__depthSees && window.__depthSees.ok === false && /(뒤|가깝)/.test(window.__depthSees.why ?? '')`, { timeoutMs: 15000 });
  const sees = await p.eval(`JSON.stringify(window.__depthSees ?? null)`);
  check('⑥ 바구니 위에서 손목 뎁스는 터틀봇을 못 본다 — 카메라 뒤/너무 가깝다 (고스트 손끝 기준)', seesOk, sees.slice(0, 100));
  // 거치대가 손에 붙어 있나 — ② 무는 자세 끝(판 위 · 숫자)과 ③ 문다 끝(손 안 · 고스트 손끝 FK)의 자리가 같아야 하고(붙는 순간 안 뛴다),
  // ⑤ 터틀봇 위로 **중간**(팔이 관절 보간으로 돌아가는 동안)에도 손끝과의 거리가 ③ 때와 같아야 한다 (2026-09-06 주인님 「물고 있는 상태로 이동하지 않는다」)
  const actEnd = async (id, frac = 1) => { const o = JSON.parse(await p.eval(`JSON.stringify(window.__cycleActs.find((x) => x.id === '${id}'))`)); await p.eval(`window.__cycleSeek(${Math.round(o.t0Ms + o.durMs * frac) - 1})`); await new Promise((r) => setTimeout(r, 400)); return JSON.parse(await p.eval(`JSON.stringify({ c: window.__carrierMm ?? null, h: window.__ghostTcpMm ?? null })`)); };   // h.headingDeg = 툴 x축 요각
  const gap = (r) => (r.c && r.h ? Math.hypot(r.c.x - r.h.x, r.c.y - r.h.y, r.c.z - r.h.z) : NaN);
  const cGrasp = await actEnd('grasp'); const cClose = await actEnd('close'); const cCarry = await actEnd('carry', 0.5);
  const d23 = cGrasp.c && cClose.c ? Math.hypot(cGrasp.c.x - cClose.c.x, cGrasp.c.y - cClose.c.y, cGrasp.c.z - cClose.c.z) : NaN;
  check('③ 문다 순간 거치대가 뛰지 않는다 — 판 위 숫자와 손끝 FK 가 같은 자리 (3mm)', d23 < 3 && cClose.c?.src === 'hand', `${d23.toFixed(1)}mm · ${cGrasp.c?.src}→${cClose.c?.src}`);
  const g3 = gap(cClose); const g5 = gap(cCarry);
  check('⑤ 옮기는 중간(관절 보간 중)에도 거치대와 손끝의 거리가 ③ 때와 같다 (2mm)', cCarry.c?.src === 'hand' && Math.abs(g5 - g3) < 2, `③ ${g3.toFixed(1)} · ⑤중간 ${g5.toFixed(1)}mm`);
  // 09-09 현장 하한 뒤에는 옛 홈 근처·제자리 회전 후보를 실행 목록에서 제외한다. 회전 기하 자체는 cycle.test.js가 합성 후보로 계속 잰다.
  const runtimeStops = await p.eval(`[...document.querySelector('select[aria-label="정차 자리 바꾸기"]').options].map((o) => o.textContent)`);
  const stopFloorOk = runtimeStops.every((s) => {
    const m = s.match(/^180° · 앞 (\d+)mm/);
    return m && Number(m[1]) >= AMR_DROP.fromHomeMm;
  });
  check('실행 정차 후보는 모두 430mm 이상·무회전이다', runtimeStops.length >= 1 && stopFloorOk, runtimeStops.join(' | '));
  // ⑩ 관측 반영 — 켜면 내리기 ⑪(u-reach)에서 손끝이 **실제 바구니 속** 거치대에 닿는다(③ 때 거리와 같다). 끄면(열린 루프) 팔은 명령 자리로 가고
  // 거치대는 실제 바구니에 있어 도착 오차(37.5mm)만큼 빗나간다 — 「카메라가 없으면 이만큼」이 숫자로 나온다 (2026-09-06)
  check('⑩ 관측 반영 스위치가 있고 기본은 켜짐', (await p.eval(`document.querySelector('[data-t="sim-observe-fix"]')?.dataset.on`)) === 'true');
  // 놓는 순간 — ⑧ 놓는다 끝(손에 든 것 · 손끝 FK)과 ⑨ 빠져나온다 끝(바구니 속 · 실제 터틀봇)의 거치대 자리가 같아야 한다.
  // 전엔 실물 메시가 명령 자리에 서고 거치대는 유령(바구니 없는 상자)을 따라 「초록 바구니에서 빠져나온」 것처럼 보였다 (2026-09-06 주인님 발견)
  const rel = await actEnd('release'); const ret = await actEnd('retreat');
  const jumpOn = Math.hypot(rel.c.x - ret.c.x, rel.c.y - ret.c.y, rel.c.z - ret.c.z);
  check('관측 반영 ON — 놓는 순간 거치대가 뛰지 않는다 (⑧→⑨ 3mm · 실제 바구니 안)', jumpOn < 3 && rel.c?.src === 'hand' && ret.c?.src === 'number', `${jumpOn.toFixed(1)}mm`);
  const rOn = await actEnd('u-reach');
  check('관측 반영 ON — 내리기 ⑪에서 손끝이 실제 바구니 속 거치대에 닿는다 (③ 거리 ±3mm)', Math.abs(gap(rOn) - g3) < 3 && rOn.c?.src === 'number', `⑪ ${gap(rOn).toFixed(1)} · ③ ${g3.toFixed(1)}mm`);
  await p.eval(`document.querySelector('[data-t="sim-observe-fix"] input').click()`);
  await p.waitFor(`document.querySelector('[data-t="sim-observe-fix"]')?.dataset.on === 'false'`, { timeoutMs: 3000 });
  // 끄면 열린 루프 자세(명령 자리의 바구니 쪽 세 자세)를 그때 푼다 — 사이클이 다시 설 때까지 기다린다
  check('열린 루프 자세가 풀려 사이클이 다시 선다', await p.waitFor(`!!window.__cycleActs`, { timeoutMs: 30000 }));
  const relO = await actEnd('release'); const retO = await actEnd('retreat');
  const jumpOff = Math.hypot(relO.c.x - retO.c.x, relO.c.y - retO.c.y, relO.c.z - retO.c.z);
  check('관측 반영 OFF — 놓는 순간 거치대가 실제 바구니로 도착 오차만큼 튄다 (37.5±3mm · 카메라 없는 싣기의 빗나감)', Math.abs(jumpOff - AMR_ARRIVE_ERR_MM) < 3, `${jumpOff.toFixed(1)}mm`);
  const rOff = await actEnd('u-reach');
  // 거치대는 그대로(실제 바구니)인데 손끝만 명령 자리로 간다 — 그 차가 도착 오차(37.5) 그대로여야 「카메라 없이 이만큼 빗나간다」가 참이다
  const dHand = Math.hypot(rOff.h.x - rOn.h.x, rOff.h.y - rOn.h.y, rOff.h.z - rOn.h.z);
  const dCarrier = Math.hypot(rOff.c.x - rOn.c.x, rOff.c.y - rOn.c.y, rOff.c.z - rOn.c.z);
  check('관측 반영 OFF — 열린 루프면 손끝이 도착 오차만큼 다른 곳에 내린다 (37.5±3mm) · 거치대는 그대로', Math.abs(dHand - AMR_ARRIVE_ERR_MM) < 3 && dCarrier < 1, `손끝 ${dHand.toFixed(1)} · 거치대 ${dCarrier.toFixed(1)}mm`);
  await p.eval(`document.querySelector('[data-t="sim-observe-fix"] input').click()`);
  await p.waitFor(`document.querySelector('[data-t="sim-observe-fix"]')?.dataset.on === 'true'`, { timeoutMs: 3000 });
  await p.eval(`window.__cycleSeek(null)`);
  // ── 입력 한 줄 (phase 4) — 거치대 자리. 목업엔 실측 표적이 없으니 「고르기」가 열려 있고, 판 위 한 점을 넣으면
  //    ① 줄이 「입력(가정)」+ 좌표 ② 옛 해·평가가 비워진다(낡은 자리 것) ③ 실제 화면 클릭 경로(레이캐스트)도 좌표를 낸다
  // ── 바구니 표적 — 같은 ⓐ~ⓔ 로 빈 바구니 바닥(파임 90)을 재고 통과하면 ⑥~⑨ 자리가 관측값으로 흐른다. 대강값은 정차 자리+오프셋
  await p.eval(`(() => { const s = document.querySelector('[data-t="sim-aim"] select'); s.value = 'basketFloor'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await aimStep('a', 'b');
  const bCoarse = await p.eval(`document.querySelector('[data-t="sim-aim-coarse"]')?.textContent ?? ''`);
  check('바구니 대강값은 정차 자리+등 뒤 오프셋에서 온다', /출처 stop\+offset/.test(bCoarse), bCoarse.slice(0, 70));
  await aimStep('b', 'c', 30000); await aimStep('c', 'd'); await aimStep('d', 'e'); await aimStep('e', null);
  await aimStep('b', 'c', 30000); await aimStep('c', 'd'); await aimStep('d', 'e'); await aimStep('e', null);
  const basketOk = await p.waitFor(`!!document.querySelector('[data-t="sim-aimed-basket"]')`, { timeoutMs: 8000 });
  check('바구니 융합이 통과하면 ⑥~⑨ 가 관측값으로 흐른다', basketOk, (await p.eval(`document.querySelector('[data-t="sim-aimed-basket"]')?.textContent ?? ''`)).slice(0, 80));
  const inputBefore = await p.eval(`document.querySelector('[data-t="sim-input"]')?.dataset.src`);
  check('입력 줄이 있고 실측이 없으면 출처가 「파지 자세」다', inputBefore === 'truth', String(inputBefore));
  const fromScreen = await p.eval(`(() => { const r = document.querySelector('[data-t="twin"] canvas').getBoundingClientRect(); return JSON.stringify(window.__twin?.pickFromScreen?.(r.left + r.width * 0.55, r.top + r.height * 0.6) ?? null); })()`);
  check('3D 클릭 경로(레이캐스트)가 판 위 user1 좌표를 낸다', /^\[-?\d/.test(fromScreen), fromScreen);
  await p.eval(`window.__twin.pickCarrierAt([700, -1100])`);
  const inputOk = await p.waitFor(`document.querySelector('[data-t="sim-input"]')?.dataset.src === 'input' && /입력[(]가정[)].*700.*-1100/.test(document.querySelector('[data-t="sim-input"]')?.textContent ?? '')`, { timeoutMs: 5000 });
  check('자리를 넣으면 「입력(가정)」과 좌표가 뜨고', inputOk, (await p.eval(`document.querySelector('[data-t="sim-input"]')?.textContent ?? ''`)).slice(0, 80));
  check('옛 해·평가는 비워진다 (낡은 자리 것이라)', !(await p.eval(`!!document.querySelector('[data-t="sim-score"]')`)));
  await p.eval(`[...document.querySelectorAll('[data-t="sim-input"] button')].find(b => b.textContent === '되돌리기')?.click()`);
  check('되돌리기 뒤 출처가 「파지 자세」로 돌아온다', (await p.eval(`document.querySelector('[data-t="sim-input"]')?.dataset.src`)) === 'truth');
  check('자리를 되돌리면 옛 사이클은 사라지고 목록은 싣기 10칸으로 돌아간다 (낡은 자리의 구간을 남기지 않는다)',
    (await p.eval(`document.querySelectorAll('[data-t="sim-cycle"] ol.steps li').length`)) === 10 && (await p.eval(`window.__cycleActs == null`)));
  // 제한 자동 실행 — 마지막 단계 S3를 고른 한 번의 시작으로 새 글로벌값→두 뷰 조준→계획까지만 간다.
  // 커서가 1/N 그대로라는 것이 S4 첫 동작을 건드리지 않았다는 실행 증거다.
  await p.eval(`(() => {
    const target = document.querySelector('[data-t="sim-aim"] select');
    target.value = 'carrier'; target.dispatchEvent(new Event('change', { bubbles: true }));
    const limit = document.querySelector('[data-t="sim-auto-limit"]');
    limit.value = 'S3'; limit.dispatchEvent(new Event('change', { bubbles: true }));
    const confirm = document.querySelector('[data-t="sim-auto-confirm"]');
    if (!confirm.checked) confirm.click();
  })()`);
  await p.waitFor(`document.querySelector('[data-t="sim-auto-start"]')?.disabled === false`, { timeoutMs: 5000 });
  await p.eval(`document.querySelector('[data-t="sim-auto-start"]').click()`);
  const autoHold = await p.waitFor(`window.__automatic?.status === 'HOLD' && window.__automatic?.stage === 'S3'`, { timeoutMs: 240000 });
  const autoState = JSON.parse(await p.eval(`JSON.stringify(window.__automatic ?? null)`));
  check('한 번 시작하면 S0→S1→S2→S3을 이어서 수행하고 S3 HOLD에서 멈춘다', autoHold
    && ['S0', 'S1', 'S2', 'S3'].every((s) => autoState.completed?.includes(s)), JSON.stringify(autoState));
  await p.eval(`document.querySelector('[data-t="sim-stage-3"]')?.click()`);
  const autoCursor = await p.eval(`document.querySelector('[data-t="sim-next-status"]')?.textContent ?? ''`);
  check('S3 제한 실행은 집기 첫 칸을 실행하지 않는다 (커서 1/N · 지난 칸 없음)', /^1\/\d+/.test(autoCursor.trim()) && !/지난 칸/.test(autoCursor), autoCursor.slice(0, 80));
  if (!REMOTE) {
    await new Promise((r) => setTimeout(r, 500));
    const runs = await fetch(`http://localhost:${BP}/runs`).then((r) => r.json()).catch(() => []);
    const last = runs[runs.length - 1];
    const doc = last ? await fetch(`http://localhost:${BP}/runs/${last.runId}`).then((r) => r.json()) : null;
    const lines = doc?.lines ?? [];
    const forbidden = lines.filter((l) => l.sent?.cmd === 'gripper' || l.drive || (!String(l.label ?? '').startsWith('조준 자세') && l.step === 'go'));
    check('S3 자동 장부에는 조준 이동 외 로봇·그리퍼·터틀봇 실행이 0건이다',
      lines.some((l) => l.step === 'solve')
        && lines.some((l) => l.step === 'auto-hold' && l.automatic?.stage === 'S3') && forbidden.length === 0,
      `${last?.runId} · ${lines.length}줄 · 금지 ${forbidden.length}`);
  }
  // S3R은 실기 이동이 있으므로 원격 게이트에서는 절대 누르지 않는다. 로컬 목업에서만
  // 높은 접근·사전 성형 두 칸을 잇고 하강·닫기·주행이 없는지 장부로 확인한다.
  if (!REMOTE) {
    await p.eval(`(() => {
      const limit = document.querySelector('[data-t="sim-auto-limit"]');
      limit.value = 'S3R'; limit.dispatchEvent(new Event('change', { bubbles: true }));
      const confirm = document.querySelector('[data-t="sim-auto-confirm"]');
      if (!confirm.checked) confirm.click();
    })()`);
    await p.waitFor(`document.querySelector('[data-t="sim-auto-start"]')?.disabled === false`, { timeoutMs: 5000 });
    await p.eval(`document.querySelector('[data-t="sim-auto-start"]').click()`);
    const readyHold = await p.waitFor(`window.__automatic?.status === 'HOLD' && window.__automatic?.stage === 'S3R'`, { timeoutMs: 240000 });
    const readyState = JSON.parse(await p.eval(`JSON.stringify(window.__automatic ?? null)`));
    const runs = await fetch(`http://localhost:${BP}/runs`).then((r) => r.json()).catch(() => []);
    const last = runs[runs.length - 1];
    const doc = last ? await fetch(`http://localhost:${BP}/runs/${last.runId}`).then((r) => r.json()) : null;
    const lines = doc?.lines ?? [];
    const readyGo = lines.filter((l) => l.step === 'go' && ['① 위에서 접근', '①b 내려가기 전 손 맞춤'].includes(l.label));
    const forbidden = lines.filter((l) => l.step === 'go' && /무는 자세|문다|들어올린다|터틀봇/.test(l.label ?? ''));
    const held = lines.find((l) => l.step === 'auto-hold' && l.automatic?.stage === 'S3R');
    const readySolve = lines.find((l) => l.step === 'solve-ready');
    const fullSolve = lines.find((l) => l.step === 'solve');
    check('S3R은 미래 정차 계획 없이 높은 접근·사전 성형을 마치고 HOLD한다', readyHold
      && ['S0', 'S1', 'S2', 'S3R'].every((s) => readyState.completed?.includes(s))
      && !readyState.completed?.includes('S3') && readySolve && !fullSolve
      && readyGo.length === 2 && held?.evidence?.gripperPct === PREGRIP_PCT,
    `${last?.runId} · 준비 ${readyGo.length}/2 · S3 ${readyState.completed?.includes('S3') ? '있음' : '없음'} · 최종 ${held?.evidence?.gripperPct ?? '?'}%`);
    check('S3R 장부에는 하강·닫기·들기·터틀봇 실행이 0건이다', forbidden.length === 0,
      `금지 ${forbidden.length}`);

    // S4도 먼저 전체 접두 경로를 풀지만 PREVIEW에서는 낮은 파지 고스트만 보이고 실기 명령은 0건이다.
    // 목업에서 확인 버튼을 누른 뒤에만 다섯 칸을 원자적으로 잇고 lift HOLD로 끝내는지 본다.
    await p.eval(`(() => {
      const limit = document.querySelector('[data-t="sim-auto-limit"]');
      limit.value = 'S4'; limit.dispatchEvent(new Event('change', { bubbles: true }));
      const confirm = document.querySelector('[data-t="sim-auto-confirm"]');
      if (!confirm.checked) confirm.click();
    })()`);
    await p.waitFor(`document.querySelector('[data-t="sim-auto-start"]')?.disabled === false`, { timeoutMs: 5000 });
    await p.eval(`document.querySelector('[data-t="sim-auto-start"]').click()`);
    const preview = await p.waitFor(`window.__automatic?.status === 'PREVIEW' && window.__automatic?.stage === 'S4'`, { timeoutMs: 240000 });
    let pickRuns = await fetch(`http://localhost:${BP}/runs`).then((r) => r.json()).catch(() => []);
    let pickLast = pickRuns[pickRuns.length - 1];
    let pickDoc = pickLast ? await fetch(`http://localhost:${BP}/runs/${pickLast.runId}`).then((r) => r.json()) : null;
    let pickLines = pickDoc?.lines ?? [];
    const beforePick = pickLines.filter((l) => l.step === 'go' && /위에서 접근|손 맞춤|무는 자세|문다|들어올린다/.test(l.label ?? ''));
    const previewLine = pickLines.find((l) => l.step === 'auto-preview');
    const insetMm = previewLine?.evidence?.graspInsetMm;
    const insetCandidates = previewLine?.evidence?.insetCandidates ?? [];
    const ghostTcp = JSON.parse(await p.eval(`JSON.stringify(window.__ghostTcpMm ?? null)`));
    check('S4는 낮은 파지 고스트 PREVIEW에서 멈추고 확인 전 집기 명령이 0건이다', preview
      && previewLine && beforePick.length === 0
      && Number.isInteger(insetMm) && insetMm >= 0 && insetMm <= 10
      && insetCandidates.length >= 1 && insetCandidates.at(-1)?.ok === true
      && insetCandidates.at(-1)?.insetMm === insetMm
      && insetCandidates.slice(0, -1).every((c) => c.ok === false)
      && Number.isFinite(ghostTcp?.x) && Number.isFinite(ghostTcp?.y) && Number.isFinite(ghostTcp?.z),
    `${pickLast?.runId} · 안쪽 ${insetMm ?? '?'}mm (${insetCandidates.length}후보) · 명령 ${beforePick.length} · ghost base (${ghostTcp?.x?.toFixed?.(1) ?? '?'}, ${ghostTcp?.y?.toFixed?.(1) ?? '?'}, ${ghostTcp?.z?.toFixed?.(1) ?? '?'})`);
    if (argv.includes('--shot')) await p.screenshot(join(shotDir, 's4-grasp-preview.png'));
    await p.eval(`document.querySelector('[data-t="sim-auto-preview-confirm"]').click()`);
    const pickHold = await p.waitFor(`window.__automatic?.status === 'HOLD' && window.__automatic?.stage === 'S4'`, { timeoutMs: 240000 });
    pickRuns = await fetch(`http://localhost:${BP}/runs`).then((r) => r.json()).catch(() => []);
    pickLast = pickRuns[pickRuns.length - 1];
    pickDoc = pickLast ? await fetch(`http://localhost:${BP}/runs/${pickLast.runId}`).then((r) => r.json()) : null;
    pickLines = pickDoc?.lines ?? [];
    const pickGo = pickLines.filter((l) => l.step === 'go' && /위에서 접근|손 맞춤|무는 자세|문다|들어올린다/.test(l.label ?? ''));
    const pickLabels = pickGo.map((l) => l.label);
    const pickHeld = pickLines.find((l) => l.step === 'auto-hold' && l.automatic?.stage === 'S4');
    const closeGoAt = pickLines.findIndex((l) => l.step === 'go' && l.label === '③ 문다');
    const liftPreviewAt = pickLines.findIndex((l) => l.step === 'auto-lift-preview');
    const liftGoAt = pickLines.findIndex((l) => l.step === 'go' && l.label === '④ 들어올린다');
    const liftPreview = pickLines[liftPreviewAt];
    const tbCommands = pickLines.filter((l) => l.drive || l.tb || /터틀봇/.test(l.label ?? ''));
    check('S4 확인 뒤 접근→28mm→하강→4% 닫기→들기를 잇고 lift HOLD에서 끝난다', pickHold
      && JSON.stringify(pickLabels) === JSON.stringify(['① 위에서 접근', '①b 내려가기 전 손 맞춤', '② 무는 자세', '③ 문다', '④ 들어올린다'])
      && pickHeld?.evidence?.gripperPct === 4 && pickHeld?.evidence?.graspInsetMm === insetMm && tbCommands.length === 0,
    `${pickLast?.runId} · ${pickLabels.join(' → ')} · 안쪽 ${pickHeld?.evidence?.graspInsetMm ?? '?'}mm · 최종 ${pickHeld?.evidence?.gripperPct ?? '?'}% · TB ${tbCommands.length}`);
    check('S4 닫힘 readback 뒤·리프트 명령 전에 물체를 포함한 고스트 증거가 남는다',
      closeGoAt >= 0 && closeGoAt < liftPreviewAt && liftPreviewAt < liftGoAt
        && liftPreview?.evidence?.closeConfirmed === true && Array.isArray(liftPreview?.evidence?.liftTcpMmDeg),
      `장부 순서 close ${closeGoAt} < ghost ${liftPreviewAt} < lift ${liftGoAt}`);
    const heldInTwin = await p.waitFor(`window.__carrierMm?.src === 'hand'`, { timeoutMs: 5000 });
    const heldTwin = JSON.parse(await p.eval(`JSON.stringify({ carrier: window.__carrierMm ?? null, hand: window.__ghostTcpMm ?? null })`));
    check('S4 lift HOLD에서 거치대가 바닥이 아니라 고스트 손에 붙어 있다', heldInTwin
      && heldTwin.carrier?.src === 'hand' && heldTwin.hand,
    `${heldTwin.carrier?.src ?? '없음'} · carrier (${heldTwin.carrier?.x?.toFixed?.(1) ?? '?'}, ${heldTwin.carrier?.y?.toFixed?.(1) ?? '?'}, ${heldTwin.carrier?.z?.toFixed?.(1) ?? '?'})`);
    if (argv.includes('--shot')) await p.screenshot(join(shotDir, 's4-lift-held.png'));

    // P0 회귀: close 후 리프트 고스트 장부 POST가 대기 중일 때 STOP을 누르면, 대기가 풀려도 lift를 보내지 않아야 한다.
    await p.eval(`(() => {
      const limit = document.querySelector('[data-t="sim-auto-limit"]');
      limit.value = 'S4'; limit.dispatchEvent(new Event('change', { bubbles: true }));
      const confirm = document.querySelector('[data-t="sim-auto-confirm"]');
      if (!confirm.checked) confirm.click();
    })()`);
    await p.waitFor(`document.querySelector('[data-t="sim-auto-start"]')?.disabled === false`, { timeoutMs: 5000 });
    await p.eval(`document.querySelector('[data-t="sim-auto-start"]').click()`);
    await p.waitFor(`window.__automatic?.status === 'PREVIEW' && window.__automatic?.stage === 'S4'`, { timeoutMs: 240000 });
    await p.eval(`(() => {
      window.__liftLogSeen = false; window.__liftLogRelease = null; window.__fetchBeforeLiftStop = window.fetch;
      window.fetch = (...args) => {
        if (String(args[1]?.body ?? '').includes('auto-lift-preview')) return new Promise((resolve, reject) => {
          window.__liftLogSeen = true;
          window.__liftLogRelease = () => window.__fetchBeforeLiftStop(...args).then(resolve, reject);
        });
        return window.__fetchBeforeLiftStop(...args);
      };
    })()`);
    await p.eval(`document.querySelector('[data-t="sim-auto-preview-confirm"]').click()`);
    const liftWaiting = await p.waitFor(`window.__liftLogSeen === true && window.__carrierMm?.src === 'hand'`, { timeoutMs: 10000 });
    if (argv.includes('--shot')) await p.screenshot(join(shotDir, 's4-lift-before-command.png'));
    await p.eval(`document.querySelector('[data-t="sim-auto-stop"]').click()`);
    await p.waitFor(`window.__automatic?.status === 'STOPPED'`, { timeoutMs: 5000 });
    await p.eval(`window.__liftLogRelease?.()`);
    await new Promise((r) => setTimeout(r, 500));
    const stoppedRuns = await fetch(`http://localhost:${BP}/runs`).then((r) => r.json()).catch(() => []);
    const stoppedLast = stoppedRuns[stoppedRuns.length - 1];
    const stoppedDoc = stoppedLast ? await fetch(`http://localhost:${BP}/runs/${stoppedLast.runId}`).then((r) => r.json()) : null;
    const stoppedLift = (stoppedDoc?.lines ?? []).filter((l) => l.step === 'go' && l.label === '④ 들어올린다');
    check('S4 리프트 고스트 대기 중 STOP 후에는 늦은 lift 명령을 보내지 않는다',
      liftWaiting && stoppedLift.length === 0, `${stoppedLast?.runId ?? '장부 없음'} · lift ${stoppedLift.length}건`);
    await p.eval(`window.fetch = window.__fetchBeforeLiftStop; delete window.__fetchBeforeLiftStop; delete window.__liftLogRelease;`);
  }
  // 되감기는 터틀봇 탭으로 이사했다 — 옮긴 자리에 살아 있는지. 탭을 바꾸면 시뮬 절은 내려가므로(유령 주인 교대) **맨 끝**에서 본다
  await p.eval(`[...document.querySelectorAll('nav[role="tablist"] button')].find((b) => b.textContent.trim() === '터틀봇')?.click()`);
  const tbRuns = await p.waitFor(`!!document.querySelector('[data-t="tb-runs"]') && !document.querySelector('[data-t="sim-cycle"]')`, { timeoutMs: 5000 });
  check('터틀봇 탭에 「되감기」 절이 있고 시뮬 절은 내려갔다', tbRuns);
  const errs = await p.eval(`window.__err ?? ''`);
  check('콘솔 오류 없음', !errs, String(errs).slice(0, 120));
} catch (e) { check('실행 자체', false, String(e.message || e)); }
finally { try { await p?.close?.(); } catch {} killTree(bridge); killTree(web); }
const bad = out.filter(v => !v).length;
console.log(`\n${out.length - bad}/${out.length} PASS`);
process.exit(bad ? 1 : 0);
