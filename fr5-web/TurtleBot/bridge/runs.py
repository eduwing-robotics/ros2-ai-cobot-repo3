# 실험 기록 — run 1건 = data/runs/<id>.json. 저장 I/O 를 이 파일에 격리한다 —
# Database/ 저장소가 확정되면 이 파일만 교체한다 (ARCHITECTURE §TurtleBot).
import json
import math
import threading
import time
from pathlib import Path

from safety import PATCH_BODY_MAX

RUNS_DIR = Path(__file__).parent / "data" / "runs"
PATH_SAMPLE_S = 1.0          # 1Hz pose 샘플 (TB-CONTRACT §실험 기록)
PATH_FLUSH_EVERY = 5        # 샘플 5개(=5초)마다 파일로 흘린다 — 브리지가 죽어도 남는다


class RunStore:
    def __init__(self, on_log):
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._on_log = on_log
        self._paths = {}         # run_id -> [{tSec,xMm,yMm,thetaDeg}]
        self._recover_orphans()

    def _recover_orphans(self):
        # 브리지 재시작 — endedAt=null run 은 error 로 마감한다 (감사 R3)
        for f in RUNS_DIR.glob("*.json"):
            if f.name.endswith(".path.json"):
                continue
            run = json.loads(f.read_text(encoding="utf-8"))
            if run.get("endedAt") is None:
                run["endedAt"] = time.time()
                run["result"] = "error"
                run.setdefault("note", "")
                run["note"] = (run["note"] + " [bridge-restart 로 회수됨]").strip()
                f.write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")

    def _file(self, run_id):
        return RUNS_DIR / f"{run_id}.json"

    def create(self, robot, map_slot, script_slot, params):
        run_id = f"{time.strftime('%Y-%m-%d-%H%M%S')}-{robot}-{script_slot}"
        run = {
            "id": run_id, "robot": robot, "mapSlot": map_slot, "scriptSlot": script_slot,
            "params": params, "layoutId": None, "startedAt": time.time(), "endedAt": None,
            "result": None, "note": "", "metrics": {}, "bagPath": None,
        }
        with self._lock:
            self._file(run_id).write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
            self._paths[run_id] = []
        return run

    def sample_pose(self, run_id, pose):
        # ⚠ 메모리에만 두면 **브리지가 죽는 순간 그 주행의 궤적이 통째로 사라진다**
        # (2026-08-19 실측: 71.8초를 달린 run 이 재배포 한 번에 샘플 0개로 남았다).
        # 그래서 몇 초마다 파일로 흘려 둔다 — 사고가 나야 보고 싶어지는 게 이 기록이다.
        with self._lock:
            samples = self._paths.get(run_id)
            if samples is None:
                return
            samples.append({"tSec": round(len(samples) * PATH_SAMPLE_S, 1), **pose})
            if len(samples) % PATH_FLUSH_EVERY == 0:
                self._flush_path(run_id, samples)

    def _flush_path(self, run_id, samples):
        """부분 궤적을 파일로. 락 안에서 부른다."""
        try:
            (RUNS_DIR / f"{run_id}.path.json").write_text(
                json.dumps(samples, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass                                    # 기록 실패가 주행을 막지는 않는다

    def end(self, run_id, result):
        with self._lock:
            f = self._file(run_id)
            if not f.exists():
                return
            run = json.loads(f.read_text(encoding="utf-8"))
            samples = self._paths.pop(run_id, [])
            travel = sum(
                math.hypot(b["xMm"] - a["xMm"], b["yMm"] - a["yMm"])
                for a, b in zip(samples, samples[1:])
            )
            run["endedAt"] = time.time()
            run["result"] = result
            run["metrics"] = {**run.get("metrics", {}), "travelMm": round(travel), "source": "mock"}
            f.write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
            (RUNS_DIR / f"{run_id}.path.json").write_text(json.dumps(samples), encoding="utf-8")
        self._on_log(run["robot"], "bridge", "info", f"run {result} — {run_id} · travelMm={round(travel)}")

    def set_bag(self, run_id, bag_path):
        with self._lock:
            f = self._file(run_id)
            if f.exists():
                run = json.loads(f.read_text(encoding="utf-8"))
                run["bagPath"] = bag_path
                f.write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")

    def list(self, robot=None, slot=None, limit=100):
        runs = []
        for f in RUNS_DIR.glob("*.json"):
            if f.name.endswith(".path.json"):
                continue
            run = json.loads(f.read_text(encoding="utf-8"))
            if robot and run["robot"] != robot:
                continue
            if slot and run["scriptSlot"] != slot:
                continue
            runs.append(run)
        runs.sort(key=lambda r: r["startedAt"], reverse=True)
        return runs[:limit]

    def get(self, run_id):
        f = self._file(run_id)
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None

    def get_path(self, run_id):
        with self._lock:
            if run_id in self._paths:                      # 진행 중이면 메모리
                return list(self._paths[run_id])
        f = RUNS_DIR / f"{run_id}.path.json"
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []

    def patch(self, run_id, body):
        if len(json.dumps(body)) > PATCH_BODY_MAX:
            return None, "본문 64KB 상한 초과"
        with self._lock:
            f = self._file(run_id)
            if not f.exists():
                return None, "없는 run"
            run = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(body.get("note"), str):
                run["note"] = body["note"]
            if isinstance(body.get("metrics"), dict):
                run["metrics"] = {**run.get("metrics", {}), **body["metrics"]}   # 얕은 병합 (계약)
            f.write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
            return run, None
