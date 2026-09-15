#!/usr/bin/env python3
"""기록 노드 DB 초기화·마이그레이션. 표준 라이브러리만 (D81 — 새 의존성 0).

    python3 migrate.py <db경로>      # 없으면 만들고 스키마 적용, 버전 기록

스키마 정본은 schema.sql (그 정본은 다시 RECORD-NODE-CONTRACT.md). 이 스크립트는 옮기지 않는다 —
schema.sql 을 읽어 그대로 적용하고 schema_meta.version 만 관리한다.
"""
import sqlite3, sys, os, time

SCHEMA_VERSION = 0
HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_SQL = os.path.join(HERE, "schema.sql")


def current_version(db):
    row = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'"
    ).fetchone()
    if not row:
        return None
    r = db.execute("SELECT max(version) FROM schema_meta").fetchone()
    return r[0] if r else None


def migrate(db_path):
    """스키마를 적용하고 도달 버전을 반환한다. 이미 최신이면 그대로 둔다."""
    db = sqlite3.connect(db_path)
    try:
        db.executescript(open(SCHEMA_SQL, encoding="utf-8").read())  # CREATE … IF NOT EXISTS — 재적용 안전
        if current_version(db) != SCHEMA_VERSION:
            db.execute("INSERT INTO schema_meta(version, applied_at) VALUES(?,?)",
                       (SCHEMA_VERSION, time.time()))
        db.commit()
        return current_version(db)
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    v = migrate(sys.argv[1])
    print(f"OK · {sys.argv[1]} · schema v{v}")
