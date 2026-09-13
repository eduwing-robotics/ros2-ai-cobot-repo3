#!/usr/bin/env python3
"""화면을 겹치는 타일로 나눠 YOLO 를 여러 번 돌려 작은 물체를 찾는다."""
import sys, time, numpy as np, cv2, rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data
from ultralytics import YOLO

OUT   = "/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"
MODEL = "/home/kimsunil/SAM3/PT/best (1).pt"
CONF  = 0.05

rclpy.init(); n = Node("yt3"); cam = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: cam.update(c=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3)),
    qos_profile_sensor_data)
for _ in range(300):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in cam: break
if "c" not in cam: sys.exit("카메라 프레임 못 받음")
bgr = cam["c"]; H, W = bgr.shape[:2]
m = YOLO(MODEL)

def tile_detect(img, tw, th, overlap=0.5, up=640):
    """겹치는 타일로 훑는다. 결과는 원본 좌표로 되돌린다."""
    sx, sy = int(tw*(1-overlap)), int(th*(1-overlap))
    out, ntile = [], 0
    for y0 in range(0, max(1, H-th+1), sy):
        for x0 in range(0, max(1, W-tw+1), sx):
            crop = img[y0:y0+th, x0:x0+tw]
            if crop.shape[0] < 10 or crop.shape[1] < 10: continue
            k = up / crop.shape[1]
            big = cv2.resize(crop, (up, int(crop.shape[0]*k)), interpolation=cv2.INTER_CUBIC)
            r = m.predict(big, conf=CONF, verbose=False)[0]
            ntile += 1
            b = r.boxes
            for i in range(len(b)):
                x1, y1, x2, y2 = (float(v) for v in b.xyxy[i])
                out.append(dict(cls=m.names[int(b.cls[i])], conf=float(b.conf[i]),
                                u=x0 + (x1+x2)/2/k, v=y0 + (y1+y2)/2/k,
                                w=(x2-x1)/k, h=(y2-y1)/k))
    return out, ntile

for tw, th, lbl in ((224, 168, "35%"), (320, 240, "50%"), (160, 120, "25%")):
    t0 = time.time()
    dets, ntile = tile_detect(bgr, tw, th)
    dt = time.time() - t0
    # 중심 15px 안이면 같은 물체로 합치고 conf 큰 것을 남긴다
    kept = []
    for d in sorted(dets, key=lambda x: -x["conf"]):
        if not any(((d["u"]-k["u"])**2 + (d["v"]-k["v"])**2) ** 0.5 <= 15 for k in kept):
            kept.append(d)
    print(f"\n=== 타일 {lbl} ({tw}x{th}, {ntile}회 추론, {dt:.2f}초) "
          f"→ 원시 {len(dets)}개 → 병합 {len(kept)}개 ===")
    for d in sorted(kept, key=lambda x: -x["conf"])[:10]:
        print(f"   {d['cls']:10s} conf={d['conf']:.3f} 중심=({d['u']:5.1f},{d['v']:5.1f}) "
              f"크기={d['w']:.0f}x{d['h']:.0f}px")
