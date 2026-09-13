#!/usr/bin/env python3
"""카메라를 계속 보며 SAM3 검출 결과가 바뀔 때만 한 줄 출력한다.
물체를 넣고 빼면서 차이를 보는 용도. 로봇은 건드리지 않는다."""
import sys, time, numpy as np, cv2, torch, rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data
from transformers import Sam3Model, Sam3Processor

PROMPTS  = ["bullet", "metal ring"]
TH       = 0.08
MIN_AREA = 300
MAX_AREA = 5000        # 큰 오검출(트레이 전체 등) 배제
ZMIN, ZMAX = 240, 300  # 트레이 깊이 범위. 손(170~220mm)을 걸러낸다
DEDUP    = 15
XMAX     = 430          # 브래킷 배제
PERIOD   = 1.5          # 초

rclpy.init(); n = Node("wd"); cam = {}
n.create_subscription(Image, "/camera/camera/color/image_raw",
    lambda m: cam.update(c=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3)),
    qos_profile_sensor_data)
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw",
    lambda m: cam.update(d=np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)),
    qos_profile_sensor_data)
for _ in range(300):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in cam: break
if "c" not in cam: sys.exit("카메라 프레임 못 받음")

sam  = Sam3Model.from_pretrained("facebook/sam3", dtype=torch.bfloat16).to("cuda").eval()
proc = Sam3Processor.from_pretrained("facebook/sam3")
tins = {q: proc(text=q, return_tensors="pt").to("cuda") for q in PROMPTS}
print("감시 시작 — 검출이 바뀔 때만 출력합니다", flush=True)

def detect(bgr, dep):
    ii = proc(images=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), return_tensors="pt").to("cuda")
    raw = []
    with torch.no_grad():
        ve = sam.get_vision_features(pixel_values=ii.pixel_values)
        for q in PROMPTS:
            o = sam(vision_embeds=ve, **tins[q])
            r = proc.post_process_instance_segmentation(o, threshold=TH, mask_threshold=0.5,
                    target_sizes=ii.get("original_sizes").tolist())[0]
            mm = r["masks"].detach().cpu().numpy().astype(bool)
            if mm.ndim == 4: mm = mm[:, 0]
            sc = r.get("scores")
            sc = sc.detach().float().cpu().numpy() if sc is not None else np.zeros(len(mm))
            for s, mk in zip(sc, mm):
                if not (MIN_AREA <= mk.sum() <= MAX_AREA): continue
                ys, xs = np.nonzero(mk)
                u, v = float(xs.mean()), float(ys.mean())
                if u >= XMAX: continue
                dv = dep[mk] if dep is not None else np.array([])
                dv = dv[~np.isnan(dv)]
                Z = float(np.percentile(dv, 10)) if dv.size >= 10 else float("nan")
                if not np.isnan(Z) and not (ZMIN <= Z <= ZMAX): continue
                raw.append(dict(u=u, v=v, area=int(mk.sum()), Z=Z, s=float(s), q=q))
    kept = []
    for d in sorted(raw, key=lambda x: -x["area"]):
        if not any(((d["u"]-k["u"])**2 + (d["v"]-k["v"])**2)**0.5 <= DEDUP for k in kept):
            kept.append(d)
    return raw, kept

def sig(kept):
    return tuple(sorted((round(d["u"]/10), round(d["v"]/10)) for d in kept))

prev, t_last = None, 0.0
while True:
    rclpy.spin_once(n, timeout_sec=0.05)
    if time.time() - t_last < PERIOD: continue
    t_last = time.time()
    bgr = cam.get("c"); dep = cam.get("d")
    if bgr is None: continue
    dep2 = dep.copy() if dep is not None else None
    if dep2 is not None: dep2[dep2 == 0] = np.nan
    raw, kept = detect(bgr, dep2)
    s = sig(kept)
    if s != prev:
        prev = s
        ts = time.strftime("%H:%M:%S")
        if not kept:
            print(f"[{ts}] 검출 0개 (원시 {len(raw)})", flush=True)
        else:
            items = "  ".join(
                f"({d['u']:.0f},{d['v']:.0f}) {d['q'][:5]} s={d['s']:.2f} a={d['area']}px "
                f"Z={d['Z']:.0f}mm" for d in kept)
            print(f"[{ts}] 검출 {len(kept)}개 (원시 {len(raw)})  {items}", flush=True)
