#!/usr/bin/env bash
# 시뮬 탭 실렌더 — **`fr5-web-verify.mjs` 가 이 탭을 안 연다** (nav button 을 4개로 단정).
# 왜 따로 도는지는 `sim-tab.mjs` 머리말. 브리지(5158)+vite(5176)를 스스로 띄운다.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
echo "== 시뮬 탭 실렌더 =="
node scripts/check/sim-tab.mjs
