# 가짜 FR5 — 실기 없이 브리지·화면 왕복을 검증하기 위한 어댑터.
# 기준 자세·펌웨어 문자열은 2026-07-31 실측값이다 (archive/evidence-2026-07/2026-07-31/fr5-live-readback.md).
# 움직임 규칙: move_j 는 순간이동이 아니라 속도 상한에 비례해 한 틱씩 다가간다 —
# 실기처럼 큐가 차 있는 동안 EXECUTING 이 보여야 화면·게이트 검증이 성립한다.
import json
import math
import threading
import time
from pathlib import Path

from .base import RobotAdapter

# ── 좌표계 — **얼려 둔 실기 값을 빌려 쓴다** (2026-08-18) ────────────────────────
# 게이트 상자는 `user1` 에 적히고 쌍둥이의 카트·바닥 모델은 `base` 에 그려진다. 그 사이를
# user1 원점(실기 실측 -401.8, +497.3, +342.1)만큼 밀어야 하는데, mock 이 전부 0 을 주면
# 화면이 **그 640mm 를 안 민 채** 그린다 — 2026-08-18 에 작업대3 이 카트를 367×302mm
# 뚫은 그림이 그렇게 나왔고 하마터면 「상자가 틀렸다」로 읽을 뻔했다.
# ⛔ **값을 여기 베껴 적지 않는다.** `Sim/fixtures/<robotId>.json` 이 정본이고(로봇이 준 값을
#    얼린 것) 없으면 예전처럼 0 이다 — 없는 값을 지어내는 것보다 「목업이다」가 정직하다.
FIXTURES = Path(__file__).resolve().parents[3] / "Sim" / "fixtures"
ZERO6 = [0.0] * 6


def _frozen(robot_id):
    """얼려 둔 실기 좌표계. `(coord, coordDefs)` — 없으면 `(None, None)`."""
    f = FIXTURES / f"{robot_id}.json"
    if not robot_id or not f.exists():
        return None, None
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    return d.get("coord"), d.get("coordDefs")

# 실측 readback 값 — mock 의 기준 자세 (손끝은 아래 기구학이 이 관절각에서 **계산**한다)
JOINTS_BASE = [-80.851326, -98.353310, 91.248093, -89.073883, -89.751343, 6.898761]

# ── 기구학 — **진짜다** (2026-09-06 · `docs/archive/GRILL-conveyor-twin-progresslog-2026-09-06.md` 결정 #5) ────────
# 집(컨트롤러 없음)에서 시뮬 탭이 돌려면 `/ik` 가 진짜 자세를 내야 한다. 전엔 관절→손끝을
# 10mm/° 선형으로 흉내 냈고, 그걸로는 팔이 바구니에 닿는 그림이 안 섰다.
# FK 는 `safety.link_poses_mm`(URDF 체인 · `scripts/check/arm-fk.mjs` 가 무조코와 2000자세 대조)
# 위에 플랜지·툴·user 원점을 얹은 것이고, IK 는 그 FK 를 수치로 뒤집는다(감쇠 최소제곱 ·
# 표준 라이브러리만 — 브리지는 numpy 를 안 들인다).
# `ponytail:` **그림용이다.** 판정은 실기 `GetForwardKin`/`GetInverseKinRef` 가 한다.
#   실기 대조: `Sim/fixtures/fr5-lab-a.json` `fkSamples` 와 위치 ≤2mm · 회전 ≤0.1° (`test_mock_kin.py`).
FLANGE_MM = 99.0   # wrist3_link 원점 → 플랜지면. 출처 `Shared/data/config/tool-hull.json` `_flangeToTcpMm` (234 = 툴 135 + 플랜지 99)
IK_ITERS = 80
IK_ROT_WEIGHT_MM = 1000.0  # 1rad 회전 오차를 1000mm 로 친다 — 위치(≈17mm/°)·회전(17.5/°) 야코비안 크기를 맞춘 저울.
#                            100 이었을 때 감쇠가 회전 항을 눌러 한 번에 10% 씩만 줄었다(실측 2026-09-06 · 80회 미수렴)
IK_DAMP2 = 1.0             # 감쇠 λ² (mm²) — 특이점 근처에서 한 걸음이 튀지 않게. 4·25 는 수렴을 3→23→80회로 늦췄다
IK_STEP_CAP_DEG = 15.0
IK_TOL_MM = 0.5            # 그림용 허용치. 손목 특이점(j5≈0) 근처에서 0.1~0.3mm 에 멈추는 자세가 60개 중 4개 있었다
IK_TOL_RAD = 1e-3          # ≈0.06°


def _kin():
    """`safety` 는 늦게 끌어온다 — 어댑터 패키지를 단독으로 import 할 때 브리지 루트가 필요 없게."""
    import safety
    return safety


def _euler_fixed_xyz_deg(r):
    """회전행렬 → 고정축 XYZ(RPY) 도. `safety._rot_fixed_xyz` 의 역이다 (R = Rz·Ry·Rx)."""
    sy = max(-1.0, min(1.0, -r[2][0]))
    ry = math.asin(sy)
    if abs(sy) > 0.999999:                                   # 짐벌 — rz 를 0 으로 두고 rx 에 몰아준다
        return [math.degrees(math.atan2(-r[1][2], r[1][1])), math.degrees(ry), 0.0]
    return [math.degrees(math.atan2(r[2][1], r[2][2])), math.degrees(ry),
            math.degrees(math.atan2(r[1][0], r[0][0]))]


def _rotvec(r):
    """회전행렬 → 회전벡터(rad). 180° 근처는 대각 성분에서 축을 꺼낸다."""
    c = max(-1.0, min(1.0, (r[0][0] + r[1][1] + r[2][2] - 1.0) / 2.0))
    ang = math.acos(c)
    if ang < 1e-9:
        return [0.0, 0.0, 0.0]
    if ang > math.pi - 1e-4:
        k = max(range(3), key=lambda i: r[i][i])
        ax = [0.0, 0.0, 0.0]
        ax[k] = math.sqrt(max(0.0, (r[k][k] + 1.0) / 2.0))
        for j in range(3):
            if j != k:
                ax[j] = r[k][j] / (2.0 * ax[k])
        return [ang * v for v in ax]
    s2 = 2.0 * math.sin(ang)
    return [ang * (r[2][1] - r[1][2]) / s2, ang * (r[0][2] - r[2][0]) / s2, ang * (r[1][0] - r[0][1]) / s2]


def _tcp_base(joints_deg, tool):
    """관절각 → 손끝 `(회전 3x3, 위치 mm)` **base 기준**. `T_tcp = T_wrist3 · Trans(0,0,플랜지) · Trans(tool.xyz) · R(tool.rpy)`."""
    s = _kin()
    lp = s.link_poses_mm(joints_deg)
    if isinstance(lp, Exception):
        return None
    r, p = lp["wrist3_link"]
    moved = s._apply(r, (tool[0], tool[1], tool[2] + FLANGE_MM))
    return s._matmul(r, s._rot_fixed_xyz(tool[3], tool[4], tool[5])), [p[k] + moved[k] for k in range(3)]


def _solve6(a, b):
    """6x6 가우스 소거(부분 피벗). 특이하면 None."""
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    n = 6
    for c in range(n):
        piv = max(range(c, n), key=lambda i: abs(m[i][c]))
        if abs(m[piv][c]) < 1e-12:
            return None
        m[c], m[piv] = m[piv], m[c]
        for i in range(c + 1, n):
            f = m[i][c] / m[c][c]
            for j in range(c, n + 1):
                m[i][j] -= f * m[c][j]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        x[i] = (m[i][n] - sum(m[i][j] * x[j] for j in range(i + 1, n))) / m[i][i]
    return x


def _ik_numeric(target, ref, tool, user):
    """감쇠 최소제곱 IK. `target` 은 얼린 user 기준 `[x,y,z,rx,ry,rz]`, 해는 `ref` 에서 출발한 가지.
    수렴 못 하거나 관절 한계 밖이면 `None`."""
    s = _kin()
    tp = [target[k] + user[k] for k in range(3)]        # user → base. 위치만 — `safety` 와 같은 가정(user 회전 0.005°)
    tr = s._rot_fixed_xyz(target[3], target[4], target[5])
    w = IK_ROT_WEIGHT_MM

    def err(q):
        pose = _tcp_base(q, tool)
        if pose is None:
            return None
        r, p = pose
        d = _rotvec(s._matmul(tr, [[r[j][i] for j in range(3)] for i in range(3)]))
        return [tp[0] - p[0], tp[1] - p[1], tp[2] - p[2], w * d[0], w * d[1], w * d[2]]

    q = list(ref)
    done = False
    best_norm, stalled = float("inf"), 0
    for _ in range(IK_ITERS):
        e = err(q)
        if e is None:
            return None
        if math.hypot(e[0], e[1], e[2]) < IK_TOL_MM and math.hypot(e[3], e[4], e[5]) / w < IK_TOL_RAD:
            done = True
            break
        # **정체면 일찍 끊는다** — 못 갈 시작점이 80회를 다 돌면 다중 시작 한 번이 0.9초였다 (부하 118 실측).
        # 6회 연속으로 0.5% 도 못 줄이면 그 시작점은 도달 밖이거나 특이점에 갇힌 것이다
        norm = math.hypot(*e)
        stalled = stalled + 1 if norm > best_norm * 0.995 else 0
        best_norm = min(best_norm, norm)
        if stalled >= 6:
            break
        h = 0.05
        jac = [[0.0] * 6 for _ in range(6)]
        for j in range(6):
            qq = list(q)
            qq[j] += h
            ej = err(qq)
            if ej is None:
                return None
            for i in range(6):
                jac[i][j] = (e[i] - ej[i]) / h
        # dq = Jᵀ (J Jᵀ + λ²I)⁻¹ e
        a = [[sum(jac[i][k] * jac[j][k] for k in range(6)) + (IK_DAMP2 if i == j else 0.0)
              for j in range(6)] for i in range(6)]
        y = _solve6(a, e)
        if y is None:
            return None
        dq = [sum(jac[i][j] * y[i] for i in range(6)) for j in range(6)]
        q = [q[j] + max(-IK_STEP_CAP_DEG, min(IK_STEP_CAP_DEG, dq[j])) for j in range(6)]
    if not done:
        return None
    out = []
    for k, (lo, hi) in enumerate(s.JOINT_LIMITS_DEG):
        v = q[k]
        if not lo <= v <= hi:
            alt = next((a for a in (v - 360.0, v + 360.0) if lo <= a <= hi), None)
            if alt is None:
                return None
            v = alt
        out.append(v)
    return out
VERSION = {
    "model": "FR5",
    "controller": "FR_CTRL_FV2.010.12",
    "servo": "FR_SERVO_FV5.043.16",
    "end": "FR05_End_FV2.010.11",
    "sdk": "mock-0.1",          # 실기 SDK 문자열을 사칭하지 않는다 — 화면에서 mock 임이 보여야 한다
    "web": "mock-0.1",
}
# speedPct 100 기준 관절 속도 — **실측값이다** (2026-08-08 실기 · `commands.JOINT_DEG_S_AT_FULL`).
#
# 이 값은 하루 사이에 30 → 180 → 28.9 로 갔다. 기록해 둔다:
# 원래 30 이었고 근거가 없어 보여 **벤더 사양 180°/s(관절 기계적 최대)로 고쳤는데, 그게
# 틀렸다.** `MoveJ` 의 `vel` 백분율은 기계적 최대의 백분율이 아니다 — 실기에서 재니
# `speedPct 10` 이 2.89°/s 라 100% 환산 **28.9°/s** 였다. 원래 30 이 사실상 맞았던 것이다.
# **사양서보다 줄자가 옳다.** 두 브리지의 상수가 갈리지 않게 위 상수와 같은 값을 쓴다.
FULL_SPEED_DEG_S = 28.9


class MockFr5Adapter(RobotAdapter):
    """profile.mock 으로 결함 주입 — model 바꿔치기·안전 필드 drop (preflight fail-closed 시험)."""

    def __init__(self, profile):
        self._fault = profile.get("mock") or {}
        # 프로필이 사칭하는 로봇의 얼린 좌표계 — 있으면 쓰고 없으면 base 그대로(0)
        # `fixture:` 가 있으면 **그 로봇의** 얼린 좌표계를 빌린다 (2026-09-06 · `fr5-mock-lab`) — 집에서
        # 시뮬 탭이 user1 좌표로 `/ik` 를 묻는데, 좌표계가 없으면 base 로 읽혀 725mm 엉뚱한 자리를 푼다
        self._coord, self._coord_defs = _frozen(profile.get("fixture") or profile.get("robotId"))
        self._step_lock = threading.Lock()   # `_step_motion` 전용 — 스트림·명령 스레드가 같이 적분하지 않게
        self._connected = False
        self._t0 = time.time()
        self._joints = list(JOINTS_BASE)
        self._enabled = False
        self._mode = 1
        self._target = None            # move_j 목표 (도)
        self._speed_pct = 10.0
        self._last_tick = time.time()
        self._servo_target = [0.0] * 6
        self._settings = None          # apply_settings 가 넣은 값 — 되읽기의 출처
        self._grip_active = False      # ActGripper 전에는 이동 명령이 거부돼야 한다
        self._grip_cmd_pct = 0.0       # 마지막 지령 (지령 기준)
        self._grip_fault = bool(self._fault.get("gripperFault"))

    def connect(self):
        self._connected = True

    def disconnect(self):
        self._connected = False
        self._target = None
        self._enabled = False
        self._mode = 1

    def get_version(self):
        v = dict(VERSION)
        if "model" in self._fault:
            v["model"] = self._fault["model"]
        return v

    # ── 안전 설정 (D53) — mock 은 넣은 값을 실제로 들고 있다가 되읽어 준다 ──
    def apply_settings(self, settings):
        self._settings = dict(settings or {})

    def read_settings(self):
        if self._settings is None:
            return {"payloadKg": None, "cogMm": None, "toolCoord": None,
                    "jointSoftLimitDeg": None}
        drift = 1.0 if self._fault.get("settingsDrift") else 0.0   # 되읽기가 어긋나는 로봇
        return {
            "payloadKg": float(self._settings["payloadKg"]) + drift,
            "cogMm": [float(v) for v in self._settings["cogMm"]],
            "toolCoord": [0.0] * 6,
            "jointSoftLimitDeg": None,     # mock 은 컨트롤러 리밋을 흉내 내지 않는다
        }

    def reset_errors(self):
        self._require()

    def enable(self, on):
        self._require()
        self._enabled = bool(on)
        if not on:
            self._target = None

    def _frames(self):
        """얼린 좌표계 `(tool, user)` 6개씩. 없으면 0 — base 기준·툴 없음(플랜지가 손끝)."""
        d = self._coord_defs or {}
        ok = lambda v: (isinstance(v, (list, tuple)) and len(v) >= 6      # noqa: E731
                        and all(isinstance(x, (int, float)) and math.isfinite(x) for x in v[:6]))
        return ([float(x) for x in d["tool"][:6]] if ok(d.get("tool")) else list(ZERO6),
                [float(x) for x in d["user"][:6]] if ok(d.get("user")) else list(ZERO6))

    def forward_kin(self, joints_deg):
        """URDF 체인 FK — 실기 `GetForwardKin` 과 같은 모양 `[x,y,z,rx,ry,rz]`(mm·도 · 얼린 tool/user 기준).
        `ponytail:` **그림용이다.** 판정은 실기가 한다 — 여기 숫자를 실기 근거로 쓰지 않는다.
        못 풀면(관절각이 숫자가 아니다) `None` — 게이트가 「손끝을 못 구했다」로 막는다."""
        tool, user = self._frames()
        pose = _tcp_base(joints_deg, tool)
        if pose is None:
            return None
        r, p = pose
        return [p[0] - user[0], p[1] - user[1], p[2] - user[2]] + _euler_fixed_xyz_deg(r)

    def inverse_kin(self, tcp_mm_deg, ref_joints_deg=None):
        """`forward_kin` 을 수치로 뒤집는다 — 참조 자세에서 제일 가까운 가지(실기 `GetInverseKinRef` 규약).
        `ponytail:` 그림용. **도달 밖·수렴 실패·관절 한계 밖은 `None`** 이라야 게이트가
        「해가 없다」 경로를 실제로 밟는다."""
        p = list(tcp_mm_deg) if isinstance(tcp_mm_deg, (list, tuple)) else []
        if len(p) < 6 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p[:6]):
            return None
        ref = ref_joints_deg if (isinstance(ref_joints_deg, (list, tuple)) and len(ref_joints_deg) >= 6
                                 and all(isinstance(v, (int, float)) and math.isfinite(v)
                                         for v in ref_joints_deg[:6])) else self._joints
        tool, user = self._frames()
        target = [float(v) for v in p[:6]]
        ref6 = [float(v) for v in ref[:6]]
        # **가지를 고른다.** 참조에서만 출발하면 목표가 멀 때(시작 자세 → 반대편 집기 자리) 팔꿈치가
        # 뒤집힌 먼 해에 먼저 닿는다 — 실측 2026-09-06: 참조와 관절 거리 649° 짜리를 골랐고 가까운
        # 가지는 367° 였다. 그래서 팔꿈치·손목을 뒤집은 시작점 몇 개에서 같이 풀고, 수렴한 해 중
        # **참조에 가장 가까운 것**을 준다 (실기 `GetInverseKinRef` 가 약속하는 것).
        seeds = [ref6]
        for d2, d3 in ((60.0, -60.0), (-60.0, 60.0), (120.0, -120.0), (-120.0, 120.0)):
            s = list(ref6)
            s[1] += d2
            s[2] += d3
            seeds.append(s)
        seeds.append([ref6[0], ref6[1], ref6[2], ref6[3] + 180.0, -ref6[4], ref6[5] + 180.0])   # 손목 뒤집기
        best = None
        for i, s in enumerate(seeds):
            q = _ik_numeric(target, s, tool, user)
            if q is None:
                continue
            dist = sum(abs(q[k] - ref6[k]) for k in range(6))
            if i == 0 and dist < 90.0:
                return q          # 참조 바로 옆의 해 — 가지가 바뀔 수 없다. 나머지 시작점을 돌 이유가 없다
            if best is None or dist < best[0]:
                best = (dist, q)
        return best[1] if best else None

    def set_mode(self, mode):
        self._require()
        self._mode = int(mode)

    def set_speed(self, pct):
        """mock 은 값만 받아 둔다 — **이동 시간을 흉내내지 않는다**(이 파일 규약).
        실기에서는 이 값이 0 이면 이동이 전부 거부되지만, mock 이 그걸 흉내내면
        게이트가 사람 없이 못 돌아간다."""
        self._require()
        self._speed_pct = int(pct)

    def exit_drag_teach(self):
        self._require()

    def set_sample_period(self, ms):
        self._require()

    def move_j(self, joints_deg, speed_pct, tool, user):
        self._require()
        if not self._enabled:
            raise ConnectionError("mock: 서보 OFF — 컨트롤러가 명령을 거부한다")
        self._target = [float(j) for j in joints_deg]
        self._servo_target = list(self._target)
        self._speed_pct = float(speed_pct)
        self._last_tick = time.time()

    def stop(self):
        self._target = None

    # ── 그리퍼 ─────────────────────────────────────────────────────────────
    def gripper_activate(self):
        self._require()
        if not self._enabled:
            raise ConnectionError("mock: 서보 OFF — 활성화를 거부한다")
        self._grip_active = True
        return {"config": (0, [1, 4, 0, 0])}    # 실기와 같은 진단 모양

    def gripper_move(self, pct, vel_pct, force_pct):
        self._require()
        if not self._grip_active:
            raise ConnectionError("mock: 그리퍼가 활성화되지 않았다")
        self._grip_cmd_pct = float(pct)

    def gripper_settle_s(self, vel_pct):
        """mock 은 즉시 끝난다 — **실기 시간을 흉내내지 않는다.** 흉내내면 게이트가 손가락을
        기다리며 초를 태우고, 그 초가 늘 때 아무도 게이트를 안 돌린다 (D90)."""
        return 0.0

    def read_coord_defs(self):
        """얼린 실기 값이 있으면 그것, 없으면 base 그대로(전부 0).

        ⛔ **이 값을 근거로 실기를 판단하지 않는다** (이 파일 규약 그대로) — 빌려온 것은
        「어디를 원점으로 삼나」 뿐이고 관절·자세는 여전히 가짜다. 빌리는 이유는 화면이
        상자를 **맞는 자리에** 그리게 하기 위해서다."""
        if self._coord_defs:
            return self._coord_defs
        return {"tool": list(ZERO6), "user": list(ZERO6), "missing": []}

    def _require(self):
        if not self._connected:
            raise ConnectionError("mock: 연결이 없다")

    def _step_motion(self):
        # ⛔ **잠금 안에서 적분한다** (감사 2026-09-06 ①-1). `read_state()` 는 WS 스트림(33ms)과 `/ik`·`/follow/step`·goto 의
        # `read_fresh_state()` 가 **다른 스레드**에서 같이 부른다. 한쪽이 도착을 감지해 `_target = None` 으로 지우는 순간 다른 쪽이
        # `self._target[i]` 를 읽으면 `TypeError` — 스트림 쪽이면 조용히 끊기고 명령 쪽이면 500 이다. 실기 어댑터는 같은 이유로
        # `self._lock` 을 쓴다(`fairino.py`). 잠금 구간은 이 적분 한 번뿐이라 `/ik` 의 수치 IK 와는 경합하지 않는다.
        with self._step_lock:
            target = self._target
            if target is None:
                return
            now = time.time()
            dt = min(now - self._last_tick, 0.5)
            self._last_tick = now
            step = FULL_SPEED_DEG_S * (self._speed_pct / 100.0) * dt
            done = True
            for i in range(6):
                diff = target[i] - self._joints[i]
                if abs(diff) <= step:
                    self._joints[i] = target[i]
                else:
                    self._joints[i] += math.copysign(step, diff)
                    done = False
            if done:
                self._target = None

    def read_state(self):
        self._require()
        self._step_motion()
        joints = list(self._joints)
        if not self._enabled:
            # 서보 OFF 관측 상태에서만 ±0.5° 숨쉬기 — 스트림이 살아있음을 화면에서 보이게
            dt = time.time() - self._t0
            joints[0] += 0.5 * math.sin(dt * 0.5)
            joints[2] += 0.5 * math.sin(dt * 0.7)
        state = {
            "enabled": self._enabled,
            "mode": self._mode,
            "jointsDeg": [round(j, 4) for j in joints],
            "tcpMmDeg": self.forward_kin(joints),
            "motionQueueLength": 1 if self._target is not None else 0,
            "safety": {
                "code": 0,
                "emergencyStop": False,
                "safetyStop": False,
                "collisionDetected": False,
                "inDragTeach": False,
                "mainErrorCode": 0,
                "subErrorCode": 0,
            },
            "coord": self._coord or {"toolId": 0, "userId": 0},
            "gripper": {
                "pct": round(self._grip_cmd_pct, 1),   # 읽기 = 지령 (실기와 같다)
                "fault": self._grip_fault,
                "motionDone": True,        # mock 은 순간 도달 — 실기는 실시간 필드가 준다
                "active": self._grip_active,
            },
            "lastServoTargetDeg": list(self._servo_target),
            "missing": [],
        }
        for name in self._fault.get("drop", []):
            state["safety"].pop(name, None)
            state["missing"].append(name)
        return state
