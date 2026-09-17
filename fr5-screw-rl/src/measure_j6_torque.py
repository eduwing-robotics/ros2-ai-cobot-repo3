#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""j6 토크·전류를 실제로 읽을 수 있는지 재는 스크립트.

**왜 이게 필요한가.** 조립(조여 넣기)에는 자동 완료 판정이 없다. 2026-09-07 실기에서
어깨가 앉은 뒤에도 스트로크가 343.6° 를 다 돌았다 — 착좌 후 잔여 회전을 그리퍼 고무가
흡수해서 위치 기반 스톨 문턱에 안 걸린다. 위치로는 못 잡으니 **힘으로 잡아야** 한다.

**이 스크립트가 답하는 것 (로봇이 있어야 답이 나오는 것들).**
  ① 컨트롤러가 이 필드들을 **실제로 채우나.** 구조체에 자리가 있는 것과 채우는 것은 다르다.
  ② **단위가 뭔가.** SDK 주석에 안 적혀 있다. Nm 인지 정격 대비 % 인지.
  ③ **회전할 때 실제로 변하나.** 안 변하면 판정에 못 쓴다.
  ④ **조일 때 얼마나 오르나.** 문턱을 정할 근거.

**주의 — SDK 가 성공 여부를 거짓말한다.** 네 게터 모두 `return 0, ...` 이 하드코딩이다:

    def GetJointTorques(self, flag=1):
        # _error = self.robot.GetJointTorques(flag)   ← 원래 RPC 호출은 주석 처리됨
        return 0,[self.robot_state_pkg.jt_cur_tor[0], ...]

컨트롤러가 필드를 안 채워도 0(성공)이 온다. 그래서 **반환 코드로 판단하면 안 되고,
값이 실제로 변하는지로 판단해야 한다.** 이 스크립트는 그 판단을 대신 해 준다.

기본은 **로봇을 안 움직인다.** 정지 샘플링만 한다. 돌려 보려면 --move 를 준다.
"""

import argparse
import csv
import os
import statistics
import sys
import time

sys.path.insert(0, "/home/ej/FR5Web/FR5/bridge/robot_adapter")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fr5_site as SITE                            # noqa: E402
import selfcheck                                   # noqa: E402
from fairino_sdk.Robot import RPC                  # noqa: E402

POLL_S = 0.05                  # 20Hz. 게터가 RPC 왕복을 안 하므로 이 정도는 공짜다
ARRIVE_EPS_DEG = 0.15
MOVE_GUARD_DEG = 120.0         # --move 를 이보다 크게 못 준다 (실수 방지)

# 정지 상태에서 이 값보다 작으면 "안 채워짐" 으로 본다.
# 중력을 받는 j2/j3 조차 0 이면 컨트롤러가 안 보내는 것이다.
FILLED_EPS = 1e-9

# 재는 필드들. (표시이름, 패킷필드, 개수, 설명)
FIELDS = [
    ("jt_cur_tor",         "jt_cur_tor",         6, "현재 토크 (当前扭矩)"),
    ("jt_tgt_tor",         "jt_tgt_tor",         6, "지령 토크 (关节指令力矩)"),
    ("jointDriverTorque",  "jointDriverTorque",  6, "드라이버 현재 토크"),
    ("actual_qd",          "actual_qd",          6, "실제 관절 속도"),
]
SCALARS = [
    ("gripper_current",    "gripper_current",    "그리퍼 전류 (int8)"),
    ("gripperRotTorque",   "gripperRotTorque",   "회전그리퍼 토크 % (uint8)"),
    ("gripper_position",   "gripper_position",   "그리퍼 위치 %"),
    ("collisionState",     "collisionState",     "충돌 플래그 (1=충돌)"),
    ("frame_cnt",          "frame_cnt",          "프레임 카운터"),
]


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


def sample(robot):
    """패킷을 한 번 읽어 평평한 dict 로 만든다."""
    p = robot.robot_state_pkg
    row = {"t": time.time()}
    for i, v in enumerate(p.jt_cur_pos):
        row[f"j{i+1}_pos"] = float(v)
    for name, field, n, _ in FIELDS:
        arr = getattr(p, field, None)
        for i in range(n):
            row[f"{name}_{i+1}"] = float(arr[i]) if arr is not None else float("nan")
    for name, field, _ in SCALARS:
        row[name] = float(getattr(p, field, float("nan")))
    return row


def collect(robot, seconds, label):
    """seconds 동안 샘플을 모은다. 움직이지 않는다."""
    rows, t0 = [], time.time()
    while time.time() - t0 < seconds:
        rows.append(sample(robot))
        time.sleep(POLL_S)
    print(f"    {label}: {len(rows)}개 샘플 / {seconds}초")
    return rows


def stats(rows, key):
    vals = [r[key] for r in rows if r.get(key) == r.get(key)]   # NaN 제거
    if not vals:
        return None
    return min(vals), max(vals), statistics.fmean(vals)


def report_filled(rows, title):
    """어떤 필드가 실제로 채워지는지 — 이 스크립트의 핵심 산출물."""
    print(f"\n  ── {title} ──")
    for name, _, n, desc in FIELDS:
        cells = []
        any_filled = False
        for i in range(n):
            st = stats(rows, f"{name}_{i+1}")
            if st is None:
                cells.append("    ?   ")
                continue
            lo, hi, mean = st
            if abs(lo) < FILLED_EPS and abs(hi) < FILLED_EPS:
                cells.append("   0    ")
            else:
                any_filled = True
                cells.append(f"{mean:+8.2f}")
        mark = "✅" if any_filled else "❌ 안 채워짐"
        print(f"    {name:18s} {' '.join(cells)}   {mark}  ({desc})")
    print()
    for name, _, desc in SCALARS:
        st = stats(rows, name)
        if st is None:
            print(f"    {name:18s}      ?"); continue
        lo, hi, mean = st
        rng = "" if lo == hi else f"  (범위 {lo:.0f}~{hi:.0f})"
        print(f"    {name:18s} {mean:8.2f}{rng}   ({desc})")


def main():
    ap = argparse.ArgumentParser(
        description="j6 토크/전류를 읽을 수 있는지, 회전할 때 변하는지 잰다")
    ap.add_argument("--seconds", type=float, default=3.0, help="정지 샘플링 시간 (기본 3)")
    ap.add_argument("--move", type=float, default=None,
                    help="j6 를 이만큼(도) 돌리며 샘플링. 부호가 방향. "
                         "⚠ 양수 = 오른쪽 = **조이는 방향**")
    ap.add_argument("--vel", type=float, default=3.0, help="이동 속도 %% (기본 3)")
    ap.add_argument("--csv", default=None, help="원시 샘플을 쓸 CSV 경로")
    ap.add_argument("--ip", default=SITE.ROBOT_IP)
    ap.add_argument("--back", action="store_true",
                    help="--move 만큼 갔다가 **제자리로 되돌아온다**. 두 방향의 힘을 비교하고, "
                         "끝나면 나사 위치가 그대로다")
    ap.add_argument("--run", action="store_true",
                    help="--move 를 **실제로** 하려면 필요. 없으면 정지 샘플링만 한다")
    a = ap.parse_args()

    if a.move is not None and abs(a.move) > MOVE_GUARD_DEG:
        raise SystemExit(f"⛔ --move {a.move}° 는 너무 크다 (최대 ±{MOVE_GUARD_DEG:.0f}°)")

    print("═" * 76)
    print("j6 토크·전류 측정" + ("" if (a.move and a.run) else "  (정지 샘플링만 — 로봇 안 움직임)"))
    print("═" * 76)

    robot = RPC(ip=a.ip)
    print(robot)

    # ── [1] 패킷이 살아 있나 ──────────────────────────────────────────────
    # 토크가 0 일 때 "컨트롤러가 안 채운다" 와 "소켓이 죽었다" 를 갈라야 한다.
    # frame_cnt 가 오르고 jt_cur_pos 가 게터와 일치하면 스트림은 살아 있는 것이고,
    # 그때의 0 은 **진짜 안 채우는 것**이다.
    print("\n[1] 실시간 패킷이 살아 있나")
    time.sleep(0.5)                        # 백그라운드 수신 스레드 예열
    c0 = int(robot.robot_state_pkg.frame_cnt)
    time.sleep(1.0)
    c1 = int(robot.robot_state_pkg.frame_cnt)
    moved = (c1 - c0) % 256
    print(f"    frame_cnt {c0} → {c1}  (1초에 {moved}프레임)")
    if moved == 0:
        raise SystemExit("⛔ 패킷이 안 온다 — 이 상태의 0 은 아무 의미가 없다. "
                         "포트 20003 연결과 컨트롤러 상태를 먼저 확인해라")

    rtn = robot.GetActualJointPosDegree(0)
    _code(rtn, "GetActualJointPosDegree")
    getter = [float(v) for v in rtn[1]]
    pkt = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
    gap = max(abs(g - p) for g, p in zip(getter, pkt))
    print(f"    게터 vs 패킷 관절값 최대 차이 {gap:.4f}°  "
          f"{'✅ 같은 원천' if gap < 0.5 else '⚠ 어긋난다'}")

    p = robot.robot_state_pkg
    print(f"    고장 {int(p.main_code)}/{int(p.sub_code)} · 모드 {int(p.robot_mode)} "
          f"(0=자동) · j6 {pkt[5]:+.2f}° · 그리퍼 {int(p.gripper_position)}%")

    # ── [2] 정지 상태 — 어떤 필드가 채워지나 ──────────────────────────────
    print(f"\n[2] 정지 샘플링 {a.seconds}초  (움직이지 않는다)")
    rest = collect(robot, a.seconds, "정지")
    report_filled(rest, "정지 상태 평균 (j1 … j6)")

    print("\n    ⚠ 위에서 ❌ 인 줄은 컨트롤러가 그 필드를 안 보낸다는 뜻이다.")
    print("      게터는 그래도 code=0 을 돌려주므로 반환값만 보면 알 수 없다.")
    print("      ✅ 인데 j2/j3 이 큰 값이면 **중력을 받고 있는 것** = 진짜 물리량이다.")

    # ── [3] 단위 추정 ─────────────────────────────────────────────────────
    print("\n[3] 단위 추정")
    st_cur = stats(rest, "jt_cur_tor_2")
    st_drv = stats(rest, "jointDriverTorque_2")
    if st_cur and abs(st_cur[2]) > FILLED_EPS:
        m = abs(st_cur[2])
        print(f"    j2 정지 토크(jt_cur_tor) = {st_cur[2]:+.2f}")
        if m > 100:
            print("      → 100 을 넘으니 **백분율이 아니다.** Nm 로 본다")
        elif m < 1.0:
            print("      → 너무 작다. 정규화된 값이거나 중력보상이 이미 빠진 값이다")
        else:
            print("      ⚠ 1~100 구간이라 Nm 과 % 를 이것만으로 못 가른다.")
            print("        --move 로 팔을 움직여 값이 어떻게 변하는지 봐야 갈린다")
        if st_drv and abs(st_drv[2]) > FILLED_EPS:
            print(f"    j2 드라이버 토크 = {st_drv[2]:+.2f}  "
                  f"(비 {st_drv[2]/st_cur[2]:+.3f})  ← 배율이 보이면 한쪽이 정규화된 것")
    else:
        print("    jt_cur_tor 가 안 채워져서 추정할 게 없다")

    rows = list(rest)

    # ── [4] 회전 중 ───────────────────────────────────────────────────────
    if a.move is None:
        print("\n[4] 건너뜀 — --move 를 안 줬다")
    elif not a.run:
        tgt = pkt[5] + a.move
        print(f"\n[4] 계획만 — j6 {pkt[5]:+.2f}° → {tgt:+.2f}°  "
              f"({'오른쪽=조임 ⚠' if a.move > 0 else '왼쪽=풂'})")
        print("    실제로 하려면 --run 을 붙여라")
    else:
        target = list(pkt)
        target[5] = pkt[5] + a.move
        lo, hi = SITE.JOINT_LIMITS_DEG[5]
        if not (lo + SITE.J6_MARGIN_DEG <= target[5] <= hi - SITE.J6_MARGIN_DEG):
            raise SystemExit(f"⛔ j6 {target[5]:+.2f}° 가 허용 밖 "
                             f"({lo+SITE.J6_MARGIN_DEG:+.0f}~{hi-SITE.J6_MARGIN_DEG:+.0f})")
        ok, why = selfcheck.scan_joint_path(pkt, target, n=10)
        if not ok:
            raise SystemExit(f"⛔ 자기충돌 — {why[0]}")

        if a.move > 0:
            print("\n⚠️  **오른쪽 = 조이는 방향이다.** 이미 앉은 나사면 과조임이 된다.")
        leg1 = "왼쪽=풂" if a.move < 0 else "오른쪽=조임"
        leg2 = "오른쪽=조임" if a.move < 0 else "왼쪽=풂"
        print(f"\n[4] 회전 j6 {pkt[5]:+.2f}° → {target[5]:+.2f}°  ({a.move:+.1f}°, {a.vel}%) — {leg1}")
        if a.back:
            print(f"    그리고 {pkt[5]:+.2f}° 로 되돌아온다 ({-a.move:+.1f}°) — {leg2}")
            print("    ⚠ 제자리로 오므로 **나사 위치는 그대로다.**")
        input("    계속하려면 Enter (중단은 Ctrl+C): ")

        def leg(dst, label):
            """dst 로 이동하면서 샘플을 모은다. 이동이 끝나면 샘플 목록을 돌려준다."""
            cur = [float(v) for v in robot.robot_state_pkg.jt_cur_pos]
            cap = SITE.wait_cap_s(cur, dst, a.vel)
            _code(robot.MoveJ(list(dst), int(p.tool), int(p.user),
                              vel=float(a.vel), blendT=0.0), f"MoveJ({label})")
            t0, out = time.time(), []
            while time.time() - t0 < cap:
                r = sample(robot)
                out.append(r)
                if abs(r["j6_pos"] - dst[5]) < ARRIVE_EPS_DEG:
                    break
                time.sleep(POLL_S)
            print(f"    {label}: {len(out)}개 샘플 / {time.time()-t0:.1f}초 · "
                  f"도착 j6 {out[-1]['j6_pos']:+.2f}°")
            _fault(robot, label)
            return out

        mv = leg(target, leg1)
        rows += mv
        report_filled(mv, f"{leg1} 평균 (j1 … j6)")

        mv2 = None
        if a.back:
            back = list(target)
            back[5] = pkt[5]
            mv2 = leg(back, leg2)
            rows += mv2
            report_filled(mv2, f"{leg2} 평균 (j1 … j6)")

        # 정지 대비 j6 이 얼마나 변했나 — 이게 판정에 쓸 수 있느냐의 답이다
        print("\n[5] j6 — 정지 대비 (판정에 쓸 수 있나)")
        hdr = f"    {'필드':20s} {'정지':>9} {leg1:>11}"
        if mv2 is not None:
            hdr += f" {leg2:>11}   {'차이':>8}"
        print(hdr)
        for name in ("jt_cur_tor_6", "jt_tgt_tor_6", "jointDriverTorque_6",
                     "actual_qd_6", "gripper_current", "gripperRotTorque"):
            sr, sm = stats(rest, name), stats(mv, name)
            if not sr or not sm:
                continue
            span = sm[1] - sm[0]
            verdict = "✅ 변한다" if abs(sm[2] - sr[2]) > 0.05 or span > 0.05 else "❌ 안 변한다"
            line = f"    {name:20s} {sr[2]:+9.2f} {sm[2]:+11.2f}"
            if mv2 is not None:
                s2 = stats(mv2, name)
                if s2:
                    line += f" {s2[2]:+11.2f}   {s2[2]-sm[2]:+8.2f}"
                    if abs(s2[2] - sm[2]) > 0.05:
                        verdict += " · 방향차 있음"
            print(f"{line}  {verdict}")
        if mv2 is not None:
            print("\n    ⚠ **방향차**가 핵심이다. 조일 때가 풀 때보다 토크가 크면,")
            print("      그 차이로 '나사가 얼마나 뻑뻑한가' 를 읽을 수 있다.")
            print("      바닥에 닿으면 조이는 쪽만 급격히 커진다 → 자동 판정의 재료다.")

    # ── CSV ───────────────────────────────────────────────────────────────
    if a.csv:
        keys = sorted({k for r in rows for k in r})
        keys.remove("t"); keys = ["t"] + keys
        with open(a.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            w.writerows(rows)
        print(f"\n    CSV {len(rows)}행 → {a.csv}")

    print("\n" + "═" * 76)
    print("판단 기준")
    print("  · [2] 에서 jt_cur_tor 가 ❌ 면 → **토크 판정은 이 기체에서 불가능**하다.")
    print("        그러면 위치 스톨(지금 방식) + 사람 눈이 유일한 수단이다.")
    print("  · [5] 에서 jt_cur_tor_6 가 ✅ 면 → 조일 때 얼마나 오르는지 이어서 재고")
    print("        그 값을 fr5_site 에 문턱으로 박는다.")
    print("  · actual_qd_6 가 ✅ 면 → **스톨 판정을 위치 대신 속도로 바꿀 수 있다.**")
    print("        고무가 흡수해도 속도는 떨어지므로 지금 방식보다 민감하다.")
    print("═" * 76)


if __name__ == "__main__":
    main()
