#!/usr/bin/env bash
# 장면 생성 게이트. **`all.sh` 는 `*.sh` 만 글로브한다** — `.mjs` 를 직접 두면 아무 게이트도
# 안 부르는 고아가 된다 (`sim-parity.sh` 와 같은 이유).
#
# 무엇을 재나 — 장면이 **생성물인가**. `config.yaml` 을 고치면 MJCF 가 따라오나, 손파서가
# 진짜 yaml 파서와 같은 값을 읽나, 구역을 빠뜨리면 되읽기 검사가 죽나.
# 로봇·브라우저를 안 쓰고 몇 초에 끝난다.
#
# ⚠ `@mujoco/mujoco` 가 필요하다 — `npm install` 을 안 했으면 여기서 걸린다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [ ! -d node_modules/@mujoco/mujoco ]; then
  echo "  SKIP  @mujoco/mujoco 가 없다 — npm install 을 먼저 한다"
  exit 0
fi
node scripts/check/sim-scene.mjs
