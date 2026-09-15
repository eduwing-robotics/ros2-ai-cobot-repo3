#!/usr/bin/env bash
# 스플랫 뷰어를 띄운다. 라이브러리는 처음 한 번만 받아 `lib/` 에 둔다 (gitignore).
#
#   bash scripts/map/splat-view/serve.sh .splat-work/out          # 맥에서
#   bash scripts/map/splat-view/serve.sh ~/splat-work/out 5057    # 우분투에서 (랩 전체 공개)
#
# **npm 을 안 쓴다.** 로봇 브리지가 사는 기계에 node_modules 를 얹지 않으려고 파일로 받아
# importmap 으로 물린다. 받아 두면 인터넷 없이 돈다.
set -euo pipefail
cd "$(dirname "$0")"

PLY_DIR=${1:?"`.ply` 가 있는 폴더를 주세요"}
PORT=${2:-5057}
THREE=0.180.0                 # spark 2.1.0 이 이 버전을 기준으로 배포된다
SPARK=2.1.0

if [ ! -f lib/spark.module.js ]; then
  echo "== 라이브러리 받는 중 (처음 한 번) =="
  mkdir -p lib
  B=https://cdn.jsdelivr.net/npm/three@$THREE
  # three 0.180 은 module 과 core 가 갈려 있다 — core 를 빼면 404 로 조용히 멈춘다
  curl -sfL -o lib/three.module.js  "$B/build/three.module.js"
  curl -sfL -o lib/three.core.js    "$B/build/three.core.js"
  curl -sfL -o lib/OrbitControls.js "$B/examples/jsm/controls/OrbitControls.js"
  # spark 가 이것 하나를 더 import 한다. 없으면 "Failed to resolve module specifier" 로 멈춘다
  curl -sfL -o lib/Pass.js          "$B/examples/jsm/postprocessing/Pass.js"
  curl -sfL -o lib/spark.module.js  "https://sparkjs.dev/releases/spark/$SPARK/spark.module.js"
fi

# `.ply` 는 심볼릭 링크로 건다 — 수백 MB 를 복사하지 않는다
for f in "$PLY_DIR"/*.ply; do [ -e "$f" ] && ln -sf "$(cd "$(dirname "$f")" && pwd)/$(basename "$f")" "./$(basename "$f")"; done
[ -f "$PLY_DIR/../start-pose.json" ] && cp "$PLY_DIR/../start-pose.json" ./start-pose.json

echo "== http://localhost:$PORT/  (랩 안에서는 이 기계의 IP:$PORT) =="
ls *.ply 2>/dev/null | sed 's/^/   /'
exec python3 -m http.server "$PORT" --bind 0.0.0.0
