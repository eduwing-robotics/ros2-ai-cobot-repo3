# TurtleBot — 터틀봇 브리지 (tb-bridge · 로봇 파이 안 · **웹앱은 없다**)

**계약이 먼저다** — `docs/ref/contract/TB-CONTRACT.md` 를 고치고 코드를 짠다 (D29~D31).
**화면은 `FR5/` 의 「터틀봇」 탭이다** (D182 · 2026-09-05) — 옛 웹앱(`src/`)은 퇴역했다.
제일 큰 칸이 목업 지형 위 점 하나였고, 그 값은 FR5 트윈이 실측으로 그린다.
**포트는 5056** — 정본은 `bridge/config.yaml` 의 `port` 한 줄 · 기동 스크립트가 읽는다.

- 브리지는 **로봇 파이 안**에서 systemd 로 돈다(`http://192.168.30.15:5056` · 2026-08-18) —
  배포 `bash scripts/deploy/tb-pi.sh`. 맥에서는 `bash scripts/dev/tb-dev.sh` 로 mock 브리지
- **ROS 는 `bridge/ros_adapter/` 안에서만.** mock↔real 파일 교체가 환경 전환의 전부 (D30)
- 화면 쪽 클라이언트는 `Shared/data/datasource/tb-client.js`(실물) · `tb-mock.js`(목업) —
  FR5 가 `?tb=<host>` / `?tb=mock` 으로 고른다. 두 파일의 **얼굴은 같아야 한다** (`tb-unit.sh`)
- 안전은 브리지가 강제 — 속도 상한 · 워치독 500ms · `estop` 항상 통과. 클라이언트를 믿지 않는다
- 쓰기(`POST`…)는 FR5 조작 화면의 출처에서만 받는다 — `main.py` §CORS (계약 §미래 접점 ④)
- 팀원 주행 스크립트는 `bridge/slots/` 에 꽂힌다 — 계약은 `bridge/slots/README.md`

## 폴더

| 경로 | 무엇 |
|---|---|
| `bridge/` | FastAPI 관문 — 상태 WS·슬롯 프로세스·맵·live.png·기록 |
| `bridge/ros_adapter/` | ROS 유일 경계 — mock·real 둘 다 동작 (real 은 D43) |
| `bridge/slots/` | 팀원 파이썬 슬롯 — 계약은 `slots/README.md` |
| `deploy/` | **로봇 파이의 상주 배선 정본 사본** — `start-bridge.sh` · systemd 유닛 2개 |

검증 `bash scripts/check/tb-unit.sh` · `node scripts/check/tb-{bridge,cycle}-verify.mjs` ·
화면은 `node scripts/check/tb-web-verify.mjs`(FR5 dev + `?tb=mock`)
읽을 것 — `docs/ref/contract/TB-CONTRACT.md`
