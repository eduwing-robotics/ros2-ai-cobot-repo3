// 킬-실험 계기 — **시뮬이 낸 순위가 실기에서 순위로 남나** (`docs/goals/GOAL-grasp-rank.md`).
//
// 로봇 없이 돈다. 하는 일 셋 —
//   ① 자세 셋(좋음·중간·빗나감)을 **흔들어** 순위를 낸다
//   ② 실기 기록이 있으면 판정 넷을 찍는다. 없으면 `대기` 로 통과한다 (다른 게이트를 안 붉힌다)
//   ③ **자기검사** — 순위가 뒤집힌 합성 기록을 넣으면 빨개진다 (안 재는 게이트와 가른다)
//
// ⛔ **「성공률」이라 부르지 않는다.** 이건 실기 빈도가 아니라 **흔들었을 때 물 수 있는 자세로
//    남은 비율**이다. 이름을 헷갈리면 화면이 없는 능력을 자랑하게 된다
//    (`SIM-CONTRACT.md` §화면 — 그 금지는 아직 유효하다. 이 골은 문서를 안 연다).
//
// ⛔ **판정은 비율이 아니라 순서다.** 원래 골은 「성공률 ±15%p · 10회」였는데 이항분포에서
//    p=0.9·n=10 이면 표준오차가 9.5%p 라 **판정선이 잡음보다 작았다**. 순위 보존은 n=3 으로도
//    판정된다 (`docs/ref/rnd/SIM-GRASP-CONVERGE-LOOP-2026-08-13.md` D5·D12).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { judgeGrasp } from '../../Sim/runner/grasp.mjs';
import { rotFixedXyz } from '../../Sim/runner/judge.mjs';
import { ROUND, FIXTURE, GRASP_TRUTH } from '../../Shared/data/props.js';
import { readWorkspace } from '../../Sim/scene/build-scene.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
let bad = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); bad += 1; };
const ok = (c, m) => (c ? pass(m) : fail(m));
const note = (m) => console.log(`  ·     ${m}`);
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));

// ── 흔들 폭 — **실측이다. 지어낸 값이 아니다** ──────────────────────────────
// hand-eye 킬실험(2026-08-12)의 **흩어짐 12.3mm** — 표적이 총알(눕힘)일 때의 값이다.
// 이게 「비전이 준 물체 자리」가 실제로 얼마나 흔들리는지이고, 강건성이 견뎌야 할 폭이다.
// ⚠ **사람 교시 재현 오차는 여기 없다** — 아직 안 쟀고, 그걸 재는 것이 이 골의 산출이다.
const SHAKE_MM = 12.3;
const SHAKE_SRC = 'docs/evidence/2026-08-12/handeye-kill-experiment.md 흩어짐 12.3mm';
const N = 400;

/** 씨앗 있는 난수 — `Math.random` 은 쓰지 않는다. 재현 안 되면 계측이 아니다. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 반지름 `r` 공 안의 한 점 — 겉면만 뽑으면 최악만 재고, 정육면체면 모서리가 과대해진다. */
function ball(rand, r) {
  for (;;) {
    const p = [0, 1, 2].map(() => rand() * 2 - 1);
    const d2 = p[0] ** 2 + p[1] ** 2 + p[2] ** 2;
    if (d2 <= 1 && d2 > 0) return p.map((v) => v * r);
  }
}

// ── 무대 — 총알이 서 있는 자리 ─────────────────────────────────────────────
// ⚠ **`FIXTURE.tableZMm`(그 자리 실측)이 있으면 그걸 쓰고, 없으면 게이트 상자 값을 쓴다.**
// 둘은 다르다 — 상자 값은 상판 네 귀의 **최고점**이고 실물은 1.20° 기울어 있다.
// 2026-08-13 실측: 그 차이가 **5.18mm** 였다. 어느 쪽을 썼는지 화면이 글자로 말한다.
const ws = readWorkspace('fr5-lab-a');
const tableBox = ws.boxes.find((b) => /작업대/.test(b.name));
const measured = Number.isFinite(FIXTURE.tableZMm);
const tableZ = measured ? FIXTURE.tableZMm : tableBox.topZMm;
const baseMm = [FIXTURE.centerMm[0], FIXTURE.centerMm[1], tableZ + FIXTURE.heightMm];
const OBJ = { baseMm, lengthMm: ROUND.lengthMm, diaMm: ROUND.diaMm };

// ── 자세 셋 — 참값에서 **툴 좌표계로** 밀어 만든다 ─────────────────────────
// 유저 좌표계로 밀면 「위로」·「옆으로」가 자세에 따라 다른 뜻이 된다. 툴 축이 곧 의미다:
// X 개폐축 · Y 폭축 · Z 접근축.
const T = GRASP_TRUTH.standing.tcpMmDeg;
const R = rotFixedXyz(T[3], T[4], T[5]);
const shift = (dTool) => [
  ...[0, 1, 2].map((i) => T[i] + R[i][0] * dTool[0] + R[i][1] * dTool[1] + R[i][2] * dTool[2]),
  T[3], T[4], T[5],
];
// ⛔ **「중간」을 접근축 후퇴로 만들었다가 되돌렸다** (2026-08-13 첫 실행). 물림이 22.4 → 12.8mm
//    로 반이 됐는데 **남은 비율은 85.3% → 85.5% 로 안 줄었다.** 지배적 탈락이 `offAxis`(옆으로)
//    라 접근축을 건드려도 그 실패를 안 건드리기 때문이다. **물림을 줄이는 것은 강건성을 안 줄인다** —
//    채점식이 물림에 무게를 싣고 있었다면 그게 헛다리였다는 뜻이다 (칸 4 로 넘길 발견).
//    그래서 셋을 **같은 실패 모드(옆으로)에서** 세 단계로 만든다. 안 그러면 순위가 안 갈린다.
const POSES = [
  { name: '좋음', note: '실기 참값 그대로 (2026-08-13 10:57)', tcp: shift([0, 0, 0]) },
  { name: '중간', note: '개폐축으로 9mm — 여유가 반쯤 남는다', tcp: shift([9, 0, 0]) },
  { name: '빗나감', note: '개폐축으로 18mm — 벌려도 축이 안 들어온다', tcp: shift([18, 0, 0]) },
];

/** 흔들었을 때 **물 수 있는 자세로 남은 비율**. 물체 자리를 흔든다(비전 오차). */
function survive(tcp, widthMm, seed) {
  const rand = rng(seed);
  let live = 0;
  let biteSum = 0;
  const fails = new Map();       // ⚠ 이름을 `why` 로 두면 자세의 설명 필드를 덮는다
  for (let i = 0; i < N; i += 1) {
    const d = ball(rand, widthMm);
    const g = judgeGrasp(tcp, { ...OBJ, baseMm: [0, 1, 2].map((k) => OBJ.baseMm[k] + d[k]) });
    if (g.reason === null) { live += 1; biteSum += g.biteMm; } else {
      // `offAxis` 는 사유가 하나지만 **원인이 둘**이다 — 개폐가 모자란 것과 턱 폭을 벗어난 것.
      // 계기는 그 둘을 갈라 센다. 어느 쪽이 먼저 지는지가 곧 다음에 손댈 곳이다
      // (`grasp.mjs` 는 자세당 사유를 하나만 내기로 했으므로 저기서 안 쪼갠다).
      const key = g.reason !== 'offAxis' ? g.reason
        : (g.sideMm > 8.35 ? 'offAxis:폭' : 'offAxis:개폐');
      fails.set(key, (fails.get(key) ?? 0) + 1);
    }
  }
  return { rate: live / N, meanBite: live ? biteSum / live : 0, fails };
}

/**
 * 순위 — 남은 비율 내림차순. **동률을 억지로 가르지 않는다.**
 *
 * ⛔ 첫 판은 `rate` 가 0.2%p 만 달라도 순위를 매겼다. `N=400 · p≈0.85` 의 표준오차가
 * **1.8%p** 라 그 순위는 잡음이었고, 폭을 2배로 하면 그대로 뒤집혔다 — 그런데 그건 순위가
 * 불안정한 게 아니라 **둘이 실제로 동률**이었던 것이다. 계기가 없는 차이를 만들면
 * 「폭에 민감하다」는 거짓 경보가 난다. 그래서 **2σ 안이면 같은 층**으로 묶는다.
 */
function tiers(rows) {
  const se = (p) => Math.sqrt(Math.max(p * (1 - p), 1e-9) / N);
  const sorted = [...rows].sort((a, b) => b.rate - a.rate);
  const out = [[sorted[0]]];
  for (const r of sorted.slice(1)) {
    const head = out[out.length - 1][0];
    const band = 2 * (se(head.rate) + se(r.rate));
    if (head.rate - r.rate <= band) out[out.length - 1].push(r);
    else out.push([r]);
  }
  return out.map((t) => t.map((r) => r.name).sort());
}
const showTiers = (t) => t.map((g) => (g.length > 1 ? `{${g.join('=')}}` : g[0])).join(' > ');

console.log('킬-실험 계기 — 시뮬이 낸 순위가 실기에서 남나\n');
console.log(`  무대   총알 ${ROUND.lengthMm}×${ROUND.diaMm} · 받침 ${FIXTURE.heightMm}`
  + ` · 상판 ${tableZ.toFixed(2)} (${measured ? '**그 자리 실측**' : '⚠ 게이트 상자값 — 선행 미측정'})`);
console.log(`  흔들기 반지름 ${SHAKE_MM}mm 공 · ${N}회 · 씨앗 고정`);
console.log(`         출처 ${SHAKE_SRC}\n`);

// ── ① 시뮬 순위 ───────────────────────────────────────────────────────────
const base = POSES.map((p) => ({ ...p, ...survive(p.tcp, SHAKE_MM, 20260813) }));
for (const r of base) {
  const top = [...r.fails.entries()].sort((a, b) => b[1] - a[1])[0];
  note(`${r.name.padEnd(4)} 남은비율 ${(r.rate * 100).toFixed(1)}%`
    + ` · 평균물림 ${f1(r.meanBite)}mm`
    + ` · 최다탈락 ${top ? `${top[0]}(${top[1]})` : '없음'}   ${r.note}`);
}
const simTiers = tiers(base);
const simRank = simTiers.flat();
ok(simTiers.length === POSES.length,
  `자세 셋이 **통계적으로 갈린다** (${showTiers(simTiers)}) — 2σ 밖으로 떨어진 층 ${simTiers.length}/3`);
ok(simRank[simRank.length - 1] === '빗나감',
  `빗나감이 꼴찌다 (${simRank[simRank.length - 1]})`);

// ── ④ 폭 민감도 — 2배로 흔들어도 순위가 유지되나 ──────────────────────────
// 유지되면 **칸 5(폭 실측) 전에도 순위를 결론으로 쓸 수 있다**. 안 되면 못 쓴다.
//
// ⛔ **「뒤집힘」과 「해상도 상실」을 가른다** (2026-08-13 첫 실행에서 갈렸다). 폭을 2배로 하니
//    `{좋음=중간} > 빗나감` 이 됐다 — **순서가 틀린 게 아니라 둘을 못 가르게 된 것**이다.
//    D15 가 물은 것은 「순위를 결론으로 쓸 수 있나」이고, 합쳐져도 「빗나감이 꼴찌」는 그대로라
//    쓸 수 있다. 그래서 **뒤집힘만 실패**로 세고 해상도는 경고로 남긴다. 둘을 한 줄로 묶으면
//    거짓 경보가 나고, 거짓 경보는 다음 사람이 게이트를 안 믿게 만든다.
const wide = POSES.map((p) => ({ ...p, ...survive(p.tcp, SHAKE_MM * 2, 20260813) }));
const wideTiers = tiers(wide);
const order = (t) => t.flat();
const inverted = order(simTiers).some((n, i) => {
  const j = order(wideTiers).indexOf(n);
  return order(simTiers).slice(i + 1).some((m) => order(wideTiers).indexOf(m) < j
    // 같은 층으로 합쳐진 것은 뒤집힘이 아니다 — 층이 다른데 순서가 바뀐 것만 센다
    && wideTiers.findIndex((g) => g.includes(m)) !== wideTiers.findIndex((g) => g.includes(n)));
});
ok(!inverted,
  `판정 4 — 폭 2배(${(SHAKE_MM * 2).toFixed(1)}mm)에도 **순서가 안 뒤집힌다** (${showTiers(wideTiers)})`);
if (JSON.stringify(simTiers) !== JSON.stringify(wideTiers)) {
  note(`⚠ 해상도는 잃는다 — ${showTiers(simTiers)} → ${showTiers(wideTiers)}.`
    + ' 폭이 커지면 상위 둘을 못 가른다. **실패가 아니라 한계다** — 칸 5 가 폭을 실측하면 다시 갈린다');
}

// ── 실기 기록 ─────────────────────────────────────────────────────────────
function findRecord() {
  const dir = join(ROOT, 'docs/evidence');
  if (!existsSync(dir)) return null;
  const days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const d of days) {
    const p = join(dir, d, 'grasp-rank.json');
    if (existsSync(p)) return { path: `docs/evidence/${d}/grasp-rank.json`, data: JSON.parse(readFileSync(p, 'utf-8')) };
  }
  return null;
}

/** 기록 하나를 판정 1~3 으로 옮긴다. **게이트와 자기검사가 같은 함수를 쓴다.** */
export function judgeRecord(rec, simRankNames) {
  const out = [];
  const rows = rec.poses ?? [];
  const byName = new Map(rows.map((r) => [r.name, r]));
  // 판정 1 — 실기 순서가 시뮬 순서를 뒤집지 않는다. 실기 순서 = 잡힘 우선, 동률이면 기록 순
  const realRank = [...rows]
    .sort((a, b) => (Number(b.gripped) - Number(a.gripped)))
    .map((r) => r.name);
  out.push([JSON.stringify(realRank) === JSON.stringify(simRankNames),
    `판정 1 순위 — 시뮬 [${simRankNames.join(' > ')}] · 실기 [${realRank.join(' > ')}]`]);
  // 판정 2 — 시뮬이 꼴찌로 민 자세가 실기에서도 못 문다
  const worst = byName.get(simRankNames[simRankNames.length - 1]);
  out.push([worst != null && worst.gripped === false,
    `판정 2 반례 — 시뮬 꼴찌(${simRankNames[simRankNames.length - 1]})가 실기에서 ${worst?.gripped === false ? '못 물었다' : '물었다'}`]);
  // 판정 3 — 파지 높이가 ±3mm
  const gaps = rows.filter((r) => Number.isFinite(r.taughtHeightMm) && Number.isFinite(r.simHeightMm))
    .map((r) => ({ name: r.name, gap: Math.abs(r.taughtHeightMm - r.simHeightMm) }));
  const worstGap = gaps.length ? Math.max(...gaps.map((g) => g.gap)) : NaN;
  out.push([gaps.length === rows.length && worstGap <= 3,
    `판정 3 높이 — 최대 갭 ${f1(worstGap)}mm ≤ 3 (${gaps.length}/${rows.length}건 기록)`]);
  return out;
}

const rec = findRecord();
if (!rec) {
  console.log('\n  대기   실기 기록이 없다 — docs/evidence/<날짜>/grasp-rank.json');
  note('로봇 세션에서 ① 받침 자리 상판 짚기 ② 자세 셋 교시 ③ 잡아보기 를 하면 판정 1~3 이 열린다');
} else {
  console.log(`\n  기록   ${rec.path}`);
  for (const [good, msg] of judgeRecord(rec.data, simRank)) ok(good, msg);
}

// ── ③ 자기검사 — 뒤집힌 기록을 넣으면 빨개지나 ────────────────────────────
// 「판정이 있다」와 「판정이 잡는다」는 다르다. 기록이 아직 없어도 이건 늘 돈다.
{
  const flipped = {
    poses: [
      { name: '빗나감', gripped: true, taughtHeightMm: 10, simHeightMm: 10 },
      { name: '중간', gripped: true, taughtHeightMm: 10, simHeightMm: 10 },
      { name: '좋음', gripped: false, taughtHeightMm: 10, simHeightMm: 10 },
    ],
  };
  const v = judgeRecord(flipped, simRank);
  ok(v[0][0] === false && v[1][0] === false,
    '자기검사 — 순위가 뒤집힌 기록을 넣으면 판정 1·2 가 빨개진다');
  const off = { poses: [{ name: '좋음', gripped: false, taughtHeightMm: 20, simHeightMm: 10 }] };
  ok(judgeRecord(off, ['좋음'])[2][0] === false, '자기검사 — 높이 10mm 갭이면 판정 3 이 빨개진다');
}

// ── 선행 ──────────────────────────────────────────────────────────────────
// ⛔ **exit 코드는 「계기가 옳나」만 말한다. 「실험이 끝났나」는 아니다.**
//    안 그러면 이 골 하나 때문에 `all.sh` 가 계속 빨갛고, 상시 빨간 게이트는 아무도 안 본다
//    (`sim-batch.sh` 가 픽스처 없을 때 「잰 척하지 않고 SKIP」 하는 것과 같은 규약).
//    **완료 판정은 `docs/goals/GOAL-grasp-rank.md` 가 들고 있다** — 판정 넷 + 선행.
if (measured) pass(`선행 — 받침 자리 상판 실측 ${FIXTURE.tableZMm}`);
else {
  console.log(`  대기   선행 미완 — props.js FIXTURE.tableZMm 이 없다`);
  note(`게이트 상자값(${tableBox.topZMm})으로 돌고 있다. 실물은 그 자리에서 5mm 급 낮다`);
  note('scripts/robot/table-probe.py 로 받침 놓는 자리를 짚으면 채워진다');
}

const done = measured && rec;
console.log(bad
  ? `\n킬-실험 계기 — ${bad}건 미충족`
  : `\n킬-실험 계기 OK — ${done ? '실험 완료' : '**실험 미완** (선행·실기 기록 대기 · 골이 완료를 판정한다)'}`);
process.exit(bad ? 1 : 0);
