#!/usr/bin/env bash
# 터틀봇 브리지(mock) 개발 서버. 화면은 FR5 dev(`npm run dev:fr5` · :5176) 를 `?tb=localhost:5056`
# 으로 연다 (D182 · 옛 터틀봇 웹앱은 퇴역). `bridge` 인자는 호환용 — 이제 언제나 브리지만 띄운다.
set -euo pipefail
cd "$(dirname "$0")/../../TurtleBot/bridge"

# 포트 정본은 config.yaml 하나다 (D80) — 파서를 들이지 않고 그 한 줄만 읽는다
PORT=$(sed -n 's/^port:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' config.yaml)
[ -n "$PORT" ] || { echo "config.yaml 에 port 가 없다"; exit 1; }

BRIDGE_CMD=(uv run --with fastapi --with 'uvicorn[standard]' --with pyyaml \
  uvicorn main:app --host 0.0.0.0 --port "$PORT")

exec "${BRIDGE_CMD[@]}"
