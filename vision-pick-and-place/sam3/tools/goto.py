#!/usr/bin/env python3
"""절대 카테시안 좌표로 이동한다.
사용법: goto.py x y z [rx ry rz] [--speed N]
자세를 안 주면 현재 자세를 유지한다."""
import sys, time, numpy as np, rclpy
from rclpy.node import Node
from fairino_msgs.msg import RobotNonrtState
from fairino_msgs.srv import RemoteCmdInterface
from rcl_interfaces.srv import SetParameters
from rcl_interfaces.msg import Parameter, ParameterValue, ParameterType

args = [x for x in sys.argv[1:] if not x.startswith("--")]
speed = 10
for x in sys.argv[1:]:
    if x.startswith("--speed"): speed = int(x.split("=")[1]) if "=" in x else speed
if len(args) not in (3, 6): sys.exit(__doc__)
tx, ty, tz = (float(v) for v in args[:3])

rclpy.init(); n = Node("goto"); st = {}
n.create_subscription(RobotNonrtState, "/nonrt_state_data", lambda m: st.__setitem__("s", m), 1)
cli = n.create_client(RemoteCmdInterface, "/fairino_remote_command_service")
par = n.create_client(SetParameters, "/fr_command_server/set_parameters")
for c, nm in ((cli, "명령"), (par, "파라미터")):
    if not c.wait_for_service(timeout_sec=5.0): sys.exit(f"{nm} 서비스 없음")

def send(cmd):
    r = RemoteCmdInterface.Request(); r.cmd_str = cmd
    f = cli.call_async(r); rclpy.spin_until_future_complete(n, f, timeout_sec=20.0)
    if f.result() is None: sys.exit(f"응답 없음: {cmd}")
    return f.result().cmd_res

def state(timeout=5.0):
    t = time.time()
    while time.time()-t < timeout:
        rclpy.spin_once(n, timeout_sec=0.1)
        if "s" in st: return st["s"]
    sys.exit("로봇 상태를 못 받았습니다")

s = state()
p0 = np.array([s.cart_x_cur_pos, s.cart_y_cur_pos, s.cart_z_cur_pos])
if len(args) == 6:
    rx, ry, rz = (float(v) for v in args[3:])
else:
    rx, ry, rz = s.cart_a_cur_pos, s.cart_b_cur_pos, s.cart_c_cur_pos

tgt = np.array([tx, ty, tz]); dist = float(np.linalg.norm(tgt - p0))
print(f"현재  ({p0[0]:.2f}, {p0[1]:.2f}, {p0[2]:.2f})  자세 "
      f"({s.cart_a_cur_pos:.2f}, {s.cart_b_cur_pos:.2f}, {s.cart_c_cur_pos:.2f})")
print(f"목표  ({tx:.2f}, {ty:.2f}, {tz:.2f})  자세 ({rx:.2f}, {ry:.2f}, {rz:.2f})")
print(f"거리  {dist:.1f}mm   속도 {speed}%")

# 서보용 offset 이 남아 있으면 목표에 더해진다 — 0 으로 되돌린다
req = SetParameters.Request()
for nm, val in (("MoveJLC_offset_flag", 1), ("MoveJLC_offset_pos_x", 0.0),
                ("MoveJLC_offset_pos_y", 0.0), ("MoveJLC_offset_pos_z", 0.0),
                ("MoveJLC_offset_pos_rx", 0.0), ("MoveJLC_offset_pos_ry", 0.0),
                ("MoveJLC_offset_pos_rz", 0.0)):
    pv = (ParameterValue(type=ParameterType.PARAMETER_INTEGER, integer_value=int(val))
          if nm.endswith("flag") else
          ParameterValue(type=ParameterType.PARAMETER_DOUBLE, double_value=float(val)))
    req.parameters.append(Parameter(name=nm, value=pv))
f = par.call_async(req); rclpy.spin_until_future_complete(n, f, timeout_sec=5.0)

print(f"에러코드 {send('GetRobotErrorCode()')}  RobotEnable {send('RobotEnable(1)')}  "
      f"SetSpeed {send(f'SetSpeed({speed})')}")
r1 = send(f"CARTPoint(1,{tx:.3f},{ty:.3f},{tz:.3f},{rx:.3f},{ry:.3f},{rz:.3f})")
if str(r1).strip() != "0": sys.exit(f"CARTPoint 거부 (코드 {r1})")
r2 = send(f"MoveL(CART1,{speed},1,1)")
if str(r2).strip() != "0": sys.exit(f"MoveL 거부 (코드 {r2})")

timeout = max(20.0, dist / max(0.48*speed, 0.1) * 3.0)
t = time.time()
while time.time()-t < timeout:
    s = state(1.0)
    cur = np.array([s.cart_x_cur_pos, s.cart_y_cur_pos, s.cart_z_cur_pos])
    if np.linalg.norm(cur - tgt) < 2.0: break
    time.sleep(0.2)
s = state(); cur = np.array([s.cart_x_cur_pos, s.cart_y_cur_pos, s.cart_z_cur_pos])
print(f"도달  ({cur[0]:.2f}, {cur[1]:.2f}, {cur[2]:.2f})")
print(f"차이  ({cur[0]-tx:+.2f}, {cur[1]-ty:+.2f}, {cur[2]-tz:+.2f}) mm   "
      f"남은 거리 {np.linalg.norm(cur-tgt):.2f}mm")
print(f"에러코드 {send('GetRobotErrorCode()')}")
n.destroy_node(); rclpy.shutdown()
