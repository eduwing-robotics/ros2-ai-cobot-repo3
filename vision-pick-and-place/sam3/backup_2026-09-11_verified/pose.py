#!/usr/bin/env python3
"""현재 TCP·관절·그리퍼만 읽는다. 로봇을 움직이지 않는다.

/nonrt_state_data 는 서비스 호출이 한 번 있어야 유효한 값을 싣는다 —
그냥 구독만 하면 전부 0 으로 온다. 그래서 읽기 전용 명령을 한 번 보낸다."""
import rclpy
from rclpy.node import Node
from fairino_msgs.msg import RobotNonrtState
from fairino_msgs.srv import RemoteCmdInterface

rclpy.init(); n = Node("pose"); st = {}
n.create_subscription(RobotNonrtState, "/nonrt_state_data", lambda m: st.__setitem__("s", m), 1)
cli = n.create_client(RemoteCmdInterface, "/fairino_remote_command_service")
if not cli.wait_for_service(timeout_sec=5.0):
    print("명령 서비스 없음 — ros2_cmd_server 가 떠 있는지 확인"); raise SystemExit(1)
req = RemoteCmdInterface.Request(); req.cmd_str = "GetRobotErrorCode()"   # 읽기 전용
f = cli.call_async(req); rclpy.spin_until_future_complete(n, f, timeout_sec=20.0)
if f.result() is None:
    print("응답 없음 — 잠시 뒤 다시 시도하세요"); raise SystemExit(1)
print(f"에러코드 {f.result().cmd_res}")

s = None
for _ in range(300):
    rclpy.spin_once(n, timeout_sec=0.1)
    c = st.get("s")
    if c is not None and abs(c.cart_x_cur_pos) + abs(c.cart_y_cur_pos) > 1.0:
        s = c; break
if s is None:
    print("유효한 상태를 못 받았습니다"); raise SystemExit(1)
print(f"TCP   ({s.cart_x_cur_pos:.2f}, {s.cart_y_cur_pos:.2f}, {s.cart_z_cur_pos:.2f})")
print(f"관절  [{', '.join(f'{v:.3f}' for v in (s.j1_cur_pos, s.j2_cur_pos, s.j3_cur_pos, s.j4_cur_pos, s.j5_cur_pos, s.j6_cur_pos))}]")
print(f"그리퍼  위치 {getattr(s, 'grip_position', -1)}  done {getattr(s, 'grip_motion_done', -1)}")
