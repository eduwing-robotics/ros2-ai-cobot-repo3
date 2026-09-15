"""공동 시각화 고스트의 2초 임대 저장소 (API-CONTRACT §공동 시각화 고스트).

로봇 명령과 분리된 화면 전용 상태다. 메모리에만 살고 재시작 뒤 복구하지 않는다.
"""
import math
import threading
import time


TTL_S = 2.0
KINDS = {"preview", "replay", "simulation"}


class VisualGhostStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._publisher = None
        self._ghost = None

    def _expire(self, now):
        if self._ghost and self._ghost["expiresAt"] <= now:
            self._publisher = None
            self._ghost = None

    def snapshot(self, now=None):
        now = time.time() if now is None else now
        with self._lock:
            self._expire(now)
            return None if self._ghost is None else {**self._ghost, "jointsDeg": list(self._ghost["jointsDeg"])}

    def publish(self, publisher, msg, owner_ok, now=None):
        now = time.time() if now is None else now
        if not owner_ok:
            with self._lock:
                if self._publisher == publisher:
                    self._publisher = None
                    self._ghost = None
            return False, "현재 조종권과 게시자 증표가 맞지 않는다"

        joints = msg.get("jointsDeg")
        grip = msg.get("gripperPct")
        seq = msg.get("seq")
        if msg.get("type") != "ghost":
            return False, "모르는 시각화 메시지다"
        if not str(msg.get("robotId") or "").strip():
            return False, "robotId가 없다"
        if msg.get("kind") not in KINDS:
            return False, "kind는 preview·replay·simulation 중 하나여야 한다"
        if not isinstance(joints, list) or len(joints) != 6 \
                or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in joints):
            return False, "jointsDeg는 유한한 숫자 6개여야 한다"
        if grip is not None and (isinstance(grip, bool) or not isinstance(grip, (int, float))
                                 or not math.isfinite(grip) or not 0 <= grip <= 100):
            return False, "gripperPct는 null 또는 0~100이어야 한다"
        if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0:
            return False, "seq는 0 이상의 정수여야 한다"

        with self._lock:
            self._expire(now)
            if self._publisher is not None and self._publisher != publisher:
                return False, "다른 게시자가 공동 고스트를 게시 중이다"
            if self._publisher == publisher and self._ghost and seq <= self._ghost["seq"]:
                return False, "seq가 이전 값보다 커야 한다"
            self._publisher = publisher
            self._ghost = {
                "robotId": str(msg["robotId"]),
                "kind": msg["kind"],
                "jointsDeg": [float(v) for v in joints],
                "gripperPct": None if grip is None else float(grip),
                "seq": seq,
                "operator": str(msg.get("who") or ""),
                "publishedAt": now,
                "expiresAt": now + TTL_S,
            }
        return True, None

    def close(self, publisher):
        with self._lock:
            if self._publisher != publisher:
                return False
            self._publisher = None
            self._ghost = None
            return True
