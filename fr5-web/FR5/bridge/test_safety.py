# safety.py 단위 테스트 — 표준 라이브러리 unittest (새 의존성 0).
#
# 왜 단위인가 — safety 는 표준 라이브러리만 쓰는 순수 함수라 제일 싸게 검증된다
# (`math`·`json`·`pathlib` — 형상 정본 `tool-hull.json`·`arm-hull.json` 을 읽는다). HTTP 통합
# (fr5-bridge-verify.mjs 38항목)은 "한 판이 도는가" 를 보고, 여기는 **조건 하나하나가
# 제대로 막는가** 를 본다. 조건이 26개라 조합을 통합으로만 덮을 수 없다.
#
# 규칙: 게이트는 사유 목록을 돌려주고 **비어 있을 때만 허용**이다 (제1원칙).
# 그래서 "차단됐다" 는 사유 문자열 일부로 확인한다.
import unittest

import safety

OK_SETTINGS = {"mismatch": []}          # 조건 26 통과용 최소 모양


def state(**over):
    """게이트를 통과하는 기준 상태 — 테스트마다 한 곳만 망가뜨린다."""
    base = {
        "enabled": True, "mode": 0, "motionQueueLength": 0,
        "jointsDeg": [0.0] * 6, "tcpMmDeg": [0.0] * 6,
        "safety": {"emergencyStop": False, "safetyStop": False, "collisionDetected": False,
                   "inDragTeach": False, "mainErrorCode": 0, "subErrorCode": 0},
        "coord": {"toolId": 0, "userId": 0},
    }
    if "safety" in over:
        base["safety"] = {**base["safety"], **over.pop("safety")}
    base.update(over)
    return base


def blocked(reasons, needle):
    return any(needle in r for r in reasons)


class MotionGate(unittest.TestCase):
    def gate(self, st=None, age=0.0, target=None, speed=None, applied=OK_SETTINGS,
             commanded=None):
        return safety.check_motion(st if st is not None else state(), age,
                                   target if target is not None else [0.0] * 6,
                                   safety.SPEED_CAP_PCT if speed is None else speed, applied,
                                   commanded_deg=commanded)

    def test_기준_상태는_통과한다(self):
        self.assertEqual(self.gate(), [])

    def test_상태_None_은_차단(self):
        self.assertTrue(blocked(safety.check_motion(None, 0.0, [0.0] * 6, 10, OK_SETTINGS),
                                "fail-closed"))

    def test_신선도_초과_차단(self):
        self.assertTrue(blocked(self.gate(age=safety.STATE_FRESH_S + 0.01), "낡았다"))

    def test_안전필드_결측은_차단(self):
        st = state()
        del st["safety"]["collisionDetected"]
        self.assertTrue(blocked(self.gate(st), "결측"))

    def test_비상정지_차단(self):
        self.assertTrue(blocked(self.gate(state(safety={"emergencyStop": True})), "비상정지"))

    def test_안전정지_차단(self):
        self.assertTrue(blocked(self.gate(state(safety={"safetyStop": True})), "안전정지"))

    def test_컨트롤러_오류_차단(self):
        self.assertTrue(blocked(self.gate(state(safety={"mainErrorCode": 7})), "오류"))

    def test_충돌_차단(self):
        self.assertTrue(blocked(self.gate(state(safety={"collisionDetected": True})), "충돌"))

    def test_드래그티칭_중_차단(self):
        self.assertTrue(blocked(self.gate(state(safety={"inDragTeach": True})), "드래그"))

    def test_큐가_남아있으면_차단(self):
        self.assertTrue(blocked(self.gate(state(motionQueueLength=2)), "큐"))

    def test_서보_off_차단(self):
        self.assertTrue(blocked(self.gate(state(enabled=False)), "서보"))

    def test_수동모드_차단(self):
        self.assertTrue(blocked(self.gate(state(mode=1)), "auto"))

    def test_현재값_NaN_은_차단(self):
        self.assertTrue(blocked(self.gate(state(jointsDeg=[float("nan")] + [0.0] * 5)),
                                "비정상"))

    def test_속도_상한_초과_차단(self):
        self.assertTrue(blocked(self.gate(speed=safety.SPEED_CAP_PCT + 0.1), "속도 상한"))

    def test_속도_0_이하_차단(self):
        self.assertTrue(blocked(self.gate(speed=0), "속도 상한"))

    def test_관절_변화_상한_초과_차단(self):
        over = [safety.JOINT_DELTA_CAP_DEG + 0.1] + [0.0] * 5
        self.assertTrue(blocked(self.gate(target=over), "관절 변화"))

    def test_목표가_6축_숫자가_아니면_차단(self):
        self.assertTrue(blocked(self.gate(target=[0.0] * 5), "6축"))

    # ── 드리프트 (조건 8 대안 · 계약 §드리프트 기준) ──────────────────────────
    # 기준은 **우리가 보낸 MoveJ 목표**다. 컨트롤러의 lastServoTarget 이 아니다.

    def test_우리_지령을_안_따라오면_차단(self):
        cmd = [safety.DRIFT_CAP_DEG + 1.0] + [0.0] * 5   # 실측은 전 축 0
        self.assertTrue(blocked(self.gate(commanded=cmd), "괴리"))

    def test_지령_이력이_없으면_드리프트를_건너뛴다(self):
        self.assertEqual(self.gate(commanded=None), [])

    def test_지령이_전부_0이어도_기준으로_쓴다(self):
        """옛 구현은 '전부 0 = 이력 없음'으로 뭉갰다. 원점 지령은 **실제 지령**이다."""
        st = state(jointsDeg=[safety.DRIFT_CAP_DEG + 1.0] + [0.0] * 5)
        self.assertTrue(blocked(self.gate(st, target=st["jointsDeg"], commanded=[0.0] * 6),
                                "괴리"))

    def test_컨트롤러_lastServoTarget_은_판정에_안_쓴다(self):
        """티치모드가 채워 넣은 값이 우리 명령을 영구히 잠그던 자리 (2026-08-06 실기 31.52°)."""
        st = state(lastServoTargetDeg=[31.52] + [0.0] * 5)
        self.assertEqual(self.gate(st), [])


class JointLimits(unittest.TestCase):
    """실기 컨트롤러가 보고한 소프트리밋과 대조해 확정된 값이다 (2026-08-04)."""

    def gate_target(self, target):
        # 현재값을 목표 근처에 둬서 5° 변화 상한에 걸리지 않게 한다
        cur = [min(max(t, -175), 175) for t in target]
        st = state(jointsDeg=cur)
        return safety.check_motion(st, 0.0, target, safety.SPEED_CAP_PCT, OK_SETTINGS)

    def test_j3_경계_160_은_통과(self):
        t = [0.0, 0.0, 160.0, 0.0, 0.0, 0.0]
        self.assertEqual([r for r in self.gate_target(t) if "한계" in r], [])

    def test_j3_161_은_차단_컨트롤러가_160_이다(self):
        t = [0.0, 0.0, 161.0, 0.0, 0.0, 0.0]
        self.assertTrue(blocked(self.gate_target(t), "j3"))

    def test_j2_비대칭_한계(self):
        self.assertTrue(blocked(self.gate_target([0.0, 86.0, 0.0, 0.0, 0.0, 0.0]), "j2"))
        self.assertEqual([r for r in self.gate_target([0.0, -260.0, 0.0, 0.0, 0.0, 0.0])
                          if "한계" in r], [])


class Condition26(unittest.TestCase):
    """안전 설정 기록이 없으면 모션을 막는다 — 충돌 감지가 켜졌는지 알 수 없기 때문 (D53)."""

    def test_설정_기록이_없으면_차단(self):
        r = safety.check_motion(state(), 0.0, [0.0] * 6, safety.SPEED_CAP_PCT, None)
        self.assertTrue(blocked(r, "조건 26"))

    def test_되읽기_불일치면_차단(self):
        applied = {"mismatch": ["payloadKg 기대 0.6 · 실제 1.6"]}
        r = safety.check_motion(state(), 0.0, [0.0] * 6, safety.SPEED_CAP_PCT, applied)
        self.assertTrue(blocked(r, "되읽기 불일치"))


class ArmGate(unittest.TestCase):
    def test_기준_상태는_통과한다(self):
        self.assertEqual(safety.check_arm(state(), 0.0), [])

    def test_상태_None_은_차단(self):
        self.assertTrue(blocked(safety.check_arm(None, 0.0), "fail-closed"))

    def test_낡은_상태로는_arm_하지_않는다(self):
        self.assertTrue(blocked(safety.check_arm(state(), safety.STATE_FRESH_S + 0.01), "낡았다"))

    def test_비상정지_중_arm_거부(self):
        self.assertTrue(blocked(safety.check_arm(state(safety={"emergencyStop": True}), 0.0),
                                "비상정지"))

    def test_arm_은_서보_off_에서도_통과한다(self):
        # arm 이 서보를 켜는 동작이다 — 여기서 서보 ON 을 요구하면 영원히 arm 할 수 없다
        self.assertEqual(safety.check_arm(state(enabled=False), 0.0), [])

    def test_드래그_티칭_중에는_arm_거부(self):
        # arm 은 마지막에 ExitDragTeach 를 부른다 — 사람 손 안에서 팔이 굳는다 (조건 25)
        self.assertTrue(blocked(safety.check_arm(state(safety={"inDragTeach": True}), 0.0),
                                "드래그 티칭"))


# 실기 프로필과 **같은 모양**이다 (config.yaml). 옛 `tableXmm`·`wallYmm` 한 벌에서
# `boxes[]`·`walls[]` 로 일반화했다 — 벽 선분은 옛 무한 평면(y < -1400)과 같은 판정이 되게 옮겼다.
WS = {"frame": {"toolId": 1, "userId": 1},
      "boxes": [{"name": "상판", "xMm": [-16.1, 842.0], "yMm": [-798.2, -210.9],
                 "topZMm": -345.8, "marginMm": 10}],
      "walls": [{"name": "벽", "aMm": [-1500.0, -1400.0], "bMm": [1500.0, -1400.0],
                 "marginMm": 100}]}
FRAME = {"toolId": 1, "userId": 1}

# **툴이 작업대 반대쪽(위)을 보는 자세.** 손끝 규칙만 떼어 재려고 쓴다 — 툴을 아래로 두면
# 손끝이 안전해도 툴이 걸려서 그 테스트가 무엇을 재는지 흐려진다. 툴 규칙은 `ToolGate` 가 잰다.
# rx 180° 면 회전이 diag(1,-1,-1) 이라 툴이 손끝에서 **+z 로** 뻗는다.
UP = [180.0, 0.0, 0.0]
DOWN = [0.0, 0.0, 0.0]          # 툴이 손끝에서 −z 로 뻗는다 (실제 작업 자세에 가깝다)


def at(x, y, z, rot=UP):
    """`check_workspace` 는 `[x,y,z,rx,ry,rz]` 를 받는다 — `forward_kin` 이 주는 모양 그대로."""
    return [x, y, z, *rot]


# 팔이 **어느 구역에도 안 드는** 자세와 유저 좌표계 원점. 손끝·툴 규칙만 떼어 재려고 쓴다 —
# 팔이 같이 걸리면 그 테스트가 무엇을 재는지 흐려진다. 팔 규칙은 `ArmGate` 가 따로 잰다.
CLEAR_Q = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
DEFS = {"user": [-401.846, 497.329, 342.076]}       # 실기에서 구운 값 (Sim/fixtures)


_DEFAULT = object()          # `ws=None`(작업영역 없음)과 「안 넘겼다」를 구별한다


def ws_check(tcp, ws=_DEFAULT, coord=_DEFAULT, q=CLEAR_Q, defs=DEFS):
    """`check_workspace` 를 **팔 인자까지 채워** 부른다. 안 채우면 결측=차단으로 막힌다."""
    return safety.check_workspace(tcp, WS if ws is _DEFAULT else ws,
                                  FRAME if coord is _DEFAULT else coord, q, defs)


class WorkspaceGate(unittest.TestCase):
    """조건 12 의 카테시안 절반 — 관절 한계만으로는 손끝이 상판을 뚫는 것을 못 막는다.
    실측 근거는 `docs/evidence/2026-08-05/workcell-measure.md`."""

    def test_상판_위는_통과한다(self):
        self.assertEqual(ws_check(at(400, -400, -100), WS, FRAME), [])

    def test_상판_아래로_가면_거부(self):
        # 상판 z -345.8 + 여유 10 = -335.8 보다 낮고, x·y 가 상판 안이면 뚫는 것이다
        self.assertTrue(blocked(ws_check(at(400, -400, -340), WS, FRAME),
                                "상판을 뚫는다"))

    def test_상판_밖에서는_같은_높이도_통과한다(self):
        # 상판 바깥은 더 내려가도 된다 — 높이 하나로 판정하면 이게 막힌다
        self.assertEqual(ws_check(at(1500, -400, -340), WS, FRAME), [])
        self.assertEqual(ws_check(at(400, -100, -340), WS, FRAME), [])

    def test_벽에_가까우면_거부(self):
        self.assertTrue(blocked(ws_check(at(400, -1350, 0), WS, FRAME),
                                "벽에 너무 가깝다"))

    def test_벽_여유_안쪽은_통과(self):
        # ⚠ 옛날엔 -1290 이었다. 툴이 손끝보다 y 로 14.5mm 더 나가므로 그 자리는 이제
        # **툴이** 걸린다 — 그 사실은 `ToolGate` 가 따로 잰다. 여기는 손끝 규칙만 본다.
        self.assertEqual(ws_check(at(400, -1280, 0), WS, FRAME), [])

    def test_벽을_뚫고_반대편에_서면_거부(self):
        """**거리만 재면 뚫린다.** 여유 밖으로 관통해 반대편에 서는 것을 옛 무한 평면은
        막았는데, 선분으로 바꾸며 거리만 보면 그 구멍이 생긴다 (2026-08-08)."""
        r = ws_check(at(400, -3000, 0), WS, FRAME)
        self.assertTrue(blocked(r, "뚫고 반대편"), r)

    def test_유한한_판_옆으로_도는_것은_통과(self):
        """벽이 선분인 이유다 — 788mm 짜리 판 **옆**은 지나갈 수 있어야 한다.
        무한 평면이면 여기가 막혀 쓸 수 있는 자리를 통째로 잃는다."""
        self.assertEqual(ws_check(at(5000, -3000, 0), WS, FRAME), [])

    def test_상판이_여러_개여도_각각_판정한다(self):
        """작업대가 카트 옆에 생긴다 — 줄 하나 더가 되어야 한다."""
        ws = dict(WS, boxes=WS["boxes"] + [
            {"name": "작업대", "xMm": [900.0, 1400.0], "yMm": [-400.0, 100.0],
             "topZMm": -200.0, "marginMm": 10}])
        self.assertEqual(ws_check(at(1000, -100, -100), ws, FRAME), [])
        self.assertTrue(blocked(ws_check(at(1000, -100, -250), ws, FRAME),
                                "작업대를 뚫는다"))
        # 새 상판이 옛 상판 판정을 안 흔든다
        self.assertTrue(blocked(ws_check(at(400, -400, -340), ws, FRAME),
                                "상판을 뚫는다"))

    def test_벽_선분이_망가졌으면_차단(self):
        """제1원칙 — 판정할 수 없으면 통과가 아니라 차단이다."""
        for bad in ({"aMm": [0, 0], "bMm": [0, 0]},          # 두 끝점이 같다
                    {"aMm": [0, 0], "bMm": ["x", 1]},
                    {"aMm": None, "bMm": [1, 1]},
                    {"aMm": [0, 0], "bMm": [float("nan"), 1]}):
            ws = dict(WS, walls=[dict(bad, name="벽", marginMm=100)])
            self.assertTrue(blocked(ws_check(at(400, -400, -100), ws, FRAME),
                                    "판정할 수 없다"), bad)

    def test_빈_목록은_그_항목을_판정하지_않는다(self):
        # 벽만 재고 상판을 아직 안 쟀을 수 있다 — 없는 것을 있다고 하지 않는다
        self.assertEqual(ws_check(at(400, -400, -9999), dict(WS, boxes=[]), FRAME), [])
        self.assertEqual(ws_check(at(400, -9999, 0), dict(WS, walls=[]), FRAME), [])

    def test_좌표계가_다르면_거부(self):
        # 같은 숫자가 다른 자리를 가리킨다 — 값이 거짓이 된다
        self.assertTrue(blocked(
            ws_check(at(400, -400, -100), WS, {"toolId": 0, "userId": 0}), "좌표계가"))

    def test_손끝을_못_구하면_차단(self):
        for bad in (None, [], [1, 2], [1, 2, float("nan")], ["a", "b", "c"], [True, 2, 3]):
            self.assertTrue(blocked(ws_check(bad, WS, FRAME), "결측=차단"), bad)

    def test_작업영역이_없으면_판정하지_않는다(self):
        # mock·미측정 프로필 — 없는 값을 지어내 막지 않는다 (사실은 /state.workspace 가 노출)
        self.assertEqual(ws_check([0, 0, -9999], None, FRAME), [])


class ArmLinkGate(unittest.TestCase):
    """조건 12 의 나머지 — **팔 링크**. (위 `ArmGate` 는 서보를 켜는 `arm` 명령이라 다른 것이다.)

    이 게이트가 없던 동안 무작위 4000자세 중 **720개(18.0%)** 가 손끝·툴은 통과인데
    팔 링크가 구역을 **실제로 관통**했다 (2026-08-11 · 무조코 접촉으로 실측)."""

    # 무작위 탐색으로 찾은 실제로 걸리는 자세다 (2026-08-11)
    BOX_Q = [-61.7, -212.2, 48.3, -239.6, 12.6, -47.0]      # forearm 이 상판을 뚫는다
    WALL_Q = [-86.7, -143.4, -43.5, -222.0, 122.1, 172.6]   # wrist1 이 벽 여유 안이다

    def test_형상과_체인을_읽었다(self):
        self.assertNotIsInstance(safety.ARM_HULL, Exception, safety.ARM_HULL)
        self.assertEqual(len(safety.ARM_HULL["chain"]), 6)

    def test_관절각이_없으면_차단(self):
        for bad in (None, [0.0, 0.0, 0.0], [0.0] * 5 + ["x"], [0.0] * 5 + [float("nan")]):
            self.assertTrue(blocked(ws_check(at(400, -400, -100), q=bad), "관절각을 못 구했다"), bad)

    def test_유저_좌표계_원점이_없으면_차단(self):
        """구역은 user1 기준인데 FK 는 베이스 기준이다 — 원점을 모르면 725mm 어긋난 자리를 잰다."""
        for bad in ({}, None, {"user": [1, 2]}, {"user": [1, 2, "x"]}):
            self.assertTrue(blocked(ws_check(at(400, -400, -100), defs=bad),
                                    "유저 좌표계 원점"), bad)

    def test_팔이_상판을_뚫으면_거부(self):
        r = ws_check(at(400, -400, -100), q=self.BOX_Q)
        self.assertTrue(blocked(r, "조건 12 · 팔"), r)
        self.assertTrue(any("뚫는다" in x and "조건 12 · 팔" in x for x in r), r)

    def test_팔이_벽에_가까우면_거부(self):
        r = ws_check(at(400, -400, -100), q=self.WALL_Q)
        self.assertTrue(any("벽에" in x and "조건 12 · 팔" in x for x in r), r)

    def test_구역_하나당_한_줄만_낸다(self):
        """링크 6개 × 꼭짓점 8개가 같은 상판에 걸리면 48줄이 나와 사람이 못 읽는다."""
        r = ws_check(at(400, -400, -100), q=self.BOX_Q)
        self.assertEqual(len([x for x in r if "조건 12 · 팔" in x and "뚫는다" in x]), 1, r)

    def test_base_link_은_판정하지_않는다(self):
        """로봇은 카트에 볼트로 앉아 있어 베이스 상자는 **언제나** 구역 안이다 (실측 100%).
        판정하면 모든 이동이 영구 거부된다."""
        self.assertIn("base_link", safety.ARM_SKIP_LINKS)
        # 베이스만 걸리는 프로필을 만들어도 통과해야 한다
        ws = dict(WS, boxes=[{"name": "카트", "xMm": [-9999, 9999], "yMm": [-9999, 9999],
                              "topZMm": -300.0, "marginMm": 0}])
        r = [x for x in ws_check(at(400, 0, 500), ws=ws, q=CLEAR_Q) if "조건 12 · 팔" in x]
        self.assertFalse(any("base_link" in x for x in r), r)


class ToolGate(unittest.TestCase):
    """조건 12 의 나머지 절반 — **손끝이 아니라 툴 전체**를 본다
    (`SAFETY-RULES.md` §작업영역은 손끝 한 점이 아니라).

    이 게이트가 없던 동안 무작위 자세 4000개 중 **425개(10.6%)** 가 손끝은 통과인데
    그리퍼·카메라가 구역 안이었다."""

    def test_형상을_읽었다(self):
        # 못 읽으면 게이트가 통째로 무의미해지므로 **먼저** 잰다
        self.assertNotIsInstance(safety.TOOL_CORNERS_MM, Exception, safety.TOOL_CORNERS_MM)
        self.assertEqual(len(safety.TOOL_CORNERS_MM), 5 * 8)     # 상자 5개 × 꼭짓점 8개

    def test_방향이_없으면_차단(self):
        """제1원칙 — 툴이 어디를 향하는지 모르면 통과시킬 근거가 없다."""
        for bad in ([400, -400, -100],                          # 셋뿐
                    [400, -400, -100, 0, 0],                    # 다섯뿐
                    [400, -400, -100, float("nan"), 0, 0],
                    [400, -400, -100, None, 0, 0],
                    [400, -400, -100, True, 0, 0]):
            self.assertTrue(blocked(ws_check(bad, WS, FRAME),
                                    "손끝 방향"), bad)

    def test_손끝은_상판_위인데_툴이_뚫으면_거부(self):
        """**이 게이트의 존재 이유.** 손끝 z -300 은 여유선 -335.8 위라 손끝 규칙은 통과다.
        그런데 툴이 아래로 135mm 뻗으므로 몸통은 -435 까지 내려가 상판을 뚫는다."""
        r = ws_check(at(400, -400, -300, DOWN), WS, FRAME)
        self.assertEqual(ws_check(at(400, -400, -300, UP), WS, FRAME), [],
                         "툴이 위를 보면 같은 손끝 자리가 안전해야 한다")
        self.assertTrue(blocked(r, "조건 12 · 툴"), r)
        self.assertFalse(any("손끝 z" in x for x in r), f"손끝 규칙까지 걸리면 격리가 안 된 것이다: {r}")

    def test_손끝은_벽_여유_안인데_툴이_걸리면_거부(self):
        """툴은 손끝보다 y 로 14.5mm 더 나간다 — 그 14.5mm 가 여유를 먹는다."""
        r = ws_check(at(400, -1290, 0), WS, FRAME)
        self.assertTrue(blocked(r, "조건 12 · 툴"), r)
        self.assertFalse(any("손끝까지" in x for x in r), f"손끝 규칙이 아니어야 한다: {r}")

    def test_구역_하나당_한_줄만_낸다(self):
        """꼭짓점 40개가 같은 상판에 걸리면 40줄이 나와 사람이 못 읽는다.
        (손끝 규칙도 같이 걸리는 자세라 **툴 줄만** 센다 — 손끝 줄은 별개다.)"""
        r = ws_check(at(400, -400, -400, DOWN), WS, FRAME)
        self.assertEqual(len([x for x in r if "조건 12 · 툴" in x]), 1, r)

    def test_툴_판정은_손끝_판정을_포함한다(self):
        """반대 방향이 0 건이라는 것이 이 규칙이 안전한 이유다 — 손끝이 걸리는데
        툴이 안 걸리는 자세는 없어야 한다 (손끝은 툴 상자 안에 있다)."""
        for z in (-340, -360, -400):
            r = ws_check(at(400, -400, z, DOWN), WS, FRAME)
            self.assertTrue(any("손끝 z" in x for x in r), z)
            self.assertTrue(any("조건 12 · 툴" in x for x in r), z)


class ModeGate(unittest.TestCase):
    """모드 전환은 **로봇을 움직이지 않는다** — 움직임의 전제(설정 기록·충돌 감지)를 걸지 않는다."""

    def test_기준_상태에서_수동_전환_통과(self):
        self.assertEqual(safety.check_mode(state(), 0.0, True), [])

    def test_기준_상태에서_자동_복귀_통과(self):
        self.assertEqual(safety.check_mode(state(mode=1), 0.0, False), [])

    def test_서보가_켜져_있어도_통과한다(self):
        # 드래그 티칭은 서보가 켜져 있어야 된다 — ARMED 를 막으면 잠긴 상태를 못 푼다
        self.assertEqual(safety.check_mode(state(enabled=True), 0.0, True), [])

    def test_서보가_꺼져_있어도_통과한다(self):
        self.assertEqual(safety.check_mode(state(enabled=False), 0.0, True), [])

    def test_manual_이_불리언이_아니면_거부(self):
        self.assertTrue(blocked(safety.check_mode(state(), 0.0, "manual"), "true/false"))
        self.assertTrue(blocked(safety.check_mode(state(), 0.0, None), "true/false"))

    def test_상태_None_은_차단(self):
        self.assertTrue(blocked(safety.check_mode(None, 0.0, True), "fail-closed"))

    def test_낡은_상태로는_바꾸지_않는다(self):
        self.assertTrue(blocked(
            safety.check_mode(state(), safety.STATE_FRESH_S + 0.01, True), "낡았다"))

    def test_비상정지_중_거부(self):
        self.assertTrue(blocked(
            safety.check_mode(state(safety={"emergencyStop": True}), 0.0, True), "비상정지"))

    def test_모션_큐가_차_있으면_거부(self):
        self.assertTrue(blocked(safety.check_mode(state(motionQueueLength=2), 0.0, True),
                                "모션 큐"))

    def test_안전_설정_기록이_없어도_통과한다(self):
        # 조건 26 은 **움직임**의 전제다. 권한만 넘기는 전환에 걸면 영원히 못 바꾼다
        self.assertEqual(safety.check_mode(state(), 0.0, True), [])

    def test_수동_모드에서는_조그가_막힌다(self):
        # 하드 룰 4 를 지키는 것은 전환 금지가 아니라 **이 게이트**다 — 여기가 뚫리면
        # 사람이 팔을 잡고 있는데 웹에서 움직일 수 있게 된다
        self.assertTrue(blocked(
            safety.check_motion(state(mode=1), 0.0, [0.0] * 6, safety.SPEED_CAP_PCT, OK_SETTINGS),
            "auto 모드가 아니다"))


class GripperGate(unittest.TestCase):
    """그리퍼는 **관절이 아니다.** 관절 게이트를 복붙하면 통과할 수 없거나 엉뚱하게 막는다."""

    def gstate(self, **over):
        grip = {"pctRaw": 50, "pct": None, "fault": False,
                "motionDone": True, "active": True, "calibrated": False}
        grip.update(over.pop("gripper", {}))
        return state(gripper=grip, **over)

    def gate(self, st=None, age=0.0, pct=50, applied=OK_SETTINGS):
        return safety.check_gripper(st if st is not None else self.gstate(), age, pct, applied)

    def test_기준_상태는_통과한다(self):
        self.assertEqual(self.gate(), [])

    # ── 관절 게이트를 타지 않는다 (감사 P1) ─────────────────────────────
    def test_모션큐가_차_있어도_그리퍼는_움직인다(self):
        # 팔이 이동 중이어도 손가락은 따로다. 모션큐를 걸면 pick 이 성립하지 않는다
        self.assertEqual(self.gate(self.gstate(motionQueueLength=3)), [])

    def test_수동_모드에서도_그리퍼는_움직인다(self):
        # auto 모드 요구는 MoveJ 의 조건이다 — 그리퍼까지 걸면 티칭 중 개폐를 못 한다
        self.assertEqual(self.gate(self.gstate(mode=1)), [])

    def test_관절값이_비정상이어도_그리퍼는_판정하지_않는다(self):
        self.assertEqual(self.gate(self.gstate(jointsDeg=[float("nan")] * 6)), [])

    # ── 그리퍼 고유 조건 ───────────────────────────────────────────────
    def test_활성화_전에는_거부(self):
        self.assertTrue(blocked(self.gate(self.gstate(gripper={"active": False})), "활성화"))

    def test_고장_신호면_거부(self):
        self.assertTrue(blocked(self.gate(self.gstate(gripper={"fault": True})), "고장"))

    def test_그리퍼_필드_결측은_차단(self):
        self.assertTrue(blocked(self.gate(self.gstate(gripper={"fault": None})), "결측"))

    def test_그리퍼_상태_자체가_없으면_차단(self):
        st = state()
        st.pop("gripper", None)
        self.assertTrue(blocked(self.gate(st), "못 읽었다"))

    def test_pct_범위_밖은_거부(self):
        for bad in (-1, 101, float("nan"), "50", None, True):
            self.assertTrue(blocked(self.gate(pct=bad), "0~100"), f"{bad!r} 가 통과했다")

    # ── 공통 관문은 그대로 탄다 ────────────────────────────────────────
    def test_서보_off_면_거부(self):
        self.assertTrue(blocked(self.gate(self.gstate(enabled=False)), "서보 OFF"))

    def test_비상정지_중_거부(self):
        self.assertTrue(blocked(self.gate(self.gstate(safety={"emergencyStop": True})), "비상정지"))

    def test_드래그_티칭_중_거부(self):
        self.assertTrue(blocked(self.gate(self.gstate(safety={"inDragTeach": True})), "드래그"))

    def test_낡은_상태는_거부(self):
        self.assertTrue(blocked(self.gate(age=safety.STATE_FRESH_S + 0.01), "낡았다"))

    def test_안전설정_기록이_없으면_거부(self):
        self.assertTrue(blocked(self.gate(applied=None), "조건 26"))

    def test_상태_None_은_차단(self):
        # gate() 헬퍼는 None 을 '기본값 쓰라'로 읽으므로 여기만 직접 부른다
        self.assertTrue(blocked(safety.check_gripper(None, 0.0, 50, OK_SETTINGS), "fail-closed"))


class SpeedOverrideGate(unittest.TestCase):
    """전역 속도 오버라이드 게이트 (계약 §speed).

    **이 테스트가 지키는 것은 하한 1 이다.** `0` 을 보낼 수 있게 두면 우리가 2026-08-12 의
    사고를 재현할 수 있다 — 그 값이 0 이어서 외부 `MoveJ` 가 18/18 `code=172`
    ("Motion Speed Cannot Be 0")로 거부됐고, 화면에 그 값이 보이지도 않아 반나절을 썼다.
    """

    def _state(self, estop=False):
        return {"safety": {"emergencyStop": estop}}

    def test_0_은_거부한다(self):
        # ⛔ 이 한 줄이 오늘의 사고를 우리가 재현하지 못하게 막는다
        reasons = safety.check_speed_override(self._state(), 0.0, 0)
        self.assertTrue(any("허용 범위" in r for r in reasons), reasons)

    def test_하한과_상한은_통과한다(self):
        for v in (safety.SPEED_OVERRIDE_MIN_PCT, safety.SPEED_OVERRIDE_CAP_PCT):
            with self.subTest(pct=v):
                self.assertEqual(safety.check_speed_override(self._state(), 0.0, v), [])

    def test_상한_위는_거부한다(self):
        # 그 이상은 펜던트에서 사람이 — 화면에서 크게 올릴 수 있으면 vel 상한 10% 가 무의미해진다
        reasons = safety.check_speed_override(self._state(), 0.0,
                                              safety.SPEED_OVERRIDE_CAP_PCT + 1)
        self.assertTrue(any("허용 범위" in r for r in reasons), reasons)

    def test_정수가_아니면_거부한다(self):
        for v in (None, "30", 30.5, True):
            with self.subTest(pct=v):
                self.assertTrue(safety.check_speed_override(self._state(), 0.0, v))

    def test_비상정지면_거부한다(self):
        reasons = safety.check_speed_override(self._state(estop=True), 0.0, 30)
        self.assertTrue(any("비상정지" in r for r in reasons), reasons)

    def test_상태를_못_읽으면_차단한다(self):
        self.assertTrue(safety.check_speed_override(None, 0.0, 30))

    def test_낡은_상태는_거부한다(self):
        reasons = safety.check_speed_override(self._state(), 3.0, 30)
        self.assertTrue(any("낡았다" in r for r in reasons), reasons)


if __name__ == "__main__":
    unittest.main()


class PathSamples(unittest.TestCase):
    """지점 이동의 경로 표본 (D75) — `MoveJ` 가 실제로 가는 길을 5°씩 끊는다."""

    def test_끝점을_포함하고_시작점은_뺀다(self):
        poses = safety.path_samples([0] * 6, [10, 0, 0, 0, 0, 0])
        self.assertEqual(len(poses), 2)                      # 10° / 5° = 2칸
        self.assertEqual([round(v, 6) for v in poses[0]], [5, 0, 0, 0, 0, 0])
        self.assertEqual([round(v, 6) for v in poses[-1]], [10, 0, 0, 0, 0, 0])

    def test_가장_큰_축이_간격을_정한다(self):
        # j1 은 1° 인데 j3 가 20° — 20/5 = 4칸이 나와야 한다
        poses = safety.path_samples([0] * 6, [1, 0, 20, 0, 0, 0])
        self.assertEqual(len(poses), 4)
        self.assertAlmostEqual(poses[-1][2], 20.0)

    def test_모든_축이_동시에_비례로_움직인다(self):
        poses = safety.path_samples([0] * 6, [10, -10, 0, 0, 0, 0])
        self.assertAlmostEqual(poses[0][0], 5.0)
        self.assertAlmostEqual(poses[0][1], -5.0)

    def test_5도_이하면_한_칸_그리고_그게_목표다(self):
        poses = safety.path_samples([0] * 6, [2, 0, 0, 0, 0, 0])
        self.assertEqual(len(poses), 1)
        self.assertAlmostEqual(poses[0][0], 2.0)

    def test_제자리면_한_칸(self):
        poses = safety.path_samples([1] * 6, [1] * 6)
        self.assertEqual(len(poses), 1)

    def test_결측이면_None_이지_빈_목록이_아니다(self):
        # 빈 목록을 주면 "검사할 게 없다 = 통과" 로 읽힌다 — 결측은 차단이어야 한다
        self.assertIsNone(safety.path_samples([0] * 5, [0] * 6))
        self.assertIsNone(safety.path_samples([0] * 6, [0, 0, 0, 0, 0, float("nan")]))
        self.assertIsNone(safety.path_samples([], []))

    def test_먼_이동도_표본이_유한하다(self):
        # j1 은 ±175 라 최대 350° — 70칸. 무한 루프·FK 폭주가 안 나는지
        poses = safety.path_samples([-175, 0, 0, 0, 0, 0], [175, 0, 0, 0, 0, 0])
        self.assertEqual(len(poses), 70)


class LargeMoveGate(unittest.TestCase):
    """`delta_cap=None` 은 **경로를 대신 검사했을 때만** 쓴다 (D75)."""

    def _state(self):
        return {"jointsDeg": [0] * 6, "tcpMmDeg": [0] * 6, "enabled": True, "mode": 0,
                "motionQueueLength": 0, "gripper": {"fault": False},
                "safety": {"emergencyStop": False, "safetyStop": False,
                           "collisionDetected": False, "inDragTeach": False,
                           "mainErrorCode": 0, "subErrorCode": 0}}

    def test_기본은_여전히_5도에서_거부한다(self):
        reasons = safety.check_motion(self._state(), 0.0, [30, 0, 0, 0, 0, 0], 10,
                                      OK_SETTINGS)
        self.assertTrue(any("관절 변화" in r for r in reasons), reasons)

    def test_경로를_검사했으면_큰_이동이_통과한다(self):
        reasons = safety.check_motion(self._state(), 0.0, [30, 0, 0, 0, 0, 0], 10,
                                      OK_SETTINGS, delta_cap=None)
        self.assertEqual(reasons, [], reasons)

    def test_상한을_빼도_URDF_한계는_그대로다(self):
        reasons = safety.check_motion(self._state(), 0.0, [200, 0, 0, 0, 0, 0], 10,
                                      OK_SETTINGS, delta_cap=None)
        self.assertTrue(any("URDF 한계" in r for r in reasons), reasons)

    def test_상한을_빼도_속도_10퍼센트는_그대로다(self):
        reasons = safety.check_motion(self._state(), 0.0, [30, 0, 0, 0, 0, 0], 50,
                                      OK_SETTINGS, delta_cap=None)
        self.assertTrue(any("속도 상한" in r for r in reasons), reasons)

    def test_상한을_빼도_서보_OFF_는_거부다(self):
        st = self._state() | {"enabled": False}
        reasons = safety.check_motion(st, 0.0, [30, 0, 0, 0, 0, 0], 10, OK_SETTINGS,
                                      delta_cap=None)
        self.assertTrue(any("서보 OFF" in r for r in reasons), reasons)
