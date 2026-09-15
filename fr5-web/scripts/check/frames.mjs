// 좌표계 SSOT 게이트 — 문서(`FRAMES.md`)와 모듈(`frames.js`)이 **같은 표**를 가리키나,
// 그리고 fail-closed 불변식이 살아 있나.
//
// 왜 있나 — 이 저장소는 좌표계 **라벨**로 다섯 번 다쳤다. 마지막 하나는 라벨 사고를 막으려고
// 만든 SSOT 안에서 났다(`base→lab` 이 실은 `user1→lab`). 손으로 한 번 맞춰 놓는 것으로는
// 안 된다 — 한쪽만 고치는 순간 갈라지고, 갈라진 건 아무도 안 본다. `consts.sh` 와 같은 취지다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { FRAMES, EDGES, toFrame, yawToFrame, ROT_TOL_DEG } = await import(join(ROOT, 'Shared/data/frames.js'));
const { toBase } = await import(join(ROOT, 'Shared/view3d/workspace.js'));
const { AMR_HOME } = await import(join(ROOT, 'Shared/data/workcell.js'));
const md = readFileSync(join(ROOT, 'docs/ref/contract/FRAMES.md'), 'utf8');

let fail = 0;
const ok = (c, m, got) => {
  if (c) { console.log(`  ${m}`); return; }
  console.log(`  FAIL  ${m}${got === undefined ? '' : `  got=${JSON.stringify(got)}`}`);
  fail += 1;
};

console.log('== 문서 ↔ 모듈 ==');
for (const n of Object.keys(FRAMES)) ok(md.includes(`\`${n}\``), `프레임 ${n} 이 문서에 있다`);
ok((md.match(/^\| `\w+` \| /gm) ?? []).length === Object.keys(FRAMES).length,
  `문서 프레임 표 행수 = 모듈 ${Object.keys(FRAMES).length}`,
  (md.match(/^\| `\w+` \| /gm) ?? []).length);
for (const e of EDGES) {
  const row = md.split('\n').find((l) => l.includes(`\`${e.from}\` → \`${e.to}\``));
  ok(Boolean(row), `갈래 ${e.from}→${e.to} 가 문서에 있다`);
  if (row) ok(row.toLowerCase().includes(e.kind), `  그 행의 kind 가 ${e.kind}`, row.slice(0, 70));
}

console.log('== fail-closed (규약 3) ==');
const P = { xMm: 100, yMm: 50, zMm: 0 };
const WS = { boxes: [{ name: 't', xMm: [0, 100], yMm: [0, 100], topZMm: -380.9 }], walls: [] };
for (const [n, v] of [['NaN', NaN], ['문자열', 'x'], ['숫자문자열', '0'], ['undefined', undefined], ['null', null], ['Infinity', Infinity]]) {
  ok(toFrame(P, 'user1', 'base', { user1: [-401.8, 497.3, 342.1, v, 0, 0] }) === null, `frames 회전 ${n} → null`);
  ok(toFrame(P, 'user1', 'base', { user1: [v, 497.3, 342.1, 0, 0, 0] }) === null, `frames 이동 ${n} → null`);
  ok(toBase(WS, [-401.8, 497.3, 342.1, v, 0, 0]) === null, `toBase 회전 ${n} → null`);
}
ok(toFrame(P, 'user1', 'base', { user1: [-401.8, 497.3, 342.1, ROT_TOL_DEG, 0, 0] }) !== null, `문턱 ${ROT_TOL_DEG}° 경계는 통과`);
ok(toFrame(P, 'user1', 'base', { user1: [-401.8, 497.3, 342.1, ROT_TOL_DEG + 0.01, 0, 0] }) === null, `문턱 초과는 차단`);
ok(toFrame(P, 'user1', 'base', {}) === null, 'live 값 없으면 null');
for (const e of EDGES.filter((x) => x.kind === 'unknown')) {
  ok(toFrame(P, e.from, e.to, { user1: [-401.8, 497.3, 342.1, 0, 0, 0] }) === null, `unknown 갈래 ${e.from}→${e.to} 는 null`);
}

console.log('== 사슬 교차검증 (원본과 대조) ==');
// 같은 작업대를 user1(config.yaml 실측)·lab(presets) 두 프레임으로 잰 값이 맞아야 한다
const L = { user1: [-401.846, 497.329, 342.076, 0, 0, 0] };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const t1 = toFrame({ xMm: 688.1, yMm: -1048.2, zMm: -380.9 }, 'user1', 'lab', L);
ok(near(t1.xMm, 2204.2, 0.05) && near(t1.yMm, 1750.0, 0.05), '작업대1 user1→lab = presets 값', [t1.xMm, t1.yMm]);
ok(near(t1.zMm, 965, 0.2), '작업대 상판 높이 = presets hMm 965 (독립 검산)', t1.zMm);
const t2 = toFrame({ xMm: -111.9, yMm: -1048.2, zMm: -380.9 }, 'user1', 'lab', L);
ok(near(t2.xMm, 1404.2, 0.05) && near(t2.yMm, 1750.0, 0.05), '작업대2 도 맞는다', [t2.xMm, t2.yMm]);
// odom 은 축까지 돈다 — 전진이 작업대2 쪽(user1 −x)이어야 한다
const fwd = toFrame({ xMm: 500, yMm: 0, zMm: 0 }, 'odom', 'user1', L);
ok(near(fwd.xMm, AMR_HOME.xMm - 500, 0.01), 'odom 전진 500 → user1 x 가 500 줄어든다 (회전 반영)', fwd.xMm);
ok(near(yawToFrame(0, 'odom', 'user1', L), AMR_HOME.yawDeg, 0.01), `odom 요각 0 → user1 ${AMR_HOME.yawDeg}°`);
// 왕복
const rt = toFrame(toFrame({ xMm: 123, yMm: -45, zMm: 6 }, 'odom', 'base', L), 'base', 'odom', L);
ok(near(rt.xMm, 123, 1e-6) && near(rt.yMm, -45, 1e-6) && near(rt.zMm, 6, 1e-6), 'odom→base→odom 이 제자리', rt);

console.log('== 모델 정면 0점 (두 화면이 같은가) ==');
const THREE = await import(join(ROOT, 'node_modules/three/build/three.module.js'));
const { mountBurgerZUpXForward, mountBurgerYUpXForward } = await import(join(ROOT, 'Shared/view3d/burger.js'));
const probe = () => { const p = new THREE.Object3D(); const n = new THREE.Object3D(); n.position.set(0, 0, 1); p.add(n); return [p, n]; };
const [pz, nz] = probe(); const gz = new THREE.Group(); gz.add(mountBurgerZUpXForward(pz)); gz.updateMatrixWorld(true);
const vz = nz.getWorldPosition(new THREE.Vector3());
ok(near(vz.x, 1, 1e-6), 'Z-up(FR5) yaw 0 → +x', [vz.x, vz.y, vz.z]);
const [py, ny] = probe(); const gy = new THREE.Group(); gy.add(mountBurgerYUpXForward(py)); gy.updateMatrixWorld(true);
const vy = ny.getWorldPosition(new THREE.Vector3());
ok(near(vy.x, 1, 1e-6) && near(-vy.z, 0, 1e-6), 'Y-up(배치) θ 0 → 평면도 +x', [vy.x, -vy.z]);

console.log(fail ? `\n좌표계 SSOT 실패 (${fail}건)` : '\n좌표계 SSOT OK');
process.exit(fail ? 1 : 0);
