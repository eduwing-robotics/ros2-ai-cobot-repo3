#!/usr/bin/env bash
# 좌표계 SSOT 게이트 — 문서(`docs/ref/contract/FRAMES.md`)와 모듈(`Shared/data/frames.js`)이
# 갈라지지 않았나 + fail-closed 불변식이 살아 있나. 상세는 `frames.mjs` 머리말.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
echo "== 좌표계 SSOT =="
node scripts/check/frames.mjs
