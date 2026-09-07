# teleop 워치독 — 「500ms 조용하면 정지하고 idle 로 돌아간다」 (TB-CONTRACT §모드 전이).
# 회귀 방어: 2026-08-19 실기에서 정지(0,0)로 끝내자 mode 가 teleop 에 갇혔고,
# 그 상태로는 「시작은 idle 에서만」에 걸려 슬롯이 영영 안 떴다. real.py 도 같은 모양이었다.
import time
import unittest

from ros_adapter.mock import MockAdapter


class Watchdog(unittest.TestCase):
    def setUp(self):
        self.a = MockAdapter(["tb3_1"], lambda *a: None)

    def test_zero_command_still_returns_to_idle(self):
        self.a.set_velocity("tb3_1", 100, 0)
        self.assertEqual(self.a.robots()["tb3_1"]["mode"], "teleop")
        self.a.set_velocity("tb3_1", 0, 0)               # 정지로 끝낸다 — 여기가 갇히던 자리
        time.sleep(0.8)
        self.assertEqual(self.a.robots()["tb3_1"]["mode"], "idle")

    def test_moving_without_signal_stops(self):
        self.a.set_velocity("tb3_1", 100, 0)
        time.sleep(0.8)
        r = self.a.robots()["tb3_1"]
        self.assertEqual(r["mode"], "idle")
        self.assertEqual(r["velocity"]["linearMmS"], 0.0)

    def test_continuous_signal_keeps_teleop(self):
        for _ in range(6):                                # 조이스틱을 계속 쥐고 있는 경우
            self.a.set_velocity("tb3_1", 100, 0)
            time.sleep(0.15)
        self.assertEqual(self.a.robots()["tb3_1"]["mode"], "teleop")




class ResetOdom(unittest.TestCase):
    """원점 재설정 — 「여기가 (0,0,0)」 (계약 §원점 재설정)."""

    def test_zeroes_pose_and_trail(self):
        a = MockAdapter(["tb3_1"], lambda *x: None)
        a.set_velocity("tb3_1", 100, 0)
        time.sleep(0.4)
        self.assertNotEqual(a.robots()["tb3_1"]["pose"]["xMm"], 0.0)
        okey, why = a.reset_odom("tb3_1")
        self.assertTrue(okey, why)
        p = a.robots()["tb3_1"]["pose"]
        self.assertEqual((p["xMm"], p["yMm"], p["thetaDeg"]), (0.0, 0.0, 0.0))
        self.assertEqual(a.trail("tb3_1"), [])       # 옛 좌표계로 그린 궤적은 같이 버린다

if __name__ == "__main__":
    unittest.main()
