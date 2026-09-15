"""단계 기록 — **버튼 한 번 = 기록 한 줄** (계약 `API-CONTRACT.md` §단계 기록 · 2026-09-07 · D191).

화면이 조준·풀기·실행의 각 칸을 지날 때 무엇을 보고(원값) 무엇으로 풀었고(해·접촉) 실기가 어디 갔나
(readback·게이트 사유)를 `data/runs/<runId>.jsonl` 에 **덧붙여 쓰기만** 한다. 해석·판정은 안 한다 —
나중에 「그때 왜 틀렸나」를 되짚는 장부다. 지우는 창구는 없다(evidence 로 옮기는 것은 사람).

⛔ 표준 라이브러리만 · 한 줄 64KB 상한 · runId 는 `YYYYMMDD-HHMMSS[-suffix]` 만(경로 주입 차단).
"""
import json
import re
import threading
import time
from pathlib import Path

RUN_ID = re.compile(r"^\d{8}-\d{6}(?:-[a-z0-9]{1,16})?$")
LINE_MAX_BYTES = 64 * 1024


class RunStore:
    def __init__(self, root):
        self._dir = Path(root)
        self._lock = threading.Lock()

    @staticmethod
    def new_id():
        return time.strftime("%Y%m%d-%H%M%S")

    def _path(self, run_id):
        if not isinstance(run_id, str) or not RUN_ID.match(run_id):
            return None
        return self._dir / f"{run_id}.jsonl"

    def append(self, run_id, line):
        """한 줄 덧붙인다. 반환 `(runId, n, 사유목록)` — 사유가 있으면 안 썼다."""
        if not isinstance(line, dict):
            return None, 0, ["line 은 객체다"]
        run_id = run_id or self.new_id()
        path = self._path(run_id)
        if path is None:
            return None, 0, [f"runId 모양이 틀렸다 — YYYYMMDD-HHMMSS[-suffix] · 받은 것 {run_id!r}"]
        rec = dict(line)
        rec["t"] = time.time()            # 시각은 브리지가 박는다 — 화면 시계를 믿지 않는다
        rec["runId"] = run_id
        raw = json.dumps(rec, ensure_ascii=False)
        if len(raw.encode("utf-8")) > LINE_MAX_BYTES:
            return run_id, 0, [f"한 줄이 {LINE_MAX_BYTES // 1024}KB 를 넘는다 — 사진은 경로만 적는다"]
        with self._lock:
            self._dir.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(raw + "\n")
            n = sum(1 for _ in path.open(encoding="utf-8"))
        return run_id, n, []

    def list(self):
        if not self._dir.exists():
            return []
        out = []
        for p in sorted(self._dir.glob("*.jsonl")):
            lines = [l for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
            t0 = t1 = None
            try:
                t0 = json.loads(lines[0])["t"]; t1 = json.loads(lines[-1])["t"]
            except Exception:                 # noqa: BLE001 — 깨진 줄은 목록에서 시각만 비운다
                pass
            out.append({"runId": p.stem, "n": len(lines), "t0": t0, "t1": t1})
        return out

    def read(self, run_id):
        path = self._path(run_id)
        if path is None or not path.exists():
            return None
        lines = []
        for l in path.read_text(encoding="utf-8").splitlines():
            if not l.strip():
                continue
            try:
                lines.append(json.loads(l))
            except Exception:                 # noqa: BLE001
                lines.append({"_broken": l[:200]})
        return {"runId": run_id, "lines": lines}
