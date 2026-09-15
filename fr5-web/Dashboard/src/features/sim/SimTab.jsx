// 「시뮬」 탭 — 한 화면에 결론, 깊은 것은 **모달로** (`SIM-CONTRACT.md` §화면).
//
// 이 화면이 지키는 것 다섯:
//  ① **0층 결정이 맨 위다.** 차트를 다 보고도 뭘 바꿀지 모르면 근거가 아니라 그림이다
//  ② **스크롤하지 않는다.** 한 화면에 들어가는 만큼만 놓고, 나머지는 `<dialog>` 로 연다 —
//     세로로 늘어놓으면 아무도 아래를 안 본다 (2026-08-12 에 1,700px 짜리를 만들었다)
//  ③ **개체를 그리지 않는다.** 96개면 선 96개가 아니라 분위수 밴드다
//  ④ **분산을 부풀리지 않는다.** 납작하면 납작하게 — 축을 좁혀 크게 보이게 하지 않는다
//  ⑤ **집계를 여기서 하지 않는다.** 러너가 구운 `agg.json` 을 읽는다
//
// **문구 규칙 넷** (2026-08-12 · 화면 문구 1,233자를 세고 정했다):
//  1층에는 **값과 이름만** — 왜 그렇게 그렸는지는 모달 안에서 말한다 ·
//  **부정문을 안 쓴다**(아닌 것 말고 인 것을 적는다) · **긴 대시는 화면당 하나** ·
//  **라벨은 명사로 끝낸다**. 이 규칙을 어기면 화면이 데이터 대신 자기 설계를 변호한다.
//
// **출처를 모른다.** `Sim/out/…` 이라는 경로는 `Shared/data/datasource/sim.js` 만 안다.
import { useEffect, useRef, useState } from 'react';
import { simSource } from '@fr5/shared/data/datasource/index.js';
import { SweepCloud } from './SweepCloud.jsx';
import { ReplayView } from './ReplayView.jsx';

const fmt = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

/** 회차 파일명 → 사람이 읽는 이름. **모르는 꼴이면 원래 이름을 그대로 준다.** */
function batchKo(id) {
  const m = String(id).match(/^(.+?)-slot(\d+)-n(\d+)-seed(\w+)$/);
  return m ? `슬롯 ${m[2]} · ${m[3]}대 · 씨앗 ${m[4]}` : id;
}
const secs = (ms) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`);

/**
 * 모달 하나. **네이티브 `<dialog>` 를 쓴다** — 포커스 가두기·`Esc`·바깥 클릭이 공짜다.
 * 직접 만들면 접근성을 우리가 다시 짜야 하고, 그 코드는 아무도 검증하지 않는다.
 */
function Sheet({ open, title, sub, wide, onClose, children }) {
  const ref = useRef(null);
  // ⚠ **의존 배열을 두지 않는다 — 매 렌더 동기화한다.** `<dialog>` 는 우리가 안 시켜도
  //   닫힐 수 있고(브라우저 판단·포커스 이동), 그러면 `open` 이 안 바뀌어 효과가 다시 안 돌아
  //   모달이 **영영 안 열린 채로 남는다**. 실렌더 게이트에서 산발적으로 그랬다 (2026-08-12).
  //   상태가 정본이고 DOM 을 거기 맞춘다.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  });
  return (
    <dialog
      ref={ref}
      className={wide ? 'sheet wide' : 'sheet'}
      // `Esc` 는 우리가 받는다 — 네이티브 닫기를 막고 상태부터 바꾼다
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && (
        <>
          <header className="sheet-head">
            <h3>{title}</h3>
            {sub && <span className="sheet-sub">{sub}</span>}
            <button type="button" className="sheet-x" onClick={onClose} aria-label="닫기">✕</button>
          </header>
          <div className="sheet-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

/** 카드 하나 — 제목 + 「크게」 버튼. 누르면 같은 내용을 모달로 연다. */
function Card({ title, hint, onOpen, className, children }) {
  return (
    <figure className={className ? `card ${className}` : 'card'}>
      <figcaption className="card-head">
        <b>{title}</b>
        {hint && <span className="card-hint">{hint}</span>}
        {onOpen && <button type="button" className="card-open" onClick={onOpen}>크게 ↗</button>}
      </figcaption>
      <div className="card-body">{children}</div>
    </figure>
  );
}

/**
 * 여유 분위수 밴드 — **가로축은 진행률(0~100%)이다** (계약 §화면 · 2026-08-12).
 * 벽시계로 묶으면 같은 칸에 「막 출발한 것」과 「가장 붙은 것」이 함께 든다 —
 * 같은 회차·축만 바꿔 실측한 칸별 90% 폭이 **107.8mm → 5.4mm** 였다.
 * **0 선은 눈금이 아니라 구역 경계다** — 음수면 이미 안이다.
 */
function ClearanceBand({ band }) {
  const W = 620; const H = 200; const PAD = 44;
  if (!band?.pct?.length) return <p className="empty">밴드 칸 없음</p>;
  let lo = 0; let hi = 0;
  for (const v of band.p05) if (v < lo) lo = v;
  for (const v of band.p95) if (v > hi) hi = v;
  const pad = (hi - lo) * 0.06 || 1;
  const x = (p) => PAD + (p / 100) * (W - PAD - 10);
  const y = (v) => H - 26 - ((v - lo + pad / 2) / (hi - lo + pad)) * (H - 44);
  const area = (a, b) => [
    ...band.pct.map((p, i) => `${i ? 'L' : 'M'}${x(p)},${y(b[i])}`),
    ...band.pct.map((p, i) => `L${x(p)},${y(a[i])}`).reverse(), 'Z',
  ].join(' ');
  const line = (arr) => band.pct.map((p, i) => `${i ? 'L' : 'M'}${x(p)},${y(arr[i])}`).join(' ');
  let worstI = 0;
  for (let i = 1; i < band.p05.length; i += 1) if (band.p05[i] < band.p05[worstI]) worstI = i;
  const inside = lo < 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="여유 분위수 밴드 (진행률 축)" className="band">
      {inside && <rect x={PAD} y={y(0)} width={W - PAD - 10} height={Math.max(0, y(lo) - y(0))} className="danger" />}
      <path d={area(band.p05, band.p95)} className="band90" />
      <path d={area(band.p25, band.p75)} className="band50" />
      <path d={line(band.p50)} className="median" fill="none" />
      <line x1={PAD} y1={y(0)} x2={W - 10} y2={y(0)} className="zeroline" />
      <text x={W - 12} y={y(0) - 5} className="tick zerotag" textAnchor="end">구역 경계</text>
      <circle cx={x(band.pct[worstI])} cy={y(band.p05[worstI])} r="3.5" className="worstdot" />
      <text x={6} y={y(hi) + 4} className="tick">{fmt(hi)}mm</text>
      <text x={6} y={y(lo)} className="tick">{fmt(lo)}mm</text>
      <text x={PAD} y={H - 6} className="tick">0%</text>
      <text x={(PAD + W) / 2} y={H - 6} className="tick" textAnchor="middle">진행률</text>
      <text x={W - 10} y={H - 6} className="tick" textAnchor="end">100%</text>
    </svg>
  );
}

/** 칸별 소요시간 — **「속도를 올려라」가 아니라 「어느 칸의 속도를 올려라」**. */
function StepBar({ steps }) {
  const rows = (steps ?? []).filter((s) => s.ms);
  if (!rows.length) return <p className="empty">칸 정보 없음</p>;
  const sum = rows.reduce((a, s) => a + s.ms.p50, 0) || 1;
  return (
    <div className="stepbar">
      {rows.map((s) => {
        const w = (s.ms.p50 / sum) * 100;
        return (
          <span key={s.index} style={{ width: `${w}%` }} data-type={s.type}
            title={`${s.index} ${s.type} ${s.pointName ?? ''} · 중앙 ${fmt(s.ms.p50)}ms`}>
            {w > 12 ? `${s.pointName ?? s.type} ${secs(s.ms.p50)}` : ''}
          </span>
        );
      })}
    </div>
  );
}

/** 사이클타임 바코드 — **선 하나 = 실행 하나.** 상자 하나로 뭉개면 어디 몰렸나가 사라진다. */
function Barcode({ rows, spread: sp }) {
  const W = 620; const H = 52;
  // ⛔ **완주한 벌만 선을 긋는다** — 시간초과한 벌의 시간은 사이클이 아니라 막힌 채
  //   흘려보낸 시간이라, 같이 그으면 「이 회차는 이만큼 걸린다」가 거짓이 된다 (2026-08-19).
  const v = (rows ?? []).filter((r) => !r.timedOut).map((r) => r.cycleMs).filter(Number.isFinite);
  if (!sp) return <p className="empty">완주한 벌이 0 대라 사이클이 아직 없어요</p>;
  if (!v.length) return <p className="empty">회차 읽는 중</p>;
  const hi = sp.max * 1.05;
  const X = (t) => 30 + (t / hi) * (W - 40);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="사이클타임 바코드" className="flat">
      <rect x={X(sp.p25)} y="8" width={Math.max(1, X(sp.p75) - X(sp.p25))} height="22" className="band50" />
      {v.map((t, i) => <line key={i} x1={X(t)} y1="8" x2={X(t)} y2="30" className="barcode" />)}
      <line x1={X(sp.p50)} y1="4" x2={X(sp.p50)} y2="34" className="median" />
      <text x="2" y="24" className="tick">0</text>
      <text x={W - 4} y={H - 4} className="tick" textAnchor="end">{secs(sp.max)}</text>
      <text x={X(sp.p50)} y={H - 4} className="tick" textAnchor="middle">중앙 {secs(sp.p50)}</text>
    </svg>
  );
}

export function SimTab() {
  const [ids, setIds] = useState(null);
  const [id, setId] = useState(null);
  const [agg, setAgg] = useState(null);
  const [stamp, setStamp] = useState(null);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [sheet, setSheet] = useState(null);         // 열려 있는 모달 이름
  const [inst, setInst] = useState(null);           // 고른 인스턴스 (3D)
  const [frames, setFrames] = useState(null);
  const [sweep, setSweep] = useState(null);
  const [showSim, setShowSim] = useState(false);    // 「시뮬레이션 형상」 토글
  // ⛔ **재생 진행률을 여기로 올리지 않는다** (2026-08-12). 3D 스크러버를 밴드에도 세워 봤는데,
  //    그 밴드는 모달에 가려 **보이지 않으면서** 탭 전체를 20Hz 로 리렌더시켰다. 그 부하가
  //    URDF 로딩을 굶겨 실렌더 게이트가 산발적으로 빨개졌다 — 최적화가 아니라 삭제가 답이다.

  useEffect(() => {
    // 출처가 **새 것부터** 준다 — 이름순으로 골랐더니 없어진 슬롯의 옛 회차가 떠 있었다
    simSource.listBatches().then((list) => { setIds(list); if (list.length) setId(list[0]); });
  }, []);

  useEffect(() => {
    if (!id) return;
    setErr(null);
    Promise.all([simSource.getAgg(id), simSource.getBatch(id)])
      .then(([a, b]) => { setAgg(a); setStamp(b); })
      .catch((e) => { setAgg(null); setStamp(null); setErr(String(e.message ?? e)); });
    simSource.getSummary(id).then(setRows).catch(() => setRows(null));
    setSheet(null); setInst(null); setFrames(null); setSweep(null);
  }, [id]);

  // **무거운 것은 그 모달을 열 때만 받는다** — 1층만 보는 사람에게 안 보낸다
  useEffect(() => {
    if (inst === null || frames) return;
    simSource.getFrames(id).then(setFrames).catch((e) => setErr(String(e.message ?? e)));
  }, [inst, frames, id]);
  useEffect(() => {
    if (sheet !== 'cloud' || sweep) return;
    simSource.getSweep(id).then(setSweep).catch(() => setSweep(null));
  }, [sheet, sweep, id]);

  // 개발 서버에서만 — 모달이 왜 닫혔는지는 DOM 만 봐서는 못 가린다 (2026-08-12 플레이크 추적)
  if (import.meta.env.DEV) {
    window.__sim = { id, sheet, inst, frames: Boolean(frames), ids: ids?.length ?? null };
  }
  if (ids === null) return <section className="sim"><p className="empty">회차 찾는 중</p></section>;
  if (!ids.length) {
    return (
      <section className="sim">
        <p className="empty">
          <b>회차 없음.</b> 하나 구우면 나온다.{' '}
          <code>node Sim/runner/batch.mjs --n 96</code>
        </p>
      </section>
    );
  }

  const cyc = agg?.cycleMs;
  const v = agg?.verdict;
  const old = Boolean(agg) && (!agg.clearanceBand?.pct || !agg.steps);
  const worst = agg?.worst ?? [];
  const instFrames = frames?.instances?.find((x) => x.i === inst) ?? null;

  return (
    <section className="sim">
      <div className="simhead">
        <label>
          회차{' '}
          <select value={id ?? ''} onChange={(e) => setId(e.target.value)}>
            {/* ⛔ 파일명(`fr5-lab-a-slot2-n96-seed20260808`)을 그대로 띄우면 아무도 못 읽는다.
                **값은 id 그대로 두고 보이는 글자만** 사람 말로 바꾼다 (토스 §Casual Concept) */}
            {ids.map((b) => <option key={b} value={b}>{batchKo(b)}</option>)}
          </select>
        </label>
        {/* ⛔ 영어 코드값을 그대로 내지 않는다 — 읽을 수 있는 사람은 우리뿐이다 */}
        <span className="source" data-src={simSource.source}>출처 {simSource.source === 'sim-files' ? '시뮬 파일' : simSource.source}</span>
        {/* **누가 판정했나** — 지문이 다른 회차는 나란히 놓지 않는다 (계약 §화면) */}
        <span className="fp" title="판정 규칙 지문 — 같은 지문끼리만 견줄 수 있어요">판정 규칙 {stamp?.judge?.fingerprint ?? '—'}</span>
        <span className="fp">엔진 {stamp?.engineVersion ?? '—'}</span>
      </div>

      {err && <p className="empty warn">읽기 실패: {err}</p>}
      {old && (
        <p className="empty warn">
          <b>옛 형식 회차.</b> 다시 구우면 된다.{' '}
          <code>node Sim/runner/batch.mjs --n {agg.n} --seed {stamp?.seed ?? ''}</code>
        </p>
      )}

      {agg && !old && (
        <div className="simgrid">
          {/* ── 0층 결정 ─────────────────────────────────────────────── */}
          <div className={v?.blocked ? 'verdict blocked' : 'verdict'}>
            <p><b>{v?.headline}</b><span className="vdetail">{v?.detail}</span></p>
            <button type="button" onClick={() => setSheet('axes')}>조건 축 ↗</button>
          </div>

          {/* ── KPI ──────────────────────────────────────────────────── */}
          <dl className="kpis">
            <div><dt>돌린 대수</dt><dd>{agg.n}대</dd></div>
            <div><dt>끝까지 간 대수</dt><dd>{stamp?.completed ?? '—'}<small>/{agg.n}</small></dd></div>
            <div><dt>보통 걸린 시간</dt><dd>{secs(cyc?.p50)}</dd></div>
            <div className={agg.minClearMm?.min < 0 ? 'bad' : undefined}>
              <dt>가장 아슬아슬했던 거리</dt><dd>{fmt(agg.minClearMm?.min, 2)}<small>mm</small></dd>
            </div>
            <div className={stamp?.events > agg.n ? 'bad' : undefined}>
              <dt>사건</dt><dd>{(stamp?.events ?? 0).toLocaleString()}</dd>
            </div>
            <div><dt>가장 붙는 대목</dt><dd>{agg.clearanceBand?.worstPct ?? '—'}<small>%</small></dd></div>
          </dl>

          {/* ── 큰 차트 ──────────────────────────────────────────────── */}
          <Card title="벽까지 거리 · 작업 진행률" className="big"
            hint={`최소 ${fmt(agg.clearanceBand?.worstMm, 1)}mm · ${agg.clearanceBand?.worstPct ?? '—'}%`}
            onOpen={() => setSheet('band')}>
            <ClearanceBand band={agg.clearanceBand} />
          </Card>

          {/* ── 작은 것 둘 ───────────────────────────────────────────── */}
          <Card title="단계마다 걸린 시간" hint={cyc ? `합쳐서 ${secs(cyc.p50)}` : '완주 0 대'} onOpen={() => setSheet('steps')}>
            <StepBar steps={agg.steps} />
          </Card>
          {/* ⚠ 완주가 0 이면 「—–—」 를 적지 않는다 — 빈 칸 둘은 사실을 말하지 않는다 (2026-08-19) */}
          <Card title="사이클타임" hint={cyc ? `${secs(cyc.min)}–${secs(cyc.max)}` : '완주 0 대'} onOpen={() => setSheet('cycle')}>
            <Barcode rows={rows} spread={cyc} />
          </Card>

          {/* ── 인스턴스 칩 — 누르면 3D 가 열린다 ────────────────────── */}
          <div className="chips">
            <span className="chips-label">아슬아슬했던 순서 · 눌러서 3D</span>
            {worst.slice(0, 8).map((w) => (
              <button key={w.instance} type="button" className="chip"
                onClick={() => { setInst(w.instance); setSheet('replay'); }}>
                #{w.instance}<small>{fmt(w.minClearMm, 1)}mm</small>
              </button>
            ))}
            <button type="button" className="chip ghost" onClick={() => setSheet('cloud')}>점군 ↗</button>
            <button type="button" className="chip ghost" onClick={() => setSheet('events')}>사건 밀도 ↗</button>
          </div>
        </div>
      )}

      {/* ── 모달들 ─────────────────────────────────────────────────── */}
      <Sheet open={sheet === 'band'} wide title="벽까지 거리 · 작업 진행률" onClose={() => setSheet(null)}
        sub="90% · 50% · 중앙값">
        <ClearanceBand band={agg?.clearanceBand} />
        <p className="note">
          가로축은 <b>진행률</b>입니다. 속도가 달라도 같은 동작이 같은 자리에 옵니다.
          벽시계로 묶었을 때 칸별 90% 폭은 107.8mm 였고, 진행률로 바꾸니 5.4mm 가 됐습니다.
          칸마다 표본 {agg?.clearanceBand?.n?.[0] ?? '—'}개.
        </p>
      </Sheet>

      <Sheet open={sheet === 'axes'} wide title="조건 축" onClose={() => setSheet(null)}
        sub="상관과 효과 크기">
        <AxisTable cond={agg?.conditions} />
      </Sheet>

      <Sheet open={sheet === 'steps'} title="단계마다 걸린 시간" onClose={() => setSheet(null)}
        sub="중앙값과 90% 폭">
        <StepBar steps={agg?.steps} />
        <table className="grid">
          <thead><tr><th>칸</th><th>측정</th><th>비중</th><th>중앙</th><th>90% 폭</th></tr></thead>
          <tbody>
            {(agg?.steps ?? []).filter((s) => s.ms).map((s, _, all) => {
              const sum = all.reduce((a, x) => a + x.ms.p50, 0) || 1;
              return (
                <tr key={s.index}>
                  <th scope="row">{s.index} {s.type}{s.pointName ? ` → ${s.pointName}` : ''}</th>
                  <td>{s.type === 'grip' ? '제외' : '물리'}</td>
                  <td>{fmt((s.ms.p50 / sum) * 100, 1)}%</td>
                  <td>{fmt(s.ms.p50)}ms</td>
                  <td>{fmt(s.ms.p05)}~{fmt(s.ms.p95)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note"><b>손 동작은 시뮬 밖이에요.</b> 모델의 손가락이 고정이라 열고 닫는 게 물리를 안 타요.</p>
      </Sheet>

      <Sheet open={sheet === 'cycle'} wide title="사이클타임" onClose={() => setSheet(null)}
        sub={cyc ? `${secs(cyc.min)}–${secs(cyc.max)}` : '완주 0 대'}>
        <Barcode rows={rows} spread={cyc} />
        <table className="grid">
          {/* ⛔ **「규칙 위반」과 「부딪힘」은 다른 것이다.** 받침·작업물은 충돌체지 구역이
              아니라(SIM-CONTRACT §받침) 거기 처박혀 멈춰도 위반은 0 이다. 한 칸으로 합치면
              「위반 0 인데 왜 못 끝냈나」가 화면에서 영영 안 풀린다 (2026-08-18) */}
          <thead><tr><th>몇 번째</th><th>가장 가까웠던 거리(mm)</th><th>걸린 시간</th><th>규칙 위반</th><th>부딪힘</th><th>시작 각도(°)</th><th /></tr></thead>
          <tbody>
            {worst.map((w) => (
              <tr key={w.instance}>
                <th scope="row">#{w.instance}</th>
                <td>{fmt(w.minClearMm, 3)}</td>
                {/* ⚠ 시간초과한 벌의 시간은 **사이클이 아니라 막힌 채 흘려보낸 시간**이다.
                    같은 칸에 그냥 적으면 「이 벌은 90초 걸렸다」로 읽힌다 (2026-08-19) */}
                <td>{w.timedOut ? <span className="tmo">{secs(w.cycleMs)} · 못 끝냄</span> : secs(w.cycleMs)}</td>
                <td>{w.violations}</td>
                <td>{w.contacts ?? '—'}</td>
                <td>{fmt(w.startJ1Deg, 2)}</td>
                <td><button type="button" onClick={() => { setInst(w.instance); setSheet('replay'); }}>3D ↗</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Sheet>

      <Sheet open={sheet === 'events'} wide title="사건 밀도" onClose={() => setSheet(null)}
        sub="종류 × 시간">
        <EventDensity density={agg?.eventDensity} />
      </Sheet>

      <Sheet open={sheet === 'cloud'} wide title="스윕 볼륨" onClose={() => setSheet(null)}
        sub={`손끝 ${(sweep?.count ?? 0).toLocaleString()}점`}>
        {sweep ? <SweepCloud sweep={sweep} stage={stamp?.workspace} highlight={inst} />
          : <p className="empty">점군 받는 중</p>}
      </Sheet>

      <Sheet open={sheet === 'replay'} wide title={`인스턴스 #${inst ?? ''}`}
        onClose={() => setSheet(null)}
        sub={rowSub(rows, inst)}>
        {instFrames ? (
          <ReplayView
            deg={instFrames.deg}
            frameCount={frames.framesPerInstance}
            jointCount={frames.jointCount}
            robotId={stamp?.robotId}
            workspace={stamp?.workspace}
            userDef={stamp?.coordDefs?.user}
            showSim={showSim}
            onToggleSim={setShowSim}
          />
        ) : <p className="empty">자세 받는 중 (445KB)</p>}
      </Sheet>
    </section>
  );
}

/** 모달 부제 — 그 인스턴스의 한 줄 요약. 없으면 빈 값(거짓말하지 않는다). */
function rowSub(rows, i) {
  const r = (rows ?? []).find((x) => x.instance === i);
  if (!r) return '';
  return `여유 ${fmt(r.minClearMm, 2)}mm · 사이클 ${secs(r.cycleMs)} · 속도 ${r.speedPct}% · 위반 ${r.violations}`;
}

/** 조건 축 — **상관 옆에 효과 크기.** 설명력 0.971 이 0.03mm 일 수 있다. */
function AxisTable({ cond }) {
  if (!cond) return null;
  return (
    <>
      <table className="grid">
        <thead>
          <tr>
            <th>조건 축</th><th>조절</th><th>흔든 폭</th>
            <th>여유 설명력</th><th>여유 효과</th><th>사이클 설명력</th><th>사이클 효과</th>
          </tr>
        </thead>
        <tbody>
          {cond.axes.map((a) => (
            <tr key={a.key} className={cond.gridAxis === a.key ? 'hot' : undefined}>
              <th scope="row">{a.key}</th>
              <td>{a.spanned ? (a.controllable ? '가능' : '고정') : '—'}</td>
              <td>{a.spanned ? `${a.spanned}${a.unit ?? ''}` : '—'}</td>
              <td>{a.explainsClearance ?? '—'}</td>
              <td>{a.dClearMm === null || a.dClearMm === undefined ? '—' : `${fmt(a.dClearMm, 2)}mm`}</td>
              <td>{a.explainsCycle ?? '—'}</td>
              <td>{a.dCycleMs === null || a.dCycleMs === undefined ? '—' : secs(a.dCycleMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        <b>설명력</b>은 방향, <b>효과</b>는 크기입니다. 결정에는 효과를 씁니다.
        시작 자세는 회차마다 달라지는 값이라 조절 축은 <code>speedPct</code> 하나입니다.
        폭이 <code>—</code> 인 축은 다음 회차에 흔들 후보입니다.
      </p>
      {cond.gridReady && (
        <table className="grid">
          <caption>조건 셀 · <b>{cond.gridAxis}</b> 4분위 (설명력 {cond.bestExplains})</caption>
          <thead><tr><th>셀</th><th>구간</th><th>n</th><th>여유 중앙(mm)</th><th>여유 최소(mm)</th><th>사이클 중앙</th></tr></thead>
          <tbody>
            {cond.cells.map((c) => (
              <tr key={c.cell}>
                <th scope="row">셀 {c.cell}</th>
                <td>{c.range[0]} ~ {c.range[1]}</td>
                <td>{c.n}</td><td>{c.medClearMm}</td><td>{c.minClearMm}</td><td>{secs(c.medCycleMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** 사건 밀도 띠 — **안 난 종류도 행으로 남긴다.** 사라지면 「없다」와 「안 쟀다」가 같아 보인다. */
function EventDensity({ density }) {
  const kinds = density?.kinds ?? [];
  let max = 1;
  for (const row of density?.counts ?? []) for (const c of row) if (c > max) max = c;
  return (
    <>
      <table className="density events">
        <tbody>
          {kinds.map((kind, ki) => (
            <tr key={kind}>
              <th scope="row">{kind}</th>
              <td>
                <span className="strip">
                  {density.counts[ki].map((c, i) => (
                    <i key={i} style={{ opacity: c ? 0.15 + 0.85 * (c / max) : 0 }} />
                  ))}
                </span>
              </td>
              <td className="num">{density.counts[ki].reduce((s, c) => s + c, 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">칸 {density?.binMs ?? '—'}ms · 0 건인 종류도 행으로 남깁니다.</p>
    </>
  );
}
