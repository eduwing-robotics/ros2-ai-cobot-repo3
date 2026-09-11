# STACK — 확정 기술과 버전

분류: **SSOT**. 라이브러리를 고르거나 버전을 올릴 때 여기를 먼저 고친다.
최종 확인 2026-09-11 (npm·PyPI 레지스트리 및 GitHub API 직접 조회).

## 목차

15개 절. **`##` 절과 이 목록은 같아야 한다** — `docs-weight.sh` 가 잰다.

- 층별 확정
- AR — 마커 방식 (정본은 `AR-MARKER.md`)
- 3D — 우리 자산 그대로 쓴다
- 에셋 저작 — 무대 소품은 파일이 아니라 함수다 (2026-08-03 등재 · D51)
- 그리퍼 — URDF에 없다. 확장해야 한다
- 뎁스카메라 — RealSense D435 (정본은 `DEPTH-CAM.md`)
- TurtleBot3 겉치수 — 2026-08-07 등재 (사양서 확인 · 줄자 미검증)
- 궤적 — 역기구학(IK) 없이 된다
- 함정 — 먼저 알고 시작할 것
- 참고할 남의 코드
- 맵 편집기 (Dashboard) — 2026-07-30 등재
- FR5 실기 Python SDK — 2026-07-31 등재 (D42 · 현행)
- 로봇 안전 설정 API — 2026-08-04 등재 (소스 확인 · 실기 미검증)
- 물리 엔진 — MuJoCo WASM · 2026-08-11 등재 (레지스트리 조회 · 브라우저 실측 · 장면 생성이 소비)
- ~~FR5 실기 C# SDK 경로~~ — 폐기 (D41→D42 · 2026-07-31)

## 층별 확정

| 층 | 선택 | 버전 | 근거 |
|---|---|---|---|
| 폰 카메라 정합 | AR.js | `@ar-js-org/ar.js` 3.4.8 | iOS·안드로이드 양쪽에서 되는 유일한 방식 |
| AprilTag 재사용 킬-실험 | js-aruco2 | 2.0.0 | WebXR 이미지 추적이 거부한 36h11 태그를 일반 카메라 프레임에서 직접 검출. 실폰 검출 통과 전에는 정합 경로에 넣지 않는다 |
| 3D 렌더 | three.js | 0.185.1 | — |
| 로봇 모델 로딩 | urdf-loader | 0.13.1 | STL을 기본 지원 → 우리 URDF 그대로 사용 |
| 궤적 계산 | 정기구학(FK) 보간 | 자체 | IK 불필요 — §궤적 참조 |
| 서버 | FastAPI + uvicorn | 0.140.13 / 0.52.0 | — |
| 로봇 통신 | Fairino 공식 파이썬 SDK | GitHub 배포 | **PyPI에 없음** — §함정 참조 |
| 브라우저↔서버 | WebSocket | — | 양방향 필요, 100Hz 여유 |
| 물리 엔진 (시뮬 전용) | MuJoCo WASM | `@mujoco/mujoco` 3.11.0 | 딥마인드 공식 프리빌트 — Emscripten 빌드 불필요. **로봇에 안 붙는다** (§물리 엔진) |
| 뎁스카메라 | Intel RealSense D435 | 데이터시트 **337029-017** | 손끝 위 80mm · 툴 축 옆 82mm (실측) · **75g ±10%**(Table 3-52 — 도는 「72g」은 이 리비전과 다르다) — §뎁스카메라 |

React(`@react-three/fiber` 9.6.1)는 **화면이 복잡해진 뒤에** 도입한다. 처음엔 순수 three.js.

## AR — 마커 방식 (정본은 `AR-MARKER.md`)

iOS 사파리가 `immersive-ar`(WebXR)를 안 열어주므로 **카메라 영상을 직접 받아 마커를 찾는
방식**만 양쪽에서 동작한다. 마커 번호(#5)·인쇄 규격(A4 170mm)·검출 실측(**크기보다 흑백
명도차 130 이상이 먼저 깨진다**)은 **`AR-MARKER.md`** 로 이관했다 (2026-08-04 · 문서 무게).

카트에 이미 붙은 AprilTag 36h11 `0·1·2·4`는 WebXR `image-tracking` 대상이 아니다. 2026-09-07
실폰에서 1,473 XR 프레임 동안 0건이었지만 전용 OpenCV 검출기는 저장 프레임 6/6에서 4장을
모두 찾았다. 따라서 재사용 실험은 `getUserMedia` + `js-aruco2` 2.0.0으로 **검출만** 먼저 닫는다.
09-11 실폰 두 실행도 29/30·23/30으로 통과했다. 다음 내부 파라미터는 새 보드가 아니라 같은
태그 배치의 여러 시점 모서리로 풀고 `phone-cam.json`에 분리한다. 글로벌카메라용
`intrinsics.py`/`global-cam.json`은 건드리지 않는다.
실폰 브라우저 영상은 D225에 따라 정사각 픽셀·중앙 주점·왜곡 0의 최소 렌즈모델로 풀고,
전체뿐 아니라 앞/뒤·홀짝 분할에서도 같은 초점값이 나오는지를 게이트로 삼는다.
프레임 자세는 D226에 따라 보이는 3장 이상 태그의 모든 모서리와 평면 호모그래피 하나로 풀고,
RMS 3px·태그면 위 0.1~3m를 통과한 자세에서만 카메라 이동 발자국 고스트를 재투영한다.
태그를 놓친 프레임에는 마지막 자세를 진실처럼 유지하지 않는다.

## 3D — 우리 자산 그대로 쓴다

원본: `FR5UNITY/robotapp/Assets/Runtime/Robots/FAIRINO_FR5/`

| 항목 | 값 |
|---|---|
| URDF | `fairino5_v6.urdf` (SolidWorks 내보내기) |
| 메시 | STL 7개 (base / shoulder / upperarm / forearm / wrist1~3) |
| 관절 | `j1`~`j6`, 전부 revolute |
| 삼각형 | 58,482 |
| 용량 | 12 MB |

```js
const loader = new URDFLoader();
loader.packages = { '': '/assets/FAIRINO_FR5' };
loader.load('/assets/FAIRINO_FR5/fairino5_v6.urdf', robot => {
  robot.rotation.x = -Math.PI / 2;          // ROS는 Z-up, three.js는 Y-up
  robot.setJointValue('j2', -1.0);          // 각도는 라디안
});
```

**STL은 비동기로 늦게 붙는다.** `load` 콜백 시점에는 메시가 아직 0개일 수 있다. 삼각형 수를 세거나 바운딩 박스를 잡는 코드는 콜백 안에서 하면 틀린다.

## 에셋 저작 — 무대 소품은 파일이 아니라 함수다 (2026-08-03 등재 · D51)

**로봇만 메시 파일이고, 무대 소품은 전부 절차적 코드다.** `Shared/view3d/parts.js` 에
three.js 프리미티브로 그리는 함수 18개가 있다 — `bench` `isolator` `shelf` `instrument`
`workstation` `benchRun` `wallCabinet` `safetyFence` `beacon` `crane` `worker` `ammoPallet`.
맵은 `type` 문자열로 이 함수를 고른다.

그래서 **방산 무대 전환은 파일 교체가 아니라 함수 교체**다. `Shared/assets/` 는 안 늘고
`dist` 용량(GAP OPEN)도 안 변한다. 새 소품(컨베이어·탄두·정밀 지그·부품 랙·방폭 격벽)도
같은 자리에 함수로 더한다.

| 도구 | 주소 | 라이선스 | 무엇 | 검증 상태 |
|---|---|---|---|---|
| **img2threejs** | `github.com/img2threejs/img2threejs` | Apache-2.0 | 참조 이미지 → three.js 절차적 모델 코드 생성. Claude Code 스킬로 설치(`~/.claude/skills/`) | **주소·라이선스 확인 2026-08-03. 산출물 실사용 미검증** |

- **런타임 의존성이 아니다.** 저작 시점에만 돌고 산출물은 우리 코드가 된다.
  `package.json` 에 아무것도 안 들어간다 — 기존 "새 의존성 0" 경계를 안 깬다
- **산출물이 TypeScript 다.** 우리 저장소는 순수 JS 라(`*.ts` 0개) **JS 로 옮겨
  `parts.js` 규약에 맞춘 뒤** 커밋한다. 생성 코드를 그대로 붙이지 않는다
- 대안으로 harness 에 `blender-procedural-glb`·`step-to-glb` 스킬도 있다. **그쪽은 GLB 파일을
  낳으므로 용량이 는다** — 지금 무대 소품에는 절차적 코드가 맞다

## 그리퍼 — URDF에 없다. 확장해야 한다

원본: `FR5UNITY/robotapp/Assets/Runtime/EndEffectors/PGEA_100_40/Source/`
사본: `Shared/assets/PGEA_100_40/` (2026-07-29 복사 완료)

**`fairino5_v6.urdf`에는 팔 링크 7개만 있고 그리퍼가 없다.** 웹에서 그리퍼를 보이려면
링크 3개(`gripper_body`, `finger_left`, `finger_right`)와 **prismatic 관절 2개**를 URDF에 덧붙여야 한다.
손가락은 회전이 아니라 **직선으로 벌어진다** — 유니티 쪽 `FR5EndEffectorAttachment.cs`가
`fingerLeftClosed`/`fingerRightClosed`를 `Vector3` 위치로 들고 있는 것이 근거다.

| 파일 | 삼각형 | 용량 | 비고 |
|---|---|---|---|
| `PGEA-100-40_body.stl` | 61,774 | 3.0 MB | **전체의 절반. 1순위 경량화 대상** |
| `PGEA-100-40_finger_left.stl` | 4,164 | 203 KB | |
| `PGEA-100-40_finger_right.stl` | 4,164 | 203 KB | |
| (미복사) `PGEA-100-40.stl` | 29,037 | 7.8 MB | 통합 ASCII. 저폴리지만 손가락이 안 움직임 |

**합계 — 팔 58,482 + 그리퍼 70,102 = 128,584 삼각형 / 6.13 MB.**

경량화는 **삼각형 수를 줄이는 것뿐이다.** STL 3개는 이미 **바이너리**라
(2.9MB ÷ 61,774 = 삼각형당 50바이트, 바이너리 STL의 이론 최소치) 형식 변환으로 줄일 여지가 없다.
순서를 정하면 그리퍼 몸통부터다 — 이것 하나만 줄여도 절반이 준다.

### 단위가 팔과 다르다 — 밀리미터다

2026-07-30 STL 3개를 직접 파싱해 확인. **그냥 붙이면 1000배로 뜬다.**

| | 팔 (`FAIRINO_FR5`) | 그리퍼 (`PGEA_100_40`) |
|---|---|---|
| 단위 | **미터** (`base_link` 149mm → `0.149`) | **밀리미터** (body 79.4 × 132.0 × 29.0) |
| URDF `scale` | 없음 (= 1) | URDF에 아예 없음 |

→ three.js에 붙일 때 `scale.setScalar(0.001)`. 변환 지점은 한 곳뿐이다 (하드 룰 5).

### 세 조각의 상대 위치는 이미 맞다

세 STL이 **같은 조립 좌표계**에 구워져 있다 (min Z가 셋 다 −334~−340mm 부근,
손가락은 X축 대칭: 왼쪽 X −16.9~36.9 / 오른쪽 −36.9~16.9).
→ body와 손가락의 상대 배치를 계산할 필요가 없다. **한 `Group`에 넣으면 조립된다.**

### ~~모르는 것 둘~~ → 둘 다 닫혔다 (2026-08-05 · 외부 대조)

7-30 에 "축 방향"과 "`wrist3_link` → 그리퍼 원점"을 모른다고 적고 육안으로 맞춰
`gripper-mount.json` 에 `verified: true` 로 넣었다. 그 값이 **독립 출처와 소수점까지 맞았다** —
강사 자료(Ch12) 의 `fairino_description` URDF:

| | 우리 (육안 정합 · 7-30) | 강사 URDF (Ch12) |
|---|---|---|
| 메시 Y 오프셋 | −325.64mm | −0.325639m ✅ |
| 회전 X | +90° | 1.5708rad ✅ |
| 메시 스케일 | 0.001 | 0.001 ✅ |
| `wrist3_link` → **플랜지** | (몰랐다) | **+99mm** — 우리 Z 170.98 = 99 + 71.98 로 **역산 일치** |

즉 우리가 눈으로 맞힌 값 안에 99mm 가 이미 들어 있었다.

✅ **플랜지 99mm 는 공식 자산으로 확정됐다 — 실측이 필요 없다** (2026-08-05).
`Shared/assets/FAIRINO_FR5/meshes/wrist3_link.STL` 의 Z 최댓값이 **정확히 0.09900m** 이다.
강사 URDF 의 `xyz="0 0 0.099"` 와 같은 값이고, 출처가 서로 독립이다.

같은 메시를 1mm 씩 썰면 **끝단 5mm(Z 94~99)가 지름 63mm 로 솟은 원형 보스**다 (그 아래는
지름 80). 이게 ISO 공구 플랜지이고, **눈에 보이는 "원형" 은 로봇 자체 부품이지 어댑터가
아니다.** 즉 플랜지와 네모 그리퍼 사이에 스페이서는 없다 → **`positionMm` Z 170.98 유지.**

(강사 URDF 의 `gripper_adapter_link`(r=32mm=지름 64) 는 이 ø63 보스와 지름이 같다 —
그쪽이 로봇 보스를 어댑터로 한 번 더 그린 것으로 보인다. 우리는 따라 그리지 않는다.)

**그래도 URDF를 읽어 삼각함수로 유도하지 않는다** — 육안 정합이 먼저였고 대조가 나중이었기에
이 일치가 의미가 있다.

### ~~3D 그리퍼가 실물보다 22mm 길다~~ → 트림 완료 (2026-08-05)

STL 3개를 파싱해 툴축(메시 +Y) 으로 재면 우리 몸통은 **132.0mm**, 핑거가 거기서 25.0mm
더 나간다. 현장 실측(2026-08-05)은 **네모 몸통 맨 위 → 몸통 끝 110mm · 핑거 25mm ·
합 135mm**(원형 어댑터는 뺀 값).

| 구간 (플랜지 기준) | 우리 메시 | 대환 공식 사양 | 실측 |
|---|---|---|---|
| 네모 몸통 | **132.0** | — | **110** |
| 몸통 끝 → 핑거 끝 | 25.0 | — | 25 ✅ |
| **총 길이** | **157.0** | **118**(브레이크 없음) / **138**(있음) | **135** |
| 폭 | 73.80(조 구간) | 73.8 ✅ | — |
| 두께 | 29.00 | 29 ✅ | — |

폭·두께는 사양서와 자릿수까지 같고 핑거 돌출 25mm 도 실측과 같다 — **같은 제품 계열은
맞다.** 그런데 **우리 메시 총 157mm 는 사양서 118·138 어느 쪽도 아니다.** 몸통 하나에서만
22mm 가 길다. 실측 135 는 브레이크형 138 쪽에 가깝다.

→ 틀린 것은 **메시 자체의 길이**였다. 플랜지 위치(99mm)도 마운트 오프셋(170.98)도 맞다.

**고쳤다 — `scripts/build/gripper-trim.mjs`.** 정점 Y 히스토그램의 구멍(= 옆면이 통으로
지나가는 프리즘 구간)에서만 22mm 를 도려낸다. 균일 Y 스케일은 플랜지 볼트면·조 슬롯까지
눌러서 안 쓴다. 결과 **몸통 110 · 핑거 돌출 25 · 총 135** 로 실측과 일치.
삼각형 수(70102) 도 플랜지 면 Y(−71.98) 도 그대로라 자산 게이트와 `gripper-mount.json`
둘 다 안 건드린다. 검증은 `docs/evidence/2026-08-05/gripper-trim.md` (fr5-web-verify 27/27).

**ponytail — 어느 22mm 가 잉여인지는 모른다.** 유일하게 단면이 일정한 구간에서 도려냈을
뿐이라 길이는 맞고 형상은 근사다. 천장을 걷는 길은 대환 공식 STEP(`PGEA-100-40-W-F` ·
제품 페이지 Download, **개인정보 폼 뒤라 사람이 받아야 한다**)으로 몸통을 통째로 교체하는
것이다. 핑거는 공식에도 없다(고객 부품) — **교체 대상은 몸통 하나.**

### 핑거 길이는 `.env` 한 곳이 정한다 (2026-08-11)

핑거가 고객 부품이라는 사실의 반대편은 **갈아 끼우는 것이 정상**이라는 것이다. 그런데 그
길이에 컨트롤러 툴 Z(135)·조립좌표계 TCP(63.02)·렌즈 높이(80)가 전부 올라타 있고, 전에는
셋이 **각자 상수로 박혀** 있었다 — 하나를 잊으면 카메라가 조용히 어긋난다.

이제 `.env` 의 **`FR5_GRIPPER_FINGER_MM`** 하나가 정본이고 `config.mjs` 가 나머지를 유도한다
(`toolLengthMm = 110 + L` · `tcpYMm = 38.02 + L` · `lensHeightMm = 55 + L`).
STL 과 갈라지면 `scripts/check/assets.sh` 의 길이 대조가 잡는다 — 삼각형 수만으로는
**정점을 옮기기만 한 변형을 원리적으로 못 잡기** 때문에 따로 세운 게이트다.
교체 순서·되돌리기는 `runbook/FINGER-SWAP.md`.

## 뎁스카메라 — RealSense D435 (정본은 `DEPTH-CAM.md`)

그리퍼 **옆·핑거 위**에 외장 브래킷으로 얹고 아래를 본다 — 손끝 위 **80mm**, 툴 축 옆 **82mm**(실측).
기종 확정 근거·장착 기하·화각 실측·Min-Z 표·해상도 운용·유효 비율·USB·딸려 오는 조건은
**`docs/ref/arch/DEPTH-CAM.md`** 로 이관했다 (2026-08-05 · 문서 무게). 결정은 D61·D69.

### 깊이 노브 — 2026-08-11 등재 (**실기 실측** · `pyrealsense2 2.58.3` · S/N 254522075185)

**왜 여기 있나** — 우리는 해상도·fps 말고 **아무것도 안 걸고** 돌고 있었다. 그 사실을 모른 채
"깊이가 안 나온다"를 해상도 탓으로만 읽었다. 아래는 **설치본 introspection + 실기 조회**로
직접 읽은 값이다 (포럼 수치를 옮겨 적지 않았다).

| 노브 | 지금 값 | 범위 | 어디로 | 비고 |
|---|---|---|---|---|
| `rs.option.laser_power` | **150** | 0~360 · step 30 (기본 150) | 깊이 센서 | **여유 210mW** — 정반사·무텍스처에 직접 걸린다 |
| `rs.option.depth_units` | **0.001** (=1mm) | 1e-6~0.01 | 〃 | 0.0001 이면 0.1mm 분해능 · 최대 사거리 6.5m 로 준다 |
| `rs.option.visual_preset` | **0 = `custom`** | 0~5 | 〃 | ⚠ **`default`(1)가 아니라 `custom`(0)이다.** `remove_ir_pattern`(6)은 **범위 밖 = 이 기기 미지원** |
| `rs.option.emitter_enabled` | **1** | 0~2 | 〃 | 0=끔 · 2=always on |
| `disparityShift` | **0** | — | `rs400_advanced_mode.get/set_depth_table()` | **Min-Z 를 낮추는 축.** 표를 무효화한다 — 아래 ⚠ |

`rs400_visual_preset` 이름표: `0 custom · 1 default · 2 hand · 3 high_accuracy · 4 high_density ·
5 medium_density · 6 remove_ir_pattern`.
`STDepthTableControl` 필드: `disparityShift · depthUnits · depthClampMin · depthClampMax · disparityMode`.
현재 depth_table = `disparityShift 0 · depthUnits 1000 · clamp 0~65536 · disparityMode 0`.

**`rs400_advanced_mode` 는 이미 `is_enabled() == True` 다** — `toggle_advanced_mode()` 를 부를
일이 없다. 그래서 *"토글하면 장치가 끊겼다 재연결된다(~5초)"* 는 함정이 **우리에겐 해당 없다**.

⚠ **`DEPTH-CAM.md` §Min-Z 표와 `config.yaml min_z_mm` 은 `disparityShift = 0` 을 전제한다.**
그 전제가 어디에도 안 적혀 있었다 — 누가 shift 를 올리고 표를 그대로 믿으면 **fail-closed 가
조용히 뚫린다**(표는 "195mm 아래는 없는 값"이라는데 실제로는 90mm 도 나온다). shift 를 바꾸면
**표를 실측으로 다시 내기 전까지 그 모드는 못 쓴다.**

## TurtleBot3 겉치수 — 2026-08-07 등재 (사양서 확인 · 줄자 미검증)

실물은 **Burger ×2** 다 (`TB-CONTRACT.md` §하드웨어). 화면이 그리는 발자국은
**간섭·통로·도킹 판정의 입력**이라 장식이 아니다.

| 기종 | Size (L × W × H) | 최고 병진 | 최고 회전 | 무게 |
|---|---|---|---|---|
| **Burger** (우리 것) | **138 × 178 × 192 mm** | 0.22 m/s | 2.84 rad/s (162.72 °/s) | 1 kg |
| Waffle Pi (참고) | 281 × 306 × 141 mm | 0.26 m/s | 1.82 rad/s (104.27 °/s) | 1.8 kg |

출처: ROBOTIS e-Manual `https://emanual.robotis.com/docs/en/platform/turtlebot3/features/`
— 표 값을 그대로 옮겼다. **줄자 실측은 아직 안 했다**(실물이 랩에 있으면 실측이 정본이다).

- `heightMm 192` 는 **라이다 포함 전체**다. 사양서가 그렇게 잰다.
- **LDS-01 자체 치수는 미확인.** 코드가 몸통/라이다를 쪼개는 비율(`LIDAR_H = 40mm`)은
  근거가 없는 편의값이고, 겉면만 사양과 맞춰 뒀다 (`layout-view.js` 의 `ponytail:` 주석).
- `reachMm 380` 은 사양이 아니라 **우리가 정한 작업 반경**이다 — 이 표와 섞지 않는다.

정본 상수: `Shared/data/layout/catalog.js` §`AMR_MM`. **화면에 숫자를 박지 않는다.**

⚠ 등재 전 코드는 `280 × 300 × 190` 을 그렸다 — Waffle Pi 발자국에 Burger 높이를 섞은 값이라
바닥 면적이 실물의 **3.4배**였고, 라이다를 몸통 위에 얹어 전체 높이도 280mm(사양 192)였다.
근거 `evidence/2026-08-07/amr-burger-mm.md`.

## 궤적 — 역기구학(IK) 없이 된다

저장된 이동 지점은 **손끝 위치가 아니라 6축 관절 각도**이고, MoveJ는 그 각도를 직접 보간한다.
따라서 시작 각도 → 끝 각도를 잘게 나눠 각 단계마다 FK를 돌리면 손끝이 지나는 점들이 나온다.

```python
def preview_path(q_from, q_to, steps=100):
    return [forward_kinematics([a + (b - a) * (k / steps)
                                for a, b in zip(q_from, q_to)])
            for k in range(steps + 1)]
```

브라우저에서도 같은 계산이 가능하다 — urdf-loader가 관절 트리를 그대로 들고 있으므로
`setJointValue` 후 `getWorldPosition`을 읽으면 된다. **2026-07-29 실렌더로 검증됨**
(`docs/archive/evidence-2026-07/2026-07-29/urdf-web-render.md`).

이 궤적은 **예상값**이다. 실제 로봇은 가감속과 안전 제한 때문에 다르게 움직인다.
화면에 "예상 경로"라고 표기하고, 실제 지나간 길은 로봇이 보내는 관절값으로 따로 그린다.

## 함정 — 먼저 알고 시작할 것

| 함정 | 증상 | 대응 |
|---|---|---|
| **HTTPS 없이 카메라 안 열림** | 폰에서 `http://192.168.x.x` 접속 시 카메라 요청 자체가 안 뜸 | 코드 짜기 전에 mkcert 또는 터널부터 세운다 |
| **Fairino SDK가 PyPI에 없음** | `pip install fairino` 실패 | 공식 저장소에서 받는다. 최신 파이썬에서 설치가 막히면 pip 패치본 참고 |
| **three.js 빌드가 둘로 쪼개짐** | `three.module.js`만 받으면 `three.core.js` 404 | r185부터 두 파일. CDN 대신 번들러를 쓰면 자동 해결 |
| **마커 떨림** | 겹쳐진 로봇이 덜덜 떨림 | 최근 프레임 평균, 마커 놓쳐도 마지막 위치 유지 |
| **단위 두 번 어긋남** | 로봇이 엉뚱한 자세 | 미터·라디안 ↔ 밀리미터·도 변환을 한 곳에만 둔다 |

## 참고할 남의 코드

| 저장소 | 왜 |
|---|---|
| `FAIR-INNOVATION/fairino-python-sdk` | 공식 파이썬 SDK — 우리 서버의 뒷단 |
| `meowiky/DP-fairino-robot-API` | FR5를 REST로 감싼 최소 예시 |
| `jjh1214/fairino_sim` | 우리와 같은 ROS 2 Jazzy 조합, 코드가 작아 읽기 쉬움 |
| `123CHENJINHUA/rebar-tying` | 카메라·로봇 위치 맞추기 구현이 통째로 있음 |
| `gkjohnson/urdf-loaders` | 우리가 쓰는 로더의 본체와 예제 |

## 맵 편집기 (Dashboard) — 2026-07-30 등재

`/스택가드` 규약대로 **코드에 박기 전에 여기 등재**한다. 아래는 실제 설치본이다.

| 패키지 | 버전 | 왜 |
|---|---|---|
| `react` · `react-dom` | **19.2.8** | 맵 편집 + 지표 비교는 화면이 복잡해지는 시점이다 (D17) |
| `@vitejs/plugin-react` | **5.2.0** | Vite React 플러그인 |
| `vite` | **8.2.0** | AR 과 같은 버전. workspaces 로 묶여 있다 |
| `three` | 0.185.1 | 맵 3D. **R3F 는 쓰지 않는다** — `Shared/view3d/` 를 ref 로 마운트 (D17) |

**안 넣은 것** — 상태관리 · 라우터 · 차트 · UI 프레임워크.
필요해진 뒤에 넣는다. 미리 넣은 의존성은 나중에 빼기 어렵다 (`CONSOLE-REACT.md` §의존성).

**실측 (2026-07-30 골격)** — 빌드 통과. JS **60KB gzip** · CSS 1.9KB.
`ar-threex`(1.6MB)가 **번들에 안 실린다**는 것을 확인했다 — 폴더 분리가 실제로 작동한다.

## FR5 실기 Python SDK — 2026-07-31 등재 (D42 · 현행)

| 항목 | 값 | 검증 상태 |
|---|---|---|
| SDK | `fairino-python-sdk` **v2.2.3_robot3.9.3** (Apache-2.0) — `FR5/bridge/robot_adapter/fairino_sdk/` 벤더링 | 실기 첫 조그 성공 |
| 구현 | **순수 표준 라이브러리** — xmlrpc(20003) 명령 + socket(20004) 실시간 `RobotStatePkg` | 원본 import 전수 확인 |
| 실기 정체 | 모델 `FR5-V1-002(V6.0)` · 웹 `v3.9.7` · 컨트롤러 `V3.9.33-QX` (`GetSoftwareVersion`) | 실측 2026-08-10 `/version` — 프로필 검증값 |
| ⚠ 정체가 바뀐다 | 컨트롤러가 `V3.9.15-QX`(07-31) → `V3.9.33-QX` 로 올라갔는데 **이 표가 08-05~08-10 낡은 채였다.** 그 낡은 값을 근거로 08-10 에 오진했다 — 연결이 안 되면 **먼저 `/version` 을 다시 읽어 이 표와 대조한다** | 2026-08-10 실측 |
| 함정 | xmlrpc 연결 1개·동시성 취약 → 어댑터 단일 잠금. 브리지 밖 병행 접속 금지 | Request-sent 실측 |
| 함정 | `robot_state_pkg` 는 첫 프레임 전엔 **클래스**다 — 인스턴스 확인 후 사용 | 원본 확인 |

## 로봇 안전 설정 API — 2026-08-04 등재 (소스 확인 · 실기 미검증)

**왜 여기 있나** — 우리 안전 게이트(조건 4·5·25)는 컨트롤러가 설정돼 있어야 값을 준다.
공식 매뉴얼 대조에서 그 설정이 전혀 안 돼 있는 것이 드러났다 (`SAFETY-RULES.md` §설정이 전제다).
아래는 벤더링 `Robot.py` 소스에서 직접 읽은 시그니처다. **넣는 것과 되읽는 것을 갈라 적는다.**

| 넣는다 | 인자 의미 | 되읽는다 |
|---|---|---|
| `SetAnticollision(mode, level[6], config)` | mode 0=등급(**1~10, 작을수록 민감**)·1=퍼센트(0~100) · config 1=설정파일 갱신(재부팅 후 유지) | **없음** |
| `SetCollisionStrategy(strategy, safeTime=1000, safeDistance=100, safeVel=250, safetyMargin=[10]*6)` | strategy 0=에러후정지·1=계속·2=에러정지·3=중력토크·4=진동응답·5=리바운드 · time[1000-2000]ms · dist[1-150]mm · vel[50-250]mm/s | **없음** |
| `SetCollisionDetectionMethod(method, thresholdMode)` | method 0=전류·1=이중엔코더·2=둘 다 · thresholdMode 0=등급 고정·1=사용자 정의 | **없음** |
| `SetStaticCollisionOnOff(status)` | 정지 상태에서의 충돌 검출 0=끔·1=켬 | **없음** |
| `SetLoadWeight(loadNum, weight)` | 말단 하중 [kg] | `GetTargetPayload(flag=1)` ✅ |
| `SetLoadCoord(x, y, z, loadNum=0)` | 무게중심 [mm] | `GetTargetPayloadCog(flag=1)` ✅ |
| `SetRobotInstallPos(method)` | 0=바닥·1=측면·2=천장 | **없음** (각도만 `GetRobotInstallAngle`) |
| `SetToolCoord(id[1~15], [x,y,z,rx,ry,rz], type, install, toolID, loadNum)` | 툴 중심점의 플랜지 기준 상대 위치 [mm][°] | `GetCurToolCoord` · `GetToolCoordWithID` ✅ |
| `SetPowerLimit(status, power)` | 출력 상한 [W] — 접촉 충격을 안전 기준 이하로 | **없음** |
| — | — | `GetJointSoftLimitDeg(flag=1)` → 12값 ✅ — **컨트롤러 소프트리밋을 읽어 우리 URDF 한계와 대조** |

⚠ **되읽기가 없는 항목이 절반이다.** 그래서 "설정했다"를 상태로 삼지 않고 **매 ARM 마다
다시 넣고, 넣은 값을 기록**한다 (조건 26). 그리고 소스가 **호출 가능 시점을 문서화하지 않는다** —
서보 ON·모드 조건이 주석에 없다. 실기에서 순서를 확정한다.

✅ `GetJointSoftLimitDeg` — 주석 단위가 mm 로 적혀 모순이었으나 **실기 실측으로 도(°)임을
확정했다** (2026-08-04). 컨트롤러 응답 `[-175,175, -265,85, -160,160, -265,85, -175,175, -175,175]`
가 우리 URDF 값과 j3 만 빼고 정확히 일치 — 우연일 수 없다. **j3 는 컨트롤러가 ±160 으로 더
좁아 우리 게이트를 그쪽에 맞췄다** (우리가 더 넓으면 컨트롤러가 거부할 목표를 통과시킨다).

✅ **`GetCurToolCoord` 실측 `[0, 0, 135, 0, 0, 0]`** (2026-08-04) — `toolCoordId 0` 인데
**Z 오프셋 135mm 가 이미 들어가 있다.** 즉 이 개체의 툴 0 은 "설정 없음" 이 아니라 누군가
그리퍼 길이를 넣어 둔 상태다. 화면 TCP 는 플랜지가 아니라 **그 오프셋이 적용된 값**이다.

**~~정확도 미검증~~ → 실물 실측과 일치한다 (2026-08-05 · 현장 줄자 실측).**
플랜지에서 핑거 끝까지 **총 135mm**, 내역은 몸통 90 + 판 20 + 핑거 25 (전부 툴축 방향 높이).
컨트롤러 툴 Z 와 자릿수까지 같다 — 우연이 아니라 **누군가 같은 것을 재서 넣었다.**

~~⚠ 남은 것은 정확도가 아니라 **기준점**이다~~ → **정했다: 핑거 끝 유지** (2026-08-10 · D108).
파지 중심(≈122.5)은 **잴 수 있는 대상이 아니다** — 얼마나 깊이 무느냐에 따라 달라지므로
툴에 박으면 작업마다 다른 값이 암묵적 오차로 산다. **삽입 깊이는 작업이 명시한다.**
정본은 `contract/VISION-CONTRACT.md` §TCP 는 핑거 끝이다.

**그리퍼 실물 사양 (대환 사양서 · 2026-08-04)** — 무게 **0.6 kg**(브레이크 유무 무관) ·
파지력 15~50N · 스트로크 40mm · 반복정밀도 ±0.02mm · 정격 20W · 24V DC · Modbus RTU(RS485) ·
권장 작업물 1kg. **페이로드 설정의 근거값이다.**

**로봇 사양 (공식 개요)** — 가반하중 5kg · 도달 922mm · 반복정밀도 ±0.03mm ·
**전 관절 최대 속도 180°/s** · TCP 통상 1m/s. → 서보 스트리밍 상한 30°/s 는 **1/6**이고,
컨트롤러 감속 모드 예시(36°/s)보다도 보수적이다.

## 물리 엔진 — MuJoCo WASM · 2026-08-11 등재 (레지스트리 조회 · 브라우저 실측 · 장면 생성이 소비)

`@mujoco/mujoco` **3.11.0** — 딥마인드 공식 WASM 바인딩. 레지스트리 실조회(2026-08-11):
`latest` · 발행 **2026-07-28** · Apache-2.0 · **의존성 0** · repo `google-deepmind/mujoco`.
`exports` 에 `.` 와 **`./mt`(멀티스레드 빌드)** 가 같이 온다 — mt 는 **아직 안 쓴다**.

브라우저 실측(2026-08-08 · 근거·표 전문은 `contract/SIM-CONTRACT.md` §S0):
URDF 7링크를 **MJCF 변환 없이** `from_xml_path` 하나로 읽고, 그리면서 **96대 @60fps**.

- ⚠ **STL 7개를 `mj.FS.writeFile` 로 가상 파일시스템에 먼저 올려야 한다** — 안 올리면 로드 실패
- ⚠ **하드 상한은 fps 가 아니라 메모리다** — `MjData` **148개**에서 `Could not allocate memory`
- ⛔ **로봇에 안 붙는다.** `Sim/` 은 `FR5/bridge` 를 import 하지 않는다 (SIM-CONTRACT 불변식 1)
- **소비처 `Sim/scene/build-scene.mjs`** (2026-08-11 · V2). 게이트 `check/sim-scene.sh`
- ⚠ **핸들은 GC 되지 않는다 — `.delete()` 를 손으로 부른다** (`wasm/README.md` §Memory Management).
  특히 `data.contact` 는 **사본**이라 스텝마다 새 객체가 나고, `qpos` 는 반대로 살아있는 뷰다.
  하드 상한이 메모리라 이걸 빼먹으면 N 을 못 올린다
- ⚠ **`rollout`(다중스레드 배치 실행기)은 WASM 에 없다** — `wasm/` 경로 코드검색 0건.
  파이썬 전용(`python/mujoco/rollout.cc`)이므로 **배치 루프는 우리가 쓴다**
- ⚠ **`from_xml_path` 는 가상 FS 만 본다** — 호스트 경로를 넘기면 `Error opening file` 이다
- **시각화 API 가 바인딩돼 있다** (2026-08-12 · `mujoco.d.ts` 직접 확인, 추측 아님) —
  `mjv_updateScene(m, d, opt, pert, cam, catmask, scn)` 이 `MjvScene.geoms`(`MjvGeomVec`)를 채우고
  각 `MjvGeom` 이 **`type · pos · mat`(행 우선 9) · `size` · `rgba`** 를 준다. `data.contact.get(i).pos`
  로 접촉점도 나온다. `catmask` 는 `mjtCatBit` — **1 정적 · 2 동적 · 4 장식 · 7 전부**.
  ⚠ **`mjr_*`(렌더) 는 없다** — 그리는 것은 우리 몫이라 three.js 로 옮긴다. geom 종류 →
  three.js 매핑은 `zalo/mujoco_wasm` `src/mujocoUtils.js` 를 따른다: **캡슐·상자는 `size` 가 반값**이고
  캡슐·원기둥은 **z 축이 길이 방향**(three 는 y)이다.
  **소비처 `Shared/view3d/sim-scene.js`** (2026-08-12 · 「시뮬레이션이 보는 것」 토글)

## ~~FR5 실기 C# SDK 경로~~ — 폐기 (D41→D42 · 2026-07-31)

**쓰지 않는다.** macOS Mono 에서 xmlrpc 클라이언트가 쓰기마다 예외 → SDK 가 삼켜
가짜 성공/-4 반환 + 컨트롤러 xmlrpc 서비스까지 다운시켰다 (`archive/evidence-2026-07/2026-07-31/fr5-first-motion.md`).
아래 표는 당시 검증 기록으로만 남긴다.

`/스택가드` 규약 — 아래 호출명·시그니처는 추측이 아니라 **실기 readback 에 성공한
Unity `LiveFairinoClient.cs` 원본 대조**다 (archive/evidence-2026-07/2026-07-31/fr5-live-readback.md).

| 항목 | 값 | 검증 상태 |
|---|---|---|
| SDK | `libfairino.dll` C#SDK-V1.2.4 — 관리형 .NET 어셈블리 (네이티브 없음, System.Net.Sockets) | macOS Arm64 실기 readback 통과 |
| dll 위치 | `FR5UNITY/robotapp/Assets/Plugins/Fairino/libfairino.dll` — 저장소에 커밋 안 함, `FAIRINO_DLL` 환경변수로 참조 | `file` 로 확인 |
| 런타임 | **Unity 번들 Mono 6.13** (`…/6000.3.11f1/…/MonoBleedingEdge`) — dll 이 `DefineDynamicAssembly` 등 .NET Framework 전용 API 를 써서 **최신 dotnet 에선 안 돈다** (2026-07-31 실측). 컴파일도 같은 Mono 의 csc.exe (`fairino_cs/build.sh`) | 실기 readback 재통과 |
| 진입 클래스 | `fairino.Robot` — `Activator.CreateInstance` 후 인스턴스 메서드 | Unity 대조 |

| 호출 | 시그니처 (Unity 대조) | 용도 |
|---|---|---|
| `RPC(ip)` / `CloseRPC()` | 문자열 ip / 없음 | 연결·해제 (포트는 8080 고정, SDK 내부) |
| `GetSDKVersion` `GetSoftwareVersion` | out/ref 문자열류 — 리플렉션 후보 매칭 | 버전 |
| `GetRobotRealTimeState(ref ROBOT_STATE_PKG)` | 필드: `jt_cur_pos[6]` `tl_cur_pos[6]` `robot_mode` `mc_queue_len` `EmergencyStop` `collisionState` `rbtEnableState` 등 — **이름 후보 리스트로 읽고 없으면 결측 처리(fail-closed)** | 상태 |
| `GetSafetyCode()` | 반환 int | 안전코드 |
| `Set/GetRobotRealtimeStateSamplePeriod(int ms)` | 33 목표 | 폴링 주기 |
| `RobotEnable((byte)0/1)` | 실패 시 int 재시도 (Unity 폴백 그대로) | 서보 |
| `Mode(int)` 0=auto 1=manual | 쓰기는 0·1 뿐. **읽기값에 2 가 있다 = 드래그 티칭** (실측 2026-08-10 · D106) | 모드 |
| `DragTeachSwitch((byte)0/1)` | | 드래그 티칭 |
| `MoveJ(JointPos, tool, user, vel(f), acc(f), 100f, ExaxisPos, 0f, (byte)0, DescPose)` | 11인자 — `fairino.JointPos/ExaxisPos/DescPose` 생성도 리플렉션 | 조그(작은 delta)·이동 |
| `StopMotion()` | | 정지 |

⚠ **파이썬 `MoveJ` 의 `blendT` 기본값 `-1.0` 은 "운동 완료까지 阻塞(블로킹)" 이다**
(`Robot.py:1090` 원문). 이동이 끝날 때까지 xmlrpc 호출이 안 돌아오므로 **우리 `_guard` 의
3초 상한이 정상 이동을 행으로 오인**해 스레드를 버리고, 버려진 스레드가 연결을 요청 보낸 채
쥐어 이후 전부 `CannotSendRequest`(Request-sent)가 된다. 5° 조그는 3초 안에 끝나 안 보였고,
**33° 이동에서 실기로 재현됐다** (2026-08-05). 그래서 `blendT=0.0`(논블로킹)으로 보낸다 —
완료 판정은 20004 스트림의 `motionQueueLength`·`motionDone` 이 이미 하고 있다.

**실측 추가 (2026-07-31 실기 전수 덤프)** —
- `ROBOT_STATE_PKG` 는 **78필드**. `cmdPointError`·`strangePosFlag`·드래그티칭 필드는 **없다**
  → 드리프트는 `lastServoTarget` 자체 계산(#9 대안), 드래그티칭은 `IsInDragTeach(ref byte)` 메서드
- `GetSoftwareVersion`/`GetFirmwareVersion` 은 code 0 인데 **빈 문자열**을 돌려준다 —
  모델·컨트롤러 문자열 검증은 불가. `GetSDKVersion` 만 "C#SDK-V1.2.4  Web-3.9.3" 반환
- SDK 가 **stdout 에 중국어 로그를 섞는다** — JSON-lines 소비자는 비JSON 줄을 버려야 한다

**오류코드 정본** — `manual.fairino.support` §Error Code (2026-07-31 대조):
`-4 = xmlrpc 인터페이스 실행 실패`(컨트롤러가 거부 — 펜던트 제어권·모드·안전회로 확인) ·
`-3 = xmlrpc 통신 실패` · `-2 = 컨트롤러 통신 이상` · `-1 = 기타`.
Unity `FairinoErrorTranslator` 의 `-4="비상정지"` 매핑은 **공식과 다르다** — 공식이 이긴다.

**서보 스트리밍 (2026-08-03 소스 확인 — 실기 미검증)** — 모방학습·원격조종처럼 목표를
연속으로 흘려보낼 때 쓴다. `MoveJ` 는 점 대 점이라 초당 수십 프레임을 못 받는다.

| 호출 | 시그니처·값 |
|---|---|
| `ServoMoveStart()` / `ServoMoveEnd()` | 스트리밍 구간을 여닫는다. **짝으로 부르지 않으면 다음 명령이 안 먹는다** |
| `ServoJ(joint_pos, axisPos, acc=0, vel=0, cmdT=0.008, filterT=0, gain=0, id=0)` | 관절 목표를 주기적으로 밀어 넣는다. `cmdT` 기본 **8ms**. 내부에서 `GetSafetyCode()` 선검사 |
| `ServoCart(mode, desc_pos, …)` | 직교 좌표판 — 우리는 안 쓴다 (역기구학 범위 밖, PRD) |

⚠ **게이트를 새로 써야 한다** — "한 명령당 5°" 는 점 대 점 전제다. 스트리밍은 각속도(°/s)로
바꿔 판정한다 (`SAFETY-RULES.md` §서보 스트리밍 상한).

**그리퍼 시그니처 (2026-08-03 벤더링 SDK `Robot.py` 소스로 확정 · 같은 날 실기 스모크 통과 — 아래 §스모크 실측)**

실물 펜던트 설정(현장 실측): **제조업체 DAHUAN(대환) · 유형 PGI-140 · D1.0 · 말단 1번 포트**.
펜던트 4필드는 `SetGripperConfig` 인자와 1:1 이다.

| 호출 | 시그니처·값 |
|---|---|
| `SetGripperConfig(company, device, softversion=0, bus=0)` | **company 4=대환 · device 0=PGI-140** (대환의 유일한 선택지). softversion·bus 미사용 |
| `GetGripperConfig()` | → `(err, [number, company, device, softversion])` — **company·device 에 +1 보정돼 돌아온다** (SDK 소스) |
| `ActGripper(index, action)` | action 0=리셋 · 1=활성화 |
| `MoveGripper(index, pos, vel, force, maxtime, block, type, rotNum, rotVel, rotTorque)` | pos/vel/force 0~100% · maxtime 0~30000ms · block 0=블로킹 1=논블로킹 · type 0=평행(PGI-140) 1=회전 · rot* 는 회전형 전용(평행형은 0). 내부에서 `GetSafetyCode()` 선검사 |
| ⚠ `maxtime` 은 **`vel` 과 함께 정한다** | 전체 행정이 최고속 약 1초다. `vel` 을 낮추면 그만큼 오래 걸리는데 `maxtime` 을 그대로 두면 **정상 이동이 상한과 겹쳐 타임아웃한다.** 2026-08-04 실기: `vel 30% + maxtime 3000ms` → 완전 닫기 직후 컨트롤러가 `8/1 Gripper Movement timeout` 을 **래치**했고, 브리지 재시작·재연결로 안 풀려 전원 재투입이 필요했다. 지금 값은 `vel 30% · maxtime 10000ms` |
| `GetGripperMotionDone()` | → `(err, [fault, status])` — status 1=완료 |
| `GetGripperCurPosition()` / `GetGripperActivateStatus()` | 20004 캐시(`gripper_position`·`gripper_fault`·`gripper_active`) 읽기 — xmlrpc 왕복 없음 |

**뚜껑 풀기·조이기의 회전은 그리퍼가 못 한다 (2026-08-03)** — 위 표대로 `type` 0=평행이고
`rotNum`·`rotVel`·`rotTorque` 는 **회전형 전용이라 우리 것은 0** 이다. 즉 뚜껑을 돌리는
회전은 **J6 축이 낸다.** 두 가지가 따라온다 — ①손목 카메라·그리퍼 케이블이 같은 방향으로
감긴다 (`docs/research/vision-imitation.md` §5) ②J6 회전 범위가 풀거나 조일 수 있는 바퀴수의 상한이다.
`force` 는 평행형에서도 살아 있다 — 잡는 힘의 상한이므로 반드시 준다 (`SAFETY-RULES.md` §그리퍼 힘 상한).

**정체 확정 (2026-08-03 실물 라벨 육안 확인)** — 실물은 **PGE A-100-40** 이다. 메시·장착값은
실물과 일치. 펜던트의 "PGI-140"은 SDK 대환 선택지가 그것 하나뿐이라 **빌려 쓰는 것** — 같은
Modbus 프로토콜로 동작한다 (스모크로 실증).

**스모크 실측 (2026-08-03 · 개폐 2회 육안 확인)** — 위 시그니처 전부 실기 통과. 단 주의 둘:
- ~~지령 pos% 와 읽기 pos% 의 방향이 반대다~~ → **자동 모드에서는 곧다** (2026-08-04).
  유니티 실기 기록이 원인을 갖고 있었다 — `before auto mode: 0% → 96 · after auto mode: 0% → 0`.
  8/3 스모크는 수동 모드였고, 브리지 ARM 은 `Mode(0)` 이라 `지령 100 → 읽기 100` 이 나온다.
  **그리퍼 값을 잴 때는 모드를 함께 적는다** — 안 적으면 같은 함정에 다시 빠진다
- ~~`GetGripperMotionDone` 이 이동 직후 `[1, 0]`~~ → **재실측하지 않고 없앴다 (D65).**
  그 xmlrpc 대신 20004 실시간 구조체의 이름 붙은 필드(`gripper_motiondone`·`gripper_fault`·
  `gripper_active`·`gripper_position`)를 읽는다. 이름으로 오는 값은 순서가 섞이지 않는다
