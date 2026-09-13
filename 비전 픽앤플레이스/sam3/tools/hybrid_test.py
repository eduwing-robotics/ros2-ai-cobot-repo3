#!/usr/bin/env python3
"""SAM3 로 위치를 찾고, 그 주변 크롭을 YOLO 에 물어 종류를 판정한다.
YOLO 의 좌표는 쓰지 않고 클래스만 쓴다 — 상자 왜곡이 무관해진다."""
import sys, time, numpy as np, cv2, torch, rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image, CameraInfo
from rclpy.qos import qos_profile_sensor_data
from transformers import Sam3Model, Sam3Processor
from ultralytics import YOLO

OUT   = "/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"
YOLOP = "/home/kimsunil/SAM3/PT/best (1).pt"
PROMPTS = ["bullet", "metal ring"]
TH, MIN_AREA, DEDUP = 0.15, 300, 15
CROPS = [40, 60, 90]          # 크롭 반크기 후보 (px)

rclpy.init(); n = Node("hy"); cam = {}
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
H, W = bgr.shape[:2]

sam = Sam3Model.from_pretrained("facebook/sam3", dtype=torch.bfloat16).to("cuda").eval()
proc = Sam3Processor.from_pretrained("facebook/sam3")
yolo = YOLO(YOLOP)

# --- SAM3 로 위치 찾기 ---
ii = proc(images=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), return_tensors="pt").to("cuda")
dets = []
with torch.no_grad():
    ve = sam.get_vision_features(pixel_values=ii.pixel_values)
    for q in PROMPTS:
        tin = proc(text=q, return_tensors="pt").to("cuda")
        o = sam(vision_embeds=ve, **tin)
        r = proc.post_process_instance_segmentation(o, threshold=TH, mask_threshold=0.5,
                target_sizes=ii.get("original_sizes").tolist())[0]
        mm = r["masks"].detach().cpu().numpy().astype(bool)
        if mm.ndim == 4: mm = mm[:, 0]
        for mk in mm:
            if mk.sum() < MIN_AREA: continue
            ys, xs = np.nonzero(mk)
            if xs.mean() >= 430: continue            # 브래킷 배제
            dv = dep[mk]; dv = dv[~np.isnan(dv)]
            Z = float(np.percentile(dv, 10)) if dv.size >= 10 else float("nan")
            dets.append(dict(u=float(xs.mean()), v=float(ys.mean()),
                             area=int(mk.sum()), Z=Z, src=q))
kept = []
for d in sorted(dets, key=lambda x: -x["area"]):
    if not any(((d["u"]-k["u"])**2 + (d["v"]-k["v"])**2)**0.5 <= DEDUP for k in kept):
        kept.append(d)
print(f"=== SAM3 검출 {len(dets)}개 → 중복 제거 {len(kept)}개 ===")
for d in kept:
    print(f"   ({d['u']:5.1f},{d['v']:5.1f})  area={d['area']:4d}px  Z={d['Z']:6.1f}mm  [{d['src']}]")

# --- 각 위치 주변을 잘라 YOLO 에 종류를 묻는다 ---
print(f"\n=== 크롭 → YOLO 종류 판정 (좌표는 쓰지 않음) ===")
for d in kept:
    cu, cv_ = int(d["u"]), int(d["v"])
    line = f"   ({d['u']:5.1f},{d['v']:5.1f})  Z={d['Z']:5.0f}  "
    for half in CROPS:
        x0, y0 = max(0, cu-half), max(0, cv_-half)
        x1, y1 = min(W, cu+half), min(H, cv_+half)
        crop = bgr[y0:y1, x0:x1]
        if crop.size == 0: continue
        big = cv2.resize(crop, (640, 640), interpolation=cv2.INTER_CUBIC)
        r = yolo.predict(big, conf=0.03, verbose=False)[0]
        b = r.boxes
        if len(b):
            j = int(np.argmax(b.conf.cpu().numpy()))
            line += f"| ±{half}px → {yolo.names[int(b.cls[j])]} {float(b.conf[j]):.2f} "
            cv2.imwrite(f"{OUT}/hy_{cu}_{cv_}_{half}.png", r.plot())
        else:
            line += f"| ±{half}px → 없음 "
    print(line)
