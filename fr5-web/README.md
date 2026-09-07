# FR5AR — 배치를 바꾸면 생산성이 얼마나 달라질까

**과학실험실에서 로봇팔과 자율주행로봇(AMR)의 배치에 따라 생산성이 얼마나 달라지는지** 재는
웹 작업대. 배치안을 화면에서 바꿔 지표를 비교하고, **앱 설치 없이 폰 카메라로 그 배치안을
실제 실험실 바닥에 겹쳐** 통로·작업대와 충돌하는지 확인한다.

## 이 저장소가 맡는 것

| | 누가 | 무엇 |
|---|---|---|
| **이 저장소** | 우리 | **시각화** — 배치안 편집 · 지표 비교 · 실물 위 겹쳐 보기 |
| 다른 코드 | 팀원 | 생산성 수치를 내는 알고리즘 |
| 다른 코드 | 팀원 | AMR 자율주행 |

**우리는 수치를 만들지 않는다. 받아서 보여준다.** 그래서 두 가지를 지킨다 —
받는 모양을 우리가 먼저 제시하고(`docs/ref/contract/API-CONTRACT.md`), 나중에 백엔드·데이터베이스로
바꿔 끼울 수 있게 한 곳으로 격리한다(`Shared/data/datasource/`).

## 지금 바로 보기

**브리지 호스트 주소** — `bash scripts/deploy/fr5-ubuntu.sh` 가 빌드된 화면을 브리지와 같은 주소(`:5055`)에서 LAN 서빙한다. 주소는 팀 채널 공지를 본다.

로그인 없이 열린다. **겹쳐 보기 (AR)** → **시작** → 카메라 허용 → 마커를 비추고 **2~3초 기다린다**.

> 바로 안 뜨는 것이 정상이다. 검출기가 첫 인식까지 수십 프레임을 먹는다.

### 마커 인쇄

`Shared/assets/marker/marker-print-A4-170mm-bc2.png` — **A4에 100% 배율**로 뽑는다.

| 지켜야 할 것 | 왜 |
|---|---|
| **100% 배율.** "용지에 맞춤"·"축소" 끄기 | 크기가 틀리면 로봇 크기가 틀린다 |
| **무광 용지** | 광택지 반사광이면 크기와 무관하게 안 잡힌다 |
| **딱딱한 판에 평평하게** | 휘면 사각형 검출이 깨진다 |
| **인쇄 후 자로 검은 사각형을 잰다** | 프린터가 축소한다. 실측 143mm 였다 (목표 170의 84%) |

잰 값은 화면 **⚙** 또는 `.env` 의 `FR5_MARKER_MM` 에 넣는다.

## 화면

| 주소 | 하는 일 | 상태 |
|---|---|---|
| `/ar.html` | **겹쳐 보기.** 상자 / 로봇 / 궤적 / 안전 범위 · ⚙ 조정판 · 진단 수치 | 동작 |
| `/robot.html` | 카메라 없이 3D 로봇만. 그리퍼 장착값 맞추는 화면 | 동작 |
| `/test/marker-detect.html` | 합성 이미지로 실제 검출기를 재는 검증 페이지 | 동작 |
| `Dashboard/` | **관제화면** — 배치안 편집 · 생산성 지표 비교 (React) | 동작 |
| `FR5/` | **웹 티칭 펜던트 + 브리지** — 조작 · 티칭 · 슬롯 · 경로 · 기록 | 문서성 골격 |

화면·로봇 도메인은 `AR/` · `Dashboard/` · `FR5/` · `TurtleBot/`으로 갈리고 공용은
`Shared/`다. FR5 조작은 Dashboard 탭이 아니라 `FR5/`가 웹+브리지로 수직 소유한다.
경계는 `docs/ref/arch/BUILD-VITE.md`.

**안 될 때는 `docs/ref/runbook/AR-DEBUG.md`** — 증상별 원인표와 진단 수치 읽는 법이 있다.

## 로컬에서 돌리기

```bash
cp .env.example .env               # 설정. .env 는 커밋하지 않는다
npm install                        # workspaces (shared · AR) — 처음 한 번
node scripts/build/config.mjs      # .env → Shared/data/config/*.json 생성 (필수)
bash scripts/dev/serve.sh          # Vite dev 서버
```

> **`Shared/data/config/*.json` 은 생성물이다.** 직접 고치지 말고 `.env` 를 고친 뒤 다시 생성한다.
> Vite 는 이 JSON 을 **빌드 시 import 한다** — 없거나 깨지면 런타임이 아니라 **빌드가 실패한다**.
> 카메라는 HTTPS 에서만 열리므로 **폰 테스트는 배포본으로** 한다 (로컬 IP 로는 안 된다).

검증 페이지용 합성 이미지가 필요하면:
```bash
python3 scripts/assets/make-marker-test-images.py
```

## 검증

```bash
bash scripts/check/all.sh          # 게이트 전부. 하나라도 실패하면 exit 1
```

문서·자산·하네스·기준값 네 게이트가 돈다. **숫자가 문서와 어긋나면 실패한다** —
삼각형 수, 문서 등재 수, `.env` ↔ 생성된 JSON 등.

## 배포

```bash
bash scripts/deploy/fr5-ubuntu.sh      # 우분투 호스트 — 브리지 + 빌드된 화면 (:5055)
scripts/deploy/fr5-bridge.win.cmd      # 윈도우 호스트
bash scripts/deploy/tb-pi.sh           # 터틀봇 파이 — tb-bridge (:5056)
bash scripts/deploy/cam-ubuntu.sh      # 손목 카메라 관문 (:5058)
```

- 화면은 브리지가 같은 주소에서 정적 서빙한다 — 별도 호스팅 없음
- AR 은 카메라 권한 때문에 **https 또는 localhost** 여야 한다 — `scripts/robot/ar-tls-service.sh`

## 무엇이 확인됐고 무엇이 안 됐나

| 확인됨 | 근거 |
|---|---|
| URDF + 그리퍼 웹 렌더 (128,584 삼각형) | `docs/archive/evidence-2026-07/2026-07-29/urdf-web-render.md` |
| 그리퍼 장착값 — 플랜지 간격 0.00mm | `docs/archive/evidence-2026-07/2026-07-30/gripper-mount.md` |
| 마커 검출 — **크기보다 대비가 결정한다** | `docs/archive/evidence-2026-07/2026-07-30/marker-detect.md` |
| 폰에서 로봇이 겹쳐 보임 · 깜빡임 억제 '강' 안정 | 2026-07-30 실기 |
| Vite 이관이 가능하다 — 빌드 통과, JS 전송량 −26% | `docs/archive/evidence-2026-07/2026-07-30/vite-gate.md` |

| 아직 안 됨 |
|---|
| **배치안을 AR 로 겹쳐 보기** — 지금은 로봇 하나만 겹친다 |
| 정합 오차 실측 (±5~15mm 는 **문헌값**) |
| 실물 로봇 옆에 겹쳐 보기 |
| FR5 웹·브리지 런타임 (`FR5/`는 문서성 골격만 있음) |

## 팀원에게 물어야 하는 것 하나

**"한 사이클이 무엇인가"** — 무엇을 하면 1개 처리로 세는가.
이게 처리량의 분모라서, 어긋나면 **배치안 A와 B의 비교 자체가 무의미해진다.**
나머지(전달 방법·지표 필드 목록)는 목업으로 넘어간다 —
필수 필드는 `throughputPerHour`와 `cycleTimeSec.mean` 둘뿐이다
(`docs/ref/contract/API-CONTRACT.md` §생산성 지표).

## 문서

`docs/INDEX.md` 가 지도다. 처음이면 이 순서로 본다.

1. `docs/SESSION-START.md` — **폴더 라우터.** 무엇을 건드리는지 정하면 읽을 문서가 둘로 줄어든다
2. `docs/ref/product/PRD.md` — 목표와 성공 판정
3. `docs/status/PROJECT-STATUS.md` — 지금 어디까지
4. `docs/status/DECISION-LOG.md` — 왜 그렇게 정했나 (D1~D17)
5. `docs/ref/runbook/AR-DEBUG.md` — AR 이 안 될 때

코드를 짜기 전에 보는 것 — `docs/ref/contract/SHARED-CORE.md`(배치안 모델·단위) ·
`docs/ref/arch/BUILD-VITE.md`(폴더 경계) · `docs/ref/arch/CONSOLE-REACT.md`(관제화면)

## 기술

AR.js 3.4.8 (마커 방식 — **iOS 는 WebXR 을 안 열어준다**) · three.js 0.185.1 ·
urdf-loader 0.13.1 · 빌드 단계 없는 정적 사이트 (importmap)
