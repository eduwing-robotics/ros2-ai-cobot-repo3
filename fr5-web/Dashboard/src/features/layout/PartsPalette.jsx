// 부품 팔레트 — 좌측 패널. **고르면 방 가운데 놓인다.**
//
// 목록을 여기서 만들지 않는다 — `Shared/data/layout/catalog.js` 가 SSOT 다.
// 그래야 부품을 더해도 이 파일을 안 고친다 (codegate `PartsPalette` 와 같은 규약).
//
// **끌어다 놓을 수 있다** (2026-08-04). 눌러서 놓으면 방 가운데, **끌어다 놓으면 그 자리**다.
//
// 전에는 "배치 모드라는 상태가 하나 더 생긴다" 는 이유로 안 했는데, 그건 *클릭 후 조준*
// 방식의 이야기였다. HTML5 끌어놓기는 **브라우저가 그 상태를 들고 있어서** 우리 쪽에
// 모드가 안 생긴다 — 끌기가 끝나면 흔적도 안 남는다.

import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, VISIBLE, cardKey, kindOf } from '@fr5/shared/data/layout/catalog.js';
import { thumbFor, disposeThumbs } from '@fr5/shared/view3d/thumb.js';

const MOUNT_BADGE = { wall: '벽', bench: '작업대 위' };
// **자리는 소품이 아니다** — 배지로 갈라 준다. 시나리오가 이 이름으로 부른다
const KIND_BADGE = { station: '자리' };
// 문·창은 팩토리가 없어 구울 것이 없다 — 대신 납작한 기호를 그린다
const OPENING_ICON = { door: '▯', window: '▭', station: '◎' };
// 시나리오 어휘는 부품 탭에 안 뜬다 — 분류 id 로 가른다
const SCENARIO_CATS = new Set(['spot']);

/**
 * 좌측 패널 — **부품과 시나리오는 다른 것이다.**
 *
 * 전에는 한 목록에 섞여 있었다. `작업 지점 ①~⑥` 은 부품이 아니라 **시나리오가 이름으로
 * 부르는 어휘**인데 소품 옆에 있으니, 경로를 그린 다음 "이걸 어디에 넣지" 가 나왔다
 * (실기 담당자 지적 · 2026-08-04). 탭으로 가른다.
 *
 * **사건은 여기서도 고친다.** 타임라인 마커 우클릭과 **같은 문**(`onSetEvent`)을 쓰므로
 * 정본이 둘이 되지 않는다 — 보여주는 자리만 둘이다.
 */
export function PartsPalette({
  onPlace, count,
  series = [], stations = [], amrs = [], cycleSec = 0,
  onSetEvent, onRemoveEvent, onAddEvent, onSeek,
  // **탭은 밖에서도 바꾼다** — 경로 편집을 끝내면 화면이 시나리오 탭으로 데려간다.
  // 안에만 두면 "이제 뭘 하지" 를 사람이 스스로 알아내야 한다 (2026-08-04 · 세 번 물으셨다).
  tab = 'part', onTab, highlightEvent = null,
}) {
  const setTab = onTab ?? (() => {});
  const [q, setQ] = useState('');

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return VISIBLE;
    return VISIBLE.filter((c) => c.label.toLowerCase().includes(s)
      || c.id.toLowerCase().includes(s)
      || (c.hint ?? '').toLowerCase().includes(s));
  }, [q]);

  // 썸네일은 **한 번만 굽는다.** 목록이 뜬 뒤 비동기로 채워 첫 렌더를 안 막는다 —
  // 부품 17종을 동기로 구우면 팔레트가 그만큼 늦게 뜬다.
  const [thumbs, setThumbs] = useState({});
  useEffect(() => {
    let alive = true;
    const id = requestAnimationFrame(() => {
      const next = {};
      for (const c of VISIBLE) {
        if (kindOf(c) !== 'prop') continue;
        next[cardKey(c)] = thumbFor(c.id, c.opts ?? {}, 96);
      }
      if (alive) setThumbs(next);
    });
    return () => { alive = false; cancelAnimationFrame(id); disposeThumbs(); };
  }, []);

  return (
    <aside className="palette">
      <div className="palette-tabs" role="tablist">
        <button
          type="button" role="tab" data-t="tab-part"
          className={tab === 'part' ? 'on' : ''} onClick={() => setTab('part')}
        >부품
        </button>
        <button
          type="button" role="tab" data-t="tab-scenario"
          className={tab === 'scenario' ? 'on' : ''} onClick={() => setTab('scenario')}
        >시나리오
        </button>
      </div>

      <div className="palette-head">
        {tab === 'part' ? (
          <>
            <p>고르면 방 가운데 놓여요. 끌어서 옮기고 <kbd>R</kbd> 로 돌려요.</p>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="부품 검색…"
              aria-label="부품 검색"
            />
          </>
        ) : (
          <p>
            <b>자리</b>를 놓고, <b>사건</b>이 그 자리를 부릅니다.
            AMR 은 사건에 붙여야 움직여요 — 경로는 AMR 이 듭니다.
          </p>
        )}
      </div>

      <div className="palette-list">
        {/* ── 시나리오 탭. **자리를 놓고 사건이 그 자리를 부른다** */}
        {tab === 'scenario' && (
          <section data-t="scn-events">
            <h4>사건 — {series.length}개 · {cycleSec}초</h4>
            {!series.length && <p className="palette-note">재생할 사이클이 없어요</p>}
            {series.map((e, i) => (
              <div
                className={`scn-row${highlightEvent === i ? ' hot' : ''}`}
                key={`${i}-${e.tSec}`} data-t="scn-row"
              >
                <input
                  type="number" className="scn-t" min="0" step="0.5" value={e.tSec}
                  aria-label="시각" data-t="scn-t"
                  onChange={(ev) => onSetEvent?.(i, { tSec: Math.max(0, Number(ev.target.value) || 0) })}
                />
                <input
                  type="text" className="scn-name" value={e.event ?? ''}
                  aria-label="사건 이름" data-t="scn-name"
                  onChange={(ev) => onSetEvent?.(i, { event: ev.target.value })}
                />
                <select
                  value={e.station ?? ''} aria-label="자리" data-t="scn-st"
                  onChange={(ev) => onSetEvent?.(i, { station: ev.target.value })}
                >
                  <option value="">자리 —</option>
                  {stations.map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}</option>)}
                </select>
                <select
                  value={e.amr ?? ''} aria-label="AMR" data-t="scn-amr"
                  onChange={(ev) => onSetEvent?.(i, ev.target.value
                    ? { amr: ev.target.value, amrAt: e.amrAt ?? e.station ?? stations[0]?.id }
                    : { amr: '', amrAt: '' })}
                >
                  <option value="">AMR —</option>
                  {amrs.map((a2) => <option key={a2.id} value={a2.id}>{a2.id}</option>)}
                </select>
                {/* 그 시각으로 감는다 — 고치기 전에 무엇이 벌어지는지 보게 */}
                <button type="button" title="그 시각으로" data-t="scn-seek"
                  onClick={() => onSeek?.(e.tSec)}
                >▶
                </button>
                {/* **마지막 하나는 안 지운다** — 사건이 0 개면 사이클이 0 초라 재생이 사라진다 */}
                <button type="button" title="삭제" data-t="scn-del"
                  disabled={series.length <= 1} onClick={() => onRemoveEvent?.(i)}
                >✕
                </button>
              </div>
            ))}
            <button type="button" className="scn-add" data-t="scn-add"
              // **끝에 붙인다.** `cycleSec` 을 그대로 주면 마지막 사건과 같은 시각에 쌓여
              // 눌러도 아무 일이 안 일어난 것처럼 보인다 (빈 시나리오에서는 0,0 이 됐다).
              onClick={() => onAddEvent?.(cycleSec + 5)}
            >+ 사건 추가
            </button>
          </section>
        )}

        {CATEGORIES.map(({ id, label, note }) => {
          // **탭이 분류를 가른다** — 자리는 시나리오 어휘라 부품 탭에 안 뜬다
          if ((tab === 'scenario') !== SCENARIO_CATS.has(id)) return null;
          const items = hits.filter((c) => c.category === id);
          if (!items.length) return null;           // 빈 분류는 숨긴다
          return (
            <section key={id}>
              <h4>{label}</h4>
              {/* 분류마다 한 줄 안내 — **어디에 놓나**가 안 적혀 있어 헤맸다 (2026-08-04) */}
              {note && <p className="palette-note">{note}</p>}
              {items.map((c) => (
                <button
                  key={cardKey(c)}
                  type="button"
                  className="part-card"
                  onClick={() => onPlace(c)}
                  draggable
                  onDragStart={(e) => {
                    // 카드 **객체**를 못 실으므로 키만 싣고 받는 쪽이 카탈로그에서 찾는다
                    e.dataTransfer.setData('text/fr5-card', cardKey(c));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={c.hint ?? c.label}
                >
                  <span className="part-thumb" aria-hidden="true">
                    {thumbs[cardKey(c)]
                      ? <img src={thumbs[cardKey(c)]} alt="" />
                      : <i>{OPENING_ICON[kindOf(c)] ?? ''}</i>}
                  </span>
                  <span className="part-text">
                    <span className="part-name">{c.label}</span>
                    {(KIND_BADGE[kindOf(c)] ?? MOUNT_BADGE[c.mount])
                      && <span className="part-badge">{KIND_BADGE[kindOf(c)] ?? MOUNT_BADGE[c.mount]}</span>}
                    {c.hint && <span className="part-hint">{c.hint}</span>}
                  </span>
                </button>
              ))}
            </section>
          );
        })}
        {tab === 'part' && hits.length === 0 && <p className="palette-empty">“{q}” 검색 결과 없음</p>}
      </div>

      <div className="palette-foot">
        <span>놓인 것 {count}개 · 고르고 <kbd>Del</kbd> 로 치워요</span>
      </div>
    </aside>
  );
}

