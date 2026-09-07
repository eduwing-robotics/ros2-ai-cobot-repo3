#!/usr/bin/env bash
# 킬-실험 계기 게이트. **`all.sh` 는 `*.sh` 만 글로브한다** — `.mjs` 를 직접 두면 고아가 된다.
#
# 무엇을 재나 — `docs/goals/GOAL-grasp-rank.md` 의 **계기가 옳게 도나**. 자세 셋이 통계적으로
# 갈리나, 폭을 2배로 해도 순서가 안 뒤집히나, 뒤집힌 기록을 넣으면 빨개지나.
#
# ⛔ **exit 코드는 「실험이 끝났나」를 말하지 않는다.** 선행 실측·실기 기록이 없으면 `대기` 로
#    찍고 통과한다 — 상시 빨간 게이트는 아무도 안 보기 때문이다(`sim-batch.sh` 와 같은 규약).
#    **완료 판정은 골이 들고 있다** — 판정 넷 전부 PASS + 선행.
# 로봇·브라우저·엔진을 안 쓰고 1초 안에 끝난다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
node scripts/check/grasp-rank.mjs
