#!/usr/bin/env python
"""SAM 3 + 깊이, 스레드 분리 스트리밍 파이프라인.

기존: 캡처 → 추론 → 그리기 를 한 루프에서 = 화면도 추론 속도(1~3 FPS)로 끊긴다.
변경: 캡처 스레드 / 추론 스레드 / 표시 를 분리.
      화면은 카메라 속도(30 FPS)로 부드럽고, 추론은 제 속도로 돌며 최신 결과만 덮어쓴다.
      장면이 안 바뀌면 추론을 건너뛴다(변화 게이팅).
"""
import argparse, time, threading, os
import numpy as np, cv2, torch
import pyrealsense2 as rs

ap = argparse.ArgumentParser()
ap.add_argument("--prompt", default="bullet")
ap.add_argument("--repo", default="facebook/sam3")
ap.add_argument("--threshold", type=float, default=0.45)
ap.add_argument("--dtype", default="bfloat16")
ap.add_argument("--compile", action="store_true", help="torch.compile 사용(최초 ~60s, 이후 26%% 빠름)")
ap.add_argument("--change-gate", type=float, default=2.0,
                help="직전 추론 프레임과 평균 밝기차가 이 값 미만이면 추론을 건너뛴다. 0이면 항상 추론")
ap.add_argument("--stand-mm", type=float, default=20.0)
ap.add_argument("--split-mm", type=float, default=55.0)
ap.add_argument("--peak-mm", type=float, default=4.0)
ap.add_argument("--taper-th", type=float, default=0.15)
ap.add_argument("--aspect-th", type=float, default=4.3)
ap.add_argument("--plane-mm", type=float, default=0,
               help="테이블까지 거리(mm)를 직접 지정. 0이면 자동 추정")
p.add_argument("--plane-pct", type=float, default=85,
               help="자동 추정 시 배경 깊이의 백분위. 테이블은 가장 먼 면이므로 높게 잡는다")
p.add_argument("--depth-res", default="848x480")
ap.add_argument("--seconds", type=float, default=0)
ap.add_argument("--display", action="store_true")
ap.add_argument("--save-every", type=int, default=0)
ap.add_argument("--out-dir", default="pipe_out")
a = ap.parse_args()

dtype = getattr(torch, a.dtype); dev = "cuda"
from transformers import Sam3Model, Sam3Processor

t0 = time.time()
model = Sam3Model.from_pretrained(a.repo, dtype=dtype).to(dev).eval()
proc  = Sam3Processor.from_pretrained(a.repo)
prompts = [x.strip() for x in a.prompt.split(",") if x.strip()]
text_in = {q: proc(text=q, return_tensors="pt").to(dev) for q in prompts}
# torch.compile은 호출할 스레드 안에서 컴파일해야 한다.
# 메인에서 컴파일해 추론 스레드에서 부르면 세그폴트가 난다.
vis_fn = model.get_vision_features
print(f"[load] {time.time()-t0:.1f}s  prompts={prompts}  compile={a.compile}")

# ---------- 카메라 스레드 ----------
_dw, _dh = (int(v) for v in a.depth_res.lower().split("x"))
pipe = rs.pipeline(); rcfg = rs.config()
# bgr8 = SDK가 센서 원본 YUYV에서 변환한 비압축 경로.
# 이 카메라는 640x480@30에 MJPEG 프로파일 자체가 없어 JPEG을 타지 않는다.
rcfg.enable_stream(rs.stream.color, 640, 480, rs.format.bgr8, 30)
rcfg.enable_stream(rs.stream.depth, _dw, _dh, rs.format.z16, 30)
prof = pipe.start(rcfg)
dscale = prof.get_device().first_depth_sensor().get_depth_scale() * 1000.0
align = rs.align(rs.stream.color)
for _ in range(20): pipe.wait_for_frames()

latest = {"bgr": None, "depth": None, "n": 0}
lock = threading.Lock(); stop = threading.Event()
cam_fps = [0.0]

cam_err = [None]
def cam_loop():
    last = time.time(); ema = 0.0
    while not stop.is_set():
        try: fs = align.process(pipe.wait_for_frames())
        except Exception as e: cam_err[0] = e; break
        cf, df = fs.get_color_frame(), fs.get_depth_frame()
        if not cf or not df: continue
        b = np.asanyarray(cf.get_data()).copy()
        d = np.asanyarray(df.get_data()).astype(np.float32) * dscale
        with lock:
            latest["bgr"], latest["depth"] = b, d
            latest["n"] += 1
        now = time.time(); dt = now - last; last = now
        ema = dt if ema == 0 else ema*0.9 + dt*0.1
        cam_fps[0] = 1.0/max(ema, 1e-6)
    # 루프 종료 = 오류. 메인이 무한 대기하지 않도록 표시한다.
    if cam_err[0] is None: cam_err[0] = RuntimeError("카메라 스레드 종료")

threading.Thread(target=cam_loop, daemon=True).start()
_t0 = time.time()
while latest["bgr"] is None:
    if cam_err[0] is not None: raise SystemExit(f"카메라 오류: {cam_err[0]}")
    if time.time()-_t0 > 10: raise SystemExit("카메라 첫 프레임 10초 내 미수신")
    time.sleep(0.05)
print(f"[cam ] color 640x480 bgr8(비압축) / depth {_dw}x{_dh}  (별도 스레드)")

# ---------- 분류 ----------
def shape_feats(m):
    ys, xs = np.nonzero(m)
    if ys.size < 30: return 0.0, 0.0
    pts = np.stack([xs, ys], 1).astype(np.float32); pts -= pts.mean(0)
    _, _, vt = np.linalg.svd(pts, full_matrices=False)
    t, w = pts @ vt[0], pts @ vt[1]
    bins = np.linspace(t.min(), t.max(), 11); widths = []
    for i in range(10):
        sel = (t >= bins[i]) & (t < bins[i+1])
        widths.append(w[sel].max()-w[sel].min() if sel.sum() > 3 else 0.0)
    widths = np.array(widths); Wmax = widths.max() if widths.max() > 0 else 1.0
    return float((t.max()-t.min())/Wmax), float(abs(widths[:3].mean()-widths[-3:].mean())/Wmax)

def classify(masks, depth):
    allm = np.zeros(depth.shape, bool)
    for m in masks: allm |= m
    d = depth.copy(); d[d <= 0] = np.nan
    bgv = d[~allm & ~np.isnan(d)]
    if a.plane_mm > 0:    plane = float(a.plane_mm)
    elif bgv.size > 100:  plane = float(np.percentile(bgv, a.plane_pct))
    else:                 plane = float(np.nanpercentile(d, a.plane_pct))
    out = []
    for m in masks:
        h = plane - d[m]; h = h[~np.isnan(h)]
        if h.size < 20: out.append(("미분류", m, float('nan'))); continue
        htop = float(np.percentile(h, 97))
        if htop >= a.stand_mm:
            peak = float(np.percentile(h,97) - np.percentile(h,20))
            cls = ("탄피(꽂힘)" if htop >= a.split_mm else "탄두(꽂힘)") if a.split_mm > 0 \
                  else ("탄두(꽂힘)" if peak >= a.peak_mm else "탄피(꽂힘)")
        else:
            aspect, taper = shape_feats(m)
            if taper >= a.taper_th:        says = True
            elif taper <= a.taper_th*0.6:  says = False
            else:                          says = aspect < a.aspect_th
            cls = "탄두(누움)" if says else "탄피(누움)"
        out.append((cls, m, htop))
    return out, plane

# ---------- 추론 스레드 ----------
result = {"dets": [], "plane": 0.0, "ms": 0.0, "n": 0, "skipped": 0}
rlock = threading.Lock()

def infer_loop():
    global vis_fn
    if a.compile:
        print("[compile] 추론 스레드에서 컴파일 중... (최초 1회, 약 60초)", flush=True)
        t_c = time.time()
        fn = torch.compile(model.get_vision_features, mode="max-autotune-no-cudagraphs")
        with lock: warm = latest["bgr"].copy()
        wi = proc(images=cv2.cvtColor(warm, cv2.COLOR_BGR2RGB), return_tensors="pt").to(dev)
        with torch.no_grad(): fn(pixel_values=wi.pixel_values)
        vis_fn = fn
        print(f"[compile] 완료 {time.time()-t_c:.0f}s", flush=True)
    last_gray = None
    while not stop.is_set():
        with lock:
            bgr = None if latest["bgr"] is None else latest["bgr"].copy()
            dep = None if latest["depth"] is None else latest["depth"].copy()
        if bgr is None: time.sleep(0.01); continue
        # 변화 게이팅: 장면이 그대로면 추론을 건너뛴다
        gray = cv2.cvtColor(cv2.resize(bgr,(160,120)), cv2.COLOR_BGR2GRAY).astype(np.float32)
        if a.change_gate > 0 and last_gray is not None:
            if np.abs(gray-last_gray).mean() < a.change_gate:
                with rlock: result["skipped"] += 1
                time.sleep(0.02); continue
        last_gray = gray
        t1 = time.time()
        ii = proc(images=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), return_tensors="pt").to(dev)
        with torch.no_grad():
            ve = vis_fn(pixel_values=ii.pixel_values)
            masks = []
            for q in prompts:
                o = model(vision_embeds=ve, **text_in[q])
                r = proc.post_process_instance_segmentation(
                    o, threshold=a.threshold, mask_threshold=0.5,
                    target_sizes=ii.get("original_sizes").tolist())[0]
                mm = r["masks"].detach().cpu().numpy().astype(bool)
                if mm.ndim == 4: mm = mm[:, 0]
                masks.extend(list(mm))
        dets, plane = classify(masks, dep)
        with rlock:
            result["dets"], result["plane"] = dets, plane
            result["ms"] = (time.time()-t1)*1000; result["n"] += 1

threading.Thread(target=infer_loop, daemon=True).start()

# ---------- 표시 ----------
COL = {"탄두(꽂힘)":(80,80,255), "탄두(누움)":(255,180,80),
       "탄피(꽂힘)":(80,255,120), "탄피(누움)":(80,220,255), "미분류":(180,180,180)}
os.makedirs(a.out_dir, exist_ok=True)
t_start = time.time(); shown = 0; saved = 0; last_shown_n = -1
try:
    while True:
        if a.seconds and time.time()-t_start >= a.seconds: break
        # 카메라에 새 프레임이 올 때만 그린다. 같은 프레임 재도색은 낭비다.
        with lock:
            if latest["n"] == last_shown_n:
                bgr = None
            else:
                bgr = latest["bgr"].copy(); last_shown_n = latest["n"]
        if bgr is None:
            if a.display and (cv2.waitKey(1) & 0xFF) == ord('q'): break
            time.sleep(0.002); continue
        with rlock:
            dets = list(result["dets"]); ims = result["ms"]
            inf_n = result["n"]; skip = result["skipped"]; plane = result["plane"]
        vis = bgr.astype(np.float32); counts = {}
        for cls, m, htop in dets:
            counts[cls] = counts.get(cls, 0) + 1
            vis[m] = vis[m]*0.5 + np.array(COL[cls], dtype=np.float32)*0.5
        vis = vis.clip(0,255).astype(np.uint8)
        shown += 1
        disp_fps = shown/max(time.time()-t_start, 1e-6)
        cv2.putText(vis, f"disp {disp_fps:4.1f} / cam {cam_fps[0]:4.1f} / infer "
                         f"{1000/max(ims,1e-6):4.1f} FPS  plane={plane:.0f}mm",
                    (8,20), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (0,255,255), 2)
        cv2.putText(vis, f"추론 {inf_n}회 / 건너뜀 {skip}회   총 {len(dets)}개",
                    (8,38), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0,255,255), 1)
        for k,(cls,c) in enumerate(sorted(counts.items())):
            cv2.putText(vis, f"{cls}: {c}", (8, 58+k*18),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, COL[cls], 2)
        if a.save_every and shown % a.save_every == 0:
            cv2.imwrite(f"{a.out_dir}/p_{shown:05d}.png", vis); saved += 1
        if a.display:
            cv2.imshow("SAM3 pipeline (q: 종료)", vis)
            if cv2.waitKey(1) & 0xFF == ord('q'): break
        else:
            time.sleep(0.005)
finally:
    stop.set(); time.sleep(0.2); pipe.stop()
    if a.display: cv2.destroyAllWindows()
el = time.time()-t_start
print(f"[run ] 표시 {shown}프레임 {shown/el:.1f} FPS | 추론 {result['n']}회 "
      f"{1000/max(result['ms'],1e-6):.2f} FPS | 건너뜀 {result['skipped']}회 | saved={saved}")
