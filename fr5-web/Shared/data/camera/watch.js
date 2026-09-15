// 프레임이 정말 오고 있나 — **픽셀로 잰다.**
//
// MJPEG 는 끊겨도 아무 이벤트가 안 온다. `load` 는 첫 프레임 때 한 번뿐이고(2026-08-06 실측:
// 10초에 1회), 서버가 연결을 닫아도 `<img>` 는 **마지막 프레임을 그대로 들고 조용히 서 있는다.**
// 그날 폰 앱이 네 번 재시작했는데 화면은 멀쩡해 보였다 — 안전 표시에서 제일 나쁜 실패다.
//
// 그래서 작은 캔버스에 옮겨 그려 값이 그대로면 죽은 것으로 친다. 장면이 정말 안 움직여도
// JPEG 잡음 때문에 프레임마다 값이 달라진다 — **완전 동일은 "새 프레임 없음"이다.**
//
// **React 도 프레임워크도 모른다.** 캔버스와 `<img>` 만 안다 — 그래서 FR5(React)와
// AR(바닐라)이 같은 것을 쓴다. 갈라지면 두 화면의 "살아 있다"가 서로 달라진다.

const WATCH_MS = 3000;   // 이 간격으로 본다
const STALE_HITS = 3;    // 연속 이만큼 그대로면 죽은 것 (약 9초)
const PROBE_W = 32;      // 캔버스 크기. 원본을 다 읽으면 비싸다
const PROBE_H = 18;

/**
 * `img` 를 지켜보다 상태가 바뀔 때마다 `onChange` 를 부른다.
 *
 * **`img` 에 `crossOrigin="anonymous"` 가 있어야 한다.** 없으면 캔버스가 오염돼 픽셀을
 * 못 읽는다 — 그때는 **감시만 접고 영상은 그대로 둔다.** 못 재는 것과 안 되는 것은 다르다.
 *
 * @param {HTMLImageElement} img
 * @param {(s: {stale: boolean, lastChangeMsAgo: number|null, tainted: boolean}) => void} onChange
 * @param {{now?: () => number}} [opt]  `now` 는 시험용 주입구다
 * @returns {() => void} 멈추는 함수
 */
export function watchFrames(img, onChange, { now = () => Date.now() } = {}) {
  let canvas = null;
  let ctx = null;
  let last = null;
  let hits = 0;
  let tainted = false;
  let stale = false;
  let changedAt = null;

  const id = setInterval(() => {
    if (tainted || !img || !img.naturalWidth) return;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = PROBE_W; canvas.height = PROBE_H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    let cur;
    try {
      ctx.drawImage(img, 0, 0, PROBE_W, PROBE_H);
      cur = ctx.getImageData(0, 0, PROBE_W, PROBE_H).data;
    } catch {
      tainted = true;
      onChange({ stale, lastChangeMsAgo: null, tainted: true });
      return;
    }
    const hadPrev = last !== null;
    let same = hadPrev;
    if (same) {
      for (let i = 0; i < cur.length; i += 4) { if (cur[i] !== last[i]) { same = false; break; } }
    }
    last = cur;
    if (!hadPrev) return;      // 첫 표본은 비교 대상이 없다
    if (!same) changedAt = now();
    hits = same ? hits + 1 : 0;
    // **경고는 새 프레임을 실제로 본 뒤에만 푼다.** 다시 끼우자마자 풀면 화면이
    // "정상 → 멈춤" 을 번갈아 깜빡여, 사람이 그 순간을 정상으로 읽는다
    if (hits >= STALE_HITS) { hits = 0; stale = true; }
    else if (!same) stale = false;
    onChange({ stale, lastChangeMsAgo: changedAt === null ? null : now() - changedAt, tainted: false });
  }, WATCH_MS);

  return () => clearInterval(id);
}
