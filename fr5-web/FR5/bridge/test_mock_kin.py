# mock 기구학 — **실기와 같은가**, 그리고 **못 풀 때 None 인가** (2026-09-06 · GRILL-conveyor-twin #5).
#
# mock 의 FK/IK 는 그림용이지만, 그림이 실기와 다르면 집에서 본 시연이 랩에서 거짓이 된다.
# 그래서 실기 컨트롤러가 낸 (관절, 손끝) 쌍(`Sim/fixtures/fr5-lab-a.json` fkSamples)에 댄다 —
# 시뮬 기구학을 대조하는 유일한 실기 근거다.
import json
import math
import random
import unittest
from pathlib import Path

import safety
from robot_adapter.mock import JOINTS_BASE, MockFr5Adapter

FIXTURE = Path(__file__).resolve().parents[2] / "Sim" / "fixtures" / "fr5-lab-a.json"
FK_POS_TOL_MM = 2.0     # URDF 와 실기 링크 치수 차 — 실측 1.3mm (2026-09-06)
FK_ROT_TOL_DEG = 0.1    # 실측 0.005°


def _lab():
    return MockFr5Adapter({"robotId": "fr5-lab-a"}), json.loads(FIXTURE.read_text(encoding="utf-8"))


class 실기와_같다(unittest.TestCase):
    def test_fk_matches_controller_samples(self):
        """실기 `GetForwardKin` 표본과 위치 ≤2mm · 회전 ≤0.1° — 얼린 tool/user 좌표계 그대로."""
        a, fx = _lab()
        self.assertTrue(fx["fkSamples"], "fkSamples 가 비었다 — 대조할 실기 근거가 없다")
        for s in fx["fkSamples"]:
            got = a.forward_kin(s["jointsDeg"])
            exp = s["tcpMmDeg"]
            self.assertLess(math.dist(got[:3], exp[:3]), FK_POS_TOL_MM, (got, exp))
            for k in range(3, 6):
                self.assertLess(abs(got[k] - exp[k]), FK_ROT_TOL_DEG, (k, got, exp))

    def test_ik_recovers_controller_joints_from_home(self):
        """시뮬 탭이 실제로 묻는 모양 — home 자세를 참조로 집기 손끝을 풀면 실기 관절해와 같은 가지."""
        a, fx = _lab()
        s = fx["fkSamples"][0]
        home = fx["slots"][0]["points"]["home"]
        q = a.inverse_kin(s["tcpMmDeg"], home)
        self.assertIsNotNone(q)
        self.assertLess(max(abs(x - y) for x, y in zip(q, s["jointsDeg"])), 0.5, (q, s["jointsDeg"]))
        self.assertLess(math.dist(a.forward_kin(q)[:3], s["tcpMmDeg"][:3]), FK_POS_TOL_MM)

    def test_ik_roundtrip_random_poses(self):
        """FK→IK→FK 왕복 — 관절 한계의 60% 안 무작위 자세 40개, 참조는 ±10° 흔든 것."""
        a, _ = _lab()
        rng = random.Random(20260906)
        for _ in range(40):
            j = [rng.uniform(lo * 0.6, hi * 0.6) for lo, hi in safety.JOINT_LIMITS_DEG]
            f = a.forward_kin(j)
            q = a.inverse_kin(f, [v + rng.uniform(-10, 10) for v in j])
            self.assertIsNotNone(q, j)
            self.assertLess(math.dist(a.forward_kin(q)[:3], f[:3]), 0.6, (j, q))


class 실기_readback_과_같다(unittest.TestCase):
    def test_mock_lab_start_pose_matches_2026_07_31_readback(self):
        """`fr5-mock-lab`(실기 좌표계 tool1/user1 빌림)의 시작 자세 손끝이 2026-07-31 실기 readback 과 같다 —
        fkSamples 와 독립인 두 번째 실기 근거. 옛 `TCP_BASE` 상수가 바로 이 값이었다."""
        m = MockFr5Adapter({"robotId": "fr5-mock-lab", "fixture": "fr5-lab-a"})
        tcp = m.forward_kin(JOINTS_BASE)
        readback = [227.570862, -62.282482, 56.726894, -173.889771, 0.986040, 2.315017]
        self.assertLess(math.dist(tcp[:3], readback[:3]), 1.5, tcp)
        for k in range(3, 6):
            self.assertLess(abs(tcp[k] - readback[k]), FK_ROT_TOL_DEG, (k, tcp))

    def test_ik_picks_branch_nearest_to_reference(self):
        """시작 자세에서 반대편 집기 자리를 풀면 **참조에 가까운 가지**(팔꿈치 위 · j2<0)를 준다 —
        한 시작점에서만 풀면 관절 거리 649° 짜리 뒤집힌 해가 나왔다 (2026-09-06 실측)."""
        m = MockFr5Adapter({"robotId": "fr5-mock-lab", "fixture": "fr5-lab-a"})
        grasp = [657.208, -1102.995, -366.004, 178.825, -1.325, -90.301]   # props.CARRIER_GRASP_TRUTH
        q = m.inverse_kin(grasp, JOINTS_BASE)
        self.assertIsNotNone(q)
        self.assertLess(q[1], 0.0, q)
        self.assertLess(sum(abs(a - b) for a, b in zip(q, JOINTS_BASE)), 420.0, q)
        self.assertLess(math.dist(m.forward_kin(q)[:3], grasp[:3]), 0.6)


class 못_풀면_None(unittest.TestCase):
    def test_ik_none_when_unreachable_or_bad_input(self):
        """도달 밖·잘못된 입력은 None — 게이트가 「해가 없다」 경로를 실제로 밟아야 한다."""
        a, _ = _lab()
        self.assertIsNone(a.inverse_kin([3000.0, 0.0, 0.0, 180.0, 0.0, 0.0], JOINTS_BASE))
        self.assertIsNone(a.inverse_kin([0.0, 0.0], JOINTS_BASE))
        self.assertIsNone(a.inverse_kin([float("nan")] * 6, JOINTS_BASE))
        self.assertIsNone(a.forward_kin(["x"] * 6))


class 얼린_좌표계가_없으면_base(unittest.TestCase):
    def test_mock_a_without_fixture_reports_base_frame(self):
        """fr5-mock-a 는 base·툴 없음 — 손끝은 플랜지면이고 6개를 다 준다."""
        m = MockFr5Adapter({"robotId": "fr5-mock-a"})
        tcp = m.forward_kin(JOINTS_BASE)
        self.assertEqual(len(tcp), 6)
        self.assertTrue(all(math.isfinite(v) for v in tcp))
        # `config.yaml` fr5-mock-a 작업영역 머리말의 숫자 — 어긋나면 게이트 검사 기대치가 통째로 틀어진다
        self.assertLess(math.dist(tcp[:3], [-171.6, 420.4, 533.9]), 0.5, tcp)


if __name__ == "__main__":
    unittest.main()
