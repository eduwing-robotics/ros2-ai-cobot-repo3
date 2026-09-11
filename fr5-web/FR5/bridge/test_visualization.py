"""공동 고스트는 한 게시자·2초 임대이고 로봇 명령 경로와 분리된다."""
import json
import time
import unittest

from visualization import TTL_S, VisualGhostStore

try:
    from fastapi.testclient import TestClient
    import main
    HAVE_FASTAPI = True
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False


def ghost(seq=1, who="주인"):
    return {"type": "ghost", "robotId": "fr5-lab-a", "kind": "preview",
            "jointsDeg": [0, -20, 40, 0, 30, 0], "gripperPct": 70,
            "seq": seq, "who": who, "token": "test-token"}


class 고스트_임대(unittest.TestCase):
    def test_한_게시자와_만료를_같이_지킨다(self):
        s = VisualGhostStore()
        self.assertTrue(s.publish("a", ghost(), True, now=10)[0])
        self.assertFalse(s.publish("b", ghost(2), True, now=11)[0])
        self.assertEqual(s.snapshot(now=10)["seq"], 1)
        self.assertIsNone(s.snapshot(now=10 + TTL_S))
        self.assertTrue(s.publish("b", ghost(2), True, now=12)[0])

    def test_잘못된_입력과_옛_seq를_거부한다(self):
        s = VisualGhostStore()
        self.assertFalse(s.publish("a", {**ghost(), "jointsDeg": [0] * 5}, True, now=1)[0])
        self.assertFalse(s.publish("a", ghost(), False, now=1)[0])
        self.assertTrue(s.publish("a", ghost(3), True, now=1)[0])
        self.assertFalse(s.publish("a", ghost(3), True, now=1.1)[0])


@unittest.skipUnless(HAVE_FASTAPI, "fastapi가 없다 — 브리지 호스트에서만 돈다")
class 상태_스트림_연결(unittest.TestCase):
    def test_게시하면_snapshot에_서고_소켓을_닫으면_즉시_사라진다(self):
        ok, token = main.owner.claim("시각화시험")
        self.assertTrue(ok)
        msg = {**ghost(who="시각화시험"), "token": token}
        c = TestClient(main.app)
        try:
            with c.websocket_connect("/ws/visualization") as ws:
                ws.send_text(json.dumps(msg))
                for _ in range(20):
                    shared = main.snapshot().get("visualGhost")
                    if shared:
                        break
                    time.sleep(0.01)
                self.assertEqual(shared["operator"], "시각화시험")
                self.assertEqual(shared["jointsDeg"], msg["jointsDeg"])
            for _ in range(20):
                if main.snapshot().get("visualGhost") is None:
                    break
                time.sleep(0.01)
            self.assertIsNone(main.snapshot().get("visualGhost"))
        finally:
            main.owner.release("시각화시험", token)


if __name__ == "__main__":
    unittest.main()
