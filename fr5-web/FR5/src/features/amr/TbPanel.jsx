// 「터틀봇」 탭 — 로봇 카드 · E-STOP · 조종(WASD) · 경로 · 조종권 · 맵 슬롯 · 스크립트 슬롯 · 로그.
//
// 옛 터틀봇 웹앱의 주행 탭(`drive/DrivePanel.jsx` · 퇴역)을 그대로 옮겼다
// (D182 · 2026-09-05). **2D 맵 캔버스는 안 옮겼다** — 목업 지형 위 점 하나였고, 그 값은
// 왼쪽 3D 트윈이 실측(자세·자취·되감기)으로 그린다. 그래서 이 탭은 **조작만** 남는다.
//
// 화면은 datasource 만 안다(`datasource.tb`). 규칙(조종권·전이)은 브리지 몫이고 여기는 사유를
// 보여줄 뿐이다. 주소를 모르면(`?tb=` 없음) 조작 대신 그 사실을 말한다 — 고장이 아니라 안 켠 것.
import { useEffect, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { AMR_HOME } from '@fr5/shared/data/workcell.js';
import { Teleop } from './Teleop.jsx';
import { LogPanel } from './LogPanel.jsx';
import { RunPanel } from './RunPanel.jsx';

// 배터리 판정은 **전압**으로 한다 (계약 §배터리) — 3셀 리포는 부하에 순간 전압이 주저앉고
// OpenCR 이 그 순간값으로 모터를 끊는다. 못 읽으면 「괜찮다」가 아니라 「모른다」다
const battLevel = (v) => (v == null ? '' : v < 11.0 ? 'danger' : v < 11.5 ? 'warn' : 'ok');

// 보내면 무슨 일이 일어나나 — 실행기(run-path.py)와 **같은 규칙**으로 미리 센다.
// 「왜 돌지?」가 나오는 자리가 여기다: 15도 넘게 틀어져 있으면 제자리 회전이 먼저다
const TURN_FIRST_DEG = 15;
function preview(pose, wp) {
  if (!pose || !wp) return null;
  const dx = wp.xMm - pose.xMm, dy = wp.yMm - pose.yMm;
  const dist = Math.hypot(dx, dy);
  const bearing = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  const turn = ((bearing - pose.thetaDeg + 540) % 360) - 180;
  return { dist, turn, arrived: dist <= (wp.arriveMm ?? 30) };
}

export function TbPanel({ who, state, onReplay }) {
  const tb = datasource.tb;
  const [snap, setSnap] = useState(null);
  // 기본은 실기로 붙는 그 한 대 — `AMR_HOME.robotId`(tb3_2). 1호기는 파이가 안 뜬다 (GAP P3)
  const [robot, setRobot] = useState(AMR_HOME.robotId);
  const [slots, setSlots] = useState([]);
  const [maps, setMaps] = useState([]);
  const [pickedSlot, setPickedSlot] = useState(null);
  const [paths, setPaths] = useState([]);
  const [pathName, setPathName] = useState('to-1');
  const [pathDoc, setPathDoc] = useState(null);
  const [confirmDel, setConfirmDel] = useState('');   // 두 번 눌러야 지워진다 — 되돌릴 수 없다
  const [confirmZero, setConfirmZero] = useState(false);
  const [dwell, setDwell] = useState(1);        // 각 점에서 멈추는 시간(초)
  const [notice, setNotice] = useState('');
  const host = tb.host();

  useEffect(() => tb.subscribeState(setSnap), [tb, host]);   // 주소가 늦게 와도 다시 붙는다
  // 로봇을 바꾸면 **2단계 확인은 전부 무효** — A 에서 1차 누르고 B 로 옮기면 B 에 원점 재설정이 나가던 자리 (감사 2026-09-05 P0)
  useEffect(() => { setConfirmZero(false); setConfirmDel(''); }, [robot]);
  // 고른 로봇이 스냅샷에 없으면 **있는 쪽으로 선택을 옮긴다** — 화면은 tb3_1 을 그리는데 E-STOP 은 tb3_2 로 가던 불일치
  useEffect(() => {
    const ids = Object.keys(snap?.robots ?? {});
    if (ids.length && !ids.includes(robot)) setRobot(ids[0]);
  }, [snap, robot]);
  useEffect(() => { if (host) { tb.getSlots().then(setSlots); tb.getMaps().then(setMaps); } }, [tb, host]);
  const reloadPaths = () => tb.getPaths().then(setPaths);
  useEffect(() => { if (host) reloadPaths(); }, [host]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 고른 경로의 점 목록 — 「내가 뭘 저장했더라」를 화면이 답한다
  useEffect(() => {
    if (!pathName || !host) return setPathDoc(null);
    tb.getPath(pathName).then((d) => setPathDoc(d?.points ? d : null)).catch(() => setPathDoc(null));
  }, [pathName, paths, host]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 실측 되감기 — 시뮬 탭에서 옮겨 왔다 (2026-09-06 phase 5). 터틀봇이 남긴 주행 기록이니 터틀봇 탭이 제자리다.
  // 기록은 **FR5 브리지**가 파일로 갖고 있어 터틀봇 브리지 주소가 없어도 산다 — 그래서 아래 어느 return 에도 들어간다.
  // 고스트 주인이 하나뿐이라(시뮬 절이 같이 안 산다) `onReplay` 를 조건 없이 준다
  const runs = (
    <section data-t="tb-runs">
      <h3>되감기 <span className="dim">실측 기록 · 시뮬 아님</span></h3>
      <RunPanel state={state} onReplay={onReplay} />
    </section>
  );

  if (!host) {
    return (
      <div className="tbpanel" data-t="tb-panel" data-host="none">
        <p className="notice">터틀봇 브리지 주소를 몰라요 — 이 페이지를 <code>?tb=192.168.30.15:5056</code> 으로 한 번
          열면 기억해요. 목업으로 보려면 <code>?tb=mock</code>.</p>
        <p className="dim">브리지는 로봇 파이 안에서 돈다 (`/터틀봇` 스킬). 주소가 없는 건 고장이 아니라 안 켠 것이에요.</p>
        {runs}
      </div>
    );
  }
  if (!snap) {
    return (
      <div className="tbpanel" data-t="tb-panel" data-host={host}>
        <p className="notice warn" data-t="tb-waiting">터틀봇 브리지({host}) 상태를 기다리는 중 — 안 오면 파이가 꺼졌거나 주소가 옛것이에요.</p>
        {runs}
      </div>
    );
  }
  const robots = snap.robots ?? {};
  const me = robots[robot];   // 폴백 없음 — 위 effect 가 선택을 옮길 때까지 한 프레임 「없음」이 낫다(대상 불일치보다)
  if (!me) return <div className="tbpanel" data-t="tb-panel"><p className="notice">브리지에 등재된 로봇이 없어요</p>{runs}</div>;
  const mocked = snap.mocked ?? [];              // 계약 §목업 목록 — 화면은 이 배열로만 판단한다
  // 내 이름과 소유자가 다르면 무엇을 눌러도 403 이다. 아예 못 누르게 하고 이유를 버튼에 붙인다
  const mine = me.owner === who;
  const notMine = mine ? '' : (me.owner ? `조종권이 ${me.owner} 에게 있어요 — 나는 ${who}` : `조종권을 먼저 claim 해요 (나: ${who})`);

  const act = async (fn) => {
    const res = await fn();
    setNotice(res?.ok ? '' : (res?.reason ?? '실패'));
  };
  const actPath = async (fn) => { await act(fn); reloadPaths(); };
  const here = paths.find((p) => p.name === pathName);

  return (
    <div className="tbpanel" data-t="tb-panel" data-host={host} data-adapter={snap.adapter}>
      {/* 로봇 카드 — 트윈이 그리는 로봇이 누구인지와 같은 이름을 쓴다 (AMR_HOME.robotId) */}
      <div className="robot-cards" data-t="tb-robots">
        {Object.entries(robots).map(([id, r]) => (
          <button key={id} type="button" className="robot-card" aria-selected={robot === id}
                  onClick={() => setRobot(id)}>
            <b>{id}</b>
            <span className={`badge ${r.connected ? 'ok' : 'danger'}`}>
              {r.connected ? 'connected' : 'disconnected'}</span>
            <span className={`badge ${battLevel(r.batteryV)}`}>
              {r.batteryPct ?? '—'}%{r.batteryV != null && ` · ${r.batteryV.toFixed(1)}V`}</span>
            <span className={`badge ${r.mode === 'idle' ? '' : 'info'}`}>{r.mode}</span>
            <span className="dim">pose {r.poseAgeSec}s · {r.activeMap ?? '맵 없음'}</span>
          </button>
        ))}
        <p className="dim bridge-health">
          {host} · <b data-t="tb-adapter">{snap.adapter}</b> · 연결 {Object.values(robots).filter((r) => r.connected).length}
          /{Object.keys(robots).length} · 위치는 왼쪽 3D 가 그려요
          {mocked.length > 0 && <span className="badge warn" title={`아직 흉내예요: ${mocked.join(' · ')}`}> 목업 {mocked.length}</span>}
        </p>
      </div>

      {/* 비상 버튼은 스크롤 없이 항상 보인다 — 헤더 STOP 도 이걸 같이 보낸다(계약 ④) */}
      <button type="button" className="tb-estop" data-t="tb-estop"
              onClick={() => act(() => tb.estop(robot))}>
        E-STOP — {robot} 즉시 정지</button>

      {battLevel(me.batteryV) === 'danger' && (
        <p className="notice warn">배터리 {me.batteryV.toFixed(2)}V — 저전압 경고선(11.0V) 아래예요.
          부하가 걸리면 OpenCR 이 모터를 끊어 <b>조종이 안 먹습니다</b>. 충전하거나 교체해요</p>
      )}
      {battLevel(me.batteryV) === 'warn' && (
        <p className="notice">배터리 {me.batteryV.toFixed(2)}V — 경고선(11.0V)에 가까워요.
          주행 중 끊기면 이걸 먼저 의심해요</p>
      )}

      <section>
        <h3>조종 <span className="dim">WASD · 누르는 동안만</span></h3>
        <Teleop robot={robot} who={who} />
      </section>

      {/* 경로 — 텔레옵으로 세운 그 자세를 점으로 굳힌다 (계약 §경로 · D136) */}
      <section>
        <h3>경로 <span className="dim">지금 자리를 점으로</span></h3>
        <div className="row">
          <input list="tb-paths" value={pathName} placeholder="경로 이름 (to-1)"
                 onChange={(e) => setPathName(e.target.value.trim())} />
          <datalist id="tb-paths">
            {paths.map((p) => <option key={p.name} value={p.name} />)}
          </datalist>
          <span className="dim">{here ? `${here.points}점` : '새 경로'}</span>
        </div>
        {/* 원점 재설정 — 홈 표시 위에 세운 「지금 자세」를 (0,0,0) 으로 (계약 §원점 재설정) */}
        <div className="row">
          <button type="button" className={confirmZero ? 'danger' : ''} disabled={!mine}
                  title={notMine || '홈 표시 위에 정확히 세운 뒤 누른다 — 위치도 방향도'}
                  onClick={() => {
                    if (confirmZero) {
                      setConfirmZero(false);
                      act(() => tb.resetOdom(robot, who));
                    } else {
                      setConfirmZero(true);
                      setTimeout(() => setConfirmZero(false), 4000);
                    }
                  }}>
            {confirmZero ? '지금 자세를 (0,0,0) 으로?' : '🎯 여기를 원점으로'}</button>
        </div>

        <div className="row">
          <button type="button" className="primary" disabled={!pathName}
                  title={pathName ? '지금 자세를 점으로' : ''}
                  onClick={() => actPath(() => tb.appendHere(pathName, robot))}>
            📍 여기를 웨이포인트로</button>
          <button type="button" disabled={!here?.points}
                  onClick={() => actPath(() => tb.popPath(pathName))}>↩ 마지막 점</button>
          {/* 삭제는 되돌릴 수 없다 — 한 번 더 누르게 한다. 4초 뒤 저절로 풀린다 */}
          <button type="button" className={confirmDel === pathName ? 'danger' : ''} disabled={!here}
                  onClick={() => {
                    if (confirmDel === pathName) {
                      setConfirmDel('');
                      actPath(() => tb.deletePath(pathName));
                    } else {
                      setConfirmDel(pathName);
                      setTimeout(() => setConfirmDel((c) => (c === pathName ? '' : c)), 4000);
                    }
                  }}>
            {confirmDel === pathName ? `정말 「${pathName}」 지울까요?` : '🗑 경로 삭제'}</button>
        </div>
        {/* 실행기는 「지금 서 있는 자리」에서 출발한다 — 경로 밖이면 복귀부터 한다 */}
        {(() => {
          const wp0 = pathDoc?.points?.[0];
          const pv = wp0 ? preview(me.pose, wp0) : null;
          if (!pv) return null;
          if (pv.arrived) {
            if (wp0.thetaDeg == null) return null;
            const dth = ((wp0.thetaDeg - me.pose.thetaDeg + 540) % 360) - 180;
            if (Math.abs(dth) <= (wp0.arriveDeg ?? 10)) return null;
            return (
              <p className="notice warn">
                ⚠ 자리는 맞는데 방향이 <b>{Math.abs(dth).toFixed(0)}°</b> 틀어져 있어요 —
                제자리에서 <b>{Math.abs(dth).toFixed(0)}° {dth > 0 ? '좌' : '우'}회전</b> 먼저 합니다
              </p>
            );
          }
          const dir = pv.turn > 0 ? '좌' : '우';
          return (
            <p className="notice warn">
              ⚠ 지금 자리가 경로 밖이에요 — 첫 점까지 <b>{pv.dist.toFixed(0)}mm</b>
              {Math.abs(pv.turn) > TURN_FIRST_DEG
                ? <> · 제자리에서 <b>{Math.abs(pv.turn).toFixed(0)}° {dir}회전</b> 먼저 하고 </>
                : ' · 바로 '}
              움직입니다
            </p>
          );
        })()}

        <div className="row">
          <button type="button" disabled={!here?.points || me.mode !== 'idle' || !mine}
                  title={notMine || (me.mode !== 'idle' ? `mode=${me.mode} — idle 에서만 시작해요`
                         : 'run-path 슬롯으로 이 경로를 순서대로 돈다 — 출발은 언제나 지금 서 있는 자리다')}
                  onClick={() => act(() => tb.startSlot('run-path', robot, who, { path: pathName }))}>
            ▶ 이 경로로 보내기</button>
        </div>

        {/* 각 점에서 멈추기 — 적재·파지처럼 사람이나 팔이 일할 틈 (계약 §경로 dwellSec) */}
        {pathDoc?.points?.length > 0 && (
          <div className="row">
            <input type="number" min="0" max="60" value={dwell} style={{ width: 64, margin: 0 }}
                   onChange={(e) => setDwell(Math.max(0, Math.min(60, Number(e.target.value) || 0)))} />
            <span className="dim">초 멈춤</span>
            <button type="button"
                    onClick={() => actPath(() => tb.putPath(pathName, {
                      ...pathDoc,
                      points: pathDoc.points.map((w) => ({ ...w, dwellSec: dwell })),
                    }))}>모든 점에 적용</button>
          </div>
        )}

        {paths.length > 0 && (
          <div className="path-chips">
            {paths.map((p) => (
              <button key={p.name} type="button" className="chip-path"
                      aria-selected={p.name === pathName} onClick={() => { setConfirmDel(''); setPathName(p.name); }}>
                {p.name} <span className="dim">{p.points}</span>
              </button>
            ))}
          </div>
        )}

        {pathDoc?.points?.length > 0 && (
          <ol className="path-points">
            {pathDoc.points.map((wp, i) => {
              const pv = i === 0 ? preview(me.pose, wp) : null;
              return (
                <li key={i}>
                  <span className="mono">
                    ({wp.xMm.toFixed(0)}, {wp.yMm.toFixed(0)})
                    {wp.thetaDeg != null && ` ${wp.thetaDeg.toFixed(0)}°`}
                    {wp.dwellSec > 0 && ` ⏸${wp.dwellSec}s`}
                  </span>
                  {pv && (
                    <span className={`dim${pv.arrived ? ' ok' : ''}`}>
                      {pv.arrived
                        ? ' — 이미 도착선 안'
                        : ` — ${pv.dist.toFixed(0)}mm${Math.abs(pv.turn) > TURN_FIRST_DEG
                            ? ` · ${pv.turn > 0 ? '↺' : '↻'}${Math.abs(pv.turn).toFixed(0)}° 먼저 돈다`
                            : ' · 바로 직진'}`}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section data-t="tb-owner">
        <h3>조종권 <span className="dim">로봇별 독립</span>
          {!mine && <span className="badge warn">내 것 아님</span>}</h3>
        {notMine && <p className="notice warn">{notMine}</p>}
        <div className="row">
          <span>소유자 <b>{me.owner ?? '없음'}</b> · 나 <b>{who}</b></span>
          {me.owner === who
            ? <button type="button" onClick={() => act(() => tb.releaseOwner(robot, who))}>반납</button>
            : <button type="button" disabled={!who} onClick={() => act(() => tb.claimOwner(robot, who))}>내가 claim</button>}
        </div>
      </section>

      <section>
        <h3>맵 슬롯 <span className="dim">nav {me.nav ?? '—'}</span>
          {mocked.includes('maps') && <span className="badge warn">목업</span>}</h3>
        {maps.length === 0
          ? <p className="dim">저장된 맵이 없어요 — 매핑은 파이에서 직접 한다 (계약 §매핑)</p>
          : <select value={me.activeMap ?? ''}
                    onChange={(e) => e.target.value && act(() => tb.activateMap(e.target.value, robot))}>
              <option value="">맵 선택 (AMCL 재기동)</option>
              {maps.map((m) => (
                <option key={m.name}>{m.name}{mocked.includes('maps') ? ' — 목업' : ''}</option>
              ))}
            </select>}
      </section>

      <section>
        <h3>스크립트 슬롯 <span className="dim">{slots.length}개</span></h3>
        <div className="slot-list">
          {slots.map((s) => (
            <button key={s.name} type="button" className="slot-card"
                    aria-selected={pickedSlot === s.name} onClick={() => setPickedSlot(s.name)}>
              <b>{s.name}</b><span className="dim">{s.description}</span>
            </button>
          ))}
        </div>
        <div className="row">
          <button type="button" className="primary" disabled={!pickedSlot}
                  onClick={() => act(() => tb.startSlot(pickedSlot, robot, who))}>
            ▶ 시작</button>
          <button type="button" onClick={() => act(() => tb.stopRobot(robot))}>■ 정지</button>
          <button type="button" disabled={!me.activeRunId}
                  title={mocked.includes('rosbag')
                    ? '아직 흉내예요 — run 에 경로 문자열만 남고 실제 녹화는 없어요'
                    : 'run 에 bagPath 가 기록돼요'}
                  onClick={() => act(() => tb.recordStart(robot))}>
            ● rosbag{mocked.includes('rosbag') ? ' (목업)' : ''}</button>
        </div>
      </section>

      {notice && <p className="notice" data-t="tb-notice">{notice}</p>}

      {runs}

      <LogPanel />
    </div>
  );
}
