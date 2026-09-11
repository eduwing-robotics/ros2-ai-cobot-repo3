// 2단 조준 블록 — ⓐ 대강(글로벌캠) → ⓑ 거울 쌍 자세 풀기 → ⓒⓓ 스캔 A·B → ⓔ 융합·판정 (2026-09-07 · D192 · `plan/LAB-STEP-TEST-PLAN.md` Phase 0-4).
//
// **두 얼굴** (D194 · 4단 마법사) — 기본은 큰 버튼 하나(「거치대 찾기」 · 목업은 ⓐ~ⓔ 를 알아서 이어 돌고, 실기는 「다음」이 한 칸씩)와
// 결과 한 문장. ⓐ~ⓔ 버튼·원값은 「자세히」 안에 그대로 산다(게이트 `data-t` 유지). 풀이는 **한 벌**이다 — 자동도 버튼도 같은 함수를 부른다.
// 좌표는 여기서 만들지 않는다 — 대강값은 부르는 쪽(SimPanel)이 주고, 자세는 `view-pose.mirrorPair`, 융합은 `aim.fusePair` 가 한다.
// 실기에서 스캔은 **손끝이 그 자세에 실제로 있어야** 눌린다(5mm · 2°) — 화면이 「갔다고 치고」 재지 않는다. 목업은 자세를 `/scan` 에 대신 준다.
import { useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { mirrorPair, viewPoseAtRz } from '@fr5/shared/data/sim/view-pose.js';
import { bulletEvidence, bulletSearchSpecs, closerObservationTarget, fusePair, judge, newAim, preferLiveCoarse, singleViewFused, CENTER_MAX_MM, MAX_PASSES } from '@fr5/shared/data/sim/aim.js';
import { nearestYaw } from '@fr5/shared/data/sim/load-steps.js';
import { CARRIER, CARRIER_GRASP_TRUTH } from '@fr5/shared/data/props.js';

const TARGET_LABEL = { carrier: '거치대 (판 위)', basketFloor: '바구니 바닥 (빈 바구니)' };
const ARRIVE_MM = 5; const ARRIVE_DEG = 2;
const AUTO_SCAN_ATTEMPTS = 3;
const wrap = (d) => ((d % 360) + 540) % 360 - 180;
const near = (tcp, pose) => Array.isArray(tcp) && tcp.length === 6 && pose
  && Math.hypot(tcp[0] - pose[0], tcp[1] - pose[1], tcp[2] - pose[2]) <= ARRIVE_MM && Math.abs(wrap(tcp[5] - pose[5])) <= ARRIVE_DEG;
const fmt = (p) => (p ? `(${p[0].toFixed(0)}, ${p[1].toFixed(0)})` : '—');
// 180° 대칭 물체의 +90°·−90° 경계에서 긴 벽 신원이 반대로 바뀌지 않게, 글로벌캠/앞 패스에 가장 가까운 대표를 쓴다.
const alignFusedYaw = (fused, priorYawDeg) => (fused && Number.isFinite(fused.yawDeg) && Number.isFinite(priorYawDeg)
  ? { ...fused, yawDeg: nearestYaw(fused.yawDeg, priorYawDeg) }
  : fused);

/**
 * @param {object} p
 * @param {object} p.state          브리지 상태(`handEye`·`tcpMmDeg`·`jointsDeg`·`robotId`)
 * @param {(target:string)=>{user1Mm:number[], yawDeg:number|null, source:string}|null} p.coarseOf  표적별 대강값(글로벌캠 색 검출 > 입력 > 정본)
 * @param {(target:string, fused:object|null)=>void} p.onFused   융합 결과를 10칸에 넘긴다(null 이면 비운다)
 * @param {(pose:number[]|null, jointsDeg:number[]|null)=>void} p.onGhost  자세 미리보기
 * @param {(jointsDeg:number[], label:string, pose?:number[], guard?:()=>string|null)=>void} p.onGo 「이 자세로 (실기)」 — SimPanel 의 같은 보내기
 * @param {(step:string, payload:object)=>void} p.log            기록 한 줄
 * @param {boolean} p.isMock
 * @param {boolean} [p.wizard]      큰 버튼 하나 + 한 문장 얼굴 (기본 true)
 * @param {{id:string,limit:'S1'|'S2'|'S3'|'S3R'}|null} [p.autoRequest] 제한 실행 한 번
 * @param {(stage:string,payload:object)=>void} [p.onAutoStage]
 * @param {(result:object)=>void} [p.onAutoResult]
 * @param {(requestId:string)=>string|null} [p.autoGuard] 다음 자동 동작 직전 fail-closed 판정
 */
export function AimBlock({ state, coarseOf, onFused, onGhost, onGo, log, isMock, wizard = true,
  autoRequest = null, onAutoStage = null, onAutoResult = null, autoGuard = null }) {
  // 자동 이동을 await 하는 동안 React 렌더의 `state`는 출발 시점 값으로 굳는다. 도착 판정·스캔은
  // 반드시 최신 readback을 읽는다 — 옛 closure를 쓰면 실제로 도착해도 다시 「아직 A가 아님」이 된다.
  const stateRef = useRef(state); stateRef.current = state;
  const [target, setTarget] = useState('carrier');
  // 조준 상태도 탭을 오가도 남는다(SimPanel 의 마법사 상태와 같은 이유 · 목업은 저장 안 함). 표적별 키
  const ssKey = (t) => `fr5.sim.aim.${t}`;
  const loadSaved = (t) => { if (isMock) return null; try { return JSON.parse(window.sessionStorage.getItem(ssKey(t)) || 'null'); } catch { return null; } };
  const saved0 = loadSaved('carrier');
  const [aim, setAim] = useState(() => saved0?.aim ?? newAim('carrier'));
  const [poses, setPoses] = useState(saved0?.poses ?? null);      // {a:{pose,jointsDeg,gate}, b:{…}, rzA, rzB}
  useEffect(() => {
    if (isMock || !state) return;                     // 상태를 아직 못 받았으면 목업인지도 모른다 — 쓰지 않는다
    try { window.sessionStorage.setItem(ssKey(target), JSON.stringify({ aim, poses, t: Date.now() })); } catch { /* 저장 못 해도 화면은 돈다 */ }
  }, [aim, poses, target, isMock, !state]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [auto, setAuto] = useState(null);        // 자동 진행 중 「몇 번째 칸」 — 사람이 읽는 진행 표시
  useEffect(() => { window.__aim = { ...aim, poses }; }, [aim, poses]);   // 계측 훅 — 게이트가 상태를 읽는다
  const reset = (t = target) => { setAim(newAim(t)); setPoses(null); setNote(null); setAuto(null); onFused?.(t, null); onGhost?.(null, null); };

  // ── 풀이 한 벌 — 상태를 안 읽고 값으로 받아 값으로 준다. 버튼과 자동이 같은 함수를 부른다 ──────────────
  const doA = () => {
    const c = coarseOf(target);
    if (!c) return { err: '카메라가 거치대를 못 봤어요 — 3D 의 판을 한 번 눌러 어디 있는지 알려주세요' };
    return { coarse: c };
  };
  const doB = async (coarse) => {
    const live = stateRef.current;
    const he = live?.handEye?.tMm;
    if (!Array.isArray(he) || he.length < 3) return { err: '카메라 위치(hand-eye)가 프로필에 없어요 — 스캔 자세를 못 풀어요' };
    const rzG = CARRIER_GRASP_TRUTH.tcpMmDeg[5] + (coarse.yawDeg ?? 0);
    const cur = live?.jointsDeg ?? null;
    // ⭐ 한 눈 모드 (2026-09-07 · 계약 §hand-eye `singleView` · 주인님 「자세 A 에서 가까이 · j6 안 돌리고」) — 자세 하나만, 손목은 **파지 손목(rzG)** 그대로.
    //    그러면 보기→파지 사이에 j6 가 안 돌고 옆으로 옮겨 내려가기만 한다. 거울 쌍(rzG±90)은 편향을 지우려 손목을 돌렸던 것 — 편향을 tMm 에 박은 뒤엔 필요 없다
    if (live?.handEye?.singleView) {
      let pa = viewPoseAtRz(coarse.user1Mm, he, rzG, { tiltDeg: 0, distMm: 300 });
      if (!pa) return { err: '관측 자세를 못 만들었어요' };
      let ra = await datasource.ik(pa, cur);
      let flipped = false;
      // 파지 각(rzG)에서 카메라는 손끝 옆 90mm 에 있어, 거치대가 팔 안이어도 손끝 자리가 90mm 바깥으로 밀려 해가 없을 수 있다 (20:15 실기 — 거치대 (−107, −1083) 은 닿는데
      //    관측 손끝 (−197, −1094) 은 해 없음 · 컨트롤러 IK 직접 확인). 그럴 땐 손목을 **반대쪽(rzG+180)** 으로 — 카메라가 안쪽으로 온다. 그리퍼·거치대가 대칭이라 파지는 같다
      if (!ra?.jointsDeg) {
        const pa2 = viewPoseAtRz(coarse.user1Mm, he, rzG + 180, { tiltDeg: 0, distMm: 300 });
        const ra2 = pa2 ? await datasource.ik(pa2, cur) : null;
        if (ra2?.jointsDeg) { pa = pa2; ra = ra2; flipped = true; }
      }
      // 둘 다 없으면 **도달 밖**이다. 「자세 A 가 없어요」보다 할 일을 말한다
      if (!ra?.jointsDeg) return { err: `관측 자세를 못 풀었어요 — 거치대 ${fmt(coarse.user1Mm)} 위 300mm 를 손목 양쪽 어느 각으로도 팔이 못 가요(도달 밖). 거치대를 로봇 쪽으로 20cm 옮기고 「다시 찾기」` };
      const dmaxA = Array.isArray(ra?.jointsDeg) && Array.isArray(cur) ? Math.max(...ra.jointsDeg.map((v, i) => Math.abs(v - cur[i]))) : null;
      return { poses: { a: { pose: pa, jointsDeg: ra?.jointsDeg ?? null, gate: ra?.gate ?? null }, b: { pose: null, jointsDeg: null, gate: null }, rzA: pa[5], rzB: null, swapped: false, single: true, flipped, moveDegA: dmaxA == null ? null : Math.round(dmaxA) } };
    }
    const m = mirrorPair(coarse.user1Mm, he, rzG, { distMm: 300 });
    if (!m) return { err: '거울 쌍 자세를 못 만들었어요' };
    const ra0 = await datasource.ik(m.a, cur);
    const rb0 = await datasource.ik(m.b, cur);
    // **지금 손목에 가까운 쪽을 A 로** (2026-09-07 실기 · 주인님 「자세 A 눌러도 되나」) — 거울 쌍은 순서가 없다. 늘 rz_g+90 을 먼저 가면
    // 손목이 189° 를 돌아 조각 5개·218초가 드는데 반대쪽은 12°·30초였다. j6 한계(±175) 근처를 지나는 길도 피한다
    const dmax = (j) => (Array.isArray(j) && Array.isArray(cur) ? Math.max(...j.map((v, i) => Math.abs(v - cur[i]))) : Infinity);
    const swap = ra0?.jointsDeg && rb0?.jointsDeg && dmax(rb0.jointsDeg) + 1 < dmax(ra0.jointsDeg);
    const [pa, pb, ra, rzA, rzB] = swap ? [m.b, m.a, rb0, m.rzB, m.rzA] : [m.a, m.b, ra0, m.rzA, m.rzB];
    const rb = await datasource.ik(pb, ra?.jointsDeg ?? cur);          // B 는 A 의 해를 참조 — 이웃 가지로
    const out = { a: { pose: pa, jointsDeg: ra?.jointsDeg ?? null, gate: ra?.gate ?? null }, b: { pose: pb, jointsDeg: rb?.jointsDeg ?? null, gate: rb?.gate ?? null }, rzA, rzB, swapped: !!swap,
      moveDegA: Number.isFinite(dmax(ra?.jointsDeg)) ? Math.round(dmax(ra?.jointsDeg)) : null };
    if (!out.a.jointsDeg || !out.b.jointsDeg) return { poses: out, err: '팔이 닿지 않는 스캔 자세가 있어요 — 거치대가 너무 멀거나 가까워요. 판 안쪽으로 옮겨 주세요' };
    return { poses: out };
  };
  const doScan = async (which, coarse, pz) => {
    if (!pz?.jointsDeg) return { err: `자세 ${which.toUpperCase()} 가 없어요` };
    if (!isMock && !near(stateRef.current?.tcpMmDeg, pz.pose)) return { err: `팔이 아직 자세 ${which.toUpperCase()} 에 없어요 — 「자세 ${which.toUpperCase()} 로 (실기)」를 먼저 누르고 도착하면 다음`, needMove: which };
    const extra = isMock ? { truth: { user1Mm: coarse.user1Mm, yawDeg: coarse.yawDeg }, atTcpMmDeg: pz.pose } : {};
    const r = await datasource.scan(target, extra);
    if (!r.ok) return { err: `카메라가 못 봤어요 — ${(r.reasons ?? [r.reason]).join(' · ')}`, scan: r };
    return { view: { ...r.view, which } };
  };
  const doBulletSearchView = async (coarse, view, spec) => {
    const he = stateRef.current?.handEye?.tMm;
    const targetMm = closerObservationTarget(coarse, view);
    if (!Array.isArray(he) || !targetMm || !Number.isFinite(spec?.rzDeg)) {
      return { err: '총알 근접 관측 자세의 중심·윗면·카메라 변환 중 하나가 없어요' };
    }
    // ponytail: 깊이의 안쪽 바닥 z를 쓰면 의도한 50mm보다 더 내려간다. 합성 규칙은 aim.js 한 곳에 둔다.
    const pose = viewPoseAtRz(targetMm, he, spec.rzDeg, { tiltDeg: 0, distMm: spec.distMm });
    if (!pose) return { err: '총알 근접 관측 자세를 만들지 못했어요' };
    const solved = await datasource.ik(pose, stateRef.current?.jointsDeg ?? null);
    if (!solved?.jointsDeg) return { err: '총알 탐색 자세의 IK 해가 없어요', skippable: true, pose, targetMm, spec };
    if (solved.gate?.ok === false) return { err: `총알 탐색 자세를 안전장치가 거부했어요 — ${(solved.gate.reasons ?? [solved.reason]).filter(Boolean).join(' · ')}`, skippable: true, pose, targetMm, solved, spec };
    return { targetMm, ...spec,
      a: { pose, jointsDeg: solved.jointsDeg, gate: solved.gate ?? null } };
  };
  const doE = (views, pass, prevFused) => {
    const a = views.find((v) => v.which === 'a'); const b = views.find((v) => v.which === 'b');
    const fused = fusePair(a, b);
    const verdict = judge(fused, pass, { prevFused });
    return { fused: fused ? { ...fused, ...verdict } : null, verdict };
  };

  // ── 버튼 (자세히) ─────────────────────────────────────────────────────────────
  const stepA = () => {
    const r = doA();
    if (r.err) { setNote(r.err); return; }
    const next = { ...newAim(target), coarse: r.coarse };      // ⓐ 는 **처음부터** — 패스·앞 융합값을 버린다
    setAim(next); setPoses(null); setNote(null); onFused?.(target, null);
    log('aim-a', { aim: next });
  };
  const stepB = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await doB(aim.coarse);
      if (r.poses) { setPoses(r.poses); onGhost?.(r.poses.a.pose, r.poses.a.jointsDeg); log('aim-b', { aim, poses: r.poses }); }
      if (r.err) setNote(r.err);
    } catch (e) { setNote(`자세 풀기 실패 — ${String(e).slice(0, 80)}`); } finally { setBusy(false); }
  };
  const scan = async (which) => {
    setBusy(true); setNote(null);
    try {
      const r = await doScan(which, aim.coarse, poses?.[which]);
      if (r.err) { setNote(r.err); log(`aim-scan-${which}`, { aim, scan: r.scan ?? null, err: r.err }); return; }
      const next = { ...aim, views: [...aim.views.filter((v) => v.which !== which), r.view] };
      setAim(next); log(`aim-scan-${which}`, { aim: next, scan: r.view });
      if (which === 'a' && poses?.b?.jointsDeg) onGhost?.(poses.b.pose, poses.b.jointsDeg);
    } catch (e) { setNote(`스캔 실패 — ${String(e).slice(0, 80)}`); } finally { setBusy(false); }
  };
  const applyE = (r, base) => {
    const fused = alignFusedYaw(r.fused, base.coarse?.yawDeg);
    const next = { ...base, fused, why: r.verdict.why };
    log('aim-e', { aim: next });
    if (r.verdict.ok) { setAim(next); onFused?.(target, fused); setNote(null); return next; }
    onFused?.(target, null);
    if (r.verdict.retry) {
      // 평균 자리를 새 대강값으로 — 표적이 화면 중앙에 오면 롤 편향이 0 으로 간다(수렴 노트 라운드 2). 자세는 다시 푼다
      // z 는 **대강값의 z(윗면)** 를 그대로 — 융합 z 는 안쪽 바닥(−328)이라 그걸 쓰면 다음 패스가 58mm 낮게 보고, 높이가 다르면 보이는 벽이 달라 패스 비교가 어긋난다(18:05 실기)
      const zTop = base.coarse?.user1Mm?.[2] ?? fused.user1Mm[2];
      const again = { ...newAim(target), coarse: { user1Mm: [fused.user1Mm[0], fused.user1Mm[1], zTop], yawDeg: fused.yawDeg, source: `fused-pass${base.pass}` }, pass: base.pass + 1, prevFused: fused };
      setAim(again); setPoses(null); setNote(r.verdict.why); return again;
    }
    setAim(next); setNote(r.verdict.why); return next;
  };
  const stepE = () => applyE(doE(aim.views, aim.pass, aim.prevFused ?? null), aim);

  // ── 같은 풀이의 두 운전법 — 수동은 실기 한 칸, 제한 실행은 S2까지 이어서 ─────────────
  const autoRun = async (options = {}) => {
    const move = options?.move === true;
    const fresh = options?.fresh === true;
    const requestId = options?.requestId ?? null;
    const limit = options?.limit ?? 'S2';
    const gate = () => (move ? autoGuard?.(requestId) ?? null : null);
    const fail = (why, stage = null) => { setNote(why); return { ok: false, stage, reason: why }; };
    const report = async (stage, payload) => { if (move) await onAutoStage?.(stage, payload); };
    // 정지 자세의 프레임 결측은 모션 재전송 없이 같은 `/scan`만 다시 읽는다(D214).
    // 유효 프레임이 하나라도 있었으면 마지막 유효값을 돌려 총알 부족과 카메라 결측을 구분한다.
    const scanAtRest = async ({ which, coarse, pose, label, logStep, accept = () => true, extra = {} }) => {
      const attempts = move && !isMock ? AUTO_SCAN_ATTEMPTS : 1;
      let last = null; let lastValid = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const whyScan = gate(); if (whyScan) return { err: whyScan };
        setAuto(`${label}${attempts > 1 ? ` ${attempt}/${attempts}` : ''}`);
        const result = await doScan(which, coarse, pose);                         // eslint-disable-line no-await-in-loop
        last = result;
        if (!result.err) lastValid = result;
        log(logStep, { attempt, attempts, ...extra, scan: result.view ?? result.scan ?? null,
          err: result.err ?? null, accepted: !result.err && accept(result) });
        if (!result.err && accept(result)) return result;
      }
      return lastValid ?? last;
    };
    setBusy(true); setNote(null);
    try {
      let cur = fresh ? newAim(target) : aim; let pz = fresh ? null : poses;
      if (fresh) { setAim(cur); setPoses(null); onFused?.(target, null); onGhost?.(null, null); }
      const why0 = gate(); if (why0) return fail(why0, 'S0');
      const r0 = doA();
      const preferred = fresh ? r0.coarse : preferLiveCoarse(cur.coarse, r0.coarse);
      if (!cur.coarse) {
        if (r0.err || !preferred) return fail(r0.err ?? '글로벌카메라 대강값이 없어요', 'S1');
        cur = { ...newAim(target), coarse: preferred }; setAim(cur); pz = null; log('aim-a', { aim: cur });
      } else if (preferred !== cur.coarse) {
        // 첫 폴링 전에 잡은 truth/input으로 이어 보지 않는다 — fresh color가 생기면 관측 자세부터 다시 푼다.
        cur = { ...newAim(target), coarse: preferred }; setAim(cur); setPoses(null); pz = null; onFused?.(target, null); log('aim-a', { aim: cur });
      }
      await report('S1', { coarse: cur.coarse });
      if (move && limit === 'S1') return { ok: true, stage: 'S1', aim: cur };
      for (let loop = 0; loop < MAX_PASSES + 2; loop += 1) {
        const why = gate(); if (why) return fail(why, 'S2');
        if (!pz) { setAuto('자세 잡기'); const r = await doB(cur.coarse); if (r.err) return fail(r.err, 'S2'); pz = r.poses; setPoses(pz); log('aim-b', { aim: cur, poses: pz }); }
        if (!cur.views.some((v) => v.which === 'a')) {
          if (move && (isMock || !near(stateRef.current?.tcpMmDeg, pz.a.pose))) {
            const whyMove = gate(); if (whyMove) return fail(whyMove, 'S2');
            onGhost?.(pz.a.pose, pz.a.jointsDeg);
            if (await onGo?.(pz.a.jointsDeg, '조준 자세 A', pz.a.pose, gate) !== true) return fail('조준 자세 A 이동이 완료되지 않아 자동 실행을 멈췄어요', 'S2');
          }
          let r = await scanAtRest({ which: 'a', coarse: cur.coarse, pose: pz.a,
            label: '첫 번째 보기', logStep: 'aim-scan-a-attempt' });
          if (r.err) {
            if (r.needMove) onGhost?.(pz.a.pose, pz.a.jointsDeg);
            return fail(`${r.err}${move && !isMock ? ` — 같은 정지 자세 ${AUTO_SCAN_ATTEMPTS}회 뒤에도 확인 못 함` : ''}`, 'S2');
          }
          // 실기는 첫 관측에서 총알을 못 찾으면 같은 프레임만 반복하지 않는다. 방금 찾은 거치대 중심 위로
          // 거리와 광축 둘레 손목각을 바꾼 최대 4후보를 안전하게 풀고, 각 정지 자세에서 최대 3회 본다.
          if (move && !isMock && target === 'carrier' && !bulletEvidence(r.view, CARRIER.roundsOnBoard).ok) {
            log('aim-scan-a-initial', { scan: r.view, evidence: bulletEvidence(r.view, CARRIER.roundsOnBoard) });
            const specs = bulletSearchSpecs(pz.a.pose?.[5]);
            let safeCandidates = 0; let lastEvidence = bulletEvidence(r.view, CARRIER.roundsOnBoard);
            for (const spec of specs) {                                                  // eslint-disable-line no-restricted-syntax
              const whyPlan = gate(); if (whyPlan) return fail(whyPlan, 'S2');
              setAuto(`총알 탐색 자세 ${spec.index}/${spec.total} 계산`);
              const search = await doBulletSearchView(cur.coarse, r.view, spec);         // eslint-disable-line no-await-in-loop
              log('aim-bullet-search-plan', { fromDistMm: 300, candidate: spec,
                targetMm: search.targetMm ?? null, pose: search.a?.pose ?? search.pose ?? null,
                jointsDeg: search.a?.jointsDeg ?? search.solved?.jointsDeg ?? null,
                gate: search.a?.gate ?? search.solved?.gate ?? null, skipped: !!search.skippable, err: search.err ?? null });
              if (search.err) {
                if (search.skippable) continue;
                return fail(search.err, 'S2');
              }
              safeCandidates += 1;
              const whyMove = gate(); if (whyMove) return fail(whyMove, 'S2');
              pz = { ...pz, a: search.a, closeObservation: true, distMm: search.distMm,
                bulletSearchIndex: search.index, bulletSearchYawOffsetDeg: search.yawOffsetDeg }; setPoses(pz);
              onGhost?.(search.a.pose, search.a.jointsDeg);
              if (await onGo?.(search.a.jointsDeg, `총알 탐색 자세 ${search.index}/${search.total}`, search.a.pose, gate) !== true) { // eslint-disable-line no-await-in-loop
                return fail(`총알 탐색 자세 ${search.index}/${search.total} 이동이 완료되지 않아 자동 실행을 멈췄어요`, 'S2');
              }
              r = await scanAtRest({ which: 'a', coarse: cur.coarse, pose: search.a,
                label: `총알 탐색 ${search.index}/${search.total}`, logStep: 'aim-scan-a-bullet-search',
                extra: { candidate: spec }, accept: (retry) => bulletEvidence(retry.view, CARRIER.roundsOnBoard).ok }); // eslint-disable-line no-await-in-loop
              if (r.err) return fail(`${r.err} — 같은 정지 자세 ${AUTO_SCAN_ATTEMPTS}회 뒤에도 유효한 거치대를 못 봐 더 움직이지 않아요`, 'S2');
              lastEvidence = bulletEvidence(r.view, CARRIER.roundsOnBoard);
              if (lastEvidence.ok) break;
            }
            if (!lastEvidence.ok) return fail(`${lastEvidence.why} — 안전한 탐색 자세 ${safeCandidates}/${specs.length}개와 정지 재촬영을 모두 썼어요`, 'S2');
          }
          if (move && !isMock && target === 'carrier') {
            const bullets = bulletEvidence(r.view, CARRIER.roundsOnBoard);
            if (!bullets.ok) return fail(`${bullets.why} — 제한된 총알 탐색 뒤에도 확인 못 함`, 'S2');
          }
          cur = { ...cur, views: [...cur.views, r.view] }; setAim(cur); log('aim-scan-a', { aim: cur, scan: r.view });
          // ⭐ 한 눈 (2026-09-07 · 계약 §hand-eye `singleView`) — 프로필이 거울 쌍 실측으로 tMm 을 고쳤다고 말하면 스캔 A 가 곧 결과. 자세 B 는 안 간다
          const single = alignFusedYaw(singleViewFused(r.view, stateRef.current?.handEye), cur.coarse?.yawDeg);
          if (single) {
            // 한 눈도 **센터링**한다 (20:00 실기 — 폰 색 검출이 240mm 낡아 카메라 축에서 238mm(35°) 벗어난 채 봤다. 값은 맞았지만 그 각에선 롤·왜곡 오차가 커진다).
            //    축에서 CENTER_MAX_MM 넘게 벗어났으면 본 자리를 새 대강값으로 자세를 다시 잡아 한 번 더 — 사람이 「자세 A 로」를 누른다
            if (Number.isFinite(single.offCenterMm) && single.offCenterMm > CENTER_MAX_MM && cur.pass < MAX_PASSES) {
              const zTop = cur.coarse?.user1Mm?.[2] ?? r.view.user1Mm[2];
              const again = { ...newAim(target), coarse: { user1Mm: [r.view.user1Mm[0], r.view.user1Mm[1], zTop], yawDeg: single.yawDeg, source: `depth-pass${cur.pass}` }, pass: cur.pass + 1, prevFused: single };
              setAim(again); setPoses(null); onFused?.(target, null);
              setNote(`카메라 축에서 ${single.offCenterMm}mm 벗어나 봤어요 (> ${CENTER_MAX_MM}) — 본 자리 바로 위로 옮겨 한 번 더 (${cur.pass + 1}/${MAX_PASSES})${move ? '' : ' · 「자세 A 로」'}`);
              log('aim-e', { aim: { ...cur, fused: { ...single, ok: false, retry: true, why: '센터링 — 축에서 벗어남' } } });
              if (move) { cur = again; pz = null; continue; }
              return { ok: false, stage: 'S2', reason: '재중심 이동 대기' };
            }
            const next = { ...cur, fused: single, why: single.why }; setAim(next); log('aim-e', { aim: next }); onFused?.(target, single); setNote(null); onGhost?.(null, null);
            await report('S2', { fused: single, pass: cur.pass });
            return { ok: true, stage: 'S2', fused: single, aim: next };
          }
          if (!isMock && !move) { if (pz.b?.jointsDeg) onGhost?.(pz.b.pose, pz.b.jointsDeg); return { ok: false, stage: 'S2', reason: '자세 B 이동 대기' }; }
        }
        if (!cur.views.some((v) => v.which === 'b')) {
          if (move && (isMock || !near(stateRef.current?.tcpMmDeg, pz.b.pose))) {
            const whyMove = gate(); if (whyMove) return fail(whyMove, 'S2');
            onGhost?.(pz.b.pose, pz.b.jointsDeg);
            if (await onGo?.(pz.b.jointsDeg, '조준 자세 B', pz.b.pose, gate) !== true) return fail('조준 자세 B 이동이 완료되지 않아 자동 실행을 멈췄어요', 'S2');
          }
          setAuto('두 번째 보기'); const r = await doScan('b', cur.coarse, pz.b);
          if (r.err) { if (r.needMove && pz.b?.jointsDeg) onGhost?.(pz.b.pose, pz.b.jointsDeg); return fail(r.err, 'S2'); }
          cur = { ...cur, views: [...cur.views, r.view] }; setAim(cur); log('aim-scan-b', { aim: cur, scan: r.view });
        }
        setAuto('맞추기');
        const next = applyE(doE(cur.views, cur.pass, cur.prevFused ?? null), cur);
        if (next.fused?.ok) { await report('S2', { fused: next.fused, pass: cur.pass }); return { ok: true, stage: 'S2', fused: next.fused, aim: next }; }
        if (next.pass > cur.pass && (isMock || move)) { cur = next; pz = null; continue; }
        return { ok: false, stage: 'S2', reason: next.why ?? '조준이 수렴하지 않았어요' };
      }
      return fail(`조준이 ${MAX_PASSES}패스 안에 끝나지 않았어요`, 'S2');
    } catch (e) { return fail(`찾기 실패 — ${String(e).slice(0, 80)}`, 'S2'); } finally { setBusy(false); setAuto(null); }
  };

  // 「자세 X 로」가 **도착**을 돌려주면 스캔을 바로 잇는다 (2026-09-07 17:40 · 주인님 「중간에 한 번 더 눌러야 함」). 이동은 사람이 눌렀고(하드 룰 3),
  //    관측은 팔을 안 움직이니 자동이어도 된다. 거부·시간초과(false)면 멈춘다 — SimPanel 이 사유를 보여 준다
  // 실패로 끝난 뒤에도 마지막 평균은 «어디쯤»으로는 맞다 — 그 자리를 새 대강값으로 처음부터(1패스). 폰이 팔에 가려 대강값이 틀리던 것(18:05 · 80mm)을 피한다
  const restartFromFused = () => {
    const f = aim.fused; if (!f?.user1Mm) return;
    const zTop = aim.coarse?.user1Mm?.[2] ?? f.user1Mm[2];
    setAim({ ...newAim(target), coarse: { user1Mm: [f.user1Mm[0], f.user1Mm[1], zTop], yawDeg: f.yawDeg, source: 'fused-prev' } });
    setPoses(null); setNote(null); onFused?.(target, null);
  };
  // 「지금 자세에서 보기」 (2026-09-07 20:00 실기 · 한 눈 모드 전용) — 팔이 이미 표적 위에 있으면(바구니 위 ⑤에서 정차 자리 상수가 틀려 팔을 옮긴 뒤) 자세를 다시 풀지 않고
  //    지금 손끝에서 한 판 찍어 결과로 삼는다. 관측이라 팔은 안 움직인다. 대강값 없이도 된다 — 대강값은 자세를 만들 때만 필요했다
  const scanHere = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await datasource.scan(target, {});
      if (!r.ok) { setNote(`카메라가 못 봤어요 — ${(r.reasons ?? [r.reason]).join(' · ')}`); log(`aim-scan-here`, { target, err: r.reasons ?? r.reason }); return; }
      const view = { ...r.view, which: 'a' };
      const priorYawDeg = aim.coarse?.yawDeg ?? coarseOf(target)?.yawDeg;
      const single = alignFusedYaw(singleViewFused(view, state?.handEye), priorYawDeg);
      if (!single) { setNote('한 눈 판정이 꺼져 있어요(프로필 singleView) — 이 버튼은 한 눈 모드에서만'); return; }
      const next = { ...newAim(target), coarse: { user1Mm: view.user1Mm, yawDeg: single.yawDeg, source: 'scan-here' }, views: [view], fused: single, why: single.why };
      setAim(next); setPoses(null); log('aim-scan-a', { aim: next, scan: view }); log('aim-e', { aim: next }); onFused?.(target, single); onGhost?.(null, null);
    } catch (e) { setNote(`스캔 실패 — ${String(e).slice(0, 80)}`); } finally { setBusy(false); }
  };
  const goThenScan = async (which) => {
    const pz = poses?.[which];
    if (!pz?.jointsDeg) return;
    const ok = await onGo?.(pz.jointsDeg, `조준 자세 ${which.toUpperCase()}`, pz.pose);
    if (ok === true) await autoRun();
  };
  // 제한 실행 요청은 같은 id를 한 번만 받는다. 개발 StrictMode의 effect 재호출도 두 번째
  // proposal을 만들지 못한다. 결과는 부모가 S3 계획 또는 S3R 높은 파지 준비로 이어 받는다.
  const autoSeen = useRef(null);
  useEffect(() => {
    if (!autoRequest?.id || autoSeen.current === autoRequest.id) return;
    autoSeen.current = autoRequest.id;
    autoRun({ move: true, fresh: true, requestId: autoRequest.id, limit: autoRequest.limit })
      .then((result) => onAutoResult?.({ requestId: autoRequest.id, ...result }));
  }, [autoRequest?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const a = aim.views.find((v) => v.which === 'a'); const b = aim.views.find((v) => v.which === 'b');
  const armed = state?.phase === 'ARMED' || state?.phase === 'EXECUTING';
  const done = !!aim.fused?.ok;
  const sentence = auto ? `카메라가 보고 있어요… (${auto}${aim.pass > 1 ? ' · 한 번 더' : ''})`
    : done ? `카메라가 ${aim.fused.n === 1 ? '한 번 보고 맞췄어요(hand-eye 보정)' : '두 번 보고 맞췄어요'} ✓ 거치대 ${fmt(aim.fused.user1Mm)}${aim.fused.yawDeg ? ` · ${aim.fused.yawDeg.toFixed(0)}° 돌아 있음` : ''}`
      : note ?? (aim.coarse ? (aim.pass > 1 ? '한 번 더 보려고 해요 — 다시 「찾기」' : (a ? '두 번째 보기가 남았어요 — 다시 「찾기」' : '아직 카메라로 안 봤어요 — 「찾기」')) : '아직 안 찾았어요');
  return (
    <div className="aim" data-t="sim-aim" data-target={target} data-pass={aim.pass} data-done={String(done)}>
      {wizard && (
        <>
          <div className="row">
            <button type="button" className="big" data-t="sim-find" disabled={busy || !state?.connected || done} onClick={() => autoRun()}>
              {busy ? '보는 중…' : (done ? '찾았어요 ✓' : (aim.coarse || aim.views.length ? '🔍 이어서 찾기' : '🔍 거치대 찾기'))}
            </button>
            {done && <button type="button" onClick={() => reset()} disabled={busy}>다시 찾기</button>}
            {!isMock && state?.handEye?.singleView && !done && <button type="button" data-t="sim-scan-here" disabled={busy || !state?.connected} onClick={scanHere} title="팔을 옮기지 않고 지금 손끝에서 한 판 찍어 결과로 삼아요(한 눈)">지금 자세에서 보기</button>}
            {!done && aim.fused?.user1Mm && !busy && <button type="button" data-t="sim-find-again" onClick={() => restartFromFused()}>이 자리에서 다시 찾기</button>}
            {!isMock && poses?.a?.jointsDeg && !a && <button type="button" data-t="sim-aim-go-a" disabled={!armed} title={armed ? '' : 'ARM 뒤에'} onClick={() => goThenScan('a')}>자세 A 로 (실기) → 보기</button>}
            {!isMock && !state?.handEye?.singleView && poses?.b?.jointsDeg && a && !b && <button type="button" data-t="sim-aim-go-b" disabled={!armed} title={armed ? '' : 'ARM 뒤에'} onClick={() => goThenScan('b')}>자세 B 로 (실기) → 보기</button>}
          </div>
          <p className={`sentence ${done ? 'ok' : (note ? 'bad' : '')}`} data-t="sim-find-status">{sentence}</p>
        </>
      )}
      <details data-t="sim-aim-detail" open={!wizard}>
        <summary>자세히 — 카메라가 본 것 두 번과 맞춘 값</summary>
        <div className="row">
          <select value={target} aria-label="스캔 표적" disabled={busy} onChange={(e) => { setTarget(e.target.value); reset(e.target.value); }}>
            {Object.entries(TARGET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button type="button" data-t="sim-aim-a" disabled={busy} onClick={stepA}>ⓐ 대강 보기</button>
          <button type="button" data-t="sim-aim-b" disabled={busy || !aim.coarse || !state?.connected} onClick={stepB}>ⓑ 거울 쌍 자세 풀기</button>
          <button type="button" data-t="sim-aim-c" disabled={busy || !poses?.a?.jointsDeg} onClick={() => scan('a')}>ⓒ 스캔 A</button>
          <button type="button" data-t="sim-aim-d" disabled={busy || !poses?.b?.jointsDeg || !a} onClick={() => scan('b')}>ⓓ 스캔 B</button>
          <button type="button" data-t="sim-aim-e" disabled={busy || !a || !b} onClick={stepE}>ⓔ 융합</button>
          <button type="button" onClick={() => reset()} disabled={busy}>비우기</button>
        </div>
        <p data-t="sim-aim-coarse">
          ⓐ 대강 {aim.coarse ? <>{fmt(aim.coarse.user1Mm)} · 요각 {aim.coarse.yawDeg == null ? '모름(정본각)' : `${aim.coarse.yawDeg.toFixed(1)}°`} · 출처 <b>{aim.coarse.source}</b>{aim.pass > 1 ? ` · ${aim.pass}패스` : ''}</> : '— 아직'}
          {poses && <> · ⓑ 자세 A rz {poses.rzA.toFixed(1)}° {poses.a.jointsDeg ? '✓' : '✗'}{poses.moveDegA != null ? ` (지금 손목에서 ${poses.moveDegA}°${poses.swapped ? ' · 가까운 쪽을 A 로' : ''})` : ''} {poses.single ? ` (한 눈 · B 없음${poses.flipped ? ' · 카메라가 안쪽으로 오게 손목 반대쪽' : ''})` : ` / B rz ${poses.rzB != null ? poses.rzB.toFixed(1) : '—'}°`} {poses.b.jointsDeg ? '✓' : '✗'}
            {!isMock && poses.a.jointsDeg && <button type="button" disabled={!armed} title={armed ? '' : 'ARM 뒤에'} onClick={() => onGo?.(poses.a.jointsDeg, '조준 자세 A', poses.a.pose)}>이 자세로 (실기) A</button>}
            {!isMock && poses.b?.jointsDeg && <button type="button" disabled={!armed} title={armed ? '' : 'ARM 뒤에'} onClick={() => onGo?.(poses.b.jointsDeg, '조준 자세 B', poses.b.pose)}>B</button>}
            {isMock && ' · 목업 — 자세는 스캔에 대신 준다'}</>}
        </p>
        {(a || b) && (
          <p data-t="sim-aim-views">
            {a && <>ⓒ A {fmt(a.user1Mm)} 요각 {a.yawDeg == null ? '—' : `${a.yawDeg.toFixed(1)}°`}{a.source === 'mock' ? ' (목업)' : ''}</>}
            {b && <>{a ? ' · ' : ''}ⓓ B {fmt(b.user1Mm)} 요각 {b.yawDeg == null ? '—' : `${b.yawDeg.toFixed(1)}°`}{b.source === 'mock' ? ' (목업)' : ''}</>}
          </p>
        )}
        {aim.fused && (
          <p data-t="sim-aim-fused" data-ok={String(!!aim.fused.ok)}>
            ⓔ 융합 <b>{fmt(aim.fused.user1Mm)}</b> · 요각 {aim.fused.yawDeg == null ? '—' : `${aim.fused.yawDeg.toFixed(1)}°`} · 편향(쌍의 차/2) <b>{Number.isFinite(aim.fused.halfDiffMm) ? `${aim.fused.halfDiffMm.toFixed(2)}mm` : '— (한 눈 보정)'}</b>{aim.fused.driftMm != null ? ` · 두 패스 차 ${aim.fused.driftMm.toFixed(2)}mm` : ''}
            {' — '}{aim.fused.ok ? <span className="ok">{aim.fused.why} → 10칸이 이 자리로</span> : <span className="bad">{aim.fused.why}</span>}
          </p>
        )}
        {note && <p className="refusal" data-t="sim-aim-note">{note}</p>}
      </details>
    </div>
  );
}
