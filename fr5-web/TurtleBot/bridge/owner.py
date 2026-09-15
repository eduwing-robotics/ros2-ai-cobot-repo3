# 조종권 — 로봇별 독립, 명령 주인은 한 명 (TB-CONTRACT §조종권).
# 신원 증명은 하지 않는다(LAN·팀 신뢰 전제). hello 세션이 끊기면 10초 후 자동 해제.
import threading
import time

AUTO_RELEASE_S = 10.0


class OwnerRegistry:
    def __init__(self, robot_ids, on_change, on_log):
        self._owner = {rid: None for rid in robot_ids}
        self._sessions = {}                     # who -> 살아있는 세션 수
        self._disconnected_at = {}              # who -> 마지막 세션이 끊긴 시각
        self._lock = threading.Lock()
        self._on_change = on_change             # (robot, who|None) — 어댑터 상태 반영
        self._on_log = on_log
        threading.Thread(target=self._reaper, daemon=True).start()

    def claim(self, robot, who):
        with self._lock:
            cur = self._owner.get(robot)
            if cur and cur != who:
                return False, f"조종권은 {cur} 에게 있어요 (409)"
            self._owner[robot] = who
        self._on_change(robot, who)
        self._on_log(robot, "bridge", "info", f"owner claim — who={who}")
        return True, None

    def release(self, robot, who):
        with self._lock:
            if self._owner.get(robot) != who:
                return False, "owner 불일치 (409)"     # 타인 release 금지 — 감사 S1
            self._owner[robot] = None
        self._on_change(robot, None)
        self._on_log(robot, "bridge", "info", f"owner release — who={who}")
        return True, None

    def get(self, robot):
        with self._lock:
            return self._owner.get(robot)

    def is_owner(self, robot, who):
        with self._lock:
            return who is not None and self._owner.get(robot) == who

    # hello 세션 수명 — WS 접속/종료가 부른다
    def session_open(self, who):
        with self._lock:
            self._sessions[who] = self._sessions.get(who, 0) + 1
            self._disconnected_at.pop(who, None)

    def session_close(self, who):
        with self._lock:
            n = self._sessions.get(who, 1) - 1
            if n <= 0:
                self._sessions.pop(who, None)
                self._disconnected_at[who] = time.time()
            else:
                self._sessions[who] = n

    def _reaper(self):
        while True:
            time.sleep(1.0)
            with self._lock:
                gone = [w for w, at in self._disconnected_at.items() if time.time() - at > AUTO_RELEASE_S]
                to_release = []
                for who in gone:
                    self._disconnected_at.pop(who, None)
                    for robot, owner in self._owner.items():
                        if owner == who:
                            self._owner[robot] = None
                            to_release.append((robot, who))
            for robot, who in to_release:
                self._on_change(robot, None)
                self._on_log(robot, "bridge", "info", f"owner auto-release — {who} 세션 종료 10s")
