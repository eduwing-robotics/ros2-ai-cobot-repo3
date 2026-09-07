// 2단 조준 블록 — ⓐ 대강(글로벌캠) → ⓑ 거울 쌍 자세 풀기 → ⓒⓓ 스캔 A·B → ⓔ 융합·판정 (2026-09-07 · D192 · `plan/LAB-STEP-TEST-PLAN.md` Phase 0-4).
//
// **두 얼굴** (D194 · 4단 마법사) — 기본은 큰 버튼 하나(「거치대 찾기」 · 목업은 ⓐ~ⓔ 를 알아서 이어 돌고, 실기는 「다음」이 한 칸씩)와
// 결과 한 문장. ⓐ~ⓔ 버튼·원값은 「자세히」 안에 그대로 산다(게이트 `data-t` 유지). 풀이는 **한 벌**이다 — 자동도 버튼도 같은 함수를 부른다.
// 좌표는 여기서 만들지 않는다 — 대강값은 부르는 쪽(SimPanel)이 주고, 자세는 `view-pose.mirrorPair`, 융합은 `aim.fusePair` 가 한다.
// 실기에서 스캔은 **손끝이 그 자세에 실제로 있어야** 눌린다(5mm · 2°) — 화면이 「갔다고 치고」 재지 않는다. 목업은 자세를 `/scan` 에 대신 준다.
import { useEffect, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { mirrorPair } from '@fr5/shared/data/sim/view-pose.js';
import { fusePair, judge, newAim } from '@fr5/shared/data/sim/aim.js';
import { CARRIER_GRASP_TRUTH } from '@fr5/shared/data/props.js';

const TARGET_LABEL = { carrier: '거치대 (판 위)', basketFloor: '바구니 바닥 (빈 바구니)' };
const ARRIVE_MM = 5; const ARRIVE_DEG = 2;
const wrap = (d) => ((d % 360) + 540) % 360 - 180;
const near = (tcp, pose) => Array.isArray(tcp) && tcp.length === 6 && pose
  && Math.hypot(tcp[0] - pose[0], tcp[1] - pose[1], tcp[2] - pose[2]) <= ARRIVE_MM && Math.abs(wrap(tcp[5] - pose[5])) <= ARRIVE_DEG;
const fmt = (p) => (p ? `(${p[0].toFixed(0)}, ${p[1].toFixed(0)})` : '—');

/**
 * @param {object} p
 * @param {object} p.state          브리지 상태(`handEye`·`tcpMmDeg`·`jointsDeg`·`robotId`)
 * @param {(target:string)=>{user1Mm:number[], yawDeg:number|null, source:string}|null} p.coarseOf  표적별 대강값(글로벌캠 색 검출 > 입력 > 정본)
 * @param {(target:string, fused:object|null)=>void} p.onFused   융합 결과를 9칸에 넘긴다(null 이면 비운다)
 * @param {(pose:number[]|null, jointsDeg:number[]|null)=>void} p.onGhost  자세 미리보기
 * @param {(jointsDeg:number[], label:string)=>void} p.onGo      「이 자세로 (실기)」 — SimPanel 의 같은 보내기
 * @param {(step:string, payload:object)=>void} p.log            기록 한 줄
 * @param {boolean} p.isMock
 * @param {boolean} [p.wizard]      큰 버튼 하나 + 한 문장 얼굴 (기본 true)
 */
export function AimBlock({ state, coarseOf, onFused, onGhost, onGo, log, isMock, wizard = true }) {
  const [target, setTarget] = useState('carrier');
  const [aim, setAim] = useState(() => newAim('carrier'));
  const [poses, setPoses] = useState(null);      // {a:{pose,jointsDeg,gate}, b:{…}, rzA, rzB}
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
    const he = state?.handEye?.tMm;
    if (!Array.isArray(he) || he.length < 3) return { err: '카메라 위치(hand-eye)가 프로필에 없어요 — 스캔 자세를 못 풀어요' };
    const rzG = CARRIER_GRASP_TRUTH.tcpMmDeg[5] + (coarse.yawDeg ?? 0);
    const m = mirrorPair(coarse.user1Mm, he, rzG, { distMm: 300 });
    if (!m) return { err: '거울 쌍 자세를 못 만들었어요' };
    const cur = state?.jointsDeg ?? null;
    const ra0 = await datasource.ik(m.a, cur);
    const rb0 = await datasource.ik(m.b, cur);
    // **지금 손목에 가까운 쪽을 A 로** (2026-09-07 실기 · 실기 담당자 「자세 A 눌러도 되나」) — 거울 쌍은 순서가 없다. 늘 rz_g+90 을 먼저 가면
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
    if (!isMock && !near(state?.tcpMmDeg, pz.pose)) return { err: `팔이 아직 자세 ${which.toUpperCase()} 에 없어요 — 「자세 ${which.toUpperCase()} 로 (실기)」를 먼저 누르고 도착하면 다음`, needMove: which };
    const extra = isMock ? { truth: { user1Mm: coarse.user1Mm, yawDeg: coarse.yawDeg }, atTcpMmDeg: pz.pose } : {};
    const r = await datasource.scan(target, extra);
    if (!r.ok) return { err: `카메라가 못 봤어요 — ${(r.reasons ?? [r.reason]).join(' · ')}`, scan: r };
    return { view: { ...r.view, which } };
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
      if (which === 'a' && poses?.b) onGhost?.(poses.b.pose, poses.b.jointsDeg);
    } catch (e) { setNote(`스캔 실패 — ${String(e).slice(0, 80)}`); } finally { setBusy(false); }
  };
  const applyE = (r, base) => {
    const next = { ...base, fused: r.fused, why: r.verdict.why };
    log('aim-e', { aim: next });
    if (r.verdict.ok) { setAim(next); onFused?.(target, r.fused); setNote(null); return next; }
    onFused?.(target, null);
    if (r.verdict.retry) {
      // 평균 자리를 새 대강값으로 — 표적이 화면 중앙에 오면 롤 편향이 0 으로 간다(수렴 노트 라운드 2). 자세는 다시 푼다
      const again = { ...newAim(target), coarse: { user1Mm: r.fused.user1Mm, yawDeg: r.fused.yawDeg, source: 'fused-pass1' }, pass: base.pass + 1, prevFused: r.fused };
      setAim(again); setPoses(null); setNote(r.verdict.why); return again;
    }
    setAim(next); setNote(r.verdict.why); return next;
  };
  const stepE = () => applyE(doE(aim.views, aim.pass, aim.prevFused ?? null), aim);

  // ── 큰 버튼 하나 — 목업은 끝까지 알아서, 실기는 한 칸씩 ─────────────────────────────
  const autoRun = async () => {
    setBusy(true); setNote(null);
    try {
      let cur = aim; let pz = poses;
      if (!cur.coarse) { const r = doA(); if (r.err) { setNote(r.err); return; } cur = { ...newAim(target), coarse: r.coarse }; setAim(cur); pz = null; log('aim-a', { aim: cur }); }
      for (let guard = 0; guard < 3; guard += 1) {
        if (!pz) { setAuto('자세 잡기'); const r = await doB(cur.coarse); if (r.err) { setNote(r.err); return; } pz = r.poses; setPoses(pz); log('aim-b', { aim: cur, poses: pz }); }
        if (!cur.views.some((v) => v.which === 'a')) {
          setAuto('첫 번째 보기'); const r = await doScan('a', cur.coarse, pz.a);
          if (r.err) { setNote(r.err); if (r.needMove) onGhost?.(pz.a.pose, pz.a.jointsDeg); return; }
          cur = { ...cur, views: [...cur.views, r.view] }; setAim(cur); log('aim-scan-a', { aim: cur, scan: r.view });
          if (!isMock) { onGhost?.(pz.b.pose, pz.b.jointsDeg); return; }      // 실기는 사람이 「자세 B 로」를 누른 뒤 다음
        }
        if (!cur.views.some((v) => v.which === 'b')) {
          setAuto('두 번째 보기'); const r = await doScan('b', cur.coarse, pz.b);
          if (r.err) { setNote(r.err); if (r.needMove) onGhost?.(pz.b.pose, pz.b.jointsDeg); return; }
          cur = { ...cur, views: [...cur.views, r.view] }; setAim(cur); log('aim-scan-b', { aim: cur, scan: r.view });
        }
        setAuto('맞추기');
        const next = applyE(doE(cur.views, cur.pass, cur.prevFused ?? null), cur);
        if (next.fused?.ok) return;
        if (next.pass > cur.pass && isMock) { cur = next; pz = null; continue; }   // 한 번 더 — 목업은 이어 돈다
        return;
      }
    } catch (e) { setNote(`찾기 실패 — ${String(e).slice(0, 80)}`); } finally { setBusy(false); setAuto(null); }
  };

  const a = aim.views.find((v) => v.which === 'a'); const b = aim.views.find((v) => v.which === 'b');
  const armed = state?.phase === 'ARMED' || state?.phase === 'EXECUTING';
  const done = !!aim.fused?.ok;
  const sentence = auto ? `카메라가 보고 있어요… (${auto}${aim.pass > 1 ? ' · 한 번 더' : ''})`
    : done ? `카메라가 두 번 보고 맞췄어요 ✓ 거치대 ${fmt(aim.fused.user1Mm)}${aim.fused.yawDeg ? ` · ${aim.fused.yawDeg.toFixed(0)}° 돌아 있음` : ''}`
      : note ?? (aim.coarse ? (aim.pass > 1 ? '한 번 더 보려고 해요 — 다시 「찾기」' : (a ? '두 번째 보기가 남았어요 — 다시 「찾기」' : '아직 카메라로 안 봤어요 — 「찾기」')) : '아직 안 찾았어요');
  return (
    <div className="aim" data-t="sim-aim" data-target={target} data-pass={aim.pass} data-done={String(done)}>
      {wizard && (
        <>
          <div className="row">
            <button type="button" className="big" data-t="sim-find" disabled={busy || !state?.connected || done} onClick={autoRun}>
              {busy ? '보는 중…' : (done ? '찾았어요 ✓' : (aim.coarse || aim.views.length ? '🔍 이어서 찾기' : '🔍 거치대 찾기'))}
            </button>
            {done && <button type="button" onClick={() => reset()} disabled={busy}>다시 찾기</button>}
            {!isMock && poses?.a?.jointsDeg && !a && <button type="button" data-t="sim-aim-go-a" disabled={!armed} title={armed ? '' : 'ARM 뒤에'} onClick={() => onGo?.(poses.a.jointsDeg, '조준 자세 A')}>자세 A 로 (실기)</button>}
            {!isMock && poses?.b?.jointsDeg && a && !b && <button type="button" data-t="sim-aim-go-b" disabled={!armed} title={armed ? '' : 'ARM 뒤에'} onClick={() => onGo?.(poses.b.jointsDeg, '조준 자세 B')}>자세 B 로 (실기)</button>}
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
          {poses && <> · ⓑ 자세 A rz {poses.rzA.toFixed(1)}° {poses.a.jointsDeg ? '✓' : '✗'}{poses.moveDegA != null ? ` (지금 손목에서 ${poses.moveDegA}°${poses.swapped ? ' · 가까운 쪽을 A 로' : ''})` : ''} / B rz {poses.rzB.toFixed(1)}° {poses.b.jointsDeg ? '✓' : '✗'}
            {!isMock && poses.a.jointsDeg && <button type="button" disabled={!armed} title={armed ? '' : 'ARM 뒤에'} onClick={() => onGo?.(poses.a.jointsDeg, '조준 자세 A')}>이 자세로 (실기) A</button>}
            {!isMock && poses.b.jointsDeg && <button type="button" disabled={!armed} title={armed ? '' : 'ARM 뒤에'} onClick={() => onGo?.(poses.b.jointsDeg, '조준 자세 B')}>B</button>}
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
            ⓔ 융합 <b>{fmt(aim.fused.user1Mm)}</b> · 요각 {aim.fused.yawDeg == null ? '—' : `${aim.fused.yawDeg.toFixed(1)}°`} · 편향(쌍의 차/2) <b>{aim.fused.halfDiffMm.toFixed(2)}mm</b>{aim.fused.driftMm != null ? ` · 두 패스 차 ${aim.fused.driftMm.toFixed(2)}mm` : ''}
            {' — '}{aim.fused.ok ? <span className="ok">{aim.fused.why} → 9칸이 이 자리로</span> : <span className="bad">{aim.fused.why}</span>}
          </p>
        )}
        {note && <p className="refusal" data-t="sim-aim-note">{note}</p>}
      </details>
    </div>
  );
}
