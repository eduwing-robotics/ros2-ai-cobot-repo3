"""한 번만 간다 — `POST /follow/step` (2026-09-04 · `VISION-CONTRACT.md` §한 번만 간다).

## 무엇을 재나 — **거부가 본론이다**

추종은 계약이 **켜는 조건 여덟**을 걸어 둔 기능이고, 이 창구는 그중 여섯을 매 호출마다
다시 본다. 그러니 시험의 대부분은 「간다」가 아니라 **「어떤 때 안 가나」**여야 한다.

  ① `confirm` 없이는 안 간다            (조건 1 — 현장에 사람)
  ② ARMED 가 아니면 안 간다             (조건 2)
  ③ 표적이 낡으면 안 간다               (조건 5 — **가는 것은 멈춘다**)
  ④ 게이트가 거부하면 안 간다           (조건 3 — 비전 전용 경로를 안 만든다)
  ⑤ 데드밴드 안이면 **안 간다**         (같은 자리를 두 번 안 간다)
  ⑥ 데드밴드는 옛 추종 목표가 아니라 최신 실제 TCP를 본다

⭐ **⑥ 이 회귀검사다.** 추종 사이에 제안 이동이 팔을 옮겨도 옛 추종 목표와 같다는 이유로
`moved:false`를 내면 촬영 시퀀스의 다음 추종이 실기 0건으로 끝난다.

⚠ `fastapi` 가 없으면 건너뛴다 (`test_stop_transport.py` 와 같은 이유).
"""
import time
import unittest

try:
    from fastapi.testclient import TestClient
    import main
    HAVE = True
except Exception:                                    # noqa: BLE001
    HAVE = False

GOAL = [500.0, -1200.0, -165.0, 179.9, 0.7, 162.8]
TARGET = {"user1Mm": [500.0, -1200.0, -330.0], "ageS": 1.0, "source": "tag"}
BODY = {"who": "시험", "token": "t", "confirm": "현장확인"}
# 프로필 대신 세우는 설정. ⭐ `speedPct` 는 **여기 값이 그대로 나가야** 한다 —
# 코드에 상한을 또 박으면 「프로필이 정본」이 거짓이 된다 (계약 §기준값은 프로필에 산다).
CFG = {"standoffMm": 165.0, "faceAxis": "z", "deadbandMm": 15.0, "releaseMm": 25.0,
       "maxTiltDeg": 20.0, "speedPct": 10, "autoOffAfterS": 300,
       "targetTagId": 15, "targetSource": "anchor"}


@unittest.skipUnless(HAVE, "fastapi 가 없다 — 브리지 호스트에서만 돈다")
class 한_번만_간다(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.saved = (main.follow_target, main.follow_goal, main.owner_gate,
                      main.cmds.motion, main.follow_cfg, main.session.lastState)
        self.armed, self.reasons, self.would = True, [], True
        main.follow_cfg = lambda: (CFG, None)
        main.follow_target = lambda cfg: (TARGET, None)
        main.follow_goal = lambda t, cfg: ({"tcpMmDeg": list(GOAL), "wouldMove": self.would,
                                            "distMm": 200.0, "grade": "첫목표"}, None)
        main.owner_gate = lambda body: None
        main.cmds.motion = lambda j, s, scan=False, dry=False: self.reasons if dry else (self.sent.append((j, s)), self.reasons)[1]
        main.session.adapter = type("A", (), {"inverse_kin": staticmethod(lambda p, r: [0.0] * 6)})()
        main.session.lastState = {"jointsDeg": [0.0] * 6}
        type(main.session).armed = property(lambda _s: self.armed)
        self.c = TestClient(main.app)

    def tearDown(self):
        (main.follow_target, main.follow_goal, main.owner_gate,
         main.cmds.motion, main.follow_cfg, main.session.lastState) = self.saved
        del type(main.session).armed

    def post(self, **over):
        return self.c.post("/follow/step", json={**BODY, **over})

    def test_현장확인이_없으면_안_간다(self):
        r = self.post(confirm=None)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.sent, [], "거부인데 명령이 나갔다")

    def test_ARMED_가_아니면_안_간다(self):
        self.armed = False
        self.assertEqual(self.post().status_code, 403)
        self.assertEqual(self.sent, [])

    def test_표적을_못_보면_안_간다(self):
        """⛔ **가는 것은 멈춘다** — 마지막 자리로 가지 않는다 (계약 §못 보면)."""
        main.follow_target = lambda cfg: (None, "표적이 9.9초 낡았다")
        r = self.post()
        self.assertEqual(r.status_code, 409)
        self.assertIn("낡았다", " ".join(r.json()["reasons"]))
        self.assertEqual(self.sent, [])

    def test_게이트가_거부하면_안_간다(self):
        self.reasons = ["작업영역 밖이다"]
        r = self.post()
        self.assertEqual(r.status_code, 409)
        self.assertIn("작업영역 밖이다", r.json()["reasons"])

    def test_데드밴드_안이면_안_간다(self):
        self.would = False
        r = self.post()
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["moved"])
        self.assertEqual(self.sent, [], "데드밴드 안인데 명령이 나갔다 — 팔이 떤다")

    def test_통과하면_설정_속도로_한_번_보낸다(self):
        r = self.post()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["moved"])
        self.assertEqual(len(self.sent), 1, "한 번만 가야 한다")
        self.assertEqual(self.sent[0][1], 10, "프로필의 speedPct 로 가야 한다 (코드 상수 금지)")

    def test_관절_경계를_가로지르면_동치_TCP를_다시_푼다(self):
        """관절각 래핑으로 속이지 않고, ±175° 안의 별도 IK 해를 골라야 한다."""
        goal = [865.1, -948.2, 88.0, -176.2, 2.2, 19.1]
        main.follow_goal = lambda t, cfg: ({"tcpMmDeg": list(goal), "wouldMove": True,
                                            "distMm": 200.0, "grade": "첫목표"}, None)
        main.session.lastState = {"jointsDeg": [80.3, -65.8, 46.8, -68.7, -93.7, 151.3]}

        def inverse_kin(pose, _ref):
            return [127.1, -64.4, 44.1, -65.4, -90.9, -161.9] if pose[5] > 0 \
                else [126.4, -71.3, 56.3, -79.3, -89.0, 17.4]

        def motion(joints, speed, scan=False, dry=False):
            if dry:
                return ["313.2°라 정착 상한 밖"] if joints[5] < -100 else []
            self.sent.append((joints, speed))
            return []

        main.session.adapter = type("A", (), {"inverse_kin": staticmethod(inverse_kin)})()
        main.cmds.motion = motion
        r = self.post()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["moved"])
        self.assertEqual(r.json()["goal"]["tcpMmDeg"][5], -160.9)
        self.assertEqual(r.json()["goal"]["jointsDeg"][5], 17.4)
        self.assertEqual(len(self.sent), 1, "동치 후보 검사는 dry-run이고 실제 명령은 하나여야 한다")


@unittest.skipUnless(HAVE, "fastapi 가 없다 — 브리지 호스트에서만 돈다")
class 실제_TCP_데드밴드(unittest.TestCase):
    def setUp(self):
        self.had_tcp = hasattr(main.session, "tcpMmDeg")
        self.had_tcp_at = hasattr(main.session, "tcpAt")
        self.tcp = getattr(main.session, "tcpMmDeg", None)
        self.tcp_at = getattr(main.session, "tcpAt", None)

    def tearDown(self):
        if self.had_tcp:
            main.session.tcpMmDeg = self.tcp
        else:
            del main.session.tcpMmDeg
        if self.had_tcp_at:
            main.session.tcpAt = self.tcp_at
        else:
            del main.session.tcpAt

    def test_다른_창구가_팔을_옮기면_같은_추종_목표도_다시_간다(self):
        main.session.tcpMmDeg = [700.0, -1200.0, -165.0, 179.9, 0.7, 162.8]
        main.session.tcpAt = time.time()
        goal, why = main.follow_goal(TARGET, CFG)
        self.assertIsNone(why)
        self.assertTrue(goal["wouldMove"])
        self.assertEqual(goal["distMm"], 200.0)

    def test_실제_TCP가_목표에_있을_때만_안_간다(self):
        main.session.tcpMmDeg = list(GOAL)
        main.session.tcpAt = time.time()
        goal, why = main.follow_goal(TARGET, CFG)
        self.assertIsNone(why)
        self.assertFalse(goal["wouldMove"])
        self.assertEqual(goal["distMm"], 0.0)
