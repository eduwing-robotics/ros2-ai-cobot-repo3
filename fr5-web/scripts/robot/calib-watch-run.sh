#!/usr/bin/env bash
# 정합 감시 실행부 — 유닛이 이걸 부른다 (`cam-service.sh` 가 `cam-run.sh` 를 부르는 것과 같은 이유).
#
# **폰 주소를 유닛에 박지 않는다.** 폰은 DHCP 라 IP 가 바뀌고, 실제로 그것 때문에
# 감시가 조용히 죽었다 (2026-08-10 · 47시간 침묵 · `.10` → `.4`). 유닛에 박으면
# 다음 임대에서 같은 일이 반복된다.
#
# 순서 — ①고정 파일 ②그게 안 답하면 /24 훑기 ③찾으면 고정 파일에 적어 둔다
#
#   ponytail: 훑기는 `curl` 254회 병렬이고 8초쯤 걸린다. 서비스 기동 때 한 번만 하므로
#   값이 싸다. 폰이 랜을 아예 떠나면 못 찾고 그대로 죽는다 — 그때는 화면이
#   `정합 미감시` 로 떨어지는 것이 설계다(값의 나이로 판정 · `watch-calib.py` 머리말).
#   **천장**: 서브넷을 `192.168.30.0/24` 로 가정한다. 망이 바뀌면 여기를 고친다.
set -uo pipefail
cd "$(dirname "$0")/../.."

PIN="$HOME/fr5-data/global-cam-host"
SUBNET="192.168.30"
PORT=8080

# IP Webcam 인지까지 본다 — :8080 을 여는 다른 장치를 잡지 않게.
alive() {
  curl -s -m 3 "http://$1/status.json" 2>/dev/null | grep -q '"video_size"'
}

HOST=""
if [ -f "$PIN" ]; then
  CAND="$(cat "$PIN")"
  if alive "$CAND"; then HOST="$CAND"; echo "고정 파일에서 찾음 — $HOST"; fi
fi

if [ -z "$HOST" ]; then
  echo "훑는다 — $SUBNET.0/24:$PORT"
  TMP="$(mktemp)"
  for i in $(seq 1 254); do
    ( alive "$SUBNET.$i:$PORT" && echo "$SUBNET.$i:$PORT" >> "$TMP" ) &
  done
  wait
  HOST="$(head -1 "$TMP" 2>/dev/null)"
  rm -f "$TMP"
  [ -n "$HOST" ] && { mkdir -p "$(dirname "$PIN")"; echo "$HOST" > "$PIN"; echo "찾았다 — $HOST (고정 파일에 적었다)"; }
fi

if [ -z "$HOST" ]; then
  echo "폰을 못 찾았다 — 랜에 없다. 30초 뒤 다시 시도한다 (Restart=always)" >&2
  sleep 30
  exit 1
fi

# 화면도 이 주소를 쓴다 (계약 §정적 서빙 `global-cam-host.json`). **새 탐색을 화면에
# 또 만들지 않는다** — 어차피 여기서 찾아야 하므로 찾은 결과를 내놓는다 (하드 룰 5).
python3 -c "
import json, time, pathlib
p = pathlib.Path('Shared/data/config/global-cam-host.json')
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps({
    '_': 'scripts/robot/calib-watch-run.sh 산출물 — 직접 고치지 마라',
    't': time.time(), 'host': '$HOST',
}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print('화면용 주소 파일 갱신 — $HOST')
"

exec python3 scripts/map/watch-calib.py --host "$HOST"
