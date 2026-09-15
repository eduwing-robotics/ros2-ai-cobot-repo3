#!/usr/bin/env python3
"""그리퍼만 움직인다. 사용법: grip.py <위치>  (작을수록 닫힘)"""
import sys, time, rclpy
from rclpy.node import Node
from fairino_msgs.msg import RobotNonrtState
from fairino_msgs.srv import RemoteCmdInterface

pos = int(sys.argv[1])
GID, SPD, TRQ, MAXT = 1, 5, 15, 2000

rclpy.init(); node = Node("grip"); st = {}
node.create_subscription(RobotNonrtState, "/nonrt_state_data", lambda m: st.__setitem__("s", m), 1)
cli = node.create_client(RemoteCmdInterface, "/fairino_remote_command_service")
if not cli.wait_for_service(timeout_sec=5.0): sys.exit("명령 서비스 없음")

def send(cmd):
    r = RemoteCmdInterface.Request(); r.cmd_str = cmd
    f = cli.call_async(r); rclpy.spin_until_future_complete(node, f, timeout_sec=20.0)
    if f.result() is None: sys.exit(f"응답 없음: {cmd}")
    return f.result().cmd_res

print(f"에러코드 {send('GetRobotErrorCode()')}  RobotEnable {send('RobotEnable(1)')}")
print(f"ActGripper -> {send(f'ActGripper({GID},1)')}")
time.sleep(3.0)
print(f"MoveGripper({pos}) -> {send(f'MoveGripper({GID},{pos},{SPD},{TRQ},{MAXT},0,0,0,0,0)')}")

t = time.time(); saw = False
while time.time()-t < 25.0:
    rclpy.spin_once(node, timeout_sec=0.1)
    s = st.get("s")
    if s is None: continue
    if s.grippererro or s.gripperfaultnum:
        print(f"  ✗ 오류 erro={s.grippererro} fault={s.gripperfaultnum}"); break
    if s.grip_motion_done == 0: saw = True
    elif saw:
        print(f"  완료 ({time.time()-t:.1f}초)"); break
else:
    s = st.get("s")
    print(f"  (25초 내 완료 신호 없음 — done={getattr(s,'grip_motion_done','?')} 움직임감지={saw})")
s = st.get("s")
if s is not None:
    print(f"  상태: done={s.grip_motion_done} erro={s.grippererro} fault={s.gripperfaultnum}")
node.destroy_node(); rclpy.shutdown()
