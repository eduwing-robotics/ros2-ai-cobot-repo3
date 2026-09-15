// 파지 기하 게이트 — **네 자세를 정말 가르나.**
//
// 무엇을 재나 (골 `GOAL-sim-grasp.md` §2 · 칸 3):
//   ① 맞음·높음·낮음·빗나감이 **서로 다른 사유**로 갈린다
//   ② 제원이 실측 정본에서 온다 (여기 숫자를 안 적는다)
//   ③ 결측이면 통과가 아니라 **차단**이다 (제1원칙)
//   ④ **결함을 주입하면 빨개진다** — 안 재는 게이트와 깨끗한 게이트를 가른다
//   ⑤ 판정 지문이 `grasp.mjs` 를 덮는다 (안 덮으면 파지가 바뀐 회차가 섞인다)
//
// 로봇·브라우저·포트를 안 쓰고 1초 안에 끝난다. 물체 치수는 `props.js ROUND` 실측이다 —
// 여기서 지어내면 게이트가 자기가 만든 숫자를 자기가 통과시킨다.
import { judgeGrasp, GRASP, JAW } from '../../Sim/runner/grasp.mjs';
import { judgeFingerprint, rotFixedXyz } from '../../Sim/runner/judge.mjs';
import { ROUND, GRASP_TRUTH } from '../../Shared/data/props.js';

let bad = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); bad += 1; };
const ok = (cond, m) => (cond ? pass(m) : fail(m));
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));

if (JAW instanceof Error) {
  console.log(`  FAIL  집게 제원을 못 읽었다: ${JAW.message}`);
  process.exit(1);
}

// ── 무대 — 세워 둔 총알 하나. **좌표는 골 §0-b 의 산술 그대로다** ─────────────
// ⛔ **이 −398.9 는 얼려 둔 시험 무대다 — `config.yaml` 을 읽은 값이 아니다.**
// 2026-08-18 에 작업대가 795×453 한 판 → 800×500 세 판으로 **교체**되면서 config 에서
// 이 숫자는 사라졌다. 그래도 여기는 **안 바꾼다** — 아래 검사 24개가 재는 것은 상판 높이가
// 아니라 **집게와 원통의 기하**이고, 기대값이 전부 이 밑동에 매달려 있다. 새 상판 값으로
// 갱신하면 시험이 이유 없이 깨진다. 살아 있는 상판을 쓰는 쪽은 `grasp-rank.mjs` 다.
// 밑동 = 상판 −398.9 + 받침 86.5 (props.js FIXTURE) = −312.4.
const BASE_Z = -398.9 + 86.5;
const OBJ = { baseMm: [400, -1000, BASE_Z], lengthMm: ROUND.lengthMm, diaMm: ROUND.diaMm };
const MID_Z = BASE_Z + ROUND.lengthMm / 2;

// 손끝을 물건 **옆**에 두고 축이 폭축(Y)에 오게 세운 자세 (D122 — 세워서 꽂는다).
// rx 90° 면 툴 Z(접근)가 유저 −Y 로, 툴 Y(폭)가 유저 +Z 로 간다 — 고정축 XYZ 규약.
// 접근축으로 `d` mm 앞에 서면 손끝이 물건에서 그만큼 떨어진다.
const sidePose = (dz = 0, dx = 0, standoff = 5) =>
  [OBJ.baseMm[0] + dx, OBJ.baseMm[1] - standoff, MID_Z + dz, 90, 0, 0];

console.log('파지 기하 — 네 자세를 가르나\n');
console.log(`  집게  띠 ${JAW.bandMm}mm · 행정 ${JAW.strokeMm}mm · 턱 반너비 ${JAW.halfWidthMm}mm`);
console.log(`  물건  ${ROUND.label}  ${ROUND.lengthMm}×${ROUND.diaMm}mm  밑동 z ${BASE_Z.toFixed(1)}\n`);

// ── ① 네 자세 ──────────────────────────────────────────────────────────────
const CASES = [
  ['맞음   허리를 옆에서', sidePose(0), null],
  ['높음   꼭대기 위로', sidePose(ROUND.lengthMm / 2 + 10), GRASP.tooHigh],
  ['낮음   밑동 아래로', sidePose(-ROUND.lengthMm / 2 - 10), GRASP.tooLow],
  ['빗나감 개폐축으로 옆에', sidePose(0, JAW.strokeMm), GRASP.offAxis],
];

const got = new Map();
for (const [label, tcp, want] of CASES) {
  const g = judgeGrasp(tcp, OBJ);
  got.set(label, g);
  const shown = `${String(g.reason)}  높이 ${f1(g.heightMm)} · 물림 ${f1(g.biteMm)}`
    + ` · 편심 ${f1(g.lateralMm)}/${f1(g.sideMm)} · 필요개폐 ${f1(g.needOpenMm)}`;
  ok(g.reason === want, `${label.padEnd(22)} ${shown}`);
}
const reasons = new Set([...got.values()].map((g) => String(g.reason)));
ok(reasons.size === CASES.length,
  `사유가 넷으로 갈린다 (${reasons.size}종: ${[...reasons].join(' · ')})`);

// 맞음 자세는 숫자도 말이 돼야 한다 — 사유만 맞고 값이 헛돌면 칸 4 의 순위가 헛돈다
const good = got.get(CASES[0][0]);
ok(good.biteMm > 0 && good.needOpenMm <= JAW.strokeMm && good.sideMm <= JAW.halfWidthMm,
  `맞음 자세의 숫자가 서로 맞는다 (물림 ${f1(good.biteMm)} > 0 · 필요개폐 ${f1(good.needOpenMm)} ≤ ${JAW.strokeMm})`);

// ── ② 제원이 정본에서 오나 ─────────────────────────────────────────────────
// 값을 여기 적어 대조하면 정본이 둘이 된다. **관계**만 잰다 — 이 셋은 서로 독립이라
// 하나가 0 이 되거나 뒤바뀌면 걸린다.
ok(JAW.strokeMm > JAW.halfWidthMm && JAW.bandMm > 0 && JAW.strokeMm > 0,
  '제원이 정본(gripper-mount·tool-hull)에서 온다 — 게이트에 숫자를 안 적었다');
ok(ROUND.diaMm < JAW.strokeMm,
  `물건이 행정 안에 든다 (${ROUND.diaMm} < ${JAW.strokeMm}) — 안 그러면 tooWide 뿐이다`);

// ── ③ 결측 = 차단 ──────────────────────────────────────────────────────────
const MISSING = [
  ['손끝 방향이 없다', () => judgeGrasp([400, -1000, MID_Z], OBJ), GRASP.poseUnreadable],
  ['손끝이 NaN', () => judgeGrasp([NaN, 0, 0, 0, 0, 0], OBJ), GRASP.poseUnreadable],
  ['물건이 없다', () => judgeGrasp(sidePose(0), null), GRASP.objectUnreadable],
  ['길이가 0', () => judgeGrasp(sidePose(0), { ...OBJ, lengthMm: 0 }), GRASP.objectUnreadable],
  ['축이 영벡터', () => judgeGrasp(sidePose(0), { ...OBJ, axisUnit: [0, 0, 0] }), GRASP.objectUnreadable],
  ['집게 제원을 못 읽었다', () => judgeGrasp(sidePose(0), OBJ, new Error('x')), GRASP.gripperUnreadable],
];
for (const [label, run, want] of MISSING) {
  const g = run();
  ok(g.reason === want, `결측=차단 — ${label} → ${g.reason}`);
}

// ── ④ 결함 주입 ────────────────────────────────────────────────────────────
// 「사유가 갈린다」가 진짜인지 보려면 **갈리지 말아야 할 것을 갈리게** 해 본다.
const wide = judgeGrasp(sidePose(0), { ...OBJ, diaMm: JAW.strokeMm + 1 });
ok(wide.reason === GRASP.tooWide, `행정보다 굵게 하면 tooWide (${wide.reason})`);

// 띠를 좁히면 **물림이 그만큼 준다.** ⛔ 「사유가 바뀐다」로 재지 않는다 — 이 파일은
// 일부러 물림에 문턱을 안 두므로(§문턱을 여기서 만들지 않는다) 좁혀도 사유는 `null` 이
// 맞다. 재야 할 것은 **띠가 계산에 실제로 쓰이나**이고, 그건 값이 따라오는 것으로 잰다.
const thin = judgeGrasp(sidePose(0), OBJ, { ...JAW, bandMm: 1 });
ok(thin.biteMm === 1 && thin.biteMm < good.biteMm,
  `띠를 1mm 로 좁히면 물림이 따라온다 (${f1(good.biteMm)} → ${f1(thin.biteMm)})`);

// 물건을 접근축으로 멀리 밀면 사이는 맞는데 안 물린다
const far = judgeGrasp(sidePose(0, 0, JAW.bandMm + ROUND.diaMm + 10), OBJ);
ok(far.reason === GRASP.notReached, `덜 들어가면 notReached (${far.reason} · 물림 ${f1(far.biteMm)})`);

// 폭축(Y)이 개폐축(X)과 **따로 재지나.** 세운 자세에서는 툴 Y 가 유저 Z 라 폭축 편심이
// 곧 높이라 사유가 겹친다 — 그래서 **눕힌 총알**로 축을 갈라서 잰다 (D122 는 세우지만,
// 눕은 것이 섞여 들어오는 순간 이 축이 판정을 해야 한다).
const LAID = { ...OBJ, axisUnit: [1, 0, 0] };
const laidPose = (dzMm = 0) => [OBJ.baseMm[0] + ROUND.lengthMm / 2, OBJ.baseMm[1] - 5, OBJ.baseMm[2] + dzMm, 90, 0, 0];
const laidOk = judgeGrasp(laidPose(0), LAID);
ok(laidOk.reason === null, `눕힌 총알의 허리는 문다 (${laidOk.reason} · 폭축 ${f1(laidOk.sideMm)})`);
const laidOff = judgeGrasp(laidPose(JAW.halfWidthMm + 4), LAID);
ok(laidOff.reason === GRASP.offAxis && laidOff.sideMm > JAW.halfWidthMm,
  `폭축으로 턱 밖까지 밀면 offAxis (${laidOff.reason} · 폭축 ${f1(laidOff.sideMm)} > ${JAW.halfWidthMm})`);

// ── ⑤ 실기 참값 — **답안지로 계산기를 맞춰 본다** (2026-08-13) ──────────────
// 실기 담당자가 총알을 문 채로 잡아 두신 자세다. 여기서 **회귀를 하나 잠근다**: 옛 식은 물림을
// 지름으로만 재서, **축이 접근축과 나란한** 이 자세에서 물림 0 을 냈다 — 실기가 물고 있는데
// 「안 잡고 있다」로 보고한 것이다. 게이트 21건이 전부 초록인 채 틀려 있었다.
//
// ⛔ **눕힌 자세(`GRASP_TRUTH.laid`)로는 이게 안 잡힌다** — 축이 접근축과 직교라 옛 식과
//    새 식이 같은 답을 낸다. **자세 하나로 맞추면 그 자세만 맞는다.** 그래서 세운 자세다.
// ⛔ **작업대 평면식을 여기 적지 않는다** — 정본이 둘이 된다. 대신 평면이 필요 없는 자리에
//    물건을 둔다: 밑동을 **손끝 높이 그대로**. 그러면 「접근축과 나란한 물건은 띠를 통째로
//    덮는다」가 좌표 없이 성립한다 (실기 자리에서는 총알 끝이 띠 안에 들어 19.9mm 다).
const T = GRASP_TRUTH.standing.tcpMmDeg;
const down = Math.abs(rotFixedXyz(T[3], T[4], T[5])[2][2]);
ok(down > 0.99, `참값(세움) 접근축이 수직 아래다 (|Z·z| ${down.toFixed(3)} > 0.99) — 위에서 내려와 문다`);

const standing = { baseMm: T.slice(0, 3), lengthMm: ROUND.lengthMm, diaMm: ROUND.diaMm };
const truth = judgeGrasp(T, standing);
ok(truth.reason === null, `참값(세움) 자세를 통과로 판정한다 (${truth.reason})`);
ok(truth.biteMm === JAW.bandMm,
  `축이 접근축과 나란하면 물림이 띠 전체다 (${f1(truth.biteMm)} = ${JAW.bandMm})`
  + ' — 지름으로만 재던 옛 식이면 0.0 이라 「안 잡고 있다」가 된다');

// 개폐 실측이 있는 자세다 — 물건이 집게에 들어갈 굵기였다는 뜻 (지름 교차검증은 아직 아니다)
const openMm = GRASP_TRUTH.standing.gripperPct * 0.4;
ok(openMm > 0 && openMm < JAW.strokeMm,
  `참값(세움) 개폐 실측 ${GRASP_TRUTH.standing.gripperPct}% = ${openMm.toFixed(1)}mm — 행정 ${JAW.strokeMm} 안`);
ok(GRASP_TRUTH.laid.gripperPct === null,
  '눕힌 자세는 개폐를 안 쓴다 (active:false 라 명령값일 수 있다)');

// ── ⑥ 지문이 파지를 덮나 ───────────────────────────────────────────────────
const fp = judgeFingerprint();
ok(fp.covers.includes('grasp.mjs'),
  `판정 지문이 grasp.mjs 를 덮는다 (${fp.covers.length}개 · ${fp.fingerprint})`);

console.log(bad
  ? `\n파지 기하 실패 — ${bad}건`
  : '\n파지 기하 OK — 네 자세가 갈리고, 결측은 차단이고, 주입하면 빨개진다');
process.exit(bad ? 1 : 0);
