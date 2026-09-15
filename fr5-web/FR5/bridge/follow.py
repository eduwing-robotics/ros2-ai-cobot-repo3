"""추종 — 안전 높이를 유지하며 **따라만 간다** (계약 `VISION-CONTRACT.md` §추종 · D132).

여기는 **계산만** 한다. 로봇을 움직이지 않고, 검출도 하지 않고, 게이트도 안 본다 —
목표 자세를 만들고 「따라갈 만한 움직임인가」를 판정하는 것이 전부다. 실행은 `commands.motion`
이 하고 그때 게이트를 처음부터 다시 탄다 (비전 전용 실행 경로를 만들지 않는다).

## ⛔ 기본값이 없다

상수를 여기 두지 않는다. `config.yaml` 의 `follow:` 가 정본이고 없으면 **추종이 아예 안 돈다.**
기본값을 코드에 두면 설정을 안 고쳤는데 돌아 버려서 「지금 무슨 값으로 도는가」를 아무도
못 말한다. 그리고 현장이 바뀌면 값이 바뀌는데, 코드에 박힌 값은 아무도 못 찾는다.

## `faceAxis` 가 「눕힘 ↔ 세움」 전환의 전부다

지금은 눕힌 물체를 **위에서** 보지만 세워 꽂으면 **옆에서** 봐야 한다 (D122 — 위에서는
지름이 5.8화소라 못 본다). 그래서 기준을 **「표면에서 얼마 · 그 표면을 정면으로」** 로 잡고,
어느 면인지는 값 하나로 고른다. 「위」를 코드에 박으면 그날 통째로 다시 짠다.
"""

from safety import _rot_fixed_xyz            # 회전 규약의 정본 (D113 · 잔차 0.0048°)

REQUIRED = ("standoffMm", "faceAxis", "deadbandMm", "releaseMm", "maxTiltDeg", "speedPct",
            "autoOffAfterS", "targetTagId", "targetSource")

# 자리를 어느 창구에서 읽나 (계약 §무엇을 따라가나). **취향이 아니라 「바퀴가 있나」다** —
# `amr` 만 태그를 놓쳤을 때 odom 으로 이어 붙이는 둘째 출처를 갖는다. 거치대엔 바퀴가 없다.
SOURCES = ("amr", "anchor", "color", "wrist")
# ⭐ `wrist` 는 **글로벌캠을 안 쓴다** (2026-09-04 · D177 · 계약 §`wrist`). 앞의 셋은 전부
# 폰 산출물이라 폰이 꺼지면 표적이 통째로 언다 — 그날 71분을 그렇게 잃었다. 손목캠은
# 337mm 에서 라이다 윗면 **평면**을 직접 재므로 태그도 폰도 필요 없다. ⛔ 대신 **보고
# 있을 때만** 안다 — 눈이 팔에 달려 화각 밖은 못 찾는다(2단이지 1단이 아니다).
# ⭐ `color` 는 **태그를 안 쓴다** (2026-09-04). 실기 담당자 *"애초에 글로벌캠에 잡히는데"* —
# 영상에 물건이 보이는데 코드가 태그만 찾아서 「보이는데 못 본다」였다. 이제 색으로 직접
# 찾으므로 **물건을 옮기면 표적이 따라온다** (태그를 붙일 필요가 없다).

# 어느 태그가 터틀봇인가. 제원(84.0mm 실측)은 `Shared/assets/tag/tags.json` §fixtureTags 가
# 든다 — 여기는 **번호만** 안다. ⚠ 쌍둥이가 `scripts/map/amr-pose.py` 에 하나 더 있다
# (그쪽은 산출기라 브리지 코드를 임포트할 수 없다). 태그를 갈면 **두 곳을 같이** 고친다.
#
# ⛔ **이건 「터틀봇의 번호」지 「추종 표적의 번호」가 아니다** (2026-09-04 에 갈랐다).
# 추종이 무엇을 따라가나는 `follow.targetTagId` 가 정한다 — 여기를 표적으로 쓰면 거치대를
# 따라가려고 터틀봇 번호를 고치게 되고, 그 순간 `amr` 눈금 맞추기가 엉뚱한 태그를 문다.
AMR_TAG_ID = 18
AXES = {"x": 0, "y": 1, "z": 2}


class Switch:
    """자동이 **켜져 있나** — 계약 §추종 조건 1·8.

    ⛔ **기본은 꺼짐이고, 켠 사람과 켠 시각을 같이 붙든다.** 누가 켰는지 모르면 화면이
    「누가 켰는지 모르는 자동」을 표시하게 되고, 그건 조건 7(크게 말한다)을 절반만 지키는 것이다.

    ⛔ **시각을 밖에서 받는다.** 여기서 `time.time()` 을 부르면 시험이 진짜 시계를 기다려야
    하고, 그러면 「5분 뒤 꺼지나」를 아무도 시험하지 않게 된다.
    """

    def __init__(self):
        self.on_at = None
        self.who = None
        self.last_sent = None          # 마지막으로 **보낸** 목표 (데드밴드 기준)
        self.off_reason = None         # 왜 꺼졌나 — 사람이 켠 것과 스스로 꺼진 것을 가른다

    def on(self, who, now):
        self.on_at, self.who, self.off_reason = float(now), who, None
        self.last_sent = None          # 켤 때마다 처음부터 — 옛 목표를 물려받지 않는다
        return True

    def off(self, reason):
        self.on_at, self.who, self.last_sent = None, None, None
        self.off_reason = reason

    def alive(self, now, cfg):
        """지금 돌아도 되나. 반환 `(산다, 사유)`. **만료면 여기서 스스로 끈다.**"""
        if self.on_at is None:
            return False, self.off_reason
        age = float(now) - self.on_at
        limit = float(cfg["autoOffAfterS"])
        if age >= limit:
            self.off(f"{limit:.0f}초가 지나 스스로 껐다 — 켠 사람 {self.who or '무명'}")
            return False, self.off_reason
        return True, None

    def snapshot(self, now, cfg):
        """화면이 **크게 말할** 재료 (조건 7). 꺼져 있어도 마지막 사유를 남긴다."""
        if self.on_at is None:
            return {"on": False, "reason": self.off_reason}
        left = float(cfg["autoOffAfterS"]) - (float(now) - self.on_at)
        return {"on": True, "who": self.who, "secondsLeft": round(max(0.0, left), 1)}


def cam_to_robot(cam_mm, tcp_mm_deg, t_mm):
    """카메라가 본 자리 → **로봇 좌표**. 반환 `(P, 사유)`.

        P = R·(C + t) + p

    **회전 행렬을 여기서 다시 만들지 않는다** — `safety._rot_fixed_xyz` 가 규약의 정본이고,
    같은 계산이 두 곳에 살면 언젠가 한쪽만 고쳐진다 (하드 룰 5의 정신).

    `t_mm` 은 프로필의 `handEye.tMm` 이다. **여기 기본값을 두지 않는다** — 캘리브가 안 된
    셀에서 남의 값으로 조용히 도는 것이 제일 나쁘다.
    """
    if not cam_mm or len(cam_mm) < 3:
        return None, "카메라 좌표가 없다 — 결측=차단"
    if not tcp_mm_deg or len(tcp_mm_deg) < 6:
        return None, "지금 손끝 자세를 못 읽었다 — 결측=차단"
    if not t_mm or len(t_mm) < 3:
        return None, "hand-eye 가 프로필에 없다 — 카메라 좌표를 로봇 좌표로 옮길 수 없다"
    R = _rot_fixed_xyz(*[float(v) for v in tcp_mm_deg[3:6]])
    c = [float(cam_mm[i]) + float(t_mm[i]) for i in range(3)]
    return [sum(R[r][k] * c[k] for k in range(3)) + float(tcp_mm_deg[r]) for r in range(3)], None


def read_config(profile):
    """프로필의 `follow:` 를 읽어 검증한다. 반환 `(cfg, 사유)` — cfg 가 None 이면 안 돈다.

    **없는 것과 틀린 것을 가른다** — 없으면 「기능이 꺼진 것」이고 틀리면 「고쳐야 하는 것」이다.
    둘을 같은 말로 보고하면 사람이 오타를 「아직 안 켰나 보다」로 읽는다.
    """
    if not isinstance(profile, dict):
        return None, "프로필이 없다"
    cfg = profile.get("follow")
    if cfg is None:
        return None, None                       # 안 켠 것 — 사유가 아니다
    if not isinstance(cfg, dict):
        return None, "follow 가 블록이 아니다"
    missing = [k for k in REQUIRED if cfg.get(k) is None]
    if missing:
        return None, f"follow 에 빠진 값 — {', '.join(missing)}"
    if cfg["targetSource"] not in SOURCES:
        return None, (f"targetSource 는 {' · '.join(SOURCES)} 중 하나다 — "
                      f"받은 값 {cfg['targetSource']!r}")
    if not isinstance(cfg["targetTagId"], int):
        return None, f"targetTagId 는 정수 태그 번호다 — 받은 값 {cfg['targetTagId']!r}"
    if cfg["faceAxis"] not in AXES:
        return None, f"faceAxis 는 x·y·z 중 하나다 — 받은 값 {cfg['faceAxis']!r}"
    if not cfg["standoffMm"] > 0:
        return None, f"standoffMm 은 양수다 — {cfg['standoffMm']}"
    # **나갈 문턱이 들어올 문턱보다 커야** 경계에서 안 깜빡인다. 같거나 작으면 설정이 스스로
    # 진동을 만든다 — 그건 값의 문제가 아니라 **모양의 문제**라 여기서 막는다
    if not cfg["releaseMm"] > cfg["deadbandMm"]:
        return None, (f"releaseMm({cfg['releaseMm']}) 은 deadbandMm({cfg['deadbandMm']}) 보다 "
                      "커야 한다 — 같으면 경계에서 깜빡인다")
    return cfg, None


def tilt_deg(tcp_mm_deg):
    """손끝이 **수직 하향에서 얼마나 기울었나** (도). 못 구하면 None.

    `rx` 가 180°(뒤집힌 수직) 근처가 우리 무대의 기본 자세다 — 실측 자세들이 172~176° 였다.
    거기서 벗어난 각을 낸다. `ry` 는 그대로 기울기이므로 둘을 합쳐 본다.
    """
    if not tcp_mm_deg or len(tcp_mm_deg) < 6:
        return None
    rx, ry = float(tcp_mm_deg[3]), float(tcp_mm_deg[4])
    from_vertical = abs(abs(rx) - 180.0)        # 180 에서 얼마나 떨어졌나
    return (from_vertical ** 2 + ry ** 2) ** 0.5


def target_pose(object_mm, tcp_now, cfg):
    """물체 자리 → **목표 손끝 자리**. 반환 `(pose, 사유)`.

    **자세(rx·ry·rz)는 지금 것을 그대로 쓴다.** 사람이 맞춰 둔 방향을 우리가 다시 만들지
    않는다 — 추종은 「따라가는 것」이지 「자세를 정하는 것」이 아니다. 자세를 바꾸려면
    사람이 조그로 바꾸고, 그러면 다음 목표부터 그 자세로 따라간다.

    **어느 쪽에서 다가가나는 지금 서 있는 쪽으로 정한다.** 물체 반대편으로 돌아가면 그
    경로가 작업대를 가로지른다 — 가까운 쪽에 서는 것이 언제나 짧고 안전하다.
    """
    if not object_mm or len(object_mm) < 3:
        return None, "물체 자리가 없다 — 결측=차단"
    if not tcp_now or len(tcp_now) < 6:
        return None, "지금 손끝 자세를 못 읽었다 — 결측=차단"
    t = tilt_deg(tcp_now)
    if t is None or t > float(cfg["maxTiltDeg"]):
        return None, (f"손끝이 수직에서 {t:.1f}° 기울어 있다 — 상한 {cfg['maxTiltDeg']}° "
                      "(넘으면 화면에 평면이 둘 되어 검출이 무너진다)")
    i = AXES[cfg["faceAxis"]]
    # 지금 서 있는 쪽 부호. 같은 자리면 `+` — 물체 안에서 시작하는 일은 없다
    sign = 1.0 if float(tcp_now[i]) >= float(object_mm[i]) else -1.0
    pose = [float(v) for v in object_mm[:3]] + [float(v) for v in tcp_now[3:6]]
    pose[i] += sign * float(cfg["standoffMm"])
    return pose, None


def should_move(target, last_sent, cfg):
    """따라갈 만한 움직임인가. 반환 `(간다, 거리mm, 등급)`.

    **판정선은 `releaseMm` 하나다.** `deadbandMm` 는 판정을 바꾸지 않고 **왜 안 갔는지를
    가른다** — `잡음`(확실히 측정 흔들림)과 `보류`(움직이긴 했는데 아직 모자람). 그 구분이
    필요한 이유는 로그 때문이다: 계속 `보류` 만 찍히면 **문턱이 현장에 비해 크다**는 뜻이고,
    계속 `잡음` 이면 값이 안정돼 있다는 뜻이다. 한 단어로 뭉뚱그리면 그 신호를 잃는다.

    문턱이 하나면 경계에서 깜빡인다 — 그래서 **가는 선(`releaseMm`)을 잡음 선보다 위에** 둔다
    (`SHARED-CORE.md` §판정 규칙 · AMR 구역에서 같은 문제를 이미 풀었다).
    """
    if target is None:
        return False, None, "표적없음"
    if last_sent is None:
        return True, None, "첫목표"             # 첫 목표는 무조건 간다
    d = sum((float(a) - float(b)) ** 2 for a, b in zip(target[:3], last_sent[:3])) ** 0.5
    if d > float(cfg["releaseMm"]):
        return True, d, "이동"
    return False, d, "잡음" if d < float(cfg["deadbandMm"]) else "보류"
