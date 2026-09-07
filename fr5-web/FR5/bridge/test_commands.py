# 이 파일의 `settle_seconds` 검사는 **공식이 실측을 따라가는지**를 잰다. 그래서 전역 속도
# 오버라이드를 **기준선으로 명시해** 부른다 — 인자를 비우면 「모름」이라 대기가 하한 가정으로
# 늘어나고(계약 §speed), 그건 공식의 정확도가 아니라 **모를 때의 정책**이다. 그 정책은
# `test_adapter_guard.SettleFactor` 가 따로 지킨다. 둘을 한 검사에 섞으면 어느 쪽이 깨졌는지
# 모른다 (2026-08-12 에 실제로 이 검사 둘이 그렇게 빨개졌다).
# 이동 정착 대기 단위 테스트 — **실기 실측이 정답지다** (2026-08-08 · `evidence/2026-08-08/`).
#
# 이 값이 모자라면 이동 중에 다음 명령이 들어가고, **거부 없이 팔의 목표가 조용히 바뀐다**
# (실기 확인: 5° 세 번을 0.35초 간격으로 → 15° 가 아니라 7.48° 만 갔다). 조건 6 은 큐가
# 0 이라 헛돌고 조건 8 은 상한이 조그 상한과 같아 못 잡는다 — **이 대기가 유일한 장치다.**
import unittest

from commands import (SPEED_OVERRIDE_BASELINE_PCT, JOINT_DEG_S_AT_FULL, MOVE_REGISTER_S, MOVE_SETTLE_CAP_S,
                      settle_seconds)

HOME = [0.0] * 6

# (Δ°, speedPct, 실측 초) — j1 · 각 2회의 대표값. `trial3.py` 스윕 원본
MEASURED = [(1, 10, 0.68), (2, 10, 1.00), (4, 10, 1.70), (5, 10, 2.04),
            (5, 5, 3.65), (5, 3, 5.91)]


def moved(deg):
    return [deg] + [0.0] * 5


class SettleSecondsTest(unittest.TestCase):
    def test_실측보다_짧으면_안_된다(self):
        """**이 테스트가 이 파일의 전부다.** 짧으면 겹치고, 겹치면 조용히 어긋난다."""
        for deg, spd, real in MEASURED:
            got = settle_seconds(HOME, moved(deg), spd)
            self.assertGreaterEqual(got, real, f"{deg}° {spd}% — 예측 {got:.2f}s < 실측 {real:.2f}s")

    def test_그렇다고_과하게_길지도_않다(self):
        # 30% 넘게 여유를 주면 사람이 "왜 이렇게 굼뜨지" 를 느낀다. 보수적이되 붙어 있어야 한다
        for deg, spd, real in MEASURED:
            self.assertLess(settle_seconds(HOME, moved(deg), spd, SPEED_OVERRIDE_BASELINE_PCT),
                            real * 1.3)

    def test_벤더_사양이_아니라_실측을_쓴다(self):
        # 180°/s(관절 기계적 최대)를 쓰면 대기가 6배 짧아진다 — 2026-08-07 에 실제로 그랬다.
        # `MoveJ` 의 vel 백분율은 기계적 최대의 백분율이 **아니다**
        self.assertLess(JOINT_DEG_S_AT_FULL, 40.0)

    def test_속도를_낮추면_더_기다린다(self):
        # 속도 조절기(P5)가 이 성질에 기댄다 — 안 늘어나면 느린 이동에서 겹친다
        self.assertGreater(settle_seconds(HOME, moved(5), 3), settle_seconds(HOME, moved(5), 10))

    def test_상한이_지점이동을_덮는다(self):
        # 조그 최대(5°·3%)와 실기 지점 사이(46.2°·10%)가 상한 안이어야 한다.
        # **46.2° 는 지어낸 값이 아니다** — 실기 슬롯 `home → 1` 의 실제 Δ 이고,
        # 옛 상한 12초가 그걸 4.3초 잘라 연속 실행이 거부됐다 (2026-08-08)
        self.assertLess(settle_seconds(HOME, moved(5), 3), MOVE_SETTLE_CAP_S)
        self.assertLess(settle_seconds(HOME, moved(46.2), 10), MOVE_SETTLE_CAP_S)

    def test_상한을_넘으면_자르지_않고_죽는다(self):
        """**자르면 도착 전에 응답이 나간다** — 그러면 화면이 그걸 도착으로 읽는다.

        그리퍼 `gripper_maxtime_ms` 와 같은 규약이다: 조용히 나쁜 값을 쓰는 것보다
        안 보내는 게 낫다. 호출자는 **보내기 전에** 물어보고 사유를 돌려준다.
        """
        with self.assertRaises(ValueError):
            settle_seconds(HOME, moved(180), 3)          # 208초 — 상한 밖
        # 사유가 사람에게 무엇을 하라고 말해야 한다
        try:
            settle_seconds(HOME, moved(180), 3)
        except ValueError as e:
            self.assertIn("속도를 올리거나", str(e))

    def test_잘린_대기가_남기는_구간이_없다(self):
        # 옛 `min()` 은 상한 근처에서 **조금만** 자르는 구간이 제일 위험했다 — 그때는
        # 드리프트가 5° 상한 안이라 겹침이 조용히 통과한다. 이제 그 구간 자체가 없다:
        # 상한 안이면 필요한 만큼 정확히 기다리고, 밖이면 아예 안 보낸다
        deg_s = JOINT_DEG_S_AT_FULL * 10 / 100.0
        just_inside = (MOVE_SETTLE_CAP_S - MOVE_REGISTER_S) * deg_s * 0.999
        self.assertAlmostEqual(
            settle_seconds(HOME, moved(just_inside), 10, SPEED_OVERRIDE_BASELINE_PCT),
            MOVE_REGISTER_S + just_inside / deg_s, places=6)

    def test_못_읽으면_등록_시간만(self):
        # 현재 자세가 없거나 속도가 비정상이면 **추측하지 않는다** — 게이트가 어차피 막는다
        for bad in ([], None, ["x"] * 6):
            self.assertEqual(settle_seconds(bad, moved(5), 10), MOVE_REGISTER_S)
        for spd in (0, -1, None, "빠르게"):
            self.assertEqual(settle_seconds(HOME, moved(5), spd), MOVE_REGISTER_S)

    def test_가장_많이_움직인_관절이_정한다(self):
        # 한 축만 보면 나머지가 늦게 도착한다 — MoveJ 는 전 축을 비례로 움직인다
        self.assertEqual(settle_seconds(HOME, [1, 2, 9, 0, 0, 0], 10),
                         settle_seconds(HOME, moved(9), 10))


if __name__ == "__main__":
    unittest.main()


class 미리보기는_끝까지_검사한다(unittest.TestCase):
    """`dry_run` 이 **작업영역까지** 재나 (2026-09-04 회귀 · `commands.motion`).

    ⛔ 그 전에는 `check_motion` 에서 사유가 하나라도 나오면 **거기서 돌아갔다.** 실이동은
    그게 맞다 — 어차피 안 보낼 것을 더 계산할 이유가 없다. 그런데 `POST /ik` 는 사람이
    **계획하려고** 부르는 창구이고, 그때 제일 알고 싶은 것이 「손끝이 판을 뚫나」다.
    ARM 전에는 그 답이 **영영 안 나왔고**, 화면은 「작업영역 사유 없음」을 통과로 읽었다.
    ⭐ **「빈 결과는 통과 증거가 아니다」의 교과서 사례**라 시험으로 못 박는다.
    """

    def _cmds(self, *, enabled, ws_hit):
        import commands
        st = {"jointsDeg": [0.0] * 6, "tcpMmDeg": [0.0] * 6, "enabled": enabled,
              "mode": 0, "motionQueueLength": 0, "coord": {"toolId": 1, "userId": 1},
              # 결측=차단이라 안전 필드를 다 채운다 — 여기서 재려는 것은 그게 아니다
              "safety": {"emergencyStop": False, "safetyStop": False, "collisionDetected": False,
                         "inDragTeach": False, "mainErrorCode": 0, "subErrorCode": 0}}

        import time as _t

        class S:
            appliedSettings = {"payloadKg": 0.6, "cogMm": [0.0, 0.0, 30.0]}
            lastCommandedDeg = None
            lastStateAt = _t.time()
            lastState = st
            speedOverridePct = None
            adapter = type('A', (), {'forward_kin': staticmethod(lambda j: [0.0] * 6)})()
            workspace = None

            def read_fresh_state(self):
                return st

            def _coord_defs(self, coord):
                return {"user": [0.0] * 6, "tool": [0.0] * 6}

            def effective_workspace(self):
                return {"boxes": [{"name": "판", "xMm": [-1, 1], "yMm": [-1, 1],
                                   "topZMm": 0.0, "marginMm": 0}]}

        c = commands.Commands(S(), lambda *a: None)
        import safety
        self._orig = safety.check_workspace
        safety.check_workspace = lambda *a, **k: (["손끝이 판 안이다"] if ws_hit else [])
        self.addCleanup(lambda: setattr(safety, 'check_workspace', self._orig))
        return c

    def test_서보_OFF_라도_작업영역_사유가_나온다(self):
        c = self._cmds(enabled=False, ws_hit=True)
        got = c.motion([0.0] * 6, 10, False, True)
        self.assertTrue(any('서보' in r for r in got), got)
        self.assertTrue(any('판 안' in r for r in got),
                        f"운영 사유에 가려 작업영역 답이 사라졌다 — {got}")

    def test_서보_OFF_에_작업영역이_깨끗하면_그_사실도_나온다(self):
        c = self._cmds(enabled=False, ws_hit=False)
        got = c.motion([0.0] * 6, 10, False, True)
        self.assertEqual([r for r in got if '판 안' in r], [], got)
        self.assertTrue(any('서보' in r for r in got), got)

    def test_실이동은_여전히_첫_사유에서_끊는다(self):
        """미리보기만 바꿨다 — 안 보낼 이동을 더 계산하지 않는다."""
        c = self._cmds(enabled=False, ws_hit=True)
        got = c.motion([0.0] * 6, 10, False, False)
        self.assertEqual(got, ["서보 OFF (arm 이 안 됐다)"], got)
        # 작업영역까지 갔으면 「판 안이다」가 붙었을 것이다 — 안 붙은 것이 끊겼다는 증거다
