#!/usr/bin/env python
"""SAM 3 + RealSense 깊이 융합.
RGB에서 형태 기반 프롬프트로 물체를 찾고, 각 마스크의 깊이 프로파일로 분류한다.
색·조명에 무관하며, 위에서 내려다볼 때 잃어버리는 높이 정보를 깊이로 복원한다."""
import argparse, time, os, collections, json
import numpy as np, cv2, torch
import pyrealsense2 as rs

p = argparse.ArgumentParser()
p.add_argument("--prompt", default="bullet", help="전체 물체를 잡는 형태 기반 프롬프트")
p.add_argument("--repo", default="facebook/sam3")
p.add_argument("--threshold", type=float, default=0.5)
p.add_argument("--image-size", type=int, default=0)
p.add_argument("--dtype", default="bfloat16")
p.add_argument("--stand-mm", type=float, default=20.0,
               help="이 높이 이상이면 '세워짐/꽂힘'으로 본다")
p.add_argument("--peak-mm", type=float, default=4.0,
               help="윗면 기복이 이 이상이면 원뿔(탄두). 실측: 탄피 2.0~3.0mm / 탄두 5.0~12.0mm")
p.add_argument("--display", action="store_true")
p.add_argument("--center-x", type=int, default=-1,
               help="정렬 기준 x 픽셀. -1 이면 화면 가로 중앙")
p.add_argument("--center-y", type=int, default=-1,
               help="정렬 기준 y 픽셀. -1 이면 화면 세로 중앙")
p.add_argument("--split-y", type=int, default=185,
               help="종류를 가르는 화면 가로선의 y 픽셀. -1 이면 화면 세로 중앙. 09-12 실측 기본값 185 — 트레이 두 줄 사이 빈 틈의 중앙이다 (위 줄 아래 테두리 ~170, 아래 줄 위 테두리 ~200). "
                    "선 아래(카메라·로봇에 가까운 쪽)를 탄피, 위를 탄두로 본다. "
                    "밝기 판정은 금속 반사에 흔들려 탄두를 탄피로 잡는 일이 많았다 — "
                    "물체를 줄로 나눠 놓는다면 이 규칙이 훨씬 안정적이다")
p.add_argument("--with-lying", dest="standing_only", action="store_false", default=True,
               help="누운 물체도 표시한다. 기본은 꽂힌 물체만 본다")
p.add_argument("--tol-px", type=float, default=4.0,
               help="허용 오차 원의 반지름 px. sam3_pick_ros2.py 의 --tol-px 와 같은 값을 쓴다")
p.add_argument("--no-center-mark", dest="center_mark", action="store_false", default=True,
               help="중심 십자·허용 원을 그리지 않는다")
p.add_argument("--max-frames", type=int, default=0)
p.add_argument("--save-every", type=int, default=0)
p.add_argument("--out-dir", default="depth_out")
p.add_argument("--dump", action="store_true", help="객체별 깊이 특징값 출력")
p.add_argument("--pose", action="store_true",
               help="집기용 3D 위치(카메라 좌표 mm)와 접근 방향을 출력")
p.add_argument("--pose-json", default=None,
               help="집기 정보를 이 경로에 JSON으로 매 프레임 덮어쓴다")
p.add_argument("--min-height-mm", type=float, default=1.0,
               help="주변 평면보다 이만큼도 안 솟으면 물체로 보지 않는다. "
                    "설비·고정대처럼 면에 파묻힌 구조물을 거른다. 실측: 조인트 -9mm / 실물 4~25mm")
p.add_argument("--min-area", type=int, default=0, help="마스크 픽셀 수 하한")
p.add_argument("--max-area", type=int, default=0, help="마스크 픽셀 수 상한(0=무제한)")
p.add_argument("--exclude", action="append", default=None,
               help='제외 영역 "x1,y1,x2,y2". 여러 번 지정 가능. 고정 설비를 빼는 데 쓴다')
p.add_argument("--roi", default=None,
               help='작업 영역 "x1,y1,x2,y2". 중심이 이 밖이면 버린다')
p.add_argument("--pose-aspect", type=float, default=2.2,
               help="자세 판정: 종횡비가 이 미만이면 꽂힘/세워짐(위에서 원형), 이상이면 누움. "
                    "실측: 꽂힘 1.11~1.73 / 누움 2.78~5.34")
p.add_argument("--center-bright", type=float, default=10.0,
               help="꽂힌 물체 판정: 윗면 중심이 중간링보다 이만큼 밝으면 탄피(평평한 뇌관), "
                    "아니면 탄두(둥근 돔). 실측: 탄두 -15.5~-6.1 / 탄피 +27.6~+28.2")
p.add_argument("--taper-th", type=float, default=0.15,
               help="누운 물체의 형태 비대칭 기준. 한쪽만 뾰족한 물방울(탄두)이면 크다. "
                    "실측: 탄두 0.20~0.21 / 탄피 0.06~0.11")
p.add_argument("--aspect-th", type=float, default=4.3,
               help="누운 물체 종횡비 보조 기준. 실측: 탄두 3.7 / 탄피 4.8~5.3")
p.add_argument("--split-mm", type=float, default=55.0,
               help="꽂힌 물체를 높이로 가르는 경계. 이보다 높으면 탄피(길다), 낮으면 탄두. "
                    "0이면 사용 안 하고 윗면 기복만으로 판정. 실측: 탄두 39~47 / 탄피 63~65mm")
p.add_argument("--local-plane", action="store_true", default=True,
               help="물체 주변 링에 평면을 맞춰 높이를 잰다(기본). 카메라 기울기·배경에 무관")
p.add_argument("--global-plane", dest="local_plane", action="store_false",
               help="예전 방식: 배경 전체에서 단일 기준면을 잡는다")
p.add_argument("--ring-px", type=int, default=14, help="국소 평면을 맞출 주변 링 두께")
p.add_argument("--plane-mm", type=float, default=0,
               help="테이블까지 거리(mm)를 직접 지정. 0이면 자동 추정")
p.add_argument("--plane-pct", type=float, default=85,
               help="자동 추정 시 배경 깊이의 백분위. 테이블은 가장 먼 면이므로 높게 잡는다")
p.add_argument("--depth-res", default="848x480",
               help="깊이 해상도. 848x480이 최소측정거리가 짧아(~20cm) 근접 촬영에 안전하다. 1280x720은 ~28cm 이하에서 깊이가 비어버린다")
p.add_argument("--smooth", action="store_true",
               help="spatial/hole-filling 필터 사용. 작은 봉우리를 뭉개므로 기본은 끔")
a = p.parse_args()

dtype = getattr(torch, a.dtype)
dev = "cuda"
from transformers import Sam3Model, Sam3Processor, Sam3Config
t0 = time.time()
cfg = Sam3Config.from_pretrained(a.repo)
if a.image_size: cfg.image_size = a.image_size
model = Sam3Model.from_pretrained(a.repo, config=cfg, dtype=dtype).to(dev).eval()
proc = (Sam3Processor.from_pretrained(a.repo, size={"height":a.image_size,"width":a.image_size})
        if a.image_size else Sam3Processor.from_pretrained(a.repo))
prompts = [x.strip() for x in a.prompt.split(",") if x.strip()]
_ex = [tuple(float(v) for v in e.split(",")) for e in (a.exclude or [])]
_roi = tuple(float(v) for v in a.roi.split(",")) if a.roi else None

def rejected_by_region(mk):
    ys, xs = np.nonzero(mk); cx, cy = xs.mean(), ys.mean()
    if _roi and not (_roi[0] <= cx <= _roi[2] and _roi[1] <= cy <= _roi[3]): return True
    return any(x1 <= cx <= x2 and y1 <= cy <= y2 for x1, y1, x2, y2 in _ex)
text_in = {q: proc(text=q, return_tensors="pt").to(dev) for q in prompts}
print(f"[load] {time.time()-t0:.1f}s  prompts={prompts}")

def local_plane_height(m, d, ring_px=14):
    """물체 마스크 주변 링에 평면 z=ax+by+c 를 맞추고 마스크 안의 평면 위 높이를 구한다.
    전역 기준면과 달리 카메라가 기울어도, 물체가 트레이·수납함 등 어떤 면 위에 있어도 맞다.
    반환: (최고높이, 중앙높이, 윗면기복, 평면깊이중앙) 단위 mm"""
    k = np.ones((3,3), np.uint8); mu = m.astype(np.uint8)
    ring = cv2.dilate(mu, k, iterations=ring_px).astype(bool) & ~cv2.dilate(mu, k, iterations=3).astype(bool)
    ys, xs, zz = np.nonzero(ring)[0], np.nonzero(ring)[1], d[ring]
    ok = ~np.isnan(zz); ys, xs, zz = ys[ok], xs[ok], zz[ok]
    if zz.size < 60: return None
    A = np.stack([xs, ys, np.ones_like(xs)], 1).astype(np.float64)
    coef, *_ = np.linalg.lstsq(A, zz.astype(np.float64), rcond=None)
    for _ in range(2):                       # 이상치(트레이 벽 등) 제거 후 재적합
        r_ = zz - A @ coef
        keep = np.abs(r_) < 2.5*max(np.std(r_), 1.0)
        if keep.sum() < 40: break
        coef, *_ = np.linalg.lstsq(A[keep], zz[keep].astype(np.float64), rcond=None)
    oy, ox, oz = np.nonzero(m)[0], np.nonzero(m)[1], d[m]
    ok2 = ~np.isnan(oz)
    if ok2.sum() < 15: return None
    oy, ox, oz = oy[ok2], ox[ok2], oz[ok2]
    h = (coef[0]*ox + coef[1]*oy + coef[2]) - oz     # 평면보다 가까우면 양수 = 솟음
    return (float(np.percentile(h,97)), float(np.median(h)),
            float(np.percentile(h,97)-np.percentile(h,20)),
            float(np.median(coef[0]*ox + coef[1]*oy + coef[2])))


def grasp_info(m, depth_mm, plane_mm, standing):
    """마스크에서 집기 정보를 뽑는다.
    - pos: 카메라 좌표 (X,Y,Z) mm. Z는 카메라→물체 거리
    - yaw: 물체 주축 각도(도). 누운 물체는 이 축에 직각으로 잡는다
    - approach: 접근 방식
    """
    ys, xs = np.nonzero(m)
    d = depth_mm[m]
    d = d[~np.isnan(d)]
    if d.size < 10: return None
    # 꽂힌 물체는 윗면(가장 가까운 쪽), 누운 물체는 중앙값 깊이를 잡는다
    Z = float(np.percentile(d, 10) if standing else np.median(d))
    u, v = float(xs.mean()), float(ys.mean())
    X = (u - INTR.ppx) / INTR.fx * Z
    Y = (v - INTR.ppy) / INTR.fy * Z
    pts = np.stack([xs, ys], 1).astype(np.float32); pts -= pts.mean(0)
    _, _, vt = np.linalg.svd(pts, full_matrices=False)
    yaw = float(np.degrees(np.arctan2(vt[0][1], vt[0][0])))
    if yaw > 90: yaw -= 180
    if yaw < -90: yaw += 180
    return dict(pos_mm=[round(X,1), round(Y,1), round(Z,1)],
                yaw_deg=None if standing else round(yaw,1),
                height_mm=round(plane_mm - Z, 1),
                approach="vertical" if standing else "perpendicular_to_axis")


def center_brightness(m, gray):
    """마스크 중심에서 반경별 평균 밝기를 재고 (중심링 - 중간링)을 돌려준다.
    평평하고 광택 있는 탄피 바닥은 빛을 되쏘아 중심이 밝고,
    둥근 탄두 끝은 빛을 흩어 중심이 어둡다. 물체 내부 상대값이라 재질 색에 덜 민감하다."""
    ys, xs = np.nonzero(m)
    if ys.size < 40: return 0.0
    cy, cx = ys.mean(), xs.mean()
    r = np.hypot(ys-cy, xs-cx); rmax = r.max()
    if rmax < 3: return 0.0
    rn = r/rmax; prof = []
    for i in range(5):
        sel = (rn >= i/5) & (rn < (i+1)/5)
        prof.append(gray[ys[sel], xs[sel]].mean() if sel.sum() > 5 else np.nan)
    if np.isnan(prof[0]) or np.isnan(prof[2]): return 0.0
    return float(prof[0] - prof[2])


def shape_feats(m):
    """마스크 주축을 따라 폭 변화를 재서 (종횡비, 테이퍼)를 구한다.
    탄두를 눕히면 한쪽은 둥글고 반대쪽은 뾰족한 물방울이라 테이퍼가 크다.
    탄피는 폭이 일정한 원통이라 테이퍼가 0에 가깝다."""
    ys, xs = np.nonzero(m)
    if ys.size < 30: return 0.0, 0.0
    pts = np.stack([xs, ys], 1).astype(np.float32); pts -= pts.mean(0)
    _, _, vt = np.linalg.svd(pts, full_matrices=False)
    t, w = pts @ vt[0], pts @ vt[1]
    bins = np.linspace(t.min(), t.max(), 11)
    widths = []
    for i in range(10):
        sel = (t >= bins[i]) & (t < bins[i+1])
        widths.append(w[sel].max() - w[sel].min() if sel.sum() > 3 else 0.0)
    widths = np.array(widths)
    Wmax = widths.max() if widths.max() > 0 else 1.0
    taper = abs(widths[:3].mean() - widths[-3:].mean()) / Wmax
    return float((t.max()-t.min()) / Wmax), float(taper)


pipe = rs.pipeline(); rcfg = rs.config()
rcfg.enable_stream(rs.stream.color, 640, 480, rs.format.bgr8, 30)
_dw, _dh = (int(v) for v in a.depth_res.lower().split("x"))
rcfg.enable_stream(rs.stream.depth, _dw, _dh, rs.format.z16, 30)
prof = pipe.start(rcfg)
depth_scale_mm = prof.get_device().first_depth_sensor().get_depth_scale() * 1000.0
align = rs.align(rs.stream.color)
_cprof = prof.get_stream(rs.stream.color).as_video_stream_profile()
INTR = _cprof.get_intrinsics()      # fx, fy, ppx, ppy — 픽셀→3D 역투영에 쓴다
spatial = rs.spatial_filter(); hole = rs.hole_filling_filter()   # --smooth 일 때만 적용
for _ in range(20): pipe.wait_for_frames()
print(f"[rs  ] depth {_dw}x{_dh}  scale {depth_scale_mm:.3f} mm/unit  smooth={a.smooth}")

os.makedirs(a.out_dir, exist_ok=True)
COL = {"탄두(꽂힘)":(80,80,255), "탄두(누움)":(255,180,80),
       "탄피(꽂힘)":(80,255,120), "탄피(누움)":(80,220,255), "미분류":(180,180,180)}
recent = collections.deque(maxlen=15)
n = n_saved = 0
try:
    while True:
        if a.max_frames and n >= a.max_frames: break
        fs = align.process(pipe.wait_for_frames())
        cf, df = fs.get_color_frame(), fs.get_depth_frame()
        if not cf or not df: continue
        if a.smooth: df = hole.process(spatial.process(df))
        bgr = np.asanyarray(cf.get_data())
        depth = np.asanyarray(df.get_data()).astype(np.float32) * depth_scale_mm
        depth[depth <= 0] = np.nan

        t1 = time.time()
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        ii = proc(images=rgb, return_tensors="pt").to(dev)
        with torch.no_grad():
            ve = model.get_vision_features(pixel_values=ii.pixel_values)
            dets = []
            for q in prompts:
                o = model(vision_embeds=ve, **text_in[q])
                r = proc.post_process_instance_segmentation(
                    o, threshold=a.threshold, mask_threshold=0.5,
                    target_sizes=ii.get("original_sizes").tolist())[0]
                for m,b,s in zip(r["masks"], r["boxes"].tolist(), r["scores"].tolist()):
                    dets.append((b, s, m.detach().cpu().numpy().astype(bool)))
        dt = time.time()-t1; recent.append(dt); n += 1

        # 테이블 기준면 = 물체 마스크를 제외한 전체 깊이의 중앙값
        allmask = np.zeros(depth.shape, bool)
        for _,_,mk in dets:
            allmask |= (mk[0] if mk.ndim==3 else mk)
        bg = depth[~allmask & ~np.isnan(depth)]
        # 테이블은 화면에서 가장 먼 평면이다. 중앙값을 쓰면 트레이가 화면을 채웠을 때
        # 기준면이 트레이 바닥으로 잘못 잡혀 높이가 전부 축소된다.
        if a.plane_mm > 0:      plane = float(a.plane_mm)
        elif bg.size > 100:     plane = float(np.percentile(bg, a.plane_pct))
        else:                   plane = float(np.nanpercentile(depth, a.plane_pct))

        gray_eq = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8)).apply(
            cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)).astype(np.float32)
        vis = bgr.copy().astype(np.float32); labels=[]; counts={}; poses=[]
        _split_y = (bgr.shape[0] // 2) if a.split_y < 0 else a.split_y
        for b, sc, mk in dets:
            if mk.ndim == 3: mk = mk[0]
            dv = depth[mk]
            dv = dv[~np.isnan(dv)]
            npx = int(mk.sum())
            if a.min_area and npx < a.min_area: continue
            if a.max_area and npx > a.max_area: continue
            if (_ex or _roi) and rejected_by_region(mk): continue

            lp = local_plane_height(mk, depth, a.ring_px) if a.local_plane else None
            if lp is not None:
                h_top, h_med, peak, _pl = lp
            elif dv.size >= 20:
                hh = plane - dv
                h_top = float(np.percentile(hh,97)); h_med = float(np.median(hh))
                peak  = float(np.percentile(hh,97) - np.percentile(hh,20))
            else:
                h_top = h_med = peak = float('nan')   # 깊이가 없어도 분류는 계속한다

            # 주변 평면보다 솟지 않으면 물체가 아니다(고정대·설비 표면).
            # 깊이를 못 재면(nan) 이 검사는 건너뛰고 형태로만 판단한다.
            if not np.isnan(h_top) and h_top < a.min_height_mm: continue

            # 자세는 실루엣 종횡비로 정한다. 깊이보다 훨씬 안정적이고,
            # 셀 안으로 내려앉아 깊이가 안 나오는 물체에도 통한다.
            aspect, taper = shape_feats(mk)
            standing = aspect < a.pose_aspect
            if a.standing_only and not standing:
                continue                      # 누운 물체는 다루지 않는다
            _ys, _xs = np.nonzero(mk)
            _cv = float(_ys.mean())
            if standing:
                # 종류는 화면 가로선으로 가른다. 선 아래가 카메라에 가까운 쪽 = 탄피.
                # 밝기(center_brightness)는 금속 반사에 흔들려 탄두를 탄피로 잡는 일이
                # 많았다 — 물체를 줄로 나눠 놓는다면 위치가 훨씬 안정적인 근거다.
                cls = "탄피(꽂힘)" if _cv > _split_y else "탄두(꽂힘)"
            else:
                # 길쭉함. 한쪽만 좁아지는 물방울이면 탄두, 폭 일정한 원통이면 탄피.
                cls = "탄두(누움)" if taper >= a.taper_th else "탄피(누움)"
            counts[cls] = counts.get(cls,0)+1
            _dv = depth[mk]; _dv = _dv[~np.isnan(_dv)]
            _Z = float(np.percentile(_dv, 10) if "꽂힘" in cls else np.median(_dv)) if _dv.size >= 3 else float("nan")
            labels.append((b, cls, sc, h_top, peak, float(_xs.mean()), float(_ys.mean()), _Z))
            if a.pose or a.pose_json:
                gi = grasp_info(mk, depth, plane, "꽂힘" in cls)
                if gi:
                    gi["cls"] = cls; gi["score"] = round(float(sc),3)
                    poses.append(gi)
                    if a.pose:
                        yz = "  --  " if gi["yaw_deg"] is None else f"{gi['yaw_deg']:+6.1f}"
                        print(f"    {cls:11s} pos=({gi['pos_mm'][0]:7.1f},{gi['pos_mm'][1]:7.1f},"
                              f"{gi['pos_mm'][2]:7.1f})mm yaw={yz}  {gi['approach']}")
            c = np.array(COL[cls], dtype=np.float32)
            vis[mk] = vis[mk]*0.5 + c*0.5
            if a.dump:
                print(f"    {cls:11s} score={sc:.2f} 높이={h_top:5.1f}mm 볼록={peak:5.1f}mm")
        vis = vis.clip(0,255).astype(np.uint8)
        for b, cls, sc, h_top, peak, _cu, _cv, _cz in labels:
            c = COL[cls]
            cv2.rectangle(vis,(int(b[0]),int(b[1])),(int(b[2]),int(b[3])),c,2)
            cv2.putText(vis,f"{h_top:.0f}mm",(int(b[0]),max(10,int(b[1])-4)),
                        cv2.FONT_HERSHEY_SIMPLEX,0.42,c,1)
        fps = 1.0/(sum(recent)/len(recent))
        cv2.putText(vis,f"{fps:.1f} FPS  plane={plane:.0f}mm  total: {len(dets)}",
                    (8,20),cv2.FONT_HERSHEY_SIMPLEX,0.5,(0,255,255),2)
        for k,(cls,cnt) in enumerate(sorted(counts.items())):
            cv2.putText(vis,f"{cls}: {cnt}",(8,40+k*18),
                        cv2.FONT_HERSHEY_SIMPLEX,0.45,COL[cls],2)

        # 종류 구분선. 아래가 카메라에 가까운 쪽 = 탄피, 위 = 탄두.
        PINK = (203, 92, 255)
        cv2.line(vis, (0, _split_y), (vis.shape[1], _split_y), PINK, 2)
        cv2.putText(vis, "탄두 (먼 쪽)", (vis.shape[1] - 150, _split_y - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, PINK, 2)
        cv2.putText(vis, "탄피 (가까운 쪽)", (vis.shape[1] - 190, _split_y + 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, PINK, 2)

        # 정렬 기준 표시. sam3_pick_ros2.py 의 서보가 물체를 이 점으로 옮긴다.
        # 같은 화면에서 "얼마나 옮겨야 하나"를 눈으로 보려고 넣었다.
        if a.center_mark:
            H_, W_ = vis.shape[:2]
            cx = W_ // 2 if a.center_x < 0 else a.center_x
            cy = H_ // 2 if a.center_y < 0 else a.center_y
            GREEN = (0, 255, 0)
            cv2.drawMarker(vis, (cx, cy), GREEN, cv2.MARKER_CROSS, 22, 1)
            if a.tol_px > 0:
                cv2.circle(vis, (cx, cy), int(round(a.tol_px)), GREEN, 1)
            # 중심에 가장 가까운 물체까지의 어긋남을 px 와 mm 로 같이 보여준다.
            # mm = px * Z / fx — 야코비안 없이 깊이와 초점거리로 바로 환산한다.
            if labels:
                near = min(labels, key=lambda L: (L[5]-cx)**2 + (L[6]-cy)**2)
                du, dv_ = near[5]-cx, near[6]-cy
                err = (du*du + dv_*dv_) ** 0.5
                inside = err <= a.tol_px
                col = GREEN if inside else (0, 200, 255)
                cv2.line(vis, (cx, cy), (int(near[5]), int(near[6])), col, 1)
                cv2.circle(vis, (int(near[5]), int(near[6])), 5, col, 2)
                Z_ = near[7]
                if not np.isnan(Z_):
                    mmx, mmy = du * Z_ / INTR.fx, dv_ * Z_ / INTR.fy
                    txt = f"{err:.1f}px  ({mmx:+.1f},{mmy:+.1f})mm"
                else:
                    txt = f"{err:.1f}px  (Z 없음)"
                if inside: txt += "  OK"
                cv2.putText(vis, txt, (cx + 14, cy - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 2)

        if a.pose_json and poses:
            # 집는 순서: 높은 것(위에 있는 것)부터
            poses.sort(key=lambda g: -g["height_mm"])
            for i, g in enumerate(poses): g["pick_order"] = i
            tmp = a.pose_json + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"frame": n, "ts": time.time(),
                           "plane_mm": round(plane,1),
                           "frame_id": "camera_color_optical_frame",
                           "objects": poses}, f, ensure_ascii=False, indent=1)
            os.replace(tmp, a.pose_json)      # 원자적 교체 — 읽는 쪽이 깨진 파일을 보지 않는다

        if a.save_every and n % a.save_every == 0:
            cv2.imwrite(f"{a.out_dir}/d_{n:04d}.png", vis); n_saved += 1
        if a.display:
            cv2.imshow("SAM3 + Depth (q: 종료)", vis)
            if cv2.waitKey(1) & 0xFF == ord('q'): break
finally:
    pipe.stop()
    if a.display: cv2.destroyAllWindows()
print(f"[run ] {n} frames  {n/max(sum(recent)/len(recent)*n,1e-9):.2f} FPS  saved={n_saved}")
