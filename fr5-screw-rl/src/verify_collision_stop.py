#
# 🛑 충돌 감지가 **진짜로 멈추는지** 확인한다 (2026-09-05 신설)
#
# 왜 필요한가
#   2026-09-05 에 확인한 것은 **"정상 동작 중 오탐이 없다"** 뿐이다. 그것과 **"부딪히면
#   멈춘다"** 는 다른 이야기다. 조립은 조이는 방향이라 실패가 과조임이고 되돌릴 수 없는데,
#   그 유일한 방어선이 아직 검증되지 않았다 (FR5Web GAP 「충돌 감지가 실제로 반응하는지
#   미검증 — 등급 5 를 넣었을 뿐이다」).
#
# 시험 방법 — 회전 구속
#   고정대에 물린 **볼트**를 그리퍼로 잡고 j6 회전을 명령한다. 돌 수 없으니 토크가 오른다.
#   **실제 조립 실패(나사가 바닥에 닿거나 빗물림)와 같은 이벤트**이고, 사람이 경로에 없다.
#
# ⚠ 결과가 셋으로 갈린다 — 스크립트가 구분해 준다
#   ① 고장 `main 4`(충돌)  → ✅ 감지가 잡았다. 멈춘 각도·시간을 기록한다
#   ② 고장 0 · 거의 안 돎  → ⚠ 애매. 서보가 토크 한계로 스톨했는데 감지는 안 걸린 것일 수 있다
#   ③ 고장 0 · 다 돌았다   → **감지 실패**이거나 **고무가 미끄러진 것**이다.
#      로봇 데이터만으로는 못 가른다 — **사람이 볼트가 돌았는지 눈으로 봐야 한다.**
#      볼트가 안 돌았는데 j6 는 돌았다 = 그리퍼가 미끄러진 것 (감지 시험이 아니라 파지 시험)
#
# 안전
#   · 기본 20° · 속도 3% (j6 약 5.4°/s) — 안 멈춰도 4초, 그 안에 비상정지를 누를 수 있다
#   · 안 잡히면 임계를 낮춰 다시: 15 → 10 → 5
#   · 끝나면 충돌 감지를 반드시 해제한다 (finally)
#   · 충돌 고장(main 4)은 **리셋 가능** 등급이다 — WebApp Clear 또는 `--reset`
#
# 쓰기
#   python3 verify_collision_stop.py                     # 계획만 (로봇 안 건드림)
#   python3 verify_collision_stop.py --run               # 임계 15 로 시험
#   python3 verify_collision_stop.py --threshold 10 --run
#   python3 verify_collision_stop.py --reset             # 충돌 고장만 지운다
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

POLL_S = 0.05                  # 멈춘 순간을 놓치지 않으려면 촘촘히 본다
STILL_N = 6                    # 이만큼 연속으로 안 움직이면 멈춘 것으로 본다
STILL_EPS_DEG = 0.02
FAULT_COLLISION = 4            # FR5Web FAULT_MAIN: 4 = 충돌


def _code(rtn, what):
    c = rtn[0] if isinstance(rtn, (list, tuple)) else rtn
    if c != 0:
        raise SystemExit(f"⛔ {what} 실패 — code={c}")
    return rtn


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--threshold", type=float, default=SITE.COLLISION_THRESHOLD)
    p.add_argument("--deg", type=float, default=20.0, help="회전 명령량(°)")
    p.add_argument("--dir", choices=("left", "right"), default="right",
                   help="조립(조이는) 방향이 right 다 — 기본값")
    p.add_argument("--vel", type=int, default=3)
    p.add_argument("--grip", type=int, default=None,
                   help=f"볼트 파지값. 기본 {SITE.GRIP_PCT}(탄두용). 볼트 굵기에 맞춰 조인다")
    p.add_argument("--ip", default=SITE.ROBOT_IP)
    p.add_argument("--reset", action="store_true", help="충돌 고장을 지우고 끝낸다")
    p.add_argument("--run", action="store_true")
    a = p.parse_args()
    grip = SITE.GRIP_PCT if a.grip is None else a.grip
    delta = a.deg if a.dir == "right" else -a.deg

    print("═" * 76)
    print("충돌 감지 정지 확인 — 회전 구속 시험",
          "(실행)" if (a.run or a.reset) else "(계획만 — 로봇 안 건드림)")
    print("═" * 76)
    print(f"  임계 {a.threshold:.0f} N/m · j6 {delta:+.0f}° · 속도 {a.vel}% "
          f"· 파지 {grip}% · force {SITE.GRIP_FORCE}")
    print(f"  예상 소요 {a.deg/(SITE.J6_DEG_S_AT_FULL*a.vel/100):.1f}초 (안 멈출 경우)")
    print("\n  준비: 고정대에 볼트를 물리고, 그 볼트를 그리퍼로 잡아라.")
    print("        볼트가 돌지 않아야 시험이 성립한다.")
    if not (a.run or a.reset):
        print("\n실제로 하려면 --run")
        return

    robot = RPC(ip=a.ip)
    ver = robot.GetSoftwareVersion()
    if isinstance(ver, (list, tuple)) and ver[0] != 0:
        raise SystemExit(f"⛔ 로봇에 못 붙었다 (code={ver[0]})")
    pkg = robot.robot_state_pkg

    if a.reset:
        m = int(getattr(pkg, "main_code", -1))
        print(f"\n현재 고장 main {m} / sub {int(getattr(pkg,'sub_code',-1))}")
        if m == 0:
            print("지울 고장이 없다.")
            return
        _code(robot.ResetAllError(), "ResetAllError")
        time.sleep(1.0)
        p2 = robot.robot_state_pkg
        print(f"지운 뒤  main {int(getattr(p2,'main_code',-1))} / "
              f"sub {int(getattr(p2,'sub_code',-1))}")
        return

    # ── [1] 상태 ─────────────────────────────────────────────────────────
    cur = [float(v) for v in pkg.jt_cur_pos]
    tool, user = int(getattr(pkg, "tool", 0)), int(getattr(pkg, "user", 0))
    m0 = int(getattr(pkg, "main_code", -1))
    print(f"\n[1] 상태 — 고장 {m0}/{int(getattr(pkg,'sub_code',-1))} "
          f"· 비상정지 {int(getattr(pkg,'EmergencyStop',-1))} "
          f"· 모드 {int(getattr(pkg,'robot_mode',-1))} · tool {tool}/user {user}")
    print(f"    j6 {cur[5]:+.2f}° · 그리퍼 {getattr(pkg,'gripper_position','?')}%")
    if m0 or int(getattr(pkg, "EmergencyStop", 1)):
        raise SystemExit("⛔ 고장 또는 비상정지 상태다. 먼저 해소하라 (--reset 또는 WebApp Clear)")

    target = list(cur)
    target[5] = cur[5] + delta
    lo, hi = SITE.JOINT_LIMITS_DEG[5]
    if not (lo + SITE.J6_MARGIN_DEG <= target[5] <= hi - SITE.J6_MARGIN_DEG):
        raise SystemExit(f"⛔ 목표 {target[5]:+.1f}° 가 j6 한계 밖 — 시작각을 옮겨라")
    ok, why = selfcheck.scan_joint_path(cur, target, n=15)
    if not ok:
        raise SystemExit(f"⛔ 자기충돌 — {why[0]}")
    print(f"[2] 목표 j6 {target[5]:+.2f}° · 한계·자기충돌 통과")

    # ── [3] 파지 · 충돌 감지 ─────────────────────────────────────────────
    _code(robot.MoveGripper(SITE.GRIPPER_INDEX, int(grip), SITE.GRIP_VEL, SITE.GRIP_FORCE,
                            SITE.GRIP_MAXTIME_MS, 1, 0, 0, 0, 0), "MoveGripper")
    time.sleep(SITE.GRIP_SETTLE_S)
    print(f"[3] 파지 {grip}% → 실제 {getattr(robot.robot_state_pkg,'gripper_position','?')}%")

    _code(robot.SetLoadWeight(0, SITE.PAYLOAD_KG), "SetLoadWeight")
    _code(robot.SetLoadCoord(*SITE.COG_MM, 0), "SetLoadCoord")
    _code(robot.SetRobotInstallPos(SITE.INSTALL_POS), "SetRobotInstallPos")
    _code(robot.CustomCollisionDetectionStart(1, [a.threshold] * 6, [0.0] * 6, 1),
          "CustomCollisionDetectionStart")
    print(f"[4] 충돌 감지 ON — 관절 임계 {a.threshold:.0f} N/m")

    print("\n⚠️  볼트를 물고 j6 를 돌린다. 돌 수 없으므로 토크가 오른다.")
    print("    **비상정지에 손을 두고, 볼트가 도는지 눈으로 보아라.**")
    if input("    계속하려면 'go' 입력: ").strip().lower() != "go":
        raise SystemExit("중단.")

    # ── [5] 회전 · 고속 관측 ─────────────────────────────────────────────
    cap = SITE.wait_cap_s(cur, target, a.vel)
    still = 0
    last = cur[5]
    fault = (0, 0)
    t0 = time.time()
    try:
        _code(robot.SetSpeed(SITE.GLOBAL_SPEED_PCT), "SetSpeed")
        _code(robot.MoveJ(target, tool, user, vel=float(a.vel), blendT=0.0), "MoveJ")
        while time.time() - t0 < cap:
            time.sleep(POLL_S)
            q = robot.robot_state_pkg
            j6 = float(q.jt_cur_pos[5])
            m, s = int(getattr(q, "main_code", 0)), int(getattr(q, "sub_code", 0))
            if m:
                fault = (m, s)
                break
            still = still + 1 if abs(j6 - last) < STILL_EPS_DEG else 0
            last = j6
            if still >= STILL_N and abs(j6 - target[5]) > 0.3:
                break                       # 목표 전에 멈춰 섰다
            if abs(j6 - target[5]) < 0.15:
                break                       # 다 돌았다
    finally:
        robot.CustomCollisionDetectionEnd()

    el = time.time() - t0
    end = float(robot.robot_state_pkg.jt_cur_pos[5])
    moved = end - cur[5]
    print(f"\n[6] 결과")
    print(f"    j6 {cur[5]:+.2f}° → {end:+.2f}°   실제 {moved:+.2f}° / 명령 {delta:+.0f}°"
          f"  ({abs(moved/delta)*100:.0f}%)")
    print(f"    소요 {el:.2f}초 · 고장 main {fault[0]} / sub {fault[1]}")

    print("\n[7] 판정")
    if fault[0] == FAULT_COLLISION:
        print(f"    ✅ **충돌 감지가 잡았다** (main 4 = 충돌).")
        print(f"       임계 {a.threshold:.0f} N/m 에서 {abs(moved):.2f}° · {el:.2f}초 만에 정지.")
        print(f"       → fr5_site.COLLISION_STOP_VERIFIED = True 로 바꿔도 된다.")
    elif fault[0]:
        print(f"    ⚠ 다른 고장으로 멈췄다 — main {fault[0]}/sub {fault[1]}. "
              f"충돌 감지가 잡은 것이 아니다.")
    elif abs(moved) < 1.0:
        print("    ⚠ **애매하다** — 거의 안 돌았는데 고장이 안 떴다.")
        print("       서보가 토크 한계로 스톨했지만 충돌 감지 임계에는 못 미친 것일 수 있다.")
        print(f"       임계를 낮춰 다시: --threshold {max(a.threshold-5,3):.0f}")
    else:
        print(f"    ⛔ **안 잡혔다** — {abs(moved):.1f}° 나 돌았는데 고장 0 이다.")
        print("       원인이 둘이고 로봇 데이터로는 못 가른다:")
        print("        (a) 충돌 감지 임계가 너무 높다 → --threshold 를 낮춰 다시")
        print("        (b) **그리퍼가 미끄러졌다** → 볼트는 안 돌았을 것이다")
        print("       ★ 볼트가 돌았나? 안 돌았으면 (b) 다 — --grip 을 더 조이고 다시.")


if __name__ == "__main__":
    main()
