-- FR5Web 기록 노드 스키마 v0
-- 정본은 docs/ref/contract/RECORD-NODE-CONTRACT.md — 어긋나면 계약이 이긴다.
-- 단위: mm·도(°) 그대로 (하드 룰 5). 시각: 브리지 서버 시각 epoch 초 (RTC 의존 · D81 조건③).
-- 배치안 좌표만 실험실 바닥 원점 (SR_23).

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL, applied_at REAL NOT NULL);

-- 정체 = 프로필 robotId, IP 아님
CREATE TABLE IF NOT EXISTS robot (
  robot_id TEXT PRIMARY KEY, kind TEXT NOT NULL,      -- arm | amr | (미래: sensor…)
  name TEXT, model TEXT, endpoint TEXT,
  first_seen REAL, last_seen REAL, raw_json TEXT);

CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY, robot_id TEXT REFERENCES robot(robot_id),
  opened_at REAL NOT NULL, closed_at REAL, observe_only INTEGER DEFAULT 1,
  owner TEXT, end_phase TEXT, raw_json TEXT);

-- 연속 스트림. 뜨거운 컬럼만 뽑고 나머지는 raw_json (새 필드는 마이그레이션 없이 raw 로)
CREATE TABLE IF NOT EXISTS state_sample (
  id INTEGER PRIMARY KEY, robot_id TEXT NOT NULL REFERENCES robot(robot_id),
  session_id INTEGER REFERENCES session(id), t REAL NOT NULL,
  phase TEXT, connected INTEGER, enabled INTEGER,
  joints_json TEXT, tcp_json TEXT, pose_json TEXT,    -- arm 관절·손끝 / amr pose
  gripper_pct REAL, safety_json TEXT, raw_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sample_robot_t ON state_sample(robot_id, t);

CREATE TABLE IF NOT EXISTS trajectory (
  id INTEGER PRIMARY KEY, robot_id TEXT REFERENCES robot(robot_id),
  name TEXT, source TEXT, purpose TEXT, fps REAL, duration_sec REAL,
  start_pose_json TEXT, end_reason TEXT, dropped INTEGER DEFAULT 0,
  stamp_json TEXT, frames_json TEXT, created_at REAL NOT NULL,
  comparable INTEGER GENERATED ALWAYS AS                -- D74 단일행 비교자격
    (CASE WHEN purpose='measure' AND dropped=0 AND end_reason='done' THEN 1 ELSE 0 END) STORED);
CREATE INDEX IF NOT EXISTS ix_traj_robot ON trajectory(robot_id, created_at);

CREATE TABLE IF NOT EXISTS run (
  id INTEGER PRIMARY KEY, robot_id TEXT REFERENCES robot(robot_id),
  layout_id TEXT, started_at REAL, ended_at REAL, outcome TEXT,
  path_json TEXT, raw_json TEXT);

-- 라인 사건. kind+payload 제네릭 → 새 사건에 테이블을 안 늘린다
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES run(id),
  robot_id TEXT REFERENCES robot(robot_id), t_server REAL, t_run_sec REAL,
  station TEXT, kind TEXT NOT NULL, payload_json TEXT);
CREATE INDEX IF NOT EXISTS ix_event_station ON event(station, t_server);

CREATE TABLE IF NOT EXISTS slot_execution (
  id INTEGER PRIMARY KEY, slot_name TEXT, step_index INTEGER,
  point_name TEXT,                                     -- 좌표 아닌 지점 이름 참조
  robot_id TEXT REFERENCES robot(robot_id), who TEXT,
  executed_at REAL NOT NULL, result TEXT, raw_json TEXT);

-- 배치안. 원점 = 실험실 바닥 (SR_23)
CREATE TABLE IF NOT EXISTS layout (
  layout_id TEXT PRIMARY KEY, name TEXT, revision TEXT,
  frame TEXT DEFAULT 'lab-floor', plan_json TEXT, created_at REAL, raw_json TEXT);

-- 영상·큰 바이너리는 테이블에 안 넣는다 — 경로만
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY, kind TEXT, path TEXT NOT NULL,
  robot_id TEXT REFERENCES robot(robot_id), run_id INTEGER REFERENCES run(id),
  trajectory_id INTEGER REFERENCES trajectory(id), t_server REAL, raw_json TEXT);
