#!/usr/bin/env python3
"""보존 게이트 — 연속 상태 프레임을 저장할지 정하는 순수 함수.

계약(RECORD-NODE-CONTRACT.md §보존 정책)의 규칙을 한 곳에 담는다:
  저장 조건 = motionQueueLength>0 · 관절/pose/그리퍼 변화>ε · 전이(phase·safety·connected·enabled·그리퍼 플래그).
  나머지(유휴)는 건너뛴다. **전이는 드물고 중요해 항상 저장한다.**

⚠ **`enabled` 는 「활성」이 아니라 「전이」다** (2026-08-10 실기 실측으로 정정). 서보를 올린 채
세워 두는 것이 실사용의 기본 상태라, `enabled=1` 을 저장 조건으로 쓰면 게이트가 통째로 단락된다 —
10초 관측에서 관절 변동폭 0.0008°(ε 의 1/125)인데 297/297 저장 · 건너뜀 0% 였다. 행당 4,124B 라
그대로 두면 9.85GB/일이다.

⚠ **그리퍼가 조건에 반드시 있다.** 집기는 팔이 선 채 손만 움직인다 — 관절만 보면 파지 구간이
통째로 안 남는다. 이 두 줄이 파지 킬실험의 계측선이다.

하드웨어도 DB도 건드리지 않는다 — 프레임 dict 둘을 받아 (저장?, 사유) 만 돌려준다.
그래서 단위 테스트가 장비 없이 돈다. 값은 API 계약대로 도(°)·mm.
"""

EPS_DEG_JOINT = 0.1    # 관절이 이만큼(도) 넘게 움직이면 저장 (엔코더 잡음 위)
EPS_MM_POSE   = 5.0    # AMR 위치가 이만큼(mm) 넘게 움직이면 저장
EPS_DEG_POSE  = 0.5    # AMR 방향이 이만큼(도) 넘게 돌면 저장
EPS_PCT_GRIP  = 0.5    # 그리퍼 벌어짐(%)이 이만큼 넘게 바뀌면 저장 (pct 는 0~100 정수 보고라 1단위를 잡는다)

# safety 전이 판정에 쓰는 필드 — 하나라도 바뀌면 저장 (계약 §상태값)
SAFETY_FLAGS = ("emergencyStop", "safetyStop", "collisionDetected",
                "inDragTeach", "mainErrorCode", "subErrorCode")

# 그리퍼 전이 판정에 쓰는 필드 — `motionDone`·`fault` 가 파지 킬실험이 재려는 바로 그 값이다
GRIPPER_FLAGS = ("active", "fault", "motionDone")


def _safety_sig(frame):
    s = frame.get("safety") or {}
    return tuple(s.get(k) for k in SAFETY_FLAGS)


def _gripper_sig(frame):
    g = frame.get("gripper") or {}
    return tuple(g.get(k) for k in GRIPPER_FLAGS)


def _gripper_moved(prev, cur):
    pg, cg = (prev.get("gripper") or {}).get("pct"), (cur.get("gripper") or {}).get("pct")
    if pg is None or cg is None:
        return False
    return abs(cg - pg) > EPS_PCT_GRIP


def _max_abs_delta(a, b):
    if not a or not b or len(a) != len(b):
        return float("inf")     # 모양이 바뀌었으면 저장 쪽으로 (결측=보수적)
    return max(abs(x - y) for x, y in zip(a, b))


def _joints_moved(prev, cur):
    pj, cj = prev.get("jointsDeg"), cur.get("jointsDeg")
    if pj is None and cj is None:
        return False
    return _max_abs_delta(pj, cj) > EPS_DEG_JOINT


def _pose_moved(prev, cur):
    pp, cp = prev.get("pose"), cur.get("pose")
    if not pp or not cp:
        return False
    import math
    dxy = math.hypot((cp.get("xMm", 0) - pp.get("xMm", 0)),
                     (cp.get("yMm", 0) - pp.get("yMm", 0)))
    dth = abs(cp.get("thetaDeg", 0) - pp.get("thetaDeg", 0))
    return dxy > EPS_MM_POSE or dth > EPS_DEG_POSE


def should_store(prev, cur):
    """(저장할지: bool, 사유: str). prev 는 마지막으로 **저장한** 프레임(없으면 None)."""
    if prev is None:
        return True, "first"
    # ── 전이: 드물고 중요 — 항상 저장 ──
    if cur.get("phase") != prev.get("phase"):
        return True, "phase"
    if _safety_sig(cur) != _safety_sig(prev):
        return True, "safety"
    if bool(cur.get("connected")) != bool(prev.get("connected")):
        return True, "connected"
    # 서보 온·오프는 드물고 중요하다 — **바뀔 때만** 싣는다. 켜져 있는 동안 계속 싣지 않는다
    if bool(cur.get("enabled")) != bool(prev.get("enabled")):
        return True, "enabled-edge"
    if _gripper_sig(cur) != _gripper_sig(prev):
        return True, "gripper-flag"
    # ── 활성: 큐·실제 이동 (「움직였나」만 본다) ──
    if (cur.get("motionQueueLength") or 0) > 0:
        return True, "motion-queue"
    if _joints_moved(prev, cur):
        return True, "joint-move"
    if _pose_moved(prev, cur):
        return True, "pose-move"
    if _gripper_moved(prev, cur):
        return True, "gripper-move"
    return False, "idle-skip"
