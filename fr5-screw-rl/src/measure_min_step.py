#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🔬 컨트롤러가 **실제로 실행하는 최소 이동량**을 찾는다 (2026-09-11 신설).

왜 필요한가
    `screw_stroke_cycle.py --zlift` 의 한 스트로크 후퇴량 0.326mm 는 관절각으로
    0.039° 뿐이라 컨트롤러가 실행하지 않았다. MoveJ 는 code=0 을 돌려주고
    TCP 는 0.003mm 밖에 안 움직였다 — **조용히 실패한다.**

    0.326mm(관절 0.04°) 는 확실히 무시되고 5mm(관절 0.6°) 는 확실히 움직인다.
    그 사이 경계가 어디인지 몰라서 `--zlift-min` 기본값을 [추정] 1.0mm 로 두었다.
    이 스크립트가 그 경계를 재서 추정을 실측으로 바꾼다.

어떻게
    툴축 **위쪽(물러나는 방향)** 으로만 움직인다. `fr5_site.ZSIGN_RETRACT = -1.0`
    이 2026-09-11 에 컨트롤러 기구학으로 확정됐으므로, 아래로 파고들 일이 없다.
    한 칸 올린 뒤 같은 양을 내려 제자리로 돌아오므로 누적 이동이 쌓이지 않는다.

    판정은 **직교좌표**로 한다. 관절 도착 판정(0.15°)으로는 이 크기를 못 본다.
    로봇 반복정밀도가 ±0.02mm 이므로 지령의 50% 이상 움직였으면 '실행됨' 으로 본다.

⚠ 그리퍼에 **아무것도 물리지 말고** 돌려라. 부품이 있으면 위로 빼는 동작이 된다.

    python3 measure_min_step.py              # 계획만 (로봇 안 건드림)
    python3 measure_min_step.py --run
"""
import argparse
import math
import os
import sys
import time

sys.path.insert(0, "/home/ej/FR5Web/FR5/bridge/robot_adapter")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fr5_site as SITE                            # noqa: E402
import selfcheck                                   # noqa: E402
from fairino_sdk.Robot import RPC                  # noqa: E402

# 재볼 이동량 (mm). 아래에서 위로 올라가며 처음 '실행됨' 이 나오는 곳이 경계다.
LADDER = [0.1, 0.2, 0.326, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0, 5.0]
MOVED_RATIO = 0.5        # 지령의 이 비율 이상이면 '움직이기는 했다'
GOOD_RATIO  = 0.95       # 지령의 이 비율 이상이라야 '지령대로 갔다'
#   ⚠ 둘을 나눈 이유 (2026-09-13 실측): 0.2mm 는 80%, 0.326mm 는 37% 로 **움직이긴 하나
#     지령대로는 안 간다.** zlift 에 쓰려면 달성률이 높아야 하므로 GOOD_RATIO 로 고른다.
SETTLE_S = 1.0           # 명령 후 정지까지 기다리는 시간


def _tcp(robot):
    r = robot.GetActualTCPPose(0)
    v = r[1]
    return [float(x) for x in (v[:3] if isinstance(v, (list, tuple)) else r[1:4])]


def _wait_state(robot, timeout=10.0):
    """상태 스트림(20004)이 채워질 때까지 기다린다. 안 오면 포트가 죽은 것이다."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not isinstance(robot.robot_state_pkg, type):
            return robot.robot_state_pkg
        time.sleep(0.1)
    raise SystemExit("⛔ 상태(20004)가 안 온다 — 컨트롤러를 재부팅하라 "
                     "(fr5_state_port_20004 참조)")


def _try_step(robot, dz, tool, user, vel):
    """툴축으로 `dz` 만큼 움직여 보고 `(지령, 실측, 관절변화)` 를 돌려준다."""
    ref = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    rtn = robot.GetInverseKinRef(2, [0.0, 0.0, float(dz), 0.0, 0.0, 0.0], list(ref))
    if not (isinstance(rtn, (list, tuple)) and rtn[0] == 0 and rtn[1]):
        raise SystemExit(f"⛔ 역기구학 실패 — {rtn}")
    j = [float(v) for v in rtn[1]]
    jump = max(abs(x - y) for x, y in zip(j, ref))
    for i, (v, (lo, hi)) in enumerate(zip(j, SITE.JOINT_LIMITS_DEG)):
        if not (lo <= v <= hi):
            raise SystemExit(f"⛔ j{i+1} 한계 밖 {v:.2f}°")
    ok, why = selfcheck.scan_joint_path(ref, j, n=5)
    if not ok:
        raise SystemExit(f"⛔ 자기충돌 — {why[0]}")
    before = _tcp(robot)
    robot.MoveJ(j, int(tool), int(user), vel=float(vel), blendT=0.0)
    time.sleep(SETTLE_S)
    return abs(dz), math.dist(before, _tcp(robot)), jump


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vel", type=float, default=5.0)
    ap.add_argument("--ip", default=SITE.ROBOT_IP)
    ap.add_argument("--run", action="store_true")
    # ⚠ 사다리 1회로는 못 정한다 (2026-09-13). 0.326mm 가 0.200mm 보다 못 가는
    #   단조롭지 않은 결과가 나왔다. **재현성을 봐야** 이상값인지 실제 경향인지 갈린다.
    ap.add_argument("--repeat", type=int, default=1, help="같은 값을 몇 번씩 잴지")
    ap.add_argument("--values", default=None,
                    help="재볼 값을 직접 지정 (쉼표, mm). 예: 0.2,0.326,0.5,0.8")
    a = ap.parse_args()
    ladder = ([float(v) for v in a.values.split(",")] if a.values else LADDER)

    print("═" * 76)
    print("컨트롤러 최소 실행 이동량 측정" + ("" if a.run else "  (계획만 — 로봇 안 건드림)"))
    print("═" * 76)
    print(f"  방향: 툴축 {SITE.ZSIGN_RETRACT:+.0f} (물러나는 쪽 — 위로)")
    print(f"  재볼 값: {', '.join(f'{v}' for v in ladder)} mm"
          f"{'' if a.repeat == 1 else f'  ×{a.repeat}회'}")
    print(f"  판정: 지령의 {MOVED_RATIO*100:.0f}% 이상 움직이면 실행됨 "
          f"(반복정밀도 ±0.02mm)")
    print("  ⚠ 그리퍼에 아무것도 물리지 마라. 매 칸 올렸다가 같은 양만큼 내려 제자리로 온다.")

    robot = RPC(ip=a.ip)
    pkg = _wait_state(robot)
    m, s_ = int(pkg.main_code), int(pkg.sub_code)
    print(f"\n[1] 상태 — 고장 {m}/{s_} · 비상정지 {int(pkg.EmergencyStop)} "
          f"· 모드 {int(pkg.robot_mode)} (0=자동) · 그리퍼 {int(pkg.gripper_position)}%")
    if m or int(pkg.EmergencyStop):
        raise SystemExit(f"⛔ 고장 main {m}/sub {s_} — 먼저 지워라")
    if int(pkg.gripper_position) < 30:
        print("    ⚠ 그리퍼가 닫혀 있다. 뭔가 물고 있다면 중단하라.")

    if not a.run:
        print("\n(계획만 — 실제로 하려면 --run)")
        return
    if int(pkg.robot_mode) != 0:
        raise SystemExit(f"⛔ 모드가 {int(pkg.robot_mode)} 다 — 자동(0)이라야 MoveJ 가 나간다")

    print("\n⚠️  로봇이 실제로 움직인다. 비상정지에 손을 두어라.")
    if input("    계속하려면 'go' 입력: ").strip().lower() != "go":
        raise SystemExit("취소")

    print(f"\n[2] 측정")
    hdr = "    {:>10s} {:>10s} {:>10s} {:>9s}".format("지령(mm)", "실측평균", "달성률", "편차")
    print(hdr if a.repeat > 1 else
          "    {:>10s} {:>10s} {:>12s}   판정".format("지령(mm)", "실측(mm)", "관절변화(°)"))
    rows = []
    for step in ladder:
        dz = SITE.ZSIGN_RETRACT * step          # 물러나는 방향(위)
        gots = []
        for _ in range(a.repeat):
            want, got, jump = _try_step(robot, dz, pkg.tool, pkg.user, a.vel)
            gots.append(got)
            _try_step(robot, -dz, pkg.tool, pkg.user, a.vel)   # 제자리 복귀
        avg = sum(gots) / len(gots)
        spread = max(gots) - min(gots)
        ratio = avg / step
        rows.append((step, avg, ratio, spread))
        if a.repeat > 1:
            print(f"    {step:10.3f} {avg:10.4f} {ratio*100:9.1f}% {spread:9.4f}"
                  f"   {'✅' if ratio >= GOOD_RATIO else ('△' if ratio >= MOVED_RATIO else '❌')}")
        else:
            print(f"    {step:10.3f} {avg:10.4f} {jump:12.4f}   "
                  f"{'✅ 실행됨' if ratio >= MOVED_RATIO else '❌ 무시됨'}")

    # **판정은 '움직였나' 가 아니라 '지령대로 갔나' 다.** zlift 는 나사가 풀리는 양만큼
    # 정확히 물러나야 한다. 대충 움직이기만 하면 모자란 만큼을 그리퍼가 계속 버틴다.
    # 그래서 달성률 GOOD_RATIO 이상이 **그 값부터 끝까지 이어지는** 첫 지점을 경계로 본다.
    print("\n[3] 결과")
    good = None
    for i, (step, avg, ratio, spread) in enumerate(rows):
        if all(r >= GOOD_RATIO for _, _, r, _ in rows[i:]):
            good = step
            break
    if good is None:
        print(f"    ⛔ 어떤 값도 달성률 {GOOD_RATIO*100:.0f}% 를 안정적으로 넘지 못했다")
    else:
        print(f"    신뢰 가능한 최소 이동량 = {good:.3f} mm "
              f"(이 값부터 끝까지 달성률 {GOOD_RATIO*100:.0f}% 이상)")
        print(f"    → fr5_site.py:  MIN_STEP_MM = {good:.3f}   [실측]")
        print(f"    → screw_stroke_cycle.py:  --zlift-min 기본값을 {good:.1f} 이상으로")


if __name__ == "__main__":
    main()
