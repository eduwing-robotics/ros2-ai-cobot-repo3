#
# 🛡️ 자기충돌 · 경로 훑기 — **보내기 전에** 확인한다
#
# 왜 만드나 (2026-09-03)
#   2026-09-02 실기 사고: WebApp 에 저장된 PTP 로 이동시켰더니 **그리퍼가 자기 몸체를
#   쳤다.** PTP(=MoveJ)는 "직선으로 가라"가 아니라 각 관절을 시작각→목표각으로 보간할
#   뿐이라, **손끝이 그리는 궤적은 아무도 계획하지 않는다.** 두 점 사이에 몸체가 있으면
#   그냥 통과하려 든다.
#
#   그런데 이 스택 어디에도 자기 몸체를 보는 코드가 없었다:
#     · 학습 환경(fr5_screw_assembly) — 순수 수식이라 **팔 링크가 아예 없다**
#     · IK(ToolIK)                    — 목표 도달 여부만
#     · check_joint_limits            — **관절 한계만.** 모든 관절이 범위 안이면서
#                                        팔이 자기 몸을 관통하는 자세는 얼마든지 있다
#   MuJoCo 씬에는 로봇 전체 형상이 이미 있다. 그걸로 보내기 전에 본다.
#
# 한계 — 정직하게 적는다
#   · MuJoCo 는 메시 충돌을 **볼록껍질(convex hull)** 로 근사한다. 실제 형상보다 부풀어
#     있어 **없는 충돌을 알릴 수는 있어도(안전 방향), 오목한 틈을 놓칠 수 있다.**
#   · 이 검사는 **기하만** 본다. 속도·관성·케이블·주변 장애물은 모르는 값이다.
#   · 그래서 이건 최후 방어선이 아니라 **한 겹**이다. 컨트롤러 Collision Detection
#     (WebApp → Program → Coding → Col-D · 민감도 100 은 너무 둔감하니 10~20)을
#     같이 켜 둔다. 교육자료 7장 §10.
#
import os

import numpy as np
import mujoco

MJCF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fairino5_v6_mjmodel.xml")
JOINT_NAMES = ("j1", "j2", "j3", "j4", "j5", "j6")

# 판정 둘로 나눈다 — 섞으면 경고가 신호를 덮는다.
#   관통(dist < 0)  : **충돌이다.** 4000 자세 표본에서 안전한 자세는 한 건도 안 낸다
#   근접(0~margin)  : 경고. 구조적으로 늘 붙어 다니는 쌍(어깨↔상완 등)이 섞이므로
#                     사람이 보고 판단한다. 막지 않는다
NEAR_MARGIN_M = 0.015           # 15mm

# **씬 아티팩트 — 뺀다.**
# `held_bullet` 은 contype=0 이라 애초에 충돌하지 않지만 명시해 둔다.
#
# ⚠ **2026-09-07: `casing` 을 여기서 뺐다.** 이전에는 탄피가 (0, 0, 0.1) 즉 로봇 베이스
#   바로 위 공중에 떠 있어서 어떤 자세에서도 어깨와 겹쳤고, 안 빼면 **모든 자세가
#   충돌로 나왔다.** 지금은 실측 자리(-274.0, -654.8, +48.6 mm — task_origin.json)에
#   고정대와 함께 놓았으므로 **탄피 충돌은 이제 진짜 신호다.** 다시 넣지 마라.
#   탄피가 고정대에 꽂혀 상시 닿는 것은 MJCF 의 <exclude casing bench/> 로 처리했다.
ARTIFACT_BODIES = frozenset({"held_bullet"})

_model = None
_data = None


def _lazy(margin_m):
    global _model, _data
    if _model is None:
        _model = mujoco.MjModel.from_xml_path(MJCF)
        _data = mujoco.MjData(_model)
    _model.geom_margin[:] = margin_m        # 호출자가 값을 바꿔 부를 수 있다
    return _model, _data


def _pairs(joints_deg, margin_m):
    """그 자세의 접촉 쌍 → `{(바디A,바디B): 최소간격mm}`. 아티팩트는 빼고 중복은 접는다.

    바디 하나에 geom 이 여럿이라(손목만 4개) 같은 쌍이 여러 번 나온다 — 접지 않으면
    한 자세가 위반 다섯 건으로 부풀어 사람이 못 읽는다.
    """
    m, d = _lazy(margin_m)
    for i, n in enumerate(JOINT_NAMES):
        jid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, n)
        d.qpos[m.jnt_qposadr[jid]] = np.deg2rad(float(joints_deg[i]))
    mujoco.mj_forward(m, d)
    out = {}
    for k in range(d.ncon):
        c = d.contact[k]
        a = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, m.geom_bodyid[c.geom1])
        b = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, m.geom_bodyid[c.geom2])
        if a in ARTIFACT_BODIES or b in ARTIFACT_BODIES:
            continue
        key = tuple(sorted((a, b)))
        dist = float(c.dist) * 1000.0
        out[key] = min(out.get(key, 9e9), dist)
    return out


def contacts_at(joints_deg, margin_m=NEAR_MARGIN_M):
    """`(관통, 근접)` — 각각 `[(바디A, 바디B, 간격mm)]`."""
    pen, near = [], []
    for (a, b), dist in sorted(_pairs(joints_deg, margin_m).items(), key=lambda x: x[1]):
        (pen if dist < 0 else near).append((a, b, dist))
    return pen, near


def self_collision(joints_deg):
    """**충돌만** (관통). 이게 하드 판정이다."""
    return contacts_at(joints_deg, margin_m=0.0)[0]


# ══════════════════════════════════════════════════════════════════════════
# 책상 이격 — **관통 검사와 다른 이야기다.**
# 자기충돌 검사는 "닿았나"를 본다. 이건 "닿기 전에 얼마나 가까운가"를 본다.
# 씬에 없는 물건(사람 손·치구·케이블)은 아무도 안 보므로, 책상 위 일정 높이를
# 통째로 금지 구역으로 잡아 여유를 만든다.
#
# ⚠ **탄두(held_bullet)는 뺀다.** 정상 체결이 곧 탄두를 탄피에 꽂는 일이라,
#   탄두를 넣으면 성공하는 동작이 매번 거부된다. 막는 대상은 **그리퍼**다.
#   (2026-09-08 실측: 체결 가장 깊을 때 그리퍼 최저점 +44.3mm, 금지선 -6.4mm)
GRIPPER_BODIES = ("finger_tip_left_link", "finger_tip_right_link", "wrist3_link")


def _set_joints(m, d, joints_deg):
    for i, n in enumerate(JOINT_NAMES):
        jid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, n)
        d.qpos[m.jnt_qposadr[jid]] = np.deg2rad(float(joints_deg[i]))
    mujoco.mj_forward(m, d)


def desk_top_m():
    """책상 상면 z (m, 로봇 base 기준). 씬의 `desk` geom 에서 읽는다 — 상수로 안 박는다."""
    m, d = _lazy(0.0)
    gid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "desk")
    if gid < 0:
        raise RuntimeError("씬에 desk geom 이 없다 — 책상 이격을 잴 기준이 없다")
    mujoco.mj_forward(m, d)
    return float(d.geom_xpos[gid][2] + m.geom_size[gid][2])


def gripper_min_z_mm(joints_deg):
    """그 자세에서 그리퍼 부위의 최저 z `(mm, 어느 부위)`.

    geom 중심에서 바운딩 구 반지름을 뺀 값이라 **실제보다 낮게** 잡는다 — 안전 쪽 오차다.
    """
    m, d = _lazy(0.0)
    _set_joints(m, d, joints_deg)
    lo, who = 9e9, None
    for name in GRIPPER_BODIES:
        bid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, name)
        if bid < 0:
            continue
        for g in range(m.ngeom):
            if m.geom_bodyid[g] == bid:
                z = float(d.geom_xpos[g][2] - m.geom_rbound[g]) * 1000.0
                if z < lo:
                    lo, who = z, name
    if who is None:
        raise RuntimeError(f"그리퍼 바디를 못 찾았다: {GRIPPER_BODIES}")
    return lo, who


def scan_desk_clearance(poses, limit_z_mm):
    """자세 목록 전부에서 그리퍼가 `limit_z_mm` 아래로 내려가는지 본다.

    반환: `(ok, 사유목록)`. 첫 위반에서 안 멈추고 전부 모은다.
    """
    reasons = []
    for tag, j in poses:
        z, who = gripper_min_z_mm(j)
        if z < limit_z_mm:
            reasons.append(f"{tag}: {who} 가 z={z:.1f}mm — 금지선 {limit_z_mm:.1f}mm "
                           f"아래로 {limit_z_mm - z:.1f}mm 침범")
    return (not reasons), reasons


def j6_pos_mm(joints_deg):
    """그 자세에서 j6(손목 마지막 축) 관절 위치 (mm, 로봇 base 기준)."""
    m, d = _lazy(0.0)
    _set_joints(m, d, joints_deg)
    jid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, "j6")
    if jid < 0:
        raise RuntimeError("모델에 j6 관절이 없다")
    return d.xanchor[jid] * 1000.0


def scan_j6_box(poses, center_xy_mm, desk_top_mm, half_xy_mm, z_min_mm, z_max_mm):
    """j6 이 **책상 위에 세운 직육면체** 안에 있나.

    거리(구)가 아니라 상자다 — 위로는 길게 열어두고 옆으로만 좁게 막으려면
    구로는 표현이 안 된다. 위아래 한계는 **책상 상면 기준**이다.

    반환: `(ok, 사유목록)`.
    """
    reasons = []
    lo_z, hi_z = desk_top_mm + z_min_mm, desk_top_mm + z_max_mm
    for tag, j in poses:
        x, y, z = j6_pos_mm(j)
        dx, dy = x - center_xy_mm[0], y - center_xy_mm[1]
        if abs(dx) > half_xy_mm or abs(dy) > half_xy_mm:
            reasons.append(f"{tag}: j6 가 탄피에서 옆으로 "
                           f"(x {dx:+.1f}, y {dy:+.1f})mm — 한계 ±{half_xy_mm:.0f}mm")
        if not (lo_z <= z <= hi_z):
            reasons.append(f"{tag}: j6 높이 {z:.1f}mm (책상 위 {z-desk_top_mm:+.1f}mm) — "
                           f"허용 책상 위 {z_min_mm:.0f}~{z_max_mm:.0f}mm")
    return (not reasons), reasons


def scan_joint_path(j_from, j_to, n=25):
    """**가는 길을 움직이기 전에 훑는다.**

    `MoveJ` 는 관절을 선형 보간하므로 중간 자세를 그대로 재현할 수 있다 (FR5Web 브리지
    `commands._scan_path` 와 같은 수법 — 표본을 떠서 하나라도 막히면 보내지 않는다).

    ⚠ **끝점만 보면 못 잡는다.** 2026-09-02 사고가 그랬다 — 시작도 목표도 멀쩡한데
    가는 길 한가운데서 그리퍼가 상완을 쳤다.

    반환: `(ok, 사유목록)`. 첫 위반에서 안 멈추고 전부 모은다 — 어디서 어디까지
    나쁜지 알아야 사람이 판단한다.
    """
    a = np.asarray(j_from, dtype=float)
    b = np.asarray(j_to, dtype=float)
    reasons = []
    for i in range(n + 1):
        t = i / n
        for x, y, dist in self_collision(a + (b - a) * t):
            reasons.append(f"경로 {t*100:5.1f}% 지점: {x} ↔ {y} {abs(dist):.1f}mm 관통")
    return (not reasons), reasons


def describe(joints_deg, margin_m=NEAR_MARGIN_M):
    """사람이 읽는 한 줄."""
    pen, near = contacts_at(joints_deg, margin_m)
    if pen:
        return "⛔ 충돌 " + " · ".join(f"{a}↔{b} {abs(d):.1f}mm" for a, b, d in pen)
    if near:
        return "⚠ 근접 " + " · ".join(f"{a}↔{b} {d:.1f}mm" for a, b, d in near[:3])
    return f"안전 (관통 0 · {margin_m*1000:.0f}mm 안 근접 0)"
