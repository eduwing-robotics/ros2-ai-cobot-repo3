#!/usr/bin/env python3
"""상대좌표로 조금씩 움직인다. 사용법: jog.py dx dy dz [속도]"""
import sys, time, numpy as np, rclpy
from rclpy.node import Node
from fairino_msgs.msg import RobotNonrtState
from fairino_msgs.srv import RemoteCmdInterface
from rcl_interfaces.srv import SetParameters
from rcl_interfaces.msg import Parameter, ParameterValue, ParameterType

dx, dy, dz = (float(v) for v in sys.argv[1:4])
speed = int(sys.argv[4]) if len(sys.argv) > 4 else 5
dist = float(np.linalg.norm([dx, dy, dz]))

rclpy.init(); node = Node("jog"); st = {}
node.create_subscription(RobotNonrtState, "/nonrt_state_data", lambda m: st.__setitem__("s", m), 1)
cli = node.create_client(RemoteCmdInterface, "/fairino_remote_command_service")
par = node.create_client(SetParameters, "/fr_command_server/set_parameters")
for c, nm in ((cli, "명령"), (par, "파라미터")):
    if not c.wait_for_service(timeout_sec=5.0): sys.exit(f"{nm} 서비스 없음")

def send(cmd):
    r = RemoteCmdInterface.Request(); r.cmd_str = cmd
    f = cli.call_async(r); rclpy.spin_until_future_complete(node, f, timeout_sec=20.0)
    if f.result() is None: sys.exit(f"응답 없음: {cmd}")
    return f.result().cmd_res

def pose(timeout=5.0):
    t = time.time()
    while time.time()-t < timeout:
        rclpy.spin_once(node, timeout_sec=0.1)
        if "s" in st:
            s = st["s"]
            return np.array([s.cart_x_cur_pos, s.cart_y_cur_pos, s.cart_z_cur_pos]), \
                   (s.cart_a_cur_pos, s.cart_b_cur_pos, s.cart_c_cur_pos)
    sys.exit("로봇 상태를 못 받았습니다")

req = SetParameters.Request()
for nm, val in (("MoveJLC_offset_flag", 1), ("MoveJLC_offset_pos_x", dx),
                ("MoveJLC_offset_pos_y", dy), ("MoveJLC_offset_pos_z", dz),
                ("MoveJLC_offset_pos_rx", 0.0), ("MoveJLC_offset_pos_ry", 0.0),
                ("MoveJLC_offset_pos_rz", 0.0)):
    pv = (ParameterValue(type=ParameterType.PARAMETER_INTEGER, integer_value=int(val))
          if nm.endswith("flag") else
          ParameterValue(type=ParameterType.PARAMETER_DOUBLE, double_value=float(val)))
    req.parameters.append(Parameter(name=nm, value=pv))
f = par.call_async(req); rclpy.spin_until_future_complete(node, f, timeout_sec=5.0)
if f.result() is None: sys.exit("offset 설정 실패")

p0, rpy = pose()
print(f"현재  ({p0[0]:.2f}, {p0[1]:.2f}, {p0[2]:.2f})")
print(f"이동  ({dx:+.2f}, {dy:+.2f}, {dz:+.2f}) mm  거리 {dist:.2f}mm  속도 {speed}%")
print(f"목표  ({p0[0]+dx:.2f}, {p0[1]+dy:.2f}, {p0[2]+dz:.2f})")

print(f"에러코드 {send('GetRobotErrorCode()')}  RobotEnable {send('RobotEnable(1)')}  "
      f"SetSpeed {send(f'SetSpeed({speed})')}")
r1 = send(f"CARTPoint(1,{p0[0]:.3f},{p0[1]:.3f},{p0[2]:.3f},{rpy[0]:.3f},{rpy[1]:.3f},{rpy[2]:.3f})")
if str(r1).strip() != "0": sys.exit(f"CARTPoint 거부 (코드 {r1})")
r2 = send(f"MoveL(CART1,{speed},1,1)")
if str(r2).strip() != "0": sys.exit(f"MoveL 거부 (코드 {r2})")

# 5% 속도 실측 약 2.4mm/s. 거리에 비례해 여유 3배로 기다린다.
timeout = max(20.0, dist / 2.4 * 3)
tgt = p0 + np.array([dx, dy, dz]); t = time.time(); last = None
while time.time()-t < timeout:
    rclpy.spin_once(node, timeout_sec=0.1)
    cur, _ = pose(1.0)
    if np.linalg.norm(cur - tgt) < 0.5: break
    if last is not None and np.linalg.norm(cur-last) < 0.01 and time.time()-t > 3.0: break
    last = cur
    time.sleep(0.2)
cur, _ = pose()
print(f"도달  ({cur[0]:.2f}, {cur[1]:.2f}, {cur[2]:.2f})")
print(f"차이  ({cur[0]-tgt[0]:+.2f}, {cur[1]-tgt[1]:+.2f}, {cur[2]-tgt[2]:+.2f}) mm  "
      f"실제 이동 {np.linalg.norm(cur-p0):.2f}mm")
node.destroy_node(); rclpy.shutdown()
