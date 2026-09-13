#!/usr/bin/env python3
"""로봇 카메라 프레임에 YOLO 를 여러 방식으로 걸어 어떤 조건에서 잡히는지 찾는다."""
import sys, numpy as np, cv2, rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data
from ultralytics import YOLO

OUT   = "/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"
MODEL = "/home/kimsunil/SAM3/PT/best (1).pt"

rclpy.init(); n = Node("yt2"); cam = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: cam.update(c=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3)),
    qos_profile_sensor_data)
for _ in range(300):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in cam: break
if "c" not in cam: sys.exit("카메라 프레임 못 받음")
bgr = cam["c"]; cv2.imwrite(f"{OUT}/yolo_frame.png", bgr)
print(f"[cam] {bgr.shape[1]}x{bgr.shape[0]}")

m = YOLO(MODEL)

def run(tag, im, **kw):
    r = m.predict(im, conf=0.05, verbose=False, **kw)[0]
    b = r.boxes
    det = ", ".join(f"{m.names[int(b.cls[i])]}:{float(b.conf[i]):.2f}" for i in range(len(b)))
    print(f"  {tag:34s} {im.shape[1]}x{im.shape[0]}  {len(b):2d}개  {det}")
    if len(b):
        cv2.imwrite(f"{OUT}/yolo_{tag.replace(' ','_').replace('/','')}.png", r.plot())
    return len(b)

print("\n=== ① 추론 해상도만 올리기 (원본 프레임) ===")
for sz in (640, 960, 1280, 1600, 2048):
    run(f"imgsz {sz}", bgr, imgsz=sz)

print("\n=== ② 업스케일 후 추론 ===")
for f in (2, 3, 4):
    up = cv2.resize(bgr, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    run(f"{f}배 확대", up, imgsz=1280)

print("\n=== ③ 중앙 크롭 후 확대 ===")
h, w = bgr.shape[:2]
for frac in (0.5, 0.35):
    cw, ch = int(w*frac), int(h*frac)
    x0, y0 = (w-cw)//2, (h-ch)//2
    crop = bgr[y0:y0+ch, x0:x0+cw]
    up = cv2.resize(crop, (640, 480), interpolation=cv2.INTER_CUBIC)
    run(f"중앙 {int(frac*100)}% 크롭→640", up, imgsz=1280)
