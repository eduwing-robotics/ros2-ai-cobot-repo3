#!/usr/bin/env bash
# 좌표 사슬 게이트 — **브리지(파이썬) 쪽이 SSOT 를 실제로 보고 있나.**
# `frames.sh` 가 화면(JS) 안쪽을 맡고, 여기가 브리지 쪽과 두 언어 사이의 틈을 맡는다.
# 왜 문법 검사로는 못 잡는지는 `frames-chain.py` 머리말 (2026-08-28 실사고).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
echo "== 좌표 사슬 (브리지) =="
# numpy 만 있으면 된다 — cv2 는 `lab_to_user1` 이 안 쓴다 (그래서 갈라 놓은 것이다)
python3 scripts/check/frames-chain.py "$@"
