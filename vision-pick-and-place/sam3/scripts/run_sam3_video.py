#!/usr/bin/env python
"""SAM 3 비디오 추론 (PCS + 트래킹). 8GB VRAM 대응."""
import argparse, time, os
import torch

p = argparse.ArgumentParser()
p.add_argument("--video", default="bedroom.mp4")
p.add_argument("--prompt", default="person", help="쉼표로 여러 개: person,bed,lamp")
p.add_argument("--repo", default="facebook/sam3")
p.add_argument("--max-frames", type=int, default=30)
p.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
p.add_argument("--image-size", type=int, default=0)
p.add_argument("--out-dir", default="video_out")
p.add_argument("--save-every", type=int, default=10, help="N프레임마다 PNG 저장")
a = p.parse_args()

dtype = getattr(torch, a.dtype)
dev = "cuda" if torch.cuda.is_available() else "cpu"
if dev == "cuda":
    torch.cuda.reset_peak_memory_stats()

from transformers import Sam3VideoModel, Sam3VideoProcessor, Sam3VideoConfig
from transformers.video_utils import load_video

t0 = time.time()
if a.image_size:
    cfg = Sam3VideoConfig.from_pretrained(a.repo)
    cfg.image_size = a.image_size
    model = Sam3VideoModel.from_pretrained(a.repo, config=cfg, dtype=dtype).to(dev).eval()
    proc = Sam3VideoProcessor.from_pretrained(
        a.repo, size={"height": a.image_size, "width": a.image_size})
else:
    model = Sam3VideoModel.from_pretrained(a.repo, dtype=dtype).to(dev).eval()
    proc = Sam3VideoProcessor.from_pretrained(a.repo)
print(f"[load] {time.time()-t0:.1f}s  dtype={a.dtype}  dev={dev}")

frames, _ = load_video(a.video)
frames = frames[: a.max_frames]
print(f"[video] {a.video}  {len(frames)} frames  {frames[0].shape}")

# VRAM 절약: 전처리/저장은 CPU에 둔다
# dtype 기본값이 float32라 bf16 모델과 어긋난다. 반드시 모델과 맞춘다.
session = proc.init_video_session(
    video=frames, inference_device=dev,
    processing_device="cpu", video_storage_device="cpu",
    dtype=dtype,
)

prompts = [x.strip() for x in a.prompt.split(",") if x.strip()]
proc.add_text_prompt(session, prompts if len(prompts) > 1 else prompts[0])
print(f"[prompt] {prompts}")

os.makedirs(a.out_dir, exist_ok=True)

import numpy as np
from PIL import Image, ImageDraw
palette = [(255,80,80),(80,180,255),(120,255,120),(255,220,80),
           (220,120,255),(80,255,230),(255,150,80),(180,180,255)]

# 마스크를 전부 들고 있으면 200프레임에서 RAM OOM이 난다.
# 프레임마다 즉시 소비하고 버린다.
t0 = time.time()
counts, all_ids, prompt_map, n_saved, n = [], set(), None, 0, 0
for mo in model.propagate_in_video_iterator(
    inference_session=session, max_frame_num_to_track=a.max_frames
):
    f = proc.postprocess_outputs(session, mo)
    idx = mo.frame_idx
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
        base = np.array(frames[idx]).astype(np.float32)
        for j in range(mk.shape[0]):
            c = np.array(palette[ids[j] % len(palette)], dtype=np.float32)
            base[mk[j]] = base[mk[j]] * 0.5 + c * 0.5
        vis = Image.fromarray(base.clip(0,255).astype("uint8"))
        ImageDraw.Draw(vis).text((8,8), f"frame {idx}  objs={nobj}", fill=(255,255,0))
        vis.save(f"{a.out_dir}/frame_{idx:04d}.png"); n_saved += 1
        del mk, base
    del f, masks   # 즉시 해제

elapsed = time.time() - t0
print(f"[track] {n} frames  {elapsed:.1f}s  ({elapsed/max(n,1)*1000:.0f}ms/frame)")
if dev == "cuda":
    print(f"[vram] peak {torch.cuda.max_memory_allocated()/2**30:.2f} GiB")
import resource
print(f"[ram ] peak {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/2**20:.2f} GiB")
if prompt_map:
    for pr, ids in prompt_map.items():
        print(f"[objs] {pr!r}: {len(ids)} object(s)  ids={ids}")
print(f"[ids] 전체 등장 객체 수: {len(all_ids)}")
step = max(1, len(counts)//12)
print("[counts] " + " ".join(f"{i}:{c}" for i, c in counts[::step]))
print(f"[saved] {n_saved} PNG -> {a.out_dir}/")
