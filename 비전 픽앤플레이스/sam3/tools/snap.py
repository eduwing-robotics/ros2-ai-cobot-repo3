#!/usr/bin/env python3
"""카메라 한 프레임을 색·깊이 같이 저장한다. 로봇은 건드리지 않는다.

검출 설정을 비교할 때 매번 새 프레임을 받으면 장면이 달라져 비교가 안 된다.
그래서 프레임을 고정해 두고 offline 으로 돌린다.

사용법: snap.py [출력이름]      ->  <이름>.npz 와 <이름>.png
"""
import sys, numpy as np, cv2, rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data

out = sys.argv[1] if len(sys.argv) > 1 else "frame"
rclpy.init(); n = Node("snap"); cam = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: cam.update(c=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3)),
    qos_profile_sensor_data)
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw",
    lambda m: cam.update(d=np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)),
    qos_profile_sensor_data)
for _ in range(400):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in cam and "d" in cam: break
if "c" not in cam or "d" not in cam:
    sys.exit("프레임을 못 받았습니다 — 카메라 노드를 확인하세요")
c, d = cam["c"], cam["d"]
np.savez_compressed(f"{out}.npz", color=c, depth=d)
cv2.imwrite(f"{out}.png", c)
v = d[d > 0]
print(f"{out}.npz  색 {c.shape}  깊이 유효 {v.size/d.size*100:.0f}%  중앙 {np.median(v):.0f}mm")
