// `depth-state.js` 단위 검사 — 관문이 낸 판정을 **말로 옮기는 것만** 본다.
// 여기서 임계값을 다시 비교하지 않는 것이 요점이다 (기준이 둘이 되면 갈라진다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { depthState } from './depth-state.js';

const at = (rows, key) => rows.find((r) => r.key === key);
const 관문 = (over = {}) => ({
  connected: true, usb: '3.2', tempC: 41.0,
  depth: { resolution: '848x480', fps: 30, minZmm: 195,
    valid: true, validRatio: 0.93, validRatioCenter: 0.95, validReason: null },
  ...over,
});
const 깊이 = (over) => 관문({ depth: { ...관문().depth, ...over } });

test('전부 정상이면 경고가 없다', () => {
  const rows = depthState({ state: 관문(), ageMs: 500 });
  assert.equal(rows.filter((r) => r.tone === 'warn').length, 0);
  assert.equal(at(rows, 'link').label, 'LIVE');
  assert.match(at(rows, 'valid').label, /깊이 유효 · 중앙 95%/);
});

test('안 물어본 것과 못 읽은 것을 가른다', () => {
  // `undefined` 는 조용, `null` 은 경고 — `state.js` 와 같은 규약이다.
  // 안 물어본 화면에 경고를 띄우면 못 고칠 경고가 상주한다
  assert.equal(at(depthState({}), 'link').tone, 'mute');
  assert.equal(at(depthState({ state: null }), 'link').tone, 'warn');
});

test('카메라가 빠지면 경고다', () => {
  const rows = depthState({ state: 관문({ connected: false }), ageMs: 100 });
  assert.equal(at(rows, 'link').tone, 'warn');
  assert.match(at(rows, 'link').label, /안 붙음/);
});

test('관문은 살아 있는데 우리가 오래 못 받으면 멈춤이다', () => {
  // 관문이 자기가 안 닿는 것을 알 수는 없다 — 그건 이쪽만 안다
  const rows = depthState({ state: 관문(), ageMs: 9000 });
  assert.equal(at(rows, 'link').tone, 'warn');
  assert.match(at(rows, 'link').label, /멈춤 — 9초째/);
});

test('판정 기준 미설정은 경고가 아니다', () => {
  // 화면 앞 사람이 못 고치는 것이다. 경고로 상주시키면 경고를 무시하는 법을 가르친다
  const rows = depthState({ state: 깊이({ valid: false, validReason: 'thresholdUnset' }), ageMs: 100 });
  assert.equal(at(rows, 'valid').tone, 'mute');
  assert.equal(rows.filter((r) => r.tone === 'warn').length, 0);
});

test('사각지대는 경고이고 숫자를 같이 낸다', () => {
  // 얼마나 모자란지 알아야 팔을 얼마나 뺄지 안다
  const rows = depthState({
    state: 깊이({ valid: false, validReason: 'belowThreshold', validRatioCenter: 0.015 }),
    ageMs: 100 });
  assert.equal(at(rows, 'valid').tone, 'warn');
  assert.match(at(rows, 'valid').label, /사각지대/);
  assert.match(at(rows, 'valid').label, /중앙 2%/);
});

test('USB2 로 떨어지면 화면이 말한다', () => {
  // 조용한 고장이다 — 424x240 이 사라져 근접 깊이가 없어지는데 표시가 안 난다
  const rows = depthState({ state: 관문({ usb: '2.1' }), ageMs: 100 });
  assert.equal(at(rows, 'mode').tone, 'warn');
  assert.match(at(rows, 'mode').label, /USB 2\.1/);
});

test('USB3 면 조용하다', () => {
  assert.equal(at(depthState({ state: 관문(), ageMs: 100 }), 'mode').tone, 'mute');
});

test('Min-Z 를 모르면 모른다고 적는다', () => {
  // 0 이나 빈칸으로 채우면 아는 척이 된다
  const rows = depthState({ state: 깊이({ minZmm: null }), ageMs: 100 });
  assert.match(at(rows, 'mode').label, /Min-Z 모름/);
});

test('온도는 판정하지 않는다 — 스로틀 지점을 안 쟀다', () => {
  // 안 재 본 것에 임계값을 지어내지 않는다. 숫자만 낸다
  const rows = depthState({ state: 관문({ tempC: 65 }), ageMs: 100 });
  assert.equal(at(rows, 'temp').tone, 'mute');
  assert.equal(at(rows, 'temp').label, '65℃');
});

test('임계값을 여기서 다시 비교하지 않는다', () => {
  // 관문이 `valid: true` 라 했으면 중앙이 낮아도 그대로 따른다 — 기준이 둘이 되면 갈라진다.
  // 판정을 옮기고 싶으면 `Vision/bridge/config.yaml` 을 고친다
  const rows = depthState({ state: 깊이({ valid: true, validRatioCenter: 0.02 }), ageMs: 100 });
  assert.equal(at(rows, 'valid').tone, 'ok');
});

test('줄 순서와 키가 고정이다', () => {
  // 화면이 머리(link)와 띠(나머지)를 이 순서로 가른다
  assert.deepEqual(depthState({ state: 관문(), ageMs: 100 }).map((r) => r.key),
    ['link', 'mode', 'valid', 'calib', 'temp']);
});

// ── 손목 변환 (2026-08-08 · 근거를 2026-08-27 에 갈았다 · D145)
//
// **`valid` 와 갈리는 자리가 이 묶음의 전부다.** 깊이 픽셀은 멀쩡한데 그 좌표를 못 쓰는
// 상태가 실제 상태이고, 화면이 그때 초록이면 글로벌캠이 531mm 를 조용히 그리던 것과 같다.
//
// ⛔ **판정 입력이 관문의 `calibId` 에서 프로필의 `handEye` 로 바뀌었다.** 옛 입력은
// 장치 동일성이라 이 질문에 못 답했고, 그래서 hand-eye 가 등재된 뒤에도 화면이 영구 경고를
// 띄웠다 — 이 파일이 지키는 원칙(*"못 고칠 경고를 상주시키지 않는다"*)을 자기가 어긴 것이다.
const 정상 = { state: 관문(), ageMs: 100 };
const 손목변환 = { tMm: [-25.9, -76.1, -81.7], spreadMm: 5.74, measuredAt: '2026-08-13' };

test('깊이가 초록이어도 변환이 없으면 그 줄만 빨개진다', () => {
  const rows = depthState({ ...정상, handEye: null });
  assert.equal(at(rows, 'valid').tone, 'ok');          // 픽셀은 멀쩡하다
  assert.equal(at(rows, 'calib').tone, 'warn');        // 좌표는 못 쓴다
  assert.match(at(rows, 'calib').label, /로봇 좌표로 못 옮긴다/);
});

test('변환이 있으면 초록이고 잰 날과 흩어짐을 적는다', () => {
  const rows = depthState({ ...정상, handEye: 손목변환 });
  assert.equal(at(rows, 'calib').tone, 'ok');
  assert.match(at(rows, 'calib').label, /2026-08-13/);
  // 흩어짐은 **판정이 아니라 고지**다 — 사람이 작업 여유(D122 ±10mm)와 대봐야 안다
  assert.match(at(rows, 'calib').label, /5\.74mm/);
});

test('흩어짐을 몰라도 초록은 초록이다 — 문턱을 화면이 만들지 않는다', () => {
  const rows = depthState({ ...정상, handEye: { tMm: [1, 2, 3], measuredAt: '2026-08-13' } });
  assert.equal(at(rows, 'calib').tone, 'ok');
  assert.doesNotMatch(at(rows, 'calib').label, /흩어짐/);
});

test('"안 물어봄"과 "프로필에 없음"을 가른다', () => {
  // 로봇에 안 붙으면 프로필을 못 읽는다 — 그건 **없는 것이 아니라 안 물어본 것**이다
  assert.equal(at(depthState(정상), 'calib').tone, 'mute');
  assert.equal(at(depthState({ ...정상, handEye: null }), 'calib').tone, 'warn');
});

test('카메라가 없으면 변환은 조용하다 — 한 고장이 두 줄로 울지 않는다', () => {
  const rows = depthState({ state: 관문({ connected: false }), ageMs: 100, handEye: null });
  assert.equal(at(rows, 'link').tone, 'warn');
  assert.equal(at(rows, 'calib').tone, 'mute');
});
