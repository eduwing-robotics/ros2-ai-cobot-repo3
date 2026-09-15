# 지오펜스 — 상판 낙하 방지 경계 (TB-CONTRACT §지오펜스가 정본).
# 순수 기하 + 설정 파싱만 한다. rclpy 도 FastAPI 도 모른다 — 그래서 로봇 없이 맥에서 전부 돈다.
#
# 왜 다각형 하나인가: 작업대가 ㄱ자라 사각형으로는 못 적는다. 볼록·오목을 한 코드로
# 판정한다 — 광선 교차(안팎) + 변까지 최단거리(여유). 사각형은 점 4개짜리 특수형이다.
# 왜 브리지인가: 버거는 클리프 센서가 없고 라이다 평면이 판 위 ~170mm 라 모서리를 못 본다.
# 로봇이 못 보는 것을 브리지가 대신 본다 (D134).
import math

POSE_MAX_AGE_S = 2.0        # 이보다 늙은 pose 로는 판정하지 않는다 — fail-closed (계약 §안전 규칙과 같은 값)

# TB-CONTRACT §tb3_2 실기 출발 프로필. 원점의 받침 합집합을 현장에서 확인한 뒤 승인된
# front430 전용 예외다. 일반 슬롯·텔레옵·회전에는 절대 열리지 않고, x>100mm 면 즉시 163mm로 돌아간다.
FRONT430_BASE_INSET_MM = 163.0
FRONT430_START_INSET_MM = 150.0
FRONT430_RESTORE_X_MM = 100.0
FRONT430_ORIGIN_TOL_MM = 30.0
FRONT430_HEADING_TOL_DEG = 3.0


class Geofence:
    """여유선 안인지 판정한다. 값은 전부 mm — 변환은 어댑터 경계에서 이미 끝났다."""

    def __init__(self, polygon, inset_mm, frame="odom"):
        self.polygon = polygon
        self.inset_mm = inset_mm
        self.frame = frame
        self.error = None

    def evaluate(self, pose, pose_age_sec, inset_mm=None):
        """상태 스냅샷의 geofence 값을 만든다 — { inside, marginMm, reason }."""
        if pose is None or pose_age_sec is None:
            return _blocked("pose 가 없어요 — fail-closed")
        if pose_age_sec > POSE_MAX_AGE_S:
            return _blocked(f"pose 가 {pose_age_sec:.1f}s 늙었어요 (상한 {POSE_MAX_AGE_S:.0f}s) — fail-closed")
        x, y = pose.get("xMm"), pose.get("yMm")
        if not _finite(x) or not _finite(y):
            return _blocked("pose 값이 숫자가 아니에요 — fail-closed")

        edge = _distance_to_boundary(x, y, self.polygon)
        signed = edge if _point_inside(x, y, self.polygon) else -edge
        inset = self.inset_mm if inset_mm is None else float(inset_mm)
        margin = signed - inset
        if margin >= 0:
            return {"inside": True, "marginMm": round(margin, 1), "reason": None}
        # 밖이면 얼마나 밖인지를 숫자로 말한다 — "막혔다" 만으로는 들어야 하는지 판단이 안 선다
        where = "판 밖" if signed < 0 else "여유선 안쪽 띠"
        return {
            "inside": False,
            "marginMm": round(margin, 1),
            "reason": f"{where} — 가장자리까지 {signed:.0f}mm · 여유선 {inset:.0f}mm",
        }


class BrokenGeofence:
    """설정이 깨진 로봇 — 영구 거부. 브리지는 뜬다 (안 뜨면 estop 도 못 보낸다)."""

    def __init__(self, error):
        self.error = error
        self.polygon = []
        self.inset_mm = 0.0
        self.frame = None

    def evaluate(self, pose, pose_age_sec):
        return _blocked(f"지오펜스 설정이 깨졌어요 — {self.error}")


def parse(raw):
    """config.yaml 의 robots[].geofence 하나를 읽는다. 없으면 None(판정 안 함),
    깨졌으면 BrokenGeofence(영구 거부) — 조용히 통과시키지 않는다."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return BrokenGeofence("geofence 는 매핑이어야 해요")
    inset = raw.get("inset_mm")
    if not _finite(inset) or inset < 0:
        return BrokenGeofence("inset_mm 이 0 이상의 숫자가 아니에요")
    pts = raw.get("polygon_mm")
    if not isinstance(pts, (list, tuple)) or len(pts) < 3:
        return BrokenGeofence("polygon_mm 은 점 3개 이상이어야 해요")
    poly = []
    for p in pts:
        if not isinstance(p, (list, tuple)) or len(p) != 2 or not all(_finite(v) for v in p):
            return BrokenGeofence("polygon_mm 의 점은 [xMm, yMm] 숫자 두 개예요")
        poly.append((float(p[0]), float(p[1])))
    if abs(_area2(poly)) < 1.0:                  # 넓이 0.5mm² 미만 = 한 줄로 눌린 다각형
        return BrokenGeofence("polygon_mm 의 넓이가 0 이에요 (한 줄로 눌렸어요)")
    return Geofence(poly, float(inset), raw.get("frame") or "odom")


def blocks_motion(fence, state, linear_mm_s, angular_deg_s):
    """이동 명령을 막을 사유. 통과면 None.
    **정지는 언제나 통과한다** — 막으면 밖에 나간 로봇을 세울 수단이 사라진다 (계약)."""
    if fence is None:
        return None
    if not linear_mm_s and not angular_deg_s:
        return None
    if state and state.get("inside"):
        return None
    return (state or {}).get("reason") or "지오펜스 — 이동 거부"


def front430_start_inset(robot, slot_name, params, pose, configured_inset_mm):
    """승인된 tb3_2/front430 원점 직진 구간이면 150mm, 아니면 None.

    ponytail: 단일 촬영 경로 예외라 일반 정책 엔진을 만들지 않는다. 다른 경로가 필요해지면
    config 기반 예외 목록으로 승격한다.
    """
    if robot != "tb3_2" or slot_name != "run-path" or (params or {}).get("path") != "front430":
        return None
    if configured_inset_mm != FRONT430_BASE_INSET_MM or not isinstance(pose, dict):
        return None
    x, y, theta = pose.get("xMm"), pose.get("yMm"), pose.get("thetaDeg")
    if not all(_finite(v) for v in (x, y, theta)):
        return None
    heading = (theta + 540) % 360 - 180
    if not (-FRONT430_ORIGIN_TOL_MM <= x <= FRONT430_RESTORE_X_MM):
        return None
    if abs(y) > FRONT430_ORIGIN_TOL_MM or abs(heading) > FRONT430_HEADING_TOL_DEG:
        return None
    return FRONT430_START_INSET_MM


# ── 기하 (표준 알고리즘 · 의존성 0) ──────────────────────────────────────────
def _point_inside(x, y, poly):
    """광선 교차 — 오목 다각형에서도 성립한다."""
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xx = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xx:
                inside = not inside
    return inside


def _distance_to_boundary(x, y, poly):
    n = len(poly)
    return min(_seg_dist(x, y, poly[i], poly[(i + 1) % n]) for i in range(n))


def _seg_dist(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _area2(poly):
    s = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return s


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != math.inf


def _blocked(reason):
    return {"inside": False, "marginMm": None, "reason": reason}
