#!/usr/bin/env bash
# 우분투 PC 1회 등록 — cam-bridge 를 systemd --user 서비스로 올린다 (FR5·TB 와 같은 방식).
# `ssh host "... &"` 로 데몬을 만들지 않는 이유는 tb-service.sh 머리말 그대로다.
# 포트는 config.yaml 이 정본이라 유닛에 박지 않고 cam-run.sh 를 그대로 실행한다.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
UNIT=~/.config/systemd/user/cam-bridge.service

mkdir -p ~/.config/systemd/user
cat > "$UNIT" <<EOF
[Unit]
Description=cam-bridge (손목 D435 관문 · FastAPI)

[Service]
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/scripts/robot/cam-run.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload
systemctl --user enable --now cam-bridge
sleep 3
systemctl --user --no-pager status cam-bridge | head -5
echo "등록 끝. 재시작은 systemctl --user restart cam-bridge"
