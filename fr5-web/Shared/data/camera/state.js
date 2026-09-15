import LOCK_JSON from './lock.json' with { type: 'json' };

// 카메라 상태 판정 — **화면 셋이 같은 답을 내게 하는 한 곳.**
//
// 화면은 여기가 낸 문장과 색을 **그리기만 한다.** 판정을 화면에서 다시 짜면 FR5 와 AR 이
// 서로 다른 "괜찮다"를 갖게 되는데, 안전 표시에서 그게 제일 나쁜 갈라짐이다.
// 배치(크기·자리)는 화면마다 다르다 — PiP 300px 과 AR 전체화면을 같게 만들면 못 쓴다.
//
// **제1원칙 그대로** (`SAFETY-RULES.md`) — 못 읽은 값은 통과가 아니라 경고다.
// `status` 가 null 이면 "설정 정상"이 아니라 **"설정 확인 못 함"** 이다.
//
// DOM·fetch·타이머가 없다. 순수 함수라 브라우저 없이 `node --test` 로 판정을 다 본다.

// 폰 설정 잠금값. **조용히 되돌아가는 값들이다** — 2026-08-06 실측(D64)에서 앱이 혼자
// `2560×1440 → 1920×1080` · `quality 90 → 49` · `whitebalance fluorescent → auto` 로
// 돌아가 있었고, 화면은 아무 말도 안 했다. 내부 파라미터가 통째로 무효인 상태였다.
//
// ✅ **정본은 `lock.json` 하나다** (2026-08-08 · 위 ponytail 해소). 잠그는 쪽
// (`scripts/map/cam-lock.sh`)과 판정하는 이쪽이 같은 파일을 읽는다 — 예전에는 각자 상수를
// 들고 있어서, 저쪽을 고치고 이쪽을 안 고치면 화면이 **옛 기준으로 판정**했다 (하드 룰 5).
// `videoSize` 는 여기서 안 본다 — 해상도는 `resolutionRow` 가 **보정값과** 대조한다.
const LOCK = { quality: LOCK_JSON.quality, whitebalance: LOCK_JSON.whitebalance,
  zoom: LOCK_JSON.zoom };

// **초점은 판정하지 않는다.** `cam-lock.sh` §초점 — 기기가 되돌려주는 `focusmode`·
// `focus_distance` 는 거짓말이다(요청한 다이옵터가 그대로 나오는데 렌즈는 거기 없다).
// 판정 근거는 선명도인데 그건 화면이 못 잰다. **못 재는 것을 재는 척하지 않는다.**

// 마지막 변화가 이보다 오래되면 경고. `CamView` 의 감시 주기(3초)×3 과 같은 뜻이다
const STALE_MS = 9000;

// 겹침이 이보다 어긋나면 **보정이 지금 화면에 안 맞는다** (2026-08-08 실측으로 정했다).
//
//   정상       저장된 자세로 산 프레임을 재투영 → 1.08 ~ 1.40 px
//   25mm 이동  폰을 다시 거치했더니 같은 계산이 → **49.7 px**
//
// 5.0 은 정상의 3.5배이자 그 신호의 1/10 이다. 카메라 위치 흔들림이 0.06mm(≈0.1px)
// 라서 (`docs/evidence/2026-08-08/apriltag-corner-refine.md`) 이 선에서 오탐이 나지 않는다.
// **낮출 때는 실측부터 한다** — 숫자를 조이면 조용한 화면이 시끄러운 화면이 되고,
// 사람은 시끄러운 경고를 무시하는 법을 배운다.
const DRIFT_WARN_PX = 5.0;
// 종횡비 비교 허용치 — 1920/1080 과 2560/1440 은 부동소수라 정확히 안 같다
const ASPECT_EPS = 0.005;

const px = (w, h) => `${w}×${h}`;

/**
 * @param {object|null} calib     `Shared/data/config/global-cam.json` 그대로. 없으면 null
 * @param {object|null|undefined} status  IP Webcam `/status.json` 의 `curvals`.
 *   **`null`(물어봤는데 못 읽음 → 경고)과 `undefined`(안 물어봄 → 해당 없음)를 가른다.**
 *   합성 고정물처럼 카메라가 아예 없는 화면에서 "설정 확인 못 함"을 띄우면, 아무도 못 고치는
 *   경고가 상주해 사람이 경고를 무시하는 법을 배운다 — 그게 제1원칙을 더 크게 깬다
 * @param {object} observed
 *   @param {boolean|null} observed.live   true=프레임 옴 · false=못 옴 · null=여는 중
 *   @param {boolean} observed.stale       붙어는 있는데 프레임이 멎었나
 *   @param {number|null} observed.streamW 실제 스트림 가로(px). `naturalWidth`
 *   @param {number|null} observed.streamH
 *   @param {number|null} observed.lastChangeMsAgo  마지막으로 화면이 바뀐 뒤 지난 ms
 *   @param {{rmsPx: number|null, ageMs: number, reason?: string}|null|undefined} observed.drift
 *     지금 프레임의 겹침 오차 (`scripts/map/watch-calib.py` 산출).
 *     **`undefined`(감시를 안 걸었다)와 `null`(걸었는데 못 쟀다)을 가른다** — `status` 와 같은 규약.
 *     **`ageMs` 가 필수다** — 감시기가 죽으면 파일이 마지막 초록값으로 얼어붙는데,
 *     나이가 없으면 화면이 영원히 "괜찮다"고 말한다. 값을 믿는 근거는 값이 아니라 값의 나이다
 * @returns {{key: string, tone: 'ok'|'warn'|'mute', label: string}[]}
 */
export function cameraState({ calib = null, status = undefined, observed = {} } = {}) {
  const { live = null, stale = false, streamW = null, streamH = null,
    lastChangeMsAgo = null, drift = undefined } = observed;
  return [
    linkRow(live, stale),
    resolutionRow(calib, streamW, streamH),
    settingsRow(status),
    frameAgeRow(lastChangeMsAgo),
    calibRow(calib),
    driftRow(calib, drift),
  ];
}

function linkRow(live, stale) {
  // **멈춤을 끊김보다 먼저 본다.** 붙어 있는데 옛 프레임이 걸려 있는 쪽이 더 위험하다 —
  // 겉보기엔 정상이라 사람이 그걸 지금 화면으로 읽는다
  if (stale) return { key: 'link', tone: 'warn', label: '멈춤 — 새 프레임이 안 온다' };
  if (live === true) return { key: 'link', tone: 'ok', label: 'LIVE' };
  if (live === false) return { key: 'link', tone: 'warn', label: '안 옴' };
  return { key: 'link', tone: 'mute', label: '여는 중…' };
}

function resolutionRow(calib, w, h) {
  if (!w || !h) return { key: 'resolution', tone: 'mute', label: '해상도 확인 중' };
  const I = calib?.intrinsics;
  if (!I?.widthPx || !I?.heightPx) {
    // 보정값이 없으면 스트림 해상도만 적는다. **"정상"이라고 적지 않는다**
    return { key: 'resolution', tone: 'warn', label: `${px(w, h)} · 보정값 없음` };
  }
  if (w === I.widthPx && h === I.heightPx) {
    return { key: 'resolution', tone: 'ok', label: px(w, h) };
  }
  // 종횡비가 같으면 **순수 축소**라 내부 파라미터를 배율만큼 곱해 쓴다 (브리프 §7 단계 0a).
  // 다르면 크롭이나 다른 센서 모드라 보정값이 **통째로 무효**다 — 스케일로 못 메운다
  const same = Math.abs(w / h - I.widthPx / I.heightPx) < ASPECT_EPS;
  return same
    ? { key: 'resolution', tone: 'ok',
      label: `${px(w, h)} · 보정 ${px(I.widthPx, I.heightPx)} 에서 ${(w / I.widthPx).toFixed(2)}배` }
    : { key: 'resolution', tone: 'warn',
      label: `${px(w, h)} ≠ 보정 ${px(I.widthPx, I.heightPx)} — 종횡비가 달라 보정값이 무효다` };
}

function settingsRow(status) {
  // 물어보지 않는 화면이 있다 — 합성 고정물에는 잠글 폰이 없다. 그건 경고가 아니다
  if (status === undefined) return { key: 'settings', tone: 'mute', label: '설정 미확인' };
  // 제1원칙 — **물어봤는데** 못 읽었으면 차단 쪽이다. 앱이 안 켜졌거나 CORS 가 막혔거나
  // 둘 중 하나인데, 어느 쪽이든 **설정이 잠겼는지 모르는 상태**다
  if (!status) return { key: 'settings', tone: 'warn', label: '설정 확인 못 함' };
  const off = [];
  // 해상도 전환 직후 `status.json` 은 **키가 빠진 채** 돌아온다 (`cam-lock.sh` §curvals).
  // 없는 키를 "틀렸다"로 읽으면 전환할 때마다 거짓 경고가 뜬다 — 모르는 것은 모른다고 센다
  const miss = [];
  for (const [k, want] of Object.entries(LOCK)) {
    const got = status[k];
    if (got === undefined || got === null) miss.push(k);
    else if (String(got) !== want) off.push(`${LABEL[k]} ${got}≠${want}`);
  }
  if (off.length) return { key: 'settings', tone: 'warn', label: off.join(' · ') };
  if (miss.length) return { key: 'settings', tone: 'mute', label: '설정 읽는 중…' };
  return { key: 'settings', tone: 'ok', label: '설정 잠김' };
}
const LABEL = { quality: '화질', whitebalance: '화벨', zoom: '줌' };

function frameAgeRow(ms) {
  // **`onLoad` 로 재지 않는다** — Chrome 은 MJPEG `<img>` 에 `load` 를 첫 프레임 한 번만
  // 쏜다(2026-08-06 실측). 그걸로 재면 살아 있는 스트림이 무한히 늙는다.
  //
  // ponytail: 그래서 **픽셀이 마지막으로 바뀐 시각**으로 대신한다. 촬영 시각이 아니라
  // "이 화면이 지금 화면인가"에 답하는 값이다 — 라벨도 그렇게 적어 촬영 시각인 척하지 않는다.
  // 한계: 장면이 완전히 안 움직이면 실제보다 늙어 보인다(JPEG 잡음 덕에 실측에선 안 났다).
  // 올릴 길: 관문(`/api/camera/state`)이 `lastFrameAt` 을 싣게 되면 그 값으로 갈아탄다.
  if (ms === null || ms === undefined) return { key: 'frameAge', tone: 'mute', label: '나이 미측정' };
  const s = (ms / 1000).toFixed(1);
  return ms > STALE_MS
    ? { key: 'frameAge', tone: 'warn', label: `마지막 변화 ${s}초 전` }
    : { key: 'frameAge', tone: 'ok', label: `마지막 변화 ${s}초 전` };
}

function calibRow(calib) {
  if (!calib) return { key: 'calib', tone: 'warn', label: '보정 없음 — 겹치기 불가' };
  // `verified: false` 는 합성 고정물이다. 숫자가 있다고 실측인 척하면 안 된다
  if (calib.verified === false) return { key: 'calib', tone: 'warn', label: '합성 고정물 — 실측 아님' };
  const E = calib.labToCam;
  if (!E) return { key: 'calib', tone: 'warn', label: '정합 미검증 — 내부 파라미터만 있다' };
  const rms = typeof E.rmsPx === 'number' ? `RMS ${E.rmsPx.toFixed(2)}px` : 'RMS 미상';
  return { key: 'calib', tone: typeof E.rmsPx === 'number' ? 'ok' : 'warn', label: `정합 ${rms}` };
}

/**
 * 정합 상시 감시 — **저장된 보정이 지금 화면에도 맞나.**
 *
 * `calibRow` 와 다른 것을 본다. 저쪽은 **풀 때** 얼마나 잘 풀렸나(과거의 품질)이고, 이쪽은
 * **지금** 얼마나 맞나(현재의 유효성)다. 둘이 갈리는 순간이 정확히 위험한 순간이다 —
 * 2026-08-08 에 폰을 다시 거치했더니 `calibRow` 는 `정합 RMS 1.08px` 로 초록인데 실제 겹침은
 * 49.7px 어긋나 있었다. **잘 푼 옛날 값**이라 화면이 더 자신 있게 틀린다 (GAP P1).
 */
function driftRow(calib, drift) {
  // 볼 보정이 없으면 감시할 것도 없다. `calibRow` 가 이미 「보정 없음」이라 말했다 —
  // 같은 말을 두 줄로 하면 사람이 두 줄 다 안 읽는다
  if (!calib?.labToCam) return { key: 'drift', tone: 'mute', label: '겹침 감시 대상 없음' };
  // 안 걸었으면 경고가 아니다 — 고칠 수 없는 경고를 상주시키지 않는다 (§settings 와 같은 이유)
  if (drift === undefined) return { key: 'drift', tone: 'mute', label: '겹침 미감시' };
  // **감시기가 죽으면 파일이 얼어붙는다** — 마지막 초록값이 영원히 남아 화면이 계속
  // "괜찮다"고 말한다. 이 판에서 제일 위험한 고장이라 **값보다 나이를 먼저 본다.**
  // 나이를 안 실어 줬으면 그것도 모르는 것이다 (제1원칙)
  const age = drift?.ageMs;
  if (typeof age !== 'number') return { key: 'drift', tone: 'warn', label: '겹침 확인 못 함 — 나이 미상' };
  if (age > STALE_MS) {
    return { key: 'drift', tone: 'warn', label: `겹침 감시가 멎었다 — ${(age / 1000).toFixed(0)}초 전 값` };
  }
  // **걸었는데 못 쟀으면 차단 쪽이다** (제1원칙). 태그가 가렸든 해상도가 풀렸든, 어느 쪽이든
  // **지금 맞는지 모르는 상태**다 — 모르는 것을 「맞다」로 적지 않는다.
  // 사유를 같이 적는다: 고칠 수 있는 것(태그가 가림)과 없는 것을 사람이 갈라야 한다
  if (typeof drift.rmsPx !== 'number') {
    return { key: 'drift', tone: 'warn',
      label: `겹침 확인 못 함${DRIFT_WHY[drift.reason] ? ` — ${DRIFT_WHY[drift.reason]}` : ''}` };
  }
  const px = drift.rmsPx;
  // ponytail: 숫자 하나로 「무엇이」 움직였는지는 못 가른다. 태그별 오차를 받으면
  // 카메라가 움직인 것(전부 같이 튄다)과 태그가 움직인 것(그 태그만 튄다)이 갈린다 —
  // 값을 만드는 쪽(A2)이 생기면 그때 늘린다. 지금은 **움직였다는 사실**까지만 말한다
  return px > DRIFT_WARN_PX
    ? { key: 'drift', tone: 'warn', label: `겹침 ${px.toFixed(1)}px 어긋남 — 다시 풀어야 한다` }
    : { key: 'drift', tone: 'ok', label: `겹침 ${px.toFixed(1)}px` };
}
// `watch-calib.py` 의 `reason` → 사람 말. **모르는 사유는 지어내지 않는다** (없으면 안 붙인다)
const DRIFT_WHY = { noFrame: '영상이 안 온다', noTags: '태그가 안 보인다', resolution: '해상도가 보정값과 다르다' };

/**
 * **정합이 바뀌었나 — 캘리브를 다시 읽어야 하나** (2026-08-27 · D147).
 *
 * `calibTrust`(`view3d/zone-overlay.js`)는 같은 대조로 「못 믿는다」를 **말하기만** 했다.
 * 갈아타는 쪽은 화면마다 따로 짜여 있었고 **`AR/src/screens/cam.js` 만 갈아탔다** — 조작대 `CamView` 는
 * 캘리브를 열 때 한 번만 읽었다. 그래서 08-27 에 호스트 감시기가 카메라 이동 **89mm** 를
 * 스스로 다시 푼 뒤에도 조작대 화면만 **6시간 전 자세**로 그렸다. 실기 담당자가
 * *「맥에서는 맞는데 윈도우에서는 안 맞는다」* 로 잡으셨고, 차이는 **탭을 언제 열었나** 하나였다.
 *
 * 술어를 여기 둔 이유는 `zone-overlay.js` 가 three.js·JSON 을 물고 있어 **순수 시험에서
 * 못 열리기** 때문이다. 판정이 시험 밖에 있으면 다음에 또 조용히 갈라진다.
 *
 * ⛔ **모르면 안 갈아탄다.** 양쪽 기준샷을 다 알 때만 참이다 — 한쪽이 비면 「바뀌었다」를
 * 주장할 근거가 없고, 근거 없이 다시 읽으면 매 틱 읽는다.
 *
 * @param {string|null|undefined} driftBasis `global-cam-drift.json` 의 `basis`
 * @param {string|null|undefined} myShot 지금 얹고 있는 `global-cam.json` 의 `labToCam.shot`
 */
export function shouldAdoptCalib(driftBasis, myShot) {
  return Boolean(driftBasis && myShot && driftBasis !== myShot);
}
