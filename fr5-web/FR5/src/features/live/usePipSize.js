// PiP 크기 — 끌어서 바꾸고 기억한다. **글로벌·뎁스가 같은 것을 쓴다.**
//
// `CamView` 에만 있던 것을 뺐다 (2026-08-07). 뎁스 PiP 가 생기면서 같은 40줄이 두 벌이 될
// 참이었는데, 이건 데이터 경로가 아니라 **창 다루기**라 둘이 정말 같다 — 컴포넌트를 합치는
// 것과 다르다(그쪽은 MJPEG ↔ 낱장이라 갈라져야 한다).
//
// 여기서 지키는 함정 둘 —
//  ① **인라인 style 은 미디어쿼리를 항상 이긴다** (감사 2026-08-06 P1). CSS 가 폰에서 폭을
//     줄이려 해도 `style={{width}}` 가 늘 덮어써서, 저장된 데스크톱 크기가 폰에서 그대로 떠
//     3D 를 절반 넘게 가렸다. **좁으면 인라인을 안 준다**
//  ② **접었을 때는 핸들을 안 낸다** (감사 2026-08-06 P2). 접히면 크기가 `auto` 라 끌어도
//     화면은 그대로인데 값만 저장돼, 다시 펴면 엉뚱한 크기가 나왔다
//  ③ ⛔ **겹치는 칸은 비율을 강제한다** (2026-08-27 · D148). 영상은 `object-fit: contain` 이라
//     칸이 카메라 비율과 다르면 **안쪽으로 줄고 여백**이 생기는데, 그 위에 얹는 3D 캔버스는
//     칸 전체를 쓴다 — 둘이 다른 크기에 같은 장면을 그린다. 실측 2026-08-27: 칸이 298×82 로
//     납작해져 영상은 **146px** 폭, 3D 는 **298px** 폭 → **가로 2배** 어긋났다. 실기 담당자가
//     「맥에서는 맞는데 윈도우에서는 안 맞는다」로 잡으셨고, 차이는 **그 브라우저에 저장된
//     PiP 크기** 하나였다. 그래서 `aspect` 를 주면 **드래그가 폭만 받고** 높이는 CSS 가
//     비율로 유도한다 — 납작해질 수가 없다.
//  ④ ⛔ **위쪽으로도 자른다** (2026-08-28 실측). 여태 `minW`·`minH` 만 걸려 있어 저장값이
//     **얼마든지 커질 수 있었다.** 인라인 폭은 `flex:none` 이라 줄이 안 줄고, 줄이 창보다
//     넓어지면 오른쪽 조작 패널(`.side` 340px)이 **화면 밖으로 밀려난다** — 윈도우 2560px
//     화면에서 Live·Teach·주행 탭이 통째로 사라졌고, 같은 페이지가 맥에서는 멀쩡했다.
//     차이는 그 브라우저에 저장된 PiP 폭 하나였다(함정 ③ 과 같은 병, 반대 방향).
//     **천장은 창 크기에 비례한다** — 창이 줄면 저장값을 안 고치고도 그때그때 잘린다.
import { useEffect, useRef, useState } from 'react';

const NARROW = '(max-width: 760px)';

// ponytail: 천장을 **실제 칸이 아니라 창** 기준으로 잰다. 칸을 재려면 ref 와 ResizeObserver 가
// 필요한데, 여기서 막아야 할 것은 「줄이 창보다 넓어지는 것」 하나뿐이라 창이면 충분하다.
// 한계: 3D 칸이 창보다 훨씬 좁은 배치가 생기면 이 천장은 느슨해진다 — 그때 칸 기준으로 올린다.
const MAX_FRAC_W = 0.45;   // 오른쪽 패널 340px + 여백을 항상 남긴다
const MAX_FRAC_H = 0.6;

export function usePipSize({ key, defaultSize, minW = 160, minH = 116, aspect = null }) {
  const capW = () => (typeof window === 'undefined' ? Infinity
    : Math.max(minW, Math.round(window.innerWidth * MAX_FRAC_W)));
  const capH = () => (typeof window === 'undefined' ? Infinity
    : Math.max(minH, Math.round(window.innerHeight * MAX_FRAC_H)));

  const read = () => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return defaultSize;
      const p = JSON.parse(raw);
      return {
        width: Math.min(capW(), Math.max(minW, Number(p.width) || defaultSize.width)),
        height: Math.min(capH(), Math.max(minH, Number(p.height) || defaultSize.height)),
      };
    } catch {
      return defaultSize;
    }
  };
  const write = (s) => { try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* 프라이빗 모드 */ } };

  const [size, setSize] = useState(read);
  const [narrow, setNarrow] = useState(
    () => (typeof matchMedia === 'function' ? matchMedia(NARROW).matches : false));
  const resizing = useRef(null);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(NARROW);
    const on = (e) => setNarrow(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // 창이 바뀌면 다시 그린다 — `style()` 의 천장이 옛 창 기준으로 굳으면 함정 ④ 가 되돌아온다
  const [, bump] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const on = () => bump((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const startResize = (e) => {
    e.preventDefault();
    resizing.current = {
      startX: e.clientX ?? e.touches?.[0]?.clientX,
      startY: e.clientY ?? e.touches?.[0]?.clientY,
      startW: size.width,
      startH: size.height,
      lastSize: size,
    };
    const move = (ev) => {
      const r = resizing.current;
      if (!r) return;
      const cx = ev.clientX ?? ev.touches?.[0]?.clientX;
      const cy = ev.clientY ?? ev.touches?.[0]?.clientY;
      const next = {
        width: Math.min(capW(), Math.max(minW, Math.round(r.startW + (cx - r.startX)))),
        // 비율 강제면 **세로 입력을 버린다** — 받으면 그만큼 레터박스가 생긴다 (함정 ③)
        height: aspect ? r.startH
          : Math.min(capH(), Math.max(minH, Math.round(r.startH + (cy - r.startY)))),
      };
      r.lastSize = next;
      setSize(next);
    };
    const up = () => {
      if (resizing.current) write(resizing.current.lastSize);
      resizing.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', move);
    window.addEventListener('touchend', up);
  };

  /** 펴져 있고 넓은 화면일 때만 인라인으로 준다 (위 함정 ①)
   *
   * `aspect` 가 있으면 **높이를 안 준다** (함정 ③) — 영상칸이 CSS `aspect-ratio` 로 유도되고
   * 카드 높이는 내용이 정한다. 저장된 높이는 그대로 두되 **안 쓴다**(옛 값이 남아 있어도 무해).
   */
  const style = (open) => {
    if (!open || narrow) return undefined;
    // **낼 때 다시 자른다** — 저장값은 그대로 두고 지금 창에 맞춰 준다 (함정 ④).
    // 창을 줄였다 늘이면 원래 크기로 돌아온다.
    return aspect
      ? { width: Math.min(size.width, capW()), '--pip-ar': String(aspect) }
      : { width: Math.min(size.width, capW()), height: Math.min(size.height, capH()) };
  };
  /** 접었거나 폰이면 핸들을 안 낸다 (위 함정 ②) */
  const canResize = (open) => open && !narrow;

  return { size, narrow, startResize, style, canResize };
}
