// 오른쪽 패널의 접히는 섹션 — 규약 정본은 계획 §오른쪽 패널은 접힌다 (2026-08-10).
//
// **자리가 남아서 접는 게 아니다. 모자라서 접는다** — 실측(뷰포트 1454×728 · Teach):
// 내용 751px 에 준 자리 514px 로 **237px 넘쳤고**, 마지막 줄은 스크롤 전까지 화면 밖
// 221px 에 있었다. `grip` 칸 UI 가 들어오면 더 넘친다.
//
// `CamView`·`DepthView` 의 `data-open` + `▾/▸` 관용구를 그대로 쓴다 — 접힘 방식을 새로
// 만들지 않는다. **단 한 가지가 다르다:**
//
// ⚠ **접혀도 DOM 에서 지우지 않는다.** CamView 는 `{open && …}` 로 언마운트하지만 패널
// 섹션 안에는 게이트가 누르는 버튼이 산다 — `fr5-web-verify.mjs` 가 `element.click()` 을
// **59곳**에서 부른다. 언마운트하면 그 59개가 통째로 빨개진다. 숨기는 것은 CSS 이고,
// 프로그램적 `.click()` 은 `display:none` 에서도 발화한다 (좌표 클릭이 아니라서 성립한다).
import { useState } from 'react';

// 사람이 접은 것은 기억한다 — 매번 다시 접게 만들면 접힘이 짐이 된다
const KEY = 'fr5-panel-open';

function readChoices() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }   // 사파리 프라이빗·용량초과 — 접힘은 편의라 조용히 기본값으로 간다
}

/** 접히는 섹션.
 *
 * @param id       `data-t` 가 된다. 게이트가 이 이름으로 찾는다
 * @param title    머리 제목 (`h3`)
 * @param note     제목 옆 한 줄. **접혀도 보인다** — 접힌 섹션이 무엇인지 말하는 자리다
 * @param warn     참이면 머리에 `!` 를 올린다. 접힘이 경고를 삼키지 않게 하는 유일한 장치
 * @param autoFold **지금 할 수 없는 일**이면 참 (조종권 없는 쓰기 · 연결 뒤 진단 · 관절표).
 *                 목록이 비었다고 참을 주지 않는다 — 빈 목록은 가장 보여줘야 할 상태다
 */
export function Section({ id, title, note, warn = false, autoFold = false,
  className = '', children }) {
  // `undefined` = 사람이 아직 안 정했다. 그때만 자동 규칙이 말한다 — **사람 결정이 이긴다**
  const [choice, setChoice] = useState(() => readChoices()[id]);
  const open = choice ?? !autoFold;

  const toggle = () => {
    const next = !open;
    setChoice(next);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...readChoices(), [id]: next }));
    } catch { /* 못 써도 이번 세션은 접힌 채로 돈다 */ }
  };

  return (
    <section className={`foldsec ${className}`.trim()}
      data-t={id} data-open={String(open)} data-warn={String(warn)}>
      <div className="foldhead">
        <h3>{title}</h3>
        {/* 접힌 섹션이 스스로 무엇인지 말한다 — 제목만 남으면 왜 접혔는지 모른다 */}
        {note && <span className="foldnote" data-t={`${id}-note`}>{note}</span>}
        {/* 접혀도 경고는 보여야 한다 — 접힌 채 조용한 화면이 제일 나쁘다 (CamView 와 같은 이유) */}
        {warn && <span className="foldwarn" aria-hidden="true">!</span>}
        <button type="button" className="foldtoggle" data-t={`${id}-toggle`}
          aria-expanded={open} title={open ? '접기' : '펴기'}
          onClick={toggle}>{open ? '▾' : '▸'}</button>
      </div>
      {/* **항상 렌더한다** — 위 ⚠ 참고. 숨기는 것은 `.foldsec[data-open="false"] .foldbody` 다 */}
      <div className="foldbody">{children}</div>
    </section>
  );
}
