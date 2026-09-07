"""추종 계산 시험 (계약 `VISION-CONTRACT.md` §추종 · D132).

**로봇도 카메라도 안 쓴다** — 순수 계산이라 다른 기계에서도 그대로 돈다.
`config.yaml` 의 실제 값을 읽어 **계약과 설정이 갈리지 않는지**도 여기서 대조한다.
"""
from pathlib import Path

import yaml

import follow

CFG = {"standoffMm": 165.0, "faceAxis": "z", "deadbandMm": 15.0,
       "releaseMm": 25.0, "maxTiltDeg": 20.0, "speedPct": 10, "autoOffAfterS": 300,
       "targetTagId": 15, "targetSource": "anchor"}
VERTICAL = [400.0, -1000.0, -150.0, 176.9, -0.1, 161.2]      # 실측 자세 (2026-08-13)


# ── 설정 읽기 — **없는 것과 틀린 것을 가른다** ──────────────────────────────
def test_없으면_사유가_아니다():
    cfg, why = follow.read_config({"robotId": "x"})
    assert cfg is None and why is None, "안 켠 것은 고장이 아니다"


def test_빠진_값은_이름을_말한다():
    bad = dict(CFG); bad.pop("standoffMm")
    cfg, why = follow.read_config({"follow": bad})
    assert cfg is None and "standoffMm" in why


def test_모르는_축은_거부한다():
    cfg, why = follow.read_config({"follow": dict(CFG, faceAxis="w")})
    assert cfg is None and "faceAxis" in why


def test_나갈_문턱이_더_커야_한다():
    """같으면 설정이 스스로 진동을 만든다 — 값이 아니라 **모양**의 문제다."""
    cfg, why = follow.read_config({"follow": dict(CFG, releaseMm=15.0)})
    assert cfg is None and "깜빡" in why


def test_정상이면_통과():
    cfg, why = follow.read_config({"follow": CFG})
    assert why is None and cfg["standoffMm"] == 165.0


def test_모르는_창구는_거부한다():
    """`targetSource` 는 취향이 아니라 「바퀴가 있나」다 — 없는 출처를 켤 수 없어야 한다."""
    cfg, why = follow.read_config({"follow": dict(CFG, targetSource="odom")})
    assert cfg is None and "targetSource" in why


def test_표적_번호가_없으면_안_돈다():
    """표적이 코드에 박혀 있던 자리다 (2026-09-04). 프로필이 안 정하면 **꺼진 것**이다."""
    bad = dict(CFG); bad.pop("targetTagId")
    cfg, why = follow.read_config({"follow": bad})
    assert cfg is None and "targetTagId" in why


# ── 목표 자세 ──────────────────────────────────────────────────────────────
def test_위에서_보면_z_로_띄운다():
    obj = [446.4, -1024.0, -313.7]
    pose, why = follow.target_pose(obj, VERTICAL, CFG)
    assert why is None
    assert pose[:2] == obj[:2], "수평은 물체 바로 위"
    assert abs(pose[2] - (-313.7 + 165.0)) < 1e-6
    assert pose[3:] == VERTICAL[3:], "자세는 지금 것을 그대로 쓴다"


def test_옆에서_보면_y_로_띄운다():
    """⭐ 세워 꽂으면 이 값 하나만 바뀐다 (D122) — 「위」를 코드에 박지 않은 이유다."""
    obj = [446.4, -1024.0, -313.7]
    pose, _ = follow.target_pose(obj, VERTICAL, dict(CFG, faceAxis="y"))
    assert abs(pose[2] - obj[2]) < 1e-6, "높이는 안 바꾼다"
    assert abs(pose[1] - (-1024.0 + 165.0)) < 1e-6, "지금 서 있는 쪽(y 가 큰 쪽)으로"


def test_반대쪽에_서_있으면_그쪽으로_띄운다():
    """물체 반대편으로 돌아가면 그 경로가 작업대를 가로지른다 — 가까운 쪽이 언제나 짧다."""
    obj = [446.4, -900.0, -313.7]
    pose, _ = follow.target_pose(obj, VERTICAL, dict(CFG, faceAxis="y"))
    assert pose[1] < obj[1], "손끝이 물체보다 y 가 작으므로 그쪽으로"


def test_많이_기울면_거부한다():
    tilted = [400.0, -1000.0, -150.0, 140.0, -30.0, 161.2]
    pose, why = follow.target_pose([1.0, 2.0, 3.0], tilted, CFG)
    assert pose is None and "기울어" in why


def test_물체가_없으면_차단():
    pose, why = follow.target_pose(None, VERTICAL, CFG)
    assert pose is None and "결측" in why


# ── 따라갈까 ───────────────────────────────────────────────────────────────
def test_첫_목표는_간다():
    go, d, tag = follow.should_move([1.0, 2.0, 3.0], None, CFG)
    assert go and tag == "첫목표"


def test_잡음과_보류를_가른다():
    """판정은 같지만 **로그가 달라야** 한다 — 계속 「보류」면 문턱이 현장에 비해 크다는 뜻이다."""
    base = [0.0, 0.0, 0.0]
    go, d, tag = follow.should_move([5.0, 0.0, 0.0], base, CFG)
    assert not go and tag == "잡음"
    go, d, tag = follow.should_move([20.0, 0.0, 0.0], base, CFG)
    assert not go and tag == "보류"
    go, d, tag = follow.should_move([30.0, 0.0, 0.0], base, CFG)
    assert go and tag == "이동"


# ── 스위치 — 조건 1(사람이 켠다) · 8(스스로 꺼진다) ────────────────────────
def test_기본은_꺼짐():
    sw = follow.Switch()
    alive, why = sw.alive(1000.0, CFG)
    assert not alive and why is None, "안 켠 것은 사유가 아니다"


def test_켜면_산다():
    sw = follow.Switch(); sw.on("실기 담당자", 1000.0)
    alive, _ = sw.alive(1010.0, CFG)
    assert alive
    assert sw.snapshot(1010.0, CFG)["secondsLeft"] == 290.0


def test_시간이_지나면_스스로_꺼진다():
    """⛔ 「사람이 켠다」는 규율이라 **끄는 걸 잊는 것이 기본값**이다 — 잊어도 꺼져야 한다."""
    sw = follow.Switch(); sw.on("실기 담당자", 1000.0)
    alive, why = sw.alive(1300.0, CFG)
    assert not alive and "스스로 껐다" in why
    assert sw.on_at is None, "만료가 상태에 남으면 다음 틱이 또 돈다"


def test_다시_켜면_옛_목표를_안_물려받는다():
    """켤 때마다 처음부터 — 지난번 목표가 남아 있으면 첫 이동이 데드밴드에 걸려 안 간다."""
    sw = follow.Switch(); sw.on("A", 1000.0)
    sw.last_sent = [1.0, 2.0, 3.0]
    sw.off("사람이 껐다")
    sw.on("B", 2000.0)
    assert sw.last_sent is None and sw.who == "B"


def test_꺼진_뒤에도_사유가_남는다():
    """조건 7 — 화면이 「왜 멈췄나」를 말할 수 있어야 한다."""
    sw = follow.Switch(); sw.on("실기 담당자", 1000.0)
    sw.alive(1300.0, CFG)
    assert sw.snapshot(1300.0, CFG)["on"] is False
    assert "스스로 껐다" in sw.snapshot(1300.0, CFG)["reason"]


# ── 카메라 → 로봇 (hand-eye) ───────────────────────────────────────────────
T_HANDEYE = [-25.9, -76.1, -81.7]


def test_실측_회차를_그대로_재현한다():
    """2026-08-13 7차 실측 — 이 값이 바뀌면 **어딘가가 조용히 달라진 것**이다.

    당시 스크래치 계산과 같은 답이 나와야 한다 (`docs/evidence/2026-08-13/handeye-no-touch.md`).
    """
    cam = [25.6, -15.3, 259.0]
    tcp = [343.6, -960.6, -122.8, 163.4, 15.7, 146.8]
    P, why = follow.cam_to_robot(cam, tcp, T_HANDEYE)
    assert why is None
    # ⚠ 허용치가 0.3mm 인 이유 — **기대값이 소수 1자리로 반올림된 기록**이라 입력(cam·tcp)에
    # 이미 ±0.05mm 가 실려 있다. 이보다 조이면 시험이 계산이 아니라 **반올림을 재게** 된다.
    # 판정에 걸리는 정밀도는 hand-eye 흩어짐 5.74mm 이고 여기는 그 20분의 1이다.
    for got, want in zip(P, [368.0, -1020.9, -311.4]):
        assert abs(got - want) < 0.3, f"{P} != 기대 [368.0, -1020.9, -311.4]"


def test_hand_eye_가_없으면_차단():
    P, why = follow.cam_to_robot([1.0, 2.0, 3.0], VERTICAL, None)
    assert P is None and "hand-eye" in why


def test_카메라값이_없으면_차단():
    P, why = follow.cam_to_robot(None, VERTICAL, T_HANDEYE)
    assert P is None and "결측" in why


def test_실기_프로필의_hand_eye_가_등재돼_있다():
    p = Path(__file__).with_name("config.yaml")
    doc = yaml.safe_load(p.read_text(encoding="utf-8"))
    lab = next(r for r in doc["robots"] if r["robotId"] == "fr5-lab-a")
    he = lab.get("handEye") or {}
    assert len(he.get("tMm") or []) == 3, "hand-eye 가 프로필에 없다"
    assert he["spreadMm"] < 10.0, "흩어짐이 그리퍼 여유 ±10mm(D122) 를 넘으면 파지가 안 선다"


# ── 설정 원본 대조 — **계약과 실제 값이 갈리면 여기서 잡는다** ──────────────
def test_실기_프로필의_follow_가_계약을_만족한다():
    p = Path(__file__).with_name("config.yaml")
    doc = yaml.safe_load(p.read_text(encoding="utf-8"))
    lab = next(r for r in doc["robots"] if r["robotId"] == "fr5-lab-a")
    cfg, why = follow.read_config(lab)
    assert why is None, f"실기 프로필의 follow 가 스스로 모순이다 — {why}"
    assert cfg["faceAxis"] == "z", "거치대를 위에서 본다 — 세운 총알을 따라갈 땐 y (D122)"
    # 표적과 면은 **한 몸이다** — 번호만 갈고 면을 안 보면 조용히 틀린 쪽에서 다가간다
    assert cfg["targetSource"] in follow.SOURCES
    assert isinstance(cfg["targetTagId"], int), "표적 번호는 프로필이 정한다 (계약 §무엇을 따라가나)"
    assert cfg["releaseMm"] > cfg["deadbandMm"] > 5.74, "문턱이 hand-eye 흩어짐보다 커야 한다"


# ── `unittest` 가 평문 함수를 걷게 한다 (`_plaintests.py` §왜) ───────────────
from _plaintests import load_tests_for  # noqa: E402


def load_tests(loader, tests, pattern):
    return load_tests_for(__name__)
