#!/usr/bin/env python3
"""시작 위치로 이동한다. 관절값이므로 JNTPoint + MoveJ 를 쓴다. 사용법: home.py [속도]"""
import sys, time, numpy as np, rclpy
from rclpy.node import Node
from fairino_msgs.msg import RobotNonrtState
from fairino_msgs.srv import RemoteCmdInterface
from rcl_interfaces.srv import SetParameters
from rcl_interfaces.msg import Parameter, ParameterValue, ParameterType

HOME_JOINTS = [71.232, -77.373, 88.429, -100.799, -89.955, -18.064]
speed = int(sys.argv[1]) if len(sys.argv) > 1 else 10

rclpy.init(); n = Node("home"); st = {}
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

def joints(timeout=5.0):
    r = send("GetActualJointPosDegree(0)")
    return [float(v) for v in str(r).split(",")][1:7]

# 서보용 offset 이 남아 있으면 이후 이동에 더해진다 — 0 으로 되돌린다
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
cur = joints()
print("현재 관절  [" + ", ".join(f"{v:.3f}" for v in cur) + "]")
print("홈  관절  [" + ", ".join(f"{v:.3f}" for v in HOME_JOINTS) + "]")
print(f"최대 차이  {max(abs(c-h) for c, h in zip(cur, HOME_JOINTS)):.2f}도   속도 {speed}%")

r1 = send("JNTPoint(1," + ",".join(f"{v:.3f}" for v in HOME_JOINTS) + ")")
if str(r1).strip() != "0": sys.exit(f"JNTPoint 거부 (코드 {r1})")
r2 = send(f"MoveJ(JNT1,{speed},1,1)")
if str(r2).strip() != "0": sys.exit(f"MoveJ 거부 (코드 {r2})")

t = time.time()
while time.time()-t < 120.0:
    rclpy.spin_once(n, timeout_sec=0.1)
    cur = joints()
    if max(abs(c-h) for c, h in zip(cur, HOME_JOINTS)) < 0.5:
        print(f"도달 ({time.time()-t:.1f}초)")
        break
    time.sleep(0.3)
else:
    print("✗ 120초 내 도달 못함")
cur = joints()
print("도달 관절  [" + ", ".join(f"{v:.3f}" for v in cur) + "]")
s = st.get("s")
if s: print(f"TCP  ({s.cart_x_cur_pos:.2f}, {s.cart_y_cur_pos:.2f}, {s.cart_z_cur_pos:.2f})  "
            f"그리퍼 done={s.grip_motion_done}")
n.destroy_node(); rclpy.shutdown()
