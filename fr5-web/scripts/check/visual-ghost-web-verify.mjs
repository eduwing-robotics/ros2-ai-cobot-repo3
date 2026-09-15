// 공동 고스트 실브라우저 검증 — FR5 조작 화면이 고른 미리보기를 글로벌 카메라가
// 같은 /ws/state에서 읽고, 게시 화면이 닫히면 2초 안에 지우는지 본다.
// 로봇은 연결하지 않고 ?pose= 미리보기만 쓴다. 명령·ARM·이동 요청은 0이다.
// 실행: node scripts/check/visual-ghost-web-verify.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openPage } from './lib/cdp-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BRIDGE_PORT = 5162;
const FR5_PORT = 5191;
const AR_PORT = 5192;
const WHO = 'shared-view-check';
const JOINTS = [5, -20, 40, 0, 30, 0];
const FR5_URL = `http://localhost:${FR5_PORT}/?pose=${JOINTS.join(',')}&cam=127.0.0.1:9`;
// 고정물에는 컨베이어가 없으므로 배치 색 모델은 0개, 공동 파란 고스트만 남는다.
const CAM_URL = `http://localhost:${AR_PORT}/cam.html?only=conveyor`;
const LIVE_DEFAULT_URL = `http://localhost:${AR_PORT}/cam.html?feed=/test/cam-fixture/shot.png&scene=/test/cam-fixture/layout.json`;
const DATA = mkdtempSync(join(tmpdir(), 'fr5-visual-ghost-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const killTree = (child) => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 끝남 */ } }
};
const waitUp = async (url) => {
  for (let i = 0; i < 150; i += 1) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};

const bridge = spawn('uv', ['run', '--with', 'fastapi', '--with', 'uvicorn[standard]', '--with', 'pyyaml',
  'uvicorn', 'main:app', '--port', String(BRIDGE_PORT)], {
  cwd: join(ROOT, 'FR5/bridge'), detached: true, stdio: 'ignore',
  env: { ...process.env, FR5_DATA_DIR: DATA, FR5_TB_HOST: '' },
});
const env = { ...process.env, FR5_PORT: String(BRIDGE_PORT) };
const fr5 = spawn('npm', ['run', 'dev', '-w', '@fr5/fr5', '--', '--port', String(FR5_PORT), '--strictPort'],
  { cwd: ROOT, env, detached: true, stdio: 'ignore' });
const ar = spawn('npm', ['run', 'dev', '-w', '@fr5/ar', '--', '--port', String(AR_PORT), '--strictPort'],
  { cwd: ROOT, env, detached: true, stdio: 'ignore' });
const children = [bridge, fr5, ar];
process.on('exit', () => children.forEach(killTree));

let control = null;
let camera = null;
let token = null;
try {
  if (!await waitUp(`http://127.0.0.1:${BRIDGE_PORT}/state`)) throw new Error('브리지 기동 실패');
  if (!await waitUp(FR5_URL)) throw new Error('FR5 Vite 기동 실패');
  if (!await waitUp(CAM_URL)) throw new Error('AR Vite 기동 실패');

  const claim = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/owner/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who: WHO }),
  }).then((r) => r.json());
  token = claim.token;
  if (!token) throw new Error(`조종권 시험 준비 실패: ${JSON.stringify(claim)}`);

  control = await openPage(FR5_URL, { port: 9361, windowSize: '1280,900' });
  await control.eval(`localStorage.setItem('fr5-who', ${JSON.stringify(WHO)});
    sessionStorage.setItem('fr5.ownerToken', ${JSON.stringify(token)}); 'ok'`);
  await control.navigate(FR5_URL);
  const published = await control.waitFor(`window.FR5_STATE?.owner === ${JSON.stringify(WHO)}
    && window.FR5_VISUAL?.().active === true && window.FR5_VISUAL?.().connected === true
    && window.FR5_VISUAL?.().seq > 0`, { timeoutMs: 15000 });
  check('FR5 미리보기가 별도 시각화 소켓으로 게시된다', Boolean(published));

  camera = await openPage(CAM_URL, { port: 9362, windowSize: '1280,900' });
  const received = await camera.waitFor(`globalThis.__cam?.ghost?.visible === true
    && globalThis.__cam?.ghost?.state?.kind === 'preview'
    && globalThis.__cam?.ghost?.state?.jointsDeg?.join(',') === ${JSON.stringify(JOINTS.join(','))}`,
  { timeoutMs: 20000 });
  check('글로벌 카메라가 같은 preview 관절 6개를 받는다', Boolean(received));
  const shared = await camera.eval(`({
    ghost: globalThis.__cam.ghost,
    modelVisible: globalThis.__cam.stage.scene.getObjectByName('sharedCameraGhost')?.children?.[0]?.children?.[0]?.visible ?? false,
    hud: document.getElementById('ghost')?.textContent ?? '',
    coloredLayoutMeshes: (() => { let n = 0; globalThis.__cam.view?.root?.traverse(o => { if (o.isMesh && o.visible) n += 1; }); return n; })(),
    methods: Object.keys(globalThis.__cam),
  })`);
  check('화면 상태와 FR5 모델이 함께 보인다', shared.ghost.visible && shared.modelVisible, shared.hud);
  check('현장 기본층이 실제 작업대·로봇 색 모델을 다시 덮지 않는다', shared.coloredLayoutMeshes === 0,
    `배치 색 메시 ${shared.coloredLayoutMeshes}개`);
  check('관전자 훅에 명령 API가 없다', !shared.methods.some((k) => /claim|arm|move|stop|command/i.test(k)),
    shared.methods.join(','));
  if (process.env.VISUAL_GHOST_SHOT) {
    mkdirSync(dirname(process.env.VISUAL_GHOST_SHOT), { recursive: true });
    await camera.screenshot(process.env.VISUAL_GHOST_SHOT);
  }

  const lastSeq = shared.ghost.state.seq;
  const started = Date.now();
  await control.close(); control = null;
  const hidden = await camera.waitFor(`globalThis.__cam?.ghost?.visible === false`,
    { timeoutMs: 2500, intervalMs: 50 });
  const elapsed = Date.now() - started;
  check('게시 화면을 닫으면 2초 안에 고스트를 숨긴다', Boolean(hidden) && elapsed <= 2000,
    `${elapsed}ms · 마지막 seq ${lastSeq}`);

  // `feed`가 붙은 실영상 모드는 ?only를 사람이 안 적어도 계획 컨베이어만 남긴다.
  // 고정물 layout에는 팔·스테이션만 있고 컨베이어가 없으므로 보이는 색 메시가 0이어야 한다.
  await camera.navigate(LIVE_DEFAULT_URL);
  await camera.waitFor(`Boolean(globalThis.__cam?.view)`, { timeoutMs: 10000 });
  const liveMeshes = await camera.eval(`(() => { let n = 0;
    globalThis.__cam.view.root.traverse(o => { if (o.isMesh && o.visible) n += 1; }); return n; })()`);
  check('실영상 기본값은 ?only 없이도 계획 컨베이어만 남긴다', liveMeshes === 0,
    `고정물의 팔·스테이션 표시 메시 ${liveMeshes}개`);
} catch (e) {
  check('실행', false, e.message);
} finally {
  await control?.close?.();
  await camera?.close?.();
  if (token) await fetch(`http://127.0.0.1:${BRIDGE_PORT}/owner/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ who: WHO, token }),
  }).catch(() => {});
  children.forEach(killTree);
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed}건 실패` : `\n${results.length}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
