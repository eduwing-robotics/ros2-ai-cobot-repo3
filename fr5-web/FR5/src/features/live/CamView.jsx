// 글로벌 카메라 PiP — 3D 쌍둥이 **위에** 실영상을 작게 겹쳐 띄운다.
//
// **탭 밖에 산다.** 패널 안에 두면 탭을 옮길 때마다 재마운트돼 MJPEG 연결이 끊겼다 다시
// 붙는다 — 3D 를 탭 밖에 둔 것과 같은 이유다 (`main.jsx` §레이아웃).
//
// **아직 정합해서 겹치는 게 아니다.** 이 화면은 3D 와 실영상을 나란히 보는 것이라 정합이
// 필요 없다 — 그래서 먼저 됐다. 겹치기(공간 HUD)는 그 위에 얹는 다음 단계다.
//
// 폰은 **가로로 장착**한다 (2026-08-07). 세로였을 때는 CSS 로 90° 돌려 보여줬는데,
// 돌아간 이미지에 오버레이를 얹으면 가운데만 맞고 모서리가 338~587px 어긋난다.
// 가로로 바꾸면서 그 회전을 없앴다 — 겹치기의 선행 조건이었다.
//
// **상태 판정을 여기서 짜지 않는다** (2026-08-07). 무엇이 경고인지는
// `Shared/data/camera/state.js` 한 곳이 정하고, 이 파일은 그게 낸 문장과 색을 **그리기만**
// 한다. AR 화면도 같은 함수를 부를 것이라, 판정을 화면에 두면 거기서 갈라진다.
import { Component, useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { createStage } from '@fr5/shared/view3d/lab/stage.js';
// 판정면 겹치기는 **AR 겹치기 화면과 같은 구현**을 쓴다 — 화면마다 짜면 두 화면이 서로
// 다른 경계를 그리기 시작한다 (하드 룰 5 · `zone-overlay.js` 머리말)
import { createAnchorOverlay } from '@fr5/shared/view3d/anchor-overlay.js';
// 고스트 팔 — 칠하기·Z-up 홀더·자리 사슬 전부 `Shared` 것. 판정면(`zone-overlay`)과 **같은 루트 구성**이라
// 판정면이 제자리면 고스트도 제자리다 (rnd/PIP-GHOST-CONVERGE-LOOP-2026-09-07)
import * as THREE from 'three';
import { loadConfig, loadRobot, mountRobotYUp, paintGhost, setJointsDeg } from '@fr5/shared/view3d/robot.js';
import { planToScene } from '@fr5/shared/data/units/units.js';
import { resolveTheme } from '@fr5/shared/view3d/zone-theme.js';
import { createZoneOverlay, calibTrust, zoneLegend } from '@fr5/shared/view3d/zone-overlay.js';
import { cameraState, shouldAdoptCalib } from '@fr5/shared/data/camera/state.js';
import { watchFrames } from '@fr5/shared/data/camera/watch.js';
import { CAMERA_PIP_DEFAULT, usePipSize } from './usePipSize.js';

// 캘리브레이션은 **번들에 넣지 않고 런타임에 받는다** (2026-08-08 · 계약 §정적 서빙).
// `import.meta.glob({eager:true})` 로 읽던 동안 이 값은 **빌드한 순간에 굳었고**, 카메라를
// 다시 거치해 파일이 바뀌어도 화면은 몰랐다 — 빌드본이 X 로 531mm 어긋난 채 겹치고 있었다.
// 출처를 아는 것은 `datasource` 다 (`FR5/AGENTS.md`). 못 받으면 `null` 이고, 그걸
// "보정 없음"으로 읽는 것은 `state.js` 다 — 캘리브 전에는 **정상적으로 없다.**
// 폰 설정은 조용히 되돌아간다(D64) — 자주 볼 필요는 없고, 안 보면 모른다
const STATUS_MS = 15000;
// 겹침 감시는 자주 본다 — `watch-calib.py` 가 1초마다 쓰고 판정의 낡음 기준이 9초다.
// 3초 × 3 = 9초라 **한 번 걸러도 거짓 경고가 안 뜬다** (`state.js` §STALE_MS 와 같은 셈)
const DRIFT_MS = 3000;
// **마감시각을 건다.** 없는 IP 로 `fetch` 하면 OS 타임아웃(수십 초)까지 매달리는데,
// 그동안 상태는 "아직 안 물어봄"(조용함)에 머문다 — `FIRST_FRAME_MS` 와 똑같은 함정이다.
// 랜 안의 `status.json` 이 이보다 오래 걸릴 이유가 없다 (2026-08-07 실렌더에서 밟았다)
const STATUS_TIMEOUT_MS = 4000;

const OPEN_KEY = 'fr5.camOpen';
// **키를 갈았다** (2026-08-07 세로→가로). 안 갈면 사람들 브라우저에 저장된 9:16 크기가
// 그대로 살아나 가로 영상이 위아래로 크게 남는 칸에 뜬다 — 코드는 고쳤는데 화면은 안 바뀐다
const SIZE_KEY = 'fr5.camSize.landscape';
// **`onError` 를 기다리기만 하면 안 된다** (2026-08-06 실렌더). 없는 IP 를 주면 TCP 연결이
// OS 타임아웃(수십 초)까지 매달려서 그동안 화면은 "여는 중…" 인 채로 멈춘다 — 오래된 주소가
// 남아 있으면 사람이 그걸 "곧 뜨겠지" 로 읽는다. 못 왔으면 못 왔다고 말한다 (제1원칙).
const FIRST_FRAME_MS = 8000;
// 끊김 감시는 `Shared/data/camera/watch.js` 가 한다 (2026-08-07 이관) — AR 도 같은 것을 쓴다.
// 못 붙었을 때도 사람이 누를 때까지 기다리지 않는다 — 벽에 걸린 화면 앞에 사람이 없다.
// 다만 **간격을 벌려서** 죽은 주소에 계속 매달리지 않는다 (능동 폴링 금지의 취지).
const RETRY_MS = [3000, 6000, 12000, 20000, 30000];
// 가로 16:9 — 높이는 영상(width×9/16)에 머리띠 26px 을 더한 값이다.
// **기본값은 게이트 상한(3D 의 10%)에 걸린다** — 360x229 는 12.4% 로 떨어졌다 (2026-08-07).
// 300x195 는 8.8% 다. 더 크게 보고 싶으면 사람이 끌어서 키운다 (그 크기는 기억된다).
// 공통 시작 크기는 `usePipSize.js` 가 소유한다. 300x195 는 3D 의 8.8% 다
// (게이트 상한 10% · 2026-08-07 실측 twin 1060x628).
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } };
const writeOpen = (v) => { try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* 프라이빗 모드 */ } };

function GlobalCameraPipInner({ workspace = null, coordDefs = null, ghost = null }) {
  const [open, setOpen] = useState(readOpen);
  const [live, setLive] = useState(null);   // null=첫 프레임 대기 · true=옴 · false=못 옴
  const [tries, setTries] = useState(0);    // 이 값이 바뀌면 `<img>` 가 갈려 끼워진다
  const [stale, setStale] = useState(false);  // 붙어는 있는데 새 프레임이 안 온다
  // `undefined`=아직/안 물어봄 · `null`=물어봤는데 못 읽음(경고) · 객체=읽음. 그 셋을 가른다
  const [status, setStatus] = useState(undefined);
  const [ageMs, setAgeMs] = useState(null);    // 마지막 픽셀 변화 뒤 지난 시간. null=아직 모름
  // `null`=아직 못 받음/없음. **초기값을 낙관값으로 두지 않는다** — 판정은 `state.js` 가 한다
  const [calib, setCalib] = useState(null);
  // 겹침 폴링이 **지금 얹은 캘리브**를 봐야 하는데, effect 를 `calib` 에 걸면 갈아탈 때마다
  // 타이머가 새로 걸린다. ref 로 최신본만 넘긴다 (D147)
  const calibRef = useRef(null);
  // 크기·핸들은 공용 훅이 든다 (`usePipSize.js`) — 뎁스 PiP 와 같은 것을 쓴다.
  // 인라인 style 이 미디어쿼리를 이기는 함정도 거기서 막는다.
  //
  // ⛔ **비율을 강제한다** (D148) — 겹치는 칸이라 영상(`contain`)과 3D 캔버스가 **같은 상자**를
  // 써야 한다. 비율은 **카메라가 정한다** — 16:9 를 박으면 폰이 4:3 으로 돌아가는 날
  // (D64 가 실제로 겪었다) 겹침이 조용히 깨진다. 캘리브가 아직 없으면 CSS 기본값(16:9)이다.
  const camAspect = calib?.intrinsics?.widthPx && calib?.intrinsics?.heightPx
    ? calib.intrinsics.widthPx / calib.intrinsics.heightPx : null;
  const pip = usePipSize({ key: SIZE_KEY, defaultSize: CAMERA_PIP_DEFAULT, aspect: camAspect });
  // 주소는 **나중에 정해질 수 있다** — 아무도 `?cam=` 을 안 줬으면 브리지에게 물어보고
  // 그 답이 늦게 온다 (`datasource` §글로벌 카메라 주소). 첫 렌더의 `null` 에 갇히면
  // 카메라 칸이 영영 안 뜬다 — 그게 2026-08-10 에 화면이 카메라를 통째로 놓친 자리다
  const [host, setHost] = useState(datasource.cameraHost());
  // `undefined`=감시를 안 걸었다(주소가 없다) · `null`=걸었는데 못 읽었다 · 객체=읽었다
  const [drift, setDrift] = useState(undefined);
  const imgRef = useRef(null);

  // 첫 프레임 기다리기 — 한 번만 재고 끝낸다. 반복 확인이 아니라 마감시각이다
  useEffect(() => {
    const t = setTimeout(() => setLive((v) => (v === null ? false : v)), FIRST_FRAME_MS);
    return () => clearTimeout(t);
  }, [tries]);

  // ── 감시. **`tries` 가 바뀌면 새로 건다** — `<img>` 가 갈려 끼워졌으니 옛 표본은 버린다
  useEffect(() => {
    if (!open || live !== true) return undefined;
    return watchFrames(imgRef.current, ({ stale: s, lastChangeMsAgo }) => {
      setStale(s);
      setAgeMs(lastChangeMsAgo);
    });
  }, [open, live, tries]);

  // ── 복구: 못 붙었거나(live=false) 얼어붙었으면(stale) 스스로 다시 끼운다.
  // 간격을 점점 벌려 죽은 주소에 매달리지 않는다
  useEffect(() => {
    if (!open || (live !== false && !stale)) return undefined;
    const t = setTimeout(() => {
      // `stale` 은 여기서 안 푼다 — 감시가 새 프레임을 실제로 본 뒤에 푼다.
      // `tries` 가 오르면 감시도 새로 걸리므로 옛 표본은 저절로 버려진다
      setLive(null);
      setTries((n) => n + 1);
    }, RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]);
    return () => clearTimeout(t);
  }, [open, live, stale, tries]);

  // ── 폰 설정 되읽기. **영상이 멀쩡해도 보정이 무효일 수 있다** — 2026-08-06(D64) 에
  // 앱이 혼자 1920×1080·q49·auto 로 돌아가 있었고 화면은 아무 말도 안 했다.
  // 못 읽으면 `null` 을 그대로 넘긴다. 판정 함수가 그걸 "정상"이 아니라 "확인 못 함"으로 읽는다
  useEffect(() => datasource.onCamHost(setHost), []);
  useEffect(() => {
    // **접어도 계속 묻는다.** 접었다고 카메라가 카메라가 아닌 게 아니고, 접힌 채 벽에 걸린
    // 화면이 조용한 게 제일 나쁘다 — 접으면 경고가 사라지는 걸 실렌더에서 밟았다 (2026-08-07)
    if (!host) { setStatus(undefined); return undefined; }
    let dead = false;
    const read = async () => {
      try {
        const r = await fetch(`http://${host}/status.json`,
          { cache: 'no-store', signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        const j = await r.json();
        if (!dead) setStatus(j?.curvals ?? null);
      } catch {
        if (!dead) setStatus(null);   // CORS 든 무응답이든 **모르는 것은 모르는 것**이다
      }
    };
    read();
    const id = setInterval(read, STATUS_MS);
    return () => { dead = true; clearInterval(id); };
  }, [host, tries]);

  // ── 보정값. **`tries` 가 오르면 다시 받는다** — 사람이 「다시 시도」를 누르는 순간이
  // 곧 "뭔가 바뀌었을 것" 이라 보는 순간이라, 따로 타이머를 두지 않고 그 버튼에 얹는다.
  // `extrinsics.py` 를 돌린 뒤 새로고침이나 이 버튼 한 번이면 새 값이 온다
  useEffect(() => {
    let dead = false;
    datasource.getCamCalib().then((c) => { if (!dead) { calibRef.current = c; setCalib(c); } });
    return () => { dead = true; };
  }, [tries]);

  // ── 판정면 겹치기 (2026-08-13 · `zone-overlay.js`).
  //
  // **AR 겹치기 화면과 같은 구현이다.** 여기서 하는 일은 무대를 세우고 값을 넘기는 것뿐 —
  // 좌표 사슬도 정합 판정도 `Shared` 가 한다. 화면마다 짜면 두 화면이 서로 다른 경계를
  // 그리기 시작하고, 안전 표시에서 그게 제일 나쁘다.
  const hostRef = useRef(null);
  const stageRef = useRef(null);
  const overlayRef = useRef(null);
  const anchorsRef = useRef(null);
  const [zoneInfo, setZoneInfo] = useState(null);

  // 무대는 **보정값이 와야** 선다 — 캘리브 없이 세우면 화각이 임의라 겹침이 거짓이 된다
  useEffect(() => {
    if (!open || !calib?.labToCam || !hostRef.current) return undefined;
    const st = createStage(hostRef.current, { alpha: true, controls: false, calib });
    // ⛔ **상시 렌더를 끈다.** `createStage` 는 `setAnimationLoop` 로 60fps 를 돌리는데,
    // 이 무대는 **정적이다** — 고정 캘리브 카메라 · 궤도 없음 · 값이 바뀔 때만 형상이 변한다.
    // 조작대는 실영상 MJPEG 과 상태 스트림이 이미 도는 화면이라 그 위에 60fps 를 얹으면
    // 순수한 낭비다. 2026-08-13 실측: 얹은 채로 `fr5-render` 의 궤적 왕복이 **표본 4개를
    // 놓쳤다**(`dropped=4` · 그 전 회차는 통과). **요청할 때만 그린다.**
    st.renderer.setAnimationLoop(null);
    stageRef.current = st;
    overlayRef.current = createZoneOverlay(st.scene);
    anchorsRef.current = createAnchorOverlay(st.scene, { materialStyle: 'defense-reference-v1' });
    // ⚠ **끈 루프의 대가** — PiP 는 사람이 끌어서 크기를 바꾼다. `stage` 의 ResizeObserver 가
    // 캔버스 크기는 고치지만 **다시 그려 줄 사람이 없어** 낡은 그림이 늘어난 채 남는다.
    // 그래서 크기가 바뀌면 한 장 그린다 (2026-08-13)
    const ro = new ResizeObserver(() => st.renderer.render(st.scene, st.camera));
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      overlayRef.current?.dispose();
      anchorsRef.current?.dispose();
      overlayRef.current = null; anchorsRef.current = null; stageRef.current = null;
      st.dispose?.();
      if (hostRef.current) hostRef.current.replaceChildren();
    };
  }, [open, calib]);

  // ── 태그 앵커 (가상 컨베이어 · D135) — 판정면과 같은 3초 폴링으로 종이를 따라간다.
  // 그리기는 `anchor-overlay.js` 한 곳이 한다 (AR 겹침 화면과 같은 구현 · 위 §머리말 그대로)
  useEffect(() => {
    if (!host) return undefined;
    let dead = false;
    const read = async () => {
      const adoc = await datasource.getSceneAnchors?.();
      if (dead || !anchorsRef.current || !stageRef.current) return;
      // 값이 그대로면 안 그린다 — 정적 무대라 바뀐 순간에만 한 장 찍는다
      if (anchorsRef.current.update(adoc ?? null).changed) {
        const { renderer, scene, camera } = stageRef.current;
        renderer.render(scene, camera);
      }
    };
    read();
    const id = setInterval(read, DRIFT_MS);
    return () => { dead = true; clearInterval(id); };
  }, [host, open, calib, tries]);

  // 로봇 베이스는 사람이 손으로 쓰는 값이라 자주 안 변한다 — `tries` 에만 얹는다
  const [baseInTag, setBaseInTag] = useState(null);
  useEffect(() => {
    let dead = false;
    datasource.getRobotBaseInTag?.().then((b) => { if (!dead) setBaseInTag(b ?? null); });
    return () => { dead = true; };
  }, [tries]);

  // ── 고스트 팔 (D195·D196 · `rnd/PIP-GHOST-CONVERGE-LOOP-2026-09-07.md`).
  //
  // 영상이 곧 **불투명 실기**다. 그 위에 `ghost.jointsDeg`(주인은 `main.jsx` 가 정한다 — 보낸 목표 > 되감기 >
  // 시뮬 > 미리보기)를 **파랑 반투명**으로 세운다. 자리는 판정면과 같은 사슬(`planToScene(base)` + yaw 홀더).
  // **지연 로드**(D4) — 무대(=calib)와 베이스가 있고 PiP 가 펴진 뒤에만 6MB 를 받는다(두 번째부터는 캐시).
  // 무대는 정적이라(위 §끈 루프) 관절이 **바뀔 때만** 한 장 그리고, 계획 재생은 ≤10fps 로 묶는다(D3 · 08-13 표본 유실).
  const ghostRef = useRef(null);          // { robot, timers }
  const ghostLastKey = useRef('');
  const ghostDrawAt = useRef(0);
  const ghostDrawTimer = useRef(0);
  const [ghostNote, setGhostNote] = useState(null);   // 'target' | 'plan' | null — 머리띠 안내
  useEffect(() => {
    const st = stageRef.current;
    if (!open || !st || !baseInTag) return undefined;
    let dead = false;
    const timers = [];
    const { gripper } = loadConfig();
    loadRobot({ urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf', gripperCfg: gripper, gripperDir: '/PGEA_100_40/' })
      .then(({ robot }) => {
        if (dead) return;
        robot.visible = false;
        paintGhost(robot);
        timers.push(setTimeout(() => paintGhost(robot), 400), setTimeout(() => paintGhost(robot), 1600));
        const holder = mountRobotYUp(null);   // Z-up(로봇·m) → Y-up(씬) — `zone-overlay` 와 같은 구성
        holder.name = 'camGhost';
        holder.position.set(...planToScene([baseInTag.xMm, baseInTag.yMm, baseInTag.zMm]));
        const yaw = new THREE.Group();
        yaw.rotation.z = (baseInTag.yawDeg * Math.PI) / 180;
        yaw.add(robot);
        holder.add(yaw);
        st.scene.add(holder);
        ghostRef.current = { robot, holder };
        ghostLastKey.current = '';            // 새 팔이니 다음 틱에 반드시 한 번 얹는다
        window.__camGhost = { kind: null, visible: false, jointsDeg: null, angles: () => Object.values(robot.joints ?? {}).map((j) => j.angle) };
      })
      .catch((e) => { window.__camGhost = { kind: null, visible: false, error: String(e?.message ?? e) }; });
    return () => {
      dead = true;
      timers.forEach(clearTimeout);
      clearTimeout(ghostDrawTimer.current);
      const g = ghostRef.current;
      if (g) { st.scene.remove(g.holder); ghostRef.current = null; }
      ghostLastKey.current = '';
    };
  }, [open, calib, baseInTag]);

  // 관절·주인·정합 신뢰가 바뀔 때만 얹고 그린다. 정합을 못 믿으면 판정면과 **같이** 흐려지고(D6), 무효면 숨는다
  useEffect(() => {
    const g = ghostRef.current; const st = stageRef.current;
    if (!g || !st) { if (ghostNote !== null) setGhostNote(null); return; }
    const trust = zoneInfo?.trust ?? 'none';
    const kind = ghost?.jointsDeg && trust !== 'invalid' ? ghost.kind : null;
    const key = kind ? `${kind}|${zoneInfo?.dim ? 'dim' : 'ok'}|${ghost.jointsDeg.map((v) => Math.round(v * 100)).join(',')}` : 'off';
    if (key === ghostLastKey.current) return;
    ghostLastKey.current = key;
    if (kind) {
      const j = ghost.jointsDeg;
      setJointsDeg(g.robot, { j1: j[0], j2: j[1], j3: j[2], j4: j[3], j5: j[4], j6: j[5] });
      const a = zoneInfo?.dim ? 0.5 * resolveTheme('video').dimA : 0.5;
      g.robot.traverse((o) => { if (o.isMesh && o.userData.__ghosted) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.opacity = a; }); });
    }
    g.robot.visible = kind !== null;
    Object.assign(window.__camGhost ?? {}, { kind, visible: kind !== null, jointsDeg: kind ? [...ghost.jointsDeg] : null });
    if (ghostNote !== kind) setGhostNote(kind);
    const draw = () => { ghostDrawAt.current = performance.now(); st.renderer.render(st.scene, st.camera); };
    const wait = kind === 'plan' ? 100 - (performance.now() - ghostDrawAt.current) : 0;   // 계획 재생만 ≤10fps
    clearTimeout(ghostDrawTimer.current);
    if (wait > 0) ghostDrawTimer.current = setTimeout(draw, wait); else draw();
  }, [ghost, zoneInfo, ghostNote]);

  // ── 겹침 감시. **접어도 계속 읽는다** — 설정 되읽기와 같은 이유로, 접힌 채 벽에 걸린
  // 화면이 조용한 게 제일 나쁘다. 주기 3초 × 3 = 판정의 낡음 기준 9초라 한 번 걸러도 안 뜬다
  useEffect(() => {
    if (!host) { setDrift(undefined); return undefined; }
    let dead = false;
    const read = async () => {
      const d = await datasource.getCamDrift();
      if (dead) return;
      setDrift(d);
      // ── 자동 재정합을 **받아 얹는다** (2026-08-27 · D147).
      //
      // 이 화면은 캘리브를 **열 때 한 번만** 읽었다. 그런데 호스트 감시기가 `--auto` 로
      // 카메라 이동을 스스로 다시 푼다 — 08-27 에 89mm 를 잡아 고쳤는데 **파일만 새것이고
      // 이 화면은 6시간 전 자세로** 그렸다. 주인님이 「맥에서는 맞는데 윈도우에서는 안 맞는다」
      // 로 잡으셨고, 차이는 **탭을 언제 열었나** 하나였다.
      //
      // **새 배관 0개** — 이미 3초마다 읽던 drift 파일의 `basis` 를 한 번 더 볼 뿐이다.
      // 조건은 `AR/src/screens/cam.js` 와 **같은 술어**를 쓴다(`shouldAdoptCalib`) — 한쪽만 고쳐지는 것을 막는다.
      if (!shouldAdoptCalib(d?.basis, calibRef.current?.labToCam?.shot)) return;
      const next = await datasource.getCamCalib();
      // **아직 안 바뀌었으면 안 쓴다** — drift 가 먼저 쓰이고 캘리브가 나중일 수 있다.
      // 반쪽을 얹느니 다음 틱에 다시 본다 (제1원칙: 모르는 것을 아는 척하지 않는다)
      if (dead || next?.labToCam?.shot !== d.basis) return;
      calibRef.current = next;
      setCalib(next);
    };
    read();
    const id = setInterval(read, DRIFT_MS);
    return () => { dead = true; clearInterval(id); };
  }, [host, tries]);

  // 값이 바뀌면 다시 칠한다. **정합이 바뀌면 선을 그릴지 말지가 바뀐다** — 감시만
  // 빨개지고 선은 그대로면 화면이 자기 말과 다른 그림을 보여준다 (2026-08-13)
  useEffect(() => {
    const ov = overlayRef.current;
    if (!ov || !stageRef.current) { setZoneInfo(null); return; }
    // 겹침 판정은 `state.js` 것을 물려받는다 — 나이(감시기 죽음)까지 거기가 본다
    const dRow = cameraState({ calib, status, observed: { live, stale, drift } })
      .find((r) => r.key === 'drift') ?? null;
    setZoneInfo(ov.update({
      ws: workspace, userDef: coordDefs?.user ?? null, base: baseInTag,
      calib, camera: stageRef.current.camera, trust: calibTrust(drift, calib, dRow),
    }));
    // 정적 무대라 **바뀐 순간에만** 한 장 그린다 (위 §상시 렌더를 끈다)
    const { renderer, scene, camera } = stageRef.current;
    renderer.render(scene, camera);
  }, [workspace, coordDefs, baseInTag, calib, drift, status, live, stale, open]);

  const src = datasource.cameraFeedUrl();
  // 주소를 아무도 안 준 상태는 "기능을 안 켠 것"이다 — 빈 상자를 띄우지 않는다.
  // 반대로 주소가 있는데 영상이 안 오는 것은 **반드시 보여준다** (아래 data-live="false").
  if (!src) return null;

  const toggle = () => { const v = !open; setOpen(v); writeOpen(v); };
  const retry = () => { setStale(false); setLive(null); setTries((n) => n + 1); };

  // 판정은 전부 `Shared/data/camera/state.js` 가 한다 (위 §머리말). 여기서 하는 일은
  // 어느 줄을 머리띠에 놓고 어느 줄을 아래 띠에 놓느냐 — **배치**뿐이다
  const rows = cameraState({
    calib,
    status,
    observed: {
      live,
      stale,
      streamW: imgRef.current?.naturalWidth || null,
      streamH: imgRef.current?.naturalHeight || null,
      lastChangeMsAgo: ageMs,
      drift,
    },
  });
  const link = rows.find((r) => r.key === 'link') ?? { label: '상태 모름' };
  const hud = rows.filter((r) => r.key !== 'link');
  // **접었을 때도 경고는 보여야 한다.** 아래 띠는 펴야 보이는데, 접힌 채 벽에 걸린 화면이
  // 조용한 것이 제일 나쁘다 — 머리띠 색으로 올린다
  const warn = rows.some((r) => r.tone === 'warn');

  return (
    <div className="camview global-camera-pip" data-t="camview" data-camera="global"
      data-open={String(open)} data-live={String(live)}
      data-stale={String(stale)} data-warn={String(warn)}
      style={pip.style(open)}>
      <div className="camhead">
        {/* 실물과 3D 를 헷갈리는 것이 이 프로젝트에서 가장 비싼 오해다 (SR_24) —
            라벨을 옵션으로 두지 않는다 */}
        <b>글로벌 카메라</b>
        {/* **멈춘 것을 "정상"으로 보이게 두지 않는다** — 옛 프레임이 그대로 걸려 있는 게
            안전 표시에서 제일 나쁜 모양이다 (SAFETY-RULES 제1원칙) */}
        {/* **실패할 때도 주소를 보여준다.** "영상 없음" 만 띄우면 사람이 고칠 수가 없다 —
            저장된 주소가 옛 IP 인 게 가장 흔한 원인인데 그걸 화면에서 확인할 길이 없었다
            (2026-08-07 실기: 우분투에서 안 뜨는 원인을 화면만 보고 못 좁혔다) */}
        <span className="camstat" data-t="cam-stat">{`${link.label} · ${host}`}</span>
        {/* 고스트가 켜질 때만 — 「파란 팔 = 실물 아님」을 화면이 말한다 (SR_24 · D195). 30px 팔이라도 이 글자가 뜻을 붙든다 */}
        {open && ghostNote && (
          <span className="camghost" data-t="cam-ghost" data-kind={ghostNote}>
            {ghostNote === 'target' ? '고스트 = 이동 목표' : ghostNote === 'live-check' ? '고스트 = 지금 자세 (정합 확인)' : '고스트 = 계획'}
          </span>
        )}
        <button type="button" className="camtoggle" data-t="cam-toggle"
          title={open ? '접기' : '펴기'} onClick={toggle}>{open ? '▾' : '▸'}</button>
      </div>
      {/* 상태 띠 — 영상 위에 겹치지 않고 위쪽에 자리를 차지한다. 영상 위에 얹으면
          어두운 장면에서 글자가 사라지고, 그때가 하필 카메라를 의심할 때다 */}
      {open && (
        <div className="camhud" data-t="cam-hud">
          {hud.map((r) => (
            <span key={r.key} data-t={`cam-hud-${r.key}`} data-tone={r.tone}>{r.label}</span>
          ))}
        </div>
      )}
      {/* 색 범례 — **없으면 거꾸로 읽힌다.** 사람은 진한 파랑을 「위험」으로 읽는데
          거부가 시작되는 선은 **주황**이다 (2026-08-13) */}
      {open && zoneInfo && (
        <div className="camzonebar" data-t="cam-zonebar"
          data-tone={zoneInfo.ok ? (zoneInfo.dim ? 'warn' : 'ok') : 'warn'}>
          {zoneInfo.ok ? (
            <>
              {zoneLegend('video', { stale: (zoneInfo.staleNames?.length ?? 0) > 0 }).map((g) => (
                <span key={g.key} data-t={`cam-legend-${g.key}`}>
                  <i className="swatch" style={{ background: g.hex }} />
                  {`${g.label}(${g.note})`}
                </span>
              ))}
              <span data-t="cam-zone-count">{`상판 ${zoneInfo.boxes}·벽 ${zoneInfo.walls} · 최대 ${zoneInfo.errPx.toFixed(0)}px 어긋남`
                + (zoneInfo.staleNames?.length ? ` · 가정값: ${zoneInfo.staleNames.join('·')}` : '')}</span>
            </>
          ) : (
            <span data-t="cam-zone-why">{`판정면 없음 — ${zoneInfo.why}`}</span>
          )}
        </div>
      )}
      {open && (
        <div className="cambody">
          {/* MJPEG 는 연결을 계속 붙들고 있다 — key 로 갈아 끼워야 다시 붙는다.
              `crossOrigin` 은 **감시용**이다 — 이게 없으면 캔버스가 오염돼 프레임이
              멎었는지 못 잰다. IP Webcam 은 `Access-Control-Allow-Origin: *` 를 준다
              (2026-08-06 실측). 안 주는 카메라면 감시만 접고 영상은 계속 나온다 */}
          <img key={tries} ref={imgRef} data-t="cam-img" alt="글로벌 카메라"
            crossOrigin="anonymous"
            src={tries ? `${src}?_=${tries}` : src}
            onLoad={() => setLive(true)} onError={() => setLive(false)} />
          {/* 판정면 무대 — 영상 **위**에 겹친다. `pointer-events: none` 이라 「다시 시도」
              버튼을 안 가린다. 보정값이 없으면 무대 자체가 안 서서 빈 div 만 남는다 */}
          <div className="camzones" data-t="cam-zones-host" ref={hostRef} />
          {live === false && (
            <button type="button" className="camretry" data-t="cam-retry" onClick={retry}>
              다시 시도
            </button>
          )}
        </div>
      )}
      {/* 접었을 때는 핸들을 안 낸다 — 크기가 `auto` 라 드래그해도 화면은 그대로인데 값만
          저장돼, 다시 펴면 엉뚱한 크기가 나왔다 (감사 2026-08-06 P2). 폰에서도 안 낸다:
          너비를 CSS 가 정하므로 끌어도 안 먹는다 */}
      {pip.canResize(open) && (
        <div className="camresize" data-t="cam-resize"
          onMouseDown={pip.startResize} onTouchStart={pip.startResize}
          title="드래그해서 크기 조절" />
      )}
    </div>
  );
}

// 카메라 위젯이 렌더 중 터져도 **여기서 멈춘다.** 이 앱엔 에러 경계가 없어서(감사 #6),
// CamView 는 SafetyBar·STOP 과 같은 뿌리의 형제라 여기서 터지면 화면 전체가 언마운트돼
// STOP 버튼까지 사라졌다. 경계가 크래시를 이 위젯 안에 가둬 STOP 은 남는다.
// 조용히 비우지 않고 자리를 남겨 말한다 (제1원칙) — 무슨 일인지 사람이 알아야 고친다.
class GlobalCameraPipErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    try { console.error('카메라 화면을 못 그렸어요 · 화면은 그대로예요', err); } catch { /* noop */ }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="camview global-camera-pip" data-t="camview" data-camera="global"
          data-open="false" data-warn="true">
          <div className="camhead">
            <b>글로벌 카메라</b>
            <span className="camstat" data-t="cam-stat">글로벌 카메라 화면 오류 — 새로고침</span>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function GlobalCameraPip(props) {
  return (
    <GlobalCameraPipErrorBoundary>
      <GlobalCameraPipInner {...props} />
    </GlobalCameraPipErrorBoundary>
  );
}
