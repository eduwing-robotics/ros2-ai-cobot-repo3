# 유니티 재생 — 작업대와 실기 궤적

실기에서 측정한 좌표로 작업대를 세우고, 실제 동작을 녹화해 유니티에서 재생한다.
로봇을 건드리지 않고 동작을 다시 볼 수 있다.

```
[실기 실행] --record-traj -->  traj_pick.json  --\
                                                 >-- [유니티 FR5 재생]
[실측 좌표]  workbench.json  --> workbench_unity.json  --> [작업대]
```

## 좌표계

이게 핵심이다. 틀리면 로봇과 작업대가 안 겹친다.

```
로봇 베이스   X 앞, Y 왼쪽, Z 위, mm, 오른손
유니티        X 오른쪽, Y 위, Z 앞, m, 왼손

unity = (-Y, Z, X) / 1000
```

URDF Importer 를 `axisType.yAxis` 로 불러오면 로봇 모델도 같은 규약을 쓴다
(기존 `FR5Setup.cs` 가 그렇게 설정한다). 그래서 이 변환만 맞추면 정확히 겹친다.

로봇 베이스는 원점이고 **테이블 상판보다 329mm 위**에 있다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `workbench.json` | 작업대 실측 정의. **값마다 출처를 달았다.** 사람이 읽고 고치는 원본 |
| `make_unity_scene.py` | 위 파일에서 값만 뽑아 `workbench_unity.json` 생성 (JsonUtility 용) |
| `WorkbenchBuilder.cs` | 유니티에서 작업대를 만든다. 격자 트레이는 리브까지 세운다 |
| `WorkbenchJson.cs` | 평탄 JSON 파서 |

## 쓰는 순서

**1. 작업대 JSON 만들기**

```bash
cd ~/SAM3/unity
python make_unity_scene.py ~/Imitation_Learning/unity/FR5Viewer/Assets/StreamingAssets/
```

**2. 실기 동작 녹화**

```bash
cd ~/SAM3/VISIONSCRIPTS
python sam3_pick_ros2.py --descend --display --sign "+,-" \
    --threshold 0.15 --min-len-mm 0 --exclude "430,0,640,480" \
    --record-traj ~/SAM3/unity/traj_pick.json
```

끝나면 프레임 수와 길이가 출력된다. 25fps 로 관절 6축과 그리퍼를 찍는다.
녹화만 하고 로봇을 안 움직이려면 `--dry` 를 같이 준다.

**3. 유니티에 넣기**

| 넣을 것 | 위치 |
|---|---|
| `WorkbenchBuilder.cs`, `WorkbenchJson.cs` | `Assets/Scripts/` |
| `workbench_unity.json` | `Assets/StreamingAssets/` |
| `traj_pick.json` | `Assets/StreamingAssets/` |
| (기존) `Scripts/Trajectory*.cs`, `FR5Model/` | `Imitation_Learning/unity` 에서 가져온다 |

빈 GameObject 에 `WorkbenchBuilder` 를 붙이고 Play 하면 작업대가 생긴다.
궤적 재생은 기존 `TrajectoryPlayer` 를 그대로 쓴다 — 스키마가 호환된다
(기존 `traj_ep000.json` 의 16개 키를 모두 채우고 `tcp_mm` 만 추가한다).

## 작업대가 어떻게 나왔나

카메라 깊이와 로봇 좌표를 이어 붙여 유도했다.

```
정렬(카메라) 평면   Z = -86.6    aligned_poses.json 38건
파지 평면           Z = -287.6   정렬 Z + 탄두 보정 dz(-201.0). 실측 하강 7회 -287.52~-287.63
매트 표면           Z = -321.6   파지 평면 - 34mm  (홈에서 깊이: 매트 319 / 리브 285)
테이블 상판         Z = -328.6   파지 평면 - 41mm  (홈에서 깊이: 흰바닥 326 / 리브 285)
```

파지 평면이 곧 격자 리브의 top 이다 — **물체 top 과 리브 top 이 같은 높이**라는 것을
깊이로 실측했기 때문이다 (물체 285mm / 리브 285~287mm). 그래서 `WorkbenchBuilder` 는
리브를 트레이 높이까지 세운다. 깊이 검출이 왜 실패했는지 씬에서 그대로 보인다.

## 씬에 표시되는 것

- **파지점 8개** — 이번 세션 실측. **빨강은 빈손, 초록은 성공**이다.
  정렬 X 317 을 경계로 갈리는 것이 공간적으로 보인다 (파지 X = 정렬 X + 38.23)
- **놓기 경유점·놓을 위치** 4개 (탄피·탄두 각 2개), 파랑
- **홈 TCP** 흰색

## 신뢰도

| 값 | 근거 |
|---|---|
| 홈·경유점·놓기·파지점 좌표 | ✅ 로봇이 보고한 실측값 |
| 파지·매트·테이블 평면 Z | ✅ 실측 깊이차로 유도 |
| 트레이 중심·가로세로 | ⚠️ 파지점 8개의 중앙 + 화면 픽셀에서 환산 |
| 트레이 격자 피치 11mm | ⚠️ 화면에서 센 값 |
| 테이블·기둥 크기 | ❌ 실측 아님. 작업 영역을 덮도록 임의로 잡았다 |
| 고정대 크기·높이 | ❌ 실측 아님. X/Y 와 놓기 Z 만 실측이다 |

❌ 표시는 눈으로만 맞춘 값이니, 충돌 검사나 정밀 시뮬레이션에 쓰려면 실측해야 한다.
`workbench.json` 의 각 `note` 에 같은 내용이 적혀 있다.

## 아직 안 된 것

- **유니티 에디터 본체가 설치돼 있지 않다.** Unity Hub 는 있다 — 2022.3 LTS 이상을 하나 깔아야 한다
- C# 은 컴파일 검증을 못 했다 (이 환경에 컴파일러가 없다). 에디터에서 처음 열 때 확인이 필요하다
- 물체(탄피·탄두) 모델은 넣지 않았다. 트레이 칸에 실린더를 놓으면 된다
- 카메라의 TCP 기준 오프셋은 측정하지 않았다 — 유니티에서 카메라 시점을 재현하려면 필요하다
