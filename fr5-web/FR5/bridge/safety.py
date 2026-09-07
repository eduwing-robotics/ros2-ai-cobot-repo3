# 안전 게이트 — 서버가 강제한다, 클라이언트를 믿지 않는다 (SAFETY-RULES.md 가 정본).
# 제1원칙: 값을 못 읽으면 통과가 아니라 차단이다. 기본 반환은 차단이고 전부 통과해야 허용.
# 상한 초과는 자르지 않고 거부한다 — 잘라주면 클라이언트 버그가 숨는다 (TB 규칙 미러).
import json
import math
import pathlib

SPEED_CAP_PCT = 10.0            # v3 DefaultLiveSpeedCapPercent (SAFETY-RULES §상한)
JOINT_DELTA_CAP_DEG = 5.0       # v3 tiny-MoveJ 상한
# 상한 비교의 미세 여유. **안전 여유가 아니라 「잡음」 여유다.**
#
# 조그 걸음 `5°` 가 이 상한 `5°` 와 **정확히 같아서 여유가 0** 인데, 목표는 `jog()` 가
# `lastState` 로 만들고 판정은 `motion()` 이 `read_fresh_state()` 로 **다시 읽어** 한다.
# 그 사이의 값 흔들림이 그대로 초과가 된다.
#
# 2026-08-11 실기 실측 — 서보 ON·정지 상태에서 `/state` 를 6회 연속 읽으니 축별로
# **0.0002~0.0004°** 흔들렸고, 옛 값으로 만든 목표와 새 값의 차가 `5.000200000000007` 이
# 되어 **5° 조그가 거부됐다.** 게다가 사유가 `.2f` 로 찍혀 `5.00° > 5.0°` 로 보였다 —
# 말이 안 되게 보여서 원인이 안 잡혔다. 그래서 자릿수도 `.4f` 로 늘린다(로봇이 소수 4자리로
# 보고한다). **게이트가 결론을 안 적으면 같은 판을 다시 돈다.**
#
# 0.001° 는 잡음의 2.5배이고 손끝에서 **0.016mm** 다 — 물리적으로 의미가 없다.
# ⚠ **이 값을 키우지 마라.** 값이 크게 다른 경우는 로봇이 **실제로 움직이는 중**이라
#   거부가 옳다 (조건 8 · 드리프트 방어선).
JOINT_DELTA_EPS_DEG = 0.001
STATE_FRESH_S = 0.5             # 조건 10 — 최신 상태 신선도 (33ms 폴링 기준 넉넉히)
DRIFT_CAP_DEG = 5.0             # 조건 8 대안(#9) — 우리가 보낸 MoveJ 목표 vs 실측 차이

# URDF fairino5_v6 <limit> 실측 추출 (라디안→도 변환, 2026-07-31) — 조건 12
# 실기 컨트롤러가 보고한 소프트리밋과 대조해 확정 (2026-08-04 · GetJointSoftLimitDeg).
# j3 만 URDF 값(±162)이 컨트롤러(±160)보다 넓었다 — **좁은 쪽을 쓴다.** 우리가 더 넓으면
# 컨트롤러가 거부할 목표를 게이트가 통과시킨다.
JOINT_LIMITS_DEG = [
    (-175.0, 175.0), (-265.0, 85.0), (-160.0, 160.0),
    (-265.0, 85.0), (-175.0, 175.0), (-175.0, 175.0),
]

# 게이트가 반드시 읽어야 하는 안전 필드 — 하나라도 결측이면 차단 (조건 2·4·22 재료)
REQUIRED_FOR_MOTION = ["emergencyStop", "safetyStop", "collisionDetected",
                       "inDragTeach", "mainErrorCode", "subErrorCode"]


def _common_safety(state, state_age_s, applied_settings, amr_status=None):
    """관절·그리퍼가 **함께** 지나는 관문. 두 게이트가 이 판정을 복붙하면 한쪽만 고쳐진다.
    state 가 None 이면 다른 사유를 버리고 fail-closed 한 줄만 돌려준다 (호출자가 즉시 반환)."""
    reasons = []
    # 조건 26 — 컨트롤러 충돌 감지는 기본으로 안 켜져 있다. 브리지가 넣었다는 기록이
    # 없으면 조건 4·5 는 판정할 게 없는 상태다 (SAFETY-RULES §설정이 전제다)
    if not applied_settings:
        reasons.append("안전 설정 적용 기록이 없다 — 충돌 감지가 켜졌는지 모른다 (조건 26)")
    elif applied_settings.get("mismatch"):
        reasons.append("안전 설정 되읽기 불일치 — " + " · ".join(applied_settings["mismatch"]))
    # 조건 27 — 터틀봇이 움직이는 동안 팔은 안 움직인다 (계약 §상호 배제 · 2026-09-07).
    # **켰을 때만** fail-closed: 주소가 없으면 `enabled` False 라 아무 말도 안 한다.
    # 「움직이는지 모른다」(낡음·독자 note·velocity 없음)는 「안 움직인다」가 아니다 — 막는다.
    if amr_status and amr_status.get("enabled"):
        if amr_status.get("moving") is None:
            why = amr_status.get("note") or f"상태 나이 {amr_status.get('ageSec')}s"
            reasons.append(f"터틀봇 상태를 못 읽습니다 — 움직이는지 모른다 ({why} · 조건 27)")
        elif amr_status.get("moving"):
            v = amr_status.get("velocity") or {}
            reasons.append("터틀봇이 움직이는 중입니다 — 멈추면 다시 누르세요 "
                           f"({v.get('linearMmS')}mm/s · {v.get('angularDegS')}°/s · 조건 27)")
    if state is None:
        return ["상태를 읽지 못했다 — fail-closed (조건 17)"]
    if state_age_s > STATE_FRESH_S:
        reasons.append(f"상태가 낡았다 — {state_age_s:.2f}s > {STATE_FRESH_S}s (조건 10)")

    safety = state.get("safety") or {}
    for f in REQUIRED_FOR_MOTION:
        if f not in safety:
            reasons.append(f"안전 필드 결측 — safety.{f} (제1원칙: 결측=차단)")
    if safety.get("emergencyStop"):
        reasons.append("비상정지 작동 중 (조건 1)")
    if safety.get("safetyStop"):
        reasons.append("안전정지 신호 (조건 22)")
    if safety.get("mainErrorCode") or safety.get("subErrorCode"):
        reasons.append(f"컨트롤러 오류 {safety.get('mainErrorCode')}/{safety.get('subErrorCode')} (조건 2)")
    if safety.get("collisionDetected"):
        reasons.append("충돌 감지 상태 (조건 4)")
    if safety.get("inDragTeach"):
        reasons.append("드래그 티칭 중 — 명령을 보내지 않는다")
    return reasons


def path_samples(from_deg, to_deg, step_deg=JOINT_DELTA_CAP_DEG):
    """현재→목표를 관절 공간에서 선형 보간한 표본 목록 (끝점 포함, 시작점 제외).

    **`MoveJ` 가 실제로 가는 길이 이것이다** — 관절을 동시에 비례로 움직인다.
    간격을 조그 상한과 같은 값으로 두는 이유: 사람이 반응할 수 있는 크기라는 근거가 같다.
    두 끝이 URDF 한계 안이면 사이도 전부 안이다(볼록) — 그래서 여기서 한계를 다시 안 본다.
    """
    if len(from_deg) != 6 or len(to_deg) != 6:
        return None
    if not all(isinstance(v, (int, float)) and math.isfinite(v)
               for v in list(from_deg) + list(to_deg)):
        return None
    span = max(abs(t - c) for t, c in zip(to_deg, from_deg))
    n = max(1, math.ceil(span / float(step_deg)))
    return [[c + (t - c) * (i / n) for c, t in zip(from_deg, to_deg)]
            for i in range(1, n + 1)]


def check_motion(state, state_age_s, target_deg, speed_pct, applied_settings=None,
                 delta_cap=JOINT_DELTA_CAP_DEG, commanded_deg=None, amr_status=None):
    """jog/moveJ 게이트 (SAFETY-RULES §명령별 최소 조건). 반환: 사유 목록, 비면 허용.

    `delta_cap=None` 은 **경로를 대신 검사했을 때만** 쓴다 (지점 이동 · 계약 §경로 검사).
    5° 상한의 근거가 "경로가 안 보인다" 이므로, 경로를 보면 그 근거가 사라진다.

    `commanded_deg` 는 **브리지가 마지막으로 보낸 MoveJ 목표**다 (계약 §드리프트 기준).
    `None` 이면 추종을 논할 게 없어 드리프트를 검사하지 않는다.
    """
    reasons = _common_safety(state, state_age_s, applied_settings, amr_status)
    if state is None:
        return reasons
    # **거부 문구가 곧 화면 문구다** — 이 문장이 그대로 조작대에 뜬다. 우리끼리 쓰는 말만
    # 적으면 사람이 "기다리면 된다" 를 못 읽고 고장으로 오해한다. 사람 말을 앞에 두고
    # 기계 근거는 괄호로 남긴다 (테스트·게이트가 「모션 큐」 를 부분일치로 본다)
    if state.get("motionQueueLength", 1) != 0:
        reasons.append(f"아직 움직이는 중입니다 — 멈추면 다시 누르세요 "
                       f"(모션 큐 {state.get('motionQueueLength')} · 조건 6)")
    if not state.get("enabled"):
        reasons.append("서보 OFF (arm 이 안 됐다)")
    if state.get("mode") != 0:
        reasons.append(f"auto 모드가 아니다 — mode={state.get('mode')}")

    joints = state.get("jointsDeg") or []
    # 현재값이 유한한 숫자가 아니면 delta 비교가 NaN 으로 조용히 통과한다 — 명시적으로 차단
    if len(joints) != 6 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in joints):
        reasons.append("현재 관절값이 비정상 (NaN/결측) — fail-closed")

    # 조건 8 대안(#9) — **우리가 보낸** 지령과 실측의 괴리 (계약 §드리프트 기준).
    # 컨트롤러의 `lastServoTarget` 을 쓰면 안 된다 — ServoJ 전용이라 우리 MoveJ 로는 영영
    # 0 이고(검사가 안 돎), 티치모드가 채우면 사람이 팔을 옮긴 것을 추종 실패로 오인해
    # 우리 명령으로 못 푸는 잠금이 된다 (2026-08-06 실기 31.52°).
    # `commanded_deg` 가 None 이면 아직 아무것도 안 보냈거나 티칭으로 기준을 비운 것이다.
    if commanded_deg and len(commanded_deg) == 6 and len(joints) == 6 \
            and all(isinstance(v, (int, float)) and math.isfinite(v) for v in commanded_deg):
        drift = max(abs(a - b) for a, b in zip(commanded_deg, joints))
        if drift > DRIFT_CAP_DEG:
            reasons.append(f"아직 목표에 도착하지 않았습니다 — 도착하면 다시 누르세요 "
                           f"(지령·실측 괴리 {drift:.2f}° > {DRIFT_CAP_DEG}° · 조건 8 대안)")

    # 상한·한계 (조건 12 + §상한)
    if not isinstance(speed_pct, (int, float)) or speed_pct != speed_pct or not (0 < speed_pct <= SPEED_CAP_PCT):
        reasons.append(f"속도 상한 초과 또는 비정상 — {speed_pct} (상한 {SPEED_CAP_PCT:.0f}%)")
    if not isinstance(target_deg, list) or len(target_deg) != 6 \
            or not all(isinstance(v, (int, float)) and v == v for v in target_deg):
        reasons.append("목표 관절이 6축 숫자가 아니다")
    else:
        if len(joints) == 6 and delta_cap is not None:
            delta = max(abs(t - c) for t, c in zip(target_deg, joints))
            if delta > delta_cap + JOINT_DELTA_EPS_DEG:
                reasons.append(f"관절 변화 {delta:.4f}° > 상한 {delta_cap}° — 거부")
        for i, (t, (lo, hi)) in enumerate(zip(target_deg, JOINT_LIMITS_DEG)):
            if not (lo <= t <= hi):
                reasons.append(f"j{i + 1} 목표 {t:.2f}° 가 URDF 한계 [{lo}, {hi}] 밖 (조건 12)")
    return reasons


def check_gripper(state, state_age_s, pct, applied_settings=None, amr_status=None):
    """그리퍼 전용 게이트 (API-CONTRACT §그리퍼). 관절이 아니다 —
    5°·URDF 한계·모션큐·auto 모드는 **걸지 않는다.** 그대로 복붙하면 통과할 수 없거나
    엉뚱한 값으로 판정한다 (감사 P1). 반환: 사유 목록, 비면 허용."""
    reasons = _common_safety(state, state_age_s, applied_settings, amr_status)
    if state is None:
        return reasons

    if not state.get("enabled"):
        reasons.append("서보 OFF (arm 이 안 됐다)")

    grip = state.get("gripper")
    if not isinstance(grip, dict):
        return reasons + ["그리퍼 상태를 못 읽었다 — fail-closed (제1원칙)"]
    for f in ("fault", "active"):
        if grip.get(f) is None:
            reasons.append(f"그리퍼 필드 결측 — gripper.{f} (제1원칙: 결측=차단)")
    if grip.get("fault"):
        reasons.append("그리퍼 고장 신호 (gripper.fault)")
    if grip.get("active") is False:
        reasons.append("그리퍼가 활성화되지 않았다 — 먼저 활성화한다 (ActGripper)")

    if not isinstance(pct, (int, float)) or isinstance(pct, bool) \
            or not math.isfinite(pct) or not 0 <= pct <= 100:
        reasons.append(f"그리퍼 pct 가 0~100 숫자가 아니다 — {pct}")
    return reasons


def check_arm(state, state_age_s):
    """ARMED 승격 게이트 — 서보를 올리기 전의 최소 확인. 반환: 사유 목록."""
    reasons = []
    if state is None:
        return ["상태를 읽지 못했다 — fail-closed"]
    if state_age_s > STATE_FRESH_S:
        reasons.append(f"상태가 낡았다 — {state_age_s:.2f}s")
    safety = state.get("safety") or {}
    for f in REQUIRED_FOR_MOTION:
        if f not in safety:
            reasons.append(f"안전 필드 결측 — safety.{f}")
    if safety.get("emergencyStop"):
        reasons.append("비상정지 작동 중")
    if safety.get("safetyStop"):
        reasons.append("안전정지 신호")
    if safety.get("mainErrorCode") or safety.get("subErrorCode"):
        reasons.append(f"컨트롤러 오류 {safety.get('mainErrorCode')}/{safety.get('subErrorCode')}")
    if safety.get("collisionDetected"):
        reasons.append("충돌 감지 상태")
    # ARM 은 마지막에 ExitDragTeach + SetMode(0) 을 부른다 — 사람이 팔을 잡고 있는 동안
    # 부르면 손 안에서 팔이 굳는다 (조건 25). 사람이 손을 떼고 펜던트에서 끄면 풀린다.
    if safety.get("inDragTeach"):
        reasons.append("드래그 티칭 중 — 사람이 팔을 잡고 있다 (조건 25)")
    return reasons


def check_workspace(tcp_mm, ws, coord=None, joints_deg=None, coord_defs=None):
    """작업영역 게이트 — **조건 12 의 카테시안 절반**. 관절 한계만으로는 손끝이 작업대를
    뚫는 것을 못 막는다 (`SAFETY-RULES.md` §FR-HMI — 위치 방어선은 우리 소프트리밋뿐이다).

    실측 근거는 `docs/evidence/2026-08-05/workcell-measure.md` — 로봇이 직접 짚은 5점이다.
    **ws 가 없으면 판정하지 않는다** (mock·미측정 프로필). 그 사실은 `/state.workspace`
    가 노출하므로 조용히 사라지지는 않는다.

    **손끝 한 점과 툴 전체를 둘 다 본다** (`SAFETY-RULES.md` §작업영역은 손끝 한 점이 아니라).
    툴 판정은 손끝 판정의 상위집합이라 손끝 규칙을 지우지 않는다 — 지우면 사본과의 대조가
    통째로 갈린다. 천장 셋(팔은 안 봄 · 꼭짓점만 · 손가락 고정)은 계약에 적혀 있다."""
    if not ws:
        return []
    if not isinstance(tcp_mm, (list, tuple)) or len(tcp_mm) < 3 or not all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
            for v in tcp_mm[:3]):
        return ["손끝 위치를 못 구했다 — 작업영역을 판정할 수 없다 (제1원칙: 결측=차단)"]
    reasons = []
    # 값은 잰 좌표계에서만 참이다. 툴·사용자가 바뀌면 같은 숫자가 다른 자리를 가리킨다
    want = ws.get("frame") or {}
    have = coord or {}
    if want and have and (want.get("toolId") != have.get("toolId")
                          or want.get("userId") != have.get("userId")):
        reasons.append(
            f"좌표계가 잴 때와 다르다 — 잰 것 tool{want.get('toolId')}/user{want.get('userId')}, "
            f"지금 tool{have.get('toolId')}/user{have.get('userId')} (작업영역 값이 거짓이 된다)")
    x, y, z = float(tcp_mm[0]), float(tcp_mm[1]), float(tcp_mm[2])

    # 상판 — **평면이 아니라 사각 기둥이다.** x·y 가 안일 때만 높이를 건다
    for b in ws.get("boxes") or []:
        bx, by = b["xMm"], b["yMm"]
        floor = b["topZMm"] + b.get("marginMm", 0)
        if bx[0] <= x <= bx[1] and by[0] <= y <= by[1] and z < floor:
            name = b.get("name", "상판")
            reasons.append(f"{name}{_eul(name)} 뚫는다 — 손끝 z {z:.1f} < {floor:.1f} (조건 12)")

    # 벽 — **선분까지의 거리다.** 숫자 하나(무한 평면)로는 비스듬한 벽도 788mm 짜리
    # 유한한 판도 못 담았고, 카트를 돌리자 그 값이 통째로 거짓이 됐다 (2026-08-08)
    for w in ws.get("walls") or []:
        hit = _wall_hit(x, y, w.get("aMm"), w.get("bMm"), w.get("marginMm", 0))
        if hit is None:
            reasons.append(f"{w.get('name', '벽')} 값이 선분이 아니다 — 판정할 수 없다 (결측=차단)")
        elif hit[0]:
            # **낡은 값도 막는다.** 엉뚱한 자리를 막을지언정 아무것도 안 막는 것보다 낫다 —
            # 다만 사람에게는 그 사실을 말한다. 안 그러면 없는 벽 앞에서 이유를 못 찾는다
            stale = w.get("staleReason")
            reasons.append(f"{w.get('name', '벽')}에 {hit[1]} — 손끝까지 {hit[2]:.0f}mm "
                           f"(여유 {w.get('marginMm', 0)}mm · 조건 12)"
                           + (f" ⚠ 이 벽 값은 낡았다 — {stale}" if stale else ""))

    reasons.extend(_check_tool(tcp_mm, ws))
    reasons.extend(_check_arm_links(joints_deg, coord_defs, ws))
    return reasons


# ── 툴 전체 판정 (조건 12 · `SAFETY-RULES.md` §작업영역은 손끝 한 점이 아니라) ──────────
# 손끝은 통과인데 그리퍼·카메라가 구역 안인 자세가 무작위 4000개 중 **425개(10.6%)** 였다.
# 툴은 플랜지에 고정이라 **TCP 좌표계에서 형상이 상수**이고, 컨트롤러가 `tcpMmDeg` 로
# 위치와 방향을 이미 주므로 기구학 라이브러리가 필요 없다 — 상수점을 회전시켜 옮기면 끝이다.

def _load_tool_corners():
    """`tool-hull.json` → TCP 좌표계 꼭짓점 `[(부위이름, x, y, z), …]`.

    **형상을 여기에 적지 않는다.** 정본은 생성물이고 시뮬 사본도 같은 파일을 읽는다
    (`Sim/scene/build-scene.mjs`). 각각 적으면 한쪽이 낡고, 그 순간 시뮬이 초록인 것을
    실기가 거부한다. 파일이 낡았는지는 `node scripts/build/tool-hull.mjs --check` 가 잰다.
    """
    path = (pathlib.Path(__file__).resolve().parents[2]
            / "Shared/data/config/tool-hull.json")
    try:
        hull = json.loads(path.read_text(encoding="utf-8"))
        out = []
        for b in hull["boxes"]:
            c, h = b["centerMm"], b["halfMm"]
            if len(c) != 3 or len(h) != 3:
                raise ValueError(f"상자 {b.get('name')} 의 값이 셋이 아니다")
            for sx in (-1, 1):
                for sy in (-1, 1):
                    for sz in (-1, 1):
                        out.append((b["name"], c[0] + sx * h[0],
                                    c[1] + sy * h[1], c[2] + sz * h[2]))
        if not out:
            raise ValueError("상자가 0개다")
        return out
    except Exception as e:                                   # noqa: BLE001 — 이유를 들고 차단한다
        return e


TOOL_CORNERS_MM = _load_tool_corners()


def _rot_fixed_xyz(rx_deg, ry_deg, rz_deg):
    """고정축 XYZ(RPY) 회전행렬 — `R = Rz·Ry·Rx`.

    **규약을 추측하지 않았다.** 실기 4자세로 12개 후보를 가려 확정했고, 이것만 잔차
    0.0048° 였다 (2등 32.96°) — `docs/evidence/2026-08-11/tcp-euler-convention.md`.
    """
    cx, sx = math.cos(math.radians(rx_deg)), math.sin(math.radians(rx_deg))
    cy, sy = math.cos(math.radians(ry_deg)), math.sin(math.radians(ry_deg))
    cz, sz = math.cos(math.radians(rz_deg)), math.sin(math.radians(rz_deg))
    return ((cz * cy, cz * sy * sx - sz * cx, sz * sx + cz * sy * cx),
            (sz * cy, cz * cx + sz * sy * sx, sz * sy * cx - cz * sx),
            (-sy,     cy * sx,                cy * cx))


# ── 팔 링크 (조건 12 · 아직 판정에 안 쓴다 — 검증 먼저) ────────────────────────
# 손끝·툴을 봐도 **팔은 아직 판정 밖**이다. 2026-08-11 실측: 무작위 4000자세 중
# **720개(18.0%)** 가 게이트는 통과인데 팔 링크가 구역을 **실제로 관통**했다.
# 여유 침범이 아니라 관통이라 툴(10.6%)보다 심한 조건이다.
#
# **Pinocchio 를 안 들인다** — 브리지는 순수 표준 라이브러리이고(requirements.txt 조차 없다),
# FR5 는 관절 여섯이 전부 로컬 Z 회전인 직렬 사슬이라 FK 가 짧다. 대신 **손으로 짠 것을
# 믿지 않는다**: `scripts/check/arm-fk.sh` 가 무조코와 자세 2000개로 대조한다.

def _load_arm_hull():
    """`arm-hull.json` → 체인과 링크 상자. 못 읽으면 `Error` 를 값으로 들고 있는다."""
    path = (pathlib.Path(__file__).resolve().parents[2]
            / "Shared/data/config/arm-hull.json")
    try:
        h = json.loads(path.read_text(encoding="utf-8"))
        if len(h["chain"]) != 6:
            raise ValueError(f"관절이 6개가 아니다: {len(h['chain'])}")
        return h
    except Exception as e:                                   # noqa: BLE001 — 이유를 들고 차단한다
        return e


ARM_HULL = _load_arm_hull()


def _matmul(a, b):
    return tuple(tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3))
                 for i in range(3))


def _apply(r, p):
    return [r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
            r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
            r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2]]


def link_poses_mm(joints_deg, hull=None):
    """관절각(도) → `{링크이름: (회전 3x3, 위치 mm)}`. **base_link 기준**이다.

    `T_child = T_parent · Trans(xyz) · R_rpy · Rz(axisSign·q)` —
    URDF 의 rpy 는 고정축 XYZ 라 `_rot_fixed_xyz` 를 그대로 쓴다 (툴과 같은 규약).
    """
    h = ARM_HULL if hull is None else hull
    if isinstance(h, Exception):
        return h
    if not isinstance(joints_deg, (list, tuple)) or len(joints_deg) < 6 or not all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
            for v in joints_deg[:6]):
        return ValueError("관절각을 못 구했다")
    eye = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    out = {h["baseLink"]: (eye, [0.0, 0.0, 0.0])}
    for i, j in enumerate(h["chain"]):
        pr, pp = out[j["parent"]]
        rr = _rot_fixed_xyz(*j["rpyDeg"])
        q = float(joints_deg[i]) * j["axisSign"]
        c, s = math.cos(math.radians(q)), math.sin(math.radians(q))
        rz = ((c, -s, 0.0), (s, c, 0.0), (0.0, 0.0, 1.0))
        r = _matmul(pr, _matmul(rr, rz))
        moved = _apply(pr, j["xyzMm"])
        out[j["child"]] = (r, [pp[k] + moved[k] for k in range(3)])
    return out


# **`base_link` 는 판정하지 않는다.** 로봇은 카트 상판에 볼트로 앉아 있어서 베이스 상자는
# 언제나 카트 구역 안이다 — 2026-08-11 실측 무작위 2000자세에서 **100%**. 명령으로 움직일 수
# 없는 것을 막으면 모든 이동이 영구 거부된다. `shoulder_link` 는 같은 표본에서 0% 라 남긴다.
ARM_SKIP_LINKS = ("base_link",)


def _check_arm_links(joints_deg, coord_defs, ws):
    """팔 링크 상자를 구역에 댄다. **구역 하나당 사유 한 줄** — 링크 6개 × 꼭짓점 8개가
    같은 상판에 걸리면 48줄이 나와 사람이 못 읽는다. 제일 깊이 들어간 것만 말한다."""
    if isinstance(ARM_HULL, Exception):
        return [f"팔 형상을 못 읽었다 — 작업영역을 판정할 수 없다 ({ARM_HULL}) "
                f"(제1원칙: 결측=차단 · node scripts/build/arm-hull.mjs)"]
    # 구역은 user1 좌표계, FK 는 베이스 기준이다. 원점을 모르면 **725mm 어긋난 자리**를
    # 판정하게 된다 (2026-08-11 시뮬이 정확히 그 사고를 냈다) — 모르면 막는다.
    user = (coord_defs or {}).get("user")
    if not isinstance(user, (list, tuple)) or len(user) < 3 or not all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
            for v in user[:3]):
        return ["유저 좌표계 원점을 모른다 — 팔이 어느 자리에 있는지 못 옮긴다 "
                "(제1원칙: 결측=차단 · 조건 12 · 팔)"]
    poses = link_poses_mm(joints_deg)
    if isinstance(poses, Exception):
        return ["관절각을 못 구했다 — 팔이 어디 있는지 알 수 없다 "
                "(제1원칙: 결측=차단 · 조건 12 · 팔)"]
    # ⚠ 회전은 안 옮긴다 — `coordDefs.user` 의 회전이 0.005° 라 위치 변환과 같은 가정
    #    (평행이동만)을 쓴다. 화면·시뮬도 같은 가정이다. 유저 좌표계를 기울여 잡는 날 거짓이 된다.
    ux, uy, uz = float(user[0]), float(user[1]), float(user[2])

    pts = []
    for link in ARM_HULL["links"]:
        name = link["name"]
        if name in ARM_SKIP_LINKS or "halfMm" not in link:
            continue
        pose = poses.get(name)
        if pose is None:
            return [f"링크 {name} 의 자세를 못 구했다 (제1원칙: 결측=차단 · 조건 12 · 팔)"]
        r, p = pose
        c, h = link["centerMm"], link["halfMm"]
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    w = _apply(r, [c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]])
                    pts.append((name, p[0] + w[0] - ux, p[1] + w[1] - uy, p[2] + w[2] - uz))

    reasons = []
    for b in ws.get("boxes") or []:
        bx, by = b["xMm"], b["yMm"]
        floor = b["topZMm"] + b.get("marginMm", 0)
        worst = None
        for link, x, y, z in pts:
            if bx[0] <= x <= bx[1] and by[0] <= y <= by[1] and z < floor:
                if worst is None or z < worst[1]:
                    worst = (link, z)
        if worst:
            name = b.get("name", "상판")
            reasons.append(f"{name}{_eul(name)} 뚫는다 — {worst[0]} z {worst[1]:.1f} "
                           f"< {floor:.1f} (조건 12 · 팔)")

    for w in ws.get("walls") or []:
        # 벽 값이 망가진 것은 **손끝 판정이 이미 말했다** — 여기서 또 말하면 줄이 는다
        worst = None
        for link, x, y, _z in pts:
            hit = _wall_hit(x, y, w.get("aMm"), w.get("bMm"), w.get("marginMm", 0))
            if hit is not None and hit[0] and (worst is None or hit[2] < worst[2]):
                worst = (link, hit[1], hit[2])
        if worst:
            stale = w.get("staleReason")
            reasons.append(f"{w.get('name', '벽')}에 {worst[1]} — {worst[0]}까지 {worst[2]:.0f}mm "
                           f"(여유 {w.get('marginMm', 0)}mm · 조건 12 · 팔)"
                           + (f" ⚠ 이 벽 값은 낡았다 — {stale}" if stale else ""))
    return reasons


def _check_tool(tcp_mm, ws):
    """툴 꼭짓점 전부를 구역에 댄다. **구역 하나당 사유 한 줄** — 40점이 같은 벽에 걸리면
    40줄이 나와 사람이 못 읽는다. 제일 깊이 들어간 점만 말한다."""
    if isinstance(TOOL_CORNERS_MM, Exception):
        return [f"툴 형상을 못 읽었다 — 작업영역을 판정할 수 없다 ({TOOL_CORNERS_MM}) "
                f"(제1원칙: 결측=차단 · node scripts/build/tool-hull.mjs)"]
    # 방향이 없으면 툴이 어디를 향하는지 모른다 — 통과시킬 근거가 없다.
    # 실기 어댑터의 `forward_kin` 은 6개를 주거나 `None` 을 주므로 이 분기는 안 걸린다.
    if len(tcp_mm) < 6 or not all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
            for v in tcp_mm[3:6]):
        return ["손끝 방향(rx·ry·rz)이 없다 — 툴이 어디를 향하는지 모른다 "
                "(제1원칙: 결측=차단 · 조건 12 · 툴)"]

    r = _rot_fixed_xyz(float(tcp_mm[3]), float(tcp_mm[4]), float(tcp_mm[5]))
    ox, oy, oz = float(tcp_mm[0]), float(tcp_mm[1]), float(tcp_mm[2])
    pts = [(part,
            ox + r[0][0] * px + r[0][1] * py + r[0][2] * pz,
            oy + r[1][0] * px + r[1][1] * py + r[1][2] * pz,
            oz + r[2][0] * px + r[2][1] * py + r[2][2] * pz)
           for part, px, py, pz in TOOL_CORNERS_MM]

    reasons = []
    for b in ws.get("boxes") or []:
        bx, by = b["xMm"], b["yMm"]
        floor = b["topZMm"] + b.get("marginMm", 0)
        worst = None
        for part, x, y, z in pts:
            if bx[0] <= x <= bx[1] and by[0] <= y <= by[1] and z < floor:
                if worst is None or z < worst[1]:
                    worst = (part, z)
        if worst:
            name = b.get("name", "상판")
            reasons.append(f"{name}{_eul(name)} 뚫는다 — {worst[0]} z {worst[1]:.1f} "
                           f"< {floor:.1f} (조건 12 · 툴)")

    for w in ws.get("walls") or []:
        # 벽 값이 망가진 것은 **손끝 판정이 이미 말했다** — 여기서 또 말하면 두 줄이 된다
        worst = None
        for part, x, y, _z in pts:
            hit = _wall_hit(x, y, w.get("aMm"), w.get("bMm"), w.get("marginMm", 0))
            if hit is not None and hit[0] and (worst is None or hit[2] < worst[2]):
                worst = (part, hit[1], hit[2])
        if worst:
            stale = w.get("staleReason")
            reasons.append(f"{w.get('name', '벽')}에 {worst[1]} — {worst[0]}까지 {worst[2]:.0f}mm "
                           f"(여유 {w.get('marginMm', 0)}mm · 조건 12 · 툴)"
                           + (f" ⚠ 이 벽 값은 낡았다 — {stale}" if stale else ""))
    return reasons


def _eul(word):
    """`을`/`를` — 이름이 값에서 오므로 조사를 박아 둘 수 없다 (`작업대을 뚫는다` 가 났다).

    한글 음절은 `(코드 − 0xAC00) % 28` 이 0 이 아니면 받침이 있다. 한글이 아니면 `을`.
    """
    if not word:
        return "을"
    ch = word[-1]
    if "가" <= ch <= "힣":
        return "을" if (ord(ch) - 0xAC00) % 28 else "를"
    return "을"


def _wall_hit(x, y, a, b, margin):
    """벽 선분 a—b 에 대해 손끝 (x,y) 가 막히나. 반환 `(막힘, 사유말, 거리mm)` · 값이 이상하면 None.

    **벽은 가까이 가도 안 되고 넘어가도 안 된다.** 거리만 재면 여유 밖으로 **관통**해서
    반대편에 서는 것이 통과된다 — 옛 무한 평면 판정에는 없던 구멍이다.

    안전한 쪽은 **로봇 밑동(원점)이 있는 쪽**이다. 로봇이 자기 발밑 반대편으로 손을
    넘긴다는 것은 벽을 뚫었다는 뜻이다. 넘어감은 **선분 구간 안에서만** 본다 — 그래야
    788mm 짜리 판 **옆으로** 돌아가는 정상 동작이 안 막힌다.
    """
    try:
        ax, ay, bx, by = float(a[0]), float(a[1]), float(b[0]), float(b[1])
    except (TypeError, ValueError, IndexError):
        return None
    if not all(math.isfinite(v) for v in (ax, ay, bx, by, float(margin))):
        return None
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 <= 0:                      # 두 끝점이 같다 — 선분이 아니다
        return None
    t = ((x - ax) * dx + (y - ay) * dy) / L2
    tc = max(0.0, min(1.0, t))
    dist = math.hypot(x - (ax + tc * dx), y - (ay + tc * dy))
    if dist < margin:
        return (True, "너무 가깝다", dist)
    # 관통 — 원점과 반대쪽이고 선분 구간 안이면 벽을 지난 것이다
    side = (x - ax) * dy - (y - ay) * dx
    origin_side = (0 - ax) * dy - (0 - ay) * dx
    if 0.0 <= t <= 1.0 and side * origin_side < 0:
        return (True, "**뚫고 반대편에 있다**", dist)
    return (False, "", dist)


# ⚠ **하한이 1 이 아니라 10 인 이유 — 내리는 쪽이 위험하다** (2026-08-12 · 설계 정정).
# 0 은 이동을 전부 막지만(`code=172`), **1~9 는 더 나쁘다**: 이동이 되면서 **몇 배 느려지는데
# 우리 대기 계산은 그대로**라 응답이 「도착」인데 로봇은 아직 간다 → 겹침(D89 가 막으려던 사고).
# 처음에 `1` 로 열었다가 「누르면 겹침을 만드는 버튼」이 된다는 것을 깨닫고 올렸다.
SPEED_OVERRIDE_MIN_PCT = 10
SPEED_OVERRIDE_CAP_PCT = 30    # 그 이상은 펜던트에서 사람이 — `vel` 상한 10% 에 곱해지는 배수다


def check_speed_override(state, state_age_s, pct):
    """전역 속도 오버라이드 게이트 (계약 §speed). **로봇을 움직이지 않는다 — 배수만 바꾼다.**

    그래서 `check_mode` 와 같은 얕은 게이트다: 값 범위 · 상태 신선도 · 비상정지만 본다.
    `ARMED` 를 요구하지 않는다 — 배수는 ARM **전에** 정하는 것이 자연스럽다.

    ⛔ **하한 1 을 강제하는 이유** — `0` 이면 외부 `MoveJ` 가 전부 `code=172`
    ("Motion Speed Cannot Be 0")로 거부된다. 2026-08-12 에 그 값이 0 인 채로 반나절을
    태웠고, 화면에서 0 을 보낼 수 있게 두면 **우리가 그 사고를 재현할 수 있다.**
    """
    reasons = []
    if isinstance(pct, bool) or not isinstance(pct, int):
        reasons.append(f"pct 가 정수가 아니다 — {pct!r}")
    elif not SPEED_OVERRIDE_MIN_PCT <= pct <= SPEED_OVERRIDE_CAP_PCT:
        reasons.append(f"전역 속도 {pct} 는 허용 범위 밖이다 "
                       f"({SPEED_OVERRIDE_MIN_PCT}~{SPEED_OVERRIDE_CAP_PCT}) — "
                       f"0 은 이동을 전부 막고, 상한 위는 펜던트에서 사람이 올린다")
    if state is None:
        return reasons + ["상태를 읽지 못했다 — fail-closed (조건 17)"]
    if state_age_s > STATE_FRESH_S:
        reasons.append(f"상태가 낡았다 — {state_age_s:.2f}s > {STATE_FRESH_S}s (조건 10)")
    if (state.get("safety") or {}).get("emergencyStop"):
        reasons.append("비상정지 작동 중 (조건 1)")
    return reasons


def check_mode(state, state_age_s, manual):
    """모드 전환 게이트 (계약 §모드 전환). **로봇을 움직이지 않는다** — 권한만 넘긴다.
    그래서 안전 설정 적용 기록(조건 26)·충돌 감지는 걸지 않는다. 움직임의 전제가 아니다.

    **ARMED 에서도 허용한다.** 드래그 티칭은 서보가 켜져 있어야 되므로, ARM 을 풀게
    만들면 잠긴 상태를 풀 수 없다 (2026-08-05). 하드 룰 4 는 이 전환을 막아서가 아니라
    `check_motion` 의 `mode != 0` 이 우리 조그·moveJ 를 거부해서 지켜진다."""
    reasons = []
    if not isinstance(manual, bool):
        reasons.append(f"manual 이 true/false 가 아니다 — {manual}")
    if state is None:
        return reasons + ["상태를 읽지 못했다 — fail-closed (조건 17)"]
    if state_age_s > STATE_FRESH_S:
        reasons.append(f"상태가 낡았다 — {state_age_s:.2f}s > {STATE_FRESH_S}s (조건 10)")
    safety = state.get("safety") or {}
    if safety.get("emergencyStop"):
        reasons.append("비상정지 작동 중 (조건 1)")
    if state.get("motionQueueLength", 1) != 0:
        reasons.append(f"모션 큐가 비어있지 않다 — {state.get('motionQueueLength')} (조건 6)")
    return reasons
