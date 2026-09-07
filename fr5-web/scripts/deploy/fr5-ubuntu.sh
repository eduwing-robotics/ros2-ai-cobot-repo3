#!/usr/bin/env bash
# FR5 배포 — 맥에서 빌드해 우분투 브리지 호스트로 밀어 넣고 서비스를 재시작한다.
# 호스트 구조·주소의 정본: docs/status/PROJECT-STATUS.md §FR5 트랙 (2026-08-03 호스트 이사).
# 재시작하면 로봇 세션이 끊긴다 — 끝에서 observe-only 재연결까지 해 준다.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${FR5_HOST:-ej@192.168.30.240}
IP=${HOST#*@}

npm run build:fr5
# `--delete` 는 **보낸 적 없는 것도 지운다.** 호스트에만 사는 둘을 명시로 지킨다 (2026-08-06):
#   .venv            — tb-bridge 파이썬 환경. 지워지면 FR5 배포가 **터틀봇을 조용히 죽인다**
#   TurtleBot/…/data — 맵·주행 기록(gitignore). 실험 데이터라 되살릴 길이 없다
# FR5 데이터가 배포 트리 밖(`~/fr5-data`)에 사는 것과 같은 이유인데, 터틀봇은 트리 안이라 막아야 한다.
# `global-cam-drift.json` 도 안 보낸다 (2026-08-08) — **이 맥에서 잰 겹침 오차**다.
# 보내면 저쪽 화면이 남의 기계 값을 읽고, 감시기가 없는 그 기계에서 나이만 늙어
# 「감시가 멎었다」 로 뜬다. 파일이 아예 없어야 「미감시」(조용함)로 정직하게 나온다.
# `global-cam-host.json` 도 같다 (2026-08-10) — **저쪽 감시기가 훑어서 찾은 주소**다.
# ⚠ 여기 빼먹으면 `--delete` 가 저쪽 것을 **지운다** — 맥에는 그 파일이 없기 때문이다.
# 그러면 화면이 폰 주소를 다시 잃고 카메라 칸이 통째로 사라진다 (그래서 이 줄이 있다).
rsync -az --delete --exclude node_modules --exclude .claude \
  --exclude '.venv' --exclude 'TurtleBot/bridge/data' \
  --exclude 'Shared/data/config/global-cam-drift.json' \
  --exclude 'Shared/data/config/global-cam-host.json' ./ "$HOST":~/FR5Web/
# 데이터는 배포 트리 **밖**에 산다 (D45) — 그 밖을 아무도 안 만들면 배포는 성공하고
# **저장만 조용히 실패**한다. rsync 대상이 ~/FR5Web/ 이라 --delete 가 여기 못 닿는다.
# 지점은 **파일 하나**라 폴더가 없다 (`~/fr5-data/points.json` · 브리지가 스스로 만든다).
# 빈 폴더를 만들어 두면 다음 사람이 거기를 뒤진다 — 대시보드를 한 달 묶어 둔 게 그 빈 폴더였다.
ssh "$HOST" 'mkdir -p ~/fr5-data/trajectories ~/fr5-data/slots ~/fr5-data/history'
ssh "$HOST" 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart fr5-bridge'
for i in $(seq 1 20); do
  curl -sf -m 2 "http://$IP:5055/robots" >/dev/null && break
  sleep 1
  [ "$i" = 20 ] && { echo "브리지가 안 뜬다 — ssh $HOST 'journalctl --user -u fr5-bridge -n 30'"; exit 1; }
done
# 거부되면 **사유를 그대로 보여준다.** 원인을 추측해 적으면 사람이 엉뚱한 데를 본다 —
# 2026-08-05 에 "랜선·전원 확인" 이 그래서 오판을 만들었다 (진짜 원인은 죽은 소켓이었다).
RESP=$(curl -s -m 8 -X POST "http://$IP:5055/connect" -H 'Content-Type: application/json' \
  -d '{"robotId":"fr5-lab-a","observeOnly":true}' || true)
case "$RESP" in
  *'"ok":true'*) echo "로봇 재연결 OK (OBSERVE_ONLY)" ;;
  *) echo "(로봇 재연결 실패 — 웹은 살아 있다)"
     echo "  브리지 응답: $RESP"
     echo "  ① 브리지 재시작 후 한 번 더: ssh $HOST 'export XDG_RUNTIME_DIR=/run/user/\$(id -u); systemctl --user restart fr5-bridge'"
     echo "  ② 그래도 안 되면 선·전원: ssh $HOST 'ping -c 2 192.168.58.2; ip -brief addr | grep 58.'" ;;
esac
echo
echo "배포 OK — http://$IP:5055"
