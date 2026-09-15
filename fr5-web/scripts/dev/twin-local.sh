#!/usr/bin/env bash
# 로컬에서 쌍둥이를 띄운다 — **호스트를 안 건드린다.** 실기 프로필을 목업 어댑터로 돌려
# `config.yaml` 의 구역·상자를 실기와 같은 좌표계로 그린다.
#
#   bash scripts/dev/twin-local.sh          # 브리지(5055) + vite(5176) 를 띄우고 붙는다
#   bash scripts/dev/twin-local.sh --stop   # 둘 다 끈다
#
# ⛔ **왜 스크립트인가 — 2026-08-18 에 손으로 하다 사고가 났다.**
# 「고쳤다 → 띄웠다 → 되돌린다」를 손으로 치면 **중간에 끊겼을 때 저장소에 `adapter: mock` 이
# 남는다.** 그날 그대로 커밋됐고, 배포 직전에야 잡았다 — 나갔으면 **실기가 가짜 어댑터로 돌면서
# 화면엔 그럴듯한 관절값이 뜬다.** 사람은 로봇이 붙은 줄 안다.
# 그래서 이 스크립트는 **원본을 절대 안 고친다** — 사본을 만들어 그걸 띄운다.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
WORK=${TMPDIR:-/tmp}/fr5-twin-local

stop() { for p in 5055 5176; do pids=$(lsof -ti :$p 2>/dev/null || true); [ -n "$pids" ] && kill $pids 2>/dev/null || true; done; echo "껐다 (5055 · 5176)"; }
[ "${1:-}" = "--stop" ] && { stop; exit 0; }

# ── 사본을 만든다. **원본 트리는 한 글자도 안 바뀐다** ────────────────────────
# 시작 시점의 원본 해시를 뜬다. 끝에서 이것과 비교한다 — `git diff` 로 재면 사람이 상자를
# 고치는 중일 때마다 붉어져서, **양치기 소년이 되어 진짜 오염을 놓친다** (2026-08-18 실측).
BEFORE=$(shasum -a 256 FR5/bridge/config.yaml | cut -d' ' -f1)
rm -rf "$WORK"; mkdir -p "$WORK/FR5"
cp -R FR5/bridge "$WORK/FR5/bridge"
# `main.py` 가 `HERE.parent.parent` 로 Shared·AR·dist 를 찾는다 — 같은 모양을 만들어 준다
ln -sfn "$ROOT/Shared" "$WORK/Shared"; ln -sfn "$ROOT/Sim" "$WORK/Sim"; ln -sfn "$ROOT/AR" "$WORK/AR"

python3 - "$WORK/FR5/bridge/config.yaml" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p, encoding="utf-8").read()
# 실기 프로필만 목업으로 — 로봇이 없어도 뜨고, 좌표계는 얼린 실기 값을 mock 이 빌려 쓴다
t = re.sub(r"^(\s*)adapter: fairino", r"\1adapter: mock", t, count=1, flags=re.M)
t = re.sub(r"^(\s*)expectedModel: FR5-V1-002\(V6\.0\)", r"\1expectedModel: FR5", t, count=1, flags=re.M)
open(p, "w", encoding="utf-8").write(t)
print("  사본에만 adapter: mock 적용")
PY

stop
# ⛔ **자식의 stdin/out/err 을 전부 끊는다.** 안 끊으면 자식이 이 스크립트의 파이프를 물고 있어
# `bash twin-local.sh | tail` 이 **영영 안 끝난다** (2026-08-18 실측: 2분 타임아웃).
( cd "$WORK/FR5/bridge" && nohup uv run --with fastapi --with uvicorn --with pyyaml --with numpy \
    --with websockets uvicorn main:app --host 127.0.0.1 --port 5055 \
    > "$WORK/bridge.log" 2>&1 < /dev/null & )
( cd "$ROOT" && nohup npm run dev:fr5 > "$WORK/vite.log" 2>&1 < /dev/null & )
for i in $(seq 1 20); do nc -z 127.0.0.1 5055 2>/dev/null && break; sleep 1; done
curl -s -m 10 -X POST http://127.0.0.1:5055/connect -H 'Content-Type: application/json' \
  -d '{"robotId":"fr5-lab-a","observeOnly":true}' | head -c 120; echo

# ⛔ 원본이 안 바뀌었음을 **매번 확인한다** — 이 줄이 그날의 사고를 막는 가드다
if [ "$BEFORE" = "$(shasum -a 256 FR5/bridge/config.yaml | cut -d' ' -f1)" ]; then
  echo "  ✅ 원본 config.yaml 무변경 (이 스크립트는 손대지 않았다)"
else
  echo "  ⛔ 이 스크립트가 도는 사이 원본 config.yaml 이 바뀌었다 — 확인하라"
  git diff --stat -- FR5/bridge/config.yaml
fi
echo "  http://localhost:5176/   (끄기: bash scripts/dev/twin-local.sh --stop)"
echo "  ⚠ 관절·자세는 가짜다. 구역·상자·벽만 실기 값이다"

exit 0   # 자식(브리지·vite)은 살려 두고 스크립트만 끝낸다 — 없으면 셸이 자식을 기다린다
