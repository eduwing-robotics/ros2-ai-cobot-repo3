"""한 번만 간다 — `POST /follow/step` (2026-09-04 · `VISION-CONTRACT.md` §한 번만 간다).

## 무엇을 재나 — **거부가 본론이다**

추종은 계약이 **켜는 조건 여덟**을 걸어 둔 기능이고, 이 창구는 그중 여섯을 매 호출마다
다시 본다. 그러니 시험의 대부분은 「간다」가 아니라 **「어떤 때 안 가나」**여야 한다.

  ① `confirm` 없이는 안 간다            (조건 1 — 현장에 사람)
  ② ARMED 가 아니면 안 간다             (조건 2)
  ③ 표적이 낡으면 안 간다               (조건 5 — **가는 것은 멈춘다**)
  ④ 게이트가 거부하면 안 간다           (조건 3 — 비전 전용 경로를 안 만든다)
  ⑤ 데드밴드 안이면 **안 간다**         (같은 자리를 두 번 안 간다)
  ⑥ 보내고 나면 `follow_last_sent` 가 갱신된다

⭐ **⑥ 이 자기검사다.** 그전까지 그 변수는 읽히기만 하고 아무도 안 써서 등급이 늘
「첫목표」였다 — ⑤ 만 재면 그 상태로도 통과한다.

⚠ `fastapi` 가 없으면 건너뛴다 (`test_stop_transport.py` 와 같은 이유).
"""
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
                      main.cmds.motion, main.follow_last_sent, main.follow_cfg)
        self.armed, self.reasons, self.would = True, [], True
        main.follow_cfg = lambda: (CFG, None)
        main.follow_target = lambda cfg: (TARGET, None)
        main.follow_goal = lambda t, cfg: ({"tcpMmDeg": list(GOAL), "wouldMove": self.would,
                                            "distMm": 200.0, "grade": "첫목표"}, None)
        main.owner_gate = lambda body: None
        main.cmds.motion = lambda j, s, scan=False, dry=False: (self.sent.append((j, s)), self.reasons)[1]
        main.session.adapter = type("A", (), {"inverse_kin": staticmethod(lambda p, r: [0.0] * 6)})()
        type(main.session).armed = property(lambda _s: self.armed)
        main.follow_last_sent = None
        self.c = TestClient(main.app)

    def tearDown(self):
        (main.follow_target, main.follow_goal, main.owner_gate,
         main.cmds.motion, main.follow_last_sent, main.follow_cfg) = self.saved
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

    def test_보낸_뒤_마지막_목표가_남는다(self):
        """자기검사 — 이게 없으면 등급이 영영 「첫목표」라 데드밴드가 안 걸린다."""
        self.post()
        self.assertEqual(main.follow_last_sent, GOAL)
