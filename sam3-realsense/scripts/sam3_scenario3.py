#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
FR5 + RealSense + SAM3 + AprilTag 36h11 ID18
Automatic pink-crate pickup -> AprilTag search -> placement.

Sequence:
    1. Move to predefined safe observation WObj pose.
    2. Activate gripper and prepare at pos=15.
    3. Detect pink crate with SAM3.
    4. Center SAM3 centroid to image center using the verified method.
    5. Apply measured CENTER -> PICKUP relative offset.
    6. Close gripper at pos=3 and lift.
    7. Move from pickup position toward the expected AprilTag area using
       the measured Pickup -> Tag-center displacement.
    8. Search for AprilTag 36h11 ID18 in a rectangular pattern.
    9. Stop searching immediately when ID18 is detected.
   10. Center the AprilTag in the camera image using the same verified
       Camera XY -> Tool XY visual-centering method.
   11. Apply the fixed Tag-center -> basket-floor displacement:
           X = +213.159 mm
           Y =  -59.065 mm
           Z = -173.121 mm
   12. Release gripper at pos=15.
   13. Finish.

Robot motion is enabled.
ROBOT_SPEED remains 10%.
No manual SPACE is required in the final automatic sequence.
"""

import sys
import time
import threading

import cv2
import numpy as np
import torch
import pyrealsense2 as rs

from PIL import Image


# ============================================================
# PATHS
# ============================================================
SAM3_ROOT = "/home/inhanp/sam_project/sam3"
FAIRINO_ROOT = "/home/inhanp/fairino-python-sdk-main/linux"

if SAM3_ROOT not in sys.path:
    sys.path.insert(0, SAM3_ROOT)

if FAIRINO_ROOT not in sys.path:
    sys.path.insert(0, FAIRINO_ROOT)

from fairino import Robot
from sam3.model_builder import build_sam3_multiplex_video_predictor


# ============================================================
# CONFIG
# ============================================================
ROBOT_IP = "192.168.58.2"
CHECKPOINT = "/home/inhanp/models/sam3.1/sam3.1_multiplex.pt"

ROBOT_SPEED = 10.0
RETURN_SPEED = 30.0
ROBOT_ACC = 100.0
ROBOT_OVL = 100.0

FPS = 30
WIDTH = 640
HEIGHT = 480

PROMPT = "pink plastic crate"
OUTPUT_PROB_THRESH = 0.5

TOOL = 1
USER = 1


# ============================================================
# GRIPPER
# ============================================================
# Same startup/open constant from the uploaded verified pickup script.
GRIPPER_INDEX = 1
GRIPPER_PREP_POS = 20
GRIPPER_PICK_POS = 3

GRIPPER_VEL = 50
GRIPPER_FORCE = 75
GRIPPER_MAXTIME = 3000
GRIPPER_BLOCK = 1
GRIPPER_TYPE = 0
GRIPPER_ROTN = 0
GRIPPER_ROTVEL = 0
GRIPPER_ROTTORQUE = 0


# ============================================================
# IMAGE / CENTERING
# ============================================================
IMAGE_CENTER_X = WIDTH // 2
IMAGE_CENTER_Y = HEIGHT // 2

IMAGE_CENTER_TOLERANCE_PX = 3.0
FINAL_CHECK_TOLERANCE_PX = 5.0

MIN_DEPTH_M = 0.10
MAX_DEPTH_M = 2.0

CENTER_MAX_ITERATIONS = 30
MIN_CENTER_STEP_MM = 0.5


# ============================================================
# CONTINUOUS CAMERA VIEW
# ============================================================
# The RealSense pipeline is owned by one background capture thread.
# This avoids calling wait_for_frames() simultaneously from the robot
# control thread and the display thread.
camera_view_thread = None
camera_view_running = False
camera_view_lock = threading.Lock()

latest_view_image = None
latest_depth_image = None
depth_scale = 0.001

latest_view_status = "CAMERA STARTING..."
latest_view_mode = "plain"
latest_view_result = None
camera_view_abort_requested = False


def camera_view_worker():
    global latest_view_image
    global latest_depth_image
    global latest_view_status
    global camera_view_running

    while camera_view_running:
        try:
            frames = pipeline.wait_for_frames()
            aligned = align.process(frames)

            color_frame = aligned.get_color_frame()
            depth_frame = aligned.get_depth_frame()

            if not color_frame or not depth_frame:
                continue

            color_image = np.asanyarray(
                color_frame.get_data()
            ).copy()

            depth_image = np.asanyarray(
                depth_frame.get_data()
            ).copy()

            with camera_view_lock:
                latest_view_image = color_image
                latest_depth_image = depth_image

        except Exception as exc:
            with camera_view_lock:
                latest_view_status = f"CAMERA VIEW ERROR: {exc}"
            time.sleep(0.05)


def draw_camera_monitor_view(image, mode, result, status):
    view = image.copy()

    cv2.drawMarker(
        view,
        (
            IMAGE_CENTER_X,
            IMAGE_CENTER_Y,
        ),
        (255, 255, 255),
        cv2.MARKER_CROSS,
        28,
        2,
    )

    if mode == "sam" and result is not None:
        mask = result.get("mask")
        center_x = result.get("center_x")
        center_y = result.get("center_y")

        if mask is not None:
            mask_bool = np.squeeze(mask).astype(bool)

            if mask_bool.shape[:2] == view.shape[:2]:
                overlay = view.copy()
                overlay[mask_bool] = (0, 180, 0)
                view = cv2.addWeighted(
                    view,
                    0.55,
                    overlay,
                    0.45,
                    0,
                )

                mask_u8 = (
                    mask_bool.astype(np.uint8) * 255
                )

                contours, _ = cv2.findContours(
                    mask_u8,
                    cv2.RETR_EXTERNAL,
                    cv2.CHAIN_APPROX_SIMPLE,
                )

                cv2.drawContours(
                    view,
                    contours,
                    -1,
                    (0, 255, 0),
                    2,
                )

        if center_x is not None and center_y is not None:
            cv2.circle(
                view,
                (
                    int(round(center_x)),
                    int(round(center_y)),
                ),
                7,
                (0, 0, 255),
                -1,
            )

    elif mode == "tag" and result is not None:
        pts = result.get("corners")

        if pts is not None:
            cv2.polylines(
                view,
                [np.asarray(pts).astype(np.int32)],
                True,
                (0, 255, 0),
                3,
            )

            cx = int(round(result["center_x"]))
            cy = int(round(result["center_y"]))

            cv2.circle(
                view,
                (cx, cy),
                7,
                (0, 0, 255),
                -1,
            )

            cv2.line(
                view,
                (IMAGE_CENTER_X, IMAGE_CENTER_Y),
                (cx, cy),
                (0, 0, 255),
                2,
            )

            cv2.putText(
                view,
                f"Tag center: ({cx}, {cy})",
                (20, 35),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.65,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )

    cv2.putText(
        view,
        status,
        (20, HEIGHT - 20),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.62,
        (0, 255, 255),
        2,
        cv2.LINE_AA,
    )

    return view


def set_camera_view_status(status):
    global latest_view_status

    with camera_view_lock:
        latest_view_status = str(status)


def set_camera_view_result(mode, result):
    global latest_view_mode
    global latest_view_result

    with camera_view_lock:
        latest_view_mode = mode
        latest_view_result = result


def clear_camera_view_result():
    global latest_view_mode
    global latest_view_result

    with camera_view_lock:
        latest_view_mode = "plain"
        latest_view_result = None


def get_latest_camera_data():
    with camera_view_lock:
        if latest_view_image is None:
            return None, None

        color_image = latest_view_image.copy()

        if latest_depth_image is None:
            depth_image = None
        else:
            depth_image = latest_depth_image.copy()

    return color_image, depth_image


def camera_view_gui_worker():
    global camera_view_abort_requested

    while camera_view_running:
        try:
            with camera_view_lock:
                image = (
                    None
                    if latest_view_image is None
                    else latest_view_image.copy()
                )
                mode = latest_view_mode
                result = latest_view_result
                status = latest_view_status

            if image is not None:
                view = draw_camera_monitor_view(
                    image,
                    mode,
                    result,
                    status,
                )

                cv2.imshow(
                    "SAM3 + AprilTag Placement",
                    view,
                )

                key = cv2.waitKey(1) & 0xFF

                if key in (27, ord("q")):
                    camera_view_abort_requested = True
                    break

        except Exception:
            pass

        time.sleep(0.01)


def start_camera_view():
    global camera_view_thread
    global camera_view_running
    global camera_view_abort_requested

    camera_view_abort_requested = False
    camera_view_running = True

    camera_view_thread = threading.Thread(
        target=camera_view_worker,
        daemon=True,
    )
    camera_view_thread.start()

    # Give the capture thread a moment to acquire the first frame.
    time.sleep(0.1)

    gui_thread = threading.Thread(
        target=camera_view_gui_worker,
        daemon=True,
    )
    gui_thread.start()


def stop_camera_view():
    global camera_view_running
    global camera_view_thread

    camera_view_running = False

    if camera_view_thread is not None:
        camera_view_thread.join(timeout=1.0)
        camera_view_thread = None


# ============================================================
# VERIFIED CAMERA <-> TOOL XY RELATION
# ============================================================
CAMERA_FROM_TOOL = np.array([
    [-1.11, -0.51],
    [ 0.00, -0.43],
], dtype=np.float64)

TOOL_FROM_CAMERA = np.linalg.inv(CAMERA_FROM_TOOL)


def get_xy_axis_step_limit(camera_error_mm):
    abs_error = abs(float(camera_error_mm))

    if abs_error > 30.0:
        return 10.0
    elif abs_error > 20.0:
        return 5.0
    else:
        return 2.0


# ============================================================
# START / PICKUP WOBJ
# ============================================================
START_WOBJ_POSE = np.array([
    353.688,
    -1116.596,
    -0.086,
    179.996,
    0.003,
    179.999,
], dtype=np.float64)

CENTERED_WOBJ_REFERENCE = np.array([
    304.418,
    -1054.139,
    -0.159,
    179.995,
    0.004,
    179.994,
], dtype=np.float64)

PICKUP_WOBJ_TARGET = np.array([
    381.428,
    -1131.916,
    -283.654,
    179.996,
    0.004,
    179.994,
], dtype=np.float64)

# New placement WObj measured by the user after the pickup
# position was changed.
# Scenario 3 placement WObj target measured by the user.
PLACEMENT_WOBJ_TARGET = np.array([
    -178.844,
    -653.648,
    -296.135,  # 5 mm higher than the previous placement height
    179.904,
    1.116,
    -179.368,
], dtype=np.float64)

LIFT_WOBJ_Z_MM = START_WOBJ_POSE[2]


# ============================================================
# PICKUP -> TAG CENTER EXPECTED POSITION
# ============================================================
# Measured from the user's recorded WObj values:
#
# Pickup immediately after gripping:
#   (379.198, -1133.870, -0.088)
#
# AprilTag ID18 camera-centered:
#   (319.236, -859.499, -0.098)
#
# Therefore:
#   dX = -59.962 mm
#   dY = +274.371 mm
#   dZ = -0.010 mm
#
# This is used ONLY to move toward the expected Tag search area.
# It is NOT the placement offset.
PICKUP_TO_TAG_EXPECTED_DELTA = np.array([
    -59.962,
    +274.371,
    -0.010,
], dtype=np.float64)


# ============================================================
# TAG CENTER -> BASKET FLOOR FIXED OFFSET
# ============================================================
# Measured:
#
# Tag-centered:
#   (319.236, -859.499, -0.098)
#
# Pink crate touching basket floor:
#   (532.395, -918.564, -173.219)
#
# Fixed placement displacement:
#   dX = +213.159 mm
#   dY =  -59.065 mm
#   dZ = -173.121 mm
#
# This is the fixed placement movement applied AFTER Tag centering.
TAG_TO_BASKET_FLOOR_DELTA = np.array([
    +213.159,
    -59.065,
    -173.121,
], dtype=np.float64)


# ============================================================
# RECTANGULAR TAG SEARCH
# ============================================================
# The expected Tag location is the center of this search rectangle.
#
# The robot first checks the expected center, then follows the rectangle
# perimeter. The rectangle uses +/-60 mm in both Tool XY axes.
#
# Search order:
#       (-60,+60) -------- (+60,+60)
#            |                  |
#            |     expected     |
#            |       Tag        |
#            |                  |
#       (-60,-60) -------- (+60,-60)
#
# Each corner is checked after the robot reaches it.
SEARCH_HALF_X_MM = 60.0
SEARCH_HALF_Y_MM = 60.0

RECTANGLE_SEARCH_POINTS = [
    (0.0, 0.0),  # expected center
    (+SEARCH_HALF_X_MM, +SEARCH_HALF_Y_MM),
    (-SEARCH_HALF_X_MM, +SEARCH_HALF_Y_MM),
    (-SEARCH_HALF_X_MM, -SEARCH_HALF_Y_MM),
    (+SEARCH_HALF_X_MM, -SEARCH_HALF_Y_MM),
    (+SEARCH_HALF_X_MM, +SEARCH_HALF_Y_MM),
]

APRILTAG_ID = 18

# The robot does not make one long MoveL along a rectangle edge.
# Each edge is divided into small Tool-XY moves, and AprilTag detection
# is performed after every move. This allows the search to stop as soon
# as the target is observed instead of waiting for a corner.
APRILTAG_SEARCH_MOVE_STEP_MM = 5.0

# No repeated "tag found" message is printed during normal operation.


# ============================================================
# ROBOT HELPERS
# ============================================================
def get_tcp_pose(robot):
    ret = robot.GetActualTCPPose()

    if isinstance(ret, tuple):
        code, pose = ret
        if code != 0:
            raise RuntimeError(
                f"GetActualTCPPose failed: {code}"
            )
        return np.array(pose, dtype=np.float64)

    return np.array(ret, dtype=np.float64)


def move_tool_offset(robot, dx, dy, dz=0.0):
    current_pose = get_tcp_pose(robot)

    clear_camera_view_result()
    set_camera_view_status(
        f"ROBOT MOVING - Tool X={dx:+.1f} Y={dy:+.1f} Z={dz:+.1f} mm"
    )

    print()
    print(
        f"[MOVE] Tool offset: "
        f"X={dx:+.3f} Y={dy:+.3f} Z={dz:+.3f} mm"
    )

    err = robot.MoveL(
        desc_pos=current_pose.tolist(),
        tool=TOOL,
        user=USER,
        vel=ROBOT_SPEED,
        acc=ROBOT_ACC,
        ovl=ROBOT_OVL,
        blendR=-1.0,
        blendMode=0,
        search=0,
        offset_flag=2,
        offset_pos=[
            float(dx),
            float(dy),
            float(dz),
            0.0,
            0.0,
            0.0,
        ],
        config=-1,
    )

    if err != 0:
        raise RuntimeError(
            f"MoveL failed: {err}"
        )

    time.sleep(0.3)

    actual = get_tcp_pose(robot)

    print(
        f"[MOVE] Actual TCP: "
        f"X={actual[0]:+.3f} "
        f"Y={actual[1]:+.3f} "
        f"Z={actual[2]:+.3f}"
    )

    return actual


def move_wobj_target(robot, target_pose, label, speed=None):
    target_pose = np.asarray(
        target_pose,
        dtype=np.float64,
    )

    clear_camera_view_result()
    set_camera_view_status(
        f"ROBOT MOVING - {label}"
    )

    print()
    print(f"[MOVE] WObj target: {label}")
    print(
        f"[MOVE] X={target_pose[0]:+.3f} "
        f"Y={target_pose[1]:+.3f} "
        f"Z={target_pose[2]:+.3f}"
    )

    move_speed = ROBOT_SPEED if speed is None else float(speed)

    print(f"[MOVE] Speed = {move_speed:.1f}%")

    err = robot.MoveL(
        desc_pos=target_pose.tolist(),
        tool=TOOL,
        user=USER,
        vel=move_speed,
        acc=ROBOT_ACC,
        ovl=ROBOT_OVL,
        blendR=-1.0,
        blendMode=0,
        search=0,
        offset_flag=0,
        offset_pos=[
            0.0, 0.0, 0.0,
            0.0, 0.0, 0.0,
        ],
        config=-1,
    )

    if err != 0:
        raise RuntimeError(
            f"MoveL failed: {err}"
        )

    time.sleep(0.5)

    return get_tcp_pose(robot)


def return_to_start_pose(robot):
    """
    Return the robot to START_WOBJ_POSE using a collision-conscious
    two-stage Cartesian path:

        1. Move only in Z to START_WOBJ_POSE[2].
        2. After Z movement is complete, move only in X/Y to
           START_WOBJ_POSE[0:2].
        3. Restore the original start-pose orientation.
    """
    print()
    print("========================================")
    print("RETURN TO START POSITION")
    print("========================================")

    current_pose = get_tcp_pose(robot)

    # Return-to-start is a non-working travel section, so use the faster
    # return speed for both Z and X/Y moves. Restore the normal working
    # speed immediately after the return is complete.
    robot.SetSpeed(RETURN_SPEED)
    print(f"[RETURN] Speed = {RETURN_SPEED:.1f}%")

    try:
        # --------------------------------------------------------
        # Stage 1: Z only
        # --------------------------------------------------------
        print("[RETURN] Stage 1: Z-axis movement")
        print(
            f"[RETURN] Target Z={START_WOBJ_POSE[2]:+.3f} mm"
        )

        z_target = current_pose.copy()
        z_target[2] = START_WOBJ_POSE[2]

        move_wobj_target(
            robot,
            z_target,
            "return start Z",
            speed=RETURN_SPEED,
        )

        # --------------------------------------------------------
        # Stage 2: X/Y only
        # --------------------------------------------------------
        print("[RETURN] Stage 2: X/Y movement")

        xy_target = get_tcp_pose(robot)
        xy_target[0] = START_WOBJ_POSE[0]
        xy_target[1] = START_WOBJ_POSE[1]

        # Orientation is restored only after the robot has reached
        # the safe start height.
        xy_target[3:] = START_WOBJ_POSE[3:]

        move_wobj_target(
            robot,
            xy_target,
            "return start XY",
            speed=RETURN_SPEED,
        )

        print(
            "[RETURN] Robot returned to program-start position."
        )
    finally:
        robot.SetSpeed(ROBOT_SPEED)
        print(f"[RETURN] Restored working speed = {ROBOT_SPEED:.1f}%")


def move_gripper(robot, pos):
    ret = robot.MoveGripper(
        GRIPPER_INDEX,
        pos,
        GRIPPER_VEL,
        GRIPPER_FORCE,
        GRIPPER_MAXTIME,
        GRIPPER_BLOCK,
        GRIPPER_TYPE,
        GRIPPER_ROTN,
        GRIPPER_ROTVEL,
        GRIPPER_ROTTORQUE,
    )

    if ret != 0:
        raise RuntimeError(
            f"MoveGripper failed: error={ret}"
        )


# ============================================================
# REALSENSE / DEPTH
# ============================================================
def get_camera_xyz(mask, depth_image, intrinsics):
    ys, xs = np.where(mask)

    if len(xs) == 0:
        return None

    center_x = int(np.mean(xs))
    center_y = int(np.mean(ys))

    mask_depths = []

    for y, x in zip(ys, xs):
        raw_depth = depth_image[int(y), int(x)]
        depth = float(raw_depth) * depth_scale

        if depth < MIN_DEPTH_M:
            continue

        if depth > MAX_DEPTH_M:
            continue

        mask_depths.append(depth)

    selected_depths = None

    for radius in (5, 15, 30):
        depths = []

        x1 = max(0, center_x - radius)
        x2 = min(WIDTH, center_x + radius + 1)
        y1 = max(0, center_y - radius)
        y2 = min(HEIGHT, center_y + radius + 1)

        for y in range(y1, y2):
            for x in range(x1, x2):
                raw_depth = depth_image[y, x]
                depth = float(raw_depth) * depth_scale

                if depth < MIN_DEPTH_M:
                    continue

                if depth > MAX_DEPTH_M:
                    continue

                depths.append(depth)

        if depths:
            selected_depths = depths
            break

    if selected_depths is None:
        if not mask_depths:
            return None

        selected_depths = mask_depths

    depth_m = float(np.median(selected_depths))

    point = rs.rs2_deproject_pixel_to_point(
        intrinsics,
        [center_x, center_y],
        depth_m,
    )

    return (
        center_x,
        center_y,
        point[0] * 1000.0,
        point[1] * 1000.0,
        point[2] * 1000.0,
    )



# ============================================================
# SAM3
# ============================================================
def detect_crate(
    predictor,
    color_image,
    depth_image,
    intrinsics,
):
    rgb = cv2.cvtColor(
        color_image,
        cv2.COLOR_BGR2RGB,
    )

    pil_image = Image.fromarray(rgb)

    state = predictor.model.init_state(
        resource_path=[pil_image],
        offload_video_to_cpu=True,
        async_loading_frames=False,
    )

    with torch.inference_mode():

        _, output = predictor.model.add_prompt(
            state,
            frame_idx=0,
            text_str=PROMPT,
            output_prob_thresh=OUTPUT_PROB_THRESH,
        )

    probs = output["out_probs"]
    masks = output["out_binary_masks"]

    if len(probs) == 0:
        return None

    candidate_indices = []
    candidate_distances = []

    for index, candidate_mask in enumerate(masks):

        if hasattr(candidate_mask, "cpu"):
            candidate_mask = (
                candidate_mask.cpu().numpy()
            )

        candidate_mask = (
            np.squeeze(candidate_mask)
            .astype(bool)
        )

        ys, xs = np.where(
            candidate_mask
        )

        if len(xs) == 0:
            continue

        candidate_center_x = float(
            np.mean(xs)
        )
        candidate_center_y = float(
            np.mean(ys)
        )

        distance = float(
            np.hypot(
                candidate_center_x
                - IMAGE_CENTER_X,
                candidate_center_y
                - IMAGE_CENTER_Y,
            )
        )

        candidate_indices.append(index)
        candidate_distances.append(distance)

    if not candidate_indices:
        return None

    nearest_position = int(
        np.argmin(
            np.asarray(
                candidate_distances
            )
        )
    )

    best_index = candidate_indices[
        nearest_position
    ]

    mask = masks[best_index]

    if hasattr(mask, "cpu"):
        mask = mask.cpu().numpy()

    mask = np.squeeze(mask).astype(bool)

    xyz = get_camera_xyz(
        mask,
        depth_image,
        intrinsics,
    )

    if xyz is None:
        return None

    center_x, center_y, camera_x, camera_y, camera_z = xyz

    return {
        "mask": mask,
        "probability": float(
            probs[best_index]
        ),
        "center_x": center_x,
        "center_y": center_y,
        "camera_x": camera_x,
        "camera_y": camera_y,
        "camera_z": camera_z,
    }


def draw_sam_view(
    image,
    result,
    status,
):
    view = image.copy()

    cv2.drawMarker(
        view,
        (
            IMAGE_CENTER_X,
            IMAGE_CENTER_Y,
        ),
        (255, 255, 255),
        cv2.MARKER_CROSS,
        28,
        2,
    )

    if result is not None:

        mask = result.get("mask")
        center_x = result.get("center_x")
        center_y = result.get("center_y")

        if (
            mask is not None
            and center_x is not None
            and center_y is not None
        ):

            mask_bool = (
                np.squeeze(mask)
                .astype(bool)
            )

            if mask_bool.shape[:2] == view.shape[:2]:

                overlay = view.copy()
                overlay[mask_bool] = (
                    0, 180, 0
                )

                view = cv2.addWeighted(
                    view,
                    0.55,
                    overlay,
                    0.45,
                    0,
                )

                mask_u8 = (
                    mask_bool.astype(
                        np.uint8
                    )
                    * 255
                )

                contours, _ = cv2.findContours(
                    mask_u8,
                    cv2.RETR_EXTERNAL,
                    cv2.CHAIN_APPROX_SIMPLE,
                )

                cv2.drawContours(
                    view,
                    contours,
                    -1,
                    (0, 255, 0),
                    2,
                )

            cv2.circle(
                view,
                (
                    int(center_x),
                    int(center_y),
                ),
                7,
                (0, 0, 255),
                -1,
            )

    cv2.putText(
        view,
        status,
        (20, HEIGHT - 20),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.62,
        (0, 255, 255),
        2,
        cv2.LINE_AA,
    )

    return view


def acquire_crate_result(
    predictor,
    pipeline,
    align,
    intrinsics,
    status,
):
    color_image, depth_image = get_latest_camera_data()

    if color_image is None or depth_image is None:
        return None, True

    result = detect_crate(
        predictor,
        color_image,
        depth_image,
        intrinsics,
    )

    set_camera_view_status(status)
    set_camera_view_result(
        "sam",
        result,
    )

    if camera_view_abort_requested:
        return result, False

    return result, True



# ============================================================
# APRILTAG
# ============================================================
apriltag_dictionary = (
    cv2.aruco.getPredefinedDictionary(
        cv2.aruco.DICT_APRILTAG_36h11
    )
)

apriltag_parameters = (
    cv2.aruco.DetectorParameters()
)

if hasattr(
    cv2.aruco,
    "CORNER_REFINE_APRILTAG",
):
    apriltag_parameters.cornerRefinementMethod = (
        cv2.aruco.CORNER_REFINE_APRILTAG
    )

apriltag_detector = cv2.aruco.ArucoDetector(
    apriltag_dictionary,
    apriltag_parameters,
)


def detect_apriltag(
    color_image,
):
    corners, ids, _ = (
        apriltag_detector.detectMarkers(
            color_image
        )
    )

    if ids is None:
        return None

    for i, marker_id in enumerate(
        ids.flatten()
    ):

        if int(marker_id) != APRILTAG_ID:
            continue

        pts = corners[i].reshape(
            4,
            2,
        )

        center_x = float(
            np.mean(pts[:, 0])
        )
        center_y = float(
            np.mean(pts[:, 1])
        )

        return {
            "center_x": center_x,
            "center_y": center_y,
            "corners": pts.copy(),
        }

    return None


def get_apriltag_frame():
    color_image, _ = get_latest_camera_data()
    return color_image



def draw_apriltag_view(
    image,
    tag,
    status,
):
    view = image.copy()

    cv2.drawMarker(
        view,
        (
            IMAGE_CENTER_X,
            IMAGE_CENTER_Y,
        ),
        (255, 0, 255),
        cv2.MARKER_CROSS,
        24,
        2,
    )

    if tag is not None:

        pts = tag["corners"]

        cv2.polylines(
            view,
            [
                pts.astype(
                    np.int32
                )
            ],
            True,
            (0, 255, 0),
            3,
        )

        cx = int(
            round(
                tag["center_x"]
            )
        )
        cy = int(
            round(
                tag["center_y"]
            )
        )

        cv2.circle(
            view,
            (cx, cy),
            7,
            (0, 0, 255),
            -1,
        )

        cv2.line(
            view,
            (
                IMAGE_CENTER_X,
                IMAGE_CENTER_Y,
            ),
            (cx, cy),
            (0, 0, 255),
            2,
        )

        cv2.putText(
            view,
            f"Tag center: ({cx}, {cy})",
            (20, 35),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )

    cv2.putText(
        view,
        status,
        (20, HEIGHT - 20),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.62,
        (0, 255, 255),
        2,
        cv2.LINE_AA,
    )

    return view


def check_tag_and_display(status):
    image = get_apriltag_frame()

    if image is None:
        return None, True

    tag = detect_apriltag(image)

    set_camera_view_status(status)
    set_camera_view_result(
        "tag",
        tag,
    )

    if camera_view_abort_requested:
        return tag, False

    return tag, True



# ============================================================
# APRILTAG RECTANGULAR SEARCH
# ============================================================
def search_apriltag_rectangle(
    robot,
):
    print()
    print("========================================")
    print("STEP 6: APRILTAG RECTANGULAR SEARCH")
    print("========================================")
    print(
        f"Target: AprilTag 36h11 / ID {APRILTAG_ID}"
    )
    print(
        f"Rectangle: "
        f"X +/-{SEARCH_HALF_X_MM:.1f} mm, "
        f"Y +/-{SEARCH_HALF_Y_MM:.1f} mm"
    )
    print(
        f"Detection interval: every "
        f"{APRILTAG_SEARCH_MOVE_STEP_MM:.1f} mm"
    )
    print()

    # We are already at the expected Tag location when this function starts.
    # Check it before beginning the rectangle.
    tag, keep_running = check_tag_and_display(
        "TAG SEARCH - CENTER - Q/ESC = ABORT"
    )

    if not keep_running:
        return None

    if tag is not None:
        print("[SEARCH] Target detected at the expected location. Search stopped.")
        return tag

    # Rectangle vertices, expressed relative to the expected Tag location.
    # The first point (0, 0) has already been checked above.
    points = [
        (+SEARCH_HALF_X_MM, +SEARCH_HALF_Y_MM),
        (-SEARCH_HALF_X_MM, +SEARCH_HALF_Y_MM),
        (-SEARCH_HALF_X_MM, -SEARCH_HALF_Y_MM),
        (+SEARCH_HALF_X_MM, -SEARCH_HALF_Y_MM),
        (+SEARCH_HALF_X_MM, +SEARCH_HALF_Y_MM),
    ]

    current_x = 0.0
    current_y = 0.0

    for edge_index, (target_x, target_y) in enumerate(points, start=1):
        dx_total = float(target_x) - current_x
        dy_total = float(target_y) - current_y

        distance = float(np.hypot(dx_total, dy_total))
        steps = max(
            1,
            int(np.ceil(
                distance / APRILTAG_SEARCH_MOVE_STEP_MM
            )),
        )

        dx = dx_total / steps
        dy = dy_total / steps

        print(
            f"[SEARCH] Edge {edge_index}/{len(points)}: "
            f"to Tool X={target_x:+.1f} mm, "
            f"Y={target_y:+.1f} mm "
            f"({steps} checks)"
        )

        for step_index in range(steps):
            # Small Tool-coordinate movement. After this command returns,
            # immediately acquire a fresh camera frame and test the Tag.
            move_tool_offset(
                robot,
                dx,
                dy,
                0.0,
            )

            current_x += dx
            current_y += dy

            tag, keep_running = check_tag_and_display(
                f"TAG SEARCH - X={current_x:+.1f} "
                f"Y={current_y:+.1f} - Q/ESC = ABORT"
            )

            if not keep_running:
                return None

            if tag is not None:
                print(
                    "[SEARCH] Target detected. "
                    "Rectangle search stopped immediately."
                )
                return tag

    print(
        "[SEARCH] Rectangle search completed "
        "without finding the target."
    )

    return None


# ============================================================
# APRILTAG CENTERING
# ============================================================
def center_apriltag(robot):
    print()
    print("========================================")
    print("STEP 7: APRILTAG CENTERING")
    print("========================================")

    for iteration in range(
        1,
        CENTER_MAX_ITERATIONS + 1,
    ):

        tag, keep_running = (
            check_tag_and_display(
                f"CENTER {iteration}/{CENTER_MAX_ITERATIONS}"
            )
        )

        if not keep_running:
            return False

        if tag is None:
            print(
                "[CENTER] AprilTag temporarily unavailable."
            )
            time.sleep(0.1)
            continue

        center_x = float(
            tag["center_x"]
        )
        center_y = float(
            tag["center_y"]
        )

        pixel_error_x = (
            IMAGE_CENTER_X
            - center_x
        )
        pixel_error_y = (
            IMAGE_CENTER_Y
            - center_y
        )

        print()
        print(
            f"[CENTER] Iteration "
            f"{iteration}/{CENTER_MAX_ITERATIONS}"
        )
        print(
            f"[CENTER] AprilTag center = "
            f"({center_x:.0f}, {center_y:.0f}) px"
        )
        print(
            f"[CENTER] Image center = "
            f"({IMAGE_CENTER_X}, {IMAGE_CENTER_Y}) px"
        )
        print(
            f"[CENTER] Pixel error = "
            f"X={pixel_error_x:+.1f}, "
            f"Y={pixel_error_y:+.1f} px"
        )

        if (
            abs(pixel_error_x)
            <= IMAGE_CENTER_TOLERANCE_PX
            and
            abs(pixel_error_y)
            <= IMAGE_CENTER_TOLERANCE_PX
        ):

            print(
                "[CENTER] AprilTag reached image center."
            )
            return True

        current_pose = get_tcp_pose(
            robot
        )


        # For centering, use the latest continuously captured
        # depth image at the AprilTag center.
        _, depth_image = get_latest_camera_data()

        if depth_image is None:
            print(
                "[CENTER] Depth unavailable."
            )
            return False

        cx = int(round(center_x))
        cy = int(round(center_y))

        raw_depth = depth_image[cy, cx]
        depth_m = float(raw_depth) * depth_scale

        if (
            depth_m < MIN_DEPTH_M
            or depth_m > MAX_DEPTH_M
        ):
            # Use a small neighborhood median if the exact center is invalid.
            depths = []

            for yy in range(
                max(0, cy - 5),
                min(HEIGHT, cy + 6),
            ):
                for xx in range(
                    max(0, cx - 5),
                    min(WIDTH, cx + 6),
                ):
                    d = float(
                        depth_image[yy, xx]
                    ) * depth_scale

                    if (
                        d >= MIN_DEPTH_M
                        and d <= MAX_DEPTH_M
                    ):
                        depths.append(d)

            if not depths:
                print(
                    "[CENTER] Valid depth unavailable."
                )
                return False

            depth_m = float(
                np.median(depths)
            )

        current_point = (
            rs.rs2_deproject_pixel_to_point(
                intrinsics,
                [
                    center_x,
                    center_y,
                ],
                depth_m,
            )
        )

        target_point = (
            rs.rs2_deproject_pixel_to_point(
                intrinsics,
                [
                    IMAGE_CENTER_X,
                    IMAGE_CENTER_Y,
                ],
                depth_m,
            )
        )

        camera_error = np.array([
            (
                target_point[0]
                - current_point[0]
            ) * 1000.0,
            (
                target_point[1]
                - current_point[1]
            ) * 1000.0,
        ], dtype=np.float64)

        print(
            f"[CENTER] Camera XY correction = "
            f"X={camera_error[0]:+.2f}, "
            f"Y={camera_error[1]:+.2f} mm"
        )

        tool_xy = (
            TOOL_FROM_CAMERA
            @ camera_error
        )

        move_x = float(
            tool_xy[0]
        )
        move_y = float(
            tool_xy[1]
        )

        x_limit = get_xy_axis_step_limit(
            camera_error[0]
        )
        y_limit = get_xy_axis_step_limit(
            camera_error[1]
        )

        move_x = float(
            np.clip(
                move_x,
                -x_limit,
                +x_limit,
            )
        )

        move_y = float(
            np.clip(
                move_y,
                -y_limit,
                +y_limit,
            )
        )

        if abs(move_x) < MIN_CENTER_STEP_MM:
            move_x = 0.0

        if abs(move_y) < MIN_CENTER_STEP_MM:
            move_y = 0.0

        print(
            f"[CENTER] Tool correction = "
            f"X={move_x:+.2f}, "
            f"Y={move_y:+.2f} mm"
        )

        if (
            move_x == 0.0
            and move_y == 0.0
        ):
            print(
                "[CENTER] Correction below minimum step."
            )
            return False

        move_tool_offset(
            robot,
            move_x,
            move_y,
            0.0,
        )

    print(
        "[CENTER] Maximum iterations reached."
    )

    return False


# ============================================================
# MAIN
# ============================================================
def main():

    global pipeline
    global align
    global intrinsics

    robot = None
    pipeline = None

    try:

        print()
        print("========================================")
        print("SAM3 SCENARIO 3: BASKET CRATE PICKUP -> PLACE -> START")
        print("========================================")
        print(f"Robot speed = {ROBOT_SPEED}%")
        print(f"AprilTag = 36h11 / ID {APRILTAG_ID}")
        print()
        print("Robot motion is ENABLED.")
        print("Automatic sequence starts immediately.")
        print("========================================")

        # ----------------------------------------------------
        # Robot
        # ----------------------------------------------------
        print("\n[ROBOT] Connecting to FR5...")

        robot = Robot.RPC(ROBOT_IP)

        if robot is None:
            raise RuntimeError("Robot.RPC() returned None.")

        robot.SetSpeed(ROBOT_SPEED)
        print("[ROBOT] Connected.")

        # ----------------------------------------------------
        # SAM3
        # ----------------------------------------------------
        print("\n[SAM3] Loading model...")

        predictor = build_sam3_multiplex_video_predictor(
            checkpoint_path=CHECKPOINT,
            use_fa3=False,
        )

        print("[SAM3] Model loaded.")

        # ----------------------------------------------------
        # RealSense
        # ----------------------------------------------------
        print("\n[CAMERA] Starting RealSense...")

        pipeline = rs.pipeline()
        config = rs.config()

        config.enable_stream(
            rs.stream.color,
            WIDTH,
            HEIGHT,
            rs.format.bgr8,
            FPS,
        )

        config.enable_stream(
            rs.stream.depth,
            WIDTH,
            HEIGHT,
            rs.format.z16,
            FPS,
        )

        profile = pipeline.start(config)

        global depth_scale
        depth_scale = (
            profile
            .get_device()
            .first_depth_sensor()
            .get_depth_scale()
        )

        align = rs.align(rs.stream.color)

        intrinsics = (
            profile
            .get_stream(rs.stream.color)
            .as_video_stream_profile()
            .get_intrinsics()
        )

        print("[CAMERA] RealSense started.")

        set_camera_view_status("CAMERA READY - AUTOMATIC SEQUENCE")
        start_camera_view()

        # ====================================================
        # STEP 0: RETURN TO START / ORIGIN
        # ====================================================
        print()
        print("========================================")
        print("STEP 0: RETURN TO START / ORIGIN")
        print("========================================")

        return_to_start_pose(robot)

        # ====================================================
        # STEP 0B: GRIPPER PREP
        # ====================================================
        print()
        print("========================================")
        print("STEP 0B: GRIPPER PREP")
        print("========================================")

        ret = robot.ActGripper(GRIPPER_INDEX, 1)
        if ret != 0:
            raise RuntimeError(f"ActGripper failed: {ret}")

        print("[GRIPPER] Activated.")
        print(f"[GRIPPER] Prepare/open: pos={GRIPPER_PREP_POS}")

        time.sleep(3)
        move_gripper(robot, GRIPPER_PREP_POS)
        time.sleep(3)

        # ====================================================
        # STEP 1: MOVE TO EXPECTED TAG AREA
        # ====================================================
        print()
        print("========================================")
        print("STEP 1: MOVE TO EXPECTED TAG AREA")
        print("========================================")

        # The Scenario 3 expected Tag WObj position is used
        # only as the expected starting point for the Tag search.
        # The Tag is then detected and centered again before SAM3 starts.
        # Scenario 3 expected AprilTag location.
        # Z intentionally uses the START / origin WObj height, not the
        # measured Z value shown at the expected Tag location.
        expected_tag_pose = np.array([
            -71.788,
            -864.204,
            START_WOBJ_POSE[2],
            179.904,
            1.117,
            -179.368,
        ], dtype=np.float64)

        print("[MOVE] Moving to the previously measured expected Tag area.")
        print(
            f"       X={expected_tag_pose[0]:+.3f} mm, "
            f"Y={expected_tag_pose[1]:+.3f} mm, "
            f"Z={expected_tag_pose[2]:+.3f} mm"
        )

        move_wobj_target(
            robot,
            expected_tag_pose,
            "expected AprilTag area",
        )

        # ====================================================
        # STEP 2: RECTANGLE SEARCH
        # ====================================================
        print()
        print("========================================")
        print("STEP 2: APRILTAG SEARCH")
        print("========================================")

        tag = search_apriltag_rectangle(robot)

        if tag is None:
            raise RuntimeError("AprilTag ID18 was not found.")

        # ====================================================
        # STEP 3: CENTER TAG
        # ====================================================
        print()
        print("========================================")
        print("STEP 3: APRILTAG CENTERING")
        print("========================================")

        if not center_apriltag(robot):
            raise RuntimeError("AprilTag centering failed.")

        final_tag, keep_running = check_tag_and_display(
            "AprilTag final centering check"
        )

        if not keep_running:
            return

        if final_tag is None:
            raise RuntimeError("Final AprilTag check failed.")

        final_tag_error_x = (
            IMAGE_CENTER_X - final_tag["center_x"]
        )
        final_tag_error_y = (
            IMAGE_CENTER_Y - final_tag["center_y"]
        )

        print(
            f"[FINAL CHECK] AprilTag center = "
            f"({final_tag['center_x']:.0f}, {final_tag['center_y']:.0f})"
        )
        print(
            f"[FINAL CHECK] Pixel error = "
            f"X={final_tag_error_x:+.1f}, Y={final_tag_error_y:+.1f}"
        )

        if (
            abs(final_tag_error_x) > FINAL_CHECK_TOLERANCE_PX
            or abs(final_tag_error_y) > FINAL_CHECK_TOLERANCE_PX
        ):
            raise RuntimeError("AprilTag final centering check failed.")

        # ====================================================
        # STEP 4: SAM3 SEARCH + CENTERING
        # ====================================================
        print()
        print("========================================")
        print("STEP 4: SAM3 PINK CRATE SEARCH + CENTERING")
        print("========================================")

        result = None

        while True:
            result, keep_running = acquire_crate_result(
                predictor,
                pipeline,
                align,
                intrinsics,
                "SAM3 - searching pink crate in basket",
            )

            if not keep_running:
                return

            if result is not None:
                break

        for iteration in range(1, CENTER_MAX_ITERATIONS + 1):

            center_x = float(result["center_x"])
            center_y = float(result["center_y"])

            pixel_error_x = IMAGE_CENTER_X - center_x
            pixel_error_y = IMAGE_CENTER_Y - center_y

            print()
            print(
                f"[CENTER] Iteration "
                f"{iteration}/{CENTER_MAX_ITERATIONS}"
            )
            print(
                f"[CENTER] SAM3 centroid = "
                f"({center_x:.0f}, {center_y:.0f}) px"
            )
            print(
                f"[CENTER] Pixel error = "
                f"X={pixel_error_x:+.1f}, "
                f"Y={pixel_error_y:+.1f} px"
            )

            if (
                abs(pixel_error_x) <= IMAGE_CENTER_TOLERANCE_PX
                and abs(pixel_error_y) <= IMAGE_CENTER_TOLERANCE_PX
            ):
                break

            current_depth_m = float(result["camera_z"]) / 1000.0

            if current_depth_m < MIN_DEPTH_M or current_depth_m > MAX_DEPTH_M:
                raise RuntimeError("Invalid SAM3 depth.")

            current_point = rs.rs2_deproject_pixel_to_point(
                intrinsics,
                [center_x, center_y],
                current_depth_m,
            )

            target_point = rs.rs2_deproject_pixel_to_point(
                intrinsics,
                [IMAGE_CENTER_X, IMAGE_CENTER_Y],
                current_depth_m,
            )

            camera_error = np.array([
                (target_point[0] - current_point[0]) * 1000.0,
                (target_point[1] - current_point[1]) * 1000.0,
            ], dtype=np.float64)

            tool_xy = TOOL_FROM_CAMERA @ camera_error

            move_x = float(tool_xy[0])
            move_y = float(tool_xy[1])

            move_x = float(np.clip(
                move_x,
                -get_xy_axis_step_limit(camera_error[0]),
                +get_xy_axis_step_limit(camera_error[0]),
            ))

            move_y = float(np.clip(
                move_y,
                -get_xy_axis_step_limit(camera_error[1]),
                +get_xy_axis_step_limit(camera_error[1]),
            ))

            if abs(move_x) < MIN_CENTER_STEP_MM:
                move_x = 0.0
            if abs(move_y) < MIN_CENTER_STEP_MM:
                move_y = 0.0

            print(
                f"[CENTER] Tool correction = "
                f"X={move_x:+.2f}, Y={move_y:+.2f} mm"
            )

            move_tool_offset(robot, move_x, move_y, 0.0)

            result, keep_running = acquire_crate_result(
                predictor,
                pipeline,
                align,
                intrinsics,
                f"SAM3 centering {iteration}",
            )

            if not keep_running:
                return

            if result is None:
                raise RuntimeError(
                    "SAM3 detection lost during centering."
                )

        else:
            raise RuntimeError(
                "SAM3 centering maximum iterations reached."
            )

        # Fresh final SAM3 check.
        result, keep_running = acquire_crate_result(
            predictor,
            pipeline,
            align,
            intrinsics,
            "SAM3 final centering check",
        )

        if not keep_running:
            return

        if result is None:
            raise RuntimeError("Final SAM3 check failed.")

        final_error_x = IMAGE_CENTER_X - float(result["center_x"])
        final_error_y = IMAGE_CENTER_Y - float(result["center_y"])

        print(
            f"[FINAL CHECK] SAM3 error = "
            f"X={final_error_x:+.1f}, Y={final_error_y:+.1f} px"
        )

        if (
            abs(final_error_x) > FINAL_CHECK_TOLERANCE_PX
            or abs(final_error_y) > FINAL_CHECK_TOLERANCE_PX
        ):
            raise RuntimeError("SAM3 final centering check failed.")

        print("[FINAL CHECK] SAM3 centering confirmed.")

        # ====================================================
        # STEP 5: SAM3 CENTER -> BASKET CRATE PICKUP POSITION
        # ====================================================
        print()
        print("========================================")
        print("STEP 5: MOVE TO BASKET CRATE PICKUP")
        print("========================================")

        # Reuse the verified CENTER -> PICKUP X/Y displacement
        # from the original pink-crate pickup sequence.
        #
        # IMPORTANT: The requested change is a LEFT/RIGHT mirror on the
        # CAMERA image, not simply a sign flip of WObj X. Because Camera
        # XY and Tool XY are coupled, first convert the original XY vector
        # into Camera XY, mirror only Camera X, then convert it back to
        # Tool XY. This preserves the same screen-space travel distance
        # while reversing only the horizontal direction.
        original_pickup_delta = (
            PICKUP_WOBJ_TARGET - CENTERED_WOBJ_REFERENCE
        )
        original_tool_xy = original_pickup_delta[:2].copy()

        original_camera_xy = (
            CAMERA_FROM_TOOL @ original_tool_xy
        )
        mirrored_camera_xy = np.array([
            -original_camera_xy[0],
            original_camera_xy[1],
        ], dtype=np.float64)
        pickup_delta_xy = (
            TOOL_FROM_CAMERA @ mirrored_camera_xy
        )

        pickup_delta = original_pickup_delta.copy()
        pickup_delta[0] = pickup_delta_xy[0]
        pickup_delta[1] = pickup_delta_xy[1]

        # Scenario 3 adjustment: move 2 mm further in Tool X-
        # when approaching the basket pickup position.
        pickup_delta[0] += 2.0

        print(
            "[MOVE] CENTER -> PICKUP XY mirrored in camera image:"
        )
        print(
            f"       Original Tool XY = "
            f"X={original_tool_xy[0]:+.3f}, "
            f"Y={original_tool_xy[1]:+.3f} mm"
        )
        print(
            f"       Original Camera XY = "
            f"X={original_camera_xy[0]:+.3f}, "
            f"Y={original_camera_xy[1]:+.3f} mm"
        )
        print(
            f"       Mirrored Camera XY = "
            f"X={mirrored_camera_xy[0]:+.3f}, "
            f"Y={mirrored_camera_xy[1]:+.3f} mm"
        )
        print(
            f"       New Tool XY = "
            f"X={pickup_delta[0]:+.3f}, "
            f"Y={pickup_delta[1]:+.3f} mm"
        )
        print(
            "[MOVE] Basket pickup Z uses the measured "
            "Tag-center -> basket-floor value."
        )
        print(
            f"       Z={TAG_TO_BASKET_FLOOR_DELTA[2]:+.3f} mm"
        )

        centered_pose = get_tcp_pose(robot)

        pickup_xy_target = centered_pose.copy()
        pickup_xy_target[0] += pickup_delta[0]
        pickup_xy_target[1] += pickup_delta[1]

        move_wobj_target(
            robot,
            pickup_xy_target,
            "basket crate pickup XY",
        )

        # Z is moved separately after X/Y positioning is complete.
        pickup_z_target = get_tcp_pose(robot)
        pickup_z_target[2] += TAG_TO_BASKET_FLOOR_DELTA[2]

        move_wobj_target(
            robot,
            pickup_z_target,
            "basket crate pickup Z",
        )

        # ====================================================
        # STEP 6: GRIP
        # ====================================================
        print()
        print("========================================")
        print("STEP 6: PICKUP")
        print("========================================")

        print(
            f"[GRIPPER] Close / Pickup: pos={GRIPPER_PICK_POS}"
        )

        time.sleep(3)
        move_gripper(robot, GRIPPER_PICK_POS)
        time.sleep(3)

        print("[PICKUP] Pink crate gripped.")

        # ====================================================
        # STEP 7: LIFT AFTER PICKUP
        # ====================================================
        print()
        print("========================================")
        print("STEP 7: LIFT AFTER PICKUP")
        print("========================================")

        # Raise Z only to the original START / origin WObj height.
        # The XY position remains unchanged during this lift.
        current_pose = get_tcp_pose(robot)

        lift_z_target = current_pose.copy()
        lift_z_target[2] = START_WOBJ_POSE[2]

        print(
            f"[LIFT] Target Z = {START_WOBJ_POSE[2]:+.3f} mm"
        )

        move_wobj_target(
            robot,
            lift_z_target,
            "pickup lift Z",
        )

        # ====================================================
        # STEP 8: MOVE TO PLACEMENT POSITION
        # ====================================================
        print()
        print("========================================")
        print("STEP 8: MOVE TO PLACEMENT POSITION")
        print("========================================")

        print(
            "[PLACE] Target WObj:"
        )
        print(
            f"        X={PLACEMENT_WOBJ_TARGET[0]:+.3f} "
            f"Y={PLACEMENT_WOBJ_TARGET[1]:+.3f} "
            f"Z={PLACEMENT_WOBJ_TARGET[2]:+.3f}"
        )
        print(
            f"        Rx={PLACEMENT_WOBJ_TARGET[3]:+.3f} "
            f"Ry={PLACEMENT_WOBJ_TARGET[4]:+.3f} "
            f"Rz={PLACEMENT_WOBJ_TARGET[5]:+.3f}"
        )

        # Move X/Y first while keeping the current pickup Z.
        current_pose = get_tcp_pose(robot)

        placement_xy_target = current_pose.copy()
        placement_xy_target[0] = PLACEMENT_WOBJ_TARGET[0]
        placement_xy_target[1] = PLACEMENT_WOBJ_TARGET[1]

        move_wobj_target(
            robot,
            placement_xy_target,
            "placement XY",
        )

        # Move Z separately to the measured placement height.
        placement_z_target = get_tcp_pose(robot)
        placement_z_target[2] = PLACEMENT_WOBJ_TARGET[2]
        placement_z_target[3:] = PLACEMENT_WOBJ_TARGET[3:]

        move_wobj_target(
            robot,
            placement_z_target,
            "placement Z",
        )

        # ====================================================
        # STEP 9: RELEASE
        # ====================================================
        print()
        print("========================================")
        print("STEP 9: RELEASE")
        print("========================================")

        print(
            f"[GRIPPER] Open / Release: pos={GRIPPER_PREP_POS}"
        )

        move_gripper(robot, GRIPPER_PREP_POS)
        time.sleep(3)

        print("[PLACE] Pink crate released.")

        # ====================================================
        # STEP 10: RETURN TO ORIGINAL START / ORIGIN
        # ====================================================
        print()
        print("========================================")
        print("STEP 10: RETURN TO START / ORIGIN")
        print("========================================")
        print(
            "[RETURN] Z-axis movement first, "
            "then X/Y-axis movement."
        )

        return_to_start_pose(robot)

        print()
        print("========================================")
        print("SCENARIO 3: BASKET PICKUP -> PLACE -> START RETURN COMPLETE")
        print("========================================")

    except KeyboardInterrupt:
        print("\n[STOP] Interrupted by user.")

    except Exception as exc:
        print(f"\n[ERROR] {exc}")

    finally:

        stop_camera_view()
        cv2.destroyAllWindows()

        if pipeline is not None:
            try:
                pipeline.stop()
            except Exception:
                pass

        if robot is not None:
            try:
                robot.CloseRPC()
            except Exception:
                pass

        print("\nTest finished.")


if __name__ == "__main__":
    main()
