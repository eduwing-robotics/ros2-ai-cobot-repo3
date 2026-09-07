# 실기 FAIRINO 어댑터 — 공식 Python SDK(순수 표준 라이브러리) 직접 사용 (D42).
# xmlrpc(20003) 명령 + 20004 실시간 상태(RobotStatePkg, SDK 백그라운드 스레드가 캐시).
# 이전 C# dll·Mono 서브프로세스 경로(fairino_cs/)는 2026-07-31 실측에서 Mono xmlrpc 클라이언트가
# 쓰기 호출마다 예외를 삼키고(-4 · 가짜 성공) 컨트롤러 xmlrpc 서비스까지 넘어뜨려 폐기했다.
import math
import threading
import time

from .base import RobotAdapter

# SDK 반환 코드 → 사람 말. 정본: manual.fairino.support §Error Code + SDK RobotError.
ERROR_TRANSLATE = {
    -1: "기타 오류 — 컨트롤러 로그 확인 필요",
    -2: "컨트롤러 통신 이상 — 연결·전원 확인",
    -3: "xmlrpc 통신 실패 — 네트워크·IP 확인",
    -4: "xmlrpc 인터페이스 실행 실패 — 컨트롤러 상태 확인",
    99: "안전정지 신호(SI0/SI1) 활성",
    # ── 2026-08-12 등재. 정본: fairino-doc-en.readthedocs.io/latest/SDKManual/errcode.html
    # **숫자만 보여줘서 하루를 태운 셋이다.** 우리 이동 경로에서 실제로 날 수 있는 것만 넣는다 —
    # 표를 통째로 옮기지 않는다(안 나는 코드까지 베끼면 낡는다).
    170: "사용자(작업물) 좌표계가 적용되지 않았다 — 펜던트에서 좌표계 적용 확인",
    171: "관절 소프트리밋 초과 (보호 실패) — 목표 각도를 줄여라",
    # ⛔ **이것이 2026-08-12 의 답이었다.** 원문 "Motion Speed Cannot Be 0".
    # 우리 게이트는 전부 통과하고 `MoveJ` 만 18/18 거부됐는데, 원인은 **펜던트의 전역 속도
    # 오버라이드가 0%** 였다. `vel`(우리가 보내는 10%)에 그 값이 곱해진다.
    # ⚠ **펜던트 수동 조그는 자기 속도를 쓰므로 멀쩡하게 움직인다** — 그래서 「펜던트는 되니
    # 속도는 무죄」로 오판했고, 호스트·포트·비상정지까지 헛되게 돌았다. 그 오판을 여기 남긴다.
    # 근거 `docs/evidence/2026-08-12/movej-172-windows.md` · 2026-07-31 첫 이동 문서에도 있었다.
    172: "이동 속도가 0 이다 — **펜던트의 전역 속도(오버라이드)를 0 이 아닌 값으로** 올려라",
}
# ── 로봇 고장코드(main/sub) → 사람 말 ─────────────────────────────────────
# 정본: manual.fairino.support §Appendix **로봇 고장코드표**.
# ⚠ 위 ERROR_TRANSLATE(=SDK 반환코드표)와 **다른 표다.** 같은 숫자가 다른 뜻이라 섞으면
# 엉뚱한 조치를 시킨다 — 로봇 `6`=슬레이브 오류 · SDK `6`=TPD 타이머 종료 실패.
FAULT_MAIN = {
    1: "지령점 오류", 2: "드라이브 고장", 3: "소프트리밋 초과", 4: "충돌",
    5: "활성 슬레이브 수 오류", 6: "슬레이브 오류", 7: "IO 오류", 8: "그리퍼 오류",
    9: "파일 오류", 10: "특이자세", 11: "드라이브 통신 오류",
    12: "외부축 소프트리밋 초과", 13: "파라미터 설정 오류",
}
# 슬레이브 계열만 sub 까지 적는다 — **원인이 배선·연결**이라 사람이 어디를 볼지가 갈린다.
# 2026-08-08 에 `6-2` 로 30분을 썼다: 비상정지 박스 쪽 배선을 건드린 게 원인이었는데
# 화면엔 숫자만 떠서 버튼·랜선·브리지 재시작을 순서대로 뒤졌다.
FAULT_SUB_SLAVE = {
    1: "슬레이브 오프라인", 2: "슬레이브 상태가 설정값과 다르다", 3: "슬레이브 미설정",
    4: "슬레이브 설정 오류", 5: "슬레이브 초기화 오류", 6: "슬레이브 메일박스 통신 초기화 오류",
}
NOT_RESETTABLE_MAIN = {2, 5, 6, 9, 11}      # main 통째로 리셋 불가인 계열
NOT_RESETTABLE_SUB_1 = {20, 29, 30, 82}     # main 1 은 대부분 리셋되는데 이 넷만 아니다


def fault_text(main, sub):
    """(사람이 읽는 사유, 리셋 가능 여부). 정상이면 `(None, None)`.

    `리셋 불가` 는 **알람 리셋으로 안 지워진다**는 뜻이고, 매뉴얼이 지정한 처리법은
    *"Non-resettable fault, please power off and restart the control box."* 하나뿐이다.
    이 한 줄이 없어서 지울 수 없는 알람을 30분 지웠다 (API-CONTRACT §고장코드).

    **모르는 코드는 지어내지 않는다** — 표에 없으면 판정을 `None` 으로 두고 펜던트로 보낸다.
    펜던트는 같은 코드를 글자로 띄우므로 사람이 거기서 읽는 게 정확하다.
    """
    main, sub = int(main), int(sub)
    if main == 0:
        return None, None
    name = FAULT_MAIN.get(main)
    if name is None:
        return f"로봇 고장 {main}-{sub} — 펜던트 화면에서 확인", None
    if main == 6:
        name = FAULT_SUB_SLAVE.get(sub, name)
    if main == 10:
        return f"{name} ({main}-{sub})", None    # 자세 문제라 리셋 개념이 없다 (표에도 N/A)
    resettable = not (main in NOT_RESETTABLE_MAIN
                      or (main == 1 and sub in NOT_RESETTABLE_SUB_1))
    tail = "" if resettable else " · 리셋 불가 — 컨트롤 박스 전원 재투입"
    return f"{name} ({main}-{sub}){tail}", resettable


DRAG_CACHE_S = 0.5              # IsInDragTeach 는 xmlrpc 왕복이라 캐시한다 (신선도 게이트 이내)
CMD_TIMEOUT_S = 3.0             # xmlrpc 왕복 상한. 넘으면 행으로 보고 던진다 (아래 _guard)
STOP_LOCK_WAIT_S = 0.2          # stop 이 잠금을 기다리는 최대 시간. 그 뒤엔 잠금 없이 보낸다
GRIPPER_INDEX = 1               # 말단 1번 포트 (펜던트 실측 · STACK §그리퍼)
GRIPPER_COMPANY = 4             # 대환(DAHUAN) — 펜던트 4필드와 1:1 (evidence 2026-08-03)
GRIPPER_DEVICE = 0              # PGI-140 (대환의 유일한 선택지 · 실물은 PGE A-100-40)
# MoveGripper 시간 상한. **속도에서 유도한다 — 상수면 안 된다.**
#
# 2026-08-04 실기에서 `vel 30% + maxtime 3000ms` 로 보냈다가 정상 이동이 상한과 겹쳐
# 컨트롤러가 `8/1 Gripper Movement timeout` 을 **래치**했다 (펜던트 문구 실측). 브리지
# 재시작으로 안 풀려 전원 재투입이 필요했다. 그때 10000ms 로 고쳤는데, 그 값의 근거는
# *"vel 30% 의 행정 3.3초 × 여유 3배"* 였다 — **속도를 낮추는 순간 근거가 사라진다**
# (vel 20% 면 행정 5초라 10000ms 는 2배로 줄고, vel 10% 면 상한과 겹쳐 그 사고가 재현된다).
# 상수로 두면 그 결합이 안 보여서, 나중에 속도를 여는 사람이 같은 자리를 다시 밟는다.
# ⚠ **1.0 → 1.15 (2026-08-11 정정).** 옛 값의 근거는 「2026-08-04 실기 **관찰**」이었는데
# 10Hz 계측이 그것을 갱신했다 — `vel 30%` 에서 전 행정(빈 손 0↔100)이 **닫기 3.54초 · 열기
# 3.68초** 였다. 옛 값이면 대기가 `3.333초` 라 **0.21~0.35초 짧고**, 그동안 `wait=True` 인
# `grip` 칸이 **손가락이 아직 움직이는 중에** 다음 칸으로 넘어갔다.
# 1.15 는 실측 최대 3.68초에 약 4% 여유다 (`vel 30 → 3.83초`).
# ⚠ **속도 한 점(30%)에서만 쟀다** — 「행정 ∝ 1/vel」 선형 가정은 여전히 미검증이다.
# 근거 `docs/evidence/2026-08-11/grip-kill-experiment.md`
GRIPPER_STROKE_S_AT_FULL = 1.15   # 최고속 전 행정 (2026-08-11 10Hz 실측) → 행정 ≈ 115/vel 초
GRIPPER_TIME_MARGIN = 3.0         # 여유 배수. 진짜로 낀 그리퍼는 이 안에 보고된다
GRIPPER_MAXTIME_CAP_MS = 30000    # SDK 문서 범위 `maxtime [0~30000]` — 넘겨 보내면 모른다
# **위 셋에서 유도한다 — 숫자를 또 적지 않는다.** 옛 코드는 `10.0` 을 손으로 박아 뒀는데,
# 행정 상수를 올리는 순간 그 값이 조용히 낡는다. 이 파일이 `maxtime` 에 대해 경고하는 것과
# 같은 결합이라 같은 방식으로 묶는다. 지금 값은 **11.5%** 다 (1.0 시절엔 10%였다).
GRIPPER_VEL_FLOOR_PCT = (GRIPPER_TIME_MARGIN * GRIPPER_STROKE_S_AT_FULL * 100.0 * 1000.0
                         / GRIPPER_MAXTIME_CAP_MS)


def gripper_stroke_s(vel_pct):
    """전 행정에 **실제로 걸리는 시간**(초). 여유 배수는 안 들어간다.

    `gripper_maxtime_ms` 와 **같은 뿌리 상수**를 쓴다 — 둘이 갈라지면 상한과 대기가 서로
    모르는 값이 되고, 그 결합이 안 보이는 것이 2026-08-04 래치 사고의 원인이었다.
    """
    v = float(vel_pct)
    if not 0 < v <= 100:
        raise ValueError(f"그리퍼 속도가 0~100 이 아니다 — {vel_pct!r}")
    return GRIPPER_STROKE_S_AT_FULL * 100.0 / v


def gripper_maxtime_ms(vel_pct):
    """`MoveGripper` 의 `maxtime`. 속도에서 유도한다.

    **넘치면 잘라 보내지 않고 죽는다.** 자르면 정상 이동이 상한과 겹쳐 컨트롤러가 래치하고,
    그건 전원 재투입으로만 풀린다 — 조용히 나쁜 값을 보내는 것보다 안 보내는 게 낫다.
    """
    stroke_s = gripper_stroke_s(vel_pct)     # 0~100 검사도 여기서 같이 난다
    need_ms = GRIPPER_TIME_MARGIN * stroke_s * 1000.0
    if need_ms > GRIPPER_MAXTIME_CAP_MS:
        raise ValueError(
            f"그리퍼 속도 {float(vel_pct):g}% 는 행정이 {stroke_s:.1f}초라 "
            f"여유 {GRIPPER_TIME_MARGIN:g}배면 "
            f"{need_ms:.0f}ms 가 필요한데 SDK 상한이 {GRIPPER_MAXTIME_CAP_MS}ms 다 — "
            f"속도 하한은 {GRIPPER_VEL_FLOOR_PCT:g}% 다")
    return int(round(need_ms))


def _code(rtn, op):
    """SDK 는 int 또는 (int, ...) 를 돌려준다. 0 이 아니면 사람 말로 던진다."""
    code = rtn[0] if isinstance(rtn, (list, tuple)) else rtn
    if code != 0:
        hint = ERROR_TRANSLATE.get(code)
        raise ConnectionError(f"SDK {op} 실패 — {hint + ' ' if hint else ''}(code={code})")
    return rtn


def _guard(fn, *args, **kwargs):
    """xmlrpc 호출을 별도 스레드에서 돌려 상한을 씌운다.

    SDK 는 연결 뒤 소켓 타임아웃을 None 으로 되돌린다 (`Robot.py` connect finally).
    그래서 순단이 '끊김' 이 아니라 '행' 이면 호출이 영원히 안 돌아오고, 잠금을 쥔 채면
    브리지 전체가 선다 — 실측 5.4초 공백의 뿌리다 (evidence/2026-08-03/fr5-field-gates.md).
    데몬 스레드는 버린다: 죽일 방법이 없으니 잡아 두지 않고 호출자만 풀어 준다.
    """
    box = {}

    def _run():
        try:
            box["v"] = fn(*args, **kwargs)
        except Exception as e:      # noqa: BLE001 — 어떤 실패든 호출자에게 그대로 전달한다
            box["e"] = e

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(CMD_TIMEOUT_S)
    if t.is_alive():
        raise ConnectionError(f"SDK 응답 없음 {CMD_TIMEOUT_S:.0f}s — 컨트롤러·네트워크 확인")
    if "e" in box:
        # 상한을 넘겨 버린 스레드는 **연결을 요청 보낸 채로** 쥐고 있다. 그 뒤 호출은 전부
        # http.client 의 `CannotSendRequest`(Request-sent)로 죽는데, 그 이름만 보면
        # 네트워크가 끊긴 것처럼 읽힌다 — 실제로는 우리가 버린 호출이 원인이다.
        # 사람이 읽는 사유로 바꿔 준다. 되살릴 방법은 재연결뿐이다 (2026-08-05 실기).
        if type(box["e"]).__name__ in ("CannotSendRequest", "ResponseNotReady"):
            raise ConnectionError(
                "앞선 xmlrpc 호출이 상한 안에 안 끝나 연결이 오염됐다 — 재연결해야 한다 "
                f"(원인 {type(box['e']).__name__})") from box["e"]
        raise box["e"]
    return box["v"]


def _estop_reason(r):
    """xmlrpc 가 거부(-4)했을 때, **20004 실시간 상태로 진짜 사유를 찾는다.**

    안전회로가 열리면 컨트롤러는 xmlrpc 를 전부 거부하지만 20004 상태 스트림은 계속 흐른다
    (2026-08-08 실기 — 브리지를 떼고 생 소켓으로 `EmergencyStop=1` 을 직접 읽어 확인).
    사유가 손에 있는데 안 읽어서 `-4` 만 보고 랜선·죽은 소켓·컨트롤러 재부팅을 뒤졌다.

    **여기서 읽는 안전 필드는 이 셋뿐이다** — 배포본 `RobotStatePkg` 에 있는 게 그것뿐이다.
    `btnBoxStopSignal`·`alarmRebootRobot` 류는 상류 SDK 에만 있다
    (`docs/archive/evidence-2026-07/2026-07-30/sdk-state-fields.md` §정정). 없는 필드를 믿지 않는다.

    반환: 사람이 읽는 사유. 판정 못 하면 None — 호출자가 원래 메시지를 쓴다 (fail-open 아님).
    """
    for _ in range(15):                 # 첫 프레임 대기 — 20004 는 xmlrpc 와 독립이라 이때도 온다
        pkg = getattr(r, "robot_state_pkg", None)
        if pkg is not None and not isinstance(pkg, type):
            break
        time.sleep(0.1)
    else:
        return None                     # 20004 도 안 오면 진짜 통신 문제다 — 원래 메시지가 맞다
    text, resettable = fault_text(getattr(pkg, "main_code", 0), getattr(pkg, "sub_code", 0))
    if getattr(pkg, "EmergencyStop", 0):
        # **고장코드를 같이 낸다.** 급정지 플래그만 보면 전부 "버튼을 뽑아라" 로 끝나는데,
        # 2026-08-08 실기에서 진짜 원인은 슬레이브 오류였고 버튼은 이미 뽑혀 있었다.
        return ("비상정지가 눌려 있다 — 버튼을 시계 방향으로 돌려 뽑고 다시 연결한다. "
                "버튼이 여럿이면(컨트롤 박스·펜던트) 전부 확인한다"
                + (f" · 고장: {text}" if text else "")
                + ("" if resettable is not False else
                   " ← 버튼을 뽑아도 이 고장은 전원 재투입으로만 풀린다"))
    if getattr(pkg, "safety_stop0_state", 0) or getattr(pkg, "safety_stop1_state", 0):
        return "안전정지 신호(SI0/SI1)가 살아 있다 — 안전회로 입력을 확인한다"
    if resettable is False:
        return f"{text} — 컨트롤러가 거부하는 이유가 이것이다"
    return None


class FairinoAdapter(RobotAdapter):
    def __init__(self, profile):
        self._profile = profile
        self._r = None
        self._version = None
        self._lock = threading.Lock()   # 명령 직렬화 — xmlrpc 는 동시성에 약하다 (실측)
        self._drag = (0.0, False)       # (읽은 시각, 값)

    def connect(self):
        from .fairino_sdk import Robot as _sdk   # 무거운 모듈(685KB) — 실기 프로필일 때만 로드
        ip = self._profile["endpoint"].split(":")[0]
        # **SDK 의 연결 플래그를 매번 되살린다 (2026-08-10 · 반나절을 쓴 함정).**
        # `RPC.is_conect` 는 `self.` 가 아니라 **클래스 변수**라 프로세스 전체가 공유한다.
        # 생성자가 1초짜리 `GetControllerIP()` 탐침에 실패하면 이 값을 `False` 로 내리는데
        # **다시 `True` 로 올리는 코드가 주석 처리돼 있다**(`Robot.py` §RPC.__init__).
        # 그 뒤로는 `xmlrpc_timeout` 데코레이터가 **로봇에 묻지도 않고 `-4` 를 반환**한다 —
        # 랜이 1초만 삐끗하면 브리지를 재시작하기 전까지 영구히 `-4` 다. 실기가 멀쩡해도.
        # 그래서 `-4` 를 "컨트롤러가 거부" 로 읽으면 안 된다 (`FR5-BRINGUP.md` §안 될 때).
        _sdk.RPC.is_conect = True
        r = _sdk.RPC(ip)
        try:
            # 생성자는 실패해도 예외를 안 던진다 — 버전 질의로 xmlrpc 생사를 직접 판정한다 (fail-closed)
            reason = None
            try:
                ver = r.GetSoftwareVersion()
            except Exception as e:      # noqa: BLE001 — 사유는 아래에서 20004 로 한 번 더 캔다
                reason = f"xmlrpc 검증 실패 — {e}"
            else:
                if not (isinstance(ver, (list, tuple)) and len(ver) >= 4 and ver[0] == 0):
                    reason = f"xmlrpc 검증 실패 — GetSoftwareVersion={ver!r}"
            if reason:
                # `-4` 는 "컨트롤러가 거부" 지 통신 장애가 아니다 (STACK §오류코드 정본).
                # 비상정지처럼 사람이 1초에 고칠 수 있는 원인을 코드 숫자로만 말하지 않는다.
                raise ConnectionError(_estop_reason(r) or reason)
            # 실측 모양: [0, 'FR5-V1-002(V6.0)', 'v3.9.7', 'V3.9.33-QX'] = 모델·웹·컨트롤러
            # 값은 예시다 — 펌웨어가 올라가면 바뀐다. 정본은 `STACK.md` §실기 정체 (2026-08-10)
            self._version = {"model": str(ver[1]), "web": str(ver[2]), "controller": str(ver[3]),
                             "servo": None, "end": None, "sdk": "fairino-python v2.2.3_robot3.9.3"}
            # 실시간 상태(20004) 첫 프레임 대기 — pkg 가 클래스면 아직 수신 전이다
            for _ in range(30):
                if not isinstance(r.robot_state_pkg, type):
                    self._r = r
                    return
                time.sleep(0.1)
            raise ConnectionError("실시간 상태(20004) 첫 프레임이 안 온다")
        except Exception:
            # **실패한 RPC 를 그냥 버리지 않는다.** 버리면 SDK 의 20004 재접속 스레드가 살아남아
            # 2초 간격으로 1000회까지 소켓을 계속 문다 (`Robot.py` reconnect). /connect 가 실패할
            # 때마다 하나씩 쌓여, 로봇이 돌아온 뒤에도 `ss` 에 SYN-SENT 가 줄줄이 남고 계속
            # -4 처럼 보인다 — 2026-08-08 비상정지 복구 때 실측 8개가 이렇게 생겼다.
            try:
                _guard(r.CloseRPC)
            except Exception:           # noqa: BLE001 — 정리 실패가 원래 사유를 덮으면 안 된다
                pass
            raise

    def disconnect(self):
        if self._r is not None:
            # 잠금 안에서 닫는다 — 명령이 소켓을 쓰는 중에 CloseRPC 가 겹치면 같은 소켓을 동시에 건드린다
            with self._lock:
                try:
                    _guard(self._r.CloseRPC)
                except Exception:
                    pass
                self._r = None

    def get_version(self):
        if self._version is None:
            raise ConnectionError("미연결")
        return dict(self._version)

    def _in_drag_teach(self):
        at, val = self._drag
        if time.time() - at < DRAG_CACHE_S:
            return val
        with self._lock:                    # xmlrpc 는 연결 하나 — 동시 요청이면 Request-sent 로 얽힌다 (실측)
            at, val = self._drag            # 잠금 대기 중 다른 스레드가 채웠으면 재사용
            if time.time() - at < DRAG_CACHE_S:
                return val
            rtn = _guard(self._r.IsInDragTeach)   # (error, state) — xmlrpc 왕복
        val = bool(rtn[1]) if isinstance(rtn, (list, tuple)) and len(rtn) > 1 and rtn[0] == 0 else None
        self._drag = (time.time(), val)
        return val

    def read_state(self):
        if self._r is None:
            raise ConnectionError("연결이 없다")
        pkg = self._r.robot_state_pkg
        if isinstance(pkg, type):
            raise ConnectionError("실시간 상태 수신 끊김")
        joints = [float(v) for v in pkg.jt_cur_pos]
        tcp = [float(v) for v in pkg.tl_cur_pos]
        missing = []
        drag = self._in_drag_teach()
        safety = {
            "code": 99 if (pkg.safety_stop0_state or pkg.safety_stop1_state) else 0,
            "emergencyStop": bool(pkg.EmergencyStop),
            "safetyStop": bool(pkg.safety_stop0_state) or bool(pkg.safety_stop1_state),
            "collisionDetected": bool(pkg.collisionState),
            "mainErrorCode": int(pkg.main_code),
            "subErrorCode": int(pkg.sub_code),
        }
        # 숫자만 주면 사람이 매뉴얼을 뒤진다 — 사유와 "리셋 되나"까지 붙인다 (API-CONTRACT §고장코드)
        safety["errorText"], safety["errorResettable"] = fault_text(pkg.main_code, pkg.sub_code)
        if drag is None:
            missing.append("inDragTeach")   # 못 읽으면 결측 — 게이트가 fail-closed 한다
        else:
            safety["inDragTeach"] = drag
        state = {
            "enabled": bool(pkg.rbtEnableState),
            "mode": int(pkg.robot_mode),     # 0=auto 1=manual — SDK 주석 원문 그대로
            "jointsDeg": [round(v, 4) for v in joints],
            "tcpMmDeg": [round(v, 4) for v in tcp],
            "motionQueueLength": int(pkg.mc_queue_len),
            # ⚠ **죽은 진단을 살린다** (2026-08-12). `commands.motion` 의 `moveJ-after` 로그가
            # 이 둘을 찍는데 **아무도 채우지 않아 늘 `None`** 이었다 — 「컨트롤러가 무슨
            # 상태인지」를 우리는 한 번도 본 적이 없다. 윈도우 호스트에서 `MoveJ` 가 18/18
            # `code=172` 로 거부되는데 원인을 못 짚은 이유가 그것이다.
            # 값은 SDK 구조체 주석 원문 그대로다 (`Robot.py:64-65`) — **새 xmlrpc 왕복이 0**:
            #   robotState   1=정지 2=실행 3=일시정지 4=드래그
            #   programState 1=정지 2=실행 3=일시정지
            "robotState": int(pkg.robot_state),
            "programState": int(pkg.program_state),
            "safety": safety,
            "coord": {"toolId": int(pkg.tool), "userId": int(pkg.user)},
            "gripper": self._read_gripper(pkg),
            "lastServoTargetDeg": [float(v) for v in pkg.lastServoTarget],
            "missing": missing,
        }
        return state

    # ── 그리퍼 (D65) — 20004 실시간 구조체의 **이름 붙은** 필드만 읽는다 ──────
    # GetGripperMotionDone() 은 자리로 구분하는 튜플이라 [fault, status] 가 뒤집혀도
    # 알아챌 방법이 없다 (실측 [1, 0]). 이름으로 오는 값은 순서가 섞이지 않는다.
    def _read_gripper(self, pkg):
        return {
            # 읽기 = 지령이다 (2026-08-04 실측: 지령 30·70 → 읽기 30·70, 자동 모드).
            # 8/3 의 "방향이 반대" 는 **수동 모드**에서 잰 값이었다 (unity-bridge-protocol §6).
            # 그래서 변환도, 두 벌의 숫자도 필요 없다.
            "pct": int(pkg.gripper_position),
            "fault": bool(int(pkg.gripper_fault)),
            "motionDone": bool(int(pkg.gripper_motiondone)),
            # gripper_active 는 비트마스크지만 우리 그리퍼는 하나다 — 0 이 아니면 활성.
            # 천장: 두 번째 그리퍼가 붙으면 비트 자리를 확정해야 한다 (실측 bit0 이었다).
            "active": int(pkg.gripper_active) != 0,
        }

    def gripper_activate(self):
        """**ActGripper 만 부른다.** 설정은 읽어서 보고만 하고 쓰지 않는다.

        2026-08-04 롤백 — `SetGripperConfig` 를 활성화마다 넣어 봤다가 뺐다. 근거가 갈렸고
        (우리 실측 `company=4·device=0` ↔ 유니티 기록 `company=2·device=4`) 컨트롤러에
        쓰는 값은 **틀리면 되돌리기 어렵다.** 펜던트가 이미 설정을 들고 있고, 그 상태에서
        `ActGripper(1,1)` 만으로 활성화가 실제로 됐다 (`activeRaw=1` 실측).
        설정을 다시 넣어야 한다는 증거가 나오면 그때 되살린다.
        """
        with self._lock:
            cfg = _guard(self._r.GetGripperConfig)      # 읽기만 — 진단 기록용
            _code(_guard(self._r.ActGripper, GRIPPER_INDEX, 1), "gripper-activate")
        return {"config": cfg}

    def gripper_move(self, pct, vel_pct, force_pct):
        # **maxtime 을 먼저 구한다** — 못 구하는 속도면 잠금을 잡기도 전에 죽는다.
        # `block=1` 은 논블로킹이라 이 호출은 `CMD_TIMEOUT_S` 안에 돌아온다 (SDK 문서 확인)
        maxtime_ms = gripper_maxtime_ms(vel_pct)
        with self._lock:
            _code(_guard(self._r.MoveGripper, GRIPPER_INDEX, int(round(pct)),
                         int(round(vel_pct)), int(round(force_pct)),
                         maxtime_ms, 1, 0, 0, 0, 0), "gripper-move")

    def gripper_settle_s(self, vel_pct):
        """손가락이 다 움직일 때까지 기다릴 시간(초). `block=1`(논블로킹)의 뒷면이다.

        ponytail: **시간으로 잰다 — 완료 신호를 안 믿는다.** 컨트롤러가 파지 중(행정이 안
        끝나는 상태)을 완료로 보는지 `maxtime` 을 세는지가 **미확인**이라(`GAP-MATRIX`),
        `gripper_motiondone` 을 대기 조건으로 쓰면 안 오는 신호를 기다릴 수 있다.
        천장 — 그 판정이 실측으로 닫히면 여기가 `gripper_motiondone` 폴링으로 바뀐다.
        그때 이 함수 하나만 고치면 된다 (호출처는 `commands.gripper(wait=True)` 뿐).
        """
        return gripper_stroke_s(vel_pct)

    # ── 안전 설정 (D53) — 되읽기가 없는 항목이 절반이라 매번 다시 넣는다 ──
    def apply_settings(self, settings):
        s = settings or {}
        with self._lock:
            # 하중이 먼저다 — 매뉴얼: 하중·설치방향이 없으면 충돌 감지가 오작동한다
            _code(_guard(self._r.SetLoadWeight, 0, float(s["payloadKg"])), "load-weight")
            x, y, z = s["cogMm"]
            _code(_guard(self._r.SetLoadCoord, float(x), float(y), float(z), 0), "load-cog")
            _code(_guard(self._r.SetRobotInstallPos, int(s["installPos"])), "install-pos")
            # config=1 — 설정 파일까지 갱신해 컨트롤러 재부팅 후에도 남긴다
            _code(_guard(self._r.SetAnticollision, int(s["collisionMode"]),
                         [float(v) for v in s["collisionLevel"]], 1), "anticollision")
            # 뒤 4개는 SDK 기본인자다. 안 넘기면 조용히 채워지는데 그 기본값 중 셋이
            # **각 범위의 가장 느슨한 끝**이다 (safeVel 250=최댓값 · margin 10=최댓값).
            # 안 적으면 우리가 고른 게 아니라 벤더가 고른 것이고, SDK 판올림이 우리
            # 안전 범위를 diff 없이 옮긴다. 지금 값은 기본값과 같지만 **박아서 같은 것**이다.
            _code(_guard(self._r.SetCollisionStrategy, int(s["collisionStrategy"]),
                         int(s["collisionSafeTimeMs"]), int(s["collisionSafeDistanceMm"]),
                         int(s["collisionSafeVelMmS"]),
                         [int(v) for v in s["collisionSafetyMargin"]]),
                  "collision-strategy")

    def read_settings(self):
        """되읽을 수 있는 것만. 못 읽는 값은 None — 아는 척하지 않는다."""
        out = {"payloadKg": None, "cogMm": None, "toolCoord": None, "jointSoftLimitDeg": None}
        with self._lock:
            rtn = _guard(self._r.GetTargetPayload)
            if isinstance(rtn, (list, tuple)) and rtn[0] == 0:
                out["payloadKg"] = float(rtn[1])
            rtn = _guard(self._r.GetTargetPayloadCog)
            if isinstance(rtn, (list, tuple)) and rtn[0] == 0:
                out["cogMm"] = [float(v) for v in rtn[1]]
            rtn = _guard(self._r.GetCurToolCoord)
            if isinstance(rtn, (list, tuple)) and rtn[0] == 0:
                out["toolCoord"] = [float(v) for v in rtn[1]]
            # 함수명은 Deg 인데 주석 단위는 mm 라 모순이다 (STACK). 대조·기록만 하고 거부엔 안 쓴다
            rtn = _guard(self._r.GetJointSoftLimitDeg)
            if isinstance(rtn, (list, tuple)) and rtn[0] == 0:
                out["jointSoftLimitDeg"] = [float(v) for v in rtn[1]]
        return out

    def read_coord_defs(self):
        """`GetCurToolCoord` · `GetActualWObjNum` → `GetWObjCoordWithID` 셋만 쓴다.
        전부 읽기다 — 로봇을 안 움직인다 (API-CONTRACT §좌표계 정의)."""
        out = {"tool": None, "user": None, "missing": []}
        with self._lock:
            rtn = _guard(self._r.GetCurToolCoord)
            if isinstance(rtn, (list, tuple)) and rtn[0] == 0:
                out["tool"] = [float(v) for v in rtn[1]]
            else:
                out["missing"].append("tool")
            # 활성 번호를 먼저 묻고 그 번호의 정의를 읽는다. `GetCurWObjCoord` 는 실시간
            # 패킷에서 꺼내므로 번호와 어긋날 수 있다 — 번호→정의 경로가 더 정직하다
            num = _guard(self._r.GetActualWObjNum, 1)
            if isinstance(num, (list, tuple)) and num[0] == 0:
                rtn = _guard(self._r.GetWObjCoordWithID, int(num[1]))
                if isinstance(rtn, (list, tuple)) and rtn[0] == 0 and rtn[1] is not None:
                    out["user"] = [float(v) for v in rtn[1]]
                else:
                    out["missing"].append("user")
            else:
                out["missing"].append("userNum")
        return out

    # ── 명령 계열 — ARMED 승격 뒤에만 브리지가 부른다. 상한 검사는 브리지 몫 ──
    def reset_errors(self):
        with self._lock:
            _code(_guard(self._r.ResetAllError), "reset")

    def enable(self, on):
        with self._lock:
            _code(_guard(self._r.RobotEnable, 1 if on else 0), "enable")

    def forward_kin(self, joints_deg):
        # GetForwardKin(joint_pos) → (0, [x,y,z,rx,ry,rz]) · 실패면 (err, None) — SDK Robot.py:3634
        with self._lock:
            rtn = _guard(self._r.GetForwardKin, [float(v) for v in joints_deg])
        if isinstance(rtn, (list, tuple)) and rtn[0] == 0 and rtn[1]:
            return [float(v) for v in rtn[1]]
        return None

    def inverse_kin(self, tcp_mm_deg, ref_joints_deg=None):
        # GetInverseKinRef(type, desc_pos, joint_pos_ref) → (0, [j1..j6]) · 실패면 (err, None)
        #   type 0 = 절대 위치(베이스 기준) — SDK Robot.py:3574
        # **참조 있는 쪽을 기본으로 쓴다.** `GetInverseKin(config=-1)` 은 여러 해 중 하나를
        # 컨트롤러가 고르는데, 그게 지금 자세와 관절이 뒤집힌 해면 손끝은 맞아도 **가는 길이
        # 전혀 다른 곳을 지난다** — 경로 검사(D75)가 그 길을 검사하므로 해 선택이 곧 안전이다.
        pose = [float(v) for v in tcp_mm_deg]
        with self._lock:
            if ref_joints_deg is not None:
                rtn = _guard(self._r.GetInverseKinRef, 0, pose,
                             [float(v) for v in ref_joints_deg])
            else:
                rtn = _guard(self._r.GetInverseKin, 0, pose, -1)
        if isinstance(rtn, (list, tuple)) and rtn[0] == 0 and rtn[1]:
            return [float(v) for v in rtn[1]]
        return None

    def set_speed(self, pct):
        """전역 속도 오버라이드. **되읽기가 없다** — SDK 에 `SetSpeed` 만 있고 getter 도
        구조체 필드도 없다(2026-08-12 에 전부 grep 했다). 그래서 「보낸 값」만 알 수 있고,
        계약이 `/state.speedOverridePct` 를 `source: "sent"` 로 표시하게 한 이유가 그것이다.

        ⛔ 이 값이 `0` 이면 외부 이동이 **전부** `code=172`("Motion Speed Cannot Be 0")로
        거부된다 — 그 사고가 이 함수가 생긴 이유다 (`docs/evidence/2026-08-12/movej-172-windows.md`).
        """
        with self._lock:
            _code(_guard(self._r.SetSpeed, int(pct)), "speed")

    def set_mode(self, mode):
        with self._lock:
            _code(_guard(self._r.Mode, int(mode)), "mode")

    def exit_drag_teach(self):
        with self._lock:
            _code(_guard(self._r.DragTeachSwitch, 0), "dragteach")
        self._drag = (0.0, False)

    def set_sample_period(self, ms):
        # v2 SDK 는 20004 스트림이 주기를 스스로 관리한다 — 별도 설정 호출이 없다
        return

    def move_j(self, joints_deg, speed_pct, tool, user):
        # **`blendT=0` — 논블로킹이다.** 벤더 기본 `-1.0` 은 "운동 완료까지 阻塞(블로킹)"
        # 이라 이동이 끝날 때까지 xmlrpc 호출이 안 돌아온다 (`Robot.py:1090` 원문).
        # 그러면 `_guard` 의 3초 상한이 **정상 이동을 행으로 오인해** 스레드를 버리고,
        # 버려진 스레드가 연결을 요청 보낸 채로 쥐어 이후 전부 `Request-sent` 가 된다
        # (2026-08-05 실기 · 33° 이동에서 재현). 5° 상한이 그동안 이걸 가리고 있었다.
        # 완료 판정은 20004 스트림의 `motionQueueLength`·`motionDone` 이 이미 하고 있고,
        # 조건 6(큐 0)이 다음 명령을 막으므로 겹쳐 쏘는 경로도 없다.
        with self._lock:
            _code(_guard(self._r.MoveJ, list(joints_deg), int(tool), int(user),
                         vel=float(speed_pct), blendT=0.0), "moveJ")

    def stop(self):
        # SAFETY-RULES 제3원칙 — 정지를 막는 조건은 만들지 않는다. 잠금도 조건이다:
        # 앞선 명령이 행이면 잠금을 기다리다 stop 이 못 나간다. 잠깐만 기다리고,
        # 안 잡히면 잠금 없이 보낸다. xmlrpc 동시성 위험보다 안 멈추는 쪽이 더 나쁘다.
        got = self._lock.acquire(timeout=STOP_LOCK_WAIT_S)
        try:
            _code(_guard(self._r.StopMotion), "stop")
        finally:
            if got:
                self._lock.release()
