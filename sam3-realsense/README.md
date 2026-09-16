# sam3-realsense

RealSense 카메라로 입력받은 영상을 SAM3를 통해 오브젝트를 인식하는 스크립트

## 폴더

| 폴더 | 내용 |
|---|---|
| [`tests/`](tests/) | SAM 3.1 텍스트 프롬프트 분할을 RealSense 프레임에 돌려 보는 테스트 스크립트 |
| [`scripts/`](scripts/) | SAM 3.1 비디오 세그멘테이션으로 오브젝트의 좌표를 인식하고, 그 좌표를 바탕으로 FR5로봇을 컨트롤하는 스크립트 |

### `tests/`

SAM 3.1 멀티플렉스 비디오 예측기(`build_sam3_multiplex_video_predictor`)를 RealSense 카메라에
붙여 텍스트 프롬프트로 물체를 분할한다.

- `tests/test_realsense_single_frame.py` — 한 프레임 분할
- `tests/test_realsense_two_frames.py` — 연속 두 프레임 분할
- `tests/test_realsense_sam3.py` — 실시간 분할 (기본 프롬프트 `pink plastic crate`)

체크포인트 경로가 스크립트 안에 고정돼 있어 환경에 맞게 바꿔야 한다.


### 'scripts/'

각각의 시나리오를 상정하여 그에 맞는 동작을 수행하는 스크립트들
각 시나리오에서 FR5로봇과 상호작용할 것으로 상정된 오브젝트는 분홍색 플라스틱 상자이다.

- 'scripts/sam3_scenario1.py' - 바닥에 놓여있는 오브젝트를 잡아 터틀봇에 부착된 바구니에 넣어놓는 시나리오
- 'scripts/sam3_scenario2.py' - 터틀봇에 부착된 바구니에 들어있는 오브젝트를 잡아 바닥에 내려놓는 시나리오
- 'scripts/sam3_scenario3.py' - 위의 두 시나리오와 다른 장소에 있는 터틀봇을 추적하여, 바구니에 들어있는 오브젝트를 잡아 바닥에 내려놓는 시나리오
