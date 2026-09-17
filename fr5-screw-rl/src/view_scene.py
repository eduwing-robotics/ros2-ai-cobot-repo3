#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FR5 1대 씬을 티칭 자세로 띄운다 (관찰용).

자세는 `fr5_site.HOME_JOINTS_DEG` — 작업 원점을 티칭한 그 자세다.
중력으로 팔이 무너지지 않게 매 프레임 `mj_forward` 만 부른다(물리 적분은 안 한다).
5대 플릿은 `view_fleet.py`.
"""
import os
import sys

import numpy as np
import mujoco
import mujoco.viewer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

import fr5_site as S                       # noqa: E402
import docs_guard                          # noqa: E402

docs_guard.ensure()   # 치수·설정이 바뀌었으면 문서를 다시 만든다

m = mujoco.MjModel.from_xml_path("fairino5_v6_mjmodel.xml")
d = mujoco.MjData(m)
d.qpos[:6] = np.deg2rad(S.HOME_JOINTS_DEG)      # 티칭 자세
mujoco.mj_forward(m, d)

# ── 카메라 — **상수다. 화면을 옮겼다 꺼도 다음엔 이 값으로 뜬다.** ──────────
# 한때 창을 닫을 때 각도를 파일에 저장했는데, 뷰어를 여러 개 띄우면 마지막에 닫힌
# 창이 덮어써서 구도가 제멋대로 바뀌었다. 그래서 상수로 고정했다. 바꾸려면 여기를.
CAM_LOOKAT    = [-0.2600, -0.6400, 0.0100]
CAM_DISTANCE  = 1.45
CAM_AZIMUTH   = 88.0
CAM_ELEVATION = -14.9

with mujoco.viewer.launch_passive(m, d) as v:
    v.cam.lookat[:] = CAM_LOOKAT
    v.cam.distance, v.cam.azimuth, v.cam.elevation = CAM_DISTANCE, CAM_AZIMUTH, CAM_ELEVATION
    while v.is_running():
        mujoco.mj_forward(m, d)             # 자세 고정 — 중력으로 안 무너지게
        v.sync()

# 닫을 때 그때 각도를 **찍기만** 한다. 마음에 드는 구도가 나오면 이 숫자를 위
# CAM_* 상수에 그대로 옮겨 적으면 된다.
#   ⚠ 파일에 자동 저장하지 않는다. 한때 그렇게 했는데 뷰어를 여러 개 띄우면
#     마지막에 닫힌 창이 덮어써서 구도가 제멋대로 바뀌었다.
print("\n[카메라] 마음에 들면 view_scene.py 의 CAM_* 에 옮겨 적어라:")
print(f"    CAM_LOOKAT    = [{v.cam.lookat[0]:.4f}, {v.cam.lookat[1]:.4f}, {v.cam.lookat[2]:.4f}]")
print(f"    CAM_DISTANCE  = {v.cam.distance:.2f}")
print(f"    CAM_AZIMUTH   = {v.cam.azimuth:.1f}")
print(f"    CAM_ELEVATION = {v.cam.elevation:.1f}")
