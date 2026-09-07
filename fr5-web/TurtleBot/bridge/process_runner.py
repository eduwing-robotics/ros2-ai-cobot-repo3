# 슬롯 프로세스 실행기 — spawn · stdout→로그 · SIGTERM→5s→SIGKILL.
# 어떤 경로로 죽든 on_exit 이 불려 브리지가 cmd_vel 0 을 보장한다 (감사 R1 · §안전 규칙).
import json
import os
import signal
import subprocess
import sys
import threading

from safety import SIGTERM_GRACE_S


class ProcessRunner:
    def __init__(self, on_log, on_exit):
        self._procs = {}          # robot -> (Popen, run_id, slot_name, 정지사유 or None)
        self._lock = threading.Lock()
        self._on_log = on_log
        self._on_exit = on_exit   # (robot, run_id, result)

    def running(self, robot):
        with self._lock:
            return robot in self._procs

    def start(self, robot, slot_name, slot_file, run_id, map_path, params):
        env = {**os.environ, "TB_ROBOT": robot, "TB_MAP": map_path or "",
               "TB_PARAMS": json.dumps(params or {})}
        proc = subprocess.Popen(
            [sys.executable, "-u", str(slot_file)], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        with self._lock:
            self._procs[robot] = [proc, run_id, slot_name, None]
        threading.Thread(target=self._pump, args=(robot, proc, slot_name), daemon=True).start()
        threading.Thread(target=self._wait, args=(robot, proc), daemon=True).start()
        self._on_log(robot, "bridge", "info", f"{slot_name}: 시작 (pid={proc.pid} · runId={run_id})")

    def _pump(self, robot, proc, slot_name):
        for line in proc.stdout:
            self._on_log(robot, "slot", "info", line.rstrip())

    def _wait(self, robot, proc):
        code = proc.wait()
        with self._lock:
            entry = self._procs.pop(robot, None)
        if not entry:
            return
        _, run_id, slot_name, stop_reason = entry
        # 종료 → result 매핑 (감사 C5): exit0=completed · stop=stopped · estop=estop · 그외=error
        if stop_reason:
            result = stop_reason
        elif code == 0:
            result = "completed"
        else:
            result = "error"
            self._on_log(robot, "bridge", "warn", f"{slot_name}: 비정상 종료 exit={code}")
        self._on_exit(robot, run_id, result)

    def stop(self, robot, reason="stopped"):
        with self._lock:
            entry = self._procs.get(robot)
            if not entry:
                return False
            entry[3] = reason
            proc = entry[0]
        self._on_log(robot, "bridge", "info", f"stop({reason}) — SIGTERM pid={proc.pid}")
        proc.send_signal(signal.SIGTERM)
        threading.Thread(target=self._force_kill, args=(proc, robot), daemon=True).start()
        return True

    def _force_kill(self, proc, robot):
        try:
            proc.wait(timeout=SIGTERM_GRACE_S)
        except subprocess.TimeoutExpired:
            self._on_log(robot, "bridge", "warn", "SIGTERM 5s 무응답 — SIGKILL (좀비 방지)")
            proc.kill()
