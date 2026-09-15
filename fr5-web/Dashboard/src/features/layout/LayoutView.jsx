// 배치안 3D 뷰 — **3D 는 React 밖에서 산다.** React 는 붙일 자리와 생명주기만 준다.
//
// R3F 를 쓰지 않는 이유 (D17): `Shared/view3d/` 는 바닐라 three 이고 AR 과 같이 쓴다.
// R3F 로 가면 로봇 로딩 경로가 둘이 되고, 그게 배치가 갈라지는 두 번째 경로다.
//
// **효과를 둘로 나눈다.** 하나로 두면 물건을 하나 옮길 때마다 `layout` 이 새 객체가 되어
// 무대가 통째로 다시 만들어지고 **카메라가 기본 시점으로 튄다** — 편집 중에 이러면 못 쓴다.
//   ① 무대(렌더러·카메라·조명) = 마운트에 한 번. 카메라는 여기 살아 있다
//   ② 내용물(방·가구) = 배치안이 바뀔 때만. 시점은 건드리지 않는다
// 시점 맞추기(`frame`)는 **배치안 자체가 바뀐 첫 순간에만** 한다 (A↔B 전환·최초 진입).

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { createStage } from '@fr5/shared/view3d/lab/stage.js';
import { createLayoutView } from '@fr5/shared/view3d/lab/layout-view.js';
import { createInteraction } from '@fr5/shared/view3d/lab/interaction.js';
import { SIZE_MM, SIZE_LABEL, SIZE_RANGE_MM, SIZE_AXIS } from '@fr5/shared/data/layout/catalog.js';
import { stateAt, cycleSecOf } from '@fr5/shared/data/timeline/timeline.js';
import { sizeMmOf } from '@fr5/shared/view3d/parts.js';
import { loadConfig, loadRobot, setJointsDeg, mountRobotYUp } from '@fr5/shared/view3d/robot.js';
import { PRESET_POSES, CARRY_BY_ARM, poseFor, easeAngle } from '@fr5/shared/data/motion/poses.js';
import { solveReach } from '@fr5/shared/view3d/reach.js';
import { createJointGizmo } from '@fr5/shared/view3d/lab/joint-gizmo.js';
import { JOINTS, JOINT_LIMITS_DEG } from '@fr5/shared/data/motion/limits.js';
import { ROLES } from '@fr5/shared/data/scenario/schema.js';
import { pathLengthMm, nearestU } from '@fr5/shared/data/layout/schema.js';
import { subscribeRobotState } from '@fr5/shared/data/datasource/state-stream.js';
import { toFrame, yawToFrame } from '@fr5/shared/data/frames.js';
import { rememberedHost } from '@fr5/shared/data/datasource/remembered-host.js';

// 터틀봇 브리지 주소. **빌드에 박지 않는다** — 파이가 DHCP 라 IP 가 바뀌고, 대시보드는
// 브리지가 서빙하지 않아 `location.host` 가 곧 브리지인 FR5 와 사정이 다르다
// (`state-stream.js` §주소는 same-origin 이 아닐 수 있다).
//
// `?tb=192.168.30.15:5056` 을 한 번 주면 기억한다. `?tb=` (빈 값) 이면 잊는다 —
// `?cam=`·`?depth=` 와 **같은 규약**이다. 새 규약을 만들지 않는다.
// 아무도 안 줬으면 `null` = "주소를 모른다" 이고, 그건 고장이 아니라 안 켠 것이다.
// ⛔ **저장소를 여기서 만지지 않는다** (2026-08-28 · `check/datasource.sh` §① 이 잡았다).
// 규약이 화면마다 한 벌씩 생기면 `?tb=` 가 화면에 따라 다르게 동작하고, 그러면 사람이
// 「주소를 줬는데 왜 안 되지」를 화면별로 다시 배운다. 정본은 datasource 한 곳이다.
const tbHostValue = rememberedHost('tb', 'fr5.tbHost');
const tbHost = () => tbHostValue;

// 자세·보간은 `Shared/data/motion/poses.js` 가 든다 — **AR·게이트도 봐야 하는 데이터**라
// React 파일에 두지 않는다 (2026-08-04 에 여기서 내렸다).

/**
 * FR5 팔 — **한 번만 받아서 돌려 쓴다.**
 *
 * 물건 하나를 옮길 때마다 `createLayoutView` 가 새로 만들어진다. 그때마다 URDF·STL 6MB 를
 * 다시 받으면 편집이 멈춘다. 그래서 모듈 수준에 한 개만 두고 **부모만 갈아 끼운다.**
 *
 * ⚠ `view.dispose()` 는 트리를 훑으며 지오메트리를 지운다 — **떼어낸 뒤에 부른다.**
 * 안 그러면 두 번째 편집부터 팔이 빈 껍데기가 된다.
 *
 * 실패해도 조용히 없는 채로 간다 — 배치 판단의 근거는 도달 링이지 팔 모형이 아니다.
 */
const armCache = new Map();      // armId → { promise, holder, robot }

function getArm(key) {
  let e = armCache.get(key);
  if (e) return e;
  const { gripper } = loadConfig();
  e = { promise: null, holder: null, robot: null };
  e.promise = loadRobot({
    urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf',
    gripperCfg: gripper,
    gripperDir: '/PGEA_100_40/',
  }).then(({ robot }) => {
    setJointsDeg(robot, PRESET_POSES.home);
    // Z-up→Y-up 은 `Shared` 한 곳에서만 한다 (`mountRobotYUp`).
    const holder = mountRobotYUp(robot);
    // **피킹에서 뺀다.** 팔은 받침대로 고른다 — URDF 를 피킹에 두면 뒤가 다 가려진다
    holder.traverse((o) => { o.raycast = () => {}; });
    e.holder = holder; e.robot = robot;
    return holder;
  }).catch((err) => {
    // **조용히 실패하지 않는다** (D15·D18). 화면은 계속 돌지만 이유는 콘솔에 남긴다.
    console.warn('FR5 팔을 못 불러왔습니다. 도달 링만 그립니다:', err?.message ?? err);
    return null;
  });
  armCache.set(key, e);
  return e;
}

/**
 * 숫자 한 칸. **끌기는 100mm 격자에 붙어 그 사이 값을 못 넣는다** — 그래서 이게 있다.
 *
 * 규칙 하나가 전부다 — **타이핑 중에는 입력칸 값을 절대 되쓰지 않는다.**
 * `8` 을 치고 `0` 을 치려는 순간 화면이 `8` 을 지우면 못 쓴다.
 * (AR 의 `features/ui/number-pair.js` 가 같은 버그를 고치며 얻은 규칙이다.
 *  그쪽은 바닐라 DOM + 슬라이더 쌍이라 코드는 못 가져온다 — 규칙만 가져왔다.)
 * 자르기·격자 맞추기는 **손을 뗄 때**(`blur`) 한 번만 한다.
 */
function NumBox({ label, value, min, max, step, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  const [typing, setTyping] = useState(false);
  // 끌어서 값이 바뀌거나 고른 물건이 바뀌면 따라간다 — **타이핑 중이 아닐 때만**
  useEffect(() => { if (!typing) setDraft(String(value)); }, [value, typing]);

  const commit = () => {
    const n = Number(draft.trim());
    setTyping(false);                       // 어느 경우든 화면은 실제 값으로 돌아온다
    if (draft.trim() === '' || !Number.isFinite(n)) return;
    const v = Math.min(max, Math.max(min, Math.round(n / step) * step));
    if (v !== value) onCommit(v);
  };

  return (
    <label className="numbox">
      <span>{label}</span>
      <input
        type="number" value={draft} step={step} min={min} max={max}
        onChange={(e) => { setTyping(true); setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { setTyping(false); e.currentTarget.blur(); }
        }}
      />
    </label>
  );
}

// 우클릭 메뉴 항목. **단축키를 같이 적는다** — 메뉴가 단축키를 가르치는 자리다.
const MENU = [
  { id: 'dup',  label: '복제',      key: 'Ctrl+D' },
  { id: 'rot',  label: '90° 회전',  key: 'R' },
  { id: 'undo', label: '되돌리기',  key: 'Ctrl+Z' },
  { id: 'del',  label: '삭제',      key: 'Del', danger: true },
];

// 사건 이름 → 화면 글자. **읽는 사람은 개발자가 아니다.**
// 계약의 `event` 는 자유 문자열이라 모르는 이름은 그대로 보여준다 (화면이 안 죽는다).
//
// ⛔ **말투는 화면 전체가 해요체 하나다** (2026-08-13 전수조사). 여기가 한다체(「집는다」)이고
//    바로 옆 팔레트가 해요체(「켤 수 있어요」)라 한 화면에 두 말투가 섞여 있었다.
// ⛔ **`j6` 같은 내부 이름을 화면에 안 낸다** — 읽을 수 있는 사람은 우리뿐이다
//    (토스 §Casual Concept · 2026-08-13 전수조사 — evidence 문서는 커밋 안 돼 인용을 걷었다).
const EVENT_LABEL = {
  haul: '로봇차가 팔레트로 가요', pick: '팔레트에서 집어요', feed: '컨베이어에 올려요', move: '컨베이어로 옮겨요',
  hold: '리프터가 공중에 들어요', fetch: '신관을 가지러 가요', join: '손목을 돌려 신관을 끼워요',
  hoist: '크레인이 들어요', drop: '배출 컨베이어에 내려요', out: '실험실 밖으로 나가요',
};

/**
 * 사건 시각이 붙는 격자(초). 소품이 100mm 에 붙는 것과 같은 발상이다.
 *
 * **실수로 생기는 편집을 막는 것도 이 격자다.** 소품에는 끌기 문턱(`SLOP_PX = 4`)이 따로
 * 있는데 여기서는 안 둔다 — 한 칸이 화면에서 약 12px 라 **문턱보다 격자가 먼저 막고**,
 * 문턱을 0 으로 낮춰도 밖에서 아무 차이가 안 보였다(2026-08-04 주입 시험). 관측되지 않는
 * 장치는 지킬 수도 없다. 격자를 좁히면 그때 문턱이 필요해진다.
 */
const SNAP_SEC = 0.5;

/** 사건이 든 자세 이름 하나. 이름 하나만 적혔으면 두 칸 다 그 이름이다. */
function poseNameAt(e, role, k) {
  const v = e?.pose?.[role];
  if (!v) return '';
  return typeof v === 'string' ? v : (v[k] ?? v[0] ?? '');
}

/** 한 칸만 바꾼 `pose` 를 만든다. **양쪽이 비면 역할 자체를 지운다** — 빈 이름은 자세가 아니다. */
function withPose(e, role, k, name) {
  const cur = poseNameAt(e, role, 0);
  const nxt = poseNameAt(e, role, 1);
  const pair = k === 0 ? [name, nxt] : [cur, name];
  const rest = { ...(e?.pose ?? {}) };
  if (!pair[0] && !pair[1]) delete rest[role];
  else rest[role] = [pair[0] || pair[1], pair[1] || pair[0]];
  return Object.keys(rest).length ? rest : undefined;
}


export function LayoutView({
  layout, onReport, onCommit, onPickId, onDuplicate, onRemove, onUndo, canUndo, boundsMm,
  series = [], seriesSource = null, onDropCard,
  scenarios = [], scenarioId = null,
  onPickScenario, onDupScenario, onRenameScenario, onDelScenario,
  onMoveEvent, onSetEvent, onAddEvent, onRemoveEvent, onDupEvent, onSavePose, onDeletePose, onSetWaypoints, onUseInScenario,
  poses = null, poseMsg = null, seekTo = null,
}) {
  const hostRef = useRef(null);
  const stageRef = useRef(null);
  const editRef = useRef(null);
  const viewRef = useRef(null);
  const framedRef = useRef(null);          // 마지막으로 시점을 맞춘 배치안 id
  const [picked, setPicked] = useState(null);
  const [menu, setMenu] = useState(null);          // { item, x, y } — 우클릭 자리
  const [editing, setEditing] = useState(false);   // 타임라인을 펼쳤나
  const [evMenu, setEvMenu] = useState(null);      // { i, x, y } — 사건 우클릭 자리
  const trackRef = useRef(null);
  const dragRef = useRef(null);                    // { i, x0, moved }
  const gizmoRef = useRef(null);
  // 자세 편집 — **팔을 고르고 [자세] 를 켜야 링이 뜬다.** 늘 떠 있으면 배치 편집이 안 된다
  const [posing, setPosing] = useState(false);
  const [jointDeg, setJointDeg] = useState(null);   // { j1..j6 } — 지금 만들고 있는 자세
  const [clampMsg, setClampMsg] = useState(null);
  const [poseSel, setPoseSel] = useState('');    // 고쳐 쓰고 있는 자세 이름 (빈 값 = 새로 만든다)
  const [pathing, setPathing] = useState(false);  // AMR 경로 편집 (평소엔 선을 안 그린다)
  const pathingRef = useRef(false);
  pathingRef.current = pathing;
  const pathDragRef = useRef(null);              // { i, moved }
  const [pathMenu, setPathMenu] = useState(null);  // { i, atMm, x, y } — 경로 점 우클릭
  const posingRef = useRef(false);
  posingRef.current = posing;
  // **정본은 이 값이다.** 슬라이더는 `min`/`max` 로 자기 값을 스스로 자르므로
  // 슬라이더를 읽으면 한계 검사가 **언제나 통과한다** (2026-08-04 주입 시험이 그랬다).
  const jointRef = useRef(null);
  // 지금 자세를 만들고 있는 팔 id — **재생 틱이 이 팔을 건너뛴다**
  const posedRef = useRef(null);
  // 팔별 **만들다 만 자세**. 저장과는 다르다 — 새로고침하면 사라진다
  const draftRef = useRef({});
  // 커밋 콜백이 매번 새로 만들어지지 않게 최신 선택을 ref 로도 들고 있는다
  const pickedRef = useRef(null);
  pickedRef.current = picked;

  // 패널에 보일 값. **정본은 배치안이다** — 3D 노드의 `userData.item` 은 `{kind,id,type}` 만
  // 담아 회전을 실어 나르지 않고(180° 인 물건이 0° 로 뜬다), `picked` 는 고른 순간의 사본이라
  // 되돌리기로 배치안이 돌아가도 안 따라온다. **끄는 중(`live`)에만** 손끝을 따라간다.
  let shown = null;
  if (picked?.posMm) {
    const rec = [...(layout.props ?? []), ...(layout.stations ?? [])].find((o) => o.id === picked.id);
    const src = picked.live || !rec ? picked.posMm : rec.posMm;
    shown = { x: Math.round(src[0]), y: Math.round(src[1]), rot: Math.round(Number(rec?.rotDeg ?? 0)) };
  }
  const shownRef = useRef(null);
  shownRef.current = shown;

  // 크기 칸 — **정본은 배치안의 `opts`** 다. 아직 안 건드린 치수는 팩토리 기본값이라
  // 여기서 알 길이 없다. 그래서 `parts.js` 를 불러 재보는 대신 **비워 두지 않고**
  // 첫 편집 때 배치안에 박히게 한다 (`SIZE_RANGE` 안의 값이면 무엇이든 유효하다).
  const rec = picked ? [...(layout.props ?? []), ...(layout.stations ?? [])]
    .find((o) => o.id === picked.id) : null;
  const sizeKeys = (!picked?.live && rec && SIZE_MM[rec.type ?? rec.prop]) || [];
  const measured = sizeKeys.length ? sizeMmOf(rec.type ?? rec.prop, rec.opts ?? {}) : null;
  // 아직 안 건드린 치수는 `opts` 에 없다 — **잰 값을 보여준다.** 빈 칸을 보여주면
  // 지금 몇인지 모르는 채로 숫자를 넣게 된다.
  const sizeOf = (k) => rec?.opts?.[k]
    ?? (SIZE_AXIS[k] && measured ? measured[SIZE_AXIS[k]] : '');
  // 사용법 안내는 한 번 닫으면 안 돌아온다. **사파리 프라이빗에서 던진다** — 삼키고 계속 돈다
  const [hintOff, setHintOff] = useState(() => {
    try { return localStorage.getItem('fr5.hint.layout') === '1'; } catch { return false; }
  });
  const closeHint = useCallback(() => {
    setHintOff(true);
    try { localStorage.setItem('fr5.hint.layout', '1'); } catch { /* 저장 못 해도 이번 세션은 닫힌다 */ }
  }, []);
  // **물건을 골랐다는 건 안내를 읽었다는 뜻이다.** 안내를 접어 자리를 비운다 —
  // 폰에서는 안내와 선택 패널이 같은 아래쪽 자리를 쓴다 (실렌더로 겹침 확인).
  useEffect(() => { if (picked) closeHint(); }, [picked, closeHint]);

  // 콜백을 ref 로 잡아둔다 — 부모가 새 함수를 넘겨도 무대를 다시 만들지 않기 위해서다
  const cbRef = useRef({ onReport, onCommit, onPickId });
  cbRef.current = { onReport, onCommit, onPickId, onSetWaypoints };
  // 메뉴가 부르는 것들도 같은 이유로 ref 에 담는다 — 무대를 다시 만들지 않기 위해서다
  const actRef = useRef({ onDuplicate, onRemove, onUndo });
  actRef.current = { onDuplicate, onRemove, onUndo };
  // 클램프용 방 치수. **무대는 한 번만 만드는데 방은 씬마다 바뀐다** — 그래서 ref 다
  const boundsRef = useRef(boundsMm);
  boundsRef.current = boundsMm;

  const fit = useCallback(() => {
    if (stageRef.current && viewRef.current) stageRef.current.frame(viewRef.current.contents);
  }, []);

  // ── 재생 (사다리 2) ──────────────────────────────────────────────────────
  //
  // **시간은 렌더 루프에서 흐르고 React 는 초당 10번만 안다.** 매 프레임 setState 하면
  // 편집기 전체가 초당 60번 다시 그려진다 — 끌기가 끊긴다.
  //
  // 상태는 `stateAt` 이 낸다. 여기서 위치를 계산하지 않는다 (`SHARED-CORE.md` §1.5).
  // `armed` 는 **재생 모드**다. "시각이 0 인가" 로 대신하면 처음으로 돌린 순간과
  // 0초 장면이 구별되지 않아 **스크럽을 0 으로 당기면 작업물이 사라진다** (실렌더가 잡았다).
  const playRef = useRef({ series: [], cycleSec: 0, t: 0, playing: false, armed: false, last: 0, shown: -1 });
  // 무대의 한 tick 몸통. 오프라인 렌더가 손으로 한 번씩 부른다 (`window.__fr5play.step`)
  const tickRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [armed, setArmed] = useState(false);
  const [tSec, setTSec] = useState(0);

  const cycleSec = cycleSecOf(series);
  // **시나리오가 부르는 이름이 배치안에 다 있어야 한다.**
  //
  // 전에는 "하나라도 있으면 재생 가능" 이었다. 그러면 절반만 있는 배치안에서 **재생은 되는데
  // 아무것도 안 움직이고 화면이 이유를 안 말한다** — 주인님 맵에서 실제로 그랬다
  // (`pile`·`fuze`·`ship`·`exit` 가 없어 AMR·작업물·팔이 전부 가만히 있었다 · 2026-08-04).
  const stationIds = new Set((layout.stations ?? []).map((s) => s.id));
  const wanted = new Set();
  for (const e of series) { if (e.station) wanted.add(e.station); if (e.armAt) wanted.add(e.armAt); if (e.amrAt) wanted.add(e.amrAt); }
  const missing = [...wanted].filter((id) => !stationIds.has(id));
  const playable = cycleSec > 0 && missing.length === 0;

  playRef.current.series = series;
  playRef.current.cycleSec = cycleSec;

  /** 화면 x → 사이클 시각. **막대 밖으로 나가도 잘린다** — 음수 시각은 없다. */
  const secAtX = useCallback((clientX) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || !r.width || !cycleSec) return 0;
    return Math.min(cycleSec, Math.max(0, ((clientX - r.left) / r.width) * cycleSec));
  }, [cycleSec]);

  /**
   * 마커 끌기. **고르기와 끌기를 가르는 것은 격자다** — 반 칸(0.25초 ≈ 6px)을 못 넘으면
   * `moveEvent` 가 같은 값을 보고 그대로 돌려주므로 되돌리기 스택도 안 쌓인다.
   */
  const onMarkerDown = useCallback((e, i) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { i, x0: e.clientX, moved: false };
  }, []);

  const onMarkerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    d.moved = d.moved || Math.abs(e.clientX - d.x0) >= 1;
    onMoveEvent?.(d.i, secAtX(e.clientX));
  }, [onMoveEvent, secAtX]);

  const onMarkerUp = useCallback((e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // 문턱을 안 넘었으면 **고르기다** — 그 시각으로 감아 무엇이 벌어지는지 보여준다
    if (!d.moved) { arm(); seek(series[d.i]?.tSec ?? 0); }
  }, [series]);

  const seek = useCallback((t) => {
    const p = playRef.current;
    p.t = Math.min(Math.max(t, 0), p.cycleSec);
    p.armed = true;
    setTSec(p.t); setArmed(true);
  }, []);
  // **손을 대는 순간 재생 모드다.** 값 변화만 보면 사각지대가 생긴다 — 막대가 0 에 있는데
  // 0 자리를 누르면 값이 안 바뀌어 `onChange` 가 안 오고, 아무 일도 안 일어난 것처럼 보인다.
  const arm = useCallback(() => { playRef.current.armed = true; setArmed(true); }, []);
  // **재생과 자세 편집은 같은 관절을 쓴다.** 둘 다 켜면 그 팔만 얼어붙어 라인이 거짓말한다 —
  // 재생을 누르면 자세 편집을 끈다 (2026-08-04 손으로 눌러 보고 드러났다).
  const toggle = useCallback(() => {
    const p = playRef.current;
    if (!p.playing) setPosing(false);   // 재생을 켜면 자세 편집을 끈다 (같은 관절을 쓴다)
    p.playing = !p.playing;
    p.armed = true;
    p.last = 0;                       // 멈춰 있던 시간이 한 번에 흐르지 않게
    setPlaying(p.playing); setArmed(true);
  }, []);
  const stop = useCallback(() => {
    const p = playRef.current;
    p.playing = false; p.armed = false; p.t = 0;
    setPlaying(false); setArmed(false); setTSec(0);
  }, []);

  // 배치안이 바뀌면 처음으로. 다른 무대의 시각을 물려받으면 작업물이 엉뚱한 데서 시작한다
  useEffect(() => { stop(); }, [layout.id, stop]);

  // 헤드리스 오프라인 렌더용 노출 — `window.__fr5view`(읽기 전용)·`globalThis.__stage` 와 같은 방식.
  // **`seek` 만으로는 부족하다** — 위 `onTick` 의 `fixedDt` 주석이 이유 둘을 적어 뒀다.
  // 계약은 `docs/goals/GOAL-cine-probe.md`.
  useEffect(() => {
    window.__fr5play = {
      /**
       * 오프라인 렌더로 들어간다 — 무대를 **얼리고** 벽시계를 끊는다.
       * 이 뒤로 장면은 `step()` 을 부를 때만 움직이므로, 한 장 굽는 100ms 동안 시각이 안 흐른다.
       */
      offline: (dt = 1 / 30) => {
        const p = playRef.current;
        p.fixedDt = dt; p.manual = true; p.playing = false; p.armed = true; p.t = 0; p.shown = -1;
        setPlaying(false); setArmed(true); setTSec(0);
        tickRef.current?.();          // 0초 프레임을 세운다
        return { fixedDt: dt, cycleSec: p.cycleSec };
      },
      /** 정확히 `n` tick 앞으로. 한 tick = `fixedDt` 초다 — 벽시계와 무관하다 */
      step: (n = 1) => {
        const p = playRef.current;
        for (let i = 0; i < n; i += 1) {
          p.t = Math.min(p.t + (p.fixedDt ?? 1 / 30), p.cycleSec);
          tickRef.current?.();
        }
        return +p.t.toFixed(4);
      },
      /** 그 시각으로 감고 한 tick. 임의 접근용 — 패스 시작점을 잡을 때 쓴다 */
      seekTo: (t) => {
        const p = playRef.current;
        p.t = Math.min(Math.max(t, 0), p.cycleSec); p.armed = true;
        tickRef.current?.();
        return +p.t.toFixed(4);
      },
      /** 패스별 레이어 — 무엇을 보일지. 안 준 칸은 그대로 둔다 (`layout-view.js` §setLayers) */
      layers: (o) => { viewRef.current?.setLayers(o); return true; },
      /** 실시간으로 되돌린다 — 사람이 다시 쓰는 상태 */
      live: () => {
        const p = playRef.current;
        p.fixedDt = null; p.manual = false; p.last = 0;
        return true;
      },
      state: () => {
        const p = playRef.current;
        return {
          t: +p.t.toFixed(4), cycleSec: p.cycleSec, events: p.series.length,
          playing: p.playing, manual: Boolean(p.manual), fixedDt: p.fixedDt ?? null,
        };
      },
    };
    return () => { delete window.__fr5play; };
  }, []);

  const now = stateAt(series, tSec);

  // 숫자칸이 낸 값을 끌어놓기와 **같은 문으로** 보낸다 — 저장·되돌리기가 한 곳에서만 쌓인다.
  //
  // 함정 둘을 여기서 막는다 (둘 다 실렌더가 잡았다) —
  //   ① `picked` 를 같이 고치면 그게 또 하나의 정본이 되어, 되돌리기로 배치안이
  //      돌아가도 **패널만 옛 값**을 들고 있는다
  //   ② 그렇다고 `picked` 를 그대로 보내면 회전만 바꿔도 **고른 순간의 좌표**가 같이 실려
  //      위치가 옛날로 되돌아간다. 그래서 **지금 보이는 값**(`shown`)을 바탕으로 보낸다
  const commitField = useCallback((patch) => {
    const s = shownRef.current;
    cbRef.current.onCommit?.({
      ...pickedRef.current, posMm: [s.x, s.y], rotDeg: s.rot, ...patch,
    });
  }, []);

  // ① 무대 — 마운트에 한 번. **카메라가 여기 산다.**
  useEffect(() => {
    const stage = createStage(hostRef.current);
    stageRef.current = stage;

    // ── 관절 기즈모. **호스트 div 에 캡처로 건다** — DOM 캡처는 바깥→안 순서라
    // 캔버스에 걸린 `interaction.js` 보다 **반드시 먼저** 돈다. 링을 잡았을 때만
    // `stopPropagation()` 으로 삼키므로, 안 잡았으면 배치 편집이 그대로 돈다.
    const giz = createJointGizmo({ renderer: stage.renderer, camera: stage.camera });
    gizmoRef.current = giz;
    const host = hostRef.current;
    const apply = (r) => {
      if (!r) return;
      setJointDeg((prev) => ({ ...(prev ?? {}), [r.joint]: Math.round(r.deg * 10) / 10 }));
      setClampMsg(r.clampedTo == null ? null
        : `${r.joint} 는 ${JOINT_LIMITS_DEG[r.joint][0]}~${JOINT_LIMITS_DEG[r.joint][1]}° 까지예요`);
    };
    // 경로 점 — **`floorAtMm` 을 그대로 쓴다.** 화면→바닥 변환을 또 만들면 놓는 자리와
    // 끄는 자리가 미묘하게 어긋난다 (하드 룰 5 · `interaction.js` 주석과 같은 이유).
    const pathPick = (x, y) => {
      const pg = viewRef.current?.pathGizmo;
      if (!pg) return -1;
      const b2 = stage.renderer.domElement.getBoundingClientRect();
      const v = new THREE.Vector2(((x - b2.left) / b2.width) * 2 - 1, -((y - b2.top) / b2.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(v, stage.camera);
      return pg.pickAt(ray);
    };
    const onDown = (e) => {
      if (pathingRef.current && e.button === 0) {
        const i = pathPick(e.clientX, e.clientY);
        if (i >= 0) {
          e.stopPropagation(); e.preventDefault();
          // **상태를 먼저 세운다.** `setPointerCapture` 는 던질 수 있고(합성 이벤트·일부
          // 브라우저), 그러면 끌기가 시작조차 못 한 채 조용히 사라진다 (2026-08-04).
          pathDragRef.current = { i, moved: false };
          if (stage.controls) stage.controls.enabled = false;
          try { host.setPointerCapture(e.pointerId); } catch { /* 못 잡아도 끌기는 돈다 */ }
          return;
        }
      }
      if (!posingRef.current || e.button !== 0) return;
      if (!giz.begin(e.clientX, e.clientY)) return;
      e.stopPropagation(); e.preventDefault();
      if (stage.controls) stage.controls.enabled = false;
      try { host.setPointerCapture(e.pointerId); } catch { /* 못 잡아도 끌기는 돈다 */ }
    };
    const onMove = (e) => {
      const pd = pathDragRef.current;
      if (pd) {
        e.stopPropagation();
        const at = editRef.current?.floorAtMm?.(e.clientX, e.clientY);
        if (at) {
          pd.moved = true;
          // **어느 AMR 인지 같이 넘긴다** — 편집기가 선택 상태를 되물으면 정본이 둘이 된다
          cbRef.current.onSetWaypoints?.(viewRef.current.pathGizmo.moved(pd.i, at), pickedRef.current?.id);
        }
        return;
      }
      if (pathingRef.current && pathPick(e.clientX, e.clientY) >= 0) { host.style.cursor = 'grab'; return; }
      if (!posingRef.current) return;
      if (giz.isDragging()) { e.stopPropagation(); apply(giz.move(e.clientX, e.clientY)); return; }
      if (giz.hover(e.clientX, e.clientY)) host.style.cursor = 'grab';
    };
    const onUp = (e) => {
      if (pathDragRef.current) {
        e.stopPropagation();
        pathDragRef.current = null;
        try { host.releasePointerCapture(e.pointerId); } catch { /* 안 잡았을 수 있다 */ }
        if (stage.controls) stage.controls.enabled = true;
        return;
      }
      if (!giz.isDragging()) return;
      e.stopPropagation();
      giz.end();
      try { host.releasePointerCapture(e.pointerId); } catch { /* 안 잡았을 수 있다 */ }
      if (stage.controls) stage.controls.enabled = true;
    };
    // 헤드리스 검증용 노출 — `__fr5view` 와 같은 방식이다. 포인터 배선은 실제 이벤트로,
    // **한계 클램프 같은 계산은 각도를 정확히 줘야** 판정이 된다.
    globalThis.__fr5giz = {
      joints: () => giz.joints(),
      begin: (x, y) => giz.begin(x, y),
      move: (x, y) => { const r = giz.move(x, y); apply(r); return r; },
      end: () => giz.end(),
      /** 링 위 각도 a(°) 지점의 화면 좌표 — 검증이 정확한 지점을 겨눌 수 있어야 한다 */
      /** 지금 만들고 있는 자세 — **슬라이더가 아니라 저장될 값**이다 */
      pose: () => jointRef.current,
      /** 경로 점을 화면 좌표로 집는다 — 검증이 정확한 손잡이를 겨눌 수 있어야 한다 */
      pathPick: (x, y) => pathPick(x, y),
      pathing: () => pathingRef.current,
      pathDrag: () => pathDragRef.current,
      floorAt: (x, y) => editRef.current?.floorAtMm?.(x, y) ?? null,
      pointOn: (joint, a) => {
        let g = null;
        stage.scene.traverse((o) => {
          if (o.userData?.joint === joint && o.geometry?.parameters?.tube
            > o.geometry.parameters.radius * 0.1) g = o;
        });
        if (!g) return null;
        const R2 = g.geometry.parameters.radius; const t = (a * Math.PI) / 180;
        const v = new THREE.Vector3(R2 * Math.cos(t), R2 * Math.sin(t), 0);
        g.localToWorld(v); v.project(stage.camera);
        const b2 = stage.renderer.domElement.getBoundingClientRect();
        return [Math.round(b2.left + ((v.x + 1) / 2) * b2.width),
          Math.round(b2.top + ((1 - v.y) / 2) * b2.height)];
      },
    };
    // 우클릭 — 점 추가·삭제. **소품과 같은 문법**이라 새로 배울 것이 없다
    const onCtx = (e) => {
      if (!pathingRef.current) return;
      const i = pathPick(e.clientX, e.clientY);
      const at = editRef.current?.floorAtMm?.(e.clientX, e.clientY);
      const pg = viewRef.current?.pathGizmo;
      if (!pg || (i < 0 && !at)) return;
      e.preventDefault(); e.stopPropagation();
      const r = host.getBoundingClientRect();
      setPathMenu({ i, atMm: at, x: e.clientX - r.left, y: e.clientY - r.top });
    };
    host.addEventListener('contextmenu', onCtx, true);
    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('pointermove', onMove, true);
    host.addEventListener('pointerup', onUp, true);
    // 매 프레임 — 컷어웨이(궤도를 돌리면 숨는 벽이 바뀐다) + 재생.
    // **한 함수에 둔다.** 둘로 나누면 같은 프레임에서 순서가 안 정해진다.
    // **한 tick 을 이름 있는 함수로 뺀다** — 오프라인 렌더가 이걸 손으로 한 번씩 부른다.
    // 무대의 렌더 루프는 계속 돌지만 `manual` 이면 이 몸통을 안 부르므로 장면이 얼어 있고,
    // 그래야 한 장 굽는 동안(100ms+) 시각이 흘러가지 않는다 (`GOAL-cine-probe.md`).
    const tickOnce = () => {
      const v = viewRef.current;
      if (!v) return;
      v.updateCutaway(stage.camera);

      const p = playRef.current;
      const t0 = performance.now();
      // 첫 프레임과 탭 복귀는 `dt` 가 크게 튄다 — 0.1초로 자른다 (한 번에 순간이동하지 않게)
      //
      // **오프라인 렌더는 벽시계를 안 쓴다** (`window.__fr5play.offline`). 이유가 둘이다 —
      //   ① 한 장 굽는 데 실제로 100ms 넘게 드니, 벽시계로 흘리면 3초짜리가 30프레임에 끝난다
      //   ② `easeAngle` 이 `dt` 로 **적분**하는 j1 이 판마다 달라진다 (`poses.js:129`).
      //      같은 시각을 두 번 그렸는데 그림이 다르면 다중 패스 컷에서 팔이 튄다.
      // `fixedDt` 가 없으면 아무것도 안 바뀐다 — 사람이 쓰는 경로는 그대로 벽시계다.
      const dt = p.fixedDt ?? (p.last ? Math.min(0.1, (t0 - p.last) / 1000) : 0);
      p.last = t0;
      if (p.playing && p.cycleSec > 0) {
        p.t += dt;
        if (p.t >= p.cycleSec) p.t -= p.cycleSec;     // 사이클은 반복한다
      }
      // 재생 모드가 아니면 **평소 모습**으로 둔다 — 작업물을 감추고 팔을 원래 자세로
      const st = p.armed ? stateAt(p.series, p.t) : null;
      v.setPlayback(st);

      // **관절을 매 프레임 얹는다.** 전에는 로드할 때 한 번만 얹어서 팔이 굳어 있었다
      // (`FR5/src/features/live/RobotTwin.jsx` 가 매 프레임 얹는 것과 같은 규약).
      // `j1` 은 배치안이 낸 겨눔각이고 나머지는 키프레임이다 — 베이스는 안 돈다.
      const aim = v.armAim?.() ?? {};
      const feeds = new Set(v.feedArmIds?.() ?? []);
      for (const [id, e] of armCache) {
        if (!e.robot) continue;
        // **자세를 만들고 있는 팔은 건드리지 않는다.** 안 그러면 사람이 링을 돌려도
        // 다음 프레임에 재생기가 덮어써서 **패널 숫자만 바뀌고 팔은 안 움직인다** —
        // 게이트는 슬라이더를 읽어 통과했고, 손으로 눌러 봐야 드러났다 (2026-08-04).
        if (posedRef.current === id) continue;
        const pose = poseFor(st, { feed: feeds.has(id), poses });
        // **j1 은 튀지 않는다** — 겨눔각을 그대로 얹으면 목표가 바뀌는 순간 순간이동한다
        e.j1 = easeAngle(e.j1 ?? 0, aim[id]?.relDeg ?? 0, dt);
        setJointsDeg(e.robot, { ...pose, j1: e.j1 });
        // **「닿는 척」** — 키프레임을 얹은 **뒤에** 손끝만 목표로 당긴다 (주인님 2026-08-20).
        // 씨앗이 교시 자세라 모양이 안 망가지고, 매 프레임 다시 얹으므로 이력에 안 묶인다.
        // ⛔ 여기서 나온 관절값은 **실기가 갈 값이 아니다** — `reach.js` 머리말 참조.
        //    그래서 잔차를 들고 나와 화면이 글자로 말하게 한다.
        const tgt = st ? v.aimTargetWorld?.(id) : null;
        e.reach = tgt ? solveReach(e.robot, tgt) : null;
      }

      // **팔이 드는 구간에는 작업물이 손끝에 붙는다.** 관절을 얹은 **뒤에** 해야
      // 같은 프레임에서 맞는다 — 앞에 두면 한 프레임 늦어 손과 물건이 따로 논다.
      // **사건이 든 값이 먼저다** — 전역 표는 옛 판 폴백이다 (poses.js §poseFor 와 같은 규칙)
      const carryRole = st?.carry ?? CARRY_BY_ARM[st?.event];
      if (st && carryRole) {
        const carrier = [...armCache].find(([id, e]) => e.robot
          && (carryRole === 'feed') === feeds.has(id));
        const tipLink = carrier?.[1]?.robot?.links?.wrist3_link;
        if (tipLink) {
          tipLink.updateMatrixWorld(true);
          v.setWorkAtWorld(tipLink.getWorldPosition(new THREE.Vector3()));
        }
      }

      // React 는 0.1초마다만 안다 — 매 프레임 알리면 편집기가 초당 60번 다시 그려진다
      if (Math.abs(p.t - p.shown) >= 0.1) { p.shown = p.t; setTSec(p.t); }
    };
    tickRef.current = tickOnce;
    stage.onTick(() => { if (!playRef.current.manual) tickOnce(); });

    // 편집. 고르고 끌고 R 로 돌린다. **pickRoot 는 매번 현재 내용물을 본다** —
    // 내용물이 갈려도 인터랙션은 그대로 산다 (무대와 수명이 같다).
    const edit = createInteraction({
      renderer: stage.renderer,
      camera: stage.camera,
      scene: stage.scene,
      controls: stage.controls,
      pickRoot: () => viewRef.current?.contents,
      gridMm: 100,
      onPick: (it) => { setPicked(it); cbRef.current.onPickId?.(it?.id ?? null); },
      onMenu: setMenu,
      bounds: () => boundsRef.current,
      onCommit: (item) => {
        // 끌기가 끝났으니 **미리보기 모드를 끈다.** 안 끄면 `shown` 이 계속 손끝 좌표를 보고
        // 있어서 되돌리기를 해도 패널이 놓은 자리에 얼어붙는다 (배포본 실렌더에서 확인)
        setPicked((p) => (p?.live ? { ...p, live: false } : p));
        cbRef.current.onCommit?.(item);
      },
    });
    editRef.current = edit;

    // **dispose 를 반드시 부른다** — 탭을 왕복하면 WebGL 컨텍스트가 쌓여 브라우저가 막는다
    return () => {
      host.removeEventListener('contextmenu', onCtx, true);
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointermove', onMove, true);
      host.removeEventListener('pointerup', onUp, true);
      giz.dispose();
      gizmoRef.current = null;
      delete globalThis.__fr5giz;
      edit.dispose();
      for (const e of armCache.values()) e.holder?.removeFromParent();
      viewRef.current?.dispose();
      viewRef.current = null;
      stage.dispose();
      stageRef.current = null;
    };
  }, []);

  // 자세 편집 — **고른 팔에만 붙인다.** 팔을 바꾸거나 끄면 뗀다.
  //
  // URDF 가 늦게 오므로 `armCache` 를 폴링한다 — 팔이 아직 없는데 링을 붙이면 조용히
  // 아무것도 안 뜨고, 사람은 "기즈모가 고장났다" 로 읽는다.
  useEffect(() => {
    const giz = gizmoRef.current;
    if (!giz) return undefined;
    const armId = posing && picked?.kind === 'arm' ? picked.id : null;
    posedRef.current = armId;
    if (!armId) { giz.detach(); setJointDeg(null); setClampMsg(null); return undefined; }
    let live = true;
    const tryAttach = () => {
      if (!live) return;
      const e = armCache.get(armId);
      if (e?.robot) {
        giz.attach(e.robot);
        // **만들다 만 자세를 기억한다.** 빈 곳을 한 번 클릭하면 선택이 풀리는데, 그때마다
        // 저장 안 한 자세가 사라지면 사람이 같은 작업을 두 번 한다 (손으로 눌러 보고 알았다).
        // 없으면 **지금 서 있는 각도에서 시작한다** — 0 에서 시작하면 팔이 툭 튄다.
        setJointDeg(draftRef.current[armId] ?? Object.fromEntries(JOINTS.map((j) => [j,
          Math.round(((e.robot.joints?.[j]?.angle ?? 0) * 180 / Math.PI) * 10) / 10])));
        return;
      }
      setTimeout(tryAttach, 200);
    };
    tryAttach();
    return () => { live = false; posedRef.current = null; giz.detach(); };
  }, [posing, picked?.id, picked?.kind]);

  // 만든 자세를 **매 프레임 얹는다** — 재생기와 같은 규약이다. 안 얹으면 링만 돌고 팔은 굳어 있다.
  //
  // 얹고 나서 **손끝을 잰다** — 자세를 만드는 내내 "어디까지 갔나" 를 mm 로 봐야 한다.
  // 순기구학이지 역기구학이 아니다: 각도를 넣고 좌표를 **재는** 것이다.
  const [tipMm, setTipMm] = useState(null);
  useEffect(() => {
    const e = posing && picked?.kind === 'arm' ? armCache.get(picked.id) : null;
    jointRef.current = jointDeg;
    if (posedRef.current && jointDeg) draftRef.current[posedRef.current] = jointDeg;
    if (!e?.robot || !jointDeg) { setTipMm(null); return; }
    jointRef.current = jointDeg;
    setJointsDeg(e.robot, jointDeg);
    const link = e.robot.links?.wrist3_link;
    if (!link) { setTipMm(null); return; }
    link.updateMatrixWorld(true);
    const w = new THREE.Vector3(); let n = 0;
    link.traverse((o) => { if (o !== link && o.isMesh) { w.add(o.getWorldPosition(new THREE.Vector3())); n += 1; } });
    if (n) w.divideScalar(n); else link.getWorldPosition(w);
    setTipMm([Math.round(w.x * 1000), Math.round(-w.z * 1000), Math.round(w.y * 1000)]);
  }, [jointDeg, posing, picked?.id, picked?.kind]);

  // 경로 편집 — **고른 AMR 의 점만 그린다.** 평소엔 선을 안 그린다(주인님 결정 · 2026-08-04).
  const amrPicked = pathing && picked?.kind === 'amr'
    ? (layout.amrs ?? []).find((a) => a.id === picked.id) : null;

  // 패널의 "그 시각으로" — 재생 막대를 감는다. **`arm()` 을 같이 부른다** 안 그러면
  // 아직 재생을 안 켠 상태에서 작업물이 안 뜬다 (t=0 이 "재생 안 함" 과 겹치던 그 문제).
  useEffect(() => {
    if (!seekTo) return;
    playRef.current.armed = true;
    setArmed(true);
    seek(seekTo.t);
  }, [seekTo]);

  // ② 내용물 — 배치안이 바뀔 때만. **시점은 안 건드린다.**
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // 연출 프리셋의 배경색만 바꾼다. 공용 stage 기본값과 투명 AR 배경 계약은 그대로 둔다 (D229).
    stage.scene.background?.set(layout.appearance === 'defense-reference-v1' ? 0x3b3e40 : 0xd7dade);
    // 새로 만들기 **전에** 무엇이 골라져 있었는지 적어 둔다 — 아래에서 id 로 다시 잡는다
    const keepIds = editRef.current?.selectedIds?.() ?? [];
    const keepPrimary = pickedRef.current?.id ?? null;
    if (viewRef.current) {
      // **팔을 먼저 떼어낸다** — `dispose()` 가 트리의 지오메트리를 지운다.
      // `.then()` 으로 떼면 마이크로태스크라 dispose **뒤에** 돌아 팔이 빈 껍데기가 된다.
      // **팔을 먼저 떼어낸다** — `dispose()` 가 트리의 지오메트리를 지운다
      for (const e of armCache.values()) e.holder?.removeFromParent();
      stage.scene.remove(viewRef.current.root);
      viewRef.current.dispose();
    }
    const view = createLayoutView(layout);
    viewRef.current = view;
    stage.scene.add(view.root);
    // **그림자를 방에 맞춘다** — `contents` 가 아니라 `root` 다. 벽·바닥이 거기 있고
    // 그림자를 드리우는 것도 받는 것도 그것들이다. 방 치수가 바뀌면 다시 맞춘다.
    stage.fitShadow(view.root);
    editRef.current?.reselect?.(keepIds, keepPrimary);
    // 팔은 `armSlot` 에 붙는다 — 베이스 좌표·요각이 이미 걸려 있다 (D56 이후 주인님 요청).
    // **팔마다 하나씩 로드한다.** 한 개를 두 부모에 붙일 수 없다 — three 는 부모가 하나다.
    // URDF·STL 은 브라우저가 캐시하므로 두 번째는 네트워크가 아니라 파싱만 든다.
    for (const slot of view.armSlots ?? []) {
      const a = slot.userData.arm;
      if (a?.model !== 'FR5') continue;
      const e = getArm(a.id);
      e.promise.then((holder) => { if (holder && viewRef.current === view) slot.add(holder); });
    }
    // 헤드리스 검증용 노출 — `LayoutEditor` 의 `window.__fr5edit` 와 같은 방식이다
    window.__fr5view = () => {
      let lines = 0; let amrs = 0; let robot = 0; let items = 0;
      view.root.traverse((o) => {
        if (o.isLine) lines += 1;
        if (o.userData?.item) { items += 1; if (o.userData.item.kind === 'amr') amrs += 1; }
        if (o.isMesh && o.parent && !o.userData?.item) robot += 0;
      });
      let tris = 0;
      view.armSlot.traverse((o) => {
        if (!o.isMesh) return;
        robot += 1;
        const g = o.geometry;
        tris += g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ?? 0) / 3;
      });
      // 편집 단위마다 **화면 좌표**를 같이 낸다 — 헤드리스에서 실제로 눌러 보기 위해서다.
      // 좌표만 보고 넘기면 링이 어디 뜨는지·골라지는지를 영영 확인 못 한다.
      const cam = stageRef.current?.camera;
      const el = stageRef.current?.renderer?.domElement;
      const at = {};
      if (cam && el) {
        const r = el.getBoundingClientRect();
        const v = new THREE.Vector3();
        const bb = new THREE.Box3();
        view.contents.traverse((o) => {
          const it = o.userData?.item;
          if (!it) return;
          // **원점이 아니라 상자 가운데.** 문·창 그룹은 원점이 (0,0,0) 이다 (링과 같은 계산)
          bb.setFromObject(o).getCenter(v);
          v.project(cam);
          at[it.id] = [
            Math.round(r.left + ((v.x + 1) / 2) * r.width),
            Math.round(r.top + ((1 - v.y) / 2) * r.height),
          ];
        });
      }
      const ring = stageRef.current?.scene?.children?.find(
        (c) => c.isGroup && c.children?.[0]?.isLineLoop && c.visible,
      );
      const ol = ring?.children?.[0];
      return { lines, amrs, items, armMeshes: robot, armTris: Math.round(tris),
        // 재생 판정용 — **작업물이 어디 있고 몇 단계인가.** 좌표를 눈으로 못 재므로 숫자로 낸다
        work: view.workState(), tSec: +playRef.current.t.toFixed(2), playing: playRef.current.playing,
        // **관절이 실제로 움직였나 · 손끝이 어디에 갔나.** 각도만 보면 "얹었다" 까지밖에 모른다.
        // 순기구학으로 손끝 월드 좌표를 재서 배치안 mm 로 되돌린다 (IK 가 아니다 — 재는 것이다)
        arms: Object.fromEntries([...armCache].map(([id, e]) => {
          if (!e.robot) return [id, null];
          const j = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']
            .map((n) => Math.round((e.robot.joints?.[n]?.angle ?? 0) * 180 / Math.PI));
          const tip = e.robot.links?.wrist3_link;
          if (!tip) return [id, { j }];
          tip.updateMatrixWorld(true);
          // **손끝은 손목이 아니라 그리퍼다.** 손목 좌표로 재면 자세를 바꿀 때마다
          // 그리퍼가 물건을 잡고 있는데도 "멀다" 고 나온다 (2026-08-04).
          const w = new THREE.Vector3(); let n = 0;
          tip.traverse((o) => { if (o !== tip && o.isMesh) { w.add(o.getWorldPosition(new THREE.Vector3())); n += 1; } });
          if (n) w.divideScalar(n); else tip.getWorldPosition(w);
          // `reachMm` — 「닿는 척」 솔버가 남긴 **손끝 잔차**. 0 에 가까우면 진짜 닿은 것이고
          // 크면 **못 닿은 만큼 그대로 남은 것**이다 (URDF 는 안 늘어난다 · `reach.js`)
          return [id, { j, reachMm: e.reach?.residualMm ?? null,
            tipMm: [Math.round(w.x * 1000), Math.round(-w.z * 1000), Math.round(w.y * 1000)] }];
        })),
        armSlotKids: view.armSlot.children.map((c) => c.name || c.type),
        at,
        ring: ring ? { x: +ring.position.x.toFixed(2), z: +ring.position.z.toFixed(2),
          w: +ol.scale.x.toFixed(2), d: +ol.scale.z.toFixed(2) } : null };
    };
    if (framedRef.current !== layout.id) { stage.frame(view.contents); framedRef.current = layout.id; }
    cbRef.current.onReport?.(view.report());
  }, [layout]);

  // **무대가 다시 만들어진 뒤에 그린다.** 이 이펙트가 ② 앞에 있던 동안, 점을 하나 추가하면
  // 배치안이 바뀌며 ② 가 무대를 새로 만들었고 — **새 기즈모는 비어 있어 점이 화면에서
  // 사라졌다.** 데이터는 맞는데 화면만 빈 상태라 "추가가 안 된다" 로 보였다 (2026-08-04).
  // React 는 선언 순서대로 이펙트를 돌리므로 **② 뒤에 두는 것**이 곧 수정이다.
  useEffect(() => {
    const pg = viewRef.current?.pathGizmo;
    if (!pg) return;
    pg.show(Boolean(amrPicked));
    if (amrPicked) pg.setPoints(amrPicked.waypointsMm ?? []);
  }, [amrPicked, layout]);

  // ③ 실기 AMR — 터틀봇 브리지의 `/ws/state` 를 **관전만** 한다.
  // 계약이 이미 열어 뒀다: 「AR·FR5 웹·Dashboard 는 읽기 전용 소비자 — GET·/ws/state 만 읽어
  // AMR 위치·경로를 겹친다(트윈 실시간 표시 포함). 명령 전송 금지 — 쓰기는 터틀봇 웹앱 하나뿐」
  // (`TB-CONTRACT.md` §미래 접점 ④ · 하드룰 4 「명령 주인은 한 명」).
  //
  // **② 뒤에 둔다** — 위 경로 기즈모와 같은 이유다. ② 가 뷰를 새로 만든 뒤라야 자세를 얹을
  // 노드가 있다. 배치안이 바뀌면 소켓도 새로 연다(새 뷰에 얹어야 하므로).
  useEffect(() => {
    const host = tbHost();
    // **주소를 아무도 모르면 아무 일도 안 한다.** 그건 고장이 아니라 안 켠 것이다
    // (`?cam=` 규약과 같다 — `FR5/src/data/datasource/http.js` §글로벌 카메라 주소).
    if (!host) return undefined;
    // ⛔ **실측 무대에만 겹친다.** 실기 자세는 `lab` 프레임 값인데, 연출 무대(`cell`·
    // `defense-line`)의 좌표는 지어낸 것이라 같은 숫자가 다른 자리를 가리킨다 —
    // 겹치면 「저기 있다」가 거짓말이 된다 (2026-08-28 감사).
    if (layout.frame !== 'lab') return undefined;
    const amrs = layout.amrs ?? [];
    if (!amrs.length) return undefined;

    const placed = new Set();
    const stop = subscribeRobotState({
      host,
      // **끊기면 놓는다** — 안 놓으면 마지막 자세가 남아 「멈춘 시계」가 된다 (감사 2026-08-28)
      onStale: () => {
        for (const id of placed) viewRef.current?.setAmrLivePose?.(id, null);
        placed.clear();
      },
      onSnapshot: (snap) => {
        const view = viewRef.current;
        if (!view?.setAmrLivePose) return;
        const robots = snap?.robots ?? {};
        const ids = Object.keys(robots);
        for (const a of amrs) {
          // 짝짓기 — 배치안이 `robotId` 를 주면 그것으로. **로봇도 AMR 도 하나뿐이면
          // 짝은 자명하다**(2026-08-28 주인님 — 실기는 한 대만 쓴다). 둘 이상이면
          // 지어내지 않고 건너뛴다 — 엉뚱한 로봇을 엉뚱한 자리에 세우는 것이 최악이다.
          const robotId = a.robotId ?? (amrs.length === 1 && ids.length === 1 ? ids[0] : null);
          if (!robotId) continue;
          const pose = robots[robotId]?.pose;
          if (!Number.isFinite(pose?.xMm) || !Number.isFinite(pose?.yMm)) {
            if (placed.delete(a.id)) view.setAmrLivePose(a.id, null);
            continue;
          }
          // 프레임 변환은 **`frames.js` 한 곳**이 한다 (`docs/ref/contract/FRAMES.md`).
          // 여기서 도크를 더하거나 축을 돌리지 않는다 — 아침에 그렇게 했다가 **odom 회전을
          // 빠뜨려 전진이 반대로** 그려졌다 (2026-08-28 감사 · 전진 1000mm 면 참값과 2000mm).
          //
          // `odom → lab` 은 갈래가 전부 정적이라 실기 연결 없이 풀린다. 못 풀면 `null` 이고
          // 그때는 **얹지 않는다** (규약 3).
          const at = toFrame({ xMm: pose.xMm, yMm: pose.yMm, zMm: 0 }, 'odom', 'lab');
          const yaw = yawToFrame(pose.thetaDeg, 'odom', 'lab');
          if (at === null || yaw === null) {
            if (placed.delete(a.id)) view.setAmrLivePose(a.id, null);
            continue;
          }
          view.setAmrLivePose(a.id, { xMm: at.xMm, yMm: at.yMm, thetaDeg: yaw });
          placed.add(a.id);
        }
      },
    });
    return () => {
      stop();
      // **놓고 나간다.** 안 놓으면 소켓이 끊긴 뒤에도 마지막 자세가 남아
      // 「지금 저기 있다」로 읽힌다 — 멈춘 시계가 제일 위험한 거짓말이다.
      for (const id of placed) viewRef.current?.setAmrLivePose?.(id, null);
    };
  }, [layout]);

  return (
    <div className="view3d">
      {/* 팔레트에서 끌어다 놓는다. **바닥에 안 맞으면 아무 일도 안 한다** —
          하늘을 가리킨 채 놓으면 물건이 어디에 생겼는지 알 수 없다 */}
      <div
        ref={hostRef}
        className="view3d-host"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('text/fr5-card')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          const key = e.dataTransfer.getData('text/fr5-card');
          if (!key) return;
          e.preventDefault();
          const posMm = editRef.current?.floorAtMm(e.clientX, e.clientY);
          if (posMm) onDropCard?.(key, posMm);
        }}
      />
      <div className="view3d-tools">
        <button type="button" onClick={fit}>시점 맞추기</button>
        {/* **폰에는 키보드가 없다.** R 키와 같은 걸 부르는 버튼을 같이 둔다 */}
        <button type="button" onClick={() => editRef.current?.rotate()} disabled={!picked}>90° 회전</button>
      </div>
      {/* 재생 막대 — **한 사이클 = 1발 해체** (D51).
          **출처 배지를 여기에도 붙인다.** 움직이는 로봇은 숫자보다 훨씬 강하게 "실물" 로
          읽힌다 — 목업을 실측으로 오인해 보고하는 것이 이 프로젝트에서 가장 비싼 사고다 (SR_24) */}
      {/* ── 왼쪽 위는 **한 세로 통**이다. 전에는 재생 막대와 선택 패널이 **CSS 좌표가 같아**
          그대로 포개졌다 (둘 다 `left: s-4; top: s-3` · 2026-08-04 실측 [248,158] 동일).
          좌표를 손으로 더하지 않고 흐름에 맡긴다 — 막대가 폰에서 여러 줄로 접혀도 안 겹친다. */}
      <div className="view3d-topleft">
      {cycleSec > 0 && (
        <div className="view3d-play">
          <button type="button" onClick={toggle} disabled={!playable} aria-label={playing ? '멈춤' : '재생'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" onClick={stop} disabled={!playable || !armed}>처음으로</button>
          <input
            type="range" min="0" max={cycleSec} step="0.1" value={tSec}
            disabled={!playable}
            onPointerDown={arm}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="사이클 시각"
          />
          {playable
            ? (
              <span className="play-now">
                <b>{now.tSec.toFixed(1)}</b>/{cycleSec.toFixed(0)}초
                {' · '}{EVENT_LABEL[now.event] ?? now.event ?? '—'}
                {' · '}조립 {3 - now.warheadStage}/3
              </span>
            )
            : (
              <span className="play-now mute">
                {missing.length
                  ? `이 배치안엔 ${missing.join(', ')} 스테이션이 없어서 못 돌려요`
                  : '재생할 사이클이 없어요'}
              </span>
            )}
          {seriesSource && <span className="source" data-src={seriesSource}>출처 {seriesSource}</span>}
          {/* **평소엔 안 펼친다.** 타임라인은 3D 높이를 84px 먹으므로 편집할 때만 양보한다 */}
          <button type="button" className={editing ? 'on' : ''} disabled={!cycleSec}
            onClick={() => setEditing((v) => !v)} data-t="tl-toggle">
            {editing ? '편집 끝' : '편집'}
          </button>
        </div>
      )}
      {picked && (
        <div className="view3d-pick">
          <b>{picked.name ?? picked.id}</b>
          <span className="dim">{picked.kind === 'station' ? '스테이션' : picked.type}</span>
          {picked.count > 1 && <span className="dim">{picked.count}개 선택</span>}
          {shown && (
            <>
              {/* 범위는 **방 치수에서 온다** — 매직넘버를 여기 박지 않는다 */}
              <NumBox
                label="x" value={shown.x} min={0} max={layout.floor.widthMm} step={100}
                onCommit={(v) => commitField({ posMm: [v, shown.y] })}
              />
              <NumBox
                label="y" value={shown.y} min={0} max={layout.floor.depthMm} step={100}
                onCommit={(v) => commitField({ posMm: [shown.x, v] })}
              />
              {/* **90° 단위만 받는다** — 벽에 붙이는 가구라 자유 각도는 쓸 일이 없고
                  `interaction.js` 의 회전도 같은 전제 위에 있다 */}
              <NumBox
                label="회전" value={shown.rot} min={-270} max={270} step={90}
                onCommit={(v) => commitField({ rotDeg: v })}
              />
              <span className="dim">mm · °</span>
            </>
          )}
          {/* **크기.** 부품마다 인자 이름이 달라 `catalog.js` 가 무엇을 보여줄지 정한다 */}
          {sizeKeys.map((k) => (
            <NumBox
              key={k} label={SIZE_LABEL[k]} value={sizeOf(k)}
              min={SIZE_RANGE_MM.min} max={SIZE_RANGE_MM.max} step={SIZE_RANGE_MM.step}
              onCommit={(v) => commitField({ opts: { [k]: v } })}
            />
          ))}
          {/* **AMR 만 경로를 갖는다.** 평소엔 선을 안 그리고 여기서 켠다 */}
          {picked.kind === 'amr' && (
            <button
              type="button" className={pathing ? 'on' : ''} data-t="path-toggle"
              onClick={() => setPathing((v) => !v)}
            >
              {pathing ? '경로 끝' : '경로'}
            </button>
          )}
          {/* **팔만 자세를 갖는다.** 소품에 관절이 있을 리 없다 */}
          {picked.kind === 'arm' && (
            <button
              type="button" className={posing ? 'on' : ''} data-t="pose-toggle"
              onClick={() => setPosing((v) => !v)}
            >
              {posing ? '자세 끝' : '자세'}
            </button>
          )}
          {/* **좌표가 아니라 틈이 알고 싶은 값이다** — 벽·이웃까지 몇 mm 남았나 */}
          {picked.gapsMm && (picked.gapsMm.xMm !== null || picked.gapsMm.zMm !== null) && (
            <span className="gap">
              틈 {[picked.gapsMm.xMm, picked.gapsMm.zMm]
                .filter((v) => v !== null).join(' · ')}mm
            </span>
          )}
        </div>
      )}
      </div>

      {/* ── 타임라인. **사건은 이름만 든다** — 자리·팔은 배치안에서 뽑은 목록이라 오타가 없다 */}
      {editing && (
        <div className="timeline" data-t="timeline">
          <div className="tl-head">
            <span>시나리오</span>
            <select
              className="tl-pick" value={scenarioId ?? ''}
              onChange={(e) => onPickScenario?.(e.target.value)}
            >
              {scenarios.map((S) => <option key={S.id} value={S.id}>{S.name}</option>)}
            </select>
            <button type="button" onClick={() => onDupScenario?.()}>복제</button>
            <button
              type="button"
              onClick={() => {
                const cur = scenarios.find((S) => S.id === scenarioId);
                // eslint-disable-next-line no-alert
                const n = prompt('시나리오 이름', cur?.name ?? '');
                if (n) onRenameScenario?.(n);
              }}
            >이름
            </button>
            <button type="button" onClick={() => onDelScenario?.()}
              disabled={scenarios.length <= 1}
            >삭제
            </button>
            <span className="tl-hint">
              마커를 <b>끌어</b> 시각을 바꾸고 <b>우클릭</b>하면 고칩니다 · 빈 곳 <b>더블클릭</b>이면 추가
            </span>
          </div>

          {/* 눈금 — 10초마다. 사이클이 길어지면 칸이 늘어난다 */}
          <div className="tl-ticks">
            {Array.from({ length: Math.floor(cycleSec / 10) + 1 }, (_, k) => k * 10).map((t) => (
              <span key={t} style={{ left: `${(t / cycleSec) * 100}%` }}>{t}</span>
            ))}
            <span className="end" style={{ left: '100%' }}>{cycleSec}</span>
          </div>

          {/* ── AMR 띠. **언제 어디로 가는지 한눈에** — 전에는 마커를 하나씩 우클릭해야
              알 수 있었다 (주인님 지적 · 2026-08-04).

              구간은 `timeline.js` §amrAt 규약을 그대로 읽는다: **사건 시각이 도착 시각**이라
              앞 사건(없으면 0초)부터 그 사건까지가 이동 구간이다. 사건이 없는 AMR 은
              줄 자체가 안 뜬다 — 안 움직이는 로봇에 빈 줄을 그으면 그것도 거짓말이다. */}
          {(layout.amrs ?? []).map((a) => {
            const mine = series
              .filter((e) => e.amr === a.id && e.amrAt)
              .sort((x, y) => x.tSec - y.tSec);
            if (!mine.length || !cycleSec) return null;
            let prev = 0;
            const legs = mine.map((e) => {
              const leg = { from: prev, to: e.tSec, at: e.amrAt };
              prev = e.tSec;
              return leg;
            }).filter((l) => l.to > l.from);
            return (
              <div className="tl-amr" key={a.id} data-t={`tl-amr-${a.id}`}>
                <span className="tl-amr-name">{a.id}</span>
                <span className="tl-amr-rail">
                  {legs.map((l) => (
                    <i
                      key={`${l.from}-${l.to}`}
                      style={{
                        left: `${(l.from / cycleSec) * 100}%`,
                        width: `${((l.to - l.from) / cycleSec) * 100}%`,
                      }}
                      data-t={`tl-leg-${a.id}`}
                      title={`${l.from}~${l.to}초 · ${l.at} 로`}
                    >
                      {(layout.stations ?? []).find((x) => x.id === l.at)?.name ?? l.at}
                    </i>
                  ))}
                </span>
              </div>
            );
          })}

          <div
            className="tl-track" ref={trackRef}
            onDoubleClick={(e) => {
              if (e.target !== e.currentTarget) return;   // 마커 더블클릭은 추가가 아니다
              onAddEvent?.(secAtX(e.clientX));
            }}
          >
            {/* 지금 시각 */}
            <i className="tl-cursor" style={{ left: `${cycleSec ? (tSec / cycleSec) * 100 : 0}%` }} />
            {series.map((e, i) => (
              <button
                type="button" key={`${i}-${e.tSec}`} className="tl-mark"
                style={{ left: `${cycleSec ? (e.tSec / cycleSec) * 100 : 0}%` }}
                data-t="tl-mark" data-i={i} data-sec={e.tSec}
                title={`${e.tSec}초 · ${EVENT_LABEL[e.event] ?? e.event ?? '—'}`}
                onPointerDown={(ev) => onMarkerDown(ev, i)}
                onPointerMove={onMarkerMove}
                onPointerUp={onMarkerUp}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  const r = hostRef.current?.getBoundingClientRect();
                  setEvMenu({ i, x: ev.clientX - (r?.left ?? 0), y: ev.clientY - (r?.top ?? 0) });
                }}
              >
                <b>{e.tSec}</b>
                <span>{EVENT_LABEL[e.event] ?? e.event ?? '—'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 자세 패널. **링을 돌리면 여기 숫자가 따라 움직이고, 숫자를 고치면 팔이 움직인다** */}
      {posing && picked?.kind === 'arm' && jointDeg && (
        <div className="pose-edit" data-t="pose-edit">
          <b>{picked.name ?? picked.id} 자세</b>
          {JOINTS.map((j) => (
            <label key={j}>
              {j}
              <input
                type="range" data-t={`pose-${j}`}
                min={JOINT_LIMITS_DEG[j][0]} max={JOINT_LIMITS_DEG[j][1]} step="1"
                value={jointDeg[j] ?? 0}
                onChange={(e) => setJointDeg((p2) => ({ ...p2, [j]: Number(e.target.value) }))}
              />
              <span>{Math.round(jointDeg[j] ?? 0)}°</span>
            </label>
          ))}
          {/* **한계에 걸린 것을 말한다** — 조용히 자르면 300 을 적고 175 를 본다 */}
          {clampMsg && <span className="warn" data-t="pose-clamp">{clampMsg}</span>}
          {poseMsg && <span className="warn" data-t="pose-msg">{poseMsg}</span>}
          {/* 손끝이 어디까지 갔나 — FK 실측이다. 자세를 만드는 내내 이 숫자를 본다 */}
          {tipMm && <span className="dim" data-t="pose-tip">손끝 {tipMm.join(', ')}mm</span>}
          <label className="pose-pair">
            바꿀 자세
            <select
              data-t="pose-pick" value={poseSel}
              onChange={(e) => {
                const n = e.target.value;
                setPoseSel(n);
                // 고른 자세를 **불러온다** — 있는 자세를 고쳐 쓰는 것이 새로 만드는 것보다 흔하다
                const src = (poses ?? PRESET_POSES)[n];
                if (src) setJointDeg(Object.fromEntries(JOINTS.map((j) => [j, src[j] ?? 0])));
              }}
            >
              <option value="">새 자세</option>
              {Object.keys(poses ?? PRESET_POSES).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="pose-act">
            <button
              type="button" data-t="pose-save"
              onClick={() => {
                // eslint-disable-next-line no-alert
                const n = prompt(poseSel ? `'${poseSel}' 을 덮어씁니다` : '자세 이름', poseSel || '새 자세');
                if (n) { onSavePose?.(n, jointDeg); setPoseSel(n); }
              }}
            >
              {poseSel ? '덮어쓰기' : '저장'}
            </button>
            {/* **지우는 길이 있어야 한다** — 넣기만 되면 목록이 영영 는다 */}
            <button
              type="button" data-t="pose-del" disabled={!poseSel}
              onClick={() => { onDeletePose?.(poseSel); setPoseSel(''); }}
            >
              삭제
            </button>
            {/* **여기서도 나갈 수 있어야 한다** — 폰에서는 자세 패널이 열리면 선택 패널(그리고
                거기 있는 `자세 끝`)을 접으므로, 나가는 길이 이 안에 없으면 갇힌다 */}
            <button type="button" data-t="pose-close" onClick={() => setPosing(false)}>끝</button>
          </div>
          {/* **저장 안 하면 사라진다는 것을 말한다** — 그래야 사람이 저장을 누른다 */}
          <span className="dim">출처 <b>손으로</b> · 저장해야 남아요</span>
        </div>
      )}

      {/* ── 경로 패널. **목적지까지 얼마나 빗나갔나를 계속 보여준다** — 그 값이 도달거리를
          넘으면 재생이 경로를 버리고 직선으로 간다 (`layout-view.js` §AMR). */}
      {amrPicked && (
        <div className="pose-edit path-edit" data-t="path-edit">
          <b>{picked.name ?? picked.id} 경로</b>
          <span className="dim" data-t="path-len">
            점 {(amrPicked.waypointsMm ?? []).length}개 · 길이
            {' '}{(pathLengthMm(amrPicked.waypointsMm ?? []) / 1000).toFixed(1)}m
          </span>
          {/* 시나리오가 이 AMR 을 보내는 자리마다 빗나감을 잰다 */}
          {[...new Set(series.filter((e) => e.amr === picked.id && e.amrAt).map((e) => e.amrAt))]
            .map((sid) => {
              const st2 = (layout.stations ?? []).find((x) => x.id === sid);
              const n = st2 ? nearestU(amrPicked.waypointsMm ?? [], st2.posMm) : null;
              const lim = amrPicked.reachMm ?? 400;
              return (
                <span key={sid} className={n && n.offMm > lim ? 'warn' : 'dim'} data-t={`path-off-${sid}`}>
                  {st2?.name ?? sid} 까지 {n ? `${n.offMm}mm` : '?'}
                  {n && n.offMm > lim ? ` · 도달 ${lim}mm 밖이라 직선으로 갑니다` : ' ✓'}
                </span>
              );
            })}
          <span className="dim">점을 끌어 옮겨요 · 우클릭하면 추가·삭제</span>
          {/* **여기서 다음 걸음을 말한다.** 경로만 그려 놓으면 아무 일도 안 일어난다 —
              그 경로를 **언제** 타는지는 사건이 정한다. 화면이 안 알려줘서 같은 질문을
              세 번 받았다 (2026-08-04). 그래서 말만 하지 않고 **대신 해 준다.** */}
          <span className="dim">
            경로만으로는 안 움직여요 — <b>사건</b>이 언제 탈지 정합니다
          </span>
          <div className="pose-act">
            <button
              type="button" data-t="path-to-scenario"
              onClick={() => { onUseInScenario?.(picked.id); setPathing(false); }}
            >
              시나리오에 넣기
            </button>
            <button type="button" data-t="path-close" onClick={() => setPathing(false)}>끝</button>
          </div>
        </div>
      )}

      {/* 경로 점 우클릭 메뉴 */}
      {pathMenu && amrPicked && (
        <div
          className="view3d-menu" data-t="path-menu"
          style={{
            left: Math.min(pathMenu.x, (hostRef.current?.clientWidth ?? 0) - 150),
            top: Math.min(pathMenu.y, (hostRef.current?.clientHeight ?? 0) - 100),
          }}
          onPointerLeave={() => setPathMenu(null)}
        >
          {pathMenu.atMm && (
            <button
              type="button" data-t="path-add"
              onClick={() => {
                onSetWaypoints?.(viewRef.current.pathGizmo.inserted(pathMenu.atMm), picked.id);
                setPathMenu(null);
              }}
            >여기에 점 추가
            </button>
          )}
          {/* **둘 밑으로는 안 줄인다** — 점 하나는 경로가 아니다 */}
          <button
            type="button" data-t="path-del"
            disabled={pathMenu.i < 0 || (amrPicked.waypointsMm ?? []).length <= 2}
            onClick={() => {
              onSetWaypoints?.(viewRef.current.pathGizmo.removed(pathMenu.i), picked.id);
              setPathMenu(null);
            }}
          >이 점 삭제
          </button>
        </div>
      )}

      {/* 사건 우클릭 메뉴. **자리·팔은 배치안에서 뽑는다** — 손으로 치면 오타가 나고,
          오타 난 자리는 재생이 조용히 건너뛴다 */}
      {evMenu && series[evMenu.i] && (
        <div
          className="view3d-menu ev-menu"
          style={{
            left: Math.min(evMenu.x, (hostRef.current?.clientWidth ?? 0) - 190),
            top: Math.max(8, evMenu.y - 210),
          }}
          onPointerLeave={() => setEvMenu(null)}
        >
          <label>
            시각
            <input
              type="number" min="0" step={SNAP_SEC} value={series[evMenu.i].tSec}
              onChange={(ev) => onMoveEvent?.(evMenu.i, Number(ev.target.value))}
            />
          </label>
          {/* **자유 입력이다.** 계약상 `event` 는 자유 문자열이고 화면도 모르는 이름을 그대로
              보여준다 — 목록에 가둘 이유가 없다. 아는 이름은 제안으로만 띄운다 */}
          <label>
            사건
            <input
              type="text" list="ev-names" data-t="ev-name" value={series[evMenu.i].event ?? ''}
              onChange={(ev) => onSetEvent?.(evMenu.i, { event: ev.target.value })}
            />
          </label>
          <datalist id="ev-names">
            {Object.entries(EVENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </datalist>
          <label>
            자리
            <select value={series[evMenu.i].station ?? ''}
              onChange={(ev) => onSetEvent?.(evMenu.i, { station: ev.target.value })}
            >
              <option value="">—</option>
              {(layout.stations ?? []).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}</option>)}
            </select>
          </label>
          <label>
            팔이 보는 곳
            <select value={series[evMenu.i].armAt ?? ''}
              onChange={(ev) => onSetEvent?.(evMenu.i, { armAt: ev.target.value })}
            >
              <option value="">—</option>
              {(layout.stations ?? []).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}</option>)}
            </select>
          </label>
          {/* **AMR 은 둘이 짝이다** — 어느 대가, 어느 자리로. 하나만 적으면 재생기가
              그 AMR 을 못 찾거나 목적지를 모른다 (`validateScenario` 가 거부한다).
              이 칸이 없어서 **화면만으로는 터틀봇을 움직일 방법이 아예 없었다** (2026-08-04). */}
          <label>
            AMR
            <select value={series[evMenu.i].amr ?? ''}
              onChange={(ev) => onSetEvent?.(evMenu.i, ev.target.value
                ? { amr: ev.target.value, amrAt: series[evMenu.i].amrAt ?? layout.stations?.[0]?.id }
                : { amr: '', amrAt: '' })}
              data-t="ev-amr"
            >
              <option value="">— (안 움직인다)</option>
              {(layout.amrs ?? []).map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
            </select>
          </label>
          {series[evMenu.i].amr && (
            <label>
              AMR 목적지
              <select value={series[evMenu.i].amrAt ?? ''}
                onChange={(ev) => onSetEvent?.(evMenu.i, { amrAt: ev.target.value })}
                data-t="ev-amrat"
              >
                <option value="">—</option>
                {(layout.stations ?? []).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}</option>)}
              </select>
            </label>
          )}
          <label>
            탄두 단계
            <select value={series[evMenu.i].stage ?? ''}
              onChange={(ev) => onSetEvent?.(evMenu.i,
                { stage: ev.target.value === '' ? undefined : Number(ev.target.value) })}
            >
              <option value="">— (직전 값을 잇는다)</option>
              {[3, 2, 1, 0].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {/* **자세는 사건이 든다** — 이름을 자유롭게 지으면 전역 표가 그 이름을 모른다.
              보관함에서 고르므로 오타가 불가능하다 (자리·팔과 같은 규칙) */}
          {ROLES.map((role) => (
            <label key={role} className="pose-pair">
              {role === 'process' ? '조립팔' : '투입팔'}
              {[0, 1].map((k) => (
                <select
                  key={k} data-t={`ev-pose-${role}-${k}`}
                  value={poseNameAt(series[evMenu.i], role, k)}
                  onChange={(ev) => onSetEvent?.(evMenu.i,
                    { pose: withPose(series[evMenu.i], role, k, ev.target.value) })}
                >
                  <option value="">—</option>
                  {Object.keys(poses ?? PRESET_POSES).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              ))}
            </label>
          ))}
          <label>
            운반
            <select value={series[evMenu.i].carry ?? ''}
              onChange={(ev) => onSetEvent?.(evMenu.i, { carry: ev.target.value })}
            >
              <option value="">— (아무도 안 든다)</option>
              <option value="process">조립팔이 들어요</option>
              <option value="feed">투입팔이 들어요</option>
            </select>
          </label>
          <hr />
          <button type="button" onClick={() => { onDupEvent?.(evMenu.i); setEvMenu(null); }}>복제</button>
          <button type="button" onClick={() => { onRemoveEvent?.(evMenu.i); setEvMenu(null); }}
            disabled={series.length <= 1}
          >삭제
          </button>
        </div>
      )}
      {/* **처음 한 번만.** 항상 떠 있으면 3D 를 계속 가린다 (2026-07-31 감사 P2).
          폰·데스크톱 문구를 하나로 합쳤다 — 회전은 위 버튼이 이미 알려준다 */}
      {!hintOff && (
        <div className="view3d-hint">
          <span>물건을 끌어서 옮겨보세요<br />100mm 격자에 붙어요 · <b>우클릭</b>하면 복제·회전·삭제가 나와요</span>
          <button type="button" onClick={closeHint} aria-label="안내 닫기">✕</button>
        </div>
      )}
      {/* 우클릭 메뉴. **화면 밖으로 안 나가게** 오른쪽·아래를 잘라 붙인다 */}
      {menu && (
        <ul
          className="view3d-menu"
          style={{
            left: Math.min(menu.x, (hostRef.current?.clientWidth ?? 0) - 150),
            top: Math.min(menu.y, (hostRef.current?.clientHeight ?? 0) - 140),
          }}
          onPointerLeave={() => setMenu(null)}
        >
          <li className="view3d-menu-head">{menu.item.name ?? menu.item.type ?? menu.item.id}</li>
          {MENU.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={m.danger ? 'danger' : undefined}
                disabled={m.id === 'undo' && !canUndo}
                onClick={() => {
                  const id = menu.item.id;
                  setMenu(null);
                  if (m.id === 'dup') actRef.current.onDuplicate?.(id);
                  if (m.id === 'rot') editRef.current?.rotate();
                  if (m.id === 'undo') actRef.current.onUndo?.();
                  if (m.id === 'del') actRef.current.onRemove?.(id);
                }}
              >
                <span>{m.label}</span><kbd>{m.key}</kbd>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
