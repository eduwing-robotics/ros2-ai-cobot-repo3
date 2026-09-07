#!/usr/bin/env bash
# 카메라 관문 배포 — 맥에서 우분투 브리지 호스트로 밀어 넣고 cam-bridge 를 다시 띄운다.
# 호스트·포트의 정본: docs/status/PROJECT-STATUS.md · Vision/bridge/config.yaml.
#
# FR5·TB 배포와 **같은 트리**(`~/FR5Web/`)에 산다. tb-ubuntu.sh 가 굳혀 둔 셋을 그대로 지킨다:
#   ① `--delete` 를 안 쓴다 — 호스트의 `.venv` 를 지우면 되살리는 데 몇 분이 든다
#   ② 웹 빌드가 없다 — 이 관문은 화면을 서빙하지 않는다 (읽기 API 뿐)
#   ③ 5055·5056 은 건드리지 않는다 — 죽이는 대상은 우리 포트를 쥔 프로세스뿐이다
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${CAM_HOST:-ej@192.168.30.240}
IP=${HOST#*@}
PORT=$(sed -n 's/^port:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' Vision/bridge/config.yaml)
[ -n "$PORT" ] || { echo "config.yaml 에 port 가 없다"; exit 1; }

rsync -az --exclude .venv --exclude __pycache__ Vision/ "$HOST":~/FR5Web/Vision/
rsync -az scripts/robot/ "$HOST":~/FR5Web/scripts/robot/

# 의존성은 매번 맞춘다 — requirements 가 바뀐 채로 옛 venv 를 쓰면 뜨긴 뜨고 일부만 죽는다
ssh "$HOST" "cd ~/FR5Web && [ -x Vision/bridge/.venv/bin/pip ] || bash scripts/robot/cam-setup.sh"
ssh "$HOST" "cd ~/FR5Web && Vision/bridge/.venv/bin/pip install -q -r Vision/bridge/requirements.txt"

ssh "$HOST" "cd ~/FR5Web && [ -f ~/.config/systemd/user/cam-bridge.service ] || bash scripts/robot/cam-service.sh"
ssh "$HOST" 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart cam-bridge'

for i in $(seq 1 20); do
  curl -sf -m 2 "http://$IP:$PORT/api/camera/info" >/dev/null && break
  sleep 1
  [ "$i" = 20 ] && { echo "안 떴다 — ssh $HOST 'journalctl --user -u cam-bridge -n 40'"; exit 1; }
done
echo "배포 OK — http://$IP:$PORT/api/camera/state  (5055·5056 은 그대로)"
