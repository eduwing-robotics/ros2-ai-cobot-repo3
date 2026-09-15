#!/usr/bin/env bash
# 시나리오 게이트 — **시간축이 데이터로 왕복하는가 · 사건이 이름만 드는가.**
#
# 왜 있나 — `stateAt` 은 **어떤 입력에도 안 던진다**(`timeline.sh` ①). 그건 편집 중을 위한
# 설계지만, 부작용으로 **틀린 시나리오가 화면을 안 죽이고 조용히 아무것도 안 한다.**
# 재생 막대는 멀쩡히 뜨고 시각도 흐르는데 아무도 안 움직인다 — 그게 여기서 잡을 것이다.
#
# 그리고 **사건에 좌표나 관절 각이 들어오는 것**을 막는다. 들어오는 순간 그 시나리오는
# 배치안 하나에 묶이고, 그 사실은 **F8(배치안 A·B 비교)을 돌려 볼 때까지 안 드러난다.**
# 규약(`SHARED-CORE.md` §1.5·§1.6·§1.7)만 적어 두면 다음 화면이 또 박는다.
#
# 실패하면 exit 1.

set -uo pipefail
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 시나리오 =="
node --input-type=module -e "
const m = new Map();
globalThis.localStorage = {
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: (k) => m.delete(k),
};
const { datasource: ds } = await import('./Shared/data/datasource/index.js');
const { validateScenario, emptyScenario, sortEvents } = await import('./Shared/data/scenario/schema.js');
const { SCENARIO_PRESETS, buildScenario } = await import('./Shared/data/scenario/presets.js');
const { stateAt, cycleSecOf } = await import('./Shared/data/timeline/timeline.js');
const { buildPreset } = await import('./Shared/data/layout/presets.js');

let fail = 0;
const bad = (s) => { console.log('  FAIL  ' + s); fail = 1; };
const note = (s) => console.log('  ' + s);

// ① 계약 메서드와 왕복. 여기가 틀리면 **편집분이 조용히 사라진다**
for (const k of ['getScenarios', 'getScenario', 'putScenario', 'deleteScenario']) {
  if (typeof ds[k] !== 'function') bad('계약 메서드가 없다 — ' + k);
}
const a = { ...emptyScenario('t1', '왕복 시험'), events: [{ tSec: 0, event: 'x', station: 'in' }] };
await ds.putScenario(a);
const back = await ds.getScenario('t1');
if (JSON.stringify(back) !== JSON.stringify(a)) bad('넣은 시나리오와 꺼낸 시나리오가 다르다');
if (validateScenario(back).length) bad('꺼낸 시나리오가 스키마를 어긴다');
const list = await ds.getScenarios();
if (!list.some((x) => x.id === 't1')) bad('목록에 안 뜬다');
if (list.some((x) => 'events' in x)) bad('목록에 전문이 실렸다 — 계약은 목록만이다');
await ds.deleteScenario('t1');
if ((await ds.getScenarios()).some((x) => x.id === 't1')) bad('지운 시나리오가 목록에 남았다');
note('계약 4개 · 넣고 꺼내고 지운다');

// ② **사건은 이름과 숫자만 든다.** 좌표·관절 각을 거부하는가 —
//    이걸 놓치면 시나리오가 배치안 하나에 묶여 F8 이 무너진다
const REJECT = [
  ['좌표', { tSec: 0, posMm: [1, 2, 3] }],
  ['좌표(다른 이름)', { tSec: 0, xyz: [1, 2] }],
  ['관절 각', { tSec: 0, j1: 12 }],
  ['자세', { tSec: 0, pose: 'grip' }],
  ['모르는 칸', { tSec: 0, whatever: 1 }],
  ['tSec 없음', { event: 'x' }],
  ['tSec 음수', { tSec: -3 }],
  ['amr 짝이 안 맞음', { tSec: 0, amr: 'amr1' }],
  ['station 이 숫자', { tSec: 0, station: 7 }],
  ['stage 가 소수', { tSec: 0, stage: 1.5 }],
];
for (const [tag, ev] of REJECT) {
  const S = { ...emptyScenario('r', 'r'), events: [ev] };
  if (!validateScenario(S).length) bad('거부해야 하는데 통과했다 — ' + tag);
}
// 반대로 **정상 사건을 거부하면** 편집이 막힌다
const OK = { tSec: 4, event: 'pick', station: 'pile', armAt: 'fuze', amr: 'amr1', amrAt: 'pile', stage: 3 };
const okErrs = validateScenario({ ...emptyScenario('o', 'o'), events: [OK] });
if (okErrs.length) bad('정상 사건을 거부했다 — ' + okErrs.join(' · '));
note('사건 칸 — 거부 ' + REJECT.length + '종 · 정상 통과');

// ③ 프리셋이 성립하는가. **게이트는 저장소가 아니라 출하되는 기본값을 본다**
for (const p of SCENARIO_PRESETS) {
  const S = buildScenario(p.id);
  const errs = validateScenario(S);
  if (errs.length) { bad(p.id + ': 프리셋이 스키마를 어긴다 — ' + errs.join(' · ')); continue; }
  // **빈 시나리오는 사건 0 개가 정상이다** — 빈 방이 가리키는 것이라 사건이 없어야 한다
  if (!S.events.length && p.id !== 'blank') bad(p.id + ': 사건이 없다');
  if (!S.events.length) { note(p.id + ' — 사건 0개 (빈 방용 · 재생 막대가 안 뜬다)'); continue; }
  // 시각순으로 적혀 있나 — \`stateAt\` 은 스스로 정렬하지만 **사람이 고칠 파일**이다
  if (JSON.stringify(S.events) !== JSON.stringify(sortEvents(S.events))) {
    bad(p.id + ': 사건이 시각순이 아니다');
  }
  // 재생이 실제로 도는가 — 0 초부터 끝까지 훑어 던지지 않고 진행이 뒤로 안 간다
  let prev = -1;
  for (let t = 0; t <= cycleSecOf(S.events); t += 0.5) {
    const st = stateAt(S.events, t);
    if (st.empty) { bad(p.id + ': @' + t + ' 가 빈 상태다'); break; }
    if (st.u < prev - 1e-9) { bad(p.id + ': 진행이 뒤로 갔다 @' + t); break; }
    prev = st.u;
  }
  note(p.id + ' — ' + S.events.length + '개 사건 · ' + cycleSecOf(S.events) + '초 · 재생 OK');
}

// ④ **가리키는 시나리오가 없어도 화면이 안 죽는다.** 지워진 id 를 든 배치안이 정상이다
const L = { ...buildPreset('cell', 'g1', 'g'), scenarioId: '지워진시나리오' };
await ds.putLayout(L);
const r = await ds.getSeries('g1');
if (!r || !r.series.length) bad('없는 시나리오를 가리키는데 프리셋으로 안 떨어진다');
if (!r.source) bad('해결 결과에 source 가 없다 (SR_24)');
await ds.deleteLayout('g1');

// ⑤ 저장분이 깨져도 **빈 목록으로 시작한다** — 배치안 read() 와 같은 규칙
localStorage.setItem('fr5.scenarios', '{{{깨진');
if ((await ds.getScenarios()).length !== SCENARIO_PRESETS.length) {
  bad('깨진 저장분에서 프리셋 ' + SCENARIO_PRESETS.length + '건으로 안 떨어진다');
}
localStorage.removeItem('fr5.scenarios');
note('없는 id · 깨진 저장분 — 프리셋으로 떨어진다');

// ⑤-c **배치안이 가리키는 시나리오를 실제로 받는가.** 프리셋 id 를 못 알아보면
//      빈 방이 `blank` 을 가리켜도 조립 라인으로 떨어져 **사건 13개가 딸려 온다**
//      (2026-08-04 실사용에서 막힌 자리다).
for (const [pid, wantScn, wantEv] of [['empty', 'blank', 0], ['cell', 'assembly49', 13]]) {
  const L2 = buildPreset(pid, 'r-' + pid, pid);
  if (L2.scenarioId !== wantScn) bad(pid + ' 배치안이 가리키는 시나리오 — ' + L2.scenarioId);
  await ds.putLayout(L2);
  const got = await ds.getSeries('r-' + pid);
  if (got.series.length !== wantEv) {
    bad(pid + ' 이 받는 사건 수 — ' + got.series.length + ' (기대 ' + wantEv + ')');
  }
  await ds.deleteLayout('r-' + pid);
}
note('배치안 → 시나리오 — 빈 방은 사건 0개 · 조립 라인은 13개');

// ⑥ **시나리오가 부르는 자리가 조립 라인에 있는가.** \`timeline.sh\` ⑩ 과 같은 검사를
//    프리셋 쪽에서 한 번 더 한다 — 여기서 어긋나면 재생이 조용히 아무것도 안 한다
//    ⛔ **짝을 손으로 하나만 적지 않는다** — 2026-08-20 에 \`realmap\` 이 목록 밖이라
//    그 배치안이 \`scenarioId: 'blank'\` · \`stations: []\` 인 채로 게이트가 초록이었다.
//    시나리오는 12사건 72초로 멀쩡한데 화면은 「재생할 사이클이 없어요」였다.
//    **자리를 쓰는 배치안이 늘면 여기 한 줄을 같이 늘린다.**
for (const [pid, sid, label] of [['cell', 'assembly49', '조립 라인'],
                                 ['realmap', 'assembly-amr', '실맵 3판'],
                                 ['defense-line', 'assembly-conv', '방산 라인(연출)']]) {
  const L = buildPreset(pid);
  if (L.scenarioId !== sid) bad(label + ' 배치안이 가리키는 시나리오 — ' + L.scenarioId + ' (기대 ' + sid + ')');
  const have = new Set(L.stations.map((s) => s.id));
  const used = new Set();
  for (const e of buildScenario(sid).events) {
    if (e.station) used.add(e.station);
    if (e.armAt) used.add(e.armAt);
  }
  for (const id of used) if (!have.has(id)) bad(label + ' 에 없는 자리를 부른다 — ' + id);
  for (const id of have) if (!used.has(id)) bad(label + ' 에 만들어 놓고 안 쓰는 자리 — ' + id);
  note('자리 ' + used.size + '개 — ' + sid + ' 와 ' + label + ' 이 서로 맞는다');
}

console.log('');
console.log(fail ? '시나리오 실패' : '시나리오 OK');
process.exit(fail);
" || FAIL=1

# ⑦ **시나리오를 코드로 되돌리지 않는다.** 상수 배열로 돌아가면 저장·편집이 통째로 죽는다.
hits="$(grep -rnE "tSec: *[0-9]+.*(event|station):" Shared/data/datasource Dashboard/src 2>/dev/null \
  | awk -F: '{ c = $0; sub(/^[^:]*:[0-9]*:[[:space:]]*/, "", c); if (c !~ /^(\/\/|\*|\/\*)/) print }' \
  || true)"
if [ -n "$hits" ]; then
  echo "  FAIL  시나리오가 코드로 박혔다 — Shared/data/scenario/presets.js 로 옮긴다"
  echo "$hits" | sed 's/^/        /'
  FAIL=1
else
  echo "  datasource·관제화면에 박힌 사건 0건 (시나리오는 데이터다)"
fi

exit "${FAIL:-0}"
