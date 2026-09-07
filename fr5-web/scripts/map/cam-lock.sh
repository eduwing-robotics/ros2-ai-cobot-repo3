#!/usr/bin/env bash
# 폰 카메라의 **변하면 안 되는 값**을 잠그고, 잠겼는지 되읽어 확인한다.
#
# 캘리브레이션 결과는 해상도·초점·줌에 종속이라 **찍을 때와 쓸 때가 다르면 통째로 무효**다.
# 그런데 그 값들은 앱을 재시작하거나 케이블을 다시 꽂으면 조용히 되돌아간다 —
# 조용히 되돌아간 것을 사람이 알아채는 방법이 없어서, 여기서 매번 되읽어 찍는다.
#
# **되돌릴 수 있는 것만 한다** (dev/ 규약). 폰 설정만 바꾸고 우리 파일은 안 건드린다.
#
#   bash scripts/map/cam-lock.sh --host 192.168.0.70:8080
#   bash scripts/map/cam-lock.sh --size 1920x1080          # 라이브 겹치기용(빠름)
#
# ## 초점 — **수동 초점을 쓰지 않는다** (2026-08-04 실측)
#
# Galaxy S24+ · IP Webcam 에서 `focusmode=off` + `focus_distance` 는 **거짓말이다.**
# 되읽으면 요청한 다이옵터가 그대로 나오는데 **렌즈는 거기 없다.** 자동초점이 맞춘
# 선명한 상태에서 `focusmode=off` 로 얼리면 오히려 선명도가 950 → 36 으로 무너진다.
# 그 값을 믿고 "잠갔다"고 판단한 판이 전부 검출 0 이었다.
#
# 그래서 **자동초점을 한 번만 쓰고 그대로 둔다** — `focusmode=auto` + `/focus` 는
# 한 번 맞추면 유지된다(실측 8초 수렴 후 계속 950대 유지). 고정 카메라는 장면이
# 안 변하니 다시 헤맬 일이 없다.
#
# **판정은 되읽은 숫자가 아니라 선명도다.** 기기가 말하는 focus_distance 는 안 믿는다.

set -uo pipefail

HOST="localhost:8080"
# ✅ **값의 정본은 `Shared/data/camera/lock.json` 이다** (2026-08-08). 화면 판정
# (`Shared/data/camera/state.js`)이 같은 파일을 읽는다 — 예전에는 양쪽이 각자 상수를 들고
# 있어서 한쪽만 고치면 화면이 옛 기준으로 판정했다 (하드 룰 5). 근거 주석도 그 파일에 있다.
LOCK_JSON="$(cd "$(dirname "$0")/../.." && pwd)/Shared/data/camera/lock.json"
read -r SIZE QUALITY WB ZOOM <<EOF
$(python3 -c "
import json,sys
d=json.load(open('$LOCK_JSON'))
print(d['videoSize'], d['quality'], d['whitebalance'], d['zoom'])
")
EOF
[ -n "${SIZE:-}" ] || { echo "FAIL  $LOCK_JSON 을 못 읽었다" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host)     HOST="$2"; shift 2 ;;
    --quality)  QUALITY="$2"; shift 2 ;;
    --size)     SIZE="$2"; shift 2 ;;
    --wb)       WB="$2"; shift 2 ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *)          echo "모르는 인자: $1"; exit 2 ;;
  esac
done

BASE="http://$HOST"
echo "== 카메라 설정 잠금 ($HOST) =="

# USB 경로는 포워딩이 끊겨 있으면 여기서 되살린다 — 케이블을 다시 꽂을 때마다 사라진다.
if ! curl -s -m 3 -o /dev/null "$BASE/status.json"; then
  case "$HOST" in
    localhost:*|127.0.0.1:*)
      PORT="${HOST##*:}"
      echo "  응답이 없다 — adb forward tcp:$PORT tcp:$PORT 를 다시 건다"
      adb forward "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1 ;;
  esac
fi
if ! curl -s -m 3 -o /dev/null "$BASE/status.json"; then
  echo "FAIL  $BASE 에 응답이 없다 — 폰에서 IP Webcam '서버 시작' 을 눌렀는지 확인하라" >&2
  exit 1
fi

python3 - "$BASE" "$SIZE" "$QUALITY" "$WB" "$ZOOM" <<'PY'
import json
import sys
import time
import urllib.request

import cv2

base, want_size, want_q, want_wb, want_zoom = sys.argv[1:6]


def curvals(tries=10):
    """해상도를 바꾸면 카메라가 재시작하고, 그 사이 status.json 은 **키가 빠진 채** 돌아온다.
    없는 키를 그대로 판정하면 '설정이 안 먹었다' 로 잘못 읽힌다 — 실제로 밟았다."""
    for _ in range(tries):
        c = json.load(urllib.request.urlopen(f"{base}/status.json", timeout=5))["curvals"]
        if "focusmode" in c and "zoom" in c:
            return c
        time.sleep(0.7)
    return c


def put(path):
    urllib.request.urlopen(f"{base}{path}", timeout=6).read()


cur = curvals()
# **다른 것만 바꾼다.** 같은 값을 다시 넣어도 카메라가 재시작해서 몇 초를 버린다.
# **줌도 넣는다** (2026-08-08) — 화면 판정은 줌을 보는데 이 스크립트는 안 넣고 있었다.
# 줌이 변하면 화각이 변해 내부 파라미터가 통째로 무효다. 같은 값이면 아래 필터가 건너뛴다
todo = [(k, v) for k, v in (("video_size", want_size), ("quality", str(want_q)),
                            ("whitebalance", want_wb), ("zoom", str(want_zoom)))
        if cur.get(k) != v]
for k, v in todo:
    print(f"  바꾼다  {k} {cur.get(k)} → {v}")
    put(f"/settings/{k}?set={v}")
if todo:
    time.sleep(3)          # 해상도를 바꿨으면 카메라가 다시 열릴 때까지 기다린다

# ---- 초점: 자동으로 한 번 맞추고 그대로 둔다 (위 §초점)
put("/settings/focusmode?set=auto")
put("/focus")

cap = cv2.VideoCapture(f"{base}/video")
if not cap.isOpened():
    print("FAIL  영상 스트림을 못 연다", file=sys.stderr)
    sys.exit(1)

# **선명도로 판정한다.** 라플라시안 분산은 장면마다 절대값이 다르므로
# 임계값이 아니라 **수렴**을 본다 — 두 번 연속 10% 안이면 렌즈가 멈춘 것이다.
prev, stable, trace = 0.0, 0, []
for i in range(12):
    time.sleep(1.2)
    for _ in range(3):
        cap.read()
    ok, f = cap.read()
    if not ok:
        break
    v = cv2.Laplacian(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
    trace.append(round(v))
    stable = stable + 1 if prev and abs(v - prev) / max(prev, 1) < 0.1 else 0
    prev = v
    if stable >= 2 and i >= 3:
        break
h, w = f.shape[:2]
cap.release()

print(f"  초점 수렴: {' → '.join(map(str, trace))}")
c = curvals()
fail = []


def row(label, got, ok, note=""):
    print(f"  {'OK  ' if ok else 'FAIL'}  {label:14} {got}{note}")
    if not ok:
        fail.append(label)


row("해상도", f"{w}x{h}", f"{w}x{h}" == want_size)
row("JPEG 화질", c["quality"], c["quality"] == str(want_q))
row("화이트밸런스", c["whitebalance"], c["whitebalance"] == want_wb)
row("초점", f"auto 1회 · 선명도 {trace[-1] if trace else 0}",
    bool(stable >= 2), "  (수렴함)" if stable >= 2 else "  ← 안 멈췄다. 조명·장면을 확인하라")
# 줌은 **바꾸지 않고 검사만 한다.** 1.0 배가 아니면 사실상 다른 렌즈라 지난 캘리브레이션이
# 무효인데, 화면만 봐서는 알 수 없다.
row("줌", f"{c['zoom']} (100 = 1.0배)", c["zoom"] == "100")
print(f"  --    노출          자동 (ISO {c['iso']} · {int(c['exposure_ns']) / 1e6:.1f}ms) — 잠그지 않는다")
print(f"  --    focus_distance {c['focus_distance']} — **이 숫자는 안 믿는다** (위 §초점)")

if fail:
    print(f"FAIL  {', '.join(fail)} 이 안 잡혔다 — 이대로 찍으면 캘리브레이션이 무효다")
    sys.exit(1)
print("잠금 OK — 이 값 그대로 capture.py 부터 extrinsics.py 까지 간다")
PY
