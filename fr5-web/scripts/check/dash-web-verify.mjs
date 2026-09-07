// **자기 dev 서버를 자기 포트에 띄운다** (2026-08-07). 남의 `:5174` 에 붙지 않는다.
// 여태 사람이 다른 터미널에 `npm run dev:dash` 를 켜고 이 파일을 손으로 불러야 했고,
// 그래서 **112건이 사실상 안 돌았다.** 같은 병으로 AR 겹침이 2176px 어긋난 채 며칠을
// 살아남았다 (`docs/evidence/2026-08-07/cam-status-hud.md`). `check/dash-render.sh` 가 잠근다.
//
// **무엇을 판정하나** — 배치안 편집기가 `Shared/data/datasource/` 를 거쳐 돌고,
// 그 경계를 넣기 **전과 동작이 같은가** (GOAL-dash-datasource §2).
// 저장은 화면이 아니라 datasource 가 한다. 그래서 이 파일이 확인할 것은
// "화면이 무엇을 부르나" 가 아니라 **"사람이 겪는 결과가 같나"** 다.
//
//   실행 —  node scripts/check/dash-web-verify.mjs   (게이트: bash scripts/check/dash-render.sh)

import { spawn } from 'node:child_process';
import path from 'node:path';
// **자기 트리 기준 상대경로다** (감사 2026-08-13). 절대경로를 박으면 worktree 세션이
// 게이트를 돌릴 때 **본 트리의 서버·모듈**을 판정해, worktree 에 심은 버그가 초록으로 나온다.
import { openPage } from './lib/cdp-harness.mjs';
// 시뮬 탭 검사가 쓸 배치를 여기서 굽는다 — `Sim/out/` 은 커밋 안 한다(D14)
import { runBatch } from '../../Sim/runner/batch.mjs';
const ROOT = path.resolve(import.meta.dirname, '../..');

// 게이트 전용 포트. 개발용 `:5174` 와 겹치지 않게 둔다 — 겹치면 사람이 켜 둔 서버에 붙어서
// **고친 코드가 아니라 켜 둔 코드를 판정한다.** `--strictPort` 라 남이 쥐고 있으면 그냥 죽는다
const PORT = 5187;
const URL = `http://localhost:${PORT}/`;
// **`npm run` 을 죽여도 자식 vite 는 산다** — 포트를 쥔 채 남아 다음 판이 `--strictPort` 에
// 막히고, 그때 원인은 화면처럼 보인다. 손으로 한 번씩 부를 때는 절대 안 보이는 함정이라
// `all.sh` 에 넣는 순간 드러났다 (2026-08-06 FR5 에서 같은 것을 밟았다 · GAP-MATRIX).
// 처방도 그때와 같다 — 프로세스 **그룹**째 죽이고, 예외·중단 경로에도 건다.
const web = spawn('npm', ['run', 'dev', '-w', '@fr5/dashboard', '--', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore', detached: true });
const killTree = (c) => { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* 이미 죽음 */ } } };
process.on('exit', () => killTree(web));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 150; i++) {
  if (await fetch(URL).then((r) => r.ok).catch(() => false)) break;
  await sleep(200);
}
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); };
const edit = 'window.__fr5edit';
// **놓인 것 전체로 센다** — 팔레트 첫 칸은 소품이 아니라 문이다 (분류 순서: 방 껍데기부터).
// `props` 로만 세면 문을 놓고도 "안 늘었다" 가 된다.
const total = `(${edit}.props + ${edit}.doors + ${edit}.windows)`;

const p = await openPage(URL, { port: 9341, windowSize: '1400,900' });
try {
  // 처음 여는 브라우저처럼 — 남은 저장분이 있으면 판정이 흐려진다
  await p.eval(`localStorage.clear(); 'ok'`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);

  // ── 1. 경계가 섰다 ────────────────────────────────────────────────
  const src = await p.eval(`${edit}.source`);
  check('출처를 datasource 가 말한다', src === 'mock', `source=${src}`);
  check('헤더 배지가 그 값을 쓴다', (await p.eval(`window.SOURCE`)) === src);
  check('빈 저장소에서 배치안 1개가 선다', (await p.eval(`${edit}.scenes`)) === 1);

  const url1 = await p.eval(`new URLSearchParams(location.search).get('scene')`);
  const cur1 = await p.eval(`${edit}.current`);
  check('주소줄이 지금 배치안을 든다', url1 === cur1, `?scene=${url1}`);

  // ── 2. 프리셋으로 새 배치안 ───────────────────────────────────────
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, 'new:cell');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`${edit}.scenes === 2`);
  const n0 = await p.eval(total);
  check('프리셋에서 새 배치안이 나온다', (await p.eval(`${edit}.props`)) === 18, `놓인 것=${n0}`);
  const cur2 = await p.eval(`${edit}.current`);
  check('주소줄이 따라 바뀐다',
    (await p.eval(`new URLSearchParams(location.search).get('scene')`)) === cur2);

  // ── 3. 팔레트로 물건 하나 ─────────────────────────────────────────
  await p.eval(`document.querySelector('.part-card').click(); 'ok'`);
  await p.waitFor(`${total} === ${n0 + 1}`);
  check('팔레트로 놓은 것이 늘어난다', (await p.eval(total)) === n0 + 1);

  // ── 4. 새로고침 — datasource 가 진짜 저장했나 ─────────────────────
  await p.navigate(URL);            // ?scene= 없이 열어도 URL 이 아니라 저장분이 판정한다
  await p.waitFor(`${edit}?.scenes >= 1`);
  check('새로고침 뒤 배치안 2개가 남는다', (await p.eval(`${edit}.scenes`)) === 2);
  await p.navigate(`${URL}?scene=${cur2}`);
  await p.waitFor(`${edit}?.current === '${cur2}'`);
  check('주소줄로 그 배치안이 다시 열린다', (await p.eval(`${edit}.current`)) === cur2);
  check('놓은 것이 새로고침 뒤에도 있다',
    (await p.eval(total)) === n0 + 1, `놓인 것=${await p.eval(total)}`);

  // ── 5. 되돌리기 ───────────────────────────────────────────────────
  await p.eval(`document.querySelector('.part-card').click(); 'ok'`);
  await p.waitFor(`${total} === ${n0 + 2}`);
  await p.eval(`dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })); 'ok'`);
  await p.waitFor(`${total} === ${n0 + 1}`);
  check('⌘Z 가 한 개만 되돌린다', (await p.eval(total)) === n0 + 1);
  await p.navigate(`${URL}?scene=${cur2}`);
  await p.waitFor(`${edit}?.scenes >= 1`);
  check('되돌린 결과가 저장된다', (await p.eval(total)) === n0 + 1);

  // ── 6. 배치안 삭제가 저장소까지 간다 ──────────────────────────────
  await p.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('배치안 삭제')).click(); 'ok'`);
  await p.waitFor(`${edit}.scenes === 1`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);
  check('삭제가 새로고침 뒤에도 유지된다', (await p.eval(`${edit}.scenes`)) === 1);

  // ── 7. 저장이 실패해도 편집은 계속된다 (GOAL-editor-undo-save §3) ──
  await p.eval(`localStorage.setItem = () => { throw new Error('quota'); }; 'ok'`);
  await p.eval(`document.querySelector('.part-card').click(); 'ok'`);
  await p.waitFor(`${edit}.saveErr === true`);
  check('저장 실패를 화면이 말한다', (await p.eval(`${edit}.saveErr`)) === true);
  check('저장이 실패해도 편집은 살아 있다', (await p.eval(total)) >= 1);
  check('화면에 실패 문구가 뜬다',
    await p.eval(`!!document.querySelector('.unsaved')`));

  // ── 8. 재생 (사다리 2) ────────────────────────────────────────────────
  //
  // **좌표를 눈으로 못 재므로 숫자로 본다.** 작업물이 실제로 움직였나 · 탄두가 쪼개졌나 ·
  // 같은 시각을 두 번 물으면 같은 자리인가(되감기가 성립하는 조건).
  await p.eval(`localStorage.clear(); 'ok'`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'new:cell');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`${edit}.props === 18`);
  // **새 배치안을 만들어도 시나리오가 안 사라진다.** 보관함을 갈아 끼우는 자리가 넷인데
  // `...prev` 를 안 펼치면 시나리오가 통째로 떨어지고, 리컨실러가 저장소까지 비운다
  // (2026-08-04 에 실제로 그랬다 — 재생 막대가 통째로 사라졌다).
  check('새 배치안을 만들어도 시나리오가 남는다', (await p.eval(`${edit}.scenarios`)) >= 1,
    `시나리오 ${await p.eval(`${edit}.scenarios`)}개 · 사건 ${await p.eval(`${edit}.events`)}개`);
  await p.waitFor(`!!document.querySelector('.view3d-play')`);
  check('재생 막대가 뜬다', await p.eval(`!!document.querySelector('.view3d-play')`));
  check('재생에도 출처 배지가 붙는다',
    (await p.eval(`document.querySelector('.view3d-play .source')?.textContent`)) === '출처 mock');

  // 스크럽 — 시각을 직접 넣어 결정적인지 본다 (재생 없이)
  // 끄는 동작을 그대로 흉내낸다 — **누르고 나서 값이 바뀐다.**
  // `pointerdown` 을 빼면 0 자리로 끄는 판을 못 본다 (React 는 같은 값에 onChange 를 안 낸다).
  const setT = (t) => p.eval(`(() => {
    const r = document.querySelector('.view3d-play input[type=range]');
    r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(r, '${t}');
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  const workAt = async (t) => { await setT(t); await new Promise((r) => setTimeout(r, 250));
    return p.eval(`window.__fr5view().work`); };

  const w0 = await workAt(2);
  const w16 = await workAt(16);
  const w22 = await workAt(26);
  const w29 = await workAt(29);
  const w39 = await workAt(48);
  check('작업물이 무대에 선다', !!w0, JSON.stringify(w0));
  check('팔레트에서 배출까지 자리가 바뀐다',
    !!w0 && !!w39 && (w0.xMm !== w39.xMm || w0.yMm !== w39.yMm),
    `${w0?.xMm},${w0?.yMm} → ${w39?.xMm},${w39?.yMm}`);
  // **조립하는 동안 탄두는 리프터에서 안 움직인다** (D59·D63)
  check('조립 중 탄두가 고정된다 (16~29초)',
    !!w16 && !!w29 && w16.xMm === w29.xMm && w16.yMm === w29.yMm,
    `16s ${w16?.xMm},${w16?.yMm} = 29s ${w29?.xMm},${w29?.yMm}`);
  // **조립은 3 → 0 이다** — 빈 케이싱에 신관이 붙어 완성품이 된다
  check('탄두가 단계별로 합쳐진다 (3→0)',
    w0?.stage === 3 && w22?.stage === 2 && w39?.stage === 0,
    `2s=${w0?.stage} 26s=${w22?.stage} 48s=${w39?.stage}`);
  const w16b = await workAt(16);
  check('같은 시각은 같은 자리 (되감기 조건)',
    JSON.stringify(w16) === JSON.stringify(w16b), JSON.stringify(w16));

  // 팔 둘 — **역할이 갈린다.** 투입 팔은 팔레트 쪽, 조립 팔은 리프터 쪽이다
  const yaws = (t) => workAt(t).then(() => p.eval(`(() => { const st = window.__stage;
    const c = st.scene.children.find(x => x.name === 'layoutView').children.find(x => x.name === 'contents');
    return Object.fromEntries(c.children.filter(x => x.userData?.arm)
      .map(x => [x.userData.arm.id, Math.round(x.rotation.y * 180 / Math.PI)])); })()`));
  const yFeed = await yaws(2);
  check('FR5 가 세 대 선다 (투입 2 · 조립 1)', Object.keys(yFeed).length === 3, JSON.stringify(yFeed));
  // **베이스는 안 돈다** — 도는 것은 j1 이다 (D62 이후 규약)
  check('베이스가 안 돈다', yFeed.fr5a === 0 && yFeed.fr5b === 90 && yFeed.fr5c === 90,
    `fr5a=${yFeed.fr5a}° fr5b=${yFeed.fr5b}° fr5c=${yFeed.fr5c}°`);

  // 실제 재생 — 시간이 흐르나
  await setT(0);
  await p.eval(`[...document.querySelectorAll('.view3d-play button')][0].click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 1600));
  const t1 = await p.eval(`window.__fr5view().tSec`);
  await p.eval(`[...document.querySelectorAll('.view3d-play button')][0].click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 500));
  const t2 = await p.eval(`window.__fr5view().tSec`);
  const t3 = await p.eval(`window.__fr5view().tSec`);
  check('재생하면 시간이 흐른다', t1 > 0.8 && t1 < 3, `1.6초 뒤 ${t1}s`);
  check('멈추면 시간이 선다', t2 === t3, `${t2} = ${t3}`);

  // 빈 방 — **재생할 것이 없다고 말한다** (화면이 안 죽는다)
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'new:empty');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`${edit}.props === 0`);
  // **빈 방에는 빈 시나리오가 붙는다** (2026-08-04). 그래서 "스테이션이 없어요" 가 아니라
  // **재생 막대 자체가 안 뜬다** — 돌릴 사건이 0개다. 전에는 조립 라인 사건 13개가 딸려 와
  // 자리를 다 놓기 전까지 그 문구만 반복했다.
  check('빈 방에는 빈 시나리오가 붙는다',
    (await p.eval(`${edit}.scenarioId`)) === 'blank' && (await p.eval(`${edit}.events`)) === 0,
    `${await p.eval(`${edit}.scenarioId`)} · 사건 ${await p.eval(`${edit}.events`)}개`);
  check('돌릴 사건이 없으면 재생 막대가 안 뜬다',
    (await p.eval(`!!document.querySelector('.view3d-play')`)) === false);

  // **자리가 모자란 것은 여전히 말해야 한다** — 조립 라인 시나리오를 빈 방에 태워 본다
  await p.eval(`(() => {
    const s = document.querySelector('.tl-pick') || document.querySelector('.scene-pick');
    return 'ok';
  })()`);
  await p.eval(`(() => {
    const S = JSON.parse(localStorage.getItem('fr5.scenes'));
    const id = new URLSearchParams(location.search).get('scene');
    S.scenes[id].scenarioId = 'assembly49';
    localStorage.setItem('fr5.scenes', JSON.stringify(S));
    return 'ok';
  })()`);
  await p.navigate(`${URL}?scene=${await p.eval(`${edit}.current`)}`);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await new Promise((r) => setTimeout(r, 900));
  check('자리가 없으면 그렇게 말한다',
    (await p.eval(`document.querySelector('.view3d-play .play-now')?.textContent ?? ''`))
      .includes('없어서 못 돌려요'),
    (await p.eval(`document.querySelector('.view3d-play .play-now')?.textContent ?? '(막대 없음)'`)).trim());
  check('자리가 없으면 재생 버튼이 잠긴다',
    await p.eval(`[...document.querySelectorAll('.view3d-play button')][0]?.disabled === true`));

  // ── 9. 로봇이 실제로 움직이나 (관절 + 순기구학) ──────────────────────
  //
  // **각도만 보면 "얹었다" 까지밖에 모른다.** 손끝이 어디로 갔는지를 FK 로 재야
  // 자세가 지어낸 것인지 목표를 향한 것인지 갈린다 (IK 가 아니다 — 재는 것이다).
  // **앞 절이 빈 방으로 끝난다** — 거기엔 fr5a·fr5b 가 없어서 손끝이 씬에 안 붙어 있다.
  // 붙어 있지 않은 팔의 월드 좌표는 로컬 좌표라, 재면 6.7m 짜리 헛값이 나온다.
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'new:cell');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`${edit}.props === 18`);
  await p.waitFor(`window.__fr5view()?.arms?.fr5a?.tipMm`, { timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  const armAt = async (t) => { await setT(t); await new Promise((r) => setTimeout(r, 300));
    return p.eval(`JSON.stringify(window.__fr5view().arms)`).then(JSON.parse); };
  const a2 = await armAt(2);
  const a20 = await armAt(26);
  const a26 = await armAt(34);
  check('FR5 를 세 대 따로 세운다', !!a2.fr5a?.tipMm && !!a2.fr5b?.tipMm && !!a2.fr5c?.tipMm, Object.keys(a2).join(','));
  check('관절이 실제로 움직인다',
    JSON.stringify(a2.fr5a.j) !== JSON.stringify(a20.fr5a.j), `${a2.fr5a.j} → ${a20.fr5a.j}`);
  // **결합 구간 여러 시각을 본다** — 자세 섞임이 구간마다 다시 시작하므로
  // 한 시각만 집으면 우연히 같은 값이 나온다 (실렌더가 잡았다).
  // 리프터 위 작업물 — 조립 팔(fr5a)이 여기에 닿아야 조립이 성립한다.
  // **거리 함수를 쓰기 전에 선언한다** — 아래 반복문보다 뒤에 있어서 TDZ 로 터졌고,
  // `finally` 가 예외를 삼켜 **11·12 절이 안 도는데 31/31 초록**이었다 (2026-08-04).
  const T = [3375, 6000, 1050];
  const d = (tip) => Math.round(Math.hypot(tip[0] - T[0], tip[1] - T[1], tip[2] - T[2]));
  // **접촉하는 시각을 고른다.** 26·29·31·35 초를 재던 시절이 있었는데 그 넷은 전부
  // 팔이 **신관 트레이로 간 구간**이라(`fetch`) 리프터까지 445~487mm 가 나오는 게 정상이다.
  // 잰 값이 아니라 **잰 시각**이 틀렸던 것이다 (2026-08-04 · 1초 간격 전수로 갈랐다).
  // **시각마다 독립으로 안정시켜 잰다.** 관절에 각속도 제한(70°/s)이 걸려 화면의 자세는
  // 직전 자세에서 출발해 목표로 수렴한다. 0→49초를 촘촘히 훑으면 지연이 **누적**돼
  // 결합 거리가 445~712mm 로 나온다 — 로봇이 아니라 읽는 방법이 만든 숫자다.
  //
  // **한 시각 목록으로 두 질문을 재지 않는다.** j6 는 신관 트레이를 왕복하는 구간에서 돌고,
  // 그리퍼가 작업물에 붙는 것은 그 사이의 접촉 순간이다. 같은 목록으로 둘 다 재면 어느
  // 한쪽은 반드시 거짓 실패한다 — 실제로 양쪽을 번갈아 겪었다 (2026-08-04).
  const grips = [];
  for (const t of [17, 19, 24, 32, 36]) grips.push(d((await armAt(t)).fr5a.tipMm));
  const j6s = [];
  for (const t of [20, 24, 26, 29, 31, 35]) j6s.push((await armAt(t)).fr5a.j[5]);
  check('j6 가 돌아 결합한다', j6s.some((v) => v !== 0) && new Set(j6s).size > 1, `j6 ${j6s.join('·')}°`);
  // 결합 구간 안에서 **가장 가까울 때**를 본다 — 손을 뻗었다 물었다 하므로 평균은 뜻이 없다.
  // 전체 값을 같이 적는다 — **24초·32초 결합이 445mm 까지밖에 안 붙는 것**이 여기 보인다
  // (GAP-MATRIX OPEN). 최솟값만 적으면 그 약점이 매번 가려진다.
  check('조립 팔의 그리퍼가 작업물을 잡는다 (FK 실측)', Math.min(...grips) < 250,
    `가장 가까울 때 ${Math.min(...grips)}mm · 17·19·24·32·36초 ${grips.join('·')}mm`);
  check('멀리 있을 땐 손을 안 뻗는다', d(a2.fr5a.tipMm) > d(a26.fr5a.tipMm),
    `2s ${d(a2.fr5a.tipMm)}mm → 26s ${d(a26.fr5a.tipMm)}mm`);

  // ── 11. 크레인이 완성품을 옮긴다 ─────────────────────────────────────
  // **축이 둘이다** — 트롤리는 거더 위(x), 브리지는 레일 위(y).
  // 리프터 → 배출은 y 이동이라 트롤리만 봐서는 "안 움직인다" 를 못 잡는다.
  const crane = () => p.eval(`(() => { const c = window.__stage.scene.children
    .find(x => x.name === 'layoutView').children.find(x => x.name === 'contents');
    const h = c.getObjectByName('crane')?.userData?.crane;
    return h ? [Math.round(h.trolley.position.x * 1000), Math.round(-h.bridge.position.z * 1000)] : null; })()`);
  await setT(26); await new Promise((r) => setTimeout(r, 300));
  const c20 = await crane();
  await setT(48); await new Promise((r) => setTimeout(r, 300));
  const c39 = await crane();
  check('크레인이 레일을 따라 달린다', !!c20 && !!c39 && c20[1] !== c39[1],
    `26s [${c20}] → 48s [${c39}]`);

  // ── 12. 내보내기·가져오기 ────────────────────────────────────────────
  const exported = await p.eval(`(() => {
    let cap = null;
    const rc = URL.createObjectURL; URL.createObjectURL = (b) => { cap = b; return rc.call(URL, b); };
    const rk = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__dl = this.download; };
    [...document.querySelectorAll('button')].find((b) => b.textContent === '내보내기').click();
    HTMLAnchorElement.prototype.click = rk; URL.createObjectURL = rc;
    return cap ? cap.text() : null;
  })()`);
  check('내보내기가 배치안 전문을 낸다',
    !!exported && JSON.parse(exported).props?.length === 18, `${exported?.length ?? 0}B`);
  const feed = (text, name) => p.eval(`(() => {
    const f = new File([${JSON.stringify('TXT')}], ${JSON.stringify('NM')}, { type: 'application/json' });
    const dt = new DataTransfer(); dt.items.add(f);
    const input = document.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`.replace('TXT', JSON.stringify(text).slice(1, -1)).replace('NM', name));
  const before = await p.eval(`${edit}.scenes`);
  await feed(exported.replace(/"name": *"[^"]*"/, '"name": "가져온 배치안"'), 'map1.json');
  await p.waitFor(`${edit}.scenes === ${before + 1}`);
  check('가져오기가 새 씬으로 들어온다',
    (await p.eval(`${edit}.name`)) === '가져온 배치안', await p.eval(`${edit}.props`));
  // **아무 JSON 이나 받으면 화면이 죽는다** — 스키마를 반드시 본다
  await feed('{"nope":1}', 'bad.json');
  await new Promise((r) => setTimeout(r, 600));
  check('깨진 파일은 거부하고 이유를 말한다',
    (await p.eval(`${edit}.scenes`)) === before + 1
      && (await p.eval(`document.querySelector('.unsaved')?.textContent ?? ''`)).includes('unit'),
    await p.eval(`document.querySelector('.unsaved')?.textContent ?? '(문구 없음)'`));

  // ── 13. 시점이 화면을 채운다 (프레이밍) ──────────────────────────────
  //
  // 시점 맞추기가 **세로 화각만** 보던 시절의 실측 (2026-08-04):
  //   1600×900  방이 화면의 13.6% — 좌 34% · 우 36% 여백
  //   900×1600  가로 140% — **양옆 40% 가 화면 밖으로 잘렸다**
  // 화면은 그때도 멀쩡해 보였다. 여백은 버그처럼 안 생겼기 때문에 **재야 잡힌다.**
  //
  // **씬을 확인하고 잰다.** 빈 방을 재고 "잘 맞는다" 로 끝낼 뻔했다 — 빈 방은
  // 무엇을 하든 잘 맞는다.
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, 'new:cell');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`${edit}.props >= 18 && globalThis.__stage`);
  await new Promise((r) => setTimeout(r, 2500));

  // 놓인 것 전부의 화면 상자를 캔버스 비율로 낸다. 음수 여백 = 잘렸다.
  const FRAME_PROBE = `(() => {
    const st = globalThis.__stage, cam = st.camera, r = st.renderer.domElement.getBoundingClientRect();
    const V = Object.getPrototypeOf(cam.position).constructor;
    let sx = 1e9, sy = 1e9, bx = -1e9, by = -1e9, n = 0;
    st.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.visible) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox; if (!b) return;
      n += 1;
      for (const X of [b.min.x, b.max.x]) for (const Y of [b.min.y, b.max.y]) for (const Z of [b.min.z, b.max.z]) {
        const v = new V(X, Y, Z); o.localToWorld(v); v.project(cam);
        const px = (v.x + 1) / 2 * r.width, py = (1 - v.y) / 2 * r.height;
        if (px < sx) sx = px; if (px > bx) bx = px; if (py < sy) sy = py; if (py > by) by = py;
      }
    });
    const f = (x) => Math.round(x * 1000) / 1000;
    return { n, w: Math.round(r.width), h: Math.round(r.height),
      가로: f((bx - sx) / r.width), 세로: f((by - sy) / r.height),
      여백: [f(sx / r.width), f((r.width - bx) / r.width), f(sy / r.height), f((r.height - by) / r.height)] };
  })()`;

  // 판정 — **잘림 0** 이 먼저고, 그 다음이 빡빡한 축의 하한이다.
  // 정밀 맞춤이면 빡빡한 축은 여유분(pad 1.06)의 역수인 0.94 근처에 붙는다.
  // 반대 축은 방 모양과 창 비율이 정하므로 하한을 걸지 않는다 — 걸면 거짓 실패가 난다.
  const judgeFrame = (tag, m) => {
    const cut = m.여백.some((v) => v < -0.005);
    const tight = Math.max(m.가로, m.세로);
    check(`${tag} — 화면 밖으로 안 잘린다`, !cut, `여백 ${m.여백.join(' / ')}`);
    check(`${tag} — 빡빡한 축이 화면의 85% 이상`, tight >= 0.85,
      `가로 ${m.가로} · 세로 ${m.세로} · 캔버스 ${m.w}×${m.h} · 메쉬 ${m.n}`);
  };
  const land = await p.eval(FRAME_PROBE);
  check('프레이밍을 조립 라인에서 잰다', land.n > 300, `메쉬 ${land.n}개`);
  judgeFrame('가로 화면', land);

  // **창 비율을 바꿔서 다시 잰다.** 시점을 배치안마다 한 번만 잡던 탓에 창을 키워도
  // 방이 그대로 작았다. 이 한 줄이 그 회귀를 잡는다.
  await p.raw('Emulation.setDeviceMetricsOverride',
    { width: 900, height: 1600, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 1200));
  const port = await p.eval(FRAME_PROBE);
  check('창 비율이 바뀌면 시점을 다시 잡는다', port.w !== land.w, `${land.w}×${land.h} → ${port.w}×${port.h}`);
  judgeFrame('세로 화면', port);
  await p.raw('Emulation.clearDeviceMetricsOverride', {});

  // ── 14. 시나리오 저장 (사다리 1) ─────────────────────────────────────
  //
  // **저장을 고칠 수단이 없으면 저장을 검증할 수 없다.** 그래서 이 절은 실제로 끌어서
  // 고치고, 새로고침하고, 남아 있는지를 본다. 그게 이 칸의 완료 판정이다.
  await p.eval(`document.querySelector('[data-t=tl-toggle]').click(); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=timeline]')`);
  const marks = () => p.eval(`[...document.querySelectorAll('[data-t=tl-mark]')]
    .map((m) => ({ i: +m.dataset.i, sec: +m.dataset.sec,
      x: Math.round(m.getBoundingClientRect().left + m.getBoundingClientRect().width / 2),
      y: Math.round(m.getBoundingClientRect().top + m.getBoundingClientRect().height / 2) }))`);
  const m0 = await marks();
  check('편집을 켜면 사건 수만큼 마커가 뜬다', m0.length === (await p.eval(`${edit}.events`)),
    `마커 ${m0.length}개 · 사건 ${await p.eval(`${edit}.events`)}개`);

  // 마커 끌기 — **반 칸을 못 넘는 흔들림은 편집을 안 만든다.**
  // 막는 것은 문턱이 아니라 **0.5초 격자**다. 문턱(4px)을 따로 뒀다가 0 으로 낮춰도
  // 밖에서 아무 차이가 안 보여 지웠다 — 관측되지 않는 장치는 지킬 수도 없다 (2026-08-04).
  const drag = async (mk, dx) => p.eval(`(() => {
    const m = document.querySelector('[data-t=tl-mark][data-i="${mk.i}"]');
    const opt = (x) => ({ bubbles: true, clientX: x, clientY: ${mk.y}, pointerId: 1, button: 0 });
    m.dispatchEvent(new PointerEvent('pointerdown', opt(${mk.x})));
    m.dispatchEvent(new PointerEvent('pointermove', opt(${mk.x} + ${dx})));
    m.dispatchEvent(new PointerEvent('pointerup', opt(${mk.x} + ${dx})));
    return 'ok';
  })()`);

  const target = m0.find((m) => m.sec === 24) ?? m0[5];
  const secs0 = await p.eval(`${edit}.eventSecs`);
  await drag(target, 3);                                   // 문턱 안
  await new Promise((r) => setTimeout(r, 250));
  check('반 칸을 못 넘는 흔들림은 편집을 안 만든다 (0.5초 격자)',
    (await p.eval(`${edit}.eventSecs`)) === secs0, `${secs0} → ${await p.eval(`${edit}.eventSecs`)}`);

  await drag(target, 60);                                  // 문턱 밖
  await new Promise((r) => setTimeout(r, 300));
  const secs1 = await p.eval(`${edit}.eventSecs`);
  check('마커를 끌면 그 사건 시각이 바뀐다', secs1 !== secs0, `${secs0} → ${secs1}`);
  const moved = (await marks()).find((m) => m.i === target.i)?.sec;
  check('시각이 0.5초에 붙는다', Number.isFinite(moved) && Math.abs(moved * 2 - Math.round(moved * 2)) < 1e-9,
    `${target.sec}초 → ${moved}초`);

  // **새로고침 뒤에도 남는다** — 이 칸의 완료 판정
  await p.navigate(`${URL}?scene=${await p.eval(`${edit}.current`)}`);
  await p.waitFor(`${edit}?.scenes >= 1`);
  check('고친 시나리오가 새로고침 뒤에도 남는다',
    (await p.eval(`${edit}.eventSecs`)) === secs1, `${await p.eval(`${edit}.eventSecs`)}`);

  // ⌘Z — **같은 스택**이다. 배치안 편집과 시나리오 편집이 한 줄로 쌓인다
  await p.eval(`document.querySelector('[data-t=tl-toggle]').click(); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=timeline]')`);
  const m1 = await marks();
  await drag(m1.find((m) => m.i === target.i) ?? m1[0], -40);
  await new Promise((r) => setTimeout(r, 300));
  const twice = await p.eval(`${edit}.eventSecs`);
  await p.eval(`dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })); 'ok'`);
  await new Promise((r) => setTimeout(r, 300));
  check('⌘Z 가 시나리오 편집도 되돌린다',
    (await p.eval(`${edit}.eventSecs`)) === secs1 && twice !== secs1,
    `${secs1} →(끌기) ${twice} →(⌘Z) ${await p.eval(`${edit}.eventSecs`)}`);

  // 복제하면 **한쪽만 바뀐다** — 갈라지지 않으면 A·B 비교가 성립하지 않는다
  const nScen0 = await p.eval(`${edit}.scenarios`);
  await p.eval(`[...document.querySelectorAll('.tl-head button')].find(b => b.textContent === '복제').click(); 'ok'`);
  await p.waitFor(`${edit}.scenarios === ${nScen0 + 1}`);
  const m2 = await marks();
  await drag(m2[2], 70);
  await new Promise((r) => setTimeout(r, 300));
  const copySecs = await p.eval(`${edit}.eventSecs`);
  await p.eval(`(() => {
    const s = document.querySelector('.tl-pick');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, '${await p.eval(`${edit}.scenarioIds[0]`)}');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  check('시나리오를 복제해 고치면 원본이 안 바뀐다',
    (await p.eval(`${edit}.eventSecs`)) !== copySecs,
    `복제본 ${copySecs} · 원본 ${await p.eval(`${edit}.eventSecs`)}`);

  // ── 15. 관절 기즈모 · 자세 저장 (사다리 2) ───────────────────────────
  //
  // **팔을 클릭으로 고를 수 있어야 한다.** 소품이 앞을 가리면 못 고르므로, 팔 메시들의
  // 투영점을 훑어 실제로 눌리는 픽셀을 찾는다 — 하나도 없으면 그게 결함이다.
  await p.navigate(`${URL}?scene=${await p.eval(`${edit}.current`)}`);
  await p.waitFor(`window.__fr5view?.().arms?.fr5a?.tipMm`);
  await new Promise((r) => setTimeout(r, 2500));
  const armPts = await p.eval(`(() => {
    const st = window.__stage, b = document.querySelector('canvas').getBoundingClientRect();
    let slot = null;
    st.scene.traverse((o) => { if (o.userData?.item?.kind === 'arm' && o.userData.item.id === 'fr5a') slot = o; });
    if (!slot) return [];
    const out = [];
    slot.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingSphere();
      const v = o.geometry.boundingSphere.center.clone();
      o.localToWorld(v); v.project(st.camera);
      out.push([Math.round(b.left + (v.x + 1) / 2 * b.width), Math.round(b.top + (1 - v.y) / 2 * b.height)]);
    });
    return out;
  })()`);
  let armOk = false;
  for (const [x, y] of armPts.slice(0, 40)) {
    await p.eval(`(() => { const c = document.querySelector('canvas');
      for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(t,
        { bubbles: true, clientX: ${x}, clientY: ${y}, pointerId: 1, button: 0 }));
      return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 110));
    if (await p.eval(`${edit}.pickedId === 'fr5a'`)) { armOk = true; break; }
  }
  check('팔을 클릭으로 고를 수 있다', armOk, `후보 ${armPts.length}점`);

  await p.eval(`document.querySelector('[data-t=pose-toggle]').click(); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=pose-edit]')`);
  await new Promise((r) => setTimeout(r, 900));
  const gj = await p.eval(`window.__fr5giz.joints()`);
  check('팔을 고르면 관절마다 링이 뜬다', gj.length === 6, gj.join(','));

  // **관절 입력만 집는다.** `.pose-edit label` 로 훑으면 자세 고르기 칸까지 걸려 터진다
  // (칸이 하나 늘 때마다 깨지는 선택자였다 · 2026-08-04).
  const degs = () => p.eval(`(() => Object.fromEntries(
    ['j1','j2','j3','j4','j5','j6'].map((j) => [j,
      Number(document.querySelector('[data-t=pose-' + j + ']')?.value ?? NaN)])))()`);
  const d0 = await degs();

  // 실제 포인터로 끈다 — **배선이 도는가**
  const spin = async (j, a0, a1) => p.eval(`(async () => {
    const A = window.__fr5giz.pointOn('${j}', ${a0}), B = window.__fr5giz.pointOn('${j}', ${a1});
    if (!A || !B) return 'no-ring';
    const h = document.querySelector('.view3d-host');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: A[0], clientY: A[1], pointerId: 1, button: 0 }));
    h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: B[0], clientY: B[1], pointerId: 1 }));
    h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: B[0], clientY: B[1], pointerId: 1 }));
    return 'ok';
  })()`);
  await spin('j2', 0, 35);
  await new Promise((r) => setTimeout(r, 300));
  const d1 = await degs();
  check('링을 끌면 그 관절만 바뀐다', d1.j2 !== d0.j2
    && ['j1', 'j3', 'j4', 'j5', 'j6'].every((j) => d1[j] === d0[j]),
  `${JSON.stringify(d0)} → ${JSON.stringify(d1)}`);

  // **한계는 각도를 정확히 줘야 판정이 된다** — 기즈모 API 를 직접 몬다
  const clampRes = await p.eval(`(() => {
    const A = window.__fr5giz.pointOn('j2', 0);
    if (!window.__fr5giz.begin(A[0], A[1])) return null;
    // 링 반대편으로 몰아 상한(85°)을 넘긴다
    const B = window.__fr5giz.pointOn('j2', 170);
    const r = window.__fr5giz.move(B[0], B[1]);
    window.__fr5giz.end();
    return r;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  // **슬라이더가 아니라 저장될 값을 읽는다.** `<input type=range>` 는 `min`/`max` 로 자기
  // 값을 스스로 자르므로, 슬라이더를 읽으면 클램프를 지워도 검사가 통과한다
  // (2026-08-04 주입 시험에서 실제로 61/61 이 그대로 나왔다).
  const d2 = await p.eval(`window.__fr5giz.pose()`);
  check('한계 밖으로 못 간다', d2 && d2.j2 >= -265 && d2.j2 <= 85, `j2 = ${d2?.j2}° (한계 -265~85)`);
  // **긍정으로 판정한다** — 한계를 넘겨 몰았으면 반드시 걸렸어야 하고, 걸렸으면 말해야 한다
  const clampTxt = await p.eval(`document.querySelector('[data-t=pose-clamp]')?.textContent ?? ''`);
  check('한계에 걸리면 화면이 말한다',
    clampRes?.clampedTo != null && clampTxt.includes('j2'),
    `clampedTo=${clampRes?.clampedTo ?? '없음'} · ${clampTxt || '(문구 없음)'}`);

  // 저장 — **새로고침 뒤에도 남는다** · 출처 배지
  const n0poses = (await p.eval(`${edit}.poseNames`)).split(',').length;
  await p.eval(`window.prompt = () => '시험자세'; document.querySelector('[data-t=pose-save]').click(); 'ok'`);
  await p.waitFor(`${edit}.poseNames.includes('시험자세')`);
  check('만든 자세가 보관함에 들어간다',
    (await p.eval(`${edit}.poseNames`)).split(',').length === n0poses + 1, await p.eval(`${edit}.poseNames`));
  await p.navigate(`${URL}?scene=${await p.eval(`${edit}.current`)}`);
  await p.waitFor(`${edit}?.scenes >= 1`);
  check('저장한 자세가 새로고침 뒤에도 남는다',
    (await p.eval(`${edit}.poseNames`)).includes('시험자세'), await p.eval(`${edit}.poseNames`));
  check('저장한 자세의 출처가 손으로다',
    (await p.eval(`JSON.parse(localStorage.getItem('fr5.posesets')).items[${edit}.poseSetId].poses['시험자세'].source`)) === 'hand');

  // ── 16. 사건이 자기 성격을 든다 (사다리 2-C) ─────────────────────────
  //
  // **완료 판정은 FK 가 안 변한 것이다.** 전역 표(사건이름→자세)를 사건 안으로 옮기면서
  // 동작이 바뀌면 그건 이관이 아니라 다른 것을 만든 것이다.
  await p.eval(`localStorage.clear(); 'ok'`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'new:cell');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`${edit}.props === 18`);
  await p.waitFor(`window.__fr5view?.().arms?.fr5a?.tipMm`);
  await new Promise((r) => setTimeout(r, 2500));

  const T2 = [3375, 6000, 1050];
  const armAt2 = async (t) => {
    await p.eval(`(() => {
      const r = document.querySelector('.view3d-play input[type=range]');
      r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(r, '${t}');
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const tip = await p.eval(`window.__fr5view().arms.fr5a.tipMm`);
    return Math.round(Math.hypot(tip[0] - T2[0], tip[1] - T2[1], tip[2] - T2[2]));
  };
  // **접촉 순간과 `fetch` 구간을 둘 다 잰다.**
  //
  //   · 접촉(17·19·24·32·36초) — 팔이 작업물에 붙어야 한다
  //   · fetch(22·30초)         — 팔이 신관 쪽으로 **떠나 있어야** 한다
  //
  // fetch 를 빼먹으면 이관 오류를 못 잡는다: `fetch` 자세를 `home`→`grip` 으로 잘못 옮겨도
  // 접촉 순간만 재면 **65/65 가 그대로 통과한다** (2026-08-04 주입 시험에서 실제로 그랬다).
  //
  // **정확값이 아니라 대역으로 본다** — 각속도 제한 때문에 접촉 거리가 스크럽 순서에 따라
  // 18~24mm 로 흔들린다. 정확값을 박으면 게이트가 이유 없이 빨개진다.
  const fk = {};
  for (const t of [17, 19, 22, 24, 30, 32, 36]) fk[t] = await armAt2(t);
  const near = [17, 19, 24, 32, 36].every((t) => fk[t] < 250);
  const away = [22, 30].every((t) => fk[t] > 800);
  const fkTxt = Object.entries(fk).map(([t, d]) => `${t}s ${d}mm`).join(' · ');
  check('사건이 자세를 들어도 FK 가 그대로다 — 접촉은 붙고 fetch 는 떠난다',
    near && away, fkTxt);

  // **자유 이름** — 계약상 `event` 는 자유 문자열이다
  await p.eval(`document.querySelector('[data-t=tl-toggle]').click(); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=timeline]')`);
  await p.eval(`(() => {
    const m = document.querySelector('[data-t=tl-mark][data-i="6"]');
    m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 400 }));
    return 'ok';
  })()`);
  await p.waitFor(`!!document.querySelector('[data-t=ev-name]')`);
  await p.eval(`(() => {
    const i = document.querySelector('[data-t=ev-name]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, '나사조임');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const named = await p.eval(`(() => {
    const S = JSON.parse(localStorage.getItem('fr5.scenarios'));
    return (S.items[window.__fr5edit.scenarioId] ?? Object.values(S.items)[0]).events[6].event;
  })()`);
  check('사건 이름을 자유롭게 짓는다', named === '나사조임', `사건 6 = ${named}`);

  // 그 사건에 자세를 붙이면 **그 시각에 팔이 그 자세다**
  await p.eval(`(() => {
    const s = document.querySelector('[data-t=ev-pose-process-1]');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'retreat');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const tipAfter = await armAt2(27.9);
  check('사건에 붙인 자세가 재생에 나온다', tipAfter !== fk[24],
    `자세를 retreat 로 바꾸니 27.9초 손끝 ${tipAfter}mm (24초 ${fk[24]}mm)`);
  // **모르는 이름이 화면에 그대로 뜬다** — 계약이 그렇게 정했다
  const shown2 = await p.eval(`document.querySelector('.play-now')?.textContent ?? ''`);
  check('모르는 사건 이름을 화면이 그대로 보여준다', shown2.includes('나사조임'), shown2.trim());

  // ── 17. 손으로 눌러 보고 드러난 것들 (2026-08-04) ─────────────────────
  //
  // 게이트는 **내가 설계한 것**만 본다. 아래는 실제 조작 순서를 흉내내다 나온 결함들이라
  // 다시 새지 않게 박는다.
  const armPick = async () => {
    const pts = await p.eval(`(() => {
      const st = window.__stage, b = document.querySelector('canvas').getBoundingClientRect();
      let slot = null;
      st.scene.traverse((o) => { if (o.userData?.item?.kind === 'arm' && o.userData.item.id === 'fr5a') slot = o; });
      const out = [];
      slot?.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        o.geometry.computeBoundingSphere();
        const v = o.geometry.boundingSphere.center.clone();
        o.localToWorld(v); v.project(st.camera);
        out.push([Math.round(b.left + (v.x + 1) / 2 * b.width), Math.round(b.top + (1 - v.y) / 2 * b.height)]);
      });
      return out;
    })()`);
    for (const [x, y] of pts.slice(0, 40)) {
      await p.eval(`(() => { const c = document.querySelector('canvas');
        for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(t,
          { bubbles: true, clientX: ${x}, clientY: ${y}, pointerId: 1, button: 0 }));
        return 'ok'; })()`);
      await new Promise((r) => setTimeout(r, 100));
      if (await p.eval(`${edit}.pickedId === 'fr5a'`)) return true;
    }
    return false;
  };
  const openPose = async () => {
    if (await p.eval(`!!document.querySelector('[data-t=pose-edit]')`)) return;
    await p.eval(`document.querySelector('[data-t=pose-toggle]')?.click(); 'ok'`);
    await new Promise((r) => setTimeout(r, 900));
  };
  const spin2 = async (j, a0, a1) => {
    const A = await p.eval(`window.__fr5giz.pointOn('${j}', ${a0})`);
    const B = await p.eval(`window.__fr5giz.pointOn('${j}', ${a1})`);
    await p.eval(`(() => { const h = document.querySelector('.view3d-host');
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${A[0]}, clientY: ${A[1]}, pointerId: 1, button: 0 }));
      h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${B[0]}, clientY: ${B[1]}, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${B[0]}, clientY: ${B[1]}, pointerId: 1 }));
      return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 280));
  };
  const armJ = () => p.eval(`window.__fr5view().arms.fr5a.j.join(',')`);

  await p.eval(`localStorage.clear(); 'ok'`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'new:cell');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`window.__fr5view?.().arms?.fr5a?.tipMm`);
  await new Promise((r) => setTimeout(r, 2400));

  // **만든 자세가 로봇에 실제로 남는가.** 재생 틱이 매 프레임 모든 팔에 자세를 얹으므로
  // 그냥 두면 사람이 링을 돌려도 16ms 뒤에 덮어써진다 — **패널 숫자만 바뀌고 팔은 안 움직였다.**
  await armPick(); await openPose(); await spin2('j2', 0, 40);
  const jMade = await armJ();
  check('만든 자세가 로봇에 실제로 얹힌다', jMade.split(',')[1] !== '-90',
    `팔 관절 ${jMade} (기본 j2 = -90)`);

  // **재생과 자세 편집은 같은 관절을 쓴다** — 둘 다 켜면 그 팔만 얼어붙는다
  await p.eval(`document.querySelector('.view3d-play button').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 1200));
  check('재생을 켜면 자세 편집이 꺼진다',
    (await p.eval(`!!document.querySelector('[data-t=pose-edit]')`)) === false
      && (await armJ()) !== jMade, `재생 중 팔 ${await armJ()}`);
  await p.eval(`document.querySelector('.view3d-play button').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 400));

  // **빈 곳을 한 번 클릭해도 만들던 자세를 안 잃는다**
  await armPick(); await openPose(); await spin2('j3', 0, 35);
  const jDraft = await armJ();
  await p.eval(`(() => { const c = document.querySelector('canvas'), b = c.getBoundingClientRect();
    for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(t,
      { bubbles: true, clientX: b.left + 40, clientY: b.top + 40, pointerId: 1, button: 0 }));
    return 'ok'; })()`);
  await new Promise((r) => setTimeout(r, 500));
  await armPick(); await openPose();
  check('빈 곳을 클릭해도 만들던 자세가 남는다', (await armJ()) === jDraft,
    `${jDraft} → 빈 곳 클릭 → ${await armJ()}`);

  // **자세를 지우는 길이 있다** · **쓰이는 자세는 못 지운다**
  await p.eval(`window.prompt = () => '시험A'; document.querySelector('[data-t=pose-save]').click(); 'ok'`);
  await p.waitFor(`${edit}.poseNames.includes('시험A')`);
  const pickPose = (n) => p.eval(`(() => { const s = document.querySelector('[data-t=pose-pick]');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, '${n}');
    s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await pickPose('시험A'); await new Promise((r) => setTimeout(r, 300));
  await p.eval(`document.querySelector('[data-t=pose-del]').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 400));
  check('자세를 지울 수 있다', !(await p.eval(`${edit}.poseNames`)).includes('시험A'),
    await p.eval(`${edit}.poseNames`));

  await armPick(); await openPose();
  await pickPose('grip'); await new Promise((r) => setTimeout(r, 300));
  await p.eval(`document.querySelector('[data-t=pose-del]').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 400));
  check('시나리오가 쓰는 자세는 못 지우고 이유를 말한다',
    (await p.eval(`${edit}.poseNames`)).includes('grip')
      && (await p.eval(`document.querySelector('[data-t=pose-msg]')?.textContent ?? ''`)).includes('grip'),
    await p.eval(`document.querySelector('[data-t=pose-msg]')?.textContent ?? '(문구 없음)'`));

  // ── 18. 겹치는 판이 없다 ─────────────────────────────────────────────
  //
  // 재생 막대와 선택 패널이 **CSS 좌표가 같아** 그대로 포개져 있었다 (둘 다
  // `left: s-4; top: s-3` · 실측 [248,158] 동일). 눈으로는 "뭔가 이상하다" 로만 보이고
  // 어느 판이 위인지 모른다 — **상자를 재야 잡힌다.**
  const boxes = () => p.eval(`(() => {
    const g = (sel, n) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { n, t: r.top, b: r.bottom, l: r.left, r: r.right };
    };
    const list = [g('.view3d-play', '재생막대'), g('.view3d-pick', '선택패널'),
      g('.view3d-tools', '시점버튼'), g('[data-t=timeline]', '타임라인'),
      g('[data-t=pose-edit]', '자세패널')].filter(Boolean);
    const hit = (a2, b2) => !(a2.b <= b2.t || a2.t >= b2.b || a2.r <= b2.l || a2.l >= b2.r);
    const over = [];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) if (hit(list[i], list[j])) over.push(list[i].n + ' × ' + list[j].n);
    }
    return { 판: list.map((x) => x.n).join(','), 겹침: over };
  })()`);
  const b1 = await boxes();
  check('선택 패널이 재생 막대를 안 덮는다', b1.겹침.length === 0,
    `${b1.판} · ${b1.겹침.join(' / ') || '겹침 0'}`);

  // **폰 폭에서도 본다** — 세로가 모자라 넷이 서로를 덮던 자리다
  await p.raw('Emulation.setDeviceMetricsOverride',
    { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 1200));
  const b2 = await boxes();
  check('폰 폭에서도 판이 안 겹친다', b2.겹침.length === 0,
    `${b2.판} · ${b2.겹침.join(' / ') || '겹침 0'}`);
  await p.raw('Emulation.clearDeviceMetricsOverride', {});
  await new Promise((r) => setTimeout(r, 600));

  // ── 19. AMR 이 경로를 따라간다 (사다리 3) ────────────────────────────
  //
  // 전에는 스테이션 사이를 **직선**으로 갔다. 그래서 화면 하단이 적는 길이(0.8m)와 실제
  // 이동(1.9m)이 달랐고, 경로는 그려지지도 쓰이지도 않는 죽은 데이터였다 (2026-08-04).
  await p.eval(`localStorage.clear(); 'ok'`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'new:cell');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`${edit}.props === 18`);
  await new Promise((r) => setTimeout(r, 1500));

  const amrAtT = async (t) => {
    await p.eval(`(() => {
      const r = document.querySelector('.view3d-play input[type=range]');
      r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(r, '${t}');
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    await new Promise((r) => setTimeout(r, 260));
    return p.eval(`(() => {
      const st = window.__stage;
      let n = null;
      st.scene.traverse((o) => { if (o.name === 'amr1' && o.userData?.item?.kind === 'amr') n = o; });
      if (!n) return null;
      const w = n.getWorldPosition(new (Object.getPrototypeOf(st.camera.position).constructor)());
      return [Math.round(w.x * 1000), Math.round(-w.z * 1000)];
    })()`);
  };
  const track = [];
  for (let t = 0; t <= 4; t += 0.5) track.push(await amrAtT(t));
  const ok = track.every(Boolean);
  // **판정은 "꺾이나" 가 아니라 "경로 위에 있나" 다.**
  //
  // 처음엔 출발·도착을 잇는 직선에서 얼마나 부풀었나로 쟀는데, 이 구간엔 막는 것이 없어
  // **경로 자체가 거의 직선**이라 176mm 밖에 안 나왔다 — 없는 장애물을 피하는 척 경로를
  // 구부리는 것은 거짓말이므로, 재는 것을 바꿨다. 직선으로 질러가면 경로에서 최대 176mm
  // 벗어나므로 60mm 문턱이면 갈린다.
  const wpMm = (await import('../../Shared/data/layout/presets.js'))
    .buildPreset('cell').amrs.find((a) => a.id === 'amr1').waypointsMm;
  const { nearestU: nU, pathLengthMm: plMm } = await import('../../Shared/data/layout/schema.js');
  let offMax = 0;
  if (ok) for (const q of track) offMax = Math.max(offMax, nU(wpMm, q).offMm);
  check('AMR 이 그려 둔 경로 위를 간다', ok && offMax <= 60,
    `표본 ${track.length}개 · 경로에서 최대 ${offMax}mm 벗어남 (경로 길이 ${plMm(wpMm)}mm)`);
  check('AMR 이 목적지 팔레트 옆에 선다', ok
    && Math.hypot(track[track.length - 1][0] - 1800, track[track.length - 1][1] - 900) <= 380,
  `도착 ${track[track.length - 1]} · pile [1800,900] 까지 ${ok ? Math.round(Math.hypot(track[track.length - 1][0] - 1800, track[track.length - 1][1] - 900)) : '?'}mm`);
  check('하단이 이동거리가 아니라 경로라고 적는다',
    (await p.eval(`[...document.querySelectorAll('.facts b')].map((e) => e.textContent).join(',')`)).includes('AMR 경로'),
    await p.eval(`[...document.querySelectorAll('.facts b')].map((e) => e.textContent).join(' · ')`));

  // ── 20. 경로를 손으로 고친다 (사다리 3-C) ────────────────────────────
  //
  // **평소엔 선을 안 그린다** (실기 담당자 결정 · `layout-view.js` §AMR). `[경로]` 를 켤 때만
  // 나온다 — 타임라인·자세와 같은 문법이다.
  const amrAt2 = await p.eval(`window.__fr5view().at.amr1`);
  await p.eval(`(() => { const c = document.querySelector('canvas');
    for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(t,
      { bubbles: true, clientX: ${amrAt2[0]}, clientY: ${amrAt2[1]}, pointerId: 1, button: 0 }));
    return 'ok'; })()`);
  await new Promise((r) => setTimeout(r, 400));
  check('AMR 을 고르면 경로 버튼이 뜬다',
    (await p.eval(`${edit}.pickedId`)) === 'amr1'
      && (await p.eval(`!!document.querySelector('[data-t=path-toggle]')`)),
    `고른 것 ${await p.eval(`${edit}.pickedId`)}`);

  const dotsOf = () => p.eval(`(() => {
    const st = window.__stage, b = document.querySelector('canvas').getBoundingClientRect();
    const g = st.scene.getObjectByName('pathGizmo');
    if (!g || !g.visible) return [];
    const V = Object.getPrototypeOf(st.camera.position).constructor;
    return g.children.filter((o) => o.userData?.pointIndex !== undefined).map((o) => {
      const v = o.getWorldPosition(new V()); v.project(st.camera);
      return [o.userData.pointIndex, Math.round(b.left + (v.x + 1) / 2 * b.width),
        Math.round(b.top + (1 - v.y) / 2 * b.height)];
    });
  })()`);
  check('평소엔 경로 선을 안 그린다', (await dotsOf()).length === 0, '켜기 전 점 0개');

  await p.eval(`document.querySelector('[data-t=path-toggle]').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 700));
  const dots = await dotsOf();
  const wpOf = () => p.eval(`JSON.stringify(${edit}.wp.find((x) => x[0] === 'amr1')[1])`);
  check('경로를 켜면 점이 뜬다', dots.length === 4, `점 ${dots.length}개`);
  check('목적지까지 빗나감을 화면이 말한다',
    (await p.eval(`document.querySelector('[data-t=path-off-pile]')?.textContent ?? ''`)).includes('mm'),
    (await p.eval(`document.querySelector('[data-t=path-off-pile]')?.textContent ?? '(없음)'`)).trim());

  const wp0 = await wpOf();
  const [, dx, dy] = dots[1];
  await p.eval(`(() => { const h = document.querySelector('.view3d-host');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${dx}, clientY: ${dy}, pointerId: 1, button: 0 }));
    h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${dx + 60}, clientY: ${dy + 40}, pointerId: 1 }));
    h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${dx + 60}, clientY: ${dy + 40}, pointerId: 1 }));
    return 'ok'; })()`);
  await new Promise((r) => setTimeout(r, 500));
  const wp1 = await wpOf();
  check('점을 끌면 경로가 바뀐다', wp1 !== wp0, `${wp0} → ${wp1}`);

  // **고친 뒤에도 화면에 남아야 한다.** 경로 기즈모 갱신이 무대 재생성보다 **먼저** 돌던
  // 동안, 점을 하나 고치면 새로 만들어진 빈 기즈모가 화면을 대신해 **점이 사라졌다** —
  // 데이터는 맞는데 화면만 빈 상태라 "추가가 안 된다" 로 보였다 (2026-08-04).
  check('경로를 고쳐도 점이 화면에 남는다', (await dotsOf()).length === 4,
    `고친 뒤 점 ${(await dotsOf()).length}개`);

  // ── P2·P3. **번호와 방향** — 선만 있으면 어느 점이 몇 번이고 어디가 출발인지 모른다
  const gizInfo = () => p.eval(`(() => {
    const G = window.__stage.scene.getObjectByName('pathGizmo');
    if (!G) return null;
    const V = Object.getPrototypeOf(window.__stage.camera.position).constructor;
    const dots = G.children.filter((o) => o.userData?.pointIndex !== undefined);
    return {
      dots: dots.length,
      labels: G.children.filter((o) => o.userData?.labelIndex !== undefined).length,
      startScale: dots[0]?.scale.x ?? null,
      arrows: G.children.filter((o) => o.isMesh && o.geometry?.type === 'ConeGeometry')
        .map((c) => { const d = new V(0, 1, 0).applyQuaternion(c.quaternion);
          return [Math.round(d.x * 100) / 100, Math.round(-d.z * 100) / 100]; }),
    };
  })()`);
  const gi = await gizInfo();
  const wpNow = JSON.parse(await wpOf());
  check('점마다 번호가 뜬다', gi.dots === gi.labels && gi.labels === wpNow.length,
    `점 ${gi.dots} · 번호 ${gi.labels} · 경로 점 ${wpNow.length}`);
  check('출발점이 다른 크기다', gi.startScale > 1.2, `1번 점 크기 ${gi.startScale}`);
  // **화살표는 선분 벡터를 따른다** — 부호가 뒤집히거나 짝이 어긋나면 여기서 갈린다
  const wantDir = [];
  for (let i = 1; i < wpNow.length; i += 1) {
    const dxv = wpNow[i][0] - wpNow[i - 1][0]; const dyv = wpNow[i][1] - wpNow[i - 1][1];
    const L3 = Math.hypot(dxv, dyv) || 1;
    wantDir.push([Math.round((dxv / L3) * 100) / 100, Math.round((dyv / L3) * 100) / 100]);
  }
  const dirOk = gi.arrows.length === wantDir.length
    && gi.arrows.every((a2, i) => Math.abs(a2[0] - wantDir[i][0]) < 0.03
      && Math.abs(a2[1] - wantDir[i][1]) < 0.03);
  check('화살표가 진행 방향을 가리킨다', dirOk,
    `화살표 ${JSON.stringify(gi.arrows)} · 기대 ${JSON.stringify(wantDir)}`);

  check('점이 100mm 격자에 붙는다',
    JSON.parse(wp1).every((q) => q[0] % 100 === 0 && q[1] % 100 === 0), wp1);

  await p.eval(`dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })); 'ok'`);
  await new Promise((r) => setTimeout(r, 400));
  check('⌘Z 가 경로 편집도 되돌린다', (await wpOf()) === wp0, `${wp1} →(⌘Z) ${await wpOf()}`);

  // **번호 라벨이 GPU 에 쌓이지 않는다.** 라벨은 `CanvasTexture` 라 지오메트리 정리로는
  // 안 없어진다 — 배치안을 고칠 때마다 뷰가 새로 만들어지므로, 안 지우면 **점을 한 번 끌
  // 때마다 텍스처가 점 개수만큼 쌓인다** (고치기 전 실측: 10번 끌자 10→50 · 2026-08-04).
  const texOf = () => p.eval(`window.__stage.renderer.info.memory.textures`);
  const tex0 = await texOf();
  for (let n = 0; n < 6; n += 1) {
    const dd = await p.eval(`(() => {
      const G = window.__stage.scene.getObjectByName('pathGizmo');
      const b2 = document.querySelector('canvas').getBoundingClientRect();
      const o = G.children.find((x) => x.userData?.pointIndex === 1);
      const V = Object.getPrototypeOf(window.__stage.camera.position).constructor;
      const v = o.getWorldPosition(new V()); v.project(window.__stage.camera);
      return [Math.round(b2.left + (v.x + 1) / 2 * b2.width), Math.round(b2.top + (1 - v.y) / 2 * b2.height)];
    })()`);
    await p.eval(`(() => { const h = document.querySelector('.view3d-host');
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${dd[0]}, clientY: ${dd[1]}, pointerId: 1, button: 0 }));
      h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${dd[0] + 12}, clientY: ${dd[1]}, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${dd[0] + 12}, clientY: ${dd[1]}, pointerId: 1 }));
      return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 160));
  }
  const tex1 = await texOf();
  check('경로를 여러 번 고쳐도 텍스처가 안 쌓인다', tex1 <= tex0 + 2,
    `6번 끌기 · 텍스처 ${tex0} → ${tex1}`);

  // ── 21. 사건에 AMR 을 붙인다 ─────────────────────────────────────────
  //
  // 이 칸이 없어서 **화면만으로는 터틀봇을 움직일 방법이 아예 없었다.** 경로는 그릴 수
  // 있는데 그 경로를 언제 타는지 말할 데가 없었다 (2026-08-04 · 실기 담당자 지적).
  await p.eval(`document.querySelector('[data-t=path-toggle]')?.click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 300));
  if (!(await p.eval(`!!document.querySelector('[data-t=timeline]')`))) {
    await p.eval(`document.querySelector('[data-t=tl-toggle]').click(); 'ok'`);
    await new Promise((r) => setTimeout(r, 500));
  }
  await p.eval(`document.querySelector('[data-t=tl-mark][data-i="9"]')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 400 })); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=ev-amr]')`);
  const fields = await p.eval(`[...document.querySelectorAll('.ev-menu label')]
    .map((l) => l.childNodes[0].textContent.trim()).join(',')`);
  check('사건 메뉴에 AMR 칸이 있다', fields.includes('AMR'), fields);

  const pickSel = (t, v) => p.eval(`(() => { const s = document.querySelector('[data-t=${t}]');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, '${v}');
    s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  const ev9 = () => p.eval(`(() => {
    const S = JSON.parse(localStorage.getItem('fr5.scenarios'));
    const e = (S.items[window.__fr5edit.scenarioId] ?? Object.values(S.items)[0]).events[9];
    return JSON.stringify({ amr: e.amr ?? null, amrAt: e.amrAt ?? null });
  })()`);
  await pickSel('ev-amr', 'amr2');
  await new Promise((r) => setTimeout(r, 400));
  // **둘이 짝이다** — 하나만 적으면 재생기가 목적지를 모른다. 고르면 자리도 같이 채운다
  const paired = JSON.parse(await ev9());
  check('AMR 을 고르면 목적지도 같이 채워진다', paired.amr === 'amr2' && Boolean(paired.amrAt),
    await ev9());
  await pickSel('ev-amrat', 'ship');
  await new Promise((r) => setTimeout(r, 400));
  check('AMR 목적지를 바꿀 수 있다', JSON.parse(await ev9()).amrAt === 'ship', await ev9());

  // ── 22. 빈 방에 AMR 을 놓는다 (P1) ──────────────────────────────────
  //
  // 전에는 프리셋에만 AMR 이 있어서 **빈 방에서 시작하면 터틀봇을 추가할 방법이 아예
  // 없었다** (실기 담당자 지적 · 2026-08-04). 경로 기능이 다 돌아도 놓을 수가 없으면 못 쓴다.
  await p.eval(`localStorage.clear(); 'ok'`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await new Promise((r) => setTimeout(r, 1400));
  check('빈 방에는 AMR 이 없다', (await p.eval(`${edit}.wp.length`)) === 0, `${await p.eval(`${edit}.wp.length`)}대`);
  const hasCard = await p.eval(`[...document.querySelectorAll('.part-card')].some((c) => c.textContent.includes('터틀봇'))`);
  check('팔레트에 터틀봇 카드가 있다', hasCard);
  await p.eval(`(() => { const c = [...document.querySelectorAll('.part-card')]
    .find((x) => x.textContent.includes('터틀봇')); c?.click(); return 'ok'; })()`);
  await p.waitFor(`${edit}.wp.length === 1`);
  const wpNew = JSON.parse(await p.eval(`JSON.stringify(${edit}.wp)`));
  // **경로를 갖고 태어난다** — 점이 없으면 `[경로]` 를 켜도 끌 것이 없다
  check('놓은 AMR 이 경로를 갖고 태어난다', (wpNew[0]?.[1] ?? []).length >= 2,
    JSON.stringify(wpNew));
  await p.navigate(`${URL}?scene=${await p.eval(`${edit}.current`)}`);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await new Promise((r) => setTimeout(r, 1000));
  check('놓은 AMR 이 새로고침 뒤에도 남는다',
    (await p.eval(`${edit}.wp.length`)) === 1, await p.eval(`JSON.stringify(${edit}.wp)`));

  // ── 23. 타임라인 AMR 띠 (P4) ────────────────────────────────────────
  //
  // 전에는 **마커를 하나씩 우클릭해야** AMR 이 언제 어디로 가는지 알 수 있었다
  // (실기 담당자 지적 · 2026-08-04). 구간은 `timeline.js` §amrAt 규약대로 **사건 시각이 도착
  // 시각**이라 앞 사건(없으면 0초)부터 그 사건까지가 이동 구간이다.
  await p.eval(`localStorage.clear(); 'ok'`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await p.eval(`(() => {
    const s = document.querySelector('.scene-pick');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, 'new:cell');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await p.waitFor(`${edit}.props === 18`);
  await new Promise((r) => setTimeout(r, 1200));
  await p.eval(`document.querySelector('[data-t=tl-toggle]').click(); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=timeline]')`);
  await new Promise((r) => setTimeout(r, 400));

  const bandOf = () => p.eval(`(() => [...document.querySelectorAll('[data-t^=tl-amr-]')]
    .map((r) => ({ id: r.dataset.t.replace('tl-amr-', ''),
      legs: [...r.querySelectorAll('i')].map((i) => ({ text: i.textContent, tip: i.title,
        left: i.style.left, width: i.style.width })) })))()`);
  const band0 = await bandOf();
  // **안 움직이는 AMR 은 줄이 없다** — 빈 줄을 그으면 그것도 거짓말이다
  check('사건이 있는 AMR 만 띠가 뜬다', band0.length === 1 && band0[0].id === 'amr1',
    JSON.stringify(band0.map((b2) => b2.id)));
  check('띠가 목적지 이름을 보여준다', band0[0]?.legs?.[0]?.text === '탄체 팔레트',
    band0[0]?.legs?.[0]?.text ?? '(없음)');
  // 0~4초 = 사이클 49초의 8.16% — 자리와 폭이 시각을 그대로 따른다
  check('띠가 사건 시각을 그대로 따른다',
    band0[0]?.legs?.[0]?.left === '0%'
      && Math.abs(parseFloat(band0[0]?.legs?.[0]?.width) - (4 / 49) * 100) < 0.1,
    `${band0[0]?.legs?.[0]?.tip} · left ${band0[0]?.legs?.[0]?.left} width ${band0[0]?.legs?.[0]?.width}`);

  // 사건에 AMR 을 붙이면 **줄이 생긴다**
  await p.eval(`document.querySelector('[data-t=tl-mark][data-i="9"]')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 400 })); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=ev-amr]')`);
  const pick2 = (t, v) => p.eval(`(() => { const s = document.querySelector('[data-t=${t}]');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(s, '${v}');
    s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await pick2('ev-amr', 'amr2');
  await new Promise((r) => setTimeout(r, 400));
  await pick2('ev-amrat', 'ship');
  await new Promise((r) => setTimeout(r, 600));
  const band1 = await bandOf();
  check('AMR 을 사건에 붙이면 띠가 생긴다',
    band1.length === 2 && band1.some((b2) => b2.id === 'amr2' && b2.legs[0]?.text === '배출 시작'),
    JSON.stringify(band1.map((b2) => `${b2.id}:${b2.legs[0]?.text}`)));

  // **구간이 둘일 때가 진짜 판정이다.** 하나뿐이면 시작이 늘 0 이라, 앞 사건을 무시해도
  // 검사가 통과한다 — 실제로 주입해 보고 98/98 이 그대로 나왔다 (2026-08-04).
  // 두 번째 다리는 **앞 사건 시각**에서 시작해야 한다.
  await p.eval(`document.querySelector('[data-t=tl-mark][data-i="12"]')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 400 })); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=ev-amr]')`);
  await pick2('ev-amr', 'amr2');
  await new Promise((r) => setTimeout(r, 400));
  await pick2('ev-amrat', 'exit');
  await new Promise((r) => setTimeout(r, 600));
  const band2 = (await bandOf()).find((b2) => b2.id === 'amr2');
  const leg2 = band2?.legs?.[1];
  // 사건 9 = 36초 · 사건 12 = 49초 → 두 번째 다리는 36초에서 시작한다 (73.47%)
  check('두 번째 다리가 앞 사건 시각에서 시작한다',
    band2?.legs?.length === 2 && Math.abs(parseFloat(leg2?.left) - (36 / 49) * 100) < 0.1,
    `다리 ${band2?.legs?.length ?? 0}개 · 두 번째 ${leg2?.tip ?? '(없음)'} left ${leg2?.left ?? '?'}`);

  // ── 24. 좌측 패널이 부품과 시나리오를 가른다 ─────────────────────────
  //
  // `작업 지점 ①~⑥` 은 부품이 아니라 **시나리오가 이름으로 부르는 어휘**인데 소품 옆에
  // 있었다. 그래서 경로를 그린 다음 "이걸 어디에 넣지" 가 나왔다 (실기 담당자 지적 · 2026-08-04).
  const catsOf = () => p.eval(`[...document.querySelectorAll('.palette-list h4')].map((h) => h.textContent).join(' | ')`);
  const partCats = await catsOf();
  check('부품 탭에 작업 지점이 없다', !partCats.includes('작업 지점'), partCats);
  await p.eval(`document.querySelector('[data-t=tab-scenario]').click(); 'ok'`);
  await p.waitFor(`document.querySelectorAll('[data-t=scn-row]').length > 0`);
  const scnCats = await catsOf();
  check('시나리오 탭에 자리와 사건이 있다',
    scnCats.includes('작업 지점') && scnCats.includes('사건'), scnCats);
  const rowsP = await p.eval(`document.querySelectorAll('[data-t=scn-row]').length`);
  check('사건 줄이 사건 수만큼 뜬다', rowsP === (await p.eval(`${edit}.events`)),
    `줄 ${rowsP} · 사건 ${await p.eval(`${edit}.events`)}`);

  // **여기서 고친 것도 같은 문으로 들어간다** — 타임라인 우클릭과 정본이 같아야 한다
  const setRow = (t, i, v, evt) => p.eval(`(() => {
    const el = document.querySelectorAll('[data-t=${t}]')[${i}];
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement : window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, '${v}');
    el.dispatchEvent(new Event('${evt}', { bubbles: true }));
    return 'ok'; })()`);
  const secsP = await p.eval(`${edit}.eventSecs`);
  await setRow('scn-t', 2, '11', 'change');
  await new Promise((r) => setTimeout(r, 400));
  check('패널에서 사건 시각을 고친다', (await p.eval(`${edit}.eventSecs`)) !== secsP,
    `${secsP} → ${await p.eval(`${edit}.eventSecs`)}`);
  await setRow('scn-name', 2, '투입', 'input');
  await new Promise((r) => setTimeout(r, 400));
  const evAt2 = () => p.eval(`(() => { const S = JSON.parse(localStorage.getItem('fr5.scenarios'));
    const e = (S.items[window.__fr5edit.scenarioId] ?? Object.values(S.items)[0]).events[2];
    return JSON.stringify({ event: e.event, amr: e.amr ?? null, amrAt: e.amrAt ?? null }); })()`);
  check('패널에서 사건 이름을 고친다', JSON.parse(await evAt2()).event === '투입', await evAt2());
  await setRow('scn-amr', 2, 'amr2', 'change');
  await new Promise((r) => setTimeout(r, 400));
  const withAmr = JSON.parse(await evAt2());
  check('패널에서 AMR 을 붙인다', withAmr.amr === 'amr2' && Boolean(withAmr.amrAt), await evAt2());

  const nEvP = await p.eval(`${edit}.events`);
  await p.eval(`document.querySelectorAll('[data-t=scn-del]')[2].click(); 'ok'`);
  await p.waitFor(`${edit}.events === ${nEvP - 1}`);
  check('패널에서 사건을 지운다', (await p.eval(`${edit}.events`)) === nEvP - 1);
  await p.eval(`document.querySelector('[data-t=scn-add]').click(); 'ok'`);
  await p.waitFor(`${edit}.events === ${nEvP}`);
  check('패널에서 사건을 더한다', (await p.eval(`${edit}.events`)) === nEvP);

  // ── 25. 경로를 시나리오에 넣는 길이 화면에 있다 ──────────────────────
  //
  // **같은 질문을 세 번 받았다** — "경로 끝난 걸 시나리오에 어떻게 추가하나" (2026-08-04).
  // 답은 "사건에 AMR 을 붙인다" 인데, `[경로 끝]` 을 눌러도 화면이 한 마디도 안 했다.
  // 그래서 말만 하지 않고 **대신 해 준다.**
  await p.eval(`localStorage.clear(); 'ok'`);
  await p.navigate(URL);
  await p.waitFor(`${edit}?.scenes >= 1`);
  await new Promise((r) => setTimeout(r, 1300));
  const clickCard = (t) => p.eval(`(() => { const c = [...document.querySelectorAll('.part-card')]
    .find((x) => x.textContent.includes('${t}')); c?.click(); return !!c; })()`);
  await clickCard('터틀봇');
  await p.waitFor(`${edit}.wp.length === 1`);
  await p.eval(`document.querySelector('[data-t=tab-scenario]').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 300));
  await clickCard('① 탄체');
  await new Promise((r) => setTimeout(r, 500));

  // **자리를 AMR 에서 떼어 놓는다.** 둘 다 방 가운데에 놓이면 자리가 AMR 을 가려
  // 클릭으로 못 고른다 (피킹은 앞엣것을 잡는다). 숫자칸은 **blur 에서 커밋**하고,
  // React 는 `onBlur` 를 `focusout` 으로 받으므로 진짜 `.focus()`→`.blur()` 여야 한다.
  const numSet = (label, v) => p.eval(`(() => {
    const nb = [...document.querySelectorAll('.view3d-pick .numbox')]
      .find((x) => x.textContent.trim().startsWith('${label}'));
    const i = nb?.querySelector('input');
    if (!i) return 'no';
    i.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, '${v}');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.blur();
    return 'ok';
  })()`);
  // **먼저 고른다.** 숫자칸은 고른 물건에만 뜬다 — 안 고르고 찾으면 `null` 이라
  // 자리가 안 옮겨지고, 그러면 AMR 이 자리 뒤에 가려 클릭으로 못 고른다 (2026-08-04).
  const pilePx = await p.eval(`window.__fr5view().at.pile`);
  await p.eval(`(() => { const c = document.querySelector('canvas');
    for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(t,
      { bubbles: true, clientX: ${pilePx?.[0] ?? 0}, clientY: ${pilePx?.[1] ?? 0}, pointerId: 1, button: 0 }));
    return 'ok'; })()`);
  await new Promise((r) => setTimeout(r, 350));
  await numSet('x', '1500');
  await new Promise((r) => setTimeout(r, 350));
  await numSet('y', '2000');
  await new Promise((r) => setTimeout(r, 450));

  // **잡힐 때까지 훑는다.** 투영 중심 한 점만 찍으면 앞의 물건에 가려 못 고르고,
  // 그러면 뒤 검사가 통째로 `null.click()` 으로 무너진다 (2026-08-04).
  const amrPts = await p.eval(`(() => {
    const st = window.__stage, b2 = document.querySelector('canvas').getBoundingClientRect();
    let g = null;
    st.scene.traverse((o) => { if (o.userData?.item?.kind === 'amr') g = o; });
    if (!g) return [];
    const V = Object.getPrototypeOf(st.camera.position).constructor;
    const out = [];
    g.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingSphere();
      const v = o.geometry.boundingSphere.center.clone();
      o.localToWorld(v); v.project(st.camera);
      out.push([Math.round(b2.left + (v.x + 1) / 2 * b2.width), Math.round(b2.top + (1 - v.y) / 2 * b2.height)]);
    });
    return out;
  })()`);
  let amrOk = false;
  for (const [x, y] of amrPts.slice(0, 20)) {
    await p.eval(`(() => { const c = document.querySelector('canvas');
      for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(t,
        { bubbles: true, clientX: ${x}, clientY: ${y}, pointerId: 1, button: 0 }));
      return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 120));
    if ((await p.eval(`${edit}.pickedId`)) === 'amr-1') { amrOk = true; break; }
  }
  check('놓은 AMR 을 클릭으로 고른다', amrOk, `후보 ${amrPts.length}점`);
  await p.eval(`document.querySelector('[data-t=path-toggle]')?.click(); 'ok'`);
  await p.waitFor(`!!document.querySelector('[data-t=path-edit]')`);
  check('경로 패널이 다음 걸음을 말한다',
    (await p.eval(`document.querySelector('[data-t=path-edit]')?.textContent ?? ''`)).includes('사건')
      && (await p.eval(`!!document.querySelector('[data-t=path-to-scenario]')`)),
    await p.eval(`!!document.querySelector('[data-t=path-to-scenario]')`) ? '넣기 버튼 있음' : '**버튼 없음**');

  const ev0 = await p.eval(`${edit}.events`);
  await p.eval(`document.querySelector('[data-t=path-to-scenario]').click(); 'ok'`);
  await p.waitFor(`${edit}.events === ${ev0 + 1}`);
  const made = await p.eval(`(() => { const S = JSON.parse(localStorage.getItem('fr5.scenarios'));
    const e = (S.items[window.__fr5edit.scenarioId] ?? Object.values(S.items)[0]).events.slice(-1)[0];
    return JSON.stringify({ amr: e.amr ?? null, amrAt: e.amrAt ?? null, tSec: e.tSec }); })()`);
  // **AMR 이 붙은 사건**이어야 한다 — 빈 사건을 만들면 여전히 아무 일도 안 일어난다
  check('한 번 눌러 그 AMR 이 붙은 사건이 생긴다',
    JSON.parse(made).amr === 'amr-1' && Boolean(JSON.parse(made).amrAt), made);
  check('시나리오 탭으로 데려가고 그 줄을 강조한다',
    (await p.eval(`document.querySelector('[data-t=tab-scenario]')?.className`)) === 'on'
      && (await p.eval(`document.querySelectorAll('.scn-row.hot').length`)) === 1,
    `강조 ${await p.eval(`document.querySelectorAll('.scn-row.hot').length`)}개`);

  // ── 13. 「시뮬」 탭 — **한 화면 · 깊은 것은 모달** (2026-08-12 개편) ───────
  // **배치를 여기서 굽는다.** `Sim/out/` 은 커밋 안 하므로(D14) 새 클론에는 없고,
  // 「배치 없음」 화면만 확인하면 차트를 한 번도 안 재고 통과한다.
  const baked = await runBatch({ n: 4, seed: 1, out: `${ROOT}/Sim/out` });
  await p.navigate(URL);
  await p.eval(`[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('시뮬')).click(); 'ok'`);
  const simReady = await p.waitFor(`document.querySelector('.simgrid .card svg') !== null`, { timeoutMs: 20000 });
  // 새로고침이 났는지 재는 표식 — 사라졌으면 페이지가 다시 로드된 것이다
  await p.eval(`window.__simProbe = 'alive'; 'ok'`);
  check('시뮬 탭이 그리드를 그린다', Boolean(simReady));

  // ⛔ **스크롤하지 않는다.** 세로로 늘어놓았더니 1,700px 이 됐고 아무도 아래를 안 봤다
  const overflow = await p.eval(`JSON.stringify((() => {
    const d = document.documentElement, s = document.querySelector('.sim');
    return { page: d.scrollHeight - d.clientHeight, sim: s.scrollHeight - s.clientHeight };
  })())`);
  const ov = JSON.parse(overflow);
  check('한 화면에 들어간다 (스크롤 0)', ov.page <= 2 && ov.sim <= 2, overflow);

  // 출처를 화면에 박지 않았나 — datasource 가 자기 이름을 말해야 한다 (SR_24)
  check('시뮬 출처 배지가 datasource 에서 온다',
    (await p.eval(`document.querySelector('.sim .source')?.dataset.src`)) === 'sim-files');
  // **누가 판정했나** — 지문이 없으면 게이트가 바뀐 뒤의 회차와 그 전을 못 가린다
  check('판정 지문이 화면에 뜬다',
    /[0-9a-f]{12}/.test(await p.eval(`document.querySelector('.simhead .fp')?.textContent ?? ''`)));

  // ── 13-c. 문구 규칙 — **화면이 자기 설계를 변호하지 않는다** (2026-08-12) ─────
  // 실측 1,233자였고 긴 대시 19회·부정 종결 19회였다. 캡션이 아니라 코드 주석이었던 것이다.
  // 1층(모달 밖)은 **값과 이름만** 놓는다 — 근거는 모달 안에서 말한다
  const proseStat = await p.eval(`JSON.stringify((() => {
    const t = [...document.querySelector('.simgrid').querySelectorAll('*')]
      .filter((e) => !e.children.length).map((e) => e.textContent.trim())
      // ⚠ **값이 없다는 표시(—)는 산문이 아니다** (2026-08-19). 이 검사가 막으려던 것은
      //   1층에 깔린 **설명 문장**이지, 빈 값 한 칸이 아니다. 안 거르면 완주 0 인 회차에서
      //   「보통 걸린 시간 —」 같은 칸이 늘어 검사가 엉뚱한 것을 붉힌다.
      .filter((x) => x !== '—').join(' ');
    return { len: t.length, dash: (t.match(/—/g) || []).length,
      neg: (t.match(/아니다|않는다|없다|못 [가-힣]|안 [가-힣]/g) || []).length };
  })())`);
  const ps = JSON.parse(proseStat);
  check('1층 문구가 값과 이름뿐이다 (400자 이하)', ps.len <= 400, `${ps.len}자`);
  check('긴 대시가 1층에 최대 하나다', ps.dash <= 1, `${ps.dash}회`);
  check('1층에 부정 종결이 없다', ps.neg === 0, `${ps.neg}회`);

  // ⛔ **없는 능력을 자랑하지 않는다** (D109) — 이 낱말들은 화면에 있으면 안 된다
  const brag = await p.eval(`JSON.stringify(['최적화','정책','성공률','optimize','policy']
    .filter((w) => document.querySelector('.sim').innerText.includes(w)))`);
  check('시뮬 탭에 금칙어가 없다', JSON.parse(brag).length === 0, brag);

  // ── 13-a. 0층 결정이 맨 위 ──────────────────────────────────────────────
  const verdictText = await p.eval(`document.querySelector('.sim .verdict')?.innerText ?? ''`);
  check('0층 결정이 그리드 첫 칸이다', await p.eval(
    `document.querySelector('.simgrid').firstElementChild?.classList.contains('verdict')`) === true,
    verdictText.slice(0, 60));
  // **효과 크기가 반드시 적힌다.** 상관만 쓰면 0.971 짜리 축이 0.03mm 를 움직이는 걸 못 본다
  check('결정이 효과 크기를 mm 로 적는다', /-?\d+(\.\d+)?mm/.test(verdictText),
    verdictText.replace(/\n/g, ' ⏎ ').slice(0, 110));

  // ── 13-b. 밴드는 진행률 축이고 0 선을 그린다 ────────────────────────────
  check('여유 밴드가 진행률 축이다',
    (await p.eval(`document.querySelector('.card.big svg')?.getAttribute('aria-label') ?? ''`)).includes('진행률'));
  check('여유 0 이 구역 경계로 표시된다',
    (await p.eval(`document.querySelector('.zerotag')?.textContent ?? ''`)).includes('구역 경계'));
  const segs = await p.eval(`document.querySelectorAll('.stepbar span').length`);
  check('단계마다 걸린 시간 막대가 단계마다 있다', segs >= 3, `${segs}칸`);
  // ⛔ **선의 수는 「4」가 아니라 「완주한 벌 수」다** (2026-08-19). 옛 검사는 시간초과한 벌도
  //   사이클을 낸다는 전제로 4 를 박아 뒀는데, 그 전제가 곧 화면의 거짓말이었다.
  //   완주가 0 이면 선이 0 인 것이 맞고, 그때는 **왜 없는지를 화면이 말하는지**를 대신 잰다.
  //   완주 수는 화면이 이미 KPI 로 들고 있다 — 같은 값을 두 군데서 읽지 않는다.
  const doneN = Number(await p.eval(`(() => {
    const d = [...document.querySelectorAll('.kpis dt')].find((e) => e.textContent.includes('끝까지 간'));
    return d ? (d.nextElementSibling.firstChild?.textContent ?? '').trim() : '';
  })()`));
  const bars = await p.eval(`document.querySelectorAll('.barcode').length`);
  if (doneN === 0) {
    const why = await p.eval(`document.querySelector('.card .empty')?.textContent ?? ''`);
    check('완주 0 이면 사이클을 안 그리고 사유를 말한다', bars === 0 && why.includes('완주한 벌이 0'),
      `${bars}선 · "${why}"`);
  } else {
    check('사이클 바코드가 완주한 벌마다 선을 긋는다', bars === doneN, `${bars}선 (완주 ${doneN}벌)`);
  }

  // ── 14. 모달 — 깊은 것은 전부 여기 있다 ────────────────────────────────
  // ⚠ **`nth-of-type` 으로 카드를 고르지 않는다** — 카드가 하나 늘거나 순서가 바뀌면
  //   검사가 조용히 딴 것을 누른다. 사람이 보는 **글자**로 고른다
  // ⚠ **「아무 모달이나 열렸나」로 재지 않는다** (2026-08-12). 앞 모달이 안 닫힌 채로 다음
  //   검사가 통과해 버려, 정작 열려야 할 화면이 없는데도 초록이 났다. **제목으로 확인한다.**
  const openSheet = async (expr, want) => {
    for (let i = 0; i < 3; i += 1) {
      const hit = await p.eval(`(() => { const e = ${expr};
        if (!e) return '대상 없음: ' + [...document.querySelectorAll('.chips .chip')].map((c) => c.textContent).join('|');
        e.click(); return 'ok'; })()`);
      if (hit !== 'ok') return hit;
      const ok = await p.waitFor(
        `(document.querySelector('dialog.sheet[open] h3')?.textContent ?? '').includes(${JSON.stringify(want)})`,
        { timeoutMs: 6000 });
      if (ok) return true;
      await closeSheet();          // 엉뚱한 것이 열려 있으면 닫고 다시 누른다
    }
    return `열지 못함: ${want}`;
  };
  // 닫기도 확인한다 — `?.click()` 이 빗나가면 조용히 안 닫히고 다음 검사가 그걸 통과시킨다
  async function closeSheet() {
    for (let i = 0; i < 3; i += 1) {
      await p.eval(`document.querySelector('dialog.sheet[open] .sheet-x')?.click(); 'ok'`);
      if (await p.waitFor(`document.querySelector('dialog.sheet[open]') === null`, { timeoutMs: 4000 })) return true;
      await p.key?.('Escape');
    }
    return false;
  }
  const cardNamed = (t) => `[...document.querySelectorAll('.simgrid .card')]`
    + `.find((c) => c.innerText.includes(${JSON.stringify(t)})).querySelector('.card-open')`;

  const oAxes = await openSheet(`document.querySelector('.verdict button')`, '조건 축');
  check('결정에서 조건 축 모달이 열린다', oAxes === true, String(oAxes));
  check('조건 축 표가 아홉 축을 다 보여준다 (안 흔든 축 포함)',
    (await p.eval(`document.querySelectorAll('dialog[open] .grid tbody tr').length`)) >= 9);
  // **상관 옆에 효과 크기가 있어야 한다** — 설명력 0.971 인 축의 효과가 0.03mm 였다
  check('조건 축이 설명력과 효과를 같이 낸다',
    (await p.eval(`document.querySelector('dialog[open] .grid thead')?.innerText ?? ''`)).includes('효과'));
  check('모달이 닫힌다', Boolean(await closeSheet()));

  // ⚠ 카드 제목이 **사람 말로 바뀌었다** (2026-08-13 · 토스 §Casual Concept). 게이트도 같이 간다
  const oSteps = await openSheet(cardNamed('단계마다 걸린 시간'), '단계마다 걸린 시간');
  check('단계별 시간 모달이 열린다', oSteps === true, String(oSteps));
  check('칸별 표가 못 재는 칸을 글자로 말한다',
    (await p.eval(`document.querySelector('dialog[open]')?.innerText ?? ''`)).includes('grip'));
  await closeSheet();

  const oEvents = await openSheet(`[...document.querySelectorAll('.chips .chip')].find((c) => c.textContent.includes('사건'))`, '사건 밀도');
  check('사건 밀도 모달이 열린다', oEvents === true, String(oEvents));
  check('밀도 띠가 종류 5행을 다 남긴다',
    (await p.eval(`document.querySelectorAll('dialog[open] .density.events tbody tr').length`)) === 5);
  await closeSheet();

  // ── 14-b. 3층 재생 — **로봇이 실제로 나온다** (2026-08-12) ───────────────
  // 어제는 손으로 그린 와이어프레임뿐이라 「로봇이 없는 그림」이었다. 계약이 정한 대로
  // `Shared/view3d` 를 쓰는지 — URDF 가 실제로 올라왔는지로 잰다
  const oReplay = await openSheet(`document.querySelector('.chips .chip:not(.ghost)')`, '#');
  check('대수 칩을 누르면 3D 가 열린다', oReplay === true, String(oReplay));
  const ready = await p.waitFor(`document.querySelector('.replay-3d')?.dataset.ready === '1'`, { timeoutMs: 30000 });
  // **한 번에 읽는다** — 셋으로 나눠 읽으면 그 사이에 모달이 닫혀 뒤엣것만 빨개진다
  const replay = JSON.parse(await p.eval(`JSON.stringify({
    ready: document.querySelector('.replay-3d')?.dataset.ready === '1',
    err: document.querySelector('.replay-3d')?.dataset.error ?? '',
    range: document.querySelectorAll('.replay-bar input[type=range]').length,
    toggle: document.querySelector('.simtoggle')?.textContent ?? '(없음)' })`));
  check('재생 화면에 URDF 로봇이 올라온다', Boolean(ready) && replay.ready, JSON.stringify(replay));
  check('재생 스크러버가 있다', replay.range === 1, JSON.stringify(replay));
  // 「시뮬레이션이 보는 것」 — 엔진만 아는 것(충돌 형상)을 여는 토글
check('시뮬레이션 형상 토글이 있다', replay.toggle.includes('시뮬레이션 형상'), JSON.stringify(replay));
  await closeSheet();

  // ── 14-c. 점군 — 무대가 있어야 읽힌다 ──────────────────────────────────
  const oCloud = await openSheet(`[...document.querySelectorAll('.chips .chip')].find((c) => c.textContent.includes('점군'))`, '스윕 볼륨');
  check('점군 모달이 열린다', oCloud === true, String(oCloud));
  const cloud = await p.waitFor(`document.querySelector('.cloud canvas') !== null`, { timeoutMs: 25000 });
  check('점군이 그려진다', Boolean(cloud));
  // ⚠ 캡션의 점 수·드로우콜은 **캔버스가 붙은 뒤** 채워진다 — 바로 읽으면 빈 값을 잰다
  await p.waitFor(`(document.querySelector('.cloud figcaption')?.innerText ?? '').includes('드로우콜')`,
    { timeoutMs: 10000 });
  const cap = await p.eval(`document.querySelector('.cloud figcaption')?.innerText ?? ''`);
  const calls = Number(cap.match(/드로우콜 (\d+)/)?.[1] ?? 0);
  // 버킷 3 + 무대 `LineSegments` 1 = 4 가 상한이다 (점 수와 무관 · D109).
  // 「정확히 3」으로 재지 않는다 — 슬롯 1 은 손끝이 내내 구역 200mm 안이라 먼 버킷이 빈다
  check('점군 드로우콜이 상한 이하다 (점 수와 무관)', calls >= 1 && calls <= 4, cap.slice(0, 60));
  check('점군에 무대(상판·여유선)가 있다', cap.includes('여유선'), cap.slice(0, 90));
  await closeSheet();

  // ── 15. 「생산성 비교」 탭 — **PRD 성공 판정의 앞 문장** (F8 · L3) ──────────
  // *"맵 두 개를 만들어 지표를 비교하고 몇 % 낫다를 근거와 함께 말한다."*
  //
  // 목업 `B` 는 선택 필드를 **일부러 뺐다** (`mock.js` §지표). 팀원이 처리량 하나만 내도
  // 화면이 그날 도는지를 여기서 겪는다 — 그 검증이 이 절의 절반이다 (SR_25).
  await p.navigate(URL);
  await p.eval(`[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('생산성')).click(); 'ok'`);
  // ⚠ **표는 데이터보다 먼저 뜬다** — 빈 칸을 「—」로 그리는 게 정상이라(SR_25) 표만 기다리면
  //    지표가 도착하기 전 문장을 읽는다. **결론 문장에 % 가 찍힐 때까지** 기다린다 (2026-08-13).
  const cmpReady = await p.waitFor(`/\\d+%/.test(document.querySelector('.cmp-lead')?.innerText ?? '')`,
    { timeoutMs: 20000 });
  check('비교 탭이 표를 그린다', Boolean(cmpReady)
    && (await p.eval(`document.querySelectorAll('.cmp-tab tbody tr').length`)) >= 8);

  // ⛔ **0층 결정이 맨 위다.** 표를 다 읽어야 결론이 나오면 근거가 아니라 그림이다
  const lead = await p.eval(`document.querySelector('.cmp-lead')?.innerText ?? ''`);
  check('한 문장에 "얼마나" 와 "몇 %" 가 같이 나온다',
    /\d+개/.test(lead) && /\d+%/.test(lead), lead.slice(0, 80));
  // ⛔ **화면 말투는 해요체 하나다** (2026-08-13 전수조사 — 한 화면에 두 말투가 섞여 있었다)
  // ⚠ 문장 뒤에 % 배지가 붙으므로 **문장만 떼어** 잰다 — 안 떼면 늘 「%」로 끝나 거짓으로 붉는다
  const sentence = await p.eval(`(() => { const p2 = document.querySelector('.cmp-lead').cloneNode(true);
    p2.querySelector('.cmp-pct')?.remove(); return p2.textContent.trim(); })()`);
  check('결론이 해요체다', /(어요|에요|예요)[.!]?$/.test(sentence), sentence);
  check('그 문장이 표보다 위에 있다',
    (await p.eval(`(() => { const l = document.querySelector('.cmp-lead'), t = document.querySelector('.cmp-tab');
      return l && t ? (l.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 : false; })()`)) === true);

  // **없는 값은 그 칸만 빈다** — 화면이 죽으면 우리 진행이 팀원 일정에 묶인다 (SR_25)
  const cells = await p.eval(`JSON.stringify((() => {
    const rows = [...document.querySelectorAll('.cmp-tab tbody tr')];
    return { rows: rows.length,
      dash: rows.filter((r) => r.children[2].textContent.trim() === '—').length,
      reqFilled: rows.filter((r) => r.className === 'req')
        .every((r) => r.children[1].textContent.trim() !== '—' && r.children[2].textContent.trim() !== '—') };
  })())`);
  const cs = JSON.parse(cells);
  check('선택 필드를 뺀 판이 살아 있다 (빈 칸은 —)', cs.rows >= 8 && cs.dash >= 3, cells);
  check('필수 둘은 양쪽 다 찼다 (처리량 · 사이클 평균)', cs.reqFilled === true, cells);

  // 출처 배지 — **목업을 실측으로 오인해 보고하는 것이 제일 비싼 사고다** (SR_24)
  // ⚠ **`.cmp-src` 를 고르는 칸 안으로 좁힌다** — 관절 판 캡션(F10)도 같은 배지를 쓴다.
  //    안 좁히면 동작 축에서 배지가 넷으로 잡혀 이 검사가 거짓으로 붉는다 (2026-08-13).
  const srcs = await p.eval(`JSON.stringify([...document.querySelectorAll('.cmp-pick .cmp-src')].map((s) => s.dataset.src))`);
  check('출처 배지가 양쪽에 뜬다', JSON.parse(srcs).length === 2 && JSON.parse(srcs).every((s) => s === 'mock'), srcs);

  // ⛔ **차트 라이브러리 0.** 막대는 우리가 그린 `<svg><rect>` 다
  check('막대가 SVG 로 그려진다 (의존성 0)',
    (await p.eval(`document.querySelectorAll('.cmp-bar svg rect').length`)) === 4);
  // **축이 0 에서 시작한다** — 큰 쪽이 폭 100 이어야 자른 축이 아니다
  const widths = await p.eval(`JSON.stringify([...document.querySelectorAll('.cmp-bar svg rect')].map((r) => Number(r.getAttribute('width'))))`);
  check('막대 축이 0 에서 시작한다 (최대가 100)',
    JSON.parse(widths).filter((w) => Math.abs(w - 100) < 0.01).length === 2, widths);

  // **비교 방향이 뒤집히지 않는다** — 사이클타임은 짧은 쪽이 낫다. 목업은 A 30.0 · B 37.5 라
  // A 가 −20.0% 이고 그건 **좋은 쪽**이다. 이 부호를 놓치면 화면이 거꾸로 말한다
  const dir = await p.eval(`JSON.stringify((() => {
    const r = [...document.querySelectorAll('.cmp-tab tbody tr')].find((x) => x.children[0].textContent.includes('하나 만드는'));
    if (!r) return { txt: '행이 없다', cls: '' };
    return { txt: r.children[3].textContent.trim(), cls: r.children[3].className };
  })())`);
  const dd = JSON.parse(dir);
  check('짧은 사이클이 좋은 쪽으로 칠해진다', dd.txt.startsWith('−') && dd.cls === 'good', dir);

  // ⛔ **막대 캡션도 같은 부호를 쓴다.** 처음엔 「좋다」를 `▲` 로 그렸는데, 사이클은 짧은 쪽이
  //    나아서 **짧은 막대 옆에 「▲ 20%」**가 서고 「높다」로 읽혔다 (2026-08-13 실렌더가 잡았다).
  const capt = await p.eval(`JSON.stringify([...document.querySelectorAll('.cmp-bars')]
    .map((f) => (f.querySelector('em')?.textContent ?? '')))`);
  check('막대 캡션이 표와 같은 부호를 쓴다',
    JSON.parse(capt).every((t) => t === '' || /^[+−]\d/.test(t)), capt);

  // ── 16. 동작 비교 (F10 · L4) — **PRD 의 와우모먼트** ──────────────────────
  // *"같은 조립 작업의 시퀀스 타임이 사람 시연 → 후처리 순으로 줄어드는 것을 나란히."*
  // **새 화면이 아니라 축 하나다** — 같은 표·같은 막대에 비교 대상만 바뀐다.
  await p.eval(`document.querySelector('.cmp-axis button[data-axis=motion]').click(); 'ok'`);
  await p.waitFor(`document.querySelector('.cmp-tab tbody tr th').textContent.includes('하나 만드는')`,
    { timeoutMs: 10000 });
  const mLead = await p.eval(`document.querySelector('.cmp-lead')?.innerText ?? ''`);
  check('동작 축에서 "얼마나 빨라졌는지" 가 나온다',
    /\d+초/.test(mLead) && /\d+%/.test(mLead) && mLead.includes('빨라졌어요'), mLead);

  // ⚠ **기준이 축마다 다르다.** 배치안은 「B 대비」인데 동작은 **「A 대비」**다 —
  //    「다듬은 것이 시연보다 몇 % 빨라졌다」의 기준은 **먼저 것**이기 때문이다.
  //    안 뒤집으면 같은 두 값에서 25.9 대신 35.0 이 나온다.
  // ⛔ 기준은 화면이 아니라 **§읽는 법** 안에서 말한다 (토스 §Less Policy) — 화면엔 값만 둔다
  check('표 머리에 기준 규칙을 안 적는다',
    (await p.eval(`document.querySelector('.cmp-tab thead th:last-child')?.textContent`)) === '차이');

  // 출처 배지 셋 중 둘 — `policy` 는 **지어내지 않는다** (모방학습 사다리 4 선행)
  const mSrc = await p.eval(`JSON.stringify([...document.querySelectorAll('.cmp-pick .cmp-src')].map((s) => s.dataset.src))`);
  check('동작 출처가 demo · postproc 다', JSON.stringify(JSON.parse(mSrc)) === '["demo","postproc"]', mSrc);
  // ⛔ **영어 코드값을 화면에 그대로 내지 않는다** — 읽을 수 있는 사람은 우리뿐이다
  check('배지가 사람 말로 뜬다',
    (await p.eval(`document.querySelector('.cmp-pick .cmp-src')?.textContent`)) === '사람이 가르친 것');
  check('없는 policy 를 화면에 세우지 않는다',
    (await p.eval(`[...document.querySelectorAll('.cmp-pick option')].filter((o) => o.textContent.includes('정책')).length`)) === 0);

  // ⛔ **같은 작업이어야 나란히 놓는다** — 사건·스테이션·단계 지문이 같아야 분모가 같다
  const mNums = await p.eval(`JSON.stringify((() => {
    const rows = [...document.querySelectorAll('.cmp-tab tbody tr')];
    const cell = (n, i) => rows.find((r) => r.children[0].textContent.includes(n))?.children[i].textContent.trim();
    return { evtA: cell('작업 단계', 1), evtB: cell('작업 단계', 2), evtD: cell('작업 단계', 3),
      cycA: cell('하나 만드는', 1), cycB: cell('하나 만드는', 2), cycD: cell('하나 만드는', 3),
      posA: cell('자세', 1), posB: cell('자세', 2) };
  })())`);
  const mn = JSON.parse(mNums);
  check('두 동작의 사건 수가 같다 (같은 작업)', mn.evtA === mn.evtB && mn.evtD === '같음', mNums);
  check('시퀀스 타임이 줄어든다 (다듬은 쪽이 짧다)',
    Number(mn.cycB) < Number(mn.cycA) && mn.cycD.startsWith('−'), mNums);
  // **관절을 다양하게 쓴다** — 사람 시연이 더 많은 자세를 거치는 것이 숫자로 보여야 한다
  check('사람 시연이 더 많은 자세를 거친다', Number(mn.posA) > Number(mn.posB), mNums);

  // 방향 없는 값에는 **색을 안 칠한다** — 자세가 적은 것이 곧 나은 것은 아니다
  check('방향 없는 값은 색이 없다',
    (await p.eval(`[...document.querySelectorAll('.cmp-tab tbody tr')]
      .find((r) => r.children[0].textContent.includes('자세'))?.children[3].className`)) === '');

  // ── 16-b. 관절 재생 — **두 동작을 같은 진행률에 나란히** (Outcome 1) ────────
  check('관절 판이 둘이고 선이 6+6 이다',
    (await p.eval(`document.querySelectorAll('.jp').length`)) === 2
    && (await p.eval(`document.querySelectorAll('.jp-grid svg polyline').length`)) === 12);
  // ⛔ **세로축을 각자 맞추지 않는다** — 서로 다른 자로 그린 그림을 나란히 놓으면 크기가 거짓말한다.
  //    두 판의 같은 관절이 같은 값에서 같은 높이에 있어야 한다 (여기서는 시작점 j1 로 잰다)
  const yTop = await p.eval(`JSON.stringify([...document.querySelectorAll('.jp-grid svg')]
    .map((s) => s.querySelector('polyline').getAttribute('points').split(' ')[0].split(',')[1]))`);
  check('두 판의 세로축이 같은 범위다', JSON.parse(yTop)[0] === JSON.parse(yTop)[1], yTop);
  // 재생 머리를 밀면 **둘이 함께** 움직인다. 시계가 둘이면 「같은 시각」이 깨진다
  // ⚠ React 의 controlled range 는 `input` 이벤트로 온다 — `change` 는 안 잡힌다
  const headAt = () => p.eval(`JSON.stringify([...document.querySelectorAll('.jp-head')].map((l) => l.getAttribute('x1')))`);
  const h0 = await headAt();
  await p.eval(`(() => { const r = document.querySelector('.jp-bar input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(r, '600'); r.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  const h1 = await headAt();
  check('재생 머리가 둘 다 같은 진행률로 움직인다',
    h0 !== h1 && JSON.parse(h1)[0] === JSON.parse(h1)[1] && JSON.parse(h1)[0] === '60',
    `${h0} → ${h1}`);
  check('진행률이 글자로도 나온다',
    (await p.eval(`document.querySelector('.jp-bar b')?.textContent`)) === '60%');
  // ⛔ **가로축이 벽시계가 아니라 진행률이다** — 화면이 그걸 글자로 말한다
  check('가로축이 진행률이라고 화면이 말한다',
    (await p.eval(`document.querySelector('.jp-note')?.innerText ?? ''`)).includes('진행률'));

  // ── 16-c. 문구 규칙 — **시뮬 탭과 같은 자로 잰다** (2026-08-13) ────────────
  // 시뮬 탭 §13-c 가 쓰는 규칙 그대로다: 1층은 **값과 이름만** · 설계 근거는 모달 안 ·
  // 라벨은 명사 종결. 실측(08-13)으로 비교 탭이 **306자 · 설계 변호 두 줄**이었고
  // 시뮬은 291자 · 0줄이었다. 두 화면이 다른 자를 쓰면 사람이 탭마다 다시 읽는 법을 배운다.
  //
  // ⛔ **표의 빈 값 「—」은 산문이 아니다.** 골이 요구한 표시라(SR_25) 세는 데서 뺀다 —
  //    안 빼면 규칙이 데이터를 벌한다.
  const cmpProse = await p.eval(`JSON.stringify((() => {
    const root = document.querySelector('.cmp');
    const skip = (e) => e.closest('.cmp-tab tbody, .cmp-bar, option, .sheet');
    const t = [...root.querySelectorAll('*')].filter((e) => !e.children.length && !skip(e))
      .map((e) => e.textContent.trim()).filter(Boolean).join(' ');
    return { len: t.length, dash: (t.match(/—/g) || []).length,
      why: (t.match(/때문|이유|왜냐|아니다|않는다/g) || []) };
  })())`);
  const cp = JSON.parse(cmpProse);
  check('1층 문구가 값과 이름뿐이다 (400자 이하)', cp.len <= 400, `${cp.len}자`);
  check('1층에 설계 변호 문장이 없다', cp.why.length === 0, cp.why.join(','));
  check('긴 대시가 1층 산문에 최대 하나다', cp.dash <= 1, `${cp.dash}회`);
  // 근거는 **모달 안에서** 말한다 — 시뮬 탭의 「크게 ↗」와 같은 자리다
  await p.eval(`document.querySelector('[data-t=cmp-how]').click(); 'ok'`);
  const how = await p.waitFor(`document.querySelector('.sheet[open] .how dt') !== null`, { timeoutMs: 8000 });
  check('§읽는 법 모달이 열린다', Boolean(how));
  const howText = await p.eval(`document.querySelector('.sheet[open] .sheet-body')?.innerText ?? ''`);
  check('기준·축 설명이 모달 안에 있다',
    howText.includes('기준') && howText.includes('진행률'), `${howText.length}자`);
  await p.eval(`document.querySelector('.sheet[open] .sheet-x').click(); 'ok'`);

  // 축을 되돌리면 배치안 비교가 그대로 돌아온다 — 축이 상태를 안 망가뜨린다
  await p.eval(`document.querySelector('.cmp-axis button[data-axis=layout]').click(); 'ok'`);
  await p.waitFor(`document.querySelector('.cmp-tab tbody tr th').textContent.includes('한 시간에')`, { timeoutMs: 10000 });
  check('축을 되돌리면 배치안 비교가 돌아온다',
    (await p.eval(`document.querySelector('.cmp-tab tbody tr th').textContent`)).includes('한 시간에'));

  check('콘솔 오류 0건', p.consoleErrors.length === 0, p.consoleErrors.join(' | '));
} catch (e) {
  // **크래시를 삼키지 않는다.** `finally` 안의 `process.exit` 이 예외보다 먼저 돌기 때문에,
  // 잡아서 FAIL 로 적지 않으면 스크립트가 중간에 죽어도 "전부 통과" 로 보인다.
  // 실제로 그랬다 — 11·12 절이 안 도는 채 31/31 이었다 (2026-08-04).
  check('검증 스크립트가 끝까지 돈다', false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' ⏎ '));
} finally {
  console.log('');
  for (const [v, name, detail] of results) console.log(`  ${v}  ${name}${detail ? `  — ${detail}` : ''}`);
  const bad = results.filter(([v]) => v === 'FAIL').length;
  console.log(`\n  ${results.length - bad}/${results.length} 통과`);
  p.close();
  killTree(web);          // 위 §고아 — `process.on('exit')` 이 한 번 더 받친다
  process.exit(bad ? 1 : 0);
}
