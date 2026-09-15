// 글로벌 카메라 화면 — 고정 카메라 영상 위에 배치안 3D 를 겹친다.
//
// **추적을 안 한다.** 카메라가 고정이라 캘리브레이션 한 번이면 끝이고, 그래서 떨림이 0 이다.
//
// 세 가지를 밖에서 받는다 — 셋 다 URL 로 넘겨 링크 하나로 재현된다.
//   ?feed=<MJPEG URL>   카메라 영상. 없으면 합성 고정물
//   ?scene=<JSON URL>   대시보드에서 **내보낸 배치안 전문**. 파일 선택으로도 된다
//   ?fit=WxD&anchor=x,y 태그 사각형(mm)에 맵을 **맞춰 줄인다**. 아래 §배율
//   ?rot=도             맵을 anchor 를 축으로 **평면에서 돌린다** (2026-08-19 · D135).
//                       실맵 프리셋은 방 축이 로봇 축이라(lab 와 ~177° 차이) 이동만으로는
//                       영영 안 맞는다. 값은 planToScene 손방향 기준 — 눈으로 맞춰 확정한다
//   ?alt=mm             맵 바닥을 **lab z 기준으로** 올리고 내린다 (기본 0 = 태그 평면).
//                       lab z=0 은 실험실 바닥이 아니라 **카트 상판**이다 — 실맵은 -1000 근처
//   ?only=종류,종류      그 소품 **종류만** 그린다 (벽·문·팔·나머지 소품 전부 숨김).
//                       실물이 이미 영상에 있는 것(작업대·카트)을 그림으로 또 덮으면 실물이
//                       안 보인다 — 실맵 겹침은 `only=conveyor` 로 **가상인 것만** 얹는다 (D135)
//   ?anchors=1          **태그 직결.** `scene-anchors.json`(anchor-pose.py 산출)의 lab 좌표에
//                       앵커 소품을 그대로 세운다 — 배치안 사슬(?anchor/?rot, yaw 재측정 대기)을
//                       안 탄다. 종이가 리모컨이다: 태그를 옮기고 anchor-pose 를 다시 돌리면 따라온다
//
// **배율이 왜 필요한가** — 배치안은 12m 방인데 강의실은 3m 다. 1:1 로 겹치면 벽이 방을
// 뚫고 나간다. 태그를 놓은 사각형에 맵을 넣으면 **태그 배치가 곧 맵 크기**가 된다.

import * as THREE from 'three';
import { createStage } from '@fr5/shared/view3d/lab/stage.js';
import { applyCalibToCamera } from '@fr5/shared/view3d/global-cam.js';
import { createLayoutView } from '@fr5/shared/view3d/lab/layout-view.js';
import { createAnchorOverlay } from '@fr5/shared/view3d/anchor-overlay.js';
import { subscribeRobotState } from '@fr5/shared/data/datasource/state-stream.js';
import { selectVisualGhost } from '@fr5/shared/data/visualization/ghost.js';
import { loadConfig, loadRobot, mountRobotYUp, paintGhost, setGripperOpenPct, setJointsDeg } from '@fr5/shared/view3d/robot.js';
import { migrateLayout, validateLayout } from '@fr5/shared/data/layout/schema.js';
import { planToScene } from '@fr5/shared/data/units/units.js';
import { labToPixel } from '@fr5/shared/view3d/global-cam.js';
// 판정면은 **FR5 3D 트윈과 같은 함수**가 그린다 — 사본을 만들면 두 화면이 서로 다른
// 경계를 그리기 시작하고, 안전 표시에서 그게 제일 나쁘다 (`workspace.js` 머리말과 같은 정신)
// 판정면 겹치기는 **FR5 조작대와 같은 구현**을 쓴다 — 화면마다 짜면 두 화면이 서로 다른
// 경계를 그리기 시작한다 (하드 룰 5 · `zone-overlay.js` 머리말)
import { createZoneOverlay, calibTrust, zoneLegend } from '@fr5/shared/view3d/zone-overlay.js';
import { resolveTheme } from '@fr5/shared/view3d/zone-theme.js';
// **판정을 여기서 짜지 않는다** (2026-08-07). 무엇이 경고인지는 FR5 PiP 와 **같은 함수**가
// 정한다 — 화면마다 따로 짜면 두 화면의 "괜찮다"가 갈라지고, 안전 표시에서 그게 제일 나쁘다
import { cameraState, shouldAdoptCalib } from '@fr5/shared/data/camera/state.js';
import { watchFrames } from '@fr5/shared/data/camera/watch.js';

const FIX = '/test/cam-fixture';
const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
// `#status` 는 **실패 메시지 전용**이다. 카메라 상태는 아래 `#camhud` 가 맡는다
const status = (s, warn = false) => { $('status').textContent = s; $('status').classList.toggle('warn', warn); };

// ── 카메라 상태 띠. **판정은 안 한다** — `cameraState` 가 낸 문장과 색을 그리기만 한다.
// 배치는 화면마다 다르다(FR5 는 300px PiP, 여기는 전체화면 머리띠). 같아야 하는 건 판정뿐이다.
// `settings` 는 `undefined` 로 둔다 — 합성 고정물에는 물을 폰이 없고, 못 고칠 경고를
// 상주시키면 사람이 경고를 무시하는 법을 배운다 (`state.js` §settings)
// `drift` 초기값 `undefined` = **감시를 안 걸었다**(고정물이거나 `watch-calib.py` 가 안 돈다).
// 값은 아래 `watchDrift()` 가 채운다 — 못 읽으면 `null`(=모른다)이지 초록이 아니다
const cam = { calib: null, live: null, stale: false, lastChangeMsAgo: null,
  settings: undefined, drift: undefined };
function paintHud() {
  const img = $('feed');
  const rows = cameraState({
    calib: cam.calib,
    status: cam.settings,
    observed: { live: cam.live, stale: cam.stale, lastChangeMsAgo: cam.lastChangeMsAgo,
      streamW: img.naturalWidth || null, streamH: img.naturalHeight || null,
      drift: cam.drift },
  });
  // 겹침 판정은 **`state.js` 것을 물려받는다** — 나이(감시기 죽음)까지 거기가 이미 본다.
  // 여기서 다시 짜면 화면이 "감시가 멎었다"라고 말하면서 선은 초록인 상태가 난다
  // (2026-08-13 실측: 164초 전 값인데 판정면이 `trust: ok` 였다)
  cam.driftRow = rows.find((r) => r.key === 'drift') ?? null;
  $('camhud').replaceChildren(...rows.map((r) => {
    const el = document.createElement('span');
    el.dataset.tone = r.tone;
    el.dataset.t = `cam-hud-${r.key}`;
    el.textContent = r.label;
    return el;
  }));
}

/** 폰 설정 되읽기. 합성 고정물처럼 **카메라가 아예 없는 주소**면 걸지 않는다 */
function watchSettings(feed) {
  let origin;
  try { origin = new URL(feed, location.href).origin; } catch { return; }
  if (!/^https?:$/.test(new URL(origin).protocol) || origin === location.origin) return;
  const read = async () => {
    try {
      // **마감시각을 건다** — 없는 IP 는 OS 타임아웃까지 매달리고, 그동안 화면은
      // "아직 안 물어봄"(조용함)에 머문다. 랜 안의 `status.json` 이 이보다 걸릴 이유가 없다
      const r = await fetch(`${origin}/status.json`,
        { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      cam.settings = (await r.json())?.curvals ?? null;
    } catch { cam.settings = null; }   // CORS 든 무응답이든 **모르는 것은 모르는 것**이다
    paintHud();
  };
  read();
  setInterval(read, 15000);
}

// 겹침 감시 주기 — `watch-calib.py` 가 1초마다 쓰고, 판정의 낡음 기준은 9초다.
// 3초 × 3 = 9초라 **한 번 걸러도 경고가 안 뜬다** (`state.js` §STALE_MS 와 같은 셈)
const DRIFT_MS = 3000;

/**
 * 겹침 오차를 받아 **나이와 함께** 넘긴다 (단계 A2 · `scripts/map/watch-calib.py` 산출).
 *
 * **나이가 값보다 중요하다** — 감시기가 죽으면 파일이 마지막 초록값으로 얼어붙고, 나이가
 * 없으면 화면이 영원히 "괜찮다" 고 말한다. 판정은 `state.js` 가 한다.
 *
 * ponytail: `t` 는 **쓴 쪽 시계**다. 랜 안 NTP 동기를 전제한다(계약 §카메라 `clock`).
 * 어긋나면 나이가 틀리는데, 음수는 0 으로 눌러 미래에서 온 값이 "방금"으로 보이게만 한다 —
 * 천장: 관문이 생기면 `clockSkewMs` 를 실어 보정한다.
 */
// ⭐ **자동 재정합을 화면이 받는다** (2026-08-19).
//
// 감시기에 `--auto` 가 켜지면서 **호스트가 카메라 이동을 스스로 다시 푼다** — 그날 두 번
// 실제로 걸렸다(16:33 · 16:48). 그런데 이 화면은 `global-cam.json` 을 **열 때 한 번만**
// 읽어서, 파일은 고쳐졌는데 **화면만 옛 자세로** 남았다. 파일 기준으로는 「자동이 됐다」인데
// 보는 사람 자리에서는 「자동이 안 된다」다 — 주인님이 그렇게 잡으셨고, 그 말이 맞았다.
//
// drift 파일이 `basis`(어느 기준샷으로 잰 값인가)를 이미 실어 준다. 내가 쓰는 것과 다르면
// 다시 읽어 카메라에 얹는다. **새 배관 0개** — 이미 3초마다 읽던 파일 하나를 더 볼 뿐이다.
// ⚠ `renderer.setAnimationLoop` 이 계속 돌므로 카메라만 갈면 다음 프레임에 반영된다.
let adopting = false;
async function adoptRecalib(basis) {
  // 조건은 **조작대 `CamView` 와 같은 술어**다 (D147) — 한쪽만 고쳐지면 화면 둘이 갈라진다
  if (!shouldAdoptCalib(basis, cam.calib?.labToCam?.shot) || adopting || !stage) return;
  const mine = cam.calib.labToCam.shot;
  adopting = true;
  try {
    const next = await loadReal();
    // **아직 안 바뀌었으면 안 쓴다** — drift 가 먼저 쓰이고 캘리브가 나중일 수 있다.
    // 반쪽을 얹느니 다음 틱에 다시 본다 (제1원칙: 모르는 것을 아는 척하지 않는다)
    if (next?.labToCam?.shot !== basis) return;
    cam.calib = next;
    applyCalibToCamera(stage.camera, next);
    console.info(`[cam] 정합이 바뀌어 다시 얹었다 — ${mine} → ${basis}`);
  } catch { /* 못 읽으면 다음 틱에 다시. 옛 값을 새 값인 척하지 않는다 */ }
  finally { adopting = false; }
}

function watchDrift() {
  const read = async () => {
    try {
      const r = await fetch('/config/global-cam-drift.json',
        { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      // **없는 것(404)과 못 읽은 것을 가른다** — `settings` 와 같은 규약이다.
      // 파일이 아예 없으면 **아무도 감시를 안 건 것**이라 `undefined`(조용함)다. 그 기계에서
      // 못 끄는 경고를 상주시키면 사람이 경고를 무시하는 법을 배운다.
      // **죽은 감시기는 이쪽으로 안 온다** — 파일이 남아 있고 나이만 늙으므로 판정이 잡는다
      if (r.status === 404) { cam.drift = undefined; paintHud(); return; }
      if (!r.ok) { cam.drift = null; paintHud(); return; }
      const d = await r.json();
      cam.drift = { ...d, ageMs: Math.max(0, Date.now() - d.t * 1000) };
      await adoptRecalib(d.basis);       // 자동 재정합이 있었으면 여기서 받아 얹는다
    } catch { cam.drift = null; }        // 있다는데 못 읽었으면 **모르는 것**이다 (제1원칙)
    paintHud();
    // 판정면도 같이 다시 칠한다 — 정합이 바뀌면 **선을 그릴지 말지가 바뀐다.**
    // 감시만 빨개지고 선은 그대로면 화면이 자기 말과 다른 그림을 보여준다
    afterDrift?.();
  };
  read();
  setInterval(read, DRIFT_MS);
}

// ── 캘리브레이션. **번들에 넣지 않고 런타임에 받는다** (2026-08-08 · 계약 §정적 서빙).
//
// 여태 `import.meta.glob({eager:true})` 로 읽었다. 빌드가 안 깨지는 건 맞았는데 — 이 파일은
// `map/*.py` 의 산출물이라 캘리브레이션 전에는 **정상적으로 없다** — 대신 **빌드한 순간의
// 숫자가 페이지 안에 굳었다.** 카메라를 다시 거치해 파일이 바뀌어도 화면은 몰랐고, 실제로
// 빌드본이 X 로 531mm 어긋난 채 그럴듯하게 겹치고 있었다. 캘리브레이션은 사람이 재빌드해야
// 반영되는 값이면 안 된다 — 그게 겹쳐보기에서 제일 조용한 거짓말이다.
//
// 없으면 404 이고 **그게 정상이다.** `null` 을 내면 아래가 고정물 값으로 내려간다.
async function loadJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }     // 없는 것도 못 읽은 것도 **모르는 것**이다 (제1원칙)
}
const loadReal = () => loadJson('/config/global-cam.json');

/** 배치안을 받아 스키마로 거른다. **아무 JSON 이나 받으면 화면이 그 자리에서 죽는다.** */
function acceptScene(raw) {
  const L = migrateLayout(raw);
  const errs = validateLayout(L);
  if (errs.length) throw new Error(errs[0]);
  return L;
}

const SCENE_KEY = 'fr5.cam.scene';
/** 마지막으로 본 배치안을 기억한다 — 폰에서 매번 파일을 고르는 것은 고통이다. */
function remember(L) {
  try { localStorage.setItem(SCENE_KEY, JSON.stringify(L)); } catch { /* 프라이빗 모드 */ }
}

/**
 * 태그 사각형에 맵을 맞추는 배율.
 *
 * **균일 스케일만 쓴다.** 가로·세로를 따로 맞추면 로봇이 찌그러지고, 그 화면으로
 * 도달 범위를 판단하면 틀린 판단을 한다. 그래서 둘 중 **작은 쪽**을 쓴다.
 */
function fitScale(L, fitMm) {
  if (!fitMm) return 1;
  const s = Math.min(fitMm[0] / L.floor.widthMm, fitMm[1] / L.floor.depthMm);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

const pairMm = (key) => {
  const m = /^(\d+)[x,](\d+)$/.exec(Q.get(key) ?? '');
  return m ? [Number(m[1]), Number(m[2])] : null;
};

const FIT = pairMm('fit');
const ANCHOR = pairMm('anchor') ?? [0, 0];
const ROT_DEG = Number(Q.get('rot') ?? 0) || 0;
const ALT_MM = Number(Q.get('alt') ?? 0) || 0;
const onlyRaw = Q.get('only');
// 실영상의 기본은 계획 컨베이어뿐이다. 고정물 검증은 예전처럼 전체 배치안을 보여 준다.
const ONLY = onlyRaw !== null
  ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : Q.has('feed') ? ['conveyor'] : null;
const ANCHORS_ON = Q.get('anchors') === '1';

let stage = null;
let view = null;
let latestRobotState = null;
let robotStateStale = true;
let ghostModel = null;
let ghostLastKey = '';

const ghostName = (kind) => ({ target: '이동 목표', preview: '미리보기', replay: '되감기',
  simulation: '시뮬레이션' })[kind] ?? kind;

function applyRobotGhost() {
  const chosen = robotStateStale ? null : selectVisualGhost(latestRobotState);
  const trust = calibTrust(cam.drift, cam.calib, cam.driftRow);
  const visible = Boolean(ghostModel && chosen && trust.key !== 'invalid');
  const key = visible ? `${chosen.source}|${chosen.seq}|${chosen.jointsDeg.join(',')}|${trust.key}` : 'off';
  if (ghostModel && key !== ghostLastKey) {
    ghostLastKey = key;
    if (visible) {
      const j = chosen.jointsDeg;
      setJointsDeg(ghostModel.robot, { j1: j[0], j2: j[1], j3: j[2], j4: j[3], j5: j[4], j6: j[5] });
      if (Number.isFinite(chosen.gripperPct)) {
        setGripperOpenPct(ghostModel.gripperGroup, chosen.gripperPct, ghostModel.fingerHalfStrokeMm);
      }
      const opacity = trust.key === 'ok' || trust.key === 'none' ? 0.5 : 0.5 * resolveTheme('video').dimA;
      ghostModel.robot.traverse((o) => {
        if (!o.isMesh || !o.userData.__ghosted) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.opacity = opacity;
      });
    }
    ghostModel.robot.visible = visible;
  }
  const text = robotStateStale ? '브리지 상태 끊김 — 고스트 숨김'
    : trust.key === 'invalid' ? `${trust.label} — 고스트 숨김`
      : chosen ? `파란 고스트 = ${ghostName(chosen.kind)}${chosen.seq == null ? '' : ` · #${chosen.seq}`}`
        : '공동 고스트 없음';
  $('ghost').textContent = text;
  $('ghost').classList.toggle('warn', robotStateStale || trust.key === 'invalid');
  if (globalThis.__cam) globalThis.__cam.ghost = { visible, state: chosen, stale: robotStateStale };
}

// ══ 판정면 겹치기 (2026-08-13 · `docs/goals/GOAL-cam-zone-overlay.md`) ═════════════
//
// **배치안 레이어(`view.root`)에 얹지 않는다.** 그쪽은 `?fit=` 수동 맞춤이라 축척도 원점도
// 사람이 눈으로 맞춘 값이다. 게이트가 막는 경계를 그 위에 그리면 **캘리브된 숫자를 안
// 캘리브된 변환으로** 그리는 셈이고, 화면이 실제 경계와 다른 자리에 선을 긋는다.
// 여기는 `stage.scene` 에 직접 — 1:1 이고 캘리브 카메라가 그대로 투영한다.
//
// 좌표 사슬 넷 중 앞의 둘은 `Shared` 가 이미 한다 (하드 룰 5):
//   게이트값(user1) ──`toBase`──▶ 로봇 베이스 ──여기──▶ 태그(=lab) ──`planToScene`──▶ 씬
// 세 번째 칸만 이 파일이 하고, 값은 `robot-base-in-tag.json` 하나에서만 온다.
let zones = null;      // 마지막 `update()` 요약 (검증이 읽는다)
let overlay = null;    // `createZoneOverlay()` 핸들
/** 정합 값이 바뀌면 판정면을 다시 칠한다. 판정면이 서기 전에는 `null` 이라 아무 일도 안 한다. */
let afterDrift = null;

/** 배치안 하나를 그린다. 다시 부르면 앞의 것을 버리고 새로 그린다. */
function draw(L) {
  if (view) { stage.scene.remove(view.root); view.dispose?.(); view = null; }
  // `?only=` — 가상인 것만 남긴다. 검사(acceptScene)는 **원본으로 이미 끝났다** — 여기는 표시만
  if (ONLY) {
    L = { ...L, props: (L.props ?? []).filter((p) => ONLY.includes(p.type)),
      arms: [], stations: [], amrs: [], doors: [], windows: [] };
  }
  view = createLayoutView(L);

  // ── 배율·원점. `root` 에만 걸어 `layout-view` 내부는 안 건드린다.
  const s = fitScale(L, FIT);
  view.root.scale.setScalar(s);
  const [ax, ay, az] = planToScene([ANCHOR[0], ANCHOR[1], ALT_MM]);
  view.root.position.set(ax, ay, az);
  // 회전은 **anchor(=root 원점)를 축으로** 건다 — 위치를 먼저 놓고 돌려도 축이 같아 안 밀린다
  view.root.rotation.y = THREE.MathUtils.degToRad(ROT_DEG);
  stage.scene.add(view.root);

  // ── AR 처리. **영상이 보여야 겹친 것이다** — 불투명하게 덮으면 그냥 3D 뷰다.
  //   · 바닥 슬래브는 숨긴다. 진짜 바닥이 영상에 이미 있다
  //   · 벽은 반투명. 높이감은 주되 뒤가 비친다
  //   · 컷어웨이는 **배율을 건 뒤 한 번** 부른다. 궤도가 없으니 매 프레임 돌릴 이유가 없다
  const slab = view.root.getObjectByName('slab');
  if (slab) slab.visible = false;
  view.updateCutaway(stage.camera);
  view.root.traverse((o) => {
    if (!o.isMesh || !o.userData.inward) return;      // inward 가 붙은 것 = 벽 조각
    // `?only=` 면 벽도 그리지 않는다 — 진짜 벽이 영상에 이미 있다
    if (ONLY) { o.visible = false; return; }
    o.material = o.material.clone();
    o.material.transparent = true;
    o.material.opacity = 0.28;
    o.material.depthWrite = false;
  });

  // **배율을 화면에 적는다.** 1:5 로 줄인 화면에서 도달 범위 링을 보고
  // "저 안이면 안전하다" 로 읽으면 안 된다 — 줄어든 것은 링도 마찬가지다.
  $('scale').textContent = s === 1 ? '1:1 실물 크기'
    : `1:${(1 / s).toFixed(1)} 축소 · 실물 크기 아님`;
  $('scale').classList.toggle('warn', s !== 1);
  $('sceneName').textContent = L.name ?? L.id ?? '이름 없음';
  return s;
}

/**
 * 판정면을 세운다 — **구현은 `Shared/view3d/zone-overlay.js` 하나다.**
 * 여기서 하는 일은 사유 문구와 범례를 화면에 놓는 것뿐이다 (배치는 화면마다 다르다).
 */
function drawZones({ ws, userDef, base, calib, trust }) {
  const r = overlay.update({ ws, userDef, base, calib, camera: stage.camera, trust });
  zones = r.ok ? r : null;
  const el = $('zones');
  if (!r.ok) {
    el.replaceChildren(`판정면 없음 — ${r.why}`);
    el.classList.add('warn');
    return zones;
  }
  // ── 범례. **없으면 거꾸로 읽힌다** — 사람은 진한 파랑을 「위험」으로 읽는데
  // 실제로 거부가 시작되는 선은 **주황**이다 (2026-08-13)
  const kids = [];
  zoneLegend('video', { stale: r.staleNames.length > 0 }).forEach((g) => {
    const sw = document.createElement('i');
    sw.className = 'swatch'; sw.style.background = g.hex;
    kids.push(sw, `${g.label}(${g.note}) `);
  });
  kids.push(`· 상판 ${r.boxes}·벽 ${r.walls}`);
  if (r.staleNames.length) kids.push(` · 가정값: ${r.staleNames.join('·')}`);
  if (trust.label) kids.push(` · ${trust.label}`);
  kids.push(` · 최대 ${r.errPx.toFixed(0)}px 어긋남`);
  el.replaceChildren(...kids);
  el.classList.toggle('warn', r.dim || r.errPx > 2);
  return zones;
}

try {
  // ── 1. 영상과 캘리브레이션은 **짝이다** (2026-08-07 수정)
  //
  // 여태 캘리브를 무조건 실측(`REAL`)으로 골랐다. 실측값이 생기기 전에는 둘이 늘 고정물이라
  // 맞았는데, D82·D83 으로 실측이 들어온 순간 **합성 사진 위에 실측 캘리브**가 씌워졌다 —
  // 겹침이 2176px 어긋났고 `cam-web-verify` 가 그걸 잡고 있었다(빨간 채로 있었다).
  // 사진이 고정물이면 캘리브도 고정물이어야 한다. 사진이 실물이면 실측이어야 한다.
  const feed = Q.get('feed') || `${FIX}/shot.png`;
  const fixture = !Q.get('feed');
  const REAL = fixture ? null : await loadReal();
  const calib = (!fixture && REAL) ? REAL : await (await fetch(`${FIX}/global-cam.json`)).json();
  // 실측이 아직 없는데 실영상을 보고 있으면 **고정물 값으로 겹치는 중**이라고 말해야 한다
  cam.calib = (!fixture && REAL) ? calib : { ...calib, verified: false };
  paintHud();

  // ── 2. 영상
  await new Promise((res, rej) => {
    const img = $('feed');
    img.onload = () => { cam.live = true; paintHud(); res(); };
    img.onerror = () => { cam.live = false; paintHud(); rej(new Error(`영상을 못 읽었습니다: ${feed}`)); };
    img.src = feed;
  });
  // **재보지도 않고 "살아 있다"고 말하지 않는다** — MJPEG 는 끊겨도 이벤트가 안 온다.
  // FR5 PiP 와 같은 감시를 건다 (`Shared/data/camera/watch.js`).
  //
  // **단 고정물에는 걸지 않는다.** 합성 고정물은 정지 사진이라 픽셀이 영영 안 바뀌고,
  // 감시는 그걸 "새 프레임이 안 온다"로 읽는다 — 12초 뒤 화면이 거짓 경고를 띄웠다
  // (2026-08-07 실렌더). 안 움직이는 게 정상인 것에 움직임을 재면 안 된다.
  // **고정물에는 겹침 감시도 안 건다** — 합성 사진에는 감시할 실물이 없다. 위 프레임 감시와
  // 같은 이유로, 아무도 못 고치는 경고를 상주시키면 사람이 경고를 무시하는 법을 배운다
  if (!fixture) {
    watchFrames($('feed'), ({ stale, lastChangeMsAgo }) => {
      cam.stale = stale; cam.lastChangeMsAgo = lastChangeMsAgo; paintHud();
    });
    watchDrift();
  }
  watchSettings(feed);

  stage = createStage($('host'), { alpha: true, controls: false, calib });
  overlay = createZoneOverlay(stage.scene);

  // ── 태그 직결 앵커 (?anchors=1 · D135) — lab 좌표 1:1 이라 planToScene 이 그대로 투영한다.
  // 배치안 사슬과 달리 **캘리브 말고는 아무 가정도 안 탄다** (yaw 177.1 재측정 대기와 무관).
  //
  // **되읽는다** (3초 · 받침 지그와 같은 생각) — `anchor-pose.py --watch` 가 파일을 계속
  // 갱신하므로, 종이를 밀면 화면이 따라온다. 값이 그대로면 다시 안 그린다.
  // 나이도 같이 보여준다 — 감시가 죽으면 파일이 얼어붙고, 그때 "N분 전" 이 그 사실을 말한다.
  if (ANCHORS_ON) {
    const anchorOv = createAnchorOverlay(stage.scene, { materialStyle: 'defense-reference-v1' });
    const read = async () => {
      const adoc = await loadJson('/config/scene-anchors.json');
      const r = anchorOv.update(adoc);
      const lastT = Math.max(0, ...Object.values(adoc?.anchors ?? {}).map((a) => a.t ?? 0));
      const age = lastT ? Math.max(0, Date.now() / 1000 - lastT) : null;
      const ago = age == null ? '' : age < 90 ? ` · ${age.toFixed(0)}초 전` : ` · ${(age / 60).toFixed(0)}분 전`;
      status(r.count ? `태그 앵커 ${r.count}개 — ${r.ids.join('·')}${ago}`
        : '태그 앵커 없음 — scripts/map/anchor-pose.py 를 먼저 돌린다', !r.count);
    };
    await read();
    setInterval(read, DRIFT_MS);
  }

  // ── 3. 배치안 — URL → 저장분 → 고정물 순. **없다고 빈 화면을 주지 않는다.**
  //
  // ⚠ **배치안이 없어도 페이지는 살아야 한다** (2026-08-13 실기에서 죽었다). 판정면 겹치기는
  // 배치안과 **아무 관계가 없다** — 하나는 게이트 값이고 하나는 계획 그림이다. 그런데 여기서
  // 던지면 아래 판정면·조작까지 통째로 안 선다. 실제로 그랬다: 배포본에는 고정물이 없어서
  // (`test/` 는 dist 에 안 담긴다) `${FIX}/layout.json` 이 **404** 였는데,
  // 브리지의 404 본문 `{"detail":"Not Found"}` 이 **JSON 으로 잘 파싱돼** 스키마 검사까지
  // 내려갔고 `unit 이 'mm-deg' 가 아니다` 로 죽었다. **`r.ok` 를 안 봐서 404 를 배치안으로 읽었다.**
  const getScene = async (url) => {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status}`);       // 404 본문을 배치안으로 읽지 않는다
    return acceptScene(await r.json());
  };
  let L = null;
  let sceneWhy = null;
  const from = Q.get('scene');
  try {
    if (from) L = await getScene(from);
    if (!L) {
      const saved = localStorage.getItem(SCENE_KEY);
      if (saved) L = acceptScene(JSON.parse(saved));
    }
    if (!L) L = await getScene(`${FIX}/layout.json`);
  } catch (e) {
    // **참고 그림이 없을 뿐이다.** 판정면은 이것과 무관하게 아래에서 선다
    sceneWhy = e?.message ?? String(e);
    L = null;
  }
  if (L) draw(L);
  else {
    $('sceneName').textContent = `배치안 없음 (${sceneWhy}) — 판정면만 겹칩니다`;
    $('scale').textContent = '';
  }
  if (from && L) remember(L);

  // ── 4. 판정면 (2026-08-13 · `GOAL-cam-zone-overlay`)
  //
  // **`/state` 는 같은 출처다** — 브리지가 `/ar` 을 서빙하므로(계약 §정적 서빙) 상대경로로
  // 닿는다. dev(Vite)에서는 안 닿고 그때는 `null` 이라 **안 그린다** — 그게 맞는 동작이다.
  // ⚠ **값을 화면에 베끼지 않는다.** 게이트가 쓰는 `/state.workspace` 를 그대로 넘긴다 —
  // 사본을 두면 화면과 게이트가 서로 다른 경계를 갖게 되고, 이 골의 목적이 사라진다.
  const [st, robotBase] = await Promise.all([
    loadJson('/state'),
    loadJson('/config/robot-base-in-tag.json'),
  ]);
  const zoneArgs = {
    ws: st?.workspace ?? null,
    userDef: st?.coordDefs?.user ?? null,
    base: robotBase,
    calib,
  };
  const paintZones = () => drawZones({ ...zoneArgs, trust: calibTrust(cam.drift, calib, cam.driftRow) });
  afterDrift = () => { paintZones(); applyRobotGhost(); };
  paintZones();

  // ── 공동 FR5 고스트. `/ws/state`만 **받고**, hello·claim·명령은 보내지 않는다.
  // 베이스와 보정이 모두 있어야 같은 lab 자리에 설 수 있다. 없으면 추측하지 않고 숨긴다.
  if (robotBase) {
    const { gripper } = loadConfig();
    loadRobot({ urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf', gripperCfg: gripper,
      gripperDir: '/PGEA_100_40/' }).then(({ robot, gripperGroup }) => {
      robot.visible = false;
      paintGhost(robot);
      setTimeout(() => paintGhost(robot), 400);
      setTimeout(() => paintGhost(robot), 1600);
      const holder = mountRobotYUp(null);
      holder.name = 'sharedCameraGhost';
      holder.position.set(...planToScene([robotBase.xMm, robotBase.yMm, robotBase.zMm]));
      const yaw = new THREE.Group();
      yaw.rotation.z = (robotBase.yawDeg * Math.PI) / 180;
      yaw.add(robot); holder.add(yaw); stage.scene.add(holder);
      ghostModel = { robot, gripperGroup, holder, fingerHalfStrokeMm: gripper.fingerHalfStrokeMm };
      ghostLastKey = '';
      applyRobotGhost();
    }).catch((e) => {
      $('ghost').textContent = `고스트 모델을 못 읽었습니다: ${e?.message ?? e}`;
      $('ghost').classList.add('warn');
    });
  } else {
    $('ghost').textContent = '로봇 베이스 미등재 — 고스트 숨김';
    $('ghost').classList.add('warn');
  }
  latestRobotState = st;
  robotStateStale = false;
  subscribeRobotState({
    onSnapshot: (snap) => { latestRobotState = snap; robotStateStale = false; applyRobotGhost(); },
    onStale: () => { robotStateStale = true; applyRobotGhost(); },
  });
  applyRobotGhost();

  // 거치 높이는 **판정이 아니라 사실**이라 `cameraState` 에 없다 — 여기서 적는다.
  // 해상도·합성 고정물 경고는 위 상태 띠가 맡는다. 같은 말을 두 곳에서 하지 않는다
  const E = calib.labToCam;
  status(`카메라 ${(E.heightMm / 1000).toFixed(2)}m`);

  // ── 조작
  $('toggle').onclick = () => {
    const off = $('host').classList.toggle('off');
    $('toggle').textContent = off ? '겹치기 켜기' : '겹치기 끄기';
  };
  $('file').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const next = acceptScene(JSON.parse(await f.text()));
      draw(next);
      remember(next);
    } catch (err) {
      status(`배치안을 못 읽었습니다: ${err?.message ?? err}`, true);
    }
  };

  // 헤드리스 검증용 노출 — 배율·원점이 정말 걸렸는지는 밖에서 숫자로 봐야 판정이 된다.
  // `toPixel` 은 **화면이 실제로 쓰는 카메라**로 실험실 좌표를 투영한다. 사진 속 태그를
  // 다시 검출해 이 값과 대조하면 "겹쳐 보인다" 가 픽셀 숫자가 된다
  // (`scripts/check/cam-web-verify.mjs`).
  globalThis.__cam = { stage, calib, fit: FIT, anchor: ANCHOR, draw,
    ghost: { visible: false, state: null, stale: robotStateStale },
    get view() { return view; },
    // 판정면이 **정말 그 자리에 섰는지**는 밖에서 숫자로 봐야 판정이 된다.
    // `zones` 가 `null` 이면 안 그린 것이고, 사유는 `#zones` 문구가 들고 있다
    get zones() { return zones; },
    // 게이트값을 **밖에서 밀어 넣는 구멍.** dev 에는 `/state` 가 없고 브리지가 없어도
    // 판정면 배치를 검증해야 한다 — `cam-web-verify` 가 이걸로 고정 입력을 준다
    setZones: (a) => { Object.assign(zoneArgs, a); paintZones(); return zones !== null; },
    toPixel: (labMm) => labToPixel(stage.camera, calib, labMm),
    // **고장 주입구.** 겹침 감시가 진짜 빨개지는지는 밖에서 값을 넣어 봐야 안다 —
    // 「검사가 있다」와 「검사가 잡는다」는 다르고, 이 프로젝트는 그 차이로 데였다.
    // A2 가 실제 값을 채우면 이 구멍은 그때도 그대로 쓸모가 있다(빨간불 회귀 검사)
    // ⚠ **`watchDrift` 와 같은 모양으로 만든다** — 주입구가 실제와 다르면 검사가 헛돈다.
    // 2026-08-13: `ageMs` 를 안 붙여서 「감시기 죽음」 검사가 「나이 미상」으로 새 나갔다
    setDrift: (d) => {
      cam.drift = d && typeof d.t === 'number'
        ? { ...d, ageMs: Math.max(0, Date.now() - d.t * 1000) } : d;
      paintHud(); afterDrift?.();
    } };
} catch (e) {
  status(`실패: ${e.message}`, true);
  throw e;
}
