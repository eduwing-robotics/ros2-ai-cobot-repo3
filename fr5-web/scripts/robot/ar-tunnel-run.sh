#!/usr/bin/env bash
# cloudflared quick tunnel — **xr AR(WebXR)용 HTTPS 통로**. 브리지(:5055)를 공개 HTTPS 로 뚫어
# 폰이 `https://…/ar/xr.html` 로 WebXR(보안 컨텍스트 필수)를 열고, 같은 출처 wss 로 실물 라이브를 받는다.
# (Vercel 공개본은 LAN 평문 ws 에 못 닿는다 — 혼카 콘텐츠. 그래서 이 터널이 유일한 xr AR 경로다.)
#
# systemd --user 서비스(`ar-tunnel-service.sh`)가 이걸 Restart=always 로 돌린다 (cam/tb 와 같은 방식).
# ⚠ **quick tunnel 은 재시작마다 URL 이 바뀐다.** 현재 URL 을 `~/fr5-data/tunnel-url.txt` 에 적어 둔다 —
#    `/우분투` 스킬·상태 보고가 이 파일을 읽는다. **고정 URL 이 필요하면 명명 터널**(Cloudflare 계정+도메인):
#    https://developers.cloudflare.com/cloudflare-one/connections/connect-apps  — 계정 로그인은 사람이 한다.
set -uo pipefail
CF=$(command -v cloudflared || echo ~/cloudflared)
LOG=~/fr5-data/tunnel.log
URLFILE=~/fr5-data/tunnel-url.txt
mkdir -p ~/fr5-data
: > "$LOG"

"$CF" tunnel --url http://localhost:5055 >> "$LOG" 2>&1 &
CFPID=$!

# URL 이 로그에 뜨면 파일에 적는다 (서비스 상태에서 바로 꺼내 쓰게)
for _ in $(seq 1 30); do
  u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$u" ] && { echo "$u" > "$URLFILE"; echo "TUNNEL_URL=$u"; break; }
  sleep 1
done

# 서비스가 살아 있게 cloudflared 를 붙잡는다 (죽으면 systemd 가 Restart)
wait "$CFPID"
