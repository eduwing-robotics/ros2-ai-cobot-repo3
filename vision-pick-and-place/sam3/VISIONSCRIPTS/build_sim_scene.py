#!/usr/bin/env python3
"""fr5.xml 에 실물과 비슷한 작업대와 손목 카메라를 얹은 씬을 만든다.

원본 ~/fr5_mujoco/fr5.xml 은 건드리지 않고 새 파일로 쓴다.

실물 구성 (MUJOCO/Screenshot 참고)
  - 로봇 베이스와 작업면이 같은 테이블 위
  - 검정 매트, 분홍 트레이 2개, 흰 지그 블록
  - 트레이에 탄피/탄두가 꽂히고, 지그 위에 눕혀 둔다
  - 카메라는 손목 오른쪽 브래킷에 달려 아래를 본다 (eye-in-hand)
"""
import os, xml.etree.ElementTree as ET
import numpy as np

SRC = os.path.expanduser("~/fr5_mujoco/fr5.xml")
DST = os.path.expanduser("~/fr5_mujoco/fr5_scene.xml")

# 작업 영역 중심. 베이스에서 약 620mm — FR5 리치(922mm) 안쪽이라 자세까지 맞춰 도달 가능
WX, WY = -0.55, -0.22

def box(parent, name, pos, size, rgba, contype=1):
    ET.SubElement(parent, "geom", dict(
        name=name, type="box", pos=" ".join(f"{v:.4f}" for v in pos),
        size=" ".join(f"{v:.4f}" for v in size), rgba=rgba,
        contype=str(contype), conaffinity=str(contype)))

def obj(parent, name, kind, pos, quat=None, rgba="0.72 0.55 0.20 1"):
    """탄피 = 원통(평평한 바닥), 탄두 = 캡슐(한쪽이 둥근 물방울)."""
    b = ET.SubElement(parent, "body", dict(name=name, pos=" ".join(f"{v:.4f}" for v in pos)))
    if quat: b.set("quat", quat)
    ET.SubElement(b, "freejoint", dict(name=name+"_fj"))
    if kind == "casing":     # 탄피: 지름 10mm, 길이 30mm 원통
        ET.SubElement(b, "geom", dict(name=name+"_g", type="cylinder",
            size="0.005 0.015", rgba=rgba, mass="0.01"))
    else:                    # 탄두: 지름 9mm, 길이 22mm 캡슐 (한쪽이 뾰족한 느낌)
        ET.SubElement(b, "geom", dict(name=name+"_g", type="capsule",
            size="0.0045 0.008", rgba="0.45 0.45 0.48 1", mass="0.008"))
    return b

tree = ET.parse(SRC); root = tree.getroot()
root.set("model", "fairino5_v6_scene")
wb = root.find("worldbody")

# ---- 조명 보강 (명암 지표가 조명에 의존하므로 실물처럼 위에서 넓게) ----
ET.SubElement(wb, "light", dict(name="work", pos=f"{WX} {WY} 1.2", dir="0 0 -1",
                                directional="false", diffuse="0.6 0.6 0.6"))

# ---- 작업면 ----
box(wb, "mat",  (WX, WY, 0.0015), (0.28, 0.20, 0.0015), "0.10 0.11 0.10 1")   # 검정 매트
box(wb, "jig",  (WX-0.02, WY-0.13, 0.010), (0.09, 0.05, 0.010), "0.93 0.92 0.88 1")  # 흰 지그

# ---- 분홍 트레이 2개 (바닥 + 벽 4장) ----
for ti, (tx, ty) in enumerate([(WX-0.06, WY+0.10), (WX+0.06, WY+0.10)]):
    hx, hy, wall, floor_h = 0.045, 0.038, 0.004, 0.003
    box(wb, f"tray{ti}_floor", (tx, ty, floor_h), (hx, hy, floor_h), "0.95 0.62 0.72 1")
    for j,(dx,dy,sx,sy) in enumerate([(hx,0,wall,hy),(-hx,0,wall,hy),(0,hy,hx,wall),(0,-hy,hx,wall)]):
        box(wb, f"tray{ti}_w{j}", (tx+dx, ty+dy, 0.014), (sx, sy, 0.014), "0.95 0.62 0.72 1")

# ---- 물체 배치 ----
# 트레이0 = 탄두 꽂힘 3개, 트레이1 = 탄피 꽂힘 3개
for i, dx in enumerate((-0.022, 0.0, 0.022)):
    obj(wb, f"head_st{i}", "head",   (WX-0.06+dx, WY+0.10, 0.020))
for i, dx in enumerate((-0.022, 0.0, 0.022)):
    obj(wb, f"case_st{i}", "casing", (WX+0.06+dx, WY+0.10, 0.024))
# 지그 위에 눕힌 것 (quat: y축 90도 회전 → 눕힘)
LAY = "0.7071 0 0.7071 0"
for i, dx in enumerate((-0.045, 0.010)):
    obj(wb, f"case_ly{i}", "casing", (WX-0.02+dx, WY-0.125, 0.0255), quat=LAY)
for i, dx in enumerate((-0.020, 0.045)):
    obj(wb, f"head_ly{i}", "head",   (WX-0.02+dx, WY-0.105, 0.0245), quat=LAY)

# ---- 손목 카메라 (eye-in-hand) ----
# 실물은 손목 오른쪽 브래킷에 달려 손가락과 같은 방향(아래)을 본다.
# MuJoCo 카메라는 기본이 -Z 방향을 보므로 X축으로 180도 돌려 부모의 +Z 를 보게 한다.
w3 = None
for b in root.iter("body"):
    if b.get("name") == "wrist3_link": w3 = b; break
assert w3 is not None, "wrist3_link 를 찾지 못했다"
# 그리퍼에 가리지 않도록 바깥으로 뺀다. 실물 브래킷도 옆으로 나와 있다.
ET.SubElement(w3, "camera", dict(name="wrist_cam", pos="0.10 0 0.11",
                                 euler="3.14159 0 0", fovy="58"))
# 브래킷 모사 (시각용, 충돌 없음)
# 브래킷은 카메라를 감싸지 않도록 안쪽에만 둔다. 카메라(x=0.055)가 박스 안에 들어가면
# 렌더가 통째로 검게 나온다.
ET.SubElement(w3, "geom", dict(name="cam_bracket", type="box", pos="0.055 0 0.11",
                               size="0.040 0.010 0.008", rgba="0.95 0.95 0.95 1",
                               contype="0", conaffinity="0"))

tree.write(DST, encoding="utf-8", xml_declaration=True)
print(f"저장: {DST}")

import mujoco
m = mujoco.MjModel.from_xml_path(DST)
d = mujoco.MjData(m); mujoco.mj_forward(m, d)
print(f"nq={m.nq} nbody={m.nbody} ncam={m.ncam}")
print("카메라:", [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_CAMERA, i) for i in range(m.ncam)])
