# ros2-ai-cobot-repo3

ROS 2 기반 AI 협동로봇 작업을 모은 저장소다. 폴더마다 독립된 작업이며 서로 의존하지 않는다.

## 폴더

| 폴더 | 내용 |
|---|---|
| [`sam3-realsense/`](sam3-realsense/) | SAM 3.1 텍스트 프롬프트 분할을 RealSense 프레임에 돌려 보는 테스트 스크립트 |
| [`vision-pick-and-place/sam3/`](vision-pick-and-place/sam3/) | SAM3 비주얼 서보잉으로 FR5 가 탄피·탄두를 집어 격자 트레이에 놓는 실기 프로젝트 |

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
| 탄두 | 홈 → 정렬 → 회전 → 파지 → 놓을 위치까지. 쥔 채 멈추고 돌려 끼우는 동작은 강화학습 정책에 넘긴다 |

- 실행: `VISIONSCRIPTS/sam3_pick_ros2.py`
- 실측 기록과 현재 실행 명령: `LEADME/비주얼서보잉-실기검증.md` **8절**
- 폴더 안 `README.md` 에 설치·실행 요약이 있다
