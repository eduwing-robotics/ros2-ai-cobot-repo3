#!/usr/bin/env python3
"""실물 작업대의 좌표를 로봇에서 받아 적는다. MuJoCo 씬을 실물에 맞추기 위한 것.

fr5_joint_publisher.py 와 같은 방식 — ros2_cmd_server 의 RemoteCmdInterface RPC 로
현재 TCP 좌표를 읽는다. 팔을 움직이지 않으므로 안전하다.

사전 준비:
  ros2 run fairino_hardware_v3_9_7 ros2_cmd_server

사용법:
  python3 capture_scene_points.py
  → 각 지점 위로 Jog 한 뒤 Enter. 마지막에 scene_points.json 으로 저장한다.
"""
import json, os, sys
import rclpy
from rclpy.node import Node
from fairino_msgs.srv import RemoteCmdInterface

SERVICE = "/fairino_remote_command_service"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scene_points.json")

POINTS = [
    ("tray_head",  "탄두 트레이 중심 바로 위"),
    ("tray_case",  "탄피 트레이 중심 바로 위"),
    ("jig",        "지그(누운 물체 놓는 곳) 중심 바로 위"),
    ("mat_c1",     "매트 모서리 1 (예: 좌상단)"),
    ("mat_c2",     "매트 모서리 2 (대각선 반대편)"),
    ("table",      "테이블 면에 그리퍼 끝을 살짝 닿게 (높이 기준)"),
]


class Reader(Node):
    def __init__(self):
        super().__init__("capture_scene_points")
        self.cli = self.create_client(RemoteCmdInterface, SERVICE)
        print(f"{SERVICE} 를 기다립니다…")
        if not self.cli.wait_for_service(timeout_sec=30.0):
            raise SystemExit("ros2_cmd_server 가 없습니다.\n"
                             "  ros2 run fairino_hardware_v3_9_7 ros2_cmd_server")
        print("연결됐습니다.\n")

    def call(self, cmd, timeout=2.0):
        req = RemoteCmdInterface.Request(); req.cmd_str = cmd
        fut = self.cli.call_async(req)
        rclpy.spin_until_future_complete(self, fut, timeout_sec=timeout)
        if not fut.done() or fut.result() is None: return None
        return fut.result().cmd_res

    def tcp(self):
        """GetActualTCPPose(0) → '0,x,y,z,rx,ry,rz' 형태를 기대한다."""
        res = self.call("GetActualTCPPose(0)")
        if res is None: return None, "응답 없음"
        try:
            vals = [float(v) for v in str(res).replace(" ", "").split(",") if v not in ("",)]
            nums = vals[1:] if len(vals) >= 7 else vals
            if len(nums) < 6: return None, f"파싱 실패: {res!r}"
            return nums[:6], str(res)
        except Exception as e:
            return None, f"파싱 실패({e}): {res!r}"


def main():
    rclpy.init()
    r = Reader()
    got = {}
    try:
        for key, desc in POINTS:
            input(f"[{key}] {desc} 로 Jog 한 뒤 Enter (건너뛰려면 s+Enter): ") .strip().lower()
            pose, raw = r.tcp()
            if pose is None:
                print(f"   ! {raw}\n"); continue
            got[key] = dict(x=pose[0], y=pose[1], z=pose[2],
                            rx=pose[3], ry=pose[4], rz=pose[5])
            print(f"   x={pose[0]:8.2f} y={pose[1]:8.2f} z={pose[2]:8.2f}  "
                  f"rx={pose[3]:7.2f} ry={pose[4]:7.2f} rz={pose[5]:7.2f}\n")
    except (KeyboardInterrupt, EOFError):
        print("\n중단")
    finally:
        if got:
            json.dump(got, open(OUT, "w"), indent=1, ensure_ascii=False)
            print(f"\n저장: {OUT}  ({len(got)}개 지점)")
            if "mat_c1" in got and "mat_c2" in got:
                dx = abs(got["mat_c1"]["x"]-got["mat_c2"]["x"])
                dy = abs(got["mat_c1"]["y"]-got["mat_c2"]["y"])
                print(f"  매트 크기 추정: {dx:.0f} x {dy:.0f} mm")
        else:
            print("\n기록된 지점이 없습니다.")
        r.destroy_node(); rclpy.shutdown()


if __name__ == "__main__":
    main()
