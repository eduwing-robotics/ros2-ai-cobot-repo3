#!/usr/bin/env python3
"""현재 프레임에서 SAM3 마스크 전부를 찍고, 어느 필터에서 떨어지는지 본다."""
import numpy as np, cv2, torch, rclpy, sys
from rclpy.node import Node
from sensor_msgs.msg import Image, CameraInfo
from rclpy.qos import qos_profile_sensor_data
from transformers import Sam3Model, Sam3Processor

REPO = "facebook/sam3"
THS  = [0.02, 0.05, 0.10, 0.15, 0.30]

rclpy.init(); n = Node("why"); cam = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: cam.update(color=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3)),
    qos_profile_sensor_data)
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw",
    lambda m: cam.update(depth=np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)),
    qos_profile_sensor_data)
n.create_subscription(CameraInfo, "/camera/camera/color/camera_info",
    lambda m: cam.update(K=np.array(m.k).reshape(3,3)), qos_profile_sensor_data)
for _ in range(300):
    rclpy.spin_once(n, timeout_sec=0.1)
    if all(k in cam for k in ("color","depth","K")): break
if "color" not in cam: sys.exit("카메라 프레임 못 받음")
bgr, dep, FX = cam["color"], cam["depth"], float(cam["K"][0,0])
dep[dep == 0] = np.nan
print(f"[cam] {bgr.shape[1]}x{bgr.shape[0]}  fx={FX:.1f}")

model = Sam3Model.from_pretrained(REPO, dtype=torch.bfloat16).to("cuda").eval()
proc  = Sam3Processor.from_pretrained(REPO)
ii = proc(images=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), return_tensors="pt").to("cuda")
tin = proc(text="bullet", return_tensors="pt").to("cuda")
with torch.no_grad():
    ve = model.get_vision_features(pixel_values=ii.pixel_values)
    o  = model(vision_embeds=ve, **tin)
    for th in THS:
        r = proc.post_process_instance_segmentation(o, threshold=th, mask_threshold=0.5,
                target_sizes=ii.get("original_sizes").tolist())[0]
        mm = r["masks"].detach().cpu().numpy().astype(bool)
        if mm.ndim == 4: mm = mm[:,0]
        sc = r.get("scores")
        sc = sc.detach().float().cpu().numpy() if sc is not None else [None]*len(mm)
        print(f"\n=== threshold {th}  →  마스크 {len(mm)}개 ===")
        for i, mk in enumerate(mm):
            area = int(mk.sum())
            if area == 0: continue
            ys, xs = np.nonzero(mk); cx, cy = xs.mean(), ys.mean()
            dv = dep[mk]; dv = dv[~np.isnan(dv)]
            Z = float(np.median(dv)) if dv.size else float("nan")
            drop = "min_area(300)" if area < 300 else "통과"
            s_ = f"{sc[i]:.3f}" if sc[i] is not None else "?"
            print(f"  #{i} 점수={s_} 면적={area:5d}px 중심=({cx:5.1f},{cy:5.1f}) "
                  f"깊이유효={dv.size:4d} Z={Z:6.1f}mm  → {drop}")
