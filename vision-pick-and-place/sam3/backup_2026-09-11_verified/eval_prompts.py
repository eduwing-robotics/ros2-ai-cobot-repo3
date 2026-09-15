#!/usr/bin/env python3
"""여러 이미지 × 여러 프롬프트로 SAM3 검출 점수를 재서 어떤 표현이 일관된지 본다.
사용법: eval_prompts.py img1.jpg img2.jpg ...
"""
import sys, cv2, torch, numpy as np
from transformers import Sam3Model, Sam3Processor

PROMPTS = ["bullet", "metal ring", "cartridge case", "bullet casing",
           "brass ring", "metal cylinder", "circle", "small metal object",
           "bullet tip", "pointed metal", "cone", "screw head",
           "brass", "metal object in cell", "projectile"]
TH   = 0.02          # 낮게 걸고 점수만 본다
AREA = 300           # 최소 면적 (원본 해상도가 크므로 비율로 다시 계산)

files = sys.argv[1:]
if not files: sys.exit(__doc__)

model = Sam3Model.from_pretrained("facebook/sam3", dtype=torch.bfloat16).to("cuda").eval()
proc  = Sam3Processor.from_pretrained("facebook/sam3")

res = {q: [] for q in PROMPTS}
for fi, f in enumerate(files, 1):
    bgr = cv2.imread(f)
    if bgr is None:
        print(f"  ✗ 못 읽음: {f}"); continue
    # 로봇 카메라와 비슷한 크기로 줄인다 (640 폭) — 스케일 차이를 줄이려는 목적
    h, w = bgr.shape[:2]
    scale = 640.0 / w
    small = cv2.resize(bgr, (640, int(h*scale)))
    amin = AREA
    ii = proc(images=cv2.cvtColor(small, cv2.COLOR_BGR2RGB), return_tensors="pt").to("cuda")
    with torch.no_grad():
        ve = model.get_vision_features(pixel_values=ii.pixel_values)
        for q in PROMPTS:
            tin = proc(text=q, return_tensors="pt").to("cuda")
            o = model(vision_embeds=ve, **tin)
            r = proc.post_process_instance_segmentation(
                    o, threshold=TH, mask_threshold=0.5,
                    target_sizes=ii.get("original_sizes").tolist())[0]
            mm = r["masks"].detach().cpu().numpy().astype(bool)
            if mm.ndim == 4: mm = mm[:, 0]
            sc = r.get("scores")
            sc = sc.detach().float().cpu().numpy() if sc is not None else np.zeros(len(mm))
            keep = [(float(s), int(m.sum())) for s, m in zip(sc, mm) if m.sum() >= amin]
            best = max((s for s, _ in keep), default=0.0)
            res[q].append((best, len(keep)))
    print(f"  [{fi}/{len(files)}] {f.split('/')[-1]} 완료", flush=True)

print()
print(f"{'프롬프트':<22} {'평균점수':>8} {'최소':>7} {'최대':>7} {'검출 0인 장수':>13} {'평균 마스크수':>13}")
print("-" * 80)
rows = []
for q, v in res.items():
    if not v: continue
    ss = [s for s, _ in v]; ns = [n for _, n in v]
    rows.append((np.mean(ss), q, min(ss), max(ss), sum(1 for s in ss if s == 0), np.mean(ns)))
for avg, q, lo, hi, zeros, nm in sorted(rows, reverse=True):
    print(f"{q:<22} {avg:>8.3f} {lo:>7.3f} {hi:>7.3f} {zeros:>13d} {nm:>13.1f}")
