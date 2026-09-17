#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""6축 전부를 원점 자세(`fr5_site.HOME_JOINTS_DEG`)로 되돌린다.

원점은 2026-09-07 에 작업 원점을 티칭한 그 자세다 — 탄두를 물고 나사 선단을 탄피
입구 중심에 얹은 상태에서 읽었다. 여기로 돌아가면 캘리브레이션 조건이 재현된다.

**안 하는 것** — 그리퍼는 건드리지 않는다. 물고 있는지 비었는지는 사람이 정한다.

    python3 go_home.py            # 계획만 (로봇 안 건드림)
    python3 go_home.py --run
"""

import argparse
import os
import sys
import time

sys.path.insert(0, "/home/ej/FR5Web/FR5/bridge/robot_adapter")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fr5_site as SITE                            # noqa: E402
import selfcheck                                   # noqa: E402
from fairino_sdk.Robot import RPC                  # noqa: E402

ARRIVE_EPS_DEG = 0.20
POLL_S = 0.1


def main():
    ap = argparse.ArgumentParser(description="6축을 원점 자세로 되돌린다")
    ap.add_argument("--vel", type=float, default=15.0, help="속도 %% (기본 15)")
    ap.add_argument("--ip", default=SITE.ROBOT_IP)
    ap.add_argument("--run", action="store_true", help="실제로 움직이려면 필요")
    a = ap.parse_args()

    print("═" * 76)
    print("원점 자세로 복귀" + ("" if a.run else "  (계획만 — 로봇 안 건드림)"))
    print("═" * 76)

    robot = RPC(ip=a.ip)
    p = robot.robot_state_pkg
    cur = [float(v) for v in p.jt_cur_pos]
    tgt = list(SITE.HOME_JOINTS_DEG)

    m, s = int(p.main_code), int(p.sub_code)
    print(f"\n[1] 상태 — 고장 {m}/{s} · 비상정지 {int(p.EmergencyStop)} · "
          f"모드 {int(p.robot_mode)} (0=자동) · 그리퍼 {int(p.gripper_position)}%")
    if m or int(p.EmergencyStop):
        raise SystemExit(f"⛔ 고장 main {m}/sub {s} — 먼저 지워라")

    print("\n[2] 이동량")
    print("    관절   현재         원점         차이")
    for i, (c, t) in enumerate(zip(cur, tgt)):
        lo, hi = SITE.JOINT_LIMITS_DEG[i]
        if not (lo <= t <= hi):
            raise SystemExit(f"⛔ j{i+1} 원점 {t:+.2f}° 가 한계({lo}~{hi}) 밖이다")
        print(f"     j{i+1}  {c:+9.3f}   {t:+9.3f}   {t-c:+8.3f}")

    ok, why = selfcheck.scan_joint_path(cur, tgt, n=40)
    print(f"\n[3] 자기충돌 경로 40점 — {'통과' if ok else '실패'}")
    if not ok:
        raise SystemExit(f"⛔ 자기충돌 — {why[0]}")

    cap = SITE.wait_cap_s(cur, tgt, a.vel)
    print(f"    속도 {a.vel}% · 예상 {cap:.1f}초")

    if not a.run:
        print("\n(계획만 — 실제로 하려면 --run)")
        return

    if int(p.robot_mode) != 0:
        raise SystemExit(f"⛔ 모드가 {int(p.robot_mode)} 다 — MoveJ 는 자동(0)이라야 나간다")

    print("\n⚠️  6축이 한꺼번에 움직인다. 주변을 비우고 비상정지에 손을 두어라.")
    if input("    계속하려면 'go' 입력: ").strip().lower() != "go":
        raise SystemExit("취소")

    rtn = robot.MoveJ(tgt, int(p.tool), int(p.user), vel=float(a.vel), blendT=0.0)
    code = rtn[0] if isinstance(rtn, (list, tuple)) else rtn
    if code != 0:
        raise SystemExit(f"⛔ MoveJ 실패 — code={code}")

    t0 = time.time()
    while time.time() - t0 < cap:
        time.sleep(POLL_S)
        now = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
        if max(abs(n - t) for n, t in zip(now, tgt)) < ARRIVE_EPS_DEG:
            break
    now = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    q = robot.robot_state_pkg
    print(f"\n[4] 결과 ({time.time()-t0:.1f}초) — 고장 {int(q.main_code)}/{int(q.sub_code)}")
    print("    관절   도착         원점         오차")
    for i, (n, t) in enumerate(zip(now, tgt)):
        print(f"     j{i+1}  {n:+9.3f}   {t:+9.3f}   {n-t:+8.3f}")
    err = max(abs(n - t) for n, t in zip(now, tgt))
    print(f"\n    최대 오차 {err:.3f}°  {'도착' if err < ARRIVE_EPS_DEG else '⚠ 못 갔다'}")


if __name__ == "__main__":
    main()
