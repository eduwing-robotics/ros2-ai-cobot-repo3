#!/usr/bin/env bash
# 시간축 게이트 — **`stateAt` 이 결정적이고 안 던지는가.**
#
# 왜 있나 — 시간 함수는 **조용히 틀린다.** 화면은 계속 부드럽게 움직이는데 값이 어긋나
# 있으면 아무도 모른다. 그리고 이 함수 위에 사다리 3·4 (F8·F10) 가 통째로 얹힌다 —
# **같은 t 를 두 번 물어 다른 값이 나오면 되감기도 나란히 비교도 성립하지 않는다.**
#
# 여기서 안 잡히면 다음에 잡히는 자리는 "발표 중에 탄두가 되살아난다" 다.
# 실패하면 exit 1.

set -uo pipefail
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 시간축 =="
node --input-type=module -e "
import { stateAt, cycleSecOf } from './Shared/data/timeline/timeline.js';

let fail = 0;
const bad = (s) => { console.log('  FAIL  ' + s); fail = 1; };
const note = (s) => console.log('  ' + s);
const eq = (a, b, s) => { if (a !== b) bad(s + ' — ' + a + ' ≠ ' + b); };

const S = [
  { tSec: 0,  event: 'feed',  station: 'store', stage: 0 },
  { tSec: 7,  event: 'pick',  station: 'in' },
  { tSec: 11, event: 'cut',   station: 'in',   stage: 1 },
  { tSec: 15, event: 'cut',   station: 'meas', stage: 2 },
  { tSec: 20, event: 'place', station: 'out',  stage: 3 },
  { tSec: 24, event: 'done',  station: 'out' },
];

// ① 안 던진다 — **편집 중에는 잠깐 틀린 상태가 정상이다**
const nasty = [
  ['빈 배열', []], ['null', null], ['객체', {}], ['숫자 배열', [1, 2]],
  ['tSec 없음', [{ event: 'x' }]], ['한 개', [{ tSec: 5, station: 'in' }]],
  ['뒤섞임', [S[3], S[0], S[5]]], ['같은 시각 둘', [{ tSec: 0, station: 'a' }, { tSec: 0, station: 'b' }]],
];
for (const [name, s] of nasty) {
  for (const t of [-5, 0, 0.5, 1e9, NaN, undefined]) {
    try { stateAt(s, t); } catch (e) { bad('던졌다 — ' + name + ' @t=' + t + ': ' + e.message); }
  }
}
note('망가진 입력 ' + nasty.length + '종 × 시각 6개 — 안 던진다');

// ② 결정적 — 같은 t 를 두 번 물으면 같은 값. **되감기가 성립하는 조건이다**
for (const t of [0, 3.7, 11, 19.999, 24]) {
  eq(JSON.stringify(stateAt(S, t)), JSON.stringify(stateAt(S, t)), '결정적이지 않다 @' + t);
}

// ③ 범위 밖은 자른다
eq(stateAt(S, -100).tSec, 0, '음수 시각을 안 잘랐다');
eq(stateAt(S, 1e6).tSec, 24, '끝을 넘은 시각을 안 잘랐다');
eq(cycleSecOf(S), 24, '사이클 길이');
eq(cycleSecOf([]), 0, '빈 사이클 길이');
eq(stateAt([], 5).empty, true, '빈 목록인데 empty 가 아니다');

// ④ 진행이 뒤로 안 간다 (단조)
let prev = -1;
for (let t = 0; t <= 24; t += 0.25) {
  const u = stateAt(S, t).u;
  if (u < prev - 1e-9) { bad('진행이 뒤로 갔다 @' + t); break; }
  prev = u;
}

// ⑤ **탄두는 되살아나지 않는다** — stage 를 안 적은 사건이 직전 값을 이어야 한다.
//    'pick'(t=7) 과 'done'(t=24) 에 stage 가 없다. 여기가 이 함수에서 제일 잘 틀리는 자리다.
let last = -1;
for (let t = 0; t <= 24; t += 0.25) {
  const g = stateAt(S, t).warheadStage;
  if (g < last) { bad('탄두 단계가 되돌아갔다 @' + t + ' (' + last + ' → ' + g + ')'); break; }
  last = g;
}
eq(stateAt(S, 9).warheadStage, 0, 'stage 를 안 적은 구간이 직전 값을 안 잇는다');
eq(stateAt(S, 24).warheadStage, 3, '마지막 단계');

// ⑥ 구간과 보간 — 작업물이 from→to 사이 k 지점에 있다
const m = stateAt(S, 9);
eq(m.event, 'pick', '@9 의 사건');
eq(m.from, 'in', '@9 의 출발');
eq(m.to, 'in', '@9 의 도착');
const g2 = stateAt(S, 3.5);
eq(g2.from, 'store', '@3.5 의 출발');
eq(g2.to, 'in', '@3.5 의 도착');
eq(Math.round(g2.k * 100), 50, '@3.5 의 보간(7초 구간의 절반)');
eq(stateAt(S, 0).k, 0, '시작점의 k');
eq(stateAt(S, 24).k, 1, '끝점의 k');
// 같은 시각에 사건이 둘이어도 0 으로 안 나눈다
const dup = stateAt([{ tSec: 0, station: 'a' }, { tSec: 0, station: 'b' }], 0);
if (!Number.isFinite(dup.k)) bad('같은 시각 두 사건에서 k 가 숫자가 아니다');

// ⑦ **입력을 안 건드린다** — 정렬한다고 원본을 뒤집으면 부른 쪽 배열이 바뀐다
const orig = [S[3], S[0], S[5]];
const snap = JSON.stringify(orig);
stateAt(orig, 5);
eq(JSON.stringify(orig), snap, '입력 배열을 건드렸다');

// ⑧ 시계를 안 본다 — 있으면 되감기·나란히 비교가 깨진다
// **주석은 안 센다** — 규약을 설명하는 줄까지 잡으면 규약을 못 적는다 (datasource.sh 와 같은 규칙)
const src = (await import('node:fs')).readFileSync('Shared/data/timeline/timeline.js', 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
for (const banned of ['Date.now', 'performance.now', 'Math.random', 'new Date']) {
  if (src.includes(banned)) bad('시간 함수가 시계/난수를 본다 — ' + banned);
}
note('결정적 · 단조 · 입력 불변 · 시계 안 봄');

console.log('');
console.log(fail ? '시간축 실패' : '시간축 OK');
process.exit(fail);
" || FAIL=1

# ⑨ **재생은 명령이 아니다.** 움직이는 로봇을 화면에 두면 "이걸 실기로 보내면 되잖아" 가
#    반드시 나온다. Dashboard 는 명령을 안 보낸다 (D36 · 하드 룰 4) — 계약도
#    "재생은 실기 명령을 보내지 않는다" 라고 못 박았다. 경로가 **생기는 것 자체**를 막는다.
hits="$(grep -rnE "POST|/servo|/move|'/arm'|\"/arm\"|jog|estop" Dashboard/src 2>/dev/null \
  | awk -F: '{ c = $0; sub(/^[^:]*:[0-9]*:[[:space:]]*/, "", c); if (c !~ /^(\/\/|\*|\/\*)/) print }' \
  || true)"
if [ -n "$hits" ]; then
  echo "  FAIL  관제화면에 로봇 명령 경로가 생겼다 (D36)"
  echo "$hits" | sed 's/^/        /'
  FAIL=1
else
  echo "  관제화면 — 로봇 명령 경로 0건 (재생은 읽기다)"
fi
# ⑩ **시나리오와 배치안이 서로를 아는가.**
#    series 는 스테이션 **이름**만 들고 배치안이 좌표를 안다 — 그 이름이 어긋나면
#    재생이 조용히 아무것도 안 한다. 그리고 **만들어 놓고 안 쓰는 스테이션**도 잡는다:
#    `fuze`(신관 트레이)를 놓고 시나리오가 한 번도 안 불러서 화면에 안 나왔다 (2026-08-04).
node --input-type=module -e "
const { PRESETS, buildPreset } = await import('./Shared/data/layout/presets.js');
const { buildScenario, DEFAULT_SCENARIO } = await import('./Shared/data/scenario/presets.js');

let fail = 0;
const bad = (s) => { console.log('  FAIL  ' + s); fail = 1; };
// **저장소가 아니라 프리셋을 읽는다** — 게이트는 브라우저마다 다른 저장분이 아니라
// **출하되는 기본값**을 판정해야 한다 (2026-08-04 · 시나리오가 데이터가 되면서 갈랐다).
const series = buildScenario(DEFAULT_SCENARIO).events;
const used = new Set();
for (const e of series) { if (e.station) used.add(e.station); if (e.armAt) used.add(e.armAt); }

for (const p of PRESETS) {
  const L = buildPreset(p.id);
  const have = new Set((L.stations ?? []).map((s) => s.id));
  // **시나리오가 부르는 이름은 그 배치안에 있어야 한다** — 없으면 조용히 안 움직인다.
  //   단 프리셋마다 시나리오가 다를 수 있으므로, **하나도 안 맞는 배치안**만 잡는다
  //   (빈 방은 스테이션이 없는 것이 정상이라 뺀다).
  //   \`legacy\` 로 표시한 프리셋은 뺀다 — 옛 무대를 알고 남겨 둔 것이지 실수가 아니다.
  if (have.size && !p.legacy && ![...used].some((u) => have.has(u))) {
    bad(p.id + ': 시나리오가 부르는 스테이션이 하나도 없다 — 재생이 아무것도 안 한다');
  }
  if (p.legacy) console.log('  ' + p.id + ': legacy — 시나리오가 안 돈다 (알고 남긴 것)');
  // **셀은 시나리오의 무대다** — 여기 만들어 놓고 안 쓰는 스테이션은 화면에 안 나온다
  if (p.id === 'cell') {
    for (const id of have) if (!used.has(id)) bad('cell: 시나리오가 안 쓰는 스테이션 — ' + id);
    for (const id of used) if (!have.has(id)) bad('cell: 시나리오가 없는 스테이션을 부른다 — ' + id);
  }
}
// ⑪ **시나리오가 부르는 AMR 은 경로가 그 자리를 지나야 한다.**
//    재생이 경로를 따라가므로(2026-08-04), 경로가 목적지를 안 지나면 로봇이 엉뚱한 데서
//    멈추거나 직선으로 떨어진다. 전에는 amr1 경로가 목적지 pile 에서 **1664mm** 빗나가
//    있었는데, 재생이 경로를 안 봐서 아무도 몰랐다. 화면 하단이 적는 길이도 그만큼 거짓이었다.
{
  const { nearestU } = await import('./Shared/data/layout/schema.js');
  const cell = buildPreset('cell');
  const stAt = Object.fromEntries((cell.stations ?? []).map((s) => [s.id, s.posMm]));
  const want = new Map();
  for (const e of series) {
    if (!e.amr || !e.amrAt) continue;
    if (!want.has(e.amr)) want.set(e.amr, new Set());
    want.get(e.amr).add(e.amrAt);
  }
  for (const [id, stations] of want) {
    const a = (cell.amrs ?? []).find((x) => x.id === id);
    if (!a) { bad('시나리오가 없는 AMR 을 부른다 — ' + id); continue; }
    for (const sid of stations) {
      const at = stAt[sid];
      if (!at) { bad(id + ': 없는 자리로 보낸다 — ' + sid); continue; }
      const n = nearestU(a.waypointsMm, at);
      if (!n) { bad(id + ': 경로가 비었다'); continue; }
      if (n.offMm > a.reachMm) {
        bad(id + ' 경로가 ' + sid + ' 를 안 지난다 — ' + n.offMm + 'mm 빗나감 (도달 ' + a.reachMm + 'mm)');
      }
    }
  }
  console.log('  AMR 경로 — 시나리오가 부르는 ' + want.size + '대가 자기 자리를 지난다');
}

console.log(fail ? '  시나리오↔배치안 실패' : '  시나리오↔배치안 OK — 이름이 서로 맞고 남는 스테이션이 없다');
process.exit(fail);
" || FAIL=1

exit "${FAIL:-0}"
