# Vision — 손목캠 관문 **가동** · `/proposal` 만 미착수 (검출·hand-eye 는 딴 폴더에 있다)

`bridge/` 는 산다 — 읽기 여섯(`/api/camera/{info,state,preview,depth/frame,rgbd/frame,ir/frame}` · `:5058` · D86·D207).
`depth/frame` 은 **단발 스냅샷**이다 (2026-08-11 · 16비트 PNG · mm · 무효 0) — 컬러 단독 분할이
이 작업물에서 실패해서 열었다(`docs/evidence/2026-08-11/round-detect-probe.md`). `rgbd/frame`은
총알 xy용 동기화 ZIP이고 스트림은 여전히 컬러뿐이다.
⚠ **「검출·hand-eye 는 0줄」은 2026-08-27 에 거짓이 됐다.** 둘 다 있고, 다만 **이 폴더가 아니다** —
검출은 `scripts/robot/depth-probe.py`(평면 피팅 · 계기), hand-eye 는 **풀려서**
`FR5/bridge/config.yaml` 의 `handEye`(흩어짐 **5.74mm** · 08-13)에 등재돼 `/state` 로 나가고
화면까지 온다(D145). `FR5/bridge/follow.py` 가 추종 목표까지 계산한다(시험 완비).

**진짜로 0줄인 것은 `POST /proposal` 하나**이고, 끊긴 곳도 거기다 — `follow.py` 가 **브리지에
배선돼 있지 않다**(부르는 것은 맥의 `scripts/dev/follow-map.py` 뿐). 관문이 §문을 안 지나는
이유는 **로봇에 명령하지 않기 때문**이다. 증거 `docs/evidence/2026-08-07/cam-bridge-live.md`.

**비전은 명령을 만들지 않는다. 제안을 만든다** — 죽으면 아무 일도 안 일어난다(fail-closed).
계약 `docs/ref/contract/VISION-CONTRACT.md` · 경계 `docs/ref/arch/ARCHITECTURE.md` §비전 ·
제원 `docs/ref/arch/DEPTH-CAM.md` · 조사(SSOT 아님) `docs/research/vision-imitation.md`.

## 폴더

| 경로 | 무엇 |
|---|---|
| `bridge/` | D435 읽기 관문 (FastAPI · `:5058`). **여기서 로봇에 명령하지 않는다** — 그래서 아래 §문을 안 지난다 |

`POST /proposal` 클라이언트는 아직 폴더가 없다. 만들 때 이 표에 먼저 적는다.
⚠ 검출·hand-eye 는 **폴더가 없는 게 아니라 여기 없는** 것이다 — `scripts/robot/` 의 계기 둘과
`FR5/bridge/follow.py` 다. 옮길지 그대로 둘지는 사다리 7 을 열 때 정한다.

## 카메라라고 다 Vision 이 아니다 — 여기 것은 셋뿐이다

| 일 | 주인 |
|---|---|
| **D435 관문(`bridge/` · 가동)** + 객체 검출 · hand-eye 변환(카메라→TCP) · `POST /proposal` 클라이언트 | **여기** |
| 글로벌 카메라(폰) 캘리브레이션 — 내부·외부 파라미터 | `scripts/map/` |
| 배치안 겹쳐 보기 | `AR/src/screens/cam.js` |
| 라이브 PiP · 공간 HUD · 제안 고스트 | `FR5/src/features/live/` |
| `/proposal` 접수 · 판정 3단 · 조종권 · `moveJ` 번역 · 기록 | `FR5/bridge/` |

**상한을 여기서 만들지 않는다** (`docs/ref/contract/SAFETY-RULES.md` §상한 그대로) — 비전용 상한이 곧 게이트 우회로다.

## 문이 다 열렸다 (2026-08-10) — 이제 막는 건 「만든 게 없는 것」이다

~~저울~~·~~말단 하중~~·~~툴 좌표계 검증~~·~~TCP 기준점~~·~~호스트~~ 전부 닫혔다. 셋은 **원래
열려 있었는데 문서가 안 따라와** 막혀 보였다. 순서는 `plan/VISION-SERVO-LADDER.md` —
~~**다음은 사다리 5(객체 검출)**~~ → **5·6 은 닫혔다** (2026-08-27 정정). 검출은 돌고
hand-eye 는 5.74mm 로 풀렸다. **다음은 사다리 7(`/proposal` 배선)** 이고, 조각은 다 있다 —
검출·hand-eye·IK(`inverse_kin`)·이동(`move_j`)·추종 계산. **끊긴 곳은 배선 하나**다.

⛔ **다만 물리 벽이 하나 서 있다** — 총알이 **세워 꽂히는 것이 정본**이 됐는데(주인님 확정)
세운 총알은 위에서 **스테레오 그림자로 자기를 지운다**(받침 21% 무효 · 8개 중 4개만 · 2~5mm).
옆(90°)은 08-13 에 이미 반증됐다(평면이 깨져 덩어리 0개 · 실용 상한 **40°**).
근거 `docs/evidence/2026-08-27/standing-bullets-depth-holes.png`

⛔ **`targetPose.tcpMmDeg` 는 「물체가 어디 있나」가 아니라 「손끝을 어디 두라」다** (D108).
TCP 는 핑거 끝이므로 **삽입 깊이를 여기서 명시적으로** 더한다 — 툴에 숨기지 않는다.
⚠ 실기는 **`tool 1 · user 1`** 로 돈다(`config.yaml` 의 `0` 은 적용된 적 없다) — 실행 직전
`coord` 대조가 `toolFrameMismatch` 다.

## 다시 논의하지 마라

**마지막 구간은 아무것도 안 보인다** — 컬러가 손끝 아래 36mm, 깊이가 2mm 에서 끊긴다(D69).
앵커로 봉인한다. **closed-loop 도 "파지 순간 RGB 만" 도 기각됐다.** `auto` 통과도 닫혀 있다.
