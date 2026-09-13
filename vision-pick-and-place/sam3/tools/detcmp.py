#!/usr/bin/env python3
"""SAM3 와 깊이 검출을 한 프레임에서 각각 돌려 비교한다. 로봇은 안 움직인다."""
import sys, numpy as np, cv2, torch, rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data
from transformers import Sam3Model, Sam3Processor

TH   = float(sys.argv[1]) if len(sys.argv) > 1 else 0.03
EX   = (430, 0, 640, 480)
FX   = 604.5
O    = "/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"

rclpy.init(); n = Node("dc"); cam = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: cam.update(c=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3)),
    qos_profile_sensor_data)
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw",
    lambda m: cam.update(d=np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)),
    qos_profile_sensor_data)
for _ in range(400):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in cam and "d" in cam: break
bgr, depth = cam["c"], cam["d"].copy()
depth[depth == 0] = np.nan

dev = "cuda" if torch.cuda.is_available() else "cpu"
proc = Sam3Processor.from_pretrained("facebook/sam3")
mdl = Sam3Model.from_pretrained("facebook/sam3", dtype=torch.bfloat16).to(dev).eval()
rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

print(f"=== SAM3 (임계 {TH}) ===")
tot = 0
for pr in ("bullet", "metal ring"):
    inp = proc(images=rgb, text=pr, return_tensors="pt").to(dev)
    with torch.inference_mode():
        out = mdl(**inp)
    r = proc.post_process_instance_segmentation(
        out, threshold=TH, mask_threshold=0.5,
        target_sizes=inp.get("original_sizes").tolist())[0]
    sc = r["scores"].float().cpu().numpy()
    mk = r["masks"].cpu().numpy()
    print(f"  [{pr}] {len(sc)}개")
    for s, m in sorted(zip(sc, mk), key=lambda t: -t[0])[:8]:
        ys, xs = np.nonzero(m)
        if xs.size == 0: continue
        u, v = xs.mean(), ys.mean()
        dv = depth[m.astype(bool)]; dv = dv[~np.isnan(dv)]
        Z = np.median(dv) if dv.size else float("nan")
        flag = " <배제영역>" if u >= EX[0] else ""
        print(f"     점수 {s:.3f}  pix=({u:5.0f},{v:5.0f})  면적 {int(m.sum()):5d}  Z={Z:6.1f}{flag}")
        tot += 1
print(f"  합계 {tot}개")

print("\n=== 깊이 검출 (현재 기본값: 바닥 75%, 솟음 25mm, h상한 45, 종횡 1.6, 면적 300~5000) ===")
roi = np.ones(depth.shape, bool); roi[EX[1]:EX[3], EX[0]:EX[2]] = False
ok = roi & ~np.isnan(depth)
floor = float(np.percentile(depth[ok], 75))
thr = floor - 25
print(f"  바닥 {floor:.0f}mm → 임계 {thr:.0f}mm")
m = (ok & (depth < thr)).astype(np.uint8) * 255
m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
nl, lab, st, ce = cv2.connectedComponentsWithStats(m, 8)
passed = 0
for i in range(1, nl):
    ar = int(st[i, cv2.CC_STAT_AREA])
    w, h = int(st[i, cv2.CC_STAT_WIDTH]), int(st[i, cv2.CC_STAT_HEIGHT])
    asp = max(w, h) / max(1, min(w, h))
    dv = depth[lab == i]; dv = dv[~np.isnan(dv)]
    if dv.size < 5: continue
    Zc = float(np.median(dv)); bump = floor - Zc
    why = []
    if ar < 300: why.append(f"면적{ar}<300")
    if ar > 5000: why.append(f"면적{ar}>5000")
    if asp > 1.6: why.append(f"종횡{asp:.2f}>1.6")
    if bump > 45: why.append(f"솟음{bump:.0f}>45")
    if ar < 100: continue
    tag = "통과" if not why else "탈락: " + ", ".join(why)
    if not why: passed += 1
    print(f"  pix=({ce[i][0]:5.0f},{ce[i][1]:5.0f}) 면적{ar:5d} {w}x{h} 종횡{asp:4.2f} "
          f"Z={Zc:6.1f} 솟음{bump:5.1f}mm  {tag}")
print(f"  통과 {passed}개")
cv2.imwrite(f"{O}/detcmp.png", bgr)
