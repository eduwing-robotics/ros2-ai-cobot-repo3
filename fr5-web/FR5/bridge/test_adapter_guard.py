# `_guard` 단위 테스트 — xmlrpc 상한과 **상한이 만든 오염**을 사람 말로 바꾸는 부분.
#
# 실기에서 이걸로 한 번 죽었다 (2026-08-05): 33° 이동이 블로킹 `MoveJ` 로 3초를 넘겨
# 스레드가 버려졌고, 버려진 스레드가 연결을 쥔 채라 이후 전부 `Request-sent` 였다.
# 화면에는 "상태 읽기 실패 — Request-sent" 만 떠서 네트워크 문제로 오인하기 딱 좋았다.
import http.client
import time
import unittest

from robot_adapter.fairino import (CMD_TIMEOUT_S, GRIPPER_MAXTIME_CAP_MS,
                                   GRIPPER_TIME_MARGIN, GRIPPER_VEL_FLOOR_PCT,
                                   _estop_reason, _guard, fault_text,
                                   gripper_maxtime_ms, gripper_stroke_s)

import safety
from commands import (SPEED_OVERRIDE_BASELINE_PCT, settle_factor, settle_seconds)


class Guard(unittest.TestCase):
    def test_정상값은_그대로_돌려준다(self):
        self.assertEqual(_guard(lambda: 42), 42)
        self.assertEqual(_guard(lambda a, b=0: a + b, 1, b=2), 3)

    def test_상한을_넘으면_사람이_읽는_사유로_던진다(self):
        t0 = time.time()
        with self.assertRaises(ConnectionError) as cm:
            _guard(lambda: time.sleep(CMD_TIMEOUT_S + 2))
        self.assertIn("응답 없음", str(cm.exception))
        # 상한만큼만 기다리고 호출자를 풀어 준다 — 브리지 전체가 서면 stop 도 못 나간다
        self.assertLess(time.time() - t0, CMD_TIMEOUT_S + 1.5)

    def test_오염된_연결은_Request_sent_가_아니라_재연결하라고_말한다(self):
        def poisoned():
            raise http.client.CannotSendRequest("Request-sent")
        with self.assertRaises(ConnectionError) as cm:
            _guard(poisoned)
        msg = str(cm.exception)
        self.assertIn("연결이 오염됐다", msg)
        self.assertIn("재연결", msg)
        self.assertIn("CannotSendRequest", msg)     # 원인도 남긴다 — 진단이 사라지면 안 된다

    def test_ResponseNotReady_도_같은_취급(self):
        def poisoned():
            raise http.client.ResponseNotReady()
        with self.assertRaises(ConnectionError) as cm:
            _guard(poisoned)
        self.assertIn("연결이 오염됐다", str(cm.exception))

    def test_다른_예외는_그대로_올린다(self):
        # 삼키면 진짜 원인이 사라진다 — 오염 변환은 두 이름에만 건다
        def boom():
            raise ValueError("진짜 원인")
        with self.assertRaises(ValueError):
            _guard(boom)


class FaultText(unittest.TestCase):
    """로봇 고장코드표(main/sub) → 사람 말. 정본은 manual.fairino.support §Appendix.

    이 표가 없어서 2026-08-08 에 30분을 썼다 — `6-2` 는 **지울 수 없는** 알람인데
    화면엔 숫자만 떠서 버튼·랜선·브리지 재시작으로 지우려 들었다. 정답은 전원 재투입 하나였다.
    """

    def test_정상은_아무것도_안_만든다(self):
        self.assertEqual(fault_text(0, 0), (None, None))

    def test_그날_그_코드(self):
        text, resettable = fault_text(6, 2)
        self.assertIn("슬레이브", text)                 # 버튼이 아니라 배선을 보게 만든다
        self.assertIn("전원 재투입", text)
        self.assertFalse(resettable)

    def test_슬레이브_계열은_sub_까지_구분한다(self):
        # 오프라인이냐 상태 불일치냐에 따라 사람이 볼 자리가 다르다
        self.assertIn("오프라인", fault_text(6, 1)[0])
        self.assertIn("미설정", fault_text(6, 3)[0])

    def test_리셋_되는_고장은_전원을_끄라고_하지_않는다(self):
        # 소프트리밋·충돌은 리셋으로 풀린다. 여기서 전원을 끄라고 하면 사람이 헛수고한다
        for main, sub in ((3, 1), (4, 7), (7, 1), (8, 1), (13, 5)):
            text, resettable = fault_text(main, sub)
            self.assertTrue(resettable, f"{main}-{sub}")
            self.assertNotIn("전원 재투입", text, f"{main}-{sub}")

    def test_main1_은_대부분_리셋되는데_넷만_아니다(self):
        self.assertTrue(fault_text(1, 1)[1])
        for sub in (20, 29, 30, 82):
            self.assertFalse(fault_text(1, sub)[1], f"1-{sub}")

    def test_드라이브_슬레이브_파일_계열은_통째로_리셋_불가(self):
        for main in (2, 5, 6, 9, 11):
            self.assertFalse(fault_text(main, 1)[1], main)

    def test_특이자세는_고장이_아니라_판정을_비운다(self):
        # 표에도 N/A 다. 여기서 False 를 주면 멀쩡한 로봇의 전원을 끄게 만든다
        text, resettable = fault_text(10, 1)
        self.assertIn("특이자세", text)
        self.assertIsNone(resettable)

    def test_모르는_코드는_지어내지_않는다(self):
        # 없는 값을 그럴듯하게 채우면 안전 판정이 조용히 통과한다 (evidence/2026-07-30 §정정)
        text, resettable = fault_text(99, 7)
        self.assertIn("99-7", text)
        self.assertIn("펜던트", text)
        self.assertIsNone(resettable)


class EstopReason(unittest.TestCase):
    """`-4` 를 받았을 때 20004 로 진짜 사유를 캐는 부분.

    2026-08-08 실기: 비상정지가 눌린 채였는데 화면 문구는 `xmlrpc 검증 실패 —
    GetSoftwareVersion=-4` 뿐이었다. 그걸 보고 랜선·죽은 소켓·컨트롤러 재부팅을 30분 뒤졌고,
    정답은 손 닿는 곳의 버튼이었다. **20004 는 급정지 중에도 흘러서 사유가 이미 손에 있었다.**
    """

    class _Pkg:                 # 배포본 RobotStatePkg 중 우리가 읽는 필드만
        def __init__(self, **kw):
            self.EmergencyStop = 0
            self.safety_stop0_state = 0
            self.safety_stop1_state = 0
            self.main_code = 0
            self.sub_code = 0
            self.__dict__.update(kw)

    class _RPC:
        def __init__(self, pkg):
            self.robot_state_pkg = pkg

    def test_급정지면_버튼을_짚어_준다(self):
        r = self._RPC(self._Pkg(EmergencyStop=1, main_code=3, sub_code=1))
        msg = _estop_reason(r)
        self.assertIn("비상정지", msg)
        self.assertIn("돌려 뽑", msg)      # 재부팅이 아니라 손으로 할 일을 말한다
        self.assertIn("3-1", msg)          # 고장코드도 남긴다 — 진단이 사라지면 안 된다

    def test_급정지인데_고장이_리셋_불가면_버튼만_말하지_않는다(self):
        # 2026-08-08 그 상황이다. 버튼은 이미 뽑혀 있었고 화면은 계속 버튼을 가리켰다
        msg = _estop_reason(self._RPC(self._Pkg(EmergencyStop=1, main_code=6, sub_code=2)))
        self.assertIn("슬레이브", msg)
        self.assertIn("전원 재투입", msg)

    def test_급정지가_아니어도_리셋_불가_고장이면_그걸_말한다(self):
        # -4 의 원인이 급정지만은 아니다. 리셋 불가 고장도 xmlrpc 를 전부 거부시킨다
        msg = _estop_reason(self._RPC(self._Pkg(main_code=6, sub_code=1)))
        self.assertIn("오프라인", msg)

    def test_안전정지_신호는_따로_구분한다(self):
        # SI0/SI1 은 버튼이 아니라 안전회로 입력이다. 같은 조치를 시키면 사람이 헛짚는다
        r = self._RPC(self._Pkg(safety_stop1_state=1))
        self.assertIn("SI0/SI1", _estop_reason(r))

    def test_안전은_멀쩡한데_xmlrpc_만_죽었으면_None(self):
        # 모르면 지어내지 않는다 — 호출자가 원래 `-4` 메시지를 그대로 쓴다
        self.assertIsNone(_estop_reason(self._RPC(self._Pkg())))

    def test_20004_도_안_오면_None(self):
        # pkg 가 아직 클래스면 첫 프레임 전이다. 이때는 진짜 통신 문제라 급정지로 단정 못 한다
        class _Empty:
            pass
        t0 = time.time()
        self.assertIsNone(_estop_reason(self._RPC(_Empty)))
        self.assertLess(time.time() - t0, 3.0)      # 연결 실패 경로가 오래 매달리면 안 된다

    def test_없는_필드를_읽어도_안_죽는다(self):
        # 배포본에 `alarmRebootRobot` 류는 없다 (evidence/2026-07-30 §정정).
        # 상류 SDK 기준으로 짜인 코드가 섞여 들어와도 여기서 AttributeError 로 죽으면 안 된다
        class _Bare:
            pass
        self.assertIsNone(_estop_reason(self._RPC(_Bare())))


class GripperMaxtime(unittest.TestCase):
    """`maxtime` 은 속도에서 유도된다 — 상수로 되돌리면 여기서 깨진다.

    되돌리는 것이 왜 위험한지: 2026-08-04 에 `vel 30% + maxtime 3000ms` 로 보냈다가
    컨트롤러가 `8/1 Gripper Movement timeout` 을 **래치**해 전원 재투입이 필요했다.
    """

    def test_지금_쓰는_속도에서_지금_값이_나온다(self):
        # 30% → 11500ms. **10000 이 아니다** — 2026-08-11 에 행정 상수를 1.0→1.15 로 정정했다
        # (10Hz 실측: vel 30 전 행정 닫기 3.54s · 열기 3.68s). 옛 값이면 대기가 3.333초라
        # 0.21~0.35초 짧아 `grip` 칸이 손가락이 움직이는 중에 다음 칸으로 넘어갔다.
        self.assertEqual(gripper_maxtime_ms(30), 11500)

    def test_속도를_낮추면_상한이_늘어난다(self):
        # 늘어나지 않으면 정상 이동이 상한과 겹쳐 래치가 난다 (그게 2026-08-04 이다)
        self.assertEqual(gripper_maxtime_ms(20), 17250)
        self.assertGreater(gripper_maxtime_ms(15), gripper_maxtime_ms(20))

    def test_하한은_계산에서_나온다_적어_둔_값이_아니다(self):
        # 10% 는 정확히 SDK 상한에 닿는다. 하한 상수가 그 사실과 맞는지 여기서 대조한다
        self.assertEqual(gripper_maxtime_ms(GRIPPER_VEL_FLOOR_PCT), GRIPPER_MAXTIME_CAP_MS)

    def test_하한_아래는_자르지_않고_죽는다(self):
        # **자르면 조용히 나쁜 값이 나간다.** 안 보내는 쪽이 낫다 — 래치는 전원으로만 풀린다
        for v in (9, 5, 1):
            with self.assertRaises(ValueError) as cm:
                gripper_maxtime_ms(v)
            self.assertIn("속도 하한", str(cm.exception))

    def test_말도_안_되는_속도도_거부한다(self):
        for v in (0, -1, 101, float("nan")):
            with self.assertRaises(ValueError):
                gripper_maxtime_ms(v)

    def test_대기시간과_상한이_같은_뿌리에서_나온다(self):
        """`grip` 칸의 대기(행정)와 SDK 상한(행정×여유)이 갈라지면 안 된다 (D103).

        갈라지는 순간 하나는 "다 움직였다" 로 보고 다른 하나는 아직 상한 안이라, 그 사이
        틈에서 다음 칸의 이동이 손가락과 겹친다.
        """
        # **하한 이상만 넣는다** — 하한 아래는 상한을 넘어 거부되는 것이 정상이고, 그건
        # `test_하한_아래는_자르지_않고_죽는다` 가 본다. 2026-08-11 에 하한이 10→11.5% 로
        # 올라가면서 옛 목록의 `10` 이 여기서 ValueError 를 냈다 (그 자체가 정상 동작이다).
        for v in (30, 20, 12, GRIPPER_VEL_FLOOR_PCT):
            with self.subTest(vel=v):
                self.assertAlmostEqual(
                    gripper_maxtime_ms(v), gripper_stroke_s(v) * 1000.0 * GRIPPER_TIME_MARGIN,
                    delta=1.0)
        self.assertAlmostEqual(gripper_stroke_s(30), 11.5 / 3, places=6)

    def test_대기시간도_말도_안_되는_속도를_거부한다(self):
        for v in (0, -1, 101, float("nan")):
            with self.assertRaises(ValueError):
                gripper_stroke_s(v)


class SettleFactor(unittest.TestCase):
    """전역 속도 오버라이드에 따른 대기 배수 (계약 §speed).

    ⛔ **이 테스트가 지키는 것은 「줄이지 않는다」다.** 기준선(28.9°/s 를 잰 날의 오버라이드)이
    **기록에 없어 가정**이라, 줄이는 방향으로 틀리면 응답이 「도착」인데 로봇은 아직 가는
    겹침이 된다 (D89). 늘리는 방향으로 틀리면 손해가 「느림」뿐이다.
    """

    def test_기준선에서는_그대로다(self):
        self.assertAlmostEqual(settle_factor(SPEED_OVERRIDE_BASELINE_PCT), 1.0)

    def test_낮으면_비례로_늘린다(self):
        self.assertAlmostEqual(settle_factor(10), 3.0)
        self.assertAlmostEqual(settle_factor(20), 1.5)

    def test_높아도_줄이지_않는다(self):
        # ⛔ 기준선이 가정이라 줄이는 쪽으로 틀리면 겹침이다
        for o in (31, 50, 100):
            with self.subTest(override=o):
                self.assertEqual(settle_factor(o), 1.0)

    def test_모르면_허용_하한을_가정한다(self):
        want = SPEED_OVERRIDE_BASELINE_PCT / safety.SPEED_OVERRIDE_MIN_PCT
        for bad in (None, 0, -5, "30"):
            with self.subTest(override=bad):
                self.assertAlmostEqual(settle_factor(bad), want)

    def test_대기가_배수만큼_길어진다(self):
        f = [0.0] * 6
        t = [5.0, 0, 0, 0, 0, 0]
        base = settle_seconds(f, t, 10, SPEED_OVERRIDE_BASELINE_PCT)
        self.assertAlmostEqual(settle_seconds(f, t, 10, 10), base * 3.0, places=6)
        # 인자를 안 주면 「모름」이라 하한 가정 — **짧아지는 일은 없다**
        self.assertGreaterEqual(settle_seconds(f, t, 10), base)


if __name__ == "__main__":
    unittest.main()
