# 로그 스트림 — 최근 500줄 버퍼 + 구독 브로드캐스트 + 폭주 상한 (TB-CONTRACT §로그).
import collections
import threading
import time

BUFFER_MAX = 500
RATE_MAX_PER_S = 100        # 로봇·소스당


class LogStream:
    def __init__(self):
        self._buffer = collections.deque(maxlen=BUFFER_MAX)
        self._subs = set()          # asyncio.Queue 들
        self._lock = threading.Lock()
        self._rate = {}             # (robot, source) -> [윈도 시작, 개수]
        self._dropped = {}

    def emit(self, robot, source, level, line):
        now = time.time()
        key = (robot, source)
        with self._lock:
            win = self._rate.get(key)
            if not win or now - win[0] >= 1.0:
                if self._dropped.get(key):
                    self._push({"t": now, "robot": robot, "source": "bridge", "level": "warn",
                                "line": f"{source} dropped {self._dropped[key]}줄 (100줄/s 상한)"})
                    self._dropped[key] = 0
                self._rate[key] = [now, 0]
                win = self._rate[key]
            if win[1] >= RATE_MAX_PER_S:
                self._dropped[key] = self._dropped.get(key, 0) + 1
                return
            win[1] += 1
            self._push({"t": now, "robot": robot, "source": source, "level": level, "line": line})

    def _push(self, entry):
        self._buffer.append(entry)
        for q in list(self._subs):
            try:
                q.put_nowait(entry)
            except Exception:
                pass

    def subscribe(self, queue):
        with self._lock:
            for entry in self._buffer:      # 새 접속에 백로그 먼저 (§로그)
                queue.put_nowait(entry)
            self._subs.add(queue)

    def unsubscribe(self, queue):
        with self._lock:
            self._subs.discard(queue)
