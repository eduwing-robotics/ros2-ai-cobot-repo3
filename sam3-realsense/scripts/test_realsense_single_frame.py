import argparse
from pathlib import Path

import cv2
import numpy as np
import pyrealsense2 as rs
from PIL import Image

from sam3.model_builder import build_sam3_multiplex_video_predictor


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run SAM 3.1 text-prompt segmentation on a single RealSense frame."
    )

    parser.add_argument(
        "--checkpoint",
        required=True,
        help="Path to the SAM 3.1 Multiplex checkpoint (.pt)",
    )

    parser.add_argument(
        "--prompt",
        default="pink plastic crate",
        help="Text prompt for the object to detect.",
    )

    parser.add_argument(
        "--output",
        default="realsense_single_frame.png",
        help="Path to save the output image.",
    )

    return parser.parse_args()


def main():
    args = parse_args()

    checkpoint = Path(args.checkpoint)
    output = Path(args.output)

    if not checkpoint.exists():
        raise FileNotFoundError(
            f"SAM 3.1 checkpoint not found:\n{checkpoint}"
        )

    output.parent.mkdir(parents=True, exist_ok=True)

    print("1. Loading SAM 3.1 Multiplex...")

    predictor = build_sam3_multiplex_video_predictor(
        checkpoint_path=str(checkpoint),
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

    try:
        # Warm up the camera.
        for _ in range(30):
            pipeline.wait_for_frames()

        print("3. Capturing frame...")

        frames = pipeline.wait_for_frames()
        color_frame = frames.get_color_frame()

        if not color_frame:
            raise RuntimeError("Failed to capture a color frame.")

        frame_bgr = np.asanyarray(color_frame.get_data())

    finally:
        pipeline.stop()

    print("4. Converting frame to PIL image...")

    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    pil_image = Image.fromarray(frame_rgb)

    print("5. Initializing SAM 3.1 state...")

    state = predictor.model.init_state(
        resource_path=[pil_image],
        offload_video_to_cpu=True,
    )

    print(f"6. Running text prompt: '{args.prompt}'")

    _, outputs = predictor.model.add_prompt(
        state,
        frame_idx=0,
        text_str=args.prompt,
        output_prob_thresh=0.5,
    )

    obj_ids = outputs["out_obj_ids"]
    probs = outputs["out_probs"]
    boxes = outputs["out_boxes_xywh"]
    masks = outputs["out_binary_masks"]

    print("\n7. Detection result")

    print("Object IDs:", obj_ids)
    print("Probabilities:", probs)
    print("Boxes:", boxes)
    print("Mask shape:", masks.shape)

    print("\n8. Drawing result...")

    result = frame_bgr.copy()

    height, width = result.shape[:2]

    for i in range(len(obj_ids)):
        mask = masks[i]

        # SAM 3.1 mask is already at the original frame resolution
        # for this single-frame input.
        if mask.shape != (height, width):
            mask = cv2.resize(
                mask.astype(np.uint8),
                (width, height),
                interpolation=cv2.INTER_NEAREST,
            ).astype(bool)

        mask = mask.astype(bool)

        # Green segmentation overlay.
        overlay = result.copy()
        overlay[mask] = (
            0.5 * overlay[mask]
            + 0.5 * np.array([0, 255, 0])
        ).astype(np.uint8)

        result = overlay

        # Normalized XYWH -> pixel coordinates.
        x, y, w, h = boxes[i]

        x = int(x * width)
        y = int(y * height)
        w = int(w * width)
        h = int(h * height)

        cv2.rectangle(
            result,
            (x, y),
            (x + w, y + h),
            (0, 255, 0),
            2,
        )

        label = f"{args.prompt} {float(probs[i]):.2f}"

        cv2.putText(
            result,
            label,
            (x, max(y - 10, 20)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (0, 255, 0),
            2,
            cv2.LINE_AA,
        )

    print("9. Saving result...")

    cv2.imwrite(str(output), result)

    print("\n===== REALSENSE + SAM 3.1 TEST SUCCESS =====")
    print(f"Prompt: {args.prompt}")
    print(f"Output: {output}")


if __name__ == "__main__":
    main()
