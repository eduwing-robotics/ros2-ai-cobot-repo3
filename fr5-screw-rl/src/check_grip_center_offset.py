#
# 📏 그리퍼 파지중심이 j6 회전축에서 얼마나 벗어났는지 확인/보정
#
# 왜 중요한가
#   FR5 는 끝단(j6)을 돌리면 그 아래 그리퍼가 통째로 돌아간다. 이때 파지중심이
#   회전축에서 e 만큼 벗어나 있으면, 물린 탄두는 반경 e 로 '공전'한다.
#   나사가 물린 뒤에는 탄두 축이 탄피 축에 고정돼야 하는데 공전하면 나사산이 상한다.
#
#   현재 모델값 e = 2.60mm  (교육자료 12장의 핑거팁 실측 좌표 +31.10 / -26.00mm 에서
#   유도된 값). 나사산 물림 허용 편심이 1.00mm 이므로 허용치의 2.6배다.
#
#   이 값이 실물에서도 2.6mm 인지, 아니면 사실상 0 인지에 따라 해야 할 일이 달라진다.
#     e ≈ 0     -> 모델만 고치면 끝. 흔들림 문제 자체가 사라진다.
#     e ≈ 2.6mm -> 기구적으로 해결해야 한다 (그리퍼를 플랜지 중심에 맞춰 재장착,
#                  재장착이 필요)
#
# 측정 방법 (택1)
#   A. 손으로 (권장, 소프트웨어 설정과 무관해서 가장 신뢰할 수 있음)
#        1. 그리퍼에 뾰족한 것(핀, 볼펜심)을 물리고 툴이 연직 하향이 되게 자세를 잡는다
#        2. 종이 위에 팁 위치를 표시
#        3. j6 만 +180° 회전 (다른 관절 고정)
#        4. 팁 위치를 다시 표시하고 두 점 사이 거리 d 를 잰다
#        5. 편심 e = d / 2
#        -> python3 check_grip_center_offset.py --set-offset <e_mm>
#
#   B. 로봇이 보고하는 TCP 로 자동 (툴 좌표계가 제대로 캘리브레이션돼 있어야 함)
#        python3 check_grip_center_offset.py --measure
#
import os
import re
import sys

import numpy as np

MJCF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fairino5_v6_mjmodel.xml")
TOOL0_RE  = re.compile(r'(<site name="tool0" pos=")([-\d.eE]+)( 0 [\d.]+")')
FINGER_RE = re.compile(r'(<body name="finger_tip_(?:right|left)_link" pos=")([-\d.eE]+)( 0 [\d.]+">)')
HALF_SPAN = 0.02865   # 조 안쪽면 간격 40.80mm 를 만드는 좌우 대칭 오프셋 (조 폭 16.50)


def current_offset_mm():
    """파지중심(tool0 site)이 j6 축에서 벗어난 거리."""
    s = open(MJCF, encoding="utf-8").read()
    m = TOOL0_RE.search(s)
    if not m:
        raise SystemExit("MJCF 에서 tool0 site 를 찾지 못했습니다.")
    return float(m.group(2)) * 1000.0


def set_offset_mm(e_mm):
    """
    파지중심을 j6 축에서 e_mm 만큼 옮긴다.
    tool0 site 와 좌우 손가락을 함께 옮겨야 파지중심이 실제로 이동한다.
    """
    e = e_mm / 1000.0
    s = open(MJCF, encoding="utf-8").read()
    s2 = TOOL0_RE.sub(lambda m: f"{m.group(1)}{e:.5f}{m.group(3)}", s, count=1)
    side = [HALF_SPAN, -HALF_SPAN]          # 오른쪽, 왼쪽 순서로 등장한다
    def repl(m):
        return f"{m.group(1)}{e + side.pop(0):.5f}{m.group(3)}"
    s2 = FINGER_RE.sub(repl, s2, count=2)
    if s2 == s:
        raise SystemExit("치환에 실패했습니다. MJCF 구조를 확인하세요.")
    open(MJCF, "w", encoding="utf-8").write(s2)
    return e_mm


def orbit_radius_mm():
    """현재 모델에서 j6 를 돌렸을 때 TCP 가 그리는 궤도 반경."""
    import mujoco
    m = mujoco.MjModel.from_xml_path(MJCF)
    d = mujoco.MjData(m)
    site = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_SITE, "tool0")
    j6 = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, "j6")
    adr = m.jnt_qposadr[j6]
    pts = []
    for a in np.linspace(-np.pi, np.pi, 73):
        d.qpos[:] = 0
        d.qpos[adr] = a
        mujoco.mj_forward(m, d)
        pts.append(d.site_xpos[site].copy())
    pts = np.array(pts)[:, :2]
    return float(np.linalg.norm(pts - pts.mean(axis=0), axis=1).mean() * 1000.0)


def measure_with_robot(angles_deg=(-90.0, 0.0, 90.0)):
    """
    j6 만 돌리며 로봇이 보고하는 TCP(x,y)를 모아 원을 피팅한다.
    ⚠️ 툴 좌표계(toolcoord)가 파지중심으로 캘리브레이션돼 있어야 의미가 있다.
       플랜지 기준(toolcoord0)이면 편심이 0 으로 나온다.
    """
    from fr5_real_bridge import FR5Bridge, check_joint_limits
    bridge = FR5Bridge(dry_run=False)
    j0 = bridge.current_joints_deg()
    print(f"   현재 관절각: {[round(v,2) for v in j0]}")
    print("   ⚠️ j6 만 움직입니다. 주변을 비우고 비상정지에 손을 대고 진행하세요.")
    pts = []
    for a in angles_deg:
        j = list(j0)
        j[5] = a
        check_joint_limits(j)
        bridge.send_cmd(f"JNTPoint(9,{','.join(f'{v:.4f}' for v in j)})")
        bridge.send_cmd("MoveJ(JNT9,5,1,0)")
        import time
        time.sleep(2.0)
        for _ in range(20):
            bridge.spin_once()
        x, y, z = bridge.current_pose_mm()
        print(f"   j6={a:+7.1f}° -> TCP ({x:8.2f}, {y:8.2f}, {z:8.2f}) mm")
        pts.append((x, y))
    bridge.shutdown()

    # 세 점을 지나는 원의 반지름 = 편심
    (x1, y1), (x2, y2), (x3, y3) = pts[:3]
    A = np.array([[x2 - x1, y2 - y1], [x3 - x2, y3 - y2]]) * 2.0
    b = np.array([x2**2 - x1**2 + y2**2 - y1**2, x3**2 - x2**2 + y3**2 - y2**2])
    try:
        c = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        raise SystemExit("세 점이 거의 일직선입니다. 편심이 0 에 가깝다는 뜻입니다.")
    return float(np.hypot(x1 - c[0], y1 - c[1]))


def verdict(e_mm):
    THREAD_TOL_MM = 1.0
    print(f"\n판정 (나사산 물림 허용 편심 {THREAD_TOL_MM:.1f}mm 기준)")
    if e_mm <= 0.2:
        print(f"   ✅ 편심 {e_mm:.2f}mm — 사실상 중심. j6 회전으로 체결해도 문제없습니다.")
    elif e_mm <= THREAD_TOL_MM:
        print(f"   🟡 편심 {e_mm:.2f}mm — 허용치 안이지만 여유가 없습니다. "
              f"실물에서 체결 성공률을 확인하세요.")
    else:
        print(f"   ❌ 편심 {e_mm:.2f}mm — 허용치의 {e_mm/THREAD_TOL_MM:.1f}배입니다. "
              f"j6 회전으로 체결하면 나사산이 상합니다.")
        print("      해결: 그리퍼를 플랜지 중심에 맞춰 재장착해야 한다.")


if __name__ == "__main__":
    a = sys.argv
    print("═" * 66)
    print("그리퍼 파지중심 편심 확인")
    print("═" * 66)
    print(f"\n현재 모델값: 편심 {current_offset_mm():.2f}mm  "
          f"(j6 1회전 시 TCP 궤도 반경 {orbit_radius_mm():.2f}mm)")

    if "--set-offset" in a:
        e = float(a[a.index("--set-offset") + 1])
        set_offset_mm(e)
        print(f"\n💾 모델 편심을 {e:.2f}mm 로 갱신했습니다.")
        print(f"   갱신 후 궤도 반경 {orbit_radius_mm():.2f}mm")
        verdict(e)
        print("\n⚠️ 모델을 바꿨으므로 재학습·재녹화가 필요합니다:")
        print("   python3 train_screw_ppo.py --steps 300000")
        print("   python3 record_screw_video.py --models ./models_screw/")
    elif "--measure" in a:
        e = measure_with_robot()
        print(f"\n측정된 편심: {e:.2f}mm")
        verdict(e)
        print(f"\n반영하려면:  python3 check_grip_center_offset.py --set-offset {e:.2f}")
    else:
        verdict(current_offset_mm())
        print("\n측정 방법")
        print("  A. 손으로: 핀을 물리고 j6 만 +180° 돌린 뒤 팁 이동거리 d 측정 -> 편심 = d/2")
        print("     python3 check_grip_center_offset.py --set-offset <e_mm>")
        print("  B. 자동  : python3 check_grip_center_offset.py --measure")
        print("     (툴 좌표계가 파지중심으로 캘리브레이션돼 있어야 유효)")
