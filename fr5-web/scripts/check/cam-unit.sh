#!/usr/bin/env bash
# 카메라 관문 단위 테스트 — 깊이 유효 판정을 조건 하나하나로 본다 (fr5-unit.sh 와 같은 모양).
# **카메라 없이 돈다** — 그러려고 `depth.py` 를 `camera.py` 에서 갈라 놨다. 판정 규칙을
# 실기에서만 확인하면 규칙이 늦게 틀리고, 실기는 늘 늦게 온다.
# 표준 라이브러리 unittest + numpy 만 쓴다 (numpy 는 깊이 40만 픽셀을 세는 데 필요하다).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/Vision/bridge"

out="$(python3 -m unittest discover -p 'test_*.py' 2>&1)" || {
  echo "$out"
  echo "카메라 관문 단위 테스트 실패"
  exit 1
}
echo "  $(echo "$out" | grep -E '^Ran ' || echo '테스트 없음')"

# 자동 재캘리브 가드 — **소프트웨어가 자기 SSOT 를 덮는 코드**라 가드가 잡는지를 여기서 본다.
# 사진도 카메라도 안 쓴다(`test_watch_calib.py` 머리말) — `calib-shots/` 는 gitignore 라
# 그걸 읽으면 다른 기계에서 **조용히 건너뛰는 시험**이 된다.
cd "$ROOT"
out2="$(python3 -m unittest scripts.map.test_watch_calib 2>&1)" || {
  echo "$out2"
  echo "자동 재캘리브 가드 실패"
  exit 1
}
echo "  자동 재캘리브 가드 — $(echo "$out2" | grep -E '^Ran ')"

# 기존 AprilTag 4장으로 푸는 폰 내부 파라미터 — 합성 12시점으로 복원값과 입력 가드를 본다(D224).
out_phone="$(python3 scripts/map/phone_intrinsics.py --self-test 2>&1)" || {
  echo "$out_phone"
  echo "폰 태그 내부 파라미터 자체 검사 실패"
  exit 1
}
echo "  $out_phone"

# 세운 총알 판정 — **파지 좌표를 내는 자**라 규칙이 조용히 바뀌면 안 된다 (2026-08-31 · D159).
# 카메라도 로봇도 안 쓴다: 아는 크기의 막대를 그려 되찾고, 총알이 아닌 것은 여전히 거부하는지 본다.
out3="$(python3 -m unittest scripts.robot.test_depth_probe scripts.robot.test_carrier_find 2>&1)" || {
  echo "$out3"
  echo "세운 총알 판정 실패"
  exit 1
}
echo "  세운 총알 판정 — $(echo "$out3" | grep -E '^Ran ')"
echo "카메라 관문 단위 OK"
