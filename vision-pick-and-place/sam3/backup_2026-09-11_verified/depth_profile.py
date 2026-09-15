# 트레이 평면과 물체 솟음 높이를 실측한다. 로봇은 안 움직인다.
import rclpy, numpy as np, cv2, sys
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data

OUT = "/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"
rclpy.init(); n = Node("dp"); got = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: got.__setitem__("c", np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, -1)),
    qos_profile_sensor_data)
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw",
    lambda m: got.__setitem__("d", np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)),
    qos_profile_sensor_data)
for _ in range(400):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in got and "d" in got: break
if "d" not in got: print("프레임 못 받음"); sys.exit(1)
bgr, d = got["c"], got["d"]
d[d == 0] = np.nan

EX = (430, 0, 640, 480)
roi = np.ones(d.shape, bool); roi[EX[1]:EX[3], EX[0]:EX[2]] = False
ok = roi & ~np.isnan(d)
print(f"유효 화소 {ok.sum()}/{roi.sum()}  ({ok.sum()/roi.sum()*100:.0f}%)")
print("깊이 분위수 (mm)")
for p in (1, 5, 10, 25, 40, 50, 60, 75, 90, 95, 99):
    print(f"   {p:3d}% : {np.percentile(d[ok], p):7.1f}")
lo = int(np.percentile(d[ok], 1) // 2 * 2) - 4
h, e = np.histogram(d[ok], bins=np.arange(lo, lo + 120, 2))
print(f"\n히스토그램 (2mm 구간, 많은 순 12개)")
for i in np.argsort(h)[::-1][:12]:
    print(f"   {e[i]:6.0f}~{e[i+1]:6.0f} mm : {h[i]:6d}")

floor = float(np.percentile(d[ok], 75))
print(f"\n현재 코드 바닥 추정 (75%) = {floor:.1f}mm")
for bump in (4, 6, 8, 10, 15, 20, 25):
    m = (ok & (d < floor - bump)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5,5), np.uint8))
    nl, lab, st, ce = cv2.connectedComponentsWithStats(m, 8)
    big = [i for i in range(1, nl) if st[i, cv2.CC_STAT_AREA] >= 200]
    print(f"\n-- 임계 {floor-bump:.0f}mm (바닥-{bump}mm) : 200px+ 덩어리 {len(big)}개")
    for i in big[:8]:
        w, hh = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        dv = d[lab == i]; dv = dv[~np.isnan(dv)]
        print(f"     pix=({ce[i][0]:5.0f},{ce[i][1]:5.0f}) area={st[i,cv2.CC_STAT_AREA]:5d} "
              f"{w}x{hh} 종횡={max(w,hh)/max(1,min(w,hh)):4.2f} "
              f"Z중앙={np.median(dv):6.1f} Z10%={np.percentile(dv,10):6.1f} 솟음={floor-np.median(dv):5.1f}mm")
cv2.imwrite(f"{OUT}/dp_color.png", bgr)
vis = np.clip((d - np.nanpercentile(d, 1)) / 80 * 255, 0, 255); vis[np.isnan(d)] = 0
cv2.imwrite(f"{OUT}/dp_depth.png", cv2.applyColorMap(vis.astype(np.uint8), cv2.COLORMAP_TURBO))
print(f"\n저장: dp_color.png / dp_depth.png")
