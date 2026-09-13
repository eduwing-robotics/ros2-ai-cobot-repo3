#!/usr/bin/env python3
"""현재 프레임에 여러 프롬프트를 걸어 최고 점수를 비교한다."""
import numpy as np, cv2, torch, rclpy, sys
from rclpy.node import Node
from sensor_msgs.msg import Image, CameraInfo
from rclpy.qos import qos_profile_sensor_data
from transformers import Sam3Model, Sam3Processor

REPO = "facebook/sam3"
PROMPTS = ["bullet", "cartridge case", "bullet casing", "shell casing",
           "brass ring", "metal ring", "metal cylinder", "brass tube",
           "ammunition", "circle", "small metal object", "nut"]
TH = 0.02          # 낮게 걸고 점수만 본다

rclpy.init(); n = Node("pr"); cam = {}
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
bgr = cam["color"]; dep = cam["depth"]; dep[dep==0] = np.nan
cv2.imwrite("/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad/prompt_frame.png", bgr)

model = Sam3Model.from_pretrained(REPO, dtype=torch.bfloat16).to("cuda").eval()
proc  = Sam3Processor.from_pretrained(REPO)
ii = proc(images=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), return_tensors="pt").to("cuda")
with torch.no_grad():
    ve = model.get_vision_features(pixel_values=ii.pixel_values)
    print(f"{'프롬프트':<20} {'마스크':>5}  {'최고점수':>8}  중심 / 면적 / Z")
    print("-" * 74)
    rows = []
    for q in PROMPTS:
        tin = proc(text=q, return_tensors="pt").to("cuda")
        o = model(vision_embeds=ve, **tin)
        r = proc.post_process_instance_segmentation(o, threshold=TH, mask_threshold=0.5,
                target_sizes=ii.get("original_sizes").tolist())[0]
        mm = r["masks"].detach().cpu().numpy().astype(bool)
        if mm.ndim == 4: mm = mm[:,0]
        sc = r.get("scores")
        sc = sc.detach().float().cpu().numpy() if sc is not None else np.zeros(len(mm))
        keep = [(s, m) for s, m in zip(sc, mm) if m.sum() >= 300]
        if not keep:
            print(f"{q:<20} {len(mm):>5}  {'-':>8}  (면적 300px 이상 없음)")
            rows.append((0.0, q)); continue
        keep.sort(key=lambda t: -t[0])
        s, mk = keep[0]
        ys, xs = np.nonzero(mk); dv = dep[mk]; dv = dv[~np.isnan(dv)]
        Z = np.median(dv) if dv.size else float("nan")
        print(f"{q:<20} {len(keep):>5}  {s:>8.3f}  ({xs.mean():5.1f},{ys.mean():5.1f}) "
              f"{int(mk.sum()):5d}px  Z={Z:6.1f}mm")
        rows.append((float(s), q))
    rows.sort(reverse=True)
    print("\n점수 순:", ", ".join(f"{q}={s:.3f}" for s, q in rows[:5]))
