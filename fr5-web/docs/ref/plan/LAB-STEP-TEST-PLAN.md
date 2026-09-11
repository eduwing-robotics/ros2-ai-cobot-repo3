# LAB-STEP-TEST-PLAN — 거치대를 아무 데나 놨을 때, 실기가 한 칸씩 (2026-09-07 · `/계획` · v3 = v2 + `/수렴` 델타 7)

## 목차

- [Project Snapshot](#project-snapshot)
- [Problem](#problem)
- [Goal](#goal)
- [Non-Goals](#non-goals)
- [Constraints](#constraints)
- [Assumptions](#assumptions)
- [Risks](#risks)
- [Dependencies](#dependencies)
- [Success Metrics](#success-metrics)
- [Naming Contract](#naming-contract)
- [File Map](#file-map)
- [Folder Boundaries](#folder-boundaries)
- [Skill Routing](#skill-routing)
- [Phase Plan](#phase-plan)
- [Open Questions](#open-questions)
- [Later Backlog](#later-backlog)
- [Handoff Notes](#handoff-notes)

분류: **SSOT**(`plan/`). 「실기 단계 테스트」축의 순서와 완료 조건만 담는다. 안전 판정의 정본은
`contract/SAFETY-RULES.md`, 추종 순서의 정본은 `.claude/skills/추종/SKILL.md`, 좌표 사슬의 정본은 `Shared/data/frames.js`,
상호 배제의 정본은 `contract/API-CONTRACT.md` §상호 배제(2026-09-03 · 코드 0줄) 다. 2단 조준 설계의 수렴 기록은 `ref/rnd/AIM2-CONVERGE-LOOP-2026-09-07.md`(D192) 다.
근거는 `docs/evidence/2026-09-07/dashboard-boot-robot-param.md` §2 · `docs/evidence/2026-09-06/sim-contact-layer.md` · `docs/evidence/2026-09-03/depth-shift-and-follow-scope.md`.

## Project Snapshot

- Project: `FR5Web` — 실기 단계 테스트 축
- One-line objective: **거치대를 판 위 아무 자리·아무 각도로 놓아도**, 글로벌캠(대강)→손목 뎁스(정밀·다각도)→풀기→한 칸 실행의 **2단 조준**으로 실기가 거치대를 집어 초록 바구니에 넣고, 그 모든 칸을 **주인님이 버튼 하나씩 눌러** 확인하며, 잰 값이 전부 저장돼 나중에 디버깅할 수 있다
- Primary users: 랩에서 펜던트 옆에 서 있는 주인님
- Stack: FR5 브리지(FastAPI · FAIRINO SDK) · FR5 화면(Vite/React · `SimPanel`) · 글로벌캠 색 검출(`scripts/map/color-find.py`) · 손목 뎁스 D435(`scripts/robot/depth-probe.py` 평면·덩어리) · 브라우저 무조코 접촉 검사 · TB 브리지(`ws://<tb>/ws/state` velocity)
- Repo boundary: `FR5/src/features/sim/` · `FR5/bridge/` · `Shared/data/sim/` · `scripts/map/` · `scripts/robot/` · `docs/`

## Problem

- 9칸은 거치대 **자리(x·y)** 만 받고 **각도·높이** 는 08-31 파지 정본에 고정 (`load-steps.js` `graspXyMm`)
- 자리는 글로벌캠 색 검출 → `robot-base-in-tag.json`(08-19 · yaw 1.73° 낡음) 사슬. **실물 대비 정확도 미측**. 손목 뎁스 사슬과 **45.9mm** 어긋남(09-03 · hand-eye 에 회전 없음 · 5°→39mm)
- 손목 뎁스는 거치대 윗면(구멍 판)을 평면으로 못 잰다(RMS 13mm) — 대신 「판 위로 솟은 덩어리」로는 잡는다(`carrier-find.py` · 대략)
- **바구니에 넣기**는 터틀봇 자리를 라이다 윗면(원)으로만 보므로 **바구니 요각을 못 본다.** 여유가 한쪽 17.5(거치대) · 4.5mm(손가락)라 회전 부족 6.6°(실측)면 모서리가 4.9mm 밀려 **못 들어간다**
- 시뮬 9칸을 **실기로 보내는 창구가 없다** · 실기는 Teach `goto` · 슬롯 `step` · WS `moveJ` 만
- **상호 배제 코드 0줄** — 계약은 「팔은 터틀봇 velocity 가 0 이 아니면 거부」로 서 있다
- 잰 값이 **파일 하나에 안 모인다** — 글로벌캠은 `carrier-pose.json`(덮어씀), 뎁스는 stdout, 실기 readback 은 로그. 나중에 「그때 왜 틀렸나」를 못 되짚는다

## Goal

- **2단 조준 파이프라인**이 시뮬과 실기에서 같은 버튼으로 돈다: ⓐ 글로벌캠 대강 → ⓑ 안전 높이 관측 자세로 → ⓒ 뎁스 스캔(거치대 덩어리·바구니 바닥 사각형) → ⓓ 필요하면 반대 방위 한 번 더 → ⓔ 융합 → ⓕ 9칸 재풀기(자리·요각) → ⓖ 접촉 검사 → ⓗ 한 칸 실행
- 팔·터틀봇 **동시 이동을 브리지가 막는다**(계약 §상호 배제 그대로 · 조건 27)
- 버튼 한 번 = 기록 한 줄: 무엇을 보고(출처·원값), 무엇으로 풀었고(해·접촉), 실기가 어디 갔나(readback·게이트 사유)가 `runs/<세션>.jsonl` 에 남고 화면에서 되감긴다
- 「코드가 못 받는 것은 사람이 무엇을 대신 채우는지」를 화면이 말한다

## Non-Goals

- `/proposal`(사다리 7) — 한 칸 실행은 기존 WS `moveJ`·`gripper`. 승인 흐름의 정본은 사다리 7 그대로
- **반대 방향 상호 배제(팔이 터틀봇을 세우기)** — 계약이 금지(하드 룰 4). 터틀봇 쪽은 `run-path` 슬롯이 **자기 출발을** 팔 `moving` 보고 미루는 것만(TB-CONTRACT 개정 필요 · Phase 6)
- 지오펜스 브리지 구현 — 별도 골. Phase 6 까지는 `AMR_SHUTTLE_MM` 을 줄이고 사람이 STOP
- hand-eye **회전** 캘리브 — 다각도(반대 방위 2회 평균)로 1차 편향이 상쇄되면 안 한다. 상쇄가 안 되면(Phase 1 표) 그때 연다
- 회전 시간·드리프트 누적 모델 — 그림 정확도 문제

## Constraints

- 하드 룰 3: 속도 상한 10% · 전역 30% · 사람 확인 · 조건 26 초록 아니면 모션 차단 · 새 조건 27(상호 배제)도 **fail-closed 는 켰을 때만**(`FR5_TB_HOST` 없으면 안 막음 · 있는데 못 읽으면 막음)
- 하드 룰 1: `carrier-pose.json` 필드 · `/runs` · 조건 27 은 **계약을 먼저** 고친다
- 서보는 사람만 켠다 — 화면 세션 하나로, WS 열었다 닫는 스크립트 금지
- 관측 자세는 **D435 Min-Z 195** 밖(카메라 ≥247mm · 표적 위 standoff 220) · 라이다 윗면 위 `CLEAR_MM` 20 이상
- 단위 변환은 `frames.js` 한 곳 · `Shared/`↔화면 경계 유지

## Assumptions

- 글로벌캠 색 검출이 거치대(분홍)를 구역 안 한 덩어리로 잡는다(09-04 실측) — 이것이 **1단**이고 정확도는 ±50mm 급으로 가정(화각에 넣을 만큼)
- 손목 뎁스는 수직 관측에서 거치대 덩어리(판 위 55 솟음 · @245mm 120×148px · 구멍 17px 는 `fill_holes`)와 바구니 **바닥**(90 파임 · @310mm 151×165px · 카메라가 중심 ±55mm 안이면 다 보임)과 **바구니 속 거치대**(내리기 · 바닥 위 55 솟음)를 가른다 — `depth-probe.py` 재사용 + 파임 분기
- 거치대는 하나 · 판은 작업대1 · 터틀봇은 Phase 6 전까지 정차 자리에 사람이 세워 둔다
- mock 어댑터는 뎁스를 못 낸다 → 집에선 **정답+잡음 모델**(`cycle.observedStop` 과 같은 자리 · `DEPTH_MOCK`)이 스캔 값을 맡고, 랩에선 같은 모양으로 실측이 들어온다

## Risks

- 뎁스 덩어리 중심 ≠ 파지점(벽) — 거치대 방향을 `minAreaRect` 로 내고 `carrierBodyOffset` 으로 벽으로 옮긴다. 방향이 90° 모호(69×85 가 비슷)하면 **총알 구멍 배열**로 가르거나 글로벌캠 요각을 우선한다
- **크럭스**: 손목 뎁스 오차가 툴 프레임 **고정 편향**이 아니면(거리·화소 위치에 따라 변하면) 거울 쌍이 안 지운다 → Phase 1 킬실험 (A−B) 불변성이 가른다 → 깨지면 hand-eye 회전 캘리브 골 신설(태그 표적 · `AX=XB`). 08-13 자료 역산으로 편향 크기는 **3~5°(단일 뷰 13~21mm)** 로 확정 — 지우지 않으면 못 집는다
- 바구니 바닥 사각형이 그림자·거치대(이미 든 것)로 가려지면 요각을 못 낸다 → 넣기 전엔 바구니가 비어 있다(싣기 순서상 참) · 내리기(⑩) 때는 거치대가 판에 있어 비어 있다
- 「그림은 따라오는데 실물은 안 따라온다」 → ④ 뒤 **실물 눈 판정** · 기록에 사진 경로
- 조건 27 이 TB 브리지 끊김에 팔을 통째로 막는다 → 계약대로 「켰을 때만」 · 화면이 사유를 글자로

## Dependencies

- 랩(로봇 `192.168.57.2` · 브리지 `30.240:5055` · 폰 `5058` · 터틀봇 파이 `30.15:5056`) · 주인님 손(서보 ON · 태그0 짚기 · 거치대 5자리 짚기 · 높이 재티칭)
- `amr-pair.py` · `color-find.py` · `depth-probe.py` · `view-pose.js`(관측 자세 식 · 방위 인자) · `contact-check.js`

## Success Metrics

- Phase 1: 킬실험(rz/rz+180 거울 쌍 × 3자리) — (A+B)/2 vs 짚기 **≤3mm** 3/3 · (A−B) 세 자리에서 **불변**(±2mm) · 글로벌캠 5점 ≤50mm(1단) · 바구니 요각 ≤2°. ⚠ 3mm 인 이유: 손가락↔테두리 여유 4.5mm(`load-steps.js` ⑨) — v2 의 5mm 는 여유보다 컸다
- Phase 3: 첫 파지+넣기 — 거치대가 바구니 안 · 테두리 접촉 0 · 기록 한 줄에 원값·해·readback 전부
- Phase 4·5: 자리 3/3 · 요각 3/3 · Phase 6: 전 사이클 1회 · 조건 27 이 터틀봇 이동 중 팔 명령을 **거부한 기록 1건 이상**

## Naming Contract

- 2단 조준 상태: `aim = { coarse: {source:'color', user1Mm, yawDeg|null, px, t}, views: [{rzDeg, tcpMmDeg, blob:{kind:'raised'|'sunken', areaPx, sizeMm, longAxisDeg}, user1Mm, yawDeg, t}], fused: {user1Mm, yawDeg, halfDiffMm, pass:1|2}, target: 'carrier'|'basketFloor'|'carrierInBasket' }` — 관측은 **tilt 0 · 표적 중앙 · rz_g±90 거울 쌍**(hand-eye xy 평행이동·회전 편향이 1차로 상쇄) · `views` 는 2 + 재시도 1(N뷰 일반화 기각) · 통과 = 거울 180±2° 그리고 편향 ≤3 **또는** 두 패스 평균 3mm 일치(`aim.js judge` · 2026-09-07 실렌더 정정)
- 검출기 출력: `carrier-pose.json` 에 **`yawDeg`**(user1 · +x 0 · 반시계 +) · 손목 스캔은 브리지 `POST /scan { target }` → `{ ok, view, reasons }` (뎁스 PNG 를 브리지가 `depth-probe.probe()` 로 풂 · **파임 분기 `resid < −thr` 하나만 추가** — 바구니 바닥은 90 파인 것) · 요각 90° 모호는 odom 사전값(≤6.6°) → 없으면 윗판+테두리 합체 PCA
- 9칸: `makeLoadSteps(stop, { graspXyMm, graspRzDeg, basket: {xMm,yMm,yawDeg} })` — `basket` 이 있으면 ⑥~⑨ 를 그 자리로(없으면 정차 자리+오프셋 유도)
- 실기 창구: 기존 WS `moveJ`·`gripper`. 화면 버튼 `data-t="sim-go-step"` · 확인 문구 `현장확인` · `speedPct ≤ 10` · 목업이면 「목업 — 안 보냄」
- 기록: `<data_dir>/runs/<YYYYMMDD-HHMMSS>.jsonl`(기본 `~/fr5-data`) · `GET /runs` · `GET /runs/{id}` · 한 줄 = `{ t, phase, step, aim, solved:{jointsDeg,contacts}, sent:{cmd,speedPct}, readback:{jointsDeg,tcpMmDeg}, gate:{ok,reasons}, photo? }` · 화면 「기록」 절(터틀봇 탭 되감기와 같은 모양)
- 안전: **조건 27** — `tbVelocity` (`FR5_TB_HOST` 의 `/ws/state` velocity) `|v|>0` 또는 `poseAgeSec>1` 이면 모션 거부 · `SAFETY-RULES` §조건 목록에 등재
- banned: `/sim/execute` · `/sim/run`(비전 전용 실행 경로 금지) · `graspYaw` · `basketPose`(요각 없는 이름) · 브리지 밖 두 번째 뎁스 풀이

## File Map

- create: `docs/ref/plan/LAB-STEP-TEST-PLAN.md`(이 문서)
- create: `Shared/data/sim/aim.js`(+`.test.js`) — 2단 조준 상태·융합(반대 방위 평균 · spread) · 목업 스캔 모델
- create: `FR5/bridge/runs.py` — jsonl 기록 · `GET /runs` · `FR5/src/features/sim/RunLog.jsx` — 되감기
- create(미작성 · Phase 1 계기): scripts/robot 아래 `carrier-locate.py` — 손끝 짚기 vs 글로벌캠 vs 뎁스 3사슬 표(`amr-pair.py --add` 모양) → `docs/evidence/<날짜>/carrier-locate.json`
- modify(계약 먼저): `docs/ref/contract/API-CONTRACT.md`(§상호 배제 → 조건 27 · `/scan` · `/runs`) · `docs/ref/contract/SAFETY-RULES.md`(조건 27) · `docs/ref/contract/VISION-CONTRACT.md`(§color `yawDeg` · §`wrist` 에 「거치대 덩어리·바구니 바닥」 표적 둘)
- modify: `FR5/bridge/main.py`(`/scan` · `/runs` · 조건 27 배선) · `FR5/bridge/safety.py`(조건 27) · `FR5/bridge/follow.py`(TB velocity 구독은 이미 있음 · 노출만)
- modify: `scripts/map/color-find.py`(`minAreaRect`→`yawDeg`) · `scripts/robot/depth-probe.py`(함수 import 가능하게 · 풀이 불변)
- modify: `Shared/data/sim/load-steps.js`(`graspRzDeg`·`basket`) · `view-pose.js`(방위 두 개) · `FR5/src/features/sim/SimPanel.jsx`(조준 절 ⓐ~ⓗ 버튼 · 「이 칸으로 (실기)」) · `FR5/src/data/datasource/http.js`(`scan`·`runs`·`moveJ`)
- modify: `scripts/check/sim-tab.mjs` · `scripts/check/fr5-bridge-verify.mjs`(조건 27 · `/scan` 결측=차단 · `/runs` 한 줄 모양)
- modify: `docs/status/PROJECT-STATUS.md` · `docs/status/DECISION-LOG-CURRENT.md`(D191) · `docs/INDEX.md` · `docs/ref/README.md`
- keep: `Shared/data/workcell.js` · `props.js` · `frames.js` · `.claude/skills/추종/SKILL.md`

## Folder Boundaries

- `Shared/data/sim/`: 조준 상태·융합·9칸 — 좌표를 만들지 않고 실측을 읽는다 · 뎁스 풀이는 여기 없다
- `FR5/bridge/`: 게이트(조건 27) · 뎁스 풀이 호출(`depth-probe.probe` 재사용) · 기록. **뎁스 풀이는 `scripts/robot/depth-probe.py` 한 곳**
- `FR5/src/features/sim/`: 버튼·되감기만 · 실기 명령은 `datasource`
- `scripts/map/`(글로벌캠) · `scripts/robot/`(실기 계기)

## Skill Routing

- **조준(스킬)**: 끝났다 — 09-07 아침 판정 「부분」(`evidence/2026-09-07/dashboard-boot-robot-param.md`)
- **수렴(스킬)**: **Phase 0 코드 전에 한 번** — 크럭스 셋(① 뎁스가 거치대 덩어리를 5mm 로 내나 ② 반대 방위 평균이 회전 편향을 상쇄하나 ③ 바구니 바닥 사각형으로 요각이 2° 로 나오나)을 봉인 루브릭에 대고 킬실험을 뽑는다. 틀리면 Phase 0 절반이 死코드다
- 계획: 이 문서 · Phase 0 구현: `/페이즈루프`(5 phase) · 랩: `/윈도우`→`/우분투`→`/카메라`→`/터틀봇` · 움직임: `/추종` §7칸 · 실렌더: `/검증` · 값 바뀜: `/정합` · 닫기: `/마감`

## Phase Plan

### Phase 0 — 집에서 세팅 (로봇 없음 · 수렴 뒤 페이즈루프 5 phase) — ✅ **닫힘 2026-09-07** (sim-tab 64/64 · bridge 125/125 · web 99/99 · 단위 309·92 · D193)

Goal:
- 2단 조준 파이프라인 ⓐ~ⓗ · 조건 27 · 기록 · 요각·바구니 배선이 **목업**에서 버튼으로 돈다

Files:
- 0-1 계약: `API-CONTRACT`(조건 27 · `/scan` · `/runs`) · `SAFETY-RULES`(조건 27) · `VISION-CONTRACT`(`yawDeg` · 표적 둘)
- 0-2 브리지: `safety.py` 조건 27 · `main.py` `/scan`(`depth-probe.probe` 호출 · 목업은 `DEPTH_MOCK`) · `runs.py`
- 0-3 데이터: `aim.js`(융합·spread) · `load-steps.js`(`graspRzDeg`·`basket`) · `view-pose.js`(방위 둘) · `color-find.py`(`yawDeg`)
- 0-4 화면: `SimPanel` 조준 절 ⓐ~ⓗ 버튼(칸마다 기록 한 줄) · 「이 칸으로 (실기)」 · `RunLog.jsx`
- 0-5 게이트: `sim-tab.mjs` · `fr5-bridge-verify.mjs`

Skills:
- `/수렴`(먼저) → `/페이즈루프` · `/검증`

Verification:
- `node scripts/check/fr5-bridge-verify.mjs` — 조건 27: `FR5_TB_HOST` 없음→안 막음 · 있고 velocity≠0→거부 · 있고 못 읽음→거부 / `/scan` 결측=차단 / `/runs` 한 줄 스키마
- `node scripts/check/sim-tab.mjs` — ⓐ~ⓗ 버튼 순서 강제(앞 칸 없이 뒤 칸 비활성) · 목업이면 「안 보냄」 · 확인 문구 없이 안 보냄 · 반대 방위 2회 뒤 `fused.spreadMm` 표시 · `basket` 이 ⑥~⑨ 를 옮긴다(요각 5° 넣으면 ⑦ 자리가 회전)
- `bash scripts/check/shared-unit.sh` — `aim.test.js`(편향 +b·−b 두 뷰 평균=0 · spread=2b) · `load-steps.test.js`

Doc Sync:
- 계약 셋 · `PROJECT-STATUS` 핸드오프 · `DECISION-LOG` D191(상호 배제·기록을 이 축에 편입 · 2단 조준 채택)

Exit Criteria:
- 목업에서 ⓐ→ⓗ 를 버튼으로 끝까지 누르면 `runs/*.jsonl` 에 8줄 이상 · 되감기에서 그 줄을 눌러 그때 자세로 감 · 「이 칸으로 (실기)」는 `moveJ` 가 **안 나가고** 「목업 — 안 보냄」
- 실렌더 2장: 거치대 45° 놓은 그림에서 9칸 rz 가 돈 것 · 바구니 요각 5° 에서 ⑦ 이 돈 것

Decision Gates:
- 수렴 킬실험이 「뎁스 덩어리 5mm 불가」로 나오면 2단을 **글로벌캠 다각도(폰 두 자리)** 로 바꾼다 — 파이프라인 모양은 같다(`views[].source` 만 다름)

### Phase 1 — 랩 · 팔은 사람 손으로만 (눈 검증 · 45분) — 골 계약: `docs/goals/GOAL-lab-pick-place-1.md`(2026-09-07 · Phase 1~3 을 사다리 4칸으로)

Goal:
- **첫 10분 = 킬실험**: 받침 위 총알(08-13 표적) 위에서 rz 와 rz+180 스캔 × 자리 3곳(사람 조그 · 팔 명령 0) → (A+B)/2 vs 짚기 · (A−B) 불변성 · 그다음 세 사슬(짚기 · 글로벌캠 · 뎁스 거울 쌍) 5자리 · 바구니 바닥 요각 각도기 대조 · 홈 쌍 6 · 태그0

Files:
- `amr-pair.py --add` ×6 → `workcell.js AMR_HOME` · 태그0 짚기 → `frames.js camLab→base measured`
- `carrier-locate.py --add` ×5(짚기·글로벌캠·뎁스 두 뷰) → `evidence/<날짜>/carrier-locate.json` · 바구니 3자세 → `basket-yaw.json`

Skills:
- `/윈도우` · `/우분투`(observe-only) · `/카메라` · `/터틀봇` · 관측 자세는 **사람이 조그**로(팔 명령 0)

Verification:
- 킬실험 (A+B)/2 ≤3mm 3/3 · (A−B) 세 자리 ±2mm 불변 · 글로벌캠 ≤50mm · 뎁스 거울 쌍 5점 ≤3mm · 바구니 요각 ≤2°
- `fr5-lab-a` 시뮬 풀기 → 9/9 · 접촉 0 후보 ≥1 · 조건 26·27 초록 · mock 관절각 칸별 대조(킬실험)
- `bash scripts/check/frames.sh` camLab→base 초록

Doc Sync:
- `evidence/<날짜>/carrier-locate.md` · `workcell.js`·`frames.js` 출처 주석 · D187 열림

Exit Criteria:
- 킬실험 통과 · 뎁스 ≤3mm 전부 · 요각 ≤2° · 9/9 · 접촉 0 후보 ≥1 · 조건 26·27 초록

Decision Gates:
- (A−B) 가 자리마다 다르면 크럭스 반증 → 거울 쌍 무효 → hand-eye 회전 캘리브 골 신설 · 그 전엔 Phase 3 안 감. **Phase 0 은 그대로 유효**(융합기 입력만 바뀐다)
- 글로벌캠 >50mm 면 1단이 화각에 못 넣는다 → 태그0 사슬로 색 검출을 다시 잇고 재측정

### Phase 2 — 랩 · 팔 움직임 · 거치대 없음 (공중 리허설 · 45분)

Goal:
- 버튼으로 ⓑ 관측 자세 이동 → ⓒ 스캔 → ⓓ 반대 방위 → ⓔ 융합 → ⓕ 풀기 → ①·② 까지 한 칸씩 · 매 칸 기록

Files:
- 높이 재티칭 → `props.js CARRIER_GRASP_TRUTH`(판 −334) · `runs/*.jsonl`

Skills:
- `/추종` §7칸 · `/검증`

Verification:
- 칸마다 readback vs 해 <1° · 정착 <60초 · STOP 1회 · 관측 자세에서 카메라 ≥247mm(기록의 tcp 로 검산)
- 기록 한 세션에 ⓑ~② 전부 · 되감기로 「그때 스캔이 본 자리」가 3D 에 점으로 뜬다

Doc Sync:
- `props.js` · `evidence/<날짜>/air-rehearsal.md`

Exit Criteria:
- 빈 판에서 ⓒ 가 「거치대 없음」을 사유로 내고 멈춘다(결측=차단) · 거치대 놓으면 ⓒ~② 도착

Decision Gates:
- 게이트 거부면 참조 관절 바꿔 **해를 다시** 푼다 — 게이트를 안 푼다

### Phase 3 — 첫 파지 + 첫 넣기 (거치대 평행 · 터틀봇 정차 자리에 세워 둠 · 1.5시간)

Goal:
- ③ 문다 → ④ 50mm → **실물 눈 확인** → ④ 정본 → ⑤ → **ⓒ′ 바구니 바닥 스캔** → ⑥~⑨ 재풀기 → 넣기

Files:
- `evidence/<날짜>/first-grasp.md`(사진 · `runs/` 줄 번호)

Skills:
- `/추종` · `/검증`

Verification:
- ④ 뒤 실물이 들렸다(사진) · ⓒ′ 가 바구니 중심·요각을 냈고 ⑥~⑨ 가 그 자리로 풀렸다(기록) · ⑦ 테두리 접촉 0(눈+충돌 미발동)

Doc Sync:
- `PROJECT-STATUS` 「파지는 아직 한 번도 안 했다」 닫음

Exit Criteria:
- 거치대가 바구니 안 · 사람 개입 0(STOP 제외) · 기록에 ⓐ~⑨ 전부

Decision Gates:
- ④ 50mm 에서 안 따라오면 멈추고 기록의 `fused` vs 짚기 정답으로 자리·요각·높이 중 무엇인지 가른 뒤 재시도
- ⓒ′ 가 요각을 못 내면(바닥 가림) 넣기 **안 함** — 정차 요각 오차를 사람이 각도기로 넣고 그 사실을 기록에

### Phase 4 — 자리 자유 (요각 평행 · 3자리)

Goal:
- 가까이·멀리·옆 판 근처에서 Phase 3 반복 · 1단(글로벌캠)이 매번 화각에 넣는다

Files:
- `evidence/<날짜>/grasp-anywhere.md`

Skills:
- `/추종` · `/검증`

Verification:
- 3/3 · 접촉 빨강 칸은 버튼 비활성 · 옆 판 근처 관측 자세가 벽과 접촉 0

Doc Sync:
- `workcell.js` 「되는 구간」 주석

Exit Criteria:
- 3/3 또는 실패 자리 원인 표

Decision Gates:
- 접촉 초록인데 실물이 부딪히면 장면 근사 결함 → 놓인 거치대·관측 자세 스윕을 장면에

### Phase 5 — 요각 자유 (0·45·90°)

Goal:
- 글로벌캠 `yawDeg`(대강) → 뎁스 `minAreaRect`(정밀) → 9칸 rz

Files:
- `evidence/<날짜>/grasp-any-yaw.md`

Skills:
- `/추종` · `/검증`

Verification:
- 뎁스 요각 vs 각도기 ≤3° · 3/3 · 90° 모호성(69×85)이 글로벌캠 요각으로 풀린다

Doc Sync:
- `VISION-CONTRACT` §color·§wrist 각 오차 등재

Exit Criteria:
- 3/3 · ≤3°

Decision Gates:
- j6 한계면 rz 180° 접기(그리퍼 대칭)

### Phase 6 — 터틀봇 포함 전 사이클 + 상호 배제 실기 시험

Goal:
- 거치대 찾기→① 접근→② 사전 성형→③ 하강·닫기→④ 안전 높이까지 들기→**팔 정지 유지**→홈에서 정차 자리로 터틀봇 이동→완전 정차→⑤a 든 채 바구니 스캔→⑤~⑨ 놓기→앞 `AMR_SHUTTLE_MM`(판 끝 여유 300 이상으로 줄임)→되돌아옴→⑩ 라이다·ⓒ′ 바구니 스캔→내리기→홈 · **터틀봇이 움직이는 동안 팔 명령을 일부러 한 번 보내 조건 27 거부를 기록**

Files:
- `evidence/<날짜>/cycle-lab-1.md` · `TB-CONTRACT`(터틀봇 `run-path` 가 팔 `moving` 보고 출발 미룸 · 반대 방향 아님 — 자기 출발을 미루는 것) · 터틀봇 탭 되감기

Skills:
- `/터틀봇` · `/추종` · `/검증`

Verification:
- 조건 27 거부 기록 ≥1 · ⑩ 관측 뎁스가 `observedStop` 자리에 들어감(기록) · ⑧ 놓기 오차 <10mm · 낙하 0

Doc Sync:
- `PROJECT-STATUS` 핸드오프 · `DECISION-LOG`(지오펜스 브리지 구현을 다음 골로)

Exit Criteria:
- 1회 완주 · 사람 개입 0(STOP 제외) · 상호 배제 거부 1건 이상

Decision Gates:
- TB 브리지 `velocity` 가 0 인데 실물이 움직이면(odom 헛돎) 조건 27 의 출처를 **글로벌캠 태그 변화율**로 보강 — 계약 개정

## Open Questions

- D435 깊이 정확도 문구(<2% @2m)를 데이터시트에서 **직접** 대조 — 09-07 세션은 오프라인(샌드박스 DNS)이라 `arch/DEPTH-CAM.md` 의 등재 인용(337029-017 Table 4-11)에 기댔다
- 바구니 바닥 사각형이 그림자·벽 두께 미측(`wallMm null`)으로 몇 mm 작아 보이나 — 중심·요각엔 영향 작을 것으로 가정, 실측으로 확인
- 조건 26 을 실기에서 초록으로 만드는 세션 절차가 `FR5-BRINGUP.md` 에 있나

## Later Backlog

- 지오펜스 브리지 구현 · hand-eye 회전 캘리브(Phase 1 표가 요구할 때만) · `/proposal` 사다리 7 · 놓인 거치대·관측 스윕을 접촉 장면에 · 회전 시간·드리프트 누적 모델 · 글로벌캠 다각도(폰 둘)

## Handoff Notes

- **먼저 `/수렴`** — 크럭스 셋과 킬실험을 뽑은 뒤 Phase 0 을 `/페이즈루프` 5 phase 로. 랩 없이 끝난다
- 랩 첫 45분(Phase 1)이 전부 — 뎁스 5점이 ±5mm 를 넘거나 편향 부호가 안 뒤집히면 그날 파지는 없다
- 버튼 한 번 = 기록 한 줄. 기록 없는 칸은 안 한 칸이다
