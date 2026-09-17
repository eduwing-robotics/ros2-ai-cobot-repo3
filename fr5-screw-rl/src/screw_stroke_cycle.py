#
# 🔁 나사 스트로크 + 재파지 사이클 — j6 한 스트로크로는 한 바퀴도 못 돈다
#
# 한 사이클 (2026-09-05)
#   ① 파지한 채 j6 를 **왼쪽 끝까지** 돌린다      ← 나사가 풀린다(탄두가 위로 나온다)
#   ② 그리퍼를 **연다**                          ← 탄두는 탄피에 물린 채 남는다
#   ③ j6 를 **오른쪽 시작각으로** 되돌린다         ← 빈손이라 나사를 안 건드린다
#   ④ 그리퍼로 **다시 잡는다**
#   ⑤ ①로 돌아간다
#
#   j6 가동범위는 ±175° 지만 **시작이 정면(-25.40°)이라 실효 스트로크는 146.6°**(0.41바퀴)다.
#   M5 피치 0.8mm 이므로 한 스트로크에 **0.33mm** 풀린다. 나사부 6mm 를 다 빼려면 약 19 사이클.
#   (`--start +172` 로 오른쪽 끝에서 시작하면 344°·0.76mm 로 늘어나 10 사이클이 되지만,
#    "항상 정면에서 시작한다"는 운용 규칙과 어긋나고 축방향 부담도 두 배가 된다.)
#
# ⚠️ **축방향** — 나사가 풀리면 탄두가 위로 올라온다.
#   `--zlift` 없이 돌리면 그 만큼을 **그리퍼가 버틴다.** 셋 중 하나가 일어난다:
#     ① 고무가 축방향으로 밀린다(전단)  ② 탄두가 조 안에서 미끄러진다(풀리긴 한다)
#     ③ 낀다 → 토크 급증. 충돌 감지가 잡아야 한다
#   ⚠ 어느 쪽인지 **아무도 안 쟀다.** 고무의 전단 강성도 마찰 한계도 미측정이다.
#   ⚠ 흔한 오해 — 조 간격의 "고무 눌림 0.70mm" 는 **반경 방향**이라 축방향 0.33mm 와
#     견줄 수 없는 값이다. 방향이 직각이다.
#   → `--zlift` 를 켜면 칸마다 툴축으로 물러나 이 싸움 자체가 사라진다 (권장).
#
# ⛔⛔ **2026-09-11 실측: `--zlift` 는 지금 실제로 움직이지 않는다.** ⛔⛔
#   한 스트로크의 후퇴량 0.326mm 는 **관절각으로 0.04°** 뿐이라 컨트롤러가 무시한다.
#   IK 는 정상이고(관절 목표가 실제로 바뀐다) MoveJ 도 나가지만 로봇이 안 움직인다.
#     --substeps 10 (칸당 0.0326mm) → TCP 이동 0.0024mm  = 노이즈
#     --substeps  1 (한번에 0.326mm) → TCP 이동 0.0029mm  = 노이즈
#   측정: GetActualTCPPose 로 스트로크 전후를 비교 (로봇 반복정밀도 ±0.02mm)
#
#   ⚠ 그런데 아래 `누적 후퇴 {n}mm` 출력은 **계산값을 그냥 찍는다.** 실제 이동을 확인하지
#     않으므로, 화면만 보면 물러난 줄 안다. 지금까지 --zlift 를 켜고 돌린 것은 전부
#     --zlift 없이 돌린 것과 같았다. **탄두를 물고 본 시험을 하기 전에 고쳐야 한다** —
#     안 그러면 나사가 미는 힘을 그리퍼가 그대로 받는다(이 파일 위쪽 ⚠축방향 참조).
#   해결 방향: 칸마다 물러나지 말고 **후퇴량이 0.3mm 이상 쌓였을 때만** 한 번에 실행하거나,
#     이동 후 TCP 를 읽어 실제로 움직였는지 확인하고 아니면 멈춘다.
#
# ⚠️ **먼저 빈손으로 돌려 동작만 확인하라.** 탄두를 끼우는 건 그다음이다.
#   `--no-grip` 은 그리퍼를 아예 안 건드리고 회전만 본다.
#
# ⚠️ **속도는 진짜 백분율이다** (2026-09-05 수정). 전에는 `SetSpeed(v)×MoveJ(vel=v)` 로
#   두 번 곱해져 "15%" 가 실효 2.25% 였다. 지금은 전역 100 고정이라 **같은 값이 6.7배 빠르다.**
#
# 쓰기
#   python3 screw_stroke_cycle.py                              # dry-run (명령만)
#   python3 screw_stroke_cycle.py --strokes 2 --no-grip --run  # 빈손 동작 확인
#   python3 screw_stroke_cycle.py --strokes 1 --substeps 1 --zlift --vel 3 --run
#                                                              # ★ 툴축 부호 확인 (한 칸만)
#   python3 screw_stroke_cycle.py --strokes 6 --zlift --vel 5 --run   # 본 시험
#
import argparse
import math
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
# ⚠ 이 스크립트는 **푸는 방향**이라 기준이 나사부 전체 길이(6.0mm)다.
#   조이는 방향에서는 SITE.SCREW_TRAVEL_MM(5.00) 을 써야 한다 — 어깨가 먼저 앉기 때문에
#   6.0 으로 회차를 계산하면 과조임이 된다 (fr5_site.py:104).
THREAD_DEPTH_MM = SITE.THREAD_DEPTH_MM

# 후퇴 후 TCP 가 멎을 때까지 기다리는 상한(초). `_movej` 의 도착 판정으로는
# 이 크기의 이동이 끝났는지 알 수 없어서, 직교좌표가 멎는 것을 직접 본다.
TCP_SETTLE_S = 3.0
_wait_cap = SITE.wait_cap_s





def _code(rtn, what):
    c = rtn[0] if isinstance(rtn, (list, tuple)) else rtn
    if c != 0:
        raise SystemExit(f"⛔ {what} 실패 — code={c}")
    return rtn


def _fault(robot, where):
    p = robot.robot_state_pkg
    m, s = int(getattr(p, "main_code", -1)), int(getattr(p, "sub_code", -1))
    if m or int(getattr(p, "EmergencyStop", 0)):
        raise SystemExit(f"⛔ {where} 에서 고장 — main {m} / sub {s} "
                         f"· 비상정지 {int(getattr(p,'EmergencyStop',-1))}")
    return m, s


def _movej(robot, target, tool, user, vel, label):
    """논블로킹 MoveJ + 도착 폴링. `blendT=0.0` 은 FR5Web 이 데인 자리다 (2026-08-05)."""
    fr = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    cap = _wait_cap(fr, target, vel)
    _code(robot.MoveJ(target, int(tool), int(user), vel=float(vel), blendT=0.0), f"MoveJ({label})")
    t0 = time.time()
    while time.time() - t0 < cap:
        time.sleep(0.2)
        now = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
        if max(abs(n - t) for n, t in zip(now, target)) < 0.15:
            return now, time.time() - t0
    raise SystemExit(f"⛔ {label}: {cap:.0f}초 안에 도착 못 함 — 막혔을 수 있다")



def _j6_target(robot, j6_deg, label):
    """**현재 자세에서 j6 만** 바꾼 목표. 자기충돌 경로도 그때그때 다시 본다.

    ⚠ 시작 시점에 한 번 계산한 목표(`p_start`/`p_end`)를 쓰면 안 된다 (2026-09-13).
      그 안의 j1~j5 는 후퇴 이전 값이라, 되돌릴 때마다 **툴축 후퇴가 통째로 취소된다.**
      실측으로 확인했다 — 후퇴 1.010mm 를 실행했는데 6 스트로크 뒤 TCP 는 제자리였다.
      후퇴는 j2·j3·j4 를 움직여 만드는데 되돌림이 그 관절들을 원래 값으로 돌려놓는다.

      빈손이면 무해하지만, 탄두를 물면 파지점이 매 스트로크 어긋난다 —
      탄두는 풀려서 올라와 있는데 그리퍼만 원래 높이로 내려가 물기 때문이다.
    """
    tgt = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    tgt[5] = float(j6_deg)
    lo, hi = JOINT_LIMITS_DEG[5]
    if not (lo <= tgt[5] <= hi):
        raise SystemExit(f"⛔ {label}: j6 {tgt[5]:+.1f}° 가 허용({lo:+.0f}~{hi:+.0f}) 밖이다")
    ok, why = selfcheck.scan_joint_path(
        [float(v) for v in robot.robot_state_pkg.jt_cur_pos], tgt, n=25)
    if not ok:
        raise SystemExit(f"⛔ {label}: 자기충돌 — {why[0]}")
    return tgt


def _tcp(robot):
    """현재 TCP 직교좌표 (x, y, z) mm. 반환 형식이 SDK 판마다 달라 둘 다 받는다."""
    r = robot.GetActualTCPPose(0)
    if isinstance(r, (list, tuple)) and len(r) >= 2:
        v = r[1]
        if isinstance(v, (list, tuple)):          # [code, [x,y,z,...]]
            return [float(x) for x in v[:3]]
        return [float(x) for x in r[1:4]]         # [code, x, y, z, ...]
    raise SystemExit(f"⛔ TCP 를 못 읽었다 — {r}")


def _lift_along_tool(robot, dz_mm, ref_joints, tool, user, vel, label):
    """**툴축 방향으로** `dz_mm` 만큼 물러난다 (나사가 풀리며 올라오는 만큼).

    왜 툴축인가 — 탄두는 툴축을 따라 물려 있으므로 **나사축 = 툴축**이다. 베이스 Z 로
    올리면 로봇이 기울어 있을 때 나사축과 어긋나 옆으로 비튼다.

    왜 컨트롤러 IK 인가 — `GetInverseKinRef` 는 **참조 관절값을 주고 푸는** 역기구학이라
    해가 다른 가지로 튀지 않는다. MuJoCo 쪽 IK 를 쓰면 실물과 모델이 어긋날 여지가 남는다.
    `type=2` 는 **툴 좌표계 기준 상대 위치**다 (SDK 주석: 2-相对位姿（工具坐标系）).

    ⚠ **부호는 실기에서 확인해야 한다.** 툴 Z 가 공작물 쪽(아래)을 향하면 물러나는 것은
      `-dz` 다. `--zsign` 으로 뒤집을 수 있게 두었고, 첫 시험은 `--substeps 1` 로
      한 칸만 움직여 눈으로 확인하라.
    """
    rel = [0.0, 0.0, float(dz_mm), 0.0, 0.0, 0.0]
    ok = robot.GetInverseKinHasSolution(2, rel, list(ref_joints))
    if isinstance(ok, (list, tuple)) and ok[0] == 0 and str(ok[1]).lower().startswith("f"):
        raise SystemExit(f"⛔ {label}: 그 자세에서 {dz_mm:+.3f}mm 이동은 해가 없다")
    rtn = robot.GetInverseKinRef(2, rel, list(ref_joints))
    if not (isinstance(rtn, (list, tuple)) and rtn[0] == 0 and rtn[1]):
        raise SystemExit(f"⛔ {label}: 역기구학 실패 — {rtn}")
    j = [float(v) for v in rtn[1]]

    # **해가 튀지 않았나** — 참조에서 크게 벌어지면 다른 가지로 넘어간 것이다.
    # 0.03mm 이동에 관절이 몇 도씩 움직일 이유가 없다.
    jump = max(abs(a - b) for a, b in zip(j, ref_joints))
    if jump > 5.0:
        raise SystemExit(f"⛔ {label}: IK 해가 참조에서 {jump:.1f}° 벌어졌다 — 가지가 튀었다")
    for i, (v, (a_lo, a_hi)) in enumerate(zip(j, JOINT_LIMITS_DEG)):
        if not (a_lo <= v <= a_hi):
            raise SystemExit(f"⛔ {label}: j{i+1} 한계 밖 {v:.2f}°")
    ok2, why = selfcheck.scan_joint_path(ref_joints, j, n=5)
    if not ok2:
        raise SystemExit(f"⛔ {label}: 자기충돌 — {why[0]}")

    # ⚠ **관절 도착 판정으로는 이 이동을 검증할 수 없다** (2026-09-11).
    #   `_movej` 의 도착 허용오차는 0.15° 인데 0.326mm 후퇴는 관절각으로 0.039° 뿐이다.
    #   명령을 보내기 **전에** 이미 허용오차 안이라, 로봇이 안 움직여도 "도착" 이 된다.
    #   실제로 그랬다 — MoveJ 는 code=0 을 돌려주고 TCP 는 0.003mm 밖에 안 움직였다.
    #   그래서 **직교좌표로 전후를 비교해 실제 이동을 확인한다.** (반복정밀도 ±0.02mm)
    before = _tcp(robot)
    res = _movej(robot, j, tool, user, vel, label)
    want = abs(float(dz_mm))

    # ⚠ **`_movej` 가 돌아왔다고 이동이 끝난 게 아니다** (2026-09-13 실측).
    #   도착 판정이 0.15° 인데 1.0mm 후퇴는 관절각 0.12° 라 여전히 허용오차 안이다.
    #   그래서 첫 폴링에서 바로 반환되고, 그 순간 TCP 를 읽으면 아직 덜 움직였다.
    #   실제로 오탐이 났다 — "안 움직였다"고 멈췄는데 TCP 는 0.996mm 올라가 있었다.
    #   → **정지할 때까지 기다렸다가 잰다.** 목표에 닿거나 더 안 움직이면 끝난 것이다.
    moved, last = 0.0, None
    t0 = time.time()
    while time.time() - t0 < TCP_SETTLE_S:
        time.sleep(0.2)
        now_tcp = _tcp(robot)
        moved = math.dist(before, now_tcp)
        if moved >= want * 0.98:
            break                       # 목표만큼 갔으면 더 볼 것 없다
        if last is not None and math.dist(last, now_tcp) < 0.005:
            break                       # 두 번 연속 제자리면 멈춘 것이다
        last = now_tcp
    if moved < want * 0.5:
        raise SystemExit(
            f"⛔ {label}: 후퇴 명령은 나갔는데 로봇이 움직이지 않았다.\n"
            f"      지령 {want:.4f}mm / 실측 {moved:.4f}mm "
            f"(관절 변화 {jump:.4f}° — 컨트롤러가 무시할 만큼 작다)\n"
            f"      --zlift-min 을 올려 후퇴를 모아서 보내라 (현재 한 번에 {want:.3f}mm).")
    # **실제로 간 거리를 돌려준다.** 호출자가 모자란 만큼을 이월해야 하기 때문이다.
    return res, moved


def _gripper(robot, pct, label):
    _code(robot.MoveGripper(GRIPPER_INDEX, int(pct), GRIP_VEL, GRIP_FORCE,
                            GRIP_MAXTIME_MS, 1, 0, 0, 0, 0), f"MoveGripper({label})")
    time.sleep(GRIP_SETTLE_S)
    return float(getattr(robot.robot_state_pkg, "gripper_position", -1))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--strokes", type=int, default=1)
    # **기본 시작각은 정면이다** (실측 2026-09-05). 사람이 "항상 정면에서 시작한다"고 정했다.
    p.add_argument("--start", type=float, default=None,
                   help=f"스트로크 시작각. 기본은 정면 {SITE.J6_FRONT_DEG:+.2f}°")
    p.add_argument("--end", type=float, default=None,
                   help="스트로크 끝각(왼쪽). 기본은 j6 최소 허용각")
    p.add_argument("--zlift", action="store_true",
                   help="스트로크마다 나사가 풀린 만큼 툴축으로 물러난다 (권장)")
    p.add_argument("--substeps", type=int, default=10,
                   help="스트로크를 몇 칸으로 나눠 회전·상승을 번갈아 할지 (기본 10)")
    # [실측 2026-09-13] 컨트롤러가 지령대로 실행하는 최소 이동량은 SITE.MIN_STEP_MM(0.8mm).
    #   그보다 작으면 달성률이 44% 까지 떨어지고 편차도 커진다 (fr5_site.py 표 참조).
    #   기본 1.0mm 는 그 위로 여유를 둔 값이고, 약 3 스트로크분(0.326×3=0.98)이라
    #   회전·후퇴가 번갈아 가는 느낌도 유지된다.
    p.add_argument("--zlift-min", type=float, default=1.0, dest="zlift_min",
                   help="후퇴를 이만큼 모아서 한 번에 보낸다 (mm, 기본 1.0)")
    p.add_argument("--zsign", type=float, default=-1.0,
                   help="툴축 후퇴 부호. 툴 Z 가 공작물 쪽이면 -1 (기본). 반대면 +1")
    p.add_argument("--no-return", action="store_true",
                   help="끝나고 정면으로 안 돌아간다 (기본은 돌아간다)")
    p.add_argument("--vel", type=int, default=5)
    p.add_argument("--threshold", type=float, default=COLLISION_THRESHOLD)
    p.add_argument("--no-grip", action="store_true", help="그리퍼를 건드리지 않고 회전만")
    p.add_argument("--ip", default=ROBOT_IP)
    p.add_argument("--run", action="store_true")
    a = p.parse_args()

    # 실측 하한 아래로 내리면 후퇴가 지령대로 안 간다 — 조용히 모자라느니 막는다.
    if a.zlift and a.zlift_min < SITE.MIN_STEP_MM:
        raise SystemExit(
            f"⛔ --zlift-min {a.zlift_min}mm 는 실측 하한 {SITE.MIN_STEP_MM}mm 보다 작다.\n"
            f"      컨트롤러가 지령대로 안 움직인다 (0.326mm 지령 → 실측 0.125mm, 달성률 38%).\n"
            f"      근거: fr5_site.MIN_STEP_MM · measure_min_step.py (2026-09-13)")

    lo = JOINT_LIMITS_DEG[5][0] + J6_MARGIN_DEG
    hi = JOINT_LIMITS_DEG[5][1] - J6_MARGIN_DEG
    start = SITE.J6_FRONT_DEG if a.start is None else a.start   # 기본 = 정면
    end = lo if a.end is None else a.end            # 왼쪽 끝 (−)
    sweep = start - end

    print("═" * 74)
    print(f"나사 스트로크 사이클 ×{a.strokes}", "(실행)" if a.run else "(dry-run — 명령만)")
    print("═" * 74)
    print(f"  스트로크 {start:+.0f}° → {end:+.0f}°  ({sweep:.0f}° = {sweep/360:.2f}바퀴)")
    print(f"  한 스트로크당 풀림 {sweep/360*THREAD_PITCH_MM:.2f} mm  ·  "
          f"{a.strokes}회면 {a.strokes*sweep/360*THREAD_PITCH_MM:.2f} mm")
    grip_txt = "안 건드림" if a.no_grip else f"{GRIP_PCT}%(파지) ↔ {OPEN_PCT}%(열기)"
    print(f"  그리퍼 {grip_txt}  ·  속도 {a.vel}%  ·  충돌임계 {a.threshold:.0f} N/m")
    if a.zlift:
        print(f"  **Z 상승 ON** — {a.substeps}칸으로 나눠 칸마다 툴축 "
              f"{a.zsign*(sweep/a.substeps/360)*THREAD_PITCH_MM:+.4f}mm 씩 쌓아\n"
              f"       {a.zlift_min:.2f}mm 모일 때마다 한 번에 후퇴 (남은 양은 이월)")
    else:
        print("  ⚠ Z 상승 OFF — 나사가 미는 만큼을 그리퍼가 버틴다 (--zlift 로 켠다)")

    robot = RPC(ip=a.ip)
    ver = robot.GetSoftwareVersion()
    if isinstance(ver, (list, tuple)) and ver[0] != 0:
        raise SystemExit(f"⛔ 로봇에 못 붙었다 (code={ver[0]}).")

    pkg = robot.robot_state_pkg
    cur = [float(v) for v in pkg.jt_cur_pos]
    tool = int(getattr(pkg, "tool", 0))
    user = int(getattr(pkg, "user", 0))
    print(f"\n[1] 상태 — 고장 {int(getattr(pkg,'main_code',-1))}/{int(getattr(pkg,'sub_code',-1))}"
          f" · 비상정지 {int(getattr(pkg,'EmergencyStop',-1))}"
          f" · 모드 {int(getattr(pkg,'robot_mode',-1))} (0=자동)")
    print(f"    좌표계 tool={tool} user={user}  ·  j6 {cur[5]:+.2f}°"
          f"  ·  그리퍼 {getattr(pkg,'gripper_position','?')}%")
    _fault(robot, "시작 전")

    # ── [2] 한계·자기충돌 ────────────────────────────────────────────────
    for name, v in (("시작각", start), ("끝각", end)):
        if not (lo <= v <= hi):
            raise SystemExit(f"⛔ {name} {v:+.1f}° 가 j6 허용({lo:+.0f}~{hi:+.0f}) 밖이다")
    p_start, p_end = list(cur), list(cur)
    p_start[5], p_end[5] = start, end
    print("\n[2] 자기충돌 경로 훑기")
    for label, fr, to in (("현재→시작각", cur, p_start), ("스트로크", p_start, p_end)):
        ok, why = selfcheck.scan_joint_path(fr, to, n=25)
        print(f"    {label:12s} {'통과' if ok else f'⛔ 위반 {len(why)}건'}")
        if not ok:
            for w in why[:4]:
                print(f"      {w}")
            raise SystemExit("⛔ 자기충돌이 예측된다.")

    # ── [3] 충돌 감지 — 동작보다 먼저 ────────────────────────────────────
    print(f"\n[3] 충돌 감지 ON (하중 {PAYLOAD_KG}kg · 무게중심 {COG_MM}mm · 설치 {INSTALL_POS})")
    if not a.run:
        print("\n(dry-run — 여기까지. 실제로 돌리려면 --run)")
        return
    _code(robot.SetLoadWeight(0, PAYLOAD_KG), "SetLoadWeight")
    _code(robot.SetLoadCoord(*COG_MM, 0), "SetLoadCoord")
    _code(robot.SetRobotInstallPos(INSTALL_POS), "SetRobotInstallPos")
    _code(robot.CustomCollisionDetectionStart(1, [a.threshold] * 6, [0.0] * 6, 1),
          "CustomCollisionDetectionStart")
    print("    ✅ 활성")

    print("\n⚠️  로봇이 실제로 움직인다. 주변을 비우고 비상정지에 손을 두어라.")
    print(f"    첫 동작: j6 를 {cur[5]:+.1f}° → {start:+.1f}° 로 옮긴다"
          f"{' (그리퍼가 물고 있으면 이것부터 나사를 돌린다!)' if not a.no_grip else ''}")
    if input("    계속하려면 'go' 입력: ").strip().lower() != "go":
        raise SystemExit("중단.")

    try:
        # **전역은 100 으로 둔다.** 여기에 a.vel 을 넣으면 MoveJ(vel=) 와 두 번 곱해져
        # 실효가 (v/100)² 이 된다 (2026-09-05 실기: 5% 요청 → 실효 0.25% → 326초).
        _code(robot.SetSpeed(SITE.GLOBAL_SPEED_PCT), "SetSpeed")

        # 시작각으로 (빈손이어야 안전하다)
        print(f"\n[4] 시작각으로 이동  j6 {cur[5]:+.2f}° → {start:+.1f}°")
        now, dt = _movej(robot, p_start, tool, user, a.vel, "시작각")
        print(f"    도착 {now[5]:+.2f}° ({dt:.1f}초)")
        _fault(robot, "시작각 이동")

        # 후퇴 이월량과 실행 누계. 스트로크를 넘어 이어진다 — 리스트로 둔 것은
        # 안쪽 루프에서 갱신하기 위함이다.
        pending, done = [0.0], [0.0]
        for n in range(1, a.strokes + 1):
            print(f"\n─── 스트로크 {n}/{a.strokes} ───")
            if not a.no_grip:
                g = _gripper(robot, GRIP_PCT, "파지")
                print(f"    ① 파지 {GRIP_PCT}% → 실제 {g:.0f}%")
                _fault(robot, f"스트로크 {n} 파지")

            if not a.zlift:
                now, dt = _movej(robot, _j6_target(robot, end, f"스트로크{n}"),
                                 tool, user, a.vel, f"스트로크{n}")
                print(f"    ② 왼쪽으로 {sweep:.0f}° → j6 {now[5]:+.2f}° ({dt:.1f}초)")
                _fault(robot, f"스트로크 {n} 회전")
            else:
                # **회전과 후퇴를 번갈아 한다.** 한 번에 다 돌리고 나중에 물러나면
                # 그 사이 내내 나사가 탄두를 밀어 올리려 하고 그리퍼가 버틴다.
                dsweep = sweep / a.substeps
                dz = a.zsign * (dsweep / 360.0) * THREAD_PITCH_MM
                print(f"    ② 왼쪽 {sweep:.0f}° 를 {a.substeps}칸으로 "
                      f"(칸마다 {dsweep:.1f}° 회전, 후퇴는 {a.zlift_min:.2f}mm 모일 때마다)")
                t_all = 0.0
                now2 = None
                for k in range(1, a.substeps + 1):
                    cj = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
                    step = list(cj)
                    step[5] = cj[5] - dsweep          # 왼쪽 = j6 감소
                    now, dt = _movej(robot, step, tool, user, a.vel, f"S{n}-{k}회전")
                    t_all += dt
                    _fault(robot, f"스트로크 {n} 칸 {k} 회전")

                    # ⚠ **모아서 보낸다** (2026-09-11). 칸마다 보내면 한 번에 0.03mm 라
                    #   관절각 0.004° — 컨트롤러가 실행하지 않는다. 실측으로 확인됐다.
                    #   남은 양은 다음 칸·다음 스트로크로 **이월한다**. 버리면 누적 후퇴가
                    #   실제 풀림량보다 모자라 그리퍼가 그 차이를 계속 버티게 된다.
                    pending[0] += dz
                    if abs(pending[0]) >= a.zlift_min:
                        (now2, dt2), moved = _lift_along_tool(
                            robot, pending[0], now, tool, user, a.vel, f"S{n}-{k}후퇴")
                        # ⚠ **지령만큼 다 갔다고 치면 안 된다** (2026-09-13 실측).
                        #   1.010mm 를 지령했는데 실측 0.914mm(90.5%)만 갔다. 그 차이를
                        #   버리면 후퇴가 실제 풀림량보다 조금씩 모자라고, 그게 쌓이면
                        #   원래 막으려던 힘싸움이 되돌아온다.
                        #   → **간 만큼만 빼고 나머지는 이월한다.** 달성률이 얼마든
                        #     다음 번에 그만큼 더 가므로 스스로 따라잡는다.
                        done[0] += moved
                        pending[0] = math.copysign(
                            max(0.0, abs(pending[0]) - moved), pending[0])
                        t_all += dt2
                        _fault(robot, f"스트로크 {n} 칸 {k} 후퇴")
                    else:
                        now2 = now
                print(f"       → j6 {now2[5]:+.2f}° · 후퇴 실행 {done[0]:.3f}mm"
                      f" · 이월 {abs(pending[0]):.3f}mm ({t_all:.1f}초)")
                now = now2

            if n == a.strokes:
                break
            if not a.no_grip:
                g = _gripper(robot, OPEN_PCT, "열기")
                print(f"    ③ 열기 {OPEN_PCT}% → 실제 {g:.0f}%")
                _fault(robot, f"스트로크 {n} 열기")

            # **현재 자세 기준**으로 j6 만 되돌린다 — 후퇴분을 보존한다.
            now, dt = _movej(robot, _j6_target(robot, start, f"복귀{n}"),
                             tool, user, a.vel, f"복귀{n}")
            print(f"    ④ 되돌림 → j6 {now[5]:+.2f}° ({dt:.1f}초)")
            _fault(robot, f"스트로크 {n} 복귀")

        # **정면으로 돌아가기 전에 반드시 그리퍼를 연다.**
        # 안 열면 마지막 스트로크에서 푼 만큼을 **되돌아가며 그대로 다시 조인다** —
        # 빈손 시험(2026-09-05)에서는 무해했지만 물건을 물면 작업이 되돌려진다.
        if not a.no_return and not a.no_grip:
            g = _gripper(robot, OPEN_PCT, "열기(복귀 전)")
            print(f"\n    ③ 열기 {OPEN_PCT}% → 실제 {g:.0f}%  (복귀 중 재조임 방지)")
            _fault(robot, "복귀 전 열기")

        # **끝나면 정면으로 돌아간다** — 다음 작업이 항상 같은 자리에서 시작하도록.
        if not a.no_return:
            # 여기서도 **현재 자세 기준**이다. 누적된 후퇴를 유지한 채 j6 만 정면으로.
            # 원래 높이로 내리고 싶으면 go_home.py 를 따로 돌려라 — 이 스크립트가
            # 조용히 되돌리면 "얼마나 풀렸나" 를 자로 잴 수 없다.
            try:
                p_front = _j6_target(robot, SITE.J6_FRONT_DEG, "정면복귀")
            except SystemExit as e:
                print(f"    ⚠ {e} — 복귀를 건너뛴다")
            else:
                now, dt = _movej(robot, p_front, tool, user, a.vel, "정면복귀")
                print(f"\n[정면 복귀] j6 → {now[5]:+.2f}° ({dt:.1f}초)")
    finally:
        robot.CustomCollisionDetectionEnd()
        print("\n    충돌 감지 해제")

    p2 = robot.robot_state_pkg
    print(f"\n[5] 완료 — j6 {float(p2.jt_cur_pos[5]):+.2f}°"
          f" · 고장 {int(getattr(p2,'main_code',-1))}/{int(getattr(p2,'sub_code',-1))}"
          f" · 그리퍼 {getattr(p2,'gripper_position','?')}%")
    print(f"    누적 풀림 예상 {a.strokes*sweep/360*THREAD_PITCH_MM:.2f} mm "
          f"(나사부 {THREAD_DEPTH_MM:.0f}mm 기준 {a.strokes*sweep/360*THREAD_PITCH_MM/THREAD_DEPTH_MM*100:.0f}%)")


if __name__ == "__main__":
    main()
