// 배치 게이트 — **96벌이 완주하고, 검출기가 진짜로 잡나.**
//
// 실행: `node scripts/check/sim-batch.mjs`
//
// 「이벤트 0건」은 **깨끗하다는 뜻일 수도, 아무것도 안 재고 있다는 뜻일 수도** 있다.
// 2026-08-11 의 첫 96벌이 정확히 그 모양이었다(전부 `cycleDone` 뿐). 그래서 이 게이트는
// 완주만 보지 않고 **결함을 주입해 빨간불이 켜지는 것까지** 본다 (D97 · `SAFETY-RULES` 제1원칙).
//
// ⚠ **`Sim/out` 아래 게이트 전용 폴더에만 쓴다** — 사람이 돌린 배치 결과를 덮지 않는다.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runBatch } from '../../Sim/runner/batch.mjs';
import { readWorkspace } from '../../Sim/scene/build-scene.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'Sim/out/_gate');
const ROBOT = 'fr5-lab-a';
const N = 8;                     // 게이트는 작게 — 96벌 실측은 사람이 돌리고 evidence 에 남긴다
const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok, name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
// **「못 쟀다」는 PASS 도 FAIL 도 아니다.** 초록으로 세면 안 잰 것이 잰 것처럼 보이고,
// 빨강으로 세면 같은 뿌리(완주 0)가 두 줄로 불어 어느 것이 원인인지 흐려진다.
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`);

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

// ── ① 완주하고 세 파일이 나온다 ───────────────────────────────────────────
const a = await runBatch({ n: N, seed: 1, out: OUT });
const files = ['events.jsonl', 'summary.csv', 'batch.json', 'agg.json'];
const missing = files.filter((f) => !existsSync(join(a.dir, f)));
// ⚠ **「완주 0」을 러너 고장으로 읽지 않는다.** 승인된 프로그램이 실물 변화(상판 높이 등)로
// 더는 실행 불가능해지면 팔이 구역에 눌려 멈춘다 — 그건 시뮬이 **일을 한 것**이다.
// 2026-08-12: 상판이 58.7mm 올라가자 08-11 에 가르친 집는 지점이 상판 속 57.9mm 가 됐다.
// ⚠ **막히는 길이 둘이다** (2026-08-18 에 둘째를 실측으로 잡았다).
//  ① 구역이 손끝 자리를 덮는다 — 최소여유가 음수. 판정기가 말해 준다
//  ② 구역이 **아닌** 충돌체에 막힌다 — 받침·작업물은 충돌체지 구역이 아니라(계약 §받침)
//     팔이 거기 처박혀 멈춰도 **여유는 양수고 위반은 0** 이다. 그날 여유 +75.7mm · 위반 0 ·
//     접촉 234 였고, ① 만 보던 이 검사는 진단 없이 「완주 0/8」만 뱉었다
// ⛔ **갈래를 배치 최소값 하나로 고르지 않는다 — 벌마다 센다** (2026-08-19 고침).
//   실측: 8벌 중 **1벌만** −1.10mm(위반 2580)였고 나머지 **7벌은 +50~76mm · 위반 0 · 접촉만**
//   이었다. 그런데 `Math.min` 이 그 한 벌을 집어 8벌 전체를 ① 로 읽었다 — 어제 ①②를 가르려고
//   넣은 코드가 정확히 그 자리에서 다시 뭉갰다. **7벌의 원인(받침)이 화면에서 사라진다.**
const minClear = Math.min(...a.inst.map((s) => s.worstClearMm));
const stalled = a.stamp.completed === 0 && a.stamp.timedOut === N;
const stuck = a.inst.filter((s) => s.timedOut);
const zoneStuck = stuck.filter((s) => s.worstClearMm < 0);
const propStuck = stuck.filter((s) => s.worstClearMm >= 0);
const part = [];
if (zoneStuck.length) {
  part.push(`**구역**이 손끝 자리를 덮은 ${zoneStuck.length}벌`
    + ` (최소여유 ${Math.min(...zoneStuck.map((s) => s.worstClearMm)).toFixed(1)}mm)`);
}
if (propStuck.length) {
  part.push(`구역이 아닌 **충돌체**에 막힌 ${propStuck.length}벌`
    + ` (여유 +${Math.min(...propStuck.map((s) => s.worstClearMm)).toFixed(1)}mm 인데`
    + ` 접촉 ${propStuck.reduce((t, s) => t + s.contactEvents, 0)}건 — 받침·작업물이 길을 막는다,`
    + ` 계약 §받침)`);
}
const why = part.join(' · ');
check(`${N}개 완주 · 세 파일`, a.stamp.completed === N && missing.length === 0,
  missing.length ? `없는 파일: ${missing.join(' ')}`
    : (stalled
      ? `완주 0/${N} — 러너가 아니라 **프로그램**이 막혔다. ${why}.`
        + ` 실물이 바뀌었으면 지점을 다시 가르치고 픽스처를 다시 굽는다:`
        + ` node scripts/dev/sim-fixture.mjs`
      : `완주 ${a.stamp.completed}/${N}`));

const csv = readFileSync(join(a.dir, 'summary.csv'), 'utf-8').trim().split('\n');
check(`summary.csv 가 ${N}행 (+머리글)`, csv.length === N + 1, `실제 ${csv.length - 1}행`);

// ── ①-b 여유가 실제로 나오고, 판정과 부호가 맞나 ─────────────────────────
// **「위반 0」은 여유 1mm 와 여유 500mm 를 구분하지 못한다.** 그래서 여유를 따로 낸다
// (계약 §화면의 정렬 기준이자 이상치 승격 기준). 그리고 **판정과 어긋나면 둘 중 하나가 틀렸다** —
// 여유가 음수(침범)인데 위반이 0이면 판정이 못 잡은 것이고, 반대면 여유 계산이 틀린 것이다.
// ⚠ **열을 위치로 읽지 않는다.** 2026-08-11 에 `speedPct` 가 3번 자리에 끼면서 이 검사가
// 여유 부호를 `violations` 가 아니라 `timedOut` 과 대조하게 됐고, 둘 다 0 이라 **거짓 초록**
// 이었다. 머리글로 읽으면 열이 늘거나 순서가 바뀌어도 검사가 같은 것을 계속 잰다.
const head = csv[0].split(',');
const at = (name) => {
  const i = head.indexOf(name);
  if (i < 0) { console.error(`summary.csv 에 열 "${name}" 이 없다 — 머리글: ${csv[0]}`); process.exit(1); }
  return i;
};
const cell = (line, name) => line.split(',')[at(name)];
const clears = csv.slice(1).map((l) => cell(l, 'minClearMm'));
const filled = clears.filter((v) => v !== '' && Number.isFinite(Number(v)));
check(`최소여유가 ${N}행 전부 채워진다`, filled.length === N, `${filled.length}/${N}`);
const mismatch = csv.slice(1).filter((l) => {
  const c = Number(cell(l, 'minClearMm')); const v = Number(cell(l, 'violations'));
  return (c < 0) !== (v > 0);
});
check('여유 부호와 판정이 일치한다', mismatch.length === 0,
  mismatch.slice(0, 2).map((l) => `행 ${l}`).join(' · '));

// ── ①-c 사전 집계가 원본과 어긋나지 않나 ─────────────────────────────────
// **집계는 두 번째 계산이다.** 원본(summary.csv)과 갈리면 화면이 없는 분산을 그리게 된다 —
// 계약 §화면 「밴드는 실제 분산을 그대로 그린다, 납작하면 납작하게」가 여기서 지켜진다.
const agg = JSON.parse(readFileSync(join(a.dir, 'agg.json'), 'utf-8'));
const col = (name) => csv.slice(1).map((l) => Number(cell(l, name))).filter(Number.isFinite);
const rawClear = col('minClearMm').sort((x, y) => x - y);
// ⛔ **사이클은 완주한 행만 센다** (2026-08-19). 러너는 시간초과해도 다음 칸으로 밀어
//   끝까지 행진시키므로 `cycleMs` 열이 미완주 행에도 채워져 있다 — 그 값은 사이클이 아니라
//   막힌 채 흘려보낸 시간이다. 여유는 반대로 **전부** 쓴다 (막혀 있어도 물리가 잰 값이다).
const rawCycle = csv.slice(1).filter((l) => Number(cell(l, 'timedOut')) === 0)
  .map((l) => Number(cell(l, 'cycleMs'))).filter(Number.isFinite).sort((x, y) => x - y);
const near = (x, y, tol = 1e-6) => Math.abs(x - y) <= tol;
const drift = [];
if (!near(agg.minClearMm.min, rawClear[0])) drift.push(`여유 최소 ${agg.minClearMm.min}≠${rawClear[0]}`);
if (!near(agg.minClearMm.max, rawClear[rawClear.length - 1])) drift.push(`여유 최대 ${agg.minClearMm.max}≠${rawClear[rawClear.length - 1]}`);
// **완주가 0 이면 `cycleMs` 는 `null` 이 맞다** — 그것 자체가 검사 대상이다
if (rawCycle.length === 0) {
  if (agg.cycleMs !== null) drift.push('완주 0 인데 사이클 분위수가 있다 — 미완주 벌이 섞였다');
} else if (!agg.cycleMs) {
  drift.push(`완주 ${rawCycle.length}벌인데 사이클 분위수가 없다`);
} else {
  if (!near(agg.cycleMs.min, rawCycle[0])) drift.push(`사이클 최소 ${agg.cycleMs.min}≠${rawCycle[0]}`);
  if (!near(agg.cycleMs.max, rawCycle[rawCycle.length - 1])) drift.push(`사이클 최대 ${agg.cycleMs.max}≠${rawCycle[rawCycle.length - 1]}`);
}
if (agg.minClearMm.n !== N) drift.push(`표본 ${agg.minClearMm.n}≠${N}`);
if (agg.n !== N) drift.push(`n ${agg.n}≠${N}`);
// **이 불변식은 전부터 있었지만 한 번도 안 물렸다** — 양쪽이 늘 `8 + 0` 이었기 때문이다.
// 완주 판정을 고친 지금부터 진짜로 잰다 (2026-08-19).
if ((agg.cycleMs?.n ?? 0) + agg.cycleMsMissing !== N) drift.push(`빠진 표본이 안 맞는다 ${agg.cycleMs?.n ?? 0}+${agg.cycleMsMissing}≠${N}`);
if (!band0Ok(agg)) drift.push('밴드가 표본수(n)를 안 싣는다 — 끝칸이 몇 개로 그려졌는지 화면이 모른다');
check('집계가 원본과 같은 범위를 낸다 (분산을 안 부풀린다)', drift.length === 0, drift.join(' · '));

// 분위수는 단조여야 한다 — 아니면 계산이 틀린 것이다
function band0Ok(g) {
  const b = g.clearanceBand;
  return Array.isArray(b?.n) && b.n.length === b.pct.length && b.n.every((v) => v > 0);
}
// 없는 분포(`null`)는 「단조가 아니다」가 아니라 **잴 것이 없다** 이다 — 완주 0 이면
// `cycleMs` 가 `null` 인 것이 정상이고, 그 사실은 위 ①-c 가 따로 잰다 (2026-08-19).
const mono = (o) => o === null || o === undefined
  || (o.p05 <= o.p25 && o.p25 <= o.p50 && o.p50 <= o.p75 && o.p75 <= o.p95);
const band = agg.clearanceBand;
const badBin = band.pct.findIndex((_, i) =>
  !(band.p05[i] <= band.p25[i] && band.p25[i] <= band.p50[i]
    && band.p50[i] <= band.p75[i] && band.p75[i] <= band.p95[i]));
check(`분위수가 단조다 (밴드 ${band.pct.length}칸)`,
  mono(agg.cycleMs) && mono(agg.minClearMm) && badBin < 0,
  badBin >= 0 ? `${band.pct[badBin]}% 칸에서 뒤집힌다` : '');

// ── ①-d 밴드가 진행률 축이고, 칸마다 벌 하나씩만 들어갔나 ──────────────────
// **리샘플의 심장이다.** 진행률로 그냥 묶으면 느린 벌이 표본을 더 내서 밴드가 느린 쪽으로
// 기운다 — 그때 「96벌의 분포」라는 말이 거짓이 된다 (계약 §화면).
const kept = N - (band.excluded ?? 0);
check('밴드가 진행률 축이다 (0%~100%)',
  band.pct?.[0] === 0 && band.pct?.[band.pct.length - 1] === 100,
  `${band.pct?.[0]}~${band.pct?.[band.pct.length - 1]}`);
check(`밴드 칸마다 완주 벌이 한 점씩 (n=${kept})`,
  band.n.every((v) => v === kept) && kept > 0,
  `n 범위 ${Math.min(...band.n)}~${Math.max(...band.n)} · 제외 ${band.excluded}`);

// 칸별 소요시간 — **합이 사이클과 맞아야** 「어느 칸이 느린가」가 거짓말을 안 한다
// ⚠ **완주가 0 이면 댈 사이클이 없다 — 초록으로 넘기지 않고 「안 쟀다」로 적는다** (2026-08-19).
//   전에는 시간초과 벌의 시간까지 사이클로 세어 이 검사가 **뜻 없는 숫자끼리** 맞춰 보고
//   PASS 를 냈다 (실측: 8/8 시간초과인데 「칸합 56065ms vs 사이클 56324ms」로 초록).
const stepSum = agg.steps.reduce((s, st) => s + (st.ms?.p50 ?? 0), 0);
if (!agg.cycleMs) {
  skip(`칸별 시간 ${agg.steps.length}칸의 중앙값 합이 사이클 중앙값 부근이다`,
    `완주 0/${N} — 사이클 중앙값이 없어 댈 것이 없다 (미완주 ${agg.cycleMsMissing}벌)`);
} else {
  check(`칸별 시간 ${agg.steps.length}칸의 중앙값 합이 사이클 중앙값 부근이다`,
    agg.steps.length > 0 && Math.abs(stepSum - agg.cycleMs.p50) <= agg.cycleMs.p50 * 0.25,
    `칸합 ${Math.round(stepSum)}ms vs 사이클 ${agg.cycleMs.p50}ms`);
}

// 밀도 띠는 **안 난 종류도 0 으로 남긴다** — 행이 사라지면 「없다」와 「안 쟀다」가 같아 보인다
const kindTotal = Object.fromEntries(agg.eventDensity.kinds.map((k, i) =>
  [k, agg.eventDensity.counts[i].reduce((s, v) => s + v, 0)]));
const realTotal = {};
for (const e of a.events) realTotal[e.kind] = (realTotal[e.kind] ?? 0) + 1;
const lost = agg.eventDensity.kinds.filter((k) => (kindTotal[k] ?? 0) !== (realTotal[k] ?? 0));
check(`밀도 띠가 이벤트를 안 흘린다 (종류 ${agg.eventDensity.kinds.length})`, lost.length === 0,
  lost.map((k) => `${k} ${kindTotal[k]}≠${realTotal[k] ?? 0}`).join(' · '));

// 정렬된 표 — 계약이 정한 오름차순이고, 1행이 실제 최악이어야 한다
const sortedOk = agg.worst.every((w, i) => i === 0 || agg.worst[i - 1].minClearMm <= w.minClearMm);
check('worst 표가 최소여유 오름차순이다', sortedOk && near(agg.worst[0]?.minClearMm, rawClear[0]),
  sortedOk ? '' : '정렬이 깨졌다');

// ── ② 스탬프가 조건을 들고 있다 ───────────────────────────────────────────
// 조건이 다른 회차가 나란히 비교되는 것을 막는다 (계약 §데이터 · D74 ④ 와 같은 이유)
const stampNeed = ['batchId', 'seed', 'engineVersion', 'coord', 'sceneBuiltFrom', 'fixtureFetchedAt'];
const lack = stampNeed.filter((k) => a.stamp[k] === undefined || a.stamp[k] === null);
check('batch.json 이 조건을 스탬프한다', lack.length === 0, lack.join(' · '));

// **판정 지문** — 게이트가 손끝 → 툴 → 팔로 넓어진 날, 그 전에 구운 회차가 화면에 그대로
// 떠 있었다(2026-08-11 19:42 회차 · 20:59 규칙). 장면 지문으로는 안 잡힌다
check('batch.json 이 판정 지문을 스탬프한다',
  /^[0-9a-f]{12}$/.test(a.stamp.judge?.fingerprint ?? '') && a.stamp.judge?.rules > 0,
  JSON.stringify(a.stamp.judge ?? null));

// ── ③ 재현성 — 같은 seed 두 번이면 바이트가 같다 ──────────────────────────
const b = await runBatch({ n: N, seed: 1, out: join(OUT, 'again') });
check('같은 seed → summary.csv 바이트 동일',
  readFileSync(join(a.dir, 'summary.csv'), 'utf-8') === readFileSync(join(b.dir, 'summary.csv'), 'utf-8'));
check('같은 seed → agg.json 바이트 동일',
  readFileSync(join(a.dir, 'agg.json'), 'utf-8') === readFileSync(join(b.dir, 'agg.json'), 'utf-8'),
  '집계가 재현 안 되면 화면이 회차마다 다른 숫자를 보인다');

// 다른 seed 면 달라야 한다 — 안 달라지면 지터가 죽어 있다는 뜻이다
const c = await runBatch({ n: N, seed: 2, out: join(OUT, 'seed2') });
check('다른 seed → 시작 자세가 달라진다',
  readFileSync(join(a.dir, 'summary.csv'), 'utf-8') !== readFileSync(join(c.dir, 'summary.csv'), 'utf-8'),
  '지터가 seed 를 안 타면 96벌이 같은 한 벌이다');

// ── ④ 결함 주입 — 구역을 팔 위로 덮으면 위반이 나야 한다 ──────────────────
// **이게 이 게이트의 심장이다.** 정상 회차의 「위반 0」이 「안 재고 있다」가 아님을 증명한다.
// **판정용 구역만** 흔든다 — 물리(장면)는 그대로 두고 판정 경로가 살아 있는지만 본다.
// 장면까지 흔들면 바닥 계산이 깨져 「주입이 실패했는지 검출기가 죽었는지」를 못 가린다.
const ws = readWorkspace(ROBOT);
const wide = JSON.parse(JSON.stringify(ws));
wide.walls[0] = { ...wide.walls[0], marginMm: 100000 };   // 어떤 손끝도 이 벽 곁이다
const bad = await runBatch({ n: 2, seed: 1, out: join(OUT, 'inject'), judgeWs: wide });
const kinds = new Set(bad.events.map((e) => e.kind));
// 여유도 같이 뒤집혀야 한다 — 판정만 뒤집히고 여유가 그대로면 둘이 다른 걸 재고 있다
const injClear = bad.inst.map((s) => s.worstClearMm).filter(Number.isFinite);
check('주입하면 여유도 음수로 뒤집힌다', injClear.length > 0 && injClear.every((c) => c < 0),
  injClear.length ? `여유 ${injClear.map((c) => c.toFixed(0)).join(',')}` : '여유가 안 나왔다');
check('구역을 팔 위로 덮으면 zoneViolation 이 난다', kinds.has('zoneViolation'),
  kinds.has('zoneViolation') ? '' : `안 났다 — 판정이 배치에 안 붙어 있다 (난 것: ${[...kinds].join(' ')})`);

// 주입이 **진짜 원인인지** 확인 — 정상 회차에 없던 규칙이 주입 회차에만 나야 한다.
//
// ⚠ **「정상 회차는 위반 0」으로 재지 않는다** (2026-08-12 고침). 승인된 슬롯 1 은 집는
// 지점에서 작업대 여유를 실제로 19.2mm 침범한다 — 그건 검출기 고장이 아니라 **참인 발견**이고,
// 0 을 요구하면 게이트가 그 발견을 「자기 고장」으로 읽어 빨개진다. 주입한 것은 **벽**이므로
// 벽 규칙으로 좁혀 묻는다 — 그게 「주입이 원인」을 실제로 재는 질문이다.
const WALL_RULES = new Set(['wall', 'toolWall', 'armWall']);
const wallOf = (evts) => new Set(evts.filter((e) => e.kind === 'zoneViolation')
  .map((e) => e.detail.rule).filter((r) => WALL_RULES.has(r)));
const normalWall = wallOf(a.events);
const injectedWall = wallOf(bad.events);
check('주입한 벽 규칙이 정상 회차에는 없다',
  normalWall.size === 0 && injectedWall.size > 0,
  `정상 ${[...normalWall].join(',') || '없음'} · 주입 ${[...injectedWall].join(',') || '없음'}`);

// ── ⑤ 손끝이 컨트롤러와 맞나 — 픽스처의 실기 표본 1개로 대조 ──────────────
// 시뮬 기구학이 실기와 갈리면 위 판정이 전부 다른 자리를 잰다. 실기 표본은 1자세뿐이라
// **이건 완전한 증명이 아니다** — 그래도 갈리면 여기서 걸린다.
const fx = JSON.parse(readFileSync(join(ROOT, 'Sim/fixtures', `${ROBOT}.json`), 'utf-8'));
const fkErr = await tcpErrorMm(fx);
check(`손끝이 컨트롤러와 ${fkErr.worst.toFixed(1)}mm 안에서 맞는다 (실기 ${fkErr.n}자세)`,
  fkErr.worst < 5 && fkErr.n >= 1,
  fkErr.worst >= 5 ? '기구학이 갈렸다 — 시뮬 숫자가 다른 자리를 잰 것이다' : '');

// ── ⑥ 산출물은 커밋되지 않는다 ────────────────────────────────────────────
let tracked = '';
try { tracked = execFileSync('git', ['ls-files', 'Sim/out'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* git 없음 */ }
check('Sim/out 은 커밋되지 않는다 (D14)', tracked === '', tracked.split('\n').slice(0, 3).join(' · '));

rmSync(OUT, { recursive: true, force: true });

const fail = results.filter(([ok]) => !ok);
console.log(fail.length ? `\n${fail.length}개 실패 — ${fail.map(([, n]) => n).join(' · ')}`
  : `\n배치 OK — 완주·재현성·스탬프, 그리고 **주입하면 잡는다**`);
process.exit(fail.length ? 1 : 0);

/** 픽스처의 (관절, 손끝) 실기 한 쌍을 시뮬 기구학에 넣어 오차 mm 를 낸다. */
async function tcpErrorMm(fx) {
  const { default: loadMujoco } = await import('@mujoco/mujoco');
  const { bakeRobot, composeScene } = await import('../../Sim/scene/build-scene.mjs');
  const mj = await loadMujoco();
  const robot = bakeRobot(mj);
  const userT = fx.coordDefs.user.slice(0, 3);
  mj.FS.writeFile('/asset/fk.xml', composeScene(robot.xml, readWorkspace(ROBOT), userT));
  const m = mj.MjModel.from_xml_path('/asset/fk.xml');
  const d = new mj.MjData(m);
  let worst = 0;
  const samples = fx.fkSamples ?? (fx.fkSample ? [fx.fkSample] : []);
  for (const s of samples) {
    for (let j = 0; j < 6; j++) d.qpos[j] = (s.jointsDeg[j] * Math.PI) / 180;
    mj.mj_kinematics(m, d);
    mj.mj_forward(m, d);
    const sx = d.site_xpos;
    const sim = [sx[0] * 1000 - userT[0], sx[1] * 1000 - userT[1], sx[2] * 1000 - userT[2]];
    const t = s.tcpMmDeg;
    worst = Math.max(worst, Math.hypot(sim[0] - t[0], sim[1] - t[1], sim[2] - t[2]));
  }
  d.delete(); m.delete();
  return { worst, n: samples.length };
}
