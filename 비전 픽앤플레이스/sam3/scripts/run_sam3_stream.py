#!/usr/bin/env python
"""SAM 3 스트리밍 비디오 추론. 프레임을 하나씩 디코딩해 넣는다 (카메라 입력과 동일한 형태)."""
import argparse, time, os, resource
import numpy as np
import torch

p = argparse.ArgumentParser()
p.add_argument("--video", default="bedroom.mp4")
p.add_argument("--prompt", default="person")
p.add_argument("--repo", default="facebook/sam3")
p.add_argument("--max-frames", type=int, default=200)
p.add_argument("--dtype", default="bfloat16", choices=["bfloat16","float16","float32"])
p.add_argument("--out-dir", default="stream_out")
p.add_argument("--save-every", type=int, default=50)
a = p.parse_args()

dtype = getattr(torch, a.dtype)
dev = "cuda" if torch.cuda.is_available() else "cpu"
if dev == "cuda":
    torch.cuda.reset_peak_memory_stats()

from transformers import Sam3VideoModel, Sam3VideoProcessor

t0 = time.time()
model = Sam3VideoModel.from_pretrained(a.repo, dtype=dtype).to(dev).eval()
proc = Sam3VideoProcessor.from_pretrained(a.repo)
print(f"[load] {time.time()-t0:.1f}s  dtype={a.dtype}  dev={dev}")

# video= 를 주지 않는다. 이것이 스트리밍 모드의 핵심.
session = proc.init_video_session(
    inference_device=dev, processing_device="cpu",
    video_storage_device="cpu", dtype=dtype,
)
prompts = [x.strip() for x in a.prompt.split(",") if x.strip()]
proc.add_text_prompt(session, prompts if len(prompts) > 1 else prompts[0])
print(f"[prompt] {prompts}  (streaming)")

os.makedirs(a.out_dir, exist_ok=True)
from PIL import Image, ImageDraw
palette = [(255,80,80),(80,180,255),(120,255,120),(255,220,80),
           (220,120,255),(80,255,230),(255,150,80),(180,180,255)]

import av
container = av.open(a.video)
counts, all_ids, prompt_map, n_saved, n = [], set(), None, 0, 0
t0 = time.time()

for idx, av_frame in enumerate(container.decode(video=0)):
    if idx >= a.max_frames:
        break
    frame = av_frame.to_ndarray(format="rgb24")   # 이 한 장만 메모리에 있다

    inputs = proc(images=frame, device=dev, return_tensors="pt").to(dev)
    px = inputs.pixel_values[0].to(dtype)
    with torch.no_grad():
        mo = model(inference_session=session, frame=px, reverse=False)
    f = proc.postprocess_outputs(session, mo, original_sizes=inputs.original_sizes)

    n += 1
    if prompt_map is None and "prompt_to_obj_ids" in f:
        prompt_map = {k: list(v) for k, v in f["prompt_to_obj_ids"].items()}
    masks = f.get("masks")
    nobj = 0 if masks is None else len(masks)
    ids = list(f.get("obj_ids", range(nobj)))
    counts.append((idx, nobj)); all_ids.update(ids)

    if nobj and idx % a.save_every == 0:
        mk = masks.detach().cpu().numpy().astype(bool)
        if mk.ndim == 4: mk = mk[:, 0]
        base = frame.astype(np.float32)
        for j in range(mk.shape[0]):
            c = np.array(palette[ids[j] % len(palette)], dtype=np.float32)
            base[mk[j]] = base[mk[j]] * 0.5 + c * 0.5
        vis = Image.fromarray(base.clip(0,255).astype("uint8"))
        ImageDraw.Draw(vis).text((8,8), f"frame {idx}  objs={nobj}", fill=(255,255,0))
        vis.save(f"{a.out_dir}/frame_{idx:04d}.png"); n_saved += 1
        del mk, base
    del f, masks, inputs, px, frame

container.close()
elapsed = time.time() - t0
print(f"[track] {n} frames  {elapsed:.1f}s  ({elapsed/max(n,1)*1000:.0f}ms/frame)")
if dev == "cuda":
    print(f"[vram] peak {torch.cuda.max_memory_allocated()/2**30:.2f} GiB")
print(f"[ram ] peak {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/2**20:.2f} GiB")
if prompt_map:
    for pr, ids in prompt_map.items():
        print(f"[objs] {pr!r}: {len(ids)} object(s)  ids={ids}")
print(f"[ids] 전체 등장 객체 수: {len(all_ids)}")
step = max(1, len(counts)//12)
print("[counts] " + " ".join(f"{i}:{c}" for i, c in counts[::step]))
print(f"[saved] {n_saved} PNG -> {a.out_dir}/")
