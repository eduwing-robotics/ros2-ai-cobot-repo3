#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FR5 5대 플릿 씬을 티칭 자세로 띄운다 (관찰용 — 학습·재생은 안 한다).

`fr5_multi_fleet_control.FleetViewer._build_fleet_xml` 이 만드는 씬을 그대로 쓴다.
로봇마다 자기 책상·받침판·고정대·탄피를 갖는다. 가운데(index 2)가 실물 이식 대상이라
금색이다. 자세는 6대 전부 `fr5_site.HOME_JOINTS_DEG` — 작업 원점을 티칭한 자세다.
"""
import os
import sys

import numpy as np
import mujoco
import mujoco.viewer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

import fr5_site as S                       # noqa: E402
import fr5_multi_fleet_control as F        # noqa: E402
import docs_guard                          # noqa: E402

docs_guard.ensure()   # 치수·설정이 바뀌었으면 문서를 다시 만든다

N = 5
HIGHLIGHT = 2

b = F.FleetViewer.__new__(F.FleetViewer)
b.n_robots, b.highlight_idx = N, HIGHLIGHT
b.base_offsets = F.fleet_offsets(N, HIGHLIGHT)
path = b._build_fleet_xml(F.resolve_mjcf_path())

m = mujoco.MjModel.from_xml_path(path)
d = mujoco.MjData(m)
q = np.deg2rad(S.HOME_JOINTS_DEG)
for i in range(N):                          # 5대 전부 티칭 자세
    a = m.jnt_qposadr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, f"r{i}_j1")]
    d.qpos[a:a + 6] = q
mujoco.mj_forward(m, d)
print(f"씬 {os.path.basename(path)} · 로봇 {N}대 · geom {m.ngeom}개")
print(f"TASK_FRAME_ORIGIN {np.round(F.TASK_FRAME_ORIGIN * 1000, 2)} mm")

# ── 카메라 — **상수다. 화면을 옮겼다 꺼도 다음엔 이 값으로 뜬다.** ──────────
# 사람이 뷰어에서 직접 맞춘 구도다 (2026-09-08). 작업 영역 쪽에서 봐야 그리퍼와
# 탄두·탄피가 로봇 몸통 앞에 온다.
#   ⚠ 한때 창을 닫을 때 각도를 파일에 저장했는데, 뷰어를 여러 개 띄우면 마지막에
#     닫힌 창이 덮어써서 구도가 제멋대로 바뀌었다. 그래서 상수로 고정했다.
#     바꾸려면 여기 숫자를 고쳐라.
CAM_LOOKAT    = [-0.2740, -0.6548, 0.15]
CAM_DISTANCE  = 2.82
CAM_AZIMUTH   = 112.8
CAM_ELEVATION = -28.0

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
print("\n[카메라] 마음에 들면 view_fleet.py 의 CAM_* 에 옮겨 적어라:")
print(f"    CAM_LOOKAT    = [{v.cam.lookat[0]:.4f}, {v.cam.lookat[1]:.4f}, {v.cam.lookat[2]:.4f}]")
print(f"    CAM_DISTANCE  = {v.cam.distance:.2f}")
print(f"    CAM_AZIMUTH   = {v.cam.azimuth:.1f}")
print(f"    CAM_ELEVATION = {v.cam.elevation:.1f}")
