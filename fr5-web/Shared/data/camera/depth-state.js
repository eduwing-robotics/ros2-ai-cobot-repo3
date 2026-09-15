// 손목 뎁스카메라(D435) 상태 → 화면이 그릴 줄. **순수 함수다** — DOM·fetch·타이머 없음.
//
// `state.js`(글로벌 폰 카메라)와 **같은 규약**이다: `{ key, tone, label }` 배열을 내고
// 화면은 배치만 한다. 다만 판정의 무게중심이 다르다 —
//
//   폰   : 화면이 판정한다 (해상도·설정 잠금이 맞나를 브라우저가 안다)
//   뎁스 : **관문이 이미 판정했다** (`valid`·`validReason`). 여기는 그걸 **말로 옮긴다**
//
// 관문에 판정을 둔 이유는 계약 §카메라 — "깊이 사각지대 판정을 비전 쪽 양심에 맡기지 않는다".
// 그러니 여기서 `validRatioCenter` 를 다시 임계값과 비교하면 **기준이 둘이 된다.** 안 한다.

// 프레임이 이보다 낡으면 "지금" 이 아니다. 관문의 `STALE_S` 와 같은 뜻이되, 여기는 **망을
// 건너온 뒤**라 넉넉히 본다 — 폴링 간격(2초)보다 짧으면 정상 상태가 깜빡인다
const STALE_MS = 6000;

// `validReason` → 사람의 말. **넷뿐이다** (계약 §사유).
// ⚠ `thresholdUnset` 만 **경고가 아니다.** 그건 화면 앞 사람이 못 고치는 것이고,
// 못 고칠 경고를 상주시키면 사람이 경고를 무시하는 법을 배운다 — `설정 미확인` 과 같은 자리.
const REASON = {
  noCamera: { tone: 'warn', label: '카메라 안 붙음' },
  noFrame: { tone: 'warn', label: '프레임이 안 온다' },
  thresholdUnset: { tone: 'mute', label: '판정 기준 미설정' },
  belowThreshold: { tone: 'warn', label: '사각지대 — 너무 가깝다' },
};

/**
 * @param {object|null|undefined} state `GET /api/camera/state` 본문 (관문 `:5058`)
 * @param {number|null} ageMs 그걸 받은 뒤 지난 시간
 * @param {object|null|undefined} handEye FR5 브리지 `GET /state` 의 `handEye`.
 *   `undefined`=안 물어봄(로봇 미연결) · `null`=프로필에 없음 · 객체=있음
 *
 * ⚠ **관문의 `/api/camera/info` 를 안 본다** — `calibId` 는 장치 동일성이라 손목 변환
 * 판정에 못 쓴다 (D145 · 아래 §calibRow). 그 값을 쓸 주인은 시연 녹화이고 아직 없다.
 */
export function depthState({ state = undefined, ageMs = null, handEye = undefined } = {}) {
  return [linkRow(state, ageMs), modeRow(state), validRow(state), calibRow(state, handEye),
    tempRow(state)];
}

function linkRow(s, ageMs) {
  // 안 물어본 것과 물어봤는데 못 읽은 것을 가른다 (`state.js` 와 같은 규약)
  if (s === undefined) return { key: 'link', tone: 'mute', label: '뎁스 미확인' };
  if (!s) return { key: 'link', tone: 'warn', label: '관문 응답 없음' };
  if (!s.connected) return { key: 'link', tone: 'warn', label: '카메라 안 붙음' };
  // 관문은 살아 있는데 **우리가** 오래 못 받았을 수도 있다 — 그건 관문이 모른다
  if (ageMs !== null && ageMs > STALE_MS) {
    return { key: 'link', tone: 'warn', label: `멈춤 — ${Math.round(ageMs / 1000)}초째` };
  }
  return { key: 'link', tone: 'ok', label: 'LIVE' };
}

function modeRow(s) {
  if (!s?.depth) return { key: 'mode', tone: 'mute', label: '모드 확인 중' };
  const d = s.depth;
  const usb = s.usb ? ` · USB ${s.usb}` : '';
  // **USB2 는 조용한 고장이다** — 424x240 이 목록에서 통째로 사라져 근접 깊이가 없어지는데
  // 화면에는 아무 표시도 안 난다 (DEPTH-CAM.md §USB). 그래서 여기서 말한다
  const tone = s.usb && !String(s.usb).startsWith('3') ? 'warn' : 'mute';
  const minZ = d.minZmm == null ? 'Min-Z 모름' : `Min-Z ${d.minZmm}mm`;
  return { key: 'mode', tone, label: `${d.resolution}@${d.fps} · ${minZ}${usb}` };
}

function validRow(s) {
  if (!s?.depth) return { key: 'valid', tone: 'mute', label: '깊이 확인 중' };
  const d = s.depth;
  const pct = d.validRatioCenter == null ? null : `${(d.validRatioCenter * 100).toFixed(0)}%`;
  if (d.valid) return { key: 'valid', tone: 'ok', label: `깊이 유효 · 중앙 ${pct}` };
  const r = REASON[d.validReason] ?? { tone: 'warn', label: `깊이 무효 (${d.validReason})` };
  // 사각지대일 때는 **숫자를 같이 낸다** — 얼마나 모자란지 알아야 팔을 얼마나 뺄지 안다
  const suffix = d.validReason === 'belowThreshold' && pct ? ` · 중앙 ${pct}` : '';
  return { key: 'valid', tone: r.tone, label: `${r.label}${suffix}` };
}

/**
 * 손목↔카메라 변환(hand-eye)이 있나 — **`validRow` 와 다른 것을 본다.**
 *
 * 저쪽은 **깊이 픽셀이 쓸 만한가**(사각지대 밖인가), 이쪽은 **그 깊이를 로봇 좌표로 옮길 수
 * 있나**다. 둘이 갈리는 자리가 위험하다 — `깊이 유효 · 중앙 100%` 로 초록인데 그 좌표를
 * 옮길 수가 없으면 화면만 자신 있는 것이고, 그건 글로벌캠에서 2026-08-08 에 걷어낸 얼굴이다
 * (`state.js` §driftRow · D92).
 *
 * ⛔ **근거는 `calibId` 가 아니다** (2026-08-27 · D145). 그건 **관문의 장치 동일성**이지
 * 좌표 변환이 아니다 — 한 필드에 두 뜻을 얹어 두었더니, hand-eye 가 08-13 에 등재되고
 * `follow.py` 가 그걸 쓰고 있는데도 화면은 **영구 경고**를 띄웠다. 이 파일 머리말이
 * *"못 고칠 경고를 상주시키면 사람이 경고를 무시하는 법을 배운다"* 고 적어 둔 그 고장이다.
 *
 * 판정 근거는 FR5 브리지 `GET /state` 의 **`handEye` 하나**이고, 그 정본은 프로필이다
 * (계약 `VISION-CONTRACT.md` §hand-eye 유효성). 우리가 여기서 "검증됐다" 를 추론하지 않는다.
 */
function calibRow(s, handEye) {
  // 카메라가 없으면 변환을 말할 자리가 아니다 — `link` 가 이미 「안 붙음」이라 말했다.
  // 여기서 또 빨간불을 켜면 한 가지 고장이 두 줄로 울어 사람이 둘 다 안 읽는다
  if (!s?.connected) return { key: 'calib', tone: 'mute', label: '손목 변환 해당 없음' };
  // 로봇에 안 붙었으면 프로필을 못 읽은 것이다 — **없는 것이 아니라 안 물어본 것**이다
  if (handEye === undefined) return { key: 'calib', tone: 'mute', label: '손목 변환 미확인' };
  // **`null` 은 "괜찮다" 가 아니라 "프로필에 없다" 다.** 무엇이 막히는지까지 적는다 —
  // 사유를 안 적으면 사람이 이 경고를 끄는 법을 못 찾고, 못 끄는 경고는 무시하는 법을 가르친다
  if (!handEye) return { key: 'calib', tone: 'warn', label: '손목 변환 없음 — 로봇 좌표로 못 옮긴다' };
  // 있으면 **흩어짐을 같이 낸다** — 판정이 아니라 고지다(계약). 얼마나 믿을 값인지는
  // 사람이 작업의 여유와 대봐야 안다 (D122 는 세워 꽂기에서 ±10mm 라고만 말한다)
  const spread = handEye.spreadMm == null ? '' : ` · 흩어짐 ${handEye.spreadMm}mm`;
  return { key: 'calib', tone: 'ok', label: `손목 변환 ${handEye.measuredAt ?? '있음'}${spread}` };
}

function tempRow(s) {
  // **판정하지 않는다.** D435 가 몇 도부터 스스로 성능을 깎는지 우리가 안 쟀다
  // (2026-08-07 관측: 40분에 28→45℃). 안 재 본 것에 임계값을 지어내지 않는다 —
  // 숫자만 낸다. 재고 나면 그때 `warn` 을 붙인다
  if (s?.tempC == null) return { key: 'temp', tone: 'mute', label: '온도 미확인' };
  return { key: 'temp', tone: 'mute', label: `${s.tempC}℃` };
}
