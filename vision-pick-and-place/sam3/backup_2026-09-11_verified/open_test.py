#!/usr/bin/env python3
"""격자 리브를 OPEN 으로 지우고 물체만 남는지 본다. 로봇은 안 움직인다."""
import numpy as np, cv2, rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data
O = "/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"
rclpy.init(); n = Node("ot"); cam = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: cam.update(c=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3)), qos_profile_sensor_data)
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw",
    lambda m: cam.update(d=np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)), qos_profile_sensor_data)
for _ in range(400):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in cam and "d" in cam: break
bgr, d = cam["c"], cam["d"].copy(); d[d == 0] = np.nan
roi = np.ones(d.shape, bool); roi[0:480, 430:640] = False
ok = roi & ~np.isnan(d)
floor = float(np.percentile(d[ok], 75)); thr = floor - 25
raw = (ok & (d < thr)).astype(np.uint8) * 255
print(f"바닥 {floor:.0f}mm  임계 {thr:.0f}mm  솟은 화소 {int(raw.sum()/255)}")
for k in (5, 7, 9, 11):
    m = cv2.morphologyEx(raw, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    nl, lab, st, ce = cv2.connectedComponentsWithStats(m, 8)
    rows = []
    for i in range(1, nl):
        ar = int(st[i, cv2.CC_STAT_AREA])
        if ar < 60: continue
        w, h = int(st[i, cv2.CC_STAT_WIDTH]), int(st[i, cv2.CC_STAT_HEIGHT])
        dv = d[lab == i]; dv = dv[~np.isnan(dv)]
        if dv.size < 5: continue
        rows.append((ce[i][0], ce[i][1], ar, w, h, max(w,h)/max(1,min(w,h)),
                     float(np.median(dv)), floor - float(np.median(dv))))
    print(f"\n-- OPEN {k}x{k} : 60px+ 덩어리 {len(rows)}개")
    for u, v, ar, w, h, asp, Z, bump in sorted(rows, key=lambda r: -r[2])[:10]:
        print(f"     pix=({u:5.0f},{v:5.0f}) 면적{ar:5d} {w}x{h} 종횡{asp:4.2f} Z={Z:6.1f} 솟음{bump:5.1f}mm")
    cv2.imwrite(f"{O}/open_{k}.png", m)
