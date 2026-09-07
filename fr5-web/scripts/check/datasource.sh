#!/usr/bin/env bash
# 데이터 경계 게이트 — **화면이 데이터 출처를 모르는가.**
#
# 왜 있나 — `SHARED-CORE.md` §4 와 `ARCHITECTURE.md` §확장성이 `Shared/data/datasource/` 를
# "데이터가 어디서 오는지 아는 유일한 곳" 으로 선언했는데, **그 폴더가 2026-08-04 까지
# 비어 있었다.** 선언만 있고 지키는 것이 없으면 다음 화면이 또 `fetch` 를 직접 부른다.
# 규약은 잊히고 게이트는 안 잊힌다.
#
# 완료 판정(L3 AC#4 · SR_26) — **목업→실물 교체가 파일 한 개.** 그게 되려면
# 화면 쪽에 출처를 아는 코드가 0줄이어야 한다.
# 실패하면 exit 1.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 데이터 경계 =="
FAIL=0
bad() { echo "  FAIL  $1"; FAIL=1; }
note() { echo "  $1"; }

# ① 화면은 출처를 모른다. `Shared/data/datasource/` 만 안다.
#
# **주석은 세지 않는다** — 규약을 설명하는 줄까지 잡으면 규약을 못 적는다.
# **`fr5.hint.*` 는 예외다** — "이 힌트 다시 안 보기" 는 데이터가 아니라 이 브라우저의
# UI 기억이다. 키 접두사로 좁혀 둬서, 배치안·지표를 저장소에 직접 넣는 순간 다시 잡힌다.
strip_comments() { sed 's/^[^:]*:[0-9]*://' ; }
for pat in 'fetch(' 'localStorage' 'sessionStorage' 'XMLHttpRequest' 'new WebSocket'; do
  hits="$(grep -rn --fixed-strings "$pat" Dashboard/src 2>/dev/null \
    | grep -v 'fr5\.hint\.' \
    | awk -F: '{ c = $0; sub(/^[^:]*:[0-9]*:[[:space:]]*/, "", c); if (c !~ /^(\/\/|\*|\/\*)/) print }' \
    || true)"
  if [ -n "$hits" ]; then
    bad "화면이 출처를 직접 안다 — '$pat'"
    echo "$hits" | sed 's/^/        /'
  fi
done
[ "$FAIL" -eq 0 ] && note "Dashboard/src — fetch·저장소·소켓 직접 호출 0건 (UI 기억 fr5.hint.* 제외)"

# ② 경계 파일이 실재한다. 빈 폴더가 SSOT 인 척하는 상태로 돌아가지 않는다.
[ -f Shared/data/datasource/index.js ] || bad "Shared/data/datasource/index.js 가 없다"
[ -f Shared/data/datasource/mock.js ] || bad "Shared/data/datasource/mock.js 가 없다"

# ③ 교체가 **한 줄**인가 — index.js 가 고르기만 하고 로직을 들면 그 판정이 깨진다.
if [ -f Shared/data/datasource/index.js ]; then
  code="$(grep -vc '^\s*\(//.*\)\?$' Shared/data/datasource/index.js || true)"
  [ "$code" -le 2 ] || bad "index.js 가 고르는 것 말고 다른 일을 한다 (코드 ${code}줄 > 2)"
fi

# ④ 계약과 이름이 맞나 · 왕복이 되나 · 지표 목업이 계약 모양인가.
#    **선택 필드가 빠진 판이 반드시 하나 있어야 한다** — 팀원이 처리량 하나만 내도
#    화면이 그날 도는지를 목업이 미리 겪는 것이 이 파일의 절반이다 (SR_25).
node --input-type=module -e "
// localStorage 가 없는 노드에서 돈다 — 최소 흉내만 낸다
const m = new Map();
globalThis.localStorage = {
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: (k) => m.delete(k),
};
const { datasource: ds } = await import('./Shared/data/datasource/index.js');
const { validateLayout } = await import('./Shared/data/layout/schema.js');
const { newScene } = await import('./Shared/data/layout/scenes.js');

let fail = 0;
const bad = (s) => { console.log('  FAIL  ' + s); fail = 1; };

for (const k of ['getLayouts', 'getLayout', 'putLayout', 'deleteLayout', 'getMetrics',
  'getSeries', 'getScenarios', 'getScenario', 'putScenario', 'deleteScenario',
  'getPoseSets', 'getPoseSet', 'putPoseSet', 'deletePoseSet']) {
  if (typeof ds[k] !== 'function') bad('계약 메서드가 없다 — ' + k);
}
if (!ds.source) bad('source 를 안 말한다 — 화면 배지가 무엇을 띄우나 (SR_24)');

// 왕복 — 넣은 것이 같게 나오나. 여기가 틀리면 편집분이 조용히 사라진다.
if ((await ds.getLayouts()).length !== 0) bad('빈 저장소인데 목록이 비어 있지 않다');
const a = newScene('왕복 시험');
await ds.putLayout(a);
const back = await ds.getLayout(a.id);
if (JSON.stringify(back) !== JSON.stringify(a)) bad('넣은 배치안과 꺼낸 배치안이 다르다');
const errs = validateLayout(back);
if (errs.length) bad('꺼낸 배치안이 스키마를 어긴다 — ' + errs.join(' · '));

const list = await ds.getLayouts();
if (list.length !== 1) bad('목록이 1건이 아니다 — ' + list.length);
if (!('id' in list[0] && 'name' in list[0] && 'verified' in list[0])) {
  bad('목록 항목이 계약 모양(id·name·verified)이 아니다');
}
if ('props' in list[0]) bad('목록에 전문이 실렸다 — 계약은 목록만이다');

await ds.deleteLayout(a.id);
if ((await ds.getLayouts()).length !== 0) bad('지운 배치안이 목록에 남았다');

// 지표 목업 — 필수 둘 + '선택이 빠진 판' 이 있어야 한다
const got = [];
for (const id of ['A', 'B']) {
  const r = await ds.getMetrics(id);
  if (!r) { bad('지표 목업이 없다 — ' + id); continue; }
  got.push(r);
  if (!r.source) bad(id + ': source 가 없다 (SR_24)');
  if (!(r.metrics?.throughputPerHour > 0)) bad(id + ': 필수 throughputPerHour 가 없다');
  if (!(r.metrics?.cycleTimeSec?.mean > 0)) bad(id + ': 필수 cycleTimeSec.mean 이 없다');
}
const OPT = ['amrTravelMm', 'waitSec', 'interferences'];
if (got.length === 2 && !got.some((r) => OPT.some((k) => r.metrics[k] === undefined))) {
  bad('선택 필드가 빠진 목업이 없다 — 화면이 빈 칸을 겪어보지 못한다 (SR_25)');
}
if ((await ds.getMetrics('없는배치안')) !== null) bad('없는 배치안의 지표가 null 이 아니다');

console.log(fail ? '  왕복 실패' : '  왕복 OK — 계약 14개 · 넣고 꺼내고 지운다 · 지표 2건(선택 결손 포함)');
process.exit(fail);
" || FAIL=1

echo ""
[ "$FAIL" -eq 0 ] && echo "데이터 경계 OK" || echo "데이터 경계 실패"
exit "$FAIL"
