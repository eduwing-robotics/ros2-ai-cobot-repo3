// `state.js` 단위 검사 — **브라우저 없이 판정을 다 본다.**
//
// 실렌더 게이트(`fr5-cam-verify.mjs`)는 "그려지는가"를 보고, 여기는 "각 판정이 맞는가"를
// 본다. 브리지 쪽 `fr5-unit.sh` 와 같은 나눔이다.
// 표준 라이브러리만 쓴다 — `node:test` 는 Node 내장이라 새 의존성 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraState } from './state.js';

// ⛔ **잠금값을 여기 베껴 적지 않는다** (2026-08-19). 전에는 `quality: '90'` 처럼 문자열로
// 박혀 있었는데, `lock.json` 의 정본을 1080p q50 으로 옮기자 **시험 넷이 통째로 빨개졌다** —
// 시험이 「화면이 lock.json 과 대조한다」가 아니라 「그때의 숫자」를 재고 있었던 것이다.
// 판정 대상(`state.js:22`)이 읽는 그 파일을 여기서도 읽는다 — 그러면 정본을 바꿔도 안 깨지고,
// **정말 깨져야 할 때**(대조 로직이 망가졌을 때)만 깨진다.
import LOCK from './lock.json' with { type: 'json' };

const LOCKED = { quality: LOCK.quality, whitebalance: LOCK.whitebalance, zoom: LOCK.zoom };
const [LOCK_W, LOCK_H] = LOCK.videoSize.split('x').map(Number);
const CALIB = { verified: true, intrinsics: { widthPx: LOCK_W, heightPx: LOCK_H },
  labToCam: { rmsPx: 1.568 } };
const at = (rows, key) => rows.find((r) => r.key === key);

test('전부 정상이면 경고가 하나도 없다', () => {
  const rows = cameraState({ calib: CALIB, status: LOCKED,
    observed: { live: true, stale: false, streamW: LOCK_W, streamH: LOCK_H, lastChangeMsAgo: 1200 } });
  assert.equal(rows.filter((r) => r.tone === 'warn').length, 0);
  assert.equal(at(rows, 'link').label, 'LIVE');
  assert.equal(at(rows, 'resolution').label, `${LOCK_W}×${LOCK_H}`);
});

// ── 제1원칙: 못 읽은 값은 통과가 아니다
test('보정이 없으면 통과가 아니라 경고다', () => {
  const rows = cameraState();
  assert.equal(at(rows, 'calib').tone, 'warn');
  assert.equal(at(rows, 'link').tone, 'mute');       // 여는 중은 아직 판정이 아니다
});

test('"물어봤는데 못 읽음"과 "안 물어봄"을 가른다', () => {
  // null = 폰에 물어봤는데 응답이 없다 → 사람이 고쳐야 한다
  assert.equal(at(cameraState({ status: null }), 'settings').tone, 'warn');
  // undefined = 애초에 물을 폰이 없다(합성 고정물) → 경고를 상주시키면 안 된다
  assert.equal(at(cameraState({}), 'settings').tone, 'mute');
});

test('보정값이 없으면 해상도를 "정상"이라 적지 않는다', () => {
  const rows = cameraState({ status: LOCKED, observed: { streamW: 1920, streamH: 1080 } });
  assert.equal(at(rows, 'resolution').tone, 'warn');
  assert.match(at(rows, 'resolution').label, /보정값 없음/);
});

// ── D64 회귀 — 이 세 줄이 이 파일을 만든 이유다
test('D64 회귀: 폰이 혼자 되돌아간 설정을 잡는다', () => {
  const rows = cameraState({ calib: CALIB,
    // 되돌아간 값 = **잠금값과 다르기만** 하면 된다. 숫자 자체는 뜻이 없다
    status: { quality: '49', whitebalance: 'auto', zoom: LOCK.zoom },
    observed: { live: true, streamW: LOCK_W / 2, streamH: LOCK_H / 2, lastChangeMsAgo: 500 } });
  const s = at(rows, 'settings');
  assert.equal(s.tone, 'warn');
  assert.match(s.label, new RegExp(`화질 49≠${LOCK.quality}`));
  assert.match(s.label, /화벨 auto≠fluorescent/);
});

test('줌이 1.0배가 아니면 다른 렌즈다 — 잡는다', () => {
  const rows = cameraState({ calib: CALIB, status: { ...LOCKED, zoom: '200' },
    observed: { live: true, streamW: LOCK_W, streamH: LOCK_H } });
  assert.equal(at(rows, 'settings').tone, 'warn');
  assert.match(at(rows, 'settings').label, new RegExp(`줌 200≠${LOCK.zoom}`));
});

test('설정 키가 아직 안 돌아왔으면 경고가 아니라 "읽는 중"이다', () => {
  // 해상도를 바꾼 직후 `status.json` 은 키가 빠진 채 돌아온다 (`cam-lock.sh` §curvals)
  const rows = cameraState({ calib: CALIB, status: { quality: LOCK.quality },
    observed: { live: true, streamW: LOCK_W, streamH: LOCK_H } });
  assert.equal(at(rows, 'settings').tone, 'mute');
});

test('초점은 판정하지 않는다 — 기기가 주는 값이 거짓말이라서', () => {
  const rows = cameraState({ calib: CALIB,
    status: { ...LOCKED, focusmode: 'continuous-video', focus_distance: '2.5' },
    observed: { live: true, streamW: LOCK_W, streamH: LOCK_H } });
  assert.equal(at(rows, 'settings').tone, 'ok');
});

// ── 해상도: 순수 축소는 정상, 종횡비가 다르면 무효
test('순수 축소는 경고가 아니다 — 배율을 적는다', () => {
  // ⛔ **「1920×1080」을 시험 제목·값에 박지 않는다** (2026-08-19). 그건 그때의 잠금값이
  // 2560×1440 이라 성립한 예였고, 정본이 1080p 로 옮겨지자 **같은 해상도가 1.0배**가 돼
  // 시험이 자기 전제를 잃었다. 재는 것은 «어떤 숫자냐» 가 아니라 **«가로세로비가 같은 축소를
  // 경고가 아니라 배율로 적는가»** 다. 그래서 잠금값의 절반을 쓴다.
  const rows = cameraState({ calib: CALIB, status: LOCKED,
    observed: { live: true, streamW: LOCK_W / 2, streamH: LOCK_H / 2, lastChangeMsAgo: 300 } });
  const r = at(rows, 'resolution');
  assert.equal(r.tone, 'ok');
  assert.match(r.label, /0\.50배/);   // 두 자리로 적는다
});

test('종횡비가 다르면 보정값이 무효다', () => {
  const rows = cameraState({ calib: CALIB, status: LOCKED,
    observed: { live: true, streamW: 1920, streamH: 1440 } });
  const r = at(rows, 'resolution');
  assert.equal(r.tone, 'warn');
  assert.match(r.label, /무효/);
});

// ── 연결
test('멈춤을 끊김보다 먼저 본다 — 옛 프레임이 걸린 쪽이 더 위험하다', () => {
  const rows = cameraState({ calib: CALIB, status: LOCKED,
    observed: { live: true, stale: true, streamW: LOCK_W, streamH: LOCK_H } });
  assert.equal(at(rows, 'link').tone, 'warn');
  assert.match(at(rows, 'link').label, /멈춤/);
});

test('마지막 변화가 9초를 넘으면 경고다', () => {
  const old = cameraState({ observed: { lastChangeMsAgo: 12000 } });
  const fresh = cameraState({ observed: { lastChangeMsAgo: 8000 } });
  assert.equal(at(old, 'frameAge').tone, 'warn');
  assert.equal(at(fresh, 'frameAge').tone, 'ok');
});

// ── 정합
test('합성 고정물을 실측인 척하지 않는다', () => {
  const rows = cameraState({ calib: { ...CALIB, verified: false }, status: LOCKED,
    observed: { live: true, streamW: LOCK_W, streamH: LOCK_H } });
  assert.equal(at(rows, 'calib').tone, 'warn');
  assert.match(at(rows, 'calib').label, /실측 아님/);
});

test('내부 파라미터만 있고 labToCam 이 없으면 정합 미검증이다', () => {
  const rows = cameraState({ calib: { verified: true, intrinsics: CALIB.intrinsics },
    status: LOCKED, observed: { live: true, streamW: LOCK_W, streamH: LOCK_H } });
  assert.equal(at(rows, 'calib').tone, 'warn');
  assert.match(at(rows, 'calib').label, /정합 미검증/);
});

test('정합이 있으면 RMS 를 숫자로 적는다', () => {
  const rows = cameraState({ calib: CALIB, status: LOCKED,
    observed: { live: true, streamW: LOCK_W, streamH: LOCK_H } });
  assert.equal(at(rows, 'calib').label, '정합 RMS 1.57px');
});

test('행 개수와 키는 화면이 기대하는 그대로다', () => {
  const rows = cameraState();
  assert.deepEqual(rows.map((r) => r.key),
    ['link', 'resolution', 'settings', 'frameAge', 'calib', 'drift']);
});

// ── 정합 상시 감시 (단계 A · 2026-08-08)
//
// **여기가 이 파일에서 제일 중요한 묶음이다.** 「검사가 있다」와 「검사가 잡는다」는 다르고,
// 이 프로젝트는 그 차이로 이미 데였다. 그래서 초록만이 아니라 **빨간불을 반드시 한 번 본다.**
const OK = { calib: CALIB, status: LOCKED,
  observed: { live: true, streamW: LOCK_W, streamH: LOCK_H } };
// 나이는 **필수**라 기본으로 방금 잰 값을 준다 — 나이 자체를 보는 시험은 아래 따로 있다
const withDrift = (drift) => cameraState({ ...OK, observed: { ...OK.observed, drift } });
const fresh = (rmsPx) => withDrift({ rmsPx, ageMs: 900 });

test('겹침이 어긋나면 빨간불이 켜진다 — 25mm 옮겼을 때 실측 49.7px', () => {
  const rows = fresh(49.7);
  assert.equal(at(rows, 'drift').tone, 'warn');
  assert.match(at(rows, 'drift').label, /49\.7px 어긋남/);
  assert.match(at(rows, 'drift').label, /다시 풀어야/);
});

test('**옛 정합은 초록인 채로** 겹침만 빨개진다 — 그게 제일 위험한 얼굴이다', () => {
  // 잘 푼 옛날 값이라 `calib` 은 자신 있게 초록이다. 그 자신감이 곧 GAP P1 이다
  const rows = fresh(49.7);
  assert.equal(at(rows, 'calib').tone, 'ok');
  assert.equal(at(rows, 'drift').tone, 'warn');
});

test('정상 범위(실측 1.08~1.40px)는 조용하다 — 오탐이 나면 사람이 경고를 무시한다', () => {
  for (const px of [1.08, 1.25, 1.40, 4.9]) {
    assert.equal(at(fresh(px), 'drift').tone, 'ok', `${px}px`);
  }
});

test('경계 5.0px 은 통과, 그 위는 경고 — 선이 어디인지 못 박는다', () => {
  assert.equal(at(fresh(5.0), 'drift').tone, 'ok');
  assert.equal(at(fresh(5.01), 'drift').tone, 'warn');
});

// 파일이 **없는 것**(아무도 감시를 안 건다)과 **있는데 낡은 것**(감시기가 죽었다)은 다르다.
// 읽는 쪽이 404 를 `undefined` 로 바꿔 넘기므로, 감시기를 안 돌리는 기계에서는 조용하다 —
// 못 끄는 경고를 벽 화면에 상주시키면 사람이 경고를 무시하는 법을 배운다
test('감시를 안 거는 기계에서는 조용하다 — 못 끄는 경고를 상주시키지 않는다', () => {
  assert.equal(at(withDrift(undefined), 'drift').tone, 'mute');
  assert.equal(at(withDrift(undefined), 'drift').label, '겹침 미감시');
});

test('"감시를 안 걸었다"와 "걸었는데 못 쟀다"를 가른다', () => {
  assert.equal(at(withDrift(undefined), 'drift').tone, 'mute');            // 안 걸었다
  assert.equal(at(withDrift(null), 'drift').tone, 'warn');                 // 걸었는데 못 쟀다
  assert.equal(at(withDrift({ ageMs: 900 }), 'drift').tone, 'warn');       // 숫자가 안 왔다
  assert.equal(at(fresh('3'), 'drift').tone, 'warn');                      // 문자열은 숫자가 아니다
});

// ── **감시기가 죽으면 파일이 얼어붙는다.** 이 판에서 제일 위험한 고장이고,
// 「검사가 있다 ≠ 검사가 잡는다」가 정확히 여기서 갈린다
test('감시기가 멎으면 마지막 초록값이 초록으로 남지 않는다', () => {
  const dead = at(withDrift({ rmsPx: 1.25, ageMs: 30000 }), 'drift');
  assert.equal(dead.tone, 'warn');
  assert.match(dead.label, /멎었다/);
  assert.match(dead.label, /30초 전/);
});

test('나이를 안 실어 주면 값이 아무리 좋아도 못 믿는다', () => {
  assert.equal(at(withDrift({ rmsPx: 0.1 }), 'drift').tone, 'warn');
  assert.match(at(withDrift({ rmsPx: 0.1 }), 'drift').label, /나이 미상/);
});

test('나이 경계 9초 — 프레임 나이와 같은 선을 쓴다', () => {
  assert.equal(at(withDrift({ rmsPx: 1.25, ageMs: 9000 }), 'drift').tone, 'ok');
  assert.equal(at(withDrift({ rmsPx: 1.25, ageMs: 9001 }), 'drift').tone, 'warn');
});

test('못 잰 사유는 고칠 수 있는 것과 없는 것을 가른다', () => {
  const why = (reason) => at(withDrift({ rmsPx: null, ageMs: 900, reason }), 'drift').label;
  assert.match(why('noTags'), /태그가 안 보인다/);
  assert.match(why('noFrame'), /영상이 안 온다/);
  assert.match(why('resolution'), /해상도가 보정값과 다르다/);
  // **모르는 사유는 지어내지 않는다** — 붙일 말이 없으면 안 붙인다
  assert.equal(why('처음보는사유'), '겹침 확인 못 함');
});

test('보정이 없으면 겹침 감시는 경고를 겹쳐 울리지 않는다', () => {
  // `calib` 이 이미 「보정 없음」이라 말했다. 두 줄이 같은 말을 하면 둘 다 안 읽힌다
  const rows = cameraState({ observed: { drift: { rmsPx: 99 } } });
  assert.equal(at(rows, 'calib').tone, 'warn');
  assert.equal(at(rows, 'drift').tone, 'mute');
});
