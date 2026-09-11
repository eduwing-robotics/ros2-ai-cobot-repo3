// WebXR 겹치기 화면 실렌더 검증 — `AR/xr.html`.
//
// **이 화면만 게이트가 없었다** (2026-08-06 `/감사`). `cam`·`dash`·`fr5` 는 다 있는데
// 여기만 0건이라, `#ov` 가 스택 문맥을 만들어 계기가 통째로 안 보이던 버그도 초록인 채
// 지나갔다. 사람 눈이 우연히 잡았을 뿐이다.
//
// 두 겹으로 판정한다 —
//   ① 숫자 — 놓기 계산(`features/place/place.js`)은 순수 함수라 **브라우저 없이** 잰다.
//      `immersive-ar` 은 폰에서만 열려서, 이 길이 아니면 촬영 모드의 배율·회전을
//      영원히 검증할 수 없다.
//   ② 실렌더 — `화면` 모드는 XR 세션이 없어 헤드리스 크롬에서 그대로 돈다.
//      겹치기와 씬을 공유하므로 배치안 3D 가 깨지면 여기서도 깨진다.
//
// 실행: node scripts/check/xr-web-verify.mjs          전부 (dev 서버 + 헤드리스 크롬)
//       node scripts/check/xr-web-verify.mjs --pure   ①만. 서버도 브라우저도 안 띄운다
//
// **①만 게이트(`check/xr-place.sh`)에 넣는다.** 1초도 안 걸리고, 여기가 조용히 틀리는
// 자리다. ②는 형제들(`cam`·`dash`·`fr5`)과 같이 사람이 부른다 — 그 전부를 게이트에
// 넣을지는 이 화면 하나가 정할 일이 아니다 (`docs/evidence/2026-08-05/audit-harness-and-bridge.md`).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openPage } from './lib/cdp-harness.mjs';
import * as THREE from 'three';
import {
  solveCorners, hudText, ghostWalls, classifyHit, yawFromWallNormal, readiness, GRACE_MS, fitLine,
  snapQuadrant,
} from '../../AR/src/features/place/place.js';
import { createLayoutView } from '../../Shared/view3d/lab/layout-view.js';
import { buildPreset } from '../../Shared/data/layout/presets.js';

const PURE = process.argv.includes('--pure');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5189;
const BASE = `http://localhost:${PORT}/xr.html`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ═══ ① 숫자 — 놓기 계산 ═══════════════════════════════════════════════════
//
// **왕복으로 잰다.** 배치안의 대각선을 알려진 각도·배율로 돌려 두 모서리를 만들고,
// 그걸 다시 풀어 원래 각도·배율이 나오는지 본다. 부호를 뒤집으면 여기서 죽는다
// (2026-08-05 에 실제로 뒤집혀 있었고, 배포 전 손계산이 잡았다).
const W = 3.25;
const D = 3.25;
{
  let worstYaw = 0;
  let worstScale = 0;
  let worstCorner = 0;
  for (const degTrue of [0, 37, 90, -128, 180]) {
    for (const sTrue of [1, 0.98, 1.021]) {
      const yawTrue = (degTrue * Math.PI) / 180;
      // 로컬 대각선 (원점 → 반대 모서리) 을 yaw 만큼 돌리고 sTrue 를 곱해 "잰 값" 을 만든다.
      // three.js 의 Y 회전: x' = x·cos + z·sin · z' = −x·sin + z·cos
      const lx = W;
      const lz = -D;
      const c = Math.cos(yawTrue);
      const sn = Math.sin(yawTrue);
      const a = { x: 1.234, z: -5.678 };                 // 첫 모서리는 아무 데나
      const b = { x: a.x + (lx * c + lz * sn) * sTrue, z: a.z + (-lx * sn + lz * c) * sTrue };

      const got = solveCorners(a, b, W, D);
      const dYaw = Math.abs(((got.yaw - yawTrue + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      worstYaw = Math.max(worstYaw, (dYaw * 180) / Math.PI);
      worstScale = Math.max(worstScale, Math.abs(got.scale - sTrue) / sTrue);

      // 푼 값으로 모서리②를 되돌려 놓으면 실제로 그 자리에 떨어지는가
      const c2 = Math.cos(got.yaw);
      const s2 = Math.sin(got.yaw);
      const bx = a.x + (lx * c2 + lz * s2) * got.scale;
      const bz = a.z + (-lx * s2 + lz * c2) * got.scale;
      worstCorner = Math.max(worstCorner, Math.hypot(bx - b.x, bz - b.z) * 1000);
    }
  }
  check('두 모서리 → 회전 복원 (한계 0.01°)', worstYaw < 0.01, `최대 ${worstYaw.toFixed(4)}°`);
  check('두 모서리 → 배율 복원 (한계 0.01%)', worstScale < 1e-4, `최대 ${(worstScale * 100).toFixed(4)}%`);
  check('푼 값으로 되돌린 모서리② 오차 (한계 0.01mm)', worstCorner < 0.01, `최대 ${worstCorner.toFixed(4)}mm`);

  // **회전 부호를 뒤집으면 반드시 실패해야 한다.** 안 그러면 이 검사는 아무것도 안 막는다.
  const flipped = (() => {
    const yawTrue = (37 * Math.PI) / 180;
    const c = Math.cos(yawTrue); const sn = Math.sin(yawTrue);
    const a = { x: 0, z: 0 };
    const b = { x: W * c + -D * sn, z: -W * sn + -D * c };
    const got = solveCorners(a, b, W, D);
    return Math.abs(-got.yaw - yawTrue) > 0.01;         // 부호 반대면 어긋난다
  })();
  check('부호를 뒤집은 값은 틀리게 나온다 (검사가 실제로 막는다)', flipped);
}

// ── 계기가 거짓말을 안 하는가
{
  const zoomIn = hudText({ mode: 'walk', scale: 1.25, widthM: W, depthM: D, zoomed: true });
  const plain = hudText({ mode: 'walk', scale: 1, widthM: W, depthM: D });
  const real = hudText({ mode: 'real', scale: 0.981, widthM: W, depthM: D });
  const fit = hudText({ mode: 'fit', scale: 0.4, widthM: W, depthM: D });
  check('답사 1:1 은 1:1 이라 적는다', /실물 1:1/.test(plain) && /3\.25×3\.25m/.test(plain), plain);
  check('확대하면 1:1 이라 안 적는다', !/실물 1:1/.test(zoomIn) && /\+25\.0%/.test(zoomIn), zoomIn);
  check('확대하면 크기도 커진 값으로 적는다', /4\.06×4\.06m/.test(zoomIn), zoomIn);
  check('촬영의 보정은 1:1 을 유지한 채 표시한다',
    /실물 1:1/.test(real) && /보정 -1\.9%/.test(real), real);
  check('평소는 축소 배율을 적는다', /1:2\.5 축소/.test(fit) && /1\.30×1\.30m/.test(fit), fit);
}

// ── 히트 분류 — 벽 법선을 살리고 바닥값은 지킨다 (2026-08-07 `/감사` F2·F3·F6)
{
  check('바닥/천장은 수평이다', classifyHit(1) === 'horizontal' && classifyHit(-1) === 'horizontal');
  check('벽은 수직이다', classifyHit(0) === 'vertical' && classifyHit(-0.2) === 'vertical');
  // **애매한 것은 버린다.** 경사면 법선으로 맵을 돌리면 조용히 비뚤어진다.
  check('경사면은 둘 다 아니다 (버린다)',
    classifyHit(0.6) === 'other' && classifyHit(-0.5) === 'other');
  // 이게 F3 의 핵심이다 — 수직 히트가 `horizontal` 로 새면 세션 바닥값이 내려앉는다
  check('수직 히트가 수평으로 새지 않는다 (맵이 바닥 밑으로 파묻히는 것을 막는다)',
    [0, 0.1, 0.2, 0.3, -0.3].every((y) => classifyHit(y) !== 'horizontal'));
}

// ── 벽 법선 → yaw. **three 로 직접 돌려 확인한다** — 손으로 유도한 부호를 못 믿는다
{
  let worst = 0;
  const probe = new THREE.Object3D();
  for (const deg of [0, 23, 90, 137, 180, -61, -170]) {
    const yawTrue = (deg * Math.PI) / 180;
    // 맵을 yawTrue 만큼 돌렸을 때 로컬 +Z(= `z=0` 쪽 벽의 법선)가 가는 세계 방향
    probe.rotation.set(0, yawTrue, 0);
    probe.updateMatrixWorld(true);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(probe.quaternion);
    const got = yawFromWallNormal({ x: n.x, z: n.z });
    worst = Math.max(worst, Math.abs(((got - yawTrue + Math.PI * 3) % (Math.PI * 2)) - Math.PI));
  }
  check('벽 법선 → yaw 왕복 복원 (한계 0.01°)', (worst * 180) / Math.PI < 0.01,
    `최대 ${((worst * 180) / Math.PI).toFixed(5)}°`);
  // **뒤집힌 법선은 반대쪽을 봐야 한다.** 같은 값이 나오면 이 검사는 아무것도 안 막는다
  const a = yawFromWallNormal({ x: 0.6, z: 0.8 });
  const b = yawFromWallNormal({ x: -0.6, z: -0.8 });
  check('법선을 뒤집으면 180° 반대가 나온다 (검사가 실제로 막는다)',
    Math.abs(Math.abs(a - b) - Math.PI) < 1e-9, `${a.toFixed(4)} vs ${b.toFixed(4)}`);
  check('벽이 아니면 각도를 지어내지 않는다 (null)', yawFromWallNormal({ x: 0, z: 0 }) === null);
}

// ── 90° 네 자리 중 하나를 사람이 서 있는 쪽이 고른다 (`↺↻` 를 안 누르게 하는 것)
{
  const q = Math.PI / 2;
  let worstOff = 0;      // 벽이 준 정밀함을 얼마나 망가뜨리나 — 0 이어야 한다
  let worstFace = 0;     // 사람 쪽에서 얼마나 벗어나나 — 45° 안이어야 한다
  for (let a = -180; a <= 180; a += 7) {
    for (let b = -180; b <= 180; b += 11) {
      const yaw = (a * Math.PI) / 180;
      const face = (b * Math.PI) / 180;
      const got = snapQuadrant(yaw, face);
      // ① 결과는 반드시 `yaw + k·90°` — 벽이 낸 각도가 훼손되면 정합이 깨진다
      const k = (got - yaw) / q;
      worstOff = Math.max(worstOff, Math.abs(k - Math.round(k)));
      // ② 그중 사람을 가장 잘 마주 보는 것
      const d = Math.abs(((got - face + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      worstFace = Math.max(worstFace, (d * 180) / Math.PI);
    }
  }
  check('벽이 낸 각도를 90° 배수로만 돌린다 (정밀함을 안 깎는다)', worstOff < 1e-9);
  check('네 자리 중 사람을 마주 보는 것을 고른다 (45° 안)', worstFace <= 45.001,
    `최대 ${worstFace.toFixed(2)}°`);
}

// ── 훑기 — 짧은 기저에서 긴 기저의 정확도가 나오는가
{
  // 재현 가능한 잡음. `Math.random` 을 쓰면 게이트가 가끔 빨개진다.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const sweep = (deg, spanM, n, noiseMm) => {
    const th = (deg * Math.PI) / 180;
    const pts = [];
    for (let i = 0; i < n; i += 1) {
      const s = (i / (n - 1) - 0.5) * spanM;
      const j = (rnd() * 2 * noiseMm) / 1000;             // 선에 수직인 손 떨림
      pts.push({ x: 3 + s * Math.cos(th) - j * Math.sin(th), z: -2 + s * Math.sin(th) + j * Math.cos(th) });
    }
    return pts;
  };

  // **성질로 잰다, 유도로 재지 않는다.** "맵을 이 yaw 로 돌리면 그 벽에 나란해진다" 가
  // 우리가 원하는 전부다 — 즉 맵의 로컬 +Z 가 훑은 선과 **수직**이어야 한다.
  // 처음엔 `yaw = 선각 + 90°` 로 기대했다가 90° 어긋나 실패했다: `layout-view` 의 Z 가
  // 거울이라 실제로는 `π − 선각` 이다. 손유도를 검사에 박으면 이런 게 거짓 실패를 낸다.
  let worst = 0;
  const probe = new THREE.Object3D();
  for (const deg of [0, 31, 90, 148, -67]) {
    const th = (deg * Math.PI) / 180;
    const fit = fitLine(sweep(deg, 3, 120, 40));
    probe.rotation.set(0, fit.yaw, 0);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(probe.quaternion);
    const dot = n.x * Math.cos(th) + n.z * Math.sin(th);   // 수직이면 0
    worst = Math.max(worst, (Math.asin(Math.min(1, Math.abs(dot))) * 180) / Math.PI);
  }
  // 손계산: σ√12/(L√N) = 0.04·3.46/(3·10.95) ≈ 0.0042rad ≈ 0.24°. 3배를 한계로 둔다.
  check('3m 훑기 120표본이 0.7° 안에 든다 (탭 2회 14m 대각보다 낫다)', worst < 0.7,
    `최대 ${worst.toFixed(3)}°`);
  check('잔차가 손 떨림 크기를 말한다 (40mm 넣으면 10~40mm 로 읽힌다)', (() => {
    const r = fitLine(sweep(20, 3, 120, 40)).residualMm;
    return r > 10 && r < 40;
  })(), `${fitLine(sweep(20, 3, 120, 40)).residualMm.toFixed(1)}mm`);
  check('휜 선은 잔차가 크게 나온다 (실패를 말해 주는 첫 방법)', (() => {
    const pts = [];
    for (let i = 0; i < 120; i += 1) {
      const s = (i / 119 - 0.5) * 3;
      pts.push({ x: 3 + s, z: -2 + s * s * 0.35 });        // 포물선
    }
    return fitLine(pts).residualMm > 100;
  })());
  check('짧은 훑기는 각도를 지어내지 않는다 (null)', fitLine(sweep(10, 0.2, 60, 5)) === null);
  check('표본이 모자라면 그냥 탭으로 본다 (null)', fitLine(sweep(10, 3, 5, 5)) === null);
  // **z 축에 나란한 벽에서 죽지 않는가.** `z = ax+b` 로 맞췄으면 여기서 기울기가 발산한다.
  check('세로 벽(90°)에서도 발산하지 않는다', Number.isFinite(fitLine(sweep(90, 3, 120, 20)).yaw));

  // **한계를 검사로 박아 둔다 (F8).** 제자리에서 돌려도 점들은 직선이라 잔차가 작다 —
  // 그래서 화면이 잔차만 믿으면 안 되고, 사람이 실제로 이동했는지를 따로 잰다.
  const panned = [];
  for (let i = 0; i < 120; i += 1) {
    const s = 0.5 + (i / 119) ** 2 * 6;                    // 먼 쪽일수록 표본이 벌어진다
    panned.push({ x: 3 + s, z: -2 + rnd() * 0.02 });
  }
  check('제자리 팬은 잔차로 못 잡는다 — 이동 거리를 따로 재야 하는 이유 (F8)',
    fitLine(panned).residualMm < 50, `${fitLine(panned).residualMm.toFixed(1)}mm`);
}

// ── 준비도 — 화면이 언제 초록이 되고, **언제까지나 안 되지는 않는가** (F4)
{
  const good = { pathM: 1, floorSpreadMm: 2, extentM: 2 };
  check('바닥이 없으면 회색이다 (실패가 아니라 아직 안 한 것)',
    readiness({ floorSpreadMm: null }).state === 'gray');
  check('다 채우면 초록이고 놓을 수 있다',
    readiness(good).state === 'green' && readiness(good).ok === true);
  check('상판을 겨냥하면 빨강이고 얼마나 높은지 말한다',
    readiness({ ...good, aboveFloorMm: 400 }).state === 'red'
    && /40cm/.test(readiness({ ...good, aboveFloorMm: 400 }).say));
  check('너무 빠르면 속도부터 말한다',
    readiness({ ...good, speedMps: 2 }).say === '조금 천천히');

  // **가장 모자란 관문이 문구를 정한다** — 원호가 차오른 정도와 말이 늘 같은 것을 가리킨다
  check('시차가 모자라면 걸으라고 한다',
    readiness({ pathM: 0, floorSpreadMm: 2, extentM: 2 }).say === '폰을 든 채 옆으로 두 걸음');
  check('훑은 범위가 좁으면 훑으라고 한다',
    readiness({ pathM: 1, floorSpreadMm: 2, extentM: 0.1 }).say === '바닥을 좌우로 천천히 훑으세요');

  // **삼각대 회귀 방지.** `WARMUP_MS` 는 반드시 만료됐는데 "0.3m 이동" 은 고정 카메라에서
  // 영영 충족 안 된다 — 조건으로 바꾸다 도달 불가 상태를 만드는 사고를 여기서 막는다.
  const tripod = { pathM: 0, floorSpreadMm: 35, extentM: 0 };
  check('삼각대(움직임 0)는 유예 전에는 막힌다', readiness({ ...tripod, elapsedMs: 1000 }).ok === false);
  check('삼각대라도 유예 뒤에는 반드시 놓을 수 있다 (도달 불가 상태 없음)',
    readiness({ ...tripod, elapsedMs: GRACE_MS }).ok === true
    && /정확도가 낮을 수 있습니다/.test(readiness({ ...tripod, elapsedMs: GRACE_MS }).say));

  // 상태↔문구가 어긋나는 조합이 하나도 없어야 한다 (F12 를 수용한 값어치가 이것이다)
  let mismatch = null;
  for (const pathM of [0, 0.15, 0.4]) {
    for (const floorSpreadMm of [null, 2, 25, 60]) {
      for (const extentM of [0, 0.5, 2]) {
        for (const aboveFloorMm of [0, 400]) {
          for (const elapsedMs of [0, 3000, 9000]) {
            const r = readiness({ pathM, floorSpreadMm, extentM, aboveFloorMm, elapsedMs });
            const okState = { gray: /비추세요/, red: /높습니다/, green: /지금 탭하세요$/, yellow: /./ };
            if (!okState[r.state]?.test(r.say)) mismatch = `${r.state} ← "${r.say}"`;
            if (r.ok && (r.state === 'gray' || r.state === 'red')) mismatch = `놓기 허용된 ${r.state}`;
            if (r.state === 'green' && !r.ok) mismatch = '초록인데 못 놓는다';
          }
        }
      }
    }
  }
  check('상태와 문구가 어긋나는 조합이 없다 (216 가지 전수)', mismatch === null, mismatch ?? '');
}

// ── 유령벽이 벽만 고르는가 (문·창·소품은 `contents` 라 손대면 안 된다)
{
  const view = createLayoutView(buildPreset('cell'));
  const slab = view.root.getObjectByName('slab');
  const contentsBefore = view.root.getObjectByName('contents').children.length;
  const { walls, ghost } = ghostWalls(view.root, slab);
  const meshes = view.root.children.filter((o) => o.isMesh);
  const lines = view.root.children.filter((o) => o.isMesh && o !== slab)
    .every((o) => o.children.some((c) => c.isLineSegments));
  check('벽만 유령이 된다 (직속 메시 − 슬래브)', walls === meshes.length - 1, `${walls}장 / 메시 ${meshes.length}`);
  check('슬래브는 유령이 아니다', slab.material !== ghost);
  check('벽마다 모서리 선이 붙는다', lines);
  check('반투명 + depthWrite 끔 — 실제 방이 비친다',
    ghost.transparent && ghost.opacity < 0.3 && ghost.depthWrite === false, `opacity ${ghost.opacity}`);
  check('문·창·소품은 안 건드린다',
    view.root.getObjectByName('contents').children.length === contentsBefore, `${contentsBefore}개`);
  view.dispose?.();
}

// ═══ ② 실렌더 — `화면` 모드 ═══════════════════════════════════════════════
if (PURE) {
  const bad0 = results.filter((r) => !r).length;
  console.log(bad0 ? `\n${bad0}건 실패` : `\n${results.length}/${results.length} 통과 (①만)`);
  process.exit(bad0 ? 1 : 0);
}

// **`SIGTERM` 은 `npm run` 에서 멈추고 자식 vite 까지 안 간다** — 포트를 쥔 채 남아
// 다음 판이 `--strictPort` 에 막힌다 (2026-08-06 FR5 에서 밟은 것과 같은 함정 · GAP-MATRIX).
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
  p = await openPage(BASE, { port: 9353, windowSize: '1280,900' });
  // **`__xr` 를 기다린다.** `<option>` 은 정적 HTML 이라 DOM 만 보면 모듈이 아직 안 붙었는데도
  // 준비된 걸로 읽힌다 — 첫 판이 정확히 그렇게 거짓 실패했다.
  const ready = await p.waitFor('Boolean(globalThis.__xr)');
  check('모듈이 준비 신호를 낸다 (`globalThis.__xr`)', Boolean(ready));

  // ── 모드 넷과 버튼 잠금 규칙. 모드는 `<select>` 가 아니라 **칩**이라 실제로 누른다.
  const modes = await p.eval(`(() => {
    const go = document.getElementById('go');
    const chips = [...document.getElementById('chips').children];
    const vals = chips.map((b) => b.dataset.m);
    const gate = {}; const label = {}; const blurb = {};
    for (const b of chips) {
      b.click();
      gate[b.dataset.m] = go.disabled;
      label[b.dataset.m] = go.textContent;
      blurb[b.dataset.m] = document.getElementById('blurb').textContent;
    }
    const pressed = chips.filter((b) => b.getAttribute('aria-pressed') === 'true').length;
    return { vals, gate, label, blurb, pressed, mode: globalThis.__xr.mode() };
  })()`);
  check('모드가 넷이다 (평소·답사·촬영·화면)',
    JSON.stringify(modes.vals) === JSON.stringify(['fit', 'walk', 'real', 'screen']), modes.vals.join(','));
  check('XR 없는 환경에서 겹치기 셋은 잠긴다',
    modes.gate.fit && modes.gate.walk && modes.gate.real, JSON.stringify(modes.gate));
  check('`화면` 은 XR 없이도 열린다 — 이 화면의 유일한 자동 검증 경로다', modes.gate.screen === false);
  check('칩은 언제나 하나만 눌려 있다', modes.pressed === 1, `${modes.pressed}개`);
  check('막힌 모드가 이유와 대안을 스스로 말한다',
    /AR 을 못 엽니다/.test(modes.blurb.walk) && /화면/.test(modes.blurb.walk), modes.blurb.walk.slice(0, 46));
  check('버튼 이름이 모드에 맞는다 (AR 아닌 모드를 “AR 시작” 이라 부르지 않는다)',
    modes.label.walk === 'AR 시작' && modes.label.screen === '방 안으로 들어가기',
    `${modes.label.walk} / ${modes.label.screen}`);

  // ── 맵 미리보기 — 고르기 전에 무엇을 얹는지 보여준다
  const pv = await p.eval(`(() => {
    const c = document.querySelector('#preview canvas');
    return { on: Boolean(globalThis.__xr.preview()), w: c?.width ?? 0, h: c?.height ?? 0,
             cam: globalThis.__stage ? globalThis.__stage.camera.position.toArray() : null };
  })()`);
  check('맵 미리보기가 돈다', pv.on && pv.w > 0 && pv.h > 0, `${pv.w}×${pv.h}`);
  // **미터가 아니라 각도로 잰다.** 거리는 프레이밍(시트 높이·화면 비율)에 따라 변하지만
  // "천천히 돈다" 는 각속도의 성질이다 — 미터로 재던 첫 판이 창 크기 때문에 실패했다.
  const spun = await p.eval(`(async () => {
    const yaw = () => { const e = globalThis.__stage.camera.matrixWorld.elements;
      return Math.atan2(-e[10], -e[8]); };            // 카메라가 보는 방향의 방위각
    const a = yaw();
    await new Promise((r) => setTimeout(r, 900));
    return Math.abs(((yaw() - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
  })()`);
  check('미리보기가 천천히 돈다 (0.9초에 1~20°)', spun > 1 && spun < 20, `${spun.toFixed(2)}°`);

  // ── 없앤 것이 정말 없나
  const gone = await p.eval(`(() => ({
    arms: Boolean(document.getElementById('arms')),
    anim: Boolean(document.getElementById('anim')),
    barShown: getComputedStyle(document.getElementById('bar')).display,
  }))()`);
  check('팔 대수 선택이 없다 — 맵이 정한다', gone.arms === false);
  check('애니메이션 선택이 없다', gone.anim === false);
  check('시작 전에는 조작바가 없다', gone.barShown === 'none', gone.barShown);

  // ── 진입
  await p.eval(`(() => {
    globalThis.__xr.setMode('screen');
    document.getElementById('go').click();
    return 'go';
  })()`);
  // **캔버스는 팔보다 먼저 뜬다.** 캔버스만 기다리면 계기·조작바가 아직 안 붙은 상태를 읽어
  // 거짓 실패한다 (첫 판이 그랬다). 화면이 다 선 시점은 `화면 모드 시작` 로그다.
  const canvasFirst = await p.waitFor("document.getElementById('walk') ? 1 : 0", { timeoutMs: 30000 });
  check('`화면` 모드가 캔버스를 띄운다', canvasFirst === 1);
  // **팔보다 방이 먼저 떠야 한다.** 렌더 루프를 팔 받기 뒤에 등록했더니 6MB×3 을 받는
  // 내내 검은 화면이었다 (2026-08-06 `/감사`). 캔버스가 뜬 직후 이미 그려지고 있어야 한다.
  const early = await p.eval(`(async () => {
    const c = document.getElementById('walk');
    const g = c.getContext('webgl2') || c.getContext('webgl');
    const px = new Uint8Array(4);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    g.readPixels(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
    return { lit: px[0] + px[1] + px[2], arms: [...document.querySelectorAll('#log div')]
      .filter((d) => /팔 \d 준비/.test(d.textContent)).length };
  })()`);
  check('팔을 받기 전에 이미 방을 그린다 (검은 화면 회귀 방지)', early.lit > 30,
    `가운데 픽셀 합 ${early.lit} · 그 시점 팔 ${early.arms}대`);

  const up = await p.waitFor(
    "[...document.querySelectorAll('#log div')].some((d) => /화면 모드 시작/.test(d.textContent)) ? 1 : 0",
    { timeoutMs: 60000 });
  check('팔까지 받고 화면이 다 선다', up === 1);

  const st = await p.eval(`(() => {
    const c = document.getElementById('walk');
    const hud = document.getElementById('hud'), hint = document.getElementById('hint');
    const hb = hud.getBoundingClientRect();
    const bar = [...document.getElementById('bar').children]
      .filter((b) => !b.hidden).map((b) => b.id);
    return {
      w: c.width, h: c.height,
      hud: hud.textContent,
      hint: hint.textContent,
      // **오늘 잡은 버그를 여기서 막는다** — #ov 가 스택 문맥을 만들어 계기가 캔버스 밑에 깔렸다
      topAtHud: (document.elementFromPoint(hb.left + 4, hb.top + 4) || {}).id,
      bar,
      overflow: document.body.style.overflow,
      log: [...document.querySelectorAll('#log div')].map((d) => d.textContent),
    };
  })()`);
  check('캔버스가 실제로 그려졌다', st.w > 0 && st.h > 0, `${st.w}×${st.h}`);
  check('계기가 캔버스 **위**에 뜬다 (#ov 스택 문맥 회귀 방지)', st.topAtHud === 'hud', st.topAtHud);
  check('계기가 방 크기와 눈높이를 적는다',
    /6\.75×12\.00m/.test(st.hud) && /1\.6m/.test(st.hud), st.hud);
  check('조작 안내가 뜬다', /끌어서|탭/.test(st.hint), st.hint);
  check('`화면` 모드 조작바는 시뮬 재생·나가기 둘뿐이다 (겹치기 버튼을 숨긴다 · 재생은 phase 4)',
    JSON.stringify(st.bar) === JSON.stringify(['replay', 'exit']), st.bar.join(','));

  // ── 시뮬 재생 (phase 4 · 2026-09-05) — 표본을 받아 팔 관절이 실제로 도는가를 숫자로 본다
  const rp = await p.eval(`(async () => {
    const before = window.__xrReplay.angles();
    document.getElementById('replay').click();
    await new Promise((r) => setTimeout(r, 1200));
    const k1 = window.__xrReplay.k();
    await new Promise((r) => setTimeout(r, 700));
    const after = window.__xrReplay.angles();
    return { on: window.__xrReplay.on(), batch: window.__xrReplay.batch(), k1, k2: window.__xrReplay.k(),
      moved: before && after ? Math.max(...before.map((a, i) => Math.abs(a - after[i]))) : -1,
      label: document.getElementById('replay').textContent };
  })()`);
  check('시뮬 재생을 켜면 표본을 받는다', rp.on === true && !!rp.batch, `${rp.batch} · ${rp.label}`);
  check('프레임이 앞으로 간다 (한 바퀴 6초)', rp.k2 !== rp.k1, `k ${rp.k1} → ${rp.k2}`);
  check('팔 관절이 실제로 돈다 (라이브가 없으니 재생이 얹힌다)', rp.moved > 0.01, `최대 ${rp.moved?.toFixed?.(3)} rad`);
  await p.eval(`document.getElementById('replay').click()`);   // 끄고 다음 검사로

  // ── 고스트 팔 (D195 · 2026-09-07) — 라이브를 **주입**해 「불투명 = 실기 · 반투명 = 계획」 두 층이 서는가를 본다.
  //    `__xrLive` 는 robotId → {joints, at} 맵이라 브리지 없이도 실기가 흐르는 척할 수 있다(2초 안에 갱신).
  const gh = await p.eval(`(async () => {
    const live = window.__xrLive;
    const j = [10, -60, 70, -100, -90, 5];
    const feed = () => live.set('fr5-lab-a', { joints: j, at: performance.now() });
    feed(); const tick = setInterval(feed, 500);
    document.getElementById('replay').click();
    await new Promise((r) => setTimeout(r, 1200));
    const ghosts = window.__xrGhosts ?? [];
    const g = ghosts[0] ?? null;
    const arm = window.__xrArms.find((r) => r.userData.robotId === 'fr5-lab-a');
    const ang = (r) => Object.values(r?.joints ?? {}).map((x) => x.angle);
    const a1 = ang(arm); const g1 = ang(g); const vis1 = g?.visible;
    // 표본에는 정지 구간(파지·대기)이 있어 0.7초 창은 우연히 0 이 나온다 — 한 바퀴 6초의 40% 를 8표본으로 훑는다
    let a2 = a1; let g2 = g1; let ghostMoved = -1;
    const maxd = (x, y) => (x.length && y.length ? Math.max(...x.map((v, i) => Math.abs(v - y[i]))) : -1);
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      a2 = ang(arm); g2 = ang(g);
      ghostMoved = Math.max(ghostMoved, maxd(g1, g2));
      if (maxd(a1, a2) !== 0) break;   // 실기 팔이 움직였으면 그 자체가 실패다 — 아래에서 잡힌다
    }
    const mat = (o) => (Array.isArray(o.material) ? o.material[0] : o.material);
    const gm = { n: 0, translucent: 0, noDepth: 0 };
    g?.traverse((o) => { if (o.isMesh && o.material) { gm.n += 1; const m = mat(o); if (m.transparent && m.opacity < 1) gm.translucent += 1; if (m.depthWrite === false) gm.noDepth += 1; } });
    const am = { n: 0, opaque: 0 };
    arm.traverse((o) => { if (o.isMesh && o.material) { am.n += 1; const m = mat(o); if (!m.transparent || m.opacity >= 1) am.opaque += 1; } });
    clearInterval(tick); live.delete('fr5-lab-a');
    await new Promise((r) => setTimeout(r, 300));
    const vis2 = g?.visible;
    document.getElementById('replay').click();
    return { count: ghosts.length, total: window.__xrArms.length, vis1, vis2,
      armIsLive: a1.length > 0 && Math.abs(a1[0] - (10 * Math.PI) / 180) < 1e-3, armHeld: maxd(a1, a2) === 0,
      ghostMoved, gm, am };
  })()`);
  check('고스트는 실물 robotId 가 있는 팔에만 한 대 (`cell` 은 fr5a 하나)', gh.count === 1 && gh.total === 3, `${gh.count}대 / 팔 ${gh.total}대`);
  check('라이브가 흐르면 불투명 팔은 실기 자세에 고정된다 (재생이 실물을 덮지 않는다)', gh.armIsLive && gh.armHeld);
  check('그 위에 고스트가 보이고 계획(시뮬 표본)을 돈다', gh.vis1 === true && gh.ghostMoved > 0.01, `최대 ${gh.ghostMoved?.toFixed?.(3)} rad`);
  check('고스트 재질은 전부 반투명·depthWrite 끔 · 실기 팔은 전부 불투명 (두 층 규약)',
    gh.gm.n > 0 && gh.gm.translucent === gh.gm.n && gh.gm.noDepth === gh.gm.n && gh.am.opaque === gh.am.n,
    `고스트 ${gh.gm.translucent}/${gh.gm.n} · 실기 ${gh.am.opaque}/${gh.am.n}`);
  check('라이브가 끊기면 고스트는 숨는다 (팔 자체가 계획을 돈다)', gh.vis2 === false);

  // ── 이동 목표 고스트 (D196) — 스트림의 `motionTarget.doneAt == null` 이면 재생이 꺼져 있어도 목표 자세로 선다
  const tg = await p.eval(`(async () => {
    const live = window.__xrLive;
    const j = [10, -60, 70, -100, -90, 5];
    const target = { jointsDeg: [40, -60, 70, -100, -90, 5], via: 'jog', speedPct: 10, queuedAt: 1, doneAt: null };
    live.set('fr5-lab-a', { joints: j, at: performance.now(), target });
    await new Promise((r) => setTimeout(r, 400));
    const g = (window.__xrGhosts ?? [])[0];
    const j1 = Object.values(g?.joints ?? {})[0]?.angle;
    const vis1 = g?.visible; const kind1 = g?.userData?.kind;
    live.set('fr5-lab-a', { joints: j, at: performance.now(), target: { ...target, doneAt: 2 } });
    await new Promise((r) => setTimeout(r, 400));
    const vis2 = g?.visible;
    live.delete('fr5-lab-a');
    return { vis1, kind1, j1, vis2, replayOn: window.__xrReplay.on() };
  })()`);
  check('가는 중인 목표가 오면 재생이 꺼져 있어도 고스트가 목표 자세로 선다', tg.replayOn === false && tg.vis1 === true && tg.kind1 === 'target'
    && Math.abs(tg.j1 - (40 * Math.PI) / 180) < 1e-3, `j1 ${((tg.j1 ?? 0) * 180 / Math.PI).toFixed(1)}° · ${tg.kind1}`);
  check('doneAt 이 찍히면 목표 고스트는 사라진다 (도착한 자세는 실기 팔이 보여준다)', tg.vis2 === false);
  check('맵이 정한 만큼 팔이 붙는다 (`cell` 은 FR5 3대)',
    ['팔 1 준비', '팔 2 준비', '팔 3 준비'].every((k) => st.log.some((l) => l.includes(k))),
    st.log.filter((l) => /팔 \d 준비/.test(l)).length + '대');
  check('스크롤을 잠근다 — 끌어서 둘러볼 때 페이지가 밀리면 안 된다', st.overflow === 'hidden');

  // ── 끌면 둘러보고, 끌지 않은 탭은 이동한다
  const move = await p.eval(`(async () => {
    const el = document.getElementById('walk');
    const shot = () => { const g = el.getContext('webgl2') || el.getContext('webgl'); return g ? 1 : 0; };
    const mk = (t, x, y) => new PointerEvent(t, { pointerId: 1, bubbles: true, clientX: x, clientY: y,
      isPrimary: true, buttons: t === 'pointerup' ? 0 : 1 });
    const before = document.getElementById('hud').textContent;
    el.dispatchEvent(mk('pointerdown', 640, 450));
    for (let i = 1; i <= 8; i += 1) el.dispatchEvent(mk('pointermove', 640 - i * 20, 450));
    el.dispatchEvent(mk('pointerup', 480, 450));
    await new Promise((r) => setTimeout(r, 300));
    el.dispatchEvent(mk('pointerdown', 640, 700));
    el.dispatchEvent(mk('pointerup', 640, 700));
    await new Promise((r) => setTimeout(r, 300));
    return { gl: shot(), hudUnchanged: document.getElementById('hud').textContent === before };
  })()`);
  check('포인터 조작이 예외 없이 지나간다', move.gl === 1);
  check('둘러보고 이동해도 계기 문구는 그대로다 (방 크기는 안 변한다)', move.hudUnchanged);

  // ── 나가기가 원상복구하는가
  const out = await p.eval(`(() => {
    document.getElementById('exit').click();
    const bar = [...document.getElementById('bar').children].filter((b) => !b.hidden).map((b) => b.id);
    const b = document.getElementById('bar');
    return { canvas: Boolean(document.getElementById('walk')), overflow: document.body.style.overflow,
             barHidden: b.hidden, barDisplay: getComputedStyle(b).display, restored: bar.length,
             appBack: document.getElementById('app').hidden === false,
             previewBack: Boolean(globalThis.__xr.preview()) };
  })()`);
  check('나가기 — 캔버스를 지운다', out.canvas === false);
  check('나가기 — 스크롤을 되돌린다', out.overflow === '');
  check('나가기 — AR 버튼을 되살린다', out.restored >= 5, `${out.restored}개`);
  check('나가기 — 시작 화면과 미리보기가 돌아온다', out.appBack && out.previewBack,
    `app=${out.appBack} preview=${out.previewBack}`);
  // **`hidden` 이 실제로 먹는지 본다.** 버튼만 보면 멀쩡한데 `#bar` 자체는 `display:flex` 라
  // `[hidden]` 을 이기고 있었다 — 이 검사의 첫 판이 그 사각지대를 그대로 갖고 있었다.
  check('조작바가 `hidden` 을 지킨다 (#bar display 우선순위 회귀 방지)',
    out.barHidden && out.barDisplay === 'none', `hidden=${out.barHidden} display=${out.barDisplay}`);

  // ── D222 — 실카메라 전에 같은 36h11 검출기가 기존 네 이미지를 읽는지 고정한다.
  await p.navigate(`http://localhost:${PORT}/test/tag-cv-track.html?fixture=1`);
  const tagCv = await p.waitFor('globalThis.__tagCv?.fixture?.done && JSON.stringify(globalThis.__tagCv)');
  const tagCvState = tagCv ? JSON.parse(tagCv) : null;
  check('AprilTag 전용 검출기는 기존 ID 0·1·2·4를 4/4 읽는다',
    JSON.stringify(tagCvState?.fixture?.found) === '[0,1,2,4]',
    JSON.stringify(tagCvState?.fixture));
  check('검출 실험은 APRILTAG_36h11과 보수적 해밍 5를 고정한다',
    tagCvState?.family === 'APRILTAG_36h11' && tagCvState?.maxHammingDistance === 5);
  check('태그 모서리는 4점씩 보정 입력에 남는다',
    tagCvState?.fixture?.details?.every((detail) => detail.corners?.length === 4),
    JSON.stringify(tagCvState?.fixture?.details));

  // ── D224 — 카메라 없이도 12시점 문서 계약과 3태그 가드를 고정한다.
  await p.navigate(`http://localhost:${PORT}/test/tag-cv-track.html?fixture=1&calibrate=1`);
  const phoneCalibration = await p.waitFor(`
    globalThis.__tagCv?.fixture?.done && globalThis.__tagCv?.calibration?.layoutReady && (() => {
      const cv = globalThis.__tagCv;
      const markers = cv.fixture.details.slice(0, 3).map((detail) => ({
        id: detail.expected, corners: detail.corners, hammingDistance: 0,
      }));
      for (let i = 0; i < 12; i += 1) cv.addCalibrationShot(markers, '2026-09-11T04:00:00.000Z');
      try { cv.addCalibrationShot(markers.slice(0, 2)); }
      catch (error) { cv.calibration.guard = error.message; }
      cv.calibration.doc = cv.calibrationDocument();
      return JSON.stringify(cv.calibration);
    })()`);
  const phoneCalibrationState = phoneCalibration ? JSON.parse(phoneCalibration) : null;
  check('폰 보정 캡처는 기존 태그 배치를 읽고 12시점을 만든다',
    phoneCalibrationState?.layoutReady && phoneCalibrationState?.doc?.shots?.length === 12,
    JSON.stringify(phoneCalibrationState));
  check('폰 보정 분포 문턱은 실폰 최소 모델의 가로 50%·세로 40%다',
    phoneCalibrationState?.requiredCoverage?.x === 0.5 &&
      phoneCalibrationState?.requiredCoverage?.y === 0.4,
    JSON.stringify(phoneCalibrationState?.requiredCoverage));
  check('폰 보정 JSON은 실제 검사 크기와 태그 0·1·2·4 계약을 보존한다',
    phoneCalibrationState?.doc?.image?.widthPx === 720 &&
      phoneCalibrationState?.doc?.image?.heightPx === 720 &&
      JSON.stringify(phoneCalibrationState?.doc?.tagIds) === '[0,1,2,4]' &&
      phoneCalibrationState?.doc?.tagSizeMm === 145);
  check('폰 보정 모서리는 OpenCV의 좌상·우상·우하·좌하 순서로 저장한다',
    JSON.stringify(phoneCalibrationState?.doc?.shots?.[0]?.markers?.[0]?.corners) ===
      '[[90,90],[629,90],[629,629],[90,629]]',
    JSON.stringify(phoneCalibrationState?.doc?.shots?.[0]?.markers?.[0]?.corners));
  check('폰 보정 캡처는 태그 2장뿐인 샷을 거부한다',
    phoneCalibrationState?.guard?.includes('최소 3장'), phoneCalibrationState?.guard);
  const phoneSaveFeedback = await p.eval(`(() => {
    const button = document.getElementById('download');
    button.click();
    return { disabled: button.disabled, text: button.textContent,
      guide: document.getElementById('cal-guide').textContent };
  })()`);
  check('폰 보정 저장은 버튼과 안내문에 완료를 바로 표시한다',
    !phoneSaveFeedback.disabled && phoneSaveFeedback.text.includes('저장 완료') &&
      phoneSaveFeedback.guide.includes('다운로드 폴더'), JSON.stringify(phoneSaveFeedback));

  // ── D226 — 실제 카메라 없이도 알려진 6DoF를 투영했다가 같은 위치로 복원한다.
  await p.navigate(`http://localhost:${PORT}/test/tag-cv-track.html?fixture=1&pose=1`);
  const phonePose = await p.waitFor('globalThis.__tagCv?.fixture?.done && JSON.stringify(globalThis.__tagCv)');
  const phonePoseState = phonePose ? JSON.parse(phonePose) : null;
  check('다중 태그 평면 자세는 기존 ID 0·1·2·4 네 장을 함께 쓴다',
    phonePoseState?.fixture?.pose?.tags === 4, JSON.stringify(phonePoseState?.fixture?.pose));
  check('알려진 1m 폰 위치를 호모그래피 왕복으로 0.1mm 안에 복원한다',
    phonePoseState?.fixture?.pose?.errorMm < 0.1,
    `${phonePoseState?.fixture?.pose?.errorMm?.toFixed?.(6)}mm`);
  check('합성 자세 재투영 RMS는 0.01px보다 작다',
    phonePoseState?.fixture?.pose?.rmsPx < 0.01,
    `${phonePoseState?.fixture?.pose?.rmsPx?.toFixed?.(6)}px`);
  check('1px대 모서리 잡음에서도 폰 위치가 5mm 안에 남는다',
    phonePoseState?.fixture?.pose?.noisyRmsPx < 2 && phonePoseState?.fixture?.pose?.noisyErrorMm < 5,
    `RMS ${phonePoseState?.fixture?.pose?.noisyRmsPx?.toFixed?.(3)}px · 위치 ${phonePoseState?.fixture?.pose?.noisyErrorMm?.toFixed?.(3)}mm`);
  check('태그 2장만 보이면 자세를 지어내지 않는다',
    phonePoseState?.fixture?.pose?.twoTagGuard?.includes('3장 이상'),
    phonePoseState?.fixture?.pose?.twoTagGuard);
  check('폰 자세 모드는 RMS 3px·3태그·40mm 경로 간격을 고정한다',
    phonePoseState?.pose?.maxRmsPx === 3 && phonePoseState?.pose?.minTags === 3 &&
      phonePoseState?.pose?.pathStepMm === 40, JSON.stringify(phonePoseState?.pose));
  if (process.env.TAG_CV_SHOT) await p.screenshot(process.env.TAG_CV_SHOT);

  check('콘솔 에러 0', p.consoleErrors.length === 0, p.consoleErrors.slice(0, 2).join(' | '));
} catch (e) {
  check('실행', false, e.message);
} finally {
  await p?.close?.();
  killTree(web);          // 위 §고아 — `process.on('exit')` 이 한 번 더 받친다
}

const bad = results.filter((r) => !r).length;
console.log(bad ? `\n${bad}건 실패` : `\n${results.length}/${results.length} 통과`);
process.exit(bad ? 1 : 0);
