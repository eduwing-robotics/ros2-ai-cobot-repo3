# 경로 슬롯 — 상판 움직임을 저장하고 다시 실행하는 형식 (TB-CONTRACT §경로 · D136).
# 저장 단위는 웨이포인트다. 시간-속도 녹음의 재생은 비채택 — 드리프트만큼 밀리고 그게 낙하다.
# 좌표는 판 좌표계로 적는다: odom 원점은 브링업마다 달라지고, 드리프트가 예산을 넘으면
# 글로벌캠 태그 보정으로 갈아탄다. 그때 저장한 경로가 살아남는 유일한 방법이 판 기준이다.
import json
import math
import threading
import time
from pathlib import Path

PATHS_DIR = Path(__file__).parent / "data" / "paths"
BODY_MAX = 64 * 1024
POSE_MAX_AGE_S = 2.0        # 지오펜스와 같은 값 (계약 §안전 규칙)
MIN_STEP_MM = 150.0        # from-run 솎아내기 — 1Hz 샘플을 그대로 두면 점이 수백 개다
ARRIVE_MM = 30.0           # 기본 도착 판정 (실행기가 쓴다)
ARRIVE_DEG = 10.0
DWELL_MAX_S = 60.0         # 그 점에서 멈춰 있는 시간 상한 — 무한 대기를 막는다


def validate(doc):
    """반환: (정규화된 문서, None) 또는 (None, 사유). 거부는 항상 사유를 낸다 (D114)."""
    if not isinstance(doc, dict):
        return None, "경로는 객체여야 해요"
    frame = doc.get("frame") or "table"
    if frame not in ("table", "odom"):
        return None, "frame 은 table 또는 odom 이에요"
    pts = doc.get("points")
    if not isinstance(pts, (list, tuple)) or not pts:
        return None, "points 가 비어 있어요"
    if len(pts) > 500:
        return None, "points 는 500개까지예요"
    out = []
    for i, p in enumerate(pts):
        if not isinstance(p, dict):
            return None, f"{i}번 점이 객체가 아니에요"
        x, y = p.get("xMm"), p.get("yMm")
        if not _finite(x) or not _finite(y):
            return None, f"{i}번 점의 xMm·yMm 이 숫자가 아니에요"
        th = p.get("thetaDeg")
        if th is not None and not _finite(th):
            return None, f"{i}번 점의 thetaDeg 가 숫자가 아니에요"
        dwell = p.get("dwellSec") or 0
        if not _finite(dwell) or dwell < 0 or dwell > DWELL_MAX_S:
            return None, f"{i}번 점의 dwellSec 은 0~{DWELL_MAX_S:.0f}초예요"
        out.append({
            "xMm": float(x), "yMm": float(y),
            "thetaDeg": None if th is None else float(th) % 360,
            "arriveMm": float(p.get("arriveMm") or ARRIVE_MM),
            "arriveDeg": float(p.get("arriveDeg") or ARRIVE_DEG),
            "dwellSec": float(dwell),
        })
    tto = doc.get("tableToOdom")
    if tto is not None:
        if not isinstance(tto, dict) or not all(_finite(tto.get(k)) for k in ("xMm", "yMm", "thetaDeg")):
            return None, "tableToOdom 은 { xMm, yMm, thetaDeg } 예요"
    return {"frame": frame, "tableToOdom": tto, "points": out,
            "createdFrom": str(doc.get("createdFrom") or "hand")}, None


def from_run(samples, frame="odom"):
    """run 궤적(1Hz · odom)을 경로로 승격한다. 가까운 점은 솎아낸다 —
    ⚠ frame 기본이 odom 인 것은 **판 좌표를 아직 안 쟀기 때문**이다. 재면 여기서 변환한다."""
    pts, last = [], None
    for s in samples:
        x, y = s.get("xMm"), s.get("yMm")
        if not _finite(x) or not _finite(y):
            continue
        if last is None or math.hypot(x - last[0], y - last[1]) >= MIN_STEP_MM:
            pts.append({"xMm": float(x), "yMm": float(y), "thetaDeg": None,
                        "arriveMm": ARRIVE_MM, "arriveDeg": ARRIVE_DEG, "dwellSec": 0.0})
            last = (x, y)
    if pts and samples:
        end = samples[-1]
        if _finite(end.get("thetaDeg")):
            pts[-1]["thetaDeg"] = float(end["thetaDeg"]) % 360   # 마지막만 방향을 지킨다
    return pts


def point_from_pose(pose, pose_age_sec):
    """지금 그 자세를 점 하나로. (점, None) 또는 (None, 사유).
    **방향을 항상 채운다** — 정차점은 「지나간 자리」가 아니라 「무엇을 보고 섰나」다.
    fail-closed: pose 가 없거나 늙었으면 굳히지 않는다 (틀린 자리를 영구히 박는 것보다 거부가 싸다)."""
    if not isinstance(pose, dict):
        return None, "pose 가 없어요"
    if pose_age_sec is None or pose_age_sec > POSE_MAX_AGE_S:
        return None, f"pose 가 늙었어요 (상한 {POSE_MAX_AGE_S:.0f}s) — 지금 자리로 찍을 수 없어요"
    x, y, th = pose.get("xMm"), pose.get("yMm"), pose.get("thetaDeg")
    if not all(_finite(v) for v in (x, y, th)):
        return None, "pose 값이 숫자가 아니에요"
    return {"xMm": float(x), "yMm": float(y), "thetaDeg": float(th) % 360,
            "arriveMm": ARRIVE_MM, "arriveDeg": ARRIVE_DEG, "dwellSec": 0.0}, None


class PathStore:
    def __init__(self):
        PATHS_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _file(self, name):
        return PATHS_DIR / f"{name}.json"

    def list(self):
        out = []
        for f in sorted(PATHS_DIR.glob("*.json")):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue                                   # 깨진 파일 하나가 목록을 통째로 죽이지 않는다
            out.append({"name": d.get("name", f.stem), "points": len(d.get("points") or []),
                        "frame": d.get("frame"), "savedAt": d.get("savedAt"),
                        "createdFrom": d.get("createdFrom")})
        return out

    def get(self, name):
        f = self._file(name)
        if not f.exists():
            return None
        return json.loads(f.read_text(encoding="utf-8"))

    def save(self, name, doc):
        doc = {"name": name, "savedAt": time.time(), **doc}
        with self._lock:
            self._file(name).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        return doc

    def append(self, name, point, frame="odom"):
        """없으면 만들고 있으면 뒤에 붙인다. 반환: (문서, None) 또는 (None, 사유)."""
        with self._lock:
            doc = self.get(name) or {"name": name, "frame": frame, "tableToOdom": None,
                                     "points": [], "createdFrom": "here"}
            if len(doc["points"]) >= 500:
                return None, "points 는 500개까지예요"
            doc["points"].append(point)
            doc["savedAt"] = time.time()
            self._file(name).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
            return doc, None

    def pop(self, name):
        """마지막 점 되돌리기 — 잘못 찍었을 때 처음부터 다시 하지 않게 한다."""
        with self._lock:
            doc = self.get(name)
            if not doc or not doc.get("points"):
                return None, "되돌릴 점이 없어요"
            doc["points"].pop()
            doc["savedAt"] = time.time()
            self._file(name).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
            return doc, None

    def delete(self, name):
        f = self._file(name)
        if not f.exists():
            return False
        f.unlink()
        return True


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != math.inf
