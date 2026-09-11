"""정렬 컬러의 분홍 ROI·황동 연결 성분 — 카메라 없이 도는 최소 회귀 시험."""
import importlib.util
import math
import unittest
from pathlib import Path

import cv2
import numpy as np


P = Path(__file__).with_name("carrier-find.py")
S = importlib.util.spec_from_file_location("carrierfind_tested", P)
cf = importlib.util.module_from_spec(S)
S.loader.exec_module(cf)

K = {"fx": 425.9, "fy": 425.9, "ppx": 427.0, "ppy": 247.3}


def scene(center, yaw_deg, bullets=((10, -5),)):
    """실물처럼 분홍 외곽·격자 안에 황동 원을 그린다."""
    img = np.full((480, 848, 3), (24, 28, 25), np.uint8)
    c = np.array(center, float)
    a = math.radians(yaw_deg)
    R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])

    outer = cv2.boxPoints((tuple(c), (90, 110), yaw_deg)).astype(np.int32)
    inner = cv2.boxPoints((tuple(c), (70, 90), yaw_deg)).astype(np.int32)
    pink, dark = (190, 95, 205), (30, 24, 31)
    cv2.fillConvexPoly(img, outer, pink)
    cv2.fillConvexPoly(img, inner, dark)
    for x in range(-30, 31, 15):
        p0, p1 = c + R @ np.array([x, -45]), c + R @ np.array([x, 45])
        cv2.line(img, tuple(p0.astype(int)), tuple(p1.astype(int)), pink, 3)
    for y in range(-37, 38, 15):
        p0, p1 = c + R @ np.array([-35, y]), c + R @ np.array([35, y])
        cv2.line(img, tuple(p0.astype(int)), tuple(p1.astype(int)), pink, 3)
    expected = []
    for off in bullets:
        p = c + R @ np.array(off, float)
        cv2.circle(img, tuple(p.astype(int)), 7, (35, 75, 145), -1)
        cv2.circle(img, tuple(p.astype(int)), 3, (24, 32, 55), -1)
        expected.append(p)
    return img, expected


class 분홍ROI황동총알(unittest.TestCase):
    def test_발자국은_조각_PCA가_아니라_외곽_껍질로_판정한다(self):
        want = sorted(cf.load_props()[:2])
        self.assertTrue(cf.footprint_fits([85.5, 104.0], want))

    def test_큰_외곽과_화면에_잘린_외곽은_계속_거부한다(self):
        want = sorted(cf.load_props()[:2])
        self.assertFalse(cf.footprint_fits([125.0, 145.0], want))
        self.assertFalse(cf.footprint_fits([85.5, 104.0], want, clipped=True))

    def test_컬러_광학점을_깊이_광학점으로_되돌린다(self):
        extr = {"rotationRowMajor": [0, -1, 0, 1, 0, 0, 0, 0, 1],
                "translationMm": [10, 20, 30]}
        self.assertEqual(cf.transform_point([1, 2, 3], extr), [8.0, 21.0, 33.0])

    def test_다섯_위치와_여섯_요각에서_한개를_찾는다(self):
        cases = [((170, 135), -42), ((425, 130), -15), ((675, 145), 0),
                 ((235, 340), 31), ((610, 330), 63), ((430, 255), 86)]
        for center, yaw in cases:
            with self.subTest(center=center, yaw=yaw):
                img, expected = scene(center, yaw)
                got, pixels, why = cf.find_bullets_rgb(img, center, 95, 310.0, K)
                self.assertEqual(len(got or []), 1, why)
                self.assertLess(np.linalg.norm(np.array(pixels[0]) - expected[0]), 2.0)

    def test_총알이_둘이면_둘을_숨기지_않는다(self):
        img, _ = scene((425, 240), 25, bullets=((-14, -4), (15, 8)))
        got, _pixels, why = cf.find_bullets_rgb(img, (425, 240), 95, 310.0, K)
        self.assertEqual(len(got or []), 2, why)

    def test_황동색처럼_보이는_저채도_격자점은_버린다(self):
        center = np.array([425, 240])
        img, expected = scene(center, 0)
        dim_grid = cv2.cvtColor(np.uint8([[[8, 58, 90]]]), cv2.COLOR_HSV2BGR)[0, 0]
        cv2.circle(img, tuple(center + np.array([-12, 20])), 7, tuple(int(v) for v in dim_grid), -1)
        got, pixels, why = cf.find_bullets_rgb(img, center, 95, 310.0, K)
        self.assertEqual(len(got or []), 1, why)
        self.assertLess(np.linalg.norm(np.array(pixels[0]) - expected[0]), 2.0)

    def test_밝은_황동_하이라이트를_잘라_한_총알을_조각내지_않는다(self):
        center = np.array([425, 240])
        img, expected = scene(center, 0)
        p = expected[0].astype(int)
        bright_brass = cv2.cvtColor(np.uint8([[[18, 130, 255]]]), cv2.COLOR_HSV2BGR)[0, 0]
        dark_center = cv2.cvtColor(np.uint8([[[18, 100, 150]]]), cv2.COLOR_HSV2BGR)[0, 0]
        cv2.circle(img, tuple(p), 8, tuple(int(v) for v in bright_brass), -1)
        cv2.circle(img, tuple(p), 3, tuple(int(v) for v in dark_center), -1)
        got, pixels, why = cf.find_bullets_rgb(img, center, 95, 310.0, K)
        self.assertEqual(len(got or []), 1, why)
        self.assertLess(np.linalg.norm(np.array(pixels[0]) - expected[0]), 2.0)

    def test_한_총알의_위아래_반사조각은_작은_틈만_이어_하나로_본다(self):
        center = np.array([425, 240])
        img, _ = scene(center, 0, bullets=())
        p = center + np.array([10, -5])
        brass = cv2.cvtColor(np.uint8([[[18, 130, 255]]]), cv2.COLOR_HSV2BGR)[0, 0]
        for dy in (-9, 9):
            cv2.ellipse(img, tuple(p + np.array([0, dy])), (10, 7), 0, 0, 360,
                        tuple(int(v) for v in brass), -1)
        got, pixels, why = cf.find_bullets_rgb(img, center, 95, 310.0, K)
        self.assertEqual(len(got or []), 1, why)
        self.assertLess(np.linalg.norm(np.array(pixels[0]) - p), 2.0)

    def test_분홍_ROI가_없으면_지어내지_않는다(self):
        img = np.zeros((480, 848, 3), np.uint8)
        got, pixels, why = cf.find_bullets_rgb(img, (425, 240), 95, 310.0, K)
        self.assertIsNone(got)
        self.assertEqual(pixels, [])
        self.assertIn("분홍 ROI", why)


if __name__ == "__main__":
    unittest.main()
