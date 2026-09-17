#
# ══════════════════════════════════════════════════════════════════════════════
#  ⚠️  이 파일의 값은 실물 FR5 로봇에서 그대로 실행된다
# ══════════════════════════════════════════════════════════════════════════════
#
#  원칙
#    1. 실물에 관한 값은 임의로 정하지 않는다.
#       치수·속도·힘·좌표는 실측하거나 공식 문서에 근거해야 한다.
#       근거가 없으면 값을 넣지 말고 먼저 물어본다.
#
#    2. 근거 없는 값을 부득이 쓸 때는 반드시 [추정] 으로 표시하고,
#       무엇을 근거로 잡았는지 함께 적는다. 실측되면 즉시 교체한다.
#
#    3. 시험용으로 넣은 것은 되돌릴 때 완전히 제거한다.
#       모델·시각화·실물 명령 세 곳이 항상 같은 값을 가리켜야 한다.
#       (실제 사고: 시뮬 파지 폭만 고치고 실물 명령은 완전 닫힘으로 방치)
#
#    4. 실물 구조에 대한 가정이 들어가는 변경은 먼저 확인을 받는다.
#       (실제 사고: 회전형 엔드이펙터를 임의로 모델에 추가)
#
#  현재 값의 근거는 각 상수 옆 주석과 보고서 '실물 전송 값 점검표' 참조.
#
#
# 🔌 FR5 실물 로봇 동기 실행 브리지
#
# ─ 왜 필요한가 ────────────────────────────────────────────────────────────
# 로봇 API 명령(MoveJ, MoveGripper)은 "명령을 접수했다"는 응답을 즉시 돌려주고
# 실제 물리 동작이 끝날 때까지 기다려주지 않는다. 교육자료 14장에 기록된 실패 사례:
#
#     하강 명령을 보내고 곧바로 그리퍼 닫기 명령을 보냈더니,
#     팔이 채 내려가기도 전에 그리퍼가 먼저 닫혀버림.
#
# 기존 fr5_multi_fleet_control.send_command_to_real_fr5_robot() 은 명령을 던지고
# 바로 다음 스텝으로 넘어가는 스텁이라, 실물에 그대로 물리면 위 실패가 재현된다.
# 이 모듈은 /nonrt_state_data 를 폴링해 "실제 도착"을 확인한 뒤 다음 단계로 넘어간다.
#
# ─ 확인한 인터페이스 (추측 아님, 워크스페이스에서 직접 확인) ───────────────
#   서비스 : /fairino_remote_command_service  (fairino_msgs/srv/RemoteCmdInterface)
#            요청 cmd_str -> 응답 cmd_res ("0"=성공, "-1"=실패)
#   토픽   : /nonrt_state_data                (fairino_msgs/msg/RobotNonrtState)
#            cart_x/y/z_cur_pos, cart_a/b/c_cur_pos, j1~j6_cur_pos,
#            robot_motion_done, grip_motion_done, emg, abnormal_stop
#
# ─ 사전 준비 ──────────────────────────────────────────────────────────────
#   source /opt/ros/jazzy/setup.bash
#   source ~/fr5_jazzy_test_ws/install/setup.bash
#   ros2 run fairino_hardware_v3_9_7 ros2_cmd_server
#
import math
import time

# ── 명령어 화이트리스트 ───────────────────────────────────────────────────
# 교육자료 10~11장에서 실기로 정상 동작이 확인된 명령만 허용한다.
ALLOWED_COMMANDS = {
    "SetSpeed", "RobotEnable", "Mode",
    "JNTPoint", "CARTPoint", "MoveJ",
    "ActGripper", "MoveGripper",
    "GET",
}

# ⚠️ 서버(libfairino.so) 세그폴트가 확정된 명령. 화이트리스트에 없을 뿐 아니라
#    실수로 추가하지 않도록 이유와 함께 따로 적어 둔다.
BANNED_COMMANDS = {
    "MoveL":      "ros2_cmd_server 세그폴트 확정 (교육자료 11장)",
    "MoveC":      "ros2_cmd_server 세그폴트 확정",
    "StartJOG":   "ros2_cmd_server 세그폴트 확정",
    "StopJOG":    "ros2_cmd_server 세그폴트 확정",
    "ImmStopJOG": "ros2_cmd_server 세그폴트 확정",
}

# ── 관절 한계 (deg) — FR5 공식값, 교육자료 1장 1-1 Working Range ──────────
# Soft Limit: 소프트웨어가 먼저 멈추는 안전 경계. 일반 운용은 반드시 이 안에서.
# Hard Limit: 하드웨어가 물리적으로 차단하는 절대 한계.
# ⚠️ 원본 URDF 의 j3 는 ±162° 로, Hard Limit(±152°)조차 넘는 값이었다.
#    IK 가 그 범위를 쓰면 실물에서 도달 불가능한 관절각을 만들어낸다. Soft 로 교정.
JOINT_LIMITS_DEG = {
    "j1": (-175.0, 175.0),
    "j2": (-265.0,  85.0),
    "j3": (-150.0, 150.0),
    "j4": (-265.0,  85.0),
    "j5": (-175.0, 175.0),
    "j6": (-175.0, 175.0),
}
JOINT_HARD_LIMITS_DEG = {
    "j1": (-179.0, 179.0),
    "j2": (-269.0,  89.0),
    "j3": (-152.0, 152.0),
    "j4": (-269.0,  89.0),
    "j5": (-179.0, 179.0),
    "j6": (-179.0, 179.0),
}
# Soft 가 Hard 안에 들어있지 않으면 표가 잘못된 것이므로 임포트 시점에 잡는다
for _j, (_lo, _hi) in JOINT_LIMITS_DEG.items():
    _hlo, _hhi = JOINT_HARD_LIMITS_DEG[_j]
    assert _hlo <= _lo and _hi <= _hhi, f"{_j}: Soft Limit 이 Hard Limit 을 벗어납니다"


class FR5CommandError(RuntimeError):
    """명령이 거부되었거나 로봇이 실패를 반환한 경우."""


class FR5SafetyError(RuntimeError):
    """비상정지·이상정지 등 즉시 중단해야 하는 상태."""


def check_command(cmd_str):
    """로봇에 보내기 전에 파이썬 단에서 검사한다. 통과하면 함수명을 돌려준다."""
    name = cmd_str.split("(", 1)[0].strip()
    if name in BANNED_COMMANDS:
        raise FR5CommandError(f"'{name}' 은 금지 명령입니다 — {BANNED_COMMANDS[name]}")
    if name not in ALLOWED_COMMANDS:
        raise FR5CommandError(
            f"'{name}' 은 화이트리스트에 없습니다. 실기 검증된 명령만 허용합니다: "
            f"{sorted(ALLOWED_COMMANDS)}")
    return name


def check_joint_limits(joints_deg):
    """MoveJ 로 보내기 전에 Soft Limit 을 넘는지 확인 (넘으면 전송하지 않는다)."""
    for (name, (lo, hi)), v in zip(JOINT_LIMITS_DEG.items(), joints_deg):
        if not (lo <= v <= hi):
            raise FR5CommandError(
                f"{name}={v:.2f}° 가 Soft Limit [{lo}, {hi}] 을 벗어납니다. 전송하지 않습니다.")


class FR5Bridge:
    """
    실물 FR5 동기 실행 브리지.

    모든 이동/그리퍼 명령은 '완료 확인'까지 하고 나서 반환한다.
    dry_run=True 면 ROS 에 연결하지 않고 보낼 명령만 출력한다(하드웨어 없이 검증용).
    """

    def __init__(self, dry_run=True, timeout_service=5.0, poll_hz=20.0):
        self.dry_run = dry_run
        self.poll_dt = 1.0 / poll_hz
        self.sent = []            # dry-run 로그 / 사후 검증용
        self._node = None
        self._client = None
        self._state = None
        if dry_run:
            print("🧪 [dry-run] ROS 연결 없이 명령만 검증·출력합니다.")
            return

        import rclpy
        from rclpy.node import Node
        from rclpy.qos import QoSProfile, ReliabilityPolicy
        from fairino_msgs.srv import RemoteCmdInterface
        from fairino_msgs.msg import RobotNonrtState

        if not rclpy.ok():
            rclpy.init()
        self._rclpy = rclpy
        self._node = Node("fr5_screw_assembly_bridge")
        self._client = self._node.create_client(
            RemoteCmdInterface, "/fairino_remote_command_service")
        if not self._client.wait_for_service(timeout_sec=timeout_service):
            raise FR5CommandError(
                "/fairino_remote_command_service 에 연결하지 못했습니다. "
                "'ros2 run fairino_hardware_v3_9_7 ros2_cmd_server' 가 떠 있는지 확인하세요.")
        self._node.create_subscription(
            RobotNonrtState, "/nonrt_state_data", self._on_state,
            QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT))
        self._req = RemoteCmdInterface.Request()
        print("✅ FR5 서비스 연결 완료")

    # ── 상태 ──────────────────────────────────────────────────────────────
    # ── 바닥 가드 — **움직이는 동안** 그리퍼가 금지선에 닿으면 세운다 ──────────
    # 사전 검사(fr5_execute_policy [3-b])는 "보낼 계획"을 본다. 이건 "실제로 가는 중"을
    # 본다. 서보 지연·미끄러짐·사람이 중간에 건드린 경우는 계획에 안 나온다.
    #
    # ⚠ **쓸 수 있는 정지 수단이 RobotEnable(0) 하나뿐이다.**
    #   StopJOG / ImmStopJOG 는 ros2_cmd_server 세그폴트가 확정이라 BANNED 다(위 목록).
    #   그래서 "감속 정지"가 아니라 서보를 끄고 브레이크로 세우는 방식이다.
    #   되돌리려면 RobotEnable(1) 부터 다시 해야 한다.
    def set_floor_guard(self, z_mm, bodies=None):
        """금지선 높이(mm, 로봇 base 기준)를 걸어둔다. `None` 이면 끈다."""
        self._floor_z_mm = z_mm
        self._floor_bodies = bodies

    def _assert_floor(self, s):
        """지금 자세에서 그리퍼가 금지선에 닿았나. 닿았으면 서보를 끄고 던진다."""
        z_lim = getattr(self, "_floor_z_mm", None)
        if z_lim is None:
            return
        import selfcheck
        j = [s.j1_cur_pos, s.j2_cur_pos, s.j3_cur_pos,
             s.j4_cur_pos, s.j5_cur_pos, s.j6_cur_pos]
        z, who = selfcheck.gripper_min_z_mm(j)
        if z <= z_lim:                      # **닿으면** 이미 늦다 — 등호 포함
            try:
                self.send_cmd("RobotEnable(0)")     # 유일한 정지 수단
            finally:
                raise FR5SafetyError(
                    f"바닥 가드: {who} 가 z={z:.1f}mm — 금지선 {z_lim:.1f}mm 에 닿았습니다. "
                    f"서보를 껐습니다(RobotEnable(0)). 자세를 확인하고 다시 시작하세요.")

    def _on_state(self, msg):
        self._state = msg

    def spin_once(self, timeout=0.1):
        if not self.dry_run:
            self._rclpy.spin_once(self._node, timeout_sec=timeout)

    def state(self, wait_s=2.0):
        """최신 /nonrt_state_data. 아직 안 왔으면 잠깐 기다린다."""
        if self.dry_run:
            return None
        t0 = time.time()
        while self._state is None and time.time() - t0 < wait_s:
            self.spin_once()
        if self._state is None:
            raise FR5CommandError("/nonrt_state_data 가 수신되지 않습니다. 드라이버를 확인하세요.")
        return self._state

    def _assert_safe(self, s):
        if s is None:
            return
        if getattr(s, "emg", 0):
            raise FR5SafetyError("비상정지(EMG)가 눌렸습니다. 실행을 중단합니다.")
        if getattr(s, "abnormal_stop", 0):
            raise FR5SafetyError("이상정지(abnormal_stop) 상태입니다. 실행을 중단합니다.")

    # ── 명령 전송 ─────────────────────────────────────────────────────────
    def send_cmd(self, cmd_str):
        """화이트리스트 검사 후 전송. 응답이 '0'(성공)이 아니면 예외."""
        check_command(cmd_str)
        self.sent.append(cmd_str)
        if self.dry_run:
            print(f"   → {cmd_str}")
            return "0"
        self._assert_safe(self._state)
        self._req.cmd_str = cmd_str
        future = self._client.call_async(self._req)
        self._rclpy.spin_until_future_complete(self._node, future, timeout_sec=10.0)
        if not future.done():
            raise FR5CommandError(f"명령 응답 없음(타임아웃): {cmd_str}")
        res = future.result().cmd_res
        if str(res).strip() not in ("0", "0.0"):
            raise FR5CommandError(f"로봇이 명령을 거부했습니다: {cmd_str} -> {res}")
        return res

    # ── 완료 대기 ─────────────────────────────────────────────────────────
    def wait_for_arm(self, target_xyz_mm, tol_mm=3.0, timeout_s=90.0):
        """
        팔이 목표 직교좌표(mm)에 실제로 도착할 때까지 대기.

        robot_motion_done 만 믿지 않고 실제 좌표 오차도 같이 본다.
        (motion_done 은 '명령 큐가 비었다'는 뜻이라, 도중에 정지해도 1이 될 수 있다)
        """
        if self.dry_run:
            print(f"   ⏳ wait_for_arm{tuple(round(float(v), 1) for v in target_xyz_mm)} "
                  f"tol={tol_mm}mm  (dry-run: 즉시 통과)")
            return True
        tx, ty, tz = target_xyz_mm
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            self.spin_once()
            s = self._state
            if s is None:
                continue
            self._assert_safe(s)
            self._assert_floor(s)
            d = math.dist((s.cart_x_cur_pos, s.cart_y_cur_pos, s.cart_z_cur_pos),
                          (tx, ty, tz))
            if d <= tol_mm and getattr(s, "robot_motion_done", 1):
                return True
            time.sleep(self.poll_dt)
        raise FR5CommandError(
            f"팔이 {timeout_s}s 안에 목표에 도달하지 못했습니다 "
            f"(목표 {tx:.1f},{ty:.1f},{tz:.1f} / 허용 {tol_mm}mm)")

    def wait_for_joints(self, target_deg, tol_deg=0.5, timeout_s=90.0):
        """
        관절각이 목표에 도달할 때까지 대기하고, 걸린 시간을 돌려준다.

        wait_for_arm 은 TCP 직교좌표로 판정하는데, j6 만 도는 동작은 파지중심이
        회전축 위에 있어(실측 편심 0mm) TCP 가 전혀 움직이지 않는다.
        그래서 좌표로는 '이미 도착'으로 보여 즉시 통과해버린다. 관절각으로 봐야 한다.
        """
        if self.dry_run:
            print(f"   ⏳ wait_for_joints(j6={target_deg[5]:.1f}°) (dry-run: 즉시 통과)")
            return 0.0
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            self.spin_once()
            s = self._state
            if s is not None:
                self._assert_safe(s)
                self._assert_floor(s)
                cur = [s.j1_cur_pos, s.j2_cur_pos, s.j3_cur_pos,
                       s.j4_cur_pos, s.j5_cur_pos, s.j6_cur_pos]
                if max(abs(a - b) for a, b in zip(cur, target_deg)) <= tol_deg:
                    return time.time() - t0
            time.sleep(self.poll_dt)
        raise FR5CommandError(f"관절이 {timeout_s}s 안에 목표에 도달하지 못했습니다.")

    def wait_for_gripper(self, timeout_s=5.0):
        """그리퍼 동작 완료(grip_motion_done==1)까지 대기."""
        if self.dry_run:
            print("   ⏳ wait_for_gripper  (dry-run: 즉시 통과)")
            return True
        t0 = time.time()
        # 명령 직후에는 이전 동작의 done 이 남아 있을 수 있으므로 먼저 0 으로 떨어지길 본다
        while time.time() - t0 < 0.5:
            self.spin_once()
            if self._state is not None and not self._state.grip_motion_done:
                break
            time.sleep(self.poll_dt)
        while time.time() - t0 < timeout_s:
            self.spin_once()
            s = self._state
            if s is not None:
                self._assert_safe(s)
                if s.grip_motion_done == 1:
                    return True
            time.sleep(self.poll_dt)
        raise FR5CommandError(f"그리퍼가 {timeout_s}s 안에 동작을 마치지 못했습니다.")

    # ── 상위 동작 (전부 완료 확인까지 하고 반환한다) ──────────────────────
    def startup(self, speed_percent=10):
        """속도 -> 활성화 -> 모드 순서. 교육자료 11장 검증 시퀀스."""
        self.send_cmd(f"SetSpeed({int(speed_percent)})")
        self.send_cmd("RobotEnable(1)")
        self.send_cmd("Mode(0)")

    def shutdown(self):
        try:
            self.send_cmd("RobotEnable(0)")
        finally:
            if not self.dry_run and self._node is not None:
                self._node.destroy_node()

    def current_joints_deg(self):
        s = self.state()
        if s is None:
            return [0.0] * 6
        return [s.j1_cur_pos, s.j2_cur_pos, s.j3_cur_pos,
                s.j4_cur_pos, s.j5_cur_pos, s.j6_cur_pos]

    def current_pose_mm(self):
        s = self.state()
        if s is None:
            return (0.0, 0.0, 0.0)
        return (s.cart_x_cur_pos, s.cart_y_cur_pos, s.cart_z_cur_pos)

    def move_joints(self, joints_deg, target_xyz_mm, vel=10, point_id=1,
                    tool=1, user=0, tol_mm=3.0, timeout_s=90.0):
        """
        관절각으로 이동하고 실제 도착까지 대기.

        MoveL 이 서버 세그폴트를 내므로 직교 이동도 IK 로 관절각을 만들어 MoveJ 로 보낸다.
        target_xyz_mm 은 그 관절각에 해당하는 예상 TCP 위치(도착 판정용)다.
        """
        check_joint_limits(joints_deg)
        j = ",".join(f"{v:.4f}" for v in joints_deg)
        self.send_cmd(f"JNTPoint({point_id},{j})")
        self.send_cmd(f"MoveJ(JNT{point_id},{int(vel)},{int(tool)},{int(user)})")
        return self.wait_for_arm(target_xyz_mm, tol_mm=tol_mm, timeout_s=timeout_s)

    def gripper_init(self):
        """전원 인가 후 한 번만. 초기화도 완료를 기다린다."""
        self.send_cmd("ActGripper(1,1)")
        return self.wait_for_gripper(timeout_s=10.0)

    def gripper(self, position, speed=30, force=30, max_time_ms=2000):
        """
        position: 0=닫힘 / 100=열림 (교육자료 9장)
        force   : 파지력 % (PGEA-100-40 은 30~100N)
        """
        if not 0 <= position <= 100:
            raise FR5CommandError(f"그리퍼 위치는 0~100 이어야 합니다: {position}")
        self.send_cmd(
            f"MoveGripper(1,{int(position)},{int(speed)},{int(force)},"
            f"{int(max_time_ms)},0,0,0,0,0)")
        return self.wait_for_gripper(timeout_s=max(2.0, max_time_ms / 1000.0 + 2.0))



if __name__ == "__main__":
    import sys

    dry = "--real" not in sys.argv
    print("═" * 70)
    print("FR5 동기 실행 브리지 자체 점검", "(dry-run)" if dry else "(실물 연결)")
    print("═" * 70)

    # 1) 금지·미허용 명령이 파이썬 단에서 막히는지
    print("\n[1] 명령 검사")
    for cmd in ("MoveL(JNT1,10,1,0)", "StartJOG(1,1,1,10)", "Foo(1)"):
        try:
            check_command(cmd)
            print(f"   ❌ {cmd} 가 통과됐습니다 (버그)")
        except FR5CommandError as e:
            print(f"   ✅ 차단: {cmd}\n      └ {e}")
    for cmd in ("SetSpeed(10)", "MoveJ(JNT1,10,1,0)", "MoveGripper(1,50,30,30,2000,0,0,0,0,0)"):
        check_command(cmd)
        print(f"   ✅ 허용: {cmd}")

    # 2) Soft Limit
    print("\n[2] Soft Limit 검사")
    try:
        check_joint_limits([0, -90, 90, -90, 90, 200])
        print("   ❌ 범위 초과가 통과됐습니다 (버그)")
    except FR5CommandError as e:
        print(f"   ✅ 차단: {e}")
    check_joint_limits([0, -90, 90, -90, 90, 0])
    print("   ✅ 허용: [0, -90, 90, -90, 90, 0]")

    # 3) 동기 시퀀스 (교육자료 14장의 실패 사례를 재현하지 않는 순서인지)
    print("\n[3] 동기 시퀀스 예행")
    bridge = FR5Bridge(dry_run=dry)
    bridge.startup(speed_percent=10)
    bridge.gripper_init()
    bridge.gripper(100)                                   # 열기 + 완료 대기
    bridge.move_joints([0, -90, 90, -90, 90, 0], (-450.0, 0.0, 300.0), vel=10)
    bridge.gripper(0, force=40)                           # 닫기 + 완료 대기
    bridge.shutdown()

    print(f"\n전송된 명령 {len(bridge.sent)}개")
    print("✅ 모든 이동/그리퍼 명령이 완료 확인 후 다음 단계로 넘어갑니다.")
