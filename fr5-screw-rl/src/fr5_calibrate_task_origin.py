#
# 📐 작업 원점(TASK_ORIGIN) 캘리브레이션
#
# 학습 좌표계는 '탄피 중심이 원점 위 0.1m' 인 국소 좌표계다.
# 실물에서 그 국소 원점이 로봇 base 좌표로 어디인지 알아야 정책을 그대로 실행할 수 있다.
# 이 값이 1mm 틀리면 삽입 위치가 1mm 틀어진다 (나사산 물림 허용 편심은 1.0mm).
#
# 두 가지 방법을 지원한다.
#   0) 관절각 + 모델 FK (--from-joints)  ★ 권장
#        관절각만 읽어 우리 모델로 파지중심 위치를 계산한다.
#        로봇의 TCP(toolcoord) 설정이 안 돼 있어도 정확하다.
#   1) 로봇 TCP 직접 읽기 (--from-robot)
#        로봇이 보고하는 직교좌표를 그대로 쓴다.
#        ⚠️ WebApp 에서 toolcoord 가 파지중심으로 캘리브레이션돼 있어야 유효하다.
#   2) 비전 (--from-vision)
#        교육자료 14장에서 만든 calib_transform.npz (R, t) 로
#        P_robot = R @ P_camera + t 를 적용한다. 탄피가 움직여도 매번 다시 잡는다.
#
# 결과는 task_origin.json 에 저장되고 fr5_execute_policy.py 가 이걸 읽는다.
#
# 사용:
#   python3 fr5_calibrate_task_origin.py --show
#   python3 fr5_calibrate_task_origin.py --from-joints --tool bullet          (ROS)
#   python3 fr5_calibrate_task_origin.py --from-joints --tool bullet --sdk    (SDK 직결)
#     └ `--sdk` 는 **관절각을 읽는 경로만** 바꾼다. 그 뒤 계산(MuJoCo FK)은 완전히 같다.
#       ROS 드라이버를 띄우면 `--sdk` 만 빼면 되고, 두 경로가 같은 값을 내야 정상이다.
#   python3 fr5_calibrate_task_origin.py --from-vision --cam-xyz 60.5 240.1 842.5
#   python3 fr5_calibrate_task_origin.py --simulate -450 0 0     # 배관 검증용
#
import json
import os
import sys
import time

import numpy as np

import fr5_screw_assembly as E

CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "task_origin.json")
VISION_NPZ = os.path.expanduser("~/fr5_jazzy_test_ws/notebooks/calib_transform.npz")

# 티칭 시 TCP 가 결합면 중심에 왔을 때의 국소 z (m)
#   empty  : 빈 그리퍼의 TCP 를 결합면에 맞춘 경우
#   bullet : 탄두를 물린 채 '탄두 나사 선단'을 결합면에 맞춘 경우 (TCP 는 13mm 위)
TEACH_LOCAL_Z = {
    "empty":  E.MOUTH_Z,
    "bullet": E.MOUTH_Z + E.TCP_TO_TIP,
}


def load():
    if not os.path.exists(CONFIG):
        return None
    with open(CONFIG, encoding="utf-8") as f:
        return json.load(f)


def save(origin_mm, method, note=""):
    cfg = {
        "origin_mm": [round(float(v), 3) for v in origin_mm],
        "measured": True,
        "method": method,
        "note": note,
        "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "local_frame": {
            "casing_center_z_m": E.CASE_CENTER_Z,
            "mouth_z_m": E.MOUTH_Z,
            "tcp_to_tip_m": E.TCP_TO_TIP,
        },
    }
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(f"\n💾 저장: {CONFIG}")
    return cfg


def report(origin_mm):
    """원점이 정해졌을 때 주요 지점이 로봇 base 좌표로 어디인지 보여준다."""
    o = np.asarray(origin_mm, dtype=float)
    pts = {
        "탄피 바닥":        (0, 0, (E.CASE_CENTER_Z - E.CASE_LEN / 2) * 1000),
        "탄피 중심":        (0, 0, E.CASE_CENTER_Z * 1000),
        "탄피 결합면(입구)": (0, 0, E.MOUTH_Z * 1000),
        "삽입 직전 TCP":    (0, 0, (E.MOUTH_Z + E.TCP_TO_TIP) * 1000),
        "체결 완료 TCP":    (0, 0, (E.MOUTH_Z - E.THREAD_DEPTH + E.TCP_TO_TIP) * 1000),
        "에피소드 시작 TCP": (0, 0, E.START_Z * 1000),
    }
    print(f"\n작업 원점 = ({o[0]:.1f}, {o[1]:.1f}, {o[2]:.1f}) mm  [로봇 base 기준]")
    print("─" * 58)
    for name, p in pts.items():
        q = o + np.asarray(p)
        print(f"  {name:<18s} ({q[0]:8.1f}, {q[1]:8.1f}, {q[2]:8.1f}) mm")


def read_joints_sdk(ip="192.168.58.2"):
    """관절각을 **SDK 직결(xmlrpc 20003)** 로 읽는다 (2026-09-07 추가).

    왜 갈래를 더했나 — 원본은 ROS 토픽 `/nonrt_state_data` 를 구독한다. 그건 로봇
    드라이버가 떠 있어야 하는데, 지금은 안 떠 있다(`ros2 topic list` 에 없다).
    **읽기만 하는 일** 때문에 ROS 스택 전체를 띄울 이유가 없어 SDK 경로를 하나 더 뒀다.

    ⚠ **원본(ROS)은 그대로 살려 둔다.** 드라이버를 띄우는 날 `--sdk` 만 빼면 된다 —
      두 경로가 **같은 관절각**을 읽으므로 그 뒤 계산(MuJoCo FK)은 한 글자도 안 바뀐다.
    ⚠ 컨트롤러 `20003` 은 **연결을 하나만** 받는다. ROS 드라이버가 떠 있으면 이쪽이
      못 붙는다 — 둘 중 하나만 쓴다 (명령 주인은 한 명).
    """
    import sys as _sys
    _sys.path.insert(0, "/home/ej/FR5Web/FR5/bridge/robot_adapter")
    from fairino_sdk.Robot import RPC
    robot = RPC(ip=ip)
    ver = robot.GetSoftwareVersion()
    if isinstance(ver, (list, tuple)) and ver[0] != 0:
        raise SystemExit(f"⛔ 로봇에 못 붙었다 (code={ver[0]}). 랜·비상정지를 확인하라.")
    pkg = robot.robot_state_pkg
    m, sc = int(getattr(pkg, "main_code", -1)), int(getattr(pkg, "sub_code", -1))
    e = int(getattr(pkg, "EmergencyStop", -1))
    print(f"   [SDK] {ip} · 고장 {m}/{sc} · 비상정지 {e} "
          f"· 모드 {int(getattr(pkg,'robot_mode',-1))}")
    if m or e:
        raise SystemExit("⛔ 고장 또는 비상정지 상태다. 먼저 해소하라.")
    return [float(v) for v in pkg.jt_cur_pos]


def from_robot_joints(tool="bullet", use_sdk=False):
    """
    관절각으로 작업 원점을 구한다 (권장).

    로봇이 보고하는 직교좌표(cart_*)는 WebApp 에 설정된 툴 좌표계(toolcoord)를
    기준으로 나온다. 그 설정이 플랜지 기준이면 파지중심과 수십 mm 어긋난다.
    반면 관절각(j1~j6)은 설정과 무관한 절대값이므로, 그 관절각을 우리 MuJoCo
    모델에 넣어 tool0(파지중심) 위치를 직접 계산하면 toolcoord 설정에
    의존하지 않는다. 모델 운동학은 공식 URDF 에서 온 것이라 실물과 같다.
    """
    import mujoco
    if not use_sdk:
        from fr5_real_bridge import FR5Bridge      # ROS 경로일 때만 필요하다

    print("📐 관절각 + 모델 순기구학으로 작업 원점 측정")
    print(f"   기준: {'탄두 나사 선단' if tool == 'bullet' else '빈 그리퍼 TCP'}"
          f" 이 탄피 결합면 '중심'에 닿아 있어야 합니다.")
    if use_sdk:
        j = read_joints_sdk()
    else:
        bridge = FR5Bridge(dry_run=False)
        j = bridge.current_joints_deg()
    print(f"   현재 관절각(deg): {[round(v, 3) for v in j]}")

    mjcf = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "fairino5_v6_mjmodel.xml")
    m = mujoco.MjModel.from_xml_path(mjcf)
    d = mujoco.MjData(m)
    site = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_SITE, "tool0")
    for k, name in enumerate(("j1", "j2", "j3", "j4", "j5", "j6")):
        jid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, name)
        d.qpos[m.jnt_qposadr[jid]] = np.radians(j[k])
    mujoco.mj_forward(m, d)
    tcp = d.site_xpos[site] * 1000.0
    print(f"   모델이 계산한 TCP: ({tcp[0]:.2f}, {tcp[1]:.2f}, {tcp[2]:.2f}) mm")
    origin = tcp - np.array([0.0, 0.0, TEACH_LOCAL_Z[tool] * 1000.0])
    return origin, f"robot-joints+FK({tool})"


def from_robot(tool="bullet"):
    from fr5_real_bridge import FR5Bridge
    print("📐 로봇 티칭으로 작업 원점 측정")
    print(f"   기준: {'탄두 나사 선단' if tool == 'bullet' else '빈 그리퍼 TCP'}"
          f" 을 탄피 결합면 '중심'에 맞춘 상태여야 합니다.")
    print("   (WebApp Jog 로 맞춘 뒤 이 스크립트를 실행하세요. Drag Teaching 은 자세가"
          " 흔들리므로 권장하지 않습니다 — 교육자료 14장)")
    bridge = FR5Bridge(dry_run=False)
    tcp = np.asarray(bridge.current_pose_mm(), dtype=float)
    print(f"   현재 TCP: ({tcp[0]:.2f}, {tcp[1]:.2f}, {tcp[2]:.2f}) mm")
    origin = tcp - np.array([0.0, 0.0, TEACH_LOCAL_Z[tool] * 1000.0])
    return origin, f"robot-teach({tool})"


def from_vision(cam_xyz_mm, npz=VISION_NPZ):
    if not os.path.exists(npz):
        raise SystemExit(
            f"비전 변환행렬이 없습니다: {npz}\n"
            "교육자료 14장의 compute_calibration.py 를 먼저 실행하세요.")
    d = np.load(npz)
    R, t = d["R"], d["t"]
    p_cam = np.asarray(cam_xyz_mm, dtype=float)
    p_rob = R @ p_cam + t.reshape(3)
    print("📐 비전으로 작업 원점 계산  (P_robot = R @ P_camera + t)")
    print(f"   카메라 좌표: ({p_cam[0]:.1f}, {p_cam[1]:.1f}, {p_cam[2]:.1f}) mm")
    print(f"   로봇  좌표: ({p_rob[0]:.1f}, {p_rob[1]:.1f}, {p_rob[2]:.1f}) mm  "
          f"= 탄피 결합면 중심")
    origin = p_rob - np.array([0.0, 0.0, E.MOUTH_Z * 1000.0])
    return origin, "vision(calib_transform.npz)"


if __name__ == "__main__":
    a = sys.argv

    if "--show" in a or len(a) == 1:
        cfg = load()
        if cfg is None:
            print("아직 캘리브레이션되지 않았습니다. task_origin.json 이 없습니다.")
            print("  python3 fr5_calibrate_task_origin.py --from-robot --tool bullet")
            raise SystemExit(0)
        print(f"방법: {cfg['method']}   저장: {cfg['saved_at']}")
        report(cfg["origin_mm"])
        raise SystemExit(0)

    if "--simulate" in a:
        i = a.index("--simulate")
        origin = np.array([float(v) for v in a[i + 1:i + 4]])
        method, note = "simulate", "배관 검증용 가짜 값 — 실물 실행 전에 반드시 재측정"
        print("🧪 [simulate] 실측이 아닌 값으로 저장합니다.")
    elif "--from-joints" in a:
        tool = a[a.index("--tool") + 1] if "--tool" in a else "bullet"
        use_sdk = "--sdk" in a
        origin, method = from_robot_joints(tool, use_sdk=use_sdk)
        method += "+sdk" if use_sdk else "+ros"
        note = ("관절각+FK 방식 — 로봇 TCP(toolcoord) 설정과 무관. "
                + ("읽기는 SDK 직결(20003)" if use_sdk else "읽기는 ROS 토픽"))
    elif "--from-robot" in a:
        tool = a[a.index("--tool") + 1] if "--tool" in a else "bullet"
        if tool not in TEACH_LOCAL_Z:
            raise SystemExit(f"--tool 은 {list(TEACH_LOCAL_Z)} 중 하나여야 합니다.")
        origin, method = from_robot(tool)
        note = ""
    elif "--from-vision" in a:
        i = a.index("--cam-xyz")
        origin, method = from_vision([float(v) for v in a[i + 1:i + 4]])
        note = "탄피를 옮겼다면 다시 실행하세요."
    else:
        raise SystemExit(__doc__ or "옵션을 확인하세요 (--show / --from-robot / --from-vision)")

    report(origin)

    # 왕복 검증: 저장한 원점으로 다시 국소좌표를 만들어 오차를 확인한다
    o = np.asarray(origin)
    back = (o + np.array([0, 0, E.MOUTH_Z * 1000.0])) - o
    err = abs(back[2] - E.MOUTH_Z * 1000.0)
    print(f"\n왕복 변환 오차: {err:.6f} mm  {'✅' if err < 1e-6 else '❌'}")

    if method == "simulate":
        save(origin, method, note)
        print("⚠️  simulate 값입니다. fr5_execute_policy.py 는 실물 실행을 계속 거부합니다.")
        cfg = load(); cfg["measured"] = False
        json.dump(cfg, open(CONFIG, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    else:
        save(origin, method, note)
        print("✅ 이제 fr5_execute_policy.py 가 이 원점을 사용합니다.")
