#
# 🔧 j6 만 원하는 각도로 옮긴다 — **물건을 놓은 상태에서만**
#
# 용도 (2026-09-05)
#   `rotate_j6_180.py` 가 "180° 를 돌리려면 시작 j6 가 +8~+172° 여야 한다" 며 거부할 때,
#   그리퍼를 열고 손목만 그 범위로 옮기는 용도다. 옮긴 뒤 다시 파지하면 된다.
#
# ⚠️ **물건을 문 채로 쓰지 마라.** 그러면 이 이동 자체가 나사를 돌린다.
#    그래서 실행 전에 그리퍼 위치를 읽어 **물고 있는 것 같으면 거부**한다 (`--force` 로만 우회).
#
# 방어 순서는 `rotate_j6_180.py` 와 같다:
#   ①비상정지·고장 ②관절 한계 ③자기충돌 경로 훑기 ④충돌 감지 ON(동작보다 먼저) ⑤사람 확인
#
# 쓰기
#   python3 move_j6_to.py --to 90            # dry-run
#   python3 move_j6_to.py --to 90 --run      # 실제로 옮긴다
#
import argparse
import os
import sys
import time

sys.path.insert(0, "/home/ej/FR5Web/FR5/bridge/robot_adapter")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import selfcheck                                   # noqa: E402
from fairino_sdk.Robot import RPC                  # noqa: E402

import fr5_site as SITE                          # noqa: E402  — 현장 실측값 SSOT

ROBOT_IP = SITE.ROBOT_IP
JOINT_LIMITS_DEG = SITE.JOINT_LIMITS_DEG
J6_MARGIN_DEG = SITE.J6_MARGIN_DEG
COLLISION_THRESHOLD = SITE.COLLISION_THRESHOLD
PAYLOAD_KG, COG_MM, INSTALL_POS = SITE.PAYLOAD_KG, SITE.COG_MM, SITE.INSTALL_POS
GRIPPER_INDEX = SITE.GRIPPER_INDEX
GRIP_PCT, OPEN_PCT = SITE.GRIP_PCT, SITE.OPEN_PCT
GRIP_VEL, GRIP_FORCE = SITE.GRIP_VEL, SITE.GRIP_FORCE
GRIP_MAXTIME_MS, GRIP_SETTLE_S = SITE.GRIP_MAXTIME_MS, SITE.GRIP_SETTLE_S
GRIP_OPEN_MIN_PCT = SITE.GRIP_OPEN_MIN_PCT
JOINT_DEG_S_AT_FULL = SITE.JOINT_DEG_S_AT_FULL
THREAD_PITCH_MM = SITE.THREAD_PITCH_MM
_wait_cap = SITE.wait_cap_s




def _code(rtn, what):
    c = rtn[0] if isinstance(rtn, (list, tuple)) else rtn
    if c != 0:
        raise SystemExit(f"⛔ {what} 실패 — code={c}")
    return rtn


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--to", type=float, default=None, help="목표 j6 각도(°)")
    p.add_argument("--front", action="store_true",
                   help=f"정면({SITE.J6_FRONT_DEG:+.2f}°)으로 — 실측 2026-09-05")
    p.add_argument("--vel", type=int, default=5)
    p.add_argument("--threshold", type=float, default=COLLISION_THRESHOLD)
    p.add_argument("--ip", default=ROBOT_IP)
    p.add_argument("--run", action="store_true")
    p.add_argument("--force", action="store_true",
                   help="그리퍼가 닫혀 있어도 강행 (물건을 놓았음을 사람이 확인한 경우에만)")
    a = p.parse_args()
    if a.front:
        a.to = SITE.J6_FRONT_DEG
    if a.to is None:
        raise SystemExit("--to 각도 또는 --front 중 하나가 필요하다")

    print("═" * 72)
    print(f"j6 → {a.to:+.2f}°{' (정면)' if a.front else ''} 이동", "(실행)" if a.run else "(dry-run — 명령만 출력)")
    print("═" * 72)

    robot = RPC(ip=a.ip)
    ver = robot.GetSoftwareVersion()
    if isinstance(ver, (list, tuple)) and ver[0] != 0:
        raise SystemExit(f"⛔ 로봇에 못 붙었다 (code={ver[0]}).")
    print(f"연결 OK — {a.ip}")

    # ── [1] 안전 상태 ────────────────────────────────────────────────────
    pkg = robot.robot_state_pkg
    estop = int(getattr(pkg, "EmergencyStop", 1))
    main_c, sub_c = int(getattr(pkg, "main_code", -1)), int(getattr(pkg, "sub_code", -1))
    cur = [float(v) for v in pkg.jt_cur_pos]
    tool_id = int(getattr(pkg, "tool", 0))
    user_id = int(getattr(pkg, "user", 0))
    print(f"\n[1] 안전 상태 — 비상정지={estop} · 고장 {main_c}/{sub_c}")
    print(f"    현재 관절 {[round(v,2) for v in cur]}")
    print(f"    좌표계 tool={tool_id} user={user_id}  (로봇에서 읽은 값 — 이걸 그대로 넘긴다)")
    if estop or main_c:
        raise SystemExit("⛔ 비상정지 또는 고장 상태다. 먼저 해소하라.")

    # ── [2] 그리퍼가 비었나 — **이 스크립트의 존재 이유** ─────────────────
    grip = float(getattr(pkg, "gripper_position", -1))
    g_fault = int(getattr(pkg, "gripper_fault", 0))
    g_active = int(getattr(pkg, "gripper_active", 0))
    print(f"\n[2] 그리퍼 — 위치 {grip:.0f}% (0=닫힘 100=열림) · 활성 {g_active} · 오류 {g_fault}")
    if 0 <= grip < GRIP_OPEN_MIN_PCT and not a.force:
        raise SystemExit(
            f"⛔ 그리퍼가 {grip:.0f}% 로 닫혀 있다 — 무언가 물고 있을 수 있다.\n"
            f"   **물건을 문 채 j6 를 돌리면 이 이동 자체가 나사를 돌린다.**\n"
            f"   그리퍼를 열고(예: 35%) 다시 실행하라. 이미 비어 있다면 --force 를 붙여라.")
    print("    ✅ 비어 있다고 본다")

    # ── [3] 관절 한계 ────────────────────────────────────────────────────
    lo, hi = JOINT_LIMITS_DEG[5]
    lo, hi = lo + J6_MARGIN_DEG, hi - J6_MARGIN_DEG
    print(f"\n[3] j6 한계 — 목표 {a.to:+.2f}° (허용 {lo:+.0f}~{hi:+.0f})")
    if not (lo <= a.to <= hi):
        raise SystemExit(f"⛔ 목표가 j6 한계 밖이다.")
    target = list(cur)
    target[5] = a.to
    print(f"    ✅ 한계 안 · 이동량 {a.to - cur[5]:+.2f}°")

    # ── [4] 자기충돌 ─────────────────────────────────────────────────────
    ok, why = selfcheck.scan_joint_path(cur, target, n=25)
    print(f"\n[4] 자기충돌 경로 25점 — {'통과' if ok else f'위반 {len(why)}건'}")
    if not ok:
        for w in why[:6]:
            print(f"      ⛔ {w}")
        raise SystemExit("⛔ 자기충돌이 예측된다.")

    # ── [5] 충돌 감지 — 동작보다 먼저 ────────────────────────────────────
    print(f"\n[5] 충돌 감지 ON — 관절 임계 {a.threshold:.0f} N/m "
          f"(선행: 하중 {PAYLOAD_KG}kg · 무게중심 {COG_MM}mm · 설치 {INSTALL_POS})")
    if a.run:
        _code(robot.SetLoadWeight(0, PAYLOAD_KG), "SetLoadWeight")
        _code(robot.SetLoadCoord(*COG_MM, 0), "SetLoadCoord")
        _code(robot.SetRobotInstallPos(INSTALL_POS), "SetRobotInstallPos")
        _code(robot.CustomCollisionDetectionStart(
            1, [a.threshold] * 6, [0.0] * 6, 1), "CustomCollisionDetectionStart")
        print("    ✅ 활성")
    else:
        print("    (dry-run — 보내지 않음)")

    # ── [6] 이동 ─────────────────────────────────────────────────────────
    print(f"\n[6] MoveJ — j6 만 · 속도 {a.vel}%")
    print(f"    목표 {[round(v,3) for v in target]}")
    if not a.run:
        print("\n실제로 옮기려면 --run 을 붙여라.")
        return

    print("\n⚠️  로봇이 실제로 움직인다. 주변을 비우고 비상정지에 손을 두어라.")
    if input("    계속하려면 'go' 입력: ").strip().lower() != "go":
        raise SystemExit("중단.")

    t0 = time.time()
    try:
        # **전역은 100 으로 둔다.** 여기에 a.vel 을 넣으면 MoveJ(vel=) 와 두 번 곱해져
        # 실효가 (v/100)² 이 된다 (2026-09-05 실기: 5% 요청 → 실효 0.25% → 326초).
        _code(robot.SetSpeed(SITE.GLOBAL_SPEED_PCT), "SetSpeed")
        # ⚠ **tool/user 를 로봇에서 읽어 그대로 넘긴다.** 0/0 을 박으면 컨트롤러가
        #   `main 1 = 지령점 오류` 로 거부한다 (2026-09-05 실기 · code 154).
        #   `MoveJ` 는 `desc_pos` 를 생략하면 **정기구학으로 직교 자세를 스스로 계산**하는데,
        #   그 계산이 tool/user 좌표계에 묶여 있어 엉뚱한 좌표계면 지령점이 무효가 된다.
        #   실기는 tool 1 / user 1 을 쓰고 있었다 (FR5Web GAP 「toolCoordId 를 안 넣는다」).
        # ⚠ **blendT=0.0** — 벤더 기본 -1.0 은 "운동 완료까지 블로킹" 이라 이동이 끝날 때까지
        #   호출이 안 돌아온다. FR5Web 이 2026-08-05 실기에서 데인 자리다.
        _code(robot.MoveJ(target, int(tool_id), int(user_id),
                          vel=float(a.vel), blendT=0.0), "MoveJ")
        # 논블로킹이므로 도착을 우리가 기다린다
        cap = _wait_cap(cur, target, a.vel)
        print(f"    도착 대기 상한 {cap:.0f}초 (이동량·속도에서 유도)")
        for _ in range(int(cap / 0.2)):
            time.sleep(0.2)
            now = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
            if max(abs(n - t) for n, t in zip(now, target)) < 0.1:
                break
        print(f"    완료 ({time.time()-t0:.1f}초)")
    finally:
        robot.CustomCollisionDetectionEnd()
        print("    충돌 감지 해제")

    after = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    print(f"\n[7] 결과  j6 {cur[5]:+.2f}° → {after[5]:+.2f}°")
    print(f"    이제 파지한 뒤:  python3 rotate_j6_180.py --deg 20 --run   ← 작게 먼저")


if __name__ == "__main__":
    main()
