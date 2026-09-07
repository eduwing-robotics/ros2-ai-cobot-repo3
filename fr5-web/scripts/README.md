# scripts — 무엇을 어디에 두나

**루트에 스크립트를 두지 않는다.** 모든 스크립트는 카테고리 폴더 안에 들어간다.
이 README만 루트에 남는다.

## 지금 있는 것

```
scripts/
├── README.md
├── check/                      검증 게이트 — 실패하면 exit 1
│   ├── all.sh                    아래 전부를 순서대로 실행 (진입점)
│   ├── harness.sh                커맨드 0 · 스킬 21 · 훅 2 · settings 연결
│   ├── docs.sh                   필수 문서 · INDEX 등재 · 깨진 링크 · Unity 배너
│   ├── docs-weight.sh            문서 무게 — 쌓이는 것만 재서 임계 초과 시 알린다
│   ├── status-shape.sh           상태판은 **하루치만** — 날짜가 섞이면 접을 날을 지목한다
│   ├── assets.sh                 URDF·메시 존재와 삼각형 수
│   ├── diagrams.sh               구조도 SVG — 생성기와 바이트 · 값과 코드 · 대조일 신선도
│   ├── consts.sh                 기준값 표 ↔ 실제 상수 대조 (드리프트)
│   ├── skills.sh                 슬래시 명령 스모크 — 부르기 전에 "부를 수 있는 상태인가"
│   ├── refs.sh                   **참조** — README 목록·주석 속 경로·문서 절이 실재하나
│   ├── measurements.sh           **현실값 전람** — 잰 것 전부를 한 화면에 + 출처 없는 값 차단
│   ├── measurements.mjs            그 본체. 여섯 군데(workcell·props·global-cam·tag-layout·config.yaml)를 모은다
│   ├── shared-unit.sh            Shared 순수 함수 단위 (node:test · 새 의존성 0)
│   ├── cam-unit.sh               카메라 관문 깊이 판정 단위 + **세운 총알 판정**(D159) (카메라 없이 돈다)
│   ├── db-unit.sh                기록 노드 — 스키마 로드 + 보존 게이트 단위 (장비 없이)
│   ├── fr5-unit.sh               FR5 브리지 단위 246건 (safety.py 게이트 + **정지 전송** · unittest)
│   │                             ⚠ `test_stop_transport.py` 는 `fastapi` 가 있어야 돈다 — 없으면 **건너뛴다**
│   ├── tb-unit.sh                터틀봇 브리지 단위 (geofence.py — 상판 낙하 방지 · 로봇 없이 돈다)
│   ├── datasource.sh             데이터 경계 — **화면이 데이터 출처를 모르는가**
│   ├── frames.sh                 좌표계 SSOT — 문서(FRAMES.md) ↔ 모듈(frames.js) + fail-closed 불변식
│   ├── frames.mjs                  그 본체. 라벨 사고 여섯 번을 재발 방지로 굳혔다
│   ├── frames-chain.sh           좌표 사슬 — **브리지(파이썬)** 가 그 SSOT 를 실제로 보고 있나
│   ├── frames-chain.py             그 본체. 아는 점을 넣고 아는 답이 나오나 본다 (문법 검사로는 못 잡는다)
│   ├── agree.sh                  정합 — **같은 물건을 여럿이 볼 때 같은 자리라고 말하나.** 위 둘이 «표»를
│   │                             검사하고 여기가 «실물»을 맡는다. 표적은 터틀봇 태그 18(글로벌캠·odom 둘 다 본다).
│   │                             ⛔ `unknown` 갈래를 지나면 초록을 안 준다 — 절대값 대신 «기준선 대비 변화»로 본다.
│   │                             실기가 붙어야 도므로 `all.sh` 에 안 넣는다 (로봇 없는 세션을 붉히지 않는다)
│   ├── agree.py                    그 본체. 문턱 근거는 hand-eye 흩어짐 5.74mm · 바구니 여유 17.5mm
│   ├── agree-baseline.json         기준선 — 실물이 안 움직였는데 이 값이 변하면 사슬이 변한 것이다
│   ├── layout.sh                 배치안 — 출하 예제가 스키마를 지키고 부품 이름이 실재하나
│   ├── timeline.sh               시간축 — **`stateAt` 이 결정적이고 안 던지는가**
│   ├── scenario.sh               시나리오 — 왕복 · 사건 칸(좌표·관절 금지) · 프리셋 재생
│   ├── motion.sh                 자세 — 이름 정합 · NaN · j1 각속도 상한 · 화면에 안 박혔나
│   ├── scene-axes.sh             씬 축 규약 — `Shared/view3d` 가 `planToScene` 과 어긋나지 않나 (D43)
│   ├── xr-place.sh               겹치기 놓기 계산 — 두 모서리·히트 분류·벽 법선·훑기·준비도 (1초)
│   ├── fr5-render.sh             FR5 실렌더 183건 — 아래 `.mjs` 둘을 자동 게이트로 잠근다
│   ├── fr5-bridge-verify.mjs       브리지 왕복 93건 — 안전·조종권·작업영역·모드 (브라우저 없음)
│   ├── fr5-web-verify.mjs          Live·Teach·Program 실렌더 90건 (브리지 + vite + Chrome)
│   ├── sim-tab.sh                **시뮬 탭 실렌더** — `fr5-web-verify` 가 `nav button` 을 4개로 단정해
│   │                             이 탭을 **한 번도 안 열어봤다**(2026-09-04 발견 · 탭은 다섯이다).
│   │                             「열린다」와 **「읽을 게 적다」** 둘을 잰다 — 뒤엣것이 없으면 또 문구가 쌓인다
│   ├── sim-tab.mjs                 그 본체. 브리지(5158)+vite(5176)를 스스로 띄운다
│   ├── ar-render.sh              AR 실렌더 82건 — 아래 `.mjs` 둘을 자동 게이트로 잠근다 (5188·5189)
│   ├── cam-web-verify.mjs          글로벌 카메라 겹치기 — 사진 재검출 ↔ 투영 픽셀 대조
│   ├── xr-web-verify.mjs           WebXR 화면 — ①놓기 계산 ②`화면` 모드 실렌더. `--pure` 면 ①만
│   ├── sim-batch.sh              배치가 완주하고 **주입하면 잡나** — 재현성까지 (몇 초)
│   ├── sim-batch.mjs               그 본체. 8벌 완주 · seed 대조 · 구역 주입 · 손끝↔실기
│   ├── sim-contact.sh            시뮬 탭 **접촉 층** — 구운 장면 + 목업 IK 로 9칸 사이 길을 5° 표본해 브라우저 무조코와 같은 판정
│   ├── sim-contact.mjs             그 본체. 09-06 낮의 충돌(들고 가다 라이다를 쓸음)을 되살리면 빨강, 고친 길은 초록 (2026-09-06)
│   ├── sim-scene.sh              시뮬 장면이 **생성물인가** — 입력을 흔들면 MJCF 가 따라오나
│   ├── sim-scene.mjs               그 본체. 손파서↔pyyaml 대조 + 137mm 흔들기 + 구역 누락 주입
│   ├── sim-parity.sh             시뮬↔실기 **판정 대조** — 아래 둘을 자동 게이트로 잠근다 (1초)
│   ├── sim-parity.mjs              사본(`Sim/runner/judge.mjs`) 판정 + 대조 + 결함 주입
│   ├── sim-parity-poses.py         정본(`safety.check_workspace`)이 자세 200개를 굽는다
│   ├── sim-grasp.sh              파지 기하가 **네 자세를 가르나** — 맞음·높음·낮음·빗나감 (1초)
│   ├── sim-grasp.mjs               그 본체. `Sim/runner/grasp.mjs` + 결측 6종 + 띠·행정 주입
│   ├── grasp-rank.sh             킬-실험 계기 — 자세 셋을 흔들어 **순위가 갈리나** (1초)
│   ├── grasp-rank.mjs              그 본체. 흔들기 12.3mm×400 · 2σ 동률층 · 뒤집힌 기록 주입
│   ├── arm-fk.sh                 손으로 짠 파이썬 FK 가 **무조코와 같은가** (자세 2000개 · 몇 초)
│   ├── arm-fk.mjs                  그 본체. 링크 6개 위치·회전 대조 + 관절 1° 주입
│   ├── dash-render.sh            대시보드 실렌더 143건 — 아래 `.mjs` 를 자동 게이트로 잠근다 (5187)
│   ├── dash-web-verify.mjs         배치안·시나리오·datasource 경계·**시뮬 탭 3층** 실렌더 143건
│   ├── cam-bridge-verify.mjs     손목 D435 관문 + FR5 뎁스 PiP 실기 19건 — **손으로 부른다**
│   ├── fr5-cam-verify.mjs        실영상 PiP — 폰에서 프레임을 받는지까지 — **손으로 부른다**
│   ├── tb-api-harness.mjs        TB 브리지를 브라우저 없이 묻는 하네스 (아래 둘이 쓴다 · D182)
│   ├── tb-bridge-verify.mjs      TB 왕복 — API ↔ tb-bridge(:5056) ↔ mock + CORS 울타리 — **손으로 부른다**
│   ├── tb-cycle-verify.mjs       TB 전 사이클(매핑→저장→활성→주행→녹화→기록) — API 로 — **손으로 부른다**
│   ├── tb-web-verify.mjs         FR5 「터틀봇」 탭 실렌더(`?tb=mock`) — **손으로 부른다** (dev :5173 필요 · D182)
│   └── tb-real-verify.mjs        우분투 real 브리지가 떠 있을 때 — **실물 TB 가 있어야 돈다**

⚠ **터틀봇 파이의 상주 배선은 `TurtleBot/deploy/` 에 있다** (스크립트가 아니라 **정본 사본**) —
`start-bridge.sh`(env 정본: real·도메인 210·fastrtps) · `tb-bridge.service` · `tb-bringup.service`.
파이에만 두면 SD 카드가 죽을 때 같이 사라진다 (2026-08-18 에 `/etc/shadow` 가 없어진 그 카드다).
⛔ 아직 **저장소에 없는 것 둘** — `~/robot_runtime/bringup/_robot_bringup_ns.sh` 와
`~/dual_bringup.launch.py` 는 **repo2(팀원 소유)** 라 복사하지 않았다. 카드가 죽으면 그쪽에서 받는다.

├── build/                      설정·산출물 생성. **입력이 틀리면 쓰지 않고 멈춘다**
│   ├── config.mjs                .env → Shared/data/config/*.json (검증 포함)
│   ├── tool-hull.mjs             그리퍼 STL + gripper-mount.json → tool-hull.json (TCP 기준 충돌체)
│   ├── arm-hull.mjs              URDF → arm-hull.json (관절 체인 + 링크별 충돌상자)
│   ├── album.mjs                 evidence 사진 전부 → docs/evidence/ALBUM.md
│   ├── sim-replay.mjs            시뮬 배치 한 인스턴스 → Shared/assets/sim/replay.json (폰 XR 재생 표본 · phase 4)
│   ├── deck.py                   발표 md → 편집 가능한 .pptx (pandoc + 우리 디자인 토큰)
│   ├── arch-svg.py               하드웨어·소프트웨어·DB 아키텍처 SVG — 라벨을 계약·스키마에서 읽는다
│   ├── sim-svg.py                시뮬 탭 4장(데이터 흐름·좌표계·사이클·파일 지도) — `arch-svg` 의 Svg 를 빌려 굽는다 (2026-09-06)
│   ├── arch_svg_lib.py             `arch-svg.py` 를 import 이름으로 여는 별칭 (하이픈 파일은 import 불가)
│   ├── topic-svg.py              주제 전용 요구사항·운영 시나리오 SVG (PRD F1~F10 기준)
│   ├── ur-svg.py                 사용자 요구사항 25개를 7묶음으로 접은 SVG
│   ├── burger-glb.py             ROBOTIS Burger STL 4장 → 우리 규약에 맞춘 GLB 한 장
│   ├── gripper-trim.mjs          그리퍼 몸통 메시를 실물 길이로 — 툴축에서 22mm 도려낸다
│   └── round-split.mjs           더미탄 메시를 탄피·탄두 둘로 — 조립 진행을 그리려면 파트가 갈려야 한다
├── dev/                        개발 중 사람이 손으로 부른다
│   ├── win-open.sh               윈도우 화면에 대시보드 둘(팔 5055 · 터틀봇 5056)을 띄운다.
│   │                             주소는 `host.sh` 가 이름으로 푼다(D164). ⚠ 떴는지는 **사람 눈**이
│   │                             판정한다 — SSH 로는 창 제목이 안 읽힌다
│   ├── serve.sh                  Vite dev 서버 (`ar` | `dash`) — **포트 인자가 아니라 대상 이름이다**
│   ├── fr5-dev.sh                fr5-bridge(mock+실기) + 웹 dev 서버를 같이 띄운다
│   ├── tb-dev.sh                 tb-bridge(mock) + 웹 dev 서버를 같이 띄운다
│   ├── fr5-trial.sh              **배포 없이** 지금 코드를 실기에서 한 번 (~/fr5-trial · Ctrl-C 면 복구)
│   ├── sim-fixture.mjs           실기에서 **시뮬 입력을 굽는다** — 승인 슬롯·좌표계·손끝 표본 (로봇 필요)
│   ├── twin-local.sh             쌍둥이를 로컬로 띄운다 (브리지 사본 + vite). **호스트 무관** —
│   │                               원본 트리를 안 고치고 사본에만 목업을 먹인다
│   ├── follow-map.py             받침을 격자로 옮겨 **추종 목표가 게이트를 통과하나** 지도로.
│                                   `--host` 면 `POST /ik` 로 팔뚝까지 (로봇은 **안 움직인다**)
│   ├── observe-map.py            관찰 자세 후보를 격자로 훑어 **터틀봇이 시야에 드나** 세어 고른다
│   ├── follow-run.py             주행 기록 한 건을 되짚어 **팔이 매 표본을 볼 수 있었나** (로봇 없이)
│   ├── shot.sh                   화면·폰사진·영상 → 오늘 날짜 폴더 + 캡션 (발표 기록물 투입구)
│   ├── report-diag.py            `.diag/` 의 폰 진단 로그를 사람이 읽는 표로
│   ├── tb-run-report.py          터틀봇 주행 기록 한 건 → 구간별 도착 오차·회전 오버슛 표 (2026-08-19)
│   ├── drag-record.py            직접교시 킬실험 기록기 — **읽기 전용**(`GET /state` 만 · 조종권 안 잡는다).
│                                   판정 ②(관절값이 따라오나)를 서버 프레임 간격으로 낸다. 원값 `.diag/drag-*.jsonl`
│   ├── deploy-ar.sh              AR 배포 — **빌드 산출물만** 올린다 (D24)
│   ├── deploy-dashboard.sh       관제화면 배포 — **빌드 산출물만** 올린다 (D24)
│   └── rotate-decisions.mjs      DECISION-LOG-CURRENT 초과분을 본문으로 이관 (`--write` · D18)
│   ├── session-worktree.sh       세션마다 자기 작업 트리 — 여럿이 돌 때 조용한 덮어쓰기를 없앤다
│   ├── trace-decisions.mjs       **뒤집힌 결정**을 아직 옛 번호로 인용하는 곳 (사실이 낡음 · 후보만 낸다)
│   ├── cine-probe.mjs            킬실험 — **헤드리스 오프라인 렌더가 성립하나** (계약 `docs/goals/GOAL-cine-probe.md`)
│   ├── cine-render.mjs           데모 영상을 굽는다 — 패스 목록(`Shared/view3d/lab/shots.js`) → mp4. `--contact` 로 구도만 먼저
│   ├── cine-stage.mjs            위 둘이 같이 쓰는 무대 세우기 — vite · 헤드리스 크롬 · UI 숨김
│   ├── host.sh                   **브리지 호스트 주소를 한 곳에서** — 이름으로 푼다 (DHCP 라 숫자가 바뀐다).
│   │                             ⛔ 낡은 숫자를 폴백으로 안 둔다 — 조용히 틀린 기계에 붙는 게 더 나쁘다 (D164)
│   ├── host.py                     위 `host.sh` 의 **파이썬 얼굴** — 파이썬 도구들이 각자 숫자를 들고
│   │                             있던 것을 없앤다(전부 `.18` 로 낡아 있었다). 못 찾으면 **사유와 함께 멈춘다** (D164)
│   ├── health.sh                 **지금 뭐가 붙어 있나** — 일곱 고리(호스트·5055·5058·로봇·글로벌캠·뎁스·터틀봇)를
│   │                             한 번에 재고 **빨간 줄에 처방을 같이** 적는다. 읽기만 한다(브리지 재시작은 조종권을 끊는다)
│   ├── view-mujoco.mjs           **어디서 보면 되나** — 손목 관측 자세를 시선각·방위·거리로 훑어
│   │                             **갈 수 있고 안 부딪히는** 자리만 남긴다. ⛔ 「보이나」는 시뮬이
│   │                             모른다 — 그건 `carrier-find.py` 가 잰다. 산출은 후보이지 정답이 아니다
│   ├── amr-stop-mujoco.mjs       **터틀봇 정차 자리** — 직선 위를 훑어 순서 6칸을 `/ik` 로 풀고
│   │                             **무조코로 실제 충돌**(팔·든 거치대 × 터틀봇·바구니·고정상자)까지 본다.
│   │                             정차 시간도 관절 이동량에서 낸다 (D163)
│   ├── amr-stop-map.py           ⛔ **대체됨** — 대각선 자리를 추천했다(터틀봇이 못 간다).
│   │                             실기 안전 함수를 그대로 부르는 **독립 대조군**으로만 남긴다
├── assets/                     자산 복사·변환
│   ├── sync-from-unity.sh        유니티에서 URDF·메시 가져오기
│   ├── make-marker-sheet.py      AR 마커 인쇄 시트 생성 (자가검사 포함)
│   └── make-marker-test-images.py  마커 검출 실측용 합성 이미지 117장 → `AR/test/marker-images/`
├── robot/                      장치 관문 설치·기동·서비스 등록 (**우분투 PC 에서 돈다**)
│   ├── cam-setup.sh              1회 설치 — cam-bridge 의존성 (D435 가 USB3 로 꽂혀 있어야)
│   ├── cam-run.sh                기동. 포트는 `Vision/bridge/config.yaml`(5058)
│   ├── cam-service.sh            1회 등록 — systemd `--user` 서비스로 올린다
│   ├── calib-watch-run.sh        정합 상시 감시 기동 — 폰 주소를 고정 파일 → `/24` 훑기 순으로 푼다
│   ├── calib-watch-service.sh    1회 등록 — `setsid nohup` 은 재부팅에 안 살아남았다 (2026-08-10)
│   ├── ar-tunnel-run.sh          cloudflared 기동 — 브리지(:5055)를 HTTPS 로 뚫는다 (인터넷 어디서나)
│   ├── ar-tunnel-service.sh      1회 등록 — 터널을 systemd `--user` 서비스로 상시화
│   ├── ar-tls-service.sh         1회 등록 — LAN 전용 고정 HTTPS(:5443, 자체서명) socat 서비스
│   ├── depth-probe.py            깊이 한 장에서 「책상 위로 솟은 것」 — 평면 피팅(역깊이 1차식)이라 내부 파라미터가 필요 없다
│   ├── carrier-find.py           **총알 거치대가 지금 어디 있나** — 손목 뎁스로 찾는다.
│   │                             평면·덩어리는 `depth-probe.py`, 좌표 변환은 `follow.cam_to_robot`
│   │                             을 그대로 쓴다(새 산수 0). ⛔ 파일에 안 쓰고, 이 값으로 집지 않는다
    ├── test_depth_probe.py      **세운 총알 판정** 단위 — 아는 크기의 막대를 그려 되찾고,
    │                             총알이 아닌 것은 여전히 거부하는지 본다 (카메라·로봇 안 씀 · D159)
│   ├── table-probe.py            상판을 핑거로 짚어 평면을 낸다 — `topZMm`·기울기의 정본 (수동모드 · 사람이 돌린다)
│   ├── aim-carrier.py            **1단 조준** — 터틀봇 odom → 바구니 → 거치대 윗면 → 조준 TCP.
│   │                             ⭐ **카메라를 안 쓴다**(폰이 꺼져도 돈다) · **정차 자리를 안 박는다**
│   │                             (`AMR_DROP` 대신 지금 odom). ⛔ 로봇을 안 움직인다 — 계산·보고만
│   ├── amr-pair.py               **눈금 쌍 모으기** — 손목 뎁스로 라이다 윗면을 재서 `(odom, user1)`
│   │                             쌍을 쌓고 6개면 `amr.solve` 로 푼다. `--aim` 은 재기 전에 팔을 보낸다
│   │                             (ARM 은 사람이 · 확인만 한다). 산출 `amr-pairs.json`
│   ├── amr-pairs.json            그 산출. ⛔ **user1 이지 lab 이 아니다** — `amr-frame.json` 과 다른 물건
│   ├── follow-live.py            **연속 추종** — `POST /follow/step` 반복. ⛔ **WS 를 안 연다**(세션 종료
│   │                             10초 뒤 조종권 자동해제 → disarm → 서보 OFF, 이 펌웨어는 켜기만 거부).
│   │                             절차 정본은 `.claude/skills/추종/SKILL.md` 7칸
│   └── handeye-probe.py          hand-eye 킬실험 — 회전을 이미 아니까(틸트0·롤0) 식이 선형이다. **정식 AX=XB 를 돌릴지부터 가른다**
├── deploy/                     맥에서 빌드 → 호스트로 밀어넣기. **호스트가 둘이라 대상도 둘이다**
│   ├── fr5-ubuntu.sh             FR5 브리지. 지점·궤적은 `~/fr5-data` — **배포 트리 밖**이다 (D45)
│   ├── fr5-windows.sh            윈도우 호스트. 기본은 **화면만**(재시작 0 = ARMED 안 떨어뜨림) · `--bridge` 면 브리지까지(재시작 1). **호스트에서 임포트 검사까지 하고 실패하면 죽는다**
│   ├── fr5-bridge.win.cmd        **윈도우 상주 실행기 정본.** 호스트의 `%USERPROFILE%\fr5-bridge.cmd` 가 사본이다
│   ├── fr5-drift.win.cmd         같음 — 글로벌캠 정합 감시(`fr5-drift`). 폰 주소는 `FR5_CAM_HOST` 하나가 정본
│   ├── tb-pi.sh                  터틀봇 브리지+웹 → **로봇 파이**(`kim@192.168.30.15`). 옛 tb-ubuntu.sh 대체(2026-08-19)
│   └── cam-ubuntu.sh             카메라 관문
└── map/                        실제 맵 + 글로벌 카메라 (한 워크플로 = 한 폴더)
    ├── make-tags.py              AprilTag 36h11 + ChArUco 인쇄 시트 · tags.json (제원 SSOT)
│                             출력 = `Shared/assets/tag/` + 역할별 하위폴더(`scenario-assembly/`)
│                             폴더·파일명은 손으로 옮기지 않는다 — 위치도 `FIXTURE_TAGS` 가 정본
    ├── cam-lock.sh               폰 카메라 해상도·초점·줌 잠금 + 되읽어 확인 (찍기 전 매번)
    ├── aim.py                    카메라 위치 잡기 — 실시간 px/칸 판정 (찍기 전에 쓴다)
    ├── capture.py                웹캠 촬영 (오토포커스·해상도 잠금)
    ├── intrinsics.py             ChArUco 사진 → 카메라 화각·왜곡
    ├── extrinsics.py             태그 사진 + 실측 좌표 → labToCam (**원점은 상판 태그 id0**)
    ├── watch-calib.py            겹침 감시 (상주 · 1Hz) — 재는 쪽. `--auto` 면 **스스로 다시 푼다**
    ├── edge-fit.py               **모서리로 다듬기** — 상판 모서리를 영상에서 찾아 `robot-base-in-tag.json`
    │                             의 yaw·x·y 를 맞춘다. 기본은 **재기만**, 쓰는 건 `--apply` 로만.
    │                             ⛔ `topZMm` 은 **안 고친다** — 「짚은 값 + 여유 10」인 안전선이다
    ├── test_watch_calib.py       위 `--auto` 가드 11건 (카메라·사진 없이 돈다 · `check/cam-unit.sh`)
    ├── fixture-pose.py           받침 태그 → 자리(user1). **자주 옮겨지는 장애물** 전용 (D130)
    ├── marker_follow.py          마커 추종 **공용 뼈대** (D135) — 사슬·IPPE 풀이·원자적 쓰기·상주·원격 미러.
│                             ⛔ 안전 추종(받침)의 정본은 FR5/bridge/fixture.py — 이건 이야기 레이어까지
    ├── anchor-pose.py            장면 앵커(컨베이어 32·33) 얇은 CLI — 위 모듈에 인자만 넘긴다 (--watch·--push)
    ├── wrist-find.py            **손목캠 창구** — 손목 뎁스로 터틀봇 라이다 윗면을 재서
        `wrist-pose.json` 에 쓴다. ⭐ **태그도 폰도 안 쓴다**(계약 §`wrist`).
        측정은 `amr-pair.measure` 를 빌리고 **바퀴와 대조**해 거짓 표적을 자른다.
        상주는 브리지 안 — `anchors.start_wrist_tracker`
    ├── color-find.py             **색으로 물건을 직접** 찾는다 — 태그를 못 붙이는 물건용 (D173).
    │                             브리지가 안에서 상주시킨다(`carrier-pose.json`) · CLI 로도 돈다
    ├── touch-fit.py              로봇이 **짚은 점**으로 `robot-base-in-tag.json` 을 푼다 —
    │                             `edge-fit.py` 와 같은 세 값이지만 **카메라가 한쪽에만 낀다**
    ├── amr-pose.py               터틀봇(태그 18) 자리 얇은 CLI — 같은 뼈대, **출력만 다르다**.
│                             달리는 로봇이라 안 보이면 옛 값을 안 남긴다 (읽는 쪽이 나이로 막는다)
    ├── check-calib.sh            게이트 — 캘리브레이션 값이 있고 상한 안인가
    ├── check-camera.sh           게이트 — OpenCV 카메라 → three.js 변환. ⚠ **왜곡 0 가정**
    ├── check-overlay.sh          게이트 — 사진 한 장으로 전체 사슬. ⚠ **왜곡 0 합성**
    ├── make-fixture.py           위 둘이 쓰는 합성 고정물 생성. ⚠ **왜곡 0 · 1080p/70°**
    ├── splat-build.sh            폰 영상 → 가우시안 스플랫 .ply (ffmpeg → COLMAP → Brush)
    └── splat-view/               그 .ply 를 three.js 로 보는 정적 뷰어
        ├── index.html              Spark + OrbitControls. npm 안 씀 (importmap)
        └── serve.sh                라이브러리 최초 1회 내려받고 http.server 로 띄운다 (:5057)
```

## 카테고리

| 폴더 | 담당 | 이름 규칙 | 상태 |
|---|---|---|---|
| `check/` | 검증·게이트. 실패 시 **exit 1** | 검사 대상 이름 그대로 | 사용 중 |
| `dev/` | 개발 중 실행. 되돌릴 수 있는 것만 | 동사 | 사용 중 |
| `assets/` | 자산 복사·변환 | 동사 | 사용 중 |
| `build/` | 설정·산출물 생성. **입력이 틀리면 쓰지 않고 멈춘다** | 산출물 이름 | 사용 중 |
| `robot/` | 장치 관문 설치·기동·서비스 등록 **+ 실기에 붙어 재는 계기** | `<장치>-<동사>` | 사용 중 — `tb-{setup,run,service}.sh` · `cam-{setup,run,service}.sh` (표가 "아직 없음" 인 채로 낡아 있었다 · 2026-08-07 정정) · **계기 둘은 관문 호스트가 아니라 사람 기계에서 돌며 HTTP 로 붙는다** — `depth-probe.py`(깊이 한 장 → 솟은 것) · `table-probe.py`(상판 짚기 → 평면 → `topZMm`·기울기) |
| `map/` | 실제 맵·글로벌 카메라 캘리브레이션 | 파이프라인 단계 이름 | 사용 중 |
| `deploy/` | 배포·터널 | `<대상>-<호스트>` | 사용 중 — `fr5-ubuntu.sh` (맥 빌드 → rsync → 서비스 재시작 → 로봇 재연결) · **`fr5-windows.sh`** (화면만 = 재시작 없음 · `--bridge` = 브리지+`Shared/data/config` + 백업 + **호스트 임포트 검사**) · `tb-pi.sh`(대상이 PC 가 아니라 **로봇 파이**다) · `cam-ubuntu.sh` · **`*.win.cmd`**(호스트 상주 실행기 — 스크립트가 아니라 **저장소가 든 정본 사본**이다. 호스트에만 두면 PC 를 갈아엎을 때 사라진다 · 2026-08-19). ⚠ 이름의 `<호스트>` 가 규약인 이유가 여기서 드러났다 — 2026-08-11 에 로봇 랜선이 윈도우로 옮겨가 **같은 대상에 호스트가 둘**이 됐다 |

## 글로벌 카메라 캘리브레이션 — 세 스크립트가 한 줄로 이어진다

```
map/make-tags.py                                 →  인쇄물 (1회)
map/cam-lock.sh                                  →  해상도·초점·줌 잠금 (찍기 전 매번)
map/aim.py                                       →  카메라 자리 (찍기 전 · 화면 보고)
map/capture.py charuco  →  map/intrinsics.py     →  렌즈  (카메라당 1회)
map/capture.py tags     →  map/extrinsics.py     →  위치  (카메라를 건드릴 때마다)
                           map/check-calib.sh    →  게이트
                           map/watch-calib.py    →  겹침 감시 (상주 · 1Hz)
                           map/anchor-pose.py    →  장면 앵커(컨베이어 32·33) lab 위치 (태그를 옮길 때마다)
                           map/color-find.py     →  **색으로 물건을 직접** 찾는다 (태그가 없어도 · 브리지 상주)
                           map/touch-fit.py      →  로봇이 **짚은 점**으로 `robot-base-in-tag.json` 을 푼다
```

**`watch-calib.py` 만 방향이 반대다.** 위 셋은 **푸는** 쪽(카메라가 어디 있나), 이건 **재는**
쪽이다 — 이미 푼 자세로 지금 프레임을 다시 그려 보고 얼마나 어긋나는지만 낸다.
`Shared/data/config/global-cam-drift.json` 에 1초마다 쓰고 화면이 읽는다 (계약 §정적 서빙).
**커밋 안 한다**(`.gitignore`) — 측정 결론이 아니라 그 기계의 지금 상태다.

`cam-lock.sh` 가 맨 앞인 이유 — 해상도·초점·줌이 바뀌면 **뒤의 결과가 전부 무효**인데,
앱을 재시작하거나 케이블을 다시 꽂으면 그 값들이 조용히 되돌아간다. 실측으로
`quality` 가 49(태그 검출을 깎는 압축)로, `focusmode` 가 자동으로 돌아가는 것을 봤다.

**순서를 바꿀 수 없다.** 내부 파라미터가 나쁘면 외부가 조용히 틀어진다 — 합성 검증에서
내부 fy 를 1.3% 틀리게 넣었더니 카메라 높이가 2.4m → 4.4m 로 나왔다. 그래서 두 build
스크립트 모두 재투영 오차 상한을 넘으면 **쓰지 않고 멈춘다.** 값이 없는 편이 낫다.

인쇄물은 `Shared/assets/tag/`, 보드 제원은 같은 폴더의 `tags.json` 이 단일 출처다.
사진과 실측 서식은 `calib-shots/` (gitignore) — 결론만 `Shared/data/config/global-cam.json` 으로 간다.

**카테고리 폴더는 `check-*.sh` 로 자기 게이트를 내놓는다.** `check/all.sh` 가
`scripts/*/check-*.sh` 도 같이 돌린다 — 도메인 게이트를 `check/` 로 떼어 놓으면
워크플로가 두 폴더로 갈라지고, 손으로 불러야 하는 게이트는 결국 안 돈다.

**폴더는 첫 파일이 생길 때 만든다.** 빈 폴더를 미리 파두지 않는다.
어디에도 안 맞으면 카테고리를 새로 만들고 이 표에 한 줄 추가한다 — 루트에 두지 않는다.

## 개발 기록물 — 찍는 순간에 캡션을 받는다

```
dev/shot.sh <슬러그> "<캡션>"   →  docs/evidence/<오늘>/ 에 파일 + 같은 폴더 SHOTS.md 에 캡션
build/album.mjs                 →  docs/evidence/ALBUM.md (전 날짜 · 캡션 · 크기 한 장에)
build/sim-replay.mjs            →  Shared/assets/sim/replay.json (시뮬 배치 한 인스턴스 · 폰 XR 재생 표본 · phase 4)
```

`shot.sh` 는 소스 셋을 받는다 — 인자 없으면 **화면 영역 캡처**, `--from <파일>` 은 폰 사진
(HEIC 는 jpg 로 굽는다), `--mov <파일>` 은 영상 → gif(2MB 상한) + 대표 프레임 png.

**캡션을 나중에 받으면 못 받는다.** 실측(2026-08-06)으로 사진 42장 중 마크다운 이미지 문법에
캡션이 붙은 건 9장뿐이었고 나머지는 산문에 흩어져 있었다 — `album.mjs` 가 문장에서 28장을 건져
88%까지 올리지만, 건진 문장은 캡션으로 어색하다. 그래서 `SHOTS.md` 가 캡션의 단일 출처다.
**앨범은 생성물이다.** 캡션을 고치려면 그 날 폴더의 `SHOTS.md` 를 고치고 다시 굽는다.

영상 원본(`.mov`/`.mp4`/`.webm`)은 `.gitignore` 에 있다 — 커밋되는 건 gif 와 png 뿐이다.

## 규칙 4개

1. **`check/`는 실패 시 반드시 exit 1.** 출력만 하고 0을 내면 게이트가 아니라 소음이다.
2. **경로는 스크립트 위치 기준으로 계산한다.** 어디서 실행해도 같아야 한다.
   ```bash
   ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
   ```
3. **첫 줄 주석 한 줄로 목적을 적는다.** 이 README에는 트리에만 올린다.
4. **기준값은 스크립트 안에 상수로 두고 주석에 출처를 적는다.** 바뀌면 같이 고친다.

## 실행

```bash
bash scripts/check/all.sh              # 전부 (훅이 자동으로도 부른다)
bash scripts/check/harness.sh          # 하나만
bash scripts/dev/serve.sh              # AR 띄우기 (Vite dev)
bash scripts/assets/sync-from-unity.sh # 유니티 모델 다시 받기
node scripts/build/config.mjs          # .env → Shared/data/config/*.json
node scripts/build/config.mjs --check  # 쓰지 않고 대조만 (게이트가 쓴다)
```

## 설정은 `.env` 가 SSOT 다

**브라우저는 환경변수를 읽을 수 없다.** 그래서 `.env` 를 사람이 고치는 유일한 곳으로 두고
`scripts/build/config.mjs` 가 `Shared/data/config/*.json` 으로 굽는다. 브라우저는 그 JSON 을 fetch 한다.

- `Shared/data/config/*.json` 은 **산출물이다 — 직접 고치지 않는다.** gitignore 대상
- 형식은 `.env.example` (커밋됨). `cp .env.example .env` 로 시작한다
- 셸 환경변수가 `.env` 를 이긴다: `FR5_MARKER_BARCODE=5 node scripts/build/config.mjs`
- **값 검증이 이 스크립트의 본체다.** 바코드가 인쇄물과 다르면 화면에 아무것도 안 뜨고
  콘솔 에러도 없다. 그래서 범위·형식·**원본 존재**까지 보고 틀리면 멈춘다
- 손으로 JSON 을 고치면 `check/consts.sh` 가 드리프트로 잡는다

## 기준값이 있는 곳

숫자를 바꿀 일이 생기면 여기부터 본다. **안 고치면 게이트가 거짓으로 실패한다.**

| 스크립트 | 상수 | 현재값 | 언제 바꾸나 |
|---|---|---|---|
| `check/all.sh` | 락 나이 상한 | **900초** (15분) | 전량이 15분을 넘게 되면 올린다. 실렌더 판은 기계에 하나뿐이라 `mkdir` 락을 걸고, 죽은 주인·이 상한을 넘긴 락은 뺏는다 — 어떤 오탐도 15분 안에 저절로 풀린다 (D90) |
| `check/harness.sh` | `WANT_COMMANDS` `WANT_SKILLS` | 0 / 21 | 스킬을 더 만들거나 합칠 때 |
| `check/assets.sh` | `WANT_ARM_TRIS` `WANT_GRIP_TRIS` | 58482 / 70102 | 유니티 원본 모델이 바뀔 때 |
| `check/docs.sh` | `REQUIRED` 배열 | 15개 | SSOT 문서를 추가·삭제할 때 |
| `check/fr5-unit.sh` | 상수 없음 — 테스트가 스스로 기준 | **246 케이스** (2026-09-03 실측 · 08-06 엔 141 이었다) | `safety.py` 조건을 더하면 테스트도 더한다 |
| `check/tb-unit.sh` | 상수 없음 — 테스트가 스스로 기준 | **38 케이스** (지오펜스 19 + teleop 워치독 3 + 경로 16 — 오목 ㄱ자·fail-closed·탈출 없음·정지 통과·0 으로 끝내도 idle 복귀·경로 검증과 승격) + `main.py` 배선 4곳 grep | `geofence.py` 조건을 더하면 테스트도 더한다. **배선 grep 을 같이 두는 이유** — 순수 함수만 초록이고 브리지가 안 부르는 상태를 막는다 |
| `check/db-unit.sh` | 상수 없음 — 테스트가 스스로 기준 | 스키마 **10 테이블** + 보존 **12 케이스** | `Database/schema.sql`·`retention.py` 를 고치면 테스트도 더한다 |
| `check/fr5-render.sh` | 상수 없음 — `.mjs` 두 개가 스스로 기준 | 93 + 90 = **183 건** · 42초 | FR5 화면·브리지를 고칠 때. **자기 포트(5155·5157·5176)에 자기 브리지를 띄우고 `FR5_DATA_DIR` 를 임시 폴더로 돌린다 — 실기·`~/fr5-data/` 안 건드린다** |
| `check/ar-render.sh` | 상수 없음 — `.mjs` 두 개가 스스로 기준 | 13 + 69 = **82 건** · 약 40초 | AR 화면을 고칠 때. **자기 포트(5188·5189)에 자기 vite 를 띄운다.** 2026-08-07 신설 — `cam-web-verify` 가 겹침 2176px 어긋남을 잡고 있었는데 손으로 부르는 `.mjs` 라 며칠간 아무도 안 봤다. 마지막 1건은 **15초를 기다린다**(감시가 12초에 켜진다) |
| `check/sim-batch.sh` | 상수 없음 — `N=8` · `ROBOT=fr5-lab-a` | 완주 8/8 · 같은 seed 바이트 동일 · 다른 seed 는 달라짐 · **주입하면 zoneViolation** · 손끝 **5mm 미만** | `Sim/runner/batch.mjs` 나 `judge.mjs` 를 고칠 때. **픽스처가 없으면 SKIP** — 실기에서 굽는다(`scripts/dev/sim-fixture.mjs`). 96벌 실측은 사람이 돌려 evidence 에 남긴다 |
| `check/sim-scene.sh` | 상수 없음 — `ROBOT=fr5-lab-a` 프로필이 스스로 기준 | 파서 둘 일치 · **137mm 흔들면 따라온다** · 구역 빼면 죽는다 · `Sim/out` 미커밋 | `config.yaml` 의 `workspace` 를 고치거나 `build-scene.mjs` 를 고칠 때. **`@mujoco/mujoco` 가 없으면 SKIP 한다** — 게이트를 빨갛게 만들지 않되 잰 척도 안 한다 |
| `check/sim-parity.sh` | `sim-parity-poses.py` 의 `N=200` · `SEED=20260811` · `ROBOT=fr5-lab-a` | **202 대조**(경계 200 + 망가진 프로필 2) · 규칙 **5종** 전부 · 여유 +1mm 로 자기 빨간불 확인 | `safety.check_workspace` 를 고치면 **반드시** 같이 돈다. ⚠ **경계 자세를 늘리면 `N` 을 먼저 올린다** — 2026-08-11 에 상판 격자만으로 200 이 차서 벽 자세가 잘렸는데도 `200/200 일치` 로 초록이 났다. 지금은 넘치면 죽는다 |
| `check/dash-render.sh` | 상수 없음 — `.mjs` 가 스스로 기준 | **143 건** | 대시보드를 고칠 때. **자기 포트(5187)에 자기 vite 를 띄운다** — 개발용 5174 에 붙으면 고친 코드가 아니라 켜 둔 코드를 판정한다. 2026-08-07 신설 · 일부러 심은 버그로 빨간불을 확인했다 |
| `check/diagrams.sh` | 상수 없음 — 생성기와 그림이 스스로 기준 | `docs/diagrams/` **11장** (`arch-svg` 3 · `sim-svg` 4 · `topic-svg` 2 · `ur-svg` 1 · 손그림 1) · 3층: 생성기와 바이트 · 그림의 값과 코드 · `fr5:verified` 대조일 신선도 | 그림을 더하거나 생성기를 만들 때. **층이 하나였을 때 그림이 코드보다 낡은 채 초록이었다** — 「시뮬 코드 0줄」이 2,300줄 뒤에도 남아 있었다 (2026-08-12) |
| `check/shared-unit.sh` | 상수 없음 — 테스트가 스스로 기준 | **16 케이스** (카메라 상태 판정) | `Shared/` 에 순수 함수를 더하면 테스트도 더한다 |
| `check/cam-unit.sh` | 상수 없음 — 테스트가 스스로 기준 | **29 케이스** (깊이 판정 · 실측 표본 23개 잠금 · 관문 본문 · 미리보기 낡음) | `Vision/bridge/depth.py` 를 고칠 때. **카메라 없이 돈다** — 실기 게이트가 아니다. 손목 D435 실물 확인은 `curl :5058/api/camera/state` 로 손으로 한다 (하드웨어 필요) |
| `check/cam-bridge-verify.mjs` | 상수 없음 — 관문이 스스로 기준 | **19 건** · 손으로 부른다 | D435 관문을 고칠 때. **`all.sh` 에 안 넣는다** — D435 가 꽂혀 있어야 돈다(`fr5-cam-verify`·`tb-*` 와 같은 자리). **CORS 는 `curl` 로 못 잡는다** — 헤더를 보여줄 뿐 강제하지 않는다. 2026-08-07 신설 · CORS 를 빼서 `exit 1` 을 확인했다 |
| `check/motion.sh` | 상수 없음 — `Shared/data/motion/presets.js`·`limits.js` 가 기준 | 자세 10개 · 관절 한계 6쌍(URDF 대조) | 자세를 더하거나 URDF 가 바뀔 때 |
| `check/scenario.sh` | 상수 없음 — `Shared/data/scenario/presets.js` 가 기준 | 사건 13개 · 49초 · 거부 10종 | 시나리오 프리셋을 더하거나 사건 칸을 늘릴 때 |
| `assets/make-marker-sheet.py` | `SHEETS` · `QUIET_RATIO_MIN` | A4 170/14mm · A3 240/20mm · 하한 6% | 마커 크기·용지를 바꿀 때 |
| `map/make-tags.py` | `SHEETS` · `QUIET_RATIO` · `TAG_IDS` · **`FIXTURE_TAGS`** · **`PRINT_SCALE`** | A4 160mm · 1/8 · 방 기준 id 0~4 · **부착 태그 9종**(id 6·7·10·12·15·18·21·32·33) · **0.840** | 태그를 늘리거나 **다시 인쇄할 때**. ⛔ `FIXTURE_TAGS` 항목은 5칸이다 — `(id, 선언mm, 설명, 잰값, 출력위치)`. **네 번째 칸을 비우면 손으로 잰 값이 사라진다**(2026-08-18: 재생성 한 번에 id6 의 `halfMm`·`tagCenterToTopMm` 가 지워졌고 `fr5-unit` 이 잡았다). ⛔ **id 6 을 맨 앞에서 옮기지 마라** — `FR5/bridge/fixture.py:180,224` 가 `fixtureTags[0]` 을 집는다. `PRINT_SCALE` 은 **프린터 실측**이다(선언 ≠ 실제 · 방 기준 태그는 0.906 이었다) — 다시 뽑으면 자로 재서 고친다 |
| `map/aim.py` | `SAFE` · `RISKY` | 5.0 · 3.0 px/칸 | 검출 한계 실측이 갱신될 때 |
| `map/watch-calib.py` | `PERIOD_S` · `MIN_TAGS` | 1.0초 · 3장 | 화면이 3초마다 읽는다(`CamView`·`cam.js` 의 `DRIFT_MS`). ⚠ **경고선 5.0px 은 여기 없다** — 판정은 `Shared/data/camera/state.js` 의 `DRIFT_WARN_PX` 한 곳이 한다 |
| `map/edge-fit.py` | `SEARCH_PX` · `STEP_MM` · `MIN_PTS` · `MIN_EDGE_PTS` · `TOUCH_MM` · `OUTLIER_K` | 55px · 40mm · 20 · 5 · 20mm · 3.0 | 투영선 둘레만 훑는 폭 · 표본 간격 · 판정 최소 점수 · 한 변 최소 점수 · «물린 변» 판정 거리 · 이상점 문턱. ⛔ **처음부터 세우는 도구가 아니다** — 정합이 크게 틀어졌으면 `extrinsics.py` 가 먼저다. ⛔ 상판 높이는 **보고만 하고 안 쓴다** |
| `map/fixture-pose.py` | `JUMP_MM` · `JUMP_ACCEPT_AFTER` | 400mm · 3회 | **비전이 자리만 준다** (계약 §움직이는 장애물 · D130). ⛔ **크기·윗면거리는 여기 상수가 아니라 `Shared/assets/tag/tags.json` §fixtureTags 에 산다** — 예전엔 코드가 `HEIGHT_MM=86.5`(종이상자)를 들고 「태그는 옆면 정중앙」을 가정했는데 실물은 나무 정육면체였다. **받침이 바뀌면 조용히 틀리는 자리**라 데이터로 뺐고 **없으면 거부**한다. 점프는 1틱 상한이라 누적 표류를 못 막는다 — 자리 타당성(`fixture.on_table`)이 그쪽을 맡는다 |
| `map/marker_follow.py` | `MAX_TAG_RMS` · `Mirror.HEARTBEAT_S` | 2.0 px · 60초 | 한 태그 4점 IPPE 재투영 상한(넘으면 그 태그만 버린다 — 16점 상한보다 느슨한 이유는 모듈 머리말) · 원격 미러 심장박동(매 판 밀면 sshd 소스 페널티를 맞는다) |
| `map/watch-calib.py --auto` | `AUTO_STREAK` · `AUTO_MAX_RMS` · `AUTO_JUMP_MM` | 5회 · 2.0px · 500mm | **자기 캘리브레이션을 덮어쓰는 값들이다.** 태그는 배치도 전부를 요구한다(3장이면 176mm 틀려도 RMS 가 완벽해 보인다). `AUTO_MAX_RMS` 는 `extrinsics.py` `MAX_RMS` 와, `AUTO_WARN_PX` 는 `state.js` `DRIFT_WARN_PX` 와 **같아야 하고 시험이 원문을 읽어 대조한다** |
| `map/color-find.py` | `TAG_ID` · `MIN_AREA_PX` · `HSV_LO_HI` | 15 · 600px · 분홍(H 150~179 또는 0~8 · S≥80 · V≥90) | **태그를 못 붙이는 물건**을 색으로 찾는다 (D173). ⛔ **색만 믿지 않는다** — 색·최소 면적·**일감 구역 안** 셋을 같이 건다(09-03 에 초록 마스크가 매트로 71,955px 번졌다). 물건 색을 바꾸면 `HSV_LO_HI` 를 다시 잰다. ⚠ 산출은 **윗면 중심**이지 파지점이 아니다 |
| `map/touch-fit.py` | `STALE_S` · `MOVED_MM` · `MIN_SPAN_MM` | 60초 · 8mm · 300mm | 짚은 점으로 lab→로봇 변환을 푼다. **카메라가 한쪽에만 낀다** — 손끝은 ±0.02mm 참값이다. `MOVED_MM` 은 **짚는 동안 종이가 끌렸나**의 문턱(2026-09-04 에 53mm 끌려 오차와 구분이 안 됐다) — `--settle` 이 그걸 잡아 쌍을 버린다. `edge-fit.py` 와 **같은 세 값**(yaw·x·y)을 쓰지만 정답의 출처가 다르다 |
| `map/check-calib.sh` | `MAX_INTRINSIC_RMS` · `MAX_EXTRINSIC_RMS` | **0.5 · 2.0 px** | 캘리브레이션 재투영 상한. 2026-08-08 등재 — **`global-cam.json` 의 값은 여기 적지 않는다**(생성물이라 재측정마다 바뀐다). 문서가 그 숫자를 복제했다가 브리프 한 곳에서만 세 벌로 갈렸다 |
| `build/config.mjs` | `AVAILABLE_BARCODES` | 2 · 3 · 5 | 바코드 원본을 더 받거나 지울 때 |
| `check/docs-weight.sh` | `CAP_ENTRY_*` `CAP_STATUS_*` | 80/110 · **120/없음** | 진입 문서 상한. **PROJECT-STATUS 줄수는 경고만** — 하드로 걸었더니 통과하는 제일 싼 길이 "상한 바로 아래까지 아무거나 깎기" 였다 (실측 2026-08-08: 175→정확히 160). 하드는 `status-shape.sh` 가 맡는다 |
| `check/status-shape.sh` | `CAP_PAST` | 7 | `### 지난 날` 포인터 줄수(일주일치). 날짜 덩어리 개수 상한 **1** 은 상수가 아니라 불변식이라 코드에 박혀 있다 |
| `check/docs-weight.sh` | `CAP_DOC_*` `CAP_INDEX_*` | 300/450 · 45/61 | 개별 문서·INDEX 행 상한 |
| `check/docs-weight.sh` | `CAP_EVID_*` `CAP_RND_*` `CAP_TOTAL_*` | **8/14** · 5/8 · 9000/13000 | 폴더 개수·총량 상한. **총량은 「읽는 문서」만 센다** — `evidence/`·`archive/`(D71) 에 더해 **보관소 둘(`DECISION-LOG.md`·`GAP-CLOSED.md`)과 `SCOUT.md` 도 뺀다** (2026-08-12 · D118). 상한은 그대로다 — 읽지 않는 것을 예산에서 뺐을 뿐이다 |
| `check/docs-weight.sh` | `CAP_EVTOT_*` | 6000/12000 | `docs/evidence/**.md` 전용 총량 (2026-08-05 신설 · D71) |
| `check/docs-weight.sh` | `STALE_DAYS` | 30 | 방치 판정. 템플릿은 7일이나 세션 간격이 길어 늘렸다 |
| `check/docs-weight.sh` | `CAP_DECLOG_*` | 1200/없음 | **DECISION-LOG 전용.** 덧붙이기 전용 문서라 줄수는 경고만 — 하드 판정은 목차 대조가 한다 (2026-08-04) |
| `check/docs-weight.sh` | `CAP_FOLDER_MD` | **45**/90 | 폴더별 `AGENTS.md` 상한. **2026-08-08 실측으로 25→45** — 8개 중 6개가 25 를 넘는데 제일 큰 `Vision`(40줄)이 군더더기가 없었다. 25 는 템플릿 값이지 이 프로젝트 실측이 아니었다 |
| `check/docs-weight.sh` | `CAP_TOC` | 300 | **통독 문서는 이 줄수를 넘으면 `## 목차` 가 필수**고, 목차 항목 수 = 절 수. 줄수 하드캡 대신 이게 하드 판정을 한다 (2026-08-08 신설) |
| `check/docs-weight.sh` | `CAP_DECCUR_N` | 15 | `DECISION-LOG-CURRENT.md` 가 이고 있을 **결정 건수**. 넘으면 오래된 것부터 본편으로 옮긴다 |

`make-marker-sheet.py`는 **자기 출력을 픽셀로 검사한다.** quiet zone 안에 검은 잉크가
있거나 캡션이 용지를 넘치면 파일을 만들지 않고 실패한다. 배치표를 바꿀 때 그 검사가 문지기다.

## 훅이 자동으로 부른다

손으로 안 불러도 아래 시점에 돈다. `.claude/settings.json`이 배선이다.

| 시점 | 도는 것 |
|---|---|
| `docs/**.md` 편집 | `check/docs.sh` |
| `.claude/skills/**` · `commands/**` 편집 | `check/harness.sh` |
| `Shared/assets/**` 편집 | `check/assets.sh` |
| `scripts/build/*-svg.py` · `docs/diagrams/**` 편집 | `check/diagrams.sh` (바이트·값·신선도 3층) |
| `scripts/check/*` · 이 README 편집 | `check/consts.sh` |
| `.env` · `Shared/data/config/*` 편집 | `check/consts.sh` (`.env` ↔ JSON 대조) |
| 개수·기준값이 바뀔 편집 | `check/consts.sh` + `/정합` 알림 |
| **매 턴 끝** (`Stop`) | `check/all.sh --fast` — 실렌더 + 문서 전수(`docs.sh`·`refs.sh`)를 뺀 21개 · **16초** (2026-08-08 재측정 · 옛 표기 9초는 문서가 작던 때다). **트리가 그대로면 지난 판정을 되돌려 주고 0.2초에 끝난다** |
| **세션 종료** (`SessionEnd`) | `check/all.sh` 전량 — 레드면 알린다 (`docs-weight.sh` 는 daily 모드로 같이 돈다) |

**실패할 때만 출력한다.** 통과하면 조용하다.

## 문서 무게 — `check/docs-weight.sh`

문서가 쌓여 진입 비용이 오르는 것을 막는다. **재고 판정만 하고 지우거나 옮기지 않는다** —
문서는 SSOT이고, 스크립트가 조용히 옮기면 다음 세션이 못 찾는다.

```bash
bash scripts/check/docs-weight.sh            # daily. 게이트가 매번 부른다 (싸다)
bash scripts/check/docs-weight.sh --weekend  # 중복 md5 · 30일 방치 · 빈 문서 · 이관 후보
```

- **경고(soft)는 exit 0** — 출력만 하고 통과시킨다. 다음 마감 때 처리하면 된다
- **초과(hard)는 exit 1** — 게이트가 막는다
- 무엇이 왜 쌓이는지와 임계값 출처는 `docs/archive/evidence-2026-07/2026-07-30/doc-weight.md`

**`DECISION-LOG` 만 다르게 잰다.** `docs/INDEX.md` 가 "archive 로 옮기지 않는다" 고
못 박아서 "절을 잘라 이관하라" 는 처방이 적용되지 않는다. 조치 불가능한 경고는 소음이다.
대신 **상단 D번호 목차가 실제 결정 개수와 맞는지**를 잰다 — 안 맞으면 exit 1.
그게 통독을 없애는 장치이고, 이 문서의 진짜 불변식이다.
