#!/usr/bin/env bash
# 기록 노드 게이트 — 스키마 로드(10 테이블) + 보존 게이트 단위 테스트. 장비·브리지 없이 돈다.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="$ROOT/Database"
FAIL=0

echo "== 스키마 로드 =="
TMP="${TMPDIR:-/tmp}/fr5-db-gate-$$.db"
python3 "$DB/migrate.py" "$TMP" >/dev/null || FAIL=1
N=$(python3 - "$TMP" <<'PY'
import sqlite3, sys
print(sqlite3.connect(sys.argv[1]).execute(
    "SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0])
PY
)
[ "$N" = "10" ] && echo "  10 테이블 OK" || { echo "  테이블 $N 개 (10 기대)"; FAIL=1; }
rm -f "$TMP" "$TMP-wal" "$TMP-shm"

echo "== 보존 게이트 단위 테스트 =="
( cd "$DB" && python3 -m unittest test_retention 2>&1 | tail -3 ) || FAIL=1

[ "$FAIL" -eq 0 ] && echo "기록 노드 OK" || echo "기록 노드 실패"
exit "$FAIL"
