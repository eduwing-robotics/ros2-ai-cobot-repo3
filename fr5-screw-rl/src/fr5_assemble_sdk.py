#
# 🔩 학습된 정책으로 **조립**한다 — SDK 직결 경로 (2026-09-05 신설)
#
# 왜 새로 쓰나
#   `fr5_execute_policy.py` 가 같은 일을 하지만 **ROS 서비스**로 나간다
#   (`/fairino_remote_command_service`). 그 경로에는 오늘 실증한 것들이 없다:
#     · 충돌 감지를 **켤 수 없다** — ROS 허용목록 9개에 Col-D 명령이 없다
#     · `tool/user` 를 넘길 자리가 없다 (명령이 문자열이다)
#     · 지금 ROS 드라이버가 안 떠 있다
#   조립은 **조이는 방향**이라 실패가 과조임이고 되돌릴 수 없다. 방어선을 못 켜는
#   경로로 보낼 수 없다. **계획은 그쪽 것을 그대로 쓰고 실행만 SDK 직결로** 옮긴다.
#   ⚠ 원본은 건드리지 않는다 — ROS 드라이버를 띄우는 날 그대로 쓸 수 있게.
#
# 오늘(2026-09-05) 실기에서 실증한 것을 전부 얹는다
#   · `tool/user` 를 로봇에서 읽어 넘긴다 (0/0 을 박으면 `main 1 = 지령점 오류`)
#   · `SetSpeed` 는 100 고정 — `MoveJ(vel=)` 와 두 번 곱해지면 실효가 (v/100)² 이 된다
#   · `blendT=0.0` 논블로킹 + 도착 폴링 (대기 상한은 이동량·속도에서 유도)
#   · 보내기 전에 **자기충돌 경로 훑기**
#   · **충돌 감지를 동작 명령보다 먼저** 건다 (교육자료 7장 §10)
#
# ⛔ 선행 조건 — 하나라도 안 닫히면 실물 실행을 거부한다
#   ① 작업 원점 실측      `fr5_calibrate_task_origin.py --from-joints`
#   ② 툴축 부호 확인      `screw_stroke_cycle.py --substeps 1 --zlift --run` 로 눈 확인
#   ③ 충돌 감지 정지 확인 오탐 없음(확인됨)과 **진짜 멈춤**(미확인)은 다른 이야기다
#   ②③ 은 확인한 뒤 **사람이** `fr5_site.py` 의 플래그를 True 로 바꾼다.
#
# ⚠ 아직 아무도 확인 안 한 가정 — `ToolIK` 의 기구학이 실물과 맞나
#   `ToolIK` 는 MuJoCo 모델(벤더 URDF 유래)로 푼다. 실기는 `tool 1 / user 1` 을 쓰는데
#   그 오프셋이 모델에 반영돼 있는지 **확인된 적이 없다** (원본 스크립트도 작업 원점이
#   미실측이라 실물에서 돌아본 적이 없다). 첫 실행은 반드시 `--hover-only` 로 멈춘다.
#
# 쓰기
#   python3 fr5_assemble_sdk.py                    # dry-run (계획만 · 로봇 안 건드림)
#   python3 fr5_assemble_sdk.py --hover-only --run # 호버까지만 — **첫 실행은 반드시 이것**
#   python3 fr5_assemble_sdk.py --run              # 전체 조립
#
import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, "/home/ej/FR5Web/FR5/bridge/robot_adapter")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fr5_site as SITE                            # noqa: E402
import fr5_screw_assembly as ENV                   # noqa: E402
import fr5_execute_policy as EP                    # noqa: E402  — 계획을 그대로 쓴다
import selfcheck                                   # noqa: E402
from fairino_sdk.Robot import RPC                  # noqa: E402


def _code(rtn, what):
    c = rtn[0] if isinstance(rtn, (list, tuple)) else rtn
    if c != 0:
        raise SystemExit(f"⛔ {what} 실패 — code={c}")
    return rtn


def _fault(robot, where):
    p = robot.robot_state_pkg
    m, s = int(getattr(p, "main_code", -1)), int(getattr(p, "sub_code", -1))
    e = int(getattr(p, "EmergencyStop", 0))
    if m or e:
        raise SystemExit(f"⛔ {where} — 고장 main {m}/sub {s} · 비상정지 {e}")


def _movej(robot, target, tool, user, vel, label):
    fr = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    for i, (v, (lo, hi)) in enumerate(zip(target, SITE.JOINT_LIMITS_DEG)):
        if not (lo <= v <= hi):
            raise SystemExit(f"⛔ {label}: j{i+1} 한계 밖 {v:.2f}° (허용 {lo}~{hi})")
    ok, why = selfcheck.scan_joint_path(fr, target, n=15)
    if not ok:
        raise SystemExit(f"⛔ {label}: 자기충돌 — {why[0]}")
    cap = SITE.wait_cap_s(fr, target, vel)
    _code(robot.MoveJ(list(target), int(tool), int(user), vel=float(vel), blendT=0.0),
          f"MoveJ({label})")
    t0 = time.time()
    while time.time() - t0 < cap:
        time.sleep(0.2)
        now = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
        if max(abs(n - t) for n, t in zip(now, target)) < 0.15:
            return now, time.time() - t0
    raise SystemExit(f"⛔ {label}: {cap:.0f}초 안에 도착 못 함 — 막혔을 수 있다")


def _gripper(robot, pct, label):
    _code(robot.MoveGripper(SITE.GRIPPER_INDEX, int(pct), SITE.GRIP_VEL, SITE.GRIP_FORCE,
                            SITE.GRIP_MAXTIME_MS, 1, 0, 0, 0, 0), f"MoveGripper({label})")
    time.sleep(SITE.GRIP_SETTLE_S)
    return float(getattr(robot.robot_state_pkg, "gripper_position", -1))


def preflight_gates(run):
    """**선행 조건.** 안 닫히면 실물 실행을 거부한다 — 경고가 아니라 거부다."""
    gates = [
        ("작업 원점 실측", EP.TASK_ORIGIN_MEASURED,
         f"현재 {EP.TASK_ORIGIN_MM.tolist()}mm ({EP.TASK_ORIGIN_SRC}) — "
         "python3 fr5_calibrate_task_origin.py --from-joints"),
        ("툴축 부호 확인", SITE.ZSIGN_VERIFIED,
         "screw_stroke_cycle.py --strokes 1 --substeps 1 --zlift --vel 3 --run 로 "
         "한 칸만 움직여 눈으로 보고 fr5_site.ZSIGN_VERIFIED 를 True 로"),
        ("충돌 감지 정지 확인", SITE.COLLISION_STOP_VERIFIED,
         "오탐 없음(확인됨)과 진짜 멈춤(미확인)은 다르다. 조이는 방향의 유일한 방어선이다"),
    ]
    print("\n[0] 선행 조건")
    bad = []
    for name, ok, how in gates:
        print(f"    {'✅' if ok else '⛔'} {name}")
        if not ok:
            bad.append(f"    · {name} — {how}")
    if bad and run:
        raise SystemExit("\n⛔ 선행 조건이 안 닫혔다. 실물 실행을 거부한다:\n" + "\n".join(bad)
                         + "\n\n  조립은 **조이는 방향**이라 실패가 과조임이고 되돌릴 수 없다.")
    if bad:
        print("    (dry-run 이라 계속한다 — 실물 실행은 거부된다)")
    return not bad


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--vel", type=int, default=SITE.DEFAULT_VEL_PCT)
    p.add_argument("--seeds", type=int, default=20)
    p.add_argument("--hover-only", action="store_true",
                   help="호버까지만 하고 멈춘다 — **첫 실행은 반드시 이것**")
    p.add_argument("--threshold", type=float, default=SITE.COLLISION_THRESHOLD)
    p.add_argument("--ip", default=SITE.ROBOT_IP)
    p.add_argument("--run", action="store_true")
    a = p.parse_args()

    print("═" * 78)
    print("FR5 나사 체결 — 학습 정책 실물 조립 (SDK 직결)",
          "(실행)" if a.run else "(dry-run — 로봇을 건드리지 않는다)")
    print("═" * 78)
    preflight_gates(a.run)

    # ── [1] 정책 · 롤아웃 ────────────────────────────────────────────────
    policy, score = EP.pick_policy()
    print(f"\n[1] 정책 {os.path.relpath(policy, EP.POLICY_DIR)} "
          f"(성공률 {score[0]*100:.0f}% · 문지름 {-score[1]:.1f}스텝)")
    for seed in range(a.seeds):
        approach, strokes, info = EP.rollout(policy, seed=seed)
        if info["is_success"]:
            break
    if not info["is_success"]:
        raise SystemExit(f"⛔ 시드 {a.seeds}개 모두 체결 실패 — 정책을 다시 학습하라")
    print(f"    seed={seed} · 접근 {len(approach)}스텝 · 스트로크 {len(strokes)}회 "
          f"· 체결깊이 {info['depth_mm']:.2f}mm")

    # ── [2] 계획 (IK) ────────────────────────────────────────────────────
    waypoints = EP.compress(approach)
    ik = EP.ToolIK()
    hover_local = np.array([waypoints[0][0], waypoints[0][1],
                            ENV.MOUTH_Z + ENV.TCP_TO_TIP + EP.HOVER_MM / 1000.0])
    plan = []
    for tag, local in [("hover", hover_local)] + [(f"approach{i}", w)
                                                  for i, w in enumerate(waypoints)]:
        j, err = ik.solve(EP.to_robot_m(local), 0.0)
        plan.append((tag, j, err))
    worst = max(e for _, _, e in plan)
    print(f"\n[2] 계획 — 웨이포인트 {len(plan)}개 · IK 잔차 최대 {worst:.3f}mm")
    if worst > 1.0:
        print("    ⚠ IK 잔차가 크다 — 도달 불가 지점이 섞였을 수 있다")

    # ── [3] 자기충돌 (정적) ──────────────────────────────────────────────
    bad = [f"{tag}: {x}↔{y} {abs(d):.1f}mm" for tag, j, _ in plan
           for x, y, d in selfcheck.self_collision(j)]
    print(f"\n[3] 자기충돌 — 웨이포인트 {len(plan)}개 중 관통 {len(bad)}건")
    for b in bad[:6]:
        print(f"      ⛔ {b}")
    if bad:
        raise SystemExit("⛔ 자기충돌이 예측된다.")

    if not a.run:
        print("\n[dry-run] 여기까지. 로봇에 아무것도 안 보냈다.")
        print("  첫 실물 실행은 반드시:  python3 fr5_assemble_sdk.py --hover-only --run")
        return

    # ── [4] 연결 · 상태 · 충돌 감지 ──────────────────────────────────────
    robot = RPC(ip=a.ip)
    ver = robot.GetSoftwareVersion()
    if isinstance(ver, (list, tuple)) and ver[0] != 0:
        raise SystemExit(f"⛔ 로봇에 못 붙었다 (code={ver[0]})")
    pkg = robot.robot_state_pkg
    tool, user = int(getattr(pkg, "tool", 0)), int(getattr(pkg, "user", 0))
    cur = [float(v) for v in pkg.jt_cur_pos]
    print(f"\n[4] 연결 — tool={tool} user={user} · j6 {cur[5]:+.2f}° "
          f"· 모드 {int(getattr(pkg,'robot_mode',-1))} · 그리퍼 {getattr(pkg,'gripper_position','?')}%")
    _fault(robot, "시작 전")

    ok, why = selfcheck.scan_joint_path(cur, plan[0][1], n=EP.PATH_SCAN_SAMPLES)
    print(f"    현재→hover 경로 {EP.PATH_SCAN_SAMPLES}점 — {'통과' if ok else f'⛔ {len(why)}건'}")
    if not ok:
        raise SystemExit(f"⛔ {why[0]}")

    _code(robot.SetLoadWeight(0, SITE.PAYLOAD_KG), "SetLoadWeight")
    _code(robot.SetLoadCoord(*SITE.COG_MM, 0), "SetLoadCoord")
    _code(robot.SetRobotInstallPos(SITE.INSTALL_POS), "SetRobotInstallPos")
    _code(robot.CustomCollisionDetectionStart(1, [a.threshold] * 6, [0.0] * 6, 1),
          "CustomCollisionDetectionStart")
    print(f"    ✅ 충돌 감지 ON (임계 {a.threshold:.0f} N/m · 하중 {SITE.PAYLOAD_KG}kg)")

    print(f"\n⚠️  로봇이 실제로 움직인다. 속도 {a.vel}%. 비상정지에 손을 두어라.")
    print(f"    첫 동작: 현재 자세 → hover ({EP.HOVER_MM:.0f}mm 위)")
    if input("    계속하려면 'go' 입력: ").strip().lower() != "go":
        raise SystemExit("중단.")

    try:
        _code(robot.SetSpeed(SITE.GLOBAL_SPEED_PCT), "SetSpeed")   # 전역 100 고정
        # ── [5] 접근 ─────────────────────────────────────────────────────
        print("\n[5] 접근")
        for tag, j, _ in plan:
            now, dt = _movej(robot, j, tool, user, a.vel, tag)
            print(f"    {tag:12s} 도착 ({dt:.1f}초)")
            _fault(robot, tag)
            if tag == "hover" and a.hover_only:
                print("\n  --hover-only: 여기서 멈춘다. 자세를 눈으로 확인하라.")
                return

        # ── [6] 파지 · 체결 스트로크 ─────────────────────────────────────
        g = _gripper(robot, SITE.GRIP_PCT, "파지")
        print(f"\n[6] 파지 {SITE.GRIP_PCT}% → 실제 {g:.0f}%")
        _fault(robot, "파지")

        insert_local = np.array([0.0, 0.0, ENV.MOUTH_Z + ENV.TCP_TO_TIP])
        print(f"\n[7] 체결 — 스트로크 {len(strokes)}회 (스트로크마다 재파지)")
        for n, (w0, w1, depth) in enumerate(strokes, 1):
            j_base, _ = ik.solve(EP.to_robot_m(insert_local - np.array([0, 0, depth])), w0)
            j_end = ik.with_wrist(j_base, w1)
            print(f"    [{n}/{len(strokes)}] j6 {np.degrees(w0):+.0f}° → "
                  f"{np.degrees(w1):+.0f}° · 깊이 {depth*1000:.2f}mm")
            _movej(robot, j_end, tool, user, a.vel, f"체결{n}")
            _fault(robot, f"체결 {n}")
            if n < len(strokes):
                _gripper(robot, SITE.OPEN_PCT, "열기")
                j_back = ik.with_wrist(j_end, -ENV.WRIST_LIMIT)
                _movej(robot, j_back, tool, user, a.vel, f"재파지{n}")
                _gripper(robot, SITE.GRIP_PCT, "재파지")
                _fault(robot, f"재파지 {n}")

        # ── [8] 마무리 ───────────────────────────────────────────────────
        print("\n[8] 마무리 — 놓고 후퇴")
        _gripper(robot, SITE.OPEN_PCT, "놓기")
        _movej(robot, plan[0][1], tool, user, a.vel, "hover 복귀")
    finally:
        robot.CustomCollisionDetectionEnd()
        print("    충돌 감지 해제")

    p2 = robot.robot_state_pkg
    print(f"\n[9] 완료 — 고장 {int(getattr(p2,'main_code',-1))}/{int(getattr(p2,'sub_code',-1))}"
          f" · 그리퍼 {getattr(p2,'gripper_position','?')}%")


if __name__ == "__main__":
    main()
