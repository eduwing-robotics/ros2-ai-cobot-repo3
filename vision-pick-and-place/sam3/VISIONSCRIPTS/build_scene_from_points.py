#!/usr/bin/env python3
"""scene_points.json 의 좌표로 MuJoCo 씬을 만든다.

frame 필드
  "mujoco_base" — 좌표가 이미 MuJoCo 베이스 기준. 그대로 쓴다.
  "robot"       — 로봇이 보고한 좌표(공작물 좌표계). transform.npz 의 R,t 로 변환한다.
                  변환은 여러 자세에서 (관절값, 보고 플랜지) 쌍을 모아 fit_frame.py 로 구한다.

원본 ~/fr5_mujoco/fr5.xml 은 건드리지 않는다.
"""
import os, json, sys
import xml.etree.ElementTree as ET
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.expanduser("~/fr5_mujoco/fr5.xml")
DST  = os.path.expanduser("~/fr5_mujoco/fr5_scene.xml")
PTS  = os.path.join(HERE, "scene_points.json")
TF   = os.path.join(HERE, "frame_transform.npz")

pts = json.load(open(PTS, encoding="utf-8"))
frame = pts.get("frame", "mujoco_base")
if frame == "robot":
    if not os.path.exists(TF):
        sys.exit(f"frame='robot' 인데 {TF} 가 없다. fit_frame.py 를 먼저 실행하라.")
    z = np.load(TF); R, t = z["R"], z["t"]
    conv = lambda p: (R @ np.asarray(p, float) + t) / 1000.0
else:
    conv = lambda p: np.asarray(p, float) / 1000.0

def P(key):
    if key not in pts: sys.exit(f"scene_points.json 에 '{key}' 가 없다")
    return conv(pts[key]["xyz"])

tray_h, tray_c, jig = P("tray_head"), P("tray_case"), P("jig")
c1, c2 = P("mat_c1"), P("mat_c2")
mat_c  = (c1 + c2) / 2
mat_hx, mat_hy = abs(c1[0]-c2[0])/2, abs(c1[1]-c2[1])/2
table_z = P("table")[2]
print(f"[좌표계] {frame}{'  (임시값)' if pts.get('_placeholder') else ''}")
print(f"  매트 중심 {(mat_c*1000).round(1)}  크기 {mat_hx*2000:.0f} x {mat_hy*2000:.0f} mm")
print(f"  테이블 면 z = {table_z*1000:.1f} mm")

tree = ET.parse(SRC); root = tree.getroot(); root.set("model", "fairino5_v6_scene")
wb = root.find("worldbody")

def box(name, pos, size, rgba, solid=True):
    ET.SubElement(wb, "geom", dict(name=name, type="box",
        pos=" ".join(f"{v:.4f}" for v in pos), size=" ".join(f"{v:.4f}" for v in size),
        rgba=rgba, contype="1" if solid else "0", conaffinity="1" if solid else "0"))

def obj(name, kind, pos, quat=None):
    b = ET.SubElement(wb, "body", dict(name=name, pos=" ".join(f"{v:.4f}" for v in pos)))
    if quat: b.set("quat", quat)
    ET.SubElement(b, "freejoint", dict(name=name+"_fj"))
    if kind == "casing":
        ET.SubElement(b, "geom", dict(name=name+"_g", type="cylinder", size="0.005 0.015",
                                      rgba="0.72 0.55 0.20 1", mass="0.01",
                                      friction="1.5 0.05 0.0002", condim="4"))
    else:
        ET.SubElement(b, "geom", dict(name=name+"_g", type="capsule", size="0.0045 0.008",
                                      rgba="0.45 0.45 0.48 1", mass="0.008",
                                      friction="1.5 0.05 0.0002", condim="4"))

ET.SubElement(wb, "light", dict(name="work", pos=f"{mat_c[0]} {mat_c[1]} 1.2",
                                dir="0 0 -1", directional="false", diffuse="0.6 0.6 0.6"))
box("mat", (mat_c[0], mat_c[1], table_z+0.0015), (mat_hx, mat_hy, 0.0015), "0.10 0.11 0.10 1")
box("jig", (jig[0], jig[1], table_z+0.010), (0.09, 0.05, 0.010), "0.93 0.92 0.88 1")

for tag, c, kind in (("h", tray_h, "head"), ("c", tray_c, "casing")):
    hx, hy = 0.045, 0.038
    box(f"tray_{tag}_floor", (c[0], c[1], table_z+0.003), (hx, hy, 0.003), "0.95 0.62 0.72 1")
    for j,(dx,dy,sx,sy) in enumerate([(hx,0,0.004,hy),(-hx,0,0.004,hy),(0,hy,hx,0.004),(0,-hy,hx,0.004)]):
        box(f"tray_{tag}_w{j}", (c[0]+dx, c[1]+dy, table_z+0.014), (sx, sy, 0.014), "0.95 0.62 0.72 1")
    for i, dx in enumerate((-0.022, 0.0, 0.022)):
        obj(f"{kind}_st{i}", kind, (c[0]+dx, c[1], table_z+(0.020 if kind=="head" else 0.024)))

LAY = "0.7071 0 0.7071 0"
for i, dx in enumerate((-0.045, 0.010)):
    obj(f"casing_ly{i}", "casing", (jig[0]+dx, jig[1]-0.015, table_z+0.0255), quat=LAY)
for i, dx in enumerate((-0.020, 0.045)):
    obj(f"head_ly{i}", "head", (jig[0]+dx, jig[1]+0.005, table_z+0.0245), quat=LAY)

w3 = next(b for b in root.iter("body") if b.get("name") == "wrist3_link")
ET.SubElement(w3, "camera", dict(name="wrist_cam", pos="0.10 0 0.11", euler="3.14159 0 0", fovy="58"))
ET.SubElement(w3, "geom", dict(name="cam_bracket", type="box", pos="0.055 0 0.11",
                               size="0.040 0.010 0.008", rgba="0.95 0.95 0.95 1",
                               contype="0", conaffinity="0"))
tree.write(DST, encoding="utf-8", xml_declaration=True)
print(f"저장: {DST}")
