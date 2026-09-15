import { useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { Section } from '../Section.jsx';

const ORIGIN_MM = 30;
const ORIGIN_DEG = 3;
const FIRST_STOP_X_MM = 430;
const FINAL_STOP_X_MM = 860;
const FIRST_STOP_TOL_MM = 80;
const FIRST_STOP_TOL_DEG = 5;
const GHOST_PREVIEW_MS = 2000;
const NEW_FOLLOW_TARGET_MM = 25;
const LOCKED_GHOST_DRIFT_MM = 10;
const FOLLOW_ARRIVE_MM = 5;
const FOLLOW_ARRIVE_DEG = 2;
const FOLLOW_TARGET_MAX_AGE_S = 1;
const wrapDeg = (d) => ((d % 360) + 540) % 360 - 180;
const tcpDistance = (a, b) => (Array.isArray(a) && Array.isArray(b)
  ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
const tcpArrived = (now, goal) => tcpDistance(now, goal) <= FOLLOW_ARRIVE_MM
  && Array.isArray(now) && Array.isArray(goal)
  && Math.max(...[3, 4, 5].map((i) => Math.abs(wrapDeg(now[i] - goal[i])))) <= FOLLOW_ARRIVE_DEG;

export function CaptureScenario({ state, isMock, tbStatus, captureEnabled,
  armPreview, onCaptureGhost, onEnableCapture, onMoveInitialGhost, onRunFront430, onFollowOnce,
  onRunFront860, onStop }) {
  const [phase, setPhase] = useState('IDLE');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationReady, setConfirmationReady] = useState(false);
  const [lockedPreview, setLockedPreview] = useState(null);
  const runTokenRef = useRef(0);
  const stateRef = useRef(state); stateRef.current = state;
  const tbRef = useRef(tbStatus); tbRef.current = tbStatus;
  const previewRef = useRef(armPreview); previewRef.current = armPreview;
  useEffect(() => {
    // Chrome 폼 복원은 첫 effect 뒤에도 들어온다. ready 전환을 늦춰 checked=false를 복원 뒤 다시 그린다.
    let timer;
    const resetConfirmation = () => {
      setConfirmationReady(false); setConfirmed(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setConfirmationReady(true), 100);
    };
    window.addEventListener('pageshow', resetConfirmation); resetConfirmation();
    return () => {
      window.clearTimeout(timer); window.removeEventListener('pageshow', resetConfirmation);
      runTokenRef.current += 1; onCaptureGhost?.(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const lockPreview = (preview) => {
    const frozen = preview?.jointsDeg ? {
      jointsDeg: [...preview.jointsDeg], tcpMmDeg: [...(preview.tcpMmDeg ?? [])],
      gate: preview.gate ?? null, why: preview.why ?? null, stale: !!preview.stale,
    } : null;
    setLockedPreview(frozen); onCaptureGhost?.(frozen); return frozen;
  };
  const selectedPreview = lockedPreview ?? armPreview;
  const [note, setNote] = useState('고스트를 확인하고 현장확인을 체크한 뒤 자동 촬영 시작을 누르세요.');
  const pose = tbStatus.pose;
  const atOrigin = !!pose && Math.hypot(pose.xMm, pose.yMm) <= ORIGIN_MM
    && Math.abs(wrapDeg(pose.thetaDeg ?? 0)) <= ORIGIN_DEG;
  const front430StartException = !isMock && atOrigin && tbStatus.geofence?.inside === false
    && Number.isFinite(tbStatus.geofence?.marginMm) && tbStatus.geofence.marginMm >= -13
    && /여유선 163mm/.test(tbStatus.geofence?.reason ?? '');
  const speedOk = state?.speedOverridePct >= 10 && state.speedOverridePct <= 30;
  const armReady = isMock || (state?.connected && state?.owner && datasource.hasOwnerToken()
    && state.phase === 'ARMED' && state.mode === 0 && speedOk);
  const target = state?.follow?.target ?? null;
  const activePhases = ['AUTO_PREVIEW_INITIAL', 'PREPOSITIONING', 'DRIVING', 'AUTO_PREVIEW_FOLLOW', 'FOLLOWING',
    'EXTRA_DRIVING', 'AUTO_PREVIEW_FINAL', 'FINAL_FOLLOWING'];
  const running = activePhases.includes(phase);
  const tokenAlive = (token) => runTokenRef.current === token;
  const previewWhy = (p, label) => (!p?.jointsDeg || p?.gate?.ok === false || p?.stale
    ? `${label} 고스트를 안전하게 풀지 못했어요 — ${p?.why ?? p?.gate?.reasons?.[0] ?? '계산 중'}` : null);
  const armWhy = (s, t) => (!t?.connected ? '터틀봇 연결이 없어요'
    : !t.stopped || s?.amr?.moving !== false ? '터틀봇이 완전히 정차하지 않았어요'
      : !(isMock || (s?.connected && s?.owner && datasource.hasOwnerToken() && s.phase === 'ARMED'
        && s.mode === 0 && s.speedOverridePct >= 10 && s.speedOverridePct <= 30))
        ? 'FR5 조종권·ARMED·자동 모드·전역 속도 10~30%를 맞춰 주세요'
        : !((s?.motionQueueLength ?? 0) === 0 && (!s?.motionTarget || s.motionTarget.doneAt != null))
          ? 'FR5가 완전히 정지하지 않았어요' : null);
  const originWhy = (t) => {
    const p = t?.pose; const origin = !!p && Math.hypot(p.xMm, p.yMm) <= ORIGIN_MM
      && Math.abs(wrapDeg(p.thetaDeg ?? 0)) <= ORIGIN_DEG;
    const exception = !isMock && origin && t?.geofence?.inside === false
      && Number.isFinite(t?.geofence?.marginMm) && t.geofence.marginMm >= -13
      && /여유선 163mm/.test(t?.geofence?.reason ?? '');
    if (!origin && !isMock) return `front430 출발 원점이 아니에요 — 현재 (${Math.round(p?.xMm ?? 0)}, ${Math.round(p?.yMm ?? 0)}, ${Math.round(p?.thetaDeg ?? 0)}°)`;
    if (!isMock && t?.geofence?.inside !== true && !exception) return `지오펜스 안쪽이 아니에요 — ${t?.geofence?.reason ?? '판정 없음'}`;
    return null;
  };
  const firstStopWhy = (t) => {
    const p = t?.pose; const there = !!p && Math.hypot(p.xMm - FIRST_STOP_X_MM, p.yMm) <= FIRST_STOP_TOL_MM
      && Math.abs(wrapDeg(p.thetaDeg ?? 0)) <= FIRST_STOP_TOL_DEG;
    if (!there && !isMock) return `첫 430mm 정차점이 아니에요 — 현재 (${Math.round(p?.xMm ?? 0)}, ${Math.round(p?.yMm ?? 0)}, ${Math.round(p?.thetaDeg ?? 0)}°)`;
    if (!isMock && t?.geofence?.inside !== true) return `지오펜스 안쪽이 아니에요 — ${t?.geofence?.reason ?? '판정 없음'}`;
    return null;
  };
  const finalStopWhy = (t) => {
    const p = t?.pose; const there = !!p && Math.hypot(p.xMm - FINAL_STOP_X_MM, p.yMm) <= FIRST_STOP_TOL_MM
      && Math.abs(wrapDeg(p.thetaDeg ?? 0)) <= FIRST_STOP_TOL_DEG;
    if (!there && !isMock) return `최종 860mm 정차점이 아니에요 — 현재 (${Math.round(p?.xMm ?? 0)}, ${Math.round(p?.yMm ?? 0)}, ${Math.round(p?.thetaDeg ?? 0)}°)`;
    if (!isMock && t?.geofence?.inside !== true) return `지오펜스 안쪽이 아니에요 — ${t?.geofence?.reason ?? '판정 없음'}`;
    return null;
  };
  const baseWhy = (p = selectedPreview) => armWhy(state, tbStatus) || originWhy(tbStatus)
    || (!target ? 'FR5 추종 표적이 없어요 — 카메라/odom 추종 설정을 확인해 주세요' : null)
    || (captureEnabled ? previewWhy(p, '출발 조준') : null);
  const startWhy = !confirmationReady || !confirmed ? '고스트를 보고 현장확인을 체크해 주세요' : running ? '자동 촬영이 이미 실행 중입니다' : baseWhy();
  const wait = async (token, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now()))); // eslint-disable-line no-await-in-loop
      if (!tokenAlive(token)) return false;
    }
    return true;
  };
  const waitFor = async (token, read, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (tokenAlive(token) && Date.now() < until) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100)); // eslint-disable-line no-await-in-loop
    }
    return null;
  };
  const fail = async (token, reason) => {
    if (!tokenAlive(token)) return;
    runTokenRef.current += 1;
    setLockedPreview(null); onCaptureGhost?.(null);
    setPhase('FAILED'); setConfirmed(false); setNote(`자동 촬영 중단 — ${reason}`);
    await onStop?.();
  };
  const followStoppedTarget = async (token, previousGhost, positionWhy, label, previewPhase, movingPhase) => {
    const nextPreview = await waitFor(token, () => {
      const p = previewRef.current;
      const liveTarget = stateRef.current?.follow?.target;
      return !['wrist', 'odom'].includes(liveTarget?.source)
        || !Number.isFinite(liveTarget?.ageS) || liveTarget.ageS > FOLLOW_TARGET_MAX_AGE_S
        || previewWhy(p, `${label} 도착 기준`)
        || tcpDistance(p.tcpMmDeg, previousGhost.tcpMmDeg) < NEW_FOLLOW_TARGET_MM ? null : p;
    }, 5000);
    if (!tokenAlive(token)) return null;
    if (!nextPreview) { await fail(token, `${label} 이동 뒤 이전 고스트와 다른 새 추종 고스트를 5초 안에 받지 못했습니다.`); return null; }
    const nextGhost = lockPreview(nextPreview);
    setPhase(previewPhase); setNote(`${label} 도착 기준 새 FR5 고스트를 고정해 2초 동안 보여줍니다. 아직 FR5는 움직이지 않습니다.`);
    if (!await wait(token, GHOST_PREVIEW_MS)) return null;
    const liveNext = previewRef.current;
    const beforeFollow = armWhy(stateRef.current, tbRef.current) || positionWhy(tbRef.current)
      || (!stateRef.current?.follow?.target ? '최신 추종 표적이 사라졌습니다.' : null)
      || (!['wrist', 'odom'].includes(stateRef.current?.follow?.target?.source)
        ? `${label} 주행 뒤 wrist/odom 추종 목표가 아닙니다.` : null)
      || (!Number.isFinite(stateRef.current?.follow?.target?.ageS)
        || stateRef.current.follow.target.ageS > FOLLOW_TARGET_MAX_AGE_S
        ? `${label} 주행 뒤 추종 목표가 1초보다 오래됐습니다.` : null)
      || previewWhy(liveNext, `${label} 최신 도착 기준`)
      || (tcpDistance(liveNext?.tcpMmDeg, nextGhost.tcpMmDeg) > LOCKED_GHOST_DRIFT_MM
        ? '고스트 확인 중 최신 목표가 10mm 넘게 바뀌어 실기 목표와 고스트가 달라졌습니다.' : null);
    if (beforeFollow) { await fail(token, beforeFollow); return null; }
    setPhase(movingPhase); setNote(`FR5가 ${label} 도착 기준 고스트로 한 번 이동 중입니다. 터틀봇은 정지 상태를 유지합니다.`);
    const result = await onFollowOnce?.(() => tokenAlive(token));
    if (!tokenAlive(token)) return null;
    if (!result?.ok) { await fail(token, `FR5 추종이 거부됐습니다 — ${result?.reason ?? result?.reasons?.[0] ?? '응답 없음'}`); return null; }
    if (result.moved !== true) { await fail(token, `FR5 추종 실기 이동이 0건입니다 — ${result?.reasons?.[0] ?? 'moved:false'}`); return null; }
    const followGoal = result.goal?.tcpMmDeg ?? null;
    const followedStopped = await waitFor(token, () => (!armWhy(stateRef.current, tbRef.current)
      && tcpArrived(stateRef.current?.tcpMmDeg, followGoal)), 3000);
    if (!followedStopped) { await fail(token, 'FR5 추종 뒤 실제 TCP가 목표 위치 5mm·각도 2° 안에 도착한 것을 확인하지 못했습니다.'); return null; }
    return nextGhost;
  };
  const startAutomatic = async () => {
    if (startWhy) return;
    const token = runTokenRef.current + 1; runTokenRef.current = token;
    setLockedPreview(null); onCaptureGhost?.(null);
    onEnableCapture?.();
    setPhase('AUTO_PREVIEW_INITIAL'); setNote('출발 조준 고스트를 고정해 2초 동안 보여줍니다. 아직 로봇은 움직이지 않습니다.');
    const initialPreview = await waitFor(token, () => {
      const p = previewRef.current; return previewWhy(p, '출발 조준') ? null : p;
    }, 5000);
    if (!tokenAlive(token)) return;
    if (!initialPreview) { await fail(token, '출발 조준 고스트를 5초 안에 안전하게 풀지 못했습니다.'); return; }
    const initialGhost = lockPreview(initialPreview);
    if (!await wait(token, GHOST_PREVIEW_MS)) return;
    const beforeInitial = armWhy(stateRef.current, tbRef.current) || originWhy(tbRef.current)
      || (!stateRef.current?.follow?.target ? 'FR5 추종 표적이 사라졌습니다.' : null) || previewWhy(initialGhost, '출발 조준');
    if (beforeInitial) { await fail(token, beforeInitial); return; }
    setPhase('PREPOSITIONING'); setNote('FR5가 출발 조준 고스트로 이동 중입니다. 터틀봇은 정지 상태를 유지합니다.');
    const initialOk = await onMoveInitialGhost?.(initialGhost, () => tokenAlive(token));
    if (!tokenAlive(token)) return;
    if (!initialOk) { await fail(token, 'FR5 출발 조준 이동이 실패했습니다.'); return; }
    const armSettled = await waitFor(token, () => !armWhy(stateRef.current, tbRef.current), 3000);
    if (!armSettled) { await fail(token, 'FR5 출발 조준 뒤 완전 정지를 확인하지 못했습니다.'); return; }
    const beforeFront430 = armWhy(stateRef.current, tbRef.current) || originWhy(tbRef.current);
    if (beforeFront430) { await fail(token, beforeFront430); return; }
    setPhase('DRIVING'); setNote('터틀봇이 front430으로 직진 중입니다. 이 동안 FR5 명령은 0건입니다.');
    const front430Ok = await onRunFront430?.(() => tokenAlive(token));
    if (!tokenAlive(token)) return;
    if (!front430Ok) { await fail(token, '터틀봇 front430 주행 또는 도착 확인이 실패했습니다.'); return; }
    const stoppedAt430 = armWhy(stateRef.current, tbRef.current) || firstStopWhy(tbRef.current);
    if (stoppedAt430) { await fail(token, stoppedAt430); return; }
    const firstFollowGhost = await followStoppedTarget(token, initialGhost, firstStopWhy, 'front430', 'AUTO_PREVIEW_FOLLOW', 'FOLLOWING');
    if (!firstFollowGhost) return;
    const beforeFront860 = armWhy(stateRef.current, tbRef.current) || firstStopWhy(tbRef.current);
    if (beforeFront860) { await fail(token, beforeFront860); return; }
    setPhase('EXTRA_DRIVING'); setNote('터틀봇이 front860으로 430mm를 추가 직진 중입니다. 이 동안 FR5 명령은 0건입니다.');
    const front860Ok = await onRunFront860?.(() => tokenAlive(token));
    if (!tokenAlive(token)) return;
    if (!front860Ok) { await fail(token, '터틀봇 front860 추가 주행 또는 도착 확인이 실패했습니다.'); return; }
    const stoppedAt860 = armWhy(stateRef.current, tbRef.current) || finalStopWhy(tbRef.current);
    if (stoppedAt860) { await fail(token, stoppedAt860); return; }
    const finalFollowGhost = await followStoppedTarget(token, firstFollowGhost, finalStopWhy, 'front860', 'AUTO_PREVIEW_FINAL', 'FINAL_FOLLOWING');
    if (!finalFollowGhost) return;
    setPhase('DONE'); setConfirmed(false);
    setNote('완료 — FR5 출발 조준, 터틀봇 430mm·860mm 정차점의 FR5 추종을 모두 마쳤습니다.');
  };
  const stop = async () => {
    runTokenRef.current += 1;
    setLockedPreview(null); onCaptureGhost?.(null);
    setPhase('STOPPED'); setConfirmed(false); setNote('정지 요청을 FR5와 터틀봇 모두에 보냈습니다.');
    await onStop?.();
  };

  return (
    <Section id="capture-scenario" title="촬영 시나리오 — FR5 조준·430mm 직진·추종·430mm 추가 직진·최종 추종"
      note="출발 조준 → front430·FR5 추종 → front860·FR5 최종 추종"
      warn={phase === 'FAILED'}>
      <ol className="capturesteps">
        <li data-done={String(captureEnabled || phase !== 'IDLE')}>촬영 트윈·출발 고스트</li>
        <li data-done={String(['DRIVING', 'AUTO_PREVIEW_FOLLOW', 'FOLLOWING', 'EXTRA_DRIVING', 'AUTO_PREVIEW_FINAL', 'FINAL_FOLLOWING', 'DONE'].includes(phase))}>FR5 출발 조준 도착</li>
        <li data-done={String(['AUTO_PREVIEW_FOLLOW', 'FOLLOWING', 'EXTRA_DRIVING', 'AUTO_PREVIEW_FINAL', 'FINAL_FOLLOWING', 'DONE'].includes(phase))}>터틀봇 front430 직진·정차</li>
        <li data-done={String(['EXTRA_DRIVING', 'AUTO_PREVIEW_FINAL', 'FINAL_FOLLOWING', 'DONE'].includes(phase))}>FR5 첫 추종</li>
        <li data-done={String(['AUTO_PREVIEW_FINAL', 'FINAL_FOLLOWING', 'DONE'].includes(phase))}>터틀봇 front860 직진·정차</li>
        <li data-done={String(phase === 'DONE')}>FR5 최종 추종</li>
      </ol>
      <p className="sentence" data-t="capture-scenario-status" data-phase={phase}>{note}</p>
      <p className="hint" data-t="capture-scenario-ready">
        터틀봇 {tbStatus.connected ? (tbStatus.stopped ? '정차 ✓' : '이동 중') : '미연결'}
        {' · '}원점 {atOrigin ? '✓' : '아님'}
        {' · '}지오펜스 {isMock ? '목업' : tbStatus.geofence?.inside === true ? '안쪽 ✓' : front430StartException ? 'front430 출발 예외 ✓' : '차단'}
        {' · '}FR5 {armReady ? '실기 준비 ✓' : '준비 전'}
        {' · '}표적 {target ? `${target.source ?? '감지'} ${target.ageS ?? '?'}s` : '없음'}
      </p>
      <label className="confirm"><input type="checkbox" data-t="capture-scenario-confirm"
        name="capture-scenario-confirm" autoComplete="off" checked={confirmationReady && confirmed} disabled={running}
        onChange={(e) => setConfirmed(e.target.checked)} /> 현장확인 — 로봇 옆에 있고 STOP에 손이 닿아요</label>
      <div className="row">
        <button type="button" className="big" data-t="capture-scenario-auto-start"
          disabled={running || !!startWhy} title={startWhy ?? ''} onClick={startAutomatic}>
          {running ? '자동 촬영 진행 중…' : '▶ 자동 촬영 시작'}
        </button>
        <button type="button" className="stopbtn" data-t="capture-scenario-stop" onClick={stop}>■ 둘 다 정지</button>
      </div>
      {startWhy && !running && <p className="refusal">자동 시작 차단 — {startWhy}</p>}
    </Section>
  );
}
