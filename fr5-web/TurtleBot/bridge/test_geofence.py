# 지오펜스 단위 — 조건 하나하나가 막는가 (TB-CONTRACT §지오펜스).
# 로봇도 브리지도 없이 돈다. 표준 unittest 만 — 새 의존성 0.
import unittest

import geofence

RECT = {"frame": "odom", "inset_mm": 163,
        "polygon_mm": [[-400, -250], [400, -250], [400, 250], [-400, 250]]}
# ㄱ자 — 작업대 3판의 실제 모양. 오목 다각형이라 사각형으로는 못 적는다
ELL = {"inset_mm": 100,
       "polygon_mm": [[0, 0], [800, 0], [800, 500], [300, 500], [300, 900], [0, 900]]}

FRESH = 0.1


def ev(raw, x, y, age=FRESH):
    return geofence.parse(raw).evaluate({"xMm": x, "yMm": y, "thetaDeg": 0}, age)


class Parse(unittest.TestCase):
    def test_none_is_off(self):
        self.assertIsNone(geofence.parse(None))          # 미설정 = 판정 안 함 (계약)

    def test_valid(self):
        f = geofence.parse(RECT)
        self.assertIsNone(f.error)
        self.assertEqual(len(f.polygon), 4)
        self.assertEqual(f.inset_mm, 163.0)
        self.assertEqual(f.frame, "odom")

    def test_frame_defaults_to_odom(self):
        self.assertEqual(geofence.parse(ELL).frame, "odom")

    def test_broken_shapes_are_refusals_not_crashes(self):
        for raw in (
            "사각형",                                                    # 매핑이 아님
            {"inset_mm": 163},                                          # polygon 없음
            {"inset_mm": 163, "polygon_mm": [[0, 0], [1, 1]]},          # 점 2개
            {"inset_mm": -1, "polygon_mm": RECT["polygon_mm"]},         # 음수 여유선
            {"inset_mm": "163", "polygon_mm": RECT["polygon_mm"]},      # 숫자 아님
            {"inset_mm": 10, "polygon_mm": [[0, 0], [1, "x"], [2, 2]]},  # 점이 숫자 아님
            {"inset_mm": 10, "polygon_mm": [[0, 0], [1, 1], [2, 2]]},   # 넓이 0 — 한 줄
        ):
            f = geofence.parse(raw)
            self.assertTrue(f.error, raw)
            st = f.evaluate({"xMm": 0, "yMm": 0}, FRESH)
            self.assertFalse(st["inside"])                # 깨진 설정은 통과가 아니라 정지
            self.assertIn("깨졌", st["reason"])


class Judgement(unittest.TestCase):
    def test_center_is_inside_with_margin(self):
        st = ev(RECT, 0, 0)
        self.assertTrue(st["inside"])
        self.assertEqual(st["marginMm"], 87.0)           # 250 − 163
        self.assertIsNone(st["reason"])

    def test_margin_band_is_outside(self):
        st = ev(RECT, 0, 100)                            # 판 위지만 여유선 안쪽 띠
        self.assertFalse(st["inside"])
        self.assertEqual(st["marginMm"], -13.0)          # 150 − 163
        self.assertIn("여유선 안쪽 띠", st["reason"])

    def test_off_the_board_is_negative_distance(self):
        st = ev(RECT, 0, 300)                            # 판 밖 50mm
        self.assertFalse(st["inside"])
        self.assertEqual(st["marginMm"], -213.0)         # −50 − 163
        self.assertIn("판 밖", st["reason"])

    def test_exact_inset_line_passes(self):
        self.assertTrue(ev(RECT, 0, 250 - 163)["inside"])   # 경계는 통과 (margin 0)

    def test_concave_notch_is_outside(self):
        self.assertFalse(ev(ELL, 600, 700)["inside"])    # ㄱ자의 파인 곳 — 사각형이면 놓친다
        self.assertTrue(ev(ELL, 150, 700)["inside"])     # 세로 팔 안
        self.assertTrue(ev(ELL, 400, 250)["inside"])     # 가로 팔 안


class FailClosed(unittest.TestCase):
    def test_no_pose(self):
        st = geofence.parse(RECT).evaluate(None, None)
        self.assertFalse(st["inside"])
        self.assertIsNone(st["marginMm"])
        self.assertIn("fail-closed", st["reason"])

    def test_stale_pose(self):
        st = ev(RECT, 0, 0, age=2.1)                     # 안쪽 한복판이어도 늙었으면 정지
        self.assertFalse(st["inside"])
        self.assertIn("fail-closed", st["reason"])

    def test_fresh_boundary_of_age(self):
        self.assertTrue(ev(RECT, 0, 0, age=2.0)["inside"])

    def test_nan_pose(self):
        st = geofence.parse(RECT).evaluate({"xMm": float("nan"), "yMm": 0}, FRESH)
        self.assertFalse(st["inside"])
        self.assertIn("숫자", st["reason"])


class BlocksMotion(unittest.TestCase):
    def setUp(self):
        self.f = geofence.parse(RECT)
        self.inside = ev(RECT, 0, 0)
        self.outside = ev(RECT, 0, 300)

    def test_no_fence_never_blocks(self):
        self.assertIsNone(geofence.blocks_motion(None, None, 150, 60))

    def test_inside_passes(self):
        self.assertIsNone(geofence.blocks_motion(self.f, self.inside, 150, 0))

    def test_outside_blocks_with_reason(self):
        why = geofence.blocks_motion(self.f, self.outside, 150, 0)
        self.assertIn("판 밖", why)                       # 사유가 있어야 화면에 닿는다 (D114)

    def test_outside_blocks_rotation_too(self):
        self.assertTrue(geofence.blocks_motion(self.f, self.outside, 0, 30))

    def test_stop_always_passes(self):
        # 밖에 나간 로봇을 세울 수단을 지오펜스가 뺏으면 안 된다 (계약)
        self.assertIsNone(geofence.blocks_motion(self.f, self.outside, 0, 0))

    def test_no_escape_direction(self):
        # 어느 방향이든 거부다 — 드리프트한 odom 으로 「안쪽」을 계산하다 틀리면 낙하다
        for lin, ang in ((150, 0), (-150, 0), (0, 60), (0, -60), (-1, -1)):
            self.assertTrue(geofence.blocks_motion(self.f, self.outside, lin, ang))


if __name__ == "__main__":
    unittest.main()
