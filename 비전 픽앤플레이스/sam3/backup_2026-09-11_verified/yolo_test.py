#!/usr/bin/env python3
"""학습된 YOLO 모델을 로봇 카메라 프레임에 걸어 본다. 로봇은 움직이지 않는다."""
import sys, numpy as np, cv2, rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data
from ultralytics import YOLO

OUT = "/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"
MODEL = "/home/kimsunil/SAM3/PT/best (1).pt"
CONFS = [0.05, 0.15, 0.25, 0.40]

rclpy.init(); n = Node("yt"); cam = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: cam.update(c=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3)),
    qos_profile_sensor_data)
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw",
    lambda m: cam.update(d=np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)),
    qos_profile_sensor_data)
for _ in range(300):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in cam and "d" in cam: break
if "c" not in cam: sys.exit("카메라 프레임 못 받음")
bgr, dep = cam["c"], cam["d"]; dep[dep == 0] = np.nan
cv2.imwrite(f"{OUT}/yolo_frame.png", bgr)
print(f"[cam] {bgr.shape[1]}x{bgr.shape[0]}")

m = YOLO(MODEL)
for conf in CONFS:
    r = m.predict(bgr, conf=conf, verbose=False)[0]
    b = r.boxes
    print(f"\n=== conf {conf}  →  검출 {len(b)}개 ===")
    for i in range(len(b)):
        cls = int(b.cls[i]); sc = float(b.conf[i])
        x1, y1, x2, y2 = (float(v) for v in b.xyxy[i])
        cx, cy = (x1+x2)/2, (y1+y2)/2
        w, h = x2-x1, y2-y1
        win = dep[max(0,int(cy)-4):int(cy)+5, max(0,int(cx)-4):int(cx)+5]
        win = win[~np.isnan(win)]
        Z = float(np.median(win)) if win.size else float("nan")
        print(f"   {m.names[cls]:14s} conf={sc:.3f} 중심=({cx:5.1f},{cy:5.1f}) "
              f"크기={w:.0f}x{h:.0f}px Z={Z:6.1f}mm")
    if len(b):
        vis = r.plot()
        cv2.imwrite(f"{OUT}/yolo_conf{int(conf*100):02d}.png", vis)
