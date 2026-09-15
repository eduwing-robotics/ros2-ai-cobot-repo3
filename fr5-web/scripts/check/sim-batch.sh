#!/usr/bin/env bash
# 배치 게이트. **`all.sh` 는 `*.sh` 만 글로브한다** — `.mjs` 를 직접 두면 고아가 된다.
#
# 무엇을 재나 — N벌이 완주해 세 파일이 나오나, 같은 seed 가 같은 바이트를 내나, 그리고
# **결함을 주입하면 위반이 잡히나**. 「이벤트 0건」이 깨끗한 건지 안 재는 건지 가르는 게 핵심이다.
# 로봇·브라우저를 안 쓰고 몇 초에 끝난다. 96벌 실측은 사람이 돌려 evidence 에 남긴다.
#
# ⚠ `@mujoco/mujoco` 와 `Sim/fixtures/` 가 있어야 돈다 — 픽스처는 실기에서 굽는다
#    (`node scripts/dev/sim-fixture.mjs`). 없으면 **잰 척하지 않고 SKIP** 한다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [ ! -d node_modules/@mujoco/mujoco ]; then
  echo "  SKIP  @mujoco/mujoco 가 없다 — npm install 을 먼저 한다"; exit 0
fi
if [ ! -f Sim/fixtures/fr5-lab-a.json ]; then
  echo "  SKIP  Sim/fixtures/fr5-lab-a.json 이 없다 — 로봇을 붙이고 node scripts/dev/sim-fixture.mjs"; exit 0
fi
node scripts/check/sim-batch.mjs
