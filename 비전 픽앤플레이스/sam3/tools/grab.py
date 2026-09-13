import rclpy, numpy as np, cv2, sys
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data

OUT = "/tmp/claude-1000/-home-kimsunil/5728c06f-96bc-41fc-8cf7-e139a821954a/scratchpad"
rclpy.init(); n = Node("grab")
got = {}
def cb_c(m):
    got["c"] = np.frombuffer(m.data, np.uint8).reshape(m.height, m.width, -1)
def cb_d(m):
    got["d"] = np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)
n.create_subscription(Image, "/camera/camera/color/image_raw", cb_c, qos_profile_sensor_data)
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw", cb_d, qos_profile_sensor_data)
for _ in range(300):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "c" in got and "d" in got: break
if "c" not in got: print("색 프레임 못 받음"); sys.exit(1)
c = got["c"]
cv2.imwrite(f"{OUT}/view.png", c)
d = got.get("d")
if d is not None:
    v = d[d > 0]
    print(f"depth 유효 {v.size/d.size*100:.0f}%  중앙 {np.median(v):.0f}mm  범위 {v.min():.0f}~{v.max():.0f}mm")
    print(f"화면중심(320,240) 깊이 = {d[240,320]:.0f}mm")
print(f"저장: {OUT}/view.png  ({c.shape})")
