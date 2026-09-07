# 가짜 로봇 2대 — 맥에서 브리지 전체 왕복을 검증하기 위한 어댑터.
# 움직임 규칙은 웹 mock(datasource/mock.js)과 같다: slot 이면 웨이포인트 순찰, teleop 은 적분.
import math
import threading
import time

from .base import RosAdapter

TICK_S = 0.1
# 실기 IMU 가 회전을 13% 크게 읽는 버릇 (2026-08-19 실측 · `slots/run-path.py` 와 같은 값)
IMU_SCALE = 0.885
WATCHDOG_S = 0.5           # TB-CONTRACT §안전 규칙
PATROL = [(1500, 1500), (5500, 1500), (6200, 4800), (9800, 4300), (9800, 6800), (4500, 6500)]


class MockAdapter(RosAdapter):
    def __init__(self, robot_ids, on_log):
        self._on_log = on_log
        self._lock = threading.Lock()
        self._r = {
            rid: {
                "connected": True, "poseAgeSec": 0.1, "mode": "idle", "nav": "running",
                "pose": {"xMm": 1500 + i * 8300, "yMm": 1500 + i * 5300, "thetaDeg": (0 + i * 180) % 360},
                # 두 번째 눈 (계약 §두 번째 눈). **목업은 안 미끄러진다** — 그래서 각도는 같다.
                # 다만 실기 IMU 가 회전을 13% 크게 읽으므로 `/IMU_SCALE` 로 그 버릇까지 흉내낸다.
                # 안 하면 목업에서만 소비자의 `×0.885` 가 12% 차이를 만들어 **거짓 슬립 경보**가 난다
                "imuYawDeg": ((0 + i * 180) % 360) / IMU_SCALE % 360,
                # 자이로 원본 적분은 필터를 안 타므로 **목업에서는 엔코더와 같다** (D142)
                "imuYawIntDeg": (0 + i * 180) % 360,
                "velocity": {"linearMmS": 0.0, "angularDegS": 0.0},
                "batteryPct": 87 - i * 45, "batteryV": 12.4 - i * 1.3, "activeMap": None, "activeSlot": None,
                "activeRunId": None, "owner": None,
                "_wp": 0, "_teleop_at": 0.0, "_trail": [],
            }
            for i, rid in enumerate(robot_ids)
        }
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            with self._lock:
                for rid, r in self._r.items():
                    # real.py 와 같은 조건 — 「모드가 teleop/mapping 인데 500ms 조용하다」.
                    # 「지금 움직이나」로 걸면 정지(0,0)로 끝낸 뒤 mode 가 teleop 에 갇힌다 (2026-08-19)
                    if r["mode"] in ("teleop", "mapping") and time.time() - r["_teleop_at"] > WATCHDOG_S:
                        r["velocity"] = {"linearMmS": 0.0, "angularDegS": 0.0}
                        if r["mode"] == "teleop":
                            r["mode"] = "idle"
                            self._on_log(rid, "bridge", "warn", "teleop watchdog 500ms — 정지 · idle 복귀")
                    if r["mode"] == "slot":
                        self._steer(rid, r)
                    th = math.radians(r["pose"]["thetaDeg"])
                    r["pose"]["xMm"] += math.cos(th) * r["velocity"]["linearMmS"] * TICK_S
                    r["pose"]["yMm"] += math.sin(th) * r["velocity"]["linearMmS"] * TICK_S
                    r["pose"]["thetaDeg"] = (r["pose"]["thetaDeg"] + r["velocity"]["angularDegS"] * TICK_S) % 360
                    r["imuYawDeg"] = r["pose"]["thetaDeg"] / IMU_SCALE % 360
                    r["imuYawIntDeg"] = round(r["pose"]["thetaDeg"], 2)
                    if r["velocity"]["linearMmS"]:
                        r["_trail"].append((r["pose"]["xMm"], r["pose"]["yMm"]))
                        if len(r["_trail"]) > 2000:
                            r["_trail"].pop(0)
            time.sleep(TICK_S)

    def _steer(self, rid, r):
        wx, wy = PATROL[r["_wp"] % len(PATROL)]
        dx, dy = wx - r["pose"]["xMm"], wy - r["pose"]["yMm"]
        if math.hypot(dx, dy) < 150:
            r["_wp"] += 1
            self._on_log(rid, "nav", "info", f"waypoint {r['_wp'] % len(PATROL) + 1}/{len(PATROL)} 도착")
            return
        target = math.degrees(math.atan2(dy, dx))
        diff = (target - r["pose"]["thetaDeg"] + 540) % 360 - 180
        r["velocity"]["angularDegS"] = max(-60.0, min(60.0, diff * 2))
        r["velocity"]["linearMmS"] = 140.0 if abs(diff) < 40 else 40.0

    def robots(self):
        with self._lock:
            return {
                rid: {k: (dict(v) if isinstance(v, dict) else v) for k, v in r.items() if not k.startswith("_")}
                for rid, r in self._r.items()
            }

    def set_velocity(self, robot, linear_mm_s, angular_deg_s):
        with self._lock:
            r = self._r[robot]
            if r["mode"] == "idle":
                r["mode"] = "teleop"
            r["_teleop_at"] = time.time()
            r["velocity"] = {"linearMmS": float(linear_mm_s), "angularDegS": float(angular_deg_s)}

    def stop(self, robot):
        with self._lock:
            r = self._r[robot]
            r["velocity"] = {"linearMmS": 0.0, "angularDegS": 0.0}
            r["mode"] = "idle"
            r["activeSlot"] = None

    def reset_odom(self, robot):
        with self._lock:
            self._r[robot]["pose"] = {"xMm": 0.0, "yMm": 0.0, "thetaDeg": 0.0}
            self._r[robot]["_trail"] = []
        return True, "mock — 원점 재설정"

    def set_mode(self, robot, mode):
        with self._lock:
            self._r[robot]["mode"] = mode

    def set_active_map(self, robot, map_name):
        with self._lock:
            self._r[robot]["activeMap"] = map_name

    # 브리지 내부 전용 — 공개 필드를 직접 갱신한다 (activeSlot·activeRunId·owner·nav)
    def patch(self, robot, **fields):
        with self._lock:
            self._r[robot].update(fields)

    def trail(self, robot):
        with self._lock:
            return list(self._r[robot]["_trail"])
