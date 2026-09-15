"""글로벌캠 색 거치대 요각 — 원근 때문에 화소 장축이 뒤집혀도 실거리 장축을 고른다."""
import importlib.util
import unittest
from pathlib import Path

import cv2
import numpy as np


P = Path(__file__).with_name("color-find.py")
S = importlib.util.spec_from_file_location("colorfind_tested", P)
cf = importlib.util.module_from_spec(S)
S.loader.exec_module(cf)


class _Fixture:
    @staticmethod
    def lab_to_user1(point, _base, _user):
        return point


class 색거치대요각(unittest.TestCase):
    def test_화소로_짧아도_평면에서_긴_축을_고른다(self):
        mask = np.zeros((160, 160), np.uint8)
        cv2.rectangle(mask, (49, 40), (111, 120), 255, -1)  # 세로 80px > 가로 62px
        original = cf.to_lab
        cf.to_lab = lambda px, *_args: (np.array([px[0] * 2.0, px[1], 0.0]), None)
        try:
            yaw = cf._yaw_user1(mask, (80.0, 80.0), {"cal": {}, "base": {}}, 160, 0.0, [], _Fixture)
        finally:
            cf.to_lab = original
        self.assertAlmostEqual(yaw, 0.0, delta=0.2)  # 평면은 가로 약 124mm > 세로 약 80mm

    def test_평면에서_정사각이면_요각을_지어내지_않는다(self):
        mask = np.zeros((160, 160), np.uint8)
        cv2.rectangle(mask, (60, 40), (100, 120), 255, -1)
        original = cf.to_lab
        cf.to_lab = lambda px, *_args: (np.array([px[0] * 2.0, px[1], 0.0]), None)
        try:
            yaw = cf._yaw_user1(mask, (80.0, 80.0), {"cal": {}, "base": {}}, 160, 0.0, [], _Fixture)
        finally:
            cf.to_lab = original
        self.assertIsNone(yaw)


if __name__ == "__main__":
    unittest.main()
