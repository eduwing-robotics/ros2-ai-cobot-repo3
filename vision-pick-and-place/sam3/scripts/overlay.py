#!/usr/bin/env python
"""한 이미지에 여러 프롬프트 결과를 나란히 그려 비교."""
import sys, torch, os
import numpy as np, cv2
from PIL import Image
from transformers import Sam3Model, Sam3Processor

img_path = sys.argv[1]; prompts = sys.argv[2].split("|")
thr = float(sys.argv[3]) if len(sys.argv)>3 else 0.4
out = sys.argv[4] if len(sys.argv)>4 else "overlay.png"

dev="cuda"
model = Sam3Model.from_pretrained("facebook/sam3", dtype=torch.bfloat16).to(dev).eval()
proc = Sam3Processor.from_pretrained("facebook/sam3")
im = Image.open(img_path).convert("RGB")
base_bgr = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
ii = proc(images=im, return_tensors="pt").to(dev)
with torch.no_grad():
    ve = model.get_vision_features(pixel_values=ii.pixel_values)
pal=[(80,80,255),(255,180,80),(80,255,120),(80,220,255),(255,120,220)]
panels=[]
for k,p in enumerate(prompts):
    ti = proc(text=p, return_tensors="pt").to(dev)
    with torch.no_grad(): o = model(vision_embeds=ve, **ti)
    r = proc.post_process_instance_segmentation(o, threshold=thr, mask_threshold=0.5,
            target_sizes=ii.get("original_sizes").tolist())[0]
    v = base_bgr.astype(np.float32).copy()
    ms = r["masks"]
    for j in range(len(ms)):
        mk = ms[j].detach().cpu().numpy().astype(bool)
        if mk.ndim==3: mk=mk[0]
        c=np.array(pal[j%len(pal)],dtype=np.float32)
        v[mk]=v[mk]*0.45+c*0.55
    v=v.clip(0,255).astype(np.uint8)
    for b in r["boxes"].tolist():
        cv2.rectangle(v,(int(b[0]),int(b[1])),(int(b[2]),int(b[3])),(0,255,255),2)
    cv2.rectangle(v,(0,0),(v.shape[1],34),(0,0,0),-1)
    cv2.putText(v,f"{p}: {len(ms)}",(8,24),cv2.FONT_HERSHEY_SIMPLEX,0.7,(0,255,255),2)
    panels.append(v)
cv2.imwrite(out, np.hstack(panels)); print("저장:", out, np.hstack(panels).shape)
