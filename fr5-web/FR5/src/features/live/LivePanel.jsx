// Live 패널 — 연결 진단 · 조종권/ARM · 6축/TCP 현재값 (FR5-IMPLEMENTATION-PLAN §화면 1).
//
// **3D 와 조작대(조그·그리퍼)는 여기 없다.** 둘 다 어느 탭에서도 살아 있어야 해서
// `main.jsx` 가 들고 있다 (계획 §레이아웃). 이 패널은 "로봇에 붙고 권한을 잡는" 일만 한다.
//
// 슬롯 편집·장기 그래프는 여기 넣지 않는다. 안전 판정은 전부 서버가 한다 —
// 이 화면의 disabled 는 편의지 안전장치가 아니다 (SAFETY-RULES 제2원칙).
import { useEffect, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { Section } from '../Section.jsx';

const JOINT_LABELS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
const TCP_LABELS = ['x mm', 'y mm', 'z mm', 'rx °', 'ry °', 'rz °'];

/** TCP 숫자가 **어느 기준인지** 적는다 — D87 의 제목이 "숫자만으로는 어디인지 모른다" 다.
 *
 * `tcpMmDeg` 는 **베이스가 아니라 사용자 좌표계 기준**이고 툴 오프셋이 이미 적용돼 있다.
 * 그걸 베이스로 읽어 하루를 잃은 적이 있다 (`Shared/data/workcell.js` 머리말 · D87).
 * 화면이 숫자만 띄우면 다음 사람이 같은 하루를 잃는다.
 *
 * **번호를 박지 않는다** — `state.coord` 가 실제로 쓰는 번호를 낸다. 실기가 `config.yaml`
 * 과 다른 좌표계로 도는 일이 실제로 있다 (`GAP-MATRIX` §toolCoordId · 실기 tool 1).
 * 못 읽으면 "모른다" 고 적는다 — 0 으로 채워 아는 척하지 않는다 (제1원칙).
 */
function tcpFrameNote(state) {
  const c = state?.coord;
  const z = state?.coordDefs?.tool?.[2];
  if (!c || !Number.isFinite(c.userId)) return '⚠ 좌표계를 못 읽었어요. 이 숫자의 기준을 알 수 없어요';
  const tool = Number.isFinite(z) && z !== 0
    ? `공구 ${c.toolId} (Z +${z.toFixed(1)}mm 포함)`
    : `공구 ${c.toolId}`;
  return `기준 ${tool} · 사용자 ${c.userId} · 베이스 기준과 다릅니다`;
}

export function LivePanel({ state, who }) {
  const [robots, setRobots] = useState([]);
  const [picked, setPicked] = useState('');
  const [version, setVersion] = useState(null);
  const [lastRefusal, setLastRefusal] = useState(null);   // fail-closed 사유는 사람이 읽는다 (D40)
  const [busy, setBusy] = useState(false);
  const [siteConfirmed, setSiteConfirmed] = useState(false);

  useEffect(() => {
    datasource.getRobots().then((list) => {
      // **배열이 아니면 안 받는다** — 브리지가 죽으면 `api()` 가 `{ok:false}` 를 준다.
      // 그걸 그대로 state 에 넣으면 `robots.map` 이 터져 **화면 전체가 하얘진다**
      // (2026-08-28 실측 — 「대시보드가 안 켜진다」의 정체가 이 한 줄이었다).
      if (!Array.isArray(list)) {   // 못 받은 것도 사람에게 말한다 (제1원칙 · UX 감사 2026-09-05)
        setLastRefusal('로봇 목록을 못 받았습니다 — 브리지가 안 떴거나 주소가 틀렸어요. 허브(고리)에서 브리지 칸을 보세요.');
        return;
      }
      setRobots(list);
      // `?robot=<id>` 가 목록에 있으면 그것부터 — 없으면 첫 항목. 핸드오프 명령(`?robot=fr5-mock-lab`)이 이걸 전제했는데
      // 2026-09-07 까지 안 읽어서 「연결」이 실기(fr5-lab-a)로 나가 FAIL_CLOSED 4초를 먹었다
      const want = new URLSearchParams(window.location.search).get('robot');
      const fromUrl = list.find((r) => r.robotId === want)?.robotId;
      setPicked((p) => p || fromUrl || list[0]?.robotId || '');
    }).catch((e) => setLastRefusal(`브리지에 닿지 못했습니다: ${e?.message || e}`));
  }, []);
  useEffect(() => datasource.subscribeRefusals(setLastRefusal), []);
  useEffect(() => {
    if (state.connected) datasource.getVersion().then((v) => v.ok !== false && setVersion(v));
    else setVersion(null);
  }, [state.connected]);

  // **`try/finally` 가 없어서 영구히 잠겼다** (감사 2026-08-06 P0). 브리지가 못 답하면
  // `fetch` 가 거절하고 `setBusy(false)` 가 영영 안 돌아 연결·조종권·ARM·DISARM 버튼이
  // 전부 죽은 채로 남았다 — 새로고침 말고는 나갈 길이 없었다. Teach·Program 은 이미
  // 이 모양이었고 Live 만 남아 있었다. 그리고 **못 닿은 것도 사람에게 말한다** (제1원칙).
  const run = async (fn) => {
    setBusy(true);
    try {
      const res = await fn();
      setLastRefusal(res?.ok === false ? (res.reasons || [res.reason || '거부됨']).join(' · ') : null);
    } catch (e) {
      setLastRefusal(`브리지에 닿지 못했습니다: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // 이름이 같아도 **토큰이 없으면 내 것이 아니다** — 그래야 다시 잡을 길이 열린다.
  // 이름만 보고 판단하면 새로고침 뒤 반납·DISARM 이 전부 거부되며 갇힌다 (2026-08-04 실측)
  const sameName = who && state.owner === who;
  const mine = sameName && datasource.hasOwnerToken();
  const armed = state.phase === 'ARMED' || state.phase === 'EXECUTING';

  // 지금 몇 번째 칸인가 — 처음 온 사람은 순서를 모른다. 회색 버튼은 순서를 안 알려준다
  // (감사 2026-08-06 P1 · Program 이 이미 쓰던 규칙을 여기로 옮겼다).
  const step = !who.trim() ? 0 : !state.connected ? 1 : !mine ? 2 : !armed ? 3 : 4;
  const STEPS = ['이름 적기', '로봇에 연결', '조종권 잡기', 'ARM 하기', '조작 가능'];

  return (
    <div className="live">
      <ol className="startguide" data-t="startguide">
        {STEPS.map((label, i) => (
          <li key={label} data-at={String(i === step)} data-done={String(i < step)}>{label}</li>
        ))}
      </ol>

      {/* **연결되면 접는다** — 붙은 뒤 이 칸이 하는 말은 「연결 해제」뿐이고, 그 자리는
          지점·궤적이 쓴다. 거부·FAIL_CLOSED 는 접혀도 머리에 `!` 로 남는다 */}
      <Section id="diag" className="card diag" title="연결 진단"
        autoFold={state.connected}
        warn={state.phase === 'FAIL_CLOSED' || !!lastRefusal}
        note={state.connected ? `${state.robotId} 연결됨` : '아직 연결 안 됨'}>
        <label>로봇 프로필
          <select value={picked} disabled={state.connected || busy}
            onChange={(e) => setPicked(e.target.value)}>
            {robots.map((r) => (
              <option key={r.robotId} value={r.robotId}>{r.name} · {r.endpoint}</option>
            ))}
          </select>
        </label>
        {state.connected
          ? <button type="button" onClick={() => run(() => datasource.disconnect(who))} disabled={busy}>연결 해제</button>
          : <button type="button" className="primary" onClick={() => run(() => datasource.connect(picked))}
              disabled={busy || !picked}>
              연결 (보기만 · observe-only)
            </button>}
        {!state.connected && (
          <p className="hint">붙어서 값만 읽어요. 이 단계에서는 로봇이 움직이지 않아요.</p>
        )}
        {lastRefusal && <p className="refusal" data-t="refusal"><b>거부됨</b> {lastRefusal}</p>}
        {state.phase === 'FAIL_CLOSED' && state.failReason
          && <p className="refusal" data-t="refusal"><b>FAIL_CLOSED</b> {state.failReason}</p>}
        <dl>
          <dt>브리지 재접속</dt><dd className="ws-reconnects" data-t="ws-reconnects">{datasource.wsReconnects()}회</dd>
          {version && <>
            <dt>SDK</dt><dd>{version.sdk ?? '미보고'}</dd>
            <dt>컨트롤러</dt><dd>{version.controller ?? '미보고'}</dd>
          </>}
        </dl>
      </Section>

      <section className="card control" data-t="control">
        <h2>조종권 · 명령</h2>
        {!state.connected && <p className="hint">먼저 위에서 연결하면 조종권을 잡을 수 있어요.</p>}
        {state.connected && (
          <>
            {/* **회색 버튼은 이유를 안 알려준다** — 툴팁은 손가락에 안 뜬다 (감사 2026-08-06 P1).
                못 누르는 이유를 문장으로 적는다. Program 이 쓰던 규칙과 같은 모양이다 */}
            {!mine && !who.trim() && (
              <p className="hint" data-t="claim-blocked">
                이름부터 적으세요. 화면 오른쪽 위 <b>이름</b> 칸입니다.
              </p>
            )}
            {mine
              ? <>
                  <button type="button" onClick={() => run(() => datasource.releaseOwner(who))} disabled={busy}>
                    조종권 반납
                  </button>
                  <button type="button" data-t="reclaim"
                    onClick={() => run(() => datasource.claimOwner(who))} disabled={busy}>
                    조종권 다시 잡기
                  </button>
                </>
              : <button type="button" className="primary" disabled={busy || !who.trim()}
                  data-t="claim"
                  onClick={() => run(() => datasource.claimOwner(who))}>
                  {sameName ? '조종권 다시 잡기' : '조종권 잡기'}
                  {state.owner && state.owner !== who ? ` (현재 ${state.owner})` : ''}
                </button>}
            {sameName && !mine && (
              <p className="hint" data-t="token-lost">
                이름은 {who} 로 잡혀 있지만 이 창에는 증표가 없습니다.
                (새로고침하면 이렇게 됩니다.) 다시 잡으면 새 증표를 받습니다.
              </p>
            )}
            {mine && !armed && (
              <div className="armrow">
                <label className="confirm" data-t="confirm">
                  <input type="checkbox" checked={siteConfirmed}
                    onChange={(e) => setSiteConfirmed(e.target.checked)} />
                  현장에 사람이 있고 즉시 정지할 수 있다
                </label>
                <button type="button" className="arm" data-t="arm" disabled={busy || !siteConfirmed}
                  onClick={() => run(() => datasource.arm(who))}>
                  ARM (움직일 수 있게)
                </button>
                {!siteConfirmed
                  ? <p className="hint" data-t="arm-blocked">위 칸에 체크하면 ARM 할 수 있어요.</p>
                  : <p className="hint">누르면 서보가 켜지고 아래 조작대가 열려요.</p>}
              </div>
            )}
            {mine && armed && (
              <>
                <button type="button" onClick={() => run(() => datasource.disarm(who))} disabled={busy}>
                  DISARM (다시 잠그기)
                </button>
                <p className="hint">누르면 서보가 꺼지고 조작대가 닫혀요.</p>
              </>
            )}
            {/* 모드 토글은 헤더 안전 바에, 조그·그리퍼는 아래 조작대에 있다 — 둘 다 상시다 */}
          </>
        )}
      </section>

      {/* **연결 전에는 표를 안 그린다** (감사 2026-08-06 P1). 붙기 전 이 두 표는 12행이
          전부 `—` 였고, 첫 화면에서 제일 넓은 면적을 아무 뜻 없는 대시가 먹었다. 그 자리는
          「지금 무엇을 하면 되나」 가 쓸 자리다 (위 startguide). 연결되면 그대로 돌아온다. */}
      {state.connected && (
        <>
          {/* **기본 접힘이다** — 3D 쌍둥이가 자세를 이미 보여주고 안전 바가 단계를 말한다.
              숫자가 필요한 순간(조그 1° 가 눈에 안 보일 때)에 펴고, 그 선택은 기억된다.
              12행 두 표가 패널 높이의 절반을 먹던 자리다 (2026-08-10 실측 237px 초과) */}
          <Section id="joints-box" className="card" title="관절 각도 (°)" autoFold
            note={`j1 ${state.jointsDeg[0].toFixed(1)}° …`}>
            <table className="joints" data-t="joints"><tbody>
              {JOINT_LABELS.map((name, i) => (
                <tr key={name}><th>{name}</th>
                  <td>{state.jointsDeg[i].toFixed(3)}</td></tr>
              ))}
            </tbody></table>
          </Section>
          <Section id="tcp-box" className="card" title="손끝 위치 · TCP (mm·°)" autoFold
            note={`x ${state.tcpMmDeg[0].toFixed(0)} · y ${state.tcpMmDeg[1].toFixed(0)} · z ${state.tcpMmDeg[2].toFixed(0)}`}>
            <table className="tcp" data-t="tcp"><tbody>
              {TCP_LABELS.map((name, i) => (
                <tr key={name}><th>{name}</th>
                  <td>{state.tcpMmDeg[i].toFixed(3)}</td></tr>
              ))}
            </tbody></table>
            <p className="framenote" data-t="tcp-frame">{tcpFrameNote(state)}</p>
          </Section>
        </>
      )}
    </div>
  );
}
