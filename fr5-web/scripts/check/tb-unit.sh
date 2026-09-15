#!/usr/bin/env bash
# 터틀봇 브리지 단위 테스트 — 순수 함수(geofence.py)를 조건 하나하나로 본다.
# 로봇도 브리지도 없이 돈다. 통합 검증(tb-bridge-verify.mjs)은 "한 판이 도는가",
# 여기는 "각 조건이 막는가" 다 — fr5-unit.sh 와 같은 갈래.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/TurtleBot/bridge"

out="$(python3 -m unittest discover -p 'test_*.py' 2>&1)" || {
  echo "$out"
  echo "터틀봇 브리지 단위 테스트 실패"
  exit 1
}
echo "  $(echo "$out" | grep -E '^Ran ' || echo '테스트 없음')"

# main.py 가 geofence 를 실제로 부르는가 — 테스트만 초록이고 배선이 빠진 상태를 막는다
for pat in 'import geofence' 'FENCES' 'fence_block' 'start_geofence_watch'; do
  grep -q "$pat" main.py || { echo "main.py 에 '$pat' 배선이 없다 (계약 §지오펜스)"; exit 1; }
done

# 두 클라이언트의 **얼굴이 같은가** — mock 에만 있고 실물에 없는 메서드는 화면에서
# 조용히 죽는다(누르면 아무 일도 안 일어남). 2026-08-19 에 `resetOdom` 이 그렇게 빠졌다.
# D182 부터 둘은 `Shared/data/datasource/tb-client.js`(실물 · 팩토리 반환 객체) ·
# `tb-mock.js`(목업 · 객체)다 — `// @face` 표식 뒤의 멤버를 센다.
python3 - "$ROOT/Shared/data/datasource" <<'PY'
import re, sys
from pathlib import Path
d = Path(sys.argv[1])
def keys(f, indent):
    t = (d / f).read_text(encoding="utf-8")
    body = t[t.index("// @face"):]
    return {m.group(1) for m in re.finditer(r"^\s{%d}(?:async\s+)?([A-Za-z_]\w*)\s*[:(]" % indent, body, re.M)}
h, m = keys("tb-client.js", 4), keys("tb-mock.js", 2)
only_m, only_h = sorted(m - h), sorted(h - m)
if only_m or only_h:
    if only_m: print(f"  FAIL  tb-mock.js 에만 있다: {', '.join(only_m)} — 실기에서 눌러도 아무 일이 없다")
    if only_h: print(f"  FAIL  tb-client.js 에만 있다: {', '.join(only_h)} — 목업 화면이 깨진다")
    sys.exit(1)
print(f"  클라이언트 얼굴 일치 — 메서드 {len(h)}개")
PY
echo "터틀봇 브리지 단위 OK"
