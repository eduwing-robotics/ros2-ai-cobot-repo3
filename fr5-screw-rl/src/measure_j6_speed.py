#
# ⏱️ J6 최대 각속도 실측
#
# 왜 필요한가
#   fr5_screw_assembly.J6_MAX_SPEED 가 현재 180°/s 로 되어 있는데, 이건 협동로봇
#   손목의 통상값을 넣은 '가정'이다. 보유 교육자료 6종에 관절 속도 사양이 없다.
#   이 값이 틀리면 정책의 행동 스케일과 사이클 타임 예측이 함께 틀어진다.
#
# 원리
#   j6 만 알고 있는 각도(기본 180°)만큼 움직이고 실제 걸린 시간을 잰다.
#     최대속도 = 이동각 ÷ 소요시간 ÷ (Global Speed% × vel%)
#   다른 관절은 건드리지 않는다. 현재 자세에서 j6 만 바뀐 두 점을 만들어 오간다.
#
# 안전
#   · 기본은 dry-run. 실제로 움직이려면 --run 을 붙여야 한다.
#   · 속도는 --vel 로 정하며 기본 30%. 처음에는 낮게 잡고 올린다.
#   · 시작 전 로봇 주변을 비우고 비상정지에 손을 대고 진행할 것.
#   · j6 목표각이 Soft Limit(±175°)을 벗어나면 전송하지 않는다.
#
# 사용
#   python3 measure_j6_speed.py                    # 보낼 명령만 확인
#   python3 measure_j6_speed.py --run              # 실제 측정 (vel 30%)
#   python3 measure_j6_speed.py --run --vel 50     # 더 빠르게
#   python3 measure_j6_speed.py --run --sweep 90   # 이동각 90° 로 축소
#
import sys

import numpy as np

from fr5_real_bridge import FR5Bridge, FR5CommandError, check_joint_limits

SWEEP_DEG = 180.0    # j6 를 몇 도 움직여 잴 것인가
GLOBAL_SPEED = 100   # SetSpeed(%) — 실제 속도 = 최대 × GLOBAL × vel


def main():
    a = sys.argv
    run = "--run" in a
    vel = int(a[a.index("--vel") + 1]) if "--vel" in a else 30
    sweep = float(a[a.index("--sweep") + 1]) if "--sweep" in a else SWEEP_DEG

    print("═" * 68)
    print("J6 최대 각속도 실측", "(실행)" if run else "(dry-run — 명령만 출력)")
    print("═" * 68)
    if run:
        print("\n⚠️  로봇이 실제로 움직입니다. 주변을 비우고 비상정지에 손을 두세요.")
        print(f"    j6 만 {sweep:.0f}° 왕복합니다. 다른 관절은 그대로입니다.\n")

    bridge = FR5Bridge(dry_run=not run)
    bridge.startup(speed_percent=GLOBAL_SPEED)

    j0 = bridge.current_joints_deg() if run else [0, -90, 90, -90, 90, 0]
    print(f"현재 관절각: {[round(v, 2) for v in j0]}")

    # 현재 j6 를 중심으로 ±sweep/2. Soft Limit 을 벗어나면 중심을 0 으로 옮긴다
    c = j0[5]
    if abs(c) + sweep / 2 > 174.0:
        c = 0.0
        print(f"j6 가 한계에 가까워 중심을 0° 로 옮깁니다.")
    a_deg, b_deg = c - sweep / 2, c + sweep / 2

    pa, pb = list(j0), list(j0)
    pa[5], pb[5] = a_deg, b_deg
    check_joint_limits(pa)
    check_joint_limits(pb)
    print(f"측정 구간: j6 {a_deg:+.1f}° → {b_deg:+.1f}°  ({sweep:.0f}°)")
    print(f"속도 설정: SetSpeed({GLOBAL_SPEED}) × MoveJ vel={vel}%\n")

    def go(pt, idx, label):
        j = ",".join(f"{v:.4f}" for v in pt)
        bridge.send_cmd(f"JNTPoint({idx},{j})")
        bridge.send_cmd(f"MoveJ(JNT{idx},{vel},1,0)")
        t = bridge.wait_for_joints(pt)
        print(f"   {label}: {t:.3f} 초" if run else f"   {label}")
        return t

    print("[1] 시작점으로 이동")
    go(pa, 1, "시작점 도달")

    print("[2] 측정 구간 이동")
    t_fwd = go(pb, 2, "정방향")
    print("[3] 되돌아오며 재측정")
    t_bwd = go(pa, 1, "역방향")

    bridge.shutdown()

    if not run:
        print("\n실제로 재려면 --run 을 붙이세요.")
        return

    scale = (GLOBAL_SPEED / 100) * (vel / 100)
    print("\n" + "─" * 68)
    for name, t in (("정방향", t_fwd), ("역방향", t_bwd)):
        if t > 0:
            print(f"  {name}: {sweep:.0f}° / {t:.3f}초 = {sweep/t:.1f}°/s "
                  f"→ 최대속도 환산 {sweep/t/scale:.0f}°/s")
    t = (t_fwd + t_bwd) / 2
    if t > 0:
        vmax = sweep / t / scale
        print(f"\n  평균 최대속도 ≈ {vmax:.0f}°/s  ({vmax/6:.0f} RPM)")
        print(f"  현재 환경 설정값 180°/s 대비 {vmax/180*100:.0f}%")
        print(f"\n  반영: fr5_screw_assembly.py 의 J6_MAX_SPEED 를")
        print(f"        np.deg2rad({vmax:.0f}) 로 바꾸고 재학습하세요.")
    print("\n  ⚠️ 가감속 구간이 포함된 값이라 실제 정상속도보다 낮게 나옵니다.")
    print("     이동각을 크게 할수록(--sweep 300) 정확해집니다.")


if __name__ == "__main__":
    main()
