# 명령 실행 — 게이트를 태우고 어댑터로 보낸다 (API-CONTRACT §명령 · SAFETY-RULES).
#
# **여기가 실기에 닿는 유일한 곳이다.** 허용목록은 `jog`·`moveJ`·`gripper`·`mode`·`stop`·`speed`
# 여섯뿐이고, 지점 이동·비전 제안은 새 이름을 더하는 게 아니라 이 함수들로 **번역**된다.
# `speed`(전역 속도 오버라이드)는 2026-08-12 에 열었다 — 그 값이 0 이면 외부 이동이 전부
# 거부되는데(`code=172`) 화면에서 보이지도 고칠 수도 없었다 (계약 §speed).
# 라우트는 이걸 부르기만 한다 (D54 · tb-bridge 모양). 이 모듈은 main 을 모른다.
#
# 전부 **스레드에서** 돌린다 — xmlrpc 는 블로킹이고 이벤트 루프를 잡으면 stop 이 늦는다.
import time

import amr        # 조건 27 — 터틀봇이 움직이는 중인지 (읽기만 · 명령은 안 보낸다)
import safety

# 그리퍼 속도·힘은 화면이 못 정한다 — 보수적 기본값을 서버가 박는다 (GOAL-live-gripper §3).
# 파지 실험으로 힘을 올리려면 여기 한 곳만 고친다. 천장: 물체별 힘 프로필은 그 골 밖이다.
#
# ⚠ **속도를 낮추려면 `fairino.gripper_maxtime_ms` 를 먼저 읽어라.** 시간 상한이 이 값에서
# 유도되고, **하한은 `fairino.GRIPPER_VEL_FLOOR_PCT`(지금 11.5%)** 다 — 그 아래는 SDK
# `maxtime` 상한(30000ms)을 넘어 **보낼 수 없다.** 숫자를 여기 다시 적지 않는다:
# 2026-08-11 에 행정 상수를 1.0→1.15 로 올려 하한이 10%→11.5% 로 따라 움직였다.
# ✅ **파지 실기 확인은 끝났다** (2026-08-11 킬실험 · `GAP-MATRIX` 2행 CLOSED) — 컨트롤러는
# 막힌 채로 완료를 보고하고 `maxtime` 을 계속 세지 않는다. 즉 **속도를 낮춰도 파지 중 래치는
# 안 난다.** 다만 **힘을 올리는 것은 별개다** — 힘 하한·변형 한계는 아직 안 쟀다(GAP 100행).
# 판정은 `motionDone` 이 아니라 **`pct`** 로 한다 (`API-CONTRACT.md` §그리퍼).
GRIPPER_VEL_PCT = 30.0
GRIPPER_FORCE_PCT = 30.0
# 기구학과 상태 스트림이 같은 좌표계인지 대조할 때의 허용 오차. 같은 로봇의 같은 관절이라
# 원래 0 이어야 하고, 5mm 는 반올림·표본 시차만 덮는 값이다 (계약 §작업영역)
FK_FRAME_TOL_MM = 5.0

# `speedPct 100` 환산 각속도 — **실측이다** (2026-08-08 · j1 · `evidence/2026-08-08/`).
# Δ 1·2·4·5° 를 각 2회, 속도 10·5·3% 로 재서 `t = 0.315s + Δ/(0.289×speedPct)` 를 얻었다.
# 비례도 확인됐다 (5% 예측 3.78 실측 3.65 · 3% 예측 6.09 실측 5.91).
#
# ⚠ **벤더 사양 180°/s 를 쓰면 안 된다.** 그건 관절의 기계적 최대이고, `MoveJ` 의 `vel`
# 백분율은 그것의 백분율이 **아니다** — 실측이 6배 넘게 느리다. 어제 이 값을 180 으로
# 넣었다가 대기가 4배 짧아졌다 (5° 예측 0.53s · 실측 2.04s). **추측한 상수의 대가다.**
# 컨트롤러 전역 속도 오버라이드(펜던트 슬라이더)가 바뀌면 이 값도 바뀐다 — 그러면 다시 잰다.
JOINT_DEG_S_AT_FULL = 28.9
# 이동 하나의 고정 비용 — 가감속 램프 + 지령 왕복. 실측 절편 0.315s 를 올림해 쓴다
MOVE_REGISTER_S = 0.35
# 정착을 기다리는 상한. **넘치면 잘라 기다리지 않고 거부한다** (2026-08-08 · 그리퍼
# `gripper_maxtime_ms` 와 같은 규약). 전에는 `min()` 으로 잘랐는데, 자르면 로봇이 아직 가는
# 중인데 응답이 먼저 나가고 **화면은 그 응답을 도착으로 읽는다.**
#
# ⚠ 실기에서 그대로 터졌다 (`docs/evidence/2026-08-08/fr5-program-loop-refusal.md`):
# 지점 사이가 Δ 46.2° 라 10% 에서 16.3초가 필요한데 상한이 12.0초였다. 4.3초를 잘라 응답이
# 나갔고, 연속 실행이 다음 단계를 즉시 보내 **드리프트 12.5°** 로 거부됐다. 거부는 옳게
# 동작한 것이지만, 잘린 시간이 **조금**이었다면 드리프트가 5° 상한 안이라 겹침이 조용히
# 통과했을 것이다 — 그 구간이 이 상수의 진짜 위험이었다.
#
# 60초는 상한 속도(10%)에서 172°, 3% 에서 51° 를 덮는다. 넘는 조합은 보내지 않고 사유를
# 돌려준다 — 속도를 올리거나 지점을 나누라고 사람에게 말하는 편이, 조용히 겹치는 것보다 낫다.
# ⚠ **STOP 은 이 대기에 안 걸린다** — 웹소켓의 별도 경로이고 조종권·phase 무관이다 (제3원칙).
MOVE_SETTLE_CAP_S = 60.0

# `JOINT_DEG_S_AT_FULL` 을 잰 날(2026-08-08)의 **전역 속도 오버라이드가 기록에 없다.**
# 그래서 그 상수는 「어떤 오버라이드에서의 값」인지 모르는 상태다 — 지금 확보된 값(30%)을
# 기준선으로 **가정**하고, 그 사실을 여기 적어 둔다 (`Shared/data/workcell.js` §각속도).
SPEED_OVERRIDE_BASELINE_PCT = 30.0


def settle_factor(override_pct):
    """오버라이드에 따른 대기 배수. ⛔ **늘리기만 하고 절대 줄이지 않는다.**

    오버라이드가 기준선보다 **낮으면** 실제 이동이 그만큼 느려지는데 대기가 그대로면
    응답이 「도착」인데 로봇은 아직 간다 → 겹침이다. 그래서 낮을 때는 비례로 늘린다.
    **높을 때는 줄이지 않는다** — 기준선이 가정이라, 줄이는 방향으로 틀리면 그게 곧 겹침이다.
    (틀려도 손해가 「느림」인 쪽으로만 틀린다.)

    ⚠ **모를 때는 허용 하한을 가정한다** — 우리가 안 보냈으면 펜던트 값이고 그건 못 읽는다.
    가장 느린 허용값에서 계산해야 안전하다. 그래서 **조작대에서 값을 한 번 눌러 주는 것이
    대기를 짧게 만드는 길**이다 (계약 §speed — 화면이 `모름` 을 그대로 말한다).
    """
    o = override_pct if isinstance(override_pct, (int, float)) and override_pct > 0 \
        else safety.SPEED_OVERRIDE_MIN_PCT
    return max(1.0, SPEED_OVERRIDE_BASELINE_PCT / float(o))


def settle_seconds(from_deg, to_deg, speed_pct, override_pct=None):
    """이동이 끝나기를 기다릴 시간. **고정값이면 안 되고, 넘치면 자르지도 않는다.**

    상한을 넘으면 `ValueError` 다 — 호출자는 **보내기 전에** 이걸 물어보고 거부해야 한다
    (`gripper_maxtime_ms` 와 같은 모양). 보낸 뒤에 물으면 이미 움직이는 로봇을 두고 죽는다.

    실기 실측(2026-08-08): `10% × 1°` 는 0.67s, `10% × 5°` 는 **2.04s** 다. 고정 0.25초는
    어느 조합에서도 안 맞았다 — 제일 짧은 1° 조차 3배 모자랐다.

    ⚠ **모자라도 조건 6·8 은 안 걸린다** (실기 확인). 큐는 이동 중에도 0 이고(상태판 감사
    1순위), 드리프트 상한 5° 가 조그 상한 5° 와 **같아서** 조그 직후 드리프트는 정의상
    상한을 못 넘는다. 그래서 이동 중에 들어온 명령이 **거부 없이 조용히 팔의 목표를
    바꾼다** — 5° 세 번을 0.35초 간격으로 넣었더니 15° 가 아니라 **7.48° 만 갔다.**
    이 대기는 그 겹침을 막는 **유일한** 장치다 (GAP: 겹침 자체를 거부하는 게이트는 아직 없다).

    **폴링으로 대신하지 않는다** — 명령 뒤 조밀 폴링이 `read_state` 마다 xmlrpc 를 태워
    이동 중 단일 연결을 두드린 사고가 있었다 (2026-08-04 · 그리퍼). 한 번 자고 한 번 읽는다.

    ⚠ 실기에서는 **조건 6 이 안 걸릴 수 있다** — `motionQueueLength` 가 이동 중에도 0 이라는
    관측이 감사 1순위로 올라 있다 (`PROJECT-STATUS`). 그래도 이 대기는 필요하다: 남는 방어선
    **조건 8**(지령·실측 괴리 · D77)이 그때는 유일한 관문이라, 모자란 대기가 곧 거부다.
    """
    try:
        deg_s = JOINT_DEG_S_AT_FULL * float(speed_pct) / 100.0
        delta = max(abs(float(t) - float(c)) for t, c in zip(to_deg, from_deg))
    except (TypeError, ValueError):     # 값을 못 읽었으면 등록 시간만 — 판정은 게이트가 한다
        return MOVE_REGISTER_S
    if not deg_s > 0 or delta != delta:
        return MOVE_REGISTER_S
    need = (MOVE_REGISTER_S + delta / deg_s) * settle_factor(override_pct)
    if need > MOVE_SETTLE_CAP_S:
        raise ValueError(
            f"이 이동은 {delta:.1f}° 라 속도 {float(speed_pct):g}% 에서 {need:.0f}초가 걸리는데 "
            f"대기 상한이 {MOVE_SETTLE_CAP_S:.0f}초다 — 속도를 올리거나 지점을 나눠라 "
            f"(자르고 보내면 도착 전에 다음 명령이 나간다). "
            f"전역 속도가 `모름` 이면 대기가 {settle_factor(None):.0f}배로 잡힌다 — "
            f"조작대에서 값을 한 번 누르면 짧아진다")
    return need


class Commands:
    """세션 하나에 붙는 명령 실행기. 사유 목록을 돌려주고, 비면 성공이다."""

    def __init__(self, session, on_log):
        self._s = session
        self._log = on_log

    def _age(self):
        return time.time() - self._s.lastStateAt

    def _send(self, what, state, fn, *args):
        """어댑터 호출 한 번. **SDK 실패를 예외로 흘리지 않고 「사유」로 바꾼다.**

        ⛔ 흘리면 트레이스백만 로그에 남고 **화면은 아무 사유도 못 받는다.** 2026-08-11~12 에
        윈도우 호스트에서 `MoveJ` 가 **18/18 `code=172`** 로 거부됐는데 화면이 아무 말도 안 해
        하루를 썼다 (그 앞에는 로그가 cp949 로 죽어 아예 안 찍혔다 · `main.py` §log).
        사유는 **반환값으로만** 나간다 — 이 계층의 규약이다 (사유가 있으면 실패).

        **상태 필드를 같이 싣는다.** 숫자만 주면 사람이 우리 코드를 뒤진다 — 펜던트를 볼지
        우리를 볼지가 이 세 값에서 갈린다 (`mode`·`robotState`·`programState`).
        """
        try:
            fn(*args)
            return []
        except Exception as e:                                   # noqa: BLE001 — 이유를 값으로 돌린다
            st = state or {}
            why = (f"컨트롤러가 {what} 를 거부했다 — {e} · "
                   f"mode={st.get('mode')} robotState={st.get('robotState')} "
                   f"programState={st.get('programState')} "
                   f"안전코드={(st.get('safety') or {}).get('code')} · "
                   f"펜던트 확인: 제어권 Local→Remote · 전역속도 0% 아닌지 · 프로그램 상태")
            self._log(f"{what}-거부", why)
            return [why]

    # ── 이동 ────────────────────────────────────────────────────────────────
    def motion(self, target_deg, speed_pct, scan_path=False, dry_run=False, via="moveJ"):
        """게이트 → MoveJ. 사유가 있으면 보내지 않는다.

        `via` 는 **어느 창구가 목표를 만들었나**를 스트림에 적는 이름이다 (계약 §이동 목표 · D196).
        조그만 `"jog"` 를 넘기고 나머지는 `"moveJ"` 다 — 거부된 목표는 적지 않는다.

        `scan_path=True` 는 **지점 이동**이다 (계약 §경로 검사 · D75) — 조그용 5° 상한을
        빼는 대신 현재→목표를 5° 간격으로 보간해 **표본 전부를 작업영역 게이트에 태운다.**
        상한의 근거가 "경로가 안 보인다" 였으므로, 경로를 보면 근거가 사라진다.

        `dry_run=True` 는 **`POST /ik` 의 판정**이다 (계약 §손끝 자리 → 관절각). 검사는
        하나도 빼지 않고 전부 태우되 **보내는 한 줄만 안 한다** — 그래서 「통과한다」는 답이
        실제 이동과 같은 근거를 갖는다. **검사를 따로 짜지 않는 것이 요점이다**: 복제하면
        한쪽만 고쳐져 「미리보기는 통과인데 실제로는 거부」가 생기고, 그 순간 미리보기가
        거짓말이 된다.
        """
        s = self._s
        state = s.read_fresh_state()
        reasons = safety.check_motion(state, self._age(), target_deg, speed_pct,
                                      s.appliedSettings,
                                      delta_cap=None if scan_path else safety.JOINT_DELTA_CAP_DEG,
                                      commanded_deg=s.lastCommandedDeg,
                                      amr_status=amr.motion_status())
        # ⛔ **미리보기는 여기서 안 돌아간다** (2026-09-04). 실이동은 첫 사유에서 끊는 것이
        # 맞다 — 어차피 안 보낼 것을 더 계산할 이유가 없다. 그런데 `dry_run` 은 **사람이
        # 계획하려고** 부르는 것이고, 그때 제일 알고 싶은 것이 아래 **작업영역**(손끝이 판을
        # 뚫나)이다. 여기서 끊으면 ARM 전에는 그 답을 **영영 못 듣는다** — 서보 OFF 하나로
        # 조용히 넘어가고, 화면은 「작업영역 사유 없음」을 **통과로 읽는다.**
        # 「빈 결과는 통과 증거가 아니다」의 교과서 사례라 미리보기만 끝까지 태운다.
        pre = list(reasons)
        if reasons and not dry_run:
            return reasons
        coord = state.get("coord") or {}
        # 조건 12 의 카테시안 절반 — 관절 한계만으로는 손끝이 상판을 뚫는 것을 못 막는다.
        # 목표 관절을 **로봇 자신의 기구학**으로 손끝 위치로 바꿔 판정한다 (계약 §작업영역).
        # **관절각과 `coordDefs` 도 같이 넘긴다** — 손끝·툴은 `tcpMmDeg` 로 되지만 팔 링크는
        # 관절각에서 FK 를 돌아야 하고, 그 결과가 베이스 기준이라 user1 원점이 필요하다.
        # ⚠ **`read_fresh_state()` 에는 `coordDefs` 가 없다** — `snapshot()` 만 채운다.
        #    `state.get("coordDefs")` 로 읽으면 항상 비어서 팔 판정이 매번 차단된다
        #    (2026-08-11 에 mock 브리지의 모든 이동이 그렇게 막혔다 · 게이트가 잡았다).
        #    세션에서 직접 가져온다 — 번호가 그대로면 캐시라 xmlrpc 를 다시 안 때린다.
        defs = s._coord_defs(state.get("coord")) or {}      # noqa: SLF001 — 같은 계층이다
        # ⛔ **`s.workspace` 를 직접 쓰지 않는다** (2026-08-13 · 게이트가 받침을 못 보던 버그).
        # 프로필 상자만 들어 있어서 **비전이 준 움직이는 장애물(받침)이 빠진다** —
        # 화면은 `effective_workspace()` 를 그리므로 **화면은 막는다고 하는데 게이트는 안 막는**
        # 상태였다. D130 이 없애려던 것의 거울상이고, 사람이 화면을 믿는 만큼 더 나쁘다.
        # **한 번 구해 경로 전체에 같은 값을 쓴다** — 표본마다 다시 읽으면 검사 도중 받침이
        # 갱신될 때 앞뒤 표본이 다른 세상을 보게 된다.
        ws_eff = s.effective_workspace()
        if ws_eff:
            if scan_path:
                reasons = self._scan_path(state.get("jointsDeg") or [], target_deg, coord, defs,
                                          ws_eff)
            else:
                reasons = safety.check_workspace(s.adapter.forward_kin(target_deg),
                                                 ws_eff, coord, target_deg, defs)
            if reasons:
                self._log("작업영역-거부", " · ".join(reasons))
                return pre + reasons
        elif scan_path:
            # 검사할 수단이 없는데 상한만 푸는 것이 제일 위험하다 (계약 §경로 검사)
            return pre + ["작업영역이 등재되지 않아 경로를 검사할 수 없다 — 지점 이동을 열지 않는다"]
        if pre:
            return pre                       # 미리보기 — 작업영역은 통과했고 운영 조건이 남았다
        # **대기 시간을 먼저 구한다** — 못 기다릴 이동이면 보내기 전에 죽는다
        # (`fairino.gripper_maxtime_ms` 와 같은 규약). 보낸 뒤에 물으면 이미 움직이는 로봇을
        # 두고 거부하게 되고, 그러면 아무도 도착을 안 기다린다.
        try:
            # 오버라이드는 **보낸 값**만 안다 — 모르면 `settle_factor` 가 하한을 가정한다
            wait_s = settle_seconds(state.get("jointsDeg") or [], target_deg, speed_pct,
                                    s.speedOverridePct)
        except ValueError as e:
            self._log("이동시간-거부", str(e))
            return [str(e)]
        if dry_run:
            # 여기까지가 검사 전부다 — 신선도·서보·auto·모션큐·드리프트·URDF 한계·작업영역·
            # 경로·대기시간. **보내는 줄 하나만 건너뛴다.** 로봇은 아무것도 모른 채로 남는다.
            self._log("ik-미리보기", f"target={[round(v, 3) for v in target_deg]} 통과")
            return []
        reasons = self._send("moveJ", state, s.adapter.move_j,
                             target_deg, speed_pct, coord.get("toolId", 0), coord.get("userId", 0))
        if reasons:
            return reasons
        # 보낸 목표가 곧 다음 판정의 드리프트 기준이다 (계약 §드리프트 기준).
        # **보낸 뒤에** 적는다 — 게이트에서 거부된 목표는 기준이 될 수 없다.
        s.lastCommandedDeg = [float(v) for v in target_deg]
        # 스트림이 「어디로 가는 중인가」를 말하게 한다 (계약 §이동 목표). `doneAt` 은 정착 대기가 끝나면 찍는다 —
        # 그동안 `/ws/state` 는 `doneAt: null` 을 내고, 화면은 그 사이에만 목표를 고스트로 그린다.
        s.motionTarget = {"jointsDeg": list(s.lastCommandedDeg), "via": via, "speedPct": speed_pct,
                          "queuedAt": time.time(), "doneAt": None}
        self._log("moveJ", f"target={[round(v, 3) for v in target_deg]} speed={speed_pct} "
                  f"대기예정={wait_s:.2f}s")
        time.sleep(wait_s)
        s.motionTarget = {**s.motionTarget, "doneAt": time.time()}   # 새 dict — 스트림이 반쯤 바뀐 값을 못 본다
        after = s.read_fresh_state()
        self._log("moveJ-settle", f"{wait_s:.2f}s 대기 (상한 {MOVE_SETTLE_CAP_S}s)")
        self._log("moveJ-after", f"queue={after.get('motionQueueLength')} "
                  f"servoTarget={[round(v, 2) for v in (after.get('lastServoTargetDeg') or [])]} "
                  f"robotState={after.get('robotState')} programState={after.get('programState')} "
                  f"motionDone={after.get('motionDone')}")
        return []

    def _scan_path(self, from_deg, to_deg, coord, coord_defs=None, ws=None):
        """가는 길을 **움직이기 전에** 훑는다. 하나라도 막히면 몇 번째가 왜인지 돌려준다.

        표본은 전부 여기서 구한다 — **이동 중에 xmlrpc 를 두드리지 않는다** (연결이 하나뿐이라
        움직이는 동안 두드리면 컨트롤러가 밀린다 · 그리퍼 폴링 사고와 같은 계열).

        `ws` 는 **호출자가 한 번 구해 넘긴 작업영역**이다 (`effective_workspace()` — 비전이 준
        움직이는 장애물 포함). 여기서 다시 읽지 않는 이유는 둘이다 — 표본마다 파일을 때리지
        않으려는 것과, **경로 전체가 한 스냅샷을 보게** 하려는 것. 검사 도중 받침이 갱신되면
        앞뒤 표본이 다른 세상을 보고, 그러면 「어느 것도 안 막는 틈」이 생긴다.
        """
        poses = safety.path_samples(from_deg, to_deg)
        if poses is None:
            return ["경로를 표본할 수 없다 — 현재 자세를 못 읽었다 (제1원칙: 결측=차단)"]
        if ws is None:                          # 옛 호출자 보호 — 없으면 스스로 구한다
            ws = self._s.effective_workspace()
        for i, pose in enumerate(poses, 1):
            reasons = safety.check_workspace(self._s.adapter.forward_kin(pose),
                                             ws, coord, pose, coord_defs)
            if reasons:
                return [f"가는 길 {i}/{len(poses)} 번째가 막힌다 — " + " · ".join(reasons)]
        self._log("경로검사", f"{len(poses)}점 전부 통과 — 한 번에 간다")
        return []

    def jog(self, joint, delta_deg):
        """현재 자세에서 한 축만 민다. 목표는 **서버가 현재값에서 만든다**."""
        if not isinstance(joint, int) or not 0 <= joint <= 5:
            return ["joint 는 0~5"]
        if not isinstance(delta_deg, (int, float)) or delta_deg != delta_deg:
            return ["deltaDeg 가 숫자가 아니다"]
        joints = (self._s.lastState or {}).get("jointsDeg")
        if not joints:
            return ["현재 관절값이 없다 — fail-closed"]
        target = list(joints)
        target[joint] += float(delta_deg)
        return self.motion(target, safety.SPEED_CAP_PCT, via="jog")

    # ── 그리퍼 ──────────────────────────────────────────────────────────────
    def gripper(self, pct, wait=False):
        """게이트 → MoveGripper. 관절 게이트가 아니라 그리퍼 전용을 탄다 (계약 §그리퍼).

        `wait` — **누가 부르냐로 갈린다** (계약 §grip 칸):
        · 조작대 버튼(WS `gripper`)은 `False` 다. 사람이 손가락을 눈으로 보며 +/- 를 누르는데
          한 번에 행정 시간을 물리면 미세조작이 불가능해진다 (`evidence/2026-08-08` 그리퍼 미세조작)
        · 프로그램 `grip` 칸은 `True` 다. **한 요청이 한 단계**(D78)라 응답이 곧 「그 단계가
          끝났다」여야 한다 — 안 기다리면 다음 칸의 이동이 손가락과 겹친다
        """
        s = self._s
        state = s.read_fresh_state()
        reasons = safety.check_gripper(state, self._age(), pct, s.appliedSettings, amr_status=amr.motion_status())
        if reasons:
            self._log("gripper-거부", " · ".join(reasons))   # 조용히 버리면 원인을 못 찾는다
            return reasons
        # **대기 시간을 먼저 구한다** — moveJ 와 같은 규약이다. 보낸 뒤에 물으면 이미
        # 움직이는 손가락을 두고 죽는다 (`settle_seconds` 머리주석과 같은 이유)
        settle_s = s.adapter.gripper_settle_s(GRIPPER_VEL_PCT) if wait else 0.0
        # 이동과 **같은 규약**으로 감싼다 — 그리퍼가 지금 잘 되더라도 실패가 예외로 새면
        # 화면이 사유를 못 받는다. 그 침묵이 `moveJ` 에서 하루를 태웠다 (`_send` 머리주석)
        reasons = self._send("gripper", state, s.adapter.gripper_move,
                             float(pct), GRIPPER_VEL_PCT, GRIPPER_FORCE_PCT)
        if reasons:
            return reasons
        # 명령 뒤 조밀 폴링을 하지 않는다 (2026-08-04) — 그 폴링이 read_state 마다
        # IsInDragTeach(xmlrpc) 를 태워 **이동 중에** 단일 연결을 50번 두드렸다.
        # 정착값은 다음 상태 스트림이 어차피 싣는다.
        self._log("gripper", f"지령={pct} vel={GRIPPER_VEL_PCT} force={GRIPPER_FORCE_PCT} "
                  f"대기예정={settle_s:.2f}s")
        if settle_s > 0:
            time.sleep(settle_s)
        return []

    def gripper_activate(self):
        """활성화 — 손가락이 실제로 움직인다. 같은 안전 확인을 지나되 pct 판정은 없다."""
        s = self._s
        state = s.read_fresh_state()
        reasons = safety.check_gripper(state, self._age(), 0, s.appliedSettings, amr_status=amr.motion_status())
        # 활성화 자체가 active 를 만드는 것이므로 '활성화 안 됨' 은 사유에서 뺀다
        reasons = [r for r in reasons if "활성화되지 않았다" not in r]
        if reasons:
            return reasons
        diag = s.adapter.gripper_activate()
        # 정체는 여기서만 온다 — 로그로 흘려보내면 궤적이 어느 그리퍼로 찍혔는지 못 남긴다 (D46·D81)
        s.gripperConfig = diag
        time.sleep(0.5)                  # 원점을 잡는 물리 동작 — 비트가 서기까지 한 번만 본다
        after = (s.read_fresh_state() or {}).get("gripper") or {}
        self._log("gripper-activate", f"config={diag} → activeRaw={after.get('activeRaw')} "
                  f"faultRaw={after.get('faultRaw')} pctRaw={after.get('pctRaw')}")
        return []

    # ── 모드 ────────────────────────────────────────────────────────────────
    def mode(self, manual):
        """**로봇을 움직이지 않는다.** 수동으로 바꾸면 펜던트가 조작·드래그 티칭을 할 수 있고,
        자동으로 되돌리면 우리 jog/moveJ 가 가능해진다 (계약 §모드 전환 · D72)."""
        state = self._s.read_fresh_state()
        reasons = safety.check_mode(state, self._age(), manual)
        if reasons:
            self._log("mode-거부", " · ".join(reasons))
            return reasons
        self._s.adapter.set_mode(1 if manual else 0)
        # 수동으로 넘기면 펜던트가 팔을 옮길 수 있다 — 우리 지령은 기준 자격을 잃는다
        self._s.lastCommandedDeg = None
        self._log("mode", f"{'수동 — 펜던트가 조작한다' if manual else '자동 — 우리가 조작한다'}")
        return []

    def speed_override(self, pct):
        """전역 속도 오버라이드. **로봇을 움직이지 않는다 — 배수만 바꾼다** (계약 §speed).

        ⛔ 되읽기가 없다. 그래서 성공하면 세션이 **보낸 값**을 기억하고 `/state` 가
        `source: "sent"` 로 내보낸다 — 화면은 그것을 **실측이 아니라고** 표시해야 한다.
        펜던트에서 누가 바꾸면 우리 값은 거짓이 된다. **거짓 확신이 값을 안 보여주는 것보다 나쁘다.**
        """
        s = self._s
        state = s.read_fresh_state()
        reasons = safety.check_speed_override(state, self._age(), pct)
        if reasons:
            self._log("speed-거부", " · ".join(reasons))
            return reasons
        reasons = self._send("speed", state, s.adapter.set_speed, int(pct))
        if reasons:
            return reasons
        s.speedOverridePct = int(pct)          # 보낸 값 — 되읽기가 아니다
        self._log("speed", f"전역 속도 = {int(pct)}% (보낸 값 · 되읽기 없음)")
        return []

    # ── 승격 (계약 §명령 승격 — D41) ────────────────────────────────────────
    def arm_sequence(self, sample_ms):
        """서보 on → 안전 설정 → 샘플 주기 → 자동 모드 → 작업영역 좌표계 대조.
        **순서가 계약이다** — 서보 OFF 에선 auto 교정이 거부된다 (유니티 실측)."""
        s = self._s
        state = s.read_fresh_state()
        reasons = safety.check_arm(state, self._age())
        if reasons:
            return reasons
        a = s.adapter
        a.reset_errors()                 # 잠복 fault 해제 — 사람이 현장확인한 arm 안에서만
        why_enable = None
        try:
            a.enable(True)
        except Exception as e:            # noqa: BLE001 — 아래에서 실제 상태로 판정한다
            # 실측(2026-07-31): FW Web-3.9.3 이 SDK V1.2.4 의 RobotEnable 만 -4 로 거부한다.
            # 사람이 펜던트에서 서보를 올렸다면 그걸 인정한다 — 실제 상태가 판정한다
            why_enable = str(e)
        # ⛔ **예외가 났든 안 났든 실제 상태로 판정한다** (2026-09-04 · D179).
        # 전에는 `except` 안에서만 확인해서, `enable()` 이 **예외 대신 에러코드**로 실패하면
        # 서보가 꺼진 채 ARM 이 `ok:true` 를 냈다. 사람은 「ARM 됐네」로 읽는데 팔은 매 명령을
        # 「서보 OFF」로 거부한다 — **이름은 맞는데 값이 틀린**(D155) 그 모양이다.
        # 실기에서 그대로 물렸다: `/arm` ok:true · `enabled: False` · 이동 1걸음째 거부.
        if not s.read_fresh_state().get("enabled"):
            raise ConnectionError(
                (f"{why_enable} · " if why_enable else "서보가 안 켜졌다 — ")
                + "펜던트에서 로봇 Enable(활성화) 후 다시 ARM 하면 이어갈 수 있다")
        # 안전 설정은 서보를 올린 뒤·자동 모드 전에 넣는다 (계약 §로봇 안전 설정 · D53).
        # 컨트롤러 충돌 감지는 기본으로 안 켜져 있고 기본 민감도는 사람 접촉에 반응하지 않는다.
        s.apply_settings()
        a.set_sample_period(sample_ms)
        a.exit_drag_teach()
        a.set_mode(0)
        s.lastCommandedDeg = None        # ARM 직전까지 팔이 어디를 지났는지 우리는 모른다

        return self._check_frame()

    def _check_frame(self):
        """작업영역은 **기구학이 스트림과 같은 좌표계일 때만** 참이다. 그 가정을 여기서
        실제로 대조한다 — 어긋나면 등재된 숫자가 다른 자리를 가리킨다 (D64 계열)."""
        s = self._s
        if not s.workspace:
            return []
        st = s.read_fresh_state() or {}
        fk = s.adapter.forward_kin(st.get("jointsDeg") or [])
        tcp = st.get("tcpMmDeg") or []
        if not fk or len(tcp) < 3:
            return ["작업영역 게이트를 켤 수 없다 — 기구학을 못 구했다 (제1원칙)"]
        gap = max(abs(fk[i] - tcp[i]) for i in range(3))
        self._log("작업영역", f"기구학↔스트림 최대차 {gap:.1f}mm · fk={[round(v, 1) for v in fk[:3]]}")
        if gap > FK_FRAME_TOL_MM:
            return [f"기구학과 상태 스트림의 좌표계가 다르다 — 최대차 {gap:.1f}mm "
                    f"(> {FK_FRAME_TOL_MM}mm). 작업영역 값이 거짓이 된다"]
        return []
