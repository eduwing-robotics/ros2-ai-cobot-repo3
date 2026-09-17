# ros2-ai-cobot-repo3

ROS 2 기반 AI 협동로봇 작업을 모은 저장소다. 폴더마다 독립된 작업이며 서로 의존하지 않는다.

## 폴더

| 폴더 | 내용 |
|---|---|
| [`sam3-realsense/`](sam3-realsense/) | SAM 3.1 텍스트 프롬프트 분할을 RealSense 프레임에 돌려 보는 테스트 스크립트 |
| [`vision-pick-and-place/sam3/`](vision-pick-and-place/sam3/) | SAM3 비주얼 서보잉으로 FR5 가 탄피·탄두를 집어 격자 트레이에 놓는 실기 프로젝트 |
| [`fr5-screw-rl/`](fr5-screw-rl/) | FR5 가 탄두를 탄피에 나사 결합하는 작업의 PPO 강화학습 환경과 학습된 정책 |
| [`fr5-safety_system/`](fr5-safety_system/) | 가상 센서 기반 온·습도 제어 폐루프. 상태를 MQTT 토픽으로 발행 |

### `sam3-realsense/`

SAM 3.1 멀티플렉스 비디오 예측기(`build_sam3_multiplex_video_predictor`)를 RealSense 카메라에
붙여 텍스트 프롬프트로 물체를 분할한다.

- `scripts/test_realsense_single_frame.py` — 한 프레임 분할
- `scripts/test_realsense_two_frames.py` — 연속 두 프레임 분할
- `scripts/test_realsense_sam3.py` — 실시간 분할 (기본 프롬프트 `pink plastic crate`)

체크포인트 경로가 스크립트 안에 고정돼 있어 환경에 맞게 바꿔야 한다.

### `vision-pick-and-place/sam3/`

FAIRINO FR5 + RealSense D435 (eye-in-hand) + ROS 2 Jazzy. SAM3 로 물체를 찾고, 화면 중심으로
X/Y 서보한 뒤, 파지 자세로 제자리 회전하고, 실측 보정값만큼 내려가 집는다.

| 대상 | 상태 |
|---|---|
| 탄피 | 홈 → 정렬 → 회전 → 파지 → 놓기 → 박기 → 복귀, 셀 안착 확인 |
| 탄두 | 홈 → 정렬 → 회전 → 파지 → 놓을 위치까지. 쥔 채 멈추고 돌려 끼우는 동작은 [`fr5-screw-rl/`](fr5-screw-rl/) 의 강화학습 정책에 넘긴다 |

- 실행: `VISIONSCRIPTS/sam3_pick_ros2.py`
- 실측 기록과 현재 실행 명령: `LEADME/비주얼서보잉-실기검증.md` **8절**
- 폴더 안 `README.md` 에 설치·실행 요약이 있다

### `fr5-screw-rl/`

탄두를 탄피에 **돌려 끼우는** 구간을 PPO 로 학습한다.
`vision-pick-and-place/sam3/` 가 파지까지 하고 넘긴 지점부터다.

착좌까지 **6.25 바퀴**가 필요한데(전진 5.00mm ÷ 피치 0.8mm), j6 가동범위가 ±175° 라
한 스트로크가 **344° = 0.956 바퀴**뿐이다. 그래서 스트로크마다
`그리퍼 열기 → 손목 되감기 → 다시 잡기` 가 들어가고, 착좌까지 재파지가 6회 필요하다.

학습 환경은 **MuJoCo 물리를 쓰지 않는다.** 나사 결합의 지배 관계
`전진 = 회전 × 피치 ÷ 2π` 를 해석식으로 모델링했고, MuJoCo 는 역기구학 · 자기충돌 검사 ·
렌더링에만 쓴다. 30만 스텝 학습 1회가 1분에 끝나 반복 검증이 가능하다.

<img src="fr5-screw-rl/docs/images/screw-macro.png" width="460">
<img src="fr5-screw-rl/docs/images/learning-curves.png" width="460">

왼쪽 — 체결 중. 탄두가 회전하며 탄피 안으로 들어간다. 축방향 전진은 오직 회전으로만 일어난다.
오른쪽 — 동일 조건 15회 학습. 굵은 선이 중앙값이다. 15회 모두 10만 스텝까지 0% 이고,
첫 100% 도달이 12.5만~27.5만으로 흩어진다.

| 폴더 | 내용 |
|---|---|
| `src/` | 학습 환경 · PPO 학습/검증/녹화 · 실기 실행 스크립트 · MuJoCo 씬 · 실측 작업 원점 |
| `meshes/` | 로봇 · 그리퍼 · 탄두 · 탄피 · 고정대 STL 과 URDF |
| `models/` | 선정 정책 1개 — 20 에피소드 재평가 성공률 100%, 문지름 0.0 |
| `study_test/` | 초기 CartPole 연습 코드. 본 작업과 무관 |

- 학습: `src/train_screw_ppo.py --steps 300000`
- 확인: `src/verify_screw_policy.py` (MuJoCo 창)
- 실기: `src/fr5_execute_policy.py` — **기본이 dry-run**, 실물 실행에는 선행 조건 3개가 필요하다
- 폴더 안 `README.md` 에 상태·행동 공간, 실기 게이트, **알려진 한계**가 정리돼 있다

### `fr5-safety_system/`

가상 센서로 온·습도를 만들고, 이상 상황을 판단해 냉방·제습·환기를 돌리고, 그 결과가 다시
환경에 반영되는 폐루프다. 나사 결합과 무관한 독립 하위 시스템이다.

```
Virtual Sensor → Main Server → AI Safety Engine → Actuator → Simulation → (되돌아감)
```

| 토픽 | payload | 발행 시점 |
|---|---|---|
| `environment/temperature` | `30.0` | 매 주기 (20초) |
| `environment/humidity` | `45.0` | 매 주기 |
| `environment/status` | `HIGH_TEMPERATURE,HIGH_HUMIDITY` | 상태가 바뀔 때만 |
| `environment/control` | JSON | 제어가 바뀔 때만 |

- 브로커 없이 시연: `env_demo.py`
- 관제 서버용 참조 구독자: `env_dashboard_client.py` — 이 파일만 넘기면 된다
- 정상 범위 온도 21~28℃ · 습도 35~40%
