# FR5 Web Workspace

FR5 조작 화면, 디지털 트윈, AR/XR, 작업 셀 관제, TurtleBot·카메라 관문, MuJoCo 검토를 한 워크스페이스에서 개발합니다.

프로젝트의 발전 과정과 실기 자료는 [상위 README](../README.md), 날짜·커밋별 색인은 [FR5 증거 타임라인](../docs/FR5-EVIDENCE-TIMELINE.md)에서 먼저 볼 수 있습니다.

> 이 폴더는 2026-09-07 16:31에 반입한 코드 스냅샷입니다. 09-10 S0–S4 실기 결과와 09-11 작업 중 변경은 아직 이 브랜치 코드에 동기화되지 않았습니다.

## 실행 화면

| 화면 | 개발 주소 | 역할 |
|---|---|---|
| FR5 | `:5176` | Live·Teach·Program·시뮬·TurtleBot 탭 |
| Dashboard | `:5187` | 작업 셀 맵 편집, 배치·시뮬 결과 비교 |
| AR | Vite 개발 주소의 `/ar.html`, `/cam.html`, `/xr.html` | 마커 AR, 글로벌 카메라 겹치기, WebXR 답사 |
| FR5 Bridge | `:5055` | 상태·조종권·안전 검사·FR5 명령 |
| TurtleBot Bridge | `:5056` | ROS 2 상태와 이동 슬롯 |
| Camera Bridge | `:5058` | 손목 D435 RGB-D 프레임과 측정값 |

## 모듈 경계

| 경로 | 소유하는 것 | 하지 않는 것 |
|---|---|---|
| `Dashboard/` | 맵 편집, 배치 보기, 지표·시뮬 결과 표시 | 로봇 명령·안전 판단 |
| `AR/` | 마커 인식, 실물 영상 겹치기, XR 배치·경로 표시 | FR5 SDK 직접 호출 |
| `FR5/src/` | 로봇 조작 UI와 디지털 트윈 | 최종 안전 판정 |
| `FR5/bridge/` | FAIRINO SDK, 상태기계, 조종권, 안전 게이트 | 센서 화면 렌더링 |
| `Vision/` | D435 장치 접근과 관측 API | 로봇 명령 |
| `TurtleBot/` | TurtleBot별 상태·이동 관문 | FR5 관문의 내부 호출 |
| `Sim/` | IK·작업영역·접촉 검토 | 실기 성공 판정 |
| `Shared/` | 좌표, 설정 산출물, 3D 자산, 공용 화면 코드 | 앱별 실행 정책 |

브라우저는 로봇과 직접 통신하지 않습니다. FR5 동작은 `FR5/bridge/` 한 곳에서만 보내며, 화면과 센서가 만든 값은 제안 입력으로 취급합니다.

## 로컬 실행

```bash
cp .env.example .env
npm install
npm run config
bash scripts/dev/fr5-dev.sh
```

명령별 용도는 다음과 같습니다.

```bash
npm run dev:fr5       # FR5 화면만
npm run dev:dash      # 맵 편집·비교 화면
npm run dev:ar        # AR/XR 화면
bash scripts/dev/fr5-dev.sh bridge  # FR5 Bridge만
```

`Shared/data/config/*.json`은 `.env`에서 생성되는 파일입니다. 직접 수정하지 말고 `.env`를 바꾼 뒤 `npm run config`를 다시 실행합니다.

## 검증

```bash
bash scripts/check/all.sh --fast
```

2026-09-11 빠른 게이트에서 `grasp-rank`, `sim-batch` 두 검사가 기존 실측·픽스처 차이로 실패했습니다. `agree`는 로봇이 연결되지 않아 판정 재료가 없었습니다. 따라서 일부 검사 통과를 전체 실기 검증으로 확대해 말하지 않습니다.

## 실물 운용

- 시작은 [`docs/ref/runbook/FR5-BRINGUP.md`](docs/ref/runbook/FR5-BRINGUP.md)를 따릅니다.
- FR5는 observe-only로 먼저 연결합니다.
- 한 명만 조종권을 가지며, 사람이 현장을 확인한 뒤에만 ARM 상태로 올립니다.
- `stop`은 조종권이나 화면 상태와 무관하게 통과해야 합니다.
- TurtleBot 정지와 센서 신선도를 확인할 수 없으면 동작 명령을 차단합니다.
- AR 카메라와 WebXR은 HTTPS 또는 localhost에서 사용합니다.

## 문서 지도

| 목적 | 문서 |
|---|---|
| 시스템 경계 | [`docs/ref/arch/ARCHITECTURE.md`](docs/ref/arch/ARCHITECTURE.md) |
| API·상태 계약 | [`docs/ref/contract/API-CONTRACT.md`](docs/ref/contract/API-CONTRACT.md) |
| 안전 조건 | [`docs/ref/contract/SAFETY-RULES.md`](docs/ref/contract/SAFETY-RULES.md) |
| 좌표계 | [`docs/ref/contract/FRAMES.md`](docs/ref/contract/FRAMES.md) |
| AR 문제 해결 | [`docs/ref/runbook/AR-DEBUG.md`](docs/ref/runbook/AR-DEBUG.md) |
| 결정 배경 | [`docs/status/DECISION-LOG.md`](docs/status/DECISION-LOG.md) |
