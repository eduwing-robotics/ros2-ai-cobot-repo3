import { useEffect, useRef, useState } from 'react';
import { datasource } from '../../../data/datasource/index.js';
import { AUTO_STAGE_NAME } from './stages.js';

const IDLE = { status: 'IDLE', id: null, limit: null, stage: null, why: null, completed: [] };
const READY_STEP_IDS = ['approach', 'pregrip'];
const PICK_STEP_IDS = ['approach', 'pregrip', 'grasp', 'close', 'lift'];
const active = (status) => status === 'RUNNING' || status === 'PREVIEW';

// S0~S4 전용 실행기. S4는 전 경로를 먼저 풀고 낮은 파지 고스트 PREVIEW에서 다시 확인받은 뒤
// 접근→사전 성형→하강→닫기→들기만 잇는다. 터틀봇 주행 목록은 받지 않는다.
export function useLimitedAutomatic({ state, isMock, busy, going, colorHit, tbStatus, tbSnapshot,
  aimedCarrier, graspResolvedKey, sideKey, graspBlocked, graspPending, bulletBlocked,
  solve, solveReady, solvePick, readyStep, previewPick, resetForRun, log }) {
  const [limit, setLimit] = useState('S3');
  const [confirmed, setConfirmed] = useState(false);
  const [automatic, setAutomatic] = useState(IDLE);
  const [request, setRequest] = useState(null);
  const automaticRef = useRef(automatic); automaticRef.current = automatic;
  const inputRef = useRef(null);
  inputRef.current = { state, isMock, busy, going, colorHit, tbStatus, tbSnapshot, aimedCarrier,
    graspResolvedKey, sideKey, graspBlocked, graspPending, bulletBlocked };
  const solveRef = useRef(solve); solveRef.current = solve;
  const solveReadyRef = useRef(solveReady); solveReadyRef.current = solveReady;
  const solvePickRef = useRef(solvePick); solvePickRef.current = solvePick;
  const readyStepRef = useRef(readyStep); readyStepRef.current = readyStep;
  const previewPickRef = useRef(previewPick); previewPickRef.current = previewPick;
  const resetRef = useRef(resetForRun); resetRef.current = resetForRun;
  const logRef = useRef(log); logRef.current = log;
  const planStarted = useRef(null);
  const pickPlan = useRef(null);

  const put = (next) => { automaticRef.current = next; setAutomatic(next); };
  const gate = (requestId) => {
    const run = automaticRef.current; const input = inputRef.current; const live = input.state; const tb = input.tbStatus;
    if (!active(run.status) || run.id !== requestId) return '자동 실행이 끝났거나 다른 실행으로 바뀌었어요';
    if (!live?.connected) return 'FR5 연결이 끊겼어요';
    if (datasource.wsReconnects() !== run.snapshot.wsReconnects) return 'FR5 브리지가 재접속돼 자동 재개하지 않아요';
    if (input.isMock) return null;
    if (live.owner !== run.snapshot.owner || !datasource.hasOwnerToken()) return '조종권이 바뀌었어요';
    if (!(live.phase === 'ARMED' || live.phase === 'EXECUTING')) return `FR5가 ARMED가 아니에요 (${live.phase ?? '모름'})`;
    if (live.mode !== 0) return 'FR5가 자동 모드가 아니에요';
    if (live.speedOverridePct !== run.snapshot.speedOverridePct) return '전역 속도가 시작값과 달라졌어요';
    if (JSON.stringify(live.handEye ?? null) !== run.snapshot.handEyeKey) return '손목 카메라 변환이 실행 중 바뀌었어요';
    if (!tb.connected || !tb.stopped) return '터틀봇 연결 또는 완전 정차를 확인할 수 없어요';
    return null;
  };
  const stopBoth = async () => {
    const snap = inputRef.current.tbSnapshot;
    const robot = Object.keys(snap?.robots ?? {}).find((id) => snap.robots[id]?.connected) ?? null;
    const [fr5, tb] = await Promise.all([
      datasource.stop(),
      robot ? datasource.tb.stopRobot(robot) : Promise.resolve({ ok: true, skipped: true }),
    ]);
    return { ok: fr5?.ok === true && tb?.ok !== false, fr5, tb };
  };
  const fail = async (reason, stage = automaticRef.current.stage) => {
    const cur = automaticRef.current;
    if (!active(cur.status)) return;
    put({ ...cur, status: 'FAILED', stage, why: reason }); setConfirmed(false); setRequest(null);
    pickPlan.current = null; previewPickRef.current?.(null);
    const stopped = await stopBoth();
    logRef.current('auto-failed', { automatic: { id: cur.id, limit: cur.limit, stage, reason }, stopped });
  };
  const hold = async (stage, payload = null) => {
    const cur = automaticRef.current;
    if (cur.status !== 'RUNNING') return;
    const completed = [...new Set([...cur.completed, stage])];
    put({ ...cur, status: 'HOLD', stage, why: `${stage} ${AUTO_STAGE_NAME[stage]}에서 계획대로 멈췄어요`, completed });
    setConfirmed(false); setRequest(null);
    await logRef.current('auto-hold', { automatic: { id: cur.id, limit: cur.limit, stage, completed }, evidence: payload });
  };
  const onStage = async (stage, payload) => {
    const cur = automaticRef.current;
    if (cur.status !== 'RUNNING') return;
    const completed = [...new Set([...cur.completed, stage])];
    put({ ...cur, stage, completed });
    await logRef.current('auto-stage', { automatic: { id: cur.id, limit: cur.limit, stage, completed }, evidence: payload });
  };
  const onResult = async (result) => {
    const cur = automaticRef.current;
    if (cur.status !== 'RUNNING' || cur.id !== result.requestId) return;
    if (!result.ok) { await fail(result.reason ?? '조준이 완료되지 않았어요', result.stage); return; }
    if (cur.limit === result.stage) { await hold(result.stage, result.fused ?? result.aim ?? null); return; }
    if (result.stage !== 'S2' || !['S3', 'S3R', 'S4'].includes(cur.limit)) await fail('요청한 단계와 조준 결과가 맞지 않아요', result.stage);
  };
  const startWhy = () => {
    const input = inputRef.current;
    if (active(automaticRef.current.status)) return '이미 자동 실행 중이에요';
    if (!confirmed) return '현장확인을 먼저 체크해 주세요';
    if (!input.state?.connected) return 'FR5 연결이 없어요';
    if (input.busy || input.going?.n) return '다른 계산이나 이동이 끝난 뒤 시작해 주세요';
    if (input.isMock) return null;
    const live = input.state; const tb = input.tbStatus;
    if (!live.owner || !datasource.hasOwnerToken()) return 'Live 탭에서 조종권을 먼저 잡아 주세요';
    if (live.phase !== 'ARMED') return 'Live 탭에서 현장확인 뒤 ARM 해 주세요';
    if (live.mode !== 0) return 'FR5를 자동 모드로 바꿔 주세요';
    if (!(live.speedOverridePct >= 10 && live.speedOverridePct <= 30)) return '전역 속도 10~30%를 먼저 확인해 주세요';
    if (!tb.connected || !tb.stopped) return '터틀봇 연결과 완전 정차를 먼저 확인해 주세요';
    if (!input.colorHit) return '5초 안의 글로벌카메라 분홍 거치대 검출이 없어요';
    if (!Array.isArray(live.handEye?.tMm)) return '손목 카메라 변환이 없어요';
    return null;
  };
  const start = async () => {
    const blocked = startWhy();
    if (blocked) { put({ ...IDLE, status: 'FAILED', limit, why: blocked }); return; }
    const input = inputRef.current;
    if (!input.isMock) {
      const depth = await datasource.depthState();
      const ageS = depth?.state?.lastFrameAt == null ? Infinity : Date.now() / 1000 - depth.state.lastFrameAt;
      // 브라우저(맥)와 카메라 관문(윈도우)은 시계가 약간 다를 수 있다. 미래 1초를 낡은
      // 프레임으로 거부하지 말고, 어느 방향이든 6초를 넘는 차이만 fail-closed 한다.
      if (!depth?.ok || !depth.state?.connected || Math.abs(ageS) > 6) {
        put({ ...IDLE, status: 'FAILED', limit,
          why: depth?.reason ?? `손목 뎁스카메라 프레임이 ${Number.isFinite(ageS) ? `${ageS.toFixed(1)}초` : '알 수 없이'} 낡았어요` });
        setConfirmed(false); return;
      }
    }
    resetRef.current();
    pickPlan.current = null; previewPickRef.current?.(null);
    const id = `auto-${Date.now()}`;
    const snapshot = { owner: input.state?.owner ?? null, phase: input.state?.phase ?? null,
      mode: input.state?.mode ?? null, speedOverridePct: input.state?.speedOverridePct ?? null,
      handEyeKey: JSON.stringify(input.state?.handEye ?? null), wsReconnects: datasource.wsReconnects(),
      turtlebotPose: input.tbStatus?.pose ?? null };
    const next = { status: 'RUNNING', id, limit, stage: 'S0', why: null, completed: ['S0'], snapshot };
    put(next);
    await logRef.current('auto-start', { automatic: { id, limit, stage: 'S0', snapshot } });
    if (limit === 'S0') { await hold('S0', snapshot); return; }
    setRequest({ id, limit });
  };
  const stop = async () => {
    const cur = automaticRef.current;
    put({ ...cur, status: 'STOPPED', why: '사람이 즉시 정지를 눌렀어요' });
    setConfirmed(false); setRequest(null);
    pickPlan.current = null; previewPickRef.current?.(null);
    const stopped = await stopBoth();
    if (cur.id) await logRef.current('auto-stopped', { automatic: { id: cur.id, limit: cur.limit, stage: cur.stage }, stopped });
  };

  useEffect(() => { window.__automatic = automatic; }, [automatic]);
  useEffect(() => {
    if (!active(automatic.status)) return;
    const why = gate(automatic.id);
    if (why) fail(why, automatic.stage);
  }, [automatic.status, automatic.id, state?.connected, state?.phase, state?.mode, state?.owner,
    state?.speedOverridePct, tbStatus.connected, tbStatus.stopped]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const run = automaticRef.current; const input = inputRef.current;
    if (run.status !== 'RUNNING' || run.stage !== 'S2' || !['S3', 'S3R', 'S4'].includes(run.limit)) return;
    if (!input.aimedCarrier || input.graspResolvedKey !== input.sideKey || planStarted.current === run.id) return;
    planStarted.current = run.id;
    (async () => {
      const blocked = gate(run.id);
      if (blocked) { await fail(blocked, 'S2'); return; }
      if (input.bulletBlocked) { await fail(input.bulletBlocked, 'S2'); return; }
      if (input.graspBlocked || input.graspPending) { await fail(input.graspBlocked ?? input.graspPending, 'S2'); return; }
      if (run.limit === 'S3') {
        const planned = await solveRef.current();
        if (!planned?.ok) { await fail(planned?.reason ?? '안전한 계획을 만들지 못했어요', 'S3'); return; }
        const after = gate(run.id);
        if (after) { await fail(after, 'S3'); return; }
        await onStage('S3', { stop: planned.selected?.stop ?? null,
          gates: planned.selected?.solved?.map((o) => o.gate ?? null) ?? [], contact: planned.selected?.contact ?? null });
        await hold('S3', { stop: planned.selected?.stop ?? null });
        return;
      }
      const isPick = run.limit === 'S4';
      const planned = await (isPick ? solvePickRef.current() : solveReadyRef.current());
      const planStage = isPick ? 'S4' : 'S3R';
      if (!planned?.ok) { await fail(planned?.reason ?? `안전한 ${isPick ? '집기' : '파지 준비'} 경로를 만들지 못했어요`, planStage); return; }
      const after = gate(run.id);
      if (after) { await fail(after, planStage); return; }
      const stepIds = isPick ? PICK_STEP_IDS : READY_STEP_IDS;
      const ready = stepIds.map((id) => {
        const index = planned.selected?.steps?.findIndex((s) => s.id === id) ?? -1;
        const step = index >= 0 ? planned.selected.steps[index] : null;
        const solved = index >= 0 ? planned.selected.solved[index] : null;
        return step && solved?.jointsDeg ? { id, label: step.label, why: step.why,
          nextJ: solved.jointsDeg, nextGrip: step.grip, pose: step.pose } : null;
      });
      if (ready.some((s) => !s)) { await fail(`${isPick ? '집기' : '파지 준비'} 자세를 계획에서 찾지 못했어요`, planStage); return; }
      if (isPick) {
        const grasp = ready.find((s) => s.id === 'grasp');
        const evidence = { steps: PICK_STEP_IDS, graspTcpMmDeg: grasp.pose,
          graspInsetMm: planned.selected?.graspInsetMm ?? 0,
          insetCandidates: planned.selected?.insetCandidates ?? [],
          gates: planned.selected?.solved?.map((o) => o.gate ?? null) ?? [], contact: planned.selected?.contact ?? null };
        pickPlan.current = { runId: run.id, steps: ready, evidence };
        previewPickRef.current?.(grasp, false, evidence);
        put({ ...automaticRef.current, status: 'PREVIEW', stage: 'S4',
          why: `낮은 파지 고스트를 확인했어요 — 벽 안쪽 ${evidence.graspInsetMm}mm · 아직 실기 명령은 0건입니다` });
        setConfirmed(false); setRequest(null);
        await logRef.current('auto-preview', { automatic: { id: run.id, limit: run.limit, stage: 'S4' }, evidence });
        return;
      }
      for (const step of ready) {                                                       // eslint-disable-line no-restricted-syntax
        const before = gate(run.id); if (before) { await fail(before, 'S3R'); return; }
        if (await readyStepRef.current?.({ ...step, guard: () => gate(run.id) }) !== true) { await fail(`${step.label} 실행이 완료되지 않았어요`, 'S3R'); return; } // eslint-disable-line no-await-in-loop
        const afterStep = gate(run.id); if (afterStep) { await fail(afterStep, 'S3R'); return; }
      }
      const evidence = { steps: READY_STEP_IDS, tcpMmDeg: ready[1].pose, gripperPct: ready[1].nextGrip,
        gates: planned.selected?.solved?.map((o) => o.gate ?? null) ?? [], contact: planned.selected?.contact ?? null };
      await onStage('S3R', evidence);
      await hold('S3R', evidence);
    })();
  }, [automatic.status, automatic.stage, automatic.limit, aimedCarrier, graspResolvedKey, sideKey,
    graspBlocked, graspPending, bulletBlocked]);   // eslint-disable-line react-hooks/exhaustive-deps

  const confirmPreview = async () => {
    const cur = automaticRef.current; const plan = pickPlan.current;
    if (cur.status !== 'PREVIEW' || cur.stage !== 'S4' || !plan || plan.runId !== cur.id) return;
    const blocked = gate(cur.id);
    if (blocked) { await fail(blocked, 'S4'); return; }
    put({ ...cur, status: 'RUNNING', why: null });
    await logRef.current('auto-preview-confirm', { automatic: { id: cur.id, limit: cur.limit, stage: 'S4' } });
    let closeConfirmed = false;
    for (const step of plan.steps) {                                                    // eslint-disable-line no-restricted-syntax
      const before = gate(cur.id); if (before) { await fail(before, 'S4'); return; }
      if (step.id === 'lift' && closeConfirmed) {
        // 닫힘이 실기 readback으로 확인된 뒤에만 물체를 붙인다. 리프트 명령보다 고스트가 먼저다.
        previewPickRef.current?.(step, true, plan.evidence);
        await logRef.current('auto-lift-preview', { automatic: { id: cur.id, limit: cur.limit, stage: 'S4' },
          evidence: { ...plan.evidence, closeConfirmed: true, liftTcpMmDeg: step.pose } }); // eslint-disable-line no-await-in-loop
        const afterPreview = gate(cur.id);
        if (afterPreview) { await fail(afterPreview, 'S4'); return; }
      }
      if (await readyStepRef.current?.({ ...step, guard: () => gate(cur.id) }) !== true) { await fail(`${step.label} 실행이 완료되지 않았어요`, 'S4'); return; } // eslint-disable-line no-await-in-loop
      const after = gate(cur.id); if (after) { await fail(after, 'S4'); return; }
      if (step.id === 'close') {
        closeConfirmed = true;
        previewPickRef.current?.(step, true, plan.evidence);
      }
    }
    const lift = plan.steps[plan.steps.length - 1];
    const evidence = { ...plan.evidence, tcpMmDeg: lift.pose, gripperPct: lift.nextGrip };
    pickPlan.current = null;
    await onStage('S4', evidence);
    await hold('S4', evidence);
  };

  return { automatic, limit, setLimit, confirmed, setConfirmed, request, gate, onStage, onResult,
    start, stop, confirmPreview, startWhy: startWhy() };
}
