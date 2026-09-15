# 로봇 세션 — 연결 하나의 상태를 소유한다 (명령 주인이 한 명이듯 관문의 로봇도 하나다 · 하드룰 4).
#
# 왜 클래스인가 — 상태가 dict 로 흩어져 있을 때 "빈 세션이 무엇인가" 가 세 곳(init·fail_closed·
# disconnect)에 서로 다르게 적혀 있었다. 필드를 하나 늘리면 세 곳을 다 고쳐야 하고, 빠뜨리면
# 끊긴 뒤에도 옛 기록이 남는다 (2026-08-04 실제로 겪었다 · D54). 여기서는 clear() 하나가
# 빈 세션의 유일한 정의다.
#
# tb-bridge 의 RunStore·OwnerRegistry 와 같은 모양이다 — 도메인은 클래스, 라우트는 얇게.
# 이 모듈은 main 을 모른다 (순환 import 금지).
import math
import time
from pathlib import Path

import amr
import anchors
import fixture
import preflight
import safety

BAD_READS_LIMIT = 3     # 유니티 실측 정책 — 연속 3회 불량이면 연결 손실 판정 (API-CONTRACT §실기)

# 되읽기가 없는 항목 — SDK 에 Get 이 아예 없다 (STACK §로봇 안전 설정 API).
# "확인했다" 고 적지 않고 "넣었다" 고만 적는다 (D53).
UNVERIFIABLE_SETTINGS = ["collisionLevel", "collisionStrategy", "collisionMode",
                         "installPos", "powerLimitW",
                         "collisionSafeTimeMs", "collisionSafeDistanceMm",
                         "collisionSafeVelMmS", "collisionSafetyMargin"]
SETTING_TOL = {"payloadKg": 0.05, "cogMm": 1.0}     # 되읽기 허용 오차 (kg · mm)


def _within(got, want, tol):
    """되읽은 값이 기대값 근처인가. **NaN 은 통과가 아니라 불일치다** (감사 2026-08-05 P0-3).

    `abs(nan - 0.6) > 0.05` 은 파이썬에서 `False` 라 부등호만 쓰면 NaN 이 조용히 통과한다.
    그러면 말단 하중·무게중심이 로봇에 안 들어간 채 ARM 된다 — 그 둘이 없으면 충돌 감지가
    오작동한다(`fairino.py` §하중이 먼저다). 제1원칙 그대로 **못 읽으면 차단**이다.
    """
    if isinstance(got, bool) or not isinstance(got, (int, float)) or not math.isfinite(got):
        return False
    return abs(float(got) - float(want)) <= tol


class RobotSession:
    def __init__(self, sample_ms, on_log):
        # 비전이 주는 움직이는 장애물의 산출 파일 (계약 §움직이는 장애물).
        # **인스턴스 필드다** — 시험이 갈아끼울 수 있어야 「없을 때·깨졌을 때」를 덮는다
        self.fixturePath = str(Path(__file__).resolve().parents[2]
                               / "Shared" / "data" / "config" / "fixture-pose.json")
        self._sample_ms = sample_ms
        self._log = on_log
        self.clear()

    def clear(self, phase="DISCONNECTED", fail_reason=None):
        """빈 세션의 **유일한 정의**. 필드를 늘리면 여기만 고친다."""
        self.profile = None
        self.adapter = None
        self.phase = phase
        self.failReason = fail_reason
        self.version = None
        self.observedAt = None
        self.armed = False
        self.lastState = None
        self.lastStateAt = 0.0
        self.badReads = 0
        self.appliedSettings = None
        self.workspace = None
        # 손목 변환 — **프로필이 정본**이고 여기는 실어 나르기만 한다 (계약 §hand-eye 유효성).
        # 기본값을 두지 않는 이유는 `follow.cam_to_robot` 과 같다: 캘리브 안 된 셀에서 남의
        # 값으로 조용히 도는 것이 제일 나쁘다
        self.handEye = None
        # 좌표계 정의는 사람이 펜던트에서 바꿀 때만 변한다 — 매 틱 xmlrpc 를 때리지 않고
        # `coord` 번호가 바뀔 때만 다시 읽는다 (계약 §좌표계 정의)
        self.coordDefs = None
        self._coordDefsFor = None
        # 그리퍼 정체 — 활성화 때 읽은 **원본**. 소급해 못 채우는 값이라 궤적 stamp 에 싣는다
        # (D46·D81). 해석은 안 한다 — 계약 §궤적 녹화 참조
        self.gripperConfig = None
        # 드리프트 기준 — **우리가 마지막으로 보낸 MoveJ 목표** (계약 §드리프트 기준).
        # None 이면 검사하지 않는다. 컨트롤러의 lastServoTarget 을 쓰지 않는 이유는 계약에.
        self.lastCommandedDeg = None
        self.motionTarget = None          # 마지막으로 **보낸** 이동 목표 (계약 §이동 목표 · D196) — `commands.motion` 만 쓴다
        # 전역 속도 오버라이드 — **되읽기가 없어서 「보낸 값」만 안다** (계약 §speed).
        # SDK 에 `SetSpeed` 만 있고 getter 도 구조체 필드도 없다. 그래서 `None` 은 「모른다」이고
        # 숫자는 「우리가 보냈다」다 — 화면은 그 둘을 다르게 보여야 한다. 펜던트에서 누가
        # 바꾸면 이 값은 거짓이 된다. **거짓 확신이 값을 안 보여주는 것보다 나쁘다.**
        self.speedOverridePct = None

    def open(self, profile, adapter, version, state):
        """preflight 를 통과한 연결을 세션에 앉힌다."""
        now = time.time()
        self.profile = profile
        self.adapter = adapter
        # settings 는 **로봇에 넣는 값**이고(D53) 작업영역은 **우리 게이트가 쓰는 값**이라
        # 프로필 최상위에 둔다 — 섞으면 appliedSettings 되읽기 대조에 끼어든다
        self.workspace = profile.get("workspace")
        # 프로필 상자에 **출처를 박는다** — 화면이 「사람이 잰 값」과 「비전이 준 자리」를
        # 색으로 갈라야 한다 (계약 §움직이는 장애물). 없으면 `profile` 로 읽는 규약이지만,
        # 명시하는 편이 다음 사람에게 싸다
        if isinstance(self.workspace, dict):
            for b in self.workspace.get("boxes") or []:
                b.setdefault("source", "profile")
        self.handEye = profile.get("handEye")
        self.phase = "OBSERVE_ONLY"
        self.failReason = None
        self.version = version
        self.observedAt = now
        self.lastState = state
        self.lastStateAt = now
        self.badReads = 0
        self.lastCommandedDeg = None
        self.motionTarget = None          # 마지막으로 **보낸** 이동 목표 (계약 §이동 목표 · D196) — `commands.motion` 만 쓴다
        # 로봇이 바뀌면 그리퍼도 바뀐다 — 이전 연결의 정체를 물려주지 않는다
        self.gripperConfig = None

    # ── 상태 ────────────────────────────────────────────────────────────────
    def current_phase(self, owner_who):
        if self.adapter is None:
            return self.phase
        if self.armed:
            return "EXECUTING" if (self.lastState or {}).get("motionQueueLength") else "ARMED"
        return "OWNER_HELD" if owner_who else "OBSERVE_ONLY"

    def read_fresh_state(self):
        """어댑터에서 지금 읽고 세션에 기록한다. 실패는 fail-closed.

        비정상 수치(NaN/inf — SDK 워밍업·전송 오류)는 그 샘플을 버리고 직전 값을 유지한다.
        타임스탬프를 안 올리므로 신선도 게이트가 모션을 막는다. 연속 3회면 연결 손실 판정.
        """
        state = self.adapter.read_state()
        numbers = list(state.get("jointsDeg") or []) + list(state.get("tcpMmDeg") or [])
        if len(numbers) != 12 or not all(
                isinstance(v, (int, float)) and math.isfinite(v) for v in numbers):
            self.badReads += 1
            self._log("bad-read", f"{self.badReads}/{BAD_READS_LIMIT} — 비정상 수치 샘플 폐기")
            if self.badReads >= BAD_READS_LIMIT:
                raise ConnectionError(f"연속 {BAD_READS_LIMIT}회 비정상 상태 — 연결 손실 판정")
            if self.lastState is not None:
                return self.lastState
            raise ConnectionError("첫 상태부터 비정상 수치 — fail-closed")
        self.badReads = 0
        # 사람이 팔을 잡으면 우리 지령은 더 이상 실측의 기준이 아니다 (계약 §드리프트 기준).
        # 여기서 비우는 이유 — 펜던트가 직접 티칭을 켠 경우까지 한 곳에서 잡힌다.
        if ((state.get("safety") or {}).get("inDragTeach")
                and self.lastCommandedDeg is not None):
            self.lastCommandedDeg = None
            self.motionTarget = None          # 마지막으로 **보낸** 이동 목표 (계약 §이동 목표 · D196) — `commands.motion` 만 쓴다
            self._log("드리프트-기준-해제", "드래그 티칭 — 사람이 팔을 옮긴다")
        self.lastState = state
        self.lastStateAt = time.time()
        return state

    def fresh_state(self):
        """지금 읽고 **신선도까지** 본다 → `(state, reasons)`. 캐시된 마지막 값을 신선한
        자세로 굳히지 않는다 (감사 P2). 실패는 fail-closed 로 넘긴다."""
        if self.adapter is None:
            return None, ["미연결 — 읽을 상태가 없다"]
        try:
            state = self.read_fresh_state()
        except Exception as e:
            self.fail_closed(f"상태 읽기 실패 — {e}")
            return None, [f"상태 읽기 실패 — {e}"]
        age = time.time() - self.lastStateAt
        if age > safety.STATE_FRESH_S:
            return None, [f"상태가 낡았다 — {age:.2f}s (상한 {safety.STATE_FRESH_S}s · 조건 10)"]
        return state, []

    def stamp(self, gripper_force_pct):
        """**잰 조건.** 이게 없으면 속도 상한 10%로 잰 것과 30%로 잰 것을 나란히 놓게
        되고 "A 가 B 보다 몇 % 빠르다" 가 거짓말이 된다 (D74 · 계약 §궤적 녹화)."""
        v = self.version or {}
        ws = self.workspace or {}
        coord = (self.lastState or {}).get("coord") or {}
        return {"robotId": (self.profile or {}).get("robotId"),
                "toolId": coord.get("toolId", 0), "userId": coord.get("userId", 0),
                "firmware": v.get("controller"),
                "speedCapPct": safety.SPEED_CAP_PCT,
                "gripperForcePct": gripper_force_pct,
                "workspaceRev": ws.get("rev") or ("측정됨" if ws else None),
                "gripperConfig": self.gripperConfig}

    def effective_workspace(self):
        """프로필 작업영역 + **비전이 준 움직이는 장애물** (계약 §움직이는 장애물 · D130).

        ⛔ **비전은 상자를 더할 뿐 프로필 상자를 못 건드린다.** 지우지도, 줄이지도 못한다 —
        이 함수가 그 규약이 지켜지는 유일한 자리다. 게이트(`safety.check_workspace`)와 화면이
        **같은 값**을 보게 하려고 `/state` 를 내는 여기 한 곳에서만 합친다.

        프로필에 작업영역이 아예 없으면 **비전 상자도 안 얹는다** — 판정이 꺼진 셀에서
        상자 하나만 살아 있으면 「일부만 막는다」가 되어 사람이 전체가 막힌다고 오해한다.
        """
        ws = self.workspace
        if not isinstance(ws, dict):
            return ws
        # 기준은 **프로필 상자**다 — 비전이 준 자리가 사람이 잰 상판 위인지 본다
        box, note = fixture.box_from(self.fixturePath, tables=ws.get("boxes"))
        if box is None and note is None:
            return ws
        out = dict(ws)
        out["boxes"] = list(ws.get("boxes") or []) + ([box] if box else [])
        if note:
            # **못 만든 이유가 조용히 사라지지 않게 한다** — 화면이 이걸 읽어 말한다
            out["fixtureNote"] = note
        return out

    def hand_eye(self):
        """손목 변환 요약 — **판정은 `tMm` 존재 하나뿐이다** (계약 §hand-eye 유효성 · D145).

        `spreadMm`·`measuredAt` 은 **판정이 아니라 고지**다. 문턱을 여기 두지 않는다 —
        「흩어짐 몇 mm 부터 거부」는 작업이 요구하는 여유를 알아야 정해지는데 그건 물체마다
        다르다 (D122 는 세워 꽂기에서 ±10mm 라고만 말한다).

        ⚠ 관문의 `calibId` 와 **다른 질문**이다 — 그건 장치 동일성이고 이건 좌표 변환이다.
        """
        he = self.handEye
        if not isinstance(he, dict):
            return None
        t = he.get("tMm")
        # 셋이 안 차면 옮길 수 없다 — 「있는데 못 쓰는 값」을 있는 것처럼 내지 않는다
        if not isinstance(t, (list, tuple)) or len(t) < 3:
            return None
        return {"tMm": list(t)[:3], "spreadMm": he.get("spreadMm"),
                "measuredAt": he.get("measuredAt"),
                # 2026-09-07 — 거울 쌍 재보정 고지 셋(계약 §hand-eye 유효성). `singleView` 만 화면이 판정에 쓴다(한 눈으로 끝)
                "biasCorrectedAt": he.get("biasCorrectedAt"), "residualMm": he.get("residualMm"),
                "singleView": bool(he.get("singleView", False))}

    def snapshot(self, owner_who):
        """미연결에도 같은 스키마 — 클라이언트가 빈 응답을 따로 처리하지 않는다 (D40)."""
        base = {
            "t": time.time(),
            "robotId": None, "connected": False, "enabled": False, "mode": 1,
            "jointsDeg": [0, 0, 0, 0, 0, 0], "tcpMmDeg": [0, 0, 0, 0, 0, 0],
            "motionQueueLength": 0,
            "motionTarget": self.motionTarget,
            "safety": {"code": 0, "emergencyStop": False, "safetyStop": False,
                       "collisionDetected": False, "inDragTeach": False,
                       "mainErrorCode": 0, "subErrorCode": 0},
            "coord": {"toolId": 0, "userId": 0},
            "coordDefs": self.coordDefs,
            "sampleMs": self._sample_ms,
            # 값 + **출처**를 같이 낸다 — `sent` 는 실측이 아니다 (계약 §speed)
            "speedOverridePct": self.speedOverridePct,
            "speedOverrideSource": "sent" if self.speedOverridePct is not None else "unknown",
            "gripper": {"opened": True, "pos": 0},
            "owner": owner_who,
            "phase": self.phase, "failReason": self.failReason,
            "appliedSettings": self.appliedSettings,
            # 작업영역이 없으면 손끝 판정이 꺼진 것이다 — 조용히 사라지지 않게 노출한다
            "workspace": self.effective_workspace(),
            # 손목 변환도 같은 이유로 여기 있다 — **없다는 사실이 화면에 보여야** 한다.
            # 정적 값이지만 `workspace` 와 한 자리에 두어 「프로필이 뭘 줬나」를 한 번에 읽는다
            "handEye": self.hand_eye(),
            # 앵커 상주가 **왜 안 도는지** — `fixtureNote` 와 같은 관례다 (D146 자기리뷰).
            # 없으면 상주가 죽어도 `scene-anchors.json` 이 얼어붙은 채 화면은 조용하다.
            # 오늘 고친 병(낡은 값이 초록으로 남는다)을 새 상주가 그대로 물려받을 뻔했다
            "anchorNote": anchors.note(),
            # 터틀봇 상주도 **같은 관례**다 (2026-08-31 · D158). 없으면 바퀴가 끊겨도
            # 화면은 「태그가 안 보인다」만 말하고 진짜 원인(랜·전원)을 못 짚는다
            "amrNote": amr.note(),
            # 조건 27 의 재료를 그대로 노출 — 화면이 「왜 거부됐나」를 같은 값으로 본다 (계약 §상호 배제)
            "amr": amr.motion_status(),
            # 색 상주도 **같은 관례**다 (2026-09-04). 없으면 추적기가 죽어도 화면은
            # 「표적 파일이 없다」만 말하고 **왜 없는지**를 못 짚는다 — 오늘 그랬다.
            "colorNote": anchors.note("color"),
            # ⛔ **상주는 조용히 죽는다** — 09-04 에 `pillow` 임포트 하나로 손목 상주가
            #    안 떴는데 화면엔 아무 표시가 없었다. 사유를 밖으로 낸다.
            "wristNote": anchors.note("wrist"),
        }
        if self.adapter is None:
            return base
        try:
            state = self.read_fresh_state()
        except Exception as e:              # 읽기 실패 = 연결 손실 — fail-closed (계약 §안전)
            self.fail_closed(f"상태 읽기 실패 — {e}")
            base.update(phase="FAIL_CLOSED", failReason=self.failReason)
            return base
        base.update({k: v for k, v in state.items()
                     if k not in ("missing", "lastServoTargetDeg")})
        base.update(robotId=self.profile["robotId"], connected=True,
                    phase=self.current_phase(owner_who))
        base["coordDefs"] = self._coord_defs(base.get("coord"))
        # ⛔ **손끝을 여기서 붙들어 둔다** (2026-09-04). 추종은 `session.tcpMmDeg` 를 읽는데
        # 그 속성은 **존재한 적이 없었다** — 값은 이 딕셔너리 안에만 살았다. 그래서
        # `follow_goal` 이 **한 번도 목표를 계산하지 못하고** 늘 「손끝 자세를 못 읽었다」를
        # 냈다. 08-28 의 `session.user1` 과 **같은 병**이다(없는 속성을 읽고 결측으로 떨어진다).
        # ⚠ 값과 **잰 시각을 같이** 든다 — 안 그러면 아무도 안 폴링한 사이의 낡은 손끝으로
        #   목표를 만든다. 나이 판정은 읽는 쪽이 한다 (`main.follow_tcp`).
        self.tcpMmDeg, self.tcpAt = base.get("tcpMmDeg"), time.time()
        return base

    def _coord_defs(self, coord):
        """활성 좌표계의 **정의**. 번호가 그대로면 캐시를 준다.

        번호만으로는 `tcpMmDeg` 가 어느 원점 기준인지 알 수 없다 — 로봇이 자기 밑에 앉은
        판을 `(305, -516)` 으로 보고해도 아무도 못 알아챈다 (2026-08-07).

        ⚠ **2026-08-11 부터 이 값은 판정 입력이다.** 팔 링크 FK 는 베이스 기준이고 구역은
        user1 기준이라, `user` 원점이 없으면 작업영역 게이트가 팔을 판정할 수 없다
        (`safety._check_arm_links` · `SAFETY-RULES.md` §팔 링크도 본다).
        그래서 **읽기 실패는 여기서 조용히 넘기되 게이트가 막는다** — 아래 except 는 `user` 를
        `None` 으로 남기고, 그 `None` 이 조건 12 에서 차단 사유가 된다. 여기서 기본값을
        지어내면 그 순간 **엉뚱한 자리를 막거나 뚫린 채 통과한다.**
        """
        key = (coord or {}).get("toolId"), (coord or {}).get("userId")
        if self.coordDefs is not None and self._coordDefsFor == key:
            return self.coordDefs
        try:
            self.coordDefs = self.adapter.read_coord_defs()
        except Exception as e:              # noqa: BLE001 — 참고값이다. 못 읽으면 못 읽은 채로 논다
            self.coordDefs = {"tool": None, "user": None, "missing": ["read: %s" % e]}
        self._coordDefsFor = key
        return self.coordDefs

    def tool_coord_now(self):
        """활성 툴의 **값**을 그 자리에서 다시 읽는다 (`[x,y,z,rx,ry,rz]` · mm·° · 0.01 반올림).

        **`_coord_defs` 를 안 쓴다 — 캐시가 번호로 걸려 있기 때문이다.** 핑거를 갈고 펜던트에서
        `tool1` 의 Z 만 고치면 번호는 그대로라 캐시가 옛 값을 계속 내놓는다. 슬롯 승인 지문이
        보려는 사건이 정확히 그것이라(PROGRAM-CONTRACT §approve) 여기서는 매번 읽는다 —
        부르는 곳은 승인 1회와 단계 실행 직전뿐이라 폴링 경로에 안 얹힌다.

        **못 읽으면 None** 이고, 호출처가 그걸 차단으로 읽는다 (제1원칙: 결측=차단).
        저쪽이 실패를 삼키는 것은 참고값이라 그런 것이고, 이 값은 판정에 쓴다.
        """
        if self.adapter is None:
            return None
        try:
            tool = (self.adapter.read_coord_defs() or {}).get("tool")
        except Exception:                   # noqa: BLE001 — 못 읽었다는 사실만 쓴다
            return None
        if not isinstance(tool, (list, tuple)) or len(tool) != 6:
            return None
        try:
            return [round(float(v), 2) for v in tool]
        except (TypeError, ValueError):
            return None

    # ── 안전 설정 (D53) ─────────────────────────────────────────────────────
    def apply_settings(self):
        """설정을 넣고 되읽어 대조한다. 반환은 계약 §로봇 안전 설정의 appliedSettings 모양."""
        settings = (self.profile or {}).get("settings")
        if not settings:
            raise ConnectionError("프로필에 settings 가 없다 — 안전 설정 없이 arm 하지 않는다")
        self.adapter.apply_settings(settings)
        back = self.adapter.read_settings() or {}
        mismatch = []
        got = back.get("payloadKg")
        if not _within(got, settings["payloadKg"], SETTING_TOL["payloadKg"]):
            mismatch.append(f"payloadKg 기대 {settings['payloadKg']} · 실제 {got}")
        got = back.get("cogMm")
        want = settings["cogMm"]
        # 길이도 본다 — `zip` 은 짧은 쪽에서 조용히 멈춘다. 빈 목록이면 비교가 0회라 통과한다
        if not isinstance(got, (list, tuple)) or len(got) != len(want) \
                or not all(_within(g, w, SETTING_TOL["cogMm"]) for g, w in zip(got, want)):
            mismatch.append(f"cogMm 기대 {settings['cogMm']} · 실제 {got}")
        applied = {"appliedAt": time.time(), "sent": dict(settings), "readback": back,
                   "unverifiable": list(UNVERIFIABLE_SETTINGS), "mismatch": mismatch}
        if mismatch:
            raise ConnectionError("안전 설정이 로봇에 안 먹었다 — " + " · ".join(mismatch))
        self.appliedSettings = applied
        notes = preflight.compare_soft_limits(back.get("jointSoftLimitDeg"),
                                              safety.JOINT_LIMITS_DEG)
        if notes:      # 거부하지 않는다 — 값 신뢰도가 낮다 (STACK). 기록만 남긴다
            self._log("soft-limit-diff", " · ".join(notes))
        return applied

    # ── 종료 경로 ───────────────────────────────────────────────────────────
    def disarm_hw(self, why):
        self.armed = False
        if self.adapter is None:
            return
        try:
            self.adapter.stop()
            self.adapter.enable(False)
            self._log("disarm", why)
        except Exception as e:
            self._log("disarm-fail", f"{why} — {e}")

    def fail_closed(self, reason):
        self.armed = False
        if self.adapter:
            try:
                self.adapter.disconnect()
            except Exception:
                pass
        self.clear(phase="FAIL_CLOSED", fail_reason=reason)
        self._log("FAIL_CLOSED", reason)

    def close(self):
        """정상 해제 — 열려 있으면 서보를 내리고 어댑터를 닫은 뒤 빈 세션으로 돌아간다."""
        if self.adapter:
            if self.armed:
                self.disarm_hw("disconnect")
            try:
                self.adapter.disconnect()
            except Exception:
                pass
            self._log("DISCONNECTED", self.profile["robotId"])
        self.clear()
