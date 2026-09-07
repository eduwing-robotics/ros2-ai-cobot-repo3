// 터틀봇 라이브 로그 — 「터틀봇」 탭 하단. source 별 색 + 필터 칩 (TB-CONTRACT §로그).
// 옛 터틀봇 웹앱의 `logs/LogPanel.jsx`(퇴역 · D182). **기본은 접힘** — 340px 패널 안에서
// 로그가 펼쳐지면 조종·경로 칸이 밀린다. 사람이 펼치면 기억한다.
import { useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';

const SOURCES = ['전체', 'slot', 'nav', 'rosout', 'bridge'];
const KEY = 'fr5-tb-log-open';

export function LogPanel() {
  const [lines, setLines] = useState([]);
  const [filter, setFilter] = useState('전체');
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } });
  const bodyRef = useRef(null);

  useEffect(() => datasource.tb.subscribeLogs((entry) =>
    setLines((prev) => [...prev.slice(-499), entry])), []);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;   // 자동 스크롤
  }, [lines, filter, open]);

  const shown = filter === '전체' ? lines : lines.filter((l) => l.source === filter);
  const toggle = () => {
    const v = !open; setOpen(v);
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* 편의라 조용히 */ }
  };

  return (
    <section className="logpanel" data-t="tb-log">
      <div className="logpanel-head">
        <button type="button" className="chip" onClick={toggle}
                title="펼치면 로그 500줄이 보여요">{open ? '▾' : '▸'}</button>
        <h3>라이브 로그</h3>
        {open && SOURCES.map((s) => (
          <button key={s} type="button" className="chip" aria-selected={filter === s}
                  onClick={() => setFilter(s)}>{s}</button>
        ))}
        <span className="logpanel-note">
          {open ? '최근 500줄' : `접힘 · ${lines.length}줄`}</span>
      </div>
      {open && <div className="logpanel-body" ref={bodyRef}>
        {shown.map((l, i) => (
          <div key={i} className="logline">
            <span className="log-t">{new Date(l.t * 1000).toLocaleTimeString('ko-KR', { hour12: false })}</span>
            <span className="log-robot">{l.robot}</span>
            <span className={`log-src src-${l.source}`}>{l.source}</span>
            <span className={l.level === 'warn' ? 'log-warn' : ''}>{l.line}</span>
          </div>
        ))}
      </div>}
    </section>
  );
}
