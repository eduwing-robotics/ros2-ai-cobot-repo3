#!/usr/bin/env python3
"""보존 게이트 단위 테스트 — 장비 없이 돈다. python3 -m unittest 로 실행."""
import unittest
from retention import should_store


def frame(**kw):
    f = {"connected": True, "enabled": False, "phase": "OBSERVE_ONLY",
         "motionQueueLength": 0, "jointsDeg": [0, 0, 0, 0, 0, 0],
         "gripper": {"pct": 30, "fault": False, "motionDone": True, "active": True},
         "safety": {k: (0 if k.endswith("Code") else False) for k in
                    ("emergencyStop", "safetyStop", "collisionDetected",
                     "inDragTeach", "mainErrorCode", "subErrorCode")}}
    f.update(kw)
    return f


class Retention(unittest.TestCase):
    def _stored(self, prev, cur):
        return should_store(prev, cur)[0]

    def test_first_always_stored(self):
        self.assertTrue(self._stored(None, frame()))

    def test_idle_skipped(self):
        # 연결됐지만 서보 꺼짐·정지·같은 관절 → 유휴, 건너뜀
        self.assertFalse(self._stored(frame(), frame()))

    def test_enabled_edge_stored(self):
        # 서보 온·오프는 **바뀌는 순간**에 싣는다
        self.assertTrue(self._stored(frame(), frame(enabled=True)))
        self.assertTrue(self._stored(frame(enabled=True), frame()))

    def test_armed_but_parked_skipped(self):
        """2026-08-10 실기 회귀 — 서보 올린 채 세워두면 건너뛴다.

        옛 게이트는 `enabled=1` 을 저장 조건으로 써서 이 상태를 전량 저장했다.
        실측: 10초·297프레임·건너뜀 0% · 관절 변동폭 0.0008° · 행당 4,124B → 9.85GB/일.
        """
        prev = frame(enabled=True, phase="ARMED")
        cur = frame(enabled=True, phase="ARMED",
                    jointsDeg=[0, 0, 0, 0, 0, 0.0008])   # 실측 변동폭 = ε 의 1/125
        self.assertFalse(self._stored(prev, cur))

    def test_gripper_move_stored_while_arm_parked(self):
        # 집기는 팔이 선 채 손만 움직인다 — 관절만 보면 파지 구간이 통째로 안 남는다
        prev = frame(enabled=True)
        cur = frame(enabled=True)
        cur["gripper"] = dict(prev["gripper"], pct=45)
        self.assertTrue(self._stored(prev, cur))

    def test_gripper_jitter_skipped(self):
        prev = frame()
        cur = frame(); cur["gripper"] = dict(prev["gripper"], pct=30.2)  # 0.2 < ε 0.5
        self.assertFalse(self._stored(prev, cur))

    def test_gripper_motion_done_transition_stored(self):
        # 파지 킬실험이 재려는 값 — 행정이 끝났다고 보고하는 순간
        prev = frame(enabled=True)
        cur = frame(enabled=True)
        cur["gripper"] = dict(prev["gripper"], motionDone=False)
        self.assertTrue(self._stored(prev, cur))

    def test_gripper_fault_transition_stored(self):
        prev = frame(enabled=True)
        cur = frame(enabled=True)
        cur["gripper"] = dict(prev["gripper"], fault=True)
        self.assertTrue(self._stored(prev, cur))

    def test_motion_queue_stored(self):
        self.assertTrue(self._stored(frame(), frame(motionQueueLength=3)))

    def test_joint_move_stored(self):
        cur = frame(jointsDeg=[0, 0, 0, 0, 0, 0.2])   # 0.2° > ε 0.1°
        self.assertTrue(self._stored(frame(), cur))

    def test_joint_jitter_skipped(self):
        cur = frame(jointsDeg=[0, 0, 0, 0, 0, 0.05])  # 0.05° < ε, 유휴
        self.assertFalse(self._stored(frame(), cur))

    def test_phase_transition_always_stored_even_when_idle(self):
        # 유휴여도 phase 가 바뀌면 저장 — 안전·중요
        self.assertTrue(self._stored(frame(phase="OBSERVE_ONLY"),
                                     frame(phase="OWNER_HELD")))

    def test_safety_transition_always_stored_even_when_idle(self):
        prev = frame()
        cur = frame(); cur["safety"] = dict(prev["safety"], emergencyStop=True)
        self.assertTrue(self._stored(prev, cur))

    def test_error_code_change_stored(self):
        prev = frame()
        cur = frame(); cur["safety"] = dict(prev["safety"], mainErrorCode=17)
        self.assertTrue(self._stored(prev, cur))

    def test_connected_transition_stored(self):
        self.assertTrue(self._stored(frame(connected=True),
                                     frame(connected=False)))

    def test_amr_pose_move_stored(self):
        prev = frame(jointsDeg=None, pose={"xMm": 0, "yMm": 0, "thetaDeg": 0})
        cur = frame(jointsDeg=None, pose={"xMm": 10, "yMm": 0, "thetaDeg": 0})  # 10mm > ε
        self.assertTrue(self._stored(prev, cur))

    def test_amr_pose_still_skipped(self):
        prev = frame(jointsDeg=None, pose={"xMm": 0, "yMm": 0, "thetaDeg": 0})
        cur = frame(jointsDeg=None, pose={"xMm": 1, "yMm": 0, "thetaDeg": 0.1})  # 1mm·0.1° < ε
        self.assertFalse(self._stored(prev, cur))


if __name__ == "__main__":
    unittest.main()
