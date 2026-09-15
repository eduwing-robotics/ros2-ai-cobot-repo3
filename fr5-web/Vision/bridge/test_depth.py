# 깊이 판정 단위 — 카메라 없이 돈다 (그게 `depth.py` 를 가른 이유다).
# 표준 라이브러리 unittest 만 쓴다 (`FR5/bridge/test_safety.py` 와 같은 규약).
import unittest

import numpy as np

import depth


class ValidRatios(unittest.TestCase):
    def test_포화_65535_를_유효로_세지_않는다(self):
        # 실기에서 무효는 0 만이 아니다 — 포화 쓰레기가 섞여 나온다. "0 이 아니면 유효" 는
        # 이 프레임을 100% 로 읽는다. 그게 이 함수가 있는 이유다
        z = np.full((30, 30), 65535, dtype=np.uint16)
        self.assertEqual(depth.valid_ratios(z, 105), (0.0, 0.0))

    def test_0_도_유효가_아니다(self):
        z = np.zeros((30, 30), dtype=np.uint16)
        self.assertEqual(depth.valid_ratios(z, 105), (0.0, 0.0))

    def test_MinZ_아래는_버린다(self):
        # 105mm 모드에서 90mm 는 "가까운 값" 이 아니라 **없는 값**이다
        z = np.full((30, 30), 90, dtype=np.uint16)
        self.assertEqual(depth.valid_ratios(z, 105)[0], 0.0)

    def test_경계는_포함이다(self):
        z = np.full((30, 30), 105, dtype=np.uint16)
        self.assertEqual(depth.valid_ratios(z, 105)[0], 1.0)

    def test_상한_밖은_버린다(self):
        z = np.full((30, 30), 5000, dtype=np.uint16)
        self.assertEqual(depth.valid_ratios(z, 105, 4000)[0], 0.0)

    def test_중앙이_먼저_죽는_프레임을_전체비율이_가린다(self):
        # 2026-08-05 실측의 모양 — 가장자리는 살아 있고 중앙만 죽는다.
        # 전체만 보면 "좀 나오네" 에 속는다. 그래서 판정은 중앙으로 한다
        z = np.full((30, 30), 200, dtype=np.uint16)
        z[10:20, 10:20] = 0
        whole, center = depth.valid_ratios(z, 105)
        self.assertAlmostEqual(whole, 800 / 900)
        self.assertEqual(center, 0.0)
        self.assertGreater(whole, 0.8)   # 전체만 보면 통과시켰을 값이다

    def test_중앙은_1_3_이다(self):
        z = np.zeros((30, 30), dtype=np.uint16)
        self.assertEqual(depth.center_view(z).shape, (10, 10))

    def test_3으로_안_나뉘어도_빈_배열이_아니다(self):
        # 빈 배열이면 mean() 이 nan 을 내고, nan 비교는 전부 False 라 **조용히 차단**된다.
        # 차단 쪽이라 안전하지만 사유가 틀리게 나온다
        for n in (1, 2, 4, 5, 7):
            with self.subTest(n=n):
                self.assertGreater(depth.center_view(np.zeros((n, n), dtype=np.uint16)).size, 0)

    def test_빈_프레임은_0_이다(self):
        self.assertEqual(depth.valid_ratios(None, 105), (0.0, 0.0))


class Judge(unittest.TestCase):
    def test_임계값이_없으면_차단이다(self):
        # 제1원칙 — 값을 못 읽으면 통과가 아니라 차단이다. 아무도 실측 안 한 상태를
        # "괜찮다" 로 읽으면 사각지대에서 뜬 좌표가 그럴듯하게 흘러 나간다
        valid, reason = depth.judge(0.99, None)
        self.assertFalse(valid)
        self.assertEqual(reason, depth.THRESHOLD_UNSET)

    def test_사유를_가른다(self):
        # 못 고치는 것(임계값 미실측)과 지금 자세 탓(사각지대)은 다른 얼굴이어야 한다
        self.assertEqual(depth.judge(0.01, 0.5)[1], depth.BELOW_THRESHOLD)
        self.assertNotEqual(depth.judge(0.01, 0.5)[1], depth.judge(0.01, None)[1])

    def test_통과하면_사유가_없다(self):
        self.assertEqual(depth.judge(0.6, 0.5), (True, None))

    def test_임계값과_같으면_통과다(self):
        self.assertTrue(depth.judge(0.5, 0.5)[0])


class 실측표본(unittest.TestCase):
    """2026-08-05 높이 스윕(`docs/evidence/2026-08-05/cam-fov.md` §높이 스윕)의 **중앙 1/3 유효율**을
    그대로 박는다. 임계값을 누가 조용히 옮기면 여기가 먼저 빨개진다 — 그 숫자는 취향이 아니라
    실측이고, 실측을 바꾸려면 다시 재야 한다."""

    THRESHOLD = 0.50
    # (렌즈~물체 mm, 모드, 중앙 유효율) — 죽은 것과 산 것
    죽음 = [(87, '848x480', .009), (87, '640x360', .004), (87, '480x270', .002),
            (95, '848x480', .012), (95, '640x360', .003), (95, '480x270', .000),
            (95, '424x240', .015), (115, '848x480', .020), (115, '640x360', .013),
            (138, '848x480', .032), (152, '848x480', .021), (87, '424x240', .076)]
    삶 = [(115, '480x270', .702), (115, '424x240', .803), (138, '480x270', .827),
          (138, '424x240', .828), (152, '640x360', .831), (152, '480x270', .842),
          (152, '424x240', .843), (236, '848x480', .818), (236, '640x360', .833),
          (333, '848x480', .737), (333, '424x240', .782)]

    def test_죽은_자세는_전부_막힌다(self):
        for mm, mode, c in self.죽음:
            with self.subTest(f'{mm}mm {mode}'):
                self.assertFalse(depth.judge(c, self.THRESHOLD)[0], f'{c:.1%} 가 통과했다')

    def test_산_자세는_전부_통과한다(self):
        for mm, mode, c in self.삶:
            with self.subTest(f'{mm}mm {mode}'):
                self.assertTrue(depth.judge(c, self.THRESHOLD)[0], f'{c:.1%} 가 막혔다')

    def test_임계값이_틈_안에_있다(self):
        # 죽은 것의 최대 7.6% 와 산 것의 최소 70.2% 사이가 통째로 비어 있다.
        # 임계값이 이 틈 밖으로 나가면 실측 표본 중 하나가 반대로 판정된다
        self.assertGreater(self.THRESHOLD, max(c for *_, c in self.죽음))
        self.assertLess(self.THRESHOLD, min(c for *_, c in self.삶))

    def test_전체비율로_판정했으면_속았다(self):
        # 424x240 @ 95mm 는 **전체 22.2%** 인데 중앙은 1.5% 다 — 경계에선 중앙이 먼저 죽고,
        # 가장자리(37.4%)가 전체를 끌어올린다. 계약이 중앙으로 판정하라고 한 이유가 이것이다
        self.assertTrue(depth.judge(0.222, 0.20)[0])      # 전체로 봤다면 통과했을 것이다
        self.assertFalse(depth.judge(0.015, 0.20)[0])     # 중앙으로 보면 막힌다


class MinZ(unittest.TestCase):
    def test_모르는_해상도는_0_이_아니라_None_이다(self):
        # 0 을 주면 전 픽셀이 유효로 세어져 **조용히 통과**한다
        self.assertIsNone(depth.min_z_mm({"848x480": 195}, "1920x1080"))

    def test_표를_그대로_읽는다(self):
        self.assertEqual(depth.min_z_mm({"424x240": 105}, "424x240"), 105)


class CleanMm(unittest.TestCase):
    """계약 §깊이 스냅샷 — 비율과 **같은 규칙**으로 비운 밀리미터 정수 배열."""

    def test_유효밖은_0_으로_비운다(self):
        z = np.array([[0, 90, 105], [200, 4000, 65535]], dtype=np.uint16)
        got = depth.clean_mm(z, 105, 4000)
        # 90 은 Min-Z 아래 · 65535 는 포화 · 0 은 원래 없음 → 셋 다 0.
        # 105 와 4000 은 **경계 포함**이라 살아남는다
        self.assertEqual(got.tolist(), [[0, 0, 105], [200, 4000, 0]])

    def test_정수_밀리미터로_낸다(self):
        z = np.full((4, 4), 210.7, dtype=np.float32)
        self.assertEqual(depth.clean_mm(z, 105).dtype, np.uint16)

    def test_MinZ_를_모르면_None(self):
        # 범위를 모르는 채로 비우면 무엇을 버렸는지 아무도 모른다 — 비율이 fail-closed 인데
        # 스냅샷만 나가면 두 판정이 갈린다
        z = np.full((4, 4), 200, dtype=np.uint16)
        self.assertIsNone(depth.clean_mm(z, None))

    def test_비율과_같은_규칙을_쓴다(self):
        # 이 둘이 갈리면 "유효 90%" 인데 스냅샷엔 값이 없는 일이 난다 (D103)
        rng = np.random.default_rng(7)
        z = rng.integers(0, 65535, size=(40, 40)).astype(np.uint16)
        whole, _ = depth.valid_ratios(z, 105, 4000)
        nonzero = float((depth.clean_mm(z, 105, 4000) > 0).mean())
        self.assertAlmostEqual(whole, nonzero, places=9)


if __name__ == "__main__":
    unittest.main()
