# 안전 검사 — 서버가 강제한다, 클라이언트를 믿지 않는다 (TB-CONTRACT §안전 규칙).
# 상한은 절대값 기준. 초과는 자르지 않고 거부한다 — 잘라주면 클라이언트 버그가 숨는다.
NAME_RE = r"^[a-z0-9-_]+$"
LINEAR_CAP_MM_S = 150.0
ANGULAR_CAP_DEG_S = 60.0
TELEOP_WATCHDOG_S = 0.5
SIGTERM_GRACE_S = 5.0
PATCH_BODY_MAX = 64 * 1024
PARAMS_MAX = 4 * 1024


def check_teleop(linear, angular):
    """반환: 거부 사유 문자열, 통과면 None."""
    for v in (linear, angular):
        if not isinstance(v, (int, float)) or v != v:      # NaN 은 자기 자신과 다르다
            return "값이 숫자가 아니에요"
    if abs(linear) > LINEAR_CAP_MM_S or abs(angular) > ANGULAR_CAP_DEG_S:
        return f"상한 초과 (|{LINEAR_CAP_MM_S:.0f}|mm/s · |{ANGULAR_CAP_DEG_S:.0f}|°/s) — 거부"
    return None


def check_name(name):
    import re
    if not name or not re.match(NAME_RE, name):
        return "이름은 [a-z0-9-_] 만 — 경로 문자는 거부돼요"
    return None
