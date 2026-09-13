#!/usr/bin/env python
"""SAM 3 이미지 추론 스모크 테스트 (RTX 5060 / 8GB VRAM 대응)."""
import argparse, time, os
import torch
from PIL import Image

p = argparse.ArgumentParser()
p.add_argument("--image", default="cats.jpg")
p.add_argument("--prompt", default="cat")
p.add_argument("--repo", default="facebook/sam3")
p.add_argument("--threshold", type=float, default=0.5)
p.add_argument("--mask-threshold", type=float, default=0.5)
p.add_argument("--image-size", type=int, default=0, help="0이면 기본 해상도")
p.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
p.add_argument("--box", action="append", default=None,
               help="x1,y1,x2,y2 형식. 여러 번 지정 가능. 예: --box 59,144,76,163")
p.add_argument("--neg-box", action="append", default=None,
               help="제외할 영역. --box 와 동일 형식")
p.add_argument("--out", default=None)
a = p.parse_args()

dtype = getattr(torch, a.dtype)
dev = "cuda" if torch.cuda.is_available() else "cpu"
torch.cuda.reset_peak_memory_stats() if dev == "cuda" else None

from transformers import Sam3Model, Sam3Processor, Sam3Config

t0 = time.time()
if a.image_size:
    cfg = Sam3Config.from_pretrained(a.repo)
    cfg.image_size = a.image_size
    model = Sam3Model.from_pretrained(a.repo, config=cfg, dtype=dtype).to(dev).eval()
    proc = Sam3Processor.from_pretrained(
        a.repo, size={"height": a.image_size, "width": a.image_size}
    )
else:
    model = Sam3Model.from_pretrained(a.repo, dtype=dtype).to(dev).eval()
    proc = Sam3Processor.from_pretrained(a.repo)
t_load = time.time() - t0
n_par = sum(x.numel() for x in model.parameters())
print(f"[load] {t_load:.1f}s  params={n_par/1e9:.2f}B  dtype={a.dtype}  dev={dev}")

image = Image.open(a.image).convert("RGB")

def parse_box(s):
    v = [float(x) for x in s.split(",")]
    assert len(v) == 4, f"박스는 x1,y1,x2,y2 4개 값이어야 함: {s}"
    return v

boxes_in, labels_in = [], []
for b in (a.box or []):
    boxes_in.append(parse_box(b)); labels_in.append(1)
for b in (a.neg_box or []):
    boxes_in.append(parse_box(b)); labels_in.append(0)

kw = {}
use_text = a.prompt.lower() not in ("", "none")
if use_text:
    kw["text"] = a.prompt
if boxes_in:
    kw["input_boxes"] = [boxes_in]
    kw["input_boxes_labels"] = [labels_in]
assert kw, "텍스트나 박스 중 하나는 필요함 (--prompt 또는 --box)"

desc = []
if use_text: desc.append(f"text={a.prompt!r}")
if boxes_in: desc.append(f"boxes={labels_in.count(1)}pos/{labels_in.count(0)}neg")
print(f"[img ] {a.image} {image.size}  " + "  ".join(desc))

inputs = proc(images=image, return_tensors="pt", **kw).to(dev)
# transformers 5.16.1 버그 우회: 박스 좌표가 float32로 나와 bf16/fp16 모델과 dtype 불일치
if "input_boxes" in inputs and inputs["input_boxes"] is not None:
    inputs["input_boxes"] = inputs["input_boxes"].to(dtype)

for i in range(2):  # 1회차 warmup, 2회차 계측
    torch.cuda.synchronize() if dev == "cuda" else None
    t0 = time.time()
    with torch.no_grad():
        outputs = model(**inputs)
    torch.cuda.synchronize() if dev == "cuda" else None
    t_inf = time.time() - t0
print(f"[infer] {t_inf*1000:.0f}ms (warm)")

res = proc.post_process_instance_segmentation(
    outputs, threshold=a.threshold, mask_threshold=a.mask_threshold,
    target_sizes=inputs.get("original_sizes").tolist(),
)[0]

masks, boxes, scores = res["masks"], res["boxes"], res["scores"]
print(f"[result] {len(masks)} object(s)")
for i, (b, s) in enumerate(zip(boxes.tolist(), scores.tolist())):
    print(f"   #{i}  score={s:.3f}  box=[{b[0]:.0f},{b[1]:.0f},{b[2]:.0f},{b[3]:.0f}]")

if dev == "cuda":
    print(f"[vram] peak {torch.cuda.max_memory_allocated()/2**30:.2f} GiB")

out = a.out or f"out_{os.path.splitext(os.path.basename(a.image))[0]}_{a.prompt.replace(' ','_')}.png"
if len(masks):
    import numpy as np
    from PIL import ImageDraw
    base = np.array(image).astype(np.float32)
    palette = [(255,80,80),(80,180,255),(120,255,120),(255,220,80),
               (220,120,255),(80,255,230),(255,150,80),(180,180,255)]
    m = masks.detach().cpu().numpy().astype(bool)
    for i in range(m.shape[0]):
        c = np.array(palette[i % len(palette)], dtype=np.float32)
        sel = m[i]
        base[sel] = base[sel] * 0.45 + c * 0.55
    vis = Image.fromarray(base.clip(0, 255).astype("uint8"))
    d = ImageDraw.Draw(vis)
    for i, (b, s) in enumerate(zip(boxes.tolist(), scores.tolist())):
        c = palette[i % len(palette)]
        d.rectangle(b, outline=c, width=3)
        d.text((b[0] + 4, max(0, b[1] - 12)), f"{a.prompt if use_text else 'obj'} {s:.2f}", fill=c)
    vis.save(out)
    print(f"[saved] {out}")
else:
    print("[saved] (검출 0개 - 시각화 생략)")
