# turtlebot3_burger/burger.glb — 출처와 라이선스

## 라이선스

원본 메시는 **ROBOTIS `turtlebot3` 저장소**의 것이고 **Apache License 2.0** 이다.
재배포·수정이 허용되며 **출처 표기와 라이선스 고지를 유지해야 한다** — 이 파일이 그 고지다.

```
Copyright (c) ROBOTIS Co., Ltd.
Licensed under the Apache License, Version 2.0
https://github.com/ROBOTIS-GIT/turtlebot3   (turtlebot3_description)
http://www.apache.org/licenses/LICENSE-2.0
```

## 원본 4장 → GLB 1장

| 원본 (`turtlebot3_description/meshes/`) | 크기 | 삼각형 |
|---|---|---|
| `bases/burger_base.stl` | 4.83 MB | 96,524 |
| `wheels/left_tire.stl` | 1.08 MB | 21,672 |
| `wheels/right_tire.stl` | 1.08 MB | 21,672 |
| `sensors/lds.stl` | 0.73 MB | 14,566 |
| **합계** | **7.72 MB** | **154,434** |
| → `burger.glb` (노드 4개 · 2026-09-06) | **0.75 MB** | **9,996** |

배치는 `turtlebot3_description/urdf/turtlebot3_burger.urdf` 의 관절 원점에서 읽었다
(`base_link` 는 바닥 +10mm, visual 이 x −32mm, 바퀴 ±80mm, LDS +172mm).

**원본 STL 을 저장소에 넣지 않는다.** 7.72MB 이고 재생성이 1분이다 — 굽는 법이 자산보다 값지다.

## 다시 굽는 법

```bash
# 원본 4장 받기 (저장소에 없다)
B=https://raw.githubusercontent.com/ROBOTIS-GIT/turtlebot3/main/turtlebot3_description
mkdir -p /tmp/tb && for f in bases/burger_base wheels/left_tire wheels/right_tire sensors/lds; do
  curl -sL "$B/meshes/$f.stl" -o "/tmp/tb/$(basename $f).stl"; done

blender -b --factory-startup -P scripts/build/burger-glb.py -- /tmp/tb \
  Shared/assets/turtlebot3_burger/burger.glb 10000
```

## 우리 규약으로 구워 넣은 것

- **원점 = 바닥 중앙**, **정면 = +Z**, 단위 미터 (`parts.js` 머리 규약 그대로)
  ROS 는 Z-up · X-forward 라 Z 축 −90° 를 굽는 단계에서 먹였다
- **부품 4개가 노드 4개다** (2026-09-06 · `GRILL-conveyor-twin` #8) — 루트 `turtlebot3_burger` 아래
  `base` · `wheel_left` · `wheel_right` · `lds`. 전엔 `join()` 으로 한 덩어리(드로우콜 1)였는데 그러면
  **바퀴가 돌 수 없었다.** 축 정렬(Z −90°)·바닥 원점은 **루트의 노드 변환**이고, 자식 로컬은 ROS 프레임이다.
  바퀴 원점은 축 중심(STL 원점과 기하 중심이 0.0mm 차 — 굽는 로그가 적는다)이고 월드 z 33.1 · x ±80.
  바퀴 축은 glTF 로컬 **z**, 앞으로 구르는 부호는 **−** — `Shared/view3d/burger.js` `BURGER_MODEL` 이 검산값을 든다.
  회전은 `rollWheels(mesh, 굴러간 mm)` 하나가 한다 (반지름 33 · `catalog.js` `AMR_WHEEL_R_MM`)
- **재질을 안 실었다** (`export_materials='NONE'`) — 화면이 `mat.amr` 로 덮는다.
  D62(화이트 모형 · 텍스처 없음)를 지키는 방법이 이것이다. GLB 가 자기 색을 들고 오면 규약이 깨진다
- **Draco 를 안 썼다.** 144KB 로 줄지만 `DRACOLoader` + WASM 디코더(~200KB)를 또 받아야 해
  합계로 손해다. gzip 이 전송량을 750 → 217KB 로 줄인다

## 겉치수 — 사양과 얼마나 맞나

| | 폭 | 깊이 | 높이 |
|---|---|---|---|
| 사양 (`STACK.md` §TurtleBot3 겉치수) | 178 | 138 | 192 |
| 이 GLB (실렌더 실측) | 178 | 140 | 191 |

깊이 2mm·높이 1mm 차이는 **감량이 깎은 만큼**이다. 판정 기준(도킹 간격·통로)에 영향이 없는 크기다.

⚠ **감량을 더 하면 실루엣이 더 깎인다.** 꼭짓점을 붙여 7,948까지 줄여 봤더니 높이가
191 → 186mm 로 5mm 빠졌다. 10,000 이 겉치수를 지키는 하한이다.
