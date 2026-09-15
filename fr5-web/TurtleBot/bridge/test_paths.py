# 경로 저장 형식 단위 — 검증·승격·저장소 (TB-CONTRACT §경로 · D136).
# 로봇 없이 돈다. 실행기(slots/run-path.py)의 주행 루프는 rclpy 가 필요해 여기서 안 돈다 —
# 대신 **저장되는 값**이 틀리면 주행도 틀리므로, 그 값만은 여기서 전부 잠근다.
import json
import tempfile
import unittest
from pathlib import Path

import paths


def doc(points, **kw):
    return {"frame": "table", "points": points, **kw}


class Validate(unittest.TestCase):
    def test_minimal_ok(self):
        d, why = paths.validate(doc([{"xMm": 100, "yMm": 0}]))
        self.assertIsNone(why)
        self.assertEqual(d["points"][0]["arriveMm"], paths.ARRIVE_MM)   # 기본값이 채워진다
        self.assertIsNone(d["points"][0]["thetaDeg"])
        self.assertEqual(d["createdFrom"], "hand")

    def test_theta_wraps(self):
        d, _ = paths.validate(doc([{"xMm": 0, "yMm": 0, "thetaDeg": 370}]))
        self.assertEqual(d["points"][0]["thetaDeg"], 10)

    def test_refusals_have_reasons(self):
        for bad in (
            "경로",                                            # 객체가 아님
            doc([]),                                          # 점 0개
            {"frame": "lab", "points": [{"xMm": 0, "yMm": 0}]},   # 모르는 frame
            doc([{"xMm": "0", "yMm": 0}]),                    # 숫자 아님
            doc([{"xMm": 0, "yMm": float("nan")}]),           # NaN
            doc([{"xMm": 0, "yMm": 0, "thetaDeg": "북"}]),     # 방향이 숫자 아님
            doc([{"xMm": 0, "yMm": 0}], tableToOdom={"xMm": 0}),  # 변환이 반쪽
            doc([{"xMm": i, "yMm": 0} for i in range(501)]),  # 상한 초과
        ):
            d, why = paths.validate(bad)
            self.assertIsNone(d, bad)
            self.assertTrue(why, bad)                          # 사유 없는 거부는 없다 (D114)


class Dwell(unittest.TestCase):
    """각 점에서 멈추기 — 적재·파지 틈 (계약 §경로 dwellSec)."""

    def test_default_is_zero(self):
        d, _ = paths.validate(doc([{"xMm": 0, "yMm": 0}]))
        self.assertEqual(d["points"][0]["dwellSec"], 0.0)

    def test_accepts_seconds(self):
        d, why = paths.validate(doc([{"xMm": 0, "yMm": 0, "dwellSec": 1.5}]))
        self.assertIsNone(why)
        self.assertEqual(d["points"][0]["dwellSec"], 1.5)

    def test_refuses_out_of_range(self):
        for bad in (-1, 61, "1초", float("nan")):
            d, why = paths.validate(doc([{"xMm": 0, "yMm": 0, "dwellSec": bad}]))
            self.assertIsNone(d, bad)
            self.assertIn("dwellSec", why)

    def test_capture_here_starts_at_zero(self):
        pt, _ = paths.point_from_pose({"xMm": 1, "yMm": 2, "thetaDeg": 3}, 0.1)
        self.assertEqual(pt["dwellSec"], 0.0)


class FromRun(unittest.TestCase):
    def test_decimates_close_samples(self):
        samples = [{"xMm": x, "yMm": 0.0, "thetaDeg": 0.0} for x in range(0, 1000, 50)]
        pts = paths.from_run(samples)
        self.assertEqual([p["xMm"] for p in pts], [0.0, 150.0, 300.0, 450.0, 600.0, 750.0, 900.0])

    def test_keeps_final_heading(self):
        pts = paths.from_run([{"xMm": 0, "yMm": 0, "thetaDeg": 0},
                              {"xMm": 400, "yMm": 0, "thetaDeg": 91.5}])
        self.assertEqual(pts[-1]["thetaDeg"], 91.5)

    def test_skips_broken_samples(self):
        pts = paths.from_run([{"xMm": 0, "yMm": 0}, {"xMm": None, "yMm": 0}, {"xMm": 400, "yMm": 0}])
        self.assertEqual(len(pts), 2)

    def test_too_short_gives_one_point(self):
        self.assertEqual(len(paths.from_run([{"xMm": 0, "yMm": 0}, {"xMm": 10, "yMm": 0}])), 1)


class PointFromPose(unittest.TestCase):
    POSE = {"xMm": 1200.4, "yMm": -340.6, "thetaDeg": 371.0}

    def test_keeps_heading(self):
        pt, why = paths.point_from_pose(self.POSE, 0.1)
        self.assertIsNone(why)
        self.assertEqual(pt["thetaDeg"], 11.0)                 # 방향은 항상 채운다 (371 → 11)
        self.assertEqual((pt["xMm"], pt["yMm"]), (1200.4, -340.6))
        self.assertEqual(pt["arriveMm"], paths.ARRIVE_MM)

    def test_fail_closed(self):
        for pose, age in ((None, 0.1), (self.POSE, None), (self.POSE, 2.1),
                          ({"xMm": 0, "yMm": 0, "thetaDeg": float("nan")}, 0.1)):
            pt, why = paths.point_from_pose(pose, age)
            self.assertIsNone(pt)
            self.assertTrue(why)                               # 늙은 자리를 굳히면 그 경로는 영원히 틀린다

    def test_age_boundary_passes(self):
        self.assertIsNotNone(paths.point_from_pose(self.POSE, 2.0)[0])


class Store(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._orig = paths.PATHS_DIR
        paths.PATHS_DIR = Path(self.tmp.name)

    def tearDown(self):
        paths.PATHS_DIR = self._orig
        self.tmp.cleanup()

    def test_round_trip(self):
        store = paths.PathStore()
        d, _ = paths.validate(doc([{"xMm": 120, "yMm": 0}]))
        store.save("belt-to-cell", d)
        listed = store.list()
        self.assertEqual(listed[0]["name"], "belt-to-cell")
        self.assertEqual(listed[0]["points"], 1)
        self.assertEqual(store.get("belt-to-cell")["frame"], "table")
        self.assertTrue(store.delete("belt-to-cell"))
        self.assertEqual(store.list(), [])
        self.assertFalse(store.delete("belt-to-cell"))

    def test_append_creates_then_grows(self):
        store = paths.PathStore()
        pt, _ = paths.point_from_pose({"xMm": 10, "yMm": 20, "thetaDeg": 90}, 0.1)
        doc, why = store.append("to-1", pt)
        self.assertIsNone(why)
        self.assertEqual(doc["frame"], "odom")                 # 바닥 주행엔 판 좌표계가 없다
        self.assertEqual(doc["createdFrom"], "here")
        store.append("to-1", pt)
        self.assertEqual(store.list()[0]["points"], 2)

    def test_pop_undoes_last(self):
        store = paths.PathStore()
        pt, _ = paths.point_from_pose({"xMm": 1, "yMm": 2, "thetaDeg": 3}, 0.1)
        store.append("to-1", pt); store.append("to-1", pt)
        doc, why = store.pop("to-1")
        self.assertIsNone(why)
        self.assertEqual(len(doc["points"]), 1)
        store.pop("to-1")
        self.assertIsNone(store.pop("to-1")[0])                # 빈 경로를 또 되돌리면 사유가 온다

    def test_append_respects_cap(self):
        store = paths.PathStore()
        pt, _ = paths.point_from_pose({"xMm": 1, "yMm": 2, "thetaDeg": 3}, 0.1)
        doc = {"name": "big", "frame": "odom", "points": [pt] * 500, "createdFrom": "here"}
        store.save("big", doc)
        self.assertIsNone(store.append("big", pt)[0])

    def test_broken_file_does_not_kill_the_list(self):
        store = paths.PathStore()
        d, _ = paths.validate(doc([{"xMm": 1, "yMm": 2}]))
        store.save("good", d)
        (paths.PATHS_DIR / "broken.json").write_text("{ 이건 json 이 아니에요", encoding="utf-8")
        self.assertEqual([p["name"] for p in store.list()], ["good"])

    def test_saved_json_is_readable(self):
        store = paths.PathStore()
        d, _ = paths.validate(doc([{"xMm": 1, "yMm": 2}]))
        store.save("a", d)
        raw = json.loads((paths.PATHS_DIR / "a.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["name"], "a")
        self.assertIn("savedAt", raw)


if __name__ == "__main__":
    unittest.main()
