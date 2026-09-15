#!/usr/bin/env bash
# 시뮬↔실기 판정 대조 게이트. **`all.sh` 는 `*.sh` 만 글로브한다** — `.mjs` 를 직접 두면
# 아무 게이트도 안 부르는 고아가 된다(GAP «`.mjs` 를 어느 `.sh` 도 안 부른다» 와 같은 자리).
# 그래서 `fr5-render.sh` 와 같은 모양의 래퍼를 둔다.
#
# 무엇을 재나 — 시뮬의 「위반」과 `safety.check_workspace` 의 「거부」가 자세 200개에서
# 같은 답을 내나. 로봇·브라우저·포트를 안 쓰고 1초 안에 끝나므로 `--fast` 에서도 뺀 게 없다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
node scripts/check/sim-parity.mjs
