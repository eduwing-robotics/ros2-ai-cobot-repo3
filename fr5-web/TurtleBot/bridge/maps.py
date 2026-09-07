# 맵 슬롯 — data/maps/<name>.{yaml,pgm,meta.json}. mapToLab 은 meta 에 (TB-CONTRACT §맵).
import json
import threading
from pathlib import Path

MAPS_DIR = Path(__file__).parent / "data" / "maps"


class MapStore:
    def __init__(self):
        MAPS_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def list(self):
        maps = []
        for f in sorted(MAPS_DIR.glob("*.meta.json")):
            maps.append(json.loads(f.read_text(encoding="utf-8")))
        return maps

    def exists(self, name):
        return (MAPS_DIR / f"{name}.meta.json").exists()

    def yaml_path(self, name):
        return str(MAPS_DIR / f"{name}.yaml")

    def save(self, name, map_to_lab=None):
        import time
        meta = {"name": name, "mapToLab": map_to_lab or {"xMm": 0, "yMm": 0, "thetaDeg": 0},
                "savedAt": time.time()}
        with self._lock:
            # 실기(P4)에선 map_saver_cli 가 yaml+pgm 을 만든다. mock 은 자리만 만든다.
            (MAPS_DIR / f"{name}.yaml").write_text(f"# mock map — {name}\n", encoding="utf-8")
            (MAPS_DIR / f"{name}.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        return meta

    def patch(self, name, map_to_lab):
        with self._lock:
            f = MAPS_DIR / f"{name}.meta.json"
            if not f.exists():
                return None
            meta = json.loads(f.read_text(encoding="utf-8"))
            meta["mapToLab"] = {**meta.get("mapToLab", {}), **map_to_lab}
            f.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
            return meta
