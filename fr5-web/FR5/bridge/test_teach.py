# teach.py 단위 테스트 — 지점(점)과 궤적(선). 순수 파일 I/O 라 로봇 없이 전부 돈다.
#
# 여기서 지키는 것 셋: **결측=차단**(관절 못 읽으면 캡처 안 한다) ·
# **좌표계가 다르면 이동 전에 막는다** · **`fps` 가 거짓말이 되지 않는다**(재표본·결손 계수).
import json
import tempfile
import time
import unittest
from pathlib import Path

from teach import (MAX_DURATION_S, PointStore, Recorder, TeachService,
                    TrajectoryStore, frame_mismatch, safe_name)

HOME = [-80.85, -98.35, 91.25, -89.07, -89.75, 6.90]


def state(joints=None, tcp=None, tool=1, user=1, pct=62, estop=False, collide=False):
    return {
        "jointsDeg": list(joints if joints is not None else HOME),
        "tcpMmDeg": list(tcp if tcp is not None else [357.4, 10.9, -11.6, 180.0, 0.0, 45.0]),
        "coord": {"toolId": tool, "userId": user},
        "gripper": {"pct": pct},
        "safety": {"emergencyStop": estop, "collisionDetected": collide},
    }


class PointCapture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = PointStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_캡처가_서버_상태를_굳힌다(self):
        p, reasons = self.store.capture("P1", state(), "fr5-lab-a")
        self.assertEqual(reasons, [])
        self.assertEqual(p["jointsDeg"], HOME)
        self.assertEqual((p["toolId"], p["userId"]), (1, 1))
        self.assertEqual(p["capturedRobotId"], "fr5-lab-a")
        self.assertEqual(self.store.get("P1")["name"], "P1")

    def test_이름이_비면_거부(self):
        for bad in ("", "   ", None, 3):
            _, reasons = self.store.capture(bad, state(), "fr5-lab-a")
            self.assertTrue(reasons, f"{bad!r} 가 통과했다")

    def test_관절을_못_읽으면_캡처하지_않는다(self):
        for bad in ([], [1, 2, 3], [1, 2, 3, 4, 5, float("nan")]):
            p, reasons = self.store.capture("P1", state(joints=bad), "fr5-lab-a")
            self.assertIsNone(p)
            self.assertTrue(reasons)
        self.assertEqual(self.store.list(), [])

    def test_그리퍼를_못_읽으면_null_이지_0_이_아니다(self):
        p, _ = self.store.capture("P1", state(pct=None), "fr5-lab-a")
        self.assertIsNone(p["gripperPct"])

    def test_같은_이름은_덮어쓴다(self):
        self.store.capture("P1", state(), "fr5-lab-a")
        self.store.capture("P1", state(joints=[0] * 6), "fr5-lab-a")
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(self.store.get("P1")["jointsDeg"], [0] * 6)

    def test_삭제는_참조가_없을_때만(self):
        self.store.capture("P1", state(), "fr5-lab-a")
        ok, blocked = self.store.delete("P1", refs=["slot-a"])
        self.assertFalse(ok)
        self.assertEqual(blocked, ["slot-a"])
        self.assertIsNotNone(self.store.get("P1"))     # 참조가 있으면 살아 있어야 한다
        ok, blocked = self.store.delete("P1")
        self.assertTrue(ok)
        self.assertIsNone(self.store.get("P1"))

    def test_없는_지점_삭제는_False(self):
        ok, blocked = self.store.delete("없음")
        self.assertFalse(ok)
        self.assertEqual(blocked, [])

    def test_깨진_파일이면_빈_목록(self):
        (Path(self.tmp.name) / "points.json").write_text("{ 이건 JSON 이 아니다")
        self.assertEqual(self.store.list(), [])

    def test_자세에_붙은_이름_찾기(self):
        self.store.capture("home-a", state(), "fr5-lab-a")
        self.assertEqual(self.store.name_of_pose(HOME), "home-a")
        near = list(HOME)
        near[0] += 0.4
        self.assertEqual(self.store.name_of_pose(near), "home-a")
        far = list(HOME)
        far[0] += 2.0
        self.assertIsNone(self.store.name_of_pose(far))
        self.assertIsNone(self.store.name_of_pose(None))


class FrameGate(unittest.TestCase):
    def test_좌표계가_같으면_통과(self):
        p = {"toolId": 1, "userId": 1}
        self.assertEqual(frame_mismatch(p, {"toolId": 1, "userId": 1}), [])

    def test_좌표계가_다르면_사유를_준다(self):
        p = {"toolId": 0, "userId": 0}
        reasons = frame_mismatch(p, {"toolId": 1, "userId": 1})
        self.assertEqual(len(reasons), 1)
        self.assertIn("tool0", reasons[0])
        self.assertIn("tool1", reasons[0])

    def test_좌표를_못_읽으면_기본값_0_으로_비교한다(self):
        # 결측을 통과로 읽지 않는다 — tool1 지점은 좌표 미상일 때 막혀야 한다
        self.assertTrue(frame_mismatch({"toolId": 1, "userId": 1}, None))


class Recording(unittest.TestCase):
    def _rec(self, **kw):
        return Recorder("demo-01", kw.get("purpose", "measure"), kw.get("source", "demo"),
                        kw.get("fps", 10), {"robotId": "fr5-lab-a"}, kw.get("start"))

    def test_고정_주기_격자로_재표본한다(self):
        r = self._rec(fps=10)
        r.t0 = time.time()
        # 0.00 · 0.05 · 0.10 … 실제 간격은 흔들려도 격자는 0.1s 로 나온다
        for i in range(21):
            r.raw.append((i * 0.05, [float(i)] * 6, [0.0] * 6, 50.0))
        traj = r.finish()
        self.assertEqual(traj["fps"], 10)
        self.assertEqual(traj["dropped"], 0)
        ts = [f["tSec"] for f in traj["frames"]]
        self.assertEqual(ts, [round(i * 0.1, 4) for i in range(11)])
        # 격자 0.1s = 원본 인덱스 2 → 값 2.0 (보간이 맞는지)
        self.assertAlmostEqual(traj["frames"][1]["jointsDeg"][0], 2.0, places=3)

    def test_빈_구간은_지어내지_않고_결손으로_센다(self):
        r = self._rec(fps=10)
        r.raw = [(0.0, [0.0] * 6, [0.0] * 6, None),
                 (1.0, [10.0] * 6, [0.0] * 6, None)]      # 사이 1초가 통째로 비었다
        traj = r.finish()
        self.assertGreater(traj["dropped"], 5)
        self.assertEqual([f["tSec"] for f in traj["frames"]], [0.0, 1.0])

    def test_비상정지는_그_자리에서_끝_사유가_된다(self):
        r = self._rec()
        self.assertTrue(r.push(state()))
        self.assertFalse(r.push(state(estop=True)))
        self.assertEqual(r.finish()["endReason"], "estop")

    def test_충돌도_마찬가지(self):
        r = self._rec()
        r.push(state())
        self.assertFalse(r.push(state(collide=True)))
        self.assertEqual(r.finish()["endReason"], "collision")

    def test_상한을_넘으면_timeout_으로_스스로_닫는다(self):
        r = self._rec()
        r.t0 = time.time() - (MAX_DURATION_S + 1)
        self.assertFalse(r.push(state()))
        self.assertEqual(r.finish()["endReason"], "timeout")

    def test_불량_표본은_버리되_녹화는_이어간다(self):
        r = self._rec()
        self.assertTrue(r.push(state(joints=[1, 2, 3])))
        self.assertEqual(r.raw, [])
        self.assertTrue(r.push(state()))
        self.assertEqual(len(r.raw), 1)

    def test_purpose_와_source_는_아는_값만_받는다(self):
        r = self._rec(purpose="아무거나", source="아무거나")
        self.assertEqual(r.purpose, "measure")           # 모르면 차단 쪽으로 떨어진다
        self.assertEqual(r.source, "demo")
        self.assertEqual(self._rec(purpose="collect", source="policy").purpose, "collect")

    def test_잰_조건과_출발_자세가_실린다(self):
        r = self._rec(start="home-a")
        r.raw = [(0.0, HOME, [0.0] * 6, 62.0)]
        traj = r.finish()
        self.assertEqual(traj["stamp"]["robotId"], "fr5-lab-a")
        self.assertEqual(traj["startPose"]["name"], "home-a")
        self.assertEqual(traj["startPose"]["jointsDeg"], [round(v, 4) for v in HOME])

    def test_한_프레임도_없으면_startPose_는_null(self):
        traj = self._rec().finish()
        self.assertIsNone(traj["startPose"])
        self.assertEqual(traj["frames"], [])
        self.assertEqual(traj["endReason"], "done")


class Storage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TrajectoryStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_목록은_프레임을_안_싣는다(self):
        r = Recorder("d1", "measure", "demo", 10, {"robotId": "fr5-lab-a"})
        r.raw = [(i * 0.1, [float(i)] * 6, [0.0] * 6, 0.0) for i in range(5)]
        self.store.save(r.finish())
        rows = self.store.list()
        self.assertEqual(len(rows), 1)
        self.assertNotIn("frames", rows[0])
        self.assertEqual(rows[0]["frameCount"], 5)
        self.assertEqual(len(self.store.get("d1")["frames"]), 5)

    def test_없는_궤적은_None(self):
        self.assertIsNone(self.store.get("없음"))

    def test_빈_폴더도_목록이_돈다(self):
        self.assertEqual(self.store.list(), [])

    def test_저장은_유효한_JSON(self):
        r = Recorder("d1", "measure", "demo", 10, {"robotId": "fr5-lab-a"})
        r.raw = [(0.0, HOME, [0.0] * 6, 1.0)]
        self.store.save(r.finish())
        raw = (Path(self.tmp.name) / "trajectories" / "d1.json").read_text()
        self.assertEqual(json.loads(raw)["name"], "d1")


class TrajectoryNameIsAFileName(unittest.TestCase):
    """궤적 이름이 그대로 파일 경로가 됐다 (감사 2026-08-05 P0-2).

    `pathlib` 은 오른쪽이 절대경로면 왼쪽을 버린다. 조종권만 있으면 ARM 없이
    브리지 계정이 쓸 수 있는 아무 파일이나 `.json` 내용으로 덮어썼다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TrajectoryStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    BAD = ["/etc/cron.d/pwn", "../../.ssh/authorized_keys", "..", "a/b",
           "a\\b", ".", "x" * 65, "sp ace", "d1.json", ""]

    def test_경로가_되는_이름은_전부_거부(self):
        for bad in self.BAD:
            with self.subTest(name=bad):
                self.assertTrue(safe_name(bad)[1], f"{bad!r} 이 통과했다")

    def test_평범한_이름은_통과(self):
        for ok in ["d1", "demo-01", "trayPick", "왼쪽_집기", "A_b-9"]:
            with self.subTest(name=ok):
                self.assertEqual(safe_name(ok), (ok, []))

    def test_폴더_밖으로는_한_글자도_안_쓴다(self):
        """`save` 는 마지막 방어선이다 — 호출처가 검사를 빠뜨려도 파일이 안 새어 나간다."""
        outside = Path(self.tmp.name) / "outside.json"
        with self.assertRaises(ValueError):
            self.store.save({"name": "../outside", "frames": []})
        self.assertFalse(outside.exists())

    def test_읽기도_폴더_밖을_안_본다(self):
        target = Path(self.tmp.name) / "secret.json"
        target.write_text(json.dumps({"name": "secret"}))
        self.assertIsNone(self.store.get("../secret"))

    def test_녹화는_시작에서_막힌다(self):
        """끝에서 막으면 120초를 녹화하고 저장에서 버리게 된다."""
        svc = TeachService(self.tmp.name, 10, lambda *a: None)
        rec, reasons = svc.start("/etc/cron.d/pwn", "measure", "demo", {}, state())
        self.assertIsNone(rec)
        self.assertTrue(reasons)
        self.assertIsNone(svc.recording)


if __name__ == "__main__":
    unittest.main()
