// 시뮬 탭 실렌더 — **게이트가 이 탭을 한 번도 안 열어봤다** (2026-09-04 발견).
//
// `fr5-web-verify.mjs` 는 `nav button` 이 **4개**라고 단정하고 Live·Teach·Program 만 연다.
// 그런데 탭은 **다섯**이다 — 08-31 에 「시뮬」이 늘었는데 그 게이트가 안 따라왔다.
// 그래서 시뮬 탭이 **터져도 초록**이었다. 이 파일이 그 자리를 맡는다.
//
// ⛔ **저쪽 게이트를 고치지 않았다** — `=== 4` 를 손대면 그 99건이 통째로 흔들린다.
// 여기는 시뮬 탭만 열고 닫는 **작은 판**이라 저쪽과 독립이다.
//
// 무엇을 재나 — 「열린다」와 **「읽을 게 적다」** 둘이다. 뒤엣것이 없으면 다음 사람이
// 또 절마다 ⛔ 문구를 붙이고, 그건 09-03 에 실제로 일어난 일이다.
//
// ## ⛔ 이 초록은 **「배포된 것이 맞다」를 증명하지 않는다** (2026-09-04)
//
//     node scripts/check/sim-tab.mjs                       소스 (스스로 띄운 vite)
//     node scripts/check/sim-tab.mjs --url http://<호스트>:5055/   **실제로 나가는 화면**
//
// 오늘 실기 담당자가 *"윈도우엔 거치대 바구니 시뮬밖에 없는데"* 라고 하셨는데 이 게이트는
// 10/10 초록이었다. 둘 다 참이었다 — 게이트는 **로컬 vite** 를 봤고, 원격 번들에는 값이
// 들어가 있었으며, 실기 담당자 탭이 **옛 번들을 물고** 있었다. 셋을 못 가른 이유는 하나다:
// **계측기가 사람이 보는 것을 안 봤다.**
//
// ⚠ 기본은 로컬로 둔다 — 게이트는 로봇 없이도 돌아야 한다(`all.sh` 는 실기가 꺼진
//   기계에서도 초록이어야 한다). `--url` 은 **배포 직후 사람이 한 번** 부르는 칸이다.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// **레포 상대 경로다** — 절대 경로로 박으면 남의 기계에서 죽는다 (fr5-web-verify 와 같은 이유)
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openPage, pixelChanged } from './lib/cdp-harness.mjs';
// 후보 개수의 정본은 데이터다 — 게이트가 숫자를 따로 들지 않는다 (하드 룰 5)
import { AMR_HOME, AMR_DROP, AMR_ARRIVE_ERR_MM } from '../../Shared/data/workcell.js';
import { AMR_WHEEL_R_MM } from '../../Shared/data/layout/catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const REMOTE = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : null;
const BP = 5158, URL = REMOTE ?? 'http://localhost:5176/';
const DATA = mkdtempSync(join(tmpdir(), 'simux-'));
const killTree = (c) => { try { process.kill(-c.pid, 'SIGKILL'); } catch {} };
const bridge = REMOTE ? null : spawn('uv', ['run', '--with', 'fastapi', '--with', 'uvicorn[standard]', '--with', 'pyyaml',
  'uvicorn', 'main:app', '--port', String(BP)],
  { cwd: join(ROOT, 'FR5/bridge'), stdio: 'ignore', detached: true,
    env: { ...process.env, FR5_DATA_DIR: DATA, FR5_TB_HOST: '' /* 조건 27 끔 — 게이트는 터틀봇 없는 기계에서도 초록이어야 한다 */ } });
const web = REMOTE ? null : spawn('npm', ['run', 'dev:fr5'], { cwd: ROOT, stdio: 'ignore', detached: true,
  env: { ...process.env, FR5_PORT: String(BP) } });
process.on('exit', () => {
  if (bridge) killTree(bridge);
  if (web) killTree(web);
  rmSync(DATA, { recursive: true, force: true });
});
const up = async (u) => { for (let i = 0; i < 150; i++) { if (await fetch(u).then(r => r.ok).catch(() => false)) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
if (!REMOTE && !await up(`http://localhost:${BP}/robots`)) { console.log('FAIL 브리지가 안 떴다'); process.exit(1); }
if (!await up(URL)) { console.log(`FAIL ${REMOTE ? '그 주소가 안 뜬다' : 'vite 가 안 떴다'} — ${URL}`); process.exit(1); }
if (REMOTE) console.log(`== 배포된 화면을 본다 — ${URL} ==`);
// ⛔ **목업에 붙여 둔다** — 「따라가기」 스위치는 `disabled={!state.connected}` 라
// 미연결이면 눌러도 아무 일이 없다. 그 상태로 「눌리나」를 재면 영영 false 다.
// 실기가 없는 기계에서도 **조작이 도는지**를 보려면 목업이 그 자리를 맡아야 한다.
if (!REMOTE) {
  await fetch(`http://localhost:${BP}/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // **실기 좌표계를 빌린 목업**이다 (2026-09-06 · `fr5-mock-lab`). 시뮬 탭은 user1 좌표로 `/ik` 를 묻는데
    // `fr5-mock-a` 는 좌표계가 없어 base 로 읽혀 9칸이 전부 「해가 없다」였다 — 그러면 사이클을 못 잰다
    body: JSON.stringify({ robotId: 'fr5-mock-lab', observeOnly: true }),
  }).catch(() => {});
}

const out = [];
const check = (n, ok, d = '') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const p = await openPage(URL);
try {
  await p.waitFor(`document.querySelectorAll('nav button').length >= 5`, { timeoutMs: 15000 });
  check('시뮬 탭이 nav 에 있다',
    !!(await p.eval(`[...document.querySelectorAll('nav button')].some(b => b.textContent === '시뮬레이션')`)));
  await p.eval(`[...document.querySelectorAll('nav button')].find(b => b.textContent === '시뮬레이션').click()`);
  const ok = await p.waitFor(`!!document.querySelector('[data-t="sim-cycle"]')`, { timeoutMs: 8000 });
  check('시뮬 탭이 열린다 (터지지 않는다)', !!ok);
  check('머리가 「①② 는 화면에서만 · ③ 에서만 실기」라고 말한다 (접혀도 보인다)',
    (await p.eval(`document.querySelector('[data-t="sim-cycle-note"]')?.textContent`))?.includes('화면에서만'));
  // ── 4단 마법사 (2026-09-07 · D194) — 질문 하나 · 큰 버튼 하나 · 결과 한 문장. 단계 넷 중 **하나만 보인다**(나머지는 hidden · DOM 엔 있다)
  check('단계 표시 넷이 있고 ① 이 켜져 있다', (await p.eval(`document.querySelectorAll('[data-t="sim-wizard"] button').length === 4 && document.querySelector('[data-t="sim-stage-1"]')?.getAttribute('aria-current') === 'step'`)) === true);
  check('단계 내용 넷 중 하나만 보인다 (나머지는 hidden)', (await p.eval(`[...document.querySelectorAll('[data-t="sim-stage"]')].filter(s => !s.hidden).length`)) === 1);
  check('② ③ 은 앞 단계가 끝나기 전엔 눌리지 않는다', (await p.eval(`document.querySelector('[data-t="sim-stage-2"]').disabled && document.querySelector('[data-t="sim-stage-3"]').disabled`)) === true);
  check('① 의 큰 버튼은 「거치대 찾기」 하나다', (await p.eval(`[...document.querySelectorAll('[data-t="sim-stage"][data-n="1"] button.big')].map(b => b.textContent).join('|')`)).includes('거치대 찾기'));
  const visibleCtl = await p.eval(`[...document.querySelectorAll('[data-t="sim-cycle"] button, [data-t="sim-cycle"] select, [data-t="sim-cycle"] input')].filter(e => e.offsetParent !== null && !e.closest('details:not([open])')).length`);
  check('기본 화면의 조작 요소가 8개 이하다 (중학생 기준 — 실험 장치는 「자세히」 안)', visibleCtl <= 8, `지금 ${visibleCtl}개`);
  // ── 탭 재구성 (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 5) — 절은 둘뿐이다: 입력+9칸(세 층 답) · 사이클.
  //    「따라간다」 절은 3D 좌상단 스위치 하나로 돌아갔고, 관측 후보는 사이클 관측 칸에 흡수, 되감기는 터틀봇 탭으로 갔다.
  //    지운 게 아니라 옮긴 것이므로 **옮겨간 자리에 살아 있는지**까지 본다(3D 스위치 · 터틀봇 탭은 맨 끝에서).
  check('맨 위가 「컨베이어 한 사이클」 절이다 — 탭이 답하는 질문이 먼저다',
    (await p.eval(`document.querySelector('.sim > *')?.dataset.t`)) === 'sim-cycle');
  check('시뮬 탭에 따라가기·관측 후보·되감기 절이 없다 (옮겼다)',
    (await p.eval(`['sim-follow', 'sim-view', 'sim-runs', 'sim-why', 'sim-carrier'].filter((k) => document.querySelector('[data-t="' + k + '"]')).join(',')`)) === '');
  check('절이 하나다 — 입력 · 세 층 답 · 사이클(구간 목록이 9칸을 품는다)',
    (await p.eval(`[...document.querySelectorAll('.sim > [data-t]')].map((e) => e.dataset.t).join(',')`)) === 'sim-cycle');
  // 따라가기는 3D 스위치 **하나**가 주인이다 — 있는 것과 도는 것은 다르므로 눌러서 바뀌는지까지 본다.
  // 스위치는 `disabled={!state.connected}` 라 WebSocket 첫 판을 기다린다(2026-09-04 실측: 원격이 한 박자 늦어 게이트가 자기 경합을 결함으로 보고했다)
  await p.waitFor(`document.querySelector('[data-t="followsim"] button')?.disabled === false`, { timeoutMs: 15000 });
  await p.eval(`document.querySelector('[data-t="followsim"] button').click()`);
  const followOn = await p.waitFor(`document.querySelector('[data-t="followsim"] button')?.getAttribute('aria-pressed') === 'true'`, { timeoutMs: 5000 });
  check('3D 좌상단 「따라가기」 스위치가 살아 있고 눌리면 켜진다', followOn);
  await p.eval(`document.querySelector('[data-t="followsim"] button').click()`);
  check('풀기 전엔 답 줄이 없다 — 0/9 를 초록으로 그리지 않는다', !(await p.eval(`!!document.querySelector('[data-t="sim-answer"]')`)));
  const hints = await p.eval(`[...document.querySelectorAll('[data-t="sim-cycle"] .hint, [data-t="sim-cycle"] .sentence')].filter(e => e.offsetParent !== null && !e.closest('details:not([open])')).length`);
  check('기본 화면의 설명 문단이 3개 이하다 (보이는 것만)', hints <= 3, `지금 ${hints}개`);
  check('9칸이 다 있다',
    (await p.eval(`document.querySelectorAll('[data-t="sim-cycle"] ol.steps li').length`)) === 9);
  check('⑨ 빠져나온다가 있다',
    !!(await p.eval(`document.querySelector('[data-t="sim-cycle"] ol.steps').textContent.includes('빠져나온다')`)));
  // ── 컨베이어 한 사이클 (2026-09-06 · `GRILL-conveyor-twin`) — **풀고, 돌리고, 그림이 바뀌는지**까지 본다.
  // 9칸은 컨트롤러(여기서는 mock 의 URDF IK)에 묻는다 — 붙은 뒤에만 눌린다.
  // ── 2단 조준 (2026-09-07 · D192 · `plan/LAB-STEP-TEST-PLAN.md` Phase 0) — ⓐ 대강 → ⓑ 거울 쌍 자세 → ⓒⓓ 스캔 → ⓔ 융합.
  //    목업 스캔은 **툴 프레임 고정 편향**(12, −8)을 진값에 얹으므로 한 뷰는 14.4mm 틀리고, rz±90 두 뷰의 평균은 진값이어야 한다.
  //    첫 패스는 「고정인지 모른다 → 한 번 더」, 둘째 패스는 평균 일치(0.00mm) → 통과 → 9칸이 그 자리로. 버튼 순서가 강제되는지(뒤 칸 비활성)도 본다
  const aimBtn = (k) => `document.querySelector('[data-t="sim-aim-${k}"]')`;
  check('2단 조준 블록이 사이클 절 안에 있다 (절은 그대로 하나)', (await p.eval(`!!document.querySelector('[data-t="sim-cycle"] [data-t="sim-aim"]')`)) === true);
  check('앞 칸 없이 뒤 칸은 눌리지 않는다 (ⓑ~ⓔ 비활성)', await p.eval(`['b','c','d','e'].every(k => ${'document.querySelector(`[data-t="sim-aim-${k}"]`)'}?.disabled === true)`));
  const aimStep = async (k, readyK, ms = 15000) => { await p.waitFor(`${aimBtn(k)}?.disabled === false`, { timeoutMs: ms }); await p.eval(`${aimBtn(k)}.click()`); if (readyK) await p.waitFor(`${aimBtn(readyK)}?.disabled === false`, { timeoutMs: ms }); };
  await aimStep('a', 'b');
  const coarse = await p.eval(`document.querySelector('[data-t="sim-aim-coarse"]')?.textContent ?? ''`);
  check('ⓐ 대강값이 출처를 말한다 (목업 = 08-31 정본을 중심으로 되돌린 것)', /출처 truth-0831/.test(coarse), coarse.slice(0, 70));
  await aimStep('b', 'c', 30000);
  const posesTxt = await p.eval(`document.querySelector('[data-t="sim-aim-coarse"]')?.textContent ?? ''`);
  check('ⓑ 거울 쌍 두 자세가 둘 다 닿는다 (rz 가 180° 차)', /자세 A rz .*✓.* \/ B rz .*✓/.test(posesTxt), posesTxt.slice(-80));
  const rzs = JSON.parse(await p.eval(`JSON.stringify([window.__aim?.poses?.rzA, window.__aim?.poses?.rzB])`));
  check('두 자세의 손목 요각 차가 180°±0.5', Math.abs(Math.abs(((rzs[0] - rzs[1]) % 360 + 540) % 360 - 180) - 0) < 0.5 || Math.abs(Math.abs(rzs[0] - rzs[1]) - 180) < 0.5, `${rzs}`);
  await aimStep('c', 'd'); await aimStep('d', 'e'); await aimStep('e', null);
  await new Promise((r) => setTimeout(r, 400));
  const note1 = await p.eval(`document.querySelector('[data-t="sim-aim-note"]')?.textContent ?? ''`);
  const pass2 = await p.eval(`document.querySelector('[data-t="sim-aim"]')?.dataset.pass`);
  check('첫 패스 — 편향 14.4mm 를 보고 「한 번 더」로 돌려보낸다 (고정인지 모르므로 통과시키지 않는다)', /한 번 더/.test(note1) && pass2 === '2', note1.slice(0, 80));
  await aimStep('b', 'c', 30000); await aimStep('c', 'd'); await aimStep('d', 'e'); await aimStep('e', null);
  const fusedOk = await p.waitFor(`document.querySelector('[data-t="sim-aim-fused"]')?.dataset.ok === 'true'`, { timeoutMs: 8000 });
  const fusedTxt = await p.eval(`document.querySelector('[data-t="sim-aim-fused"]')?.textContent ?? ''`);
  check('둘째 패스 — 두 패스의 평균이 일치해 통과 (고정 편향이라 지워졌다)', fusedOk && /두 패스 차 0\.00mm/.test(fusedTxt), fusedTxt.slice(0, 120));
  const fused = JSON.parse(await p.eval(`JSON.stringify(window.__aim?.fused ?? null)`));
  const coarseTruth = JSON.parse(await p.eval(`JSON.stringify(window.__aim?.coarse?.user1Mm ?? null)`));
  check('융합 자리가 진값(대강값)과 0.1mm 안 — 단일 뷰는 편향 14.4mm 만큼 틀렸다', !!fused && Math.hypot(fused.user1Mm[0] - coarseTruth[0], fused.user1Mm[1] - coarseTruth[1]) < 0.1 && fused.halfDiffMm > 10,
    fused ? `융합 (${fused.user1Mm[0].toFixed(1)}, ${fused.user1Mm[1].toFixed(1)}) · 편향 ${fused.halfDiffMm}` : '융합 없음');
  check('통과한 융합값이 9칸 입력으로 흐른다 (거치대 자리는 융합값)', (await p.eval(`!!document.querySelector('[data-t="sim-aimed-carrier"]')`)) === true);
  // 트윈 — 카메라가 본(융합) 거치대는 **분홍·실측**으로 서고(D128 불투명=실기), 조준이 세운 고스트는 9칸 재생성에도 남는다(고스트 주인 규칙 · 2026-09-07)
  const cm = await p.waitFor(`window.__carrierMm && window.__carrierMm.src === 'seen' && window.__carrierMm.paint === 'pink'`, { timeoutMs: 6000 });
  check('트윈의 거치대가 카메라가 본 자리에 분홍(실측)으로 선다', cm, JSON.stringify(await p.eval(`window.__carrierMm && { src: window.__carrierMm.src, paint: window.__carrierMm.paint }`)));
  check('찾기가 끝난 뒤에도 조준 고스트(자세 B)가 남아 있다', (await p.eval(`!!window.__ghostTcpMm`)) === true);
  // ① 이 끝나면 ② 로 스스로 넘어가고 큰 버튼은 「계획 세우기」 하나
  const stage2 = await p.waitFor(`document.querySelector('[data-t="sim-stage-2"]')?.getAttribute('aria-current') === 'step'`, { timeoutMs: 5000 });
  check('① 이 끝나면 ② 로 스스로 넘어간다', stage2);
  const solveBtn = `document.querySelector('[data-t="sim-plan"]')`;
  await p.waitFor(`${solveBtn}?.disabled === false`, { timeoutMs: 15000 });
  await p.eval(`${solveBtn}.click()`);
  const solvedOk = await p.waitFor(`!!document.querySelector('[data-t="sim-score"]')`, { timeoutMs: 60000 });
  const score = await p.eval(`document.querySelector('[data-t="sim-score"]')?.textContent ?? ''`);
  check('9칸이 풀린다 (mock URDF IK · user1 좌표계)', solvedOk && /닿는 자세 9\/9/.test(score), score.slice(0, 40));
  // 둘째 층 — 부딪히나. 브라우저 무조코가 9칸 사이 길을 재고 요약 한 줄을 낸다. 장면(`/sim/scene`)이 있으면 숫자, 없으면 사유
  // 「재는 중…」은 답이 아니다 — 엔진(9.7MB)을 받고 표본을 다 돌 때까지 기다린다(부하에서 수십 초)
  const contactOk = await p.waitFor(`(() => { const s = document.querySelector('[data-t="sim-contact"]')?.textContent ?? ''; return /접촉/.test(s) && !/재는 중/.test(s); })()`, { timeoutMs: 120000 });
  const contactTxt = await p.eval(`document.querySelector('[data-t="sim-contact"]')?.textContent ?? ''`);
  check('접촉 층이 답한다 (숫자 또는 못 재는 사유)', contactOk, contactTxt.slice(0, 90));
  // ── 정차 자리는 사이클이 고른다 (phase 2) — 후보 7 을 전부 평가하고 우선순위로 하나. **개수·선택을 박지 않는다** — 되는 자리가
  // 0 이어도 답이다(2026-09-06 실측: 채택값은 거치대 자리와 4.4mm 겹치고, 홈 근처 6 은 팔·카메라가 옆 판·바구니에 5~68mm 파고든다)
  await p.waitFor(`Array.isArray(window.__stopEvals)`, { timeoutMs: 240000 });
  const evals = JSON.parse(await p.eval(`JSON.stringify(window.__stopEvals ?? [])`));
  check('정차 후보 전부를 평가한다 (닿나·접촉·시간·뻗음)', evals.length >= 2 && evals.every((e) => typeof e.reachable === 'boolean' && typeof e.contactLegs === 'number' && (e.dwellSec === null || Number.isFinite(e.dwellSec))),
    `후보 ${evals.length} · 닿음 ${evals.filter((e) => e.reachable).length} · 접촉 없는 자리 ${evals.filter((e) => e.reachable && !e.contactLegs).length}`);
  check('접촉이 있는 후보는 어느 구간·무엇·얼마나 파고드는지 든다', evals.filter((e) => e.contactLegs).every((e) => e.hits.length && /−\d+\.\dmm/.test(e.hits[0])),
    (evals.find((e) => e.contactLegs)?.hits[0] ?? '').slice(0, 100));
  const stopWhy = await p.eval(`document.querySelector('[data-t="sim-stop-why"]')?.textContent ?? ''`);
  check('정차 자리 한 줄이 「고른 이유」거나 「되는 자리가 없다」로 말한다', /제일 (빠름|덜 뻗음)|되는 정차 자리가 없어요/.test(stopWhy), stopWhy.slice(0, 110));
  const optTexts = await p.eval(`[...document.querySelectorAll('[data-t="sim-stop"] select option')].map(o => o.textContent).join('|')`);
  check('드롭다운이 후보마다 판정 꼬리표(✗·💥·초)를 단다', optTexts.split('|').length === evals.length && evals.every((e, i) => new RegExp(e.reachable ? (e.contactLegs ? '💥' : '\\d+s') : '✗').test(optTexts.split('|')[i])), optTexts.slice(0, 120));
  await p.eval(`[...document.querySelectorAll('[data-t="sim-stop"] button')].find(b => b.textContent === '덜 뻗게').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const afterStop = await p.eval(`document.querySelector('[data-t="sim-stop-why"]')?.textContent ?? ''`);
  check('우선순위를 바꿔도 다시 풀지 않고 즉시 답한다', /제일 (빠름|덜 뻗음)|되는 정차 자리가 없어요/.test(afterStop) && !/평가 중/.test(afterStop), afterStop.slice(0, 90));
  await p.eval(`[...document.querySelectorAll('[data-t="sim-stop"] button')].find(b => b.textContent === '빠르게').click()`);
  await new Promise((r) => setTimeout(r, 300));
  check('사이클 절이 있고 재생 버튼이 선다 (9칸이 다 풀렸다는 뜻)',
    (await p.eval(`!!document.querySelector('[data-t="sim-cycle"] [data-t="sim-cycle-play"]')`)) === true);
  // ② 신호등 셋 — 닿아요 초록 · 부딪히나(숫자 또는 사유) · 안전장치(목업은 빨강 + 「랩에서 ARM 하면」) → ③ 으로 스스로 넘어가고 「다음 칸 ▶」이 한 칸씩 보낸다
  const lightsOk = JSON.parse(await p.eval(`JSON.stringify([...document.querySelectorAll('[data-t="sim-lights"] li')].map(l => [l.dataset.t, l.dataset.ok, l.textContent.slice(0, 60)]))`));
  check('② 신호등 셋 — 닿아요 초록 · 안전장치는 사람 말로 왜 빨간지 말한다', lightsOk.length === 3 && lightsOk[0][1] === 'true' && /ARM|안전장치/.test(lightsOk[2][2]), JSON.stringify(lightsOk).slice(0, 160));
  const stage3 = await p.waitFor(`document.querySelector('[data-t="sim-stage-3"]')?.getAttribute('aria-current') === 'step'`, { timeoutMs: 5000 });
  check('계획이 초록이면 ③ 으로 스스로 넘어간다', stage3);
  const next0 = await p.eval(`document.querySelector('[data-t="sim-next"]')?.textContent ?? ''`);
  check('③ 의 큰 버튼이 「다음 칸 ▶ + 칸 이름」이고 정지 버튼이 옆에 있다', /다음 칸/.test(next0) && !!(await p.eval(`!!document.querySelector('[data-t="sim-stop-btn"]')`)), next0.slice(0, 40));
  check('③ 준비 줄(조종권·ARM·자동·전역 속도)은 실기에서만 — 목업엔 없다', (await p.eval(`!document.querySelector('[data-t="sim-ready"]')`)) === true);
  await p.eval(`document.querySelector('[data-t="sim-next"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const next1 = await p.eval(`document.querySelector('[data-t="sim-next-status"]')?.textContent ?? ''`);
  check('「다음 칸」을 누르면 한 칸 나아가고 지난 칸을 말한다 (목업은 기록만)', /2\/\d+/.test(next1) && /지난 칸/.test(next1), next1.slice(0, 80));
  // ── 한 칸 실기로 (2026-09-07 · D191) — 팔 구간마다 「실기」 버튼. 목업이면 **안 보내고 기록만**. 기록은 브리지 `/runs` 한 줄
  const goN = await p.eval(`document.querySelectorAll('[data-t="sim-go-step"]').length`);
  const armN = await p.eval(`(window.__cycleActs ?? []).filter(a => a.nextJ).length`);
  check('팔 구간마다 「실기」 버튼이 있다 (주행 구간엔 없다)', goN > 0 && goN === armN, `버튼 ${goN} · 팔 구간 ${armN}`);
  check('목업 프로필이면 버튼이 「기록만」이라 말한다', await p.eval(`document.querySelector('[data-t="sim-go-confirm"]')?.dataset.mock === 'true' && /기록만/.test(document.querySelector('[data-t="sim-go-step"]')?.textContent ?? '')`));
  await p.eval(`document.querySelectorAll('[data-t="sim-go-step"]')[1].click()`);
  await new Promise((r) => setTimeout(r, 600));
  if (!REMOTE) {
    const runs = await fetch(`http://localhost:${BP}/runs`).then((r) => r.json()).catch(() => []);
    const last = runs[runs.length - 1];
    const doc = last ? await fetch(`http://localhost:${BP}/runs/${last.runId}`).then((r) => r.json()) : null;
    const steps = (doc?.lines ?? []).map((l) => l.step);
    check('버튼 한 번 = 기록 한 줄 — ⓐ~ⓔ 두 패스·풀기·실기가 전부 장부에 있다', steps.includes('aim-a') && steps.filter((s) => s === 'aim-e').length === 2 && steps.includes('solve') && steps.includes('go'),
      `${last?.runId} · ${steps.length}줄 · ${[...new Set(steps)].join(',')}`);
    const go = (doc?.lines ?? []).find((l) => l.step === 'go' && !l.drive);   // 「다음 칸」의 첫 칸은 터틀봇 주행(drive) 줄이라 해가 없다 — 팔 칸을 본다
    check('목업 실기 줄은 sent=null · mock=true · 해(관절각)와 readback 을 든다', !!go && go.sent === null && go.mock === true && Array.isArray(go.solved?.jointsDeg) && !!go.readback,
      go ? JSON.stringify({ sent: go.sent, mock: go.mock, j: go.solved?.jointsDeg?.length }) : '줄 없음');
    const scanLine = (doc?.lines ?? []).find((l) => l.step === 'aim-scan-a');
    check('스캔 줄이 원값(자세 rz · user1 · source)을 그대로 든다', !!scanLine?.scan?.user1Mm && scanLine.scan.source === 'mock' && Number.isFinite(scanLine.scan.rzDeg));
  }
  await p.eval(`document.querySelector('[data-t="sim-log"]')?.setAttribute('open', ''); document.querySelector('[data-t="sim-log-refresh"]')?.click()`);
  const logOk = await p.waitFor(`document.querySelectorAll('[data-t="sim-log-lines"] li').length >= 10`, { timeoutMs: 8000 });
  check('기록 절이 장부를 되감는다 (줄 10개 이상 · 줄을 누르면 그때 자세)', logOk, String(await p.eval(`document.querySelectorAll('[data-t="sim-log-lines"] li').length`)));
  const shotDir = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : DATA;
  // **3D 캔버스만 잘라 비교한다** — 전체 화면이면 옆 패널의 「N초 전」 텍스트만 바뀌어도 「3D 가 바뀌었다」로 통과한다 (감사 2026-09-06 ④-1)
  const twinRect = await p.rect('[data-t="twin"]');
  check('3D 캔버스가 있다 (클립 대상)', !!twinRect && twinRect.width > 100);
  const shot0 = await p.screenshot(join(shotDir, 'sim-cycle-0.png'), twinRect ?? undefined);
  await p.eval(`document.querySelector('[data-t="sim-cycle-play"]').click()`);
  // 배속 5 · 첫 구간(홈→정차 1.7초)이 지나 팔이 움직이는 구간까지 기다린다
  const moved = await p.waitFor(
    `/^(\\d+)\\/\\d+/.test(document.querySelector('[data-t="sim-cycle-cur"]')?.textContent ?? '') && Number(RegExp.$1) >= 3`,
    { timeoutMs: 30000 });
  const cur = await p.eval(`document.querySelector('[data-t="sim-cycle-cur"]')?.textContent ?? ''`);
  check('사이클이 돈다 — 구간이 넘어간다', moved, cur.slice(0, 60));
  const shot1 = await p.screenshot(join(shotDir, 'sim-cycle-1.png'), twinRect ?? undefined);
  check('3D 캔버스 픽셀이 실제로 바뀐다 (터틀봇·팔이 움직였다)', pixelChanged(shot0, shot1));
  // 바퀴 — 홈→정차 200mm 를 굴렀으면 반지름 33 으로 **6.06 rad** 돌아 있어야 한다 (`burger.js` `rollWheels`).
  // 구간 3 이상이면 첫 주행이 끝났다. 값이 null 이면 GLB 에 바퀴 노드가 없다(옛 한 덩어리).
  // 도착 오차 유령 — 첫 주행(홈→정차)이 끝난 뒤라 명령 자리와 실측 오차(37.5mm)만큼 벌어져 있어야 한다
  const driftMm = await p.eval(`window.__amrDriftMm ?? null`);
  check('도착 오차 유령이 명령 자리에서 실측 37.5mm 벌어져 선다', driftMm !== null && Math.abs(driftMm - AMR_ARRIVE_ERR_MM) < 1,
    driftMm === null ? '유령 없음' : `${driftMm.toFixed(1)}mm`);
  check('홈 두 후보(정본 실선 · 손목 뎁스 점선)가 바닥에 그려진다',
    (await p.eval(`window.__amrHomeCandidates ?? 0`)) === 2);
  const wheelRad = await p.eval(`window.__amrWheelRad ?? null`);
  // 실물 메시는 **실제로 선 자리**에 선다(2026-09-06 · 명령 자리는 회색 상자) — 바퀴는 실제로 간 거리(200 − 도착 오차 37.5)만큼 돈다
  const wantRad = (Math.abs(AMR_HOME.xMm - AMR_DROP.xMm) - AMR_ARRIVE_ERR_MM) / AMR_WHEEL_R_MM;
  // 부호까지 본다 — 앞으로 굴렀으면 `wheelSign` −1 이라 **음수**여야 한다. 크기만 보면 거꾸로 도는 바퀴도 통과한다 (감사 ④-2)
  check('바퀴가 실제로 굴러간 거리만큼 앞으로 돈다 ((200 − 37.5)mm ÷ 33 = −4.92 rad)',
    wheelRad !== null && Math.abs(wheelRad - (-wantRad)) < 0.05,
    wheelRad === null ? '바퀴 노드 없음' : `${wheelRad.toFixed(2)} rad · 기대 ${(-wantRad).toFixed(2)}`);
  // ── 관측 칸 둘 (phase 3) — 「거치대를 본다」「터틀봇을 본다」가 사이클에 있고, 터틀봇 관측 칸에서는 손목 뎁스 발자국이 **초록**이어야 한다
  //    (라이다 윗면을 시선각 20°·거리 300 에서 본다 → 깊이 195~1000 안 · 발자국 안). 시각은 훅으로 옮긴다
  const acts = JSON.parse(await p.eval(`JSON.stringify(window.__cycleActs ?? [])`));
  const oC = acts.find((a) => a.id === 'o-carrier'); const oA = acts.find((a) => a.id === 'o-amr');
  check('사이클에 관측 칸 둘이 있다 (⓪ 거치대를 본다 · ⑩ 터틀봇을 본다)', !!oC && !!oA, `구간 ${acts.length}`);
  if (oA) {
    await p.eval(`window.__depthSees = null; window.__cycleSeek(${oA.t0Ms + Math.floor(oA.durMs / 2)})`);
    const seesAmr = await p.waitFor(`window.__depthSees && window.__depthSees.ok === true`, { timeoutMs: 15000 });
    check('⑩ 터틀봇을 본다 — 손목 뎁스 발자국이 초록(보인다 · 깊이 195~1000)', seesAmr,
      await p.eval(`JSON.stringify(window.__depthSees ?? null)`).then((s) => s.slice(0, 100)));
  }
  await p.eval(`document.querySelector('[data-t="sim-cycle-off"]').click()`);
  const nRows = await p.eval(`document.querySelectorAll('[data-t="sim-cycle"] ol.steps li').length`);
  check('사이클을 꺼도 구간 목록은 그대로다 — 9칸+관측+내리기 (데이터 개수와 같다)', nRows === (await p.eval(`window.__cycleActs?.length ?? -1`)) && nRows >= 9, `${nRows}`);
  // 손목 뎁스 발자국 — 9칸 ⑥ 「바구니 위」에서는 팔이 라이다보다 **낮아** 카메라 뒤(또는 Min-Z 안)가 정답이다.
  // 발자국이 고스트 손끝을 따라가야 이 값이 나온다(실물 자세면 발자국이 딴 데 있다) — 그걸 재는 검사다.
  // 클릭의 **인과**를 잰다 — 옛 값을 먼저 지우고, 클릭 뒤에 새 값이 생기는지 본다 (감사 ④-3). 부하에서 rAF 가 늦어 15초
  // ⛔ 풀린 사이클 위에서만 뜻이 있다 — 해가 없으면 버튼이 죽어 있고 발자국은 **실물** 자세 것이라 값이 나와도 남의 것이다 (2026-09-06: 입력 되돌리기 뒤로 밀려 그렇게 통과한 적 있다)
  check('⑥ 검사 전제 — 풀린 사이클이 살아 있다', !!(await p.eval(`!!window.__cycleActs`)));
  await p.eval(`window.__depthSees = null`);
  await p.eval(`[...document.querySelectorAll('[data-t="sim-cycle"] ol.steps li button')].find(b => b.textContent.includes('바구니 위')).click()`);
  const seesOk = await p.waitFor(`window.__depthSees && window.__depthSees.ok === false && /(뒤|가깝)/.test(window.__depthSees.why ?? '')`, { timeoutMs: 15000 });
  const sees = await p.eval(`JSON.stringify(window.__depthSees ?? null)`);
  check('⑥ 바구니 위에서 손목 뎁스는 터틀봇을 못 본다 — 카메라 뒤/너무 가깝다 (고스트 손끝 기준)', seesOk, sees.slice(0, 100));
  // 거치대가 손에 붙어 있나 — ② 무는 자세 끝(판 위 · 숫자)과 ③ 문다 끝(손 안 · 고스트 손끝 FK)의 자리가 같아야 하고(붙는 순간 안 뛴다),
  // ⑤ 터틀봇 위로 **중간**(팔이 관절 보간으로 돌아가는 동안)에도 손끝과의 거리가 ③ 때와 같아야 한다 (2026-09-06 실기 담당자 「물고 있는 상태로 이동하지 않는다」)
  const actEnd = async (id, frac = 1) => { const o = JSON.parse(await p.eval(`JSON.stringify(window.__cycleActs.find((x) => x.id === '${id}'))`)); await p.eval(`window.__cycleSeek(${Math.round(o.t0Ms + o.durMs * frac) - 1})`); await new Promise((r) => setTimeout(r, 400)); return JSON.parse(await p.eval(`JSON.stringify({ c: window.__carrierMm ?? null, h: window.__ghostTcpMm ?? null })`)); };   // h.headingDeg = 툴 x축 요각
  const gap = (r) => (r.c && r.h ? Math.hypot(r.c.x - r.h.x, r.c.y - r.h.y, r.c.z - r.h.z) : NaN);
  const cGrasp = await actEnd('grasp'); const cClose = await actEnd('close'); const cCarry = await actEnd('carry', 0.5);
  const d23 = cGrasp.c && cClose.c ? Math.hypot(cGrasp.c.x - cClose.c.x, cGrasp.c.y - cClose.c.y, cGrasp.c.z - cClose.c.z) : NaN;
  check('③ 문다 순간 거치대가 뛰지 않는다 — 판 위 숫자와 손끝 FK 가 같은 자리 (3mm)', d23 < 3 && cClose.c?.src === 'hand', `${d23.toFixed(1)}mm · ${cGrasp.c?.src}→${cClose.c?.src}`);
  const g3 = gap(cClose); const g5 = gap(cCarry);
  check('⑤ 옮기는 중간(관절 보간 중)에도 거치대와 손끝의 거리가 ③ 때와 같다 (2mm)', cCarry.c?.src === 'hand' && Math.abs(g5 - g3) < 2, `③ ${g3.toFixed(1)} · ⑤중간 ${g5.toFixed(1)}mm`);
  // 손목이 도는 정차 후보(요각 270 · 홈 180)로 바꾸면 거치대 요각도 **손끝 x축 요각과 같은 각**만큼 돈다 — 채택 후보는 손목이 안 돌아 이 길이 안 보인다
  const turnIdx = await p.eval(`[...document.querySelector('select[aria-label="정차 자리 바꾸기"]').options].findIndex((o) => o.textContent.startsWith('270'))`);
  await p.eval(`(() => { const s = document.querySelector('select[aria-label="정차 자리 바꾸기"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${turnIdx}'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await new Promise((r) => setTimeout(r, 400));
  const tLift = await actEnd('lift'); const tCarry = await actEnd('carry');
  const wrap = (a) => ((a % 360) + 540) % 360 - 180;
  const dHead = wrap(tCarry.h.headingDeg - tLift.h.headingDeg);
  const dYaw = wrap(tCarry.c.yawDeg - tLift.c.yawDeg);
  check('손목이 도는 정차 후보에선 거치대 요각이 손끝 요각과 같은 각만큼 돈다 (1° · 45° 넘게)', turnIdx >= 0 && Math.abs(dYaw) > 45 && Math.abs(wrap(dYaw - dHead)) < 1, `후보 ${turnIdx} · 손끝 ${dHead.toFixed(1)}° · 거치대 ${dYaw.toFixed(1)}°`);
  await p.eval(`(() => { const s = document.querySelector('select[aria-label="정차 자리 바꾸기"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '0'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await new Promise((r) => setTimeout(r, 400));
  // ⑩ 관측 반영 — 켜면 내리기 ⑪(u-reach)에서 손끝이 **실제 바구니 속** 거치대에 닿는다(③ 때 거리와 같다). 끄면(열린 루프) 팔은 명령 자리로 가고
  // 거치대는 실제 바구니에 있어 도착 오차(37.5mm)만큼 빗나간다 — 「카메라가 없으면 이만큼」이 숫자로 나온다 (2026-09-06)
  check('⑩ 관측 반영 스위치가 있고 기본은 켜짐', (await p.eval(`document.querySelector('[data-t="sim-observe-fix"]')?.dataset.on`)) === 'true');
  // 놓는 순간 — ⑧ 놓는다 끝(손에 든 것 · 손끝 FK)과 ⑨ 빠져나온다 끝(바구니 속 · 실제 터틀봇)의 거치대 자리가 같아야 한다.
  // 전엔 실물 메시가 명령 자리에 서고 거치대는 유령(바구니 없는 상자)을 따라 「초록 바구니에서 빠져나온」 것처럼 보였다 (2026-09-06 실기 담당자 발견)
  const rel = await actEnd('release'); const ret = await actEnd('retreat');
  const jumpOn = Math.hypot(rel.c.x - ret.c.x, rel.c.y - ret.c.y, rel.c.z - ret.c.z);
  check('관측 반영 ON — 놓는 순간 거치대가 뛰지 않는다 (⑧→⑨ 3mm · 실제 바구니 안)', jumpOn < 3 && rel.c?.src === 'hand' && ret.c?.src === 'number', `${jumpOn.toFixed(1)}mm`);
  const rOn = await actEnd('u-reach');
  check('관측 반영 ON — 내리기 ⑪에서 손끝이 실제 바구니 속 거치대에 닿는다 (③ 거리 ±3mm)', Math.abs(gap(rOn) - g3) < 3 && rOn.c?.src === 'number', `⑪ ${gap(rOn).toFixed(1)} · ③ ${g3.toFixed(1)}mm`);
  await p.eval(`document.querySelector('[data-t="sim-observe-fix"] input').click()`);
  await p.waitFor(`document.querySelector('[data-t="sim-observe-fix"]')?.dataset.on === 'false'`, { timeoutMs: 3000 });
  // 끄면 열린 루프 자세(명령 자리의 바구니 쪽 세 자세)를 그때 푼다 — 사이클이 다시 설 때까지 기다린다
  check('열린 루프 자세가 풀려 사이클이 다시 선다', await p.waitFor(`!!window.__cycleActs`, { timeoutMs: 30000 }));
  const relO = await actEnd('release'); const retO = await actEnd('retreat');
  const jumpOff = Math.hypot(relO.c.x - retO.c.x, relO.c.y - retO.c.y, relO.c.z - retO.c.z);
  check('관측 반영 OFF — 놓는 순간 거치대가 실제 바구니로 도착 오차만큼 튄다 (37.5±3mm · 카메라 없는 싣기의 빗나감)', Math.abs(jumpOff - AMR_ARRIVE_ERR_MM) < 3, `${jumpOff.toFixed(1)}mm`);
  const rOff = await actEnd('u-reach');
  // 거치대는 그대로(실제 바구니)인데 손끝만 명령 자리로 간다 — 그 차가 도착 오차(37.5) 그대로여야 「카메라 없이 이만큼 빗나간다」가 참이다
  const dHand = Math.hypot(rOff.h.x - rOn.h.x, rOff.h.y - rOn.h.y, rOff.h.z - rOn.h.z);
  const dCarrier = Math.hypot(rOff.c.x - rOn.c.x, rOff.c.y - rOn.c.y, rOff.c.z - rOn.c.z);
  check('관측 반영 OFF — 열린 루프면 손끝이 도착 오차만큼 다른 곳에 내린다 (37.5±3mm) · 거치대는 그대로', Math.abs(dHand - AMR_ARRIVE_ERR_MM) < 3 && dCarrier < 1, `손끝 ${dHand.toFixed(1)} · 거치대 ${dCarrier.toFixed(1)}mm`);
  await p.eval(`document.querySelector('[data-t="sim-observe-fix"] input').click()`);
  await p.waitFor(`document.querySelector('[data-t="sim-observe-fix"]')?.dataset.on === 'true'`, { timeoutMs: 3000 });
  await p.eval(`window.__cycleSeek(null)`);
  // ── 입력 한 줄 (phase 4) — 거치대 자리. 목업엔 실측 표적이 없으니 「고르기」가 열려 있고, 판 위 한 점을 넣으면
  //    ① 줄이 「입력(가정)」+ 좌표 ② 옛 해·평가가 비워진다(낡은 자리 것) ③ 실제 화면 클릭 경로(레이캐스트)도 좌표를 낸다
  // ── 바구니 표적 — 같은 ⓐ~ⓔ 로 빈 바구니 바닥(파임 90)을 재고 통과하면 ⑥~⑨ 자리가 관측값으로 흐른다. 대강값은 정차 자리+오프셋
  await p.eval(`(() => { const s = document.querySelector('[data-t="sim-aim"] select'); s.value = 'basketFloor'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await aimStep('a', 'b');
  const bCoarse = await p.eval(`document.querySelector('[data-t="sim-aim-coarse"]')?.textContent ?? ''`);
  check('바구니 대강값은 정차 자리+등 뒤 오프셋에서 온다', /출처 stop\+offset/.test(bCoarse), bCoarse.slice(0, 70));
  await aimStep('b', 'c', 30000); await aimStep('c', 'd'); await aimStep('d', 'e'); await aimStep('e', null);
  await aimStep('b', 'c', 30000); await aimStep('c', 'd'); await aimStep('d', 'e'); await aimStep('e', null);
  const basketOk = await p.waitFor(`!!document.querySelector('[data-t="sim-aimed-basket"]')`, { timeoutMs: 8000 });
  check('바구니 융합이 통과하면 ⑥~⑨ 가 관측값으로 흐른다', basketOk, (await p.eval(`document.querySelector('[data-t="sim-aimed-basket"]')?.textContent ?? ''`)).slice(0, 80));
  const inputBefore = await p.eval(`document.querySelector('[data-t="sim-input"]')?.dataset.src`);
  check('입력 줄이 있고 실측이 없으면 출처가 「파지 자세」다', inputBefore === 'truth', String(inputBefore));
  const fromScreen = await p.eval(`(() => { const r = document.querySelector('[data-t="twin"] canvas').getBoundingClientRect(); return JSON.stringify(window.__twin?.pickFromScreen?.(r.left + r.width * 0.55, r.top + r.height * 0.6) ?? null); })()`);
  check('3D 클릭 경로(레이캐스트)가 판 위 user1 좌표를 낸다', /^\[-?\d/.test(fromScreen), fromScreen);
  await p.eval(`window.__twin.pickCarrierAt([700, -1100])`);
  const inputOk = await p.waitFor(`document.querySelector('[data-t="sim-input"]')?.dataset.src === 'input' && /입력[(]가정[)].*700.*-1100/.test(document.querySelector('[data-t="sim-input"]')?.textContent ?? '')`, { timeoutMs: 5000 });
  check('자리를 넣으면 「입력(가정)」과 좌표가 뜨고', inputOk, (await p.eval(`document.querySelector('[data-t="sim-input"]')?.textContent ?? ''`)).slice(0, 80));
  check('옛 해·평가는 비워진다 (낡은 자리 것이라)', !(await p.eval(`!!document.querySelector('[data-t="sim-score"]')`)));
  await p.eval(`[...document.querySelectorAll('[data-t="sim-input"] button')].find(b => b.textContent === '되돌리기')?.click()`);
  check('되돌리기 뒤 출처가 「파지 자세」로 돌아온다', (await p.eval(`document.querySelector('[data-t="sim-input"]')?.dataset.src`)) === 'truth');
  check('자리를 되돌리면 옛 사이클은 사라지고 목록은 싣기 9칸으로 돌아간다 (낡은 자리의 구간을 남기지 않는다)',
    (await p.eval(`document.querySelectorAll('[data-t="sim-cycle"] ol.steps li').length`)) === 9 && (await p.eval(`window.__cycleActs == null`)));
  // 되감기는 터틀봇 탭으로 이사했다 — 옮긴 자리에 살아 있는지. 탭을 바꾸면 시뮬 절은 내려가므로(유령 주인 교대) **맨 끝**에서 본다
  await p.eval(`[...document.querySelectorAll('nav[role="tablist"] button')].find((b) => b.textContent.trim() === '터틀봇')?.click()`);
  const tbRuns = await p.waitFor(`!!document.querySelector('[data-t="tb-runs"]') && !document.querySelector('[data-t="sim-cycle"]')`, { timeoutMs: 5000 });
  check('터틀봇 탭에 「되감기」 절이 있고 시뮬 절은 내려갔다', tbRuns);
  const errs = await p.eval(`window.__err ?? ''`);
  check('콘솔 오류 없음', !errs, String(errs).slice(0, 120));
} catch (e) { check('실행 자체', false, String(e.message || e)); }
finally { try { await p?.close?.(); } catch {} killTree(bridge); killTree(web); }
const bad = out.filter(v => !v).length;
console.log(`\n${out.length - bad}/${out.length} PASS`);
process.exit(bad ? 1 : 0);
