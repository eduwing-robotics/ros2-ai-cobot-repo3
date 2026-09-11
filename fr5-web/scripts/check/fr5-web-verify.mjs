// P1 실렌더 검증 — fr5-bridge(5157) + vite dev(5176) 를 직접 띄워 Live 화면을 판정한다.
// 3D 쌍둥이 로딩·관절값 스트림·연결 진단·fail-closed 사유 표시를 실제 브라우저로 본다.
// 실행: node scripts/check/fr5-web-verify.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// **레포 상대 경로다.** 절대 경로로 박으면 남의 기계에서 죽고, 게이트에 못 넣는다 (2026-08-06)
import { openPage, pixelChanged } from './lib/cdp-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const HUD_FRAME = `data:image/jpeg;base64,${readFileSync(join(ROOT,
  'test/fixtures/rgbd-aligned-color.jpg')).toString('base64')}`;
const BRIDGE_PORT = 5157;
// `?cam=` 죽은 주소 — PiP 창만 띄운다(영상은 안 오지만 **무대는 calib 만 있으면 선다** · `CamView.jsx` §판정면 겹치기).
// 실카메라 게이트(`fr5-cam-verify.mjs`)는 폰이 필요해 여기서 PiP 고스트를 잰다 (rnd/PIP-GHOST-CONVERGE-LOOP D7)
const URL = 'http://localhost:5176/?cam=127.0.0.1:9';
// 기본값이 **끝난 세션의 스크래치패드**였다 — `screenshot` 은 `writeFileSync` 뿐이라
// 폴더가 없으면 그 자리에서 죽는다. 스스로 만든 임시 폴더를 기본으로 둔다.
const OUT = process.env.FR5_VERIFY_OUT ?? mkdtempSync(join(tmpdir(), 'fr5-web-shots-'));
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? 'PASS' : 'FAIL', name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
// 지점·궤적은 파일에 남는다 — **사람의 진짜 ~/fr5-data 에 쓰지 않는다**
const DATA = mkdtempSync(join(tmpdir(), 'fr5-web-verify-'));
const env = { ...process.env, FR5_PORT: String(BRIDGE_PORT) };

// **자식의 자식까지 죽인다** — `uv run` 도 `npm run` 도 SIGTERM 을 안 넘긴다.
// `.kill()` 만 하면 uvicorn 이 5157 을, vite 가 5176 을 쥔 채 살아남아 **다음 실행이
// 통째로 무너진다.** 손으로 한 번 돌릴 때는 안 보이고 게이트에 넣는 순간 드러났다 (2026-08-06).
const killTree = (c) => { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch {} } };
const spawnBridge = () => spawn('uv', ['run', '--with', 'fastapi', '--with', 'uvicorn[standard]', '--with', 'pyyaml',
  'uvicorn', 'main:app', '--port', String(BRIDGE_PORT)],
  { cwd: join(ROOT, 'FR5/bridge'), stdio: 'ignore', detached: true,
    env: { ...process.env, FR5_DATA_DIR: DATA, FR5_TB_HOST: '' /* 조건 27 끔 — 게이트는 터틀봇 없는 기계에서도 초록이어야 한다 */ } });
let bridge = spawnBridge();
const web = spawn('npm', ['run', 'dev:fr5'], { cwd: ROOT, env, stdio: 'ignore', detached: true });
process.on('exit', () => { killTree(bridge); killTree(web); });   // 예외·중단에도 고아 0
const waitUp = async (url) => {
  for (let i = 0; i < 150; i++) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

let p = null;
try {
  if (!await waitUp(`http://127.0.0.1:${BRIDGE_PORT}/robots`)) throw new Error('브리지 기동 실패');
  if (!await waitUp(URL)) throw new Error('vite dev 기동 실패');

  p = await openPage(URL, { port: 9343, windowSize: '1280,900' });

  // 1. 뼈대 — 패널 5개(Live·Teach·Program·시뮬레이션·터틀봇 · D182) + 상시 안전 바. **Optimize 는 없다** (D74)
  await p.waitFor(`document.querySelectorAll('nav button').length === 5`);
  check('패널 탭 5개', true);
  check('Optimize 탭이 없다 (D74)',
    !(await p.eval(`[...document.querySelectorAll('nav button')].some(b => /optimize/i.test(b.textContent))`)));
  check('History 탭이 없고 다섯 탭 전부 열려 있다 (D182)',
    (await p.eval(`document.querySelectorAll('nav button:disabled').length`)) === 0
    && (await p.eval(`[...document.querySelectorAll('nav button')].map(b => b.textContent).join(',')`))
      === 'Live,Teach,Program,시뮬레이션,터틀봇');
  check('상시 안전 바 8항목',
    (await p.eval(`document.querySelectorAll('[data-t="safeitem"]').length`)) === 8);
  await p.waitFor(`!!document.querySelector('[data-t="depthview"]')`);
  await p.eval(`window.dispatchEvent(new CustomEvent('fr5:wrist-depth-scan', { detail: {
    target: 'carrier', result: { ok: true, reasons: [], view: {
      target: 'carrier', targetPx: [479.4, 248.1], bulletsPx: [[490.5, 248.6]],
      blob: { hullAxisDeg: 88.7 }, frame: {
        url: ${JSON.stringify(HUD_FRAME)}, widthPx: 848, heightPx: 480, capturedAt: 1
      }
    } }
  } }))`);
  check('손목 뎁스 스캔 정지화면에 표적·총알 HUD가 화소 좌표로 그려진다',
    !!(await p.waitFor(`document.querySelector('[data-t="depthview"]')?.dataset.open === 'true'
      && document.querySelectorAll('[data-t="depth-scan-target"]').length === 1
      && document.querySelectorAll('[data-t="depth-scan-bullet"]').length === 1
      && document.querySelector('[data-t="depth-scan-note"]')?.textContent.includes('총알 1개')`, { timeoutMs: 3000 })));
  if (process.env.FR5_HUD_SHOT) {
    await p.screenshot(process.env.FR5_HUD_SHOT, await p.rect('[data-t="depthview"]'));
  }
  await p.eval(`document.querySelector('[data-t="depth-scan-live"]').click()`);
  check('실시간 보기로 정지 HUD를 즉시 닫는다',
    !(await p.eval(`document.querySelector('[data-t="depth-scan-overlay"]')`)));
  check('글로벌 카메라와 손목 뎁스카메라 이름·종류가 분리돼 있다',
    await p.eval(`document.querySelector('[data-camera="global"] .camhead b')?.textContent === '글로벌 카메라'
      && document.querySelector('[data-camera="wrist-depth"] .camhead b')?.textContent === '손목 뎁스카메라'`));
  check('미연결 phase 표시 DISCONNECTED',
    !!(await p.eval(`document.querySelector('[data-t="safetybar"]').textContent.includes('DISCONNECTED')`)));

  // 2. 불량 mock 프로필 연결 시도 → 사람이 읽는 거부 사유 (fail-closed 경로).
  //    실기 프로필은 시험에서 건드리지 않는다 — 로봇 유무에 따라 결과가 갈리고, 있으면 실기를 만진다
  await p.waitFor(`document.querySelectorAll('[data-t="diag"] select option').length === 5`);
  const pickProfile = (id) => p.eval(`(() => {
    const sel = document.querySelector('[data-t="diag"] select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(id)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await pickProfile('fr5-mock-broken');
  await p.eval(`document.querySelector('[data-t="diag"] button.primary').click()`);
  const refusal = await p.waitFor(`document.querySelector('[data-t="refusal"]')?.textContent`, { timeoutMs: 5000 });
  check('불량 프로필 → 거부 사유 표시 (모델 불일치 fail-closed)', !!refusal && refusal.includes('모델 불일치'));

  // 3. mock 프로필로 연결 → OBSERVE_ONLY
  await pickProfile('fr5-mock-a');
  await p.eval(`document.querySelector('[data-t="diag"] button.primary').click()`);
  check('connect → 안전 바 OBSERVE_ONLY',
    !!(await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('OBSERVE_ONLY')`, { timeoutMs: 5000 })));
  check('출처 배지 mock (사칭 없음)',
    (await p.eval(`document.querySelector('[data-t="source"]').dataset.src`)) === 'mock');
  check('펌웨어 실측 문자열 표시',
    !!(await p.waitFor(`document.body.textContent.includes('FR_CTRL_FV2.010.12')`, { timeoutMs: 5000 })));

  // 4. 값이 흐른다 — 관절 표가 스트림을 따라 변한다
  const j1a = await p.waitFor(`document.querySelector('[data-t="joints"] td')?.textContent !== '—' && document.querySelector('[data-t="joints"] td')?.textContent`, { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 1200));
  const j1b = await p.eval(`document.querySelector('[data-t="joints"] td')?.textContent`);
  check('관절값 스트림 갱신 (WS)', !!j1a && j1a !== j1b, `${j1a} → ${j1b}`);
  check('TCP 6행 값 표시',
    (await p.eval(`[...document.querySelectorAll('[data-t="tcp"] td')].filter(td => td.textContent !== '—').length`)) === 6);

  // 5. 3D 쌍둥이 — URDF 실로딩 + 픽셀이 실제로 움직인다
  check('URDF+그리퍼 로딩 완료 깃발',
    !!(await p.waitFor(`document.querySelector('[data-t="twin"]')?.dataset.ready === '1'`, { timeoutMs: 20000 })));
  const rect = await p.rect('[data-t="twin"] canvas');
  const shot1 = `${OUT}/fr5-twin-1.png`;
  const shot2 = `${OUT}/fr5-twin-2.png`;
  await p.screenshot(shot1, rect);
  await new Promise((r) => setTimeout(r, 1500));
  await p.screenshot(shot2, rect);
  check('3D 캔버스 픽셀이 흐른다 (mock 숨쉬기 실렌더)', pixelChanged(shot1, shot2));
  await p.screenshot(`${OUT}/fr5-live-p1.png`);

  // 6. P2 — 조종권 → ARM(현장확인) → jog 실이동 → DISARM
  const setInput = (sel, value, proto = 'HTMLInputElement') => p.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // **버튼이 나타날 때까지 기다린다.** 전에는 `?? 'notfound'` 를 돌려주고 아무도 안 봤다 —
  // 상태가 바뀌며 조작대가 다시 그려지는 사이에 누르면 클릭이 허공으로 가고, 실패는
  // **그 다음 검사**에서 터져 원인이 안 보인다 (`DISARM → 서보 OFF` 가 그렇게 깜빡였다).
  const clickText = async (text, scope = '[data-t="control"]') => {
    const find = `[...document.querySelectorAll('${scope} button')].find(b => b.textContent.includes(${JSON.stringify(text)}))`;
    if (!await p.waitFor(`!!(${find})`, { timeoutMs: 5000 })) throw new Error(`버튼을 못 찾았다: ${text}`);
    return p.eval(`${find}.click()`);
  };
  const rotateOwnerTokenBehindUi = () => p.eval(`fetch('/owner/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ who: 'kim' })
  }).then(r => r.json())`);

  check('상시 STOP 버튼 존재', !!(await p.eval(`!!document.querySelector('[data-t="safetybar"] [data-t="estop"]')`)));
  // 모드 토글도 상시다 — 잠긴 펜던트를 푸는 유일한 길이라 탭을 옮겨도 사라지면 안 된다 (D72)
  check('모드 토글이 STOP 옆에 상시 존재',
    !!(await p.eval(`!!document.querySelector('[data-t="safetybar"] [data-t="mode-toggle"]')`)));
  check('조종권 없으면 모드 토글 비활성',
    (await p.eval(`document.querySelector('[data-t="mode-toggle"]').disabled`)) === true);
  await setInput('header [data-t="who"] input', 'kim');
  await clickText('조종권 잡기');
  check('조종권 claim → 안전 바에 kim',
    !!(await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('조종권 kim')`, { timeoutMs: 4000 })));
  check('보유 표시 중에도 수동 다시 잡기 경로가 있다',
    !!(await p.waitFor(`!!document.querySelector('[data-t="reclaim"]')`, { timeoutMs: 4000 })));
  // 새로고침으로 토큰을 잃어도 자기 조종권에 갇히지 않는다 (2026-08-04 실기 사고)
  await p.eval(`sessionStorage.removeItem('fr5.ownerToken'); location.reload()`);
  await new Promise((r) => setTimeout(r, 2500));
  await setInput('header [data-t="who"] input', 'kim');
  check('토큰을 잃으면 "다시 잡기" 가 열린다 (반납 불가로 갇히지 않는다)',
    !!(await p.waitFor(`document.querySelector('[data-t="claim"]')?.textContent.includes('다시 잡기')`, { timeoutMs: 5000 })));
  await clickText('조종권 다시 잡기');
  check('다시 잡기 → 새 토큰으로 조종권 복구',
    !!(await p.waitFor(`!!document.querySelector('[data-t="control"] [data-t="confirm"]')`, { timeoutMs: 5000 })));

  // 서버 재시작·같은 이름 재접속 등으로 저장 토큰만 낡은 경우. 값이 "있다"는 이유로
  // 내 것으로 오판하면 반납도 ARM도 거부되고 다시 잡기 버튼까지 사라진다.
  await rotateOwnerTokenBehindUi();
  await clickText('조종권 반납');
  check('REST가 낡은 토큰을 거부하면 즉시 다시 잡기가 열린다',
    !!(await p.waitFor(`document.querySelector('[data-t="claim"]')?.textContent.includes('다시 잡기')`, { timeoutMs: 5000 })));
  await clickText('조종권 다시 잡기');
  check('REST 거부 뒤 새 토큰으로 복구',
    !!(await p.waitFor(`!!document.querySelector('[data-t="control"] [data-t="confirm"]')`, { timeoutMs: 5000 })));

  check('현장확인 전 ARM 비활성',
    (await p.eval(`document.querySelector('[data-t="control"] button[data-t="arm"]')?.disabled`)) === true);
  await p.eval(`document.querySelector('[data-t="control"] [data-t="confirm"] input').click()`);
  await clickText('ARM');
  check('ARM → phase ARMED + 서보 ON',
    !!(await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('ARMED') && document.querySelector('[data-t="safetybar"]').textContent.includes('서보 ON')`, { timeoutMs: 5000 })));
  // ARMED 인 채로 수동 전환 — 드래그 티칭은 서보가 켜져 있어야 되므로 여기서 막히면 안 된다
  check('ARMED 에서 모드 토글이 활성',
    (await p.eval(`document.querySelector('[data-t="mode-toggle"]').disabled`)) === false);
  await p.eval(`document.querySelector('[data-t="mode-toggle"]').click()`);
  await p.screenshot(`${OUT}/fr5-mode-toggle.png`);   // 활성 상태의 토글 — 눈으로 볼 근거
  check('수동으로 → 안전 바가 manual · 서보는 ON 유지',
    !!(await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('manual') && document.querySelector('[data-t="safetybar"]').textContent.includes('서보 ON')`, { timeoutMs: 5000 })));
  await p.eval(`document.querySelector('[data-t="mode-toggle"]').click()`);
  check('자동으로 → 다시 auto (갇히지 않는다)',
    !!(await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('auto')`, { timeoutMs: 5000 })));

  await rotateOwnerTokenBehindUi();
  await p.eval(`document.querySelector('[data-t="mode-toggle"]').click()`);
  check('WS가 낡은 토큰을 거부해도 다시 잡기가 열린다',
    !!(await p.waitFor(`document.querySelector('[data-t="claim"]')?.textContent.includes('다시 잡기')`, { timeoutMs: 5000 })));
  await clickText('조종권 다시 잡기');
  check('WS 거부 뒤 ARMED를 유지한 채 조종권 복구',
    !!(await p.waitFor(`[...document.querySelectorAll('[data-t="control"] button')].some(b => b.textContent.includes('DISARM'))`, { timeoutMs: 5000 })));

  const j1Before = parseFloat(await p.eval(`document.querySelector('[data-t="joints"] td').textContent`));
  await p.eval(`[...document.querySelectorAll('[data-t="jogrow"]')][0].querySelectorAll('button')[1].click()`);
  const j1Target = (j1Before + 1).toFixed(2);
  check('jog +1° → 3D·표의 관절값이 정확히 +1° 도달',
    !!(await p.waitFor(`Math.abs(parseFloat(document.querySelector('[data-t="joints"] td').textContent) - ${j1Before + 1}) < 0.01`, { timeoutMs: 8000 })),
    `j1 ${j1Before.toFixed(2)}→${j1Target}`);
  // 걸음 고르기 — 1° 로 박혀 있던 것을 서버 상한(5°)까지 열었다. **버튼이 고른 값을 실제로
  // 보내는지**를 본다: 라벨만 바뀌고 1° 를 보내면 사람은 5° 를 밀었다고 믿는다
  check('걸음 기본은 1° 이고 그것이 눌려 있다',
    (await p.eval(`document.querySelector('[data-t="jog-step"] button[aria-pressed="true"]').dataset.deg`)) === '1');
  await p.eval(`document.querySelector('[data-t="jog-step-pick"][data-deg="5"]').click()`);
  const j1At5 = parseFloat(await p.eval(`document.querySelector('[data-t="joints"] td').textContent`));
  check('5° 를 고르면 조그 버튼 라벨도 5° 로 바뀐다',
    (await p.eval(`[...document.querySelectorAll('[data-t="jogrow"]')][0].querySelectorAll('button')[1].textContent`)).includes('5'));
  await p.eval(`[...document.querySelectorAll('[data-t="jogrow"]')][0].querySelectorAll('button')[1].click()`);
  check('5° 조그가 실제로 5° 간다 (라벨만 바뀐 게 아니다 · 서버 상한과 같은 값)',
    !!(await p.waitFor(`Math.abs(parseFloat(document.querySelector('[data-t="joints"] td').textContent) - ${j1At5 + 5}) < 0.01`, { timeoutMs: 8000 })),
    `j1 ${j1At5.toFixed(2)}→${(j1At5 + 5).toFixed(2)}`);

  // ── PiP 고스트 (D195·D196 · rnd/PIP-GHOST-CONVERGE-LOOP-2026-09-07) — 이동 중에만 목표가 반투명 팔로 서고, 정착하면 숨는다
  const ghostUp = await p.waitFor(`window.__camGhost && !window.__camGhost.error ? 1 : 0`, { timeoutMs: 40000 });
  check('PiP 고스트 팔이 붙는다 (calib + 베이스 → 지연 로드)', ghostUp === 1,
    await p.eval(`JSON.stringify(window.__camGhost?.error ?? null)`));
  await p.eval(`[...document.querySelectorAll('[data-t="jogrow"]')][0].querySelectorAll('button')[1].click()`);   // +5° (위에서 5 를 골랐다)
  const tgt = await p.waitFor(`window.__camGhost?.kind === 'target' && window.__camGhost.visible ? 1 : 0`, { timeoutMs: 4000, intervalMs: 50 });
  const tgtJ = await p.eval(`(async () => { const st = await (await fetch('/state')).json();
    return { ghost: window.__camGhost?.jointsDeg, sent: st.motionTarget?.jointsDeg, note: document.querySelector('[data-t="cam-ghost"]')?.textContent ?? null }; })()`);
  // 실렌더 — 게이트가 evidence 를 낸다 (하드 룰 2). PiP 창만 잘라 담는다
  await p.screenshot(`${OUT}/fr5-pip-ghost.png`, await p.rect('[data-t="camview"]')).catch(() => {});
  check('이동 중(doneAt null) PiP 고스트 = 보낸 목표 · 머리띠 「고스트 = 이동 목표」', tgt === 1 && !!tgtJ.ghost && !!tgtJ.sent
    && tgtJ.ghost.every((v, i) => Math.abs(v - tgtJ.sent[i]) < 1e-6) && tgtJ.note === '고스트 = 이동 목표',
    `${tgtJ.note} · j1 ${tgtJ.ghost?.[0]?.toFixed?.(2)} vs ${tgtJ.sent?.[0]?.toFixed?.(2)}`);
  const gone = await p.waitFor(`window.__camGhost?.kind === null && !window.__camGhost.visible ? 1 : 0`, { timeoutMs: 20000 });
  check('정착(doneAt) 뒤 PiP 고스트 숨김 — 도착한 자세는 영상이 보여준다', gone === 1);
  await p.eval(`document.querySelector('[data-t="jog-step-pick"][data-deg="0.1"]').click()`);
  const j1At01 = parseFloat(await p.eval(`document.querySelector('[data-t="joints"] td').textContent`));
  await p.eval(`[...document.querySelectorAll('[data-t="jogrow"]')][0].querySelectorAll('button')[1].click()`);
  check('0.1° 걸음도 실제로 0.1° 다 (파지 자세를 맞추는 최소 단위)',
    !!(await p.waitFor(`Math.abs(parseFloat(document.querySelector('[data-t="joints"] td').textContent) - ${j1At01 + 0.1}) < 0.01`, { timeoutMs: 8000 })),
    `j1 ${j1At01.toFixed(2)}→${(j1At01 + 0.1).toFixed(2)}`);
  await p.eval(`document.querySelector('[data-t="jog-step-pick"][data-deg="1"]').click()`);
  // 그리퍼 — 활성화 전에는 슬라이더가 잠겨 있고, 활성화하면 열린다 (GOAL-live-gripper 1)
  check('ARMED 에서 그리퍼 블록이 보인다',
    !!(await p.eval(`!!document.querySelector('[data-t="gripper"]')`)));
  check('활성화 전 슬라이더 잠김',
    (await p.eval(`document.querySelector('[data-t="gripper-range"]').disabled`)) === true);
  await p.eval(`document.querySelector('[data-t="gripper-activate"]').click()`);
  check('활성화 → 슬라이더 열림',
    !!(await p.waitFor(`document.querySelector('[data-t="gripper-range"]')?.disabled === false`, { timeoutMs: 5000 })));
  await p.eval(`document.querySelector('[data-t="gripper-close"]').click()`);
  check('완전 닫기 → 읽은 값이 화면에 돌아온다',
    !!(await p.waitFor(`document.querySelector('[data-t="gripper-raw"]')?.textContent === '0%'`, { timeoutMs: 5000 })),
    '지령 0 → 읽기 0% (같은 방향)');
  // 세밀 개폐 — 세 버튼(열기·n%·닫기) 사이가 **한 번의 클릭으로** 닿아야 한다 (2026-08-08 실기 지적).
  // 조그의 0.1° 검사와 같은 모양이다: 한 번 밀어서 딱 그만큼만 가는지 본다.
  // **걸음 고르개는 두지 않는다** — 큰 이동은 슬라이더가 맡으므로 ± 는 1% 미세조정 전용이다.
  await p.eval(`document.querySelector('[data-t="gripper-plus"]').click()`);
  check('+1% 이 실제로 1% 다 (파지 최소 단위 — 행정 40mm 의 0.4mm)',
    !!(await p.waitFor(`document.querySelector('[data-t="gripper-raw"]')?.textContent === '1%'`, { timeoutMs: 5000 })),
    '0% → +1% → 읽기 1%');
  await p.eval(`document.querySelector('[data-t="gripper-plus"]').click()`);
  await p.eval(`document.querySelector('[data-t="gripper-plus"]').click()`);
  check('눌린 만큼 쌓인다 — 3단계가 아니라 연속이다',
    !!(await p.waitFor(`document.querySelector('[data-t="gripper-raw"]')?.textContent === '3%'`, { timeoutMs: 5000 })),
    '1% → +1% ×2 → 읽기 3%');
  check('벌어짐을 mm 로도 말한다 (행정은 gripper-mount.json 이 뿌리다)',
    (await p.eval(`document.querySelector('[data-t="gripper-mm"]')?.textContent`)) === '1.2mm',
    '3% × 40mm = 1.2mm');
  check('% 칸은 mm 이 붙어도 그대로다 (게이트가 읽는 문자열이 안 바뀐다)',
    (await p.eval(`document.querySelector('[data-t="gripper-raw"]')?.textContent`)) === '3%');
  // 340px 열에서 손잡이가 안 깨지는지 눈으로 본다. **조작대는 40dvh 라 스크롤한 뒤 찍는다** —
  // 안 내리고 찍으면 증거 사진에 그리퍼가 반만 나와 무엇을 확인했는지 알 수 없다
  await p.eval(`document.querySelector('[data-t="dock"]').scrollTop = 9999`);
  await p.screenshot(`${OUT}/fr5-gripper-fine.png`);
  await p.eval(`document.querySelector('[data-t="gripper-minus"]').click()`);
  check('−1% 도 같은 크기로 되돌아온다',
    !!(await p.waitFor(`document.querySelector('[data-t="gripper-raw"]')?.textContent === '2%'`, { timeoutMs: 5000 })));

  // 8. Teach — 지점(점)과 궤적(선). **여기는 승인하지 않는다** (D74)
  await p.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === 'Teach').click()`);
  check('Teach 탭 → 패널이 뜬다',
    !!(await p.waitFor(`!!document.querySelector('[data-t="teach"]')`, { timeoutMs: 5000 })));
  check('탭을 옮겨도 STOP·모드 토글은 그대로다 (상시 안전 바)',
    !!(await p.eval(`!!document.querySelector('[data-t="safetybar"] [data-t="estop"]')
      && !!document.querySelector('[data-t="safetybar"] [data-t="mode-toggle"]')`)));
  // 조작대도 상시다 — Teach 는 조그하며 쓰는 화면이라 Live 로 왕복하면 흐름이 끊긴다
  // (계획 §레이아웃 · 2026-08-06 실기 지적). 그리퍼는 캡처가 굳히는 값이라 특히 그렇다.
  check('Teach 에서도 조그·그리퍼 조작대가 그대로다 (Live 왕복 없음)',
    !!(await p.eval(`!!document.querySelector('[data-t="dock"] [data-t="gripper"]')
      && document.querySelectorAll('[data-t="dock"] [data-t="jogrow"]').length === 6`)));
  check('3D 쌍둥이는 탭을 옮겨도 한 인스턴스다 (카메라 각도 유지)',
    (await p.eval(`document.querySelectorAll('[data-t="twin"]').length`)) === 1);
  check('지점이 없을 때 화면이 그렇게 말한다',
    !!(await p.eval(`!!document.querySelector('[data-t="points-empty"]')`)));
  check('3D 가 "실물 자세" 라고 말한다 (미리보기 아님)',
    (await p.eval(`document.querySelector('[data-t="twin-note"]')?.dataset.live`)) === 'true');
  await setInput('[data-t="point-name"]', 'trayPick');
  // **캡처된 자세를 여기서 읽어 둔다.** 예전에는 한참 위(`j1Before + 1`)의 상수로 가정했는데,
  // 그 사이에 조그가 하나만 늘어도 조용히 어긋난다 (실제로 걸음 검사를 넣자 깨졌다).
  // 뒤의 「그 지점으로 되돌아온다」 는 이 값과 대조한다
  const trayPickJ1 = parseFloat(await p.eval(`window.FR5_STATE.jointsDeg[0]`));
  await p.eval(`document.querySelector('[data-t="point-capture"]').click()`);
  check('캡처 → 목록에 지점이 생긴다',
    !!(await p.waitFor(`document.querySelector('[data-t="point-row"]')?.dataset.name === 'trayPick'`, { timeoutMs: 6000 })));
  // 삭제는 되돌릴 수 없고 바로 옆이 실기를 움직이는 "이동" 이다 (감사 2026-08-05 P0-4).
  // **한 번에 안 지워지는 것**이 이 검사의 핵심이다 — 확인 단계가 사라지면 여기서 깨진다.
  await p.eval(`document.querySelector('[data-t="point-delete"]').click()`);
  check('삭제는 한 번 더 묻는다 (되돌리기가 없다)',
    !!(await p.waitFor(`!!document.querySelector('[data-t="point-delete-ask"]')`, { timeoutMs: 4000 })));
  await p.eval(`document.querySelector('[data-t="point-delete-cancel"]').click()`);
  check('취소하면 지점이 그대로 남는다',
    !!(await p.waitFor(`document.querySelector('[data-t="point-row"]')?.dataset.name === 'trayPick'
      && !document.querySelector('[data-t="point-delete-ask"]')`, { timeoutMs: 4000 })));

  // 미리보기는 **로봇에 아무것도 안 보낸다** — 이동 전에 어디로 가는지 화면에서 먼저 본다
  // 관절 표는 Live 에만 있다 — Teach 에 선 채로는 상태 훅에서 읽는다
  const jBeforePv = await p.eval(`window.FR5_STATE.jointsDeg[0].toFixed(3)`);
  await p.eval(`document.querySelector('[data-t="point-preview"]').click()`);
  check('미리보기 → 3D 가 "실물이 아니다" 를 말한다',
    !!(await p.waitFor(`document.querySelector('[data-t="twin-note"]')?.dataset.live === 'false'
      && document.querySelector('[data-t="twin-note"]').textContent.includes('아직 안 보냈다')`, { timeoutMs: 5000 })));
  await new Promise((r) => setTimeout(r, 600));
  check('미리보기 중에도 실물은 안 움직였다 (읽기 전용)',
    (await p.eval(`document.querySelector('[data-t="teach-refusal"]')`)) === null, `실물 j1 ${jBeforePv}`);
  await p.eval(`document.querySelector('[data-t="point-preview"]').click()`);

  // 궤적 이름은 그대로 파일 이름이 된다 — 경로가 되는 이름은 녹화 **시작에서** 막힌다
  // (감사 2026-08-05 P0-2. 끝에서 막으면 120초를 녹화하고 저장에서 버리게 된다)
  await setInput('[data-t="traj-name"]', '/etc/cron.d/pwn');
  await p.eval(`document.querySelector('[data-t="traj-start"]').click()`);
  check('경로가 되는 궤적 이름은 거부된다 (임의 파일 덮어쓰기 차단)',
    !!(await p.waitFor(`document.querySelector('[data-t="teach-refusal"]')?.textContent.includes('이름은')
      && !document.querySelector('[data-t="traj-live"]')`, { timeoutMs: 5000 })));

  // 궤적 — 녹화는 읽기만 한다
  await setInput('[data-t="traj-name"]', 'demo-01');
  await p.eval(`document.querySelector('[data-t="traj-start"]').click()`);
  const recOn = await p.waitFor(`!!document.querySelector('[data-t="traj-live"]')`, { timeoutMs: 6000 }).catch(() => false);
  check('녹화 시작 → 화면이 녹화 중이라고 말한다', !!recOn,
    recOn ? '' : String(await p.eval(`document.querySelector('[data-t="teach-refusal"]')?.textContent ?? '사유 없음'`)));
  if (!recOn) throw new Error('녹화가 시작되지 않았다');
  await new Promise((r) => setTimeout(r, 1500));
  await p.eval(`document.querySelector('[data-t="traj-stop"]').click()`);
  check('녹화 정지 → 목록에 궤적이 생긴다',
    !!(await p.waitFor(`document.querySelector('[data-t="traj-row"]')?.dataset.name === 'demo-01'`, { timeoutMs: 8000 })));
  check('조건이 맞는 measure 궤적은 비교에 쓸 수 있다고 표시된다',
    (await p.eval(`document.querySelector('[data-t="traj-row"]')?.dataset.usable`)) === 'true');
  check('비교 가능 개수를 화면이 말한다',
    !!(await p.eval(`document.querySelector('[data-t="traj-usable"]')?.textContent.includes('1 / 1')`)));
  await p.eval(`document.querySelector('[data-t="traj-play"]').click()`);
  check('되감기 → 3D 가 "실물은 안 움직인다" 를 말한다',
    !!(await p.waitFor(`document.querySelector('[data-t="twin-note"]')?.textContent.includes('되감기')
      && document.querySelector('[data-t="twin-note"]').dataset.live === 'false'`, { timeoutMs: 8000 })));
  check('되감기 스크럽이 있다',
    !!(await p.eval(`!!document.querySelector('[data-t="play-scrub"]')`)));
  // Teach 에서 그리퍼를 직접 조작한다 — 이게 되면 캡처 전에 Live 로 건너갈 이유가 없다
  await p.eval(`document.querySelector('[data-t="dock"] [data-t="gripper-open"]').click()`);
  check('Teach 를 떠나지 않고 그리퍼가 움직인다',
    !!(await p.waitFor(`document.querySelector('[data-t="gripper-raw"]')?.textContent === '100%'`, { timeoutMs: 5000 })),
    '탭 이동 0회');
  // 두 번째 지점 — **순서 바꾸기를 보려면 이름이 다른 칸이 둘 필요하다.** 이름이 같으면
  // 순서가 바뀌어도 화면이 똑같아 검사가 아무것도 증명하지 못한다.
  // ⚠ 이름이 `trayPick` **뒤로** 정렬돼야 한다 — 「만들기」 는 `points[0]` 으로 첫 칸을
  // 채우고(`ProgramPanel`), 목록은 파일 이름 순이다(`teach.py`). 앞으로 정렬되는 이름을
  // 쓰면 첫 칸이 조용히 바뀌어 뒤의 「그 지점으로 되돌아온다」 가 엉뚱한 자세를 본다
  // ⚠ **자세를 옮겨 두고 캡처한다.** 같은 자리에서 찍으면 두 지점이 **같은 자세**가 되고,
  // 그러면 뒤의 연속 실행 검사가 「마지막 단계 자세로 끝났다」를 증명하지 못한다 — 1바퀴든
  // 2바퀴든 도착 자세가 같아서 통과해 버린다 (2026-08-08 에 실제로 그렇게 통과했다).
  await p.eval(`[...document.querySelectorAll('[data-t="dock"] [data-t="jogrow"]')][0].querySelectorAll('button')[1].click()`);
  await p.waitFor(`Math.abs(window.FR5_STATE.jointsDeg[0] - ${trayPickJ1 + 1}) < 0.01`, { timeoutMs: 8000 });
  await setInput('[data-t="point-name"]', 'trayPut');
  await p.eval(`document.querySelector('[data-t="point-capture"]').click()`);
  check('두 번째 지점도 캡처된다 (순서 바꾸기 재료)',
    !!(await p.waitFor(`document.querySelectorAll('[data-t="point-row"]').length === 2`, { timeoutMs: 6000 })));
  // 캡처는 **지금 자세를 굳히는 것**이라 이 순간의 j1 이 곧 trayPut 의 j1 이다
  const trayPutJ1 = parseFloat(await p.eval(`window.FR5_STATE.jointsDeg[0]`));
  // 되돌린다 — 아래 3% 이동 검사가 `trayPickJ1` 에서 출발하는 것을 전제한다
  await p.eval(`[...document.querySelectorAll('[data-t="dock"] [data-t="jogrow"]')][0].querySelectorAll('button')[0].click()`);
  await p.waitFor(`Math.abs(window.FR5_STATE.jointsDeg[0] - ${trayPickJ1}) < 0.01`, { timeoutMs: 8000 });

  // **3D 는 손가락을 그리는데 「이동」은 관절만 보낸다.** 화면이 그 차이를 말하지 않으면
  // 사람은 그린 대로 실물이 움직인다고 믿는다 — 이 프로젝트에서 제일 비싼 오해 계열이다
  check('그리퍼 값이 기록일 뿐임을 카드와 안내가 말한다',
    !!(await p.eval(`!!document.querySelector('[data-t="point-grip-note"]')`))
    && !!(await p.eval(`!!document.querySelector('[data-t="grip-not-replayed"]')`)));
  const lastPreview = `[...document.querySelectorAll('[data-t="point-row"]')].pop().querySelector('[data-t="point-preview"]')`;
  await p.eval(`${lastPreview}.click()`);
  check('미리보기 라벨도 손가락은 안 따라간다고 말한다',
    !!(await p.waitFor(`document.querySelector('[data-t="twin-note"]')?.textContent.includes('손가락은 안 따라간다')`, { timeoutMs: 5000 })));
  await p.eval(`${lastPreview}.click()`);        // 실물 자세로 되돌린다 — 뒤 검사가 본다

  // 이동 속도 — **고른 값이 실제로 실려야 한다.** 화면에만 뜨고 서버로 안 가면 사람은
  // 천천히 간다고 믿으며 상한으로 움직이는 로봇을 본다. 값이 살아나는 곳은 조그가 아니라
  // 수십 도를 한 번에 가는 지점 이동이다 (조그 1° 는 10% 에서 56ms 라 차이가 안 보인다)
  check('Teach 에 이동 속도 고르기가 있고 기본이 상한(10%) 이다',
    (await p.eval(`document.querySelector('[data-t="speed-pick-select"]')?.value`)) === '10');
  await p.eval(`(() => {
    const el = document.querySelector('[data-t="speed-pick-select"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '3');
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await p.eval(`[...document.querySelectorAll('[data-t="dock"] [data-t="jogrow"]')][0].querySelectorAll('button')[0].click()`);
  await p.waitFor(`Math.abs(window.FR5_STATE.jointsDeg[0] - ${trayPickJ1 - 1}) < 0.01`, { timeoutMs: 8000 });
  await p.eval(`[...document.querySelectorAll('[data-t="point-row"]')][0].querySelector('[data-t="point-goto"]').click()`);
  check('3% 를 고른 지점 이동이 거부 없이 도착한다 (서버 상한 안이라 통과한다)',
    !!(await p.waitFor(`Math.abs(window.FR5_STATE.jointsDeg[0] - ${trayPickJ1}) < 0.05`, { timeoutMs: 9000 }))
    && (await p.eval(`document.querySelector('[data-t="teach-refusal"]')`)) === null,
    `j1 ${(trayPickJ1 - 1).toFixed(2)}→${trayPickJ1.toFixed(2)} @3%`);

  // 9. Program — 지점을 순서로 엮어 승인한 것만 한 단계씩 (PROGRAM-CONTRACT.md · 사다리 3)
  await p.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === 'Program').click()`);
  check('Program 탭이 열린다 (사다리 3)',
    !!(await p.waitFor(`!!document.querySelector('[data-t="program"]')`, { timeoutMs: 5000 })));
  await setInput('[data-t="slot-name"]', '집기시연');
  // 지점 목록이 도착해야 만들 수 있다 — 그 전에는 버튼이 잠겨 있고 화면이 이유를 말한다
  check('지점이 도착하면 만들기가 열린다',
    !!(await p.waitFor(`document.querySelector('[data-t="slot-create"]')?.disabled === false`, { timeoutMs: 6000 })));
  await p.eval(`document.querySelector('[data-t="slot-create"]').click()`);
  const madeSlot = await p.waitFor(`document.querySelector('[data-t="slot-row"]')?.dataset.name === '집기시연'
      && document.querySelector('[data-t="slot-row"]').textContent.includes('작성 중')`, { timeoutMs: 6000 });
  check('프로그램을 만들면 작성 중(draft) 으로 선다', !!madeSlot,
    madeSlot ? '' : String(await p.eval(`(() => {
      const r = document.querySelector('[data-t="program-refusal"]')?.textContent;
      const rows = document.querySelectorAll('[data-t="slot-row"]').length;
      const err = document.querySelector('[data-t="program"]') ? '패널 살아있음' : '패널 사라짐';
      return \`거부=\${r ?? '없음'} · 행수=\${rows} · \${err}\`;
    })()`)));
  // 순서 바꾸기 — 이게 없을 때는 3번 앞에 하나 넣으려고 **뒤의 칸을 전부 빼고 다시 넣어야**
  // 했다. 티칭에서 중간 삽입은 예외가 아니라 일상이다
  const stepNames = `[...document.querySelectorAll('[data-t="step-peek"]')].map(b => b.textContent.trim()).join('|')`;
  await p.eval(`(() => {
    const el = document.querySelector('[data-t="point-pick"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'trayPut');
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await p.eval(`document.querySelector('[data-t="step-add"]').click()`);
  check('뒤에 넣기 → 두 칸이 된다',
    !!(await p.waitFor(`document.querySelectorAll('[data-t="step-row"]').length === 2`, { timeoutMs: 6000 })));
  const orderBefore = await p.eval(stepNames);
  check('첫 칸은 위, 마지막 칸은 아래로 못 간다 (범위 밖 맞바꾸기 없음)',
    (await p.eval(`document.querySelector('[data-t="step-up"]').disabled`)) === true
    && (await p.eval(`[...document.querySelectorAll('[data-t="step-down"]')].pop().disabled`)) === true);
  await p.eval(`[...document.querySelectorAll('[data-t="step-up"]')].pop().click()`);
  check('↑ 로 2번 칸이 1번이 된다 — 순서가 실제로 뒤집힌다',
    !!(await p.waitFor(`${stepNames} === ${JSON.stringify(orderBefore.split('|').reverse().join('|'))}`, { timeoutMs: 6000 })),
    `${orderBefore} → ${orderBefore.split('|').reverse().join('|')}`);
  // 작성 중(draft) 화면의 근거 — **승인 뒤에는 이 버튼들이 사라져** 다른 스크린샷에 안 잡힌다.
  // 340px 열에 ↑·↓·빼기 셋이 들어가는지는 눈으로만 닫힌다
  await p.screenshot(`${OUT}/fr5-program-draft.png`);
  // 되돌려 놓는다 — 뒤의 검사가 1단계로 trayPick 을 기대한다
  await p.eval(`[...document.querySelectorAll('[data-t="step-down"]')][0].click()`);
  await p.waitFor(`${stepNames} === ${JSON.stringify(orderBefore)}`, { timeoutMs: 6000 });
  await p.eval(`[...document.querySelectorAll('[data-t="step-remove"]')].pop().click()`);
  await p.waitFor(`document.querySelectorAll('[data-t="step-row"]').length === 1`, { timeoutMs: 6000 });

  // ── `grip` 칸을 화면에서 꽂는다 (2026-08-10 · D103 · 계약 §삽입은 단계 옆에서) ──
  // **버튼이 단계 목록 안에 있다** — 처음엔 Teach 지점 카드로 적었는데 Teach 는 어느 슬롯이
  // 초안인지 몰라 못 만든다. 사람이 「이 지점 다음에 손을 닫자」고 생각하는 순간이 여기다.
  await p.eval(`document.querySelector('[data-t="step-add-grip"]').click()`);
  check('+ 손 → 그 칸 뒤에 grip 칸이 꽂힌다',
    !!(await p.waitFor(`document.querySelectorAll('[data-t="step-row"]').length === 2
      && document.querySelectorAll('[data-t="step-row"]')[1].dataset.type === 'grip'`, { timeoutMs: 6000 })),
    await p.eval(`[...document.querySelectorAll('[data-t="step-row"]')].map(r => r.dataset.type).join()`));
  // 이동 칸(`… 으로`)과 **문법이 같아야** 한다. 동사(열기/닫기)를 넣으면 방향을 틀릴 자리가 생긴다
  check('칸 이름을 값에서 만든다 — 「손 N% 로」 (이동 칸과 같은 문법 · 동사 없음)',
    /손 \d+% 로/.test(await p.eval(`document.querySelectorAll('[data-t="step-peek"]')[1].textContent`))
    && !/열기|닫기/.test(await p.eval(`document.querySelectorAll('[data-t="step-peek"]')[1].textContent`)),
    await p.eval(`document.querySelectorAll('[data-t="step-peek"]')[1].textContent`));
  check('기본값의 **출처**를 화면이 적는다 (자동으로 넣고 말 안 하면 오해가 되살아난다)',
    /잰 값|실물 값|확인하세요/.test(await p.eval(`document.querySelector('[data-t="grip-seeded"]')?.textContent ?? ''`)),
    await p.eval(`document.querySelector('[data-t="grip-seeded"]')?.textContent`));
  check('집기 순서를 화면이 말한다 — 이동에 딸려 붙지 않는다는 것',
    /접근.*하강.*닫기/.test(await p.eval(`document.querySelector('[data-t="grip-order-hint"]')?.textContent ?? ''`)));
  // **여러 자리 숫자를 타이핑할 수 있어야 한다** — 2026-08-10 에 못 쳤다. 값이 서버에 매여
  // 있어서 키 하나마다 저장→재로드가 돌고 입력칸이 되돌아갔다(화살표로 1씩만 가능했다).
  // 그래서 여기서 **두 자리를 한 글자씩** 넣고 `blur` 로 커밋한다 — 중간 글자에 저장이 끼면 깨진다
  await p.eval(`(() => {
    const el = document.querySelector('[data-t="step-grip-pct"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    for (const ch of ['4', '42']) {
      set.call(el, ch);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  check('타이핑 중에는 입력칸이 되돌아가지 않는다 (키마다 저장하지 않는다)',
    (await p.eval(`document.querySelector('[data-t="step-grip-pct"]').value`)) === '42',
    await p.eval(`document.querySelector('[data-t="step-grip-pct"]').value`));
  await p.eval(`document.querySelector('[data-t="step-grip-pct"]').blur()`);
  check('blur 에서 커밋되고 칸 이름이 「손 42% 로」로 따라온다',
    !!(await p.waitFor(`document.querySelectorAll('[data-t="step-peek"]')[1].textContent.includes('손 42% 로')`, { timeoutMs: 6000 })),
    await p.eval(`document.querySelectorAll('[data-t="step-peek"]')[1].textContent`));
  // 3D — **손가락만 움직인다.** 팔까지 움직이면 사람이 "이 칸에서 여기로 간다" 로 읽는다
  await p.eval(`document.querySelectorAll('[data-t="step-peek"]')[1].click()`);
  check('grip 칸을 누르면 3D 가 「손가락만 · 팔은 그대로」라고 말한다',
    !!(await p.waitFor(`/손가락만/.test(document.querySelector('[data-t="twin-note"]').textContent)
      && /팔은 그대로/.test(document.querySelector('[data-t="twin-note"]').textContent)`, { timeoutMs: 6000 })),
    await p.eval(`document.querySelector('[data-t="twin-note"]').textContent`));
  await p.screenshot(`${OUT}/fr5-program-grip-step.png`);
  // 되돌린다 — 뒤의 검사가 1단계(trayPick)를 기대한다
  await p.eval(`document.querySelectorAll('[data-t="step-peek"]')[1].click()`);
  await p.eval(`[...document.querySelectorAll('[data-t="step-remove"]')].pop().click()`);
  await p.waitFor(`document.querySelectorAll('[data-t="step-row"]').length === 1`, { timeoutMs: 6000 });

  // 승인 전에는 실행 버튼이 아예 없고 **왜인지 문장으로** 나온다 (회색 비활성 금지)
  check('승인 전에는 실행 버튼이 없다',
    (await p.eval(`document.querySelector('[data-t="step-run"]')`)) === null);
  check('현장확인 전 승인 버튼 비활성',
    (await p.eval(`document.querySelector('[data-t="slot-approve"]').disabled`)) === true);
  await p.eval(`document.querySelector('[data-t="approve-confirm"] input').click()`);
  await p.eval(`document.querySelector('[data-t="slot-approve"]').click()`);
  check('승인 → 1단계가 "지금 여기" 로 짚힌다',
    !!(await p.waitFor(`document.querySelector('[data-t="step-row"]')?.dataset.at === 'true'
      && document.querySelector('[data-t="step-row"]').textContent.includes('지금 여기')`, { timeoutMs: 6000 })));
  check('다음에 갈 자세를 3D 가 미리 보여준다 (아직 안 보냈다)',
    (await p.eval(`document.querySelector('[data-t="twin-note"]')?.dataset.live`)) === 'false');
  const runBtn = await p.eval(`document.querySelector('[data-t="step-run"]')?.textContent`);
  check('버튼이 지금 할 한 가지만 말한다', runBtn?.includes('1단계 실행'), runBtn);
  // Program 도 같은 고르기를 쓴다 — 값이 둘로 갈리면 한쪽만 고쳐진다 (`SpeedPick.jsx` 한 곳)
  check('Program 도 실행 직전에 속도를 고른다 (기본 상한)',
    (await p.eval(`document.querySelector('[data-t="speed-pick-select"]')?.value`)) === '10');
  // **일부러 자세를 옮겨 두고** 실행한다 — 이미 그 자세면 "도달했다" 가 공허하다.
  // 조작대는 어느 탭에서도 살아 있으므로 Program 에 선 채로 조그할 수 있다.
  // **관절 표는 Live 패널에만 있다** — 다른 탭에서는 `[data-t="joints"]` 가 null 이라
  // 값 비교가 조용히 NaN 이 된다. 여기서는 페이지가 브리지를 직접 읽는다.
  const j1Now = `window.FR5_STATE.jointsDeg[0]`;
  const j1Moved = trayPickJ1 - 1;      // 조작대 기본 걸음 1° 만큼 **아래로** 밀어 둔다
  await p.eval(`[...document.querySelectorAll('[data-t="dock"] [data-t="jogrow"]')][0].querySelectorAll('button')[0].click()`);
  check('조작대는 Program 탭에서도 산다 — 여기서 자세를 옮긴다',
    !!(await p.waitFor(`Math.abs(${j1Now} - ${j1Moved}) < 0.01`, { timeoutMs: 8000 })),
    `j1 ${trayPickJ1.toFixed(2)}→${j1Moved.toFixed(2)}`);
  await p.eval(`document.querySelector('[data-t="step-run"]').click()`);
  check('한 단계 실행 → 옮겨 둔 자세에서 그 지점으로 되돌아온다',
    !!(await p.waitFor(`Math.abs(${j1Now} - ${trayPickJ1}) < 0.05`, { timeoutMs: 9000 })),
    `j1 ${j1Moved.toFixed(2)}→${trayPickJ1.toFixed(2)} (trayPick)`);
  check('한 칸만 간다 — 마지막까지 끝나면 그렇게 말한다',
    !!(await p.waitFor(`document.querySelector('[data-t="step-blocked"]')?.textContent.includes('마지막 단계까지 끝났어요')`, { timeoutMs: 5000 })));
  await p.screenshot(`${OUT}/fr5-program.png`);

  // 9. 연속 실행 + 반복 (D94 · 계약 §연속 실행과 반복) — **한 단계씩이 기본인 채로** 그 옆에 선다.
  // 칸이 둘이어야 "이어서 갔다" 가 증명된다 — 한 칸짜리는 1바퀴와 2바퀴가 같은 자세로 끝난다.
  await p.eval(`document.querySelector('[data-t="slot-unapprove"]').click()`);
  await p.waitFor(`!!document.querySelector('[data-t="slot-approve"]')`, { timeoutMs: 6000 });
  await p.eval(`(() => {
    const el = document.querySelector('[data-t="point-pick"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'trayPut');
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await p.eval(`document.querySelector('[data-t="step-add"]').click()`);
  await p.waitFor(`document.querySelectorAll('[data-t="step-row"]').length === 2`, { timeoutMs: 6000 });
  await p.eval(`document.querySelector('[data-t="approve-confirm"] input').click()`);
  await p.eval(`document.querySelector('[data-t="slot-approve"]').click()`);
  await p.waitFor(`!!document.querySelector('[data-t="run-all"]')`, { timeoutMs: 6000 });
  check('승인하면 「전체 실행」이 한 단계 실행 **옆에** 선다 (기본은 여전히 한 칸)',
    !!(await p.eval(`!!document.querySelector('[data-t="step-run"]') && !!document.querySelector('[data-t="run-all"]')`)));
  // **임의 칸 실행** (2026-08-10) — 계약이 이미 허용한다(§step: 화면이 index 를 보낸다).
  // 칸마다 버튼이 있어야 하고, **커서가 그 칸 다음으로 따라와야** 한다 — 안 따라오면
  // 「지금 여기」가 방금 실행한 칸과 어긋나 화면이 거짓말을 한다
  check('승인된 칸마다 「이 칸만」 버튼이 있다',
    (await p.eval(`document.querySelectorAll('[data-t="step-run-one"]').length`)) === 2,
    `${await p.eval(`document.querySelectorAll('[data-t="step-run-one"]').length`)}개`);
  await p.eval(`[...document.querySelectorAll('[data-t="step-run-one"]')].pop().click()`);
  check('마지막 칸만 실행하면 커서가 그 칸 다음으로 옮겨진다 (순서를 건너뛸 수 있다)',
    !!(await p.waitFor(`[...document.querySelectorAll('[data-t="step-row"]')].every(r => !r.textContent.includes('지금 여기'))
      && [...document.querySelectorAll('[data-t="step-row"]')].filter(r => r.textContent.includes('끝남')).length === 2`, { timeoutMs: 8000 })),
    await p.eval(`[...document.querySelectorAll('[data-t="step-row"]')].map(r => r.textContent.trim()).join(' | ')`));
  await p.eval(`document.querySelector('[data-t="cursor-reset"]').click()`);
  await p.waitFor(`document.querySelector('[data-t="step-row"]').textContent.includes('지금 여기')`, { timeoutMs: 6000 });
  await setInput('[data-t="run-laps"] input', '2');
  const runAllLabel = await p.eval(`document.querySelector('[data-t="run-all"]')?.textContent`);
  check('버튼이 몇 바퀴 도는지 스스로 말한다', runAllLabel?.includes('2바퀴'), runAllLabel?.trim());
  // 자세를 일부러 옮겨 둔다 — 이미 목적지면 "이어서 갔다" 가 공허하다
  await p.eval(`[...document.querySelectorAll('[data-t="dock"] [data-t="jogrow"]')][0].querySelectorAll('button')[0].click()`);
  await p.waitFor(`Math.abs(${j1Now} - ${trayPickJ1 - 1}) < 0.01`, { timeoutMs: 8000 });
  await p.eval(`document.querySelector('[data-t="run-all"]').click()`);
  // **두 바퀴째를 눈으로 본다.** 끝 자세만 보면 1바퀴와 2바퀴가 구분되지 않는다
  check('두 바퀴째가 실제로 돈다 — 진행이 화면에 숫자로 나온다',
    !!(await p.waitFor(`document.querySelector('[data-t="run-progress"]')?.textContent.includes('2/2바퀴')`, { timeoutMs: 30000 })));
  check('도는 중에는 누를 것이 「그만」 하나다 (멈출 길이 화면에서 안 사라진다)',
    !!(await p.eval(`!!document.querySelector('[data-t="run-stop"]')`)));
  // 패널을 내려서 찍는다 — 「그만」과 진행 표시가 스크롤 아래에 있으면 증거 사진이
  // 무엇을 확인했는지 말하지 못한다 (그리퍼 손잡이 때와 같은 함정)
  await p.eval(`document.querySelector('.panelbox').scrollTop = 9999`);
  await p.screenshot(`${OUT}/fr5-program-loop.png`);
  check('연속 실행이 마지막 단계 자세로 끝난다 (사람이 매 칸 안 눌렀다)',
    !!(await p.waitFor(`Math.abs(${j1Now} - ${trayPutJ1}) < 0.05`, { timeoutMs: 30000 })),
    `j1 ${(trayPickJ1 - 1).toFixed(2)}→${trayPutJ1.toFixed(2)} (trayPut · 2바퀴 × 2단계)`);
  check('다 돌면 「그만」이 사라지고 끝났다고 말한다',
    !!(await p.waitFor(`!document.querySelector('[data-t="run-stop"]')
      && document.querySelector('[data-t="step-blocked"]')?.textContent.includes('마지막 단계까지 끝났어요')`, { timeoutMs: 10000 })));
  // **busy 가 풀리기를 기다린다.** 루프 직후에는 버튼이 `disabled` 라 클릭이 조용히 삼켜지고,
  // 그러면 뒤의 삭제 검사가 「확인 단계가 사라졌다」로 잘못 붉어진다 (2026-08-08 에 밟았다)
  await p.waitFor(`document.querySelector('[data-t="slot-delete"]')?.disabled === false`, { timeoutMs: 10000 });

  // 프로그램 삭제는 **한 번 더 묻는다** (2026-08-06 `/감사` P0 — 지점만 확인이 있었다).
  // 취소하면 슬롯이 그대로 남는 것까지 본다. 이 검사가 없으면 확인 단계가 조용히 사라진다
  await p.eval(`document.querySelector('[data-t="slot-delete"]').click()`);
  check('프로그램 삭제는 곧장 안 지운다 — 한 번 더 묻는다',
    !!(await p.waitFor(`!!document.querySelector('[data-t="slot-delete-ask"]')
      && document.querySelector('[data-t="slot-delete-confirm"]') !== null`, { timeoutMs: 4000 })));
  await p.eval(`document.querySelector('[data-t="slot-delete-cancel"]').click()`);
  check('취소하면 프로그램이 그대로 남는다',
    !!(await p.waitFor(`document.querySelector('[data-t="slot-delete-ask"]') === null
      && !!document.querySelector('[data-t="slot-row"]')`, { timeoutMs: 4000 })));

  await p.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === 'Teach').click()`);
  await p.waitFor(`!!document.querySelector('[data-t="teach"]')`, { timeoutMs: 5000 });
  await p.screenshot(`${OUT}/fr5-teach.png`);
  await p.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === 'Live').click()`);
  await p.waitFor(`!!document.querySelector('[data-t="gripper"]')`, { timeoutMs: 5000 });

  await p.eval(`document.querySelector('[data-t="safetybar"] [data-t="estop"]').click()`);
  await clickText('DISARM');
  check('DISARM → 서보 OFF 복귀',
    !!(await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('서보 OFF')`, { timeoutMs: 5000 })));
  await clickText('조종권 반납');
  await p.screenshot(`${OUT}/fr5-live-p2.png`);

  // 7. 브리지 재기동 → 웹이 스스로 다시 붙고 재연결 횟수가 남는다 (V0 AC)
  // 여기서도 그룹째 죽인다 — 안 그러면 옛 uvicorn 이 포트를 쥐고 있어 재기동이 실패한다
  killTree(bridge);
  await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('DISCONNECTED') || true`, { timeoutMs: 3000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  bridge = spawnBridge();
  if (!await waitUp(`http://127.0.0.1:${BRIDGE_PORT}/robots`)) throw new Error('브리지 재기동 실패');
  const reconn = await p.waitFor(`parseInt(document.querySelector('[data-t="ws-reconnects"]')?.textContent) >= 1 && document.querySelector('[data-t="ws-reconnects"]').textContent`, { timeoutMs: 15000 });
  check('브리지 재기동 → WS 자동 재연결 + 횟수 기록', !!reconn, `재연결 ${reconn}`);
  await p.eval(`(() => {
    const sel = document.querySelector('[data-t="diag"] select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'fr5-mock-a');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await p.eval(`document.querySelector('[data-t="diag"] button.primary')?.click()`);
  check('재연결 후 다시 OBSERVE_ONLY 진입',
    !!(await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('OBSERVE_ONLY')`, { timeoutMs: 5000 })));

  // 7. 해제 → 미연결 스냅샷으로 복귀
  await p.eval(`[...document.querySelectorAll('[data-t="diag"] button')].find(b => b.textContent.includes('연결 해제')).click()`);
  // **`—` 대신 「표 자체가 없다」를 본다** (2026-08-06 `/감사` UI/UX). 예전에는 끊긴 뒤에도
  // 관절·TCP 12행이 `—` 로 남아 첫 화면에서 제일 넓은 면적을 뜻 없는 대시가 먹었다. 지금은
  // `state.connected` 일 때만 그린다 — 옛 값이 남지 않는다는 원래 의도를 **더 세게** 만족한다.
  // 그 자리는 「지금 무엇을 하면 되나」(startguide)가 쓴다.
  check('disconnect → DISCONNECTED + 값 비움 (표를 안 그린다)',
    !!(await p.waitFor(`document.querySelector('[data-t="safetybar"]').textContent.includes('DISCONNECTED')
      && document.querySelector('[data-t="joints"]') === null
      && document.querySelector('[data-t="tcp"]') === null`, { timeoutMs: 5000 })));
  check('연결 전 시작 순서가 「로봇에 연결」을 짚는다',
    (await p.eval(`document.querySelector('[data-t="startguide"] li[data-at="true"]')?.textContent`)) === '로봇에 연결');
} catch (e) {
  check('실행 자체', false, String(e.message || e));
} finally {
  try { await p?.close?.(); } catch {}
  killTree(bridge);
  killTree(web);
  rmSync(DATA, { recursive: true, force: true });
}

const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
