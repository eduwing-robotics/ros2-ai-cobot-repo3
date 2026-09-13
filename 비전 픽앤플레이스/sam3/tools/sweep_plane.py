#!/usr/bin/env python3
"""저장한 프레임(.npz)에 plane 검출기를 여러 임계로 돌려 비교한다.

프레임을 고정하는 것이 핵심이다 — 매번 새로 받으면 장면이 달라져 비교가 안 된다.
추론은 한 번만 하고 임계만 바꾼다.

사용법: sweep_plane.py scene.npz [프롬프트] [임계들...]
"""
import sys, numpy as np, cv2, torch
from transformers import Sam3Model, Sam3Processor

npz = np.load(sys.argv[1])
bgr, depth = npz["color"], npz["depth"].astype(np.float32)
depth[depth == 0] = np.nan
prompt = sys.argv[2] if len(sys.argv) > 2 else "bullet"
ths = [float(x) for x in sys.argv[3:]] or [0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.05]

FX, RING, PLANE_PCT, MIN_H = 604.5, 14, 85.0, 1.0

def local_plane_height(m, d, ring_px=RING):
    k = np.ones((3,3), np.uint8); mu = m.astype(np.uint8)
    ring = cv2.dilate(mu,k,iterations=ring_px).astype(bool) & ~cv2.dilate(mu,k,iterations=3).astype(bool)
    ys, xs, zz = np.nonzero(ring)[0], np.nonzero(ring)[1], d[ring]
    ok = ~np.isnan(zz); ys, xs, zz = ys[ok], xs[ok], zz[ok]
    if zz.size < 60: return None
    A = np.stack([xs, ys, np.ones_like(xs)], 1).astype(np.float64)
    co, *_ = np.linalg.lstsq(A, zz.astype(np.float64), rcond=None)
    for _ in range(2):
        r_ = zz - A@co; keep = np.abs(r_) < 2.5*max(np.std(r_), 1.0)
        if keep.sum() < 40: break
        co, *_ = np.linalg.lstsq(A[keep], zz[keep].astype(np.float64), rcond=None)
    oy, ox, oz = np.nonzero(m)[0], np.nonzero(m)[1], d[m]
    ok2 = ~np.isnan(oz)
    if ok2.sum() < 15: return None
    oy, ox, oz = oy[ok2], ox[ok2], oz[ok2]
    return float(np.percentile((co[0]*ox+co[1]*oy+co[2])-oz, 97))

dev = "cuda" if torch.cuda.is_available() else "cpu"
proc = Sam3Processor.from_pretrained("facebook/sam3")
mdl = Sam3Model.from_pretrained("facebook/sam3", dtype=torch.bfloat16).to(dev).eval()
ii = proc(images=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), text=prompt, return_tensors="pt").to(dev)
with torch.inference_mode():
    out = mdl(**ii)
sizes = ii.get("original_sizes").tolist()
print(f"프롬프트 '{prompt}'  프레임 {bgr.shape[1]}x{bgr.shape[0]}\n")

for th in ths:
    r = proc.post_process_instance_segmentation(out, threshold=th, mask_threshold=0.5,
                                                target_sizes=sizes)[0]
    mm = r["masks"].detach().cpu().numpy().astype(bool)
    if mm.ndim == 4: mm = mm[:, 0]
    sc = r["scores"].float().cpu().numpy()
    allm = np.zeros(depth.shape, bool)
    for m in mm: allm |= m
    bgpx = depth[~allm & ~np.isnan(depth)]
    plane = float(np.percentile(bgpx, PLANE_PCT)) if bgpx.size > 100 else float(np.nanpercentile(depth, PLANE_PCT))
    rows = []
    for m, s in zip(mm, sc):
        dv = depth[m]; dv = dv[~np.isnan(dv)]
        lp = local_plane_height(m, depth)
        if lp is not None: h, srcn = lp, "국소"
        elif dv.size >= 20: h, srcn = float(np.percentile(plane - dv, 97)), "배경"
        else: continue
        if not np.isnan(h) and h < MIN_H: continue
        ys, xs = np.nonzero(m)
        rows.append((float(xs.mean()), float(ys.mean()), int(m.sum()), h, float(s), srcn))
    rows.sort(key=lambda r: -r[2])
    print(f"임계 {th:<5.2f} 기준면 {plane:.0f}mm  마스크 {len(mm):2d} → 통과 {len(rows):2d}")
    for u, v, ar, h, s, srcn in rows[:12]:
        print(f"    pix=({u:5.0f},{v:5.0f}) 면적{ar:5d} h={h:6.1f}mm 점수{s:.3f} [{srcn}]")
    print()
