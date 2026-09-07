// Program 패널 — 지점을 순서로 엮어 승인한 것만 한 단계씩 실행한다 (PROGRAM-CONTRACT.md).
//
// **여기는 녹화하지 않는다.** 찍는 것은 Teach, 되짚는 것은 History 다 (계획 §화면).
//
// 초심자가 따라올 수 있게 세 가지를 지킨다:
//   ① 지금 몇 번째 칸인지 **번호로** 보인다  ② 버튼은 **지금 할 한 가지**만 말한다
//   ③ 못 누를 때는 회색으로 죽이지 않고 **왜인지 적는다** — 회색 버튼은 이유를 안 알려준다
//
// 안전 판정은 전부 서버가 한다. 여기 disabled 는 편의지 안전장치가 아니다 (SAFETY-RULES 제2원칙).
import { useCallback, useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { Section } from '../Section.jsx';
import { SPEED_CAP_PCT, SpeedPick } from '../control/SpeedPick.jsx';

// 서버는 커서를 안 든다 (D78) — "지금 여기" 는 화면이 센다. 그래서 중단해도 재개할 상태가
// 서버에 없고, 처음부터 다시 도는 사고도 구조적으로 없다.
//
// **연속 실행도 여기서 돈다** (D94 · 계약 §연속 실행과 반복). 새 엔드포인트가 아니라 기존
// `slotStep` 을 index 올려 가며 부르는 것이라, 매 단계가 ARMED·승인·정체 지문·경로 검사·
// 26조건을 처음부터 다시 탄다. 그리고 **탭을 닫으면 멈춘다** — 사람이 자리를 뜨면 멈추는
// 쪽이 기본값이어야 한다 (하드 룰 3).
//
// 다음 단계를 언제 보낼지는 **묻지 않는다** — 서버가 `settle_seconds()`(실측 · D89)만큼
// 기다렸다 응답한다. 응답을 await 하는 것이 곧 "도착했다" 다. 폴링하지 않는다.
const MAX_LAPS = 20;   // 무한은 안 연다 (D94). 천장: 양산 반복은 상한이 아니라 감시부터 정한다

// 두 칸을 맞바꾼다. **끼워넣기가 아니라 맞바꾸기다** — 한 칸씩 올리면 사람이 눈으로 따라간다.
// 이게 없어서 3번 앞에 하나 넣으려면 뒤의 칸을 전부 빼고 다시 넣어야 했다.
const swapped = (arr, a, b) => {
  const out = [...arr];
  [out[a], out[b]] = [out[b], out[a]];
  return out;
};

// **칸 이름은 값에서 만든다** (계약 §grip 칸). 사람이 이름을 지으면 목록이 스스로 읽히지
// 않는다 — Robotiq 의 자동 명명과 같은 이유다.
//
// ⚠ **열기/닫기로 갈라 적지 않는다 (2026-08-10 정정).** 처음엔 `0`→「손 열기」·`100`→「손 닫기」로
// 적었는데 **방향이 거꾸로였다** — `pct` 는 **벌어짐**이라 `100` 이 열림이다(`main.py` 의
// `open:true → 100` · 조작대 `완전 열기 → send(100)` · `gripMm = pct × 행정 / 100`).
// 「닫기」라고 쓰인 칸이 손을 열면 물건을 떨어뜨린다. **동사를 라벨에 넣으면 그 자리가 다시
// 생긴다** — 그래서 값만 적는다.
//
// 문법은 **이동 칸과 맞춘다**: `trayPick 으로` / `손 42% 로`. 둘 다 「…으로 보낸다」라 동사가
// 하나다. 방향(0=닫힘·100=열림)은 **입력칸 툴팁과 §집기 순서 안내**가 말한다 — 라벨이
// 아니라 그 둘이 방향의 정본이다.
const stepLabel = (st) => (st.type === 'grip'
  ? `손 ${st.pct}% 로`
  : `${st.pointName} 으로`);

// `grip` 칸을 끼울 때 `pct` 를 어디서 가져오나 — **출처를 같이 돌려준다.**
// 자동으로 넣고 말 안 하면 「지점이 그리퍼를 재생한다」는 오해가 되살아난다 (계약 §grip 칸).
function gripSeed(step, points, liveState) {
  const p = step?.type === 'move' && points.find((x) => x.name === step.pointName);
  if (p && typeof p.gripperPct === 'number') {
    return { pct: Math.round(p.gripperPct), from: `${p.name} 에서 잰 값` };
  }
  const live = liveState?.gripper?.pct;
  if (typeof live === 'number') return { pct: Math.round(live), from: '지금 실물 값' };
  // 잰 값도 지금 값도 없다 — **지어내지 않고 활짝 열어 두고 확인을 요구한다.**
  // `100`(= 벌어짐 최대)을 고른 이유: 닫힌 손으로 시작하면 다음 이동이 물건·치구를 치고,
  // 그 사고가 더 비싸다. **`0` 이 닫힘이다** — 방향을 한 번 거꾸로 적었으니 여기 적어 둔다
  return { pct: 100, from: '잰 값이 없어 활짝 열어 뒀습니다 (100% = 벌어짐 최대). 확인하세요' };
}
export function ProgramPanel({ state, who, onView }) {
  const [slots, setSlots] = useState([]);
  const [points, setPoints] = useState([]);
  const [pick, setPick] = useState('');           // 지금 열어 둔 슬롯 이름
  const [newName, setNewName] = useState('');
  const [addPoint, setAddPoint] = useState('');
  const [cursor, setCursor] = useState(0);        // 다음에 실행할 단계
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [loadErr, setLoadErr] = useState(null);   // 못 읽음 ≠ 비어 있음 (감사 2026-08-06 P0)
  const [gripNote, setGripNote] = useState(null); // `grip` 칸 기본값의 **출처** (계약 §grip 칸)
  // `grip` 칸 `pct` 입력의 **로컬 초안** {칸번호: 문자열}.
  // ⚠ 이게 없으면 **숫자를 타이핑할 수 없다** (2026-08-10 실기 담당자 지적). 값이 서버(`slot.steps`)에
  // 매여 있어서 키 하나마다 `saveSlot` → 목록 재로드가 돌고, 그 왕복이 입력칸을 되돌려 놓는다.
  // 그래서 화살표로 1씩 올리는 것 말고는 방법이 없었다. **초안은 로컬에 두고 커밋은 blur·Enter 에서** 한다
  const [gripDraft, setGripDraft] = useState({});
  const [askDelete, setAskDelete] = useState(false);
  const [peek, setPeek] = useState(null);         // 눌러서 들여다보는 스텝 (null=커서 미리보기)
  // 속도는 **슬롯에 저장되지 않는다** — 승인은 「어디를 어떤 순서로」에 대한 것이고, 속도를
  // 굳히면 천천히 한 번 돌려보려고 승인을 다시 받아야 한다 (계약 §속도)
  const [speedPct, setSpeedPct] = useState(SPEED_CAP_PCT);
  const [laps, setLaps] = useState(1);            // 몇 바퀴 (1 = 한 바퀴만)
  const [loop, setLoop] = useState(null);         // 도는 중: { lap, index } · null 이면 안 돎
  // 「그만」을 누른 것을 **다음 단계를 부르기 직전에** 본다. state 는 루프 안에서 옛 값이라
  // 못 쓴다 — ref 여야 이미 돌고 있는 루프가 새 값을 읽는다
  const stopRef = useRef(false);

  const mine = !!who && state.owner === who && datasource.hasOwnerToken();
  const armed = state.phase === 'ARMED' || state.phase === 'EXECUTING';

  // **읽기 실패를 삼키면 화면이 거짓말을 한다** (감사 2026-08-06 P0). 브리지가 못 답해도
  // 예전에는 `[]` 로 남아 "아직 프로그램이 없습니다" 가 떴다 — 실제로는 서버에 멀쩡히 있다.
  const reload = useCallback(async () => {
    try {
      const [ss, ps] = await Promise.all([datasource.getSlots(), datasource.getPoints()]);
      if (!Array.isArray(ss) || !Array.isArray(ps)) throw new Error('브리지가 목록 대신 다른 답을 줬어요');
      setSlots(ss);
      setPoints(ps);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e?.message || String(e));
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const run = async (fn) => {
    setBusy(true);
    try {
      const res = await fn();
      setNote(res?.ok === false ? (res.reasons || [res.reason || '거부됨']).join(' · ') : null);
      await reload();
      return res;
    } catch (e) {
      setNote(`브리지에 닿지 못했습니다: ${e?.message || e}`);
      return { ok: false };
    } finally { setBusy(false); }
  };

  const slot = slots.find((s) => s.name === pick) || null;
  const steps = slot?.steps || [];
  const approved = slot?.status === 'approved';
  const done = cursor >= steps.length;

  // 3D 에 자세를 미리 띄운다 — **누르기 전에 어디로 가는지 본다.** 로봇엔 아무것도 안 보낸다.
  //   · 스텝을 누르면(peek) 그 칸을 본다 — 승인 뒤 지나간 칸도, 목록 아무 칸이나 다시 본다.
  //   · 안 누르고 있으면 preview 가 「다음에 갈 칸(cursor)」을 자동으로 띄운다.
  useEffect(() => {
    const idx = peek != null ? peek : (preview && !done ? cursor : null);
    const st = idx != null && slot ? steps[idx] : null;
    if (st?.type === 'grip') {
      // **손가락만 움직인다.** 팔 자세는 직전 `move` 칸(없으면 지금 실물)을 그대로 쓴다 —
      // 0 자세로 그리면 사람이 "이 칸에서 팔이 여기로 간다" 로 읽는다
      const prev = [...steps.slice(0, idx)].reverse().find((s) => s.type === 'move');
      const base = prev && points.find((x) => x.name === prev.pointName);
      onView({ jointsDeg: base?.jointsDeg ?? state.jointsDeg,
        gripperPct: st.pct,
        label: `${stepLabel(st)} · 손가락만 움직입니다. 팔은 그대로입니다` });
      return;
    }
    const p = st?.pointName && points.find((x) => x.name === st.pointName);
    // 3D 는 손가락까지 그리지만 `move` 칸은 관절만 보낸다 (손가락은 `grip` 칸 몫이다) —
    // 라벨이 그 차이를 말하지 않으면 사람은 손가락도 재생된다고 읽는다
    onView(p ? { jointsDeg: p.jointsDeg, gripperPct: p.gripperPct,
      label: `${p.name} 로 가면 이 자세다. 아직 안 보냈다`
        + (p.gripperPct == null ? '' : ' · 손가락은 안 따라간다') } : null);
  }, [peek, preview, slot, done, cursor, steps, points, state.jointsDeg, onView]);
  useEffect(() => () => onView(null), [onView]);

  // 슬롯을 바꾸거나 단계가 바뀌면 처음으로 — 옛 칸 번호로 엉뚱한 단계를 실행하지 않는다.
  // 삭제 확인도 같이 접는다 — 열어 둔 채로 다른 프로그램을 고르면 엉뚱한 것을 지운다
  useEffect(() => { setCursor(0); setConfirmed(false); setAskDelete(false); setPeek(null); },
    [pick, steps.length, slot?.status]);
  // 출처 문구는 **`steps.length` 에 안 걸린다** — 칸을 꽂는 순간 길이가 늘어나므로 위 효과에
  // 같이 두면 방금 쓴 문구가 그 자리에서 지워진다 (2026-08-10 실렌더가 잡았다).
  // 다른 프로그램으로 옮길 때만 지운다
  useEffect(() => { setGripNote(null); setGripDraft({}); }, [pick]);

  const setSteps = (next) => run(() => datasource.saveSlot(who, slot.name, next));

  // 연속 실행 — **거부 하나면 즉시 전부 멈춘다** (fail-closed · 계약 §연속 실행과 반복).
  // 남은 단계도 남은 회차도 진행하지 않는다. 「한 단계 건너뛰고 계속」 은 없다.
  //
  // `run()` 을 안 쓴다 — 그건 매 호출마다 목록을 다시 읽어 단계 사이에 왕복을 하나 더 끼운다.
  // 여기서는 끝나고 한 번만 읽는다.
  const runAll = async () => {
    stopRef.current = false;
    setNote(null);
    setBusy(true);
    let stoppedBy = null;
    try {
      for (let lap = 0; lap < laps; lap += 1) {
        // 첫 바퀴는 **지금 커서부터** — 3단계에서 멈춰 있었다면 거기서 이어 돈다.
        // 두 바퀴째부터는 처음부터다 (한 바퀴 = 목록 전체).
        for (let i = lap === 0 ? cursor : 0; i < steps.length; i += 1) {
          if (stopRef.current) { stoppedBy = '사람이 「그만」을 눌렀어요.'; break; }
          setLoop({ lap: lap + 1, index: i });
          // await 가 곧 도착이다 — 서버가 정착까지 기다렸다 응답한다 (D89)
          // eslint-disable-next-line no-await-in-loop
          const res = await datasource.slotStep(who, slot.name, i, speedPct);
          if (res?.ok === false) {
            stoppedBy = (res.reasons || [res.reason || '거부됨']).join(' · ');
            break;
          }
          setCursor(i + 1);
        }
        if (stoppedBy) break;
        if (lap + 1 < laps) setCursor(0);       // 다음 바퀴는 1단계부터
      }
    } catch (e) {
      stoppedBy = `브리지에 닿지 못했습니다: ${e?.message || e}`;
    } finally {
      setLoop(null);
      setBusy(false);
      setNote(stoppedBy);
      await reload();
    }
  };

  // 못 누르는 이유를 **문장으로** 돌려준다. null 이면 누를 수 있다.
  const blockedWhy = () => {
    if (!mine) return '조종권을 잡으면 실행할 수 있어요. Live 탭에서 잡으세요.';
    if (!approved) return '먼저 승인하세요. 승인해야 로봇에서 실행돼요.';
    if (!armed) return 'ARM 하면 실행할 수 있어요. Live 탭에서 현장확인 후 ARM 하세요.';
    if (done) return '마지막 단계까지 끝났어요. 처음부터 다시 하려면 아래를 누르세요.';
    return null;
  };
  // **도는 중에는 막힘 안내를 띄우지 않는다.** 마지막 바퀴의 끝 단계에서 cursor 가 잠깐
  // 목록 끝에 닿는데, 그때 안내로 갈아치우면 **「그만」 버튼이 사라진다** — 멈출 방법이
  // 화면에서 없어지는 것이 이 화면에서 제일 나쁜 상태다
  const why = loop ? null : blockedWhy();

  return (
    <div className="program" data-t="program">
      {/* 슬롯을 열면 목록은 접는다 — 아래 상세가 단계·승인·실행을 다 담아 길다. 다른 것을
          고르려면 펴면 되고, 그 선택은 기억된다. **목록이 비었을 때는 접지 않는다** */}
      <Section id="slots-box" title="프로그램" warn={!!loadErr}
        autoFold={!!slot}
        note={loadErr ? '목록을 못 읽었어요'
          : slots.length ? `${slots.length}개${pick ? ` · ${pick} 선택` : ''}` : '아직 없음'}>
        <p className="mm">지점을 순서로 엮고, 승인한 뒤 한 단계씩 실행해요.</p>
        <div className="row">
          <input value={newName} placeholder="이름 (예: 집기시연)" data-t="slot-name"
            onChange={(e) => setNewName(e.target.value)} />
          <button type="button" data-t="slot-create"
            disabled={!mine || busy || !newName.trim() || !points.length}
            onClick={() => run(() => datasource.saveSlot(who, newName.trim(),
              [{ type: 'move', pointName: points[0].name }]))
              .then((r) => { if (r?.ok !== false) { setPick(newName.trim()); setNewName(''); } })}>
            만들기
          </button>
        </div>
        {loadErr && (
          <p className="refusal" data-t="slots-loaderr">
            <b>목록을 못 읽었어요</b> {loadErr} — 프로그램이 없는 게 아니라 <b>확인을 못 했어요.</b>
          </p>
        )}
        {!mine && !loadErr && (
          <p className="hint" data-t="write-blocked">
            조종권을 잡으면 만들고 고칠 수 있습니다. Live 탭에서 잡으세요.
          </p>
        )}
        {!loadErr && !points.length && (
          <p className="mm" data-t="no-points">
            지점이 없습니다. Teach 탭에서 자세를 캡처하면 여기서 순서로 엮을 수 있습니다.
          </p>
        )}
        {!loadErr && !slots.length && points.length > 0 && (
          <p className="empty" data-t="slots-empty">아직 프로그램이 없어요. 이름을 짓고 만드세요.</p>
        )}
        {slots.length > 0 && (
          <ul className="slotlist" data-t="slots">
            {slots.map((s) => (
              <li key={s.name}>
                <button type="button" data-t="slot-row" data-name={s.name}
                  aria-selected={s.name === pick} onClick={() => setPick(s.name)}>
                  {s.name}
                  <span className="mm">{s.status === 'approved' ? '승인됨' : '작성 중'}
                    {' · '}{(s.steps || []).length}단계</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {slot && (
        <section data-t="slot-open">
          <h3>{slot.name}</h3>
          <ol className="steps" data-t="steps">
            {steps.map((st, i) => (
              <li key={i} data-t="step-row" data-index={i} data-type={st.type}
                data-at={String(approved && i === cursor)}>
                {/* 칸 이름을 누르면 그 지점 자세를 3D 로 본다 — 승인 뒤에도 아무 칸이나 다시 본다.
                    로봇은 안 움직인다(미리보기). 다시 누르면 커서 미리보기로 돌아간다.
                    인라인 리셋은 main.css 를 안 건드리려는 것 — .stepname 은 텍스트 스타일뿐이다 */}
                <button type="button" className="stepname" data-t="step-peek"
                  aria-pressed={peek === i} onClick={() => setPeek(peek === i ? null : i)}
                  style={{ background: 'none', border: 0, padding: 0, margin: 0,
                    fontSize: 'inherit', fontFamily: 'inherit', color: 'inherit',
                    textAlign: 'left', cursor: 'pointer',
                    textDecoration: 'underline dotted', textUnderlineOffset: '3px',
                    fontWeight: peek === i ? 700 : 'inherit' }}>
                  {stepLabel(st)}
                </button>
                {approved
                  ? (
                    <span className="stepbtns">
                      <span className="mm">{i < cursor ? '끝남' : i === cursor ? '지금 여기' : ''}</span>
                      {/* **이 칸만 실행** — 계약이 이미 허용한다: 「한 요청이 한 단계고 **화면이
                          몇 번째인지 보낸다**」(D78). 서버는 아무 `index` 나 받으므로 서버 변경 0줄이다.
                          커서를 그 칸 다음으로 옮긴다 — 안 옮기면 「지금 여기」가 방금 실행한 칸과
                          어긋나 화면이 거짓말을 한다.
                          ⚠ **순서를 건너뛰는 책임은 사람에게 있다.** 접근 없이 하강하면 부품을 친다 —
                          다만 게이트(경로 검사 D75·작업영역·26조건)는 매 칸 처음부터 다시 탄다 */}
                      {!loop && !why && (
                        <button type="button" data-t="step-run-one" disabled={busy}
                          title="이 칸만 실행해요. 순서를 건너뛰면 사람이 확인해야 해요"
                          onClick={() => run(() => datasource.slotStep(who, slot.name, i, speedPct))
                            .then((r) => { if (r?.ok !== false) setCursor(i + 1); })}>
                          이 칸만
                        </button>
                      )}
                    </span>
                  )
                  : (
                    /* 순서를 바꾸면 목록이 바뀐 것이므로 승인이 풀린다 — 이미 draft 라
                       달라지는 건 없지만, 규칙은 `saveSlot` 한 곳에만 산다 (계약 §POST /slots) */
                    <span className="stepbtns">
                      {/* `grip` 칸의 폭은 여기서 고친다 — **승인 대상이라** 고치면 승인이 풀린다.
                          0~100 정수만 서버가 받는다 (계약 §grip 칸). 화면이 잘라 주지 않는다 */}
                      {st.type === 'grip' && (
                        <input type="number" data-t="step-grip-pct" min="0" max="100" step="1"
                          value={gripDraft[i] ?? String(st.pct)}
                          disabled={!mine || busy} style={{ width: '4.4em' }}
                          title="0 = 완전히 닫힘 · 100 = 완전히 열림 (벌어짐)"
                          /* 타이핑 중에는 **로컬 초안만** 바꾼다 — 키마다 저장하면 서버 왕복이
                             입력칸을 되돌려 놓아 아예 못 친다 (2026-08-10 정정) */
                          onChange={(e) => setGripDraft({ ...gripDraft, [i]: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                          onBlur={() => {
                            const raw = gripDraft[i];
                            setGripDraft(({ [i]: _, ...rest }) => rest);
                            if (raw === undefined || raw.trim() === '') return;   // 빈 칸은 되돌린다
                            const n = Math.trunc(Number(raw));
                            // **화면이 자르지 않는다** — 범위 밖은 서버가 사유와 함께 거부한다
                            // (자르면 사람이 보낸 값과 저장된 값이 갈린다 · 계약 §grip 칸)
                            if (!Number.isFinite(n) || n === st.pct) return;
                            setSteps(steps.map((x, k) => (k === i ? { type: 'grip', pct: n } : x)));
                          }} />
                      )}
                      {/* **삽입 제스처는 단계 옆에 산다** (계약 §삽입은 단계 옆에서) — 사람이
                          「이 지점 다음에 손을 닫자」고 생각하는 순간은 이 목록을 볼 때다 */}
                      <button type="button" data-t="step-add-grip" title="이 칸 뒤에 손 동작"
                        disabled={!mine || busy}
                        onClick={() => {
                          const seed = gripSeed(st, points, state);
                          setGripNote(`${i + 1}번째 뒤에 손 ${seed.pct}% 를 넣었습니다 · ${seed.from}`);
                          setSteps([...steps.slice(0, i + 1), { type: 'grip', pct: seed.pct },
                            ...steps.slice(i + 1)]);
                        }}>+ 손</button>
                      <button type="button" data-t="step-up" title="위로"
                        disabled={!mine || busy || i === 0}
                        onClick={() => setSteps(swapped(steps, i, i - 1))}>↑</button>
                      <button type="button" data-t="step-down" title="아래로"
                        disabled={!mine || busy || i === steps.length - 1}
                        onClick={() => setSteps(swapped(steps, i, i + 1))}>↓</button>
                      <button type="button" data-t="step-remove" disabled={!mine || busy || steps.length <= 1}
                        onClick={() => setSteps(steps.filter((_, k) => k !== i))}>빼기</button>
                    </span>
                  )}
              </li>
            ))}
          </ol>
          <p className="mm" data-t="step-peek-hint">칸을 누르면 그 자세를 3D 로 봅니다 — 로봇은 안 움직입니다.
            {!approved && ' 중간에 넣으려면 뒤에 넣고 ↑ 로 올리세요.'}</p>
          {/* **기본값의 출처를 적는다** — 자동으로 넣고 말 안 하면 「지점이 그리퍼를
              재생한다」는 오해가 되살아난다 (계약 §grip 칸) */}
          {gripNote && <p className="hint" data-t="grip-seeded">{gripNote}</p>}
          {!approved && steps.some((s) => s.type === 'grip') && (
            <p className="hint" data-t="grip-order-hint">
              <b>집기는 「접근(열림) → 하강 → 닫기 → 상승」 순서예요.</b> 손 동작은 이동에
              딸려 붙지 않는 별도 칸이라, 이동과 같은 칸에서 닫히지 않습니다.
            </p>
          )}

          {!approved && (
            <>
              <div className="row">
                <select value={addPoint} data-t="point-pick"
                  onChange={(e) => setAddPoint(e.target.value)}>
                  <option value="">지점 고르기</option>
                  {points.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
                <button type="button" data-t="step-add" disabled={!mine || busy || !addPoint}
                  onClick={() => setSteps([...steps, { type: 'move', pointName: addPoint }])
                    .then(() => setAddPoint(''))}>
                  뒤에 넣기
                </button>
              </div>
              {steps.length <= 1 && (
                <p className="hint">단계가 하나뿐이라 뺄 수 없어요. 먼저 하나 더 넣으세요.</p>
              )}
              {/* 확인 절차는 한 모양이다 — 체크박스 + 실행 버튼 (계획 §확인 절차) */}
              <label className="confirm" data-t="approve-confirm">
                <input type="checkbox" checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)} />
                승인하면 이 {steps.length}단계가 실기에서 실행됩니다
              </label>
              <button type="button" className="arm" data-t="slot-approve"
                disabled={!mine || busy || !confirmed}
                onClick={() => run(() => datasource.approveSlot(who, slot.name))}>
                승인
              </button>
              {!mine && <p className="hint">조종권을 잡으면 승인할 수 있어요.</p>}
            </>
          )}

          {approved && (
            <>
              {why
                ? <p className="hint" data-t="step-blocked">{why}</p>
                : (
                  <>
                    <div className="row">
                      <SpeedPick value={speedPct} onChange={setSpeedPct} disabled={busy} />
                      <span className="mm">한 번 돌려볼 때는 천천히</span>
                    </div>
                    {loop ? (
                      <>
                        {/* 도는 중에는 **누를 것이 하나뿐**이다 — 멈추는 것. 다른 버튼을
                            같이 두면 사람이 급할 때 무엇을 눌러야 하는지 고른다 */}
                        <button type="button" className="danger" data-t="run-stop"
                          onClick={() => { stopRef.current = true; }}>
                          반복 그만 (지금 단계는 끝까지)
                        </button>
                        <p className="hint" data-t="run-progress">
                          도는 중 — <b>{loop.lap}/{laps}바퀴 · {loop.index + 1}/{steps.length}단계</b>.
                          {' '}「그만」은 <b>루프만</b> 멈춥니다. 지금 나간 단계는 끝까지 갑니다 —
                          {' '}로봇을 즉시 세우려면 위 <b>STOP</b> 입니다.
                        </p>
                      </>
                    ) : (
                      <>
                        <button type="button" className="arm" data-t="step-run" disabled={busy}
                          onClick={() => run(() => datasource.slotStep(who, slot.name, cursor, speedPct))
                            .then((r) => { if (r?.ok !== false) setCursor(cursor + 1); })}>
                          {cursor + 1}단계 실행
                        </button>
                        {/* 반복은 원래 요구사항이다 (UR_07) — 한 단계씩은 없애지 않고 그 옆에 선다 */}
                        <div className="row">
                          <label className="lappick" data-t="run-laps">몇 바퀴
                            <input type="number" min="1" max={MAX_LAPS} value={laps} disabled={busy}
                              onChange={(e) => setLaps(Math.min(MAX_LAPS,
                                Math.max(1, Math.floor(Number(e.target.value) || 1))))} />
                          </label>
                          <button type="button" className="arm" data-t="run-all" disabled={busy}
                            onClick={runAll}>
                            {cursor > 0 ? `${cursor + 1}단계부터 끝까지` : '전체 실행'}
                            {laps > 1 ? ` × ${laps}바퀴` : ''}
                          </button>
                        </div>
                        <p className="hint">
                          누르면 로봇이 실제로 움직입니다. 「{cursor + 1}단계 실행」은 <b>다음 칸</b>,
                          {' '}칸마다 있는 <b>「이 칸만」</b>은 <b>그 칸</b>, 「전체 실행」은
                          {' '}<b>끝까지 이어서</b> 갑니다.
                          {' '}<b>거부가 하나라도 나오면 그 자리에서 전부 멈춰요.</b>
                          {' '}⚠ <b>「이 칸만」으로 순서를 건너뛰면 사람이 책임져요</b> — 접근 없이
                          {' '}하강하면 부품을 칩니다. 게이트는 매 칸 다시 탑니다.
                          {' '}손 칸은 <b>손가락만</b>, 이동 칸은 <b>관절만</b> 움직입니다.
                        </p>
                      </>
                    )}
                  </>
                )}
              <label className="confirm">
                <input type="checkbox" checked={preview}
                  onChange={(e) => setPreview(e.target.checked)} />
                다음에 갈 자세를 3D 로 미리 보기
              </label>
              <div className="row">
                {/* 커서만 되돌린다 — 로봇은 안 움직인다 (서버는 커서를 안 든다 · D78).
                    **버튼 이름이 그 사실을 말해야 한다** — 「1단계로 돌아가기」 만 적으면
                    로봇이 1단계 자세로 간다고 읽힌다. 이 프로젝트에서 제일 비싼 오해가
                    실물과 화면을 헷갈리는 것이다 (감사 2026-08-06 P1) */}
                <button type="button" data-t="cursor-reset" disabled={busy || cursor === 0}
                  onClick={() => setCursor(0)}>세는 자리만 1단계로</button>
                {/* 같은 목록을 다시 저장해 draft 로 되돌린다 — 버튼 이름이 그 일을 말한다.
                    "고치기" 라고 적으면 단계가 바뀐 줄 알고, 승인이 풀린 것을 못 본다 */}
                <button type="button" data-t="slot-unapprove" disabled={!mine || busy}
                  onClick={() => setSteps(steps)}>승인 풀기</button>
              </div>
              <p className="hint">
                「세는 자리만 1단계로」는 <b>로봇을 움직이지 않아요.</b> 화면이 세는 칸만
                처음으로 돌립니다.
              </p>
            </>
          )}

          {/* **확인 없이 지워지고 있었다** (감사 2026-08-06 P0). 지점 삭제는 확인을 붙였는데
              프로그램만 한 번에 사라졌다 — 계획 §확인 절차는 「삭제가 모두 이 형태다」 다.
              `window.confirm` 은 안 쓴다: 브라우저 모달은 실렌더 검증을 그 자리에서 멈춘다 */}
          {askDelete ? (
            <div className="askdelete" data-t="slot-delete-ask">
              <p>{slot.name} 과 그 {steps.length}단계를 지웁니다. 되돌릴 수 없습니다.</p>
              <div className="row">
                <button type="button" data-t="slot-delete-cancel"
                  onClick={() => setAskDelete(false)}>취소</button>
                <button type="button" className="danger" data-t="slot-delete-confirm"
                  disabled={!mine || busy}
                  onClick={() => { setAskDelete(false);
                    run(() => datasource.deleteSlot(who, slot.name)).then(() => setPick('')); }}>
                  지웁니다
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button type="button" data-t="slot-delete" disabled={!mine || busy}
                onClick={() => setAskDelete(true)}>
                이 프로그램 지우기
              </button>
            </div>
          )}
        </section>
      )}

      {note && <p className="refusal" data-t="program-refusal"><b>거부됨</b> {note}</p>}
    </div>
  );
}
