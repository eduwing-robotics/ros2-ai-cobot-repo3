// 화면 녹화 — 겹쳐 보이는 그대로를 영상 파일로 남긴다.
//
// **왜 `renderer.domElement.captureStream()` 이 아닌가.**
// AR 화면은 두 장이 겹쳐 있다 — 뒤에 카메라 `<video>`(z-index -2), 앞에 **투명한** WebGL 캔버스
// (D13). 캔버스만 잡으면 로봇만 나오고 배경은 통째로 비어 있다. 그래서 매 프레임 둘을
// 오프스크린 캔버스에 합치고, 그 캔버스를 녹화한다.
//
// **합치는 시점이 렌더 직후여야 한다.** 렌더러가 `preserveDrawingBuffer: false` 라
// 애니메이션 루프 밖에서 WebGL 캔버스를 읽으면 **빈 화면**이 나온다. 그래서 이 모듈은
// 스스로 루프를 돌지 않고 `capture()` 를 밖에서 — `setAnimationLoop` 끝에서 — 부르게 한다.
//
// **HTML UI 는 안 찍힌다.** 합치는 것이 영상과 캔버스 둘뿐이라 버튼바·진단판이
// 영상에 남지 않는다. 녹화 전에 화면을 정리할 필요가 없다.

// 폰 저장공간과 인코딩 부담의 상한. 넘으면 스스로 멈추고 파일을 떨군다.
const MAX_MS = 3 * 60_000;
// 긴 변 상한. 폰 카메라가 1280 이상을 줘도 여기서 깎는다 — 인코딩이 fps 를 먹는다.
const MAX_EDGE = 1280;
// 후보 순서대로 처음 되는 것을 쓴다. iOS 사파리는 mp4, 안드로이드 크롬은 webm 이다.
const TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? null;
}

/** `fr5-ar-20260731-142530.mp4` — 폰 앨범에서 언제 찍은 판인지 바로 보인다. */
function fileName(ext) {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `fr5-ar-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/**
 * 영상을 대상 사각형에 **잘라 채운다**(cover). 여백을 두면(contain) 화면에서 보던
 * 구도와 영상이 달라져, 나중에 "이때 마커가 화면 어디 있었나" 를 못 되짚는다.
 */
function drawCover(ctx, src, sw, sh, dw, dh) {
  const scale = Math.max(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(src, (dw - w) / 2, (dh - h) / 2, w, h);
}

/**
 * 한 프레임을 합친다 — **카메라가 아래, 겹침이 위.** 순서가 뒤집히면 로봇이 영상에 묻힌다.
 *
 * `capture()` 에서 떼어 낸 이유는 **눈이 아니라 픽셀로 검사하기 위해서**다.
 * 만든 영상 파일을 되열어 보는 검증은 백그라운드 탭에서 디코딩이 막힌다
 * (archive/evidence-2026-07/2026-07-31/ar-record.md). 이 함수는 캔버스에 직접 그리므로
 * `getImageData` 로 레이어 순서를 바로 잴 수 있다.
 */
export function composeFrame(ctx, video, canvas, w, h) {
  ctx.clearRect(0, 0, w, h);
  if (video?.videoWidth) drawCover(ctx, video, video.videoWidth, video.videoHeight, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas   3D 겹침이 그려지는 WebGL 캔버스
 * @param {() => (HTMLVideoElement|null)} o.getVideo  카메라 영상 (아직 없으면 null)
 * @param {number} [o.fps]               녹화 프레임률. 렌더 fps 보다 높게 잡아도 소용없다
 * @param {(state: {on: boolean, sec: number, msg: string}) => void} [o.onState]
 */
export function createRecorder({ canvas, getVideo, fps = 24, onState }) {
  const mimeType = pickType();
  const supported = Boolean(mimeType && canvas.captureStream);

  let off = null;      // 합치는 캔버스
  let ctx = null;
  let rec = null;
  let chunks = [];
  let startedAt = 0;
  let lastSec = -1;

  const say = (msg) => onState?.({
    on: Boolean(rec),
    sec: rec ? Math.floor((performance.now() - startedAt) / 1000) : 0,
    msg,
  });

  function start() {
    if (rec || !supported) return;

    // 화면비를 그대로 유지한 채 긴 변만 깎는다.
    const w = canvas.width || canvas.clientWidth || 1280;
    const h = canvas.height || canvas.clientHeight || 720;
    const k = Math.min(1, MAX_EDGE / Math.max(w, h));
    off = document.createElement('canvas');
    off.width = Math.max(2, Math.round(w * k));
    off.height = Math.max(2, Math.round(h * k));
    ctx = off.getContext('2d');

    chunks = [];
    // captureStream(fps) 은 브라우저가 알아서 캔버스를 fps 로 샘플링한다.
    // requestFrame() 수동 제어는 사파리에서 안 되므로 쓰지 않는다.
    rec = new MediaRecorder(off.captureStream(fps), { mimeType, videoBitsPerSecond: 4_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      chunks = [];
      rec = null;
      off = null;
      ctx = null;
      save(blob);
    };
    rec.start(1000);   // 1초마다 조각을 넘긴다 — 도중에 죽어도 앞부분은 남는다
    startedAt = performance.now();
    lastSec = -1;
    say('녹화 시작');
  }

  function stop() {
    if (!rec) return;
    rec.stop();          // 파일 저장은 onstop 에서 이어진다
    say('저장하는 중…');
  }

  async function save(blob) {
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const name = fileName(ext);
    const file = new File([blob], name, { type: blob.type });

    // 폰에서는 공유 시트가 낫다 — 앨범·메시지로 바로 간다.
    // 데스크톱과 지원 안 하는 폰은 그냥 내려받는다.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        say(`${name} 공유함`);
        return;
      } catch (e) {
        // 사용자가 공유 시트를 닫은 것은 실패가 아니다 — 조용히 내려받기로 간다
        if (e?.name !== 'AbortError') say('공유에 실패해 내려받습니다');
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    // 짧은 판은 1MB 가 안 된다. MB 로만 적으면 `0.0MB` 가 떠서 **실패로 읽힌다.**
    const size = blob.size >= 1e6 ? `${(blob.size / 1e6).toFixed(1)}MB` : `${Math.round(blob.size / 1e3)}KB`;
    say(`${name} 저장됨 · ${size}`);
  }

  return {
    supported,
    mimeType,
    recording: () => Boolean(rec),
    toggle() { if (rec) stop(); else start(); },
    stop,

    /** **렌더 직후에 부른다.** 여기 말고 다른 데서 부르면 캔버스가 비어 있다. */
    capture(now) {
      if (!ctx) return;
      composeFrame(ctx, getVideo?.(), canvas, off.width, off.height);

      const sec = Math.floor((now - startedAt) / 1000);
      if (sec !== lastSec) { lastSec = sec; say(''); }
      if (now - startedAt >= MAX_MS) stop();
    },
  };
}
