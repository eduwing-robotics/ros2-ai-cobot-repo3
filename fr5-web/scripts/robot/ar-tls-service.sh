#!/usr/bin/env bash
# LAN 전용 고정 HTTPS — socat 로 :5443 에 TLS 를 씌워 브리지(:5055)로 넘긴다 (xr AR = WebXR HTTPS 필수).
# **브리지 http :5055 는 그대로 둔다** — 팀 조작 화면이 안 깨진다. 폰은 https://<PC>:5443/ar/xr.html.
# 자체서명이라 폰이 인증서 경고를 **한 번 수락**하면 된다. 도메인·계정·터널 불필요 (LAN 안에서만).
# systemd --user 서비스라 상시(Restart=always). cam/tb/ar-tunnel 과 같은 방식.
set -euo pipefail
command -v socat >/dev/null || { echo "socat 없음 → sudo apt install -y socat 후 다시"; exit 1; }
command -v openssl >/dev/null || { echo "openssl 없음 → sudo apt install -y openssl 후 다시"; exit 1; }

CERT=~/fr5-data/fr5-tls.pem   # 키+인증서 합본 (socat cert= 가 읽는다)
mkdir -p ~/fr5-data
if [ ! -f "$CERT" ]; then
  # IP SAN 을 넣어야 브라우저가 그 IP 로 인정한다 (CN 만으론 최신 브라우저가 거부)
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=192.168.30.240" -addext "subjectAltName=IP:192.168.30.240" \
    -keyout /tmp/_k.pem -out /tmp/_c.pem
  cat /tmp/_k.pem /tmp/_c.pem > "$CERT"; chmod 600 "$CERT"; rm -f /tmp/_k.pem /tmp/_c.pem
fi

UNIT=~/.config/systemd/user/ar-tls.service
mkdir -p ~/.config/systemd/user
cat > "$UNIT" <<EOF
[Unit]
Description=fr5 ar-tls (socat TLS :5443 -> 브리지 :5055 · xr AR LAN HTTPS)
[Service]
# TLS 종단 후 **원시 TCP** 로 넘기므로 http 도 WebSocket(/ws/state) 도 그대로 통과한다
ExecStart=/usr/bin/socat OPENSSL-LISTEN:5443,cert=$CERT,verify=0,reuseaddr,fork TCP:localhost:5055
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
EOF

export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload
systemctl --user enable --now ar-tls
sleep 2
systemctl --user --no-pager status ar-tls | head -4
echo
echo "→ 폰에서: https://192.168.30.240:5443/ar/xr.html  (인증서 경고 '고급 → 계속' 한 번)"
echo "  재시작: systemctl --user restart ar-tls · 로그: journalctl --user -u ar-tls -f"
