#!/usr/bin/env python
"""여러 이미지 × 여러 프롬프트를 한 번의 모델 로드로 일괄 평가."""
import sys, torch, glob, os
from PIL import Image
from transformers import Sam3Model, Sam3Processor

imgs = sys.argv[1].split(",")
prompts = sys.argv[2].split("|")
thr = float(sys.argv[3]) if len(sys.argv) > 3 else 0.4
save = len(sys.argv) > 4 and sys.argv[4] == "save"

dev = "cuda"
model = Sam3Model.from_pretrained("facebook/sam3", dtype=torch.bfloat16).to(dev).eval()
proc = Sam3Processor.from_pretrained("facebook/sam3")

text_in = {p: proc(text=p, return_tensors="pt").to(dev) for p in prompts}
print(f"{'이미지':22s} " + " ".join(f"{p[:17]:>18s}" for p in prompts))
print("-" * (23 + 19*len(prompts)))
results = {}
for ip in imgs:
    im = Image.open(ip).convert("RGB")
    ii = proc(images=im, return_tensors="pt").to(dev)
    with torch.no_grad():
        ve = model.get_vision_features(pixel_values=ii.pixel_values)
    row = []
    for p in prompts:
        with torch.no_grad():
            out = model(vision_embeds=ve, **text_in[p])
        r = proc.post_process_instance_segmentation(
            out, threshold=thr, mask_threshold=0.5,
            target_sizes=ii.get("original_sizes").tolist())[0]
        n = len(r["masks"])
        top = max(r["scores"].tolist()) if n else 0.0
        row.append(f"{n}개({top:.2f})" if n else "0")
        results[(ip, p)] = (n, top, r)
    print(f"{os.path.basename(ip)[:22]:22s} " + " ".join(f"{c:>18s}" for c in row))
