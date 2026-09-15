# RECORD-NODE-CONTRACT — 기록 노드 계약

분류: **SSOT**. 랩 안 상주 SQLite 기록 노드(파이5 `fr5-log`)가 브리지에서 무엇을 받아 어떻게
저장하고 팀에 무엇을 서빙하는지의 유일한 합의점이다. **여기를 먼저 고치고 코드를 짠다** (하드 룰 1).

`API-CONTRACT.md` 가 아니라 여기 산다 — 그 문서가 450줄 상한에 닿았고, 기록 노드는 수명주기
(수집→서빙)와 소비자(datasource 경계)가 상태·명령과 다르다 (슬롯을 뺀 것과 같은 이유 · D81).

결정 근거는 D81, 폴더 규칙은 `Database/AGENTS.md`. 이 문서는 그 둘을 **실행 가능한 모양**으로 옮긴다.

## 무엇이고 무엇이 아닌가

```
FR5 브리지 :5055  ┐
TB  브리지 :5056  ┤─(읽기 WS 구독)→  기록 노드 (파이5 :5060)  ─(읽기 HTTP)→  datasource → 화면
카메라 브리지 :5058 ┘                    │
                                    SQLite (SD/SSD · 파일 한 개)
```

- **읽기 전용 구독자다.** 브리지의 기존 `/ws/state` 를 구독만 한다 — 새 WS 메시지·새 명령
  엔드포인트를 브리지에 **더하지 않는다.** 그래서 이 계약은 브리지 계약을 안 건드린다.
- **쓰는 주체는 프로세스 하나** (D81). SQLite 는 네트워크 DB 가 아니다 — 여러 곳에서 동시에
  쓰면 깨진다. 수집기 하나만 쓰고, 나머지는 전부 HTTP 로 **읽기만** 한다.
- **브라우저가 저장소를 직접 부르지 않는다** (D41 로그인 없음). 서버만 말하고, 화면은
  `Shared/data/datasource/` 경계를 통해서만 소비한다. 주소를 아는 누구나 남의 기록을
  지우는 일이 없어야 한다.
- **호스트는 파이5** (2026-08-07 실측 · `evidence/2026-08-07/pi5-log-node-bringup.md`). 포트 5060
  은 제안값이고 **정본은 파이의 config** 다 (D80 규약 — 한 자원에 하나).

## 어떻게 붙나 (수집)

| 출처 | 무엇을 | 어느 테이블로 |
|---|---|---|
| `GET /robots` · `/version` | 로봇 정체 | `robot` (upsert) |
| `/ws/state` (FR5 ~27Hz · TB pose) | 연속 상태 표본 | `state_sample` · `session` |
| `POST /trajectories/stop` 결과 | Teach 저장 궤적 | `trajectory` |
| TB run 저장 · `/ws/logs` | 주행 run · 사건 | `run` · `event` |
| `POST /slots/{name}/step` 결과 | 슬롯 실행 감사 | `slot_execution` |
| 맵(맵 편집기) | 레이아웃 플랜 | `layout` |

- **연결이 끊겨도 티칭·실행·열람이 멈추지 않는다** (fail-closed 의 데이터 판 · `Database/AGENTS.md`).
  브리지 로컬 파일(`~/fr5-data/`)이 정본이고, 이 노드는 **상위 공유층**이다.
- **모든 하드웨어 유래 행에 `raw_json` 원본을 함께 싣는다.** 정체(`robotId`·펌웨어·tool/user·
  그리퍼·`source`)와 서버 시각은 **소급해 못 채운다** (D46·D81). 해석하지 않고 원본을 남긴다.

## 서빙 (팀 읽기 · 전부 GET · 조종권 불필요)

```
GET /records/trajectories?robotId=&purpose=&comparable=   → 목록 (프레임 제외)
GET /records/trajectories/{id}                            → frames 포함
GET /records/runs?layoutId=
GET /records/events?station=&from=&to=
GET /records/samples?robotId=&from=&to=                   → 상태 표본 범위 질의
```

`comparable=1` 은 measure·무결손·정상종료만 준다 (D74). **stamp 가 다른 measure 를 나란히
놓지 않는다** — 같은 조건 그룹인지는 `stamp_json` 으로 질의 시 가른다.

## 스키마 (정본 · 10 테이블)

단위는 **mm·도(°)** 그대로 (하드 룰 5). 시각은 **브리지 서버 시각 epoch 초** — RTC 의존(D81 조건③).
맵 좌표만 **실험실 바닥 원점** 이다 (SR_23 — 로봇 베이스로 저장하면 맵끼리 비교 불가).

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;

CREATE TABLE schema_meta (version INTEGER NOT NULL, applied_at REAL NOT NULL);

-- 정체 = 프로필 robotId, IP 아님
CREATE TABLE robot (
  robot_id TEXT PRIMARY KEY, kind TEXT NOT NULL,      -- arm | amr | (미래: sensor…)
  name TEXT, model TEXT, endpoint TEXT,
  first_seen REAL, last_seen REAL, raw_json TEXT);

CREATE TABLE session (
  id INTEGER PRIMARY KEY, robot_id TEXT REFERENCES robot(robot_id),
  opened_at REAL NOT NULL, closed_at REAL, observe_only INTEGER DEFAULT 1,
  owner TEXT, end_phase TEXT, raw_json TEXT);

-- 연속 스트림. 뜨거운 컬럼만 뽑고 나머지는 raw_json (새 필드는 마이그레이션 없이 raw 로)
CREATE TABLE state_sample (
  id INTEGER PRIMARY KEY, robot_id TEXT NOT NULL REFERENCES robot(robot_id),
  session_id INTEGER REFERENCES session(id), t REAL NOT NULL,
  phase TEXT, connected INTEGER, enabled INTEGER,
  joints_json TEXT, tcp_json TEXT, pose_json TEXT,    -- arm 관절·손끝 / amr pose
  gripper_pct REAL, safety_json TEXT, raw_json TEXT NOT NULL);
CREATE INDEX ix_sample_robot_t ON state_sample(robot_id, t);

CREATE TABLE trajectory (
  id INTEGER PRIMARY KEY, robot_id TEXT REFERENCES robot(robot_id),
  name TEXT, source TEXT, purpose TEXT, fps REAL, duration_sec REAL,
  start_pose_json TEXT, end_reason TEXT, dropped INTEGER DEFAULT 0,
  stamp_json TEXT, frames_json TEXT, created_at REAL NOT NULL,
  comparable INTEGER GENERATED ALWAYS AS                -- D74 단일행 비교자격
    (CASE WHEN purpose='measure' AND dropped=0 AND end_reason='done' THEN 1 ELSE 0 END) STORED);
CREATE INDEX ix_traj_robot ON trajectory(robot_id, created_at);

CREATE TABLE run (
  id INTEGER PRIMARY KEY, robot_id TEXT REFERENCES robot(robot_id),
  layout_id TEXT, started_at REAL, ended_at REAL, outcome TEXT,
  path_json TEXT, raw_json TEXT);

-- 라인 사건. kind+payload 제네릭 → 새 사건에 테이블을 안 늘린다
CREATE TABLE event (
  id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES run(id),
  robot_id TEXT REFERENCES robot(robot_id), t_server REAL, t_run_sec REAL,
  station TEXT, kind TEXT NOT NULL, payload_json TEXT);
CREATE INDEX ix_event_station ON event(station, t_server);

CREATE TABLE slot_execution (
  id INTEGER PRIMARY KEY, slot_name TEXT, step_index INTEGER,
  point_name TEXT,                                     -- 좌표 아닌 지점 이름 참조
  robot_id TEXT REFERENCES robot(robot_id), who TEXT,
  executed_at REAL NOT NULL, result TEXT, raw_json TEXT);

-- 맵. 원점 = 실험실 바닥 (SR_23)
CREATE TABLE layout (
  layout_id TEXT PRIMARY KEY, name TEXT, revision TEXT,
  frame TEXT DEFAULT 'lab-floor', plan_json TEXT, created_at REAL, raw_json TEXT);

-- 영상·큰 바이너리는 테이블에 안 넣는다 — 경로만
CREATE TABLE media (
  id INTEGER PRIMARY KEY, kind TEXT, path TEXT NOT NULL,
  robot_id TEXT REFERENCES robot(robot_id), run_id INTEGER REFERENCES run(id),
  trajectory_id INTEGER REFERENCES trajectory(id), t_server REAL, raw_json TEXT);
```

정본은 이 문서다. `Database/` 의 마이그레이션 파일은 이걸 따른다 — 두 곳이 어긋나면 여기가 이긴다.

## 확장성 5원칙 (스키마에 박은 것)

1. **`raw_json` 원본 보존** — 하드웨어 유래 모든 행에. 새 SDK/계약 필드가 마이그레이션 없이 산다
2. **`robot.kind`·`event.kind` 제네릭** — 새 로봇(팔→AMR→센서)·새 사건에 테이블을 안 늘린다
3. **`schema_meta.version`** — 마이그레이션 경로
4. **`source`·`stamp` 보존** — 조건 다른 measure 를 안 섞는다 (D74)
5. **값 아닌 참조** — 지점은 이름, 로봇은 프로필 id, 맵은 `layout_id` (좌표를 굳혀 넣지 않는다)

## 보존 정책 (2026-08-07 결정 · D81 하위)

**계층 보존이다 — 하나의 스위치로 안 정한다.** 생산성 분석이 질의하는 건 `event`·`trajectory`·
`run` 이지 27Hz 관절 스트림이 아니다. 원시 스트림은 텔레메트리라 무한 보존 대상이 아니다.

| 부류 | 보존 | 근거 |
|---|---|---|
| **아티팩트** (`trajectory`·`run`·`event`·`layout`·`slot_execution`) | **영구·전부** | 경계가 있고 소급 불가 · 비교(D74)의 기질 · 다 합쳐 하루 수십 MB |
| **`state_sample`** (연속 27Hz) | **움직일 때만 + 14일 보존창** | 텔레메트리 · 정지 중복 |

- **`state_sample` 기록 조건** — 「**움직였나**」만 본다: `motionQueueLength>0` OR 관절 변화 > ε
  OR **그리퍼 `pct` 변화 > ε** OR **전이**(`phase`·`safety`·`connected`·**`enabled`**·그리퍼 플래그).
  유휴는 건너뛴다. 단 **전이는 드물고 중요해 항상 기록**.
  기본 ε — 관절 0.1° · AMR 위치 5mm · AMR 방향 0.5° · **그리퍼 0.5%p** (`Database/retention.py` 상수 ·
  마지막 **저장한** 프레임 기준이라 느린 드리프트도 누적되면 잡힌다).
- ⚠ **`enabled=1` 을 저장 조건으로 쓰지 않는다** (2026-08-10 실기 실측으로 정정). 서보를 올린 채
  세워 두는 것이 실사용의 **기본 상태**라 그 한 줄이 게이트를 통째로 단락시켰다 — 실기 10초에서
  관절 변동폭 **0.0008°**(ε 의 1/125)인데 **297/297 저장 · 건너뜀 0%** 였다. `enabled` 는
  **전이일 때만** 싣는다 (서보 온·오프는 드물고 중요하다).
- ⚠ **그리퍼가 조건에 반드시 있어야 한다.** 집기는 **팔이 선 채 손만** 움직인다 — 관절만 보면
  파지 구간이 통째로 안 남는다. `pct` 변화와 `motionDone`·`fault`·`active` 전이가 파지 킬실험의
  계측선이다 (`GAP-MATRIX` 파지 2건).
- 궤적을 정식 녹화 중이면 그 구간 `state_sample` 은 건너뛴다 — `trajectory.frames` 와 중복이다.
- **14일 지난 `state_sample` 은 자동 정리.** 아티팩트는 영구라 되짚기가 안 사라진다.
- 산술 (**2026-08-10 실측으로 정정**) — 행당 디스크는 `348B` 가 아니라 **4,124B** 다
  (`raw_json` 원본 보존 · **확장성 원칙 1번이 앞선 산술에 안 들어갔다**). 서보 올린 채 전량 저장이면
  29.7Hz × 4,124B = **9.85GB/일** · 14일이면 **138GB** 로 파이5 SD 가 못 받는다.
  **이 게이트는 최적화가 아니라 전제다.** 움직일 때만이면 활성 구간에만 값이 든다.
  근거 — `evidence/2026-08-10/retention-gate-armed-hole.md`
- **①항상**(정지 중복 안티패턴)·**③N분 롤업**(②의 다음 단계 · 지금 열지 않음 — `ponytail:` 업그레이드 경로)은 기각/보류.

## 미결 — 착수 전 정할 것

- **내구성 분리** — 슬롯 실행·승인 감사(`slot_execution`)는 한 건도 잃으면 안 되니
  `synchronous=FULL` 로 분리할지. 궤적 표본은 NORMAL 로 둔다 (354배 여유 · 스파이크 실측).
- **frames 저장** — 지금 `frames_json` 블롭. 프레임별 질의(생산성 분석)가 필요해지면
  자식 테이블로 승격 (ceiling — 지금 열지 않는다).

## 근거

- 실증 — `evidence/2026-08-07/pi5-log-node-bringup.md` (기록 왕복 29.7Hz→SD, 유입의 354배 여유)
- 결정 — D81(`DECISION-LOG-CURRENT.md`) · 폴더 규칙 `Database/AGENTS.md` · 경계 `SHARED-CORE.md` §datasource
