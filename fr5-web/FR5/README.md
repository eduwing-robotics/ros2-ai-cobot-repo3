# FR5 — 웹 티칭 펜던트 + 로봇 브리지 · **Live 동작 중**

이 폴더가 FR5 조작 기능의 수직 배포 단위다. `Dashboard/`는 배치·지표만 보여주고 명령을 안 보낸다.

- 계약부터: `docs/ref/contract/API-CONTRACT.md`. 실기 명령·엔드포인트는 문서를 먼저 바꾸고 짠다
- 브라우저는 로봇과 직접 통신하지 않는다. 유일한 관문은 `bridge/`
- 안전은 `bridge/`에서만 강제: 속도 10% · 관절 5° · `stop`은 항상 통과.
  **stop 은 잠금도 기다리지 않는다** — 잠금도 정지를 막는 조건이다 (D45)
- 명령 주인은 한 명. 오류·연결 손실·소유권 불명은 fail-closed
- 실기 경로는 **순수 파이썬 SDK 벤더링**이다 (D42). C# dll·Mono 경로는 폐기 — 부르지 않는다
- 브링업은 observe-only 부터. 명령 승격(`/arm`) 뒤에만 서보·모드를 바꾼다
- 화면에서 직접 `fetch` 금지 — `src/data/datasource/` 로 목업↔실물을 바꾼다

## 폴더

| 경로 | 책임 |
|---|---|
| `src/screens/` | 화면 진입점 jsx+css 한 쌍 |
| `src/features/` | 조작·티칭·슬롯·경로·기록 화면 경계. 지금 사는 것: `live/` `teach/` `program/` `control/` `sim/`(**4단 마법사** — ① 어디 있나(카메라 두 번 보고 맞춤 · `AimBlock`) → ② 할 수 있나(신호등 셋: 닿아요·부딪히지 않아요·안전장치) → ③ 한 칸씩(「다음 칸 ▶」+ 상시 정지 · 현장확인 1회) → ④ 기록. 질문 하나·큰 버튼 하나·결과 한 문장이 기본 화면이고, 9칸·정차 후보·사이클 재생·26칸 목록·장부는 각 단계의 「자세히」 안에 산다(지운 게 아니라 접은 것 · 게이트 `data-t` 유지) · 2026-09-07 D194 · 이전 절 하나 구조는 D188) `amr/`(**「터틀봇」 탭** — 로봇 카드·배터리·조종권·WASD·경로·슬롯·E-STOP, 옛 터틀봇 웹앱의 주행 탭 · D182 · **되감기 `RunPanel` 도 여기**(D188)) — History 탭은 없다(D182) |
| `src/data/datasource/` | 화면과 브리지·DB 사이의 유일한 데이터 경계 |
| `bridge/` | FastAPI·안전·조종권·상태·웹 빌드 서빙 경계 |
| `bridge/robot_adapter/` | mock과 FAIRINO SDK 교체 경계 |

**P0~P2 완료** · 실기 첫 조그와 그리퍼 개폐 통과. 브리지는 우분투에서 systemd 로 돈다 —
배포 `bash scripts/deploy/fr5-ubuntu.sh`. 다음은 `docs/goals/GOAL-live-gripper.md` 부터
사다리 4칸이고, 5개 패널 순서는 `docs/ref/plan/FR5-IMPLEMENTATION-PLAN.md` 가 정본이다.
