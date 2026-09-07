#!/usr/bin/env bash
# FR5 브리지 단위 테스트 — 순수 함수(safety.py)를 조건 하나하나로 본다.
# 통합 검증(fr5-bridge-verify.mjs)은 "한 판이 도는가", 여기는 "각 조건이 막는가" 다.
# 표준 라이브러리 unittest 만 쓴다 — 새 의존성 0.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/FR5/bridge"

out="$(python3 -m unittest discover -p 'test_*.py' 2>&1)" || {
  echo "$out"
  echo "브리지 단위 테스트 실패"
  exit 1
}
echo "  $(echo "$out" | grep -E '^Ran ' || echo '테스트 없음')"
echo "브리지 단위 OK"
