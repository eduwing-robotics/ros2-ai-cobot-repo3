#!/usr/bin/env python3
"""SAM 3로 물체 중심 좌표만 찍는다. 로봇은 건드리지 않는다.

검증 1단계 — 카메라에서 탄두/탄피를 찾아 중심 픽셀과 깊이를 표시한다.
이게 안정적으로 나오는 걸 확인한 뒤에 로봇 제어로 넘어간다.

사전 준비
  ros2 launch realsense2_camera rs_launch.py align_depth.enable:=true

사용법
  python3 sam3_center.py --display          # 실시간 창
  python3 sam3_center.py --once             # 한 프레임만 출력
  python3 sam3_center.py --display --save out.png
"""
import argparse, sys, time
import numpy as np
import cv2
import torch
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image, CameraInfo

TOPIC_COLOR = "/camera/camera/color/image_raw"
TOPIC_DEPTH = "/camera/camera/aligned_depth_to_color/image_raw"
TOPIC_INFO  = "/camera/camera/color/camera_info"

ap = argparse.ArgumentParser()
ap.add_argument("--display", action="store_true", help="실시간 창 (q 로 종료)")
ap.add_argument("--once", action="store_true", help="한 프레임만 처리하고 종료")
ap.add_argument("--save", default=None, help="오버레이 저장 경로")
ap.add_argument("--prompt", default="bullet")
ap.add_argument("--repo", default="facebook/sam3")
ap.add_argument("--threshold", type=float, default=0.4)
ap.add_argument("--pose-aspect", type=float, default=2.2)
ap.add_argument("--center-bright", type=float, default=10.0)
ap.add_argument("--taper-th", type=float, default=0.15)
ap.add_argument("--min-height-mm", type=float, default=1.0)
ap.add_argument("--min-len-mm", type=float, default=12.0,
                help="실제 길이가 이보다 짧으면 버린다. 실측: 실물 15.4~23.1 / 조인트·노이즈 4.0~9.0")
ap.add_argument("--max-len-mm", type=float, default=45.0, help="이보다 길면 버린다")
ap.add_argument("--len-split-mm", type=float, default=20.0,
                help="꽂힌 물체 길이 경계. 실측: 탄두 15.4~18.1 / 탄피 21.9~23.1")
ap.add_argument("--min-area", type=int, default=300,
                help="마스크 픽셀 수 하한. 실측: 실물 579~922 / 오검출 39~163")
ap.add_argument("--ring-px", type=int, default=14)
ap.add_argument("--roi", default=None, help='작업 영역 "x1,y1,x2,y2"')
ap.add_argument("--exclude", action="append", default=None, help='제외 영역 "x1,y1,x2,y2"')
ap.add_argument("--robot-side", default="bottom", choices=["bottom","top","left","right"],
                help="화면에서 로봇 방향. 같은 종류면 가까운 쪽을 1순위로 표시")
a = ap.parse_args()

_roi = tuple(float(v) for v in a.roi.split(",")) if a.roi else None
_ex  = [tuple(float(v) for v in e.split(",")) for e in (a.exclude or [])]

from transformers import Sam3Model, Sam3Processor
t0 = time.time()
model = Sam3Model.from_pretrained(a.repo, dtype=torch.bfloat16).to("cuda").eval()
proc  = Sam3Processor.from_pretrained(a.repo)
prompts = [x.strip() for x in a.prompt.split(",") if x.strip()]
text_in = {q: proc(text=q, return_tensors="pt").to("cuda") for q in prompts}
print(f"[load] SAM3 {time.time()-t0:.1f}s  prompt={prompts}")


def shape_feats(m):
    """(종횡비, 테이퍼, 길이px, 폭px). 길이·폭은 주축 기준이다."""
    ys, xs = np.nonzero(m)
    if ys.size < 30: return 0.0, 0.0, 0.0, 0.0
    pts = np.stack([xs, ys], 1).astype(np.float32); pts -= pts.mean(0)
    _, _, vt = np.linalg.svd(pts, full_matrices=False)
    t, w = pts @ vt[0], pts @ vt[1]
    bins = np.linspace(t.min(), t.max(), 11); wd = []
    for i in range(10):
        s = (t >= bins[i]) & (t < bins[i+1])
        wd.append(w[s].max()-w[s].min() if s.sum() > 3 else 0.0)
    wd = np.array(wd); W = wd.max() if wd.max() > 0 else 1.0
    L = float(t.max()-t.min())
    return float(L/W), float(abs(wd[:3].mean()-wd[-3:].mean())/W), L, float(W)


def center_brightness(m, gray):
    ys, xs = np.nonzero(m)
    if ys.size < 40: return 0.0
    cy, cx = ys.mean(), xs.mean()
    r = np.hypot(ys-cy, xs-cx); rmax = r.max()
    if rmax < 3: return 0.0
    rn = r/rmax; prf = []
    for i in range(5):
        s = (rn >= i/5) & (rn < (i+1)/5)
        prf.append(gray[ys[s], xs[s]].mean() if s.sum() > 5 else np.nan)
    if np.isnan(prf[0]) or np.isnan(prf[2]): return 0.0
    return float(prf[0]-prf[2])


def local_plane_height(m, d, ring_px):
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


def in_region(mk):
    ys, xs = np.nonzero(mk); cx, cy = xs.mean(), ys.mean()
    if _roi and not (_roi[0] <= cx <= _roi[2] and _roi[1] <= cy <= _roi[3]): return False
    return not any(x1 <= cx <= x2 and y1 <= cy <= y2 for x1,y1,x2,y2 in _ex)


def detect(bgr, depth):
    gray = cv2.createCLAHE(2.0,(8,8)).apply(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)).astype(np.float32)
    ii = proc(images=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), return_tensors="pt").to("cuda")
    with torch.no_grad():
        ve = model.get_vision_features(pixel_values=ii.pixel_values)
        masks = []
        for q in prompts:
            o = model(vision_embeds=ve, **text_in[q])
            r = proc.post_process_instance_segmentation(
                o, threshold=a.threshold, mask_threshold=0.5,
                target_sizes=ii.get("original_sizes").tolist())[0]
            mm = r["masks"].detach().cpu().numpy().astype(bool)
            if mm.ndim == 4: mm = mm[:, 0]
            masks.extend(list(mm))
    out = []
    for mk in masks:
        if mk.sum() < a.min_area: continue          # 격자 조각 같은 잔티끌 제거
        if not in_region(mk): continue
        h = local_plane_height(mk, depth, a.ring_px)
        if h is not None and h < a.min_height_mm: continue

        ys, xs = np.nonzero(mk)
        u, v = float(xs.mean()), float(ys.mean())
        uu, vv = int(round(u)), int(round(v))
        win = depth[max(0,vv-3):vv+4, max(0,uu-3):uu+4]
        win = win[~np.isnan(win)]
        Z = float(np.median(win)) if win.size >= 3 else float("nan")

        aspect, taper, Lpx, Wpx = shape_feats(mk)
        # 픽셀 치수를 실제 mm 로. 깊이가 있으면 거리에 무관한 값이 된다.
        Lmm = Lpx * Z / FX if not np.isnan(Z) else float("nan")
        Wmm = Wpx * Z / FX if not np.isnan(Z) else float("nan")
        # 크기가 실물 범위를 벗어나면 물체가 아니다(고정대 조인트 등)
        if not np.isnan(Lmm) and not (a.min_len_mm <= Lmm <= a.max_len_mm): continue

        if aspect < a.pose_aspect:
            pose = "꽂힘"
            # 길이로 먼저 가른다. 탄피가 더 길다. 애매한 구간에서만 명암을 쓴다.
            if not np.isnan(Lmm) and abs(Lmm - a.len_split_mm) >= 1.5:
                kind = "탄피" if Lmm >= a.len_split_mm else "탄두"
            else:
                kind = "탄피" if center_brightness(mk, gray) >= a.center_bright else "탄두"
        else:
            pose = "누움"; kind = "탄두" if taper >= a.taper_th else "탄피"
        out.append(dict(kind=kind, pose=pose, u=u, v=v, Z=Z, height=h, mask=mk,
                        Lmm=Lmm, Wmm=Wmm, area=int(mk.sum())))
    near = {"bottom": lambda d: -d["v"], "top": lambda d: d["v"],
            "left":   lambda d:  d["u"], "right": lambda d: -d["u"]}[a.robot_side]
    out.sort(key=lambda d: (0 if d["kind"] == "탄피" else 1, near(d)))
    return out


rclpy.init(); node = Node("sam3_center"); cam = {}
node.create_subscription(Image, TOPIC_COLOR,
    lambda m: cam.update(color=np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, 3),
                         cseq=cam.get("cseq", 0) + 1), 1)
node.create_subscription(Image, TOPIC_DEPTH,
    lambda m: cam.update(depth=np.frombuffer(m.data, np.uint16).reshape(m.height, m.width)), 1)
node.create_subscription(CameraInfo, TOPIC_INFO,
    lambda m: cam.update(K=np.array(m.k).reshape(3, 3)), 1)

print("카메라 토픽을 기다립니다…")
for _ in range(150):
    rclpy.spin_once(node, timeout_sec=0.1)
    if all(k in cam for k in ("color", "depth", "K")): break
missing = [k for k in ("color", "depth", "K") if k not in cam]
if missing:
    print(f"수신 실패: {missing}\n"
          f"  {TOPIC_COLOR}\n  {TOPIC_DEPTH}\n"
          "  ros2 launch realsense2_camera rs_launch.py align_depth.enable:=true")
    node.destroy_node(); rclpy.shutdown(); sys.exit(1)
FX = float(cam["K"][0, 0])
print(f"[cam ] {cam['color'].shape[1]}x{cam['color'].shape[0]} color / "
      f"{cam['depth'].shape[1]}x{cam['depth'].shape[0]} aligned depth  fx={FX:.1f}")

COL = {("탄두","꽂힘"):(80,80,255), ("탄두","누움"):(255,180,80),
       ("탄피","꽂힘"):(80,255,120), ("탄피","누움"):(80,220,255)}
n = 0
try:
    while True:
        seq = cam.get("cseq", 0)
        for _ in range(60):
            rclpy.spin_once(node, timeout_sec=0.1)
            if cam.get("cseq", 0) != seq: break
        bgr = cv2.cvtColor(cam["color"], cv2.COLOR_RGB2BGR)
        depth = cam["depth"].astype(np.float32).copy(); depth[depth <= 0] = np.nan

        t1 = time.time(); dets = detect(bgr, depth); dt = time.time()-t1
        n += 1

        print(f"\n[{n}] {len(dets)}개  ({dt*1000:.0f}ms)")
        for i, d in enumerate(dets):
            hz = "--" if d["height"] is None else f"{d['height']:5.1f}"
            zz = "--" if np.isnan(d["Z"]) else f"{d['Z']:.0f}"
            lm = "--" if np.isnan(d["Lmm"]) else f"{d['Lmm']:4.1f}"
            wm = "--" if np.isnan(d["Wmm"]) else f"{d['Wmm']:4.1f}"
            print(f"   {i}: {d['kind']}({d['pose']})  중심=({d['u']:6.1f}, {d['v']:6.1f})  "
                  f"깊이={zz}mm  높이={hz}mm  크기={lm}x{wm}mm  면적={d['area']}px")

        vis = bgr.astype(np.float32)
        for d in dets:
            vis[d["mask"]] = vis[d["mask"]]*0.5 + np.array(COL[(d["kind"],d["pose"])], np.float32)*0.5
        vis = vis.clip(0,255).astype(np.uint8)
        for i, d in enumerate(dets):
            c = COL[(d["kind"], d["pose"])]
            u, v = int(d["u"]), int(d["v"])
            cv2.drawMarker(vis, (u, v), c, cv2.MARKER_CROSS, 20, 2)
            cv2.circle(vis, (u, v), 3, (255,255,255), -1)
            zz = "--" if np.isnan(d["Z"]) else f"{d['Z']:.0f}"
            cv2.putText(vis, f"{i} ({u},{v}) {zz}mm", (u+12, v-8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, c, 1, cv2.LINE_AA)
        if _roi:
            cv2.rectangle(vis, (int(_roi[0]),int(_roi[1])), (int(_roi[2]),int(_roi[3])), (120,120,120), 1)
        for x1,y1,x2,y2 in _ex:
            cv2.rectangle(vis, (int(x1),int(y1)), (int(x2),int(y2)), (60,60,200), 1)
        cv2.putText(vis, f"{len(dets)} objects   {1000*dt:.0f}ms", (8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0,255,255), 2)

        if a.save: cv2.imwrite(a.save, vis); print(f"   저장: {a.save}")
        if a.display:
            cv2.imshow("SAM3 center (q: 종료)", vis)
            if cv2.waitKey(1) & 0xFF == ord('q'): break
        if a.once: break
finally:
    if a.display: cv2.destroyAllWindows()
    node.destroy_node()
    if rclpy.ok(): rclpy.shutdown()
