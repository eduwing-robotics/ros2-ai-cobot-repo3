// 글로벌 카메라 겹치기 실렌더 검증 — `AR/cam.html` 을 실제 브라우저로 띄워 판정한다.
//
// **눈으로 "맞는 것 같다" 로 끝내지 않는다.** 사진 속 태그를 cv2 로 다시 검출해 얻은 중심과,
// 화면이 실제로 쓰는 카메라로 실험실 좌표를 투영한 픽셀을 **숫자로 대조**한다
// (evidence/2026-08-02 §S4 와 같은 방법).
//
// 실행: node scripts/check/cam-web-verify.mjs
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openPage } from './lib/cdp-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5188;
const BASE = `http://localhost:${PORT}/cam.html`;
const MAX_PX = 3;          // S4 실측이 0.83px. 여유를 3배 두되 이 이상은 어긋난 것이다

const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 정답 — 합성 사진에서 태그를 **다시 검출**해 중심 픽셀을 얻는다. 참값을 쓰지 않는다.
const truth = JSON.parse(execFileSync('python3', ['-c', `
import json
import cv2, numpy as np
from pathlib import Path
root = Path(${JSON.stringify(ROOT)})
spec = json.loads((root / "Shared/assets/tag/tags.json").read_text(encoding="utf-8"))
dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, spec["family"]))
g = cv2.imread(str(root / "AR/test/cam-fixture/shot.png"), cv2.IMREAD_GRAYSCALE)
c, i, _ = cv2.aruco.ArucoDetector(dic, cv2.aruco.DetectorParameters()).detectMarkers(g)
print(json.dumps({int(k): np.mean(q[0], axis=0).tolist() for q, k in zip(c, i.ravel())}))
`], { encoding: 'utf8' }));
check('사진에서 태그 4장 재검출', Object.keys(truth).length === 4, Object.keys(truth).join(','));

// **`SIGTERM` 은 `npm run` 에서 멈추고 자식 vite 까지 안 간다** — 포트를 쥔 채 남아
// 다음 판이 `--strictPort` 에 막히고, 그때 원인은 화면처럼 보인다. 손으로 한 번씩 부를 때는
// 절대 안 보이고 `all.sh` 에 넣는 순간 드러난다 (2026-08-06 FR5 에서 밟은 것과 같은 함정).
const web = spawn('npm', ['run', 'dev', '-w', '@fr5/ar', '--', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore', detached: true });
const killTree = (c) => { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* 이미 죽음 */ } } };
process.on('exit', () => killTree(web));   // 예외·중단에도 고아 0
const waitUp = async (url) => {
  for (let i = 0; i < 150; i += 1) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => { setTimeout(r, 200); });
  }
  return false;
};

let p = null;
try {
  if (!await waitUp(BASE)) throw new Error('vite dev 기동 실패');

  // ── 1. 고정물 그대로 (배율 없음)
  p = await openPage(BASE, { port: 9351, windowSize: '1280,900' });
  await p.waitFor('Boolean(globalThis.__cam?.view)');
  const base = await p.eval(`(() => {
    const c = globalThis.__cam;
    return {
      scale: c.view.root.scale.x,
      name: document.getElementById('sceneName').textContent,
      hud: document.getElementById('scale').textContent,
      // 카메라 상태는 #status 가 아니라 상태 띠가 낸다 (2026-08-07 · Shared/data/camera/state.js).
      // 이 블록은 템플릿 문자열 안이라 주석에 백틱을 쓰면 문자열이 거기서 끊긴다
      warn: document.querySelector('[data-t="cam-hud-calib"]')?.dataset.tone ?? '없음',
      warnText: document.querySelector('[data-t="cam-hud-calib"]')?.textContent ?? '',
      slab: c.view.root.getObjectByName('slab')?.visible,
      canvas: document.querySelector('#host canvas')?.width ?? 0,
      bg: c.stage.scene.background,
      px: [[300,300,0],[2700,300,0],[2700,1300,0],[300,1300,0]].map((L) => c.toPixel(L)),
    };
  })()`);
  check('배치안이 파일에서 올라온다 (하드코딩 아님)', base.name === '합성 고정물', base.name);
  check('배율 없으면 1:1', base.scale === 1, base.hud);
  check('바닥 슬래브는 숨긴다 — 영상의 진짜 바닥을 가리지 않는다', base.slab === false);
  check('배경 투명 — 영상이 비친다', base.bg === null);
  check('캔버스가 그려졌다', base.canvas > 0, `${base.canvas}px`);
  check('합성 고정물이라고 경고한다', base.warn === 'warn' && base.warnText.includes('실측 아님'),
    `${base.warn} · ${base.warnText}`);

  // ── 2. 정합 — 태그 lab 좌표를 화면 카메라로 투영한 값 ↔ 사진에서 검출한 중심
  const worst = [0, 1, 2, 3].reduce((mx, i) => {
    const [gx, gy] = base.px[i];
    const [tx, ty] = truth[i];
    return Math.max(mx, Math.hypot(gx - tx, gy - ty));
  }, 0);
  check(`정합 — 스테이션 좌표 ↔ 사진 속 태그 중심 (한계 ${MAX_PX}px)`,
    worst < MAX_PX, `최대 ${worst.toFixed(2)}px`);

  // ── 3. 배율 — 태그 사각형에 맵을 맞춘다 (floor 3000x1600 · fit 1200x800 → 0.40)
  await p.close?.();
  p = await openPage(`${BASE}?fit=1200x800&anchor=500,400`, { port: 9352, windowSize: '1280,900' });
  await p.waitFor('Boolean(globalThis.__cam?.view)');
  const fit = await p.eval(`(() => {
    const c = globalThis.__cam;
    const r = c.view.root;
    return { s: r.scale.x, y: r.scale.y, z: r.scale.z, pos: r.position.toArray(),
             hud: document.getElementById('scale').textContent };
  })()`);
  check('fit 배율이 짧은 쪽으로 잡힌다', Math.abs(fit.s - 0.4) < 1e-9, `${fit.s}`);
  check('균일 스케일 — 로봇이 찌그러지지 않는다', fit.s === fit.y && fit.y === fit.z);
  check('앵커가 planToScene 규약대로 놓인다 (500,400 → x .5 · z -.4)',
    Math.abs(fit.pos[0] - 0.5) < 1e-9 && Math.abs(fit.pos[2] + 0.4) < 1e-9, JSON.stringify(fit.pos));
  check('배율을 화면에 적는다 — 실물 크기가 아님을 말한다',
    /1:2\.5/.test(fit.hud) && /실물 크기 아님/.test(fit.hud), fit.hud);

  // ── 3.5 판정면 겹치기 (2026-08-13 · GOAL-cam-zone-overlay)
  //
  // **`?fit=` 페이지에서 잰다.** 판정면이 배치안 축척을 타면 안 된다는 것이 이 골의 §2 이고,
  // 1:1 페이지에서 재면 축척 1 이라 **타든 안 타든 통과**한다. 0.4 배 페이지라야 갈린다.
  //
  // 값은 밖에서 밀어 넣는다 — dev 에는 브리지가 없고, 있어도 실기 값은 날마다 바뀌어
  // 게이트 기준이 못 된다. 자리 계산이 맞는지는 **고정 입력**으로만 잰다.
  const ZB = { xMm: 285, yMm: -179, zMm: 1.5, yawDeg: 177.1 };
  const ZWS = { boxes: [{ name: '검사판', xMm: [-100, 100], yMm: [-100, 100], topZMm: 0, marginMm: 10 }],
    walls: [{ name: '검사벽', aMm: [0, 0], bMm: [500, 0], marginMm: 100 }] };
  const ZD = JSON.stringify({ ws: ZWS, userDef: [0, 0, 0, 0, 0, 0], base: ZB });

  const z = await p.eval(`(() => {
    const c = globalThis.__cam;
    const drawn = c.setZones({ ...${ZD}, });
    const zz = c.zones, r = zz?.root;
    const yaw = r?.children?.[0];
    return {
      drawn, boxes: zz?.boxes ?? null, walls: zz?.walls ?? null,
      errPx: zz?.errPx ?? null, trust: zz?.trust ?? null, dim: zz?.dim ?? null,
      scale: r ? r.scale.x : null,
      parentIsScene: r ? r.parent === c.stage.scene : null,
      pos: r ? r.position.toArray() : null,
      yawZ: yaw ? yaw.rotation.z : null,
      text: document.getElementById('zones').textContent,
    };
  })()`);
  // 자리 — planToScene([x,y,z]) = [mm(x), mm(z), -mm(y)] 이므로 (285,-179,1.5) → (.285,.0015,.179)
  const wantPos = [0.285, 0.0015, 0.179];
  check('판정면이 선다 — 상자 1 · 벽 1',
    z.drawn === true && z.boxes === 1 && z.walls === 1, `${z.boxes}·${z.walls}`);
  check('판정면은 배치안(?fit=0.4) 축척을 안 탄다 — 1:1 이다',
    z.scale === 1 && z.parentIsScene === true, `scale ${z.scale} · sceneChild ${z.parentIsScene}`);
  check('로봇 베이스 자리가 planToScene 규약대로다 (285,-179,1.5)',
    z.pos && wantPos.every((v, i) => Math.abs(z.pos[i] - v) < 1e-9), JSON.stringify(z.pos));
  check('베이스 yaw 가 걸린다 (177.1°)',
    Math.abs(z.yawZ - (177.1 * Math.PI) / 180) < 1e-9, `${z.yawZ}`);
  check('왜곡 대가를 숫자로 말한다', /어긋남/.test(z.text) && Number.isFinite(z.errPx), z.text);

  // 팔레트 — **실영상용을 쓰는가.** 트윈 값(마진 0.14)은 흰 상판 위에서 안 읽힌다
  // (2026-08-13 실측: 확대해야 보였다). 색은 `Shared/view3d/zone-theme.js` 한 곳에서 온다.
  // 불투명도가 아니라 **색**을 본다 — 정합이 노랑이면 화면이 불투명도를 낮추므로(의도된 동작)
  // 그 값으로 판정하면 검사가 흔들린다
  const pal = await p.eval(`(() => {
    const out = { face: null, margin: null };
    globalThis.__cam.zones.root.traverse((o) => {
      if (!o.material || !o.name) return;
      if (o.name.startsWith('boxMargin:')) out.margin = o.material.color.getHex();
      else if (o.name.startsWith('box:')) out.face = o.material.color.getHex();
    });
    return out;
  })()`);
  check('실영상 팔레트를 쓴다 (트윈 값이 아니다)',
    pal.face === 0x1f6fd0 && pal.margin === 0xff7a1a,
    `face #${(pal.face ?? 0).toString(16)} · margin #${(pal.margin ?? 0).toString(16)}`);
  check('판정면과 여유가 다른 색이다 — 「어디부터 거부되나」가 색으로 갈린다',
    pal.face !== pal.margin);

  // 결측 = 차단 (제1원칙). **없는 경계를 그리면 그게 거짓말이다**
  const zNo = await p.eval(`(() => {
    const c = globalThis.__cam;
    const a = c.setZones({ ws: null });
    const t1 = document.getElementById('zones').textContent;
    c.setZones({ ws: ${JSON.stringify(ZWS)}, base: null });
    const t2 = document.getElementById('zones').textContent;
    return { a, t1, t2, zones: c.zones };
  })()`);
  check('작업영역이 없으면 안 그리고 사유를 말한다',
    zNo.a === false && zNo.zones === null && /브리지가 작업영역을 안 준다/.test(zNo.t1), zNo.t1);
  check('로봇 베이스가 없으면 안 그리고 사유를 말한다',
    /로봇 베이스 미등재/.test(zNo.t2), zNo.t2);

  // ── 3.6 정합 3단 — **「모른다」와 「틀렸다」를 가른다** (2026-08-13)
  //
  // 얼어붙은 빨간불을 「무효」로 읽으면 멀쩡한 캘리브 위에서 화면이 스스로를 지운다.
  // 실측이 그 함정을 냈다: rmsPx 347.42 가 08-10 에 멈춰 있는데 캘리브는 08-12 것이었다.
  // **고장 주입으로 세 얼굴을 다 본다** — 「검사가 있다」와 「검사가 잡는다」는 다르다.
  const shot = await p.eval(`globalThis.__cam.calib?.labToCam?.shot ?? null`);
  const drift3 = await p.eval(`(() => {
    const c = globalThis.__cam, out = {};
    c.setZones({ ws: ${JSON.stringify(ZWS)}, userDef: [0,0,0,0,0,0], base: ${JSON.stringify(ZB)} });
    const snap = () => ({ drawn: c.zones !== null, dim: c.zones?.dim ?? null,
                          trust: c.zones?.trust ?? null,
                          text: document.getElementById('zones').textContent });
    c.setDrift({ basis: ${JSON.stringify(shot)}, rmsPx: 0.5, t: Date.now()/1000 });
    out.ok = snap();
    c.setDrift({ basis: 'tags-옛날-remount3.jpg', rmsPx: 347.42, t: Date.now()/1000 });
    out.stale = snap();
    c.setDrift({ basis: ${JSON.stringify(shot)}, rmsPx: 347.42, t: Date.now()/1000 });
    out.invalid = snap();
    c.setDrift({ rmsPx: 347.42, t: Date.now()/1000 });      // 기준을 안 싣는 옛 감시기
    out.noBasis = snap();
    // **감시기가 죽으면 파일이 마지막 값에서 얼어붙는다** — 값은 초록인데 나이가 늙는다
    c.setDrift({ basis: ${JSON.stringify(shot)}, rmsPx: 0.5, t: Date.now()/1000 - 600 });
    out.dead = snap();
    return out;
  })()`);
  check('정합 초록 — 실선으로 그린다',
    drift3.ok.drawn === true && drift3.ok.dim === false, drift3.ok.text);
  check('정합 노랑(감시 꺼짐) — 지우지 않고 흐린다',
    drift3.stale.drawn === true && drift3.stale.dim === true
      && /감시 꺼짐/.test(drift3.stale.text), drift3.stale.text);
  check('정합 빨강(같은 기준인데 초과) — 선을 안 그린다',
    drift3.invalid.drawn === false && /정합 무효/.test(drift3.invalid.text), drift3.invalid.text);
  // **「무효」는 증거가 있어야 하는 주장이다.** 기준을 대조 못 하는데 빨강으로 떨어뜨리면
  // 멀쩡한 캘리브 위에서 화면이 스스로를 지운다 — 2026-08-13 에 이 검사가 그 버그를 잡았다
  check('기준을 모르면 빨강이 아니라 노랑 — 「모른다」와 「틀렸다」를 가른다',
    drift3.noBasis.drawn === true && drift3.noBasis.dim === true, drift3.noBasis.text);
  // **값이 초록이어도 감시기가 죽었으면 초록이 아니다.** 2026-08-13 실기에서 화면이
  // "겹침 감시가 멎었다 — 164초 전 값"이라고 말하면서 판정면은 `trust: ok` 였다 —
  // 화면이 자기 말과 다른 그림을 그린 것이다. 판정은 `state.js` 한 곳에서만 한다
  check('감시기가 죽으면(값은 초록·나이만 늙음) 판정면도 초록이 아니다',
    drift3.dead.drawn === true && drift3.dead.dim === true
      && /멎었다/.test(drift3.dead.text), drift3.dead.text);

  // ── 4. 안 움직이는 게 정상인 것에 움직임을 재지 않는다 (2026-08-07)
  //
  // 끊김 감시(`Shared/data/camera/watch.js`)는 픽셀이 그대로면 "새 프레임이 안 온다"로 읽는다.
  // **합성 고정물은 정지 사진이라 영영 그대로다** — 감시를 걸었더니 12초 뒤 화면이
  // `멈춤` 이라고 거짓말했다. 거짓 경고는 사람에게 경고를 무시하는 법을 가르친다.
  // **경고가 켜지는 시각은 9초가 아니라 12초다** — 감시 주기 3초에 첫 틱은 비교 대상이
  // 없어 기준만 잡는다(3s 기준 · 6·9·12s 에서 3연속). 11초로 뒀더니 회귀를 심어도
  // 초록이었다 — **일부러 심은 버그로 빨간불을 본 뒤에야 이 숫자를 믿는다.**
  await new Promise((r) => setTimeout(r, 15000));
  const link = await p.eval(`document.querySelector('[data-t="cam-hud-link"]')?.textContent ?? '없음'`);
  check('고정물은 시간이 지나도 멈춤이라고 하지 않는다', link === 'LIVE', `15초 뒤 ${link}`);
} catch (e) {
  check('실행', false, e.message);
} finally {
  await p?.close?.();
  killTree(web);          // 위 §고아 — `process.on('exit')` 이 한 번 더 받친다
}

const bad = results.filter((r) => !r).length;
console.log(bad ? `\n${bad}건 실패` : `\n${results.length}/${results.length} 통과`);
process.exit(bad ? 1 : 0);
