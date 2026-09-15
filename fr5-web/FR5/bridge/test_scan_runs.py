"""2단 조준 브리지 몫 — 조건 27 · `/scan` 목업 거울 쌍 · `/runs` 장부 (2026-09-07 · D191·D192).

  ① 조건 27 은 **켰을 때만** 막는다 — 주소 없음 → 무언 · 움직임 → 거부 · 모름(낡음/note) → 거부
  ② 목업 스캔의 편향은 툴 프레임에 고정 → rz 와 rz+180 두 뷰의 **평균이 진값**(1e-6) · 단일 뷰는 진값이 아니다
  ③ 장부는 덧붙이기만 · runId 모양 검사 · 64KB 상한
⚠ `fastapi` 가 없으면 엔드포인트 시험만 건너뛴다(test_stop_transport 와 같은 태도).
"""
import json
import math
import tempfile
import unittest
from pathlib import Path

import safety
import scan_frames
from runs import RunStore

try:
    from fastapi.testclient import TestClient
    import main
    HAVE = True
except Exception:                                    # noqa: BLE001
    HAVE = False

OK_STATE = {"enabled": True, "mode": 0, "motionQueueLength": 0, "jointsDeg": [0, -60, 90, -120, -90, 0],
            "safety": {"emergencyStop": False, "safetyStop": False, "mainErrorCode": 0, "subErrorCode": 0,
                       "collisionDetected": False, "collisionLevel": [1] * 6, "inDragTeach": False}}
APPLIED = {"sent": {"payloadKg": 0.6}, "readback": {}, "mismatch": [], "unverifiable": []}


class 조건27(unittest.TestCase):
    def _reasons(self, amr):
        return [r for r in safety.check_motion(OK_STATE, 0.05, [0, -60, 90, -120, -90, 1], 10, APPLIED, amr_status=amr)
                if "조건 27" in r]

    def test_주소_없으면_무언(self):
        self.assertEqual(self._reasons({"enabled": False, "moving": None}), [])
        self.assertEqual(self._reasons(None), [])

    def test_움직이면_거부(self):
        r = self._reasons({"enabled": True, "moving": True, "velocity": {"linearMmS": 120.0, "angularDegS": 0.0}})
        self.assertEqual(len(r), 1); self.assertIn("움직이는 중", r[0])

    def test_모르면_거부(self):
        r = self._reasons({"enabled": True, "moving": None, "ageSec": 5.3, "note": None})
        self.assertEqual(len(r), 1); self.assertIn("못 읽습니다", r[0])

    def test_서_있으면_통과(self):
        self.assertEqual(self._reasons({"enabled": True, "moving": False, "velocity": {"linearMmS": 0.0, "angularDegS": 0.0}}), [])

    def test_데드밴드_안_잡음은_안_막는다(self):
        # 주차된 odom 잡음 0.5mm/s·0.3°/s 는 movingFalse 로 온다 — 아래 amr.motion_status 가 데드밴드를 적용한 결과
        self.assertEqual(self._reasons({"enabled": True, "moving": False, "velocity": {"linearMmS": 0.49, "angularDegS": 0.31}}), [])

    def test_그리퍼도_같은_문(self):
        r = [x for x in safety.check_gripper(OK_STATE | {"gripperActive": True}, 0.05, 30, APPLIED,
                                             amr_status={"enabled": True, "moving": True, "velocity": {}}) if "조건 27" in x]
        self.assertEqual(len(r), 1)


class 조건27_데드밴드(unittest.TestCase):
    def _mv(self, lin, ang, age=0.1):
        import amr, time
        with amr._lock:
            amr._state.update(host="x:5056", velocity={"linearMmS": lin, "angularDegS": ang}, t=time.time() - age, note=None)
        return amr.motion_status()["moving"]

    def test_잡음은_정지_실주행은_움직임(self):
        self.assertIs(self._mv(0.49, 0.31), False)     # 주차 잡음
        self.assertIs(self._mv(0.0, 0.0), False)
        self.assertIs(self._mv(120.0, 0.0), True)      # 직진
        self.assertIs(self._mv(0.0, 30.0), True)       # 제자리 회전
        self.assertIsNone(self._mv(0.0, 0.0, age=5.0))  # 낡음=모른다


class 장부(unittest.TestCase):
    def test_덧붙이고_읽는다(self):
        with tempfile.TemporaryDirectory() as d:
            st = RunStore(Path(d) / "runs")
            rid, n, why = st.append(None, {"phase": 0, "step": "a"})
            self.assertEqual(why, []); self.assertEqual(n, 1)
            rid2, n2, _ = st.append(rid, {"phase": 0, "step": "b"})
            self.assertEqual((rid2, n2), (rid, 2))
            doc = st.read(rid)
            self.assertEqual([l["step"] for l in doc["lines"]], ["a", "b"])
            self.assertTrue(all("t" in l and l["runId"] == rid for l in doc["lines"]))
            self.assertEqual(st.list()[0]["n"], 2)

    def test_runId_모양과_상한(self):
        with tempfile.TemporaryDirectory() as d:
            st = RunStore(Path(d) / "runs")
            self.assertTrue(st.append("../etc", {"a": 1})[2])
            self.assertTrue(st.append(None, "문자열")[2])
            self.assertTrue(st.append(None, {"big": "x" * (65 * 1024)})[2])
            self.assertIsNone(st.read("../etc"))


@unittest.skipUnless(HAVE, "fastapi 가 없다 — 브리지 호스트에서만 돈다")
class 목업_거울쌍(unittest.TestCase):
    def test_props_치수는_정본에서(self):
        self.assertEqual(main._props_size("CARRIER"), (69.0, 85.0))
        self.assertEqual(main._props_size("AMR_BASKET"), (110.0, 120.0))

    def test_rz_180_두_뷰_평균이_진값(self):
        truth = {"user1Mm": [657.2, -1103.0, -366.0], "yawDeg": -90.3}
        for rz in (-90.3, 0.0, 37.0, 135.0):
            a, _ = main._scan_mock("carrier", truth, [657.2, -1103.0, -100.0, 178.8, -1.3, rz + 90])
            b, _ = main._scan_mock("carrier", truth, [657.2, -1103.0, -100.0, 178.8, -1.3, rz - 90])
            avg = [(a["user1Mm"][i] + b["user1Mm"][i]) / 2 for i in range(3)]
            self.assertLess(math.dist(avg[:2], truth["user1Mm"][:2]), 1e-6, f"rz={rz} 평균이 진값이 아니다 {avg}")
            # 단일 뷰는 편향만큼 벗어나야 한다 — 편향이 0 이면 이 시험은 아무것도 재지 않는다
            self.assertGreater(math.dist(a["user1Mm"][:2], truth["user1Mm"][:2]), 10.0)
            self.assertEqual(a["source"], "mock"); self.assertEqual(a["yawDeg"], -90.3)

    def test_truth_없으면_지어내지_않는다(self):
        view, why = main._scan_mock("carrier", None, [0, 0, 0, 180, 0, 0])
        self.assertIsNone(view); self.assertIn("지어내지", why[0])

    def test_엔드포인트_문턱(self):
        c = TestClient(main.app)
        frame = scan_frames.add(b"jpeg", 848, 480, 123.0)
        image = c.get(frame["url"])
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.headers["content-type"], "image/jpeg")
        self.assertEqual(image.headers["cache-control"], "no-store")
        self.assertEqual(c.get("/scan/frame/not-found").status_code, 404)
        self.assertEqual(c.post("/scan", json={"target": "moon"}).status_code, 400)
        r = c.post("/runs", json={"runId": "../x", "line": {"a": 1}})
        self.assertEqual(r.status_code, 400)
        r = c.post("/runs", json={"runId": "20260907-000000-test", "line": {"phase": 0, "step": "unit"}})
        self.assertTrue(r.json()["ok"]); self.assertEqual(r.json()["runId"], "20260907-000000-test")
        got = c.get("/runs/20260907-000000-test").json()
        self.assertEqual(got["lines"][-1]["step"], "unit")
        self.assertEqual(c.get("/runs/nope").status_code, 404)
        main.runs._path("20260907-000000-test").unlink(missing_ok=True)   # 사람 데이터 폴더에 시험 줄을 남기지 않는다
        self.assertEqual(c.get("/state").json()["amr"]["enabled"], False)   # 집 = 주소 없음 = 안 켠 것


class ScanHudFrames(unittest.TestCase):
    def test_only_four_recent_frames_keep_json_small(self):
        refs = [scan_frames.add(f"jpeg-{i}".encode(), 848, 480, i) for i in range(5)]
        self.assertIsNone(scan_frames.get(refs[0]["url"].rsplit("/", 1)[-1]))
        for ref in refs[1:]:
            self.assertEqual(set(ref), {"url", "widthPx", "heightPx", "capturedAt"})
            self.assertLess(len(json.dumps(ref)), 200)
            self.assertIsNotNone(scan_frames.get(ref["url"].rsplit("/", 1)[-1]))


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE, "fastapi 없음")
class 제안수명(unittest.TestCase):
    """제안은 90초 뒤 죽는다 — 그새 팔·물건이 움직였을 수 있다. 수명 판정은 시각 하나로 결정된다."""
    def test_수명(self):
        p = {"expiresAt": 1000.0}
        self.assertFalse(main.proposal_expired(p, now=999.9))
        self.assertTrue(main.proposal_expired(p, now=1000.1))
        self.assertGreaterEqual(main.PROPOSAL_TTL_S, 60.0)          # 사람이 고스트 보고 누를 시간
