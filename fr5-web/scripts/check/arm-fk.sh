#!/usr/bin/env bash
# 팔 FK 게이트. **`all.sh` 는 `*.sh` 만 글로브한다** — `.mjs` 를 직접 두면 아무 게이트도
# 안 부르는 고아가 된다 (`sim-scene.sh` 와 같은 이유).
#
# 무엇을 재나 — `safety.link_poses_mm`(손으로 짠 FK)이 같은 URDF 를 읽는 무조코와
# 자세 2000개에서 같은가. 틀리면 팔 판정이 통째로 엉뚱한 자리를 막는다.
# 로봇을 안 쓰고 몇 초에 끝난다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [ ! -d node_modules/@mujoco/mujoco ]; then
  echo "  SKIP  @mujoco/mujoco 가 없다 — npm install 을 먼저 한다"
  exit 0
fi
node scripts/check/arm-fk.mjs
