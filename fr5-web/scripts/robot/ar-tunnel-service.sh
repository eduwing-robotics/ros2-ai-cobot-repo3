#!/usr/bin/env bash
# 우분투 PC 1회 등록 — cloudflared 터널을 systemd --user 서비스로 올린다 (cam/tb 와 같은 방식).
# 이걸로 **터널이 상시로** 돈다: 부팅·크래시·네트워크 복구 후 자동 재기동(Restart=always).
# xr AR(WebXR) 은 HTTPS 가 필요하고, 이 터널이 브리지(:5055)를 HTTPS 로 뚫는다.
#
# ⚠ quick tunnel 이라 재기동마다 URL 이 바뀐다 — 현재 URL 은 `~/fr5-data/tunnel-url.txt`.
#    고정 URL 은 명명 터널(Cloudflare 계정+도메인)로 업그레이드 (ar-tunnel-run.sh 주석 참조).
# ⚠ 로그인 세션이 있어야 --user 서비스가 돈다. 헤드리스로도 상시로 두려면: sudo loginctl enable-linger ej
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
UNIT=~/.config/systemd/user/ar-tunnel.service

command -v cloudflared >/dev/null || [ -x ~/cloudflared ] || {
  echo "cloudflared 가 없다 → 설치:"
  echo "  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/cloudflared && chmod +x ~/cloudflared"
  exit 1
}

mkdir -p ~/.config/systemd/user
cat > "$UNIT" <<EOF
[Unit]
Description=fr5 ar-tunnel (cloudflared → 브리지 :5055 · xr AR HTTPS)
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=/bin/bash $ROOT/scripts/robot/ar-tunnel-run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload
systemctl --user enable --now ar-tunnel
sleep 12
echo "=== 현재 터널 URL ==="
cat ~/fr5-data/tunnel-url.txt 2>/dev/null || echo "(아직 — 몇 초 뒤 다시: cat ~/fr5-data/tunnel-url.txt)"
echo "재시작: systemctl --user restart ar-tunnel · 로그: journalctl --user -u ar-tunnel -f"
