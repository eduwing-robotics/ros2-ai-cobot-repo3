"""세운 총알 판정 시험 — **카메라도 로봇도 안 쓴다** (2026-08-31 · D159).

`test_watch_calib.py` 와 같은 태도다: 판정 규칙을 실기에서만 확인하면 규칙이 늦게 틀리고,
실기는 늘 늦게 온다. 여기서 지키는 것은 하나 — **자를 바꿔 통과시키지 않는다.**

2026-08-31 에 깊이가 총알 넷을 또렷이 잡아 놓고 「판정선 밖」으로 버렸다. 원인은 자였다:
누운 총알의 **지름**(7~13mm)으로 재고 있었는데 실물은 서 있어 **길이**(77mm)로 솟는다.
고치는 길은 관용도를 늘리는 것이 아니라 **옳은 치수를 재는 것**이었다.
"""
import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "depth_probe", Path(__file__).resolve().parent / "depth-probe.py")
dp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dp)


def bar(len_mm, wid_mm, z_mm, deg, shape=(480, 848)):
    """알려진 크기의 막대를 화면에 그린다 — 되찾을 수 있어야 한다."""
    h, w = shape
    m = np.zeros(shape, bool)
    px_l = len_mm * dp.FX848 / z_mm
    px_w = wid_mm * dp.FX848 / z_mm
    ys, xs = np.mgrid[0:h, 0:w]
    dx, dy = xs - w / 2, ys - h / 2
    t = math.radians(deg)
    u = dx * math.cos(t) + dy * math.sin(t)          # 긴축 방향
    v = -dx * math.sin(t) + dy * math.cos(t)
    # 균일 막대의 표준편차는 길이/√12 다. `blob_size_mm` 이 4σ 를 쓰므로
    # 되찾히는 값은 길이 × 4/√12 = 1.155배 — **그 편향까지 시험이 알고 있어야 한다**
    m[(np.abs(u) <= px_l / 2) & (np.abs(v) <= px_w / 2)] = True
    return m


BIAS = 4.0 / math.sqrt(12.0)      # 균일 막대에서 4σ 가 길이를 이만큼 부풀린다


class 덩어리치수(unittest.TestCase):
    def test_아는_막대를_되찾는다(self):
        for deg in (0, 30, 90, 137):
            with self.subTest(deg=deg):
                s = dp.blob_size_mm(bar(77.0, 10.0, 200.0, deg), 200.0)
                self.assertIsNotNone(s)
                self.assertAlmostEqual(s["longMm"], 77.0 * BIAS, delta=2.0)
                self.assertAlmostEqual(s["shortMm"], 10.0 * BIAS, delta=2.0)

    def test_회전해도_같은_치수다(self):
        """바깥 상자로 재면 45°에서 대각선을 감싸 부푼다 — 주축은 안 흔들린다."""
        a = dp.blob_size_mm(bar(77.0, 10.0, 200.0, 0), 200.0)
        b = dp.blob_size_mm(bar(77.0, 10.0, 200.0, 45), 200.0)
        self.assertAlmostEqual(a["longMm"], b["longMm"], delta=2.0)

    def test_거리를_반영한다(self):
        """같은 화소라도 멀면 실물이 크다 — 거리를 안 나누면 여기서 잡힌다."""
        m = bar(77.0, 10.0, 200.0, 90)
        near = dp.blob_size_mm(m, 200.0)["longMm"]
        far = dp.blob_size_mm(m, 400.0)["longMm"]
        self.assertAlmostEqual(far / near, 2.0, delta=0.05)

    def test_긴축_방향을_낸다(self):
        """세워 꽂혔나 누웠나를 파지 쪽이 이 각으로 본다."""
        self.assertAlmostEqual(dp.blob_size_mm(bar(77, 10, 200, 90), 200)["longAxisDeg"],
                               90.0, delta=3.0)

    def test_화소가_모자라면_안_낸다(self):
        self.assertIsNone(dp.blob_size_mm(np.zeros((480, 848), bool), 200.0))
        self.assertIsNone(dp.blob_size_mm(bar(77, 10, 200, 0), None))


class 판정(unittest.TestCase):
    def test_누운_총알은_지금까지처럼_높이로_본다(self):
        self.assertIn("총알을 본다", dp.verdict_of(10.0, None, None))

    def test_세운_총알을_길이로_본다(self):
        """2026-08-31 실사고 그 자리 — 솟음 139.7mm 로 버려지던 장면."""
        v = dp.verdict_of(139.7, None, {"longMm": 71.1, "shortMm": 15.5, "longAxisDeg": 96.7})
        self.assertIn("세운 총알을 본다", v)

    def test_짧은축이_부풀어도_거부하지_않는다(self):
        """2026-08-31 실측: 짧은축이 +55% 로 부풀었다. 판정에 쓰면 참인 것을 버린다."""
        v = dp.verdict_of(139.7, None, {"longMm": 77.0, "shortMm": 40.0, "longAxisDeg": 90.0})
        self.assertIn("세운 총알을 본다", v)

    def test_총알이_아닌_것은_여전히_거부한다(self):
        """⛔ 자를 바꿔 아무거나 통과시키면 안 된다 — 이게 이 시험의 본체다."""
        for ln in (20.0, 45.0, 120.0, 300.0):
            with self.subTest(longMm=ln):
                v = dp.verdict_of(139.7, None, {"longMm": ln, "shortMm": 10.0,
                                                "longAxisDeg": 90.0})
                self.assertIn("판정선 밖", v)
                self.assertIn("총알 길이 밖", v)

    def test_치수를_못_재면_옛_판정_그대로다(self):
        self.assertIn("판정선 밖", dp.verdict_of(139.7, None, None))

    def test_판정선이_실측에서_유도된다(self):
        """⛔ 숫자를 지어내지 않았다 — `props.js` ROUND 전장 ±30%(지름 판정과 같은 관용도)."""
        self.assertAlmostEqual(dp.LEN_MIN_MM, dp.ROUND_LEN_MM * 0.70, places=6)
        self.assertAlmostEqual(dp.LEN_MAX_MM, dp.ROUND_LEN_MM * 1.30, places=6)
        # 지름 판정선도 같은 관용도여야 한다 — 하나만 바뀌면 여기서 갈린다
        self.assertAlmostEqual(dp.PEAK_MIN_MM, dp.ROUND_DIA_MM * 0.70, places=6)
        self.assertAlmostEqual(dp.PEAK_MAX_MM, dp.ROUND_DIA_MM * 1.30, places=6)


if __name__ == "__main__":
    unittest.main()
