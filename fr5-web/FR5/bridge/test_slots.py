# slots.py 단위 테스트 — 순수 파일 I/O 라 로봇 없이 전부 돈다 (PROGRAM-CONTRACT.md 가 정본).
#
# 여기서 지키는 것 넷:
#   **없는 지점을 가리키면 저장에서 막는다**(실행 시점에 알면 사람이 로봇 앞에 선 다음이다) ·
#   **고치면 승인이 풀린다** · **승인 안 된 것은 실행 못 한다** ·
#   **승인 당시 정체와 지금이 다르면 실행 못 한다**(tool0 승인 → 장착 후 실행 = 충돌).
import tempfile
import unittest
from pathlib import Path

from slots import MAX_STEPS, SlotStore, grip_pct, identity_mismatch, point_mismatch

# `toolCoordMm` 는 활성 툴의 **값**이다 — 번호가 같은 채 값만 바뀌는 사건(핑거 교체)을
# 번호 셋으로는 못 잡는다. 135 는 실기 `tool1` 의 Z (플랜지→핑거 끝).
IDENT = {"robotId": "fr5-lab-a", "toolId": 1, "userId": 1,
         "toolCoordMm": [0.0, 0.0, 135.0, 0.0, 0.0, 0.0], "firmware": "V3.9.33-QX"}
# 지점 이름 → 관절 자세. save 는 키만 보고(없는 지점 거부), approve·step_plan 은 자세를
# 지문으로 박아 승인 뒤 재교시를 잡는다 (감사 #2)
POINTS = {"home": [0, 0, 0, 0, 0, 0], "1": [10, 0, 0, 0, 0, 0], "2": [20, 0, 0, 0, 0, 0]}


def steps(*names):
    return [{"type": "move", "pointName": n} for n in names]


class Save(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SlotStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_저장하면_draft_다(self):
        slot, reasons = self.store.save("집기시연", steps("home", "1"), POINTS)
        self.assertEqual(reasons, [])
        self.assertEqual(slot["status"], "draft")
        self.assertEqual([s["pointName"] for s in slot["steps"]], ["home", "1"])
        self.assertIsNone(slot["approvedWith"])

    def test_좌표를_안_든다(self):
        """슬롯은 `pointName` 만 참조한다 (D78) — 관절값이 들어가면 정본이 둘이 된다."""
        slot, _ = self.store.save("s", steps("home"), POINTS)
        self.assertEqual(set(slot["steps"][0]), {"type", "pointName"})

    def test_없는_지점을_가리키면_저장이_거부된다(self):
        _, reasons = self.store.save("s", steps("home", "없음"), POINTS)
        self.assertTrue(any("없는 지점" in r for r in reasons))
        self.assertIsNone(self.store.get("s"))

    def test_빈_단계는_거부(self):
        for bad in ([], None, "home"):
            with self.subTest(steps=bad):
                _, reasons = self.store.save("s", bad, POINTS)
                self.assertTrue(reasons)

    def test_단계_상한(self):
        _, reasons = self.store.save("s", steps(*["home"] * (MAX_STEPS + 1)), POINTS)
        self.assertTrue(any("너무 많다" in r for r in reasons))

    def test_모르는_type_은_거부(self):
        """`wait` 는 천장이다 (계약 §지금 여는 것) — 이름만 있는 칸이 조용히 저장되면 안 된다."""
        for bad in ({"type": "wait", "sec": 1}, {"type": "pick", "pointName": "home"},
                    {"pointName": "home"}, "move"):
            with self.subTest(step=bad):
                _, reasons = self.store.save("s", [bad], POINTS)
                self.assertTrue(any("type" in r for r in reasons), f"{bad!r} 가 통과했다")

    def test_경로가_되는_이름은_거부(self):
        for bad in ("/etc/cron.d/pwn", "../../x", "a/b", ""):
            with self.subTest(name=bad):
                _, reasons = self.store.save(bad, steps("home"), POINTS)
                self.assertTrue(reasons)

    def test_고치면_승인이_풀린다(self):
        self.store.save("s", steps("home"), POINTS)
        self.store.approve("s", "kim", IDENT, POINTS)
        self.assertEqual(self.store.get("s")["status"], "approved")
        self.store.save("s", steps("home", "1"), POINTS)     # 목록을 바꿨다
        self.assertEqual(self.store.get("s")["status"], "draft")
        self.assertIsNone(self.store.get("s")["approvedWith"])


class GripStep(unittest.TestCase):
    """`grip` 칸 (2026-08-10 · D103 · 계약 §grip 칸).

    지키는 것 셋: **`pct` 는 0~100 정수만** · **지점을 참조하지 않는다**(지문 대조·삭제
    참조에서 빠진다) · **저장 때 걸렀어도 실행 직전에 한 번 더 본다**(파일을 손으로 고친 경우).
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SlotStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_pct_는_0에서_100_정수만(self):
        for bad in (-1, 101, 62.5, "50", None, True, False):
            with self.subTest(pct=bad):
                self.assertIsNone(grip_pct(bad)[0], f"{bad!r} 가 통과했다")
                _, reasons = self.store.save("s", [{"type": "grip", "pct": bad}], POINTS)
                self.assertTrue(reasons, f"{bad!r} 가 저장됐다")
        for ok in (0, 50, 100):
            with self.subTest(pct=ok):
                self.assertEqual(grip_pct(ok), (ok, []))

    def test_소수를_반올림해_주지_않는다(self):
        """`62.5 → 63` 으로 고쳐 주면 사람이 보낸 값과 승인된 값이 갈린다 (계약 §grip 칸)."""
        _, reasons = self.store.save("s", [{"type": "grip", "pct": 62.5}], POINTS)
        self.assertTrue(any("정수" in r for r in reasons))

    def test_pointName_을_저장하지_않는다(self):
        slot, reasons = self.store.save(
            "s", [{"type": "grip", "pct": 100, "pointName": "home"}], POINTS)
        self.assertEqual(reasons, [])
        self.assertEqual(set(slot["steps"][0]), {"type", "pct"})

    def test_grip_칸만으로도_승인된다(self):
        """지문이 없어야 정상이다 — 가리키는 지점이 없다."""
        self.store.save("s", [{"type": "grip", "pct": 0}], POINTS)
        slot, reasons = self.store.approve("s", "kim", IDENT, POINTS)
        self.assertEqual(reasons, [])
        self.assertEqual(slot["approvedWith"]["points"], {})

    def test_섞인_프로그램은_move_칸만_지문을_박는다(self):
        mixed = [{"type": "move", "pointName": "home"}, {"type": "grip", "pct": 100},
                 {"type": "move", "pointName": "1"}]
        self.store.save("s", mixed, POINTS)
        slot, _ = self.store.approve("s", "kim", IDENT, POINTS)
        self.assertEqual(sorted(slot["approvedWith"]["points"]), ["1", "home"])

    def test_실행하면_칸을_그대로_낸다(self):
        self.store.save("s", [{"type": "move", "pointName": "home"},
                              {"type": "grip", "pct": 100}], POINTS)
        self.store.approve("s", "kim", IDENT, POINTS)
        self.assertEqual(self.store.step_plan("s", 1, IDENT, POINTS),
                         ({"type": "grip", "pct": 100}, []))

    def test_파일을_손으로_고쳐_망친_pct_는_실행에서_막힌다(self):
        self.store.save("s", [{"type": "grip", "pct": 100}], POINTS)
        self.store.approve("s", "kim", IDENT, POINTS)
        path = Path(self.tmp.name) / "slots" / "s.json"
        path.write_text(path.read_text().replace('"pct": 100', '"pct": 999'))
        step, reasons = self.store.step_plan("s", 0, IDENT, POINTS)
        self.assertIsNone(step)
        self.assertTrue(any("pct" in r for r in reasons))

    def test_grip_칸은_지점_삭제를_막지_않는다(self):
        self.store.save("s", [{"type": "grip", "pct": 100}], POINTS)
        self.assertEqual(self.store.refs_to_point("home"), [])
        self.store.save("t", [{"type": "move", "pointName": "home"}], POINTS)
        self.assertEqual(self.store.refs_to_point("home"), ["t"])


class StepGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SlotStore(self.tmp.name)
        self.store.save("s", steps("home", "1", "2"), POINTS)

    def tearDown(self):
        self.tmp.cleanup()

    def test_승인_전에는_실행_못_한다(self):
        target, reasons = self.store.step_plan("s", 0, IDENT, POINTS)
        self.assertIsNone(target)
        self.assertTrue(any("승인" in r for r in reasons))

    def test_승인하면_단계_이름이_나온다(self):
        self.store.approve("s", "kim", IDENT, POINTS)
        for i, want in enumerate(["home", "1", "2"]):
            with self.subTest(index=i):
                self.assertEqual(self.store.step_plan("s", i, IDENT, POINTS),
                                 ({"type": "move", "pointName": want}, []))

    def test_범위_밖_번호는_거부(self):
        self.store.approve("s", "kim", IDENT, POINTS)
        for bad in (-1, 3, 99, None, "0", 1.5, True):
            with self.subTest(index=bad):
                target, reasons = self.store.step_plan("s", bad, IDENT, POINTS)
                self.assertIsNone(target, f"{bad!r} 가 통과했다")
                self.assertTrue(reasons)

    def test_좌표계가_바뀌면_실행_못_한다(self):
        """tool0 에서 승인한 것을 그리퍼 장착 후 실행하면 파지 실패가 아니라 충돌이다."""
        self.store.approve("s", "kim", IDENT, POINTS)
        target, reasons = self.store.step_plan("s", 0, {**IDENT, "toolId": 0}, POINTS)
        self.assertIsNone(target)
        self.assertTrue(any("toolId" in r for r in reasons))

    def test_핑거를_갈면_번호가_같아도_실행_못_한다(self):
        """번호 셋이 전부 같고 지점 자세도 같은데 손끝만 15mm 더 나가는 자리다.

        핑거 25mm → 40mm 로 갈고 펜던트에서 `tool1` 의 Z 를 135→150 으로 고친 상황.
        지점은 관절값으로 재생되므로(`MoveJ`) 지문 대조도 통과한다 — 값 대조만 남는다.
        """
        self.store.approve("s", "kim", IDENT, POINTS)
        swapped = {**IDENT, "toolCoordMm": [0.0, 0.0, 150.0, 0.0, 0.0, 0.0]}
        self.assertEqual(swapped["toolId"], IDENT["toolId"])      # 번호는 그대로다
        target, reasons = self.store.step_plan("s", 0, swapped, POINTS)
        self.assertIsNone(target)
        self.assertTrue(any("toolCoordMm" in r for r in reasons))

    def test_툴_값을_못_읽으면_차단이다(self):
        """읽기 실패는 `None` 으로 온다 — 통과가 아니라 차단이다 (제1원칙)."""
        self.store.approve("s", "kim", IDENT, POINTS)
        target, reasons = self.store.step_plan("s", 0, {**IDENT, "toolCoordMm": None}, POINTS)
        self.assertIsNone(target)
        self.assertTrue(reasons)

    def test_다른_개체면_실행_못_한다(self):
        self.store.approve("s", "kim", IDENT, POINTS)
        target, _ = self.store.step_plan("s", 0, {**IDENT, "robotId": "fr5-lab-b"}, POINTS)
        self.assertIsNone(target)

    def test_펌웨어는_대조하지_않는다(self):
        """기록은 남기되 판정에는 안 쓴다 — 펌웨어가 오르면 모든 승인이 죽는다."""
        self.store.approve("s", "kim", IDENT, POINTS)
        self.assertEqual(
            self.store.step_plan("s", 0, {**IDENT, "firmware": "V9"}, POINTS),
            ({"type": "move", "pointName": "home"}, []))

    def test_없는_슬롯은_404_사유(self):
        target, reasons = self.store.step_plan("없음", 0, IDENT, POINTS)
        self.assertIsNone(target)
        self.assertTrue(reasons)

    def test_승인_후_지점을_다시_가르치면_실행_못_한다(self):
        """승인은 자세 지문을 박는다 — 재교시로 지점이 바뀌면 아무도 검토 안 한 자세다 (감사 #2)."""
        self.store.approve("s", "kim", IDENT, POINTS)
        moved = {**POINTS, "home": [90, 0, 0, 0, 0, 0]}      # home 을 다시 가르쳤다
        target, reasons = self.store.step_plan("s", 0, IDENT, moved)
        self.assertIsNone(target)
        self.assertTrue(any("바뀌었다" in r for r in reasons))
        # 안 바뀐 단계(1)는 그대로 실행된다
        self.assertEqual(self.store.step_plan("s", 1, IDENT, moved),
                         ({"type": "move", "pointName": "1"}, []))

    def test_지점_자세를_못_읽으면_승인_못_한다(self):
        """지문을 못 박으면 승인하지 않는다 (제1원칙: 결측=차단)."""
        _, reasons = self.store.approve("s", "kim", IDENT, {**POINTS, "home": None})
        self.assertTrue(any("못 읽어" in r for r in reasons))
        self.assertEqual(self.store.get("s")["status"], "draft")

    def test_실행_시점에_자세를_못_읽으면_차단(self):
        self.store.approve("s", "kim", IDENT, POINTS)
        target, reasons = self.store.step_plan("s", 0, IDENT, {**POINTS, "home": None})
        self.assertIsNone(target)
        self.assertTrue(reasons)


class IdentityGate(unittest.TestCase):
    def test_기록이_없으면_차단이다(self):
        for bad in (None, {}, "x", []):
            with self.subTest(approved=bad):
                self.assertTrue(identity_mismatch(bad, IDENT))

    def test_같으면_통과(self):
        self.assertEqual(identity_mismatch(dict(IDENT), IDENT), [])


class PointGate(unittest.TestCase):
    def test_지문이_없는_옛_승인은_차단(self):
        """자세를 안 박고 승인된 옛 슬롯은 통과가 아니라 차단이다 (제1원칙 · 감사 #2)."""
        for bad in (None, {}, {"points": "x"}, {"points": {"other": [0] * 6}}):
            with self.subTest(approved=bad):
                self.assertTrue(point_mismatch(bad, "home", [0] * 6))

    def test_같은_자세면_통과(self):
        aw = {"points": {"home": [0, 0, 0, 0, 0, 0]}}
        self.assertEqual(point_mismatch(aw, "home", [0, 0, 0, 0, 0, 0]), [])

    def test_반올림_안쪽은_같다(self):
        """지문은 소수 3자리 — 그 아래 흔들림은 재교시가 아니다."""
        aw = {"points": {"home": [0.0, 0, 0, 0, 0, 0]}}
        self.assertEqual(point_mismatch(aw, "home", [0.0001, 0, 0, 0, 0, 0]), [])


class PointRefs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SlotStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_참조하는_슬롯을_찾는다(self):
        self.store.save("a", steps("home", "1"), POINTS)
        self.store.save("b", steps("2"), POINTS)
        self.assertEqual(self.store.refs_to_point("home"), ["a"])
        self.assertEqual(sorted(self.store.refs_to_point("2")), ["b"])
        self.assertEqual(self.store.refs_to_point("없음"), [])

    def test_빈_폴더도_목록이_돈다(self):
        self.assertEqual(self.store.list(), [])
        self.assertEqual(self.store.refs_to_point("home"), [])

    def test_삭제(self):
        self.store.save("a", steps("home"), POINTS)
        self.assertTrue(self.store.delete("a"))
        self.assertFalse(self.store.delete("a"))
        self.assertIsNone(self.store.get("a"))


class Unapprove(unittest.TestCase):
    """재교시가 승인을 푸는 길 (계약 §재교시). **지문 대조를 대체하지 않는다** — 더 이른 알림이다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SlotStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_승인을_풀되_단계는_남긴다(self):
        self.store.save("a", steps("home", "1"), POINTS)
        self.store.approve("a", "kim", IDENT, POINTS)
        self.assertTrue(self.store.unapprove("a"))
        slot = self.store.get("a")
        self.assertEqual(slot["status"], "draft")
        self.assertIsNone(slot["approvedWith"])
        self.assertIsNone(slot["approvedBy"])
        # 단계를 지우면 사람이 프로그램을 처음부터 다시 엮어야 한다 — 그건 재교시의 대가가 아니다
        self.assertEqual(slot["steps"], steps("home", "1"))

    def test_이미_draft_거나_없으면_False(self):
        self.store.save("a", steps("home"), POINTS)
        self.assertFalse(self.store.unapprove("a"))      # draft 였다 — 화면이 헛말을 안 하게
        self.assertFalse(self.store.unapprove("없음"))

    def test_푼_뒤에는_실행이_막힌다(self):
        self.store.save("a", steps("home"), POINTS)
        self.store.approve("a", "kim", IDENT, POINTS)
        self.store.unapprove("a")
        _, reasons = self.store.step_plan("a", 0, IDENT, POINTS)
        self.assertTrue(any("승인되지 않은" in r for r in reasons), reasons)

    def test_지문_대조는_그대로_남는다(self):
        # 캡처 알림을 못 받은 경로(파일 직접 수정 등)도 실행 직전에 걸려야 한다 (감사 #2)
        self.store.save("a", steps("home"), POINTS)
        self.store.approve("a", "kim", IDENT, POINTS)
        moved = dict(POINTS, home=[9, 0, 0, 0, 0, 0])
        _, reasons = self.store.step_plan("a", 0, IDENT, moved)
        self.assertTrue(any("승인 후 바뀌었다" in r for r in reasons), reasons)


if __name__ == "__main__":
    unittest.main()
