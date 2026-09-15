#!/usr/bin/env bash
# 정합 게이트 — **같은 물건을 여럿이 볼 때 같은 자리라고 말하나.**
# `frames.sh`(화면)·`frames-chain.sh`(브리지)가 **표**를 검사하고, 여기가 **실물**을 맡는다.
# 왜 문법 검사로는 못 잡는지와 문턱의 근거는 `agree.py` 머리말.
#
# ⚠ **실기가 붙어 있어야 돈다.** 안 붙어 있으면 「못 쟀다」로 끝난다 — 그건 실패가 아니다.
#    그래서 `check/all.sh` 에 넣지 않는다(로봇 없는 세션의 게이트를 붉히면 안 된다).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
eval "$(bash scripts/dev/host.sh)"        # 호스트는 이름으로 푼다 (D164)
export FR5_HOST_IP
python3 scripts/check/agree.py "$@"
