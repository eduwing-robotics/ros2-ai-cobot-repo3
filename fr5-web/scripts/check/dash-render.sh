#!/usr/bin/env bash
# 대시보드 실렌더 검증을 **자동 게이트에 잠근다** (2026-08-07). `fr5-render.sh`·`ar-render.sh` 와 같은 형제다.
#
# 왜 만들었나 — `dash-web-verify.mjs` 113건은 사람이 다른 터미널에 dev 서버를 켜고
# 손으로 불러야만 돌았다. **손으로 부르는 게이트는 안 도는 게이트다** — 같은 병으로
# AR 겹침이 2176px 어긋난 채 며칠을 살아남았다 (`docs/evidence/2026-08-07/cam-status-hud.md`).
#
#   dash-web-verify.mjs  113건  포트 5187 · 배치안 편집기 + 시나리오 + datasource 경계
#
# `.mjs` 가 자기 vite 를 자기 포트에 띄운다 — 개발용 `:5174` 에 붙지 않는다.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 없으면 **건너뛰지 않고 실패한다.** 조용히 건너뛰는 게이트는 게이트가 아니다.
for tool in node npm; do
  command -v "$tool" >/dev/null || { echo "  $tool 이 없다 — 대시보드 실렌더 게이트를 돌릴 수 없다"; exit 1; }
done

# 전용 포트를 남이 쥐고 있으면 멈춘다. `--strictPort` 라 그냥 죽는데, 그때 원인이 화면처럼 보인다
BUSY=""
for port in 5187; do
  lsof -ti tcp:"$port" >/dev/null 2>&1 && BUSY="$BUSY $port"
done
if [ -n "$BUSY" ]; then
  echo "  게이트 전용 포트를 이미 누가 쓴다:$BUSY  (앞선 실행의 고아다)"
  echo "    lsof -ti tcp:5187 | xargs -r kill -9"
  exit 1
fi

if out="$(node "$ROOT/scripts/check/dash-web-verify.mjs" 2>&1)"; then
  echo "  배치안·시나리오 실렌더 — $(echo "$out" | grep -E '[0-9]+/[0-9]+ 통과' | tail -1 | tr -s ' ')"
  echo "대시보드 실렌더 OK"
else
  echo "$out" | grep -E 'FAIL' || echo "$out" | tail -20
  echo "대시보드 실렌더 실패"
  exit 1
fi
