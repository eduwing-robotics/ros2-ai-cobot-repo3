// F8 생산성 비교 — **목업으로 완성한다.** 팀원 알고리즘을 기다리지 않는다.
//
// PRD 성공 판정의 **앞 문장**이 이 화면에서 닫힌다 —
// *"맵 두 개를 만들어 지표를 비교하고 몇 % 낫다를 근거와 함께 말한다."*
//
// 지킬 것:
//   · **지표를 여기서 계산하지 않는다.** 팀원이 낸다. 우리는 받아서 보여준다.
//     유일한 예외가 **A 대 B 의 비교 산술**이다 — 그게 이 화면의 존재 이유다.
//     처리량·사이클타임 자체를 만들면 그 순간 측정이 아니라 창작이 된다
//   · `fetch` 를 직접 부르지 않는다 — `Shared/data/datasource/` 를 거친다.
//     그래야 나중에 백엔드·데이터베이스를 **파일 한 개 교체**로 붙인다
//   · 필수 필드는 `throughputPerHour` 와 `cycleTimeSec.mean` **둘뿐**이다.
//     나머지가 없으면 그 칸만 "—" 로 비운다 — 화면이 죽으면 우리 진행이 팀원 일정에 묶인다 (SR_25)
//   · **출처(mock/sim/measured)를 화면에 표시한다.** 목업을 실측으로 오인해 보고하는 것이
//     이 프로젝트에서 가장 비싼 사고다 (SR_24)
//
// 차트 라이브러리를 넣지 않는다 — 막대는 SVG 로 직접 그린다 (의존성 0).
//
// ⛔ **단위를 여기서 만들지 않는다.** mm → m 은 `Shared/data/units/units.js` 의 `mm()` 이다
//    (하드 룰 5). 화면마다 `/1000` 을 적으면 소수점이 갈리는 날이 온다.
import { useEffect, useRef, useState } from 'react';
import { datasource } from '@fr5/shared/data/datasource/index.js';
import { mm } from '@fr5/shared/data/units/units.js';
import { stateAt } from '@fr5/shared/data/timeline/timeline.js';
import { poseFor } from '@fr5/shared/data/motion/poses.js';

/** 값이 없으면 **긴 대시 하나**. `0` 은 값이므로 살린다 — `||` 를 쓰면 0 이 사라진다. */
const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const fmt = (v, dp) => (has(v) ? Number(v).toFixed(dp) : '—');

/**
 * 볼 지표의 정본. **`better` 가 방향이다** — 처리량은 큰 쪽이, 사이클·대기·간섭은 작은 쪽이 낫다.
 * 이걸 안 적으면 「37.5초가 30.0초보다 25% 크다」를 「25% 낫다」로 읽는 사고가 난다.
 *
 * `req` 는 계약이 정한 **필수 둘**이다 (`LAYOUT-METRICS-CONTRACT.md`). 나머지는 없으면 빈다.
 */
// ⛔ **라벨은 우리 말이 아니라 **읽는 사람 말**이다** (2026-08-13 · 토스 §Casual Concept —
//    *"전문적인 개념을 친숙하고 이해하기 쉬운 개념으로 전달"*). 「처리량 개/h」·「사이클 p95」는
//    우리끼리 쓰는 말이라 처음 보는 사람이 3초 안에 못 읽는다 (토스 §Easy to Answer).
//    ⚠ **계약 필드 이름은 안 바꾼다** — 바뀌는 것은 화면 라벨뿐이고 `get` 이 그 다리다.
const FIELDS = [
  { key: 'thr', label: '한 시간에', unit: '개', dp: 0, better: 'high', req: true,
    get: (m) => m?.throughputPerHour },
  { key: 'mean', label: '하나 만드는 시간', unit: '초', dp: 1, better: 'low', req: true,
    get: (m) => m?.cycleTimeSec?.mean },
  { key: 'p50', label: '보통 걸리는 시간', unit: '초', dp: 1, better: 'low',
    get: (m) => m?.cycleTimeSec?.p50 },
  { key: 'p95', label: '느릴 때', unit: '초', dp: 1, better: 'low',
    get: (m) => m?.cycleTimeSec?.p95 },
  { key: 'amr', label: '로봇차가 다닌 거리', unit: 'm', dp: 0, better: 'low',
    get: (m) => (has(m?.amrTravelMm) ? mm(m.amrTravelMm) : null) },
  { key: 'wArm', label: '팔이 기다린 시간', unit: '초', dp: 0, better: 'low', get: (m) => m?.waitSec?.arm },
  { key: 'wAmr', label: '로봇차가 기다린 시간', unit: '초', dp: 0, better: 'low', get: (m) => m?.waitSec?.amr },
  { key: 'itf', label: '부딪힐 뻔한 횟수', unit: '회', dp: 0, better: 'low', get: (m) => m?.interferences },
];

/**
 * 동작 축(F10) — **같은 배치·같은 작업, 다른 움직임.** PRD 의 와우모먼트다.
 *
 * ⚠ **기준이 반대다.** 배치안은 「A 가 B 보다」(B 대비)인데 동작은 「다듬은 것이 시연보다
 * 몇 % **빨라졌다**」라 **먼저 것(A)이 기준**이다. 기준을 안 뒤집으면 25.9% 가 35.0% 로 나온다 —
 * 같은 두 값에서 나오는 다른 숫자다. 그래서 축마다 기준을 적고 **화면이 그걸 글자로 말한다.**
 */
const MOTION_FIELDS = [
  { key: 'cyc', label: '하나 만드는 시간', unit: '초', dp: 1, better: 'low', req: true,
    get: (m) => m?.cycleSec },
  // **좋고 나쁨을 안 매긴다.** 자세가 적은 것이 곧 나은 것은 아니다 — 값만 나란히 놓는다
  { key: 'pos', label: '팔이 취한 자세', unit: '가지', dp: 0, better: null, get: (m) => m?.poses },
  { key: 'evt', label: '작업 단계', unit: '개', dp: 0, better: null, get: (m) => m?.events },
];

const AXES = {
  layout: { label: '배치안', fields: FIELDS, base: 'B', unit: '배치안' },
  motion: { label: '동작', fields: MOTION_FIELDS, base: 'A', unit: '동작' },
};

/**
 * **이 화면이 하는 유일한 산술.** `base` 를 기준으로 `subject` 가 몇 % 인가.
 *
 * ⚠ **기준을 화면이 글자로 말한다** — "25% 낫다" 는 무엇 대비인지 없으면 뜻이 없다.
 * ⚠ **기준이 0 이면 % 가 없다.** 「무한히 낫다」로 적으면 그건 값이 아니라 연출이다.
 * ⚠ `better` 가 `null` 이면 **좋고 나쁨을 안 매긴다** — 방향이 없는 값에 색을 칠하면 거짓말이다.
 */
function diff(subject, base, better) {
  if (!has(subject) || !has(base) || Number(base) === 0) return null;
  const pct = ((Number(subject) - Number(base)) / Number(base)) * 100;
  const win = better === null ? null : (better === 'high' ? pct > 0 : pct < 0);
  return { pct, abs: Math.abs(pct), win, tie: Math.abs(pct) < 0.05 };
}

/** 막대 둘. **축은 0 에서 시작한다** — 잘라서 그리면 작은 차이가 커 보인다. */
function Bars({ label, unit, dp, a, b, better, base }) {
  const max = Math.max(has(a) ? a : 0, has(b) ? b : 0);
  const w = (v) => (max > 0 && has(v) ? Math.max((Number(v) / max) * 100, 0.4) : 0);
  const d = base === 'A' ? diff(b, a, better) : diff(a, b, better);
  return (
    <figure className="cmp-bars">
      <figcaption>
        {label}
        <small>{unit}</small>
        {/* ⛔ **화살표를 「좋다/나쁘다」로 쓰지 않는다.** 사이클은 짧은 쪽이 나은데 `▲` 를 붙였더니
            **짧은 막대 옆에 「▲ 20%」**가 서서 「높다」로 읽혔다 (2026-08-13 실렌더). 부호는 값의
            방향이고 색이 좋고 나쁨이다 — 표와 같은 규약을 쓴다. */}
        {d && !d.tie && (
          <em className={d.win === null ? '' : (d.win ? 'good' : 'bad')}>
            {d.pct > 0 ? '+' : '−'}{d.abs.toFixed(1)}%
          </em>
        )}
      </figcaption>
      {[['A', a], ['B', b]].map(([side, v]) => (
        <div className="cmp-bar" key={side}>
          <span className="cmp-side">{side}</span>
          <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <rect x="0" y="1.5" width={w(v)} height="7" rx="0.6"
              fill={side === 'A' ? 'var(--c-ok)' : 'var(--c-line-strong)'} />
          </svg>
          <b>{fmt(v, dp)}</b>
        </div>
      ))}
    </figure>
  );
}

// ── 관절 재생 (F10) — **두 동작을 같은 시각에 나란히** ───────────────────────
// `timeline.js` 머리가 적어 둔 그 자리다: *"결정적이어야 한다 — 이게 성립해야 되감기와
// 「동작 A·B 를 같은 시각에 나란히」(F10) 가 성립한다."*
//
// ⛔ **가로축이 벽시계가 아니라 진행률(0~100%)이다.** 사이클이 66초와 49초로 갈리는데
//    벽시계로 묶으면 같은 칸에 「막 출발한 것」과 「거의 끝난 것」이 함께 든다.
//    `SIM-CONTRACT.md` §화면이 밴드에 대해 이미 정한 규약과 같은 이유다 (실측 107.8mm → 5.4mm).
//
// ⛔ **세로축을 각자 맞추지 않는다.** 동작마다 스스로 최대에 맞추면 서로 다른 자로 그린 그림이
//    나란히 서서, 크게 움직인 쪽과 작게 움직인 쪽이 같아 보인다. **둘의 공통 범위**를 쓴다.
const JOINTS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
const JOINT_HUE = [8, 40, 92, 168, 214, 286];
const SAMPLES = 120;

/** 한 동작의 관절 궤적. `poseFor(stateAt(...))` — **여기서 자세를 계산하지 않는다.** */
function traceOf(series, cycleSec) {
  const out = JOINTS.map(() => []);
  if (!series?.length || !(cycleSec > 0)) return out;
  for (let i = 0; i < SAMPLES; i += 1) {
    const u = i / (SAMPLES - 1);
    const pose = poseFor(stateAt(series, u * cycleSec));
    JOINTS.forEach((j, k) => out[k].push(Number(pose[j] ?? 0)));
  }
  return out;
}

/** 관절 여섯을 한 판에. `lo`·`hi` 는 **양쪽이 공유하는** 세로 범위다. */
function JointPlot({ label, source, trace, u, lo, hi }) {
  const H = 64;
  const y = (v) => (hi > lo ? H - ((v - lo) / (hi - lo)) * H : H / 2);
  return (
    <figure className="jp" data-motion={label}>
      <figcaption>{label}<span className="cmp-src">{source}</span></figcaption>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${label} 관절 여섯`}>
        {trace.map((vals, k) => (
          <polyline key={JOINTS[k]} fill="none" strokeWidth="0.8" vectorEffect="non-scaling-stroke"
            stroke={`hsl(${JOINT_HUE[k]} 62% 52%)`}
            points={vals.map((v, i) => `${(i / (SAMPLES - 1)) * 100},${y(v).toFixed(2)}`).join(' ')} />
        ))}
        {/* 재생 머리 — **둘이 같은 진행률에 선다.** 그게 「나란히」의 뜻이다 */}
        <line className="jp-head" x1={u * 100} x2={u * 100} y1="0" y2={H}
          stroke="var(--c-fg)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

/**
 * 모달 하나. **시뮬 탭과 같은 규약이다** — 네이티브 `<dialog>` + 같은 클래스(`sheet`).
 *
 * 왜 이게 필요한가 — 시뮬 탭의 문구 규칙 첫 줄이 *"1층에는 **값과 이름만** — 왜 그렇게
 * 그렸는지는 모달 안에서 말한다"* 다. 이 화면은 그걸 안 지켜 **1층에 설계 변호 문장이
 * 두 줄** 있었다(2026-08-13 실측 306자). 그 문장들이 여기로 온다.
 *
 * ⚠ **의존 배열을 두지 않는다 — 매 렌더 동기화한다.** `<dialog>` 는 우리가 안 시켜도 닫힐 수
 * 있고, 그러면 `open` 이 안 바뀌어 효과가 다시 안 돌아 모달이 영영 안 열린다 (시뮬 탭이 겪었다).
 */
function Sheet({ open, title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  });
  return (
    <dialog ref={ref} className="sheet"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && (
        <>
          <header className="sheet-head">
            <h3>{title}</h3>
            <button type="button" className="sheet-x" onClick={onClose} aria-label="닫기">✕</button>
          </header>
          <div className="sheet-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

/**
 * 출처 배지. **`measured` 가 아니면 눈에 띄어야 한다** — 그게 이 배지의 전부다 (SR_24).
 * ⛔ **영어 코드값을 화면에 그대로 내지 않는다** — `postproc` 을 읽을 수 있는 사람은 우리뿐이다.
 */
const SRC_KO = { mock: '예시값', measured: '실측', sim: '시뮬', demo: '사람이 가르친 것', postproc: '다듬은 것', policy: '학습한 것' };
const Source = ({ src }) => (
  <span className={src === 'measured' ? 'cmp-src real' : 'cmp-src'} data-src={src ?? ''}>
    {SRC_KO[src] ?? src ?? '없음'}
  </span>
);

export function MetricsCompare() {
  // ⛔ **고르는 대상은 배치안이 아니라 회차다.** 안 돌려본 배치안은 비교할 게 없다.
  //    배치안 목록으로 고르게 했더니 저장분 0개인 새 브라우저에서 화면이 빈 채로 떴다 (2026-08-13).
  const [runs, setRuns] = useState([]);
  const [names, setNames] = useState({});
  const [pick, setPick] = useState(['', '']);
  const [run, setRun] = useState([null, null]);
  const [err, setErr] = useState('');
  // F10 — **새 화면이 아니라 축 하나다** (PRD §F10). 비교 대상이 배치안 ↔ 동작으로 바뀐다
  const [axis, setAxis] = useState('layout');
  const [motions, setMotions] = useState([]);
  const [mPick, setMPick] = useState(['', '']);
  const [series, setSeries] = useState([null, null]);
  const [u, setU] = useState(0);            // 재생 머리 — **진행률이다. 초가 아니다**
  const [playing, setPlaying] = useState(false);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([datasource.getRuns(), datasource.getLayouts()])
      .then(([rs, ls]) => {
        if (!live) return;
        setRuns(rs);
        // 배치안 이름이 있으면 쓰고, 없으면 id 를 쓴다 — **회차는 배치안보다 오래 산다**
        setNames(Object.fromEntries(ls.map((l) => [l.id, l.name])));
        // 처음 열었을 때 **뭐라도 서 있어야 한다.** 둘 미만이면 있는 만큼만 고른다
        setPick([rs[0]?.layoutId ?? '', rs[1]?.layoutId ?? rs[0]?.layoutId ?? '']);
      })
      .catch((e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    // **`null` 은 정상이다** — 아직 안 돌려본 배치안이 그렇다. 던지는 것만 오류로 본다
    Promise.all(pick.map((id) => (id ? datasource.getMetrics(id) : Promise.resolve(null))))
      .then((r) => live && setRun(r))
      .catch((e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [pick[0], pick[1]]);

  // 동작 목록은 **배치안 A 를 따라간다** — F10 은 「**같은 배치**에서의 동작 A·B·C」다
  useEffect(() => {
    let live = true;
    if (!pick[0]) { setMotions([]); return undefined; }
    datasource.getMotions(pick[0])
      .then((ms) => {
        if (!live) return;
        setMotions(ms);
        setMPick([ms[0]?.id ?? '', ms[1]?.id ?? ms[0]?.id ?? '']);
      })
      .catch((e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [pick[0]]);

  // 고른 두 동작의 시간축 — 관절 재생이 이걸 먹는다
  useEffect(() => {
    let live = true;
    if (axis !== 'motion' || !pick[0]) return undefined;
    Promise.all(mPick.map((id) => (id ? datasource.getMotionSeries(pick[0], id) : null)))
      .then((ss) => live && setSeries(ss))
      .catch((e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [axis, pick[0], mPick[0], mPick[1]]);

  // **재생 — `requestAnimationFrame` 하나로 둘을 함께 민다.** 시계가 둘이면 「같은 시각」이 깨진다.
  // ⚠ `Date.now()` 를 안 쓴다 — rAF 가 주는 타임스탬프만 쓴다 (`timeline.js` §결정적이어야 한다).
  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    let last = 0;
    const tick = (now) => {
      if (last) setU((v) => (v + (now - last) / 6000) % 1);   // 6초에 한 바퀴
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const ax = AXES[axis];
  const motionOf = (id) => motions.find((m) => m.id === id) ?? null;
  const [A, B] = axis === 'layout' ? run : [motionOf(mPick[0]), motionOf(mPick[1])];
  const name = (id) => (axis === 'layout'
    ? (names[id] ?? (id ? `배치안 ${id}` : '—'))
    : (motionOf(id)?.label ?? '—'));
  const side = axis === 'layout' ? pick : mPick;
  // 배치안은 지표 안에, 동작은 자기 몸에 값을 들고 있다 — 꺼내는 자리를 축이 정한다
  const val = (m, f) => f.get(axis === 'layout' ? m?.metrics : m);
  const head = ax.fields[0];
  // ⚠ 기준이 축마다 다르다 (§동작 축 주석). 「A 대비」면 말하는 주어가 B 다
  const lead = ax.base === 'A'
    ? diff(val(B, head), val(A, head), head.better)
    : diff(val(A, head), val(B, head), head.better);
  const [say, than] = ax.base === 'A' ? [side[1], side[0]] : [side[0], side[1]];
  // **같은 작업이 아니면 나란히 놓지 않는다** — 다른 작업의 시퀀스 타임 비교는 거짓말이다
  const sameTask = axis === 'layout' || !A || !B || A.task === B.task;

  return (
    <section className="cmp">
      <h2>생산성 비교</h2>

      {/* **새 화면이 아니라 축 하나다** (PRD §F10) — 비교 대상이 배치안 ↔ 동작으로 바뀐다 */}
      <div className="cmp-axis" role="tablist">
        {Object.entries(AXES).map(([k, a]) => (
          <button key={k} type="button" role="tab" aria-selected={axis === k}
            data-axis={k} onClick={() => setAxis(k)}>{a.label}</button>
        ))}
      </div>

      {/* ── 결론 하나 — **3초 안에 읽히게** (토스 §Easy to Answer · §One Thing per One Page) ──
          ⛔ 「25.9% 짧다」는 우리 말이다. 사람은 **「얼마나」**를 먼저 묻는다 — 절대값을 앞에 놓고
             %는 뒤에 붙인다. 말투는 화면 전체가 **해요체**로 하나다 (2026-08-13 전수조사에서
             한 화면 안에 해요체와 한다체가 섞여 있었다). */}
      <div className="verdict">
        <p className="cmp-lead">
          {lead && !lead.tie
            ? (axis === 'layout'
              ? <><b>{name(say)}</b> 가 한 시간에 <b className={lead.win ? 'good' : 'bad'}>{fmt(Math.abs(val(A, head) - val(B, head)), 0)}개</b> 더 만들어요<span className="cmp-pct">{lead.abs.toFixed(0)}%</span></>
              : <>움직임을 다듬으니 하나당 <b className={lead.win ? 'good' : 'bad'}>{fmt(Math.abs(val(A, head) - val(B, head)), 0)}초</b> 빨라졌어요<span className="cmp-pct">{lead.abs.toFixed(0)}%</span></>)
            : (lead ? <>두 쪽이 같아요.</> : <>양쪽 값이 있어야 견줄 수 있어요.</>)}
        </p>
        <button type="button" onClick={() => setSheet(true)} data-t="cmp-how">읽는 법 ↗</button>
      </div>

      <Sheet open={sheet} title={`${ax.label} 비교 — 읽는 법`} onClose={() => setSheet(false)}>
        <dl className="how">
          <dt>차이의 기준</dt>
          <dd>
            {ax.base} 를 기준으로 재요. 배치안은 <b>B 대비</b>, 동작은 <b>A 대비</b>예요 —
            「다듬은 것이 시연보다 몇 % 빨라졌다」의 기준은 <b>먼저 것</b>이라 축마다 뒤집혀요.
            같은 두 값에서 25.9% 와 35.0% 가 갈리는 자리예요.
          </dd>
          <dt>부호와 색</dt>
          <dd>
            부호는 <b>값의 방향</b>, 색은 <b>좋고 나쁨</b>이에요. 시간은 짧은 쪽이 나아
            <b className="good"> −20.0%</b> 가 초록이에요. 방향이 없는 값(팔이 취한 자세)은 색이 없어요.
          </dd>
          <dt>빈 칸</dt>
          <dd>
            꼭 있어야 하는 건 둘이에요. 나머지가 없으면 그 칸만 「—」로 둬요 —
            팀원이 값을 덜 줘도 화면이 그날 돌아요.
          </dd>
          <dt>출처 배지</dt>
          <dd>예시값은 노랑, 실측은 초록이에요. 예시값을 실측으로 옮겨 적는 것을 막는 자리예요.</dd>
          {axis === 'motion' && (
            <>
              <dt>관절 판의 가로축</dt>
              <dd>
                <b>진행률 0~100%</b> 이고 벽시계가 아니다. 사이클이 {fmt(A?.cycleSec, 1)}초와
                {' '}{fmt(B?.cycleSec, 1)}초로 갈려서, 같은 초에 묶으면 한 칸에 「막 출발한 것」과
                「거의 끝난 것」이 들어요.
              </dd>
              <dt>관절 판의 세로축</dt>
              <dd>두 그림이 <b>같은 자</b>로 그려져요. 각자 맞추면 서로 다른 자로 그린 그림이 나란히 서요.</dd>
              <dt>같은 작업인가</dt>
              <dd>
                단계와 자리와 순서가 같아야 나란히 놔요. 시각과 자세는 빼요 —
                그 둘이 동작마다 달라지는 것이라, 나머지가 같으면 <b>다른 움직임으로 같은 일</b>을 한 거예요.
              </dd>
              <dt>정책</dt>
              <dd>학습이 끝나야 나와요. 지금은 사람이 가르친 것과 다듬은 것 두 벌이에요.</dd>
            </>
          )}
        </dl>
      </Sheet>

      <div className="cmp-pick">
        {[0, 1].map((i) => (
          <label key={i}>
            <span>{i === 0 ? 'A' : 'B'}</span>
            {axis === 'layout' ? (
              <select
                value={pick[i]}
                onChange={(e) => setPick((p) => (i === 0 ? [e.target.value, p[1]] : [p[0], e.target.value]))}
              >
                {runs.length === 0 && <option value="">회차 없음</option>}
                {runs.map((r) => (
                  <option key={r.layoutId} value={r.layoutId}>{name(r.layoutId)}</option>
                ))}
              </select>
            ) : (
              <select
                value={mPick[i]}
                onChange={(e) => setMPick((p) => (i === 0 ? [e.target.value, p[1]] : [p[0], e.target.value]))}
              >
                {motions.length === 0 && <option value="">동작 없음</option>}
                {motions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            )}
            <Source src={axis === 'layout' ? run[i]?.source : (A && B ? [A, B][i]?.source : null)} />
          </label>
        ))}
      </div>

      {err && <p className="cmp-err">지표를 못 읽었다 — {err}</p>}
      {/* ⛔ **작업이 다르면 나란히 놓지 않는다** — 다른 작업의 시퀀스 타임 비교는 숫자가 거짓말을 한다 */}
      {!sameTask && (
        <p className="cmp-err">작업이 서로 달라요 — 단계와 자리가 어긋나서 비교에서 뺐어요.</p>
      )}
      {axis === 'motion' && motions.length < 2 && (
        <p className="cmp-err">견줄 게 하나뿐이에요 — 같은 배치의 움직임이 둘 이상이어야 % 가 나와요.</p>
      )}

      {/* ⛔ **여덟 줄을 늘 보여주면 아무도 안 읽는다** (토스 §Minimum Features).
          필수 둘만 밖에 두고 나머지는 접는다 — `<details>` 라 DOM 은 그대로 있어 게이트가 잰다. */}
      <details className="cmp-more">
        <summary>숫자 자세히</summary>
      <table className="cmp-tab">
        <thead>
          <tr>
            <th scope="col">지표</th>
            <th scope="col">{name(side[0])}</th>
            <th scope="col">{name(side[1])}</th>
            {/* ⛔ 「B 대비」를 화면에 두면 **사용자가 규칙을 배워야 한다** (토스 §Less Policy).
                기준은 §읽는 법 안에서 말하고, 여기는 값만 둔다 */}
            <th scope="col">차이</th>
          </tr>
        </thead>
        <tbody>
          {ax.fields.map((f) => {
            const a = val(A, f);
            const b = val(B, f);
            const d = sameTask ? (ax.base === 'A' ? diff(b, a, f.better) : diff(a, b, f.better)) : null;
            return (
              <tr key={f.key} className={f.req ? 'req' : ''}>
                <th scope="row">{f.label}<small>{f.unit}</small></th>
                <td>{fmt(a, f.dp)}</td>
                <td>{fmt(b, f.dp)}</td>
                <td className={d && !d.tie && d.win !== null ? (d.win ? 'good' : 'bad') : ''}>
                  {d ? (d.tie ? '같음' : `${d.pct > 0 ? '+' : '−'}${d.abs.toFixed(1)}%`) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </details>

      <div className="cmp-charts">
        {ax.fields.filter((f) => f.req).map((f) => (
          <Bars key={f.key} label={f.label} unit={f.unit} dp={f.dp}
            a={val(A, f)} b={val(B, f)} better={f.better} base={ax.base} />
        ))}
      </div>

      {/* 관절 재생 — **두 동작을 같은 진행률에 나란히** (F10 Outcome 1) */}
      {axis === 'motion' && sameTask && series[0] && series[1] && (
        <div className="jp-wrap">
          <div className="jp-bar">
            <button type="button" onClick={() => setPlaying((v) => !v)} data-t="jp-play">
              {playing ? '정지' : '재생'}
            </button>
            <input type="range" min="0" max="1000" value={Math.round(u * 1000)} aria-label="진행률"
              onChange={(e) => { setPlaying(false); setU(Number(e.target.value) / 1000); }} />
            <b>{(u * 100).toFixed(0)}%</b>
            <span className="jp-legend">
              {JOINTS.map((j, k) => (
                <i key={j} style={{ color: `hsl(${JOINT_HUE[k]} 62% 52%)` }}>{j}</i>
              ))}
            </span>
          </div>
          {(() => {
            const tr = series.map((s) => traceOf(s.series, s.cycleSec));
            const all = tr.flat(2);
            const lo = Math.min(...all, 0);
            const hi = Math.max(...all, 0);
            return (
              <div className="jp-grid">
                {[0, 1].map((i) => (
                  <JointPlot key={i} label={name(mPick[i])} source={series[i].source}
                    trace={tr[i]} u={u} lo={lo} hi={hi} />
                ))}
              </div>
            );
          })()}
          {/* **축 이름만 남긴다.** 왜 진행률인지는 §읽는 법 안에 있다 (시뮬 탭 문구 규칙 1) */}
          <p className="jp-note">가로는 작업 진행률, 세로는 팔 각도예요 · 두 그림은 같은 자로 그렸어요</p>
        </div>
      )}

      <p className="cmp-foot">
        {axis === 'layout'
          ? <>{A?.cycles ?? '—'}개 · {B?.cycles ?? '—'}개 만들어 본 결과예요</>
          : <>같은 배치에서 같은 작업 {A?.events ?? '—'}단계를 돌린 결과예요</>}
      </p>
    </section>
  );
}
