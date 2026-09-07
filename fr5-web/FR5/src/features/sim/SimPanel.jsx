// 「시뮬」 탭 — **팔이 거치대를 집어 터틀봇 바구니에 넣는 동작을 화면에서만 돌린다.**
//
// ⛔ **실기는 안 움직인다.** 관절각은 브리지 `POST /ik` 가 컨트롤러에 **묻기만** 해서 받은
// 값이고, 같은 요청이 실제 이동과 **같은 함수**를 `dry_run` 으로 태워 게이트 판정까지
// 돌려준다. 그래서 이건 그림이 아니라 **실기 기구학·실기 게이트로 푼 시뮬레이션**이다.
//
// **탭이 답하는 질문 하나** (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 5) — 「거치대가 *여기* 있으면 팔이 할 수 있나 · 얼마나 걸리나」.
// 그래서 절은 **하나**다 — 입력 한 줄 · 풀기 · 세 층 답 · 사이클(구간 목록이 곧 9칸+관측+내리기). 「따라간다」 절은 3D 좌상단 스위치 하나로 돌아갔고
// (같은 상태가 두 곳에 있던 것), 관측 자세 후보는 사이클의 관측 칸에 흡수됐고(phase 3), 실측 되감기는 시뮬이 아니라
// **터틀봇 탭**으로 갔다(`TbPanel` §되감기). 어느 것도 지운 게 아니라 제자리로 보낸 것이다.
//
// ## 좌표가 어디서 오나 (지어낸 숫자 0)
//
//   9칸의 좌표는 전부 `Shared/data/sim/load-steps.js` 가 실측 SSOT 에서 만든다 (2026-09-06 · 정본 하나) —
//   집는 자리 `props.CARRIER_GRASP_TRUTH`(높이는 그려진 상판 기준) · 넣는 자리 정차 자리 + `props.AMR_BASKET` · 띄우는 높이 라이다 위 20
//
// ⚠ **바구니 자리는 「터틀봇이 홈에 섰을 때」의 가정이다.** 실제 정지 위치는 터틀봇이
// 켜져 있어야 알고, 그때는 `state.follow.target` 이 정본이 된다 (계약 §터틀봇 자리).
import { useEffect, useMemo, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { buildCycle, unloadSteps, observedStop } from '@fr5/shared/data/sim/cycle.js';
import { makeLoadSteps } from '@fr5/shared/data/sim/load-steps.js';
import { AMR_BASKET } from '@fr5/shared/data/props.js';
import { runContactCheck } from './contact.js';
import { PRIORITIES, stopCandidates, chooseStop, dwellSeconds, stopLabel } from '@fr5/shared/data/sim/stop-select.js';
import { DEMO_SPEED_PCT } from '@fr5/shared/data/sim/cycle.js';
import { viewPoseNearRz, VIEW_DEFAULT } from '@fr5/shared/data/sim/view-pose.js';
import { CARRIER, carrierBodyOffset } from '@fr5/shared/data/props.js';
import { AMR_MM } from '@fr5/shared/data/layout/catalog.js';
import { AMR_HOME, AMR_DROP, AMR_DROP_CANDIDATES } from '@fr5/shared/data/workcell.js';
import { Section } from '../Section.jsx';
import { AimBlock } from './AimBlock.jsx';
import { RunLog } from './RunLog.jsx';
import { foldYaw } from '@fr5/shared/data/sim/aim.js';
import { CARRIER_GRASP_TRUTH } from '@fr5/shared/data/props.js';
import { chunkJoints, arrived, maxJointDelta, chunkSeconds, CHUNK_DEG } from '@fr5/shared/data/sim/motion-chunks.js';
import { TABLE_TOP_REAL_ZMM } from '@fr5/shared/data/workcell.js';

// 싣기 9칸의 정본은 `Shared/data/sim/load-steps.js` 다 (2026-09-06 · phase 1) — 전엔 여기와 `amr-stop-mujoco.mjs` 가 각자 적었다
// 거치대 자리 — 실측 표적(색 검출)이 있으면 그것, 없으면 사람이 판 위에서 고른 자리(가정), 둘 다 없으면 08-31 파지 자세 x·y
// 색 검출·판 위 클릭·손목 스캔이 내는 것은 전부 **거치대 윗면 중심**이다. 9칸의 `graspXyMm` 은 **파지점(벽)** — 몸통이 뻗는 34.5mm 를
// 손가락 축 방향으로 되빼야 한다(`props.carrierBodyOffset` 한 곳). 2026-09-07 까지는 중심을 그대로 파지점으로 썼다 — 08-31 「그리퍼가
// 거치대 속에 통째로」 그 사고의 모양이 입력 경로에 남아 있던 것. rz 는 거치대 요각을 반영한 손목 각
const graspFromCenter = (center, rzDeg) => {
  if (!Array.isArray(center)) return null;
  const o = carrierBodyOffset(rzDeg);
  return [center[0] - o.dxMm, center[1] - o.dyMm];
};

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

export function SimPanel({ state, onReplay, carrierInput = null, measuredCarrier = null, pickCarrier = false, onPickCarrier = null, onClearInput = null, onCarrierSeen = null }) {
  // **정차 자리는 사이클이 고른다** (2026-09-06 · phase 2). 풀기 때 후보 7(채택 + 6)을 전부 평가하고 우선순위로 하나를 집는다.
  // `pick` 은 그 결과이고, 사람이 드롭다운으로 덮을 수 있다(덮어도 평가값은 그대로 보인다).
  // ⛔ 고른다고 터틀봇이 움직이지 않는다. 이 화면은 **그 자리였다면 팔이 어떻게 되나**만 푼다.
  // 2단 조준 결과 — 융합이 통과한 표적만 여기 산다(`AimBlock` → `onFused`). 거치대는 파지 자리·요각으로, 바구니는 ⑥~⑨ 자리로 흐른다
  const [aimed, setAimed] = useState({ carrier: null, basket: null });
  const [runId, setRunId] = useState(null);           // 기록 장부 — 첫 줄이 만들고 세션 내내 같은 파일에 덧붙인다
  const [goConfirm, setGoConfirm] = useState(false);  // 「현장확인」 — 실기 보내기 버튼의 전제 (하드 룰 3 · window.confirm 안 쓴다)
  // 4단 마법사 (D194) — 질문 하나·큰 버튼 하나·결과 한 문장. 단계 내용은 전부 DOM 에 있고 `hidden` 으로만 숨긴다(게이트 훅 유지)
  const [stage, setStage] = useState(1);
  const [cursor, setCursor] = useState(0);            // ③ 한 칸씩 — 다음에 보낼 구간
  // 색 검출 폴링 effect 가 아래에서 쓴다 — 선언보다 먼저 참조하면 TDZ 로 화면이 통째로 하얘진다(2026-09-07 실기 배포에서 한 번)
  const isMock = !!state?.robotId?.includes('mock');
  const armed = state?.phase === 'ARMED' || state?.phase === 'EXECUTING';
  // 색 검출을 **직접** 읽는다 (2026-09-07 실기) — 실기 프로필의 `follow.targetSource` 가 `color` 가 아니면 `follow.target` 엔 터틀봇(odom)이 오고
  // 화면은 08-31 자리를 대강값으로 써서 270mm 딴 곳을 스캔하게 된다. 파일 나이 5초 안일 때만 실측으로 친다(가려지면 사라진다)
  const [colorHit, setColorHit] = useState(null);
  useEffect(() => {
    if (stage !== 1 || !state?.connected || isMock) { setColorHit(null); return undefined; }
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
  }, [stage, state?.connected, isMock]);   // eslint-disable-line react-hooks/exhaustive-deps
  const followYaw = state?.follow?.target?.source === 'color' && Number.isFinite(state.follow.target.yawDeg) ? state.follow.target.yawDeg : null;
  // 트윈이 그릴 거치대 — 융합값 > 색 검출(직접) > 없음. 부르는 쪽(main.jsx)이 `carrierAtMm` 로 넘긴다. 값이 바뀔 때만 올린다
  const seenKey = JSON.stringify(aimed.carrier ? [aimed.carrier.user1Mm, aimed.carrier.yawDeg, 'fused'] : (colorHit ? [colorHit.user1Mm, colorHit.yawDeg, 'color'] : null));
  useEffect(() => {
    const v = JSON.parse(seenKey);
    onCarrierSeen?.(v ? { user1Mm: v[0], yawDeg: v[1], source: v[2] } : null);
  }, [seenKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onCarrierSeen?.(null), []);   // eslint-disable-line react-hooks/exhaustive-deps
  const measuredYaw = colorHit ? colorHit.yawDeg : followYaw;
  // 거치대 요각(접힌 값 · 0 = 가로 85 가 x 와 평행) — 융합 > 색 검출 > 정본(0). 손목 각은 정본 rz + 요각
  const graspRz = aimed.carrier ? (aimed.carrier.yawDeg ?? 0) : (measuredYaw ?? null);
  const rzForOffset = CARRIER_GRASP_TRUTH.tcpMmDeg[5] + (graspRz ?? 0);
  const liveCarrier = colorHit ? colorHit.user1Mm : (Array.isArray(measuredCarrier) ? measuredCarrier : null);
  const carrierCenter = aimed.carrier ? aimed.carrier.user1Mm : (liveCarrier ?? (Array.isArray(carrierInput) ? carrierInput : null));
  const graspXy = graspFromCenter(carrierCenter, rzForOffset);
  const makeSteps = (stopLike = AMR_DROP) => makeLoadSteps(stopLike, { graspXyMm: graspXy, graspRzDeg: graspRz, basket: aimed.basket });
  // 기록 한 줄 — 무엇을 보고·풀고·보냈나 + 그때의 실기 readback. 브리지는 적기만 한다(계약 §단계 기록)
  // ⛔ runId 는 **ref + 직렬 사슬**로 든다 — state 만 쓰면 첫 응답이 오기 전에 연달아 누른 버튼들이 각각 새 장부를 만들어 줄이 여러 파일로 흩어진다
  //    (2026-09-07 게이트: 같은 세션 줄이 12↔25 로 요동 · 원인이 이것). 한 줄씩 순서대로 적고 첫 줄이 만든 runId 를 그 뒤 전부가 쓴다
  const runIdRef = useRef(null); const logChain = useRef(Promise.resolve());
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
  // **분할 이동**(2026-09-07 · `motion-chunks.js`): WS `moveJ` 는 한 명령 5° 상한이라 관절차를 5° 조각으로 잘라 한 조각씩 보내고 **도착(1°)을 확인한 뒤** 다음 조각.
  // 정착 상한 60초(D94)를 넘는 이동이 거부되던 것과 「응답 못 보면 성공 가정」(09-04) 둘을 같이 피한다. 도착을 못 보면 **멈추고** 사유를 쓴다
  const stateRef = useRef(state); stateRef.current = state;
  const [going, setGoing] = useState(null);           // { label, k, n, why } — 조각 진행 · 실패 사유
  // 브리지 거부 사유는 WS 응답으로 **따로** 온다(`sendCmd` 는 보냈다는 것만 안다) — ③ 운전석이 그 문장을 그대로 보여준다
  const [refusal, setRefusal] = useState(null);
  useEffect(() => datasource.subscribeRefusals((r) => setRefusal(r ? { text: String(r), t: Date.now() } : null)), []);
  const speedPct = state?.speedOverridePct ?? null;      // 브리지가 「보낸 값」만 안다 — null 이면 대기 추정이 3배라 큰 이동이 60초 상한에 걸린다
  const speedOk = speedPct != null && speedPct >= 10 && speedPct <= 30;
  const goStep = async (a) => {
    const cur = stateRef.current?.jointsDeg ?? null;
    const moved = Array.isArray(a.nextJ) && (!Array.isArray(cur) || maxJointDelta(cur, a.nextJ) > 0.5);
    const gripChange = a.nextGrip != null && a.prevGrip != null && a.nextGrip !== a.prevGrip;
    if (isMock) {
      log('go', { label: a.label, sent: null, mock: true, solved: { jointsDeg: a.nextJ ?? null, tcpMmDeg: a.pose ?? null }, gate: null });
      return true;
    }
    if (moved) {
      if (!Array.isArray(cur)) { setGoing({ label: a.label, k: 0, n: 0, why: '지금 관절각을 못 읽어 못 보내요' }); return false; }
      const chunks = chunkJoints(cur, a.nextJ, CHUNK_DEG);
      const sp = stateRef.current?.speedOverridePct ?? null;
      for (let k = 0; k < chunks.length; k += 1) {
        const j = chunks[k]; const deg = maxJointDelta(k === 0 ? cur : chunks[k - 1], j);
        setGoing({ label: a.label, k: k + 1, n: chunks.length, why: null, deg });
        const res = datasource.moveJ(j, DEMO_SPEED_PCT);
        log('go', { label: a.label, chunk: `${k + 1}/${chunks.length}`, chunkDeg: Math.round(deg), sent: { cmd: 'moveJ', speedPct: DEMO_SPEED_PCT, globalPct: sp }, mock: false,
          solved: { jointsDeg: j, tcpMmDeg: k === chunks.length - 1 ? (a.pose ?? null) : null }, gate: { ok: res.ok, reasons: res.reason ? [res.reason] : [] } });
        if (!res.ok) { setGoing({ label: a.label, k: k + 1, n: chunks.length, why: res.reason }); return false; }
        // 도착을 기다린다 — 예상 시간의 2배 + 10초. 못 보면 멈춘다(성공으로 가정하지 않는다 · 09-04 ②)
        const budget = Math.min(120000, chunkSeconds(deg, DEMO_SPEED_PCT, sp ?? 30) * 2000 + 10000);
        const t0 = Date.now(); let ok = false;
        while (Date.now() - t0 < budget) {                                              // eslint-disable-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 300));                                  // eslint-disable-line no-await-in-loop
          if (arrived(stateRef.current?.jointsDeg, j)) { ok = true; break; }
        }
        if (!ok) {
          const why = `조각 ${k + 1}/${chunks.length} 도착을 ${Math.round(budget / 1000)}초 안에 못 봤어요 — 거부됐거나 느려요. Live 탭 사유를 보고 다시`;
          setGoing({ label: a.label, k: k + 1, n: chunks.length, why });
          log('go-timeout', { label: a.label, chunk: `${k + 1}/${chunks.length}`, why, readback: { jointsDeg: stateRef.current?.jointsDeg ?? null } });
          return false;
        }
      }
    }
    if (gripChange) {
      const res = datasource.gripper(a.nextGrip);
      log('go', { label: a.label, sent: { cmd: 'gripper', pct: a.nextGrip }, mock: false, solved: { jointsDeg: a.nextJ ?? null, tcpMmDeg: a.pose ?? null }, gate: { ok: res.ok, reasons: res.reason ? [res.reason] : [] } });
      if (!res.ok) { setGoing({ label: a.label, k: 0, n: 0, why: res.reason }); return false; }
    }
    setGoing(null);
    return true;
  };
  const onGhost = (pose, j) => onReplay?.(j ? { armJoints: j, ...(pose ? { tcpMmDeg: pose } : {}) } : null);
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
  const [steps, setSteps] = useState(() => makeSteps());
  // 좌표계 정본 — 없으면 터틀봇 자리를 못 옮긴다(결측=차단). 매 렌더 최신을 쓴다
  const userDef = state?.coordDefs?.user ?? null;
  const [solved, setSolved] = useState(null);      // [{jointsDeg, gate, reason}]
  const [contact, setContact] = useState(null);    // 접촉 층 — {legs, hitLegs, why} (`contact.js` · 브라우저 무조코)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // ── 컨베이어 한 사이클 (2026-09-06 · `docs/archive/GRILL-conveyor-twin-progresslog-2026-09-06.md`). 9칸이 풀리면 그 자세를
  //    되써서 「홈→정차 · 관측 · 싣기 · 앞으로 500 · 되돌아옴 · 관측 · 내리기 · 홈」을 **실시간 축**으로 돌린다
  //    (`Shared/data/sim/cycle.js` · IK 추가 호출 0). 시연이다 — 실기 근거가 아니다.
  //    9칸 전용 재생은 2026-09-06 밤에 없앴다 — 사이클 구간 목록이 그 9칸을 품고, 슬라이더도 부분집합이었다 (실기 담당자 「사이클만 남기면」).
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
      return buildCycle({ load: steps, solved, stop, userDef: userDef2, observe,
        loadAmr: observedRes?.obsIn ?? null, observed: observedRes?.obsBack ?? null, unloadSolved: observedRes?.unloadSolved ?? null });
    }
    // 열린 루프 — 명령 자리에서 푼 자세로 싣고 내린다. 터틀봇은 실제 자리에 서 있으니 어긋남이 그림으로 난다
    if (!openLoop) return { why: '열린 루프 자세를 푸는 중…' };
    if (openLoop.why) return { why: openLoop.why };
    return buildCycle({ load: openLoop.steps, solved: openLoop.solved, stop, userDef: userDef2, observe });
  }, [steps, solved, stop, userKey, observe, observeFix, observedRes, openLoop]);
  const acts = cycle && !cycle.why ? cycle.acts : null;
  const uFrom = useMemo(() => Object.fromEntries((unloadSteps(steps) ?? []).map((s) => [s.id, s.from])), [steps]);
  // 계측 훅 — 게이트가 구간 목록을 읽고 시각을 옮긴다(관측 칸에서 발자국이 초록인지 재려고)
  useEffect(() => {
    window.__actsChanges = (window.__actsChanges ?? 0) + 1;   // 진단 훅 — 사이클 정체(acts) 가 몇 번 바뀌었나. 재생 중 늘면 시계가 매 틱 재시작되는 병이다
    window.__cycleActs = acts ? acts.map((a) => ({ id: a.id, t0Ms: a.t0Ms, durMs: a.durMs, prevJ: a.prevJ ?? null, nextJ: a.nextJ ?? null })) : null;   // 관절 목표도 — 「왜 이 칸이 57초인가」를 밖에서 잰다
    window.__cycleSeek = (ms) => { setCyclePlaying(false); setCycleT(ms); };
  }, [acts]);

  // 고스트 주인 규칙 — **사이클이 주인일 때만** 지운다. 조준(ⓑ 자세 미리보기)이 세운 고스트를 9칸 재생성이 지우면
  // 「찾기가 끝나자 고스트가 사라진다」(2026-09-07 실기 · 실기 담당자 발견). `cycleTRef` 가 지금 주인이 누군지 말한다
  const stopCycle = () => { setCyclePlaying(false); setCycleT(null); if (cycleTRef.current != null) onReplay?.(null); };

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
  async function evaluateStop(candidate, sceneId) {
    // ⓪ 관측이 볼 도착 자리(실측 도착 오차 모델 · 랩에선 뎁스 검출값)로 9칸을 푼다 — 바구니 쪽 5칸만 정차 자리에 걸리고 판 쪽은 그대로다
    const obsIn = observedStop(candidate, AMR_HOME, { leg: 'in' });
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
      const cands = stopCandidates();
      const res = [];
      for (let k = 0; k < cands.length; k += 1) {
        setEvalNote(`정차 후보 ${k + 1}/${cands.length} 평가 중…`);
        res.push(await evaluateStop(cands[k], sceneId));            // eslint-disable-line no-await-in-loop
      }
      setEvalNote(null);
      setEvals(res);
      // 계측 훅 — 게이트·디버그가 후보별 판정(닿나·접촉 구간·시간·뻗음)을 읽는다
      window.__stopEvals = res.map((e) => ({ stop: stopLabel(e.stop), reachable: e.reachable, contactLegs: e.contactLegs, why: e.why,
        hits: (e.contact?.legs ?? []).filter((l) => l.hits.length).map((l) => `${l.from}→${l.to}: ${l.hits.join(', ')}`), dwellSec: e.dwellSec, reachMm: e.reachMm, contactWhy: e.contact?.why ?? null, observe: { carrier: !!e.observe?.carrier, amr: !!e.observe?.amr } }));
      applyChoice(res, priority);
      log('solve', { evals: window.__stopEvals, aimed });
    } catch (e) {
      setErr(String(e).slice(0, 120));
      setEvalNote(null);
    } finally { setBusy(false); }
  }

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
  useEffect(() => { if (stage === 1 && aimed.carrier) setStage(2); }, [aimed.carrier]);        // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (stage === 2 && planOk) setStage(3); }, [planOk]);                     // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCursor(0); }, [acts]);
  const nextAct = acts?.[cursor] ?? null;
  const goNext = async () => {
    if (!nextAct || going?.n) return;
    setCyclePlaying(false); setCycleT(Math.max(0, nextAct.t0Ms + nextAct.durMs - 1));     // 3D 는 그 칸 끝 자세를 먼저 보여준다(고스트 먼저)
    let ok = true;
    if (nextAct.kind === 'arm') ok = await goStep(nextAct);
    else log('go', { label: nextAct.label, sent: null, mock: isMock, drive: true, solved: null, gate: null });
    if (ok) setCursor((c) => c + 1);                                                       // 도착했을 때만 다음 칸으로
  };
  const firstBad = (solved ?? []).find((o) => o.gate && !o.gate.ok)?.gate?.reasons?.[0] ?? null;
  const lights = [
    { id: 'reach', label: '팔이 닿아요', ok: solved ? okCount === total : null,
      why: solved ? (okCount === total ? '9칸 전부 닿아요' : `${total - okCount}칸에 팔이 닿지 않아요 — 거치대를 판 안쪽으로 옮겨 보세요`) : '아직 계획 전' },
    { id: 'contact', label: '부딪히지 않아요', ok: contact ? (contact.why ? null : contact.hitLegs === 0) : null,
      why: !contact ? '아직 계획 전' : contact.why ? `재지 못했어요 — ${contact.why}` : contact.hitLegs === 0 ? '가는 길 어디서도 부딪히지 않아요' : `${contact.hitLegs}구간에서 부딪혀요 — 정차 자리를 바꿔 보세요 (자세히)` },
    { id: 'gate', label: '안전장치가 켜져 있어요', ok: solved ? gateOk === total : null,
      why: !solved ? '아직 계획 전' : gateOk === total ? '안전장치가 전부 확인됐어요' : (firstBad && /조건 26/.test(firstBad) ? '안전장치 확인이 안 됐어요 — 랩에서 로봇을 ARM 하면 켜져요 (집 목업에선 늘 이래요)' : (firstBad ?? '안전장치를 확인하지 못했어요')) },
  ];
  const stageBtn = (n, label, enabled) => (
    <button type="button" key={n} data-t={`sim-stage-${n}`} aria-current={stage === n ? 'step' : undefined} disabled={!enabled}
      onClick={() => setStage(n)}>{n} {label}{n === 1 && aimed.carrier ? ' ✓' : ''}{n === 2 && planOk ? ' ✓' : ''}</button>
  );

  return (
    <div className="sim">
      {/* 4단 마법사 (D194) — 절은 여전히 하나. 질문 하나 · 큰 버튼 하나 · 결과 한 문장. 실험 장치(사이클 재생·정차 후보·26칸·장부)는 「자세히」 안에 */}
      <Section id="sim-cycle" title="거치대를 집어 바구니에 — 네 단계" note="①② 는 화면에서만 · ③ 에서만 실기가 움직여요 · 목업이면 기록만">
        <nav className="wizard" data-t="sim-wizard" aria-label="단계">
          {stageBtn(1, '어디 있나', true)}{stageBtn(2, '할 수 있나', s2ok)}{stageBtn(3, '한 칸씩', s3ok)}{stageBtn(4, '기록', true)}
        </nav>

        {/* ── ① 어디 있나 ─────────────────────────────────────────────────────────── */}
        <section data-t="sim-stage" data-n="1" hidden={stage !== 1}>
          <h4>① 거치대가 어디 있나요?</h4>
          <AimBlock state={state} coarseOf={coarseOf} isMock={isMock} log={log} onGhost={onGhost}
            onGo={(j, label) => goStep({ label, nextJ: j, prevJ: state?.jointsDeg ?? null, prevGrip: null, nextGrip: null })}
            onFused={(target, fused) => setAimed((a) => (target === 'carrier' ? { ...a, carrier: fused } : { ...a, basket: fused ? { xMm: fused.user1Mm[0], yMm: fused.user1Mm[1], yawDeg: fused.yawDeg } : null }))} />
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
          <div className="row">
            <button type="button" className="big" data-t="sim-plan" onClick={solve} disabled={busy || !state?.connected}>
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
              <span>정차 자리</span>
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
            </div>
            <p className="hint" data-t="sim-stop-why">
              {evalNote ?? (evals
                ? <>{stopLabel(stop)} — {chooseStop(evals, priority)?.index === pick ? chooseStop(evals, priority)?.why : '사람이 골랐다'} · 후보 {evals.length} 중 되는 자리 {evals.filter((e) => e.reachable && !e.contactLegs).length}</>
                : <>({stop.xMm}, {stop.yMm}) · 요각 {stop.yawDeg}° — 「계획 세우기」가 후보 {stopCandidates().length}을 전부 평가해 고른다</>)}
            </p>
          </details>
        </section>

        {/* ── ③ 한 칸씩 ─────────────────────────────────────────────────────────────── */}
        <section data-t="sim-stage" data-n="3" hidden={stage !== 3}>
          <h4>③ 한 칸씩 보낼까요?</h4>
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
            <button type="button" className="big" data-t="sim-next" disabled={!acts || !nextAct || (!!going?.n && !going.why) || (!isMock && (!armed || !goConfirm || !speedOk))} onClick={goNext}
              title={!isMock && armed && !speedOk ? '전역 속도를 먼저 (위 「전역 30 으로」)' : (!isMock && !goConfirm ? '현장확인 체크 먼저' : '')}>
              {!acts ? '먼저 ② 계획을 세워요' : !nextAct ? '끝났어요 ✓' : (going?.n && !going.why ? `가는 중… 조각 ${going.k}/${going.n} (${Math.round(going.deg ?? 0)}°)` : `다음 칸 ▶  ${nextAct.label}`)}
            </button>
            <button type="button" className="stopbtn" data-t="sim-stop-btn" onClick={() => datasource.stop()}>■ 정지</button>
            {acts && cursor > 0 && <button type="button" onClick={() => { setCursor(0); stopCycle(); }}>처음부터</button>}
          </div>
          {going?.why && <p className="refusal" data-t="sim-go-why">{going.label} — {going.why}</p>}
          <p className="sentence" data-t="sim-next-status">
            {!acts ? '계획이 서면 여기서 한 칸씩 보내요.' : nextAct
              ? <>{cursor + 1}/{acts.length} · {nextAct.kind === 'arm' ? '팔이 움직여요' : '터틀봇 차례예요 — 터틀봇 탭에서 보내고 여기서 「다음」'}{cursor > 0 ? ` · 지난 칸 ${acts[cursor - 1].label} ${isMock ? '(목업: 기록만)' : '보냈어요'}` : ''}</>
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
                      <button type="button" data-t="sim-go-step" className="go" title={isMock ? '목업 — 안 보내고 기록만' : (!armed ? 'ARM 뒤에' : (!goConfirm ? '현장확인 칸을 먼저' : '이 칸의 관절각으로 moveJ (10%)'))}
                        disabled={!isMock && (!armed || !goConfirm || !!bad)} onClick={() => goStep(a)}>
                        {isMock ? '실기(목업·기록만)' : '실기'}
                      </button>
                    )}
                    {bad && <span className="refusal"> — {bad}</span>}
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
