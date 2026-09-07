#!/usr/bin/env bash
# 로컬에서 화면을 띄운다. Vite dev 서버를 부른다.
#
#   bash scripts/dev/serve.sh            # AR (기본)
#   bash scripts/dev/serve.sh dash       # Dashboard (아직 없다)
#
# **카메라는 HTTPS 에서만 열린다.** 폰 테스트는 배포본으로 한다 —
# 로컬 IP(`http://192.168.x.x`)로는 브라우저가 카메라를 안 준다 (README §로컬).
# 로컬에서 확인할 수 있는 것은 3D·모듈 해석·기준값이고, 카메라는 폰이다.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TARGET="${1:-ar}"
case "$TARGET" in
  ar)   WS=@fr5/ar ;;
  dash) WS=@fr5/dashboard
        [ -d Dashboard ] || { echo "FAIL  Dashboard/ 가 아직 없다 (L1 에서 만든다)"; exit 1; } ;;
  *)    echo "모르는 대상: $TARGET  (ar | dash)"; exit 2 ;;
esac

[ -d node_modules ] || { echo "의존성이 없다 → npm install"; npm install || exit 1; }

# 설정 JSON 은 .env 에서 굽는 산출물이다. 없으면 **빌드가 실패한다** (D18).
if [ ! -f Shared/data/config/marker-offset.json ]; then
  echo "설정 JSON 이 없다 → node scripts/build/config.mjs"
  node scripts/build/config.mjs || exit 1
fi

echo "→ npm run dev -w $WS"
exec npm run dev -w "$WS"
