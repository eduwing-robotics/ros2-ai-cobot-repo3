"""정지 전송 — **`stop` 은 줄서지 않는다** (2026-09-03 · `SAFETY-RULES.md` §도착까지가 규약이다).

## 왜 이 시험이 있나

계약에는 오래 적혀 있었는데 **코드가 안 지키고 있었다.** 수신 루프가
`res = await handle_cmd(msg, ...)` 로 직렬화돼 있어서, 이동 중에 온 `stop` 이 **그 이동이
끝날 때까지 버퍼에 머물렀다.** 「통과한다」는 참인데 로봇은 계속 움직였다 — 지연이 남은
이동 시간과 같아 지점 이동에서는 최대 60초까지 벌어진다(2026-08-10 목 브리지 로그).

**판정만 적으면 전송을 아무도 안 본다** — 계약이 그렇게 적어 뒀고, 그 자리를 이 시험이 맡는다.

## 무엇을 재나 — 둘을 **같이** 봐야 뜻이 있다

  ① `stop` 은 느린 명령 **도중에** 실행된다      (새치기해야 정지다)
  ② `stop` 아닌 것은 **줄선다**                  (순서가 안 지켜지면 이동 둘이 겹친다)

⛔ ①만 재면 「전부 동시 실행」도 통과한다. ②가 그 구멍을 막는다 — **자기검사를 겸한다.**

⚠ `fastapi` 가 없으면 **건너뛴다.** 브리지 호스트에는 있고 개발 맥에는 없을 수 있는데,
없는 것을 실패로 적으면 게이트가 「의존성 없음」과 「계약 위반」을 같은 빨간불로 말한다.
"""
import asyncio
import json
import time
import unittest

try:
    from fastapi.testclient import TestClient
    import main
    HAVE = True
except Exception:                                    # noqa: BLE001
    HAVE = False

SLOW_S = 0.6            # 「이동」 흉내. 짧게 잡되 잡음(수십 ms)보다 충분히 크게


@unittest.skipUnless(HAVE, "fastapi 가 없다 — 브리지 호스트에서만 돈다")
class 정지가_줄서지_않는다(unittest.TestCase):
    def setUp(self):
        self.log = []
        self._cmd, self._stop = main.handle_cmd, main.do_stop

        async def slow(msg, who, token):
            self.log.append(("start", msg.get("cmd"), time.monotonic()))
            await asyncio.sleep(SLOW_S)
            self.log.append(("end", msg.get("cmd"), time.monotonic()))
            return {"ok": True}

        async def rec(who=None, via="ws"):
            self.log.append(("stop", via, time.monotonic()))
            return {"ok": True}

        main.handle_cmd, main.do_stop = slow, rec

    def tearDown(self):
        main.handle_cmd, main.do_stop = self._cmd, self._stop

    def _run(self, second_cmd):
        c = TestClient(main.app)
        with c.websocket_connect("/ws/state") as ws:
            t0 = time.monotonic()
            ws.send_text(json.dumps({"cmd": "moveJ"}))
            time.sleep(SLOW_S * 0.25)
            ws.send_text(json.dumps({"cmd": second_cmd}))
            time.sleep(SLOW_S + 0.4)
        return t0, self.log

    def test_stop_은_이동_도중에_실행된다(self):
        t0, log = self._run("stop")
        stop = [t for (n, _, t) in log if n == "stop"]
        end = [t for (n, _, t) in log if n == "end"]
        self.assertTrue(stop, "stop 이 아예 실행되지 않았다")
        self.assertTrue(end, "느린 명령이 안 끝났다 — 시험 자체가 안 돌았다")
        self.assertLess(stop[0], end[0],
                        f"stop 이 이동이 끝난 뒤에 실행됐다 — 계약 위반 "
                        f"(stop {stop[0]-t0:.2f}s · 이동 종료 {end[0]-t0:.2f}s)")

    def test_자기검사_stop_아닌_것은_줄선다(self):
        """①만 재는 시험과 가른다 — 전부 동시 실행이면 여기서 빨개진다."""
        t0, log = self._run("gripper")
        starts = {v: t for (n, v, t) in log if n == "start"}
        end = [t for (n, v, t) in log if n == "end" and v == "moveJ"]
        self.assertIn("gripper", starts, "둘째 명령이 실행되지 않았다")
        self.assertTrue(end)
        self.assertGreaterEqual(starts["gripper"], end[0] - 0.05,
                                "stop 아닌 명령이 앞 명령을 앞질렀다 — 이동 둘이 겹친다")


@unittest.skipUnless(HAVE, "fastapi 가 없다 — 브리지 호스트에서만 돈다")
class 밀린_명령은_받은_때의_신원으로_실행된다(unittest.TestCase):
    """수신·실행을 가르면서 **새로 생긴** 구멍 (2026-09-03 자기리뷰).

    큐에 넣은 뒤 `hello` 가 오면, 실행 시점의 클로저를 읽는 구현은 **앞 명령을 새 사람
    신원으로** 돌린다 — 조종권 판정이 뒤바뀐다. 직렬 실행이던 때는 둘이 같은 순간이라
    없던 자리고, 그래서 **가르는 변경과 함께 들어온 결함**이다.
    """

    def setUp(self):
        self.seen = []
        self._cmd = main.handle_cmd

        async def rec(msg, who, token):
            await asyncio.sleep(0.25)              # 그 사이에 hello 가 온다
            self.seen.append((msg.get("cmd"), who))
            return {"ok": True}

        main.handle_cmd = rec

    def tearDown(self):
        main.handle_cmd = self._cmd

    def test_뒤에_온_hello_가_앞_명령의_신원을_바꾸지_않는다(self):
        c = TestClient(main.app)
        with c.websocket_connect("/ws/state") as ws:
            ws.send_text(json.dumps({"cmd": "hello", "who": "먼저", "token": "t1"}))
            ws.send_text(json.dumps({"cmd": "moveJ"}))
            time.sleep(0.05)
            ws.send_text(json.dumps({"cmd": "hello", "who": "나중", "token": "t2"}))
            time.sleep(0.6)
        self.assertTrue(self.seen, "명령이 실행되지 않았다")
        self.assertEqual(self.seen[0][1], "먼저",
                         f"밀린 명령이 «나중» 신원으로 돌았다 — 조종권 판정이 뒤바뀐다: {self.seen}")


@unittest.skipUnless(HAVE, "fastapi 가 없다 — 브리지 호스트에서만 돈다")
class POST_stop_은_아무것도_묻지_않는다(unittest.TestCase):
    """제3원칙 — 조종권·신원·phase 를 묻는 순간 그게 **정지를 막는 조건**이 된다."""

    def test_본문_없이도_엉뚱한_본문에도_멱등하게_통과한다(self):
        c = TestClient(main.app)
        for body in (None, {}, {"who": "아무개", "token": "틀린값"}):
            r = c.post("/stop") if body is None else c.post("/stop", json=body)
            self.assertEqual(r.status_code, 200, f"본문 {body!r} 에 거부했다")
            self.assertTrue(r.json().get("ok"), f"본문 {body!r} 에 ok 가 아니다")


if __name__ == "__main__":
    unittest.main()
