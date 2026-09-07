#!/usr/bin/env bash
# AR 실렌더 검증을 **자동 게이트에 잠근다** (2026-08-07). `fr5-render.sh` 의 AR 판이다.
#
# 왜 만들었나 — `cam-web-verify.mjs` 가 **겹침이 2176px 어긋난 것을 잡고 있었는데**
# `.mjs` 라 `all.sh` 가 안 불렀고, 손으로 부르는 사람도 없어서 실측 캘리브가 들어온
# D82·D83 이후로 계속 빨간 채였다. 화면은 그럴듯해 보였다.
# **손으로 부르는 게이트는 안 도는 게이트다** (2026-08-05 `/감사` P0 와 같은 결론).
#
#   cam-web-verify.mjs  12건  포트 5188 · AR/cam.html + 사진 속 태그 재검출 정합
#   xr-web-verify.mjs         포트 5189 · AR/xr.html
#
# 둘 다 자기 vite 를 자기 포트에 띄운다 — 남의 dev 서버에 붙지 않는다.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 없으면 **건너뛰지 않고 실패한다.** 조용히 건너뛰는 게이트는 게이트가 아니다.
for tool in node npm python3; do
  command -v "$tool" >/dev/null || { echo "  $tool 이 없다 — AR 실렌더 게이트를 돌릴 수 없다"; exit 1; }
done
# 정합 판정의 정답은 **사진에서 다시 검출한 태그 중심**이라 cv2 가 있어야 한다.
# 없이 돌면 "정합을 안 본 채 초록" 이 되는데, 그게 이 게이트를 만든 이유의 정반대다.
python3 -c 'import cv2' 2>/dev/null || {
  echo "  python3 의 cv2 가 없다 — 정합 판정의 정답을 못 만든다 (pip install opencv-python)"; exit 1; }

# 게이트 전용 포트를 남이 쥐고 있으면 멈춘다 (`fr5-render.sh` 와 같은 이유 — 고아에 붙으면
# 남의 화면을 우리 것으로 잘못 판정한다). `--strictPort` 라 붙는 대신 죽지만, 원인이 안 보인다.
BUSY=""
for port in 5188 5189; do
  lsof -ti tcp:"$port" >/dev/null 2>&1 && BUSY="$BUSY $port"
done
if [ -n "$BUSY" ]; then
  echo "  게이트 전용 포트를 이미 누가 쓴다:$BUSY"
  echo "    for p in 5188 5189; do lsof -ti tcp:\$p | xargs -r kill -9; done"
  exit 1
fi

FAIL=0
run() {          # $1 표시 이름 · $2 스크립트
  local out
  if out="$(node "$ROOT/scripts/check/$2" 2>&1)"; then
    echo "  $1 — $(echo "$out" | grep -E '^[0-9]+/[0-9]+' | tail -1)"
  else
    echo "$out" | grep -E '^FAIL' || echo "$out" | tail -20
    echo "  $1 실패"
    FAIL=1
  fi
}

run "글로벌 카메라 겹치기" cam-web-verify.mjs
run "WebXR 겹치기"       xr-web-verify.mjs

[ "$FAIL" -eq 0 ] && echo "AR 실렌더 OK" || echo "AR 실렌더 실패"
exit "$FAIL"
