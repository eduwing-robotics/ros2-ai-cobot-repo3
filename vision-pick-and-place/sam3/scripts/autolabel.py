#!/usr/bin/env python
"""SAM 3 + 깊이로 학습 데이터셋을 자동 생성한다.

SAM 3에 형태 프롬프트로 물체를 찾게 하고, 깊이와 실루엣으로 클래스를 정한 뒤
YOLO 형식 라벨로 저장한다. 사람은 틀린 것만 고치면 된다.

장면이 바뀌고 안정되면 자동으로 촬영하므로, 물체를 재배치하기만 하면 표본이 쌓인다.
깊이도 함께 저장하므로 임계값을 바꿔 나중에 재라벨링할 수 있다.
"""
import argparse, os, time, json, shutil
import numpy as np, cv2, torch
import pyrealsense2 as rs

ap = argparse.ArgumentParser()
ap.add_argument("--out", default="dataset", help="데이터셋 루트")
ap.add_argument("--prompt", default="bullet")
ap.add_argument("--repo", default="facebook/sam3")
ap.add_argument("--threshold", type=float, default=0.45)
ap.add_argument("--shots", type=int, default=50, help="목표 촬영 장수")
ap.add_argument("--classes", type=int, default=4, choices=[2,4],
                help="4=자세 포함(꽂힘/누움), 2=탄두/탄피만")
ap.add_argument("--seg", action="store_true", help="폴리곤(세그멘테이션) 라벨도 저장")
ap.add_argument("--val-ratio", type=float, default=0.2)
# 자동 촬영 조건
ap.add_argument("--change-th", type=float, default=3.0, help="이 이상 바뀌면 '변화'로 본다")
ap.add_argument("--settle-sec", type=float, default=1.2, help="변화 후 이만큼 조용하면 촬영")
ap.add_argument("--min-gap", type=float, default=2.0, help="촬영 간 최소 간격(초)")
ap.add_argument("--manual", action="store_true", help="자동 대신 스페이스바로 촬영")
# 분류 임계값 (run_sam3_depth.py 와 동일)
ap.add_argument("--stand-mm", type=float, default=20.0)
ap.add_argument("--split-mm", type=float, default=55.0)
ap.add_argument("--taper-th", type=float, default=0.15)
ap.add_argument("--aspect-th", type=float, default=4.3)
ap.add_argument("--plane-mm", type=float, default=0,
               help="테이블까지 거리(mm)를 직접 지정. 0이면 자동 추정")
p.add_argument("--plane-pct", type=float, default=85,
               help="자동 추정 시 배경 깊이의 백분위. 테이블은 가장 먼 면이므로 높게 잡는다")
p.add_argument("--depth-res", default="848x480")
ap.add_argument("--min-area", type=int, default=80, help="이보다 작은 마스크는 버린다")
ap.add_argument("--display", action="store_true")
a = ap.parse_args()

NAMES4 = ["head_standing", "head_lying", "casing_standing", "casing_lying"]
NAMES2 = ["head", "casing"]
NAMES  = NAMES4 if a.classes == 4 else NAMES2
KO = {"head_standing":"탄두(꽂힘)","head_lying":"탄두(누움)",
      "casing_standing":"탄피(꽂힘)","casing_lying":"탄피(누움)",
      "head":"탄두","casing":"탄피"}
COL = {0:(80,80,255),1:(255,180,80),2:(80,255,120),3:(80,220,255)}

root = a.out
for d in ("images/train","images/val","labels/train","labels/val","depth","review"):
    os.makedirs(os.path.join(root,d), exist_ok=True)

from transformers import Sam3Model, Sam3Processor
t0=time.time()
model = Sam3Model.from_pretrained(a.repo, dtype=torch.bfloat16).to("cuda").eval()
proc  = Sam3Processor.from_pretrained(a.repo)
prompts=[x.strip() for x in a.prompt.split(",") if x.strip()]
text_in={q: proc(text=q, return_tensors="pt").to("cuda") for q in prompts}
print(f"[load] {time.time()-t0:.1f}s  클래스 {a.classes}종: {NAMES}")

_dw,_dh = (int(v) for v in a.depth_res.lower().split("x"))
pipe=rs.pipeline(); cfg=rs.config()
cfg.enable_stream(rs.stream.color,640,480,rs.format.bgr8,30)
cfg.enable_stream(rs.stream.depth,_dw,_dh,rs.format.z16,30)
prof=pipe.start(cfg)
dscale=prof.get_device().first_depth_sensor().get_depth_scale()*1000.0
align=rs.align(rs.stream.color)
for _ in range(25): pipe.wait_for_frames()
print(f"[cam ] 준비 완료. 목표 {a.shots}장  "
      f"({'스페이스=촬영' if a.manual else '물체를 재배치하면 자동 촬영'}, q=종료)")

def shape_feats(m):
    ys,xs=np.nonzero(m)
    if ys.size<30: return 0.0,0.0
    pts=np.stack([xs,ys],1).astype(np.float32); pts-=pts.mean(0)
    _,_,vt=np.linalg.svd(pts,full_matrices=False)
    t,w=pts@vt[0],pts@vt[1]
    bins=np.linspace(t.min(),t.max(),11); wd=[]
    for i in range(10):
        sel=(t>=bins[i])&(t<bins[i+1])
        wd.append(w[sel].max()-w[sel].min() if sel.sum()>3 else 0.0)
    wd=np.array(wd); W=wd.max() if wd.max()>0 else 1.0
    return float((t.max()-t.min())/W), float(abs(wd[:3].mean()-wd[-3:].mean())/W)

def detect(bgr, depth):
    ii=proc(images=cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB),return_tensors="pt").to("cuda")
    with torch.no_grad():
        ve=model.get_vision_features(pixel_values=ii.pixel_values)
        masks=[]
        for q in prompts:
            o=model(vision_embeds=ve,**text_in[q])
            r=proc.post_process_instance_segmentation(o,threshold=a.threshold,
                mask_threshold=0.5,target_sizes=ii.get("original_sizes").tolist())[0]
            mm=r["masks"].detach().cpu().numpy().astype(bool)
            if mm.ndim==4: mm=mm[:,0]
            masks.extend(list(mm))
    d=depth.copy(); d[d<=0]=np.nan
    allm=np.zeros(d.shape,bool)
    for m in masks: allm|=m
    if a.plane_mm > 0:   plane=float(a.plane_mm)
    else:
        bgv=d[~allm & ~np.isnan(d)]
        plane=float(np.percentile(bgv,a.plane_pct)) if bgv.size>100 else float(np.nanpercentile(d,a.plane_pct))
    out=[]
    for m in masks:
        if m.sum() < a.min_area: continue
        h=plane-d[m]; h=h[~np.isnan(h)]
        if h.size<20: continue
        htop=float(np.percentile(h,97))
        if htop>=a.stand_mm:
            name = "casing_standing" if htop>=a.split_mm else "head_standing"
        else:
            asp,tap=shape_feats(m)
            says = tap>=a.taper_th if tap>=a.taper_th or tap<=a.taper_th*0.6 else asp<a.aspect_th
            name = "head_lying" if says else "casing_lying"
        if a.classes==2: name = "head" if name.startswith("head") else "casing"
        out.append((NAMES.index(name), m, htop))
    return out, plane

def to_yolo(m, W, H):
    ys,xs=np.nonzero(m)
    x1,x2,y1,y2=xs.min(),xs.max(),ys.min(),ys.max()
    return ((x1+x2)/2/W, (y1+y2)/2/H, (x2-x1+1)/W, (y2-y1+1)/H)

def to_poly(m, W, H):
    cs,_=cv2.findContours(m.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    if not cs: return None
    c=max(cs,key=cv2.contourArea)
    eps=0.005*cv2.arcLength(c,True)
    ap_=cv2.approxPolyDP(c,eps,True).reshape(-1,2)
    if len(ap_)<3: return None
    return " ".join(f"{x/W:.6f} {y/H:.6f}" for x,y in ap_)

shots=0; last_shot=0.0; last_gray=None; quiet_since=None
tally={n:0 for n in NAMES}
try:
    while shots < a.shots:
        fs=align.process(pipe.wait_for_frames())
        cf,df=fs.get_color_frame(),fs.get_depth_frame()
        if not cf or not df: continue
        bgr=np.asanyarray(cf.get_data()).copy()
        depth=np.asanyarray(df.get_data()).astype(np.float32)*dscale
        H,W=bgr.shape[:2]

        gray=cv2.cvtColor(cv2.resize(bgr,(160,120)),cv2.COLOR_BGR2GRAY).astype(np.float32)
        diff = 0.0 if last_gray is None else float(np.abs(gray-last_gray).mean())
        last_gray=gray
        now=time.time()
        take=False
        if a.manual:
            pass                                   # 아래 키 입력에서 처리
        else:
            # 움직임이 멎고 settle_sec 만큼 조용하면 촬영
            if diff >= a.change_th: quiet_since=None
            elif quiet_since is None: quiet_since=now
            if (quiet_since and now-quiet_since>=a.settle_sec
                    and now-last_shot>=a.min_gap):
                take=True

        vis=bgr.copy()
        if a.display or take:
            dets,plane=detect(bgr,depth) if take else ([],0.0)
        if take:
            if not dets:
                quiet_since=now                    # 검출 0이면 촬영하지 않는다
            else:
                split="val" if np.random.rand()<a.val_ratio else "train"
                stem=f"{int(now*1000)%10**10:010d}"
                cv2.imwrite(f"{root}/images/{split}/{stem}.jpg", bgr,
                            [cv2.IMWRITE_JPEG_QUALITY,100])
                np.save(f"{root}/depth/{stem}.npy", depth.astype(np.float32))
                lines=[]
                for ci,m,htop in dets:
                    cx,cy,w,h=to_yolo(m,W,H)
                    if a.seg:
                        pl=to_poly(m,W,H)
                        lines.append(f"{ci} {pl}" if pl else f"{ci} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                    else:
                        lines.append(f"{ci} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                    tally[NAMES[ci]]+=1
                open(f"{root}/labels/{split}/{stem}.txt","w").write("\n".join(lines)+"\n")
                rv=bgr.astype(np.float32)
                for ci,m,htop in dets:
                    rv[m]=rv[m]*0.5+np.array(COL[ci%4],dtype=np.float32)*0.5
                rv=rv.clip(0,255).astype(np.uint8)
                for ci,m,htop in dets:
                    ys,xs=np.nonzero(m)
                    cv2.putText(rv,f"{NAMES[ci]} {htop:.0f}mm",(xs.min(),max(10,ys.min()-3)),
                                cv2.FONT_HERSHEY_SIMPLEX,0.35,COL[ci%4],1)
                cv2.imwrite(f"{root}/review/{stem}.png", rv)
                shots+=1; last_shot=now; quiet_since=None
                print(f"  [{shots}/{a.shots}] {split:5s} {stem}  객체 {len(dets)}개  "
                      + " ".join(f"{KO[n]}:{tally[n]}" for n in NAMES), flush=True)

        if a.display:
            cv2.putText(vis,f"{shots}/{a.shots}  diff={diff:.1f}",(8,20),
                        cv2.FONT_HERSHEY_SIMPLEX,0.5,(0,255,255),2)
            cv2.imshow("autolabel (space=촬영, q=종료)",vis)
            k=cv2.waitKey(1)&0xFF
            if k==ord('q'): break
            if a.manual and k==ord(' '): last_shot=0; quiet_since=time.time()-a.settle_sec
finally:
    pipe.stop()
    if a.display: cv2.destroyAllWindows()

open(f"{root}/classes.txt","w").write("\n".join(NAMES)+"\n")
open(f"{root}/data.yaml","w").write(
    f"path: {os.path.abspath(root)}\ntrain: images/train\nval: images/val\n\n"
    f"nc: {len(NAMES)}\nnames: {NAMES}\n")
n_tr=len(os.listdir(f"{root}/images/train")); n_va=len(os.listdir(f"{root}/images/val"))
print(f"\n[완료] train {n_tr}장 / val {n_va}장  → {os.path.abspath(root)}")
print("  클래스별 인스턴스: " + " ".join(f"{KO[n]}={tally[n]}" for n in NAMES))
print(f"  review/ 의 오버레이로 라벨을 검수한 뒤 학습에 쓰세요.")
