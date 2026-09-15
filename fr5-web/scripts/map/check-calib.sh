#!/usr/bin/env bash
# 글로벌 카메라 캘리브레이션 게이트.
#
# **아직 측정 안 했으면 통과시킨다** — 측정은 하드웨어가 있어야 하고,
# 없다고 전체 게이트를 빨갛게 만들면 아무도 안 본다.
# 파일이 있는데 값이 나쁘거나 반쪽이면 그때 실패한다.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF="$ROOT/Shared/data/config/global-cam.json"

echo "== 글로벌 카메라 캘리브레이션 =="

if [ ! -f "$CONF" ]; then
  echo "  아직 측정 전 — 건너뛴다 (scripts/map/intrinsics.py 부터)"
  exit 0
fi

python3 - "$CONF" <<'PY'
import json, sys
from pathlib import Path

MAX_INTRINSIC_RMS = 0.5
MAX_EXTRINSIC_RMS = 2.0

doc = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
fail = []

I = doc.get("intrinsics")
if not I:
    fail.append("intrinsics 없음 — intrinsics.py 를 돌려라")
else:
    for k in ("widthPx", "heightPx", "fx", "fy", "cx", "cy", "dist", "rmsPx"):
        if k not in I:
            fail.append(f"intrinsics.{k} 없음")
    if I.get("rmsPx", 9) > MAX_INTRINSIC_RMS:
        fail.append(f"내부 RMS {I['rmsPx']} > {MAX_INTRINSIC_RMS}")
    else:
        print(f"  내부 {I['widthPx']}x{I['heightPx']} · HFOV {I.get('hfovDeg')}° · "
              f"RMS {I['rmsPx']}px · 사진 {I.get('shots')}장")

E = doc.get("labToCam")
if not E:
    print("  labToCam 아직 없음 — 카메라 설치 후 extrinsics.py (지금은 통과)")
elif E.get("rmsPx", 99) > MAX_EXTRINSIC_RMS:
    fail.append(f"외부 RMS {E['rmsPx']} > {MAX_EXTRINSIC_RMS}")
elif E.get("heightMm", 0) <= 0:
    fail.append(f"카메라 높이 {E.get('heightMm')}mm — 태그 평면 아래는 있을 수 없다")
else:
    print(f"  외부 태그면 위 {E['heightMm']/1000:.2f}m · 하향 {E.get('depressionDeg')}° · "
          f"태그 {E.get('tags')}장 · RMS {E['rmsPx']}px")

for f in fail:
    print(f"  FAIL  {f}")
sys.exit(1 if fail else 0)
PY
rc=$?
[ "$rc" -eq 0 ] && echo "캘리브레이션 OK"
exit "$rc"
