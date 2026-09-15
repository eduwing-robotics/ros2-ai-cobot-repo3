// WebXR 정합 — **마커 없이** 맵을 실제 바닥에 얹는다.
//
// 캘리브레이션도 평소엔 없다. 다만 `촬영` 모드만 **아는 맵의 두 모서리**를 받아
// 그 방·그 세션의 축척 오차를 지운다 (`:startAR` §real).
//
// 마커 방식(`ar.html`)을 고른 이유는 iOS 사파리가 `immersive-ar` 을 안 열어주기 때문이다
// (`AR-MARKER.md`). 그런데 **고정 카메라·현장 시연은 기기가 하나**라 그 제약이 안 걸린다.
// 축척 정확도는 실측했다 — 1m 를 987·1019·1012·918mm 로 읽었다
// (`docs/evidence/2026-08-04/global-cam-phone.md`).
//
// **네 모드가 한 씬을 공유한다.** AR 셋(평소·답사·촬영)은 배율 숫자와 탭 횟수만 다르고,
// `화면` 은 XR 없이 그 방 안을 본다. 렌더 경로를 가르면 평소 테스트가 촬영본을 검증해 주지
// 못한다 (D17 의 실패 모양). 그래서 씬을 짓는 코드는 `buildScene` 하나다.
//
//   평소 fit    — 1:2.5 로 줄여 책상 위. 한 번 탭
//   답사 walk   — 실물 1:1. 한 번 탭하고 **그 안을 걸어 들어간다**
//   촬영 real   — 실물 1:1 + 아는 맵의 두 모서리로 축척 오차까지 지운다
//   화면 screen — XR 없음. 폰이 없어도 열려 실렌더 검증이 된다
//
// **고를 것은 둘뿐이다** — 모드와 맵. 팔 대수·애니메이션은 사람이 고를 값이 아니라
// 맵이 정한다 (2026-08-06). 골라서 얻는 게 없는 선택지는 화면에서 뺐다.

import * as THREE from 'three';
import { createLayoutView } from '@fr5/shared/view3d/lab/layout-view.js';
import { buildLabSky, ENV_INTENSITY } from '@fr5/shared/view3d/lab/sky.js';
import { PRESETS, buildPreset } from '@fr5/shared/data/layout/presets.js';
import {
  loadConfig, loadRobot, setJointsDeg, countTriangles, mountRobotYUp, paintGhost,
} from '@fr5/shared/view3d/robot.js';
import { frameAt, frameIndexAt } from '@fr5/shared/data/sim/frames.js';
import { PRESET_POSES as POSES } from '@fr5/shared/data/motion/poses.js';
import { subscribeRobotState } from '@fr5/shared/data/datasource/state-stream.js';
// 놓기 계산은 **화면 밖 순수 함수**다 — XR 세션 없이 게이트가 숫자로 판정한다
import {
  solveCorners, hudText, ghostWalls, classifyHit, yawFromWallNormal, readiness,
  fitLine, snapQuadrant, SWEEP_MIN,
} from '../features/place/place.js';
import { createMapPreview } from '../features/preview/map-preview.js';
import './xr.css';

const $ = (id) => document.getElementById(id);
const lines = [];
const say = (m, cls = '') => {
  lines.push(m);
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = m;
  $('log').prepend(d);
};
/** 세션 중 한 줄 안내. 받는 동안 화면이 말을 안 하면 "멈췄다" 로 읽힌다. */
const tell = (m) => { $('hint').textContent = m; };

/**
 * 모드 — **AR 셋과 화면 하나.** `xr` 이 참인 것만 XR 을 필요로 한다.
 * 조건(탭 횟수·필요 공간)을 여기 같이 둔다. 고르기 *전에* 보여야 하는 값이다.
 */
const MODES = [
  { id: 'fit', name: '평소', line: '2.5m 로 줄여 책상 위에 얹습니다', tags: '탭 1회 · 아무 바닥', xr: true },
  { id: 'walk', name: '답사', line: '실물 1:1 로 얹고 그 안을 걸어 들어갑니다', tags: '탭 1회 · 맵 크기만큼 빈 공간', xr: true },
  { id: 'real', name: '촬영', line: '실측 맵의 두 모서리로 축척 오차까지 지웁니다', tags: '탭 2회 · 크기를 아는 맵', xr: true },
  { id: 'screen', name: '화면', line: 'AR 없이 방 안을 눈높이로 둘러봅니다', tags: '폰이 없어도 열립니다', xr: false },
];
const Q = new URLSearchParams(location.search);
let mode = MODES.some((m) => m.id === Q.get('mode')) ? Q.get('mode') : 'fit';
const modeOf = () => MODES.find((m) => m.id === mode);

// ── 맵 고르기. 폰에서 고르고, 링크로도 넘긴다 (`?preset=cell&mode=walk`).
const sel = $('preset');
for (const p of PRESETS) {
  const o = document.createElement('option');
  o.value = p.id;
  o.textContent = p.label;
  sel.appendChild(o);
}
sel.value = PRESETS.some((p) => p.id === Q.get('preset')) ? Q.get('preset') : 'cell';

$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    say('결과를 클립보드에 복사했습니다', 'ok');
  } catch { say('복사에 실패했습니다. 화면의 숫자를 옮겨 적으세요', 'bad'); }
};
// 기록은 접어 둔다. **계측 로그와 안내는 다른 것**이다 — 안내를 로그에 섞으면
// `결과 복사` 로 회수한 숫자에 노이즈가 들어간다 (2026-08-06 UI 감사).
$('logBtn').onclick = () => {
  const open = $('log').hidden;
  $('log').hidden = !open;
  $('logBtn').setAttribute('aria-expanded', String(open));
  $('logBtn').textContent = open ? '기록 숨기기' : '기록 보기';
};

say(`${new Date().toLocaleString('ko-KR')} · ${navigator.userAgent.slice(0, 44)}`);

// **`화면` 모드는 XR 이 없어도 열린다.** 그래서 지원 여부로 버튼을 통째로 잠그면 안 된다 —
// PC 브라우저에서 이걸 열 수 있는 것이 이 화면의 유일한 실렌더 검증 경로다.
let arOk = false;
let secure = true;
if (!isSecureContext) { secure = false; say('보안 출처가 필요합니다. WebXR 은 HTTPS 에서만 열립니다', 'bad'); }

function renderChips() {
  $('chips').replaceChildren(...MODES.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.m = m.id;
    b.textContent = m.name;
    if (m.xr && !arOk) b.dataset.off = '1';
    b.onclick = () => { mode = m.id; sync(); };
    return b;
  }));
}

/** 고른 모드가 무엇을 시키는지, 안 되면 **왜 + 어디로 가야 하는지**까지 한 곳에 적는다. */
function sync() {
  const m = modeOf();
  const blocked = m.xr && !arOk;
  for (const b of $('chips').children) b.setAttribute('aria-pressed', String(b.dataset.m === mode));
  $('blurb').innerHTML = `<b>${m.name}</b> — ${m.line}<br>${m.tags}`
    + (blocked
      ? '<br><span class="no">이 기기는 AR 을 못 엽니다. <b>화면</b> 을 고르세요.'
        + `${secure ? ' 안드로이드 크롬 + “Google Play 서비스 for AR” 이면 열립니다' : ''}</span>`
      : '');
  $('go').disabled = blocked;
  $('go').textContent = m.xr ? 'AR 시작' : '방 안으로 들어가기';
}

// ── 맵 미리보기 — **무엇을 얹게 되는지 먼저 보여준다.** 알맹이는 `features/preview/` 에 있다.
let preview = null;
function showPreview() {
  preview?.dispose();
  preview = createMapPreview({
    host: $('preview'), sheet: $('sheet'), layout: buildPreset(sel.value),
  });
}
sel.onchange = showPreview;

/** 세션으로 들어간다 — **미리보기를 반드시 버린다.** WebGL 컨텍스트가 쌓이면 브라우저가 막는다. */
function enterSession() {
  preview?.dispose();
  preview = null;
  $('app').hidden = true;
}
/** 세션에서 나온다. 미리보기를 다시 세운다. */
function leaveSession() {
  $('app').hidden = false;
  $('bar').hidden = true;
  $('steps').hidden = true;
  tell('');
  showPreview();
}

/** 가장 긴 변이 이만큼(mm)이 되게 줄인다 — 12m 방을 강의실에 넣는 기본값 */
const TARGET_MM = 2500;

/**
 * 두 모서리 탭이 낼 수 있는 보정의 상한. 이 밖이면 **모서리를 잘못 찍은 것**이지
 * WebXR 축척 오차가 아니다 (실측 오차는 ±2% 였다). 막지는 않고 말만 한다 —
 * 세게 막으면 아무것도 못 하게 된다 (2026-08-04 에 한 번 그렇게 잘못 만들었다).
 */
const SANE_SCALE = [0.5, 2];

/**
 * 준비도 색 — **CSS 토큰과 같은 값**이다 (`xr.css` 의 `--muted`·`--hazard`·`--go`·`--bad`).
 * 조준 링과 화면 글자가 다른 색으로 같은 상태를 말하면 사람이 둘을 다른 것으로 읽는다.
 */
const RD_COLOR = {
  gray: 0x97a1ac, yellow: 0xd9a323, green: 0x7fd88f, red: 0xff8b8b,
};

/** 겨냥한 면과 바닥이 이보다 벌어지면 **낙하선을 긋는다** — 링만 바닥에 있으면 허공에 뜬 것으로 읽힌다 */
const DROP_MM = 50;

/** 초록이 이만큼 흔들림 없이 이어지면 `평소` 는 저절로 놓는다 */
const AUTO_MS = 800;

/** 훑기 결과를 이만큼 붙잡아 둔다 — 준비도 문구가 바로 덮으면 사람이 못 읽는다 */
const HOLD_MS = 2500;

/** `화면` 모드의 눈높이 — 서 있는 사람 기준 */
const EYE_M = 1.6;

/**
 * 앵커 보정이 이만큼(m) 넘게 움직이면 **그림자도 다시 그린다.**
 *
 * 키 라이트가 앵커 밑에 있어 맵과 같이 움직이는데, `shadowMap.autoUpdate` 가 꺼져
 * 있으면 three 가 그림자 행렬을 갱신하지 않는다 (`WebGLShadowMap` 이 조기 리턴하고
 * `updateMatrices` 는 그 뒤에 있다). 그러면 **앵커가 보정될수록 그림자가 물체에서
 * 떨어져 나간다** — 앵커를 붙인 목적을 그림자가 되돌리는 셈이다 (2026-08-06 `/감사`).
 */
const ANCHOR_EPS = 0.002;

/**
 * 세 모드가 공유하는 씬 뼈대.
 *
 * **키 라이트를 씬에 붙이지 않고 돌려준다.** AR 은 맵을 따라다녀야 하고
 * (앵커 밑에 붙는다), `화면` 은 방에 고정이라 붙일 자리가 다르다.
 */
function buildScene(layout) {
  const scene = new THREE.Scene();
  const sky = buildLabSky();
  scene.environment = sky;
  scene.environmentIntensity = ENV_INTENSITY;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  // **그림자가 접지감의 전부다.** 대시보드(`stage.js`)는 처음부터 켜 두고 주석까지
  // 달아 놨는데(*"없으면 물체가 떠 보인다"*) AR 에서만 빠져 있었다 — 그래서 정확히
  // 놓아도 뜬 것으로 읽혔다.
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0012;
  const view = createLayoutView(layout);
  return { scene, sky, key, view };
}

/** 키 라이트의 그림자 상자를 발자국 크기에 맞춘다. 세계 단위(m)로 받는다. */
function fitShadow(key, halfM) {
  const c = key.shadow.camera;
  c.left = -halfM; c.right = halfM; c.top = halfM; c.bottom = -halfM;
  c.near = 0.1; c.far = halfM * 6 + 4;
  c.updateProjectionMatrix();
}

/**
 * **맵이 정한 만큼** URDF 를 받아 슬롯에 꽂는다. 대당 6MB · 삼각형 128,808.
 *
 * 대수를 사람이 고르게 두지 않는다 — 맵이 팔 자리를 이미 들고 있고, 거기서 벗어난
 * 대수로 본 화면은 그 맵이 아니다. 받는 동안 **몇 대째인지 화면에 적는다** — 안 그러면
 * 캔버스가 뜬 채 몇 초가 흘러 "멈췄다" 로 읽힌다.
 */
async function mountArms(view) {
  const arms = [];
  const slots = (view.armSlots ?? []).filter((sl) => sl.userData?.arm?.model === 'FR5');
  if (!slots.length) return arms;
  const { gripper } = loadConfig();
  for (let i = 0; i < slots.length; i += 1) {
    tell(`FR5 팔 ${i + 1}/${slots.length}대 받는 중… (대당 6MB)`);
    const tLoad = performance.now();
    try {
      const { robot } = await loadRobot({
        urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf', gripperCfg: gripper, gripperDir: '/PGEA_100_40/',
      });
      // Z-up→Y-up 은 `Shared` 한 곳에서만 한다 — 베껴 쓴 다섯 벌 중 하나가 빠지면
      // 팔이 바닥에 누워 버린다.
      const holder = mountRobotYUp(robot);
      // 팔이 그림자를 던져야 바닥에 서 있는 것으로 읽힌다. 128k 삼각형이 그림자맵에도
      // 한 번 더 들어가므로 **fps 로그가 이 비용을 말한다** (GAP: 폰 성능 미측정).
      robot.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      // **자세를 한 번 얹는다.** 관절 0 은 곧게 선 막대라 로봇으로 안 읽힌다.
      // 움직이지는 않는다 — 없는 궤적을 지어내지 않는다는 규약 그대로다.
      setJointsDeg(robot, POSES.home);
      robot.userData.robotId = slots[i].userData?.arm?.robotId ?? null;   // 실기 라이브 매핑
      slots[i].add(holder);
      arms.push(robot);
      say(`팔 ${i + 1} 준비 · ${((performance.now() - tLoad) / 1000).toFixed(1)}초 · `
        + `${countTriangles(robot).triangles.toLocaleString()} 삼각형`, 'ok');
      // **실물이 물리는 팔에만 고스트를 한 대 더 꽂는다** (D195 · 2026-09-07). 규약은 하나 —
      // 불투명 = 실기 · 반투명 = 계획. 라이브가 흐르는 동안 그 위에 시뮬 표본을 겹쳐 「어디로 갈
      // 예정인가」를 실물 위에서 읽는다. 화면 팔(robotId 없음)은 제 몸으로 계획을 돌므로 고스트가
      // 필요 없다. 두 번째 `loadRobot` 은 브라우저 캐시라 빠르고, 실패해도 실기 팔은 살아 있어야 한다.
      if (robot.userData.robotId) {
        try {
          const { robot: ghost } = await loadRobot({
            urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf', gripperCfg: gripper, gripperDir: '/PGEA_100_40/',
          });
          ghost.visible = false;                       // 라이브 + 재생이 같이 있을 때만 켠다 (applyLive)
          setJointsDeg(ghost, POSES.home);
          // 늦게 붙는 그리퍼·브래킷까지 — 세 번 칠한다 (`paintGhost` 규약)
          paintGhost(ghost);
          setTimeout(() => paintGhost(ghost), 400);
          setTimeout(() => paintGhost(ghost), 1600);
          slots[i].add(mountRobotYUp(ghost));
          robot.userData.ghost = ghost;
        } catch (e) { say(`팔 ${i + 1} 고스트 실패: ${e?.message ?? e}`, 'bad'); }
      }
    } catch (e) { say(`팔 ${i + 1} 실패: ${e?.message ?? e}`, 'bad'); }
  }
  return arms;
}

// ── 실기 라이브 — 팔에 매핑된 robotId 의 스트림을 관절에 얹는다. **읽기 전용**(하드룰 4).
// robotId 로 키잉하므로 실물이 늘면 각 팔이 제 스트림을 따라간다(브리지가 robotId별로 줄 때.
// 지금은 연결 1대 — layout 이 fr5a↔fr5-lab-a 를 매핑). 매핑 없는 팔은 home 에 머문다.
const liveByRobot = new Map();   // robotId → { joints, at }
subscribeRobotState({
  onSnapshot: (st) => {
    const j = st.jointsDeg;
    if (st.connected && st.robotId && Array.isArray(j) && j.length >= 6) {
      liveByRobot.set(st.robotId, { joints: j, at: performance.now(), target: st.motionTarget ?? null });   // target — 계약 §이동 목표
    }
  },
});
const liveFor = (robotId, now) => {
  if (!robotId) return null;
  const e = liveByRobot.get(robotId);
  return e && now - e.at < 2000 ? e.joints : null;
};
// 가는 중인 목표(`doneAt` 이 null) — 라이브가 살아 있을 때만 뜻이 있다
const goingTarget = (robotId, now) => {
  const e = robotId ? liveByRobot.get(robotId) : null;
  const t = e && now - e.at < 2000 ? e.target : null;
  return t && t.doneAt == null && Array.isArray(t.jointsDeg) && t.jointsDeg.length >= 6 ? t.jointsDeg : null;
};
const asJoints = (a) => ({ j1: a[0], j2: a[1], j3: a[2], j4: a[3], j5: a[4], j6: a[5] });
// ── 시뮬 재생 — MuJoCo 배치 한 인스턴스(`/sim/replay.json` · `scripts/build/sim-replay.mjs`)를 팔에 얹는다
// (phase 4 · 2026-09-05). **실기 라이브가 있는 팔은 라이브가 이긴다** — 계획 궤적을 실물 위에 겹치는 건
// 트윈 두 층 규약(실측 불투명 · 계획 반투명)의 XR 판인데, 여기는 팔이 하나라 「라이브 없을 때만」으로 가른다.
// 한 바퀴 6초 — Dashboard ReplayView 와 같다. `?replay=1` 로 켠 채 열 수 있다.
let replay = null;                    // { deg, framesPerInstance, jointCount, batchId }
let replayOn = Q.get('replay') === '1';
let replayK = 0;
async function loadReplay() {
  if (replay) return replay;
  const r = await fetch('/sim/replay.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`replay.json ${r.status}`);
  replay = await r.json();
  say(`시뮬 표본 · ${replay.batchId} #${replay.instance} · ${replay.framesPerInstance}프레임 · 실제 ${Math.round((replay.cycleMs ?? 0) / 1000)}초를 6초로`, 'ok');
  return replay;
}
function syncReplayBtn() {
  const b = $('replay');
  b.setAttribute('aria-pressed', String(replayOn));
  b.textContent = replayOn ? '시뮬 재생 켬' : '시뮬 재생';
}
$('replay').onclick = async () => {
  replayOn = !replayOn;
  syncReplayBtn();
  if (replayOn) { try { await loadReplay(); } catch (e) { say(`시뮬 표본 없음: ${e?.message ?? e}`, 'bad'); replayOn = false; syncReplayBtn(); } }
};
syncReplayBtn();
if (replayOn) loadReplay().catch((e) => say(`시뮬 표본 없음: ${e?.message ?? e}`, 'bad'));

function applyLive(arms, now) {
  window.__xrArms = arms;   // 헤드리스 검증용 — 지금 붙은 팔들
  const rp = replayOn && replay ? replay : null;
  if (rp) replayK = frameIndexAt(now, rp.framesPerInstance);
  for (const robot of arms) {
    const live = liveFor(robot.userData?.robotId, now);
    if (live) setJointsDeg(robot, { j1: live[0], j2: live[1], j3: live[2], j4: live[3], j5: live[4], j6: live[5] });
    else if (rp) setJointsDeg(robot, frameAt(rp.deg, replayK, rp.jointCount));
    // 고스트 — **실기가 흐르는 팔 위에만** 계획을 반투명으로 얹는다. 라이브가 없으면 팔 자체가 계획을
    // 도니 고스트를 숨긴다(같은 자세 두 대가 겹치면 뜻이 없다). 재생이 꺼져 있어도 숨긴다.
    // 우선순위 — ① 브리지가 낸 **가는 중인 목표**(계약 §이동 목표 · D196) ② 시뮬 표본 재생 ③ 숨김
    const ghost = robot.userData?.ghost;
    if (ghost) {
      const going = live ? goingTarget(robot.userData?.robotId, now) : null;
      const kind = going ? 'target' : (live && rp ? 'plan' : null);
      if (kind === 'target') setJointsDeg(ghost, asJoints(going));
      else if (kind === 'plan') setJointsDeg(ghost, frameAt(rp.deg, replayK, rp.jointCount));
      ghost.visible = kind !== null;
      if (ghost.userData.kind !== kind) {
        ghost.userData.kind = kind;
        if (kind === 'target') say('고스트 = 이동 목표(브리지 motionTarget · 파랑 반투명) · 불투명 팔 = 실기 지금 자세', 'ok');
        else if (kind === 'plan') say('고스트 = 계획(시뮬 표본 · 파랑 반투명) · 불투명 팔 = 실기 지금 자세', 'ok');
      }
    }
  }
  window.__xrGhosts = arms.map((r) => r.userData?.ghost).filter(Boolean);   // 헤드리스 검증용
}
window.__xrLive = liveByRobot;   // 헤드리스 검증용 — robotId별 라이브 스냅샷
// 헤드리스 검증용 — 재생이 도는지 숫자로 (프레임 번호 · 첫 팔의 관절각)
window.__xrReplay = {
  on: () => replayOn, k: () => replayK, batch: () => replay?.batchId ?? null,
  angles: () => (window.__xrArms?.[0] ? Object.values(window.__xrArms[0].joints ?? {}).map((j) => j.angle) : null),
};

$('go').onclick = async () => {
  const layout = buildPreset(sel.value);
  $('go').disabled = true;
  enterSession();
  tell('맵을 세우는 중…');
  try {
    if (modeOf().xr) await startAR(layout);
    else await startWalk(layout);
  } catch (e) {
    // **폰엔 콘솔이 없다.** 여기서 안 잡으면 거부된 프로미스가 조용히 사라지고
    // 사용자는 "그냥 안 됐다" 만 본다 (2026-08-06 `/감사`).
    say(`중단: ${e?.message ?? e}`, 'bad');
    leaveSession();
  } finally { sync(); }
};

// ── AR ─────────────────────────────────────────────────────────────────────
async function startAR(layout) {
  const longest = Math.max(layout.floor.widthMm, layout.floor.depthMm);
  // **평면도 원점이 곧 root 원점**이다 (`layout-view.js` 의 slab 이 `W/2, Z(D/2)` 에 놓인다).
  // 그래서 첫 모서리에 anchor 를 놓으면 그대로 맞는다.
  const W = layout.floor.widthMm / 1000;           // m
  const D = layout.floor.depthMm / 1000;

  // 모드마다 시키는 일이 다르다. 문구를 한 곳에 모아 둔다 — 세 군데에 흩어져 있으면
  // 모드를 하나 더 넣을 때마다 삼항 연산자가 한 겹씩 깊어진다.
  const HINT = {
    fit: { first: '링을 놓을 자리에 맞추고 탭하세요. 폰을 돌려 겨냥합니다', again: '다시 놓을 자리를 겨냥해 탭하세요' },
    walk: { first: '들어갈 쪽 바닥을 겨냥해 탭하세요. 그 자리가 입구가 되고 맵이 앞으로 펼쳐집니다', again: '다시 들어갈 자리를 겨냥해 탭하세요' },
    real: { first: '맵의 한쪽 모서리에 링을 맞추고 탭하세요. 다음은 대각선 반대편입니다', again: '맵의 한쪽 모서리를 겨냥해 탭하세요 (두 번 받습니다)' },
  };

  // **걸어 다닐 모드는 실제 공간이 맵보다 넓어야 한다.** 좁으면 가상 벽을 통과해
  // 실제 벽으로 걸어간다 — 화면은 아무 말도 안 해 준다. 그래서 숫자를 미리 적어 둔다.
  if (mode !== 'fit') {
    say(`이 맵은 ${W.toFixed(2)}×${D.toFixed(2)}m 입니다. 실제 공간이 이보다 좁으면 `
      + '가상 벽을 통과해 걷게 된다', 'bad');
  }

  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor'],
      // **`anchors` 가 이 화면의 핵심 옵션이다.** 없으면 놓은 좌표가 `local-floor` 의
      // 고정 숫자로 남는데, ARCore 는 세션 내내 바닥 추정을 갱신한다 — 그 갱신이
      // 좌표계를 움직이고 우리 맵만 옛 자리에 남아 뜬다. 앵커를 붙이면 반대로
      // **보정이 맵을 따라온다**. 걸어 들어가는 사용은 이게 전제다.
      optionalFeatures: ['dom-overlay', 'anchors'],
      // **루트가 화면을 덮으면 탭을 DOM 이 먹어 `select` 가 안 온다** (2026-08-04 실측).
      // 조작바에만 `beforexrselect` 를 걸어 그 위 탭만 DOM 으로 보낸다.
      domOverlay: { root: $('ov') },
    });
  } catch (e) { say(`세션 시작 실패: ${e?.message ?? e}`, 'bad'); leaveSession(); return; }

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.xr.enabled = true;
  await renderer.xr.setSession(session);
  document.body.appendChild(renderer.domElement);

  const { scene, sky, key, view } = buildScene(layout);
  const camera = new THREE.PerspectiveCamera();   // XR 이 투영행렬을 넣는다

  // 놓을 자리 표식 — 바닥에 눕힌 링. DOM 조준선보다 바닥에서 읽기 쉽다.
  //
  // **두 겹이다.** 흐린 바탕 링 위로 밝은 원호가 준비도만큼 차오른다 — 색이 회색→노랑→초록
  // 으로 바뀌는 것만으로는 "얼마나 남았나" 를 못 읽는다. 폰을 들고 바닥을 보는 사람은
  // 글자를 읽을 눈이 없으니 링 자체가 진행률이어야 한다.
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.12, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: RD_COLOR.gray, transparent: true, opacity: 0.32 }),
  );
  reticle.visible = false;
  scene.add(reticle);
  const arc = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.12, 32, 1, Math.PI / 2, 0).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: RD_COLOR.gray, transparent: true, opacity: 0.95 }),
  );
  arc.visible = false;
  scene.add(arc);
  /** 원호를 다시 굽는다. **20칸으로 뭉뚱그린다** — 매 프레임 지오메트리를 새로 만들 수는 없다. */
  let arcStep = -1;
  const setArc = (score) => {
    const step = Math.round(score * 20);
    if (step === arcStep) return;
    arcStep = step;
    arc.geometry.dispose();
    arc.geometry = new THREE.RingGeometry(0.088, 0.122, 48, 1, Math.PI / 2, (step / 20) * Math.PI * 2)
      .rotateX(-Math.PI / 2);
  };

  // 겨냥한 면 → 바닥 낙하선. 상판을 겨냥했을 때 **맵이 갈 곳이 어디인지** 보여준다 (F9).
  const dropMat = new THREE.LineBasicMaterial({ color: RD_COLOR.red, transparent: true, opacity: 0.8 });
  // **버퍼를 미리 잡고 값만 덮어쓴다.** `setFromPoints` 는 부를 때마다 새 어트리뷰트를
  // 만드는데, 상판을 겨냥한 채 있으면 그게 초당 60번이다 — 폰에서 GC 로 돌아온다.
  const dropXYZ = new Float32Array(6);
  const dropGeo = new THREE.BufferGeometry();
  dropGeo.setAttribute('position', new THREE.BufferAttribute(dropXYZ, 3));
  const drop = new THREE.Line(dropGeo, dropMat);
  drop.frustumCulled = false;      // 두 점짜리라 바운딩이 납작해 잘못 잘린다
  drop.visible = false;
  scene.add(drop);

  // 맵이 붙는 자리. 탭하면 이 그룹만 옮긴다 — 맵 데이터는 손대지 않는다.
  const anchor = new THREE.Group();
  scene.add(anchor);
  anchor.add(view.root);
  // 키 라이트를 앵커 밑에 둔다 — 맵이 옮겨져도 그림자 방향과 상자가 따라온다.
  anchor.add(key);
  anchor.add(key.target);
  // **바닥 슬래브는 숨긴다** — 진짜 바닥이 카메라 영상에 이미 있다 (cam.js 와 같은 이유).
  const slab = view.root.getObjectByName('slab');
  if (slab) slab.visible = false;
  // **놓기 전에는 맵을 안 그린다.** 예전엔 세션이 열리자마자 `local-floor` 원점 —
  // 즉 **시작할 때 서 있던 자리** — 에 맵이 통째로 떠 있었다. 겨냥한 곳과 아무 상관없는
  // 자리라, 사람은 "이미 놓였나?" 로 읽고 탭하면 거기서 점프한다 (폰에서 잡혔다).
  // 링만 보이는 게 맞다 — 링이 곧 "여기에 놓인다" 다.
  view.root.visible = false;

  // **벽을 유령으로.** 근거와 규약은 `features/place/place.js` 에 있다.
  const { walls, ghost, edge } = ghostWalls(view.root, slab);
  // 벽이 0장이면 정합을 눈으로 읽을 기준선이 없다 — 조용히 넘어가면 안 된다
  if (!walls) say('이 맵에는 벽이 없습니다. 방 껍데기가 빠져 있습니다', 'bad');

  // 그림자 받이 — 슬래브를 숨겼으니 **그림자를 받을 면이 하나도 없다.** 투명하지만
  // 그림자만 그리는 면을 슬래브 자리에 깔면, 실제 바닥 영상 위에 가상 그림자가 얹힌다.
  // 접지가 눈에 읽히는 것은 거의 전부 이 그림자다.
  const catcher = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.34 }),
  );
  catcher.position.set(W / 2, 0.002, -D / 2);      // Z(D/2) = −D/2 (layout-view 규약)
  catcher.receiveShadow = true;
  view.root.add(catcher);

  // **끝내기를 여기서 등록한다.** 아래 팔 받기가 대당 6MB 라 그 사이에 뒤로가기를 누르면
  // 죽은 세션에 `requestReferenceSpace` 를 물어 거부되고, 그 거부를 아무도 안 잡는다 —
  // **폰엔 콘솔이 없어 사용자는 "그냥 안 됐다" 만 본다.** 렌더러도 그대로 남는다.
  let ended = false;
  let hits = null;
  const barGuard = (e) => e.preventDefault();
  session.addEventListener('end', () => {
    ended = true;
    renderer.setAnimationLoop(null);
    renderer.domElement.remove();
    hits?.cancel?.();                       // 히트테스트 소스는 명시로 닫는다
    $('bar').removeEventListener('beforexrselect', barGuard);
    view.dispose?.();                       // geometry — 재질은 각자 지운다
    for (const m of [ghost, edge, catcher.material, reticle.material, arc.material, dropMat]) {
      m.dispose?.();
    }
    for (const g of [reticle.geometry, arc.geometry, drop.geometry]) g.dispose?.();
    sky.dispose?.();
    renderer.dispose();
    $('hud').hidden = false;
    $('fps').hidden = false;
    say('세션 종료');
    leaveSession();
  });

  // **세 AR 모드의 차이는 이 숫자 하나다.** `view.root` 는 미터로 지어지므로 1.0 이
  // 실물 1:1 이다. 답사는 1.0 을 그대로 쓰고(한 번 탭), 촬영은 1.0 에서 출발해 두 모서리를
  // 받으면 그 방·그 세션의 축척 오차만큼 보정된다.
  const scale0 = mode === 'fit' ? TARGET_MM / longest : 1;
  let scale = scale0;
  let yaw = 0;
  // **손으로 확대·축소했는가.** 이 표시가 없으면 답사에서 실수로 확대해도 계기는
  // 계속 `실물 1:1` 이라 적는다 — 걸어 다니며 눈으로 거리를 재는 모드라 치명적이다.
  // 촬영의 `보정` 은 이것과 다르다. 그건 **1:1 을 맞추려고** 곱한 값이다.
  let zoomed = false;
  const pct = (s) => `${s >= 1 ? '+' : ''}${((s - 1) * 100).toFixed(1)}%`;
  // **링이 맵의 어디에 해당하는가 — 모드가 정한다.** `layout-view.js:102` 의 root 원점은
  // 맵의 **모서리**라, 그대로 두면 셋 다 구석에 서게 된다.
  //
  //   평소 center — 탭한 곳이 **가운데**. 책상 위 모형은 "여기 놔라" 라는 뜻이다
  //   답사 edge   — 탭한 곳이 **들어가는 변의 가운데**. 구석에 서면 대각선으로 들어가야
  //                 해서 "걸어 들어간다" 가 성립하지 않는다 (폰에서 잡혔다)
  //   촬영 corner — **모서리 그대로.** `solveCorners` 가 첫 모서리를 원점으로 쓴다 —
  //                 여기서 바꾸면 축척 보정이 통째로 깨진다
  const PIVOT = { fit: 'center', walk: 'edge' }[mode] ?? 'corner';
  const apply = () => {
    view.root.scale.setScalar(scale);
    anchor.rotation.y = yaw;
    // 이동을 **여기서** 한다 — 탭할 때 좌표를 옮겨 두면 확대할 때마다 기준점이 모서리
    // 쪽으로 밀린다. 배율이 바뀔 때 같이 다시 잡아야 제자리에 머문다.
    const px = PIVOT === 'corner' ? 0 : -(W * scale) / 2;   // 가운데·변 둘 다 가로는 중앙
    const pz = PIVOT === 'center' ? (D * scale) / 2 : 0;    // 변은 z=0 모서리가 링에 온다
    view.root.position.set(px, 0, pz);
    // 라이트는 앵커 공간(=배율 없는 미터)에 있다. 맵의 **중심**을 비춰야 하므로
    // 위에서 옮긴 만큼을 더해 따라가게 한다.
    const cx = view.root.position.x + (W * scale) / 2;
    const cz = view.root.position.z - (D * scale) / 2;
    key.target.position.set(cx, 0, cz);
    key.position.set(cx + 2.5 * scale, 5 * scale, cz + 2.5 * scale);
    fitShadow(key, Math.max(W, D) * scale * 0.8);
    renderer.shadowMap.needsUpdate = true;
    $('hud').textContent = hudText({ mode, scale, widthM: W, depthM: D, yaw, zoomed });
  };
  apply();

  // **팔보다 방을 먼저 띄운다.** 아래 렌더 루프를 팔 받기 뒤에 등록했더니 6MB×3 을 받는
  // 내내 **검은 화면에 안내 한 줄**만 있었다 (실렌더가 잡았다 · 2026-08-06 `/감사`).
  // 히트테스트도 싸니 먼저 연다 — 그래야 받는 동안에도 조준 링이 산다.
  let arms = [];
  const hitSpace = await session.requestReferenceSpace('viewer');
  hits = await session.requestHitTestSource({ space: hitSpace });
  let aimed = null;
  let placed = false;
  let found = 0;
  const t0 = performance.now();
  let frames = 0;
  let fpsAt = performance.now();
  const fpsLog = [];

  // **바닥은 세션 전체에서 가장 낮은 면이다.** 한 프레임의 결과 중 최저를 고르는 것은
  // *그 광선 위*의 최저일 뿐이라, 책상을 겨냥한 채 탭하면 맵이 책상 높이에 앉는다.
  //
  // 대신 **`다시 놓기` 가 이 값을 비운다.** 안 그러면 초기 노이즈나 바닥 틈으로 낮은 히트가
  // 한 번 들어왔을 때 세션을 새로 열기 전에는 못 빠져나온다 (2026-08-06 `/감사`).
  let floorY = null;

  // 지금 겨냥 안에 벽이 있으면 그 벽에 맞출 yaw, 없으면 null. **매 프레임 다시 판정한다** —
  // 겨냥이 벗어났는데 옛 각도가 남아 있으면 엉뚱한 벽에 맞춘다.
  let wallYaw = null;
  // 법선을 뽑는 임시 그릇. 렌더 루프 안이라 매 프레임 새로 만들지 않는다.
  const NORMAL = new THREE.Vector3();
  const QUAT = new THREE.Quaternion();
  const FWD = new THREE.Vector3();
  let eyeFwd = null;               // 사람이 보는 방향 (바닥 성분). `평소` 가 맵을 이쪽으로 돌린다

  // ── 준비도 계측. **판정은 `place.js` 가 하고 여기서는 재기만 한다** — 그래야 폰 없이
  // 게이트가 판정을 검사할 수 있다. 예전의 `WARMUP_MS` 타이머가 이 자리에 있었다.
  let pathM = 0;                   // 눈이 실제로 움직인 누적 거리 = 시차
  let speedMps = 0;
  let lastEye = null;
  let lastEyeT = 0;
  const floorLog = [];             // 최근 바닥값(m). 흔들림을 여기서 잰다
  const swept = new THREE.Box3();  // 훑은 히트점이 퍼진 범위
  let rd = { score: 0, state: 'gray', ok: false, say: '바닥을 비추세요' };
  let lastHint = null;
  let hintHold = 0;                // 이 시각까지는 준비도가 안내줄을 안 건드린다
  let lastState = null;
  let greenAt = 0;
  // `다시 놓기` 를 누른 사람은 **자리를 직접 고르겠다는 뜻**이다. 그 뒤로 자동 놓기를
  // 다시 걸면 옮기려는 순간 제자리에 도로 놓여 "안 움직인다" 가 된다.
  let autoOff = false;
  // 팔을 받는 동안 안내줄은 **받기 진행률이 쓴다** (대당 6MB). 준비도가 매 프레임 덮어쓰면
  // "몇 대째 받는 중" 이 통째로 안 보인다 — 그게 검은 화면 다음으로 나빴다.
  let armsLoading = true;

  // 앵커 — 다음 프레임에 만들 자리와, 만들어진 뒤의 앵커.
  //
  // **놓기 세대를 센다.** `createAnchor` 는 프로미스라, 앵커가 붙기 *전에* `다시 놓기` 를
  // 누르면 그 시점 `xrAnchor` 는 아직 `null` 이라 **삭제가 무동작**이고, 뒤늦게 해결되며
  // 옛 자리 앵커가 되살아난다. 그러면 아래 렌더 루프가 매 프레임 그걸로 위치를 덮어써
  // **새로 놓은 맵이 옛 자리로 끌려간다** (2026-08-07 `/감사` F1).
  // 사람 손으로는 타이밍이 잘 안 맞아 안 보였다 — 자동 놓기가 이걸 상시 경로로 만든다.
  let placeGen = 0;
  let anchorReq = null;
  let xrAnchor = null;
  let anchorWarned = false;

  // 조작바 위의 탭은 **DOM 이 가져간다** — 안 그러면 버튼을 누를 때마다 맵이 옮겨진다
  $('bar').addEventListener('beforexrselect', barGuard);

  let cornerA = null;                 // 촬영 모드의 첫 모서리
  let barShown = true;
  // 촬영은 탭 2회다. 어디까지 했는지 **로그가 아니라 화면**이 말해야 한다.
  const steps = $('steps').children;
  const setStep = (n) => {
    $('steps').hidden = mode !== 'real' || placed;
    steps[0].classList.toggle('on', n >= 1);
    steps[1].classList.toggle('on', n >= 2);
  };
  setStep(1);

  /**
   * 실제로 놓는다. **탭과 자동 놓기가 같은 길을 쓴다** — 갈라 두면 한쪽만 고쳐서
   * 자동으로 놓았을 때만 앵커가 안 붙는 식의 버그가 난다.
   */
  const tryPlace = () => {
    // **거절하지 않고 링이 말한다.** 예전엔 탭을 받아 놓고 "안 된다" 고 답했다 — 사후
    // 처벌이다. 지금은 준비가 안 됐으면 링이 회색·노랑이라 애초에 탭할 생각이 안 든다.
    if (placed || !aimed || !rd.ok) return;

    if (mode === 'real' && !cornerA) {
      cornerA = aimed.clone();
      setStep(2);
      tell('이제 대각선 반대편 모서리를 겨냥해 탭하세요');
      say(`모서리 ① 받음 · 높이 ${(aimed.y * 1000).toFixed(0)}mm`);
      return;
    }

    // 놓을 자리. **높이는 겨냥한 면이 아니라 세션 최저면(바닥)을 쓴다.**
    const at = new THREE.Vector3(aimed.x, floorY ?? aimed.y, aimed.z);

    if (mode === 'real') {
      // 배율·회전을 한 번에 낸다. 유도와 부호 규약은 `place.js` 에 있다.
      const sol = solveCorners(cornerA, aimed, W, D);
      scale = sol.scale;
      yaw = sol.yaw;
      at.set(cornerA.x, floorY ?? cornerA.y, cornerA.z);
      say(`모서리 ② 받음 · 잰 대각 ${(sol.measuredM * 1000).toFixed(0)}mm · `
        + `참값 ${(sol.diagM * 1000).toFixed(0)}mm · 보정 ${pct(scale)}`, 'ok');
      if (sol.measuredM < 0.3) say('두 탭이 너무 가깝습니다. 같은 자리를 찍으셨을 수 있습니다', 'bad');
      if (scale < SANE_SCALE[0] || scale > SANE_SCALE[1]) {
        say('보정값이 너무 큽니다. 마주보는 모서리가 맞는지 확인하세요', 'bad');
      }
      // 촬영 모드는 놓는 순간 계기를 끈다. **로그에는 남으므로 `결과 복사`로 회수된다.**
      $('hud').hidden = true;
      $('fps').hidden = true;
    } else {
      // **맵이 사람을 마주 본다.** `yaw = 0` 은 사람이 보는 쪽과 아무 상관이 없었다 —
      // 평소는 읽으려고, 답사는 **앞으로 걸어 들어가려고** 이쪽을 향해야 한다.
      // 어느 자리가 링에 오는지(가운데냐 변 가운데냐)는 `apply()` 의 `PIVOT` 이 정한다.
      const face = eyeFwd ? yawFromWallNormal({ x: -eyeFwd.x, z: -eyeFwd.z }) : null;
      if (wallYaw !== null) {
        // **벽이 정밀함을, 사람이 방향을 낸다.** 벽 법선은 yaw 를 90° 네 자리까지만
        // 좁힌다 — 그 마지막 한 칸을 `↺↻` 로 미루지 않고 서 있는 쪽이 고른다.
        yaw = face !== null ? snapQuadrant(wallYaw, face) : wallYaw;
        say(`벽에 맞춤 · ${Math.round((yaw * 180) / Math.PI)}°`, 'ok');
      } else if (face !== null) {
        yaw = face;
      }
      say(`놓음 · 겨냥 높이 ${(aimed.y * 1000).toFixed(0)}mm · `
        + `바닥 ${((floorY ?? aimed.y) * 1000).toFixed(0)}mm · 1:${(1 / scale).toFixed(1)}`, 'ok');
    }
    // 앵커가 붙기 전에도 바로 보여야 하니 좌표를 먼저 넣고, 앵커는 다음 프레임에 만든다
    // (`createAnchor` 는 **활성 프레임 안**에서만 부를 수 있다).
    // **놓는 순간의 준비도를 로그에 남긴다.** 화면 문구는 명령형이라 기술 용어가 없는데,
    // `결과 복사` 가 회수하는 이 로그가 실기 검증의 유일한 증거다 — 어긋났을 때
    // "그때 어떤 상태에서 놓았나" 를 여기서만 알 수 있다 (F11).
    say(`놓은 시점 준비도 ${(rd.score * 100).toFixed(0)}% ${rd.state} · `
      + `이동 ${pathM.toFixed(2)}m · 훑은 범위 ${(swept.isEmpty() ? 0
        : Math.max(swept.max.x - swept.min.x, swept.max.z - swept.min.z)).toFixed(2)}m · `
      + `바닥 흔들림 ${floorLog.length >= 5
        ? ((Math.max(...floorLog) - Math.min(...floorLog)) * 1000).toFixed(0) : '?'}mm`);

    anchor.position.copy(at);
    placeGen += 1;                   // 이전 세대의 앵커 프로미스를 무효로 만든다 (F1)
    anchorReq = at.clone();
    placed = true;
    view.root.visible = true;        // 이제야 맵을 그린다
    reticle.visible = false;
    arc.visible = false;
    drop.visible = false;
    setStep(2);
    lastHint = null;
    tell('');
    apply();
  };

  // ── 훑기. **누르고 있는 동안 링이 지나간 바닥점을 모아** 그 선에 맵을 나란히 맞춘다.
  //
  // 손가락이 아니라 **폰을 움직인다** — 조준 광선이 `viewer` 에서 나가므로 화면 위 손가락
  // 위치는 애초에 안 본다. 그게 오히려 낫다: 걸으면서 훑으면 시차가 같이 벌리고, 표본이
  // 전부 같은 거리·같은 각도라 먼 쪽이 스치는 각도로 뭉개지지 않는다.
  //
  // **`select` 와 `selectend` 의 발화 순서에 기대지 않는다.** 점 목록을 `selectstart` 에서만
  // 비우므로 어느 순서로 와도 "훑기였다" 를 양쪽이 똑같이 읽는다 (F7).
  let sweepPts = [];
  let sweeping = false;
  let sweepPath = 0;
  session.addEventListener('selectstart', () => {
    sweepPts = [];
    sweepPath = pathM;
    // 촬영은 탭 2회 규약이 따로 있고, 놓은 뒤엔 조작바 토글이 이 이벤트를 쓴다
    sweeping = !placed && mode !== 'real';
  });
  session.addEventListener('selectend', () => {
    sweeping = false;
    if (sweepPts.length < SWEEP_MIN) return;
    const fit = fitLine(sweepPts);
    // 훑기 결과는 **잠깐 붙잡아 둔다** — 안 그러면 다음 프레임에 준비도 문구가 덮어써서
    // 사람이 자기가 방금 뭘 했는지 못 읽는다.
    hintHold = performance.now() + HOLD_MS;
    if (!fit) { tell('너무 짧습니다. 벽을 따라 좀 더 길게 훑으세요'); return; }
    // **사람이 실제로 움직였는지 따로 잰다.** 서서 폰만 돌리면 점들은 여전히 직선이라
    // 잔차가 작게 나오는데(F8), 먼 쪽 깊이 오차는 크다 — 잔차만 믿으면 안 된다.
    const moved = pathM - sweepPath;
    yaw = fit.yaw;
    apply();
    say(`훑기 정렬 · ${Math.round((yaw * 180) / Math.PI)}° · 길이 ${fit.spanM.toFixed(2)}m · `
      + `잔차 ${fit.residualMm.toFixed(0)}mm · 이동 ${moved.toFixed(2)}m · 표본 ${sweepPts.length}`,
    fit.residualMm < 50 && moved > 0.15 ? 'ok' : 'bad');
    if (fit.residualMm >= 50) tell('선이 휘었습니다. 천천히 다시 훑으세요');
    else if (moved <= 0.15) tell('제자리에서 돌리셨습니다. 옆으로 걸으며 다시 훑으세요');
    else tell('벽에 맞췄습니다. 이제 놓을 자리를 탭하세요');
  });

  session.addEventListener('select', () => {
    // **놓은 뒤의 탭은 안 옮긴다.** 촬영 중 화면을 스치면 맵이 튀었다.
    // 대신 조작바를 여닫는 데 쓴다 — 영상에 버튼이 안 찍히게 하려면 이 길뿐이다.
    if (placed) { barShown = !barShown; $('bar').hidden = !barShown; return; }
    // 훑는 동작이었다면 이건 놓기가 아니라 **정렬**이다 — `selectend` 가 처리한다
    if (sweepPts.length >= SWEEP_MIN) return;
    tryPlace();
  });

  $('zoomIn').onclick = () => { scale *= 1.25; zoomed = true; apply(); };
  $('zoomOut').onclick = () => { scale /= 1.25; zoomed = true; apply(); };
  // **90° 씩 돈다.** 벽 법선이 미세각을 넣어 주므로 사람에게 남는 건 "네 벽 중 어느 벽"
  // 뿐이다 — 직사각형이라 90° 네 자리가 다 유효하고, 기하학은 어느 것인지 안 알려준다.
  // 예전 15° 는 그 미세각을 손으로 맞추라는 뜻이었고, 그게 정합 오차의 최대 항이었다.
  $('rotL').onclick = () => { yaw -= Math.PI / 2; apply(); };
  $('rotR').onclick = () => { yaw += Math.PI / 2; apply(); };
  $('again').onclick = () => {
    placed = false;
    view.root.visible = false;     // 다시 링만 보이는 상태로

    cornerA = null;
    anchorReq = null;
    // **세대를 올리는 것이 핵심이다.** 아직 안 붙은 앵커는 여기서 지울 수가 없어
    // (`xrAnchor` 가 `null` 이다) 세대로 무효화한다 — 안 그러면 뒤늦게 되살아난다 (F1)
    placeGen += 1;
    xrAnchor?.delete?.();          // 안 지우면 앵커가 세션에 쌓인다
    xrAnchor = null;
    scale = scale0;                // 손으로 늘린 배율도 되돌린다 — 답사는 1:1 이 전제다
    zoomed = false;
    floorY = null;                 // 잘못 잡힌 바닥에서 빠져나오는 유일한 길
    floorLog.length = 0;           // 바닥값을 비웠으니 그 흔들림도 다시 잰다
    lastHint = null;
    autoOff = true;                // 이제부터 자리는 사람이 고른다
    // **`pathM` 과 `swept` 은 안 비운다** — 이미 걸었고 이미 훑었다. 그건 여전히 사실이라,
    // 지우면 사람에게 한 일을 또 시키게 된다.
    say('다시 놓기. 배율과 바닥값을 비웠습니다');
    $('hud').hidden = false;
    $('fps').hidden = false;
    setStep(1);
    tell(HINT[mode].again);
    apply();
  };
  $('exit').hidden = true;         // AR 은 폰의 뒤로가기로 나간다
  $('bar').hidden = false;

  renderer.setAnimationLoop((t, frame) => {
    if (frame) {
      const ref = renderer.xr.getReferenceSpace();

      // **눈의 이동을 잰다.** ARCore 를 수렴시키는 건 시간이 아니라 시차다 — 가만히 서서
      // 기다리면 얻는 게 없고, 옆으로 반 걸음이 5초보다 낫다.
      const eye = frame.getViewerPose(ref);
      if (eye) {
        const p = eye.transform.position;
        if (lastEye) {
          const d = Math.hypot(p.x - lastEye.x, p.y - lastEye.y, p.z - lastEye.z);
          pathM += d;
          const dt = (t - lastEyeT) / 1000;
          if (dt > 0) speedMps = speedMps * 0.8 + (d / dt) * 0.2;   // 떨림을 눌러 읽는다
        }
        lastEye = { x: p.x, y: p.y, z: p.z };
        lastEyeT = t;
        // 카메라는 로컬 −Z 를 본다. 바닥 성분만 쓴다 — 고개를 숙여도 방위는 안 변해야 한다.
        FWD.set(0, 0, -1).applyQuaternion(QUAT.copy(eye.transform.orientation));
        eyeFwd = { x: FWD.x, z: FWD.z };
      }

      const r = hits ? frame.getHitTestResults(hits) : [];
      if (r.length) {
        // **먼저 수평/수직을 가른다.** 예전엔 그냥 최저를 골랐는데, 벽을 겨냥해도 바닥
        // 히트가 같이 와서 **늘 바닥이 이겼다** — 벽 법선이 영영 안 왔다 (F2).
        // 더 나쁜 건 `floorY` 다: 수직 평면은 바닥선 아래로 자주 뻗어서, 한 번 섞이면
        // 세션 바닥값이 내려앉고 **맵이 바닥 밑으로 파묻힌다** (F3).
        //
        // 법선은 히트 포즈에서 그대로 나온다 — 규약상 포즈의 **로컬 +Y 가 그 면의 법선**이다.
        // 오일러로 뽑지 않는다: 벽 포즈는 이미 90° 눕혀져 있어 pitch 가 yaw 로 샌다 (F6).
        let low = null;
        let wall = null;
        for (const h of r) {
          const po = h.getPose(ref);
          if (!po) continue;
          const n = NORMAL.set(0, 1, 0).applyQuaternion(QUAT.copy(po.transform.orientation));
          const kind = classifyHit(n.y);
          if (kind === 'horizontal') {
            if (!low || po.transform.position.y < low.transform.position.y) low = po;
          } else if (kind === 'vertical' && wall === null) {
            wall = yawFromWallNormal(n);
          }
        }
        wallYaw = wall;
        if (low) {
          aimed = new THREE.Vector3().copy(low.transform.position);
          // **수평 히트만 바닥값을 내린다** (F3)
          if (floorY === null || aimed.y < floorY) floorY = aimed.y;
          floorLog.push(aimed.y);
          if (floorLog.length > 30) floorLog.shift();
          swept.expandByPoint(aimed);
          if (sweeping) sweepPts.push({ x: aimed.x, z: aimed.z });
          if (!found) {
            found = performance.now();
            say(`평면 찾음 · ${((found - t0) / 1000).toFixed(1)}초`, 'ok');
          }
        }
      }

      // ── 준비도 → 링·문구. 놓기 전에만 잰다.
      if (!placed) {
        const above = aimed && floorY !== null ? (aimed.y - floorY) * 1000 : 0;
        rd = readiness({
          pathM,
          // 표본이 몇 개 안 되면 흔들림을 말할 자격이 없다 — `null` 은 "아직 모른다" 다
          floorSpreadMm: floorLog.length >= 5
            ? (Math.max(...floorLog) - Math.min(...floorLog)) * 1000 : null,
          extentM: swept.isEmpty() ? 0
            : Math.max(swept.max.x - swept.min.x, swept.max.z - swept.min.z),
          aboveFloorMm: above,
          speedMps,
          elapsedMs: found ? t - found : 0,
        });

        // **초록이 되는 순간 진동.** 폰을 들고 바닥을 보는 사람은 글자를 읽을 눈이 없다 —
        // 30ms 한 번이면 안 보고도 안다. 회색↔노랑에는 안 울린다: 자주 울리면 그것도 소음이다.
        if (rd.state === 'green' && lastState !== 'green') {
          greenAt = t;
          navigator.vibrate?.(30);
        } else if (rd.state !== 'green') greenAt = 0;
        lastState = rd.state;

        // **`평소` 만 저절로 놓는다.** 자리가 어디든 상관없는 모드라 사람이 할 일을
        // "폰 들고 바닥 훑기" 하나로 줄일 수 있다. 답사·촬영은 *특정 구석*을 노리므로
        // 저절로 놓으면 엉뚱한 데 앉는다 — 거기선 초록 + 진동까지만 하고 탭은 사람이 한다.
        if (mode === 'fit' && !autoOff && !sweeping && greenAt && t - greenAt > AUTO_MS) {
          say('자동으로 놓았습니다. 자리를 바꾸려면 `다시 놓기`', 'ok');
          tryPlace();
        }

        // **링은 맵이 갈 자리에 선다** — 겨냥한 상판이 아니라 바닥이다. 둘이 벌어지면
        // 낙하선을 그어 "여기를 보고 있지만 저기에 놓인다" 를 한 장면으로 만든다 (F9).
        if (aimed) {
          const fy = floorY ?? aimed.y;
          reticle.position.set(aimed.x, fy, aimed.z);
          arc.position.copy(reticle.position);
          reticle.visible = true;
          arc.visible = true;
          reticle.material.color.setHex(RD_COLOR[rd.state]);
          arc.material.color.setHex(RD_COLOR[rd.state]);
          setArc(rd.score);
          drop.visible = above > DROP_MM;
          if (drop.visible) {
            dropXYZ.set([aimed.x, aimed.y, aimed.z, aimed.x, fy, aimed.z]);
            dropGeo.attributes.position.needsUpdate = true;
          }
        }

        // **문구는 한 곳에서만 정한다.** 여러 군데서 `tell` 하면 서로 덮어써 마지막 것만
        // 남는다 — 무엇이 이겼는지 코드를 읽어야 알게 된다. 우선순위를 여기 한 줄로 둔다.
        const want = (() => {
          if (!rd.ok) return rd.say;
          if (mode === 'real') return cornerA ? '이제 대각선 반대편 모서리를 겨냥해 탭하세요' : HINT.real.first;
          if (wallYaw !== null) return '벽을 잡았습니다. 탭하면 이 벽에 나란히 놓입니다';
          return rd.say;
        })();
        if (!armsLoading && t > hintHold && want !== lastHint) { lastHint = want; tell(want); }
      }

      // 앵커 만들기 — **활성 프레임 안**이라 여기서만 가능하다.
      if (anchorReq) {
        const req = anchorReq;
        anchorReq = null;
        if (typeof frame.createAnchor === 'function') {
          const gen = placeGen;
          frame.createAnchor(new XRRigidTransform({ x: req.x, y: req.y, z: req.z }), ref)
            .then((a) => {
              // 기다리는 사이에 다시 놓았거나 나갔다 — **받은 앵커를 버린다.**
              // 안 버리면 이 앵커가 계속 살아 새 자리를 옛 자리로 끌어간다 (F1).
              if (gen !== placeGen || ended) { a.delete?.(); return; }
              xrAnchor = a;
              say('앵커를 붙였습니다. 트래킹 보정이 따라옵니다', 'ok');
            })
            .catch((e) => say(`앵커 실패: ${e?.message ?? e} (고정 좌표로 진행)`, 'bad'));
        } else if (!anchorWarned) {
          anchorWarned = true;
          say('앵커를 지원하지 않는 기기입니다. 걸어 다니면 어긋날 수 있습니다', 'bad');
        }
      }
      // 앵커가 있으면 **매 프레임 그 자리를 다시 묻는다.** ARCore 가 바닥 추정을 고칠
      // 때마다 이 좌표가 같이 고쳐진다. 회전은 우리 것을 유지한다 (yaw 는 사람이 정했다).
      if (xrAnchor) {
        const p = frame.getPose(xrAnchor.anchorSpace, ref);
        if (p) {
          const q = p.transform.position;
          // **보정이 들어오면 그림자도 다시 그린다** (§ANCHOR_EPS). 이걸 빼면
          // 앵커는 따라오는데 그림자만 옛 자리에 남아 접지가 도로 깨진다.
          if (!renderer.shadowMap.autoUpdate
            && Math.abs(q.x - anchor.position.x) + Math.abs(q.y - anchor.position.y)
              + Math.abs(q.z - anchor.position.z) > ANCHOR_EPS) {
            renderer.shadowMap.needsUpdate = true;
          }
          anchor.position.set(q.x, q.y, q.z);
        }
      }
    }
    // **fps 를 화면에 적고 로그에도 남긴다.** 그림자를 켠 뒤의 비용은 이 숫자가 말한다
    // (GAP: 폰 성능 미측정). 화면에만 있으면 `결과 복사` 로 회수되지 않는다.
    frames += 1;
    if (t - fpsAt > 2000) {
      const f = Math.round((frames * 1000) / (t - fpsAt));
      $('fps').textContent = `${f} fps`;
      fpsLog.push(f);
      if (fpsLog.length % 5 === 0) {
        const srt = [...fpsLog].sort((a, b) => a - b);
        say(`fps 중앙값 ${srt[srt.length >> 1]} · 최저 ${srt[0]} · 팔 ${arms.length}대`);
      }
      frames = 0; fpsAt = t;
    }
    applyLive(arms, t);   // 실기 라이브를 매핑된 팔에 얹는다
    renderer.render(scene, camera);
  });

  arms = await mountArms(view);
  if (ended) return;                        // 팔 받는 사이에 나갔다 — 아래는 죽은 세션이다
  armsLoading = false;                      // 이제부터 안내줄은 준비도가 쓴다
  // 팔이 안 움직이므로 그림자맵을 매 프레임 다시 그릴 이유가 없다 — 폰에서 이게 크다.
  // 바뀔 때는 `apply()` 가, 앵커가 보정될 때는 렌더 루프가 `needsUpdate` 를 켠다.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
}

// ── 화면 — AR 없이 방 안에 서서 둘러본다 ────────────────────────────────────
//
// **XR 세션을 안 연다.** 안드로이드 크롬은 헤드셋 없이 `immersive-vr` 을 안 열어준다.
// 실제로 걸어 들어가는 것은 `답사`(1:1 AR)가 하고, 이건 **공간도 폰도 없을 때**
// 맵을 사람 눈높이에서 확인하는 쪽이다.
//
// 그래서 진짜 값어치는 여기 있다: **PC 브라우저에서 열린다.** AR 은 폰이 있어야만
// 확인되는데, 이 모드는 헤드리스로도 렌더된다 — 맵 3D 의 실렌더 검증 경로다.
async function startWalk(layout) {
  const W = layout.floor.widthMm / 1000;
  const D = layout.floor.depthMm / 1000;

  const { scene, sky, key, view } = buildScene(layout);
  scene.add(view.root);
  // AR 과 달리 **슬래브도 벽도 그대로 둔다** — 이 모드는 방 안이다.
  // `updateCutaway` 도 부르지 않는다. 안에서는 벽이 다 보여야 방으로 읽힌다.
  scene.background = sky;         // 위를 보면 천장 대신 환경맵이 보인다
  key.position.set(W / 2 + 3, 5.5, -D / 2 + 3);
  key.target.position.set(W / 2, 0, -D / 2);
  fitShadow(key, Math.max(W, D) * 0.75);
  scene.add(key);
  scene.add(key.target);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const el = renderer.domElement;
  el.id = 'walk';
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';

  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 60);
  // 남쪽 벽 근처에 서서 방 안쪽(−z)을 본다. three.js 의 yaw 0 이 −z 방향이다.
  const pos = new THREE.Vector3(W / 2, EYE_M, -D * 0.12);
  let yaw = 0;
  let pitch = -0.05;

  let arms = [];
  // 끌면 둘러보고, **끌지 않은 탭은 그 바닥으로 간다.** 조이스틱을 안 만드는 이유는
  // 이 모드의 용도가 "맵을 눈으로 확인" 이지 이동 자체가 아니기 때문이다.
  const ray = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  let dragging = false;
  let lastX = 0; let lastY = 0; let moved = 0;

  el.addEventListener('pointerdown', (e) => {
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
    // 합성 포인터(헤드리스 검증)는 캡처가 없다 — 여기서 던지면 조작이 통째로 죽는다
    try { el.setPointerCapture(e.pointerId); } catch { /* 캡처는 있으면 좋은 것뿐이다 */ }
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX; const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    yaw -= dx * 0.005;
    pitch = Math.max(-1.2, Math.min(1.2, pitch - dy * 0.005));
  });
  el.addEventListener('pointerup', (e) => {
    dragging = false;
    if (moved >= 8) return;                       // 둘러본 것이지 이동이 아니다
    const r = el.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    ), camera);
    if (!ray.ray.intersectPlane(floorPlane, hit)) return;
    // 벽을 뚫고 나가지 않게 방 안으로 가둔다
    pos.x = Math.max(0.4, Math.min(W - 0.4, hit.x));
    pos.z = Math.max(-D + 0.4, Math.min(-0.4, hit.z));
  });

  const onResize = () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', onResize);

  $('hud').hidden = false;
  $('fps').hidden = false;
  $('hud').textContent = `화면 · ${W.toFixed(2)}×${D.toFixed(2)}m · 눈높이 ${EYE_M}m`;
  for (const id of ['zoomIn', 'zoomOut', 'rotL', 'rotR', 'again']) $(id).hidden = true;
  $('exit').hidden = false;
  $('bar').hidden = false;

  $('exit').onclick = () => {
    renderer.setAnimationLoop(null);
    removeEventListener('resize', onResize);
    el.remove();
    document.body.style.overflow = '';
    for (const id of ['zoomIn', 'zoomOut', 'rotL', 'rotR', 'again']) $(id).hidden = false;
    $('exit').hidden = true;
    view.dispose?.();
    sky.dispose?.();
    renderer.dispose();
    say('화면 모드 종료');
    leaveSession();
  };

  let frames = 0;
  let fpsAt = performance.now();

  // **방을 먼저 띄우고 팔을 받는다** (AR 쪽과 같은 이유 — 검은 화면 3초가 나온다).
  renderer.setAnimationLoop((t) => {
    camera.position.copy(pos);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    frames += 1;
    if (t - fpsAt > 2000) {
      $('fps').textContent = `${Math.round((frames * 1000) / (t - fpsAt))} fps`;
      frames = 0; fpsAt = t;
    }
    applyLive(arms, t);   // 실기 라이브를 매핑된 팔에 얹는다
    renderer.render(scene, camera);
  });

  arms = await mountArms(view);
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  tell('끌어서 둘러본다 · 바닥을 탭하면 그리로 간다');
  say(`화면 모드 시작 · ${W.toFixed(2)}×${D.toFixed(2)}m · 팔 ${arms.length}대`, 'ok');
}

// ── 기동. 지원 확인이 끝나야 칩·버튼 상태가 정해진다.
if (!navigator.xr) {
  $('dot').className = 'bad';
  $('sup').textContent = 'navigator.xr 이 없습니다. `화면` 모드만 열립니다';
} else {
  arOk = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  $('dot').className = arOk ? 'ok' : 'bad';
  $('sup').textContent = arOk ? '이 기기는 AR 을 엽니다' : '이 기기는 AR 을 못 엽니다';
  say(`immersive-ar 지원: ${arOk}`, arOk ? 'ok' : 'bad');
}
renderChips();
sync();
showPreview();

// 헤드리스 검증용 노출 — `cam.js` 의 `__cam` 과 같은 계약이다 (`AR/AGENTS.md`).
// **빼지 않는다.** 이 화면은 칩과 미리보기를 모듈이 만들므로, 이게 없으면 검증기가
// 준비 시점을 알 길이 없다 — 준비 전에 눌러 놓고 "버튼이 안 열린다" 는 **거짓 실패**를
// 낸다 (`xr-web-verify.mjs` 첫 판이 실제로 그랬다 · 2026-08-06).
globalThis.__xr = {
  arOk,
  mode: () => mode,
  setMode: (m) => { mode = m; sync(); },
  modes: () => MODES.map((x) => x.id),
  preview: () => Boolean(preview),
};
