#!/usr/bin/env bash
# 자세 게이트 — **자세 이름이 서로 맞는가.**
#
# 왜 있나 — `POSE_AT` 이 부르는 자세 이름이 `POSES` 에 없어도 화면은 **안 죽는다.**
# `POSES[from] ?? POSES[idle]` 로 조용히 대기 자세가 나가고, 팔은 그냥 안 움직인다.
# 오타 하나가 "저 팔은 원래 저기서 안 움직여" 로 몇 세션을 산다.
#
# 이 검사는 2026-08-04 이전에는 **불가능했다** — 자세표가 React 파일 안에 있어서
# Node 로 못 읽었다. `Shared/data/motion/poses.js` 로 내리면서 생긴 게이트다.
#
# 실패하면 exit 1.

set -uo pipefail
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 자세 =="
node --input-type=module -e "
import { PRESET_POSES as POSES, POSE_AT, FEED_POSE_AT, IDLE, CARRY_BY_ARM,
  poseFor, mixPose, easeAngle, J1_MAX_DPS } from './Shared/data/motion/poses.js';
import { JOINT_LIMITS_DEG, JOINTS, clampPose, outOfLimit } from './Shared/data/motion/limits.js';
import { validatePoseSet, migratePoseSet } from './Shared/data/motion/schema.js';
import { POSE_PRESETS, buildPoseSet } from './Shared/data/motion/presets.js';
import { readFileSync } from 'node:fs';
const { buildScenario, DEFAULT_SCENARIO } = await import('./Shared/data/scenario/presets.js');

let fail = 0;
const seen = new Set();
const bad = (s) => { if (!seen.has(s)) { seen.add(s); console.log('  FAIL  ' + s); } fail = 1; };
const note = (s) => console.log('  ' + s);
const J = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];

// ① 프리셋이 스키마를 통과하는가 — 관절 6개 · 출처 · **한계 안**
for (const p of POSE_PRESETS) {
  const errs = validatePoseSet(buildPoseSet(p.id));
  if (errs.length) bad(p.id + ': ' + errs.join(' · '));
}
note('자세 ' + Object.keys(POSES).length + '개 × 관절 6 — 스키마 통과 (출처·한계 포함)');

// ①-b **한계 사본이 URDF 와 같은가.** 사본을 두면서 사본이 거짓말하지 않게 하는 검사다.
//     \`unscrew.j6 = 300°\` 가 ±175 밖인데 urdf-loader 가 말없이 잘라 아무도 몰랐다 (2026-08-04).
{
  const urdf = readFileSync('Shared/assets/FAIRINO_FR5/fairino5_v6.urdf', 'utf8');
  const seen = {};
  for (const m of urdf.matchAll(/<joint\b([\s\S]*?)<\/joint>/g)) {
    const b2 = m[1];
    const nm = /name=\x22([^\x22]+)\x22/.exec(b2)?.[1];
    const lo = /\blower=\x22([-0-9.eE]+)\x22/.exec(b2);
    const up = /\bupper=\x22([-0-9.eE]+)\x22/.exec(b2);
    if (!nm || !lo || !up) continue;
    seen[nm] = [Math.round(lo[1] * 180 / Math.PI), Math.round(up[1] * 180 / Math.PI)];
  }
  for (const j of JOINTS) {
    const want = seen[j];
    if (!want) { bad('URDF 에 ' + j + ' 가 없다'); continue; }
    const got = JOINT_LIMITS_DEG[j];
    if (want[0] !== got[0] || want[1] !== got[1]) {
      bad(j + ' 한계 사본이 URDF 와 다르다 — 사본 ' + got.join('~') + ' · URDF ' + want.join('~'));
    }
  }
  note('한계 사본 ↔ URDF — 관절 ' + JOINTS.length + '개 일치');
}

// ①-c **자르는 것이 실제로 잘리는가.** 여기가 죽으면 사람이 만든 자세가 조용히 어긋난다
{
  const { pose, clamped } = clampPose({ j6: 300, j2: -90 });
  if (pose.j6 !== 175) bad('j6 300° 가 안 잘렸다 — ' + pose.j6);
  if (pose.j2 !== -90) bad('한계 안인 j2 를 건드렸다 — ' + pose.j2);
  if (!clamped.length) bad('무엇을 잘랐는지 안 알려준다 — 조용히 자르면 300 을 적고 175 를 본다');
  if (!outOfLimit({ j6: 300 }).length) bad('outOfLimit 이 한계 밖을 못 잡는다');
  note('클램프 — 300° → ' + pose.j6 + '° · 무엇을 잘랐는지 같이 낸다');
}

// ② **표가 부르는 이름이 전부 있는가.** 여기가 조용히 틀리는 자리다
for (const [tag, table] of [['조립팔', POSE_AT], ['투입팔', FEED_POSE_AT]]) {
  for (const [ev, pair] of Object.entries(table)) {
    if (!Array.isArray(pair) || pair.length !== 2) { bad(tag + ' ' + ev + ': 자세 두 벌이 아니다'); continue; }
    for (const n of pair) if (!POSES[n]) bad(tag + ' ' + ev + ': 없는 자세를 부른다 — ' + n);
  }
}
for (const [k, n] of Object.entries(IDLE)) if (!POSES[n]) bad('대기 자세가 없다 — ' + k + ' → ' + n);
note('자세표가 부르는 이름 — 전부 POSES 에 있다');

// ③ **던지지 않는다.** 편집 중에는 모르는 사건·빈 상태가 정상이다
for (const st of [null, undefined, {}, { event: 'nope', k: 0.5 }, { event: 'join', k: NaN }]) {
  for (const feed of [true, false]) {
    try {
      const p = poseFor(st, { feed });
      for (const j of J) if (!Number.isFinite(p[j])) bad('poseFor 가 NaN 을 냈다 — ' + JSON.stringify(st));
    } catch (e) { bad('poseFor 가 던졌다 — ' + JSON.stringify(st) + ': ' + e.message); }
  }
}
note('모르는 사건·빈 상태 — 안 던지고 NaN 도 안 낸다');

// ④ 보간이 끝에서 정확히 양 끝이다. 가감속을 넣었어도 0 과 1 은 안 흔들려야 한다
const A = POSES.home; const B = POSES.grip;
for (const [k, want, tag] of [[0, A, '시작'], [1, B, '끝']]) {
  const g = mixPose(A, B, k);
  for (const j of J) if (Math.abs(g[j] - want[j]) > 1e-9) bad('보간 ' + tag + '이 자세와 다르다 — ' + j);
}
// 범위 밖을 넣어도 자른다
for (const k of [-5, 2, NaN]) {
  const g = mixPose(A, B, k);
  for (const j of J) if (!Number.isFinite(g[j])) bad('보간이 범위 밖 k=' + k + ' 에서 NaN');
}
note('보간 — 양 끝이 정확하고 범위 밖을 자른다');

// ⑤ **j1 각속도 상한을 지키는가.** 이게 없으면 목표가 바뀌는 순간 관절이 순간이동한다
const dt = 1 / 60;
let cur = 0;
const step = Math.abs(easeAngle(cur, 179, dt) - cur);
if (step > J1_MAX_DPS * dt + 1e-9) bad('j1 이 한 프레임에 상한을 넘었다 — ' + step.toFixed(2) + '° > ' + (J1_MAX_DPS * dt).toFixed(2) + '°');
// 짧은 쪽으로 돈다 — 350° 목표는 +350 이 아니라 -10 쪽이다
if (easeAngle(0, 350, dt) > 0) bad('j1 이 먼 쪽으로 돈다 (350° 목표에서 양수)');
note('j1 — 한 프레임 상한 ' + (J1_MAX_DPS * dt).toFixed(2) + '° · 짧은 쪽으로 돈다');

// ⑤-b **저장 왕복.** 사람이 만든 자세가 넣은 대로 나오는가 — 여기가 틀리면 조용히 사라진다
{
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
  const { datasource: ds } = await import('./Shared/data/datasource/index.js');
  for (const k of ['getPoseSets', 'getPoseSet', 'putPoseSet', 'deletePoseSet']) {
    if (typeof ds[k] !== 'function') bad('계약 메서드가 없다 — ' + k);
  }
  const P = buildPoseSet('fr5hand', 't1', '왕복 시험');
  P.poses.myPose = { j1: 0, j2: -30, j3: 20, j4: -10, j5: -90, j6: 12, source: 'hand' };
  await ds.putPoseSet(P);
  const back = await ds.getPoseSet('t1');
  if (JSON.stringify(back) !== JSON.stringify(P)) bad('넣은 자세와 꺼낸 자세가 다르다');
  if (validatePoseSet(back).length) bad('꺼낸 보관함이 스키마를 어긴다');
  if (!(await ds.getPoseSets()).some((x) => x.id === 't1')) bad('목록에 안 뜬다');
  if ((await ds.getPoseSets()).some((x) => 'poses' in x)) bad('목록에 전문이 실렸다');
  await ds.deletePoseSet('t1');
  if ((await ds.getPoseSets()).some((x) => x.id === 't1')) bad('지운 보관함이 목록에 남았다');
  // **출처가 없는 옛 자세는 읽으면서 hand 로 채운다** — 빈칸은 \"실측인가?\" 로 읽힌다 (SR_24)
  const old = migratePoseSet({ id: 'o', name: 'o', unit: 'mm-deg',
    poses: { a: { j1: 0, j2: 0, j3: 0, j4: 0, j5: 0, j6: 0 } } });
  if (old.poses.a.source !== 'hand') bad('출처 없는 옛 자세를 hand 로 안 채운다');
  // 출처가 이상하면 거부한다
  const fake = buildPoseSet('fr5hand', 'f', 'f');
  fake.poses.home = { ...fake.poses.home, source: '실측' };
  if (!validatePoseSet(fake).length) bad('모르는 출처를 거부하지 않는다');
  note('보관함 — 넣고 꺼내고 지운다 · 출처 hand|taught 만 받는다');
}

// ⑥ **시나리오의 사건이 자세로 이어지나.** 이어지지 않은 사건에서는 팔이 대기 자세로 선다.
//    이건 설계상 그럴 수 있어서 **실패로 만들지 않는다 — 대신 반드시 적는다.**
//    안 적으면 \"저 팔은 원래 저기서 안 움직인다\" 가 검증 없이 굳는다.
// **저장소가 아니라 프리셋을 읽는다** — 판정 대상은 출하되는 기본값이다
const series = buildScenario(DEFAULT_SCENARIO).events;
const evs = [...new Set(series.map((e) => e.event).filter(Boolean))];
const idleAt = { 조립팔: evs.filter((e) => !POSE_AT[e]), 투입팔: evs.filter((e) => !FEED_POSE_AT[e]) };
for (const [tag, list] of Object.entries(idleAt)) {
  if (list.length) note('※ ' + tag + '이 대기 자세로 서 있는 사건 — ' + list.join(', '));
}
// 반대로 **시나리오에 없는 사건을 표가 들고 있으면** 그건 죽은 칸이다
for (const [tag, table] of [['조립팔', POSE_AT], ['투입팔', FEED_POSE_AT]]) {
  const dead = Object.keys(table).filter((e) => !evs.includes(e));
  if (dead.length) bad(tag + ' 자세표에 시나리오가 안 부르는 사건 — ' + dead.join(', '));
}
// 무엇을 드는가도 같은 검사를 받는다
for (const e of Object.keys(CARRY_BY_ARM)) {
  if (!evs.includes(e)) bad('CARRY_BY_ARM 이 시나리오에 없는 사건을 든다 — ' + e);
}

console.log('');
console.log(fail ? '자세 실패' : '자세 OK');
process.exit(fail);
" || FAIL=1

# ⑦ **관제화면에 자세를 다시 심지 않는다.** 여기서 내린 이유가 그것이다 —
#    화면 안에 있으면 위 검사가 통째로 불가능해진다.
#
#    **`Dashboard/src` 만 본다.** `AR/src/screens/robot.js` 의 `BENT`·영점은 로봇 뷰어
#    페이지의 **버튼 두 개**지 조립 라인의 동작 데이터가 아니다 — 여기로 끌어오면
#    시나리오 자세표에 시나리오가 안 부르는 칸이 생긴다(⑥ 이 그걸 실패로 잡는다).
hits="$(grep -rnE "j1: *-?[0-9]+.*j2: *-?[0-9]+" Dashboard/src 2>/dev/null \
  | awk -F: '{ c = $0; sub(/^[^:]*:[0-9]*:[[:space:]]*/, "", c); if (c !~ /^(\/\/|\*|\/\*)/) print }' \
  || true)"
if [ -n "$hits" ]; then
  echo "  FAIL  화면 코드에 자세가 박혀 있다 — Shared/data/motion/poses.js 로 옮긴다"
  echo "$hits" | sed 's/^/        /'
  FAIL=1
else
  echo "  관제화면에 박힌 자세 0건 (자세는 데이터다)"
fi
ar="$(grep -rlE "j1: *-?[0-9]+.*j2: *-?[0-9]+" AR/src FR5/src 2>/dev/null || true)"
if [ -n "$ar" ]; then
  echo "  ※ 조립 라인 밖에서 자세를 든 화면 — $(echo "$ar" | tr '\n' ' ')(뷰어 데모용 · 이 게이트 밖)"
fi

exit "${FAIL:-0}"
