#!/usr/bin/env bash
# 파지 기하 게이트. **`all.sh` 는 `*.sh` 만 글로브한다** — `.mjs` 를 직접 두면 아무 게이트도
# 안 부르는 고아가 된다 (`sim-parity.sh`·`sim-scene.sh` 와 같은 이유).
#
# 무엇을 재나 — 파지 기하 계측이 **네 자세를 가르나**(맞음·높음·낮음·빗나감), 결측이면
# 차단하나, 그리고 **결함을 주입하면 빨개지나**. 제원·치수는 전부 실측 정본에서 읽는다.
# 로봇·브라우저·엔진을 안 쓰고 1초 안에 끝나므로 `--fast` 에서도 뺀 게 없다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
node scripts/check/sim-grasp.mjs
