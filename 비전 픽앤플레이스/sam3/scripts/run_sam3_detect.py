#!/usr/bin/env python
"""SAM 3 실시간 웹캠 '매 프레임 검출' 모드.
비디오 트래커 대신 이미지 모델을 매 프레임 돌린다. 이동에 강하고 메모리가 쌓이지 않는다.
vision 임베딩은 한 번만 계산해 여러 텍스트 프롬프트가 공유한다."""
import argparse, time, os, collections
import numpy as np
import torch, cv2

p = argparse.ArgumentParser()
p.add_argument("--cam", type=int, default=4)
p.add_argument("--prompt", default="gold cylinder,silver bullet,pink tray")
p.add_argument("--repo", default="facebook/sam3")
p.add_argument("--threshold", type=float, default=0.5)
p.add_argument("--prompt-threshold", action="append", default=None,
               help='프롬프트별 임계값. 예: "gold cylinder=0.6"')
p.add_argument("--mask-threshold", type=float, default=0.5)
p.add_argument("--priority", default=None, help='겹칠 때 우선순위(앞이 이김)')
p.add_argument("--derive", action="append", default=None,
               help='차집합 클래스. 예: --derive "bullet head=bullet-gold cylinder" '
                    '(bullet 검출 중 gold cylinder와 겹치지 않는 것 = bullet head)')
p.add_argument("--iou", type=float, default=0.5)
p.add_argument("--image-size", type=int, default=0)
p.add_argument("--dtype", default="bfloat16", choices=["bfloat16","float16","float32"])
p.add_argument("--exposure", type=int, default=600)
p.add_argument("--width", type=int, default=640)
p.add_argument("--height", type=int, default=480)
p.add_argument("--display", action="store_true")
p.add_argument("--seconds", type=float, default=0)
p.add_argument("--max-frames", type=int, default=0)
p.add_argument("--out-dir", default="detect_out")
p.add_argument("--save-every", type=int, default=0)
a = p.parse_args()

dtype = getattr(torch, a.dtype)
dev = "cuda" if torch.cuda.is_available() else "cpu"
if dev == "cuda": torch.cuda.reset_peak_memory_stats()

from transformers import Sam3Model, Sam3Processor, Sam3Config

t0 = time.time()
cfg = Sam3Config.from_pretrained(a.repo)
if a.image_size: cfg.image_size = a.image_size
model = Sam3Model.from_pretrained(a.repo, config=cfg, dtype=dtype).to(dev).eval()
proc = (Sam3Processor.from_pretrained(a.repo, size={"height": a.image_size, "width": a.image_size})
        if a.image_size else Sam3Processor.from_pretrained(a.repo))
print(f"[load] {time.time()-t0:.1f}s  image_size={a.image_size or 1008}  dtype={a.dtype}")

prompts = [x.strip() for x in a.prompt.split(",") if x.strip()]
prompt_thr = {}
for spec in (a.prompt_threshold or []):
    k,_,v = spec.rpartition("="); prompt_thr[k.strip()] = float(v)
priority = [x.strip() for x in a.priority.split(",")] if a.priority else []
rank_of = {pr:i for i,pr in enumerate(priority)}
# 차집합 클래스 파싱: NAME=BASE-MINUS1,MINUS2
derives = []
for spec in (a.derive or []):
    name, _, rhs = spec.partition("=")
    base, _, minus = rhs.partition("-")
    derives.append((name.strip(), base.strip(),
                    [m.strip() for m in minus.split(",") if m.strip()]))
base_prompts = {d[1] for d in derives}          # 화면에 직접 표시하지 않는다
display_classes = [d[0] for d in derives] + [p for p in prompts if p not in base_prompts]
print(f"[prompt] {prompts}  (per-frame detection, no tracking)")
for nm, b, mi in derives:
    print(f"[derive] {nm} = '{b}' - {mi}")

# 텍스트 임베딩은 고정이므로 미리 계산해 재사용한다
text_inputs = {pr: proc(text=pr, return_tensors="pt").to(dev) for pr in prompts}

def _iou(b1,b2):
    x1,y1 = max(b1[0],b2[0]), max(b1[1],b2[1])
    x2,y2 = min(b1[2],b2[2]), min(b1[3],b2[3])
    iw,ih = max(0.,x2-x1), max(0.,y2-y1); inter = iw*ih
    a1 = max(0.,b1[2]-b1[0])*max(0.,b1[3]-b1[1])
    a2 = max(0.,b2[2]-b2[0])*max(0.,b2[3]-b2[1])
    u = a1+a2-inter
    return inter/u if u>0 else 0.

cap = cv2.VideoCapture(a.cam, cv2.CAP_V4L2)
cap.set(cv2.CAP_PROP_FRAME_WIDTH, a.width); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, a.height)
cap.set(cv2.CAP_PROP_BUFFERSIZE, 1); cap.set(cv2.CAP_PROP_AUTO_WB, 1)
if a.exposure:
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE,1); cap.set(cv2.CAP_PROP_EXPOSURE,a.exposure)
else:
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE,3)
if not cap.isOpened(): raise SystemExit(f"카메라 /dev/video{a.cam} 열기 실패")
for _ in range(15): cap.read()
print(f"[cam ] /dev/video{a.cam}  {int(cap.get(3))}x{int(cap.get(4))}")

os.makedirs(a.out_dir, exist_ok=True)
palette = np.array([(255,80,80),(80,180,255),(120,255,120),(255,220,80),
                    (220,120,255),(80,255,230)], dtype=np.float32)
recent = collections.deque(maxlen=20)
n = n_saved = 0
t_start = time.time()
try:
    while True:
        if a.seconds and time.time()-t_start >= a.seconds: break
        if a.max_frames and n >= a.max_frames: break
        ok, bgr = cap.read()
        if not ok: print("[warn] 프레임 획득 실패"); break
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

        t1 = time.time()
        img_inputs = proc(images=rgb, return_tensors="pt").to(dev)
        with torch.no_grad():
            # vision 인코더는 프레임당 한 번만 — 프롬프트들이 공유한다
            vision_embeds = model.get_vision_features(pixel_values=img_inputs.pixel_values)
            dets = []   # (prompt, score, box, mask)
            for pr in prompts:
                out = model(vision_embeds=vision_embeds, **text_inputs[pr])
                res = proc.post_process_instance_segmentation(
                    out, threshold=prompt_thr.get(pr, a.threshold),
                    mask_threshold=a.mask_threshold,
                    target_sizes=img_inputs.get("original_sizes").tolist())[0]
                for m, b, sc in zip(res["masks"], res["boxes"].tolist(), res["scores"].tolist()):
                    dets.append((pr, sc, b, m))
        dt = time.time()-t1; recent.append(dt); n += 1

        # 차집합 클래스: base 검출 중 minus 클래스와 겹치지 않는 것만 남긴다
        for nm, base, minus in derives:
            minus_boxes = [d[2] for d in dets if d[0] in minus]
            newdets = []
            for d in dets:
                if d[0] != base:
                    newdets.append(d); continue
                if any(_iou(d[2], mb) >= a.iou for mb in minus_boxes):
                    continue                      # 이미 minus 클래스로 잡힌 것
                newdets.append((nm, d[1], d[2], d[3]))
            dets = newdets

        # 우선순위 기반 IoU 억제 (클래스 간 중복 제거)
        if priority and dets:
            rk = lambda d: rank_of.get(d[0], len(priority))
            dets.sort(key=lambda d: (rk(d), -d[1]))
            kept = []
            for d in dets:
                if any(rk(k) < rk(d) and _iou(d[2], k[2]) >= a.iou for k in kept): continue
                kept.append(d)
            dets = kept

        per_class = {}
        vis = bgr.astype(np.float32)
        for pr, sc, b, m in dets:
            per_class[pr] = per_class.get(pr,0)+1
            ci = display_classes.index(pr) if pr in display_classes else 0
            c = palette[ci % len(palette)][::-1]
            mk = m.detach().cpu().numpy().astype(bool)
            if mk.ndim == 3: mk = mk[0]
            vis[mk] = vis[mk]*0.5 + c*0.5
        vis = vis.clip(0,255).astype(np.uint8)
        for pr, sc, b, m in dets:
            ci = display_classes.index(pr) if pr in display_classes else 0
            c = tuple(int(v) for v in palette[ci % len(palette)][::-1])
            cv2.rectangle(vis, (int(b[0]),int(b[1])), (int(b[2]),int(b[3])), c, 1)

        fps = 1.0/(sum(recent)/len(recent))
        cv2.putText(vis, f"{fps:.1f} FPS ({sum(recent)/len(recent)*1000:.0f}ms)  total: {len(dets)}",
                    (8,22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0,255,255), 2)
        for k, pr in enumerate(display_classes):
            c = tuple(int(v) for v in palette[k % len(palette)][::-1])
            cv2.putText(vis, f"{pr}: {per_class.get(pr,0)}", (8, 44+k*20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 2)

        if a.save_every and n % a.save_every == 0:
            cv2.imwrite(f"{a.out_dir}/det_{n:04d}.png", vis); n_saved += 1
        if a.display:
            cv2.imshow("SAM3 detect (q: 종료)", vis)
            if cv2.waitKey(1) & 0xFF == ord('q'): break
        del img_inputs, vision_embeds, dets
finally:
    cap.release()
    if a.display: cv2.destroyAllWindows()

el = time.time()-t_start
print(f"[run ] {n} frames  {el:.1f}s  평균 {el/max(n,1)*1000:.0f}ms  {n/max(el,1e-9):.2f} FPS")
if dev == "cuda": print(f"[vram] peak {torch.cuda.max_memory_allocated()/2**30:.2f} GiB")
print(f"[saved] {n_saved} -> {a.out_dir}/")
