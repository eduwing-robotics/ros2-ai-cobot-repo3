"""터틀봇 자리 맞추기 시험 — **로봇도 카메라도 안 쓴다** (2026-08-31 · D158).

여기서 지키는 것은 하나다: **눈금이 틀렸으면 안 써야 한다.**
이 코드가 내는 값은 「팔이 어디로 갈까」의 입력이라, 조용히 그럴듯한 답을 내는 것이
답을 안 내는 것보다 나쁘다 (D155 가 가르친 것).
"""
import math

import amr
import fixture

TRUE = {"yawDeg": 137.0, "txMm": -412.5, "tyMm": 903.25}


def _pairs(points, true=TRUE):
    th = math.radians(true["yawDeg"])
    c, s = math.cos(th), math.sin(th)
    return [{"odom": [x, y],
             "lab": [c * x - s * y + true["txMm"], s * x + c * y + true["tyMm"]]}
            for x, y in points]


SPREAD = [(0, 0), (500, 0), (500, 400), (0, 400), (250, 200), (-300, 150), (800, -200)]


def test_참값을_정확히_되찾는다():
    got, why = amr.solve(_pairs(SPREAD))
    assert got, why
    assert abs(got["yawDeg"] - TRUE["yawDeg"]) < 1e-6
    assert abs(got["txMm"] - TRUE["txMm"]) < 1e-6
    assert abs(got["tyMm"] - TRUE["tyMm"]) < 1e-6
    assert got["rmsMm"] == 0.0


def test_적용이_같은_산수다():
    """맞추는 자리(`amr`)와 쓰는 자리(`fixture`)가 갈라지면 여기서 잡힌다 (하드 룰 5)."""
    pairs = _pairs(SPREAD)
    got, _ = amr.solve(pairs)
    for p in pairs:
        lab = fixture.odom_to_lab(p["odom"], got, 85.2)
        assert max(abs(lab[i] - p["lab"][i]) for i in (0, 1)) < 1e-6
        assert lab[2] == 85.2          # z 는 안 푼다 — 태그가 준 값이 그대로 통과한다


def test_쌍이_적으면_안_푼다():
    got, why = amr.solve(_pairs(SPREAD)[: amr.MIN_PAIRS - 1])
    assert got is None and "쌍이" in why


def test_한_점에_몰리면_안_푼다():
    """서 있는 로봇에서 계속 찍으면 회전이 안 풀린다 — 그때 **답을 내면 안 된다**."""
    got, why = amr.solve([{"odom": [10, 10], "lab": [1, 1]}] * 7)
    assert got is None and "한 점" in why


def test_잔차가_크면_안_쓴다():
    pairs = _pairs(SPREAD)
    pairs[0]["lab"] = [pairs[0]["lab"][0] + 900, pairs[0]["lab"][1]]
    got, why = amr.solve(pairs)
    assert got is None and "잔차" in why


def test_같은_자리는_쌍으로_안_쌓는다(tmp_path):
    """`MIN_PAIR_SPACING_MM` 이 없으면 서 있는 동안 같은 점이 40개 쌓여 회전이 죽는다."""
    amr._pairs.clear()
    now = 1000.0
    assert amr.observe([0, 0], [10, 10], now, now) is True
    assert amr.observe([5, 5], [15, 15], now, now) is False      # 7mm — 너무 가깝다
    assert amr.observe([0, 300], [10, 310], now, now) is True    # 300mm — 받는다
    assert amr.pair_count() == 2
    amr._pairs.clear()


def test_시각이_어긋난_쌍은_안_받는다():
    """태그와 바퀴가 다른 순간의 값이면 **한 쌍이 아니다** — 움직이는 로봇이라 그렇다."""
    amr._pairs.clear()
    now = 2000.0
    assert amr.observe([0, 0], [10, 10], now, now + amr.PAIR_MAX_SKEW_S + 0.5) is False
    assert amr.pair_count() == 0
    amr._pairs.clear()


def test_눈금을_파일로_남기고_받아_든다(tmp_path):
    """브리지가 죽어도 눈금이 안 사라진다 — 안 그러면 재시작마다 쌍을 다시 모아야 한다."""
    amr._pairs.clear()
    out = tmp_path / "amr-frame.json"
    now = 3000.0
    for i, (x, y) in enumerate(SPREAD):
        amr.observe([x, y], _pairs(SPREAD)[i]["lab"], now, now, out_path=str(out))
    assert out.exists()
    saved = amr.fit()
    assert saved and abs(saved["yawDeg"] - TRUE["yawDeg"]) < 1e-6

    amr._fit = None
    amr._pairs.clear()
    assert amr.fit() is None
    amr.load(str(out))
    back = amr.fit()
    assert back and abs(back["yawDeg"] - TRUE["yawDeg"]) < 1e-6
    assert amr.pair_count() == len(SPREAD)
    amr._pairs.clear()
    amr._fit = None


def test_주소를_안_주면_안_돈다():
    """켜는 스위치는 주소 하나다 — 안 준 것은 **고장이 아니라 안 켠 것**이다."""
    amr._state["note"] = "옛 사유"
    amr.start_reader("", robot_id="tb3_2")
    assert amr.note() is None


# ── `unittest` 가 평문 함수를 걷게 한다 (`_plaintests.py` §왜) ───────────────
from _plaintests import load_tests_for  # noqa: E402


def load_tests(loader, tests, pattern):
    return load_tests_for(__name__)
