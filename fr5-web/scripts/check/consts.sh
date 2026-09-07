#!/usr/bin/env bash
# 기준값 드리프트 검사 — scripts/README.md의 기준값 표와 실제 스크립트 상수가 맞는지.
# 오늘(2026-07-29~30) 이 불일치로 게이트가 여러 번 거짓 실패했다. 그걸 막는 게이트다.
# 실패 시 exit 1.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FAIL=0
note() { printf '  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=1; }

R=scripts/README.md

# 실제 상수 → README 표에 같은 숫자가 있는지
chk() {  # $1=설명 $2=실제값 $3=README에서 찾을 정규식
  if grep -qE "$3" "$R"; then note "$1 = $2"
  else bad "$1 = $2 인데 README 기준값 표와 다르다 (표를 고쳐라)"; fi
}

# 상수 한 개를 꺼낸다. **줄 끝 주석을 반드시 떼어낸다** — `cut -d= -f2` 만 쓰면
# `WANT_SKILLS=18    # 2026-08-10: ...` 의 주석까지 값에 붙어 README 대조가 영원히 어긋난다.
# 2026-08-11 실측: 실제 개수도 표도 `18` 로 맞는데 이 게이트만 빨간불이었다. 상수에 이유를
# 적는 것은 권장 사항이므로(`/스택가드`), 고칠 곳은 주석이 아니라 **꺼내는 쪽**이다.
konst() { grep -m1 "^$2=" "$1" | cut -d= -f2 | awk '{print $1}'; }

A=$(konst scripts/check/assets.sh WANT_ARM_TRIS)
G=$(konst scripts/check/assets.sh WANT_GRIP_TRIS)
chk "삼각형 팔/그리퍼" "$A / $G" "$A / $G"

echo
echo "== .env ↔ 생성된 설정 =="
# Shared/data/config/*.json 은 .env 에서 생성된 산출물이다. 손으로 고치면 다음 생성에서 사라진다.
if command -v node >/dev/null 2>&1; then
  if out="$(node "$ROOT/scripts/build/config.mjs" --check 2>&1)"; then
    printf '%s\n' "$out"
  else
    printf '%s\n' "$out"
    bad ".env 와 Shared/data/config/*.json 이 다르다 → node scripts/build/config.mjs"
  fi
  # 툴 형상은 .env 가 아니라 **STL + gripper-mount.json** 에서 나온다. 메시를 깎거나
  # (`gripper-trim.mjs`) 마운트를 다시 재면 낡는데, 낡은 채로도 **시뮬과 실기 게이트가 둘 다
  # 조용히 돈다** — 둘 다 같은 낡은 파일을 읽으니 대조로도 안 잡힌다. 여기서만 잡힌다.
  if out="$(node "$ROOT/scripts/build/tool-hull.mjs" --check 2>&1)"; then
    printf '  %s\n' "$out"
  else
    printf '%s\n' "$out"
    bad "tool-hull.json 이 형상과 다르다 → node scripts/build/tool-hull.mjs"
  fi
  # 팔 형상·체인은 URDF 에서 나온다. URDF 를 갈면 낡는데, 낡아도 조용히 돈다 (툴과 같은 이유)
  if out="$(node "$ROOT/scripts/build/arm-hull.mjs" --check 2>&1)"; then
    printf '  %s\n' "$out"
  else
    printf '%s\n' "$out"
    bad "arm-hull.json 이 URDF 와 다르다 → node scripts/build/arm-hull.mjs"
  fi
else
  note "node 없음 — 대조를 건너뛴다"
fi

echo
echo "== 브리지 라우트 ↔ vite dev 프록시 =="
# 손으로 미러링하는 목록이라 라우트를 늘리고 vite.config.js 를 안 고치면 **dev 에서만** 조용히
# 404 가 난다. 브리지는 200 인데 화면만 거부한다 — 2026-08-05 `/trajectories`,
# 2026-08-06 `/slots` 로 두 번 겪었다. 세 번째는 이 게이트가 받는다.
if command -v python3 >/dev/null 2>&1; then
  miss="$(python3 - "$ROOT" <<'PY'
import re, sys
from pathlib import Path
root = Path(sys.argv[1])
routes = {"/" + m.group(1) for m in re.finditer(
    r'@app\.(?:get|post|put|delete|websocket)\("/([^/"{]+)', (root / "FR5/bridge/main.py").read_text())}
proxied = set(re.search(r"const API_PATHS = \[(.*?)\]",
    (root / "FR5/vite.config.js").read_text(), re.S).group(1).replace("'", "").replace("\n", "").split(","))
proxied = {p.strip() for p in proxied if p.strip()} | {"/ws"}
print(" ".join(sorted(routes - proxied)))
PY
)"
  if [ -z "$miss" ]; then note "브리지 라우트가 전부 프록시된다"
  else bad "vite dev 프록시에 없는 라우트: $miss  (FR5/vite.config.js 의 API_PATHS 에 더해라)"; fi
else
  note "python3 없음 — 대조를 건너뛴다"
fi

echo
echo "== tb-bridge 포트 (config.yaml 이 정본) =="
# tb 브리지 포트 — 5055 는 FR5, 5056 이 tb 다 (D80). 터틀봇 웹앱·vite 프록시는 없다(D182) —
# FR5 화면이 `?tb=<host:port>` 로 절대 주소를 받으므로 사본이 생길 자리가 없다. 남는 검사는
# 「FR5 와 같은 포트가 아닌가」와 「CORS 울타리가 FR5 포트를 여는가」 둘이다.
TBP=$(sed -n 's/^port:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' TurtleBot/bridge/config.yaml)
FR5P=$(sed -n 's/.*FR5_PORT:-\([0-9]\{1,\}\).*/\1/p' scripts/dev/fr5-dev.sh | head -1)
if [ -z "$TBP" ]; then bad "TurtleBot/bridge/config.yaml 에 port 가 없다"
elif [ "$TBP" = "$FR5P" ]; then
  bad "tb 포트 $TBP 가 FR5 기본 포트와 같다 — 같은 PC 에서 둘 다 못 뜬다 (D80)"
elif ! grep -q "(5055|5176)" TurtleBot/bridge/main.py; then
  bad "tb 브리지 CORS 가 FR5 출처(:5055·dev :5176)를 안 연다 — 「터틀봇」 탭의 쓰기가 전부 403 이다 (계약 ④)"
else note "tb=$TBP · FR5=$FR5P · CORS 쓰기 출처 = FR5"; fi

echo
[ "$FAIL" -eq 0 ] && echo "기준값 OK" || echo "기준값 불일치"
exit "$FAIL"
