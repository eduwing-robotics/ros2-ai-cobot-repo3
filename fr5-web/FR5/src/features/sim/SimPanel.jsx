// 「시뮬」 탭 — **팔이 거치대를 집어 터틀봇 바구니에 넣는 동작을 화면에서만 돌린다.**
//
// ⛔ **실기는 안 움직인다.** 관절각은 브리지 `POST /ik` 가 컨트롤러에 **묻기만** 해서 받은
// 값이고, 같은 요청이 실제 이동과 **같은 함수**를 `dry_run` 으로 태워 게이트 판정까지
// 돌려준다. 그래서 이건 그림이 아니라 **실기 기구학·실기 게이트로 푼 시뮬레이션**이다.
//
// **탭이 답하는 질문 하나** (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 5) — 「거치대가 *여기* 있으면 팔이 할 수 있나 · 얼마나 걸리나」.
// 그래서 절은 **하나**다 — 입력 한 줄 · 풀기 · 세 층 답 · 사이클(구간 목록이 곧 10칸+관측+내리기). 「따라간다」 절은 3D 좌상단 스위치 하나로 돌아갔고
// (같은 상태가 두 곳에 있던 것), 관측 자세 후보는 사이클의 관측 칸에 흡수됐고(phase 3), 실측 되감기는 시뮬이 아니라
// **터틀봇 탭**으로 갔다(`TbPanel` §되감기). 어느 것도 지운 게 아니라 제자리로 보낸 것이다.
//
// ## 좌표가 어디서 오나 (지어낸 숫자 0)
//
//   10칸(9자세+사전성형)의 좌표는 전부 `Shared/data/sim/load-steps.js` 가 실측 SSOT 에서 만든다 (2026-09-06 · 정본 하나) —
//   집는 자리 `props.CARRIER_GRASP_TRUTH`(높이는 그려진 상판 기준) · 넣는 자리 정차 자리 + `props.AMR_BASKET` · 띄우는 높이 라이다 위 20
//
// ⚠ **바구니 자리는 「터틀봇이 홈에 섰을 때」의 가정이다.** 실제 정지 위치는 터틀봇이
// 켜져 있어야 알고, 그때는 `state.follow.target` 이 정본이 된다 (계약 §터틀봇 자리).
import { useEffect, useMemo, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { buildCycle, unloadSteps, observedStop } from '@fr5/shared/data/sim/cycle.js';
import { makeLoadSteps } from '@fr5/shared/data/sim/load-steps.js';
import { carrierOffsetAtInset, graspFromCenter, bulletsNearGraspWall, GRASP_INSET_CANDIDATES_MM } from '@fr5/shared/data/sim/grasp.js';
import { AMR_BASKET } from '@fr5/shared/data/props.js';
import { runContactCheck } from './contact.js';
import { PRIORITIES, stopCandidates, chooseStop, dwellSeconds, stopLabel } from '@fr5/shared/data/sim/stop-select.js';
import { DEMO_SPEED_PCT } from '@fr5/shared/data/sim/cycle.js';
import { viewPoseNearRz, viewPoseAtRz, VIEW_DEFAULT } from '@fr5/shared/data/sim/view-pose.js';
import { CARRIER, carrierBodyOffset } from '@fr5/shared/data/props.js';
import { AMR_MM } from '@fr5/shared/data/layout/catalog.js';
import { AMR_HOME, AMR_DROP, AMR_DROP_CANDIDATES, AMR_ARRIVE_ERR_MM } from '@fr5/shared/data/workcell.js';
import { Section } from '../Section.jsx';
import { AimBlock } from './AimBlock.jsx';
import { Guard } from './Guard.jsx';
import { RunLog } from './RunLog.jsx';
import { AutoRunControls } from './automatic/AutoRunControls.jsx';
import { useLimitedAutomatic } from './automatic/useLimitedAutomatic.js';
import { bulletEvidence, foldYaw, singleViewFused } from '@fr5/shared/data/sim/aim.js';
import { CARRIER_GRASP_TRUTH } from '@fr5/shared/data/props.js';
import { chunkJoints, arrived, maxJointDelta, chunkSeconds, BIG_CHUNK_DEG } from '@fr5/shared/data/sim/motion-chunks.js';
import { TABLE_TOP_REAL_ZMM } from '@fr5/shared/data/workcell.js';

// 싣기 10칸의 정본은 `Shared/data/sim/load-steps.js` 다 (2026-09-06 · phase 1) — 전엔 여기와 `amr-stop-mujoco.mjs` 가 각자 적었다
// 거치대 자리 — 실측 표적(색 검출)이 있으면 그것, 없으면 사람이 판 위에서 고른 자리(가정), 둘 다 없으면 08-31 파지 자세 x·y
// 색 검출·판 위 클릭·손목 스캔이 내는 것은 전부 **거치대 윗면 중심**이다. 9칸의 `graspXyMm` 은 **파지점(벽)** — 몸통이 뻗는 34.5mm 를
// 손가락 축 방향으로 되빼야 한다(`props.carrierBodyOffset` 한 곳). 2026-09-07 까지는 중심을 그대로 파지점으로 썼다 — 08-31 「그리퍼가
// 거치대 속에 통째로」 그 사고의 모양이 입력 경로에 남아 있던 것. rz 는 거치대 요각을 반영한 손목 각
const WIZARD_SS_KEY = 'fr5.sim.wizard';   // 마법사 상태 세션 저장 키(`AimBlock` 은 표적별 `fr5.sim.aim.<target>`)
const BASKET_OBSERVATION_MAX_AGE_MS = 10 * 60 * 1000;
const TB_POSE_KEEP_MM = 15;
const TB_YAW_KEEP_DEG = 3;
// API-CONTRACT 조건 27과 같은 주차 odom 잡음 데드밴드. FR5 브리지의 실기 게이트도 이 값을 쓴다.
const TB_STOP_LINEAR_DEADBAND_MM_S = 5;
const TB_STOP_ANGULAR_DEADBAND_DEG_S = 3;
const GRASP_VARIANTS = [
  { flip: false, turnDeg: 0 }, { flip: false, turnDeg: 180 },
  { flip: true, turnDeg: 0 }, { flip: true, turnDeg: 180 },
];
const wrapDeg = (d) => ((d % 360) + 540) % 360 - 180;
const connectedTb = (snap) => Object.values(snap?.robots ?? {}).find((r) => r?.connected) ?? null;
const tbPose = (snap) => {
  const p = connectedTb(snap)?.pose;
  return Number.isFinite(p?.xMm) && Number.isFinite(p?.yMm)
    ? { xMm: p.xMm, yMm: p.yMm, thetaDeg: Number(p.thetaDeg) || 0 }
    : null;
};
const freshBasket = (b, now = Date.now()) => !!b && Number.isFinite(b.measuredAtMs)
  && now - b.measuredAtMs >= 0 && now - b.measuredAtMs <= BASKET_OBSERVATION_MAX_AGE_MS;
const poseChanged = (a, b) => !!a && !!b
  && (Math.hypot(a.xMm - b.xMm, a.yMm - b.yMm) > TB_POSE_KEEP_MM
    || Math.abs(wrapDeg(a.thetaDeg - b.thetaDeg)) > TB_YAW_KEEP_DEG);

// 구간 하나의 표시 — 싣기 칸은 그 칸의 해·접촉, 내리기 칸은 같은 자세를 되쓰므로 그 원본 칸의 해, 관측 칸은 있으면 ✅, 주행은 →
function actMark(a, steps, solved, contact, uFrom) {
  if (a.kind === 'drive') return { mark: '→', bad: null };
  const sid = uFrom[a.id] ?? a.id;
  const k = steps.findIndex((s) => s.id === sid);
  if (k < 0) return { mark: '✅', bad: null };                       // 관측 칸 — 사이클에 있다는 것이 곧 해가 있다는 뜻
  const o = solved?.[k];
  const isLoad = !uFrom[a.id];
  const legHit = contact?.legs?.find((l) => l.hits.length && (l.to === a.id || (isLoad && l.toIndex === k)));
  const mark = !o ? '·' : (legHit ? '💥' : (o.gate?.ok ? '✅' : (o.jointsDeg ? '⚠' : '⛔')));
  const bad = !isLoad || !o ? null : (!o.jointsDeg ? (o.reason ?? '해가 없어요')
    : (o.gate && !o.gate.ok ? ((o.gate.reasons ?? [])[0] ?? '게이트 거부') : null));
  return { mark, bad };
}

export function SimPanel({ state, onReplay, onAmrTarget = null, carrierInput = null, measuredCarrier = null, pickCarrier = false, onPickCarrier = null, onClearInput = null, onCarrierSeen = null }) {
  // **정차 자리는 사이클이 고른다** (2026-09-06 · phase 2). 풀기 때 후보 7(채택 + 6)을 전부 평가하고 우선순위로 하나를 집는다.
  // `pick` 은 그 결과이고, 사람이 드롭다운으로 덮을 수 있다(덮어도 평가값은 그대로 보인다).
  // ⛔ 고른다고 터틀봇이 움직이지 않는다. 이 화면은 **그 자리였다면 팔이 어떻게 되나**만 푼다.
  // 2단 조준 결과 — 융합이 통과한 표적만 여기 산다(`AimBlock` → `onFused`). 거치대는 파지 자리·요각으로, 바구니는 ⑥~⑨ 자리로 흐른다
  const isMock = !!state?.robotId?.includes('mock');   // (아래 저장 판단이 먼저 써서 여기로 올렸다 — 선언 전 사용(TDZ)이 09-07 오후 배포를 하얗게 만들었다)
  // ⭐ 마법사 상태는 **탭을 오가도·새로고침해도** 남는다 (2026-09-07 17:40 실기 · 주인님 「터틀봇 탭을 갔다 오면 처음부터」) — 찾기 한 바퀴가 6분이다.
  //    sessionStorage(이 탭 안에서만 · 창 닫으면 사라진다). 목업(게이트)은 저장 안 한다 — 게이트가 같은 탭에서 여러 번 열며 1단부터 기대한다.
  //    ⛔ 「현장확인」(goConfirm)은 남기지 않는다 — 실기 보내기의 전제는 매번 사람이 다시 켠다(하드 룰 3)
  const wizardSaved = (() => { if (isMock) return null; try { return JSON.parse(window.sessionStorage.getItem(WIZARD_SS_KEY) || 'null'); } catch { return null; } })();
  const savedAimed = wizardSaved?.aimed ?? { carrier: null, basket: null };
  // 옛 배포 값에는 측정 시각·당시 터틀봇 자세가 없다. 물건은 그대로여도 터틀봇은 이미 움직였을 수 있으므로 복원하지 않는다.
  const [aimed, setAimed] = useState({ ...savedAimed, basket: freshBasket(savedAimed.basket) && savedAimed.basket?.tbPose ? savedAimed.basket : null });
  const aimedRef = useRef(aimed); aimedRef.current = aimed;
  const [alreadyStopped, setAlreadyStopped] = useState(false);              // 현장 확인값 — 새로고침·탭 재마운트 뒤에는 사람이 다시 확인한다
  const alreadyStoppedRef = useRef(alreadyStopped); alreadyStoppedRef.current = alreadyStopped;
  const resumePoseRef = useRef(null);
  const [runId, setRunId] = useState(wizardSaved?.runId ?? null);           // 기록 장부 — 첫 줄이 만들고 세션 내내 같은 파일에 덧붙인다
  const [goConfirm, setGoConfirm] = useState(false);  // 「현장확인」 — 실기 보내기 버튼의 전제 (하드 룰 3 · window.confirm 안 쓴다)
  // 4단 마법사 (D194) — 질문 하나·큰 버튼 하나·결과 한 문장. 단계 내용은 전부 DOM 에 있고 `hidden` 으로만 숨긴다(게이트 훅 유지)
  const [stage, setStage] = useState(wizardSaved?.stage ?? 1);
  const [cursor, setCursor] = useState(wizardSaved?.cursor ?? 0);            // ③ 한 칸씩 — 다음에 보낼 구간
  useEffect(() => {
    if (isMock || !state) return;                     // 상태를 아직 못 받았으면 목업인지도 모른다 — 쓰지 않는다
    try { window.sessionStorage.setItem(WIZARD_SS_KEY, JSON.stringify({ aimed, runId, stage, cursor, t: Date.now() })); } catch { /* 저장 못 해도 화면은 돈다 */ }
  }, [aimed, runId, stage, cursor, isMock, !state]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 색 검출 폴링 effect 가 아래에서 쓴다 — 선언보다 먼저 참조하면 TDZ 로 화면이 통째로 하얘진다(2026-09-07 실기 배포에서 한 번)
  const armed = state?.phase === 'ARMED' || state?.phase === 'EXECUTING';
  // 색 검출을 **직접** 읽는다 (2026-09-07 실기) — 실기 프로필의 `follow.targetSource` 가 `color` 가 아니면 `follow.target` 엔 터틀봇(odom)이 오고
  // 화면은 08-31 자리를 대강값으로 써서 270mm 딴 곳을 스캔하게 된다. 파일 나이 5초 안일 때만 실측으로 친다(가려지면 사라진다)
  const [colorHit, setColorHit] = useState(null);
  useEffect(() => {
    // 제한 실행 시작 버튼은 어느 마법사 단계에서도 보인다. 시작 전에 S1 신선도를 판정해야 하므로
    // 시뮬 탭이 열린 동안은 계속 읽는다(2초 · no-store). 실행 뒤 팔에 가리면 기존 5초 규칙대로 null.
    if (!state?.connected || isMock) { setColorHit(null); return undefined; }
    let dead = false; const recent = [];      // 마지막 5표본 — 중앙값으로 튐을 누른다(검출기가 두 덩어리 사이를 오가던 2026-09-07 실측 · 45mm 튐)
    const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const tick = async () => {
      const d = await datasource.carrierPose().catch(() => null);
      const v = d?.anchors?.['15'];
      const fresh = v && Array.isArray(v.user1Mm) && (Date.now() / 1000 - (v.t ?? 0)) <= 5;
      if (dead) return;
      if (!fresh) { recent.length = 0; setColorHit(null); return; }
      recent.push({ x: v.user1Mm[0], y: v.user1Mm[1], z: v.user1Mm[2], yaw: Number.isFinite(v.yawDeg) ? v.yawDeg : null, t: v.t });
      if (recent.length > 5) recent.shift();
      const yaws = recent.map((r) => r.yaw).filter((y) => y != null);
      const yawSpread = yaws.length ? Math.max(...yaws) - Math.min(...yaws) : 0;
      setColorHit({ user1Mm: [median(recent.map((r) => r.x)), median(recent.map((r) => r.y)), median(recent.map((r) => r.z))],
        yawDeg: yaws.length && yawSpread <= 20 ? median(yaws) : null,       // 요각이 20° 넘게 흔들리면 모른다고 한다(정사각 모호)
        ageS: Math.round(Date.now() / 1000 - v.t), n: recent.length, jitterMm: Math.round(Math.hypot(Math.max(...recent.map((r) => r.x)) - Math.min(...recent.map((r) => r.x)), Math.max(...recent.map((r) => r.y)) - Math.min(...recent.map((r) => r.y)))) });
    };
    tick(); const id = setInterval(tick, 2000);
    return () => { dead = true; clearInterval(id); };
  }, [state?.connected, isMock]);   // eslint-disable-line react-hooks/exhaustive-deps
  const followYaw = state?.follow?.target?.source === 'color' && Number.isFinite(state.follow.target.yawDeg) ? state.follow.target.yawDeg : null;
  // 트윈이 그릴 거치대 — 융합값 > 색 검출(직접) > 없음. 부르는 쪽(main.jsx)이 `carrierAtMm` 로 넘긴다. 값이 바뀔 때만 올린다
  // ⚠ z 는 뎁스 값을 쓰지 않는다 — 융합 z 는 **안쪽 바닥**(판+6~28 · 창 안 테두리가 섞이면 −276~−329 로 흔들린다)이고 트윈·집기는 «윗면 중심» 규약이다.
  //    실기 2026-09-07 17:33: 융합 z 그대로 넘겨 트윈의 거치대가 상판을 26~50mm 파고들었다. 윗면 z 는 상판 SSOT + 키(색 검출 대강값과 같은 식)
  const carrierTopZ = AMR_HOME.topZMm + CARRIER.hMm;
  const seenKey = JSON.stringify(aimed.carrier
    ? [[aimed.carrier.user1Mm[0], aimed.carrier.user1Mm[1], carrierTopZ], aimed.carrier.yawDeg, 'fused', aimed.carrier.bulletsUser1Mm ?? null]
    : (colorHit ? [colorHit.user1Mm, colorHit.yawDeg, 'color', null] : null));
  useEffect(() => {
    const v = JSON.parse(seenKey);
    onCarrierSeen?.(v ? { user1Mm: v[0], yawDeg: v[1], source: v[2], bulletsUser1Mm: v[3] } : null);
  }, [seenKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onCarrierSeen?.(null), []);   // eslint-disable-line react-hooks/exhaustive-deps
  const measuredYaw = colorHit ? colorHit.yawDeg : followYaw;
  // 거치대 요각(접힌 값 · 0 = 가로 85 가 x 와 평행) — 융합 > 색 검출 > 정본(0). 손목 각은 정본 rz + 요각
  // ⭐ **긴 벽×손목 대표 4개 중 하나를 고른다** (D208). 어느 벽인지(`flip`)와 손가락 축이 같은 손목 0°/180° 대표는 독립이다.
  //    벽 2×손목 2 전부에 총알·IK·안전 게이트를 묻고, 통과한 것 중 지금 관절에서 덜 도는 쪽을 고른다. 목업은 정본 벽·손목 0° 고정(결정성).
  const stateRef = useRef(state); stateRef.current = state;   // (아래 벽 고르기가 먼저 써서 여기로 올렸다)
  const [graspTurnDeg, setGraspTurnDeg] = useState(0);                          // 같은 손가락 축의 손목 대표 0|180
  const [graspFlip, setGraspFlip] = useState(false);                            // false=정본 벽, true=반대 긴 벽
  const [graspBlocked, setGraspBlocked] = useState(null);                       // 두 벽 다 안 되면 사유 — ③ 실기 버튼을 막는다
  const [graspPending, setGraspPending] = useState(null);                       // ARM 전에는 기하학과 실기 게이트를 섞지 않는다
  const [graspResolvedKey, setGraspResolvedKey] = useState(null);                // 자동 S3은 새 조준값의 벽 판정이 끝난 뒤에만 푼다
  // 요각 — 뎁스(융합) > 폰 색 검출 > 0. ⚠ 뎁스가 「모른다」(껍질 정사각 · 20:44 실기 95×102)고 하면 0 이 아니라 **폰 요각**으로 — 0 으로 두면 긴 벽을 90° 잘못 짚어
  //    짧은 벽 안쪽으로 손가락이 내려간다(20:19 충돌의 한 갈래). 둘 다 없을 때만 0(정본 자세 그대로)
  const graspYaw = aimed.carrier ? (aimed.carrier.yawDeg ?? (measuredYaw != null ? foldYaw(measuredYaw) : 0)) : (measuredYaw ?? null);
  const graspYawSource = aimed.carrier ? (aimed.carrier.yawDeg != null ? '뎁스' : (measuredYaw != null ? '폰(뎁스는 모름)' : '정본 0 (뎁스·폰 둘 다 모름)')) : (measuredYaw != null ? '폰' : null);
  const graspRz = graspYaw == null ? null : wrapDeg(graspYaw + graspTurnDeg);    // FAIRINO IK는 같은 자세도 ±180° 밖 Euler 표기를 해 없음으로 돌릴 수 있다(D209)
  const rzBase = CARRIER_GRASP_TRUTH.tcpMmDeg[5] + (graspYaw ?? 0);             // 오프셋 벡터는 손목 180 과 무관하게 이 각에서 flip 으로만 뒤집는다
  const rzForOffset = rzBase;
  const liveCarrier = colorHit ? colorHit.user1Mm : (Array.isArray(measuredCarrier) ? measuredCarrier : null);
  const carrierCenter = aimed.carrier ? aimed.carrier.user1Mm : (liveCarrier ?? (Array.isArray(carrierInput) ? carrierInput : null));
  const graspXy = graspFromCenter(carrierCenter, rzForOffset, graspFlip);
  const bullets = aimed.carrier?.bulletsUser1Mm ?? [];                          // 뎁스가 본 서 있는 총알(user1 xy)
  const bulletGate = bulletEvidence(aimed.carrier, CARRIER.roundsOnBoard);       // 빈 배열은 총알 없음이 아니라 정본 수 미달(D206)
  const bulletStepBlocked = (a) => !isMock && !bulletGate.ok && (a?.id === 'grasp' || a?.id === 'close');
  const bulletsOnGraspWall = bulletsNearGraspWall(carrierCenter, bullets, rzBase, graspFlip);
  const sideKey = JSON.stringify([aimed.carrier?.user1Mm ?? null, aimed.carrier?.bulletsUser1Mm ?? null, graspYaw, armed]);
  useEffect(() => {
    setGraspResolvedKey(null);
    if (isMock || !aimed.carrier || graspYaw == null) { setGraspTurnDeg(0); setGraspFlip(false); setGraspBlocked(null); setGraspPending(null); setGraspResolvedKey(sideKey); return; }
    let dead = false;
    (async () => {
      const cur = stateRef.current?.jointsDeg ?? null;
      const zGrasp = TABLE_TOP_REAL_ZMM + CARRIER_GRASP_TRUTH.tcpAboveTableMm;
      const cand = [];
      for (const { flip, turnDeg } of GRASP_VARIANTS) {
        const rz0 = CARRIER_GRASP_TRUTH.tcpMmDeg[5] + graspYaw;                  // 벽 오프셋(flip)과 180° 동치 손목(turnDeg)은 독립
        const xy = graspFromCenter(aimed.carrier.user1Mm, rz0, flip);
        const nearB = bulletsNearGraspWall(aimed.carrier.user1Mm, aimed.carrier.bulletsUser1Mm ?? [], rz0, flip);
        const pose = [xy[0], xy[1], zGrasp, CARRIER_GRASP_TRUTH.tcpMmDeg[3], CARRIER_GRASP_TRUTH.tcpMmDeg[4], wrapDeg(rz0 + turnDeg)];
        const r = await datasource.ik(pose, cur);                                            // eslint-disable-line no-await-in-loop
        const j = r?.jointsDeg ?? null;
        const delta = Array.isArray(j) && Array.isArray(cur) ? Math.max(...j.map((v, i) => Math.abs(v - cur[i]))) : null;
        const j6Delta = Array.isArray(j) && Array.isArray(cur) ? Math.abs(j[5] - cur[5]) : null;
        const gateReasons = r?.gate?.reasons ?? [];
        cand.push({ flip, turnDeg, ok: !!j && nearB.length === 0 && (!armed || r?.gate?.ok !== false), reachable: !!j,
          gateOk: r?.gate?.ok !== false, gateReasons, bullets: nearB.length, delta,
          j6Deg: Array.isArray(j) ? j[5] : null, j6Delta, pose });
      }
      if (dead) return;
      const ok = cand.filter((c) => c.ok); const pool = ok.length ? ok : [];       // ARM 전에는 관절해·총알만, ARM 뒤에는 안전 게이트까지 본다
      const pick = pool.length ? pool.reduce((a, b) => ((b.delta ?? Infinity) < (a.delta ?? Infinity) ? b : a)) : null;
      setGraspTurnDeg(pick ? pick.turnDeg : 0); setGraspFlip(pick ? pick.flip : false);
      const baseOk = cand.filter((c) => c.reachable && c.bullets === 0);
      const gateWhy = [...new Set(baseOk.flatMap((c) => c.gateReasons).filter(Boolean))].join(' · ');
      const otherHasBullet = cand.some((c) => c.bullets > 0);
      const blocked = pick ? null : (cand.every((c) => c.bullets > 0)
        ? '총알이 사전 성형한 손가락의 하강 띠에 있어 두 긴 벽 다 못 물어요 — 집지 않아요. 총알 배치를 바꾸고 「다시 찾기」'
        : (cand.every((c) => !c.reachable) ? '두 긴 벽 다 팔이 못 닿아요 — 집지 않아요'
          : (baseOk.length === 0 ? '닿는 긴 벽에는 총알이 있고 반대 벽은 도달하지 못해요 — 집지 않아요'
            : `${baseOk.length === 1 ? '총알 없는 긴 벽' : '두 긴 벽'}은 안전장치가 거부했어요${gateWhy ? ` — ${gateWhy}` : ''}${otherHasBullet ? ' · 반대 긴 벽은 총알과 겹쳐요' : ''} — 집지 않아요`)));
      setGraspBlocked(blocked);
      setGraspPending(pick && !armed ? '팔은 닿아요 · ARM 뒤 안전장치를 다시 확인해요' : null);
      setGraspResolvedKey(sideKey);
      log('grasp-side', { chosen: pick ? { wall: pick.flip ? 180 : 0, turnDeg: pick.turnDeg,
        j6Deg: pick.j6Deg, j6Delta: pick.j6Delta, tcpRzDeg: pick.pose[5], carrierYawDeg: graspYaw } : null,
        why: pick ? (!armed ? '관절해·총알 통과 — ARM 뒤 게이트 재확인' : (ok.length > 1 ? `${ok.length}개 후보 통과 — 손목 ${Math.round(pick.delta ?? 0)}° 로 덜 도는 것` : '되는 후보 하나')) : blocked,
        bullets: aimed.carrier.bulletsUser1Mm ?? [],
        candidates: cand.map((c) => ({ wall: c.flip ? 180 : 0, turnDeg: c.turnDeg, reachable: c.reachable, gateOk: c.gateOk, gateReasons: c.gateReasons,
          ok: c.ok, bullets: c.bullets, delta: c.delta == null ? null : Math.round(c.delta),
          j6Deg: c.j6Deg, j6Delta: c.j6Delta, tcp: c.pose })) });
    })();
    return () => { dead = true; };
  }, [sideKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const makeStepsAtInset = (stopLike = AMR_DROP, insetMm = 0) => makeLoadSteps(stopLike, {
    graspXyMm: graspFromCenter(carrierCenter, rzForOffset, graspFlip, insetMm),
    graspRzDeg: graspRz, basket: aimed.basket, graspFlip,
  });
  const makeSteps = (stopLike = AMR_DROP) => makeStepsAtInset(stopLike, 0);
  // 기록 한 줄 — 무엇을 보고·풀고·보냈나 + 그때의 실기 readback. 브리지는 적기만 한다(계약 §단계 기록)
  // ⛔ runId 는 **ref + 직렬 사슬**로 든다 — state 만 쓰면 첫 응답이 오기 전에 연달아 누른 버튼들이 각각 새 장부를 만들어 줄이 여러 파일로 흩어진다
  //    (2026-09-07 게이트: 같은 세션 줄이 12↔25 로 요동 · 원인이 이것). 한 줄씩 순서대로 적고 첫 줄이 만든 runId 를 그 뒤 전부가 쓴다
  const runIdRef = useRef(wizardSaved?.runId ?? null); const logChain = useRef(Promise.resolve());   // 같은 장부에 이어 쓴다(복원)
  const log = (step, payload = {}) => {
    const line = { phase: 0, step, robotId: state?.robotId ?? null,
      readback: { jointsDeg: state?.jointsDeg ?? null, tcpMmDeg: state?.tcpMmDeg ?? null, phase: state?.phase ?? null }, ...payload };
    const next = logChain.current.then(() => datasource.logRun(runIdRef.current, line))
      .then((r) => { if (r?.ok && r.runId) { if (r.runId !== runIdRef.current) { runIdRef.current = r.runId; setRunId(r.runId); } } return r; })
      .catch(() => null);
    logChain.current = next;
    return next;
  };
  // 한 칸 실기로 — 기존 WS `moveJ`·`gripper`(같은 게이트 · 조건 26·27). 목업이면 **안 보내고 기록만** 남긴다.
  // **분할 이동**(2026-09-07 · `motion-chunks.js`): 처음엔 WS `moveJ` 5° 조각(38개·5분)이었고, 같은 날 저녁 `/proposal`(경로 훑기)로 바꿔 120° 조각 — 조각마다 **도착(1°)을 확인한 뒤** 다음 조각.
  // 정착 상한 60초(D94)를 넘는 이동이 거부되던 것과 「응답 못 보면 성공 가정」(09-04) 둘을 같이 피한다. 도착을 못 보면 **멈추고** 사유를 쓴다
  const [going, setGoing] = useState(null);           // { label, k, n, why } — 조각 진행 · 실패 사유
  // 브리지 거부 사유는 WS 응답으로 **따로** 온다(`sendCmd` 는 보냈다는 것만 안다) — ③ 운전석이 그 문장을 그대로 보여준다
  const [refusal, setRefusal] = useState(null);
  useEffect(() => datasource.subscribeRefusals((r) => setRefusal(r ? { text: String(r), t: Date.now() } : null)), []);
  const speedPct = state?.speedOverridePct ?? null;      // 브리지가 「보낸 값」만 안다 — null 이면 대기 추정이 3배라 큰 이동이 60초 상한에 걸린다
  const speedOk = speedPct != null && speedPct >= 10 && speedPct <= 30;
  // ⭐ 파지 뚫림 **산수** (2026-09-07 · 주인님 「트윈에서 그리퍼가 거치대를 뚫고 내려가지 않는지」) — 접촉 시뮬은 판 위 거치대를 안 보고(GAP 09-06) 랩 장면도 없다.
  //    대신 정본 셋으로 답한다: 손끝 높이(판 위 tcpAboveTableMm) · 안쪽 바닥 윗끝(depthSignature.innerFloorAboveTableMm[1]) · 테두리(hMm). 몸통은 벽 밖(carrierBodyOffset)
  const graspCheck = (() => {
    const tip = CARRIER_GRASP_TRUTH.tcpAboveTableMm; const floorTop = CARRIER.depthSignature?.innerFloorAboveTableMm?.[1] ?? null; const rim = CARRIER.hMm;
    const aboveFloor = floorTop == null ? null : tip - floorTop; const belowRim = rim - tip;
    const ok = aboveFloor != null && aboveFloor >= 5 && belowRim >= 5;
    const yawTxt = graspYawSource ? ` · 요각 ${Number.isFinite(graspYaw) ? graspYaw.toFixed(0) : '?'}°(${graspYawSource})` : '';
    const bulletTxt = isMock ? ' · 목업 — 총알 안전 증거 아님'
      : (bulletGate.ok ? ` · ${bulletGate.why} · ${graspFlip ? '반대' : '정본'} 긴 벽을 물어요` : ` · ⛔ ${bulletGate.why} · 높은 접근·사전성형까지만`);
    const wallTxt = yawTxt + (graspBlocked ? ` · ⛔ ${graspBlocked}` : (graspPending ? ` · ⏳ ${graspPending}` : bulletTxt));
    return { ok: ok && !graspBlocked && !graspPending && (isMock || bulletGate.ok), text: `② 손끝은 판 위 ${tip}mm — 안쪽 바닥(판+${floorTop ?? '?'}) 위 ${aboveFloor == null ? '?' : aboveFloor.toFixed(0)} · 테두리(${rim}) 아래 ${belowRim.toFixed(0)}` + (ok ? ' → 바닥을 뚫지 않고 벽을 물어요' : ' → ⚠ 바닥이나 테두리와 5mm 여유가 없어요') + ' (산수 · 몸통은 벽 밖 34.5)' + wallTxt };
  })();
  // ⭐ 터틀봇 칸 자동 주행 (2026-09-07 19:10 · 주인님 「터틀봇 자동 이동이 시퀀스 안에」 · 계약 TB-CONTRACT §미래 접점 4·§경로)
  //    정차 후보의 `pathName` 경로로 슬롯 `run-path` 를 시작하고 `/ws/state` 로 도착(mode slot→idle · 속도 0 · 목표 30mm 안)을 본다. 경로가 없는 후보는 예전처럼 손으로.
  //    팔은 조건 27 이 자동으로 막는다. STOP 은 둘 다 세운다. 목업 팔이면 기록만
  const tbRef = useRef(null);
  const [tbStatus, setTbStatus] = useState({ connected: false, stopped: false, pose: null });
  const tbStatusKey = useRef('');
  useEffect(() => datasource.tb?.subscribeState?.((snap) => {
    tbRef.current = snap;
    const robot = connectedTb(snap); const pose = tbPose(snap);
    const moving = !!robot && (Math.abs(robot.velocity?.linearMmS ?? 0) > TB_STOP_LINEAR_DEADBAND_MM_S
      || Math.abs(robot.velocity?.angularDegS ?? 0) > TB_STOP_ANGULAR_DEADBAND_DEG_S || robot.mode === 'slot');
    const next = { connected: !!robot, stopped: !!robot && !moving, pose };
    const key = JSON.stringify([next.connected, next.stopped,
      pose ? Math.round(pose.xMm) : null, pose ? Math.round(pose.yMm) : null, pose ? Math.round(pose.thetaDeg * 2) / 2 : null]);
    if (key !== tbStatusKey.current) { tbStatusKey.current = key; setTbStatus(next); }

    // 오래된 측정, 측정 뒤 주행, 자세 점프(재부팅·odom 재설정 포함)는 정확한 바구니 값의 근거를 없앤다.
    const b = aimedRef.current?.basket;
    if (b && (!freshBasket(b) || moving || (b.tbPose && (!pose || poseChanged(b.tbPose, pose))))) {
      setAimed((a) => (a.basket === b ? { ...a, basket: null } : a));
    }
    if (alreadyStoppedRef.current && (moving || (resumePoseRef.current && (!pose || poseChanged(resumePoseRef.current, pose))))) {
      resumePoseRef.current = null; setAlreadyStopped(false);
    }
  }) ?? undefined, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const goDrive = async (a) => {
    const pathName = a.id === 'd-in' ? (stop.pathName ?? null) : (a.id === 'd-home' ? (stop.pathHome ?? null) : null);
    if (isMock) return true;                       // 목업 팔이면 터틀봇 칸은 예전처럼 그냥 넘어간다(기록 없음 · 게이트가 첫 실기 줄을 팔 줄로 읽는다)
    if (!pathName) { setGoing(null); log('go', { label: a.label, sent: null, mock: false, tb: { path: null, manual: true }, gate: { ok: true, reasons: ['저장 경로 없음 — 사람이 터틀봇 탭에서 보냈다고 본다'] } }); return true; }
    const snap = tbRef.current; const robots = snap?.robots ?? {};
    const robot = Object.keys(robots).find((id) => robots[id]?.connected) ?? null;
    if (!robot) { setGoing({ label: a.label, k: 1, n: 1, why: '터틀봇 브리지에 연결된 로봇이 없어요 — 터틀봇 탭에서 주소·연결 확인' }); return false; }
    const who = state?.owner ?? 'sim';
    const path = await datasource.tb.getPath(pathName);
    const goal = Array.isArray(path?.points) && path.points.length ? path.points[path.points.length - 1] : null;
    if (!goal) { setGoing({ label: a.label, k: 1, n: 1, why: `경로 ${pathName} 를 터틀봇 브리지에서 못 읽었어요` }); return false; }
    setGoing({ label: a.label, k: 1, n: 1, why: null, deg: null });
    const cl = await datasource.tb.claimOwner(robot, who);
    if (cl && cl.ok === false) { setGoing({ label: a.label, k: 1, n: 1, why: `터틀봇 조종권을 못 잡았어요 — ${cl.reason ?? ''}` }); return false; }
    const st = await datasource.tb.startSlot('run-path', robot, who, { path: pathName });
    if (!st || st.ok === false) { setGoing({ label: a.label, k: 1, n: 1, why: `run-path 시작 거부 — ${st?.reason ?? '응답 없음'}` }); log('go', { label: a.label, sent: { cmd: 'slot', slot: 'run-path', path: pathName, robot, who }, mock: false, gate: { ok: false, reasons: [st?.reason ?? '응답 없음'] } }); return false; }
    // 도착을 기다린다 — 슬롯이 시작됐다가(mode slot) 끝나면(idle · 속도 0) 자리가 목표 안인지 본다. 못 보면 멈춘다
    const p0 = robots[robot]?.pose ?? { xMm: 0, yMm: 0 };
    const distMm = Math.hypot(goal.xMm - p0.xMm, goal.yMm - p0.yMm);
    const budget = Math.min(180000, Math.max(45000, (distMm / 40) * 1000 + 30000));
    const t0 = Date.now(); let seenSlot = false; let r = null;
    while (Date.now() - t0 < budget) {                                                    // eslint-disable-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 300));                                    // eslint-disable-line no-await-in-loop
      r = tbRef.current?.robots?.[robot] ?? null;
      if (r?.mode === 'slot') seenSlot = true;
      if (!seenSlot && Date.now() - t0 > 10000) break;                                     // 10초 안에 슬롯이 안 뜨면 시작이 안 된 것
      if (seenSlot && r?.mode !== 'slot' && Math.abs(r?.velocity?.linearMmS ?? 0) < 1 && Math.abs(r?.velocity?.angularDegS ?? 0) < 1) break;
    }
    const pose = r?.pose ?? null; const elapsedS = Math.round((Date.now() - t0) / 1000);
    const err = pose ? Math.hypot(goal.xMm - pose.xMm, goal.yMm - pose.yMm) : null;
    const tol = (goal.arriveMm ?? 30) + 20;
    const ok = seenSlot && r?.mode !== 'slot' && err != null && err <= tol;
    const why = !seenSlot ? '슬롯이 10초 안에 시작되지 않았어요 — 터틀봇 탭에서 모드·조종권 확인'
      : (r?.mode === 'slot' ? `${Math.round(budget / 1000)}초 안에 도착을 못 봤어요 — 터틀봇 탭 STOP 뒤 다시`
        : (err != null && err > tol ? `도착 자리가 목표에서 ${err.toFixed(0)}mm 벗어났어요 (허용 ${tol})` : null));
    log('go', { label: a.label, sent: { cmd: 'slot', slot: 'run-path', path: pathName, robot, who }, mock: false, gate: { ok, reasons: ok ? [] : [why] },
      tb: { goal: { xMm: goal.xMm, yMm: goal.yMm, thetaDeg: goal.thetaDeg }, pose, errMm: err == null ? null : Math.round(err), elapsedS } });
    if (!ok) { setGoing({ label: a.label, k: 1, n: 1, why }); return false; }
    setGoing(null); return true;
  };
  const goStep = async (a) => {
    const guardStep = (where) => {
      const reason = typeof a.guard === 'function' ? a.guard() : null;
      if (!reason) return null;
      setGoing({ label: a.label, k: 0, n: 0, why: reason });
      log('go-blocked', { label: a.label, sent: null, reason, where });
      return reason;
    };
    if (bulletStepBlocked(a)) {
      setGoing({ label: a.label, k: 0, n: 0, why: bulletGate.why });
      log('go-blocked', { label: a.label, sent: null, reason: bulletGate.why,
        bullets: aimed.carrier?.bulletsUser1Mm ?? null, expected: CARRIER.roundsOnBoard });
      return false;
    }
    const cur = stateRef.current?.jointsDeg ?? null;
    const moved = Array.isArray(a.nextJ) && (!Array.isArray(cur) || maxJointDelta(cur, a.nextJ) > 0.5);
    // 모델의 prevGrip 이 아니라 **실기 readback**이 주인이다. 첫 접근은 모델상 이미 100%라 실제 손이 닫혀 있어도 열기를 건너뛰던 자리다.
    const gripNow = stateRef.current?.gripper?.pct;
    const gripChange = a.nextGrip != null && (!Number.isFinite(gripNow) || Math.abs(gripNow - a.nextGrip) > 1);
    if (isMock) {
      log('go', { label: a.label, sent: null, mock: true, solved: { jointsDeg: a.nextJ ?? null, tcpMmDeg: a.pose ?? null }, gate: null });
      return true;
    }
    if (moved) {
      if (!Array.isArray(cur)) { setGoing({ label: a.label, k: 0, n: 0, why: '지금 관절각을 못 읽어 못 보내요' }); return false; }
      // 전역 속도를 브리지가 「모름」이면(재시작 뒤엔 늘 그렇다) 대기 추정이 3배라 94° 조각이 60초 상한에 걸려 거부된다(실기 2026-09-07 17:27 ×3). 보내기 전에 말한다
      if (stateRef.current?.speedOverridePct == null) { setGoing({ label: a.label, k: 0, n: 0, why: '전역 속도를 브리지가 몰라요(재시작 뒤) — Live 탭 조작대에서 전역 속도 30 을 한 번 누르고 다시' }); return false; }
      // ⭐ **낮은 곳에서 출발하면 먼저 곧게 위로, 그다음 옆으로** (2026-09-07 18:50 · 주인님 「비전이 찾은 자리로 팔이 스스로 가야 한다」). 관절 직선은 올라가면서
      //    동시에 옆으로 가서, 손가락이 거치대 벽 안에 든 채(② 높이) 옆으로 끌릴 수 있다 — 판 위 거치대는 접촉 판정에 없다. 목표보다 5mm 넘게 낮고 xy 가 10mm 넘게
      //    다르면 같은 xy·같은 손목으로 목표 높이까지 올린 자세를 `/ik`(지금 관절 참조 · 같은 가지)로 풀어 앞 다리로 둔다. 내려가는 칸(②·⑦)은 xy 가 같아 다리가 안 생긴다
      const legs = [];
      const tcp = stateRef.current?.tcpMmDeg ?? null;
      // 「낮은 곳」= 판 위 150mm 안(거치대 55·바구니 테두리 150 높이의 물건 사이). 그 위에서 출발하면 옆 이동이 물건을 끌 일이 없다 — 19:20 실기: 판 위 283mm 에서
      //    출발한 ⓪ 칸이 이 다리를 만들다 IK 해가 없어 멈췄다(멀리 뻗은 자리에서 105mm 더 올릴 해가 없었다). 필요 없는 다리였다
      const LOW_Z = TABLE_TOP_REAL_ZMM + 150;
      if (Array.isArray(a.pose) && Array.isArray(tcp) && tcp.length === 6 && tcp[2] < LOW_Z && tcp[2] < a.pose[2] - 5 && Math.hypot(tcp[0] - a.pose[0], tcp[1] - a.pose[1]) > 10) {
        // 목표 높이까지 · 못 풀면 LOW_Z 까지만 · 그것도 못 풀면 다리 없이(경로 검사는 그대로 탄다) — 멈추지 않고 사유를 기록한다
        let leg = null;
        for (const z of [a.pose[2], Math.min(a.pose[2], LOW_Z + 20)]) {
          const up = [tcp[0], tcp[1], z, tcp[3], tcp[4], tcp[5]];
          const r = await datasource.ik(up, cur);                                          // eslint-disable-line no-await-in-loop
          if (r?.jointsDeg && r?.gate?.ok !== false) { leg = { j: r.jointsDeg, pose: up, label: `${a.label} · 먼저 곧게 위로 ${Math.round(z - tcp[2])}mm` }; break; }
        }
        if (leg) legs.push(leg);
        else log('go-note', { label: a.label, why: '먼저 곧게 올라갈 자세를 못 풀어 다리 없이 간다 — 경로 검사만 탄다' });
      }
      legs.push({ j: a.nextJ, pose: a.pose ?? null, label: a.label });
      let from = cur;
      for (const leg of legs) {                                                            // eslint-disable-line no-restricted-syntax
        const chunks = chunkJoints(from, leg.j, BIG_CHUNK_DEG);
        const sp = stateRef.current?.speedOverridePct ?? null;
        for (let k = 0; k < chunks.length; k += 1) {
          const j = chunks[k]; const deg = maxJointDelta(k === 0 ? from : chunks[k - 1], j);
          setGoing({ label: leg.label, k: k + 1, n: chunks.length, why: null, deg });
          // ⭐ **한 번에 간다** (2026-09-07 · 사다리 7 · 계약 VISION-CONTRACT §제안): `/proposal` 이 경로를 훑어 판정만 하고(팔 안 움직임), 사람이 누른 이 버튼이
          //    곧 승인 → 브리지가 `moveJ` 로 번역해 같은 게이트(조건 26·27)를 다시 탄다. WS `moveJ` 5° 상한 대신 정착 상한 60초(D94)가 조각 크기라 189° 가 2조각(5분 → 약 70초).
          //    승인 응답은 **도착 뒤**에 온다 — 그래도 아래 도착 확인을 한 번 더 한다(응답을 성공으로 가정하지 않는다 · 09-04 ②)
          const beforeProposal = guardStep('proposal 직전');
          if (beforeProposal) return false;
          const tcpHere = k === chunks.length - 1 ? (leg.pose ?? null) : null;
          const pr = await datasource.proposeMove(j, tcpHere, leg.label);                    // eslint-disable-line no-await-in-loop
          const pid = pr?.proposalId ?? null;
          const beforeApprove = guardStep('approve 직전');
          if (beforeApprove) return false;
          const res = (pr?.ok && pr?.verdict === 'needsHumanConfirm')
            ? await datasource.approveProposal(pid)                                        // eslint-disable-line no-await-in-loop
            : { ok: false, reason: pr?.reason ?? pr?.reasons?.[0] ?? `제안이 거부됐어요 (${pr?.verdict ?? '응답 없음'})` };
          const reasons = res?.ok ? [] : [res?.reason ?? res?.reasons?.[0] ?? '사유 없음'];
          log('go', { label: leg.label, chunk: `${k + 1}/${chunks.length}`, chunkDeg: Math.round(deg), sent: { cmd: 'proposal', proposalId: pid, speedPct: pr?.speedPct ?? DEMO_SPEED_PCT, globalPct: sp }, mock: false,
            solved: { jointsDeg: j, tcpMmDeg: tcpHere }, gate: { ok: !!res?.ok, reasons } });
          if (!res?.ok) { setGoing({ label: leg.label, k: k + 1, n: chunks.length, why: reasons[0] }); return false; }
          // 도착을 기다린다 — 예상 시간의 2배 + 10초. 못 보면 멈춘다(성공으로 가정하지 않는다 · 09-04 ②)
          const budget = Math.min(120000, chunkSeconds(deg, DEMO_SPEED_PCT) * 2000 + 10000);   // 승인 응답이 도착 뒤에 오므로 보통 즉시 통과한다
          const t0 = Date.now(); let ok = false;
          while (Date.now() - t0 < budget) {                                              // eslint-disable-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 300));                                  // eslint-disable-line no-await-in-loop
            if (arrived(stateRef.current?.jointsDeg, j)) { ok = true; break; }
          }
          if (!ok) {
            const why = `조각 ${k + 1}/${chunks.length} 도착을 ${Math.round(budget / 1000)}초 안에 못 봤어요 — 거부됐거나 느려요. Live 탭 사유를 보고 다시`;
            setGoing({ label: leg.label, k: k + 1, n: chunks.length, why });
            log('go-timeout', { label: leg.label, chunk: `${k + 1}/${chunks.length}`, why, readback: { jointsDeg: stateRef.current?.jointsDeg ?? null } });
            return false;
          }
        }
        from = leg.j;
      }
    }
    if (gripChange) {
      const beforeGrip = guardStep('gripper 직전');
      if (beforeGrip) return false;
      const res = datasource.gripper(a.nextGrip);
      if (!res.ok) { setGoing({ label: a.label, k: 0, n: 0, why: res.reason }); return false; }
      // WS 명령은 서버에서 직렬이지만 send() 자체는 즉시 돌아온다. 목표 readback 전에 다음 REST 이동 승인을 못 보내게 여기서 기다린다.
      setGoing({ label: a.label, k: 1, n: 1, why: null, deg: 0 });
      const t0 = Date.now(); let steady = 0; let g = null;
      while (Date.now() - t0 < 15000) {                                                // eslint-disable-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));                                  // eslint-disable-line no-await-in-loop
        g = stateRef.current?.gripper ?? null;
        if (g?.fault) break;
        steady = g?.active && Number.isFinite(g?.pct) && Math.abs(g.pct - a.nextGrip) <= 1 ? steady + 1 : 0;
        if (steady >= 2) break;                                                        // motionDone 이 최종값보다 먼저 뜨므로 pct 두 표본을 본다
      }
      const gripOk = steady >= 2 && !g?.fault;
      const reason = gripOk ? null : (g?.fault ? '그리퍼 fault — 다음 이동을 보내지 않아요' : `그리퍼 ${a.nextGrip}% 도착을 15초 안에 못 봤어요 — 다음 이동을 보내지 않아요`);
      log('go', { label: a.label, sent: { cmd: 'gripper', pct: a.nextGrip }, mock: false, solved: { jointsDeg: a.nextJ ?? null, tcpMmDeg: a.pose ?? null },
        readback: { gripper: g }, gate: { ok: gripOk, reasons: reason ? [reason] : [] } });
      if (!gripOk) { setGoing({ label: a.label, k: 1, n: 1, why: reason }); return false; }
    }
    setGoing(null);
    return true;
  };
  const onGhost = (pose, j, grip = null, carrierHold = null) => onReplay?.(j ? {
    armJoints: j, ...(pose ? { tcpMmDeg: pose } : {}), ...(Number.isFinite(grip) ? { gripperPct: grip } : {}),
    ...(carrierHold && pose ? { carrierHeldTcp: pose.slice(0, 3), carrierInHand: true, carrierHold } : {}),
  } : null);
  // 표적별 대강값 — 거치대는 색 검출 > 판 위 클릭 > 08-31 정본(중심으로 되돌린 것), 바구니는 정차 자리 + 등 뒤 오프셋(실측 −115) · 테두리 높이
  const coarseOf = (target) => {
    if (target === 'carrier') {
      const zTop = AMR_HOME.topZMm + CARRIER.hMm;
      if (Array.isArray(liveCarrier)) return { user1Mm: [liveCarrier[0], liveCarrier[1], zTop], yawDeg: measuredYaw, source: colorHit ? `color(${colorHit.ageS}s)` : 'color' };
      if (Array.isArray(carrierInput)) return { user1Mm: [carrierInput[0], carrierInput[1], zTop], yawDeg: null, source: 'input' };
      const g = CARRIER_GRASP_TRUTH.tcpMmDeg; const o = carrierBodyOffset(g[5]);
      return { user1Mm: [g[0] + o.dxMm, g[1] + o.dyMm, zTop], yawDeg: 0, source: 'truth-0831' };
    }
    const th = (stop.yawDeg * Math.PI) / 180; const back = Number.isFinite(AMR_BASKET.offsetMm?.x) ? AMR_BASKET.offsetMm.x : -115;
    return { user1Mm: [stop.xMm + back * Math.cos(th), stop.yMm + back * Math.sin(th), AMR_HOME.topZMm + (AMR_BASKET.rimAboveGroundMm ?? 150)],
      yawDeg: foldYaw(stop.yawDeg), source: 'stop+offset' };
  };
  const [pick, setPick] = useState(0);
  const [priority, setPriority] = useState('fast');
  const [evals, setEvals] = useState(null);         // 후보별 {reachable, contactLegs, dwellSec, reachMm, why, solved}
  const [evalNote, setEvalNote] = useState(null);   // 「후보 3/7 평가 중…」
  const [observe, setObserve] = useState(null);      // 관측 칸 둘 {carrier:{pose,jointsDeg}, amr:{…}} — 고른 후보 것 (phase 3)
  // ⑩ 관측 반영 — 되돌아온 터틀봇이 **실제로 선 자리**(유령 · 실측 도착 오차 37.5mm)로 내리기 자리를 다시 푼다. 끄면 열린 루프:
  // 팔은 명령 자리에 내리고 거치대는 실제 바구니에 있어 그 어긋남이 그림으로 보인다 — 「카메라가 없으면 이만큼 빗나간다」 (2026-09-06)
  const [observeFix, setObserveFix] = useState(true);
  const [observedRes, setObservedRes] = useState(null);   // {obsIn, obsBack, unloadSolved} — 고른 후보 것. 9칸(`steps`·`solved`)은 ⓪ 도착 자리 기준으로 푼 **계획**이다
  const [openLoop, setOpenLoop] = useState(null);         // 스위치를 끄면 그때 푼다 — 바구니 쪽 세 자세를 명령 자리에서 (열린 루프 그림용)
  const stop = stopCandidates()[pick] ?? AMR_DROP;
  const tbAtLoadingStop = isMock || (!!tbStatus.pose && tbStatus.stopped
    && Math.hypot(tbStatus.pose.xMm - stop.fromHomeMm, tbStatus.pose.yMm) <= AMR_ARRIVE_ERR_MM + 20
    && Math.abs(wrapDeg(tbStatus.pose.thetaDeg - (stop.turnFromHomeDeg ?? 0))) <= 15);
  const [steps, setSteps] = useState(() => makeSteps());
  // 좌표계 정본 — 없으면 터틀봇 자리를 못 옮긴다(결측=차단). 매 렌더 최신을 쓴다
  const userDef = state?.coordDefs?.user ?? null;
  const [solved, setSolved] = useState(null);      // [{jointsDeg, gate, reason}]
  // ⭐ 든 채 바구니 관측 자세 (2026-09-07 20:35) — ⑤ 「터틀봇 위로」 손목 각으로 바구니 대강값(관측이 있으면 그 값) 위 300mm(테두리 기준) 에 카메라를 둔다. 실기만(목업은 ⓪ 그대로)
  const [heldScan, setHeldScan] = useState(null);
  const heldKey = JSON.stringify([isMock, !!aimed.carrier, aimed.basket, stop?.xMm, stop?.yMm, stop?.yawDeg, graspRz, state?.handEye?.tMm]);
  useEffect(() => {
    if (isMock || !aimed.carrier || !Array.isArray(state?.handEye?.tMm)) { setHeldScan(null); return; }
    let dead = false;
    (async () => {
      const b = coarseOf('basket'); const st = makeSteps(stop); const carry = st.find((x) => x.id === 'carry'); const lift = st.find((x) => x.id === 'lift');
      if (!b || !carry) { if (!dead) setHeldScan(null); return; }
      const rim = [b.user1Mm[0], b.user1Mm[1], AMR_HOME.topZMm + (AMR_BASKET.rimAboveGroundMm ?? 150)];
      // 거리 250 (2026-09-07 21:00 실기 — 300 이면 카메라가 상판에서 450 이라 손목 뎁스의 disparity_shift(총알 근접용 50 · 425mm 밖 무효) 에 걸려 유효 12.8% 로 판 평면을 못 잡았다).
      //    250 이면 상판 400 · 바닥 판 285 · 든 거치대 바닥은 테두리 위 73 — 다 창 안
      const pose = viewPoseAtRz(rim, state.handEye.tMm, carry.pose[5], { tiltDeg: 0, distMm: 250 });
      if (!pose) { if (!dead) setHeldScan(null); return; }
      const liftJ = solved?.[st.indexOf(lift)]?.jointsDeg ?? stateRef.current?.jointsDeg ?? null;
      const r = await datasource.ik(pose, liftJ);
      if (dead) return;
      setHeldScan(r?.jointsDeg ? { pose, jointsDeg: r.jointsDeg } : null);
      if (!r?.jointsDeg) log('held-scan-pose', { why: '든 채 바구니 관측 자세를 못 풀었다 — ⓪ 터틀봇 관측으로 되돌아간다', pose });
    })();
    return () => { dead = true; };
  }, [heldKey, solved]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [contact, setContact] = useState(null);    // 접촉 층 — {legs, hitLegs, why} (`contact.js` · 브라우저 무조코)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // ── 컨베이어 한 사이클 (2026-09-06 · `docs/archive/GRILL-conveyor-twin-progresslog-2026-09-06.md`). 10칸이 풀리면 그 자세를
  //    되써서 「집기·들기 → 홈→정차 → 든 채 관측·놓기 → 앞으로·되돌아옴 → 관측·내리기 → 홈」을 **실시간 축**으로 돌린다
  //    (`Shared/data/sim/cycle.js` · IK 추가 호출 0). 시연이다 — 실기 근거가 아니다.
  //    9칸 전용 재생은 2026-09-06 밤에 없앴다 — 사이클 구간 목록이 그 9칸을 품고, 슬라이더도 부분집합이었다 (주인님 「사이클만 남기면」).
  const cycleTRef = useRef(null);                    // 고스트 주인 판정용(아래 stopCycle) — 선언은 state 앞에(TDZ)
  const [cycleT, setCycleT] = useState(null);        // ms · null = 꺼짐(고스트를 놓는다)
  cycleTRef.current = cycleT;
  const [cyclePlaying, setCyclePlaying] = useState(false);
  const [cycleSpeed, setCycleSpeed] = useState(5);   // 배속 — 실기 속도 그대로면 몇 분이라 기본 5배 (#13)
  const cycleTimer = useRef(0);
  // ⛔ `userDef` 는 상태 프레임마다 **새 배열**이다(33ms). 그대로 의존하면 memo 가 매 틱 새 사이클을 만들고
  //    아래 시계 effect 가 interval 을 50ms 마다 재시작해 **한 번도 안 울린다** (2026-09-06 게이트에서 0.0초에 멈춤).
  //    값으로 비교한다.
  const userKey = JSON.stringify(userDef);
  const cycle = useMemo(() => {
    if (!solved) return null;
    const userDef2 = JSON.parse(userKey);
    if (observeFix || !observedRes?.obsIn) {
      return buildCycle({ load: steps, solved, stop, userDef: userDef2, observe, carrierKnown: !!aimed.carrier, heldScan,
        loadAmr: observedRes?.obsIn ?? null, observed: observedRes?.obsBack ?? null, unloadSolved: observedRes?.unloadSolved ?? null,
        startAtStop: alreadyStopped, initialArm: alreadyStopped ? { jointsDeg: stateRef.current?.jointsDeg, tcpMmDeg: stateRef.current?.tcpMmDeg } : null });
    }
    // 열린 루프 — 명령 자리에서 푼 자세로 싣고 내린다. 터틀봇은 실제 자리에 서 있으니 어긋남이 그림으로 난다
    if (!openLoop) return { why: '열린 루프 자세를 푸는 중…' };
    if (openLoop.why) return { why: openLoop.why };
    return buildCycle({ load: openLoop.steps, solved: openLoop.solved, stop, userDef: userDef2, observe, carrierKnown: !!aimed.carrier, heldScan,
      startAtStop: alreadyStopped, initialArm: alreadyStopped ? { jointsDeg: stateRef.current?.jointsDeg, tcpMmDeg: stateRef.current?.tcpMmDeg } : null });
  }, [steps, solved, stop, userKey, observe, observeFix, observedRes, openLoop, alreadyStopped]);
  const acts = cycle && !cycle.why ? cycle.acts : null;
  const uFrom = useMemo(() => Object.fromEntries((unloadSteps(steps) ?? []).map((s) => [s.id, s.from])), [steps]);
  // 계측 훅 — 게이트가 구간 목록을 읽고 시각을 옮긴다(관측 칸에서 발자국이 초록인지 재려고)
  useEffect(() => {
    window.__actsChanges = (window.__actsChanges ?? 0) + 1;   // 진단 훅 — 사이클 정체(acts) 가 몇 번 바뀌었나. 재생 중 늘면 시계가 매 틱 재시작되는 병이다
    window.__cycleActs = acts ? acts.map((a) => ({ id: a.id, t0Ms: a.t0Ms, durMs: a.durMs, prevJ: a.prevJ ?? null, nextJ: a.nextJ ?? null })) : null;   // 관절 목표도 — 「왜 이 칸이 57초인가」를 밖에서 잰다
    window.__cycleSeek = (ms) => { setCyclePlaying(false); setCycleT(ms); };
  }, [acts]);

  // 고스트 주인 규칙 — **사이클이 주인일 때만** 지운다. 조준(ⓑ 자세 미리보기)이 세운 고스트를 9칸 재생성이 지우면
  // 「찾기가 끝나자 고스트가 사라진다」(2026-09-07 실기 · 주인님 발견). `cycleTRef` 가 지금 주인이 누군지 말한다
  const stopCycle = () => { setCyclePlaying(false); setCycleT(null); if (cycleTRef.current != null) onReplay?.(null); };
  const resumePlanSeen = useRef(alreadyStopped);
  useEffect(() => {
    if (resumePlanSeen.current === alreadyStopped) return;
    resumePlanSeen.current = alreadyStopped;
    setSteps(makeSteps(stop)); setSolved(null); setContact(null); setEvals(null); setObserve(null); setObservedRes(null); setOpenLoop(null); setErr(null); setCursor(0); stopCycle();
  }, [alreadyStopped]);   // eslint-disable-line react-hooks/exhaustive-deps
  const chooseAlreadyStopped = (checked) => {
    if (checked && !tbAtLoadingStop) return;
    resumePoseRef.current = checked ? tbStatus.pose : null;
    setAlreadyStopped(checked);
    log('resume-stop', { checked, tb: { connected: tbStatus.connected, stopped: tbStatus.stopped, pose: tbStatus.pose }, sent: null });
  };

  // 자리를 바꾸면 9칸을 다시 만들고 **이전 해를 버린다** — 옛 관절각이 새 자리의 답인 척하면 화면이 거짓말을 한다
  useEffect(() => {
    if (evals) return;                             // 평가가 있으면 `applyChoice` 가 9칸·해를 같이 올린다 — 여기서 버리면 안 된다
    setSteps(makeSteps(stop));
    setSolved(null); setContact(null); setErr(null); stopCycle();
  }, [pick]);                                     // eslint-disable-line react-hooks/exhaustive-deps

  // 거치대 자리(입력·실측)가 바뀌면 옛 해·평가는 낡은 자리 것이다 — 비우고 「다시 풀기」를 청한다
  const graspKey = JSON.stringify([graspXy, graspRz, aimed.basket]);
  useEffect(() => {
    setSteps(makeSteps(stop));
    setSolved(null); setContact(null); setEvals(null); setObserve(null); setObservedRes(null); setOpenLoop(null); stopCycle();
  }, [graspKey]);                                 // eslint-disable-line react-hooks/exhaustive-deps

  // 사이클 시계 — 벽시계 × 배속. 끝에 닿으면 멈춘다
  useEffect(() => {
    clearInterval(cycleTimer.current);
    if (!cyclePlaying || !cycle || cycle.why) return undefined;
    cycleTimer.current = setInterval(() => {
      setCycleT((v) => {
        const next = (v ?? 0) + 50 * cycleSpeed;
        if (next >= cycle.totalMs) { setCyclePlaying(false); return cycle.totalMs; }
        return next;
      });
    }, 50);
    return () => clearInterval(cycleTimer.current);
  }, [cyclePlaying, cycle, cycleSpeed]);

  // 사이클이 켜져 있으면 그 표본이 고스트 주인이다 — 팔·그리퍼·거치대·터틀봇·예정 경로를 한 번에 준다
  useEffect(() => {
    if (cycleT == null || !cycle || cycle.why) return;
    const s = cycle.sample(cycleT);
    onReplay?.({
      armJoints: s.armJoints, gripperPct: s.gripperPct, carrierHeldTcp: s.carrierHeldTcp, carrierInHand: !!s.carrierInHand,
      tcpMmDeg: s.tcpMmDeg,                          // 손목 카메라 시야 발자국이 고스트 자세를 따라간다
      ...(s.pose ? { pose: s.pose } : {}), ...(s.trail ? { trail: s.trail } : {}),
      ...(s.driftPose ? { driftPose: s.driftPose } : {}),   // 도착 오차 유령 — 실측 37.5mm 만큼 짧게 선 자리
    });
  }, [cycleT, cycle, onReplay]);

  // 열린 루프 자세 — 스위치를 끄면 그때 바구니 쪽 세 자세(carry·over·insert · 명령 자리)만 푼다. 판 쪽과 내리기 되쓰기는 그대로
  useEffect(() => {
    if (observeFix || openLoop || !solved || !observedRes?.obsIn) return undefined;
    let dead = false;
    (async () => {
      const stO = makeSteps(stop);
      const solvedO = solved.slice();
      const idx = Object.fromEntries(stO.map((s, i) => [s.id, i]));
      let ref = solved[idx.lift]?.jointsDeg ?? null;
      const got = {};
      for (const id of ['carry', 'over', 'insert']) {
        const r = await datasource.ik(stO[idx[id]].pose, ref);       // eslint-disable-line no-await-in-loop
        if (!r?.jointsDeg) { if (!dead) setOpenLoop({ why: `열린 루프 자세(명령 자리 · ${id})의 해가 없어요 — 관측 반영을 다시 켜요` }); return; }
        got[id] = r.jointsDeg; ref = r.jointsDeg;
      }
      for (const [id, from] of [['carry', 'carry'], ['over', 'over'], ['insert', 'insert'], ['release', 'insert'], ['retreat', 'over']]) {
        solvedO[idx[id]] = { ...solved[idx[id]], jointsDeg: got[from] };
      }
      if (!dead) setOpenLoop({ steps: stO, solved: solvedO });
    })();
    return () => { dead = true; };
  }, [observeFix, openLoop, solved, observedRes, stop]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ⛔ **떠날 때 고스트를 놓는다** — 안 놓으면 다른 탭에서 팔이 시뮬 자세로 굳는다
  useEffect(() => () => { onReplay?.(null); }, [onReplay]);

  // 한 후보를 푼다 — 9칸 IK(**참조는 직전 칸의 해** · 계약 §/ik) → 접촉 → 정차 시간·뻗음. 컨트롤러(집에선 목업)에 한 칸씩 묻는다.
  // ⛔ 전엔 참조를 안 넘겨 브리지가 칸마다 「지금 자세」를 참조했다 — 칸 사이에 가지가 갈려 관측 칸 하나가 165° 회전 57초였다 (2026-09-06)
  async function evaluateStop(candidate, sceneId, { currentStop = false } = {}) {
    // ⓪ 관측이 볼 도착 자리(실측 도착 오차 모델 · 랩에선 뎁스 검출값)로 9칸을 푼다 — 바구니 쪽 5칸만 정차 자리에 걸리고 판 쪽은 그대로다
    const obsIn = currentStop ? { ...candidate, dxMm: 0, dyMm: 0, yawErrDeg: 0, missMm: 0, leg: 'current' }
      : observedStop(candidate, AMR_HOME, { leg: 'in' });
    const obsBack = observedStop(candidate, AMR_HOME, { leg: 'back' });
    const st = makeSteps({ ...candidate, xMm: obsIn.xMm, yMm: obsIn.yMm, yawDeg: obsIn.yawDeg });
    const out = [];
    for (const s of st) {
      const r = await datasource.ik(s.pose, out[out.length - 1]?.jointsDeg ?? null);   // eslint-disable-line no-await-in-loop
      out.push({ asked: r != null, jointsDeg: r?.jointsDeg ?? null, gate: r?.gate ?? null,
        reason: r == null ? '브리지에 못 물었어요' : (r.reason ?? null) });
    }
    const reachable = out.every((o) => o.jointsDeg);
    // 관측 자세 둘 (phase 3) — ⓪ 거치대 윗면 중심(파지점 + 몸통 오프셋 · 판 + 높이 55) · ⑩ 터틀봇 라이다 윗면(정차 자리 + 192).
    // hand-eye 는 실기(또는 빌린) `state.handEye.tMm` — 없으면 관측 칸을 안 만든다(결측=차단)
    const tHE = state?.handEye?.tMm ?? null;
    const g = st.find((s) => s.id === 'grasp')?.pose;
    const bo = g ? carrierBodyOffset(g[5]) : null;
    const carrierTop = g && bo ? [g[0] + bo.dxMm, g[1] + bo.dyMm, AMR_HOME.topZMm + CARRIER.hMm] : null;
    const lidarTop = [candidate.xMm, candidate.yMm, AMR_HOME.topZMm + AMR_MM.heightMm];
    // 관측 자세의 손목 요각은 작업 자세(파지 rz)에 가장 가깝게 — 광축 둘레 회전은 「본다」에 자유라서 (`viewPoseNearRz`).
    // 참조는 이웃 칸의 해: ⓪ 은 ① 접근, ⑩ 은 ⑨ 빠져나온다
    const obsPoses = tHE && g ? [viewPoseNearRz(carrierTop, tHE, g[5]), viewPoseNearRz(lidarTop, tHE, g[5])] : [null, null];
    const obsRef = [out[0]?.jointsDeg ?? null, out[out.length - 1]?.jointsDeg ?? null];
    const obsJ = [];
    for (const [k, pz] of obsPoses.entries()) obsJ.push(pz ? (await datasource.ik(pz, obsRef[k]))?.jointsDeg ?? null : null);   // eslint-disable-line no-await-in-loop
    const obs = { tiltDeg: VIEW_DEFAULT.tiltDeg, distMm: VIEW_DEFAULT.distMm,
      carrier: obsPoses[0] && obsJ[0] ? { pose: obsPoses[0], jointsDeg: obsJ[0] } : null,
      amr: obsPoses[1] && obsJ[1] ? { pose: obsPoses[1], jointsDeg: obsJ[1] } : null };
    const extra = [];
    if (reachable && obs.carrier) extra.push({ from: 'o-carrier', to: 'approach', fromJ: obs.carrier.jointsDeg, toJ: out[0].jointsDeg, held: false });
    if (reachable && obs.amr) extra.push({ from: 'retreat', to: 'o-amr', fromJ: out[out.length - 1].jointsDeg, toJ: obs.amr.jointsDeg, held: false });
    if (reachable && obs.amr && obs.carrier) extra.push({ from: 'o-amr-in', to: 'o-carrier', fromJ: obs.amr.jointsDeg, toJ: obs.carrier.jointsDeg, held: false });
    const c = reachable ? await runContactCheck({ sceneId, steps: st, solved: out, stop: { xMm: obsIn.xMm, yMm: obsIn.yMm, yawDeg: obsIn.yawDeg }, userDef, extra }) : null;
    // ⑩ 관측 반영 — 되돌아와 실제로 선 자리(`observedStop` back · 유령과 같은 모델)로 바구니 쪽 내리기 자리를 옮겨 **두 자세만** 더 푼다
    // (u-over=u-lift · u-reach=u-close). 참조는 이웃 해(⑩ 관측 → over′ → insert′). 접촉도 터틀봇을 그 자리에 세워 두 길을 잰다
    const observed = obsBack;
    let unloadSolved = null;
    if (reachable) {
      const uf = unloadSteps(st, { from: obsIn, to: obsBack }) ?? [];
      const pOver = uf.find((s) => s.id === 'u-over')?.pose; const pReach = uf.find((s) => s.id === 'u-reach')?.pose;
      const jO = pOver ? (await datasource.ik(pOver, obs.amr?.jointsDeg ?? out[out.length - 1].jointsDeg))?.jointsDeg ?? null : null;
      const jI = pReach && jO ? (await datasource.ik(pReach, jO))?.jointsDeg ?? null : null;
      if (jO && jI) {
        unloadSolved = { 'u-over': jO, 'u-lift': jO, 'u-reach': jI, 'u-close': jI };
        const legs = [{ from: obs.amr ? 'o-amr' : 'retreat', to: 'u-over', fromJ: obs.amr?.jointsDeg ?? out[out.length - 1].jointsDeg, toJ: jO, held: false },
          { from: 'u-over', to: 'u-reach', fromJ: jO, toJ: jI, held: false }];
        const c2 = await runContactCheck({ sceneId, steps: [], solved: [], stop: { xMm: observed.xMm, yMm: observed.yMm, yawDeg: observed.yawDeg }, userDef, extra: legs });
        if (c && !c.why && c2 && !c2.why) { c.legs.push(...c2.legs); c.hitLegs = c.legs.filter((l) => l.hits.length).length; }
      }
    }
    const dwell = reachable ? dwellSeconds(st, out.map((o) => o.jointsDeg), DEMO_SPEED_PCT) : null;
    const reachMm = st.length ? Math.max(...st.map((s) => Math.hypot(s.pose[0] + (userDef?.[0] ?? 0), s.pose[1] + (userDef?.[1] ?? 0)))) : null;
    return { stop: candidate, steps: st, solved: out, contact: c, observe: obs, obsIn, obsBack, unloadSolved, reachable, contactLegs: c?.hitLegs ?? (c?.why ? 0 : 0),
      contactUnknown: !!c?.why, dwellSec: dwell, reachMm, why: reachable ? null : (out.find((o) => !o.jointsDeg)?.reason ?? '해가 없어요') };
  }

  async function solve() {
    setBusy(true); setErr(null); setSolved(null); setContact(null);
    stopCycle();                                   // 옛 해 위에 선 사이클이 새 해로 **혼자 다시 돌지** 않게 (감사 F4)
    setEvals(null);
    try {
      const robots = await datasource.robots();
      const sceneId = robots.find((r) => r.robotId === state?.robotId)?.sceneId ?? null;
      const cands = alreadyStopped ? [stop] : stopCandidates();
      const res = [];
      for (let k = 0; k < cands.length; k += 1) {
        setEvalNote(alreadyStopped ? '현재 정차 자리 평가 중…' : `정차 후보 ${k + 1}/${cands.length} 평가 중…`);
        res.push(await evaluateStop(cands[k], sceneId, { currentStop: alreadyStopped }));            // eslint-disable-line no-await-in-loop
      }
      setEvalNote(null);
      setEvals(res);
      // 계측 훅 — 게이트·디버그가 후보별 판정(닿나·접촉 구간·시간·뻗음)을 읽는다
      window.__stopEvals = res.map((e) => ({ stop: stopLabel(e.stop), reachable: e.reachable, contactLegs: e.contactLegs, why: e.why,
        hits: (e.contact?.legs ?? []).filter((l) => l.hits.length).map((l) => `${l.from}→${l.to}: ${l.hits.join(', ')}`), dwellSec: e.dwellSec, reachMm: e.reachMm, contactWhy: e.contact?.why ?? null, observe: { carrier: !!e.observe?.carrier, amr: !!e.observe?.amr } }));
      let selected = null;
      if (alreadyStopped) {
        const e = res[0];
        selected = e;
        setSteps(e.steps); setSolved(e.solved); setContact(e.contact ?? { legs: [], hitLegs: 0, why: e.why ?? '못 쟀다' });
        setObserve(e.observe ?? null); setObservedRes({ obsIn: e.obsIn ?? null, obsBack: e.obsBack ?? null, unloadSolved: e.unloadSolved ?? null });
        setOpenLoop(null); setEvalNote(null);
      } else {
        const chosen = applyChoice(res, priority);
        selected = chosen?.eval ?? null;
      }
      log('solve', { evals: window.__stopEvals, aimed, alreadyStopped });
      let why = null;
      if (!selected) why = '되는 정차 자리가 없어요';
      else if (!selected.reachable) why = selected.why ?? '팔이 닿지 않는 칸이 있어요';
      else if (selected.contactUnknown) why = `접촉을 확인하지 못했어요 — ${selected.contact?.why ?? '사유 없음'}`;
      else if (selected.contactLegs > 0) why = `${selected.contactLegs}구간에서 접촉해요`;
      else if (!isMock && selected.solved.some((o) => o.gate?.ok !== true)) {
        why = selected.solved.find((o) => o.gate?.ok !== true)?.gate?.reasons?.[0] ?? '안전 게이트를 확인하지 못했어요';
      }
      return { ok: !why, reason: why, selected };
    } catch (e) {
      const reason = String(e).slice(0, 120);
      setErr(reason);
      setEvalNote(null);
      return { ok: false, reason };
    } finally { setBusy(false); }
  }

  // S3R·S4는 미래 정차·놓기와 독립이다. S2가 고른 긴 벽에서 요청한 집기 접두 경로만
  // 다시 풀고 접촉까지 잰다. S4도 터틀봇·운반·놓기는 목록에 넣지 않는다(D212·D216).
  async function solvePickPrefix(stepIds, logStep, label) {
    setBusy(true); setErr(null);
    try {
      const currentJ = stateRef.current?.jointsDeg ?? null;
      if (!Array.isArray(currentJ)) return { ok: false, reason: `현재 관절각을 읽지 못해 ${label} 경로를 못 풀어요` };
      const currentGripPct = stateRef.current?.gripper?.pct;
      if (!isMock && !Number.isFinite(currentGripPct)) return { ok: false, reason: `현재 그리퍼 열림을 읽지 못해 ${label} 경로를 못 풀어요` };
      const liveBullets = aimedRef.current?.carrier?.bulletsUser1Mm;
      if (!isMock && (!Array.isArray(liveBullets) || liveBullets.length !== CARRIER.roundsOnBoard)) {
        return { ok: false, reason: `총알 ${Array.isArray(liveBullets) ? liveBullets.length : 0}/${CARRIER.roundsOnBoard}개 검출 — ${label} 접촉 장면을 만들지 않아요` };
      }
      const robots = await datasource.robots();
      const sceneId = robots.find((r) => r.robotId === stateRef.current?.robotId)?.sceneId ?? null;
      const insets = stepIds.includes('grasp') ? GRASP_INSET_CANDIDATES_MM : [0];
      const tried = []; let selected = null; let why = null;
      for (const insetMm of insets) {
        const readySteps = makeStepsAtInset(AMR_HOME, insetMm).filter((s) => stepIds.includes(s.id));
        const out = [];
        for (const s of readySteps) {
          const r = await datasource.ik(s.pose, out[out.length - 1]?.jointsDeg ?? currentJ); // eslint-disable-line no-await-in-loop
          out.push({ asked: r != null, jointsDeg: r?.jointsDeg ?? null, gate: r?.gate ?? null,
            reason: r == null ? '브리지에 못 물었어요' : (r.reason ?? null) });
        }
        let contact = null; let candidateWhy = null;
        if (readySteps.length !== stepIds.length) candidateWhy = `${label}의 ${stepIds.join('→')} 칸을 만들지 못했어요`;
        else if (out.some((o) => !o.jointsDeg)) candidateWhy = out.find((o) => !o.jointsDeg)?.reason ?? `${label} 자세의 해가 없어요`;
        else if (!isMock && out.some((o) => o.gate?.ok !== true)) {
          candidateWhy = out.find((o) => o.gate?.ok !== true)?.gate?.reasons?.[0] ?? `${label} 안전 게이트를 확인하지 못했어요`;
        } else {
          const gripNow = Number.isFinite(currentGripPct) ? currentGripPct : 100;
          contact = await runContactCheck({ sceneId, steps: readySteps, solved: out, stop: AMR_HOME, userDef,
            carrierUser1: [aimedRef.current.carrier.user1Mm[0], aimedRef.current.carrier.user1Mm[1], carrierTopZ],
            bulletsUser1Mm: liveBullets,
            extra: [
              { from: 'current', to: 'approach', fromJ: currentJ, toJ: out[0].jointsDeg, held: false,
                fromGripPct: gripNow, toGripPct: gripNow },
              { from: 'approach', to: 'open', fromJ: out[0].jointsDeg, toJ: out[0].jointsDeg, held: false,
                fromGripPct: gripNow, toGripPct: readySteps[0].grip },
            ] });
          if (contact?.why) candidateWhy = `${label} 경로의 접촉을 확인하지 못했어요 — ${contact.why}`;
          else if (contact?.hitLegs > 0) candidateWhy = `${label} 경로 ${contact.hitLegs}구간에서 접촉해요`;
        }
        tried.push({ insetMm, ok: !candidateWhy, reason: candidateWhy,
          gates: out.map((o) => o.gate ?? null), contact });
        if (!candidateWhy) { selected = { steps: readySteps, solved: out, contact, graspInsetMm: insetMm, insetCandidates: tried }; break; }
        if (insetMm === 0) why = candidateWhy;
      }
      if (!selected) why = why ?? `${label}의 물림 깊이 0~10mm에 안전한 후보가 없어요`;
      const report = selected ?? { steps: [], solved: [], contact: null, graspInsetMm: null, insetCandidates: tried };
      await log(logStep, { selected: { steps: report.steps.map((s) => s.id), graspInsetMm: report.graspInsetMm,
        insetCandidates: tried.map((c) => ({ insetMm: c.insetMm, ok: c.ok, reason: c.reason,
          contactLegs: c.contact?.hitLegs ?? null })), gates: report.solved.map((o) => o.gate ?? null), contact: report.contact },
      grasp: { wall: graspFlip ? 180 : 0, turnDeg: graspTurnDeg, insetMm: report.graspInsetMm }, reason: why });
      return { ok: !why, reason: why, selected };
    } catch (e) {
      const reason = String(e).slice(0, 120);
      setErr(reason);
      return { ok: false, reason };
    } finally { setBusy(false); }
  }
  const solveReady = () => solvePickPrefix(['approach', 'pregrip'], 'solve-ready', '파지 준비');
  const solvePick = () => solvePickPrefix(['approach', 'pregrip', 'grasp', 'close', 'lift'], 'solve-pick', '집기');

  // 평가 결과에서 하나를 집어 화면 상태(정차 자리·9칸·해·접촉)로 올린다 — 우선순위를 바꿔도 다시 풀지 않는다
  function applyChoice(res, prio, forceIndex = null) {
    const chosen = forceIndex != null ? { index: forceIndex, why: '사람이 골랐다' } : chooseStop(res, prio);
    const idx = chosen?.index ?? 0;
    const e = res[idx];
    setPick(idx);
    setSteps(e.steps);
    setSolved(e.solved);
    setContact(e.contact ?? { legs: [], hitLegs: 0, why: e.why ?? '못 쟀다' });
    setObserve(e.observe ?? null);
    setObservedRes({ obsIn: e.obsIn ?? null, obsBack: e.obsBack ?? null, unloadSolved: e.unloadSolved ?? null });
    setOpenLoop(null);
    setEvalNote(chosen ? null : '되는 정차 자리가 없어요 — 채택값을 그대로 보여요');
    return chosen;
  }

  const resetForAutomatic = () => {
    // 이전 탭의 장부·조준·계획은 이번 실행의 근거가 아니다. 첫 로그가 새 runId를 만든다.
    runIdRef.current = null; setRunId(null); logChain.current = Promise.resolve();
    try { window.sessionStorage.removeItem('fr5.sim.aim.carrier'); } catch { /* 저장소가 없어도 실행은 새 상태로 간다 */ }
    setAimed({ carrier: null, basket: null }); setSolved(null); setContact(null); setEvals(null); setObserve(null);
    setObservedRes(null); setOpenLoop(null); setErr(null); setCursor(0); setStage(1); stopCycle();
    onGhost(null, null);
  };
  const auto = useLimitedAutomatic({ state, isMock, busy, going, colorHit, tbStatus, tbSnapshot: tbRef.current,
    aimedCarrier: aimed.carrier, graspResolvedKey, sideKey, graspBlocked, graspPending,
    bulletBlocked: !isMock && !bulletGate.ok ? bulletGate.why : null,
    solve, solveReady, solvePick, readyStep: goStep,
    previewPick: (step, held = false, evidence = null) => {
      const o = carrierOffsetAtInset(rzBase, graspFlip, evidence?.graspInsetMm ?? 0);
      onGhost(step?.pose ?? null, step?.nextJ ?? null, step?.nextGrip ?? null, held ? {
        offsetMm: [o.dxMm, o.dyMm], graspRzDeg: step?.pose?.[5] ?? null, yawDeg: graspYaw,
        graspInsetMm: evidence?.graspInsetMm ?? 0,
      } : null);
    },
    resetForRun: resetForAutomatic, log });
  const { automatic, limit: autoLimit, setLimit: setAutoLimit, confirmed: autoConfirm,
    setConfirmed: setAutoConfirm, request: autoRequest, gate: autoGate,
    onStage: onAutoStage, onResult: onAutoResult, start: startAutomatic,
    stop: stopAutomatic, confirmPreview: confirmAutoPreview, startWhy: autoBlocked } = auto;

  const okCount = solved?.filter((o) => o.jointsDeg).length ?? 0;
  const gateOk = solved?.filter((o) => o.gate?.ok).length ?? 0;
  const sample = acts && cycleT != null ? cycle.sample(cycleT) : null;
  // 구간 목록 — 풀리기 전엔 싣기 9칸(무엇을 풀 것인가), 풀린 뒤엔 사이클 구간 전부(관측·내리기 포함)
  const rows = acts ?? steps.map((s) => ({ kind: 'arm', id: s.id, label: s.label, why: s.why }));

  // ── 4단 마법사 판정 (D194) ────────────────────────────────────────────────────
  const total = solved?.length ?? 0;
  const s2ok = !!(aimed.carrier || carrierInput || measuredCarrier);
  const planOk = !!solved && okCount === total && total > 0;
  const s3ok = planOk;
  // 계획이 통과하면 **실기 현재 위치와 별개인 이동 목표 고스트**를 왼쪽 트윈에 세운다.
  // odom 값만 넘기며 명령은 보내지 않는다. 현재 싣기 위치에 이미 섰다고 확인한 경우엔 목표가 없다.
  useEffect(() => {
    onAmrTarget?.(planOk && !alreadyStopped
      ? { xMm: stop.fromHomeMm, yMm: 0, thetaDeg: stop.turnFromHomeDeg ?? 0 }
      : null);
  }, [onAmrTarget, planOk, alreadyStopped, stop.fromHomeMm, stop.turnFromHomeDeg]);
  useEffect(() => () => onAmrTarget?.(null), [onAmrTarget]);
  useEffect(() => { if (stage === 1 && aimed.carrier) setStage(2); }, [aimed.carrier]);        // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (stage === 2 && planOk) setStage(3); }, [planOk]);                     // eslint-disable-line react-hooks/exhaustive-deps
  // 칸 목록이 다시 풀려도(바구니 관측 뒤 ⑤~⑨ 갱신) 커서는 **같은 id 의 칸**에 남는다 — 예전엔 0 으로 돌아가 터틀봇 이동부터 다시 눌러야 했다
  const prevActIds = useRef(null);
  useEffect(() => {
    const ids = acts ? acts.map((a) => a.id) : null;
    setCursor((c) => { const id = prevActIds.current?.[c]; const k = ids && id ? ids.indexOf(id) : -1; return k >= 0 ? k : 0; });
    prevActIds.current = ids;
  }, [acts]);
  const nextAct = acts?.[cursor] ?? null;
  const goNext = async () => {
    if (!nextAct || going?.n) return;
    setCyclePlaying(false); setCycleT(Math.max(0, nextAct.t0Ms + nextAct.durMs - 1));     // 3D 는 그 칸 끝 자세를 먼저 보여준다(고스트 먼저)
    let ok = true;
    if (nextAct.kind === 'arm') ok = await goStep(nextAct);
    else if (nextAct.kind === 'drive') ok = await goDrive(nextAct);
    else log('go', { label: nextAct.label, sent: null, mock: isMock, drive: true, solved: null, gate: null });
    // 관측 칸 — 도착했으면 손목 뎁스로 표적을 찍어 자리로 삼는다(관측이라 팔은 안 움직임). 못 보면 이 칸에 머물고 사유 · 다시 「다음」이면 그 자리에서 다시 찍는다
    if (ok && nextAct.scanTarget && !isMock) {
      const r = await datasource.scan(nextAct.scanTarget, {});
      const view = r?.ok ? r.view : null;
      const single = view ? (singleViewFused({ ...view, which: 'a' }, state?.handEye) ?? { user1Mm: view.user1Mm, yawDeg: view.yawDeg, n: 1, ok: true, why: '한 눈(프로필 표시 없음)' }) : null;
      log('aim-scan-basket', { target: nextAct.scanTarget, scan: view, err: r?.ok ? null : (r?.reasons ?? [r?.reason]), fused: single });
      if (!single) { setGoing({ label: nextAct.label, k: 1, n: 1, why: `카메라가 바구니를 못 봤어요 — ${(r?.reasons ?? [r?.reason ?? '응답 없음']).join(' · ')}` }); return; }
      if (nextAct.scanTarget === 'basketFloor') setAimed((a) => ({ ...a, basket: {
        xMm: single.user1Mm[0], yMm: single.user1Mm[1], yawDeg: single.yawDeg,
        measuredAtMs: Number.isFinite(view?.t) ? view.t * 1000 : Date.now(), tbPose: tbPose(tbRef.current),
      } }));
      setGoing(null);
    }
    if (ok) setCursor((c) => c + 1);                                                       // 도착했을 때만 다음 칸으로
  };
  const firstBad = (solved ?? []).find((o) => o.gate && !o.gate.ok)?.gate?.reasons?.[0] ?? null;
  const lights = [
    { id: 'reach', label: '팔이 닿아요', ok: solved ? okCount === total : null,
      why: solved ? (okCount === total ? `${total}칸 전부 닿아요` : `${total - okCount}칸에 팔이 닿지 않아요 — 거치대를 판 안쪽으로 옮겨 보세요`) : '아직 계획 전' },
    { id: 'contact', label: '부딪히지 않아요', ok: contact ? (contact.why ? null : contact.hitLegs === 0) : null,
      why: !contact ? '아직 계획 전' : contact.why ? `재지 못했어요 — ${contact.why}` : contact.hitLegs === 0 ? '가는 길 어디서도 부딪히지 않아요' : `${contact.hitLegs}구간에서 부딪혀요 — 정차 자리를 바꿔 보세요 (자세히)` },
    { id: 'gate', label: '안전장치가 켜져 있어요', ok: solved ? gateOk === total : null,
      why: !solved ? '아직 계획 전' : gateOk === total ? '안전장치가 전부 확인됐어요' : (firstBad && /조건 26/.test(firstBad) ? '안전장치 확인이 안 됐어요 — 랩에서 로봇을 ARM 하면 켜져요 (집 목업에선 늘 이래요)' : (firstBad ?? '안전장치를 확인하지 못했어요')) },
  ];
  const autoActive = automatic.status === 'RUNNING' || automatic.status === 'PREVIEW';
  const stageBtn = (n, label, enabled) => (
    <button type="button" key={n} data-t={`sim-stage-${n}`} aria-current={stage === n ? 'step' : undefined} disabled={!enabled || autoActive}
      onClick={() => setStage(n)}>{n} {label}{n === 1 && aimed.carrier ? ' ✓' : ''}{n === 2 && planOk ? ' ✓' : ''}</button>
  );

  return (
    <div className="sim">
      {/* 4단 마법사 (D194) — 절은 여전히 하나. 질문 하나 · 큰 버튼 하나 · 결과 한 문장. 실험 장치(사이클 재생·정차 후보·26칸·장부)는 「자세히」 안에 */}
      <Section id="sim-cycle" title="거치대를 집어 바구니에 — 네 단계" note="자동은 지정 단계까지만 · S3 계획 / S3R 높은 준비 / S4 고스트 확인 뒤 집어 올림">
        <nav className="wizard" data-t="sim-wizard" aria-label="단계">
          {stageBtn(1, '어디 있나', true)}{stageBtn(2, '할 수 있나', s2ok)}{stageBtn(3, '한 칸씩', s3ok)}{stageBtn(4, '기록', true)}
        </nav>
        <AutoRunControls automatic={automatic} limit={autoLimit} setLimit={setAutoLimit}
          confirmed={autoConfirm} setConfirmed={setAutoConfirm} start={startAutomatic}
          stop={stopAutomatic} confirmPreview={confirmAutoPreview} startWhy={autoBlocked} />

        {/* ── ① 어디 있나 ─────────────────────────────────────────────────────────── */}
        <section data-t="sim-stage" data-n="1" hidden={stage !== 1}>
          <h4>① 거치대가 어디 있나요?</h4>
          <Guard>
          <AimBlock state={state} coarseOf={coarseOf} isMock={isMock} log={log} onGhost={onGhost}
            autoRequest={autoRequest} onAutoStage={onAutoStage} onAutoResult={onAutoResult} autoGuard={autoGate}
            onGo={(j, label, pose, guard) => goStep({ label, nextJ: j, prevJ: state?.jointsDeg ?? null, prevGrip: null, nextGrip: null, pose, guard })}
            onFused={(target, fused) => setAimed((a) => (target === 'carrier' ? { ...a, carrier: fused } : { ...a, basket: fused ? {
              xMm: fused.user1Mm[0], yMm: fused.user1Mm[1], yawDeg: fused.yawDeg,
              measuredAtMs: Date.now(), tbPose: tbPose(tbRef.current),
            } : null }))} />
          </Guard>
          {!state?.connected && <p className="refusal">로봇(또는 목업)에 먼저 연결해 주세요 — Live 탭</p>}
          {/* 카메라 대신 손으로 — 실측(색 검출) > 판 위 클릭(가정) > 08-31 파지 자세 */}
          <p className="hint" data-t="sim-input" data-src={liveCarrier ? 'measured' : (carrierInput ? 'input' : 'truth')}>
            카메라 대신 손으로 알려줄 수도 있어요{' — '}
            {liveCarrier
              ? <>글로벌캠이 본 자리 ({liveCarrier[0].toFixed(0)}, {liveCarrier[1].toFixed(0)}){colorHit?.yawDeg != null ? ` · ${colorHit.yawDeg.toFixed(0)}° 돌아 있음` : (colorHit ? ' · 각도 모름' : '')}{colorHit?.jitterMm > 15 ? <b className="bad"> · 검출이 {colorHit.jitterMm}mm 흔들려요 — 두 덩어리로 보이는 중(브리지 검출기 갱신 대기)</b> : ''}{colorHit && colorHit.user1Mm[2] < TABLE_TOP_REAL_ZMM + CARRIER.hMm - 8 ? <b className="bad"> · 검출 높이 {colorHit.user1Mm[2].toFixed(0)} 이 상판({TABLE_TOP_REAL_ZMM}) 위 거치대 윗면보다 낮아요 — 평면 높이가 낡은 검출기(재시작 대기)</b> : ''}</>
              : carrierInput
                ? <><b>입력(가정)</b> ({carrierInput[0].toFixed(0)}, {carrierInput[1].toFixed(0)}) — 점선 자리 · 카메라가 보면 그것이 이겨요</>
                : <>지금은 08-31 에 놓았던 자리로 가정해요</>}
            {' '}
            <button type="button" data-t="sim-pick-btn" aria-pressed={!!pickCarrier} disabled={busy || !!liveCarrier}
              title={liveCarrier ? '카메라가 보고 있어 손으로 못 옮겨요' : '3D 의 판 위를 한 번 누르면 그 자리로'}
              onClick={() => onPickCarrier?.(!pickCarrier)}>
              {pickCarrier ? '판 위를 누르세요…' : '자리 고르기'}
            </button>
            {carrierInput && !liveCarrier && <button type="button" onClick={() => onClearInput?.()}>되돌리기</button>}
          </p>
        </section>

        {/* ── ② 할 수 있나 ─────────────────────────────────────────────────────────── */}
        <section data-t="sim-stage" data-n="2" hidden={stage !== 2}>
          <h4>② 로봇이 할 수 있나요?</h4>
          <p className="hint" data-t="sim-already-stopped" data-on={String(alreadyStopped)}>
            <label>
              <input type="checkbox" checked={alreadyStopped} disabled={!tbAtLoadingStop}
                onChange={(e) => chooseAlreadyStopped(e.target.checked)} />
              {' '}터틀봇이 <b>싣기 위치에 이미 도착했어요</b> — 원점 정차는 해당하지 않음
            </label>
            {!isMock && !tbStatus.connected && <b className="bad"> · 터틀봇 연결을 먼저 확인해요</b>}
            {!isMock && tbStatus.connected && !tbStatus.stopped && <b className="bad"> · 완전히 멈춘 뒤에만 선택돼요</b>}
            {!isMock && tbStatus.connected && tbStatus.stopped && !tbAtLoadingStop && <b className="bad">
              {' '}· 현재 원점 기준 앞 {Math.round(tbStatus.pose?.xMm ?? 0)}mm · 목표 {stop.fromHomeMm}mm에 도착해야 선택돼요
            </b>}
            {!alreadyStopped && <span data-t="sim-loading-stop-status"> · 거치대를 안전 높이까지 든 뒤 터틀봇이 목표 {stop.fromHomeMm}mm로 이동해요</span>}
            {alreadyStopped && <span> · 첫 주행을 생략하고 현재 자리 하나만 계산하며, 넣기 전 뎁스로 바구니를 다시 맞춰요</span>}
          </p>
          <div className="row">
            <button type="button" className="big" data-t="sim-plan" onClick={solve} disabled={busy || autoActive || !state?.connected}>
              {busy ? (evalNote ?? '계획 세우는 중…') : (solved ? '다시 계획 세우기' : '📐 계획 세우기')}
            </button>
            {planOk && !busy && <button type="button" onClick={() => setStage(3)}>③ 한 칸씩 →</button>}
          </div>
          <ul className="lights" data-t="sim-lights">
            {lights.map((l) => (
              <li key={l.id} data-t={`sim-light-${l.id}`} data-ok={l.ok === null ? 'unknown' : String(l.ok)}>
                <span className="lamp" aria-hidden="true" /> <b>{l.label}</b> — {l.why}
              </li>
            ))}
          </ul>
          {err && <p className="refusal">계획을 못 세웠어요 — {err}</p>}
          {cycle?.why && <p className="refusal">{cycle.why}</p>}
          <details data-t="sim-plan-detail">
            <summary>자세히 — 세 층 답 · 정차 자리 · 관측 반영</summary>
            {solved && (
              <p className="hint" data-t="sim-answer">
                <span data-t="sim-score">닿는 자세 <b>{okCount}/{solved.length}</b> · 게이트 통과 <b>{gateOk}/{solved.length}</b>
                  {gateOk < okCount && ' (거부 사유는 칸에)'}</span>
                {contact && <span data-t="sim-contact">{' · '}
                  {contact.why
                    ? <>접촉 — {contact.why}</>
                    : (contact.hitLegs === 0
                      ? <>접촉 <b>0</b>/{contact.legs.length}구간</>
                      : <>접촉 <b>{contact.hitLegs}</b>구간 — {contact.legs.filter((l) => l.hits.length).map((l) => `${steps[l.toIndex]?.label ?? l.to}: ${l.hits.join(', ')}`).join(' · ')}</>)}
                </span>}
                {acts && <>{' · '}한 사이클 <b>{(cycle.totalMs / 1000).toFixed(0)}초</b></>}
              </p>
            )}
            {solved && observedRes?.obsIn && (
              <p className="hint" data-t="sim-observe-fix" data-on={String(observeFix)}>
                <label>
                  <input type="checkbox" checked={observeFix}
                    onChange={(e) => { stopCycle(); setObserveFix(e.target.checked); }} />
                  {' '}⓪·⑩ 관측 반영 — 터틀봇이 <b>실제로 선 자리</b>(도착 오차 {observedRes.obsBack.missMm.toFixed(1)}mm
                  {observedRes.obsBack.yawErrDeg ? ` · 덜 돈 ${observedRes.obsBack.yawErrDeg.toFixed(1)}°` : ''})로 싣기·내리기를 푼다
                </label>
                {!observedRes.unloadSolved && observeFix && <b className="bad"> — 내릴 자리의 해가 없어 못 반영해요 · 끄면 열린 루프로 봐요</b>}
                {observedRes.unloadSolved && !observeFix && <b className="bad"> — 끔: 카메라 없이 싣고 내리면 {observedRes.obsBack.missMm.toFixed(1)}mm 빗나가요</b>}
              </p>
            )}
            <div className="hint" data-t="sim-stop" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span>{alreadyStopped ? '현재 정차 자리' : '정차 자리'}</span>
              {!alreadyStopped && <>
                {Object.entries(PRIORITIES).map(([k, v]) => (
                  <button key={k} type="button" aria-pressed={priority === k} title={v.hint} disabled={busy}
                    onClick={() => { setPriority(k); if (evals) { stopCycle(); applyChoice(evals, k); } }}
                    style={{ padding: '2px 10px', borderRadius: 4, fontWeight: priority === k ? 700 : 400,
                      border: priority === k ? '2px solid #2f6fd0' : '1px solid #bbb', background: '#fff' }}>
                    {v.label}
                  </button>
                ))}
                <select value={pick} disabled={busy || !evals} aria-label="정차 자리 바꾸기"
                  onChange={(e) => { stopCycle(); applyChoice(evals, priority, Number(e.target.value)); }}>
                  {stopCandidates().map((c, i) => {
                    const ev = evals?.[i];
                    const tag = !ev ? '' : (!ev.reachable ? ' ✗' : (ev.contactLegs ? ' 💥' : ` ${ev.dwellSec?.toFixed(0)}s`));
                    return <option key={`${c.xMm}-${c.yawDeg}-${i}`} value={i}>{stopLabel(c)}{i === 0 ? ' (채택)' : ''}{tag}</option>;
                  })}
                </select>
              </>}
            </div>
            <p className="hint" data-t="sim-stop-why">
              {alreadyStopped
                ? (evalNote ?? (evals ? <>현재 자리 하나만 평가했어요 · 정확한 바구니 중심은 넣기 전 뎁스로 다시 맞춰요</> : <>첫 주행 없이 현재 자리 하나만 평가합니다</>))
                : (evalNote ?? (evals
                ? <>{stopLabel(stop)} — {chooseStop(evals, priority)?.index === pick ? chooseStop(evals, priority)?.why : '사람이 골랐다'} · 후보 {evals.length} 중 되는 자리 {evals.filter((e) => e.reachable && !e.contactLegs).length}</>
                : <>({stop.xMm}, {stop.yMm}) · 요각 {stop.yawDeg}° — 「계획 세우기」가 후보 {stopCandidates().length}을 전부 평가해 고른다</>))}
            </p>
          </details>
        </section>

        {/* ── ③ 한 칸씩 ─────────────────────────────────────────────────────────────── */}
        <section data-t="sim-stage" data-n="3" hidden={stage !== 3}>
          <h4>③ 한 칸씩 보낼까요?</h4>
          <p className={`ready ${graspCheck.ok ? '' : 'bad'}`} data-t="sim-grasp-check" data-ok={String(graspCheck.ok)}>{graspCheck.text}</p>
          {!isMock && (
            <p className="ready" data-t="sim-ready" data-ok={String(armed && speedOk && state?.mode === 0)}>
              <span data-ok={String(!!state?.owner)}>조종권 {state?.owner ? `${state.owner} ✓` : '없음 — Live 탭에서 잡기'}</span>
              {' · '}<span data-ok={String(armed)}>{armed ? 'ARMED ✓' : 'ARM 전 — Live 탭에서 현장확인 뒤 ARM'}</span>
              {' · '}<span data-ok={String(state?.mode === 0)}>{state?.mode === 0 ? '자동 ✓' : '수동(펜던트) — ARM 하면 자동으로 바뀌어요'}</span>
              {' · '}<span data-ok={String(speedOk)}>전역 속도 {speedPct == null ? '모름' : `${speedPct}%`}{speedOk ? ' ✓' : ''}</span>
              {!speedOk && armed && (
                <button type="button" data-t="sim-speed-30" onClick={() => datasource.setSpeedOverride(30)} title="명령 10% × 전역 30% = 최대의 3% (0.87°/s) · 09-04 실기값">전역 30 으로</button>
              )}
              {speedPct != null && speedPct !== 30 && armed && <button type="button" onClick={() => datasource.setSpeedOverride(30)}>30 으로</button>}
            </p>
          )}
          {refusal && <p className="refusal" data-t="sim-refusal">브리지 거부 — {refusal.text} <button type="button" onClick={() => setRefusal(null)}>지움</button></p>}
          <p data-t="sim-go-confirm" data-mock={String(isMock)} data-on={String(goConfirm)}>
            <label className="confirm"><input type="checkbox" checked={goConfirm} onChange={(e) => setGoConfirm(e.target.checked)} />
              {' '}<b>현장확인</b> — 로봇 옆에 사람이 있고 정지 버튼에 손이 닿아요 (속도 {DEMO_SPEED_PCT}% · 같은 안전장치)</label>
            {isMock && <span> · 목업 — <b>안 보내고 기록만</b> 남겨요</span>}
            {!isMock && !armed && <span> · Live 탭에서 ARM 한 뒤에 눌려요</span>}
            {aimed.carrier && <span data-t="sim-aimed-carrier"> · 거치대는 카메라가 맞춘 자리({aimed.carrier.user1Mm[0].toFixed(0)}, {aimed.carrier.user1Mm[1].toFixed(0)})</span>}
            {aimed.basket && <span data-t="sim-aimed-basket"> · 바구니는 관측값({aimed.basket.xMm.toFixed(0)}, {aimed.basket.yMm.toFixed(0)})</span>}
          </p>
          <div className="row">
            <button type="button" className="big" data-t="sim-next" disabled={autoActive || !acts || !nextAct || (!!going?.n && !going.why) || (!isMock && (!armed || !goConfirm || !speedOk)) || (!isMock && !!graspBlocked) || bulletStepBlocked(nextAct)} onClick={goNext}
              title={bulletStepBlocked(nextAct) ? bulletGate.why : (!isMock && armed && !speedOk ? '전역 속도를 먼저 (위 「전역 30 으로」)' : (!isMock && !goConfirm ? '현장확인 체크 먼저' : ''))}>
              {!acts ? '먼저 ② 계획을 세워요' : !nextAct ? '끝났어요 ✓' : (going?.n && !going.why ? `가는 중… 조각 ${going.k}/${going.n} (${Math.round(going.deg ?? 0)}°)` : `다음 칸 ▶  ${nextAct.label}`)}
            </button>
            <button type="button" className="stopbtn" data-t="sim-stop-btn" onClick={stopAutomatic}>■ 정지</button>
            {acts && cursor > 0 && <button type="button" onClick={() => { setCursor(0); stopCycle(); }}>처음부터</button>}
          </div>
          {going?.why && <p className="refusal" data-t="sim-go-why">{going.label} — {going.why}</p>}
          <p className="sentence" data-t="sim-next-status">
            {!acts ? '계획이 서면 여기서 한 칸씩 보내요.' : nextAct
              ? <>{cursor + 1}/{acts.length} · {nextAct.kind === 'arm' ? '팔이 움직여요' : ((nextAct.id === 'd-in' && stop.pathName) ? `터틀봇이 움직여요 — 경로 ${stop.pathName} · 도착까지 기다려요` : '터틀봇 차례예요 — 터틀봇 탭에서 보내고 여기서 「다음」')}{cursor > 0 ? ` · 지난 칸 ${acts[cursor - 1].label} ${isMock ? '(목업: 기록만)' : '보냈어요'}` : ''}</>
              : <>{acts.length}칸 전부 보냈어요 — ④ 기록에서 되감아 보세요</>}
          </p>
          <details data-t="sim-run-detail">
            <summary>자세히 — 구간 {acts?.length ?? steps.length}개 · 재생</summary>
            <div className="row">
              <button type="button" data-t="sim-cycle-play" disabled={!acts}
                onClick={() => {
                  if (cyclePlaying) { setCyclePlaying(false); return; }
                  setCycleT((v) => (v == null || v >= cycle.totalMs ? 0 : v));
                  setCyclePlaying(true);
                }}>
                {cyclePlaying ? '멈춤' : (cycleT == null ? '사이클 재생' : '이어서')}
              </button>
              <button type="button" disabled={cycleT == null} onClick={() => { setCyclePlaying(false); setCycleT(0); }}>처음으로</button>
              <button type="button" disabled={cycleT == null} data-t="sim-cycle-off" onClick={stopCycle}>끄기</button>
              <label className="mm">배속{' '}
                <select value={cycleSpeed} onChange={(e) => setCycleSpeed(Number(e.target.value))}>
                  {[1, 2, 5, 10].map((v) => <option key={v} value={v}>{v}×</option>)}
                </select>
              </label>
            </div>
            {acts && (
              <>
                <input type="range" min={0} max={cycle.totalMs} step={100} value={cycleT ?? 0}
                  aria-label="사이클 재생 위치" disabled={cycleT == null}
                  onChange={(e) => { setCyclePlaying(false); setCycleT(Number(e.target.value)); }} />
                <p className="hint" data-t="sim-cycle-cur">
                  {sample
                    ? <>{sample.actIndex + 1}/{acts.length} <b>{sample.label}</b> · {(sample.tMs / 1000).toFixed(1)}/{(cycle.totalMs / 1000).toFixed(0)}초{sample.why ? <> — {sample.why}</> : null}</>
                    : <>실기 속도 {DEMO_SPEED_PCT}% · 주행 138.5mm/s 실측 · 구간 {acts.length}개 — 구간을 누르면 그 자세로</>}
                </p>
              </>
            )}
            <ol className="steps">
              {rows.map((a, i) => {
                const { mark, bad } = actMark(a, steps, solved, contact, uFrom);
                return (
                  <li key={a.id} aria-current={sample && sample.actIndex === i ? 'step' : (acts && i === cursor ? 'true' : undefined)}>
                    <button type="button" disabled={!acts} title={a.why}
                      onClick={() => { setCyclePlaying(false); setCycleT(Math.max(0, a.t0Ms + a.durMs - 1)); }}>
                      {mark} {a.label}
                    </button>
                    {a.kind === 'arm' && Array.isArray(a.nextJ) && (
                      <button type="button" data-t="sim-go-step" className="go" title={isMock ? '목업 — 안 보내고 기록만' : (bulletStepBlocked(a) ? bulletGate.why : (!armed ? 'ARM 뒤에' : (!goConfirm ? '현장확인 칸을 먼저' : '이 칸의 관절각으로 moveJ (10%)')))}
                        disabled={autoActive || (!isMock && (!armed || !goConfirm || !!bad || bulletStepBlocked(a)))} onClick={() => goStep(a)}>
                        {isMock ? '실기(목업·기록만)' : '실기'}
                      </button>
                    )}
                    {bad && <span className="refusal"> — {bad}</span>}
                    {bulletStepBlocked(a) && <span className="refusal"> — {bulletGate.why}</span>}
                  </li>
                );
              })}
            </ol>
          </details>
        </section>

        {/* ── ④ 기록 ──────────────────────────────────────────────────────────────── */}
        <section data-t="sim-stage" data-n="4" hidden={stage !== 4}>
          <h4>④ 무엇을 했나요?</h4>
          <p className="sentence">{runId ? <>이번 세션의 버튼 한 번 한 번이 장부 <b>{runId}</b> 에 한 줄씩 남아요 — 줄을 누르면 그때 자세로 돌아가요.</> : '아직 아무 버튼도 안 눌렀어요.'}</p>
          <RunLog runId={runId} onGhost={onGhost} />
        </section>
      </Section>
    </div>
  );
}
