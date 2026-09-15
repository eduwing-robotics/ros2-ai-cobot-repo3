# FR5 bridge 경계

FAIRINO FR5의 유일한 명령 관문이다. 계약은 `docs/ref/contract/API-CONTRACT.md`가 정본이다.

구현됨 (P0~P2 · 2026-07-31):

- robot profile 선택(`config.yaml`)과 observe-only preflight — 불일치는 `FAIL_CLOSED` + 사유
- `/robots` `/connect` `/version` `/disconnect` `/state` `/ws/state` (33ms 브로드캐스트)
- 조종권 한 명(`/owner/*` · hello 신원, 409) · `/arm`(`confirm:"현장확인"` 강제) · `/disarm`
- guarded jog/moveJ — SAFETY-RULES 게이트(속도 10%·관절 5°·URDF 한계·신선도·드리프트) ·
  **stop 은 신원·조종권 무관 항상 통과** · owner 소실 = 자동 disarm
- `robot_adapter/` — mock 과 **fairino(공식 Python SDK 순수 표준 라이브러리 벤더링, D42)**.
  실기 첫 조그 통과 (`docs/archive/evidence-2026-07/2026-07-31/fr5-first-motion.md`)
- 빌드된 웹(`FR5/dist`)을 같은 주소에서 LAN 서빙 — 주소를 여는 누구나 조작 후보 (팀 신뢰)
- 실행 `bash scripts/dev/fr5-dev.sh` (준비물 없음 — 순수 파이썬 SDK, D42) ·
  검증 `node scripts/check/fr5-{bridge,web}-verify.mjs` ·
  실기 배포 `bash scripts/deploy/fr5-ubuntu.sh` (우분투 호스트 · `http://192.168.30.240:5055`)

예정 책임:

- 실기 arm·jog 현장 체크리스트 승격 (하드룰 3 — 사람 확인)
- Vision은 명령 대신 `POST /proposal`을 보내며 안전 게이트 통과분만 실행
- 지점·경로·슬롯·실행 기록의 API 경계 (P3~)

`robot_adapter/` 밖에서 FAIRINO SDK를 직접 부르지 않는다. xmlrpc 는 연결 하나뿐이라
브리지 밖에서 20003 에 병행 접속해서도 안 된다 (D42). `fairino_cs/` 는 폐기된 C# 경로의
증거 보존본이다 — 어디서도 부르지 않는다.
