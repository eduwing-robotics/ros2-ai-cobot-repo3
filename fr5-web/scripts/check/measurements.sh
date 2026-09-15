#!/usr/bin/env bash
# 현실값 전람 + 출처 검사. 본체는 `measurements.mjs` — 여기는 all.sh 가 집어 갈 껍데기다.
#
# **브라우저도 로봇도 필요 없다.** 순수 읽기라 언제 불러도 되고, 값을 찾을 때 제일 먼저 부른다.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$ROOT/scripts/check/measurements.mjs"
