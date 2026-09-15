# session.py 단위 테스트 — 안전 설정 되읽기 대조 (감사 2026-08-05 P0-3).
#
# 여기서 지키는 것 하나: **못 읽은 값은 통과가 아니라 차단이다.** `abs(nan - x) > tol` 은
# 파이썬에서 `False` 라, 부등호만 쓰면 NaN 되읽기가 조용히 "일치" 로 통과했다. 그러면
# 말단 하중·무게중심이 로봇에 안 들어간 채 ARM 된다 — 그 둘이 없으면 충돌 감지가 오작동한다.
import unittest

from session import SETTING_TOL, RobotSession, _within

NAN = float("nan")
SETTINGS = {"payloadKg": 0.6, "cogMm": [0.0, 0.0, 30.0]}


class Within(unittest.TestCase):
    def test_NaN_은_불일치다(self):
        self.assertFalse(_within(NAN, 0.6, SETTING_TOL["payloadKg"]))
        # 옛 구현이 통과시킨 이유를 같이 박아 둔다 — 이 사실이 바뀌면 테스트가 먼저 깨진다
        self.assertFalse(abs(NAN - 0.6) > SETTING_TOL["payloadKg"])

    def test_inf_와_결측도_불일치(self):
        for bad in (float("inf"), float("-inf"), None, "0.6", [], True):
            with self.subTest(got=bad):
                self.assertFalse(_within(bad, 0.6, SETTING_TOL["payloadKg"]))

    def test_허용_오차_안팎(self):
        self.assertTrue(_within(0.62, 0.6, 0.05))
        self.assertFalse(_within(0.70, 0.6, 0.05))
        # 정확한 경계(0.65)는 걸지 않는다 — `0.65 - 0.6 = 0.05000000000000004` 라
        # 이진 부동소수에서 안팎이 갈린다. 옛 구현(`> tol`)도 같은 쪽이었으니 변화는 없다.


class FakeAdapter:
    def __init__(self, readback):
        self._readback = readback
        self.applied = None

    def apply_settings(self, settings):
        self.applied = settings

    def read_settings(self):
        return self._readback


class ApplySettings(unittest.TestCase):
    def _session(self, readback):
        s = RobotSession(33, lambda *a: None)
        s.profile = {"robotId": "fr5-lab-a", "settings": SETTINGS}
        s.adapter = FakeAdapter(readback)
        return s

    def test_되읽기가_맞으면_통과(self):
        s = self._session({"payloadKg": 0.6, "cogMm": [0.0, 0.0, 30.0]})
        self.assertEqual(s.apply_settings()["mismatch"], [])

    def test_payload_가_NaN_이면_ARM_으로_못_간다(self):
        s = self._session({"payloadKg": NAN, "cogMm": [0.0, 0.0, 30.0]})
        with self.assertRaises(ConnectionError):
            s.apply_settings()
        self.assertIsNone(s.appliedSettings)   # 기록도 안 남는다 — 조건 26 이 막는다

    def test_cog_가_NaN_이면_차단(self):
        s = self._session({"payloadKg": 0.6, "cogMm": [NAN, NAN, NAN]})
        with self.assertRaises(ConnectionError):
            s.apply_settings()

    def test_cog_길이가_짧으면_차단(self):
        """`zip` 은 짧은 쪽에서 조용히 멈춘다 — 빈 목록이면 비교가 0회라 통과했다."""
        for short in ([], [0.0], [0.0, 0.0]):
            with self.subTest(cogMm=short):
                s = self._session({"payloadKg": 0.6, "cogMm": short})
                with self.assertRaises(ConnectionError):
                    s.apply_settings()

    def test_되읽기가_아예_비면_차단(self):
        s = self._session({})
        with self.assertRaises(ConnectionError):
            s.apply_settings()


if __name__ == "__main__":
    unittest.main()


class 손끝을_붙들어_둔다(unittest.TestCase):
    """`snapshot()` 이 만든 `tcpMmDeg` 를 **속성으로도 남기나** (2026-09-04 회귀).

    추종은 `session.tcpMmDeg` 를 읽는데 **그 속성이 존재한 적이 없었다** — 값은
    `snapshot()` 이 만드는 딕셔너리 안에만 살았다. 그래서 `follow_goal` 이 한 번도
    목표를 못 냈고, 화면엔 늘 「손끝 자세를 못 읽었다」만 떴다. 08-28 의 `session.user1`
    과 같은 병이라 **같은 병이 세 번째로 오기 전에** 시험으로 못 박는다.
    """

    class Adapter:
        def read_state(self):
            return {"jointsDeg": [0.0] * 6, "tcpMmDeg": [1.0, 2.0, 3.0, 180.0, 0.0, 90.0],
                    "coord": {"toolId": 1, "userId": 1}}

    def test_미연결이면_안_지어낸다(self):
        s = RobotSession(33, lambda *a: None)
        self.assertIsNone(getattr(s, "tcpMmDeg", None),
                          "안 읽었으면 없어야 한다 — 0 벡터를 손끝이라 부르지 않는다")

    def test_읽고_나면_속성으로_남는다(self):
        s = RobotSession(33, lambda *a: None)
        s.adapter, s.profile = self.Adapter(), {"robotId": "x"}
        snap = s.snapshot(None)
        self.assertEqual(s.tcpMmDeg, snap["tcpMmDeg"], "딕셔너리와 속성이 같은 값이어야 한다")
        self.assertGreater(s.tcpAt, 0, "잰 시각이 없으면 나이를 못 본다 — 낡은 손끝이 통과한다")
