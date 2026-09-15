#!/usr/bin/env bash
# FR5 실렌더·왕복 검증을 **자동 게이트에 잠근다** (2026-08-06).
#
# 여태 `all.sh` 는 `check/*.sh` 만 돌아 `.mjs` 를 아무도 안 불렀다 — 156건이 초록인지
# 사람이 손으로 두 명령을 쳐야만 알았고, 그래서 안 쳤다 (2026-08-05 `/감사` P0 1순위).
# 붙일 수 있게 된 이유는 하나다: **지금 둘 다 초록이다.** 빨간 채로는 영영 못 붙인다.
#
#   fr5-bridge-verify.mjs  93건  포트 5155 · 브리지만 (브라우저 없음)
#   fr5-web-verify.mjs     66건  포트 5157+5176 · 브리지 + vite + Chrome
#                                (2026-08-06 `/감사` UI/UX 로 3건 추가 — 시작 순서 · 삭제 2단계 확인)
#
# 둘 다 자기 브리지를 자기 포트에 띄우고 `FR5_DATA_DIR` 를 임시 폴더로 돌린다 —
# **실기에도 `~/fr5-data/` 에도 손대지 않는다.**
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 없으면 **건너뛰지 않고 실패한다.** 조용히 건너뛰는 게이트는 게이트가 아니다.
for tool in node npm uv; do
  command -v "$tool" >/dev/null || { echo "  $tool 이 없다 — FR5 실렌더 게이트를 돌릴 수 없다"; exit 1; }
done

# 게이트 전용 포트를 **남이 쥐고 있으면 멈춘다** (2026-08-06).
# `.mjs` 는 자기 브리지를 띄운 뒤 `/robots` 가 200 이면 "떴다" 로 본다 — 그런데 남의 브리지도
# 200 을 준다. 앞선 실행이 남긴 고아가 포트를 쥐고 있으면 **이미 로봇에 연결된 화면**에
# 붙어서, "아직 연결 안 됨" 을 전제한 검사들이 화면 탓처럼 깨진다 (실측: 66건 중 2건).
# 개발용 5055 와 겹치지 않는 전용 포트라, 여기 살아 있는 것은 고아뿐이다.
BUSY=""
for port in 5155 5157 5176; do
  lsof -ti tcp:"$port" >/dev/null 2>&1 && BUSY="$BUSY $port"
done
if [ -n "$BUSY" ]; then
  echo "  게이트 전용 포트를 이미 누가 쓴다:$BUSY"
  echo "  앞선 실행의 고아다 — 정리하고 다시 돌린다:"
  echo "    for p in 5155 5157 5176; do lsof -ti tcp:\$p | xargs -r kill -9; done"
  exit 1
fi

FAIL=0
run() {          # $1 표시 이름 · $2 스크립트 · $3 기대 건수
  local out
  if out="$(node "$ROOT/scripts/check/$2" 2>&1)"; then
    echo "  $1 — $(echo "$out" | grep -E '^[0-9]+/[0-9]+' | tail -1)"
  else
    echo "$out" | grep -E '^FAIL' || echo "$out" | tail -20
    echo "  $1 실패"
    FAIL=1
  fi
}

run "브리지 왕복" fr5-bridge-verify.mjs
run "웹 실렌더"  fr5-web-verify.mjs

[ "$FAIL" -eq 0 ] && echo "FR5 실렌더 OK" || echo "FR5 실렌더 실패"
exit "$FAIL"
