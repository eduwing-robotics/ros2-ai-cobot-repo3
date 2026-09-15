# 프로그램 슬롯 — 지점을 순서로 엮어 승인한 것만 실행한다 (PROGRAM-CONTRACT.md 가 정본).
#
# **이 모듈은 로봇을 모른다.** 저장과 판정만 하고, 실제 이동은 라우트가 `goto` 와 **같은 함수**로
# 보낸다 — 실기 cmd 허용목록에 새 이름을 더하지 않는다 (계약 §이 계약이 지키는 것).
# teach.py 와 같은 모양이다 — 도메인은 클래스, 라우트는 얇게 (D54). main 을 모른다.
#
# **슬롯은 좌표를 안 든다** (D78) — `pointName` 만 참조한다. 관절값을 굳혀 넣으면 지점을 다시
# 가르쳤을 때 슬롯이 옛 자세로 가고, 같은 값이 두 파일에 살아 단위 변환 지점이 둘이 된다.
import json
import time
from pathlib import Path

from teach import safe_name

MAX_STEPS = 50                  # 계약 §POST /slots — 선형 목록의 상한
# `grip` 은 2026-08-10 에 열렸다 (D103 · 계약 §grip 칸). **천장은 `wait` 과 묶음 스킬이다.**
# `grip` 칸은 지점을 참조하지 않는다 — 그래서 지문 대조·삭제 참조에서 빠진다 (아래).
STEP_TYPES = ("move", "grip")
# 승인 당시와 지금이 같아야 하는 것. 그리퍼 장착 전(tool0)에 승인한 것을 장착 후에 실행하면
# TCP 오프셋만큼 어긋나 **파지 실패가 아니라 충돌**이 된다 (계약 §step 2번)
#
# `toolCoordMm` 는 번호가 아니라 **값**이다 (2026-08-11). 번호 셋만 보면 **핑거 교체를 못
# 잡는다** — 핑거를 갈고 펜던트에서 `tool1` 의 Z 만 고치면 번호는 `1` 그대로다. 지점은
# 관절값으로 재생되니(`MoveJ`) 팔 자세도 승인 때와 같아 지문(`points`)도 통과하고, 손끝만
# 그 차이만큼 더 내려간다. 값을 넣어야 **핑거를 갈면 승인이 깨진다**.
IDENTITY_KEYS = ("robotId", "toolId", "userId", "toolCoordMm")
# 승인 당시 각 지점의 자세를 이만큼 반올림해 지문으로 박는다. 승인 뒤 지점을 다시 가르치면
# (재교시) 이 지문이 어긋나 실행이 막힌다 — 아무도 검토 안 한 자세가 나가는 것을 끊는다 (감사 #2)
POINT_FP_DEG = 3


class SlotStore:
    """슬롯 하나가 파일 하나. 이름은 파일 이름이 되므로 `safe_name` 을 지난다 (감사 P0-2)."""

    def __init__(self, data_dir):
        self._dir = Path(data_dir) / "slots"

    def _path(self, name):
        """이름 → 파일 경로. **폴더 밖으로 나가면 None** — 호출처가 검사를 빠뜨려도 막는다."""
        ok, _ = safe_name(name)
        if not ok:
            return None
        path = (self._dir / f"{ok}.json").resolve()
        return path if path.parent == self._dir.resolve() else None

    def list(self):
        out = []
        for f in sorted(self._dir.glob("*.json")) if self._dir.exists() else []:
            try:
                out.append(json.loads(f.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
        return out

    def get(self, name):
        path = self._path(name)
        if path is None:
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

    def _write(self, slot):
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._path(slot["name"])
        if path is None:            # 여기까지 왔으면 호출처가 검사를 빠뜨린 것이다
            raise ValueError(f"슬롯 이름을 파일로 쓸 수 없다 — {slot['name']!r}")
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(slot, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)
        return slot

    def save(self, name, steps, known_points):
        """만들거나 덮어쓴다. **항상 `draft` 로 돌아간다** (계약 §POST /slots).

        승인은 그 순간의 단계 목록에 대한 것이라, 목록이 바뀌면 그 승인은 다른 프로그램의
        승인이다. 리비전이 없는 지금은 이게 그 자리를 대신한다.
        """
        name, reasons = safe_name(name)
        if reasons:
            return None, reasons
        if not isinstance(steps, list) or not steps:
            return None, ["단계가 없다 — 빈 프로그램은 승인할 수 없다"]
        if len(steps) > MAX_STEPS:
            return None, [f"단계가 너무 많다 — {len(steps)} (상한 {MAX_STEPS})"]
        clean = []
        for i, s in enumerate(steps, 1):
            if not isinstance(s, dict) or s.get("type") not in STEP_TYPES:
                return None, [f"{i}번째 단계의 type 이 {STEP_TYPES} 가 아니다 — {s!r}"]
            if s["type"] == "grip":
                pct, reasons = grip_pct(s.get("pct"))
                if reasons:
                    return None, [f"{i}번째 단계 — {r}" for r in reasons]
                clean.append({"type": "grip", "pct": pct})
                continue
            pn = s.get("pointName")
            # **없는 지점을 가리키면 저장 자체를 거부한다** — 실행 시점에야 드러나면
            # 사람이 로봇 앞에 선 다음에 알게 된다 (계약 §POST /slots)
            if pn not in known_points:
                return None, [f"{i}번째 단계가 없는 지점을 가리킨다 — {pn!r}"]
            clean.append({"type": "move", "pointName": pn})
        return self._write({
            "name": name, "steps": clean, "status": "draft",
            "approvedAt": None, "approvedBy": None, "approvedWith": None,
            "updatedAt": time.time(),
        }), []

    def delete(self, name):
        path = self._path(name)
        if path is None or not path.exists():
            return False
        path.unlink()
        return True

    def approve(self, name, who, identity, points):
        """조종권 + 현장확인을 지난 뒤 불린다. **로봇을 움직이지 않는다.**

        승인 시점의 정체 **와 각 지점의 자세**를 박아 둔다 — 실행 직전에 이걸 지금과 대조한다.
        정체만 고정하고 자세를 안 보면, 승인 뒤 지점을 다시 가르쳤을 때 옛 승인이 바뀐
        실기에 그대로 나간다 (골 Outcome 4 · 감사 #2). `points` 는 {지점이름: jointsDeg}.
        """
        slot = self.get(name)
        if slot is None:
            return None, [f"없는 슬롯 — {name}"]
        fps = {}
        for st in slot.get("steps") or []:
            # `grip` 칸은 지점을 안 가리킨다 — 지문이 없어야 정상이다 (계약 §grip 칸 지문 대조)
            if st.get("type") != "move":
                continue
            pn = st.get("pointName")
            fp = _point_fp((points or {}).get(pn))
            if fp is None:                  # 자세를 못 읽으면 승인하지 않는다 (제1원칙: 결측=차단)
                return None, [f"지점 자세를 못 읽어 승인할 수 없다 — {pn!r}"]
            fps[pn] = fp
        slot["status"] = "approved"
        slot["approvedAt"] = time.time()
        slot["approvedBy"] = who
        slot["approvedWith"] = {k: identity.get(k) for k in IDENTITY_KEYS}
        slot["approvedWith"]["firmware"] = identity.get("firmware")
        slot["approvedWith"]["points"] = fps
        return self._write(slot), []

    def step_plan(self, name, index, identity, points):
        """`index` 단계를 그대로 돌려준다. 반환: `(step, 사유목록)`.

        **로봇에 아무것도 안 보낸다** — 라우트가 `type` 을 보고 `goto`(move) 또는
        `gripper`(grip) 와 **같은 경로로** 보낸다 (계약 §step 4번). 칸 종류가 둘이 된
        2026-08-10 에 `step_target`(지점 이름만 돌려주던 것)에서 이름이 바뀌었다 —
        반환형이 조용히 바뀌는 대신 호출처가 전부 드러나게 했다.

        `points` 는 {지점이름: jointsDeg} — 승인 당시 자세와 지금이 같은지 여기서 본다 (감사 #2).
        """
        slot = self.get(name)
        if slot is None:
            return None, [f"없는 슬롯 — {name}"]
        if slot.get("status") != "approved":
            return None, [f"승인되지 않은 슬롯이다 — status={slot.get('status')}. 먼저 승인한다"]
        reasons = identity_mismatch(slot.get("approvedWith"), identity)
        if reasons:
            return None, reasons
        steps = slot.get("steps") or []
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(steps):
            return None, [f"단계 번호가 범위 밖이다 — {index} (0~{len(steps) - 1})"]
        step = steps[index]
        if step.get("type") == "grip":
            # 지문 대조가 없다 — 가리키는 지점이 없기 때문이다. 값 자체는 저장 때 걸렀지만
            # **파일을 손으로 고친 경우**가 남으므로 여기서 한 번 더 본다 (제1원칙)
            pct, reasons = grip_pct(step.get("pct"))
            if reasons:
                return None, reasons
            return {"type": "grip", "pct": pct}, []
        pn = step["pointName"]
        # 승인 당시 자세와 지금이 다르면 막는다 — 재교시된 지점은 아무도 검토 안 한 자세다
        reasons = point_mismatch(slot.get("approvedWith"), pn, (points or {}).get(pn))
        if reasons:
            return None, reasons
        return {"type": "move", "pointName": pn}, []

    def unapprove(self, name):
        """승인만 푼다 — **단계는 그대로 둔다.** 재교시(같은 이름 재캡처)가 부르는 길이다.

        `step_plan` 의 지문 대조가 이미 실행을 막는다(감사 #2). 그런데 그게 걸리는 시점은
        **사람이 로봇 앞에 선 다음**이다 — 이 계약이 *"없는 지점을 가리키면 저장 자체를
        거부한다"* 로 이미 택한 것과 같은 이유로, 알 수 있는 가장 이른 곳에서 알린다.
        지문 대조는 지우지 않는다. 이건 더 이른 알림이지 대체재가 아니다.

        반환: 실제로 풀었으면 True. 이미 draft 거나 없는 슬롯이면 False.
        """
        slot = self.get(name)
        if slot is None or slot.get("status") != "approved":
            return False
        slot["status"] = "draft"
        slot["approvedAt"] = None
        slot["approvedBy"] = None
        slot["approvedWith"] = None
        slot["updatedAt"] = time.time()
        self._write(slot)
        return True

    def refs_to_point(self, point_name):
        """이 지점을 참조하는 슬롯 이름들. 비어 있으면 지점을 지워도 된다 (계약 §지점 삭제).

        `grip` 칸에는 `pointName` 이 없어 자연히 안 걸린다 — 그래서 그리퍼 칸만 쓰는 슬롯이
        지점 삭제를 막지 않는다 (계약 §grip 칸).
        """
        return [s["name"] for s in self.list()
                if any(st.get("type") == "move" and st.get("pointName") == point_name
                       for st in (s.get("steps") or []))]


def grip_pct(value):
    """`grip` 칸의 `pct` 검증. 반환: `(정수, 사유목록)` — 사유가 있으면 첫 값은 None.

    **0~100 정수만 받는다** (계약 §grip 칸). 소수를 반올림해 주지 않는다 —
    `62.5` 를 63 으로 고쳐 주면 사람이 보낸 값과 승인된 값이 갈리고, 승인은 「어느 폭으로
    쥐는가」에 대한 것이라 그 한 칸이 곧 승인 대상이다. `True` 는 `int` 라서 따로 막는다.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None, [f"grip 칸의 pct 는 0~100 정수여야 한다 — {value!r}"]
    if not 0 <= value <= 100:
        return None, [f"grip 칸의 pct 가 0~100 밖이다 — {value}"]
    return value, []


def identity_mismatch(approved_with, now):
    """승인 당시 정체와 지금이 다른가. 반환: 사유 목록, 비면 같다.

    **기록이 없으면 통과가 아니라 차단이다** (제1원칙) — 승인 경로를 안 지난 슬롯이다.
    """
    if not isinstance(approved_with, dict):
        return ["승인 당시 정체 기록이 없다 — 다시 승인한다 (제1원칙: 결측=차단)"]
    out = []
    for k in IDENTITY_KEYS:
        want, got = approved_with.get(k), (now or {}).get(k)
        if want != got:
            out.append(f"승인 당시와 다르다 — {k} 승인 {want!r} · 지금 {got!r}")
    return out


def _point_fp(joints_deg):
    """지점 자세의 지문 — 반올림한 6축 리스트. 못 읽으면 None (제1원칙: 결측=차단)."""
    if not isinstance(joints_deg, (list, tuple)) or len(joints_deg) != 6:
        return None
    try:
        return [round(float(v), POINT_FP_DEG) for v in joints_deg]
    except (TypeError, ValueError):
        return None


def point_mismatch(approved_with, point_name, now_joints):
    """지점이 승인 후 바뀌었나. 반환: 사유 목록, 비면 같다 (감사 #2 · 골 Outcome 4).

    **지문이 없으면 통과가 아니라 차단이다** (제1원칙) — 자세를 안 박고 승인된 옛 슬롯이다.
    """
    fps = (approved_with or {}).get("points") if isinstance(approved_with, dict) else None
    if not isinstance(fps, dict) or point_name not in fps:
        return ["승인 당시 지점 자세 기록이 없다 — 다시 승인한다 (제1원칙: 결측=차단)"]
    now_fp = _point_fp(now_joints)
    if now_fp is None:
        return [f"지점 자세를 못 읽었다 — {point_name!r} (제1원칙: 결측=차단)"]
    if now_fp != fps[point_name]:
        return [f"지점이 승인 후 바뀌었다 — {point_name!r}. 다시 승인한다 (감사 #2)"]
    return []
