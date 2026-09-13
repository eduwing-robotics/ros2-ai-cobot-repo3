import rclpy, numpy as np, cv2
from rclpy.node import Node
from sensor_msgs.msg import Image
from rclpy.qos import qos_profile_sensor_data
rclpy.init(); n = Node("dpp"); got = {}
n.create_subscription(Image, "/camera/camera/aligned_depth_to_color/image_raw",
    lambda m: got.__setitem__("d", np.frombuffer(m.data, np.uint16).reshape(m.height, m.width).astype(np.float32)),
    qos_profile_sensor_data)
for _ in range(400):
    rclpy.spin_once(n, timeout_sec=0.1)
    if "d" in got: break
d = got["d"]; d[d == 0] = np.nan
def patch(u, v, r=3):
    w = d[max(0,v-r):v+r+1, max(0,u-r):u+r+1]
    w = w[~np.isnan(w)]
    return (np.median(w), w.size) if w.size else (float("nan"), 0)
pts = {"물체A(왼쪽)": (297, 277), "물체B(오른쪽)": (373, 251),
       "격자 리브 (A 옆)": (297, 258), "격자 리브 (A 아래)": (297, 296),
       "격자 리브 (B 옆)": (373, 232), "빈 칸 바닥1": (320, 277), "빈 칸 바닥2": (345, 300),
       "트레이 테두리 좌": (247, 277), "트레이 테두리 하": (330, 345),
       "트레이 바깥 매트": (180, 277), "흰 바닥": (60, 430)}
print(f"{'지점':22s} {'깊이mm':>8s} {'유효px':>6s}")
for k, (u, v) in pts.items():
    z, cnt = patch(u, v)
    print(f"{k:22s} {z:8.1f} {cnt:6d}")
