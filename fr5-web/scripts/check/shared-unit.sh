#!/usr/bin/env bash
# Shared/ 단위 테스트 — 화면 없이 도는 순수 함수를 조건 하나하나로 본다.
# 실렌더 게이트(`*-web-verify.mjs`)는 "그려지는가", 여기는 "판정이 맞는가" 다.
# 브리지 쪽 `fr5-unit.sh` 와 같은 나눔이고, 같은 원칙이다 — **표준 라이브러리만.**
# `node:test` 는 Node 내장이라 새 의존성 0 (Node 18+).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# 디렉터리 인자는 Node 24 에서 파일로 읽혀 실패한다 — 글로브를 **따옴표로 넘겨**
# Node 가 직접 펼치게 한다 (셸이 펼치면 `**` 가 한 단계만 먹는다).
out="$(node --test "Shared/**/*.test.js" 2>&1)" || {
  echo "$out"
  echo "Shared 단위 테스트 실패"
  exit 1
}
echo "  $(echo "$out" | grep -E '^# tests|^ℹ tests' || echo '테스트 없음')"
echo "  $(echo "$out" | grep -E '^ℹ pass' || true)"
echo "Shared 단위 OK"
