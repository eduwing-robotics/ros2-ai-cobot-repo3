#!/usr/bin/env bash
# 우분투 PC 1회 등록 — 정합 감시(`watch-calib.py`)를 systemd --user 로 올린다.
#
# **왜 유닛이어야 하나** — 08-08 에 `setsid nohup` 으로 띄웠더니 재부팅에 안 살아남아
# **47시간을 조용히 죽어 있었다**(GAP P1). 감시가 없다는 것도 조용해서, 사람이
# 안 물어보면 모른다. `loginctl show-user ej -p Linger` 가 `yes` 라 유닛이면 산다.
#
# 주소는 유닛에 안 박는다 — `calib-watch-run.sh` 머리말 참조.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
UNIT=~/.config/systemd/user/calib-watch.service

mkdir -p ~/.config/systemd/user
cat > "$UNIT" <<EOF
[Unit]
Description=글로벌 카메라 정합 감시 (watch-calib.py)

[Service]
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/scripts/robot/calib-watch-run.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload
systemctl --user enable --now calib-watch
sleep 12
systemctl --user --no-pager status calib-watch | head -8
echo "등록 끝. 재시작은 systemctl --user restart calib-watch"
