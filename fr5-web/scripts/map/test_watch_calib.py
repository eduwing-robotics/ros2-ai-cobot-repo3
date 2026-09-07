#!/usr/bin/env python3
"""자동 재캘리브 가드 단위 시험 — **카메라도 사진도 없이 돈다.**

`--auto` 는 소프트웨어가 **자기 캘리브레이션 SSOT 를 덮어쓰는** 코드다. 그래서 여기서
재는 것은 "가드가 있나" 가 아니라 **"가드가 잡나"** 다 — 이 프로젝트는 그 차이로 데였다
(`GAP-MATRIX` — *"검사가 있다"와 "검사가 잡는다"는 다르다*).

사진을 안 쓴다: `calib-shots/` 는 gitignore 대상이라 그걸 읽으면 **다른 기계에서 조용히
건너뛰는 시험**이 된다. 대신 알려진 자세로 점을 투영해 입력을 만든다 — 참값을 우리가 아니까
가드가 거부해야 할 입력도 정확히 만들 수 있다.
"""
import importlib.util
import unittest
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("wc", ROOT / "scripts/map/watch-calib.py")
wc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wc)

# 실측 근사 — 값 자체는 중요하지 않다. **가드가 무엇을 거부하는가**가 시험 대상이다
K = np.array([[1728.0, 0, 1280.0], [0, 1724.0, 720.0], [0, 0, 1]])
DIST = np.zeros(5)
RVEC = np.array([0.2155, 2.5147, -1.8050])      # 08-12 실측 자세를 그대로 빌린다
TVEC = np.array([63.1, 142.0, 1759.6])
# 태그 4장(한 평면) × 모서리 4 = 16점. 배치는 실측 배치도의 자릿수를 따른다
CENTERS = [(0, 0), (0, -307.8), (-601.5, 0), (-601.5, -307.8)]
HALF = 72.5


def _points():
    op = np.array([[cx + dx, cy + dy, 0.0] for cx, cy in CENTERS
                   for dx, dy in ((-HALF, HALF), (HALF, HALF), (HALF, -HALF), (-HALF, -HALF))])
    ip, _ = cv2.projectPoints(op, RVEC, TVEC, K, DIST)
    return op, ip.reshape(-1, 2)


def _cam_pos(rvec, tvec):
    R, _ = cv2.Rodrigues(np.asarray(rvec, float))
    return (-R.T @ np.asarray(tvec, float)).ravel()


class 가드(unittest.TestCase):
    def setUp(self):
        self.op, self.ip = _points()
        self.prev = _cam_pos(RVEC, TVEC)

    def test_정상_입력은_풀린다(self):
        """가드가 **참인 것까지 막으면** 자동 재캘리브가 영영 안 돈다."""
        new, why = wc.resolve(self.op, self.ip, K, DIST, self.prev)
        self.assertIsNone(why)
        self.assertLess(new["rmsPx"], 0.5)
        self.assertLess(new["jumpMm"], 1.0)

    def test_가드2_새_해가_나쁘면_거부한다(self):
        """화소가 흔들리면 푼 자세도 틀린다 — RMS 로 걸러낸다."""
        noisy = self.ip + np.random.default_rng(7).normal(0, 25, self.ip.shape)
        new, why = wc.resolve(self.op, noisy, K, DIST, self.prev)
        self.assertIsNone(new)
        self.assertIn("RMS", why)

    def test_가드3_자세가_튀면_거부한다(self):
        """**재거치는 수십 mm 다.** 미터 단위로 튀면 그건 잘못 푼 것이지 이사가 아니다."""
        far = self.prev + np.array([AUTO := wc.AUTO_JUMP_MM + 1000.0, 0, 0])
        new, why = wc.resolve(self.op, self.ip, K, DIST, far)
        self.assertIsNone(new)
        self.assertIn("튀었다", why)

    def test_가드3_경계_바로_아래는_통과한다(self):
        """상한을 **넘을 때만** 막아야 한다 — 안쪽까지 막으면 정상 재거치가 안 닫힌다."""
        near = self.prev + np.array([wc.AUTO_JUMP_MM * 0.5, 0, 0])
        new, why = wc.resolve(self.op, self.ip, K, DIST, near)
        self.assertIsNone(why, why)
        self.assertGreater(new["jumpMm"], 0)

    def test_가드1_연속_문턱이_1회가_아니다(self):
        """1회면 **사람이 잠깐 가린 것**만으로 SSOT 를 덮는다."""
        self.assertGreaterEqual(wc.AUTO_STREAK, 3)

    def test_상한이_extrinsics_와_같다(self):
        """두 경로가 다른 상한을 쓰면 «손으로 풀면 거부, 자동이면 통과» 가 생긴다."""
        src = (ROOT / "scripts/map/extrinsics.py").read_text(encoding="utf-8")
        line = next(x for x in src.splitlines() if x.startswith("MAX_RMS"))
        self.assertEqual(float(line.split("=")[1].split("#")[0]), wc.AUTO_MAX_RMS)

    def test_기록이_증발하지_않는_자리에_남는다(self):
        """`drift.json` 은 **1초마다 덮어써진다** — 거기 적은 기록은 1초 뒤 사라진다.

        2026-08-13 에 실제로 `note` 필드에만 적었다가 이 자리를 놓칠 뻔했다.
        표준출력도 안 된다(상주 프로세스라 버퍼에 갇힌다). **덧붙이는 파일**이라야 남는다.
        """
        src = (ROOT / "scripts/map/watch-calib.py").read_text(encoding="utf-8")
        self.assertIn('recalib.log', src)
        self.assertIn('"a"', src, "덧붙이기(append) 로 열어야 이전 기록이 안 지워진다")

    def test_경고선이_화면과_같다(self):
        """감시기가 다시 푸는 문턱과 화면이 빨개지는 문턱이 다르면 사람이 헷갈린다."""
        src = (ROOT / "Shared/data/camera/state.js").read_text(encoding="utf-8")
        line = next(x for x in src.splitlines() if "DRIFT_WARN_PX" in x and "=" in x)
        self.assertEqual(float(line.split("=")[1].split(";")[0]), wc.AUTO_WARN_PX)


    def test_가드4_는_장수가_아니라_기하를_본다(self):
        """**가림에 지지 않으면서 평면 degeneracy 는 막는가.**

        옛 가드는 「배치도에 있는 것을 전부」였다. 그건 안전하지만 **가림에 통째로 진다** —
        2026-08-19 하루에만 팔·종이가 id1 하나를 가려 세 번 멈췄다. 새 가드는 조건을
        **배치도 자기 자신에 대한 비율**로 적어, 태그를 늘린 만큼 가림에 강해진다.
        """
        def sq(x, y, z=0.0, h=72.5):
            return [(x - h, y + h, z), (x + h, y + h, z), (x + h, y - h, z), (x - h, y - h, z)]
        # ── 방 기준 4장만 있는 옛 배치도: 예전과 **같이** 동작해야 한다
        room = {"0": sq(0, 0), "1": sq(0, -308), "2": sq(601, 0), "4": sq(601, -308)}
        fs, fz = wc.layout_span([c for v in room.values() for c in v])
        self.assertEqual(fz, 0.0, "방 기준 태그는 한 평면이다")
        ok, _ = wc.geometry_ok([c for k in ("0", "1", "2", "4") for c in room[k]], fs, fz)
        self.assertTrue(ok, "4장 다 보이면 예전처럼 통과해야 한다")
        for miss in ("0", "1", "2", "4"):
            ids = [k for k in room if k != miss]
            ok, why = wc.geometry_ok([c for k in ids for c in room[k]], fs, fz)
            self.assertFalse(ok, f"3장(한 평면)으로 풀면 안 된다 — id{miss} 가림")
            self.assertIn("최소", why, "왜 거부했는지 사유가 있어야 한다")
        # ── 조립셀 태그까지 올린 배치도: **한 장 가려도 살아야 한다**
        wide = dict(room)
        wide.update({"7": sq(-950, -700, -35), "10": sq(250, -700, -35),
                     "12": sq(-1000, 150, -35), "21": sq(-800, 400, -35)})
        fs2, fz2 = wc.layout_span([c for v in wide.values() for c in v])
        self.assertGreater(fz2, 0, "작업대 태그는 카트 상판보다 낮다 — 한 평면이 아니다")
        ok, why = wc.geometry_ok([c for k in wide if k != "1" for c in wide[k]], fs2, fz2)
        self.assertTrue(ok, f"넓은 배치도에서 한 장 가려도 풀어야 한다 — {why}")
        # 넓은 배치도인데 **카트 상판에만 몰린** 검출분은 거부한다 (기하가 나쁘다)
        ok, why = wc.geometry_ok([c for k in ("0", "1", "2", "4") for c in wide[k]], fs2, fz2)
        self.assertFalse(ok, "한 구석에 몰린 4장으로 SSOT 를 덮으면 안 된다")
        self.assertIn("퍼짐", why)

    def test_가드4_는_numpy_배열에도_안_터진다(self):
        """⛔ **`measure()` 는 `op` 를 numpy 배열로 준다** (`watch-calib.py:253`).

        2026-08-19 에 `if op` 로 참거짓을 물었다가 `ValueError` 로 죽었다. 하필 이 줄은
        **자동 재정합이 걸리려는 순간에만** 지나간다 — 평소엔 멀쩡하다가 **정작 필요할 때**
        죽는다. 실제로 카메라가 움직여 rms 207 이 된 그 순간 감시기가 여기서 터졌고,
        사람이 「자동이 안 된다」로 알아챘다. 들어올 수 있는 모양을 전부 넣어 본다.
        """
        import numpy as np
        pts = [(0., 0., 0.), (900., 0., 0.), (900., 900., 0.), (0., 900., 0.)] * 4
        for name, v in (("리스트", pts), ("numpy", np.array(pts, np.float64)),
                        ("None", None), ("빈 배열", np.zeros((0, 3), np.float64))):
            with self.subTest(name):
                ok, why = wc.geometry_ok(v, 1200.0, 0.0)   # 예외가 안 나는 것이 요점
                self.assertIsInstance(ok, bool)
                self.assertIsInstance(why, str)

    def test_태그마다_크기가_다를_수_있다(self):
        """조립셀 태그는 84~134mm 다 — 배치도 전역값 하나로는 못 담는다.

        ⛔ `extrinsics.py` 와 `watch-calib.py` 가 **같은 규약**이어야 한다. 다르면 한쪽만
        어긋난 값을 내고, 그건 재투영 오차로 안 잡힌다.
        """
        big = wc.corners_3d({"xMm": 0, "yMm": 0}, 100.0, 0)
        self.assertEqual(big[1][0] - big[0][0], 100.0, "항목에 크기가 없으면 전역값을 쓴다")
        small = wc.corners_3d({"xMm": 0, "yMm": 0, "tagSizeMm": 84.0}, 100.0, 0)
        self.assertEqual(small[1][0] - small[0][0], 84.0, "항목 크기가 전역값을 덮어야 한다")
        src = (ROOT / "scripts/map/extrinsics.py").read_text(encoding="utf-8")
        self.assertIn('t.get("tagSizeMm", size)', src,
                      "extrinsics.py 도 같은 규약이어야 한다 (하드 룰 5)")


if __name__ == "__main__":
    unittest.main()
