# SAM3 Visual Servoing Pick & Place

SAM3 로 탄약을 찾아 FAIRINO FR5 협동로봇이 격자 트레이에 꽂고 빼는 실기 프로젝트.
야코비안을 학습하지 않고 픽셀 오차를 깊이와 초점거리로 바로 mm 로 바꿔 서보한다.

![ROS 2 Jazzy](https://img.shields.io/badge/ROS%202-Jazzy-22314E?logo=ros)
![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FR5](https://img.shields.io/badge/Robot-FAIRINO%20FR5-0A66C2)
![RealSense D435](https://img.shields.io/badge/Camera-RealSense%20D435-00B4E0)
![SAM3](https://img.shields.io/badge/Model-facebook%2Fsam3-FF6F00)

<!-- docs/demo.gif 를 넣으면 여기에 표시된다
![demo](docs/demo.gif)
-->

## 핵심

**픽셀→mm 을 학습 없이 구한다.** 손눈 보정이나 야코비안 학습 단계가 없다.

```
mm = px × Z / fx        fx = 604.5 (D435 640x480)
```

깊이 카메라가 Z 를 주므로 보폭을 매번 다시 계산한다. 물체가 멀면 보폭이 자동으로
커지고, 가까우면 작아진다. 학습 절차가 사라지고 카메라 높이가 바뀌어도 그대로 쓴다.

## 실측 결과

| 항목 | 결과 |
|---|---|
| 정렬 (X·Y 동시 서보) | **3~5회**에 1.7~2.8px 수렴 (허용 4.0px ≈ 1.7mm) |
| 탄피 전 구간 | **5회 연속 완주** — 홈→정렬→파지→놓기→박기→복귀 |
| 탄두 전 구간 | 완주 확인. 파지 재현성 **7회 중 3회** (아래 "미해결") |
| 하강·경유점·놓기 정확도 | 목표차 **0.13mm 이내** |
| 들어올리기 | +100mm 명령에 실제 **+99.95mm** |
| 종류 분류 | 거리 기준. 탄피 260mm / 탄두 277~284mm (17mm 여유) |

순차 서보를 X·Y 동시로 바꿔 정렬 횟수가 10~13회에서 3~5회로 줄었다.

## 빠른 실행

```bash
# 사전 조건 — 둘 다 하나씩만. 중복되면 로봇이 명령을 거부한다
ros2 launch realsense2_camera rs_launch.py align_depth.enable:=true
ros2 run fairino_hardware_v3_9_7 ros2_cmd_server

cd VISIONSCRIPTS

# 탄피 전 구간 (5회 연속 완주)
python sam3_pick_ros2.py --descend --display --sign "+,-" \
    --threshold 0.15 --min-len-mm 0 --exclude "430,0,640,480"

# 탄두 — 격자에 꽂힌 물체. 위에서 링만 보여 점수가 낮으므로 임계를 내린다
python sam3_pick_ros2.py --descend --display \
    --detector sam3 --threshold 0.03 --min-len-mm 0 \
    --sign "+,-" --exclude "430,0,640,480"

# 로봇을 건드리지 않고 흐름만 확인
python sam3_pick_ros2.py --dry
```

## 동작

1. **홈 이동** — `HOME_JOINTS` 상수. `JNTPoint` + `MoveJ`
2. **검출** — SAM3 (`facebook/sam3`) 프롬프트 `"bullet,metal ring"`
3. **분류** — 카메라 거리로 탄피·탄두를 가른다
4. **정렬** — X·Y 동시 서보. `MoveJLC_offset_pos_*` + `CARTPoint` + `MoveL` 로 상대 이동
5. **하강** — 실측 보정값만큼 상대 이동 후 파지
6. **놓기** — 절대좌표 경유점 → 놓을 위치 → 1mm 씩 박기 → 경유점 복귀 → 홈

종류별로 보정값·그리퍼 값·놓는 좌표·박기 단계·복귀 여부가 갈린다 (`KIND_CFG`).

## 구조

```
VISIONSCRIPTS/    비전·서보 본체 — sam3_pick_ros2.py (1362줄)
  grip_offset.json      파지 보정 실측값 + 조정 이력
  tandu_align_ref.json  탄두 보정값을 측정한 정렬 기준 자세
  aligned_poses.json    정렬 완료 기록 누적
tools/            로봇 유틸·진단 — home jog grip goto pose grab
                  깊이 실측 — depth_profile dp_points dp_mask detcmp
scripts/          SAM3 파이프라인 실험
LEADME/           실기 검증 기록 — 막혔던 것들과 원인
unity/            실측 좌표로 만든 작업대 + 궤적 재생 (README 참고)
```

이미지·영상·모델 가중치는 저장소에 없다 (`.gitignore`). `IMEAGE/`, `PT/`,
`VISIONSCRIPTS/study/` 는 로컬에만 둔다.

자주 쓰는 유틸:

```bash
python tools/pose.py            # 현재 TCP·관절·그리퍼 (로봇 안 움직임)
python tools/home.py 10         # 홈으로 이동, 속도 10%
python tools/jog.py 0 0 -5      # 상대 이동 dx dy dz
python tools/grip.py 35         # 그리퍼만
```

## 막혔던 것들

실측으로 원인을 규명한 기록이 [검증 문서](LEADME/비주얼서보잉-실기검증.md)에 1144줄로 있다.
하드웨어에서 증상과 원인이 어긋나는 경우가 많아, 증상별로 **무엇을 재서 원인을 좁혔는지**를
남겼다.

몇 가지만:

- **정렬될수록 검출이 죽는다** — 물체가 화면 중심에 올수록 수직으로 내려다보게 되어
  링만 남고 `bullet` 점수가 0.029 로 떨어진다 (`metal ring` 은 0.703). 프롬프트를 둘 다 쓴다
- **파지가 빈손인데 좌표는 정확했다** — 도달 판정이 거리만 봐서 감속 구간에서 조기 통과했다.
  아직 1.8mm 내려오는 중에 그리퍼를 닫았고, 물릴 구간이 2~3mm 뿐인 꽂힌 물체는 100% 실패했다.
  탄피는 여유가 커서 같은 버그를 안고도 5회 완주했다 — **한 종류가 되는 것은 판정 로직의 검증이 아니다**
- **깊이로 물체를 찾을 수 없다** — 물체 top 285mm, 격자 리브 top 285~287mm 로 같은 높이다.
  `MORPH_OPEN` 으로 리브를 침식하는 것도 교차점이 물체만큼 굵어 실패했다
- **카메라가 유령 노드로 남는다** — USB 가 실제로 빠졌다가 다른 포트로 재연결되면
  노드는 옛 장치 경로를 붙든 채 살아 있다. `node list` 에는 보이는데 `topic hz` 가 안 나온다

## 미해결

- **탄두 파지 재현성 3/7** — 정렬 TCP 의 X ≈ 317 을 경계로 예외 없이 갈린다.
  정렬·검출·도달 판정은 `--no-servo` 로 모두 배제했다. 한 위치에서 1회 실측한 보정값을
  위치 무관 상수로 쓴 것이 원인으로 보인다
- **검은 물체 미검출** — 25회 이상 측정에서 점수 0.08~0.53, 임계 0.15 에서 약 50% 놓친다
- **루프** — 놓는 좌표가 고정이라 두 번째 물체가 첫 번째 위에 쌓인다

## 유니티에서 재생

실측 좌표로 작업대를 세우고 실기 동작을 녹화해 재생한다. 로봇을 건드리지 않는다.

```bash
# 동작 녹화 (실행에 옵션 하나만 추가)
python sam3_pick_ros2.py --descend ... --record-traj ../unity/traj_pick.json

# 작업대 JSON 생성
python unity/make_unity_scene.py <프로젝트>/Assets/StreamingAssets/
```

작업대는 카메라 깊이와 로봇 좌표를 이어 붙여 유도했다 — 테이블 상판은 로봇 베이스보다
**329mm 아래**, 격자 리브의 top 이 곧 파지 평면(`Z = -287.6`)이다.
씬에는 실측 파지점 8개가 **성공(초록)·실패(빨강)** 으로 찍혀, 정렬 X 317 경계가
공간적으로 보인다. 자세한 것은 [unity/README.md](unity/README.md).

## 환경

```
로봇      FAIRINO FR5 · 192.168.58.2 (PC 192.168.58.10)
제어      ros2_cmd_server (fairino_hardware_v3_9_7)
카메라    RealSense D435 eye-in-hand · 640x480 · aligned_depth_to_color
모델      facebook/sam3 (bfloat16, CUDA)
ROS       ROS 2 Jazzy
```
