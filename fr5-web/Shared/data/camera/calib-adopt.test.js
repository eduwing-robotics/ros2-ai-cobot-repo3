// 정합 갈아타기 술어 — **화면 둘이 같은 조건으로 갈아타는가** (D147).
//
// 왜 이 파일이 생겼나 (2026-08-27): 호스트 감시기가 `--auto` 로 카메라 이동 89mm 를 스스로
// 다시 풀었는데, `AR/src/screens/cam.js` 만 갈아타고 **조작대 `CamView` 는 안 갈아탔다.** 파일은 새것인데
// 한 화면만 6시간 전 자세로 그렸고, 실기 담당자가 *「맥에서는 맞는데 윈도우에서는 안 맞는다」*
// 로 잡으셨다. 차이는 **탭을 언제 열었나** 하나였다.
//
// 그래서 여기는 술어만 보지 않는다 — **두 화면이 실제로 그 술어를 부르는지**까지 본다.
// 술어만 시험하면 다음 화면이 또 안 부르고, 그때도 게이트는 초록이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { shouldAdoptCalib } from './state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('기준샷이 바뀌면 갈아탄다', () => {
  assert.equal(shouldAdoptCalib('tags-auto-20260827-133724.jpg', 'tags-auto-20260820-142116.jpg'), true);
});

test('같으면 안 갈아탄다 — 매 틱 다시 읽으면 안 된다', () => {
  assert.equal(shouldAdoptCalib('tags-20260827.jpg', 'tags-20260827.jpg'), false);
});

test('⛔ 모르면 안 갈아탄다 — 한쪽이 비면 「바뀌었다」의 근거가 없다', () => {
  // 감시기가 아직 basis 를 못 낸 판(못 쟀다) · 캘리브에 shot 이 없는 옛 파일 — 둘 다 침묵
  assert.equal(shouldAdoptCalib(null, 'tags-20260827.jpg'), false);
  assert.equal(shouldAdoptCalib(undefined, 'tags-20260827.jpg'), false);
  assert.equal(shouldAdoptCalib('tags-20260827.jpg', null), false);
  assert.equal(shouldAdoptCalib('', ''), false);
  assert.equal(shouldAdoptCalib(undefined, undefined), false);
});

// ── 배선 — **부르는 곳이 둘 다 살아 있나**
//
// 순수 함수가 맞는 것과 화면이 그걸 부르는 것은 다른 질문이다. 08-27 의 고장은 후자였다.
// grep 은 거친 시험이지만 **이 고장의 모양을 정확히 잡는다** — 부르는 줄이 사라지면 빨개진다.
const CALLERS = [
  ['AR/src/screens/cam.js', 'AR 글로벌캠 겹치기'],
  ['FR5/src/features/live/CamView.jsx', '조작대 실영상 PiP'],
];

for (const [rel, what] of CALLERS) {
  test(`${what} 이 갈아타기를 부른다 — ${rel}`, () => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /shouldAdoptCalib\s*\(/,
      `${rel} 이 shouldAdoptCalib 을 안 부른다 — 자동 재정합이 이 화면에 안 온다`);
    assert.match(src, /from '@fr5\/shared\/data\/camera\/state\.js'/,
      `${rel} 이 공용 구현을 안 쓴다 — 화면마다 조건이 갈라진다`);
  });
}

test('두 화면이 **자기 판단으로** 대조하지 않는다 — 술어가 하나여야 한다', () => {
  // 손으로 `basis !== shot` 을 쓰는 곳이 생기면 그쪽만 규칙이 갈라진다.
  // `zone-overlay.js` 안(술어 본체·`calibTrust`)은 예외다 — 거기가 정본이다.
  for (const [rel] of CALLERS) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const hand = src.match(/basis\s*!==\s*\w+|\w+\s*!==\s*.*labToCam\?\.\.?shot/g) || [];
    assert.deepEqual(hand.filter((h) => !h.includes('d.basis')), [],
      `${rel} 에 손으로 쓴 기준샷 대조가 있다 — 공용 술어로 모은다`);
  }
});
