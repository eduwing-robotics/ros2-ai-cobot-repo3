#!/usr/bin/env bash
# 접촉 검사기 자체를 잰다 — 길 위의 충돌(09-06 사고)을 되살려 빨강이 나는지, 고친 높이는 초록인지 (`sim-contact.mjs`).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(node "$ROOT/scripts/check/sim-contact.mjs" 2>&1)" || { echo "$out" | grep -E '^FAIL|Error' ; echo "접촉 검사 실패"; exit 1; }
echo "$out" | grep -E '^[0-9]+/[0-9]+ PASS' | sed 's/^/  접촉 검사 /'
