// 손목 D435 관문 실기 검증 — **하드웨어가 있어야 돈다. `all.sh` 에 안 넣는다**
// (`fr5-cam-verify`·`tb-*` 와 같은 자리 — 장비 없는 날마다 빨간불이면 게이트가 죽는다).
//
// 여기서만 볼 수 있는 것이 있다: **CORS 는 `curl` 로 못 잡는다.** `curl` 은 헤더를 보여줄 뿐
// 강제하지 않는다 — 막히는 것은 브라우저뿐이고, 그래서 브라우저로 봐야 한다.
// FR5 화면은 `:5055` 에서 오고 관문은 `:5058` 이라 **같은 기계인데도 남의 출처**다.
// 2026-08-06 에 폰 `status.json` 에서 이 함정을 밟았다.
//
// 실행: node scripts/check/cam-bridge-verify.mjs  (기본 호스트 192.168.30.240)
import { openPage } from './lib/cdp-harness.mjs';

const HOST = process.env.CAM_HOST ?? '192.168.30.240';
const ORIGIN = `http://${HOST}:5055`;         // FR5 화면이 오는 곳
const CAM = `http://${HOST}:5058`;            // 관문
const THRESHOLD_SRC = 'evidence/2026-08-05/cam-fov.md §높이 스윕';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

let p = null;
try {
  // ── 0. 서버에서 본 값 (브라우저 밖) — 브라우저에서 본 것과 대조하려고 먼저 받는다
  const direct = await fetch(`${CAM}/api/camera/state`).then((r) => r.json());
  check('관문이 응답한다', direct.connected === true, `usb ${direct.usb}`);
  check('USB3 다 — 480Mbps 면 근접 424x240 이 사라진다', direct.usb?.startsWith('3'), direct.usb);

  // **캐시를 깬다.** 프로필이 남아 있으면 브라우저가 **옛 `index.html`** 을 꺼내 쓰고, 그러면
  // 방금 배포한 코드가 아니라 **지난번 코드**를 판정한다 — 2026-08-07 에 여기서 밟았다.
  // 번들 해시가 배포본과 달랐는데(`index-BaalZV6j` vs `index-kScYSitO`) 화면 에러처럼 보였다.
  // D85 가 vite 포트에서 잡은 것과 **같은 죄**다: 고친 코드가 아니라 켜 둔 코드를 판정한다.
  p = await openPage(`${ORIGIN}/?_=${Date.now()}`, { port: 9361, windowSize: '1280,900' });
  await p.waitFor('document.readyState === "complete"');

  // ── 1. **CORS** — 남의 출처에서 fetch. 막히면 여기서 TypeError 가 난다
  //
  // **두 번 해 본다.** 진짜 CORS 차단은 매번 똑같이 막히고, 순간적인 연결 실패는 다음 판에
  // 붙는다 — 둘을 가르려고 재시도한다. 재시도로 초록이 되는 게이트는 위험하지만, 여기서
  // 가리는 대상(브라우저 정책)은 **간헐적일 수가 없다**. 2026-08-07 에 떠 있던 검증용 Chrome
  // 고아 2대가 관문을 2초마다 두드려 이 검사만 흔들렸다 (`p.close()` 는 SIGTERM 이라 남는다).
  const corsOnce = () => p.eval(`(async () => {
    try {
      const r = await fetch('${CAM}/api/camera/state', { cache: 'no-store' });
      const j = await r.json();
      return { ok: true, connected: j.connected, valid: j.depth.valid,
               reason: j.depth.validReason, center: j.depth.validRatioCenter };
    } catch (e) { return { ok: false, err: String(e) }; }
  })()`);
  let cors = await corsOnce();
  if (!cors?.ok) { await new Promise((r) => setTimeout(r, 1000)); cors = await corsOnce(); }
  check('FR5 출처(:5055)에서 관문(:5058)을 읽는다 — CORS', cors?.ok, cors?.err ?? 'fetch OK');
  check('브라우저가 본 값이 서버가 낸 값과 같다',
    cors?.ok && cors.connected === direct.connected, `${cors.connected} vs ${direct.connected}`);

  // ── 2. 미리보기가 `<img>` 로 뜬다
  const img = await p.eval(`(() => new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ ok: true, w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => res({ ok: false, err: 'onerror' });
    // 마감시각을 건다 — 프로미스가 안 끝나면 CDP 가 값 없이 돌아오고, 그 에러는 화면
    // 결함처럼 보인다. 안 오면 안 왔다고 말한다.
    // (이 블록은 템플릿 문자열 안이다 — 주석에 백틱을 쓰면 문자열이 거기서 끊긴다)
    setTimeout(() => res({ ok: false, err: '5초 안에 안 왔다' }), 5000);
    i.src = '${CAM}/api/camera/preview?_=' + Date.now();
  }))()`);
  check('미리보기가 화면에 뜬다', img?.ok, img?.ok ? `${img.w}x${img.h}` : (img?.err ?? '값이 안 왔다'));
  check('미리보기가 16:9 다 — 4:3 은 화각이 15도 좁다 (DEPTH-CAM §화각)',
    img?.ok && Math.abs(img.w / img.h - 16 / 9) < 0.02, img?.ok ? `${(img.w / img.h).toFixed(3)}` : '');

  // ── 3. **캔버스가 안 오염된다** — 이게 없으면 끊김 감시(`watch.js`)를 못 건다.
  // 헤더만 보고 넘기면 여기서 걸린다: `crossOrigin` 없이 그린 캔버스는 읽는 순간 죽는다
  const taint = await p.eval(`(() => new Promise((res) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      c.getContext('2d').drawImage(i, 0, 0, 8, 8);
      try { c.getContext('2d').getImageData(0, 0, 8, 8); res({ ok: true }); }
      catch (e) { res({ ok: false, err: String(e) }); }
    };
    i.onerror = () => res({ ok: false, err: 'crossOrigin 으로 못 실었다' });
    setTimeout(() => res({ ok: false, err: '5초 안에 안 왔다' }), 5000);
    i.src = '${CAM}/api/camera/preview?_=' + Date.now();
  }))()`);
  check('캔버스가 안 오염된다 — 끊김 감시를 걸 수 있다', taint?.ok, taint?.err ?? 'getImageData OK');

  // ── 4. 미리보기가 **진짜 지금**이다 — 두 장이 다르면 살아 있는 것이다.
  // 같으면 캐시를 물었거나 컬러가 멎은 것이고, 둘 다 "옛 사진을 지금이라 우기는" 자리다
  //
  // ⚠ **앞 512바이트로 비교하면 안 된다** (2026-08-07 이 검사의 첫판이 그래서 빨갰다).
  // 그 구간은 JPEG **헤더**(DQT·DHT·SOF)라 같은 인코더가 내는 한 매 프레임 똑같다 —
  // 살아 있는 스트림을 "멈췄다" 고 판정했다. **전체를 봐야 한다.**
  const fresh = await p.eval(`(async () => {
    const grab = async () => {
      const b = await (await fetch('${CAM}/api/camera/preview', { cache: 'no-store' })).arrayBuffer();
      const u = new Uint8Array(b);
      let h = 2166136261;
      for (let i = 0; i < u.length; i += 1) { h ^= u[i]; h = Math.imul(h, 16777619); }
      return u.length + ':' + (h >>> 0);
    };
    const a = await grab();
    await new Promise((r) => setTimeout(r, 700));
    const b = await grab();
    return { same: a === b, a, b };
  })()`);
  check('미리보기가 갱신된다 — 옛 사진을 물고 있지 않다', fresh.same === false,
    `${fresh.a} → ${fresh.b}`);

  // ── 5. 판정이 실측 임계값을 쓴다 (`thresholdUnset` 이면 아무도 안 채운 것이다)
  check(`깊이 판정이 실측 임계값으로 돈다 (${THRESHOLD_SRC})`,
    cors?.ok && cors.reason !== 'thresholdUnset',
    `valid=${cors?.valid} reason=${cors?.reason} 중앙=${(cors?.center ?? 0).toFixed(3)}`);

  // ── 6. **FR5 화면** — 관문이 값을 내는 것과 화면이 그리는 것은 다른 일이다.
  // 여기까지 봐야 "뎁스 화면을 볼 수 있나" 에 답한 것이 된다
  // ⚠ **`waitFor` 는 타임아웃에 조용히 `null` 을 낸다** (`cdp-harness.mjs` §waitFor).
  // 안 받으면 다음 줄이 "null 의 dataset" 으로 죽고, 그 에러는 **화면 결함처럼 보인다** —
  // 진짜 사실은 "15초 기다렸는데 안 나왔다" 다. 받아서 말한다 (2026-08-07 여기서 밟았다)
  // **판마다 초기화한다.** 접힘/펴짐은 localStorage 에 남고 CDP 프로필은 판 사이에 살아
  // 있어서, 지난 판이 펴 둔 것을 이번 판이 "기본이 펴짐" 으로 읽는다 — 게이트가 자기가
  // 남긴 자국에 걸려 넘어진다(2026-08-07 실측). 기본값 검사는 **깨끗한 브라우저**라야 뜻이 있다.
  await p.eval("localStorage.removeItem('fr5.depthOpen'); 'ok'");
  await p.navigate(`${ORIGIN}/?_=${Date.now()}`);
  await p.waitFor('document.readyState === "complete"');
  if (!await p.waitFor('!!document.querySelector("[data-t=depthview]")', { timeoutMs: 15000 })) {
    const why = await p.eval(`(() => ({
      campips: !!document.querySelector('.campips'),
      twin: !!document.querySelector('[data-t=twin]'),
      host: location.host,
      depthHost: (() => { try { return localStorage.getItem('fr5.depthHost'); } catch { return 'ls불가'; } })(),
      번들: [...document.querySelectorAll('script[src]')].map((s) => s.src.split('/').pop()).join(','),
    }))()`);
    throw new Error(`뎁스 PiP 가 15초 안에 안 나왔다 — ${JSON.stringify(why)}`);
  }
  const folded = await p.eval(`(() => {
    const v = document.querySelector('[data-t=depthview]');
    const twin = document.querySelector('[data-t=twin]').getBoundingClientRect();
    const sum = [...document.querySelectorAll('.campips > *')]
      .reduce((a, el) => { const r = el.getBoundingClientRect(); return a + r.width * r.height; }, 0);
    return { open: v.dataset.open, head: document.querySelector('[data-t=depth-stat]')?.textContent,
             tone: document.querySelector('[data-t=depth-stat]')?.dataset.tone,
             img: !!document.querySelector('[data-t=depth-img]'),
             pct: sum / (twin.width * twin.height) * 100,
             n: document.querySelectorAll('.campips > *').length };
  })()`);
  check('뎁스 PiP 가 화면에 있다', folded.head != null, folded.head ?? '없음');
  check('머리띠가 관문 상태를 말한다', folded.tone === 'ok' && folded.head === 'LIVE',
    `${folded.tone} · ${folded.head}`);
  // **기본은 접힘이다** — 펴 두면 3D 를 가리고 스트림이 하나 더 열린다
  check('기본이 접힘이다', folded.open === 'false', `open=${folded.open}`);
  check('접혀 있으면 그림을 안 받는다 — 대역을 안 쓴다', folded.img === false);
  // 무리 전체로 잰다. **한 창만 재면 새 창이 검사를 지나가 버린다** (2026-08-07)
  check('기본 상태에서 PiP 무리가 3D 의 10% 미만이다', folded.pct < 10,
    `${folded.pct.toFixed(1)}% · 창 ${folded.n}개`);

  // 펴면 그림과 띠가 나온다
  await p.eval(`document.querySelector('[data-t=depth-toggle]').click()`);
  await new Promise((r) => setTimeout(r, 2500));
  const opened = await p.eval(`(() => {
    const img = document.querySelector('[data-t=depth-img]');
    return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0,
             hud: [...document.querySelectorAll('[data-t^=depth-hud-]')].map((e) => e.dataset.tone) };
  })()`);
  check('펴면 깊이 화면이 뜬다', opened.w > 0 && opened.h > 0, `${opened.w}x${opened.h}`);
  check('띠 3줄이 나온다 (모드·유효·온도)', opened.hud.length === 3, opened.hud.join(','));
  // **온도는 판정하지 않는다** — 스로틀 지점을 안 쟀다. 안 재 본 것에 임계값을 지어내지 않는다
  check('안 잰 것(온도)에 경고색을 붙이지 않는다', opened.hud[2] === 'mute', opened.hud[2]);

  // ── 7. 크기 — **둘이 나란히 서므로 폭이 다르면 어긋나 보인다.** 기본값을 맞췄고
  // 크기 조절은 공용 훅(`usePipSize.js`)이 든다. 글로벌은 안 띄운 브라우저면 건너뛴다
  const box = await p.eval(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return { depth: r('[data-t=depthview]'), cam: r('[data-t=camview]'),
             handle: !!document.querySelector('[data-t=depth-resize]') };
  })()`);
  check('뎁스 PiP 에 크기 조절 핸들이 있다', box.handle === true);
  check('펼친 기본 크기가 글로벌 기본값(300x195)과 같다',
    box.depth?.w === 300 && box.depth?.h === 195, JSON.stringify(box.depth));
  if (box.cam) {
    check('두 창의 폭이 같다 — 나란히 서므로 어긋나면 눈에 띈다',
      box.cam.w === box.depth.w, `글로벌 ${box.cam.w} · 뎁스 ${box.depth.w}`);
  }
} catch (e) {
  check('실행', false, e.message);
} finally {
  await p?.close?.();
}

const bad = results.filter((r) => !r).length;
console.log(bad ? `\n${bad}건 실패` : `\n${results.length}/${results.length} 통과`);
process.exit(bad ? 1 : 0);
