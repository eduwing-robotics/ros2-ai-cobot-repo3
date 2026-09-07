#!/usr/bin/env python3
"""기록 노드 수집기 — 브리지 /ws/state 를 읽기 구독해 보존 게이트를 통과한 프레임만 SQLite 에 적는다.

표준 라이브러리만 (D81 — 새 의존성 0). 읽기 전용 — 명령을 안 보낸다 (계약: 구독만).
    python3 collector.py <db> <ws_url> [--seconds N] [--max N]
    예) python3 collector.py rec.db ws://192.168.30.240:5055/ws/state --seconds 10

한 수집기 = 한 브리지(= 한 로봇 스트림). FR5 와 TB 는 인스턴스를 따로 띄운다.
쓰는 주체는 이 프로세스 하나 (D81). 서빙(읽기)은 별도 — 이 파일은 수집만.
"""
import sqlite3, sys, os, json, time, socket, base64, struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from retention import should_store
import migrate


# ── 표준 라이브러리 WS 클라이언트 (읽기 전용 · 서버 프레임은 마스크 없음) ──
def ws_connect(url, timeout=6):
    assert url.startswith("ws://"), "ws:// 만 지원 (랩 안 평문)"
    host, _, rest = url[5:].partition("/")
    host, _, port = host.partition(":")
    port = int(port or 80)
    path = "/" + rest
    s = socket.create_connection((host, port), timeout=timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(1)
        if not c:
            raise RuntimeError("핸드셰이크 중 연결 끊김")
        buf += c
    if b"101" not in buf.split(b"\r\n", 1)[0]:
        raise RuntimeError("업그레이드 실패: " + buf.split(b"\r\n", 1)[0].decode("latin1"))
    return s


def _recvall(s, n):
    out = b""
    while len(out) < n:
        c = s.recv(n - len(out))
        if not c:
            raise RuntimeError("프레임 도중 연결 끊김")
        out += c
    return out


def ws_read_text(s):
    while True:
        b0, b1 = _recvall(s, 2)
        opcode, length = b0 & 0x0F, b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", _recvall(s, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", _recvall(s, 8))[0]
        payload = _recvall(s, length) if length else b""
        if opcode == 0x1:
            return payload.decode("utf-8", "replace")
        if opcode == 0x8:
            raise RuntimeError("서버 close 프레임")
        # ping/pong/continuation → 무시


def infer_kind(frame):
    if frame.get("jointsDeg") is not None:
        return "arm"
    if frame.get("pose"):
        return "amr"
    return "unknown"


class Collector:
    """프레임을 받아 보존 게이트를 적용하고 저장한다. WS 없이도 ingest() 를 테스트할 수 있다."""

    def __init__(self, db_path):
        migrate.migrate(db_path)                 # 스키마 보장
        self.db = sqlite3.connect(db_path)
        self.db.execute("PRAGMA foreign_keys=ON")   # 연결별이라 여기서 다시 켠다 (Phase1 이월)
        self.prev = None       # 마지막으로 **저장한** 프레임 (누적 드리프트 다운샘플)
        self.session_id = None
        self.cur_robot = None
        self.stored = 0
        self.skipped = 0

    def _upsert_robot(self, frame):
        rid = frame.get("robotId")
        if not rid:
            return None
        now = time.time()
        self.db.execute(
            "INSERT INTO robot(robot_id,kind,first_seen,last_seen,raw_json) VALUES(?,?,?,?,?) "
            "ON CONFLICT(robot_id) DO UPDATE SET last_seen=excluded.last_seen",
            (rid, infer_kind(frame), now, now, json.dumps(frame)))
        return rid

    def _track_session(self, frame, rid):
        connected = bool(frame.get("connected"))
        if connected and rid and self.session_id is None:
            cur = self.db.execute(
                "INSERT INTO session(robot_id,opened_at,owner) VALUES(?,?,?)",
                (rid, time.time(), frame.get("owner")))
            self.session_id = cur.lastrowid
            self.cur_robot = rid
        elif not connected and self.session_id is not None:
            self.db.execute("UPDATE session SET closed_at=?, end_phase=? WHERE id=?",
                            (time.time(), frame.get("phase"), self.session_id))
            self.session_id = None

    def ingest(self, frame):
        """(stored: bool, reason). robotId 없는(미연결) 스냅샷은 세션만 닫고 저장은 건너뛴다."""
        rid = self._upsert_robot(frame)
        self._track_session(frame, rid)
        if not rid:
            self.skipped += 1
            return False, "no-robot"
        keep, reason = should_store(self.prev, frame)
        if not keep:
            self.skipped += 1
            return False, reason
        g = frame.get("gripper") or {}
        self.db.execute(
            "INSERT INTO state_sample(robot_id,session_id,t,phase,connected,enabled,"
            "joints_json,tcp_json,pose_json,gripper_pct,safety_json,raw_json) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, self.session_id, frame.get("t"), frame.get("phase"),
             int(bool(frame.get("connected"))),
             1 if frame.get("enabled") else 0,
             json.dumps(frame.get("jointsDeg")) if frame.get("jointsDeg") is not None else None,
             json.dumps(frame.get("tcpMmDeg")) if frame.get("tcpMmDeg") is not None else None,
             json.dumps(frame.get("pose")) if frame.get("pose") else None,
             g.get("pct"), json.dumps(frame.get("safety")), json.dumps(frame)))
        self.prev = frame
        self.stored += 1
        return True, reason

    def run_ws(self, url, seconds=None, max_frames=None):
        s = ws_connect(url)
        end = time.time() + seconds if seconds else None
        n = 0
        try:
            while True:
                if end and time.time() >= end:
                    break
                if max_frames and n >= max_frames:
                    break
                raw = ws_read_text(s)      # 소켓 오류는 그대로 던진다 — 연결이 죽은 것
                try:
                    self.ingest(json.loads(raw))
                except Exception as e:
                    # 비정형 프레임 하나로 프로세스가 죽으면 이후 프레임 전부를 잃는다 (감사 2026-08-13)
                    self.skipped += 1
                    print(f"frame-skip: {e}", file=sys.stderr)
                n += 1
                if self.stored % 25 == 0 and self.stored:
                    self.db.commit()
        finally:
            self.db.commit()
            s.close()

    def close(self):
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db.close()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    db_path, url = sys.argv[1], sys.argv[2]
    seconds = max_frames = None
    if "--seconds" in sys.argv:
        seconds = float(sys.argv[sys.argv.index("--seconds") + 1])
    if "--max" in sys.argv:
        max_frames = int(sys.argv[sys.argv.index("--max") + 1])
    c = Collector(db_path)
    c.run_ws(url, seconds=seconds, max_frames=max_frames)
    size = os.path.getsize(db_path)
    c.close()
    total = c.stored + c.skipped
    print(f"수집 {total} 프레임 · 저장 {c.stored} · 건너뜀 {c.skipped} "
          f"({100*c.skipped//total if total else 0}% skip) · DB {size/1024:.1f}KB")
