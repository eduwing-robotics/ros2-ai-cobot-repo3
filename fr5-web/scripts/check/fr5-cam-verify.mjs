// 실영상 PiP 실렌더 판정 — 3D 쌍둥이 위 카메라 창이 **실제 폰에서 프레임을 받는지**까지 본다.
//
// ⚠ **폰이 켜져 있어야 한다.** IP Webcam 서버가 떠 있지 않으면 통과할 수 없으므로
// `all.sh` 에 넣지 않는다 (다른 `*-verify.mjs` 와 같이 손으로 부른다 — `scripts/README.md`).
// 실행: `node scripts/check/fr5-cam-verify.mjs` (주소는 `FR5_CAM_HOST` — 호스트와 같은 정본)
// 폰 붙이기는 `/카메라` 스킬이 먼저다 (주소·해상도 잠금까지 거기서 끝난다).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openPage } from './lib/cdp-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.FR5_VERIFY_OUT ?? mkdtempSync(join(tmpdir(), 'fr5-cam-verify-'));
// 폰 주소의 정본은 `FR5_CAM_HOST` 다 — 브리지의 받침 추적·정합 감시가 읽는 것과 같은 값
// (`docs/ref/runbook/FR5-BRINGUP.md` §윈도우 호스트). `CAM_HOST` 는 옛 이름이라 남겨만 둔다.
const CAM = process.env.FR5_CAM_HOST ?? process.env.CAM_HOST ?? '192.168.30.8:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = [];
const check = (n, ok, d = '') => { R.push([ok, n, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// mock 브리지가 없으면 LivePanel 이 죽어 화면 전체가 안 뜬다 (`/robots` 가 배열이 아님)
const PORT = 5158;
const bridge = spawn('uv', ['run', '--with', 'fastapi', '--with', 'uvicorn[standard]', '--with', 'pyyaml',
  'uvicorn', 'main:app', '--port', String(PORT)],
  { cwd: `${ROOT}/FR5/bridge`, stdio: 'ignore', env: { ...process.env, FR5_DATA_DIR: `${OUT}/cam-data`, FR5_TB_HOST: '' } });   // 조건 27 끔 — 게이트는 터틀봇 없는 기계에서도 초록
const vite = spawn('npm', ['run', 'dev:fr5'], { cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, FR5_PORT: String(PORT) } });
const waitUp = async (u) => { for (let i = 0; i < 150; i++) {
  if (await fetch(u).then((r) => r.ok).catch(() => false)) return true; await sleep(200); } return false; };
let page;
try {
  if (!await waitUp(`http://127.0.0.1:${PORT}/robots`)) throw new Error('브리지 기동 실패');
  if (!await waitUp('http://localhost:5176/')) throw new Error('vite 기동 실패');
  // ── 1. 주소를 안 주면 창이 없다 (기능을 안 켠 상태)
  page = await openPage('http://localhost:5176/', { port: 9351, windowSize: '1400,900',
    // 저장분이 남으면 "주소 없음" 검사가 거짓 실패한다
    userDataDir: `${OUT}/cdp-cam-${process.pid}` });
  await page.waitFor('!!document.querySelector("[data-t=twin]")');
  await sleep(1500);
  check('주소 없으면 PiP 가 없다', await page.eval('!document.querySelector("[data-t=camview]")'));

  // ── 2. ?cam= 을 주면 창이 뜨고 기억된다
  await page.navigate(`http://localhost:5176/?cam=${CAM}`);
  await page.waitFor('!!document.querySelector("[data-t=camview]")');
  check('?cam= 을 주면 PiP 가 뜬다', true);
  check('주소를 기억한다', await page.eval(`localStorage.getItem('fr5.camHost') === ${JSON.stringify(CAM)}`),
    await page.eval("localStorage.getItem('fr5.camHost')"));

  // ── 3. **실제로 프레임이 오는가** — 여기까지 해야 "보인다" 다
  const live = await page.waitFor('document.querySelector("[data-t=camview]").dataset.live === "true"',
    { timeoutMs: 20000 });
  const dim = await page.eval(`(() => { const i = document.querySelector('[data-t=cam-img]');
    return i ? \`\${i.naturalWidth}x\${i.naturalHeight}\` : null; })()`);
  check('폰에서 실제 프레임이 온다', !!live, `naturalSize ${dim}`);
  check('스트림 해상도가 2560x1440 이다', dim === '2560x1440', dim);

  // ── 4. 3D 를 안 가린다 — twin 이 화면의 대부분이고 PiP 는 작다
  const twin = await page.rect('[data-t=twin]');
  const cam = await page.rect('[data-t=camview]');
  // **한 창이 아니라 무리 전체를 잰다** (2026-08-07 뎁스 추가). `[data-t=camview]` 하나만
  // 재면 PiP 를 하나 더 얹었을 때 규칙의 취지(3D 를 가리지 않는다)는 깨지는데 게이트는
  // 초록이다 — 새 창이 이 검사를 **통과하는 게 아니라 지나가 버린다**
  const pips = await page.eval(`(() => {
    const t = document.querySelector('[data-t=twin]').getBoundingClientRect();
    const sum = [...document.querySelectorAll('.campips > *')]
      .reduce((a, el) => { const r = el.getBoundingClientRect(); return a + r.width * r.height; }, 0);
    return { sum, twin: t.width * t.height,
             n: document.querySelectorAll('.campips > *').length };
  })()`);
  const ratio = pips.sum / pips.twin;
  check(`PiP 무리가 3D 의 10% 미만이다 (창 ${pips.n}개)`, ratio < 0.1,
    `${(ratio * 100).toFixed(1)}%`);
  check('PiP 가 3D 우상단 안에 있다',
    cam.x > twin.x + twin.width / 2 && cam.y < twin.y + twin.height / 2,
    `cam(${cam.x},${cam.y}) twin(${twin.x},${twin.y},${twin.width}x${twin.height})`);

  // ── 5. 탭을 옮겨도 스트림이 안 끊긴다 (이 배치의 존재 이유)
  await page.eval(`[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()==='Teach')?.click(); 'ok'`);
  await sleep(1200);
  check('Teach 로 옮겨도 PiP 가 살아 있다',
    await page.eval('document.querySelector("[data-t=camview]")?.dataset.live === "true"'));

  // ── 6. 접기 — 접으면 영상 요소가 사라지고 머리만 남는다
  await page.eval(`document.querySelector('[data-t=cam-toggle]').click(); 'ok'`);
  await sleep(400);
  check('접으면 영상이 사라진다',
    await page.eval('!document.querySelector("[data-t=cam-img]") && !!document.querySelector("[data-t=camview]")'));
  await page.eval(`document.querySelector('[data-t=cam-toggle]').click(); 'ok'`);
  await sleep(1500);

  // ── 7. 못 닿는 주소면 **조용히 숨지 않고** 영상 없음을 말한다 (제1원칙의 화면판)
  await page.navigate('http://localhost:5176/?cam=192.168.30.199:8080');
  const dead = await page.waitFor('document.querySelector("[data-t=camview]").dataset.live === "false"',
    { timeoutMs: 20000 });
  const deadText = await page.eval('document.querySelector("[data-t=cam-stat]")?.textContent');
  check('못 닿으면 "영상 없음" 을 표시한다', !!dead, deadText);
  // **실패할 때도 주소를 보여줘야 한다** — 2026-08-07 실기에서 우분투 화면이 안 뜨는데
  // 화면에 "영상 없음" 뿐이라 저장된 주소가 옛것인지 확인할 길이 없었다
  check('못 닿을 때 어느 주소가 안 왔는지 보인다', (deadText || '').includes('192.168.30.199'), deadText);
  check('다시 시도 버튼이 있다', await page.eval('!!document.querySelector("[data-t=cam-retry]")'));

  // ── 되돌리고 증거 촬영
  await page.navigate(`http://localhost:5176/?cam=${CAM}`);
  await page.waitFor('document.querySelector("[data-t=camview]").dataset.live === "true"', { timeoutMs: 20000 });
  await sleep(2000);
  await page.screenshot(`${OUT}/fr5-cam-pip.png`);
  console.log(`\n증거: ${OUT}/fr5-cam-pip.png`);
  check('콘솔 오류 없음', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '));
} finally {
  page?.close();
  vite.kill('SIGTERM');
  bridge.kill('SIGTERM');
  spawn('pkill', ['-f', 'vite'], { stdio: 'ignore' });
}
const bad = R.filter(([ok]) => !ok).length;
console.log(`\n${R.length - bad}/${R.length} PASS`);
process.exit(bad ? 1 : 0);
