# 조종권 — 명령 주인은 한 명 (하드룰 4 · API-CONTRACT §조종권).
# **사람을 인증하지 않는다** (LAN·팀 신뢰 전제 · D41 유지) — 누구나 잡을 수 있다.
# 다만 **잡은 뒤에는 그 세션만** 명령한다: claim 이 1회용 토큰을 발급하고 명령이 그걸 싣는다.
# 이름만 쓰던 때는 조종권자 이름이 /state 로 방송되므로 남의 이름을 대면 통과했다 (D55).
# 보호는 인증이 아니라 조종권 1명 · 토큰 · 안전 게이트 · stop 상시가 맡는다.
import secrets
import threading
import time

AUTO_RELEASE_S = 10.0


class Owner:
    def __init__(self, on_lost, on_log):
        self._who = None
        self._token = None
        self._sessions = {}             # who -> 살아있는 WS 세션 수
        self._disconnected_at = {}
        self._lock = threading.Lock()
        self._on_lost = on_lost         # (who) — 조종권 소실 시 브리지가 disarm 한다
        self._on_log = on_log
        threading.Thread(target=self._reaper, daemon=True).start()

    def claim(self, who):
        """성공하면 (True, 토큰). 같은 사람이 다시 잡으면 **새 토큰**을 준다 — 옛 세션은 끊긴다."""
        if not who or not str(who).strip():   # 공백만 친 이름도 거부 — 안전 바 조종권 칸이 빈칸이 된다 (UX 감사 2026-09-05)
            return False, "이름이 없다"
        with self._lock:
            if self._who and self._who != who:
                return False, f"조종권은 {self._who} 에게 있다 (409)"
            self._who = who
            self._token = secrets.token_urlsafe(16)
            token = self._token
        self._on_log("owner-claim", who)
        return True, token

    def release(self, who, token=None):
        with self._lock:
            if self._who != who or not self._match(token):
                return False, "owner 불일치 (409)"
            self._who = None
            self._token = None
        self._on_log("owner-release", who)
        self._on_lost(who)
        return True, None

    def get(self):
        with self._lock:
            return self._who

    def _match(self, token):
        # 잠금 안에서만 부른다. 토큰이 없던 시절 세션은 없다 — claim 이 항상 발급한다
        return self._token is not None and token == self._token

    def is_owner(self, who, token=None):
        """이름 **과** 토큰이 둘 다 맞아야 조종권이다 (D55). 토큰 없이 부르면 거짓이다."""
        with self._lock:
            return who is not None and self._who == who and self._match(token)

    # WS 세션 수명 — hello/close 가 부른다. 마지막 세션이 끊기고 10초 지나면 자동 해제
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
            lost = None
            with self._lock:
                gone = [w for w, at in self._disconnected_at.items() if time.time() - at > AUTO_RELEASE_S]
                for who in gone:
                    self._disconnected_at.pop(who, None)
                    if self._who == who:
                        self._who = None
                        self._token = None
                        lost = who
            if lost:
                self._on_log("owner-auto-release", f"{lost} 세션 종료 {AUTO_RELEASE_S:.0f}s")
                self._on_lost(lost)
