#
# 🔄 j6 만 180° 천천히 돌린다 — 충돌 감지를 먼저 켜고
#
# 용도 (2026-09-05)
#   탄두-탄피 결합체가 고정대에 꽂혀 있고, 그리퍼가 그것을 파지(17 / force 30)한 상태에서
#   손목(j6)만 180° 돌린다. 나사 체결·풀림의 실기 확인용이다.
#
# ⚠️ 이 스크립트는 **로봇을 실제로 움직인다.** 기본은 dry-run 이고 `--run` 이 있어야 나간다.
#
# ── 설계에서 막아 둔 것 ────────────────────────────────────────────────────
#
#  ① j6 한계(±175°)를 먼저 본다.
#     현재 각도에서 180° 를 돌리면 **거의 항상 한계를 벗어난다.** 예: j6=0 에서 -180 은 밖이다.
#     한계 밖으로 나가면 컨트롤러 오류 3/1 이 나고, 그 자세에서는 우리 조그로 못 빠져나온다
#     (펜던트로만 복구 · FR5Web GAP 실측 2026-08-05).
#     **그래서 못 도는 각도면 그냥 거부한다.** 시작각을 자동으로 옮기지 않는다 —
#     물건을 물고 있는데 j6 를 먼저 돌리면 **그 준비 동작이 이미 나사를 돌린다.**
#     대신 "어느 범위에서 다시 잡으면 되는지"를 알려준다.
#
#  ② 충돌 감지를 **동작 명령보다 먼저** 건다 (교육자료 7장 §10: "프로그램 맨 앞에 위치").
#     ⚠ 기본 임계 100(N/m) 은 "손으로 세게 밀거나 때려도 반응하지 않을 만큼 둔감"하다.
#       여기 기본값은 15 다 (교육자료 권장 10~20).
#     ⚠ 하중·설치방향을 먼저 넣는다 — 매뉴얼: **하중이 없으면 충돌 감지가 오작동한다.**
#
#  ③ 자기충돌 검사(selfcheck)를 보내기 전에 돌린다. j6 회전은 위험이 낮지만 공짜다.
#
# ── 이 스크립트가 못 막는 것 ──────────────────────────────────────────────
#   · **고정대와 그리퍼가 같은 물건을 잡고 있으면 180° 회전은 나사를 풀거나 조인다.**
#     방향이 반대면 과조임이 되고, 부품이나 그리퍼가 상할 수 있다.
#     충돌 감지가 최후 방어선이지만 **그것이 실제로 반응하는지는 아직 아무도 못 봤다**
#     (FR5Web GAP OPEN). 그래서 처음에는 **`--deg 20` 처럼 작게** 돌려 반응을 보고 늘린다.
#   · 회전 방향의 실제 부호는 **로봇 설치 방향에 따라 다르다.** 아래 §방향 참조.
#
# 쓰기
#   python3 rotate_j6_180.py                      # dry-run (보낼 명령만)
#   python3 rotate_j6_180.py --deg 20 --run       # 먼저 20° 로 반응 확인  ← 권장 첫 시도
#   python3 rotate_j6_180.py --run                # 180° (기본)
#   python3 rotate_j6_180.py --deg 180 --dir right --run
#
import argparse
import os
import sys
import time

sys.path.insert(0, "/home/ej/FR5Web/FR5/bridge/robot_adapter")   # 벤더 SDK (순수 표준 라이브러리)
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
    p.add_argument("--deg", type=float, default=180.0, help="돌릴 각도 (기본 180)")
    p.add_argument("--dir", choices=("left", "right"), default="left")
    p.add_argument("--vel", type=int, default=5, help="MoveJ 속도%% (기본 5 — 천천히)")
    p.add_argument("--threshold", type=float, default=COLLISION_THRESHOLD)
    p.add_argument("--ip", default=ROBOT_IP)
    p.add_argument("--run", action="store_true", help="실제로 움직인다")
    a = p.parse_args()

    # §방향 — j6 각도의 부호로 정의한다. `left` 를 **감소**로 잡았다.
    #   ⚠ 화면에서 보는 "왼쪽"과 부호의 대응은 로봇 설치 방향에 따라 다르다.
    #     첫 시도에서 반대로 돌면 `--dir right` 로 바꾼다. 추측하지 말고 **작게 돌려 확인**한다.
    delta = -a.deg if a.dir == "left" else +a.deg

    print("═" * 72)
    print(f"j6 {a.deg:.0f}° {a.dir} 회전", "(실행)" if a.run else "(dry-run — 명령만 출력)")
    print("═" * 72)

    robot = RPC(ip=a.ip)
    ver = robot.GetSoftwareVersion()
    if isinstance(ver, (list, tuple)) and ver[0] != 0:
        raise SystemExit(f"⛔ 로봇에 못 붙었다 (code={ver[0]}). 랜·브리지·비상정지를 확인하라.")
    print(f"연결 OK — {a.ip}")

    # ── [1] 안전 상태 ────────────────────────────────────────────────────
    print("\n[1] 안전 상태")
    pkg = robot.robot_state_pkg
    estop = int(getattr(pkg, "EmergencyStop", 1))
    main_c = int(getattr(pkg, "main_code", -1))
    sub_c = int(getattr(pkg, "sub_code", -1))
    print(f"    비상정지={estop} · 고장 {main_c}/{sub_c}")
    if estop or main_c:
        raise SystemExit("⛔ 비상정지 또는 고장 상태다. 먼저 해소하라 (WebApp Alarm Status).")

    cur = [float(v) for v in pkg.jt_cur_pos]
    tool_id = int(getattr(pkg, "tool", 0))
    user_id = int(getattr(pkg, "user", 0))
    print(f"    현재 관절 {[round(v,2) for v in cur]}")
    print(f"    좌표계 tool={tool_id} user={user_id}  (로봇에서 읽은 값 — 이걸 그대로 넘긴다)")

    # ── [2] j6 한계 검사 — **돌리기 전에** ────────────────────────────────
    lo, hi = JOINT_LIMITS_DEG[5]
    lo, hi = lo + J6_MARGIN_DEG, hi - J6_MARGIN_DEG
    target = list(cur)
    target[5] = cur[5] + delta
    print(f"\n[2] j6 한계 검사 — 현재 {cur[5]:+.2f}° → 목표 {target[5]:+.2f}° (허용 {lo:+.0f}~{hi:+.0f})")
    if not (lo <= target[5] <= hi):
        # **자동으로 시작각을 옮기지 않는다** — 물건을 물고 있으면 그 준비 동작이 이미 나사를 돌린다
        s_lo, s_hi = (lo - delta, hi - delta)
        s_lo, s_hi = max(lo, min(s_lo, s_hi)), min(hi, max(s_lo, s_hi))
        raise SystemExit(
            f"⛔ 목표가 j6 한계를 벗어난다.\n"
            f"   {a.deg:.0f}° {a.dir} 를 돌리려면 시작 j6 가 **{s_lo:+.0f}° ~ {s_hi:+.0f}°** 여야 한다.\n"
            f"   지금은 {cur[5]:+.2f}° 다. 그리퍼를 열고 그 범위에서 다시 잡아라.\n"
            f"   (여기서 j6 를 자동으로 옮기지 않는 이유: 물건을 문 채 손목을 돌리면\n"
            f"    그 준비 동작 자체가 이미 나사를 돌린다.)")
    print("    ✅ 한계 안")

    # 나머지 관절도 확인 (j6 만 바뀌지만 원칙대로 전부 본다)
    for i, (v, (a_lo, a_hi)) in enumerate(zip(target, JOINT_LIMITS_DEG)):
        if not (a_lo <= v <= a_hi):
            raise SystemExit(f"⛔ j{i+1} 이 한계 밖 — {v:.2f}° (허용 {a_lo}~{a_hi})")

    # ── [3] 자기충돌 ─────────────────────────────────────────────────────
    print("\n[3] 자기충돌 검사 (MuJoCo 씬)")
    ok, why = selfcheck.scan_joint_path(cur, target, n=25)
    print(f"    경로 25점 — {'통과' if ok else f'위반 {len(why)}건'}")
    if not ok:
        for w in why[:6]:
            print(f"      ⛔ {w}")
        raise SystemExit("⛔ 자기충돌이 예측된다.")

    # ── [4] 충돌 감지 — **동작 명령보다 먼저** (교육자료 7장 §10) ──────────
    print(f"\n[4] 충돌 감지 ON — 관절 임계 {a.threshold:.0f} N/m (기본 100 은 너무 둔감)")
    print(f"    선행: 하중 {PAYLOAD_KG}kg · 무게중심 {COG_MM}mm · 설치 {INSTALL_POS}")
    if a.run:
        _code(robot.SetLoadWeight(0, PAYLOAD_KG), "SetLoadWeight")
        _code(robot.SetLoadCoord(*COG_MM, 0), "SetLoadCoord")
        _code(robot.SetRobotInstallPos(INSTALL_POS), "SetRobotInstallPos")
        # flag=1 : 관절 검출만. TCP 임계(xyzabc)는 단위 근거가 없어 안 쓴다
        _code(robot.CustomCollisionDetectionStart(
            1, [a.threshold] * 6, [0.0] * 6, 1), "CustomCollisionDetectionStart")
        print("    ✅ 충돌 감지 활성")
    else:
        print("    (dry-run — 보내지 않음)")

    # ── [5] 회전 ─────────────────────────────────────────────────────────
    print(f"\n[5] MoveJ — j6 만 {delta:+.1f}° · 속도 {a.vel}%")
    print(f"    목표 {[round(v,3) for v in target]}")
    if not a.run:
        print("\n실제로 돌리려면 --run 을 붙여라.")
        print("⚠ 첫 시도는 `--deg 20 --run` 으로 작게 — 충돌 감지가 실제로 반응하는지 먼저 본다.")
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
    print(f"\n[6] 결과  j6 {cur[5]:+.2f}° → {after[5]:+.2f}° (실제 {after[5]-cur[5]:+.2f}°)")
    pkg = robot.robot_state_pkg
    print(f"    고장 {int(getattr(pkg,'main_code',-1))}/{int(getattr(pkg,'sub_code',-1))} · "
          f"비상정지 {int(getattr(pkg,'EmergencyStop',1))}")
    if abs((after[5] - cur[5]) - delta) > 2.0:
        print("    ⚠ 실제 회전량이 지령과 2° 넘게 다르다 — 도중에 막혔거나 정지했을 수 있다.")


if __name__ == "__main__":
    main()
