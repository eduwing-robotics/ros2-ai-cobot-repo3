// 손목 뎁스카메라 PiP — 관문(`Vision/bridge/` · D86)이 낸 값을 그린다.
//
// **글로벌 PiP 와 세 가지가 다르다.** 그래서 `CamView` 를 인자로 푸는 대신 옆에 세웠다 —
// 하나로 합치면 두 데이터 경로가 한 컴포넌트 안에서 갈라져 둘 다 읽기 어려워진다.
//
//   ① 그림이 **MJPEG 이 아니라 낱장 JPEG** 이다. 계약 §카메라가 "실시간 경로는 압축 컬러뿐"
//      이라 스트림을 안 만들었다 — 화면이 주기적으로 다시 받는다
//   ② **판정을 화면이 안 한다.** 관문이 `valid`·`validReason` 을 이미 실어 보낸다
//      (계약 §서버가 싣는다). 여기는 `depthState()` 로 **말로 옮기기만** 한다
//   ③ 끊김을 픽셀로 재지 않는다 — 관문이 `lastFrameAt` 을 준다. 잴 수 있는 것을 안 재고
//      추측하지 않는다는 규칙은 같고, 잴 방법만 다르다
//
// **기본은 접힘이다.** 펴면 3D 를 가리고(게이트 상한 10%) 스트림도 하나 더 연다.
// 접혀 있어도 상태는 계속 묻는다 — 접힌 채 벽에 걸린 화면이 조용한 게 제일 나쁘다(2026-08-07).
//
// **크기는 글로벌 PiP 와 같은 값으로 시작하고, 같은 방식으로 끌어 바꾼다** (2026-08-07).
// 크기 다루기는 `usePipSize.js` 로 뺐다 — 창 다루기는 둘이 정말 같아서 합쳐도 안 갈라진다
// (데이터 경로는 위 셋처럼 다르므로 컴포넌트는 안 합친다).
import { useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { depthState } from '@fr5/shared/data/camera/depth-state.js';
import { usePipSize } from './usePipSize.js';
import { PIP_DEFAULT } from './CamView.jsx';

// 상태 폴링 — 깊이 유효는 팔이 움직이면 바뀐다. 폰 설정(15초)보다 자주 본다
const STATE_MS = 2000;
// **마감시각을 건다.** 없는 주소로 `fetch` 하면 OS 타임아웃까지 매달리는데 그동안 화면은
// "아직 안 물어봄"(조용함)에 머문다 — `CamView` 의 `STATUS_TIMEOUT_MS` 와 같은 함정이다
const TIMEOUT_MS = 1500;
// 미리보기 갱신. 30fps 를 다 받을 이유가 없다 — 사람이 "지금 뭘 보나" 를 알면 된다
const SHOT_MS = 500;
const OPEN_KEY = 'fr5.depthOpen';
const SIZE_KEY = 'fr5.depthSize';
// **기본이 접힘이다** — 글로벌 PiP(기본 펴짐)와 반대다. 값이 없으면 접는다
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const writeOpen = (v) => { try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* 프라이빗 모드 */ } };

export function DepthView({ handEye = undefined }) {
  const [open, setOpen] = useState(readOpen);
  // `undefined`=안 물어봄 · `null`=물어봤는데 못 읽음(경고) · 객체=읽음. 셋을 가른다
  const [state, setState] = useState(undefined);
  const [shot, setShot] = useState(null);   // 다 받아 놓은 미리보기 URL. null=아직
  // 기본 크기를 글로벌과 **같은 값**으로 둔다 — 둘이 나란히 서므로 폭이 다르면 어긋나 보인다
  // 비율은 **관문이 내는 해상도**가 정한다 (D148) — 여기는 겹치기가 아니지만 같은 규칙을
  // 쓴다: 칸이 납작해지면 `contain` 이 영상을 줄여 사람이 「카메라가 이상하다」로 읽는다.
  // 근접에서 424×240 으로 갈아타도(계약 §근접 해상도) 그 비율이 그대로 온다
  const dres = String(state?.depth?.resolution ?? '').match(/^(\d+)x(\d+)$/);
  const pip = usePipSize({ key: SIZE_KEY, defaultSize: PIP_DEFAULT,
    aspect: dres ? Number(dres[1]) / Number(dres[2]) : null });
  const seenAt = useRef(null);          // 마지막으로 **새 프레임 시각을 본** 때 (성능시계)
  const lastFrame = useRef(null);       // 그때의 `lastFrameAt`

  // ── 손목 변환은 **관문이 아니라 로봇 프로필**이 답한다 (2026-08-27 · D145).
  // 관문의 `/api/camera/info` 를 안 묻는다 — `calibId` 는 장치 동일성이라 이 판정에 못 쓰고,
  // 그 값을 쓸 주인(시연 녹화)은 아직 없다. **소비자 없는 fetch 를 남겨 두지 않는다.**
  // 프로필 값은 `main.jsx` 가 `/state` 에서 받아 내려 준다 — `CamView` 의 `workspace` 와 같다.

  const url = datasource.depthStateUrl();
  useEffect(() => {
    if (!url) { setState(undefined); return undefined; }
    let dead = false;
    const read = async () => {
      try {
        const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
        const j = await r.json();
        if (dead) return;
        // **프레임이 실제로 새 것인지는 `lastFrameAt` 이 바뀌는지로 본다.** 관문이 살아서
        // 200 을 주는 것과 카메라가 프레임을 주는 것은 다른 일이다
        if (j?.lastFrameAt !== lastFrame.current) {
          lastFrame.current = j?.lastFrameAt ?? null;
          seenAt.current = performance.now();
        }
        setState(j ?? null);
      } catch {
        if (!dead) setState(null);       // 막혔든 무응답이든 **모르는 것은 모르는 것**이다
      }
    };
    read();
    const id = setInterval(read, STATE_MS);
    return () => { dead = true; clearInterval(id); };
  }, [url]);

  // 그림은 **펼쳤을 때만** 받는다 — 접힌 창 때문에 대역을 쓰지 않는다.
  // 상태 폴링과 달리 이건 안 봐도 잃는 정보가 없다.
  //
  // **보이는 `<img>` 의 `src` 를 직접 갈지 않는다** (2026-08-07 실렌더에서 잡았다).
  // 갈아 끼우면 브라우저가 새 그림을 받는 동안 **칸을 비운다** — 0.5초마다 깜빡이고,
  // 게이트가 그 순간을 읽으면 `naturalWidth 0` 이 나온다. 안 보이는 `Image` 로 먼저 받고
  // **다 받은 뒤에야** 보이는 쪽에 넘긴다. 그때는 캐시에 있어 즉시 바뀐다.
  //
  // 다음 장을 **다 받은 뒤에 예약**하는 것도 요점이다 — `setInterval` 이면 링크가 느릴 때
  // 요청이 쌓인다. 못 받으면 간격을 벌린다 (죽은 주소에 매달리지 않는다).
  const previewUrl = datasource.depthPreviewUrl();
  useEffect(() => {
    if (!open || !previewUrl) return undefined;
    let dead = false;
    let timer = null;
    const tick = () => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const next = (ms) => { if (!dead) timer = setTimeout(tick, ms); };
      img.onload = () => { if (!dead) { setShot(img.src); next(SHOT_MS); } };
      img.onerror = () => next(SHOT_MS * 4);
      img.src = `${previewUrl}?_=${Date.now()}`;
    };
    tick();
    return () => { dead = true; clearTimeout(timer); };
  }, [open, previewUrl]);

  if (!url) return null;   // 주소가 없으면 기능을 안 켠 것이다 — 빈 상자를 띄우지 않는다

  const toggle = () => { const v = !open; setOpen(v); writeOpen(v); };
  const ageMs = seenAt.current === null ? null : performance.now() - seenAt.current;
  const rows = depthState({ state, ageMs, handEye });
  const link = rows.find((r) => r.key === 'link');
  const hud = rows.filter((r) => r.key !== 'link');
  // 접었을 때도 경고는 보여야 한다 — 띠는 펴야 보이므로 머리띠 색으로 올린다
  const warn = rows.some((r) => r.tone === 'warn');

  return (
    <div className="camview depthview" data-t="depthview"
      data-open={String(open)} data-warn={String(warn)} style={pip.style(open)}>
      <div className="camhead">
        {/* 실물·3D·글로벌캠을 헷갈리는 것이 이 프로젝트에서 가장 비싼 오해다 (SR_24).
            손목 것임을 라벨이 말한다 — "카메라" 만 쓰면 폰과 구분이 안 된다 */}
        <b>손목 깊이</b>
        {/* 주소를 같이 찍는다 — CamView 가 이미 「영상 없음만 띄우면 못 고친다」로 처방한 것(UX 감사 2026-09-05) */}
        <span className="camstat" data-t="depth-stat" data-tone={link.tone}>
          {link.label}{datasource.depthHost?.() ? ` · ${datasource.depthHost()}` : ''}</span>
        <button type="button" className="camtoggle" data-t="depth-toggle"
          title={open ? '접기' : '펴기'} onClick={toggle}>{open ? '▾' : '▸'}</button>
      </div>
      {open && (
        <div className="camhud" data-t="depth-hud">
          {hud.map((r) => (
            <span key={r.key} data-t={`depth-hud-${r.key}`} data-tone={r.tone}>{r.label}</span>
          ))}
        </div>
      )}
      {open && (
        <div className="cambody">
          {/* `crossOrigin` 은 나중에 캔버스로 뭘 재게 될 때를 위한 것이다 — 관문이
              `ACAO: *` 를 주는 것은 실렌더로 확인했다 (`cam-bridge-verify` 9/9).
              `src` 는 **이미 다 받아 놓은 것**이라 바뀌어도 칸이 안 비워진다 (위 §이중 버퍼) */}
          {shot && <img data-t="depth-img" alt="손목 뎁스카메라"
            crossOrigin="anonymous" src={shot} />}
          {!shot && <p className="camwait" data-t="depth-wait">첫 장 기다리는 중…</p>}
        </div>
      )}
      {/* 접었거나 폰이면 핸들을 안 낸다 — 훅이 판정한다 (감사 2026-08-06 P2) */}
      {pip.canResize(open) && (
        <div className="camresize" data-t="depth-resize"
          onMouseDown={pip.startResize} onTouchStart={pip.startResize}
          title="드래그해서 크기 조절" />
      )}
    </div>
  );
}
