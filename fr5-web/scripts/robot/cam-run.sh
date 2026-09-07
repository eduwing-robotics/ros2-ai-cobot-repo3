#!/usr/bin/env bash
# 우분투 PC 실행 — cam-bridge 기동. 포트 정본은 `Vision/bridge/config.yaml` 의 **5058** 이다
# (같은 PC 에 5055 FR5 · 5056 터틀봇 · D80·D86). 2026-08-08 정정: 이 줄이 `tb-run.sh` 에서
# 복사돼 **자기 포트만 빠져 있었다** — 포트를 찾으러 온 사람에게 남의 번호 둘만 보여줬다.
# 전제: cam-setup.sh 1회 완료 · D435 가 USB3 로 꽂혀 있다.
set -euo pipefail
cd "$(dirname "$0")/../../Vision/bridge"

# 포트 정본은 config.yaml 하나다 (D80) — 파서를 들이지 않고 그 한 줄만 읽는다
PORT=$(sed -n 's/^port:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' config.yaml)
[ -n "$PORT" ] || { echo "config.yaml 에 port 가 없다"; exit 1; }

# **포트를 먼저 확인하고 파이썬을 띄운다** (2026-08-07 실기에서 밟았다).
# uvicorn 은 lifespan 시작을 **바인드보다 먼저** 돌린다 — 포트가 이미 잡혀 있으면
# 앱이 카메라를 연 다음에야 바인드에 실패하고 죽는다. systemd 가 3초마다 되살리니
# **장치를 잡았다 버리기를 14번 반복해 D435 가 엉켰고**, 그때 나온 얼굴은
# `xioctl(UVCIOC_CTRL_QUERY) failed ... Protocol error` 라 커널·udev 문제처럼 보인다.
# 진짜 원인은 포트였다. 여기서 막으면 그 오진이 통째로 사라진다.
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "포트 $PORT 을 남이 쥐고 있다 — 카메라를 열지 않고 멈춘다"
  ss -ltnp 2>/dev/null | grep ":$PORT " || true
  exit 1
fi

# **워커는 하나다.** 장치가 하나뿐이라 두 워커가 뜨면 두 번째가 파이프라인을 못 열고
# 요청마다 둘 사이를 오가며 절반이 503 을 낸다 — 화면에는 "가끔 끊긴다" 로 보인다
exec .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port "$PORT" --workers 1
