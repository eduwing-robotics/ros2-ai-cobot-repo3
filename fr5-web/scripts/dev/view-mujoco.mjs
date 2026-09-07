// **어디서 보면 잘 보이나** — 손목 카메라의 관측 자세 후보를 훑는다 (2026-09-03).
//
//   node scripts/dev/view-mujoco.mjs --target 480.2,-1381.3,-354.7
//   node scripts/dev/view-mujoco.mjs --target … --tilts 10,20,30,40 --dists 250,350 --json
//
// ## 왜 만드나 — 실기 담당자 「손목카메라를 계속 이동하면서 최적의 위치를 찾고」 (2026-09-03)
//
// 지금은 손목이 **선 자리에서** 찍고, 물체가 화각 가장자리에 비스듬히 걸려 크기가
// 69×85 → **50×120** 으로 찌그러진다(오늘 실측). 「좋은 자리로 옮겨서 본다」가 답인데,
// **팔을 헤매게 하면 안 된다** — 반복 이동은 `VISION-SERVO-LADDER` 2번(`POST /stop`)이
// 서기 전에는 열지 않는 것이 이 저장소의 순서다.
//
// 그래서 **헤매는 대신 미리 고른다.** 이 훑기가 「갈 수 있고 안 부딪히는」 관측 자세만
// 남기고, 사람이 그중 하나로 한 번 보낸다.
//
// ## ⛔ 역할을 정확히 가른다 — 무조코는 «보이나» 를 모른다
//
//   무조코   그 자세로 **갈 수 있나**(IK) · **부딪히나**(메시 대 메시)
//   카메라   거기서 **실제로 보이나** — `scripts/robot/carrier-find.py` 가 답한다
//
// 둘을 섞으면 「시뮬이 잘 보인다고 했다」가 되는데 그건 시뮬이 답할 수 없는 질문이다.
// 이 도구의 산출은 **후보 목록**이지 정답이 아니다.
//
// ## 시선각을 왜 0~40° 로 훑나 (사다리 §7 앞에 선 물리 벽)
//
//   0°(바로 위)   세운 총알이 **자기를 스테레오 그림자로 지운다** — 무효화소 21% · 8개 중 4개
//   88.4°(옆)     평면이 깨져 덩어리 **0개** (2026-08-13 실측)
//   → 실용 상한 **40°** 라고 사다리가 적어 뒀다. 그 안을 훑고 **판정은 카메라에 맡긴다**
//
// ⛔ **로봇을 안 움직인다.** `/ik` 는 컨트롤러에 묻기만 한다 (`amr-stop-mujoco.mjs` 와 같다).
// ponytail: 장면 세우기가 `amr-stop-mujoco.mjs` 와 닮았다. 합치지 않은 이유는 그쪽이
//   **터틀봇·바구니·든 거치대**를 세우고 여기는 **빈손**이라 장면이 다르기 때문이다.
//   천장 — 셋째 훑기가 생기면 그때 `Sim/scene/` 로 뺀다.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import loadMujoco from '@mujoco/mujoco';
import { bakeRobot } from '../../Sim/scene/build-scene.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
// 주소는 이름으로 푼다 (D164) — ⛔ 숫자를 폴백으로 두지 않는다
const HOST = process.env.FR5_HOST ?? (() => {
  const out = spawnSync('bash', [join(ROOT, 'scripts/dev/host.sh')], { encoding: 'utf8' });
  const ip = (out.stdout || '').split('\n')
    .find((l) => l.startsWith('export FR5_HOST_IP='))?.split('=')[1]?.replace(/'/g, '').trim();
  if (!ip) { console.error('⛔ 브리지 호스트를 못 찾았다 — FR5_HOST=<ip:port> 로 준다'); process.exit(1); }
  return `${ip}:5055`;
})();

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const nums = (s) => s.split(',').map(Number);
const PATH_MODE = argv.includes('--path');       // 끝점이 아니라 **가는 길**을 본다
const COVER_MODE = argv.includes('--coverage');  // **아무 데나 놔도 따라가나** — 판을 통째로
const GRID_MM = Number(opt('--grid', '150'));
const STEP_DEG = Number(opt('--step', '5'));     // 관절 보간 간격 — 게이트의 5° 표본과 같은 눈금
const TARGET = argv.includes('--target') ? nums(opt('--target')) : null;
if (!PATH_MODE && !COVER_MODE && (!TARGET || TARGET.length !== 3)) {
  console.error('⛔ --target x,y,z (user1 mm) 가 필요하다. `carrier-find.py --json` 이 낸 자리를 준다');
  process.exit(1);
}
const TILTS = nums(opt('--tilts', '0,10,20,30,40'));      // 수직(nadir)에서 기운 각
const AZIS = nums(opt('--azis', '0,45,90,135,180,225,270,315'));
const DISTS = nums(opt('--dists', '250,350,450'));         // 카메라–표적 거리

const m2 = (mm) => mm / 1000;
const D = Math.PI / 180;

// ── 브리지에서 좌표계·hand-eye 를 받는다 ─────────────────────────────────────
const state = await (await fetch(`http://${HOST}/state`)).json();
const user = state?.coordDefs?.user;
if (!user) { console.error('user1 원점을 모른다 — 로봇에 연결돼 있어야 한다 (결측=차단)'); process.exit(1); }
const tHE = state?.handEye?.tMm;
if (!tHE) { console.error('⛔ hand-eye 가 없다 — 카메라 자리를 손끝 자리로 못 옮긴다'); process.exit(1); }
const toBase = (x, y, z) => [x + user[0], y + user[1], z + user[2]];

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const ik = async (tcp) => {
  for (let t = 0; t < 3; t += 1) {
    try {
      const r = await fetch(`http://${HOST}/ik`, {                       // eslint-disable-line no-await-in-loop
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tcpMmDeg: tcp }),
      });
      if (!r.ok) return null;
      return (await r.json())?.jointsDeg ?? null;                        // eslint-disable-line no-await-in-loop
    } catch { await sleep(200 * (t + 1)); }                              // eslint-disable-line no-await-in-loop
  }
  return null;
};

// ── 회전 — **규약은 `safety._rot_fixed_xyz` 하나다** (R = Rz·Ry·Rx · D113) ──────
// 여기서는 그 **역**을 쓴다: 원하는 시선에서 오일러각을 낸다. 정본과 어긋나면 로봇이
// 엉뚱한 데를 본다 — 아래 `check` 가 왕복으로 그것을 잡는다.
const rot = (rx, ry, rz) => {
  const [cx, sx] = [Math.cos(rx * D), Math.sin(rx * D)];
  const [cy, sy] = [Math.cos(ry * D), Math.sin(ry * D)];
  const [cz, sz] = [Math.cos(rz * D), Math.sin(rz * D)];
  return [[cz * cy, cz * sy * sx - sz * cx, sz * sx + cz * sy * cx],
    [sz * cy, cz * cx + sz * sy * sx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx]];
};
const eulerOf = (R) => {
  const ry = Math.asin(Math.max(-1, Math.min(1, -R[2][0]))) / D;
  const rx = Math.atan2(R[2][1], R[2][2]) / D;
  const rz = Math.atan2(R[1][0], R[0][0]) / D;
  return [rx, ry, rz];
};
const mul = (R, v) => R.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

/** 시선(카메라 +z)이 `f` 를 향하고 롤이 `roll` 인 회전. 카메라 축 ∥ 손끝 축 전제(hand-eye 규약). */
function lookAt(f, roll) {
  const z = f.map((v) => v / Math.hypot(...f));
  let up = Math.abs(z[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1];
  let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  const nx = Math.hypot(...x); x = x.map((v) => v / nx);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const c = Math.cos(roll * D); const s = Math.sin(roll * D);
  const xr = x.map((v, i) => c * v + s * y[i]);
  const yr = y.map((v, i) => -s * x[i] + c * v);
  return [[xr[0], yr[0], z[0]], [xr[1], yr[1], z[1]], [xr[2], yr[2], z[2]]];
}

// ── 장면 — 로봇 + **게이트가 아는 상자들** (빈손이라 든 물건은 없다) ─────────────
const ZONE_THICK_MM = 80;
const zonesXml = (state?.workspace?.boxes ?? []).map((b, i) => {
  const [x0, x1] = b.xMm; const [y0, y1] = b.yMm;
  const c = toBase((x0 + x1) / 2, (y0 + y1) / 2, b.topZMm - ZONE_THICK_MM / 2);
  return `
    <body name="zone${i}" pos="${m2(c[0])} ${m2(c[1])} ${m2(c[2])}">
      <geom name="zone_${i}" type="box" size="${m2((x1 - x0) / 2)} ${m2((y1 - y0) / 2)} ${m2(ZONE_THICK_MM / 2)}" rgba="0.7 0.7 0.75 0.4"/>
    </body>`;
}).join('');

const dec = new TextDecoder();
function geomNames(model) {
  const nm = model.names; const adr = model.name_geomadr; const out = [];
  for (let g = 0; g < model.ngeom; g += 1) {
    const a = adr[g]; let s = '';
    if (a >= 0) { let e = a; while (nm[e]) e += 1; s = dec.decode(nm.slice(a, e)); }
    out.push(s);
  }
  return out;
}
const OBST = /^zone_/;

const mj = await loadMujoco();
const robot = bakeRobot(mj);                       // `{ xml, counts }` 를 준다 — 문자열이 아니다
mj.FS.writeFile('/asset/view.xml', robot.xml.replace('</worldbody>', `${zonesXml}</worldbody>`));

/** 팔(또는 그리퍼)이 **놓여 있는 것**에 닿은 쌍들. 로봇 자기접촉은 질문이 아니다.
 *  ⚠ **개수가 아니라 이름을 낸다** (2026-09-04) — 「어디에」 부딪히는지 없이 개수만 보면
 *  사람이 고칠 데를 못 찾는다. 부르는 쪽이 `.length` 로 세면 옛 뜻 그대로다. */
function contacts(joints) {
  let model; let data;
  try {
    model = mj.MjModel.from_xml_path('/asset/view.xml');
    data = new mj.MjData(model);
    for (let k = 0; k < Math.min(6, model.nq); k += 1) data.qpos[k] = joints[k] * D;
    mj.mj_forward(model, data);
    const names = geomNames(model);
    const hits = [];
    for (let i = 0; i < data.ncon; i += 1) {
      const c = data.contact[i];
      if (!c) continue;
      const a = names[c.geom1] ?? ''; const b = names[c.geom2] ?? '';
      if ((OBST.test(a) && !OBST.test(b)) || (OBST.test(b) && !OBST.test(a))) hits.push(`${a}↔${b}`);
    }
    return hits;
  } catch { return ['장면을 못 세웠다']; }           // 장면을 못 세우면 **그 자리는 못 쓴다**
  finally { data?.delete?.(); model?.delete?.(); }
}

// ── 닿는 범위 (`--coverage`) — **한 자리가 되는 건 한 자리가 된다는 뜻뿐이다** (2026-09-04)
//
// 실기 담당자 질문: *"총알거치대가 여러 위치에 있을 때 잘 따라가는지를 볼 건가"*. 그렇다 —
// 그리고 그걸 **로봇을 안 움직이고** 본다. 판 위 격자마다 「그 자리에 놓였다면 갈 수
// 있나 · 부딪히나」를 물어 지도로 낸다.
//
// ⛔ **되는 곳을 세지 말고 안 되는 곳을 본다.** 90% 가 된다는 말은 위로가 안 된다 —
//    실기 담당자가 하필 그 10% 에 놓으면 팔은 그냥 안 간다. **어디가 안 되는지**가 답이다.
// ⚠ 서 있는 자세(rx·ry·rz)와 서는 높이(standoff)는 **지금 목표에서 그대로 가져온다** —
//    설정을 다시 파싱하면 그 순간 정본이 둘이 된다 (하드 룰 5).
if (COVER_MODE) {
  const tgt0 = state?.follow?.target?.user1Mm; const goal0 = state?.follow?.goal?.tcpMmDeg;
  if (!tgt0 || !goal0) {
    console.error(`⛔ 지금 표적·목표가 있어야 자세와 높이를 가져온다 — ${state?.follow?.goalWhy ?? state?.follow?.targetWhy ?? '사유 없음'}`);
    process.exit(1);
  }
  const stand = goal0[2] - tgt0[2];
  const pose3 = goal0.slice(3);
  const boxes = (state?.workspace?.boxes ?? []).filter((b) => /작업대/.test(b.name));
  console.log(`판 ${boxes.length}개 · 격자 ${GRID_MM}mm · 서는 높이 ${stand.toFixed(0)}mm · 자세 [${pose3.join(', ')}]`);
  console.log('⛔ 무조코는 **보이나를 모른다** — 갈 수 있나·부딪히나까지다\n');
  let ok = 0; let noIk = 0; let hitN = 0;
  for (const b of boxes) {
    const xs = []; for (let x = b.xMm[0]; x <= b.xMm[1] + 1; x += GRID_MM) xs.push(x);
    const ys = []; for (let y = b.yMm[0]; y <= b.yMm[1] + 1; y += GRID_MM) ys.push(y);
    const rowsOut = [];
    for (const y of [...ys].reverse()) {
      let line = '';
      for (const x of xs) {
        const tcp = [x, y, b.topZMm + stand, ...pose3];
        const j = await ik(tcp);                      // eslint-disable-line no-await-in-loop
        if (!j) { line += '·'; noIk += 1; continue; }
        if (contacts(j).length) { line += 'X'; hitN += 1; continue; }
        line += '#'; ok += 1;
      }
      rowsOut.push(`  y ${String(Math.round(y)).padStart(6)} │${line}│`);
    }
    console.log(`${b.name}  x ${xs[0].toFixed(0)} … ${xs[xs.length - 1].toFixed(0)}   (# 간다 · X 부딪힘 · · 해없음)`);
    for (const r of rowsOut) console.log(r);
    console.log('');
  }
  const total = ok + noIk + hitN;
  console.log(`격자 ${total}칸 — **간다 ${ok}** · 부딪힘 ${hitN} · 해없음 ${noIk}`);
  if (noIk + hitN) console.log('⛔ 안 되는 칸이 있다 — 거치대를 거기 놓으면 팔은 그냥 안 간다. 위 지도를 보고 놓는다.');
  if (argv.includes('--json')) console.log(`\n===JSON===\n${JSON.stringify({ mode: 'coverage', gridMm: GRID_MM, standMm: stand, ok, hitN, noIk }, null, 1)}`);
  process.exit(0);
}

// ── 가는 길 (`--path`) — **끝점만 보면 지나가는 길을 못 본다** (2026-09-04) ──────
//
// 브리지 게이트는 경로를 5° 간격으로 표본해 **작업영역 상자**에 태운다. 그건 「손끝이
// 금지 부피에 들어가나」이고, **팔꿈치가 카트 모서리를 스치나**는 못 본다 — 상자는
// 손끝만 보고 링크 형상은 안 본다. 여기가 그 칸이다: **메시 대 메시**로 같은 길을 본다.
//
// ⛔ **여기 통과가 「가도 된다」는 아니다.** 무조코는 사람도 케이블도 실물 오차도 모른다.
//    부딪힌다고 하면 안 가고, 안 부딪힌다고 하면 **사람이 지켜보며** 간다.
if (PATH_MODE) {
  const from = state?.jointsDeg;
  const goal = state?.follow?.goal?.tcpMmDeg;
  if (!from) { console.error('⛔ 지금 관절각을 못 읽었다 — 로봇에 연결돼 있어야 한다'); process.exit(1); }
  if (!goal) {
    console.error(`⛔ 추종 목표가 없다 — ${state?.follow?.goalWhy ?? state?.follow?.targetWhy ?? state?.follow?.reason ?? '사유 없음'}`);
    process.exit(1);
  }
  const to = await ik(goal);
  if (!to) { console.error('⛔ 목표의 해가 없다 — 도달 밖이거나 그 자세가 불가능하다'); process.exit(1); }
  const span = from.map((v, i) => to[i] - v);
  const worst = Math.max(...span.map(Math.abs));
  const n = Math.max(1, Math.ceil(worst / STEP_DEG));
  console.log(`가는 길 — 관절 최대 ${worst.toFixed(1)}° · ${STEP_DEG}° 간격 → 표본 ${n + 1}개`);
  console.log(`  지금 [${from.map((v) => v.toFixed(1)).join(', ')}]`);
  console.log(`  목표 [${to.map((v) => v.toFixed(1)).join(', ')}]  ← TCP [${goal.slice(0, 3).join(', ')}]`);
  const bad = [];
  for (let k = 0; k <= n; k += 1) {
    const j = from.map((v, i) => v + (span[i] * k) / n);
    const hit = contacts(j);
    if (hit.length) bad.push({ at: k / n, hit: [...new Set(hit)] });
  }
  if (!bad.length) {
    console.log(`
✅ **전 구간 접촉 0** — ${n + 1}개 표본 전부 깨끗하다`);
    console.log('⛔ 다만 무조코는 사람도 케이블도 실물 오차도 모른다. 사람이 지켜보며 간다.');
  } else {
    console.log(`
⛔ **${bad.length}/${n + 1} 개 표본에서 부딪힌다**`);
    for (const b of bad.slice(0, 8)) console.log(`  ${(b.at * 100).toFixed(0).padStart(3)}% 지점 — ${b.hit.join(' · ')}`);
    if (bad.length > 8) console.log(`  … 그리고 ${bad.length - 8}개 더`);
  }
  if (argv.includes('--json')) {
    console.log(`
===JSON===
${JSON.stringify({ mode: 'path', from, to, goal, samples: n + 1, bad }, null, 1)}`);
  }
  process.exit(bad.length ? 1 : 0);
}

// ── 훑기 ────────────────────────────────────────────────────────────────────
console.log(`표적 user1 (${TARGET.join(', ')}) · 시선각 ${TILTS.join('/')}° · 방위 ${AZIS.length}개 · 거리 ${DISTS.join('/')}mm`);
console.log(`⛔ 무조코는 **보이나를 모른다** — 여기 통과분을 카메라(carrier-find.py)가 다시 판정한다\n`);
const rows = [];
let asked = 0;
for (const tilt of TILTS) {
  for (const azi of AZIS) {
    for (const dist of DISTS) {
      // 표적에서 카메라로 가는 방향 (위쪽 +z 기준으로 tilt 만큼 기운다)
      const n = [Math.sin(tilt * D) * Math.cos(azi * D), Math.sin(tilt * D) * Math.sin(azi * D), Math.cos(tilt * D)];
      const cam = TARGET.map((v, i) => v + dist * n[i]);
      const R = lookAt(n.map((v) => -v), 0);            // 카메라 +z 가 표적을 향한다
      const [rx, ry, rz] = eulerOf(R);
      // 손끝 = 카메라 − R·t  (`follow.cam_to_robot` 의 역 — 같은 규약이어야 한다)
      const off = mul(rot(rx, ry, rz), tHE);
      const tcp = [cam[0] - off[0], cam[1] - off[1], cam[2] - off[2], rx, ry, rz];
      asked += 1;
      const j = await ik(tcp);                          // eslint-disable-line no-await-in-loop
      if (!j) continue;
      const hit = contacts(j).length;
      if (hit > 0) continue;
      rows.push({ tiltDeg: tilt, aziDeg: azi, distMm: dist,
        tcpMmDeg: tcp.map((v) => +v.toFixed(1)), jointsDeg: j.map((v) => +v.toFixed(2)),
        reachMm: +Math.hypot(tcp[0] + user[0], tcp[1] + user[1]).toFixed(0) });
    }
  }
}

console.log(`IK 질의 ${asked}회 · **갈 수 있고 안 부딪히는** 관측 자세 ${rows.length}개`);
if (!rows.length) { console.error('되는 자리가 없다 — 표적이 팔 밖이거나 각·거리를 넓혀야 한다'); process.exit(1); }
// **팔이 덜 뻗는 쪽이 여유가 크다** — 같은 조건이면 그쪽을 위에 둔다
rows.sort((a, b) => a.reachMm - b.reachMm);
console.log('\n좋은 관측 자세 — 시선각 · 방위 · 거리 · 베이스에서');
for (const r of rows.slice(0, 10)) {
  console.log(`  시선 ${String(r.tiltDeg).padStart(2)}° · 방위 ${String(r.aziDeg).padStart(3)}°`
    + ` · ${String(r.distMm).padStart(3)}mm  ·  베이스 ${r.reachMm}mm`
    + `  ·  TCP [${r.tcpMmDeg.slice(0, 3).join(', ')}]`);
}
const byTilt = new Map();
for (const r of rows) byTilt.set(r.tiltDeg, (byTilt.get(r.tiltDeg) ?? 0) + 1);
console.log('\n시선각별 되는 자리 수 — **0°(바로 위)가 많아도 잘 보인다는 뜻이 아니다**');
for (const [t, n] of [...byTilt].sort((a, b) => a[0] - b[0])) console.log(`  ${String(t).padStart(2)}° : ${n}개`);
console.log('\n▶ 다음 — 위에서 하나 골라 사람이 팔을 보내고 `carrier-find.py` 로 **실제로 보이는지** 잰다.');
console.log('⛔ 반복 이동(서보)은 `POST /stop` 이 선 뒤에 연다 (VISION-SERVO-LADDER 2번).');
if (argv.includes('--json')) console.log(`\n===JSON===\n${JSON.stringify({ target: TARGET, asked, passed: rows.length, rows: rows.slice(0, 20) }, null, 1)}`);
