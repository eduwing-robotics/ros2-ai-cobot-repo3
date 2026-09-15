import argparse
from pathlib import Path

import cv2
import numpy as np
import pyrealsense2 as rs
import torch
from PIL import Image

from sam3.model_builder import build_sam3_multiplex_video_predictor


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run SAM 3.1 text-prompt segmentation on two consecutive RealSense frames."
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
        default="realsense_two_frames.png",
        help="Path to save the frame 1 result image.",
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
        print("3. Waiting for camera exposure to stabilize...")

        for _ in range(30):
            pipeline.wait_for_frames()

        print("4. Capturing two consecutive frames...")

        frames_bgr = []

        for i in range(2):
            frames = pipeline.wait_for_frames()
            color_frame = frames.get_color_frame()

            if not color_frame:
                raise RuntimeError(
                    f"Failed to get RealSense frame {i}"
                )

            frame_bgr = np.asanyarray(
                color_frame.get_data()
            ).copy()

            frames_bgr.append(frame_bgr)

            print(
                f"   Frame {i}: "
                f"{frame_bgr.shape[1]} x {frame_bgr.shape[0]}"
            )

    finally:
        pipeline.stop()

    # ---------------------------------------------------------
    # Convert RealSense frames to PIL
    # ---------------------------------------------------------

    print("5. Converting frames to PIL...")

    pil_images = []

    for frame_bgr in frames_bgr:
        frame_rgb = cv2.cvtColor(
            frame_bgr,
            cv2.COLOR_BGR2RGB,
        )

        pil_images.append(
            Image.fromarray(frame_rgb)
        )

    # ---------------------------------------------------------
    # Initialize ONE SAM3 state containing TWO frames
    # ---------------------------------------------------------

    print("6. Initializing SAM3 state with 2 frames...")

    state = predictor.model.init_state(
        resource_path=pil_images,
        offload_video_to_cpu=True,
    )

    print(
        "   num_frames:",
        state["num_frames"],
    )

    # ---------------------------------------------------------
    # Frame 0: text prompt
    # ---------------------------------------------------------

    print(
        f"7. Adding text prompt to frame 0: "
        f"'{args.prompt}'..."
    )

    _, output0 = predictor.model.add_prompt(
        state,
        frame_idx=0,
        text_str=args.prompt,
        output_prob_thresh=0.5,
    )

    print()
    print("===== FRAME 0 =====")

    print(
        "Object IDs:",
        output0["out_obj_ids"],
    )

    print(
        "Probabilities:",
        output0["out_probs"],
    )

    print(
        "Boxes:",
        output0["out_boxes_xywh"],
    )

    print(
        "Mask shape:",
        output0["out_binary_masks"].shape,
    )

    # ---------------------------------------------------------
    # Frame 1: process the next frame
    # ---------------------------------------------------------

    print()
    print("8. Processing frame 1...")

    try:
        with torch.inference_mode():
            output1 = predictor.model._run_single_frame_inference(
                state,
                frame_idx=1,
                reverse=False,
            )

        print()
        print("===== FRAME 1 =====")

        print(
            "Raw output type:",
            type(output1),
        )

        output1 = predictor.model._postprocess_output(
            state,
            output1,
        )

        print(
            "Object IDs:",
            output1["out_obj_ids"],
        )

        print(
            "Probabilities:",
            output1["out_probs"],
        )

        print(
            "Boxes:",
            output1["out_boxes_xywh"],
        )

        print(
            "Mask shape:",
            output1["out_binary_masks"].shape,
        )

    except Exception as e:
        print()
        print("===== FRAME 1 FAILED =====")
        print(type(e).__name__, ":", e)
        raise

    # ---------------------------------------------------------
    # Draw frame 1 result
    # ---------------------------------------------------------

    print()
    print("9. Drawing frame 1 result...")

    result = frames_bgr[1].copy()

    orig_height, orig_width = result.shape[:2]

    obj_ids = output1["out_obj_ids"]
    probs = output1["out_probs"]
    boxes = output1["out_boxes_xywh"]
    masks = output1["out_binary_masks"]

    for i in range(len(obj_ids)):

        # -----------------------------------------------------
        # Bounding box
        # -----------------------------------------------------

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

        # -----------------------------------------------------
        # Mask
        # -----------------------------------------------------

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

        # -----------------------------------------------------
        # Label
        # -----------------------------------------------------

        label = (
            f"{args.prompt} "
            f"ID:{obj_ids[i]} "
            f"{probs[i]:.3f}"
        )

        cv2.putText(
            result,
            label,
            (x1, max(y1 - 10, 20)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (0, 255, 0),
            2,
            cv2.LINE_AA,
        )

    # ---------------------------------------------------------
    # Save
    # ---------------------------------------------------------

    print("10. Saving result...")

    cv2.imwrite(
        str(output),
        result,
    )

    print()
    print("========================================")
    print("===== TWO-FRAME TEST SUCCESS =====")
    print("========================================")
    print()
    print("Prompt:", args.prompt)
    print("Output:")
    print(output)


if __name__ == "__main__":
    main()
