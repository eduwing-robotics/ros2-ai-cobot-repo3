// 조그·그리퍼 상시 조작대 (FR5-IMPLEMENTATION-PLAN §레이아웃 · 2026-08-03 확정).
//
// **Live 패널의 소유물이 아니다.** Teach 는 로봇을 조그하며 쓰는 화면이라, 조작대가 Live 에만
// 있으면 "자세를 만든다 → 캡처한다" 사이에 탭이 두 번 바뀐다. 특히 그리퍼는 캡처가 굳히는
// 값(`gripperPct`)이라, 파지 자세 하나를 가르치려면 매번 Live 로 건너갔다 돌아와야 했다
// (2026-08-06 실기 지적).
//
// 안전 판정은 전부 서버가 한다. 여기 disabled 는 편의지 안전장치가 아니다
// (SAFETY-RULES 제2원칙). 조그·그리퍼 둘 다 서버가 조종권 + ARMED 를 다시 본다.
import { useEffect, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import gripperMount from '@fr5/shared/data/config/gripper-mount.json';

const JOINT_LABELS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
// 한 번에 미는 각도. **서버 상한(`safety.JOINT_DELTA_CAP_DEG` = 5°)까지 열어 둔다.**
// 1° 로 박혀 있었는데 바로 아래 안내문은 "5°/회" 라고 적혀 있었다 — 읽은 값과 눌리는 값이
// 달랐다. 그리고 손목의 1° 는 손끝에서 여러 mm 라, 파지 자세를 맞추려면 0.1° 가 필요하고
// 크게 옮길 땐 5° 가 필요하다. 상한을 넘는 값은 넣지 않는다 (넣어도 서버가 거부한다).
const JOG_STEPS = [0.1, 1, 5];
// 전역 속도 오버라이드 후보 — 서버가 **10~30** 만 받는다 (`safety.SPEED_OVERRIDE_*_PCT`).
// **0 도 1 도 넣지 않는다.** 0 은 이동을 전부 막고(`code=172`), 1~9 는 더 나쁘다 —
// 이동은 되면서 몇 배 느려지는데 서버 대기 계산이 그만큼 늘어나야 해서다.
// 상한 위(~100)는 펜던트에서 사람이 올린다 — `vel` 상한 10% 의 근거를 화면이 무너뜨리지 않는다.
const SPEED_OVR_STEPS = [10, 20, 30];

// 그리퍼 한 걸음(%). **1% 고정이고, 조그처럼 걸음 고르개를 두지 않는다.**
// 조그는 ± 밖에 없어서 큰 이동까지 걸음으로 해야 하지만, 그리퍼는 슬라이더가 이미 큰 이동을
// 맡는다 — 5%·10% 걸음은 슬라이더와 하는 일이 겹쳤다 (2026-08-08 실기 담당자 지적으로 걷어냈다).
// ± 는 미세조정 전용이다.
//
// 슬라이더 + 「n% 로」만 있을 때는 눈에 보이는 게 `완전 열기 / 50% 로 / 완전 닫기` 세 버튼이라
// 실기에서 "3단계뿐"으로 읽혔다. 값은 처음부터 0~100 전부 갈 수 있었다 —
// **모자랐던 건 범위가 아니라 그 사이를 한 번에 누를 손잡이였다.**
// 1% 가 하한인 이유는 SDK 다 — `MoveGripper` 가 pct 를 int 로 받는다 (`fairino.gripper_move`).
const GRIP_STEP_PCT = 1;
// 단위 변환은 한 곳에서만 (CLAUDE 하드룰 5). 0.4mm/% 를 손으로 적어 두면 행정이 바뀔 때
// 3D(`setGripperOpenPct`)와 이 숫자가 조용히 갈라진다 — 뿌리는 `gripper-mount.json` 하나다.
const GRIP_STROKE_MM = gripperMount.fingerHalfStrokeMm * 2;
const gripMm = (pct) => (pct * GRIP_STROKE_MM / 100).toFixed(1);

// 그리퍼는 관절이 아니다. 보내는 값과 읽는 값이 **같은 척도**다 (2026-08-04 실기 확인).
// 그래서 숫자를 하나만 보여준다. 반대라고 적혀 있던 8/3 기록은 수동 모드 관측이었다.
function Gripper({ gripper, busy }) {
  const [pct, setPct] = useState(50);
  const g = gripper ?? {};
  const active = g.active === true;
  // ± 는 **보낼 값**을 기준으로 민다 — 읽은 값을 기준으로 하면 물건을 물어 행정이 덜 끝났을 때
  // 누를 때마다 같은 자리로 되돌아간다. 지금 값은 아래 `지금 벌어짐` 이 따로 말한다.
  const send = (v) => {
    const t = Math.min(100, Math.max(0, Math.round(v)));
    setPct(t);
    datasource.gripper(t);
  };
  return (
    <div className="gripper" data-t="gripper">
      <h3>그리퍼</h3>
      {g.fault && (
        <p className="refusal" data-t="gripper-fault">
          그리퍼가 고장 신호를 냈다. 명령이 거부된다.
        </p>
      )}
      {!active && (
        <button type="button" data-t="gripper-activate" disabled={busy}
          onClick={() => datasource.gripperActivate()}>
          그리퍼 활성화
        </button>
      )}
      {!active && <p className="hint">활성화하면 손가락이 움직여요.</p>}
      <label>보낼 값 {pct}% <span className="mm">(벌어짐 약 {gripMm(pct)}mm)</span>
        <input type="range" min="0" max="100" step="1" value={pct} data-t="gripper-range"
          disabled={!active || busy} onChange={(e) => setPct(Number(e.target.value))} />
      </label>
      {/* ± 는 미세조정 전용이라 누르는 즉시 나간다. 가운데는 슬라이더로 크게 옮긴 값을 보내는 자리.
          조작대는 40dvh 안에서 조그와 자리를 나눠 쓰므로 줄을 하나라도 아낀다 —
          안 보이는 손잡이는 없는 손잡이다 (2026-08-06 표 사건과 같다) */}
      <div className="griprow">
        <button type="button" data-t="gripper-minus" disabled={!active || busy || pct <= 0}
          onClick={() => send(pct - GRIP_STEP_PCT)}>−{GRIP_STEP_PCT}%</button>
        <button type="button" data-t="gripper-send" disabled={!active || busy}
          onClick={() => datasource.gripper(pct)}>{pct}% 로</button>
        <button type="button" data-t="gripper-plus" disabled={!active || busy || pct >= 100}
          onClick={() => send(pct + GRIP_STEP_PCT)}>+{GRIP_STEP_PCT}%</button>
      </div>
      <div className="griprow griprow-2">
        <button type="button" data-t="gripper-open" disabled={!active || busy}
          onClick={() => send(100)}>완전 열기</button>
        <button type="button" data-t="gripper-close" disabled={!active || busy}
          onClick={() => send(0)}>완전 닫기</button>
      </div>
      <dl>
        <dt>지금 벌어짐</dt>
        {/* % 와 mm 은 **각자 자기 칸을 갖는다** — 한 노드에 이어 붙이면 게이트가 읽는 문자열이
            `0%` 에서 `0% 0.0mm` 로 조용히 바뀐다 */}
        <dd><span data-t="gripper-raw">{g.pct == null ? '—' : `${g.pct}%`}</span>
          {g.pct != null && <span className="mm gripmm" data-t="gripper-mm">{gripMm(g.pct)}mm</span>}</dd>
        <dt>상태</dt><dd>{g.motionDone === undefined ? '—' : g.motionDone ? '멈춤' : '움직이는 중'}</dd>
      </dl>
    </div>
  );
}

// `onHoverJoint(index|null)` — 관절 행을 **가리키는 동안만** 3D 가 그 링크 축을 띄운다.
// 「선택된 관절」 상태는 만들지 않는다: 조그는 누르는 즉시 실기가 움직이므로 그런 상태가
// 원래 없고, 만들면 화면이 없는 개념을 새로 만든다 (`SHARED-CORE.md` §프레임 축).
export function ControlDock({ state, who, onHoverJoint }) {
  const [refusal, setRefusal] = useState(null);
  const [stepDeg, setStepDeg] = useState(1);   // 조그 걸음. 훅은 아래 조기 반환보다 먼저다
  const [lastCmd, setLastCmd] = useState(null); // 마지막으로 보낸 조그 — 거부 사유가 「어느 버튼」 것인지 말하게 (UX 감사 2026-09-05)
  useEffect(() => datasource.subscribeRefusals(setRefusal), []);

  const mine = !!who && state.owner === who && datasource.hasOwnerToken();
  const armed = state.phase === 'ARMED' || state.phase === 'EXECUTING';

  // **왜 조종권·ARM 전에도 자리를 지키나** — 없어졌다 나타나면 사람이 "어느 탭이었지" 를
  // 다시 찾는다. 자리는 그대로 두고 지금 무엇이 모자란지 한 줄로 말한다.
  if (!mine || !armed) {
    return (
      <section className="dock dock-off" data-t="dock">
        <h3>조작대</h3>
        <p className="hint" data-t="dock-locked">
          {!state.connected ? '로봇에 연결하면 열려요.'
            : !mine ? '조종권을 잡으면 열려요.'
              : 'ARM 하면 열려요.'}
        </p>
      </section>
    );
  }

  return (
    <section className="dock" data-t="dock">
      <h3>조작대</h3>
      {/* 전역 속도 오버라이드 — **이 값이 0 이면 이동이 전부 거부된다** (`code=172`).
          2026-08-12 에 그 값이 0 인 채로 반나절을 태웠는데 화면에 보이지도 않았다.
          ⛔ **되읽기가 없다** — SDK 에 setter 만 있어서 여기 뜨는 숫자는 「우리가 보낸 값」이다.
          펜던트에서 누가 바꾸면 거짓이 되므로 **출처를 같이 적는다** (계약 §speed). */}
      <div className="speedovr" data-t="speed-ovr">
        <span className="mm">전역 속도</span>
        {SPEED_OVR_STEPS.map((v) => (
          <button key={v} type="button" data-t="speed-ovr-pick" data-pct={v}
            aria-pressed={state.speedOverridePct === v}
            onClick={() => datasource.setSpeedOverride(v)}>{v}%</button>
        ))}
        <span className="mm" data-t="speed-ovr-src">
          {state.speedOverridePct == null
            ? '아직 몰라요. 눌러서 정하면 그 값이 보여요'
            : `보낸 값 ${state.speedOverridePct}% · 실측 아님 (펜던트에서 바뀌면 거짓)`}
        </span>
      </div>
      <div className="jog">
        {/* 걸음을 먼저 고르고 축을 민다 — 파지 자세는 0.1°, 자리 옮기기는 5° 다 */}
        <div className="jogstep" data-t="jog-step">
          <span className="mm">한 걸음</span>
          {JOG_STEPS.map((d) => (
            <button key={d} type="button" data-t="jog-step-pick" data-deg={d}
              aria-pressed={stepDeg === d} onClick={() => setStepDeg(d)}>{d}°</button>
          ))}
        </div>
        {JOINT_LABELS.map((name, i) => (
          // `onFocus`·`onBlur` 도 같이 건다 — 폰엔 hover 가 없고 키보드로도 와야 한다.
          // React 의 focus 는 버블하므로 안쪽 버튼에서 와도 이 행이 받는다
          <div key={name} className="jogrow" data-t="jogrow" data-joint={name}
            onMouseEnter={() => onHoverJoint?.(i)} onMouseLeave={() => onHoverJoint?.(null)}
            onFocus={() => onHoverJoint?.(i)} onBlur={() => onHoverJoint?.(null)}>
            <span>{name}</span>
            <button type="button" onClick={() => { setLastCmd(`${name} −${stepDeg}°`); datasource.jog(i, -stepDeg); }}>−{stepDeg}°</button>
            <button type="button" onClick={() => { setLastCmd(`${name} +${stepDeg}°`); datasource.jog(i, +stepDeg); }}>+{stepDeg}°</button>
          </div>
        ))}
        {/* 큰 걸음은 그만큼 오래 걸린다 — 도착 전에 다시 누르면 서버가 「아직 움직이는
            중입니다」 로 거부한다 (조건 6·8). 고장이 아니라는 것을 여기서 미리 말한다 */}
        <p className="hint">서버 상한은 속도 10%, 관절 5°/회다. 넘으면 거부된다.
          걸음이 클수록 오래 걸리고, 멈추기 전에 다시 누르면 거부된다.</p>
      </div>
      <Gripper gripper={state.gripper} busy={false} />
      {refusal && (
        <p className="refusal" data-t="dock-refusal"><b>거부됨</b> {lastCmd && <span className="mm">({lastCmd} 요청) </span>}{refusal}</p>
      )}
    </section>
  );
}
