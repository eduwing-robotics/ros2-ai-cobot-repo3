#!/usr/bin/env python3
""" 캘리브레이션 빠른 검증: 타겟 마커(ID=1, '가짜 물체')의 위치를 계산해서
로봇을 그 바로 위(호버 높이)로 이동시켜 실제 정렬이 맞는지 눈으로 확인한다.

⚠️ 기본은 미리보기(dry-run)만 합니다 — 계산된 목표 좌표만 출력하고 로봇을 움직이지
않습니다. 값을 확인한 뒤 --move 옵션으로 다시 실행해야 실제로 이동합니다.

⚠️ 처음 --move로 실행할 때는 로봇 주변을 비우고 비상정지 버튼에 손을 댈 수 있는 상태에서
진행하세요. 저속(SetSpeed 10%)+호버(목표 위 150mm)로만 이동하도록 설계했습니다.

사전 준비:
  - 타겟 마커(ID=1)를 작업대 위 평평한 곳에 고정 (generate_target_marker.py로 생성)
  - ros2 launch realsense2_camera rs_launch.py rgb_camera.color_profile:=1920x1080x30
  - ros2 run fairino_hardware_v3_9_7 ros2_cmd_server
  - compute_calibration.py로 calib_transform.npz 생성 완료

사용법:
  python3 vision_pick_and_place.py          # 미리보기만 (로봇 안 움직임)
  python3 vision_pick_and_place.py --move   # 실제로 호버 위치까지만 이동
  python3 vision_pick_and_place.py --grasp  # Pick(호버->하강->닫기->들어올리기)
                                          # + Place(고정 위치로 이동->하강->열기->들어올리기) 전체 수행
"""
import argparse
import os
import time

import cv2
import cv2.aruco as aruco
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image, CameraInfo
from fairino_msgs.msg import RobotNonrtState
from fairino_msgs.srv import RemoteCmdInterface

TARGET_MARKER_ID = 1
MARKER_LENGTH_M = 0.029  # capture_calib_point.py와 동일 실측값 - 다르면 반드시 갱신
NUM_SAMPLES = 30
MAX_ATTEMPTS = 150
HOVER_OFFSET_MM = 150.0  # 목표 지점 위 이만큼 띄운 높이로만 이동 (테이블/물체 충돌 방지)
MOVE_SPEED = 10  # % - 검증 단계라 저속

# 그리퍼가 테이블에 수직으로(똑바로 내려다보며) 접근하는 자세
# 맞춰서 확인한 값(타겟 마커 위에서 그리퍼 손가락이 상자 정중앙에 양쪽으로 걸리는 자세)
APPROACH_RX = -179.224
APPROACH_RY = 1.509
APPROACH_RZ = 91.191

# 그리퍼 마커(ID=0)의 부착 위치와 실제 그립 지점(손가락 중심) 사이의 물리적 오프셋 보정.
# 캘리브레이션은 비스듬한 자세로 진행했는데 실제 그립은 수직 자세로 접근하다 보니,
# 마커->그립지점 오프셋이 다른 방향을 향하게 되어 X/Y에 상수 오차가 생김
# Drag Teaching/Jog으로 그리퍼를 타겟 상자 정중앙에 맞춘 실측값과 스크립트 계산값의 차이로 구함
# - 캘리브레이션/접근 자세가 둘 다 고정인 한 위치와 무관하게 상수로 재사용 가능.
# 서로 다른 위치에서 3회 측정(x-14.2/y+9.1, x-20.0/y+12.1, x-17.1/y+6.5) 후 평균낸 값
CORRECTION_X_MM = -17.1
CORRECTION_Y_MM = 9.2

# 실제 그립 높이 보정 - 계산된 타겟 Z(마커 표면 높이 추정치, 노이즈가 X/Y보다 큼)와
# Jog로 직접 찾은 "손가락이 상자를 감싸는 높이"의 차이. 2회 측정(+28.6mm, +40.5mm) 평균.
# 이 값은 X/Y 보정과 달리 "이 상자 높이"에 맞춘 값이라 물체 크기가 다르면 안 맞을 수 있음
# (깊이 기반 물체 높이 인식)에서 정식으로 대체될 임시값
Z_GRASP_OFFSET_MM = 34.6

GRIPPER_ID = 1
GRIPPER_OPEN_POS = 100  # 0=완전 닫힘, 100=완전 열림 
GRIPPER_CLOSE_POS = 80  # 완전 닫힘(0)까지 안 가고 살짝만 닫음 - 간격이 타이트해서 여유를 둠
GRIPPER_SPEED = 5
GRIPPER_TORQUE = 15  # 저항 느끼면 목표 위치 전이라도 멈춤 - 살살 잡도록 낮춤
GRIPPER_MAXTIME_MS = 2000

# Place(놓는) 위치 - WebApp Jog로 미리 잡아둔 고정 지점. 자세는 APPROACH와 거의
# 동일(수직 접근 유지)이라 별도 자세값 없이 APPROACH_RX/RY/RZ를 그대로 재사용.
PLACE_X = -387.773
PLACE_Y = 2.445
PLACE_Z = 9.336

TRANSFORM_FILE = os.path.join(os.path.dirname(__file__), "calib_transform.npz")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--move", action="store_true", help="실제로 호버 위치까지만 이동 (기본은 미리보기만)")
    parser.add_argument(
        "--grasp", action="store_true",
        help="호버 이동 후 그립 높이로 하강 -> 그리퍼 닫기 -> 다시 호버로 들어올리기까지 전체 수행",
    )
    args = parser.parse_args()
    do_move = args.move or args.grasp

    if not os.path.exists(TRANSFORM_FILE):
        print(f"{TRANSFORM_FILE} 이(가) 없습니다. compute_calibration.py를 먼저 실행하세요.")
        return

    data = np.load(TRANSFORM_FILE)
    R, t = data["R"], data["t"]

    rclpy.init()
    node = Node("vision_pick_and_place")
    result = {}

    def on_image(msg):
        result["image"] = np.frombuffer(msg.data, dtype=np.uint8).reshape(msg.height, msg.width, 3)
        result["image_seq"] = result.get("image_seq", 0) + 1

    def on_info(msg):
        result["K"] = np.array(msg.k).reshape(3, 3)
        result["D"] = np.array(msg.d)

    def on_state(msg):
        result["state"] = msg

    node.create_subscription(Image, "/camera/camera/color/image_raw", on_image, 1)
    node.create_subscription(CameraInfo, "/camera/camera/color/camera_info", on_info, 1)
    node.create_subscription(RobotNonrtState, "/nonrt_state_data", on_state, 1)

    for _ in range(50):
        rclpy.spin_once(node, timeout_sec=0.2)
        if all(k in result for k in ("image", "K", "state")):
            break

    if not all(k in result for k in ("image", "K", "state")):
        print("카메라/카메라정보/로봇상태 중 일부를 못 받았습니다. 노드 실행 상태를 확인하세요.")
        node.destroy_node()
        rclpy.shutdown()
        return

    dictionary = aruco.getPredefinedDictionary(aruco.DICT_4X4_50)
    parameters = aruco.DetectorParameters_create()

    samples = []
    last_seq = -1
    attempts = 0
    while len(samples) < NUM_SAMPLES and attempts < MAX_ATTEMPTS:
        rclpy.spin_once(node, timeout_sec=0.1)
        attempts += 1
        if result.get("image_seq", 0) == last_seq:
            continue
        last_seq = result["image_seq"]

        gray = cv2.cvtColor(result["image"], cv2.COLOR_RGB2GRAY)
        corners, ids, _ = aruco.detectMarkers(gray, dictionary, parameters=parameters)
        if ids is None or TARGET_MARKER_ID not in ids.flatten():
            continue

        idx = list(ids.flatten()).index(TARGET_MARKER_ID)
        rvecs, tvecs, _ = aruco.estimatePoseSingleMarkers(
            [corners[idx]], MARKER_LENGTH_M, result["K"], result["D"]
        )
        samples.append(tvecs[0][0] * 1000.0)  # m -> mm

    if len(samples) < 5:
        print(
            f"타겟 마커(ID={TARGET_MARKER_ID}) 검출 성공 프레임이 {len(samples)}개뿐입니다. "
            "작업대에 고정된 마커가 카메라 시야 안에 있는지 확인하세요."
        )
        node.destroy_node()
        rclpy.shutdown()
        return

    samples = np.array(samples)
    cam_xyz_mm = np.median(samples, axis=0)
    print(f"타겟 마커 카메라 좌표(mm): x={cam_xyz_mm[0]:.1f} y={cam_xyz_mm[1]:.1f} z={cam_xyz_mm[2]:.1f}")

    robot_xyz_mm = R @ cam_xyz_mm + t
    print(f"변환된 로봇 base 좌표(mm): x={robot_xyz_mm[0]:.1f} y={robot_xyz_mm[1]:.1f} z={robot_xyz_mm[2]:.1f}")

    robot_xyz_mm[0] += CORRECTION_X_MM
    robot_xyz_mm[1] += CORRECTION_Y_MM
    print(
        f"마커->그립지점 보정 적용(x{CORRECTION_X_MM:+.1f}, y{CORRECTION_Y_MM:+.1f}): "
        f"x={robot_xyz_mm[0]:.1f} y={robot_xyz_mm[1]:.1f} z={robot_xyz_mm[2]:.1f}"
    )

    state = result["state"]
    print(
        f"현재 로봇 위치(mm): x={state.cart_x_cur_pos:.1f} y={state.cart_y_cur_pos:.1f} "
        f"z={state.cart_z_cur_pos:.1f} (자세 a={state.cart_a_cur_pos:.1f} b={state.cart_b_cur_pos:.1f} "
        f"c={state.cart_c_cur_pos:.1f})"
    )

    hover_x, hover_y, hover_z = robot_xyz_mm[0], robot_xyz_mm[1], robot_xyz_mm[2] + HOVER_OFFSET_MM
    grasp_z = robot_xyz_mm[2] + Z_GRASP_OFFSET_MM
    print(
        f"이동 목표(타겟 위 {HOVER_OFFSET_MM:.0f}mm 호버, 수직 접근 자세로 전환): "
        f"x={hover_x:.1f} y={hover_y:.1f} z={hover_z:.1f} "
        f"(자세 a={APPROACH_RX:.1f} b={APPROACH_RY:.1f} c={APPROACH_RZ:.1f})"
    )
    if args.grasp:
        print(f"그립 높이(호버 후 하강 목표): z={grasp_z:.1f}")

    if not do_move:
        print("\n[미리보기 모드] 로봇을 움직이지 않았습니다. 값이 합리적이면 --move/--grasp로 다시 실행하세요.")
        node.destroy_node()
        rclpy.shutdown()
        return

    client = node.create_client(RemoteCmdInterface, "/fairino_remote_command_service")
    if not client.wait_for_service(timeout_sec=5.0):
        print("로봇 서비스에 연결할 수 없습니다. ros2_cmd_server 실행 상태를 확인하세요.")
        node.destroy_node()
        rclpy.shutdown()
        return

    def send_cmd(cmd_str, timeout_sec=20.0):
        request = RemoteCmdInterface.Request()
        request.cmd_str = cmd_str
        future = client.call_async(request)
        rclpy.spin_until_future_complete(node, future, timeout_sec=timeout_sec)
        if future.result() is None:
            raise TimeoutError(f"응답 시간 초과: {cmd_str}")
        return future.result().cmd_res

    def wait_for_arm(target_x, target_y, target_z, tol_mm=3.0, timeout_s=90.0):
        # MoveJ는 명령이 접수되면 바로 응답하고 실제 도착까지 기다려주지 않음 - 직접 폴링
        start = time.time()
        while time.time() - start < timeout_s:
            rclpy.spin_once(node, timeout_sec=0.1)
            s = result.get("state")
            if s is not None:
                d = (
                    (s.cart_x_cur_pos - target_x) ** 2
                    + (s.cart_y_cur_pos - target_y) ** 2
                    + (s.cart_z_cur_pos - target_z) ** 2
                ) ** 0.5
                if d < tol_mm:
                    return True
        print(f"  (경고: {timeout_s:.0f}초 안에 목표 위치 도달 확인 못함 - 계속 진행)")
        return False

    def wait_for_gripper(timeout_s=5.0):
        start = time.time()
        while time.time() - start < timeout_s:
            rclpy.spin_once(node, timeout_sec=0.1)
            s = result.get("state")
            if s is not None and s.grip_motion_done == 1:
                return True
        print(f"  (경고: {timeout_s:.0f}초 안에 그리퍼 완료 신호 못 받음 - 계속 진행)")
        return False

    print(f"\nSetSpeed({MOVE_SPEED}) -> {send_cmd(f'SetSpeed({MOVE_SPEED})')}")

    cart_cmd = (
        f"CARTPoint(1,{hover_x:.2f},{hover_y:.2f},{hover_z:.2f},"
        f"{APPROACH_RX:.2f},{APPROACH_RY:.2f},{APPROACH_RZ:.2f})"
    )
    print(f"{cart_cmd} -> {send_cmd(cart_cmd)}")

    move_cmd = f"MoveJ(CART1,{MOVE_SPEED},1,0)"
    print(f"{move_cmd} -> {send_cmd(move_cmd)}")
    wait_for_arm(hover_x, hover_y, hover_z)

    if not args.grasp:
        print("\n이동 명령 전송 완료. 로봇이 타겟 마커 바로 위(호버 위치)로 이동했는지 눈으로 확인하세요.")
        node.destroy_node()
        rclpy.shutdown()
        return

    print(f"\nActGripper({GRIPPER_ID},1) -> {send_cmd(f'ActGripper({GRIPPER_ID},1)')}")
    time.sleep(3.0)

    open_cmd = (
        f"MoveGripper({GRIPPER_ID},{GRIPPER_OPEN_POS},{GRIPPER_SPEED},"
        f"{GRIPPER_TORQUE},{GRIPPER_MAXTIME_MS},0,0,0,0,0)"
    )
    print(f"{open_cmd} -> {send_cmd(open_cmd)}")
    wait_for_gripper()

    descend_cmd = (
        f"CARTPoint(1,{hover_x:.2f},{hover_y:.2f},{grasp_z:.2f},"
        f"{APPROACH_RX:.2f},{APPROACH_RY:.2f},{APPROACH_RZ:.2f})"
    )
    print(f"{descend_cmd} -> {send_cmd(descend_cmd)}")
    print(f"{move_cmd} -> {send_cmd(move_cmd)}")
    wait_for_arm(hover_x, hover_y, grasp_z)

    close_cmd = (
        f"MoveGripper({GRIPPER_ID},{GRIPPER_CLOSE_POS},{GRIPPER_SPEED},"
        f"{GRIPPER_TORQUE},{GRIPPER_MAXTIME_MS},0,0,0,0,0)"
    )
    print(f"{close_cmd} -> {send_cmd(close_cmd)}")
    wait_for_gripper()
    print("그리퍼 LED가 초록색으로 바뀌는지 확인하세요 (파지 성공 신호).")

    lift_cmd = (
        f"CARTPoint(1,{hover_x:.2f},{hover_y:.2f},{hover_z:.2f},"
        f"{APPROACH_RX:.2f},{APPROACH_RY:.2f},{APPROACH_RZ:.2f})"
    )
    print(f"{lift_cmd} -> {send_cmd(lift_cmd)}")
    print(f"{move_cmd} -> {send_cmd(move_cmd)}")
    wait_for_arm(hover_x, hover_y, hover_z)

    print("\nPick 완료. 물체가 그리퍼에 딸려 올라왔는지 확인 후 Place로 이동합니다.")

    place_hover_z = PLACE_Z + HOVER_OFFSET_MM

    place_hover_cmd = (
        f"CARTPoint(1,{PLACE_X:.2f},{PLACE_Y:.2f},{place_hover_z:.2f},"
        f"{APPROACH_RX:.2f},{APPROACH_RY:.2f},{APPROACH_RZ:.2f})"
    )
    print(f"{place_hover_cmd} -> {send_cmd(place_hover_cmd)}")
    print(f"{move_cmd} -> {send_cmd(move_cmd)}")
    wait_for_arm(PLACE_X, PLACE_Y, place_hover_z)

    place_descend_cmd = (
        f"CARTPoint(1,{PLACE_X:.2f},{PLACE_Y:.2f},{PLACE_Z:.2f},"
        f"{APPROACH_RX:.2f},{APPROACH_RY:.2f},{APPROACH_RZ:.2f})"
    )
    print(f"{place_descend_cmd} -> {send_cmd(place_descend_cmd)}")
    print(f"{move_cmd} -> {send_cmd(move_cmd)}")
    wait_for_arm(PLACE_X, PLACE_Y, PLACE_Z)

    release_cmd = (
        f"MoveGripper({GRIPPER_ID},{GRIPPER_OPEN_POS},{GRIPPER_SPEED},"
        f"{GRIPPER_TORQUE},{GRIPPER_MAXTIME_MS},0,0,0,0,0)"
    )
    print(f"{release_cmd} -> {send_cmd(release_cmd)}")
    wait_for_gripper()
    print("물체가 완전히 떨어지도록 대기 중...")
    time.sleep(3.0)

    place_lift_cmd = (
        f"CARTPoint(1,{PLACE_X:.2f},{PLACE_Y:.2f},{place_hover_z:.2f},"
        f"{APPROACH_RX:.2f},{APPROACH_RY:.2f},{APPROACH_RZ:.2f})"
    )
    print(f"{place_lift_cmd} -> {send_cmd(place_lift_cmd)}")
    print(f"{move_cmd} -> {send_cmd(move_cmd)}")
    wait_for_arm(PLACE_X, PLACE_Y, place_hover_z)

    print("\nPick & Place 시퀀스 완료. 물체가 Place 위치에 놓였는지 눈으로 확인하세요.")

    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
