#!/usr/bin/env bash
# 우분투 PC 1회 설치 — cam-bridge 의존성. D435 가 USB3 로 꽂혀 있어야 한다.
# tb-setup.sh 와 같은 모양이되 `--system-site-packages` 를 **안 쓴다** — ROS 처럼 시스템에서
# 빌려올 것이 없고, 시스템 numpy(1.26)와 휠이 원하는 버전이 섞이면 거기서 조용히 갈린다.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== python 의존성 (venv) =="
python3 -m venv Vision/bridge/.venv
Vision/bridge/.venv/bin/pip install -q --upgrade pip
Vision/bridge/.venv/bin/pip install -q -r Vision/bridge/requirements.txt

echo "== 의존성 확인 =="
Vision/bridge/.venv/bin/python -c "import fastapi, uvicorn, yaml, numpy, PIL, pyrealsense2 as rs; print('  관문 의존성 OK · pyrealsense2', rs.__version__)"

echo "== 장치 확인 =="
# **여기서 안 보이면 그 아래가 전부 같은 이유로 실패한다.** 커널이 보는 것과 librealsense 가
# 여는 것을 따로 본다 — lsusb 에 있는데 파이프라인이 안 열리면 권한(udev)이다
lsusb | grep -i 8086 || { echo "  ⚠ USB 에 Intel 장치가 없다 — 케이블부터 본다"; exit 1; }
for d in /sys/bus/usb/devices/*/; do
  [ "$(cat "$d/idVendor" 2>/dev/null)" = "8086" ] || continue
  sp=$(cat "$d/speed" 2>/dev/null)
  echo "  USB 속도 ${sp}Mbps"
  # 480Mbps 면 424x240 이 목록에서 통째로 사라져 근접 깊이가 없다 (DEPTH-CAM.md §USB).
  # **조용히 지나가면 안 된다** — 화면에는 아무 표시도 안 나는 종류의 고장이다
  [ "$sp" = "480" ] && echo "  ⚠ USB2 로 떨어졌다 — 케이블 등급을 의심한다. 근접 깊이(424x240)가 없다"
done
Vision/bridge/.venv/bin/python -c "
import pyrealsense2 as rs
ctx = rs.context()
ds = list(ctx.query_devices())
if not ds:
    raise SystemExit('  ⚠ librealsense 가 장치를 못 연다 — udev 규칙(권한)을 의심한다')
d = ds[0]
print('  ', d.get_info(rs.camera_info.name),
      '· S/N', d.get_info(rs.camera_info.serial_number),
      '· USB', d.get_info(rs.camera_info.usb_type_descriptor))
"
echo "설치 끝. 실행: bash scripts/robot/cam-run.sh"
