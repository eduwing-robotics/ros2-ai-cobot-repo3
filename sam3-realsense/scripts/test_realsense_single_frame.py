import cv2
import numpy as np
import pyrealsense2 as rs
from PIL import Image

from sam3.model_builder import build_sam3_multiplex_video_predictor


CHECKPOINT = "/home/inhanp/models/sam3.1/sam3.1_multiplex.pt"
PROMPT = "pink plastic crate"

OUTPUT = "/home/inhanp/Documents/sam3_video/realsense_single_frame.png"


print("1. Loading SAM 3.1 Multiplex...")

predictor = build_sam3_multiplex_video_predictor(
    checkpoint_path=CHECKPOINT,
    use_fa3=False,
    compile=False,
    warm_up=False,
)


print("2. Starting RealSense...")

pipeline = rs.pipeline()
config = rs.config()

config.enable_stream(
    rs.stream.color,
    640,
    480,
    rs.format.bgr8,
    30,
)

pipeline.start(config)


print("3. Waiting for frame...")

# 카메라 자동 노출 안정화
for _ in range(30):
    frames = pipeline.wait_for_frames()

frames = pipeline.wait_for_frames()

color_frame = frames.get_color_frame()

if not color_frame:
    pipeline.stop()
    raise RuntimeError("Failed to get RealSense color frame")

frame_bgr = np.asanyarray(color_frame.get_data())

pipeline.stop()


print(f"   RealSense frame: {frame_bgr.shape[1]} x {frame_bgr.shape[0]}")


print("4. Converting BGR -> RGB -> PIL...")

frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
pil_image = Image.fromarray(frame_rgb)


print("5. Initializing SAM3 state...")

state = predictor.model.init_state(
    resource_path=[pil_image],
    offload_video_to_cpu=True,
)


print("6. Running text prompt...")

_, outputs = predictor.model.add_prompt(
    state,
    frame_idx=0,
    text_str=PROMPT,
    output_prob_thresh=0.5,
)


print("7. Detection result")

obj_ids = outputs["out_obj_ids"]
probs = outputs["out_probs"]
boxes = outputs["out_boxes_xywh"]
masks = outputs["out_binary_masks"]

print("   Object IDs:", obj_ids)
print("   Probabilities:", probs)
print("   Boxes:", boxes)
print("   Mask shape:", masks.shape)


print("8. Drawing result...")

result = frame_bgr.copy()

orig_height, orig_width = frame_bgr.shape[:2]


for i in range(len(obj_ids)):

    # -----------------------------
    # Bounding box
    # -----------------------------
    x, y, w, h = boxes[i]

    x1 = int(x * orig_width)
    y1 = int(y * orig_height)
    x2 = int((x + w) * orig_width)
    y2 = int((y + h) * orig_height)

    cv2.rectangle(
        result,
        (x1, y1),
        (x2, y2),
        (0, 255, 0),
        2,
    )

    # -----------------------------
    # Mask
    # -----------------------------
    mask = masks[i].astype(np.uint8)

    mask = cv2.resize(
        mask,
        (orig_width, orig_height),
        interpolation=cv2.INTER_NEAREST,
    )

    mask_bool = mask > 0

    overlay = result.copy()

    overlay[mask_bool] = (
        0.5 * overlay[mask_bool]
        + 0.5 * np.array([0, 255, 0])
    ).astype(np.uint8)

    result = overlay

    # -----------------------------
    # Label
    # -----------------------------
    label = f"{PROMPT} {probs[i]:.3f}"

    cv2.putText(
        result,
        label,
        (x1, max(y1 - 10, 20)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (0, 255, 0),
        2,
        cv2.LINE_AA,
    )


print("9. Saving result...")

cv2.imwrite(OUTPUT, result)


print()
print("===== REALSENSE TEST SUCCESS =====")
print(f"Output: {OUTPUT}")
