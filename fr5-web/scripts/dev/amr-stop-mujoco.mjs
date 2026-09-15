// **터틀봇이 어디 서야 팔이 안전하게 바구니에 넣나** — 무조코로 **실제 충돌**을 본다.
//
//   node scripts/dev/amr-stop-mujoco.mjs                 # 격자 훑기
//   node scripts/dev/amr-stop-mujoco.mjs --span 300 --step 60
//
// ## 왜 또 만드나 — `amr-stop-map.py` 가 못 보는 것이 있다
//
// 그쪽은 `safety.check_workspace` 로 **상자 판정**을 한다. 그건 「금지 구역을 파고들었나」이지
// **「손에 든 거치대가 바구니 벽에 닿나」가 아니다.** 실제로 08-31 시뮬에서
// *「게이트가 손에 든 거치대를 모른다」* 를 한계로 적어 뒀는데, 그 한계를 여기서 닫는다.
//
// 무조코는 **메시 대 메시**로 접촉을 센다. 그래서
//   ① 팔이 터틀봇·바구니에 부딪히나
//   ② **든 거치대**가 바구니 벽·테두리에 걸리나
// 둘을 같이 답한다. `arm-fk.mjs` 와 **같은 로봇 모델**을 쓰므로 판정이 갈리지 않는다.
//
// ⛔ **로봇을 안 움직인다.** 관절각은 브리지 `/ik` 가 컨트롤러에게 물어 받은 값이고,
//    여기서는 그 자세를 무조코에 **세워 보기만** 한다.
//
// ⭐ **08-31 이 적어 둔 가정 하나가 닫혔다 (2026-09-03).** 바구니가 터틀봇 어디에 달렸는지
//    (`AMR_BASKET.offsetMm`)를 손목 뎁스로 쟀다 — **−115.0mm**, 유도값 −132 보다 17mm 앞.
//    이제 이 지도는 가정이 아니라 실측 위에 선다. `offsetMm` 이 `null` 로 되돌아가면
//    아래가 다시 유도로 떨어지고, **머리말이 그 사실을 화면에 적는다.**
//
// ## ⛔ 직선 주행만 본다 (2026-08-31 정정 · 실기 담당자 「대각선으로 이동하지 않을 거야」)
//
// 처음엔 x·y 격자를 훑어 **대각선 자리**를 추천했다 — 터틀봇이 못 가는 곳이다.
// 차동구동 로봇은 **자기 heading 으로 앞뒤**만 간다. 홈이 곧 `odom` 원점이고
// 홈 요각이 `AMR_HOME.yawDeg` 이므로, 직진하면 **odom y 는 0 에 머문다.**
//
// 실측 검산 (2026-08-31) — `odom (x, 0)` 을 `user1` 로 옮기면 **y 가 −948.2 로 고정**이고
// x 만 변한다. 그래서 이 훑기는 **한 축**만 본다. 회전은 도착해서 제자리로 한다
// (D141 실측: 직진은 600mm 에 0.4°, 오차는 전부 회전에서 난다 — 직진을 길게 잡는다).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import loadMujoco from '@mujoco/mujoco';
import { bakeRobot } from '../../Sim/scene/build-scene.mjs';
import { CARRIER, AMR_BASKET } from '../../Shared/data/props.js';
import { AMR_HOME } from '../../Shared/data/workcell.js';
import { AMR_MM } from '../../Shared/data/layout/catalog.js';
import { composeDemoScene } from '../../Shared/data/sim/scene-compose.js';
import { relevantHits } from '../../Shared/data/sim/contact-check.js';
import { makeLoadSteps } from '../../Shared/data/sim/load-steps.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
// 주소는 `scripts/dev/host.sh` 가 **이름으로** 푼다 (D164). ⛔ 숫자를 폴백으로 두지 않는다 —
// 여기 박혀 있던 `192.168.30.6:5055` 는 DHCP 가 옮기는 순간 **조용히 틀린 기계**에 붙는다.
const HOST = process.env.FR5_HOST ?? (() => {
  const out = spawnSync('bash', [join(ROOT, 'scripts/dev/host.sh')], { encoding: 'utf8' });
  const ip = (out.stdout || '').split('\n')
    .find((l) => l.startsWith('export FR5_HOST_IP='))?.split('=')[1]?.replace(/'/g, '').trim();
  if (!ip) {
    console.error('⛔ 브리지 호스트를 못 찾았다 — 그 PC 가 망에 없거나 꺼졌다.');
    console.error('   이번만 다른 기계면 FR5_HOST=<ip:port> 를 주고 다시 돌린다.');
    process.exit(1);
  }
  return `${ip}:5055`;
})();
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const SPAN = arg('--span', 240);
const STEP = arg('--step', 80);
const YAWS = (argv.includes('--yaws') ? argv[argv.indexOf('--yaws') + 1] : '0,90,180,270')
  .split(',').map(Number);

const m2 = (mm) => mm / 1000;                 // 무조코는 미터다 (하드 룰 5 — 여기 한 곳에서만 바꾼다)

// ── 브리지에서 좌표계와 자세를 받는다 ─────────────────────────────────────
const state = await (await fetch(`http://${HOST}/state`)).json();
const user = state?.coordDefs?.user;
if (!user) { console.error('user1 원점을 모른다 — 로봇에 연결돼 있어야 한다 (결측=차단)'); process.exit(1); }
// ⚠ **끊기면 다시 묻는다** — 컨트롤러 왕복이라 수백 회를 몰아 보내면 소켓이 끊긴다
// (2026-08-31 실측: 29자리 훑기 중 `ECONNRESET` 으로 통째로 죽었다). 한 번 실패했다고
// 훑기를 버리면 **재현이 안 되는 지도**가 된다 — 짧게 쉬고 두 번 더 물어본다.
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const ik = async (tcp) => {
  for (let t = 0; t < 3; t += 1) {
    try {
      const r = await fetch(`http://${HOST}/ik`, {                 // eslint-disable-line no-await-in-loop
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tcpMmDeg: tcp }),
      });
      if (!r.ok) return null;
      return (await r.json())?.jointsDeg ?? null;                   // eslint-disable-line no-await-in-loop
    } catch {
      await sleep(200 * (t + 1));                                   // eslint-disable-line no-await-in-loop
    }
  }
  return null;      // 세 번 다 끊겼다 — **해가 없는 것과 구분해 두면 좋지만**, 지도에서는
                    // 둘 다 「그 자리는 못 쓴다」로 같다. 로그가 필요해지면 여기서 나눈다
};
// user1 → 베이스. `frames.js` 와 같은 규약(회전 0 전제)이다
const toBase = (x, y, z) => [x + user[0], y + user[1], z + user[2]];

// ── 장면 — 로봇 + 터틀봇(상자) + 바구니(벽 넷) + 든 거치대 ─────────────────
const wall = AMR_BASKET.wallMm ?? 3;
const outD = AMR_BASKET.innerDMm + 2 * wall;
// **잰 값이 유도값을 이긴다** (2026-09-03). `offsetMm.x` 는 손목 뎁스로 테두리 고리를 잡아
// 낸 값이고(−115.0 · std 3mm · `props.js` §방법), 유도값(−132)보다 **17mm 앞**이다.
// ⚠ 유도로 떨어질 때는 **그 사실을 화면에 적는다** — 조용히 가정 위에 서면 08-31 처럼
// 「정차 자리·시간이 전부 가정 위」인 것을 아무도 모른다.
const measuredBack = Number.isFinite(AMR_BASKET.offsetMm?.x) ? AMR_BASKET.offsetMm.x : null;
const backOff = measuredBack ?? -(AMR_MM.depthMm / 2 + outD / 2);   // 등 뒤에 **이어** 붙는다

// ── 고정 장애물 — **거치대2·작업대·카트** (2026-08-31 정정 · 실기 담당자 「거치대2 위치까지 확인」)
//
// ⛔ 처음엔 장면에 **터틀봇·바구니·든 거치대만** 넣었다. 그래서 「접촉 0」이 뜻하는 것이
// 「터틀봇에 안 부딪힌다」 뿐이었고, **팔이 거치대2 나 작업대를 뚫어도 초록**이었다.
// 실기 게이트가 지키는 그 상자들을 **같은 값으로** 넣어 판정을 한 뜻으로 만든다.
//
// 상자는 `topZMm` 이 **윗면**이다. 아래로 이만큼 두꺼운 판으로 세운다 — 팔이 그 밑으로
// 내려갈 일이 없으므로 바닥까지 그릴 필요가 없다.
const ZONE_THICK_MM = 80;
const zonesXml = (state?.workspace?.boxes ?? []).map((b, i) => {
  const [x0, x1] = b.xMm; const [y0, y1] = b.yMm;
  const c = toBase((x0 + x1) / 2, (y0 + y1) / 2, b.topZMm - ZONE_THICK_MM / 2);
  return `
    <body name="zone${i}" pos="${m2(c[0])} ${m2(c[1])} ${m2(c[2])}">
      <geom name="zone_${i}" type="box" size="${m2((x1 - x0) / 2)} ${m2((y1 - y0) / 2)} ${m2(ZONE_THICK_MM / 2)}" rgba="0.7 0.7 0.75 0.4"/>
    </body>`;
}).join('');

// 장면 합성은 `Shared/data/sim/scene-compose.js` 하나다 (2026-09-06 · phase 1) — 화면(시뮬 탭)과 같은 터틀봇·바구니·든 거치대.
// 구운 로봇(`bakeRobot`)엔 구역 상자가 없어 `zones` 로 넣는다(구운 **장면**을 쓰는 화면은 안 넣는다)
// **구운 장면**(`Sim/out/scene/<robotId>.xml` · 팔+툴+`tcp` 사이트+구역 상자)을 쓴다 — 화면(시뮬 탭)·게이트(`sim-contact.mjs`)와 같은 장면.
// 로봇만 구운 `bakeRobot` 출력엔 `tcp` 사이트가 없어 든 거치대를 못 붙인다(2026-09-06 실측 · 합성이 null → writeFile 이 죽었다)
const SCENE_FILE = join(ROOT, 'Sim/out/scene/fr5-lab-a.xml');
if (!existsSync(SCENE_FILE)) execFileSync('node', [join(ROOT, 'Sim/scene/build-scene.mjs')], { stdio: 'inherit' });
const SCENE_XML = readFileSync(SCENE_FILE, 'utf-8');
const sceneXml = (_robotXml, amr) => {
  const xml = composeDemoScene(SCENE_XML, { amrUser1: amr, userDef: user, carried: true });
  if (!xml) { console.error('장면 합성 실패 — 구운 장면 모양이 다르다'); process.exit(1); }
  return xml;
};
const dec = new TextDecoder();
function geomNames(model) {
  const nm = model.names; const adr = model.name_geomadr; const out = [];
  for (let g = 0; g < model.ngeom; g += 1) {
    const a = adr[g]; let s2 = '';
    if (a >= 0) { let e = a; while (nm[e]) e += 1; s2 = dec.decode(nm.slice(a, e)); }
    out.push(s2);
  }
  return out;
}
// 무엇이 무엇에 닿았나를 **세 무리**로 가른다. 질문은 하나다 —
// **「팔이나 팔이 든 것이, 놓여 있는 것에 닿나」.**
function countRelevant(model, data) {
  const names = geomNames(model);
  const pairs = [];
  for (let i = 0; i < data.ncon; i += 1) {
    const c = data.contact[i];
    if (c) pairs.push([names[c.geom1] ?? '', names[c.geom2] ?? '', c.dist]);
  }
  return relevantHits(pairs);            // 팔·툴·든 거치대 ↔ 놓인 것 · 3mm 넘게 파고든 것만 (`contact-check.js`)
}
const mj = await loadMujoco();
const robot = bakeRobot(mj);
const floorZ = AMR_HOME.topZMm + (AMR_BASKET.rimAboveGroundMm ?? 0) - (AMR_BASKET.innerHMm ?? 0);
const zRim = AMR_HOME.topZMm + (AMR_BASKET.rimAboveGroundMm ?? 0) + 40;
const zIns = floorZ + CARRIER.hMm;

// **한 축만 훑는다** — 위 §직선 주행만 본다. `odom x` 를 밀면 `user1 x` 만 변한다
const xs = []; for (let v = AMR_HOME.xMm - SPAN; v <= AMR_HOME.xMm + SPAN + 1e-6; v += STEP) xs.push(v);
const ys = [AMR_HOME.yMm];       // ⛔ 대각선 자리는 후보가 아니다 (터틀봇이 못 간다)
console.log(`홈 (${AMR_HOME.xMm}, ${AMR_HOME.yMm}) · 진입 z ${zRim.toFixed(1)} · 놓기 z ${zIns.toFixed(1)}`);
console.log(`직선 후보 ${xs.length}자리 × 요각 ${YAWS.length} = ${xs.length * ys.length * YAWS.length}개 (y 는 ${AMR_HOME.yMm} 고정 — 직진만)`);
// ⛔ **이 줄이 거짓말을 하면 안 된다** — 08-31~09-03 사이 이 머리말은 오프셋을 실측한 뒤에도
// 「유도값이다」를 계속 찍었다. 산출을 읽는 사람이 제일 먼저 보는 줄이라 여기서 갈라 적는다
console.log(measuredBack === null
  ? '⚠ 바구니 오프셋은 **유도값**이다 (AMR_BASKET.offsetMm 미측정)\n'
  : `✅ 바구니 오프셋 **실측** ${measuredBack.toFixed(1)}mm (${AMR_BASKET.offsetMethod})\n`);

const rows = [];
let asked = 0;
// ── 순서 전체를 각 자리에서 돌린다 (2026-08-31 정정 · 실기 담당자 「시나리오 확인」)
//
// ⛔ 전에는 **넣는 두 자세만** 봤다. 그러면 「터틀봇이 팔의 **집는 길**을 막나」를 못 본다 —
// 터틀봇이 가까이 서면 팔이 거치대1 로 가는 도중에 부딪힌다. 시나리오 ①(pile)은
// **집기와 싣기가 한 정차에서** 일어나므로, 한 자리에서 둘 다 돼야 「되는 자리」다.
//
// ⚠ 집는 좌표는 아직 **손으로 문 그 한 자리**다. 최종 구조는 태그를 검출해 그쪽으로
//    가는 것이고(실기 담당자 2026-08-31), 그때는 이 값이 검출 결과로 바뀐다.
// 순서의 정본은 `Shared/data/sim/load-steps.js` 다 — 여기 좌표를 따로 적지 않는다 (2026-09-06)
const SPEED_PCT = 10;                 // `safety.SPEED_CAP_PCT` — 상한을 넘겨 재지 않는다
const DEG_S = 28.9 * (SPEED_PCT / 100);   // `workcell.JOINT_DEG_S_AT_FULL` 실측

for (const x of xs) {
  for (const y of ys) {
    for (const yaw of YAWS) {
      const th = (yaw * Math.PI) / 180;
      const cx = x + backOff * Math.cos(th);
      const cy = y + backOff * Math.sin(th);
      const seq = makeLoadSteps({ xMm: x, yMm: y, yawDeg: yaw }).map((s) => [s.label, s.pose]);
      const xml = sceneXml(robot.xml, [x, y, yaw]);
      mj.FS.writeFile('/asset/stop.xml', xml);
      let ok = true; let why = null; const js = [];
      for (const [name, tcp] of seq) {
        const j = await ik(tcp);                       // eslint-disable-line no-await-in-loop
        asked += 1;
        if (!j) { ok = false; why = `${name} 해 없음`; break; }
        js.push(j);
        let mm2; let d2;
        try {
          mm2 = mj.MjModel.from_xml_path('/asset/stop.xml');
          d2 = new mj.MjData(mm2);
          for (let k = 0; k < Math.min(6, mm2.nq); k += 1) d2.qpos[k] = (j[k] * Math.PI) / 180;
          mj.mj_forward(mm2, d2);
          const hits = countRelevant(mm2, d2);
          if (hits.length) { ok = false; why = `${name} ${hits[0]}`; }
        } catch (e) { ok = false; why = `${name} 장면실패`; } finally { d2?.delete?.(); mm2?.delete?.(); }
        if (!ok) break;
      }
      if (!ok) continue;
      // **정차 시간** — 관절 여섯이 같이 도니 구간 시간은 **가장 많이 도는 관절**이 정한다
      let sec = 0;
      for (let k = 1; k < js.length; k += 1) {
        let mx = 0;
        for (let a = 0; a < 6; a += 1) mx = Math.max(mx, Math.abs(js[k][a] - js[k - 1][a]));
        sec += mx / DEG_S;
      }
      rows.push({ amr: [x, y, yaw], basket: [cx, cy], reach: Math.hypot(cx, cy), sec });
    }
  }
}

console.log(`\nIK 질의 ${asked}회 · **순서 6칸 전부 통과한** 정차 자리 ${rows.length}개`);
if (!rows.length) { console.error('되는 자리가 없다 — span 을 넓히거나 오프셋을 재야 한다'); process.exit(1); }
// **홈에서 짧을수록 좋다** — 주행 거리가 곧 오차다(D141). 동점이면 팔이 덜 뻗는 쪽.
rows.sort((a, b) => (Math.abs(a.amr[0] - AMR_HOME.xMm) - Math.abs(b.amr[0] - AMR_HOME.xMm))
  || (a.reach - b.reach));
// **되는 구간을 먼저 말한다** — 한 자리보다 「어디부터 어디까지 되나」가 주행에 쓸모 있다.
{
  const byYaw = new Map();
  for (const r of rows) {
    const k = r.amr[2];
    const v = byYaw.get(k) ?? { lo: Infinity, hi: -Infinity, best: null };
    const fwd = AMR_HOME.xMm - r.amr[0];
    v.lo = Math.min(v.lo, fwd); v.hi = Math.max(v.hi, fwd);
    if (!v.best || r.reach < v.best.reach) v.best = r;
    byYaw.set(k, v);
  }
  console.log('\n요각별 **되는 직진 구간** (홈에서 앞으로 +mm)');
  for (const [yaw, v] of [...byYaw].sort((a, b) => a[0] - b[0])) {
    const bf = AMR_HOME.xMm - v.best.amr[0];
    console.log(`  ${String(yaw).padStart(3)}°  ${String(v.lo).padStart(5)} ~ ${String(v.hi).padStart(4)} mm`
      + `  ·  팔이 제일 덜 뻗는 자리 ${String(bf).padStart(4)}mm (${v.best.reach.toFixed(0)}mm)`);
  }
}
console.log('\n좋은 자리 — 터틀봇(x, y, 요각) · 바구니중심 · 베이스거리');
for (const r of rows.slice(0, 8)) {
  const fwd = AMR_HOME.xMm - r.amr[0];        // odom x = 홈에서 앞으로 간 거리
  console.log(`  터틀봇 user1 (${r.amr[0].toFixed(0).padStart(6)}, ${r.amr[1].toFixed(0)}) ${String(r.amr[2]).padStart(4)}°`
    + `  ·  직진 ${fwd >= 0 ? '앞' : '뒤'} ${Math.abs(fwd).toFixed(0).padStart(4)}mm`
    + `  ·  베이스에서 ${r.reach.toFixed(0)}mm  ·  **정차 ${r.sec.toFixed(1)}초**`);
}
const best = rows[0];
const fwd = AMR_HOME.xMm - best.amr[0];
console.log(`\n추천 — 터틀봇 user1 (${best.amr[0].toFixed(0)}, ${best.amr[1].toFixed(0)}) 요각 ${best.amr[2]}°`);
console.log(`  홈(odom 원점)에서 **직진 ${fwd >= 0 ? '앞으로' : '뒤로'} ${Math.abs(fwd).toFixed(0)}mm** · odom (${fwd.toFixed(0)}, 0)`);
console.log(`  **정차 시간 ${best.sec.toFixed(1)}초** — 관절 이동량 ÷ ${DEG_S.toFixed(2)}°/s (상한 ${SPEED_PCT}%)`);
console.log('  ⚠ 가감속·정착 대기는 안 넣었다 — **하한**이다 (실주행에서 더 걸린다)');
console.log(measuredBack === null
  ? '⛔ 경로에 바로 박지 않는다 — **바구니 오프셋이 유도값**이다. 재고 다시 돌린다'
  : `✅ 바구니 오프셋은 **실측**이다 (${measuredBack.toFixed(1)}mm · ${AMR_BASKET.offsetMethod})`);

// ── `--json` — 후보를 **코드로 넘긴다** (2026-09-03) ───────────────────────────
// 사람이 읽는 표만 찍고 끝나면 화면이 후보를 못 쓴다. 시뮬 탭이 여러 자리를 비교하려면
// 산출이 데이터여야 한다. ⛔ 여기서 파일에 쓰지 않는다 — **stdout 으로만** 낸다.
// 정본에 박는 것은 사람이 보고 고르는 일이지 스크립트가 몰래 할 일이 아니다.
if (argv.includes('--json')) {
  const top = rows.slice(0, arg('--top', 6)).map((r) => ({
    xMm: +r.amr[0].toFixed(1), yMm: +r.amr[1].toFixed(1), yawDeg: r.amr[2],
    fromHomeMm: +(AMR_HOME.xMm - r.amr[0]).toFixed(1),
    turnFromHomeDeg: +(r.amr[2] - AMR_HOME.yawDeg).toFixed(1),
    reachMm: +r.reach.toFixed(0), dwellSec: +r.sec.toFixed(1),
  }));
  console.log(`\n===JSON===\n${JSON.stringify({
    _: 'amr-stop-mujoco.mjs 산출 — 순서 6칸을 무조코 충돌까지 통과한 자리',
    basketOffsetMm: measuredBack, basketOffsetMeasured: measuredBack !== null,
    asked, passed: rows.length, span: SPAN, step: STEP, yaws: YAWS,
    at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    candidates: top,
  }, null, 1)}`);
}
