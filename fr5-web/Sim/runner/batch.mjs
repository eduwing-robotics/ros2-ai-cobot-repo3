// 승인된 슬롯 하나를 **N개로 증식해 돌리고 숫자를 걷는다** (SIM-CONTRACT §증식 · §데이터).
//
//     node Sim/runner/batch.mjs                                  # 슬롯 2 · 96개 · seed 20260808
//     node Sim/runner/batch.mjs --slot 2 --n 8 --seed 1 --out Sim/out
//
// **시뮬은 실기에 무엇을 넣지 않는다** (D96). 승인된 것을 **읽어** 여러 조건에서 잴 뿐이고,
// 브리지 주소도 모른다(불변식 1) — 입력은 `scripts/dev/sim-fixture.mjs` 가 구운 파일이다.
//
// ⚠ **좌표계를 반드시 바꾼다.** `config.yaml` 의 상자·벽은 `user1` 좌표계인데 무조코는 베이스를
//    준다. 2026-08-11 실측: 안 바꾸면 손끝이 **725.7mm** 어긋나고, 바꾸면 컨트롤러와 **1.3mm** 다.
//
// ⚠ **Embind 핸들은 GC 되지 않는다** — `MjData` 를 손으로 지운다. 하드 상한이 fps 가 아니라
//    메모리(`MjData` 148개)라, 안 지우면 N 을 못 올린다 (`@mujoco/mujoco` README §Memory).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { readWorkspace, bakeRobot, composeScene } from '../scene/build-scene.mjs';
import { judgeWorkspace, judgeFingerprint } from './judge.mjs';
// **실기 속도의 정본**을 그대로 쓴다 — 시뮬 사이클타임이 PD 게인이 만든 값이 아니라
// 실기와 비교 가능한 숫자가 되게 (`workcell.js` · 2026-08-08 회귀 실측).
import { JOINT_DEG_S_AT_FULL, MOVE_FIXED_S } from '@fr5/shared/data/workcell.js';
import { clearanceMm } from './clearance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const die = (m) => { console.error(`batch: ${m}`); process.exit(1); };

const arg = (k, dflt) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? dflt : process.argv[i + 1];
};

// 재현이 안 되면 계측이 아니다 (계약 §증식). `Math.random` 을 쓰지 않는다.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const DEG = Math.PI / 180;

/**
 * 회전행렬(행 우선 9개) → 고정축 XYZ 오일러 `[rx, ry, rz]` (도).
 *
 * **컨트롤러가 `tcpMmDeg` 로 주는 것과 같은 형식**이라야 게이트가 실기와 같은 값을 본다.
 * `R = Rz·Ry·Rx` 를 되푼다 — 규약 근거는 `docs/evidence/2026-08-11/tcp-euler-convention.md`.
 */
function eulerFixedXyzDeg(m) {
  const ry = Math.asin(Math.max(-1, Math.min(1, -m[6])));
  return [Math.atan2(m[7], m[8]) / DEG, ry / DEG, Math.atan2(m[3], m[0]) / DEG];
}
const SETTLE_DEG = 0.5;        // 도착 판정 — 목표에서 이 안에 들어오면 다음 칸
const SETTLE_DPS = 2.0;        // 그리고 거의 멈춰 있어야 한다 (지나가는 순간을 도착으로 읽지 않게)
// 한 칸의 상한 — **계획 시간의 배수**로 잡는다. 속도를 흔들면 칸마다 계획이 달라져
// 고정 상한은 느린 인스턴스를 통째로 시간초과로 만든다 (2026-08-11).
const TIMEOUT_FACTOR = 3;
const TIMEOUT_FLOOR_S = 5;
// 속도 지터 — **실기 상한 10% 둘레**로만 흔든다 (하드 룰 3). 보기 좋으라고 크게 흔들면
// 그건 계측이 아니라 연출이다 (계약 §화면).
const SPEED_PCT = [5, 15];
const JUDGE_EVERY = 8;         // 손끝 판정 주기(스텝). 60Hz 쯤 — 매 스텝은 낭비다
const PER_INSTANCE_POINTS = 64;   // 인스턴스마다 이만큼만 남긴다 — 속도가 달라도 공평하다
const SWEEP_EVERY = 4;         // 점군은 판정의 1/4 만 담는다 — 96개 × 62점 ≈ 6천점
// 재생 프레임 — 3층 모달이 **로봇을 실제로 움직이려면 자세가 있어야 한다**. 진행률로 솎으므로
// 프레임 번호가 곧 진행률이다(밴드 차트와 가로축이 같아진다 — 스크러버가 둘을 같이 움직인다).
const FRAMES_PER_INSTANCE = 120;

export async function runBatch(opts = {}) {
  // **슬롯 이름을 기본값으로 박지 않는다.** 사람이 프로그램을 새로 가르치면 이름이 바뀌는데,
  // 박아 두면 픽스처를 다시 굽는 날 게이트가 「슬롯 2 가 없다」로 죽는다 (2026-08-11).
  // 안 주면 픽스처의 **첫 슬롯**을 쓴다 — 어차피 승인된 것만 들어 있다.
  const wantSlot = opts.slot ?? arg('slot', null);
  const n = Number(opts.n ?? arg('n', '96'));
  const seed = Number(opts.seed ?? arg('seed', '20260808'));
  const outDir = opts.out ?? arg('out', join(ROOT, 'Sim/out'));
  const robotId = opts.robot ?? arg('robot', 'fr5-lab-a');

  // `fixture`·`ws` 를 인자로 받을 수 있게 둔다 — **게이트가 결함을 주입하기 위해서다.**
  // 「검출기가 있다」와 「검출기가 잡는다」는 다르다(D97). 주입 통로가 없으면 0건이
  // 「깨끗하다」인지 「안 재고 있다」인지 영영 못 가린다.
  let fx = opts.fixture;
  if (!fx) {
    const fxPath = join(ROOT, 'Sim/fixtures', `${robotId}.json`);
    try { fx = JSON.parse(readFileSync(fxPath, 'utf-8')); }
    catch { die(`픽스처가 없다: ${fxPath} — 로봇을 붙이고 node scripts/dev/sim-fixture.mjs`); }
  }

  if (!fx.slots?.length) return die('픽스처에 승인된 슬롯이 0개다 — node scripts/dev/sim-fixture.mjs');
  const slotName = wantSlot === null || wantSlot === undefined
    ? String(fx.slots[0].name) : String(wantSlot);
  const slot = fx.slots.find((s) => s.name === slotName);
  if (!slot) return die(`슬롯 "${slotName}" 이 픽스처에 없다 (있는 것: ${fx.slots.map((s) => s.name).join(', ')})`);

  const ws = opts.ws ?? readWorkspace(robotId);
  // **판정용 구역과 장면용 구역을 가를 수 있게 둔다.** 기본은 같은 것이고, 게이트만
  // `judgeWs` 로 결함을 주입한다 — 물리를 안 흔들고 **판정 경로만** 시험하기 위해서다.
  const judgeWs = opts.judgeWs ?? ws;
  const userT = fx.coordDefs.user.slice(0, 3);      // 베이스 기준 user1 원점 (mm)

  const mj = await loadMujoco();
  const robot = bakeRobot(mj);
  mj.FS.writeFile('/asset/batch.xml', composeScene(robot.xml, ws, userT));
  const model = mj.MjModel.from_xml_path('/asset/batch.xml');

  if (n > 148) die(`n=${n} 은 MjData 상한(148)을 넘는다 — 상한을 낮추지 말고 계약에 다시 적는다`);
  const dt = model.opt.timestep;
  const nq = robot.counts.joint;

  // 시작 자세 = 슬롯의 home. 없으면 첫 지점
  const home = slot.points.home ?? Object.values(slot.points)[0];
  const r = rng(seed);
  const datas = [];
  const inst = [];
  for (let i = 0; i < n; i++) {
    const d = new mj.MjData(model);
    // 지터 — 시작 자세만 흔든다. 관절 한계·작업영역은 흔드는 값이 아니라 **판정하는 값**이다
    const start = home.map((v) => v + (r() * 4 - 2));      // ±2°
    // **경로 전체를 가르는 유일한 축** — 시작 자세는 첫 구간만 바꾸고 곧 수렴한다(실측 j1 상관 0.02).
    // ⚠ 시뮬 속도가 실기 `speedPct` 와 같다는 증거는 아직 없다 — 시간 모델만 실기 것을 쓴다
    const speedPct = SPEED_PCT[0] + r() * (SPEED_PCT[1] - SPEED_PCT[0]);
    for (let j = 0; j < nq; j++) { d.qpos[j] = start[j] * DEG; d.ctrl[j] = start[j] * DEG; }
    mj.mj_forward(model, d);
    datas.push(d);
    inst.push({ i, step: 0, stepStart: 0, done: false, startDeg: start, speedPct: +speedPct.toFixed(2),
      from: null, planS: 0,
      // ⛔ **구역위반과 접촉을 한 카운터에 섞지 않는다** (2026-08-18 · 실측으로 잡았다).
      // 섞여 있던 판에서 `violations` 열은 **접촉 수와 한 자리까지 같았고**(42·40·107·45),
      // 게이트 「여유 부호와 판정이 일치한다」가 여유 +75.7mm 인 행을 「위반 42」로 읽어 붉었다.
      // 그 상태에서는 **진짜 구역위반이 나도 접촉에 묻혀 안 보인다** — 그게 이 게이트가
      // 막으려던 바로 그 사고다 (`sim-batch.mjs` §①-b).
      zoneEvents: 0,          // 판정기가 낸 것 — `judgeWorkspace` 의 위반. 여유 부호와 대조되는 값
      contactEvents: 0,       // 물리가 낸 것 — 받침·작업물 같은 **구역 아닌 충돌체** 포함 (계약 §받침)
      nconPrev: 0,            // 직전 틱의 접촉 수. 같은 접촉을 매 틱 다시 세지 않으려는 것뿐이다
      worstClearMm: Infinity, cycleMs: null, timedOut: false,
      // 여유 시계열 — **분위수 밴드의 원천**이다. 인스턴스마다 선 하나를 긋는 대신
      // 시간 칸마다 분위수를 내려면 시계열이 있어야 한다 (계약 §화면).
      // 96 × 250 표본이라 메모리가 문제되지 않는다.
      clearSeries: [],
      // 손끝 궤적 — **점군 스윕 볼륨의 원천**(계약 §화면 점군 자리 ①).
      // 점마다 그때의 여유를 같이 실어 화면이 「구역에 붙은 점」을 빨갛게 칠할 수 있게 한다.
      tcpSeries: [],
      // 관절 자세 시계열 — **재생의 원천**. 점군과 같은 주기로 솎는다 (`SWEEP_EVERY`)
      qSeries: [],
      // 칸이 끝난 시각(ms) — **두 가지를 동시에 여는 값이다** (2026-08-12):
      //  ① 밴드의 진행률 축 — 계획 시간이 아니라 **실제로 걸린 시간**으로 나눠야 정렬이 참이다
      //  ② 「어느 칸이 느린가」 — 사이클 156초를 하나의 막대로 두면 손댈 곳을 못 고른다
      stepEndMs: [] });
  }

  const events = [];
  const push = (e) => { events.push(e); };

  // ── 한 틱에 전부 한 스텝. 인스턴스마다 자기 칸을 따로 진행한다 ───────────────
  let tick = 0;
  // 제일 느린 인스턴스가 다 돌 만큼 — 가장 큰 이동 × 느린 속도 × 칸 수 × 여유
  const worstS = (360 / (JOINT_DEG_S_AT_FULL * (SPEED_PCT[0] / 100)) + MOVE_FIXED_S);
  const maxTicks = Math.ceil((worstS * slot.steps.length * TIMEOUT_FACTOR) / dt);
  let alive = n;
  while (alive > 0 && tick < maxTicks) {
    for (let k = 0; k < n; k++) {
      const st = inst[k];
      if (st.done) continue;
      const d = datas[k];
      const stepDef = slot.steps[st.step];

      // 목표 세팅 — `move` 만 물리를 탄다. `grip` 은 **관절이 없어** 시뮬이 못 잰다:
      // 그리퍼는 2026-08-11 부터 충돌체로 장면에 있지만(`build-scene.mjs` §툴 충돌체)
      // 손가락이 prismatic 관절이 아니라 STL 자리에 고정이라 개폐가 물리를 안 탄다
      //
      // ⛔ **목표를 즉시 박지 않는다.** 실기는 계획된 속도로 관절을 끌고 가지 한 번에 튀지
      //    않는다. 즉시 박으면 사이클타임이 **PD 게인이 정하는 값**이 되어 실기와 무관해진다
      //    (2026-08-11 실측: 속도를 5~15% 로 흔들어도 사이클이 4.0초에 고정돼 있었다).
      //    계획 시간은 실기 회귀로 낸다 — `JOINT_DEG_S_AT_FULL` · `MOVE_FIXED_S`.
      if (stepDef.type === 'move') {
        const target = slot.points[stepDef.pointName];
        if (!target) die(`지점 "${stepDef.pointName}" 이 슬롯에 없다`);
        if (st.from === null) {
          st.from = Array.from({ length: nq }, (_, j) => d.qpos[j] / DEG);
          const dmax = Math.max(...target.slice(0, nq).map((v, j) => Math.abs(v - st.from[j])));
          st.planS = dmax / (JOINT_DEG_S_AT_FULL * (st.speedPct / 100)) + MOVE_FIXED_S;
        }
        const u = Math.min(1, ((tick - st.stepStart) * dt) / Math.max(1e-6, st.planS));
        const s = u * u * (3 - 2 * u);                 // smoothstep — 가감속 램프
        for (let j = 0; j < nq; j++) d.ctrl[j] = (st.from[j] + (target[j] - st.from[j]) * s) * DEG;
      }
      mj.mj_step(model, d);

      if (tick % JUDGE_EVERY === 0) {
        // 손끝 — site "tcp" 는 베이스 좌표계 m 이다. mm 로 바꾸고 user1 로 옮긴다.
        // **방향도 같이 넘긴다** — 툴 판정이 없으면 게이트가 손끝 한 점만 보고, 그때
        // 82mm 뻗은 카메라와 40mm 벌어진 집게가 통째로 안 보인다 (`judge.mjs` §툴 전체).
        // ⚠ 회전은 user1 로 안 옮긴다 — `coordDefs.user` 의 회전이 0.005° 라 위치 변환과
        //    같은 가정(평행이동만)을 쓴다. 유저 좌표계를 기울여 잡는 날 여기가 거짓이 된다.
        const sx = d.site_xpos;
        const m9 = d.site_xmat;
        const tcpMm = [sx[0] * 1000 - userT[0], sx[1] * 1000 - userT[1], sx[2] * 1000 - userT[2],
          ...eulerFixedXyzDeg(m9)];
        // 여유 — **위반 0 이어도 아슬아슬함은 여기서만 보인다** (계약 §화면 정렬 기준)
        const clear = clearanceMm(tcpMm, judgeWs);
        if (clear !== null) {
          if (clear < st.worstClearMm) st.worstClearMm = clear;
          st.clearSeries.push([Math.round(tick * dt * 1000), +clear.toFixed(3)]);
          // 점군은 **솎아서** 담는다 — 96개 × 250점이면 파일이 붓는다
          if (tick % (JUDGE_EVERY * SWEEP_EVERY) === 0) {
            st.tcpSeries.push([+tcpMm[0].toFixed(1), +tcpMm[1].toFixed(1), +tcpMm[2].toFixed(1),
              +clear.toFixed(1)]);
          }
        }
        // 재생 프레임 — 판정 주기의 1/4. 소수 둘이면 렌더에 충분하다(0.01° = 손끝 0.1mm 아래)
        if (tick % (JUDGE_EVERY * SWEEP_EVERY) === 0) {
          st.qSeries.push([Math.round(tick * dt * 1000),
            ...Array.from({ length: nq }, (_, j) => +(d.qpos[j] / DEG).toFixed(2))]);
        }
        // **관절각과 좌표계 정의도 넘긴다** — 안 넘기면 팔 판정이 매 틱 「원점을 모른다」로
        // 차단돼 위반 이벤트가 폭주한다 (2026-08-11 에 그랬다: 96개에 15만 건).
        const qDeg = Array.from({ length: nq }, (_, j) => d.qpos[j] / DEG);
        const bad = judgeWorkspace(tcpMm, judgeWs, fx.coord, qDeg, fx.coordDefs);
        for (const v of bad) {
          st.zoneEvents++;
          push({ instance: k, tMs: Math.round(tick * dt * 1000), kind: 'zoneViolation',
            detail: { rule: v.rule, zone: v.name, tcpMm: tcpMm.map((x) => +x.toFixed(1)) } });
        }
        const ncon = d.ncon;
        if (ncon > st.nconPrev) {
          push({ instance: k, tMs: Math.round(tick * dt * 1000), kind: 'contact',
            detail: { pairs: ncon } });
          st.contactEvents++;
        }
        st.nconPrev = ncon;
      }

      // 도착했나 — 목표에 들어왔고 거의 멈췄나
      if (stepDef.type === 'move') {
        const target = slot.points[stepDef.pointName];
        let arrived = true;
        for (let j = 0; j < nq; j++) {
          if (Math.abs(d.qpos[j] / DEG - target[j]) > SETTLE_DEG
            || Math.abs(d.qvel[j] / DEG) > SETTLE_DPS) { arrived = false; break; }
        }
        const limit = Math.max(TIMEOUT_FLOOR_S, st.planS * TIMEOUT_FACTOR);
        if (!arrived && (tick - st.stepStart) * dt < limit) continue;
        if (!arrived) st.timedOut = true;
      }
      // `grip` 은 즉시 넘어간다 (시뮬이 못 재는 칸 — summary 가 글자로 말한다)
      st.stepEndMs.push(Math.round(tick * dt * 1000));
      st.step++; st.stepStart = tick; st.from = null; st.planS = 0;
      if (st.step >= slot.steps.length) {
        st.done = true; alive--;
        st.cycleMs = Math.round(tick * dt * 1000);
        push({ instance: k, tMs: st.cycleMs, kind: 'cycleDone',
          detail: { timedOut: st.timedOut, violations: st.zoneEvents, contacts: st.contactEvents,
            minClearMm: Number.isFinite(st.worstClearMm) ? +st.worstClearMm.toFixed(3) : null } });
      }
    }
    tick++;
  }

  for (const d of datas) d.delete();      // ⛔ 빼먹으면 N 을 못 올린다
  model.delete();

  // ── 산출 세 개 ────────────────────────────────────────────────────────────
  const batchId = `${robotId}-slot${slotName}-n${n}-seed${seed}`;
  const dir = join(outDir, batchId);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'events.jsonl'),
    events.map((e) => JSON.stringify({ batchId, ...e })).join('\n') + (events.length ? '\n' : ''));

  // ⚠ **시작 자세를 여섯 관절 다 싣는다.** `startJ1Deg` 하나만 싣던 판에서 "지터가 아무것도
  // 안 가른다" 는 오판이 나왔다 — j1 의 설명력이 0.02 였을 뿐 **j2 는 0.74, j4 는 0.94** 였다.
  // 원본이 집계를 재현하지 못하면 그 오판을 다시 못 잡는다 (2026-08-11).
  const jcols = Array.from({ length: 6 }, (_, j) => `startJ${j + 1}Deg`).join(',');
  // 칸 소요시간은 **맨 뒤에 붙인다** — 앞에 끼우면 위치로 열을 읽는 곳이 조용히 밀린다
  // (2026-08-11 에 `speedPct` 를 3번 자리에 끼웠다가 게이트가 여유 부호를 `timedOut` 과
  //  대조하게 됐고, 둘 다 0 이라 **거짓 초록으로 통과했다**).
  const scols = slot.steps.map((sd, k) => `step${k}Ms_${sd.type}`).join(',');
  // `contacts` 도 **맨 뒤**다 — 바로 위 규칙 그대로. `violations` 옆에 끼우고 싶은 자리지만
  // 그 유혹이 2026-08-11 의 거짓 초록을 만들었다. 읽는 쪽은 전부 머리글로 찾는다
  const rows = [`instance,cycleMs,minClearMm,speedPct,timedOut,violations,${jcols},${scols},contacts`];
  for (const st of inst) {
    // ⚠ **소수 자리를 집계와 맞춘다.** 원본이 더 거칠면 `agg.json` 을 원본에서 재현할 수 없고,
    // 그때 화면 숫자와 표 숫자가 마지막 자리에서 갈린다 (2026-08-11 게이트가 잡았다).
    const clear = Number.isFinite(st.worstClearMm) ? st.worstClearMm.toFixed(3) : '';
    const durs = slot.steps.map((_, k) => (k < st.stepEndMs.length
      ? st.stepEndMs[k] - (k ? st.stepEndMs[k - 1] : 0) : ''));
    rows.push(`${st.i},${st.cycleMs ?? ''},${clear},${st.speedPct},${st.timedOut ? 1 : 0},${st.zoneEvents},`
      + st.startDeg.map((v) => v.toFixed(4)).join(',') + `,${durs.join(',')},${st.contactEvents}`);
  }
  writeFileSync(join(dir, 'summary.csv'), `${rows.join('\n')}\n`);

  const stamp = {
    batchId, robotId, slotName, n, seed,
    engineVersion: JSON.parse(readFileSync(join(ROOT, 'node_modules/@mujoco/mujoco/package.json'), 'utf-8')).version,
    timestepS: dt,
    fixtureFetchedAt: fx.fetchedAt,
    coord: fx.coord,
    // **판정에 쓴 구역과 좌표계 원점** — 조건이자 화면의 무대다. 여기 하나에만 둔다:
    // 산출 파일 두 곳에 같은 값을 실었더니 어느 쪽이 정본인지 알 수 없었다 (2026-08-12)
    workspace: judgeWs,
    coordDefs: { user: fx.coordDefs.user },
    // **누가 판정했나** — 장면이 같아도 판정이 바뀌면 다른 숫자가 나온다 (계약 §화면 · 2026-08-12).
    // 지문이 다른 회차는 나란히 놓지 않는다
    judge: judgeFingerprint(),
    jitter: { startJointDeg: [-2, 2], speedPct: SPEED_PCT },
    _속도: '시간 모델은 실기 회귀(JOINT_DEG_S_AT_FULL 28.9 · MOVE_FIXED_S 0.315)를 쓴다. '
      + '⚠ 시뮬 speedPct 가 실기 speedPct 와 같다는 증거는 아직 없다',
    // 게이트 값이 바뀐 뒤의 회차와 그 전의 회차를 섞지 않게 한다 (계약 §데이터)
    sceneBuiltFrom: `config.yaml:${robotId}.workspace(상자 ${ws.boxes.length}·벽 ${ws.walls.length})`,
    completed: inst.filter((s) => s.done && !s.timedOut).length,
    timedOut: inst.filter((s) => s.timedOut).length,
    events: events.length,
    // ⛔ **둘을 갈라 스탬프한다.** 합만 남기면 「무엇에 막혔나」를 회차 파일에서 못 읽는다 —
    // 받침·작업물은 구역이 아니라 충돌체라(계약 §받침) **접촉만 나고 위반은 0** 인 회차가 있다.
    // 2026-08-18 이 정확히 그랬다: 완주 0/8 인데 zoneViolations 0 · contacts 234
    zoneViolations: inst.reduce((a, s) => a + s.zoneEvents, 0),
    contacts: inst.reduce((a, s) => a + s.contactEvents, 0),
    _못재는것: 'grip 칸은 URDF 에 그리퍼가 없어 물리를 안 탄다 — cycleMs 에 그리퍼 시간이 빠져 있다',
    _아닌것: '실기 사이클타임이 아니다. 시뮬 숫자는 시뮬 숫자로만 인용한다 (불변식 5)',
  };
  writeFileSync(join(dir, 'batch.json'), `${JSON.stringify(stamp, null, 2)}\n`);

  // ── 사전 집계 — **브라우저가 매번 계산하면 96개이 안 돈다** (계약 §화면) ──────
  writeFileSync(join(dir, 'agg.json'),
    `${JSON.stringify(aggregate(inst, events, batchId, slot.steps), null, 2)}\n`);
  // 점군은 **따로** 둔다 — 1층만 볼 때까지 6천점을 받게 하지 않는다 (3층에서만 필요)
  writeFileSync(join(dir, 'sweep.json'), `${JSON.stringify(sweep(inst, batchId))}\n`);
  // 재생 프레임도 **따로** 둔다 — 1층만 볼 때까지 받게 하지 않는다 (3층 모달에서만 필요)
  writeFileSync(join(dir, 'frames.json'),
    `${JSON.stringify(frames(inst, batchId, slot.steps.length, nq))}\n`);
  return { dir, stamp, events, inst };
}

// ── 사전 집계 ───────────────────────────────────────────────────────────────
// ⛔ **분산을 부풀리지 않는다** (계약 §화면). 여기서 내는 것은 데이터 그대로의 분위수이고,
//    납작하면 납작하게 나온다. 보기 좋게 만드는 일은 화면에서도 하지 않는다.
// 시간 칸 — **폭이 아니라 개수를 고정한다.** 폭을 고정하면 사이클이 길어질 때 칸이 같이
// 늘어 `agg.json` 이 붓고 화면이 그만큼의 DOM 을 만든다 (2026-08-11: 사이클이 4초에서
// 156초가 되자 칸이 41 → 1,562 가 됐다).
const TARGET_BINS = 120;
const MIN_BIN_MS = 20;
const binWidthMs = (maxMs) => Math.max(MIN_BIN_MS, Math.ceil(maxMs / TARGET_BINS / 10) * 10);
const EVENT_KINDS = ['contact', 'zoneViolation', 'jointLimit', 'cycleDone', 'damage'];
// 밴드의 가로 격자 — 0%, 1%, …, 100%
const PROGRESS_POINTS = 101;

/** 정렬된 배열에서 선형보간 분위수. 표본이 1개면 그 값. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round3 = (v) => (v === null ? null : +v.toFixed(3));

/** 값 배열 → 다섯 분위수 + 최소·최대·개수. 밴드는 p05~p95(90%) · p25~p75(50%) · p50(중앙값). */
function spread(values) {
  const s = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return { n: s.length, min: round3(s[0]), max: round3(s[s.length - 1]),
    p05: round3(quantile(s, 0.05)), p25: round3(quantile(s, 0.25)), p50: round3(quantile(s, 0.5)),
    p75: round3(quantile(s, 0.75)), p95: round3(quantile(s, 0.95)) };
}

/** 두 열의 피어슨 상관. 분모가 0(=한 값뿐)이면 `null` — 「상관 0」과 다르다. */
function corr(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  const den = Math.sqrt(da * db);
  return den > 0 ? +(num / den).toFixed(3) : null;
}

/**
 * 조건 축 — **무엇을 흔들었고, 그게 결과를 가르나.**
 *
 * ⛔ **가짜 격자를 만들지 않는다.** 셀을 넷으로 쪼갰는데 넷이 같은 값이면 그건 드릴다운이
 *    아니라 착시다. 대신 축마다 **폭과 설명력(|상관|)** 을 내서 화면이 「이 축은 결과를
 *    안 가른다」고 말하게 한다 — 그게 다음에 무엇을 흔들지도 같이 알려 준다.
 *
 * 2026-08-11 실측: 시작 자세 지터(j1 폭 3.95°)의 설명력이 여유에 **0.02** 였다. 모든 인스턴스가
 * **같은 관절 목표**로 가므로 경로가 수렴한다 — 시작만 흔들면 과도구간만 다르고 최소여유는
 * **프로그램의 성질**이지 지터의 성질이 아니다. 경로를 바꾸는 축(속도·하중)이라야 갈린다.
 */
// **사람이 손댈 수 있는 축과 못 바꾸는 축을 가른다** (2026-08-12).
// 이 구분이 없으면 화면이 1등으로 가리키는 축이 「반복 오차」일 때도 사람이 그걸 고치려 든다.
// `startJointDeg` 는 매 회차 자세가 조금씩 다른 **현상**이지 우리가 고르는 값이 아니다.
const CONTROLLABLE = new Set(['speedPct', 'payloadKg', 'objectXyMm']);

/**
 * 효과 크기 — **상관만으로는 결정을 못 한다.** 2026-08-12 실측: `speedPct` 의 여유 설명력이
 * 0.971 이었는데 여유 폭 전체가 **0.06mm** 였다. 상관은 「같이 움직이나」고, 결정에 필요한
 * 것은 「얼마나 움직이나」다. 축 위아래 절반의 중앙값 차로 낸다(이상치에 안 흔들린다).
 */
function effectOf(done, pick) {
  const sorted = [...done].sort((a, b) => pick(a) - pick(b));
  const h = Math.floor(sorted.length / 2);
  if (h < 2) return { dCycleMs: null, dClearMm: null };
  const lo = sorted.slice(0, h);
  const hi = sorted.slice(sorted.length - h);
  const med = (rows, f) => spread(rows.map(f))?.p50 ?? null;
  const d = (f) => {
    const a = med(lo, f); const b = med(hi, f);
    return a === null || b === null ? null : +(b - a).toFixed(3);
  };
  return { dCycleMs: d((s) => s.cycleMs), dClearMm: d((s) => s.worstClearMm) };
}

/**
 * **완주한 벌** — `cycleMs` 가 있는 것이 아니라 `timedOut` 이 아닌 것이다 (2026-08-19 고침).
 *
 * 러너는 칸에서 시간이 초과돼도 **다음 칸으로 밀어** 끝까지 행진시키므로 `st.cycleMs` 는
 * **언제나** 채워진다(`:247`). 그래서 「`cycleMs` 가 없으면 미완주」라는 옛 가정은 한 번도
 * 참이 아니었고, 8/8 시간초과 회차가 사이클 중앙값 **56.3초**를 내면서 `cycleMsMissing: 0`
 * 을 나란히 실었다 (실측 2026-08-19). 그 값은 일한 시간이 아니라 **막힌 채 흘려보낸 시간**이다.
 *
 * ⛔ **사이클 통계는 완주한 벌만으로 낸다.** 여유·접촉은 반대다 — 막혀 있어도 물리가 실제로
 *    잰 값이라 전부 쓴다. 「못 끝냈다」와 「안 쟀다」는 다른 말이다.
 */
const finished = (s) => s.done && !s.timedOut && Number.isFinite(s.cycleMs);

function conditionAxes(inst) {
  // ⛔ **여유와 사이클은 표본이 다르다** (2026-08-19).
  //   여유·접촉은 팔이 막혀 있어도 물리가 **실제로 잰 값**이라 전부 쓴다. 사이클은 완주한
  //   벌만 — 시간초과 벌의 시간은 일한 시간이 아니라 막힌 채 흘려보낸 시간이다.
  //   ⚠ 둘을 같은 표본으로 묶으면 **완주 0 인 회차에서 조건 축 표가 통째로 비어**
  //   「무엇을 흔들었나」조차 화면에서 사라진다 (실측 2026-08-19 · dash-render 가 잡았다).
  const all = inst.filter((s) => Number.isFinite(s.worstClearMm));
  const done = all.filter(finished);
  const clr = all.map((s) => s.worstClearMm);
  const cyc = done.map((s) => s.cycleMs);
  const axes = [];
  const addAxis = (key, unit, digits, pick, controllable) => {
    const v = all.map(pick);
    const span = Math.max(...v) - Math.min(...v);
    if (!(span > 0)) return;
    axes.push({ key, unit, spanned: +span.toFixed(digits),
      explainsClearance: corr(v, clr),
      explainsCycle: done.length > 1 ? corr(done.map(pick), cyc) : null,
      controllable,
      dClearMm: effectOf(all, pick).dClearMm,
      dCycleMs: done.length ? effectOf(done, pick).dCycleMs : null });
  };
  // 지금 흔드는 축은 시작 자세뿐이다. 관절마다 따로 본다 — 어느 관절이 미는지가 다르다
  for (let j = 0; j < (inst[0]?.startDeg?.length ?? 0); j++) {
    addAxis(`startJointDeg[${j}]`, '°', 3, ((k) => (s) => s.startDeg[k])(j), false);
  }
  addAxis('speedPct', '%', 2, (s) => s.speedPct, true);
  // **아직 없는 축도 이름으로 남긴다** — 계약 §증식이 정한 것들이다. 화면이 「무엇을 더
  // 흔들 수 있나」를 보여줄 수 있고, 붙는 날 이 표가 그대로 격자가 된다
  for (const key of ['payloadKg', 'objectXyMm']) {
    axes.push({ key, unit: null, spanned: 0, explainsClearance: null, explainsCycle: null,
      controllable: CONTROLLABLE.has(key), dCycleMs: null, dClearMm: null });
  }
  const scored = axes.filter((a) => a.explainsClearance !== null)
    .sort((x, y) => Math.abs(y.explainsClearance) - Math.abs(x.explainsClearance));
  const top = scored[0];
  const best = top ? Math.abs(top.explainsClearance) : 0;
  // 격자를 만들 수 있나 — **설명력이 이 선 아래면 셀을 나눠도 넷이 같다**
  const gridReady = best >= 0.3;

  // 셀은 **설명력이 가장 큰 축 하나**로만 4분위를 낸다. 아무 축이나 나누면 착시다.
  let cells = [];
  if (gridReady) {
    const pick = top.key === 'speedPct'
      ? (s) => s.speedPct
      : ((j) => (s) => s.startDeg[j])(Number(top.key.match(/\[(\d)\]/)?.[1] ?? 0));
    const v = all.map(pick).sort((a, b) => a - b);
    const cut = [0.25, 0.5, 0.75].map((q) => v[Math.floor((v.length - 1) * q)]);
    const buckets = [[], [], [], []];
    for (const s of all) buckets[cut.filter((c) => pick(s) > c).length].push(s);
    cells = buckets.map((bs, i) => {
      // 칸 안에서도 사이클만 완주한 벌로 좁힌다 — 여유는 칸의 벌 전부가 낸 값이다
      const bsDone = bs.filter(finished);
      return {
        cell: i,
        range: [i === 0 ? v[0] : cut[i - 1], i === 3 ? v[v.length - 1] : cut[i]].map((x) => +x.toFixed(2)),
        n: bs.length,
        nDone: bsDone.length,
        minClearMm: bs.length ? +Math.min(...bs.map((s) => s.worstClearMm)).toFixed(3) : null,
        medClearMm: bs.length ? +spread(bs.map((s) => s.worstClearMm)).p50.toFixed(3) : null,
        medCycleMs: bsDone.length ? spread(bsDone.map((s) => s.cycleMs)).p50 : null,
        instances: bs.map((s) => s.i),
      };
    });
  }
  return { axes, bestExplains: +best.toFixed(3), gridReady,
    gridAxis: gridReady ? top.key : null, cells };
}

/**
 * 여유 분위수 밴드 — **가로축이 벽시계가 아니라 진행률이다** (계약 §화면 · 2026-08-12).
 *
 * 왜 바꿨나 — 속도를 5~15% 로 흔들면 사이클이 54s~156s 로 갈린다. 그 상태로 벽시계에 묶으면
 * 같은 칸에 **「막 출발한 것(420mm)」과 「가장 붙은 것(14mm)」이 함께** 들어간다.
 * 2026-08-12 실측: 칸별 90% 밴드 폭 중앙값이 **379.4mm** 였다 — 그건 분포가 아니라 진행 차이다.
 *
 * ⚠ **진행률은 계획 시간이 아니라 실제 칸 소요시간으로 낸다.** 계획대로 안 끝난 칸이 있고
 *   (도착 판정은 `SETTLE_DEG`·`SETTLE_DPS` 가 정한다), 계획으로 나누면 그 차이가 사라진다.
 * ⚠ **인스턴스마다 격자에 한 점씩 리샘플한다.** 진행률로 그냥 묶으면 느린 것이 표본을 더 내서
 *   밴드가 느린 쪽으로 기운다 — 칸의 `n` 이 개수와 같아야 「96개의 분포」라 말할 수 있다.
 */
/**
 * 시계열 각 표본의 진행률(0~1). **계획이 아니라 실제 칸 소요시간**으로 나눈다.
 * 밴드와 재생 프레임이 **같은 자를 쓴다** — 갈라지면 스크러버와 차트가 어긋난다.
 */
function progressOf(series, ends, nSteps) {
  const out = [];
  let k = 0;
  for (const s of series) {
    const tMs = s[0];
    while (k < nSteps - 1 && tMs >= ends[k]) k += 1;
    const s0 = k ? ends[k - 1] : 0;
    const span = ends[k] - s0;
    out.push((k + (span > 0 ? Math.min(1, (tMs - s0) / span) : 0)) / nSteps);
  }
  return out;
}

/** 진행률 격자마다 가장 가까운 표본의 색인. 둘 다 오름차순이라 포인터 하나로 훑는다. */
function resampleByProgress(prog, points) {
  const idx = [];
  let p = 0;
  for (let g = 0; g < points; g += 1) {
    const want = g / (points - 1);
    while (p + 1 < prog.length && Math.abs(prog[p + 1] - want) <= Math.abs(prog[p] - want)) p += 1;
    idx.push(p);
  }
  return idx;
}

/** 그 인스턴스가 진행률 축에 올라갈 수 있나 — 칸을 다 끝냈고 표본이 있나. */
const replayable = (st, nSteps, key) => st.stepEndMs.length >= nSteps && st[key].length > 0;

function progressBand(inst, nSteps) {
  const cols = Array.from({ length: PROGRESS_POINTS }, () => []);
  const tcols = Array.from({ length: PROGRESS_POINTS }, () => []);
  let excluded = 0;
  for (const st of inst) {
    // 칸을 다 못 끝낸 것은 진행률 100% 가 없다 — **끼워 넣지 않고 센다**
    if (!replayable(st, nSteps, 'clearSeries')) { excluded += 1; continue; }
    const prog = progressOf(st.clearSeries, st.stepEndMs, nSteps);
    resampleByProgress(prog, PROGRESS_POINTS).forEach((p, g) => {
      cols[g].push(st.clearSeries[p][1]);
      tcols[g].push(st.clearSeries[p][0]);
    });
  }
  const band = { pct: [], tMs: [], p05: [], p25: [], p50: [], p75: [], p95: [], n: [], excluded,
    worstPct: null, worstMm: null };
  for (let g = 0; g < PROGRESS_POINTS; g += 1) {
    const s = spread(cols[g]);
    if (!s) continue;
    band.pct.push(+((100 * g) / (PROGRESS_POINTS - 1)).toFixed(1));
    // 축을 바꿔도 **시간을 잃지 않는다** — 이 진행률에서 벽시계 중앙값이 몇 초였나
    band.tMs.push(Math.round(spread(tcols[g]).p50));
    for (const key of ['p05', 'p25', 'p50', 'p75', 'p95']) band[key].push(s[key]);
    band.n.push(s.n);
  }
  // 가장 붙는 지점 — KPI 한 칸이 이 값을 쓴다 (화면이 다시 훑지 않게)
  for (let i = 0; i < band.p05.length; i += 1) {
    if (band.worstMm === null || band.p05[i] < band.worstMm) {
      band.worstMm = band.p05[i]; band.worstPct = band.pct[i];
    }
  }
  return band;
}

/**
 * 칸별 소요시간 — **사이클 156초를 막대 하나로 두면 손댈 곳을 못 고른다** (2026-08-12 신설).
 * 「속도를 올려라」가 아니라 「**어느 칸의** 속도를 올려라」가 되게 하는 값이다.
 */
function stepSpreads(inst, steps) {
  return steps.map((sd, k) => {
    const v = inst.filter((s) => s.stepEndMs.length > k)
      .map((s) => s.stepEndMs[k] - (k ? s.stepEndMs[k - 1] : 0));
    return { index: k, type: sd.type, pointName: sd.pointName ?? null, n: v.length, ms: spread(v) };
  });
}

/**
 * 0층 결정 — **차트 넷보다 이 한 줄이 세다** (2026-08-12 신설 · 계약 §화면).
 *
 * 여기서 하는 일은 「무엇이 상관이 큰가」가 아니라 **「무엇을 바꾸면 무엇이 얼마나 바뀌나」** 다.
 * 그래서 상관과 **효과 크기를 반드시 같이** 낸다 — 실측에서 `speedPct` 의 여유 설명력이
 * 0.971 이었는데 그 축이 바꾸는 여유는 **0.04mm** 였다. 상관만 굵게 쓰면 그 축을 손보러 간다.
 *
 * ⛔ **결정을 지어내지 않는다.** 흔든 축으로 못 고치는 상태면 그렇게 말하고 끝낸다 —
 *    그게 「막혔다」를 숨기지 않는 유일한 방법이다.
 */
function verdict(axes, clearSpread, cycleSpread, n, timedOut = 0, stallWhy = null) {
  // 지렛대는 **사이클**을 낸 축에서 고르고, 여유 폭은 **여유**를 낸 축에서 낸다 —
  // 완주가 0 이라 사이클이 없어도 여유 폭은 그대로 살아 있다 (2026-08-19).
  const scored = axes.filter((a) => a.dCycleMs !== null && a.dCycleMs !== undefined);
  const scoredClear = axes.filter((a) => a.dClearMm !== null && a.dClearMm !== undefined);
  const usable = scored.filter((a) => a.controllable)
    .sort((x, y) => Math.abs(y.dCycleMs) - Math.abs(x.dCycleMs));
  const lever = usable[0] ?? null;
  // 흔든 축 **전체**가 여유에 주는 폭 — 이게 작으면 안전은 이 축들로 못 움직인다
  let clearReach = 0;
  for (const a of scoredClear) clearReach = Math.max(clearReach, Math.abs(a.dClearMm ?? 0));

  const allInside = clearSpread && clearSpread.max < 0;
  const notShaken = axes.filter((a) => a.controllable && !a.spanned).map((a) => a.key);
  const sign = (v, unit, d = 1) => `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}${unit}`;
  // ⛔ **변수 이름을 화면에 그대로 내지 않는다** (2026-08-13 · 토스 §Casual Concept).
  //    0층 결정에 `speedPct` 가 떠 있었고, 그건 우리만 읽는 말이다. 모르는 축은 원래 이름을
  //    그대로 준다 — 축은 자유 문자열이라 표를 못 채우는 경우가 정상이다.
  const AXIS_KO = { speedPct: '속도', payloadKg: '들고 있는 무게', objectXyMm: '물체 자리' };
  const axisKo = (k) => AXIS_KO[k] ?? k.replace(/^startJointDeg\[(\d)\]$/, (_, j) => `시작 각도 ${Number(j) + 1}번 축`);

  // **값이 먼저, 문장은 짧게.** 화면 1층은 값과 이름만 놓는다 — 왜 그렇게 그렸는지는
  // 모달 안에서 말한다 (2026-08-12 실측: 화면 문구가 1,233자였고 대부분이 설계 변호였다)
  let headline;
  let detail;
  if (timedOut > 0) {
    // ⛔ 완주 못 한 판을 낙관 문구로 덮지 않는다 — 실측 2026-08-13(감사): 8/8 전량
    // 시간초과 배치가 「속도 +9.5% → 한 개에 −23.4초」로 나갔다. 시간초과가 하나라도
    // 있으면 그 사실이 0층이고, 전멸이면 아래 분포값은 근거 자격이 없다.
    headline = `${timedOut}/${n}대가 시간 안에 못 끝냈어요`;
    // ⛔ **「왜 못 끝냈나」를 화면도 가른다** — 게이트만 가르면 화면을 보는 사람은
    //    「안 돌았다」까지만 알고 무엇을 고쳐야 하는지를 모른다 (계약 §데이터).
    detail = timedOut === n
      ? `전부 미완주 — 다른 수치는 근거가 아니에요${stallWhy ? ` · ${stallWhy}` : ''}`
      : `완주한 ${n - timedOut}대만으로 잰 값이에요${stallWhy ? ` · 나머지는 ${stallWhy}` : ''}`;
  } else if (allInside) {
    headline = `${n}대 전부 구역을 파고들어요 · ${Math.abs(clearSpread.p50).toFixed(1)}mm`;
    detail = `조절할 수 있는 축을 끝까지 흔들어도 ${clearReach.toFixed(2)}mm`;
  } else if (lever) {
    headline = `${axisKo(lever.key)} ${sign(lever.spanned, lever.unit ?? '', 1).replace('−', '+')}`
      + ` → 한 개에 ${sign(lever.dCycleMs / 1000, '초')}`;
    detail = `벽까지 거리는 ${sign(lever.dClearMm, 'mm', 2)}`;
  } else {
    headline = `갈리는 축이 없어요`;
    detail = `흔든 축이 결과를 안 바꿔요`;
  }
  return {
    headline,
    detail,
    timedOut,
    blocked: Boolean(allInside) || (n > 0 && timedOut === n),
    lever: lever && { key: lever.key, dCycleMs: lever.dCycleMs, dClearMm: lever.dClearMm,
      explainsCycle: lever.explainsCycle, spanned: lever.spanned, unit: lever.unit },
    clearReachMm: +clearReach.toFixed(3),
    fixedAxes: scoredClear.filter((a) => !a.controllable).length,
    nextExperiment: notShaken.length ? notShaken.join(' · ') : null,
    _아닌것: '상관이 크다고 중요한 게 아니다 — 효과 크기(dClearMm·dCycleMs)를 같이 본다',
  };
}

export function aggregate(inst, events, batchId, steps = []) {
  const maxMs = Math.max(0, ...inst.map((s) => s.cycleMs ?? 0));
  const BIN_MS = binWidthMs(maxMs);
  const band = progressBand(inst, steps.length);

  // 이벤트 밀도 띠 — 종류 × 시간 칸 개수. **여기는 벽시계가 맞다** (사건은 시각에 난다).
  // 밴드가 진행률로 간 뒤로 축을 공유하지 않으므로 자기 시간축을 따로 든다.
  // **안 난 종류도 0 으로 남긴다** — 행이 사라지면 「없다」와 「안 쟀다」가 화면에서 같아 보인다
  const nBins = Math.max(1, Math.floor(maxMs / BIN_MS) + 1);
  const density = { kinds: EVENT_KINDS, binMs: BIN_MS,
    tMs: Array.from({ length: nBins }, (_, i) => i * BIN_MS),
    counts: EVENT_KINDS.map(() => new Array(nBins).fill(0)) };
  for (const e of events) {
    const ki = EVENT_KINDS.indexOf(e.kind);
    const bi = Math.min(nBins - 1, Math.floor(e.tMs / BIN_MS));
    if (ki >= 0) density.counts[ki][bi] += 1;
  }

  // 정렬된 표 — **최소여유 오름차순** (계약 §화면). 위 10행만 미리 굽는다
  const worst = inst
    .filter((s) => Number.isFinite(s.worstClearMm))
    .sort((a, b) => a.worstClearMm - b.worstClearMm)
    .slice(0, 10)
    .map((s) => ({ instance: s.i, minClearMm: round3(s.worstClearMm), cycleMs: s.cycleMs,
      // ⚠ 시간초과한 벌의 `cycleMs` 는 **사이클이 아니라 막힌 채 흘려보낸 시간**이다.
      //   같은 칸에 적히므로 화면이 그것을 표시할 수 있게 기준을 같이 싣는다.
      timedOut: Boolean(s.timedOut),
      violations: s.zoneEvents, contacts: s.contactEvents, startJ1Deg: round3(s.startDeg[0]) }));

  // ⚠ **빠진 표본을 조용히 두지 않는다.** 완주 못 한 벌은 분위수에서 빼고 그 수를 적는다 —
  // 안 적으면 화면이 「96개 중앙값」이라 말하면서 실제로는 93개를 쓴다.
  // ⛔ **미완주 판정을 `cycleMs` 유무로 하지 않는다** — 위 `finished` 주석.
  const notDone = inst.filter((s) => !finished(s)).length;
  const conditions = conditionAxes(inst);
  const cycleMs = spread(inst.filter(finished).map((s) => s.cycleMs));

  // ⛔ **막히는 길이 둘이고 화면이 그것을 글자로 가른다** (계약 §데이터 · 2026-08-19).
  //  ① 구역이 손끝 자리를 덮었다 — 여유 음수. 판정기가 말해 준다
  //  ② 구역이 **아닌** 충돌체에 막혔다 — 받침·작업물은 충돌체지 구역이 아니라(계약 §받침)
  //     여유는 양수인 채 접촉만 난다
  // ⚠ **벌마다 따로 센다** — 배치 최소값 하나로 갈래를 고르면 한 벌이 스치는 순간 전체가
  //   ① 로 읽힌다 (실측 2026-08-19: 8벌 중 1벌만 −1.10mm 였고 나머지 7벌은 +50~76mm · 위반 0).
  const stalledInst = inst.filter((s) => s.timedOut);
  const byZone = stalledInst.filter((s) => s.worstClearMm < 0).length;
  const stallWhy = !stalledInst.length ? null
    : byZone === stalledInst.length ? '구역이 손끝 자리를 덮었어요'
      : byZone === 0 ? '구역이 아니라 받침·작업물에 막혔어요'
        : `구역에 눌린 ${byZone}대 · 물건에 막힌 ${stalledInst.length - byZone}대`;
  const minClearMm = spread(inst.map((s) => s.worstClearMm));
  return { batchId, binMs: BIN_MS, n: inst.length, cycleMsMissing: notDone,
    // **0층이 먼저다** — 차트를 다 보고도 뭘 바꿀지 모르면 그 화면은 근거가 아니다
    verdict: verdict(conditions.axes, minClearMm, cycleMs, inst.length,
      stalledInst.length, stallWhy),
    conditions,
    cycleMs,
    minClearMm,
    steps: stepSpreads(inst, steps),
    clearanceBand: band, eventDensity: density, worst,
    _가로축: '밴드는 진행률(%) 이다 — 벽시계로 묶으면 진행 차이가 분산으로 보인다 (계약 §화면)',
    _아닌것: '분산을 부풀리지 않았다 — 납작하면 납작한 것이 데이터다 (계약 §화면)' };
}


/**
 * 점군 스윕 볼륨 — 96개 손끝을 점으로 (계약 §화면 점군 자리 ①).
 * `p` 는 평평한 배열 `[x,y,z,clear, x,y,z,clear, …]` 다 — 객체 6천 개보다 파일이 작고
 * 화면이 `Float32Array` 로 바로 올린다(내장 재질만 · 크기 3버킷 · D109).
 */
/**
 * 재생 프레임 — **3층 모달이 로봇을 실제로 움직이는 데 쓴다** (2026-08-12 신설).
 *
 * 화면은 `Shared/view3d` 의 `setJointsDeg` 로 그린다 — **새로 짜지 않는다**(계약 §폴더).
 * 프레임 번호가 곧 진행률이라 스크러버 하나가 3D 와 여유 밴드를 같이 움직인다.
 *
 * ⚠ **관절각이다. 손끝이 아니다.** 손끝은 여기서 다시 안 싣는다 — 같은 값을 두 군데 두면
 *   어느 쪽이 정본인지 다음 사람이 못 고른다 (`sweep.json` 이 손끝의 정본이다).
 */
export function frames(inst, batchId, nSteps, jointCount) {
  const list = [];
  const skipped = [];
  for (const st of inst) {
    if (!replayable(st, nSteps, 'qSeries')) { skipped.push(st.i); continue; }
    const prog = progressOf(st.qSeries, st.stepEndMs, nSteps);
    const deg = [];
    for (const p of resampleByProgress(prog, FRAMES_PER_INSTANCE)) {
      for (let j = 1; j <= jointCount; j += 1) deg.push(st.qSeries[p][j]);
    }
    list.push({ i: st.i, cycleMs: st.cycleMs, deg });
  }
  return { batchId, jointCount, framesPerInstance: FRAMES_PER_INSTANCE, instances: list,
    skipped,
    _단위: '도(°) · 순서는 instance → frame → joint. 프레임 번호 / (framesPerInstance-1) = 진행률',
    _아닌것: '실기 관절값이 아니다 — 시뮬 관절값이다 (불변식 5)' };
}

export function sweep(inst, batchId) {
  const p = [];
  const owner = [];
  // ⚠ **인스턴스마다 점 개수를 고정한다.** 시간 간격으로 솎으면 느린 인스턴스가 점을 더 내서
  // 점군이 「느린 쪽에 치우친다」 — 게다가 사이클이 40배가 되면 파일도 40배다.
  // 2026-08-11: 속도 지터를 넣자 6천점이 23만점이 되며 `Math.min(...)` 이 스택을 넘겼다.
  for (const st of inst) {
    const src = st.tcpSeries;
    if (!src.length) continue;
    const take = Math.min(src.length, PER_INSTANCE_POINTS);
    for (let k = 0; k < take; k += 1) {
      const q = src[Math.floor((k * (src.length - 1)) / Math.max(1, take - 1))];
      p.push(q[0], q[1], q[2], q[3]); owner.push(st.i);
    }
  }
  // **스프레드로 min/max 를 내지 않는다** — 인자 개수 상한에 걸려 죽는다
  let clearMin = Infinity; let clearMax = -Infinity;
  for (let i = 3; i < p.length; i += 4) {
    if (p[i] < clearMin) clearMin = p[i];
    if (p[i] > clearMax) clearMax = p[i];
  }
  // ⛔ **무대를 여기 싣지 않는다** — 구역은 `batch.json` 의 `workspace` 하나가 정본이다.
  //    2026-08-12 에 둘 다 실었더니 어느 쪽이 정본인지 알 수 없었다.
  return { batchId, stride: 4, count: owner.length, p, owner,
    clearMin: Number.isFinite(clearMin) ? clearMin : null,
    clearMax: Number.isFinite(clearMax) ? clearMax : null,
    _단위: 'x·y·z 는 workspace.frame(user1) 밀리미터 · 넷째는 그 순간의 여유(mm)',
    _아닌것: '실기 궤적이 아니다 — 시뮬 손끝이다 (불변식 5)' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dir, stamp } = await runBatch();
  console.log(`배치 완주  ${stamp.batchId}`);
  console.log(`  완주 ${stamp.completed}/${stamp.n} · 시간초과 ${stamp.timedOut}`
    + ` · 구역위반 ${stamp.zoneViolations} · 접촉 ${stamp.contacts}`);
  console.log(`  ${dir.replace(`${ROOT}/`, '')}/  (events.jsonl · summary.csv · batch.json)`);
}
