// FR5 조작 엔트리. **탭이면 된다 — 라우터를 넣지 않는다** (TB·Dashboard 규칙 미러).
// 패널 4개 + 상시 안전 바 (FR5-IMPLEMENTATION-PLAN §화면). P1 Live · P2 조종권/jog 까지 산다.
//
// **3D 와 조작대는 여기 산다** (계획 §레이아웃 · 2026-08-03 확정). 탭은 오른쪽 패널만
// 갈아치운다 — 쌍둥이를 패널마다 두면 탭을 옮길 때 재마운트돼 카메라 각도가 리셋되고,
// 조작대가 Live 안에 있으면 Teach 에서 자세를 만들 때마다 탭을 왕복하게 된다.
import './main.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { datasource } from '../data/datasource/index.js';
import { ControlDock } from '../features/control/ControlDock.jsx';
import { RobotTwin } from '../features/live/RobotTwin.jsx';
import { CamView } from '../features/live/CamView.jsx';
import { DepthView } from '../features/live/DepthView.jsx';
import { LivePanel } from '../features/live/LivePanel.jsx';
import { ProgramPanel } from '../features/program/ProgramPanel.jsx';
import { TeachPanel } from '../features/teach/TeachPanel.jsx';
import { SimPanel } from '../features/sim/SimPanel.jsx';
import { CARRIER } from '@fr5/shared/data/props.js';
import { AMR_HOME } from '@fr5/shared/data/workcell.js';
import { TbPanel } from '../features/amr/TbPanel.jsx';
import '../features/amr/amr.css';
import { useFollowSim } from '../features/live/useFollowSim.js';

// **Optimize 는 없다** (D74) — 후보 비교는 PRD 범위 밖이고 생산성 비교의 주인은 맵 편집기다.
const PANELS = [
  ['live', 'Live', LivePanel],
  ['teach', 'Teach', TeachPanel],   // 사다리 2 — 지점(점)과 궤적(선)
  ['program', 'Program', ProgramPanel],   // 사다리 3 — 순서로 엮어 승인·한 단계씩
  // History 탭은 **없다** (D182 · 2026-09-05 실기 담당자 「제거」) — 기록은 되감기(시뮬레이션 탭 안
  // 「주행 되감기」)와 DB 가 맡는다. 빈 탭을 자리표시자로 두지 않는다.
  // 「시뮬레이션」 — 거치대를 집어 터틀봇 바구니에 넣는 동작을 **화면에서만** 돌린다 (2026-08-31).
  // ⛔ 실기는 안 움직인다 — 관절각은 브리지 `/ik` 가 컨트롤러에 **묻기만** 해서 받은 값이다.
  // ⛔ **주행 되감기를 지우지 않았다** — 실측 기록을 보는 유일한 창구라 이 탭 안에 산다.
  ['amr', '시뮬레이션', SimPanel],
  // 「터틀봇」 — 옛 터틀봇 웹앱의 주행 탭이 여기로 왔다 (D182). 맵 캔버스는 왼쪽 3D 가 대신한다.
  ['tb', '터틀봇', TbPanel],
];

// 프레임 축 스위치 — **제어에 실제로 쓰는 기준이 이 셋이다** (베이스 + 사용자/작업물 + 툴).
// 링크별 축은 개발 콘솔(`__twin.axes`)에 남긴다: 목록이 열 개가 되면 아무도 안 쓴다.
// 규약은 `SHARED-CORE.md` §프레임 축 — 계측 전용이고 켜지 않으면 객체를 만들지도 않는다.
const AXES = [
  ['base_link', '베이스', '로봇 베이스 원점이에요 · 3D 와 안전 게이트가 쓰는 기준이에요'],
  ['user1', '사용자1', '화면의 손끝 숫자가 재어지는 원점이에요. 베이스에서 떨어진 만큼을 선으로 이어요'],
  ['tcp', '손끝', 'TCP · 핑거 끝(플랜지 +135mm)이에요. 접근 방향이 +Z 예요'],
];

// 관절 → 그 관절이 **돌리는 자식 링크** (URDF 가 정본 — `SHARED-CORE.md` §프레임 축).
// 여섯 다 `axis="0 0 1"` 이라 축은 자식 링크의 로컬 Z 다 → **파랑이 그 관절이 도는 축**이다.
const JOINT_LINKS = ['shoulder_link', 'upperarm_link', 'forearm_link',
  'wrist1_link', 'wrist2_link', 'wrist3_link'];

const EMPTY = { connected: false, phase: 'DISCONNECTED', enabled: false, mode: 1,
  safety: { emergencyStop: false, collisionDetected: false }, owner: null, robotId: null };

// phase 는 영문 그대로 두고 **한글을 덧붙인다** (감사 2026-08-06 P1). 지우면 처음 보는
// 사람이 `OBSERVE_ONLY` 를 못 읽고, 실렌더 게이트도 이 enum 을 본다 — 둘 다 살린다.
const PHASE_KO = {
  DISCONNECTED: '연결 안 됨', PREFLIGHT: '점검 중', OBSERVE_ONLY: '보기만 함',
  OWNER_HELD: '조종권 잡힘', ARMED: '움직일 수 있음', EXECUTING: '실행 중',
  FAIL_CLOSED: '막혔음',
};

// 상시 안전 바 — 어느 패널에서도 사라지지 않는다 (계획 §화면). STOP 은 항상 여기 있다.
function SafetyBar({ s, who }) {
  // 조종권은 이름이 아니라 토큰이 증명한다 (D55) — 이름만 보면 새로고침 뒤 갇힌다
  const mine = !!who && s.owner === who && datasource.hasOwnerToken();
  const manual = s.mode === 1;
  const items = [
    ['연결', s.connected ? s.robotId : '없음', s.connected ? 'ok' : 'off'],
    ['단계', `${s.phase} ${PHASE_KO[s.phase] ?? ''}`.trim(),
      s.phase === 'FAIL_CLOSED' ? 'danger'
        : s.phase === 'ARMED' || s.phase === 'EXECUTING' ? 'warn'
          : s.phase === 'OBSERVE_ONLY' || s.phase === 'OWNER_HELD' ? 'ok' : 'off'],
    ['조종권', s.owner ?? '아무도 안 잡음', s.owner ? 'warn' : 'off'],
    ['서보', s.enabled ? 'ON 켜짐' : 'OFF 꺼짐', s.enabled ? 'warn' : 'off'],
    // 수동은 경고색이다 — 그 동안 우리 조그·moveJ 가 전부 거부된다
    ['모드', manual ? 'manual 수동(펜던트)' : 'auto 자동(웹)', manual ? 'warn' : 'off'],
    ['비상정지', s.safety.emergencyStop ? '작동' : '정상', s.safety.emergencyStop ? 'danger' : 'ok'],
    ['충돌', s.safety.collisionDetected ? '감지' : '정상', s.safety.collisionDetected ? 'danger' : 'ok'],
    // 계획 §화면이 기록을 바 항목으로 지정했다 — 칸은 지키되 `—` 대신 **사실을 적는다**
    // (감사 2026-08-06 P2). 영구 대시는 자리만 먹고 아무 말도 안 했다. History(사다리 4)가
    // 살면 여기가 「기록 중」 을 말한다.
    ['기록', '안 함', 'off'],
  ];
  return (
    <div className="safetybar" data-t="safetybar">
      {items.map(([label, value, tone]) => (
        <span key={label} className="safeitem" data-t="safeitem" data-tone={tone}>
          <b>{label}</b> {value}
        </span>
      ))}
      {/* ARM 이 SetMode(0) 을 부르므로 한 번 ARM 하면 펜던트가 잠긴다 (D72).
          드래그 티칭은 서보가 켜져 있어야 되므로 ARMED 에서도 넘길 수 있어야 한다 */}
      <button type="button" className="modetoggle" data-t="mode-toggle" disabled={!mine}
        title={mine ? '' : '조종권을 잡아야 바꿀 수 있다'}
        onClick={() => datasource.setMode(!manual)}>
        {manual ? '자동으로' : '수동으로'}
      </button>
      {/* 제3원칙 — stop 은 항상 통과한다. 어느 화면에서든 한 번에 누른다 */}
      {/* STOP 하나가 둘 다 세운다 (TB-CONTRACT ④ · D182) — 팔 stop + 터틀봇 estop 전부.
          터틀봇 주소를 모르면 그쪽은 사유만 돌아오고 팔은 그대로 선다 */}
      <button type="button" className="estop" data-t="estop"
        onClick={() => { datasource.stop(); datasource.tb?.estopAll?.(); }}>STOP</button>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState('live');
  const [state, setState] = useState(EMPTY);
  // 3D 가 무엇을 그리나. null 이면 실물이고, 패널이 채우면 미리보기·되감기다.
  // **실물이 아닐 때는 화면이 그렇게 말한다** — 미리보기를 실물로 오인하면 위치를 오판한다.
  // **계산한 자세를 화면에 겹쳐 본다** — `?pose=j1,…,j6` (도).
  //
  // 왜 필요했나 — `scripts/dev/observe-map.py` 같은 도구가 「이 관절값이 최적」이라고 답해도
  // 그걸 **눈으로 확인할 통로가 없었다.** 저장된 교시 지점에서만 미리보기가 열려 있었다.
  // 이 한 줄로 어떤 계산 결과든 실기를 안 움직이고 먼저 본다 — 그게 이 화면의 규약이다
  // (「미리보기를 실물로 오인하면 위치를 오판한다」 · 아래 `view` 주석).
  //
  // ⛔ **명령이 아니다.** 그리기만 한다. 실기를 그 자세로 보내는 것은 사람이 조그·지점으로 한다.
  const [view, setView] = useState(() => {
    const q = new URLSearchParams(location.search).get('pose');
    if (!q) return null;
    const j = q.split(',').map(Number);
    return j.length === 6 && j.every(Number.isFinite) ? { jointsDeg: j, from: '?pose' } : null;
  });
  const [axes, setAxes] = useState([]);   // 켠 프레임 축. 기본 전부 꺼짐
  // 조작대에서 **가리키는 중인** 관절. 저장하지 않는다 — 떼면 사라진다 (계약 §프레임 축)
  const [hoverJoint, setHoverJoint] = useState(null);
  // 조종권 신원 — 브리지의 hello 세션 바인딩에 대응한다 (API-CONTRACT §명령)
  const [who, setWho] = useState(() => localStorage.getItem('fr5-who') ?? '');
  useEffect(() => datasource.subscribeState(setState), []);
  // 터틀봇 자세 — 트윈이 그린다. 조작은 「터틀봇」 탭(`datasource.tb` · D182).
  // 주소를 안 줬으면(`?tb=` 없음) 구독 자체를 안 하고 `null` 이라 트윈이 홈에 세운다.
  const [amrPose, setAmrPose] = useState(null);
  // 되감기 — 주행 기록을 고르면 채워진다. **채워진 동안은 실물보다 이쪽이 이긴다**
  // (`view` 와 같은 태도: 실물이 아닐 때는 화면이 그렇게 말한다).
  const [replay, setReplay] = useState(null);
  useEffect(() => datasource.subscribeTbPose(setAmrPose), []);
  // 추종 시뮬레이션 — **화면에서만** 팔이 표적을 따라간다 (실기는 안 움직인다).
  // 되감기 중에는 끈다 — 그때는 「그 주행의 그때 자세」가 고스트의 주인이다
  const [followSim, setFollowSim] = useState(false);
  // 거치대 입력 (phase 4) — 판 위 클릭으로 받은 user1 (x, y). **가정**이다. 실측 표적(색 검출)이 있으면 그것이 이긴다
  const [carrierInput, setCarrierInput] = useState(null);
  // 시뮬 탭이 **직접 읽은** 색 검출·융합 자리(2026-09-07) — 실기 프로필은 `follow.target` 이 odom 이라 `measuredCarrier` 가 비어 트윈에 거치대가 안 그려졌다
  const [carrierSeen, setCarrierSeen] = useState(null);   // { user1Mm:[x,y,zTop], yawDeg|null, source }
  const [pickCarrier, setPickCarrier] = useState(false);
  const measuredCarrier = state.follow?.target?.source === 'color' ? (state.follow.target.user1Mm ?? null) : null;
  const sim = useFollowSim(state, followSim && !replay);
  // ── 글로벌 PiP 고스트의 주인 (D195·D196 · `rnd/PIP-GHOST-CONVERGE-LOOP-2026-09-07.md` D1·D2).
  //    영상 = 실기(불투명)라 반투명 후보는 **사실(브리지가 보낸 목표) > 되감기 > 추종 시뮬 > 미리보기**.
  //    트윈의 `ghostJointsDeg` 와 후보 집합은 같지만 **함수를 합치지 않는다** — 트윈은 미리보기 때
  //    불투명 몸이 계획이고 고스트가 실물(반전)이라 같은 사슬을 쓰면 뜻이 뒤집힌다.
  const mt = state.motionTarget;
  const goingTarget = mt && mt.doneAt == null && Array.isArray(mt.jointsDeg) && mt.jointsDeg.length >= 6 ? mt.jointsDeg : null;
  const pipPlan = replay?.armJoints ?? sim?.jointsDeg ?? view?.jointsDeg ?? null;
  // 킬-실험 스위치(개발용 · 크럭스 「손끝까지 사슬이 실영상에 얹히나」) — `?ghost=live` 면 지금 관절각을 고스트로 세운다.
  //   실물과 겹치면 사슬 OK · 어긋나면 그 픽셀 차가 답이다. 명령은 0 이고 팔은 안 움직인다
  const ghostLiveCheck = new URLSearchParams(location.search).get('ghost') === 'live';
  const pipGhost = ghostLiveCheck && Array.isArray(state.jointsDeg) ? { kind: 'live-check', jointsDeg: state.jointsDeg }
    : goingTarget ? { kind: 'target', jointsDeg: goingTarget }
      : pipPlan ? { kind: 'plan', jointsDeg: pipPlan } : null;
  useEffect(() => { datasource.setWho(who); }, [who]);
  // 검증용 읽기 훅 (TB 의 `window.TB_TABS` 와 같은 규약). 관절 표는 Live 패널에만 있어서
  // 다른 탭에 선 채로는 값을 볼 데가 없다 — 실렌더 검증이 여기서 읽는다. **쓰기는 없다.**
  useEffect(() => { window.FR5_STATE = state; }, [state]);
  // 터틀봇 클라이언트도 같은 규약으로 — `tb-web-verify.mjs` 가 거부 규칙을 ground truth 로 묻는다 (D182)
  useEffect(() => { window.FR5_TB = datasource.tb; }, []);
  // 추종 시뮬도 같은 규약으로 내놓는다 — **고스트가 왜 안 움직이나**를 밖에서 물을 수
  // 있어야 한다. 2026-09-04 에 「안 움직인다」를 화면만 보고는 못 갈랐다:
  // 표적이 안 왔나 · IK 가 실패했나 · 되감기가 고스트를 가져갔나가 전부 같은 그림이다.
  useEffect(() => { window.FR5_SIM = { on: followSim, replay: Boolean(replay), sim }; },
    [followSim, replay, sim]);

  // 가리키는 관절의 링크를 **켠 축에 얹는다** — 이미 켜져 있으면 그대로 둔다.
  // 새 상태가 아니라 파생값이라 떼면 저절로 사라진다
  const hoverLink = hoverJoint === null ? null : JOINT_LINKS[hoverJoint];
  const shownAxes = hoverLink && !axes.includes(hoverLink) ? [...axes, hoverLink] : axes;

  const changeWho = (name) => {
    setWho(name);
    localStorage.setItem('fr5-who', name);
  };

  return (
    <>
      <header>
        <h1>FR5 조작</h1>
        <span className="sub">FAIRINO FR5 협동로봇</span>
        {/* 허브 — 고리 일곱(브리지·로봇·카메라·뎁스·폰·정합·터틀봇)을 한 장에 (phase 3 · 2026-09-05) */}
        <a className="hublink" href="./hub.html" title="지금 뭐가 붙어 있나 — 읽기만 한다">고리</a>
        {/* 이름이 첫 관문이다 — 비어 있으면 그 뒤 전부가 막힌다. 그 사실이 툴팁에만 있어서
            처음 온 사람이 헤더 구석을 못 찾았다 (감사 2026-08-06 P1). 이제 칸이 스스로 말한다 */}
        <label className="who" data-t="who" data-need={String(!who.trim())}>이름
          <input value={who} placeholder="여기에 이름부터" onChange={(e) => changeWho(e.target.value)} />
        </label>
        {/* 출처 배지 — 목업을 실기로 오인하는 것이 가장 비싼 사고다 (SR_24) */}
        <span className="source" data-t="source" data-src={state.robotId?.includes('mock') ? 'mock' : state.connected ? 'real' : 'none'}>
          {state.connected ? state.robotId : '미연결'}
        </span>
      </header>
      <SafetyBar s={state} who={who} />
      <main className="workspace">
        {/* 3D 는 고정이다 — 탭이 바뀌어도 재마운트되지 않아 카메라 각도가 유지된다 */}
        <section className="stage">
          {/* 고스트 — 미리보기(view) 중일 때만 실물 현재 자세를 반투명으로 겹친다. 실기를 안
              쳐다봐도 "지금 어디 ↔ 가면 어디"가 한 화면에 (2026-08-07 요청). 미연결이면
              보여줄 실물 자세가 없어 안 그린다 */}
          <RobotTwin jointsDeg={view?.jointsDeg ?? state.jointsDeg ?? [0, 0, 0, 0, 0, 0]}
            // 손목 끝 LED — 매뉴얼 §The end LED 그대로: 빨강 오류 · 초록 수동 · 파랑 자동. 미연결이면 꺼짐
            ledColor={!state.connected ? null
              : (state.phase === 'FAIL_CLOSED' || state.safety?.emergencyStop || state.safety?.collisionDetected) ? 0xe03b3b
                : state.mode === 1 ? 0x2ecc71 : 0x3b82f6}
            gripperPct={view?.gripperPct ?? state.gripper?.pct ?? null}
            ghostJointsDeg={
              // 고스트의 주인은 **하나뿐이다.** 되감기 > 추종 시뮬 > 미리보기 순 —
              // 앞의 것이 켜져 있으면 뒤는 안 그린다(둘이 겹치면 어느 쪽인지 아무도 모른다)
              replay?.armJoints
              ?? sim?.jointsDeg
              ?? (view && state.connected ? (state.jointsDeg ?? null) : null)
            }
            ghostGripperPct={
              // 되감기·시뮬이 그리퍼 값을 주면 그것이 이긴다 — 고스트의 주인 순서와 같다
              replay?.gripperPct ?? (view && state.connected ? (state.gripper?.pct ?? null) : null)
            }
            carrierHeldTcp={replay?.carrierHeldTcp ?? null}
            carrierInHand={replay?.carrierInHand ?? false}
            carrierAtMm={
              // 지금 본 거치대 자리 — **색 검출일 때만** 넘긴다. 태그 추종이면 그 자리는
              // 태그이지 물건이 아니라, 그걸로 물건을 그리면 화면이 거짓말을 한다.
              // 실측이 없고 사람이 고른 자리(가정)가 있으면 그것을 그린다 — 반투명 그대로(D128). 윗면 중심 = 그려진 상판 + 거치대 높이
              carrierSeen?.user1Mm ?? measuredCarrier ?? (carrierInput ? [carrierInput[0], carrierInput[1], AMR_HOME.topZMm + CARRIER.hMm] : null)
            }
            carrierYawDeg={carrierSeen?.yawDeg ?? null}
            pickCarrier={pickCarrier}
            onPickCarrier={(xy) => { setCarrierInput(xy); setPickCarrier(false); }}
            workspace={state.workspace ?? null}
            coordDefs={state.coordDefs ?? null}
            amrPose={replay?.pose ?? amrPose}
            amrTrail={replay?.trail ?? null}
            amrDriftPose={replay?.driftPose ?? null}
            amrIsReplay={Boolean(replay)}
            tcpMmDeg={state.tcpMmDeg ?? null}
            // 가상 손끝 — 사이클·9칸 재생이 손끝 자세를 주면 시야 발자국이 **고스트의** 카메라로 그려진다
            // (2026-09-06 · 전엔 이 prop 을 아무도 안 넘겨 발자국이 늘 실물 자세였다)
            simTcpMmDeg={replay?.tcpMmDeg ?? null}
            handEye={state.handEye ?? null}
            axesFrames={shownAxes} />
          {/* 추종 시뮬 — **3D 위에 둔다** (축 스위치와 같은 이유: 탭을 바꿔도 켜진 채 남는다).
              ⛔ **켜도 실기는 안 움직인다.** 브리지 `/ik` 는 컨트롤러에 묻기만 한다 —
              그 사실을 버튼이 스스로 말한다(조용한 시뮬레이션이 제일 위험하다). */}
          <div className="followsw" data-t="followsim">
            <button type="button" aria-pressed={followSim}
              disabled={!state.connected || Boolean(replay)}
              title={replay ? '되감는 중에는 고스트가 그 주행 자세다' : '표적을 따라가는 팔을 화면에서만 그린다'}
              onClick={() => setFollowSim((v) => !v)}>
              추종 시뮬 {followSim ? '켬' : '끔'}
            </button>
            {followSim && (
              <p className="follownote" data-t="followsim-note">
                {!state.follow?.target
                  ? (sim?.jointsDeg
                    ? <b className="bad">표적을 잠깐 놓쳤다 — 고스트는 <b>마지막 자리</b>다</b>
                    : <b className="bad">표적을 못 본다 — 글로벌캠이 태그를 놓쳤다</b>)
                  : sim?.jointsDeg
                    ? <>표적 나이 {state.follow.target.ageS}s · 손끝 목표 (
                        {sim.tcpMmDeg.slice(0, 3).map((v) => Math.round(v)).join(', ')}) mm
                        {sim.gate?.ok === false && <b className="bad"> · 게이트 거부: {sim.gate.reasons?.[0]}</b>}</>
                    : <b className="bad">못 푼다 — {sim?.why ?? '푸는 중…'}</b>}
                <span className="hint"> 실기는 움직이지 않아요.</span>
              </p>
            )}
          </div>
          {/* 축 스위치 — **3D 위에 둔다.** 탭 안에 두면 탭을 바꿨을 때 축은 켜진 채 스위치가
              사라진다 (3D 는 탭 밖에 상주한다 — 위 주석). 자리는 좌상단: 아래는 `.twinnote`,
              우상단은 카메라 PiP, 가운데는 궤도 조작이 쓴다.
              `사용자1` 은 실기 `coordDefs.user` 가 있어야 세울 수 있다 — 없으면 못 누른다 */}
          <div className="axessw" data-t="axes">
            <div className="axesrow">
              {AXES.map(([name, label, tip]) => (
                <button key={name} type="button" data-t="axesbtn" data-axis={name}
                  aria-pressed={axes.includes(name)} title={tip}
                  disabled={name === 'user1' && !state.coordDefs?.user}
                  onClick={() => setAxes((a) => (a.includes(name)
                    ? a.filter((n) => n !== name) : [...a, name]))}>
                  {label}
                </button>
              ))}
            </div>
            {/* 색 안내 — **켰을 때만 뜬다.** 안 켠 사람에게 설명할 것이 없고, 3D 위라 자리가
                귀하다. 축 길이를 같이 적는 이유는 그것이 **자를 겸하기 때문**이다
                (`SHARED-CORE.md` §프레임 축 — 축이 팔보다 크면 1000배 사고다) */}
            {shownAxes.length > 0 && (
              <p className="axeslegend" data-t="axes-legend">
                <span className="ax ax-x">X</span>
                <span className="ax ax-y">Y</span>
                <span className="ax ax-z">Z</span>
                <span>축 하나 = 100mm</span>
                {axes.includes('user1') && state.coordDefs?.user && (
                  <span>· 파란 선 = 베이스↔사용자1{' '}
                    {Math.round(Math.hypot(...state.coordDefs.user.slice(0, 3).map(Number)))}mm
                  </span>
                )}
                {/* 가리키는 중일 때만 — 여섯 관절 다 자식 링크의 로컬 Z 를 돈다 */}
                {hoverLink && (
                  <span data-t="axes-hover">· <b>j{hoverJoint + 1}</b> → {hoverLink} ·{' '}
                    <b className="ax-z">파랑 Z</b> 가 도는 축
                  </span>
                )}
              </p>
            )}
          </div>
          {/* 실영상도 3D 와 같이 탭 밖이다 — 패널 안이면 탭마다 스트림이 끊긴다.
              **무리로 묶는다** (2026-08-07) — 뎁스가 붙으면서 둘이 세로로 쌓이는데,
              각자 absolute 이면 아래 것의 top 을 위 것의 높이(사람이 끌어서 바꾼다)로
              계산해야 한다. 자리는 `.campips` 가 들고 카드는 순서대로 놓인다 */}
          <div className="campips">
            {/* 판정면 겹치기가 게이트 값을 그대로 쓴다 — 화면이 사본을 안 만든다 */}
            <CamView workspace={state.workspace ?? null} coordDefs={state.coordDefs ?? null} ghost={pipGhost} />
            {/* 글로벌(작업대 전체)과 손목(mm 거리)은 대체재가 아니라 분업이다 —
                탭으로 하나만 고르게 하지 않는다. 근거 브리프는 2026-08-11 에 반증돼 보관으로
                갔다 (`docs/archive/global-camera-hud-brief-superseded-2026-08-11.md` §10.5) —
                **이 분업 판단만 남는다** */}
            <DepthView handEye={state.handEye} />
          </div>
          <p className="twinnote" data-t="twin-note" data-live={String(!view)}>
            {/* 되감기(실측 기록)와 시뮬(그림)을 한 글자로 뭉개지 않는다 — 터틀봇 자리(`pose`)가 있을 때만 「되감기/시연 자리」다 (감사 2026-09-06 F2) */}
            {view?.label ?? (replay
              ? (replay.pose ? '실물 자세 · 터틀봇은 되감기/시연 자리(반투명)' : '실물 자세 · 반투명 팔은 시뮬(실기 아님)')
              : '실물 자세')}
            {view && state.connected && <span className="mm"> · 반투명은 지금 실물 자리</span>}
          </p>
        </section>
        <aside className="side">
          {/* 탭 — `role` 이 있어야 `aria-selected` 가 스크린리더에 닿는다 (UX 감사 2026-09-05) */}
          <nav role="tablist" aria-label="패널">
            {PANELS.map(([id, label, Comp]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} disabled={!Comp}
                title={Comp ? undefined : '아직 안 만들었어요'}
                onClick={() => Comp && setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="panelbox">{(() => {
            const Panel = PANELS.find(([id]) => id === tab)?.[2] ?? LivePanel;
            return <Panel state={state} who={who} onView={setView} onReplay={setReplay}
              followSim={followSim} onFollowSim={setFollowSim}
              carrierInput={carrierInput} measuredCarrier={measuredCarrier} onCarrierSeen={setCarrierSeen}
              pickCarrier={pickCarrier} onPickCarrier={setPickCarrier} onClearInput={() => setCarrierInput(null)} />;
          })()}</div>
          {/* 조작대는 어느 탭에서도 자리를 지킨다 (계획 §레이아웃) */}
          <ControlDock state={state} who={who} onHoverJoint={setHoverJoint} />
        </aside>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
