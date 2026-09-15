# 실기 어댑터 v1 — repo2 원본 대조 (2026-07-31, 스택가드):
#   · 브링업: dual_bringup.launch.py namespace:=tb3_1|tb3_2 — 네임스페이스 방식, 도메인 하나
#   · cmd_vel: /{ns}/cmd_vel · **TwistStamped** (Jazzy — turtlebot3_node가 stamped 구독,
#     repo2 teleop_stamped.py · patch_nav_params_ns.py enable_stamped_cmd_vel=True)
#   · 위치: /{ns}/amcl_pose (map 좌표 · Nav2 중) → 없으면 /{ns}/odom 폴백 (odom 좌표 — 드리프트)
#   · 연결 판정: odom 2초 무수신 → connected=False (TB-CONTRACT §안전 규칙)
# v1 범위: 상태·teleop·stop. SLAM/Nav2 프로세스 기동은 실기 현장에서 config 명령으로 확정한다.
import math
import threading
import time

from .base import RosAdapter

ODOM_TIMEOUT_S = 2.0


def _quat_to_deg(q):
    # z-yaw 만 필요하다 (바닥 평면 · D28 과 같은 3자유도)
    yaw = math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
    return math.degrees(yaw) % 360


class RealAdapter(RosAdapter):
    def __init__(self, robot_ids, on_log):
        import rclpy                                   # 우분투에서만 성립 — 경계 안 import (D30)
        from geometry_msgs.msg import PoseWithCovarianceStamped, TwistStamped
        from nav_msgs.msg import Odometry
        from sensor_msgs.msg import BatteryState, Imu
        from std_srvs.srv import Trigger

        self._on_log = on_log
        self._lock = threading.Lock()
        self._r = {
            rid: {
                "connected": False, "poseAgeSec": None, "mode": "idle", "nav": None,
                "pose": {"xMm": 0.0, "yMm": 0.0, "thetaDeg": 0.0},
                "imuYawDeg": None,            # 두 번째 눈 — raw(보정 전) · 계약 §두 번째 눈
                "imuYawIntDeg": None,         # 자이로 원본 적분 — Madgwick 을 우회한다 (D142)
                "velocity": {"linearMmS": 0.0, "angularDegS": 0.0},
                "batteryPct": None, "batteryV": None, "activeMap": None, "activeSlot": None,
                "activeRunId": None, "owner": None,
                "_odom_at": 0.0, "_amcl_at": 0.0, "_imu_at": 0.0, "_trail": [],
                "_gyro_acc": 0.0, "_gyro_at": 0.0,
                "_teleop_at": 0.0, "_teleop_active": False,
            }
            for rid in robot_ids
        }

        rclpy.init()
        self._node = rclpy.create_node("tb_bridge")
        self._TwistStamped = TwistStamped
        self._Trigger = Trigger
        self._pubs = {}
        self._reset_cli = {}
        for rid in robot_ids:
            self._pubs[rid] = self._node.create_publisher(TwistStamped, f"/{rid}/cmd_vel", 10)
            self._node.create_subscription(Odometry, f"/{rid}/odom",
                                           lambda m, rid=rid: self._on_odom(rid, m), 10)
            self._node.create_subscription(PoseWithCovarianceStamped, f"/{rid}/amcl_pose",
                                           lambda m, rid=rid: self._on_amcl(rid, m), 10)
            # 배터리 — 판정은 전압으로 한다 (계약 §배터리). 3셀 리포는 부하에 순간 전압이 주저앉고
            # OpenCR 은 그 순간값으로 모터를 끊는다. 08-19 에 11.08V 로 조종이 안 됐다
            self._node.create_subscription(BatteryState, f"/{rid}/battery_state",
                                           lambda m, rid=rid: self._on_battery(rid, m), 10)
            # **두 번째 눈** — 엔코더는 헛도는 바퀴를 구분 못 한다 (계약 §두 번째 눈).
            # 2026-08-20 실측: 한 바퀴 뒤 odom 428mm vs 캠 4mm — 회전 4번이 회전당 ~107mm 를 쌓았다.
            # 슬롯 안에서만 보던 값을 **모든 주행**(텔레옵 포함)에서 보이게 한다
            self._node.create_subscription(Imu, f"/{rid}/imu",
                                           lambda m, rid=rid: self._on_imu(rid, m), 10)
            # 원점 재설정 — turtlebot3_node 가 이미 갖고 있다 (계약 §원점 재설정)
            self._reset_cli[rid] = self._node.create_client(Trigger, f"/{rid}/reset_odometry")

        threading.Thread(target=lambda: rclpy.spin(self._node), daemon=True).start()
        threading.Thread(target=self._watch, daemon=True).start()
        on_log("-", "bridge", "info", f"real 어댑터 기동 — robots={robot_ids} (네임스페이스 방식)")

    # ── 콜백 — m·rad 는 여기서만 mm·도로 바뀐다 ────────────────────────────
    def _on_odom(self, rid, m):
        with self._lock:
            r = self._r[rid]
            r["_odom_at"] = time.time()
            r["velocity"] = {
                "linearMmS": m.twist.twist.linear.x * 1000.0,
                "angularDegS": math.degrees(m.twist.twist.angular.z),
            }
            if time.time() - r["_amcl_at"] > 3.0:      # amcl 이 살아있으면 그쪽이 정본
                self._set_pose(r, m.pose.pose)

    def _on_amcl(self, rid, m):
        with self._lock:
            r = self._r[rid]
            r["_amcl_at"] = time.time()
            self._set_pose(r, m.pose.pose)

    def _on_imu(self, rid, m):
        # 두 값을 **나란히** 싣는다 (D142) —
        #   `imuYawDeg`    : OpenCR 이 Madgwick 으로 만든 orientation. ⛔ **못 믿는다.**
        #     ROBOTIS 펌웨어는 **지자기를 안 쓰므로** yaw 가 관측 불가능한 채로 필터를 돈다.
        #     우리 실측(2026-08-20): 90° 회전에 103°(+13%) · 180° 회전에 166°(−10%) —
        #     **각도에 따라 부호가 뒤집히므로 스케일 상수로는 원리적으로 못 고친다.**
        #   `imuYawIntDeg` : **자이로 원본(`angular_velocity.z`) 적분** — 필터를 통째로 우회한다.
        #     약점인 바이어스 누적은 실측 **0.001°/s**(정지 30초에 0.015°)라 12초 회전에서 0.012°다.
        # ⛔ 보정을 여기서 하지 않는다 — 미리 곱해 내보내면 그 값이 틀렸을 때 볼 방법이 사라진다.
        now = time.time()
        with self._lock:
            r = self._r[rid]
            r["_imu_at"] = now
            r["imuYawDeg"] = _quat_to_deg(m.orientation)
            # 사다리꼴 적분이 아니라 직사각형이다 — 20Hz 에서 차이가 오차 예산 밖이고,
            # 첫 틱은 dt 를 모르므로 건너뛴다. 1초 넘게 끊기면 그 구간은 **버린다**
            # (없는 회전을 지어내느니 모르는 채로 두는 쪽이 맞다 · 하드 룰 6 과 같은 정신)
            dt = now - r["_gyro_at"] if r["_gyro_at"] else None
            r["_gyro_at"] = now
            if dt is not None and 0 < dt < 1.0:
                r["_gyro_acc"] = (r["_gyro_acc"] + math.degrees(m.angular_velocity.z) * dt) % 360
                r["imuYawIntDeg"] = round(r["_gyro_acc"], 2)

    def _on_battery(self, rid, m):
        with self._lock:
            r = self._r[rid]
            v = float(m.voltage)
            r["batteryV"] = round(v, 2) if v == v and v > 0 else None      # NaN·0 은 「못 읽음」이다
            pct = float(m.percentage)
            r["batteryPct"] = round(pct) if pct == pct and pct > 0 else None

    def _set_pose(self, r, pose):
        r["pose"] = {
            "xMm": pose.position.x * 1000.0,
            "yMm": pose.position.y * 1000.0,
            "thetaDeg": _quat_to_deg(pose.orientation),
        }
        if abs(r["velocity"]["linearMmS"]) > 5:
            r["_trail"].append((r["pose"]["xMm"], r["pose"]["yMm"]))
            if len(r["_trail"]) > 2000:
                r["_trail"].pop(0)

    def _watch(self):
        # 워치독 두 겹 — ① teleop 500ms 무신호 → 정지 (mock 은 시뮬 루프가 했지만
        # 실기는 마지막 cmd_vel 로 계속 구른다 — 어댑터가 반드시 세운다, §안전 규칙)
        # ② odom 2s 무수신 → 연결 손실 판정
        while True:
            stops = []
            with self._lock:
                for rid, r in self._r.items():
                    # 조건은 「teleop 모드인데 500ms 조용하다」다 — 「마지막 명령이 0 이 아니었나」가
                    # 아니다. 2026-08-19 실기: 정지(0,0)로 끝내면 `_teleop_active` 가 False 라
                    # 워치독이 안 돌고 **mode 가 teleop 에 영원히 머물렀다**. 그러면 계약 §모드 전이의
                    # 「idle 에서만 시작」에 걸려 슬롯이 영영 안 뜬다 (mock 도 같은 모양이었다)
                    if r["mode"] == "teleop" and time.time() - r["_teleop_at"] > 0.5:
                        r["_teleop_active"] = False
                        r["mode"] = "idle"
                        stops.append((rid, "teleop watchdog 500ms — 정지 · idle 복귀"))
                    age = time.time() - r["_odom_at"] if r["_odom_at"] else None
                    was = r["connected"]
                    r["connected"] = age is not None and age < ODOM_TIMEOUT_S
                    r["poseAgeSec"] = round(age, 1) if age is not None else None
                    # IMU 도 같은 규칙 — 늙은 값을 「두 번째 눈」으로 쓰면 대조했다는 말이 거짓이 된다
                    if not r["_imu_at"] or time.time() - r["_imu_at"] > ODOM_TIMEOUT_S:
                        r["imuYawDeg"] = None
                        r["imuYawIntDeg"] = None
                    if was and not r["connected"]:
                        stops.append((rid, "odom 2s 무수신 — 연결 손실 판정, cmd_vel 0"))
            for rid, why in stops:
                self._on_log(rid, "bridge", "warn", why)
                self._publish_stop(rid)
            time.sleep(0.1)

    # ── 명령 ────────────────────────────────────────────────────────────────
    def _publish(self, rid, linear_mm_s, angular_deg_s):
        msg = self._TwistStamped()
        msg.header.stamp = self._node.get_clock().now().to_msg()
        msg.twist.linear.x = linear_mm_s / 1000.0      # mm/s → m/s (경계 변환)
        msg.twist.angular.z = math.radians(angular_deg_s)
        self._pubs[rid].publish(msg)

    def _publish_stop(self, rid):
        self._publish(rid, 0.0, 0.0)

    def set_velocity(self, robot, linear_mm_s, angular_deg_s):
        with self._lock:
            r = self._r[robot]
            if r["mode"] == "idle":
                r["mode"] = "teleop"
            r["_teleop_at"] = time.time()
            r["_teleop_active"] = bool(linear_mm_s or angular_deg_s)
        self._publish(robot, linear_mm_s, angular_deg_s)

    def stop(self, robot):
        self._publish_stop(robot)
        with self._lock:
            r = self._r[robot]
            r["mode"] = "idle"
            r["activeSlot"] = None
            r["_teleop_active"] = False

    def reset_odom(self, robot):
        cli = self._reset_cli.get(robot)
        if cli is None or not cli.wait_for_service(timeout_sec=2.0):
            return False, "로봇의 reset_odometry 서비스가 안 보여요 (브링업 확인)"
        fut = cli.call_async(self._Trigger.Request())
        # spin 은 이미 별도 스레드가 돈다 — 여기서는 완료만 기다린다 (겹쳐 돌리면 rclpy 가 깨진다)
        for _ in range(40):
            if fut.done():
                res = fut.result()
                return bool(res.success), (res.message or "")
            time.sleep(0.05)
        return False, "reset_odometry 응답이 2초 안에 안 왔어요"

    def set_mode(self, robot, mode):
        with self._lock:
            self._r[robot]["mode"] = mode

    def set_active_map(self, robot, map_name):
        with self._lock:
            self._r[robot]["activeMap"] = map_name

    def robots(self):
        with self._lock:
            return {
                rid: {k: (dict(v) if isinstance(v, dict) else v) for k, v in r.items() if not k.startswith("_")}
                for rid, r in self._r.items()
            }

    def patch(self, robot, **fields):
        with self._lock:
            self._r[robot].update(fields)

    def trail(self, robot):
        with self._lock:
            return list(self._r[robot]["_trail"])
