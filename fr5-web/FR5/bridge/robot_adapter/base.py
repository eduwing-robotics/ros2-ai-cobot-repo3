# FAIRINO SDK 접점의 유일한 경계 (FR5/bridge/README.md). 이 밖에서는 SDK 를 import 하지 않는다.
# 단위 변환(라디안·미터 ↔ 도·mm)도 이 경계 안에서만 한다 (하드룰 5).
# 여기는 안전 판정을 하지 않는다 — 게이트는 브리지(safety.py)가 강제한다 (SAFETY-RULES 제2원칙).


class RobotAdapter:
    """mock.py 와 fairino.py 가 같은 얼굴을 갖는다. 바깥면 단위는 전부 도(°)·mm."""

    def connect(self) -> None:
        """관측 연결만 연다. 서보·모드는 절대 건드리지 않는다 (observe-only)."""
        raise NotImplementedError

    def disconnect(self) -> None:
        raise NotImplementedError

    def get_version(self) -> dict:
        """{ model, controller, servo, end, sdk, web } — 못 읽는 값은 None 으로 보고한다.
        빈 문자열로 채워 아는 척하지 않는다 (preflight 가 '보고된 값만' 검증한다)."""
        raise NotImplementedError

    def read_state(self) -> dict:
        """API-CONTRACT §상태값의 로봇 유래 필드 — enabled·mode·jointsDeg·tcpMmDeg·
        motionQueueLength·safety·coord·gripper. 게이트 재료로 lastServoTargetDeg(있으면)와
        missing(못 읽은 필드 이름 목록)을 함께 준다. t/robotId/owner/phase 는 브리지가 얹는다."""
        raise NotImplementedError

    def read_coord_defs(self) -> dict:
        """활성 툴·사용자 좌표계가 **어디인지** 읽는다 (API-CONTRACT §좌표계 정의).

        `coord` 는 번호만 말한다. 번호만으로는 `tcpMmDeg` 가 어느 원점 기준인지 알 수 없어,
        로봇이 자기 밑에 앉은 판을 `(305, -516)` 으로 보고해도 아무도 못 알아챈다
        (2026-08-07 에 하루를 잃었다). 그래서 정의를 함께 싣는다.

        `{ tool: [x,y,z,rx,ry,rz]|None, user: [...]|None, missing: [이름] }`.
        **읽기 전용이다** — 설정을 바꾸지 않는다. 못 읽으면 None 이고 이름을 남긴다.
        """
        return {"tool": None, "user": None, "missing": ["tool", "user"]}

    # ── 안전 설정 — 주인은 브리지다 (D53 · SAFETY-RULES §설정이 전제다) ────
    def apply_settings(self, settings: dict) -> None:
        """프로필의 settings 를 로봇에 넣는다. arm 시퀀스에서 서보 ON 직후에 부른다.

        컨트롤러 충돌 감지는 기본으로 켜져 있지 않고, 말단 하중이 없으면 드래그·충돌감지가
        오작동한다 (공식 매뉴얼). 그래서 **매번** 넣는다 — 펜던트에서 누가 바꿔도 되돌린다.
        실패는 예외로 던진다. 조용히 넘어가면 게이트가 있는 척만 하게 된다.
        """
        raise NotImplementedError

    def read_settings(self) -> dict:
        """되읽을 수 있는 설정만 돌려준다. **못 읽는 값은 None** (base 규칙 그대로).

        SDK 에 SetAnticollision·SetCollisionStrategy·SetRobotInstallPos·SetPowerLimit 의
        Get 이 없다 (STACK §로봇 안전 설정 API). 그것들은 여기서 None 이고, 브리지가
        appliedSettings.unverifiable 로 정직하게 노출한다.
        """
        raise NotImplementedError

    # ── 명령 계열 — ARMED 승격 뒤에만 브리지가 부른다 ──────────────────────
    def reset_errors(self) -> None:
        """잠복 fault 해제 (ResetAllError). arm 시퀀스 맨 앞에서만 부른다."""
        raise NotImplementedError

    def enable(self, on: bool) -> None:
        """서보 on/off."""
        raise NotImplementedError

    def forward_kin(self, joints_deg):
        """관절 목표 → 손끝 위치 `[x,y,z,rx,ry,rz]`. 못 구하면 `None` (호출자가 fail-closed).
        **직접 계산하지 않는다** — 로봇 자신의 기구학을 쓴다. 툴·사용자 좌표계가
        자동으로 맞아떨어지고, 우리가 DH 파라미터를 다시 적을 이유가 없다 (조건 12)."""
        return None

    def inverse_kin(self, tcp_mm_deg, ref_joints_deg=None):
        """손끝 자리 → 관절각 `[j1..j6]`. 못 구하면 `None` (API-CONTRACT §POST /ik).

        **`forward_kin` 과 같은 이유로 직접 계산하지 않는다** — 로봇 자신의 기구학을 쓴다.
        `ref_joints_deg` 는 **여러 해 중 어느 것을 고를지**의 기준이다. 같은 손끝 자리를
        여러 관절 조합이 만들 수 있어서, 참조가 없으면 팔이 통째로 뒤집힌 해가 나온다 —
        그 해도 손끝은 맞지만 **가는 길이 전혀 다른 곳을 지난다.**

        ⚠ **여기는 판정하지 않는다.** 해가 있다는 것과 가도 된다는 것은 다르고,
        게이트는 브리지가 강제한다 (이 파일 머리말 · SAFETY-RULES 제2원칙).
        """
        return None

    def set_mode(self, mode: int) -> None:
        """0=auto 1=manual."""
        raise NotImplementedError

    def set_speed(self, pct: int) -> None:
        """전역 속도 오버라이드(1~100). **되읽기가 없다** — 보낸 값만 알 수 있다.
        `0` 이면 로봇이 외부 이동을 전부 거부한다(`code=172`) — 계약이 하한 1 을 강제한다."""
        raise NotImplementedError

    def exit_drag_teach(self) -> None:
        raise NotImplementedError

    def set_sample_period(self, ms: int) -> None:
        raise NotImplementedError

    def move_j(self, joints_deg, speed_pct: float, tool: int, user: int) -> None:
        """작은 delta 의 MoveJ. 상한 검사는 브리지가 이미 끝냈다."""
        raise NotImplementedError

    def stop(self) -> None:
        """항상 성공해야 한다. 예외를 던지면 브리지가 fail-closed 로 기록한다."""
        raise NotImplementedError

    # ── 그리퍼 — 관절이 아니다. 전용 게이트를 탄다 (API-CONTRACT §그리퍼) ────
    def gripper_activate(self) -> None:
        """ActGripper(index, 1). **손가락이 실제로 움직인다** — 원점을 잡는 물리 동작이다.
        그래서 ARM 시퀀스에 넣지 않고 사람이 화면에서 따로 부른다 (D65)."""
        raise NotImplementedError

    def gripper_move(self, pct: float, vel_pct: float, force_pct: float) -> None:
        """MoveGripper — pct 는 **지령 기준** 0~100. 읽기값과 방향이 반대라
        변환은 여기 경계 안에서만 한다 (하드 룰 5). 상한 검사는 브리지가 이미 끝냈다."""
        raise NotImplementedError

    def gripper_settle_s(self, vel_pct: float) -> float:
        """`gripper_move` 뒤 손가락이 다 움직일 때까지 기다릴 시간(초).

        **시간이 하드웨어 지식이라 어댑터가 낸다** — 브리지가 상수로 들면 mock 도 실기
        시간을 자게 되고, 반대로 실기 상한(`gripper_maxtime_ms`)과 갈라진다.
        `PROGRAM-CONTRACT.md` §grip 칸 「서버가 완료까지 기다린다」의 구현 자리다.
        """
        raise NotImplementedError
