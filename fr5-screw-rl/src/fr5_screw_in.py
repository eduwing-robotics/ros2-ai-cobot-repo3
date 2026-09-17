#
# 🔩 탄두를 탄피에 **조여 넣는다** (조립) — 스트로크 + 재파지
#
# 분리(`screw_stroke_cycle.py`)와 방향만 반대가 아니다. **위험이 다르다.**
#   분리 : 끝까지 풀리면 그냥 빠진다. 실패해도 헛돌거나 미끄러진다
#   조립 : **끝에 바닥이 있다.** 다 들어간 뒤에도 계속 돌리면 과조임이고
#          나사산이 뭉개진다. **되돌릴 수 없다.**
#
# 그래서 이 스크립트의 핵심은 회전이 아니라 **바닥을 알아채고 멈추는 것**이다.
#
# ── 바닥을 어떻게 아나 ────────────────────────────────────────────────────
#   **지령한 j6 에 실제로 도달했는가**를 매 칸 확인한다. 나사가 바닥에 닿으면
#   더 안 돌아가므로 실제 각이 지령을 못 따라온다 → 그 자리에서 멈춘다.
#   ⚠ 시작 깊이를 모른다(사람이 손으로 얹었다). 그래서 **스트로크 수를 미리 못 정한다** —
#     세는 대신 **감지해서** 멈춘다. 상한(`--max-strokes`)은 보조 안전장치다.
#   ⚠ 그리퍼가 먼저 미끄러져도 j6 는 잘 돈다. 그때는 감지가 안 걸린다 —
#     **누적 회전수 대비 탄두가 안 들어가는지 사람이 봐야 한다.**
#
# ── 축방향 ────────────────────────────────────────────────────────────────
#   조이면 탄두가 **내려간다**. `--zlift` 로 툴축을 따라 같이 내려갈 수 있지만
#   **기본은 끈다** — 부호가 아직 실기에서 확인되지 않아(`fr5_site.ZSIGN_VERIFIED`)
#   반대로 걸면 **밀어 넣는 쪽으로 눌러버린다.** 끈 상태에서는 고무가 흡수하거나
#   미끄러질 뿐이라 훨씬 덜 위험하다.
#
# 쓰기
#   python3 fr5_screw_in.py                       # 계획만 (로봇 안 건드림)
#   python3 fr5_screw_in.py --strokes 1 --run     # ★ 첫 시도는 한 스트로크만
#   python3 fr5_screw_in.py --strokes 5 --run
#
import argparse
import os
import sys
import time

sys.path.insert(0, "/home/ej/FR5Web/FR5/bridge/robot_adapter")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fr5_site as SITE                            # noqa: E402
import selfcheck                                   # noqa: E402
from fairino_sdk.Robot import RPC                  # noqa: E402

ARRIVE_EPS_DEG = 0.15          # 이 안에 들어오면 도착
STALL_EPS_DEG = 0.60           # 지령에서 이만큼 못 미치면 **바닥으로 본다**
POLL_S = 0.1


def _code(rtn, what):
    c = rtn[0] if isinstance(rtn, (list, tuple)) else rtn
    if c != 0:
        raise SystemExit(f"⛔ {what} 실패 — code={c}")
    return rtn


def _fault(robot, where):
    p = robot.robot_state_pkg
    m, s = int(getattr(p, "main_code", -1)), int(getattr(p, "sub_code", -1))
    if m or int(getattr(p, "EmergencyStop", 0)):
        raise SystemExit(f"⛔ {where} — 고장 main {m}/sub {s} "
                         f"(main 4 = 충돌) · 비상정지 {int(getattr(p,'EmergencyStop',-1))}")


def _movej_soft(robot, target, tool, user, vel, label):
    """**도착 못 해도 안 던진다.** `(도착했나, 실제관절, 초)` 를 돌려준다.

    조립에서는 "못 갔다"가 오류가 아니라 **바닥에 닿았다는 신호**다. 그래서
    분리 쪽 `_movej` 와 달리 예외 대신 사실을 돌려준다.
    """
    fr = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    for i, (v, (lo, hi)) in enumerate(zip(target, SITE.JOINT_LIMITS_DEG)):
        if not (lo <= v <= hi):
            raise SystemExit(f"⛔ {label}: j{i+1} 한계 밖 {v:.2f}° (허용 {lo}~{hi})")
    ok, why = selfcheck.scan_joint_path(fr, target, n=10)
    if not ok:
        raise SystemExit(f"⛔ {label}: 자기충돌 — {why[0]}")
    cap = SITE.wait_cap_s(fr, target, vel)
    _code(robot.MoveJ(list(target), int(tool), int(user), vel=float(vel), blendT=0.0),
          f"MoveJ({label})")
    t0, still, last = time.time(), 0, fr[5]
    while time.time() - t0 < cap:
        time.sleep(POLL_S)
        now = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
        if max(abs(n - t) for n, t in zip(now, target)) < ARRIVE_EPS_DEG:
            return True, now, time.time() - t0
        still = still + 1 if abs(now[5] - last) < 0.01 else 0
        last = now[5]
        if still >= 8:                      # 0.8초간 안 움직이면 멈춰 선 것이다
            return False, now, time.time() - t0
    now = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    return False, now, time.time() - t0


def _gripper(robot, pct, label):
    _code(robot.MoveGripper(SITE.GRIPPER_INDEX, int(pct), SITE.GRIP_VEL, SITE.GRIP_FORCE,
                            SITE.GRIP_MAXTIME_MS, 1, 0, 0, 0, 0), f"MoveGripper({label})")
    time.sleep(SITE.GRIP_SETTLE_S)
    return float(getattr(robot.robot_state_pkg, "gripper_position", -1))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--strokes", type=int, default=1, help="최대 스트로크 수 (기본 1)")
    p.add_argument("--start", type=float, default=None,
                   help="스트로크 시작각. 기본은 현재 j6 (지금 자리에서 바로)")
    p.add_argument("--return-deg", type=float, default=None,
                   help="재파지 때 되돌아갈 각. 기본은 **왼쪽 최대**(-172°) — 다음 스트로크를 "
                        "최대로 길게 쓴다. 지금 자리로 돌아가려면 값을 직접 준다")
    p.add_argument("--substeps", type=int, default=10)
    p.add_argument("--vel", type=int, default=3,
                   help="**조일 때** 속도. 조이는 방향이라 느리게 (기본 3%%)")
    p.add_argument("--vel-back", type=int, default=15, dest="vel_back",
                   help="**빈손으로 되돌아갈 때** 속도 (기본 15%%). 그리퍼를 열고 움직이므로 "
                        "나사에 영향이 없다 — 조일 때보다 빠르게 해도 된다")
    p.add_argument("--zlift", action="store_true",
                   help="툴축으로 같이 내려간다. ⚠ 부호 미검증이면 위험하다")
    p.add_argument("--threshold", type=float, default=SITE.COLLISION_THRESHOLD)
    p.add_argument("--ip", default=SITE.ROBOT_IP)
    p.add_argument("--run", action="store_true")
    a = p.parse_args()

    hi = SITE.JOINT_LIMITS_DEG[5][1] - SITE.J6_MARGIN_DEG
    lo = SITE.JOINT_LIMITS_DEG[5][0] + SITE.J6_MARGIN_DEG

    print("═" * 76)
    print("탄두 조립 — 조여 넣기 (오른쪽 = j6 증가)",
          "(실행)" if a.run else "(계획만 — 로봇 안 건드림)")
    print("═" * 76)

    robot = RPC(ip=a.ip)
    ver = robot.GetSoftwareVersion()
    if isinstance(ver, (list, tuple)) and ver[0] != 0:
        raise SystemExit(f"⛔ 로봇에 못 붙었다 (code={ver[0]})")
    pkg = robot.robot_state_pkg
    cur = [float(v) for v in pkg.jt_cur_pos]
    tool, user = int(getattr(pkg, "tool", 0)), int(getattr(pkg, "user", 0))
    grip_now = float(getattr(pkg, "gripper_position", -1))
    mode = int(getattr(pkg, "robot_mode", -1))
    start = cur[5] if a.start is None else a.start
    back = lo if a.return_deg is None else a.return_deg   # 재파지 후 되돌아갈 곳
    sweep = hi - start                     # 1번 스트로크 (지금 자리에서)
    sweep2 = hi - back                     # 2번부터 (왼쪽 끝 → 오른쪽 끝)
    adv = sweep / 360.0 * SITE.THREAD_PITCH_MM
    adv2 = sweep2 / 360.0 * SITE.THREAD_PITCH_MM

    print(f"  1번 스트로크  {start:+.2f}° → {hi:+.0f}°  ({sweep:6.1f}° = {sweep/360:.2f}바퀴 = {adv:.3f} mm)")
    if a.strokes > 1:
        print(f"  2번부터      {back:+.0f}° → {hi:+.0f}°  ({sweep2:6.1f}° = {sweep2/360:.2f}바퀴 = {adv2:.3f} mm)"
              f"   ← 열고 왼쪽 끝까지 되돌린 뒤 다시 문다")
        tot = adv + adv2 * (a.strokes - 1)
        print(f"  {a.strokes}회 최대 조임 {tot:.2f} mm  "
              f"(회전으로 넣을 양 {SITE.SCREW_TRAVEL_MM}mm 기준 "
              f"{tot/SITE.SCREW_TRAVEL_MM*100:.0f}%)")
    print(f"  ⚠ 스트로크가 길수록 축방향 부담이 크다 — 최대 {max(adv,adv2):.2f}mm 를 고무가 받는다")
    print(f"  속도  조임 {a.vel}%  ·  되돌림 {a.vel_back}% (빈손)  "
          f"·  충돌임계 {a.threshold:.0f} N/m  ·  파지 {SITE.GRIP_PCT}%")
    print(f"        스트로크 1회 = 조임 {SITE.SCREW_SWEEP_DEG/(SITE.J6_DEG_S_AT_FULL*a.vel/100):.0f}초"
          f" + 되돌림 {SITE.SCREW_SWEEP_DEG/(SITE.J6_DEG_S_AT_FULL*a.vel_back/100):.0f}초"
          f" + 그리퍼 {SITE.GRIP_SETTLE_S*2:.0f}초")
    print(f"  Z 하강 {'ON' if a.zlift else 'OFF'}"
          + ("" if a.zlift else "  (부호 미검증이라 기본 꺼짐 — 고무가 흡수한다)"))
    print(f"\n[1] 상태 — 고장 {int(getattr(pkg,'main_code',-1))}/{int(getattr(pkg,'sub_code',-1))}"
          f" · 모드 {mode} (0=자동) · j6 {cur[5]:+.2f}° · 그리퍼 {grip_now:.0f}%")
    print(f"    좌표계 tool={tool} user={user}")

    if not (lo <= start <= hi):
        raise SystemExit(f"⛔ 시작각 {start:+.1f}° 가 j6 허용({lo:+.0f}~{hi:+.0f}) 밖이다")
    if grip_now >= SITE.GRIP_OPEN_MIN_PCT:
        print(f"    ⚠ 그리퍼가 {grip_now:.0f}% 로 열려 있다 — 탄두를 물고 시작해야 한다")
    p_start, p_end, p_back = list(cur), list(cur), list(cur)
    p_start[5], p_end[5], p_back[5] = start, hi, back
    if not (lo <= back <= hi):
        raise SystemExit(f"⛔ 복귀각 {back:+.1f}° 가 j6 허용({lo:+.0f}~{hi:+.0f}) 밖이다")
    ok, why = selfcheck.scan_joint_path(p_start, p_end, n=25)
    print(f"\n[2] 자기충돌 스트로크 경로 — {'통과' if ok else f'⛔ {len(why)}건'}")
    if not ok:
        raise SystemExit(f"⛔ {why[0]}")

    print(f"\n[3] 충돌 감지 (하중 {SITE.PAYLOAD_KG}kg · 임계 {a.threshold:.0f} N/m)")
    if not a.run:
        print("\n(계획만 — 실제로 하려면 --run)")
        print("  ⚠ 조이는 방향이다. 첫 시도는 --strokes 1 로.")
        return
    if mode != 0:
        raise SystemExit(f"⛔ 모드가 {mode} 다 — MoveJ 는 자동(0)이라야 나간다")

    _code(robot.SetLoadWeight(0, SITE.PAYLOAD_KG), "SetLoadWeight")
    _code(robot.SetLoadCoord(*SITE.COG_MM, 0), "SetLoadCoord")
    _code(robot.SetRobotInstallPos(SITE.INSTALL_POS), "SetRobotInstallPos")
    _code(robot.CustomCollisionDetectionStart(1, [a.threshold] * 6, [0.0] * 6, 1),
          "CustomCollisionDetectionStart")
    print("    ✅ 활성")

    print("\n⚠️  **조이는 방향이다.** 다 들어간 뒤 계속 돌리면 과조임이고 되돌릴 수 없다.")
    print("    바닥에 닿으면 스크립트가 멈춘다. 그래도 비상정지에 손을 두어라.")
    if input("    계속하려면 'go' 입력: ").strip().lower() != "go":
        raise SystemExit("중단.")

    total_deg = 0.0
    bottomed = False
    try:
        _code(robot.SetSpeed(SITE.GLOBAL_SPEED_PCT), "SetSpeed")
        if abs(cur[5] - start) > 0.2:
            # ⚠ **물고 있으면 먼저 연다.** 안 그러면 이 이동이 방금 조인 것을 도로 푼다
            #   (2026-09-07: 스트로크 1 을 끝낸 +172° 에서 다시 돌리려다 발견).
            if grip_now < SITE.GRIP_OPEN_MIN_PCT:
                g = _gripper(robot, SITE.OPEN_PCT, "열기(시작각 이동 전)")
                print(f"\n[4-0] 그리퍼 {SITE.OPEN_PCT}% 로 열었다 → 실제 {g:.0f}%"
                      f"  (물고 이동하면 나사가 풀린다)")
                _fault(robot, "시작각 전 열기")
            print(f"[4] 시작각으로  j6 {cur[5]:+.2f}° → {start:+.2f}°  (빈손)")
            _movej_soft(robot, p_start, tool, user, a.vel_back, "시작각")
            _fault(robot, "시작각")

        for n in range(1, a.strokes + 1):
            print(f"\n─── 스트로크 {n}/{a.strokes} ───")
            g = _gripper(robot, SITE.GRIP_PCT, "파지")
            print(f"    ① 파지 {SITE.GRIP_PCT}% → 실제 {g:.0f}%")
            _fault(robot, f"스트로크 {n} 파지")

            # 1번은 지금 자리에서, 2번부터는 복귀각에서 — 길이가 다르다
            cur_j6 = float(robot.robot_state_pkg.jt_cur_pos[5])
            dsweep = (hi - cur_j6) / a.substeps
            for k in range(1, a.substeps + 1):
                cj = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
                step = list(cj)
                step[5] = cj[5] + dsweep                 # 오른쪽 = j6 증가 = 조임
                arrived, now, dt = _movej_soft(robot, step, tool, user, a.vel,
                                               f"S{n}-{k}")
                moved = now[5] - cj[5]
                total_deg += max(0.0, moved)
                _fault(robot, f"스트로크 {n} 칸 {k}")
                if not arrived and abs(step[5] - now[5]) > STALL_EPS_DEG:
                    print(f"    ⛑ **바닥으로 판단** — 칸 {k}: 지령 {dsweep:+.1f}° 중 "
                          f"{moved:+.2f}° 만 돌았다 (부족 {abs(step[5]-now[5]):.2f}°)")
                    bottomed = True
                    break
                if a.zlift:
                    print(f"      칸 {k}: {moved:+.2f}°  (Z 하강은 --zlift 구현 대기)")
            print(f"    ② 누적 회전 {total_deg:.1f}° = {total_deg/360:.2f}바퀴 "
                  f"→ 조임 {total_deg/360*SITE.THREAD_PITCH_MM:.3f} mm")
            if bottomed or n == a.strokes:
                break
            g = _gripper(robot, SITE.OPEN_PCT, "열기")
            print(f"    ③ 열기 {SITE.OPEN_PCT}% → 실제 {g:.0f}%  (탄두는 탄피에 남는다)")
            _fault(robot, f"스트로크 {n} 열기")
            arrived, now, dt = _movej_soft(robot, p_back, tool, user, a.vel_back, f"복귀{n}")
            print(f"    ④ 왼쪽 끝으로 되돌림 → j6 {now[5]:+.2f}° ({dt:.1f}초)")
            _fault(robot, f"스트로크 {n} 복귀")
    finally:
        robot.CustomCollisionDetectionEnd()
        print("\n    충돌 감지 해제")

    p2 = robot.robot_state_pkg
    print(f"\n[5] 결과")
    print(f"    누적 회전 {total_deg:.1f}° ({total_deg/360:.2f}바퀴) "
          f"→ 조임 {total_deg/360*SITE.THREAD_PITCH_MM:.3f} mm")
    print(f"    j6 {float(p2.jt_cur_pos[5]):+.2f}° · 고장 "
          f"{int(getattr(p2,'main_code',-1))}/{int(getattr(p2,'sub_code',-1))} "
          f"· 그리퍼 {getattr(p2,'gripper_position','?')}%")
    if bottomed:
        print("\n    ⛑ **바닥에 닿아 멈췄다.** 확인할 것:")
        print("       · 탄두가 실제로 다 들어갔나 — 들어갔으면 체결 완료다")
        print("       · 안 들어갔는데 멈췄으면 **빗물림**이다. 풀고 다시 물려야 한다")
    else:
        print("\n    아직 바닥이 아니다 — 더 조이려면 --strokes 를 늘려 다시 돌린다")
    print("    ⚠ 그리퍼가 미끄러졌으면 j6 는 돌았는데 탄두는 안 들어간다. 눈으로 보라.")


if __name__ == "__main__":
    main()
