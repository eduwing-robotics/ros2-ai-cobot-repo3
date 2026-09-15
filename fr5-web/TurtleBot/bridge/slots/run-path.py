"""저장된 웨이포인트 경로를 따라 몬다 — TB_PARAMS={"path":"이름"} (계약 §경로 · D136)"""
# 경로마다 .py 를 만들지 않는다. 값은 데이터(`data/paths/<name>.json`)에 살고 실행기는 이것 하나다 (D29).
# 안전은 이 파일이 지키지 않는다 — 지오펜스·속도 상한·워치독은 전부 브리지 몫이고,
# 여기는 브리지가 정한 상한 **아래**에서만 논다. 밖으로 나가면 브리지가 이 프로세스를 죽인다.
import json
import math
import os
import signal
import sys
import time
from pathlib import Path

PATHS_DIR = Path(__file__).resolve().parent.parent / "data" / "paths"
# 2026-08-19 실측 튜닝 — 카트에 박은 원인은 **회전**이었다 (직진은 600mm 가며 0.4도 안).
#   ① 15도 안에 들어오자마자 전진해 **남은 각을 호로 그렸다** → 5도로 조인다
#   ② 조향 게인 1.5 가 과해 목표 90도를 **92.1도까지 오버슛** → 0.8 로 낮춘다
#   ③ 다 온 뒤에도 100mm/s 라 급정지했다 → 거리에 비례해 미리 감속한다
LINEAR_MAX_MM_S = 100.0        # 브리지 상한 150 아래
ANGULAR_MAX_DEG_S = 20.0       # 45 → 20 (2026-08-19): 제자리 회전이 가장 잘 미끄러진다.
                               # 엔코더는 헛도는 바퀴와 도는 바퀴를 구분 못 해 방향을 통째로 잃는다
SLIP_TOL_DEG = 20.0            # 엔코더·IMU 회전량이 이만큼 갈리면 미끄러진 것이다 — ⛔ 아래 SLIP_ENFORCE 참고
# ⛔ **2026-08-20 — 이 검사의 기준이 틀렸다는 것이 확정돼 판정을 껐다 (D142).**
#   08-19 에는 「IMU 가 13% 크게 읽는다(비율 0.885)」로 보고 `IMU_SCALE` 을 넣었는데,
#   08-20 제자리 180° 회전 **2회 재현** 실측에서 정반대가 나왔다:
#     엔코더 183.74 : IMU raw 166  →  IMU 가 **10% 작다** (실기 담당자 눈·글로벌캠 둘 다 엔코더 편)
#   ⭐ **90° 에서 과다 · 180° 에서 부족** — 각도에 따라 부호가 뒤집히므로 **스케일 상수로는
#   원리적으로 못 고친다.** 원인은 우리 쪽이 아니다: OpenCR 펌웨어가 **지자기를 안 쓰고**
#   Madgwick 으로 orientation 을 만들어 yaw 가 관측 불가능한 채로 돈다(ROBOTIS 문서 · 미해결
#   업스트림 이슈). 근거 `docs/evidence/2026-08-20/tb-drift-turn.md`.
#   ⛔ **틀린 기준으로 도는 검사는 안전장치가 아니다** — 지금 값으로 대조하면 멀쩡한 180° 회전의
#   차이가 37° 로 나와 **매번 헛되이 멈춘다.** 그래서 **재기만 하고 멈추지는 않는다.**
#   ▶ 다시 켜는 조건 — 상태의 **`imuYawIntDeg`(자이로 원본 적분)** 로 갈아타고 그것이 엔코더와
#   맞는지 실측한 뒤. 그때 이 상수는 사라진다(적분값에는 스케일 보정이 필요 없다).
SLIP_ENFORCE = False           # True 면 멈춘다. 위 이유로 지금은 로그만 남긴다
IMU_SCALE = 1.0                # ⛔ 옛 0.885 는 90° 조건에서만 맞던 값이다 (위 참고). 보정하지 않는다
TURN_FIRST_DEG = 5.0           # 이보다 틀어져 있으면 제자리에서 먼저 돌린다 (옛 15 — 호가 생겼다)
TURN_GAIN = 0.9                # 제자리 회전 P 게인 (옛 1.2 — 오버슛)
STEER_GAIN = 0.8               # 전진 중 조향 게인 (옛 1.5 — 오버슛)
APPROACH_GAIN = 0.6            # 남은 거리 × 이 값 = 속도 (마지막 170mm 를 미리 줄인다)
MIN_TURN_DEG_S = 8.0           # 너무 느리면 바닥 마찰에 걸려 아예 안 돈다
WAYPOINT_TIMEOUT_S = 60.0
TICK_S = 0.1

running = True


def on_sigterm(signum, frame):
    global running
    print("SIGTERM — 세우고 종료해요")
    running = False


signal.signal(signal.SIGTERM, on_sigterm)

robot = os.environ.get("TB_ROBOT", "")
params = json.loads(os.environ.get("TB_PARAMS", "{}"))
name = params.get("path")

if not robot or not name:
    print("TB_PARAMS 에 path 이름이 없어요 — 예: {\"path\": \"belt-to-cell\"}")
    sys.exit(1)

f = PATHS_DIR / f"{name}.json"
if not f.exists():
    print(f"경로 '{name}' 이 없어요 ({f})")
    sys.exit(1)

doc = json.loads(f.read_text(encoding="utf-8"))
points = doc.get("points") or []
if not points:
    print(f"경로 '{name}' 에 점이 없어요")
    sys.exit(1)

if doc.get("frame") == "table" and not doc.get("tableToOdom"):
    # 판 좌표계로 적혔는데 변환이 없다 — 실측 전이라 odom 을 판 좌표로 간주한다.
    # 조용히 넘어가지 않는다: 이 한 줄이 없으면 나중에 왜 어긋났는지 못 찾는다.
    print("⚠ tableToOdom 이 없어 odom 을 판 좌표로 간주해요 (판 실측 전 임시)")

try:
    import rclpy                                    # 실기 전용 — 맥에는 없다
    from geometry_msgs.msg import TwistStamped
    from nav_msgs.msg import Odometry
    from sensor_msgs.msg import Imu
except ImportError:
    print("이 슬롯은 실기 전용이에요 — rclpy 가 없어요 (로봇 파이에서 돌려요)")
    sys.exit(1)


def yaw_deg(q):
    return math.degrees(math.atan2(2 * (q.w * q.z + q.x * q.y),
                                   1 - 2 * (q.y * q.y + q.z * q.z))) % 360


pose = {"xMm": None, "yMm": None, "thetaDeg": 0.0}
imu = {"yawDeg": None}              # 엔코더와 대조할 두 번째 눈 — 바퀴가 헛돌아도 이건 안 속는다


def on_odom(m):
    pose["xMm"] = m.pose.pose.position.x * 1000.0     # m → mm (바깥면은 mm · 계약 §단위)
    pose["yMm"] = m.pose.pose.position.y * 1000.0
    pose["thetaDeg"] = yaw_deg(m.pose.pose.orientation)


rclpy.init()
node = rclpy.create_node("tb_run_path")
pub = node.create_publisher(TwistStamped, f"/{robot}/cmd_vel", 10)
node.create_subscription(Odometry, f"/{robot}/odom", on_odom, 10)
node.create_subscription(Imu, f"/{robot}/imu",
                         lambda m: imu.__setitem__("yawDeg", yaw_deg(m.orientation)), 10)


def publish(lin_mm_s, ang_deg_s):
    msg = TwistStamped()
    msg.header.stamp = node.get_clock().now().to_msg()
    msg.twist.linear.x = max(-LINEAR_MAX_MM_S, min(LINEAR_MAX_MM_S, lin_mm_s)) / 1000.0
    msg.twist.angular.z = math.radians(max(-ANGULAR_MAX_DEG_S, min(ANGULAR_MAX_DEG_S, ang_deg_s)))
    pub.publish(msg)


def spin(seconds):
    rclpy.spin_once(node, timeout_sec=seconds)


def diff_deg(target, current):
    return (target - current + 540) % 360 - 180


print(f"run-path 시작 — robot={robot} path={name} 점 {len(points)}개 frame={doc.get('frame')}")

# pose 가 올 때까지 기다린다 — 위치를 모르는 채로는 한 틱도 안 움직인다 (fail-closed)
waited = 0.0
while running and pose["xMm"] is None and waited < 5.0:
    spin(TICK_S)
    waited += TICK_S
if pose["xMm"] is None:
    print("odom 이 안 와요 — 움직이지 않고 종료해요")
    publish(0, 0)
    sys.exit(1)

# IMU 를 기다린다 — 없으면 슬립 검사 없이 간다 (주행을 막지는 않되, 조용히 넘어가지도 않는다)
waited = 0.0
while running and imu["yawDeg"] is None and waited < 3.0:
    spin(TICK_S); waited += TICK_S
if imu["yawDeg"] is None:
    print("⚠ IMU 가 안 와요 — 바퀴 미끄러짐 검사 없이 갑니다")
else:
    print(f"IMU 확인 — 회전마다 엔코더와 대조해요 (허용차 {SLIP_TOL_DEG:.0f}도)")


def turn_start():
    """회전 시작 — 엔코더·IMU 를 **누적**으로 센다. 한 번에 빼면 180도를 넘는 순간
    각도가 뒤집혀 거짓 경보가 난다 (180도 회전이 이 경로에 둘 있다)."""
    return {"enc": 0.0, "imu": 0.0, "last": (pose["thetaDeg"], imu["yawDeg"])}


def slip_check(acc):
    """회전 중 엔코더와 IMU 가 갈리면 사유를 돌려준다. 안 갈리면 None."""
    if acc is None or imu["yawDeg"] is None or acc["last"][1] is None:
        return None
    e, m = pose["thetaDeg"], imu["yawDeg"]
    acc["enc"] += diff_deg(e, acc["last"][0])
    acc["imu"] += diff_deg(m, acc["last"][1]) * IMU_SCALE      # IMU 과다분을 먼저 걷어낸다
    acc["last"] = (e, m)
    gap = acc["enc"] - acc["imu"]
    if abs(gap) > SLIP_TOL_DEG:
        why = (f"엔코더 {acc['enc']:+.0f}도 vs IMU {acc['imu']:+.0f}도 (차이 {gap:+.0f}도)")
        if SLIP_ENFORCE:
            return f"바퀴가 미끄러졌어요 — {why}. 방향을 믿을 수 없어 멈춰요"
        # 판정은 껐지만 **조용히 넘어가지는 않는다** — 한 회전에 한 번만 말한다
        if not acc.get("told"):
            acc["told"] = True
            print(f"⚠ 엔코더와 IMU 가 갈려요 — {why}. "
                  f"IMU orientation 을 못 믿어 멈추지는 않아요 (D142)")
    return None


result = 0
for i, wp in enumerate(points, 1):
    started = time.time()
    turn_ref = None
    print(f"[{i}/{len(points)}] 목표 ({wp['xMm']:.0f}, {wp['yMm']:.0f})")
    while running:
        if time.time() - started > WAYPOINT_TIMEOUT_S:
            print(f"[{i}] {WAYPOINT_TIMEOUT_S:.0f}초 안에 못 닿았어요 — 멈춰요")
            result = 1
            running = False
            break
        dx, dy = wp["xMm"] - pose["xMm"], wp["yMm"] - pose["yMm"]
        dist = math.hypot(dx, dy)
        if dist <= wp["arriveMm"]:
            break
        err = diff_deg(math.degrees(math.atan2(dy, dx)), pose["thetaDeg"])
        if abs(err) > TURN_FIRST_DEG:
            if turn_ref is None:
                turn_ref = turn_start()
            why = slip_check(turn_ref)
            if why:
                print(f"[{i}] {why}")
                result = 1
                running = False
                break
            # 제자리 회전 — 게인만 낮추면 끝에서 기어가므로 최소 각속도를 깔아 준다
            w = err * TURN_GAIN
            publish(0, math.copysign(max(abs(w), MIN_TURN_DEG_S), w))
        else:
            turn_ref = None
            publish(min(LINEAR_MAX_MM_S, dist * APPROACH_GAIN), err * STEER_GAIN)
        spin(TICK_S)
    if not running:
        break
    # 방향까지 지정된 점이면 마지막에 방향을 맞춘다
    if wp["thetaDeg"] is not None:
        turn_ref = turn_start()
        while running and abs(diff_deg(wp["thetaDeg"], pose["thetaDeg"])) > wp["arriveDeg"]:
            why = slip_check(turn_ref)
            if why:
                print(f"[{i}] {why}")
                result = 1
                running = False
                break
            if time.time() - started > WAYPOINT_TIMEOUT_S:
                print(f"[{i}] 방향 맞추기 시간 초과 — 멈춰요")
                result = 1
                running = False
                break
            w = diff_deg(wp["thetaDeg"], pose["thetaDeg"]) * TURN_GAIN
            publish(0, math.copysign(max(abs(w), MIN_TURN_DEG_S), w))
            spin(TICK_S)
    print(f"[{i}/{len(points)}] 도착 — pose ({pose['xMm']:.0f}, {pose['yMm']:.0f}, {pose['thetaDeg']:.0f}°)")
    # 멈춤 — 적재·파지처럼 사람이나 팔이 일할 틈. 그동안에도 cmd_vel 0 을 계속 보낸다
    # (마지막 명령으로 계속 구르는 것을 막는다 · 계약 §안전 규칙)
    dwell = wp.get("dwellSec") or 0
    if dwell and running:
        print(f"[{i}/{len(points)}] {dwell:.0f}초 멈춤")
        end = time.time() + dwell
        while running and time.time() < end:
            publish(0, 0)
            spin(TICK_S)

publish(0, 0)                                          # 어느 경로로 끝나든 먼저 세운다
spin(0.1)
publish(0, 0)
print("run-path 종료" if result == 0 else "run-path 중단")
sys.exit(result)
