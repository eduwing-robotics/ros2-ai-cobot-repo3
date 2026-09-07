#!/usr/bin/env bash
# 터틀봇 배포 — 맥에서 빌드해 **로봇 파이**로 밀고 tb-bridge 를 다시 띄운다 (2026-08-19).
# 옛 `tb-ubuntu.sh`(우분투 PC `ej@192.168.30.240` · `~/FR5Web/` · `systemctl --user`)를 대체한다 —
# 브리지는 2026-08-18 부터 파이 안에서 돈다(DDS 를 파이에 가둬 망 변수를 없앤다 · D134 근처).
#
# 08-06 에 손으로 rsync 하다 세 번 넘어졌고 그 셋은 여기서도 그대로 지킨다:
#   ① `--delete` 를 안 쓴다 — 파이의 맵·주행기록을 지우면 되살릴 길이 없다
#   ② `bridge/data/` 를 안 보낸다 — 맥의 mock 실험 기록이 실기 기록에 섞인다
#   ③ 5055(FR5)는 건드리지 않는다 — 여긴 다른 기계지만 규칙은 같다
# 그리고 08-19 에 하나 더 붙였다:
#   ④ **`config.yaml` 은 확인 후에만 민다** — 파이 값이 더 최신일 수 있다(지오펜스는 로봇마다 다르다).
#      `TB_PUSH_CONFIG=1` 을 줄 때만 덮어쓴다
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${TB_HOST:-kim@192.168.30.15}
IP=${HOST#*@}
PORT=$(sed -n 's/^port:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' TurtleBot/bridge/config.yaml)
[ -n "$PORT" ] || { echo "config.yaml 에 port 가 없다"; exit 1; }

# ⛔ 주행 중에는 배포하지 않는다 — 재시작이 진행 중 run 을 error 로 마감하고,
# 2026-08-19 에는 71.8초짜리 주행 궤적이 통째로 사라졌다. 강제는 TB_FORCE=1
if [ "${TB_FORCE:-0}" != 1 ] && curl -sf -m 3 "http://$IP:$PORT/api/runs?limit=1" 2>/dev/null \
   | python3 -c 'import json,sys; rs=json.load(sys.stdin); sys.exit(1 if (rs and rs[0].get("endedAt") is None) else 0)'; then
  :
else
  if [ "${TB_FORCE:-0}" != 1 ]; then
    echo "⛔ 진행 중인 run 이 있다 — 배포하면 그 주행 기록이 사라진다."
    echo "   화면에서 ■ 정지 후 다시 부르거나, 정말 지금이면 TB_FORCE=1 bash $0"
    exit 1
  fi
fi

echo "== 브리지 =="
EXCLUDES=(--exclude 'data' --exclude '__pycache__' --exclude '.venv')
[ "${TB_PUSH_CONFIG:-0}" = 1 ] || EXCLUDES+=(--exclude 'config.yaml')
rsync -az "${EXCLUDES[@]}" TurtleBot/bridge/ "$HOST":~/tb-bridge/

# 웹은 안 민다 — 터틀봇 화면은 FR5 조작(:5055)의 「터틀봇」 탭이다 (D182 · 2026-09-05)

# 의존성은 **requirements.txt 로만** 맞춘다. 손으로 골라 깔면 `uvicorn[standard]` 가 빠져
# **WS 만 404** 가 난다 — 같은 함정을 08-06·08-18 두 번 밟았다.
ssh "$HOST" "python3 -m pip install -q --break-system-packages -r ~/tb-bridge/requirements.txt || \
             python3 -m pip install -q -r ~/tb-bridge/requirements.txt"

ssh "$HOST" 'sudo systemctl restart tb-bridge'

for i in $(seq 1 20); do
  curl -sf -m 2 "http://$IP:$PORT/api/slots" >/dev/null && break
  sleep 1
  [ "$i" = 20 ] && { echo "안 떴다 — ssh $HOST 'journalctl -u tb-bridge -n 40'"; exit 1; }
done
echo "배포 OK — http://$IP:$PORT"
echo "확인: curl -s http://$IP:$PORT/api/paths   (200 이면 오늘 것이 올라갔다)"
