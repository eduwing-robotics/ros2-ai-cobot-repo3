// 기록 절 — **버튼 한 번 = 기록 한 줄**을 되감는다 (2026-09-07 · D191 · 계약 §단계 기록).
// 브리지 `/runs` 를 읽기만 한다. 줄을 누르면 그때의 해(관절각)로 고스트가 간다 — 「그때 왜 틀렸나」를 자세로 본다.
import { useState } from 'react';
import { datasource } from '../../data/datasource/index.js';

const when = (t) => (t ? new Date(t * 1000).toLocaleTimeString('ko-KR', { hour12: false }) : '');
const brief = (l) => {
  const f = l.aim?.fused; const s = l.scan; const g = l.gate;
  if (l.step === 'aim-e' && f) return `융합 (${f.user1Mm?.[0]?.toFixed?.(0)}, ${f.user1Mm?.[1]?.toFixed?.(0)}) · 차/2 ${f.halfDiffMm}mm · ${f.ok ? '통과' : '아님'}`;
  if (s?.user1Mm) return `스캔 ${l.step.slice(-1).toUpperCase()} (${s.user1Mm[0].toFixed(0)}, ${s.user1Mm[1].toFixed(0)}) rz ${s.rzDeg}`;
  if (l.step === 'go') return `${l.label ?? ''} → ${l.sent ? `${l.sent.cmd} ${l.sent.speedPct ?? ''}%` : '안 보냄(목업)'}${g && !g.ok ? ` · 거부 ${g.reasons?.[0] ?? ''}` : ''}`;
  return l.step;
};

export function RunLog({ runId, onGhost }) {
  const [runs, setRuns] = useState(null);
  const [pick, setPick] = useState(null);
  const [doc, setDoc] = useState(null);
  const load = async () => {
    const list = await datasource.runs();
    const arr = Array.isArray(list) ? list : [];
    setRuns(arr);
    const id = pick ?? runId ?? arr[arr.length - 1]?.runId ?? null;
    if (id) { setPick(id); setDoc(await datasource.run(id)); }
  };
  return (
    <details data-t="sim-log" className="runlog">
      <summary>기록 — 버튼 한 번 = 한 줄{runId ? ` · 이번 세션 ${runId}` : ''}{doc?.lines ? ` · ${doc.lines.length}줄` : ''}</summary>
      <div className="row">
        <button type="button" data-t="sim-log-refresh" onClick={load}>새로고침</button>
        {runs && <select value={pick ?? ''} aria-label="기록 고르기" onChange={async (e) => { setPick(e.target.value); setDoc(await datasource.run(e.target.value)); }}>
          {runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId} · {r.n}줄</option>)}
        </select>}
        {runs && runs.length === 0 && <span>기록이 아직 없어요</span>}
      </div>
      {doc?.lines && (
        <ol className="loglines" data-t="sim-log-lines">
          {doc.lines.map((l, i) => (
            <li key={i}>
              <button type="button" disabled={!l.solved?.jointsDeg && !l.poses?.a?.jointsDeg}
                title="그때의 자세로 고스트를"
                onClick={() => onGhost?.(l.solved?.tcpMmDeg ?? l.poses?.a?.pose ?? null, l.solved?.jointsDeg ?? l.poses?.a?.jointsDeg ?? null)}>
                {when(l.t)} <b>{l.step}</b> — {brief(l)}
              </button>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
