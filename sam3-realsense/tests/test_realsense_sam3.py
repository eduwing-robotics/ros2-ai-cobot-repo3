import cv2
import numpy as np
import torch
import pyrealsense2 as rs
import time

from sam3.model_builder import build_sam3_multiplex_video_predictor


# ============================================================
# Configuration
# ============================================================

CHECKPOINT = "/home/inhanp/models/sam3.1/sam3.1_multiplex.pt"
PROMPT = "pink plastic crate"

WIDTH = 640
HEIGHT = 480
FPS = 30

SAM3_SIZE = 1008


# ============================================================
# Preprocess
# ============================================================

def preprocess_realsense_frame(frame_bgr):

    frame_rgb = cv2.cvtColor(
        frame_bgr,
        cv2.COLOR_BGR2RGB,
    )

    frame_rgb = cv2.resize(
        frame_rgb,
        (SAM3_SIZE, SAM3_SIZE),
        interpolation=cv2.INTER_LINEAR,
    )

    image = frame_rgb.astype(np.float32) / 255.0

    image = torch.from_numpy(
        image.transpose(2, 0, 1)
    )

    img_mean = torch.tensor(
        [0.485, 0.456, 0.406],
        dtype=torch.float32,
    ).view(3, 1, 1)

    img_std = torch.tensor(
        [0.229, 0.224, 0.225],
        dtype=torch.float32,
    ).view(3, 1, 1)

    image = (image - img_mean) / img_std

    image = image.unsqueeze(0)

    return image


# ============================================================
# Draw results
# ============================================================

def draw_results(frame, result):

    output = frame.copy()

    masks = result.get(
        "out_binary_masks",
        None,
    )

    if masks is None:
        return output

    if torch.is_tensor(masks):
        masks = masks.detach().cpu().numpy()

    boxes = result.get(
        "out_boxes_xywh",
        None,
    )

    probs = result.get(
        "out_probs",
        None,
    )

    obj_ids = result.get(
        "out_obj_ids",
        None,
    )

    if torch.is_tensor(boxes):
        boxes = boxes.detach().cpu().numpy()

    if torch.is_tensor(probs):
        probs = probs.detach().cpu().numpy()

    if torch.is_tensor(obj_ids):
        obj_ids = obj_ids.detach().cpu().numpy()

    for i in range(len(masks)):

        mask = masks[i].astype(bool)

        overlay = output.copy()

        overlay[mask] = (
            0.5 * overlay[mask]
            + 0.5 * np.array([0, 255, 0])
        ).astype(np.uint8)

        output = overlay

        if boxes is not None and i < len(boxes):

            x, y, w, h = boxes[i]

            x = int(x * WIDTH)
            y = int(y * HEIGHT)
            w = int(w * WIDTH)
            h = int(h * HEIGHT)

            x2 = x + w
            y2 = y + h

            cv2.rectangle(
                output,
                (x, y),
                (x2, y2),
                (0, 255, 0),
                2,
            )

            score = 0.0

            if probs is not None and i < len(probs):
                score = float(probs[i])

            obj_id = i

            if obj_ids is not None and i < len(obj_ids):
                obj_id = int(obj_ids[i])

            label = (
                f"{PROMPT} #{obj_id} "
                f"{score:.2f}"
            )

            cv2.putText(
                output,
                label,
                (x, max(20, y - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (0, 255, 0),
                2,
                cv2.LINE_AA,
            )

    return output


# ============================================================
# CUDA timing helper
# ============================================================

def cuda_sync():

    if torch.cuda.is_available():
        torch.cuda.synchronize()


# ============================================================
# Main
# ============================================================

print("1. Starting RealSense...")

pipeline = rs.pipeline()
config = rs.config()

config.enable_stream(
    rs.stream.color,
    WIDTH,
    HEIGHT,
    rs.format.bgr8,
    FPS,
)

pipeline.start(config)

try:

    print("   Warming up camera...")

    for _ in range(10):
        pipeline.wait_for_frames()


    # ========================================================
    # Load SAM3
    # ========================================================

    print("2. Loading SAM3.1...")

    predictor = build_sam3_multiplex_video_predictor(
        checkpoint_path=CHECKPOINT,
        use_fa3=False,
        compile=False,
        warm_up=False,
    )

    print("   SAM3.1 loaded.")


    # ========================================================
    # Create state
    # ========================================================

    print("3. Creating one-frame inference state...")

    state = {}

    state["image_size"] = SAM3_SIZE
    state["num_frames"] = 1
    state["device"] = torch.device("cuda")

    state["orig_height"] = HEIGHT
    state["orig_width"] = WIDTH

    state["constants"] = {}
    state["sam2_inference_states"] = []
    state["tracker_metadata"] = {}
    state["feature_cache"] = {}
    state["is_image_only"] = False


    # ========================================================
    # First frame
    # ========================================================

    frames = pipeline.wait_for_frames()

    color_frame = frames.get_color_frame()

    if not color_frame:
        raise RuntimeError(
            "Failed to get initial RealSense frame."
        )

    frame_bgr = np.asanyarray(
        color_frame.get_data()
    )

    image_tensor = preprocess_realsense_frame(
        frame_bgr
    )


    # ========================================================
    # Construct SAM3 input
    # ========================================================

    predictor.model._construct_initial_input_batch(
        state,
        image_tensor,
    )

    print(
        "   Input tensor:",
        state["input_batch"].img_batch.tensors.shape,
    )


    # ========================================================
    # Text prompt
    # ========================================================

    print(
        "4. Setting prompt:",
        PROMPT,
    )

    state["text_prompt"] = PROMPT

    state["input_batch"].find_text_batch[0] = PROMPT

    text_id = predictor.model.TEXT_ID_FOR_TEXT

    for t in range(state["num_frames"]):

        state["input_batch"].find_inputs[
            t
        ].text_ids[...] = text_id


    # ========================================================
    # Backbone
    # ========================================================

    print("5. Initializing backbone...")

    state["backbone_out"] = (
        predictor.model._init_backbone_out(
            state
        )
    )

    print("   Backbone initialized.")

    print()
    print("==========================================")
    print("Starting timed inference")
    print("Press Q to quit")
    print("==========================================")
    print()


    # ========================================================
    # Timing accumulators
    # ========================================================

    timing_count = 0

    total_times = []
    capture_times = []
    preprocess_times = []
    inference_times = []
    postprocess_times = []
    draw_times = []

    display_fps = 0.0

    last_report = time.perf_counter()


    # ========================================================
    # Live loop
    # ========================================================

    while True:

        loop_start = time.perf_counter()


        # ----------------------------------------------------
        # RealSense capture
        # ----------------------------------------------------

        t0 = time.perf_counter()

        frames = pipeline.wait_for_frames()

        color_frame = frames.get_color_frame()

        if not color_frame:
            continue

        frame_bgr = np.asanyarray(
            color_frame.get_data()
        )

        t1 = time.perf_counter()


        # ----------------------------------------------------
        # Preprocess
        # ----------------------------------------------------

        image_tensor = preprocess_realsense_frame(
            frame_bgr
        )

        t2 = time.perf_counter()


        # ----------------------------------------------------
        # Replace current frame
        # ----------------------------------------------------

        state["input_batch"].img_batch.tensors = (
            image_tensor.to(
                state[
                    "input_batch"
                ].img_batch.tensors.device
            )
        )


        # ----------------------------------------------------
        # Clear per-frame detection cache
        # ----------------------------------------------------

        state["feature_cache"].pop(
            "grounding_cache",
            None,
        )

        state["feature_cache"].pop(
            "multigpu_buffer",
            None,
        )


        # ----------------------------------------------------
        # SAM3 inference
        # ----------------------------------------------------

        cuda_sync()

        inference_start = time.perf_counter()

        with torch.inference_mode():

            output = (
                predictor.model
                ._run_single_frame_inference(
                    state,
                    frame_idx=0,
                    reverse=False,
                )
            )

        cuda_sync()

        inference_end = time.perf_counter()


        # ----------------------------------------------------
        # Postprocess
        # ----------------------------------------------------

        post_start = time.perf_counter()

        result = (
            predictor.model
            ._postprocess_output(
                state,
                output,
            )
        )

        post_end = time.perf_counter()


        # ----------------------------------------------------
        # Draw
        # ----------------------------------------------------

        draw_start = time.perf_counter()

        display = draw_results(
            frame_bgr,
            result,
        )

        draw_end = time.perf_counter()


        # ----------------------------------------------------
        # Timing
        # ----------------------------------------------------

        loop_end = time.perf_counter()

        capture_ms = (
            t1 - t0
        ) * 1000.0

        preprocess_ms = (
            t2 - t1
        ) * 1000.0

        inference_ms = (
            inference_end
            - inference_start
        ) * 1000.0

        postprocess_ms = (
            post_end
            - post_start
        ) * 1000.0

        draw_ms = (
            draw_end
            - draw_start
        ) * 1000.0

        total_ms = (
            loop_end
            - loop_start
        ) * 1000.0


        # ----------------------------------------------------
        # Store timing
        # ----------------------------------------------------

        capture_times.append(capture_ms)
        preprocess_times.append(preprocess_ms)
        inference_times.append(inference_ms)
        postprocess_times.append(postprocess_ms)
        draw_times.append(draw_ms)
        total_times.append(total_ms)

        timing_count += 1


        # ----------------------------------------------------
        # Display current FPS
        # ----------------------------------------------------

        current_fps = (
            1000.0 / total_ms
            if total_ms > 0
            else 0.0
        )

        cv2.putText(
            display,
            f"Loop FPS: {current_fps:.2f}",
            (10, 25),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (0, 255, 0),
            2,
            cv2.LINE_AA,
        )


        # ----------------------------------------------------
        # Show
        # ----------------------------------------------------

        cv2.imshow(
            "RealSense + SAM3.1",
            display,
        )


        key = cv2.waitKey(1) & 0xFF

        if key == ord("q"):
            break


        # ====================================================
        # Print statistics every 5 seconds
        # ====================================================

        now = time.perf_counter()

        if now - last_report >= 5.0:

            def avg(values):
                if not values:
                    return 0.0
                return sum(values) / len(values)

            avg_capture = avg(capture_times)
            avg_preprocess = avg(preprocess_times)
            avg_inference = avg(inference_times)
            avg_postprocess = avg(postprocess_times)
            avg_draw = avg(draw_times)
            avg_total = avg(total_times)

            print()
            print("------------------------------------------")
            print(
                f"Frames measured : {timing_count}"
            )
            print(
                f"RealSense       : {avg_capture:8.2f} ms"
            )
            print(
                f"Preprocess      : {avg_preprocess:8.2f} ms"
            )
            print(
                f"SAM3 inference  : {avg_inference:8.2f} ms"
            )
            print(
                f"Postprocess     : {avg_postprocess:8.2f} ms"
            )
            print(
                f"Drawing         : {avg_draw:8.2f} ms"
            )
            print(
                f"Total loop      : {avg_total:8.2f} ms"
            )

            if avg_total > 0:

                print(
                    f"Effective FPS   : "
                    f"{1000.0 / avg_total:.2f}"
                )

            print("------------------------------------------")
            print()

            # Reset statistics
            timing_count = 0

            total_times.clear()
            capture_times.clear()
            preprocess_times.clear()
            inference_times.clear()
            postprocess_times.clear()
            draw_times.clear()

            last_report = now


finally:

    cv2.destroyAllWindows()

    pipeline.stop()

    print()
    print("RealSense stopped.")
    print("Done.")
