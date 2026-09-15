"""움직이는 장애물 가드 — **「있다」가 아니라 「잡는다」를 잰다.**

`fixture.py` 는 **비전이 게이트에 값을 넣는 첫 코드**다 (계약 §움직이는 장애물 · D130).
그래서 재는 것은 정상 동작이 아니라 **깨진 입력을 거부하는가**이고, 무엇보다
**비전이 보호를 줄이지 못하는가**다. 카메라도 로봇도 없이 돈다 — 임시 파일만 쓴다.
"""
import json
import os
import tempfile
import time
import unittest

import fixture


def write(doc):
    fd, p = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    return p


# ⛔ `heightMm` 이 아니라 **`tagCenterToTopMm`** 이다 (2026-08-13). 예전 산출물은
# 높이만 싣고 소비처가 「태그는 옆면 정중앙」이라 보고 절반을 올렸는데, 그건 정육면체에
# 태그를 가운데 붙였을 때만 참이다. **받침이 바뀌면 조용히 틀린다.**
GOOD = {"centerMm": [383.2, -1084.4, -355.6], "halfMm": 95, "tagCenterToTopMm": 47.5,
        "seenAt": 0, "checkedAt": 0, "basis": "tags-x.jpg"}


class 받침상자(unittest.TestCase):
    def setUp(self):
        fixture._cache.update({"mtime": None, "doc": None})   # 시험끼리 캐시를 안 물려준다

    def test_정상이면_상자가_선다(self):
        b, note = fixture.box_from(write({**GOOD, "checkedAt": time.time()}))
        self.assertIsNone(note)
        self.assertEqual(b["source"], "vision")
        self.assertEqual(b["xMm"], [383.2 - 95, 383.2 + 95])
        # 윗면 = 태그 중심 + (태그→윗면). **절반을 가정하지 않는다**
        self.assertAlmostEqual(b["topZMm"], -355.6 + 47.5)
        self.assertNotIn("staleReason", b)

    def test_파일이_없으면_상자도_경고도_없다(self):
        """받침을 **안 쓰는 것**은 고장이 아니다. 못 끄는 경고를 상주시키지 않는다."""
        b, note = fixture.box_from("/tmp/없는파일-fixture-pose.json")
        self.assertIsNone(b)
        self.assertIsNone(note)

    # ── ⛔ 비전이 보호를 줄이지 못한다 ──────────────────────────────────────────
    def test_태그를_못_봐도_상자는_남는다(self):
        """**이 시험이 이 모듈의 존재 이유다.** 지우면 막던 것이 안 막힌다."""
        b, note = fixture.box_from(write({**GOOD, "checkedAt": time.time(),
                                          "staleReason": "태그를 못 본다 — noTag"}))
        self.assertIsNotNone(b, "태그를 못 봤다고 상자를 지우면 안 된다")
        self.assertIn("태그를 못 본다", b["staleReason"])

    def test_산출기가_멎으면_나이로_잡는다(self):
        """값은 멀쩡한데 갱신이 끊긴 경우 — **값이 아니라 나이가 근거다.**"""
        b, note = fixture.box_from(write({**GOOD, "checkedAt": time.time() - 600}))
        self.assertIsNotNone(b)
        self.assertIn("멎었다", b["staleReason"])

    # ── 깨진 입력은 거부한다. **다만 이유를 남긴다** ────────────────────────────
    def test_자리가_깨지면_거부하고_이유를_남긴다(self):
        b, note = fixture.box_from(write({**GOOD, "centerMm": [1, 2]}))
        self.assertIsNone(b)
        self.assertIn("centerMm", note)

    def test_크기가_범위_밖이면_거부한다(self):
        """비전이 크기를 정하지 못하게 하는 **두 번째 자물쇠**."""
        for bad in (5, 5000, "95", None):
            b, note = fixture.box_from(write({**GOOD, "halfMm": bad}))
            self.assertIsNone(b, f"halfMm={bad} 를 받아들이면 안 된다")
            self.assertIn("크기", note)

    def test_윗면_거리가_없거나_범위_밖이면_거부한다(self):
        """⛔ **옛 `heightMm` 파일은 거부한다.** 옛 가정으로 계속 도는 것보다 멈추는 게 낫다."""
        for bad in (9000, -9000, None, "47.5"):
            b, note = fixture.box_from(write({**GOOD, "tagCenterToTopMm": bad}))
            self.assertIsNone(b, f"tagCenterToTopMm={bad} 를 받으면 안 된다")
            self.assertIn("윗면", note)

    def test_옛_산출물은_거부한다(self):
        """`heightMm` 만 있는 옛 파일 — **「태그가 옆면 정중앙」 가정이 박혀 있던 판**이다."""
        old = {k: v for k, v in GOOD.items() if k != "tagCenterToTopMm"}
        b, note = fixture.box_from(write({**old, "heightMm": 86.5}))
        self.assertIsNone(b, "옛 판을 조용히 받아들이면 받침이 바뀔 때 틀린 높이를 막는다")
        self.assertIn("윗면", note)

    def test_깨진_JSON_은_마지막_성공값을_안_버린다(self):
        """산출기는 원자적으로 쓰지만, 그래도 **지우지 않는다**가 이 모듈의 규약이다."""
        p = write({**GOOD, "checkedAt": time.time()})
        first, _ = fixture.box_from(p)
        self.assertIsNotNone(first)
        with open(p, "w", encoding="utf-8") as f:
            f.write("{반쪽")
        os.utime(p, (time.time() + 1, time.time() + 1))       # mtime 을 바꿔 재읽기를 유도
        again, _ = fixture.box_from(p)
        self.assertIsNotNone(again, "깨진 판을 읽었다고 마지막 자리를 버리면 안 된다")



class 점프가드_래치업(unittest.TestCase):
    """산출기 쪽 버그였지만 **증상이 나타나는 곳은 여기**라 여기서 잰다.

    2026-08-13 실측 사고 — 받침을 215mm 옮기자 점프 가드가 거부했는데, 거부하면서
    **아무것도 안 써서** `prev` 가 옛 자리에 남았고 다음 프레임도 같은 거리라 또 거부됐다.
    **139초 동안 자리가 215mm 틀린 채 화면은 초록**이었다 — 나이로도 못 잡는 거짓말이다.
    """

    def setUp(self):
        fixture._cache.update({"mtime": None, "doc": None})

    def test_거부_중에도_나이가_늙어야_잡힌다(self):
        """`checkedAt` 이 멈추면 「방금 확인함」인 척한다. **거부해도 써야** 나이가 잡는다."""
        b, _ = fixture.box_from(write({**GOOD, "checkedAt": time.time() - 600}))
        self.assertIsNotNone(b)
        self.assertIn("멎었다", b["staleReason"],
                      "갱신이 끊긴 것을 나이로 못 잡으면 조용한 거짓말이 된다")

    def test_확인중_사유가_그대로_실린다(self):
        """산출기가 「큰 이동을 확인 중」이라 말하면 화면도 그렇게 말해야 한다."""
        b, _ = fixture.box_from(write({**GOOD, "checkedAt": time.time(),
                                       "staleReason": "큰 이동을 확인 중 — 215mm (1/3)"}))
        self.assertIsNotNone(b, "확인 중이라고 상자를 지우면 안 된다")
        self.assertIn("확인 중", b["staleReason"])



TABLES = [{"name": "작업대", "xMm": [15.45, 810.45], "yMm": [-1251.2, -798.2],
           "topZMm": -398.9, "source": "profile"}]


class 자리_타당성(unittest.TestCase):
    """⛔ **점프 가드로는 못 막는 구멍.** 「한 걸음의 크기」가 아니라 「지금 자리가 말이 되나」.

    2026-08-13 실측 — 다른 세션이 5분 간격 두 표본에서 **600mm 떨어진 값**을 봤다.
    z 가 `-354 → -31` 로 323mm 올라갔는데 받침이 작업대 위에 있다면 있을 수 없는 높이다.
    각 걸음은 25mm 라 400mm 점프 가드를 **걸어서 통과**했다.
    """

    def setUp(self):
        fixture._cache.update({"mtime": None, "doc": None})

    def test_상판_위면_받는다(self):
        b, note = fixture.box_from(
            write({**GOOD, "centerMm": [400.0, -1000.0, -355.0], "checkedAt": time.time()}),
            tables=TABLES)
        self.assertIsNotNone(b, note)

    def test_공중에_뜨면_거부한다(self):
        """z −31 = 상판 위 368mm. 놓인 물건이 아니다."""
        b, note = fixture.box_from(
            write({**GOOD, "centerMm": [185.8, -624.9, -31.2], "checkedAt": time.time()}),
            tables=TABLES)
        self.assertIsNone(b, "공중에 뜬 자리를 받으면 게이트가 엉뚱한 데를 막는다")
        self.assertIn("있을 수 없는 자리", note)

    def test_상판_밖으로_멀어지면_거부한다(self):
        b, note = fixture.box_from(
            write({**GOOD, "centerMm": [3000.0, -1000.0, -355.0], "checkedAt": time.time()}),
            tables=TABLES)
        self.assertIsNone(b)
        self.assertIn("있을 수 없는 자리", note)

    def test_기준이_없으면_판정하지_않는다(self):
        """프로필 상자가 없으면 비교할 기준이 없다 — **막지도 않는다**(없는 근거로 거부 금지)."""
        b, note = fixture.box_from(
            write({**GOOD, "centerMm": [9999.0, 9999.0, 9999.0], "checkedAt": time.time()}),
            tables=[])
        self.assertIsNotNone(b)

class 받침_기하는_데이터다(unittest.TestCase):
    """⛔ **다음 거치대가 왔을 때의 유일한 방어선.**

    2026-08-13 — 실물 사진으로 드러났다. 코드가 `HEIGHT_MM = 86.5`(종이상자)를 들고
    **「태그는 옆면 정중앙」**을 가정하고 있었는데 실물은 **나무 정육면체**였다.
    받침은 실험본이라 곧 바뀐다 — 그때 **가정이 조용히 틀리면 안 된다.**
    그래서 기하는 `tags.json` §fixtureTags 에 살고, **없으면 안 쓴다.**
    """

    OK_SPEC = {"fixtureTags": [{"id": 6, "measuredMm": 58.8,
                                "halfMm": 95.0, "tagCenterToTopMm": 47.5}]}

    def test_다_있으면_읽는다(self):
        g, why = fixture.fixture_geom(self.OK_SPEC, 6)
        self.assertIsNone(why)
        self.assertEqual((g["halfMm"], g["toTopMm"], g["sizeMm"]), (95.0, 47.5, 58.8))

    def test_윗면_거리가_없으면_거부한다(self):
        """받침이 바뀌었는데 이 값을 안 적으면 **여기서 멈춘다.** 옛 값으로 안 돈다."""
        spec = {"fixtureTags": [{"id": 6, "measuredMm": 58.8, "halfMm": 95.0}]}
        g, why = fixture.fixture_geom(spec, 6)
        self.assertIsNone(g)
        self.assertIn("tagCenterToTopMm", why)

    def test_반폭이_없으면_거부한다(self):
        spec = {"fixtureTags": [{"id": 6, "measuredMm": 58.8, "tagCenterToTopMm": 47.5}]}
        g, why = fixture.fixture_geom(spec, 6)
        self.assertIsNone(g)
        self.assertIn("halfMm", why)

    def test_정의가_통째로_없으면_거부한다(self):
        g, why = fixture.fixture_geom({}, 6)
        self.assertIsNone(g)
        self.assertIn("정의가 없다", why)

    def test_실제_tags_json_이_기하를_들고_있다(self):
        """**출하 데이터가 규약을 지키는가.** 여기가 비면 실기에서 받침이 안 뜬다."""
        import json as _j
        from pathlib import Path as _P
        spec = _j.loads((_P(__file__).resolve().parents[2]
                         / "Shared/assets/tag/tags.json").read_text(encoding="utf-8"))
        g, why = fixture.fixture_geom(spec, 6)
        self.assertIsNotNone(g, why)


if __name__ == "__main__":
    unittest.main()
