"""터틀봇 자리 상주 — **바퀴가 잇고 태그가 고친다** (계약 `API-CONTRACT.md` §터틀봇 자리는
두 출처로 온다 · `FRAMES.md` §`odom → lab` 은 재지 않고 맞춘다 · 2026-08-31 · D158).

## 왜 만들었나 (실측이 시켰다)

글로벌캠 태그 하나로만 터틀봇을 보고 있었는데, **서 있는 로봇인데도 45초에 2회(7%)** 밖에
안 잡혔다. 태그가 84mm 인데 라이다 위라 멀고 비스듬해 화소가 모자란다. 정합을 24.7px →
0.46px 로 고친 뒤에도 **3% → 7%** 로 거의 그대로였다 — 정합이 원인이 아니었다.

그런데 터틀봇은 **자기 위치를 100% 말하고 있었다**(`poseAgeSec 0.0`). 두 출처의 약점이
정확히 서로를 메운다:

    바퀴  끊기지 않는다 · 요각도 준다      그러나 시간이 갈수록 밀린다
    태그  절대 위치라 안 밀린다            그러나 거의 안 보인다

**바퀴로 잇고, 태그가 보일 때마다 눈금을 고친다.** 그러면 태그가 7% 여도 된다 — 태그의
일이 실시간 추적이 아니라 **눈금 교정**이 되기 때문이다.

## 여기가 하는 일 셋

1. **읽는다** — `ws://<tb>/ws/state` 를 받기만 한다. ⛔ **명령은 안 보낸다**(하드 룰 4 —
   조종권은 터틀봇 화면이 가진다). 받기만 하므로 마스킹도 hello 도 필요 없다
2. **쌍을 쌓는다** — 태그가 보인 순간의 `(odom, lab)` 두 자리를 같이 적는다
3. **푼다** — 그 쌍들로 평면 강체변환(3-DOF)을 맞춰 `amr-frame.json` 에 남긴다

⛔ **환산 자체는 여기서 안 한다.** 적용은 `fixture.odom_to_lab` 한 곳이다(하드 룰 5).
여기는 **계수를 구할 뿐**이고, `lab → user1` 은 기존 사슬을 그대로 탄다.

⚠ **안전 경로가 아니다** — `anchors.py` 와 같다. 여기 값으로 실기를 움직이려면 계약
§조건 5 의 출처가 둘이 됐다가 요구하는 `correctedAgoS` 상한을 읽는 쪽이 건다.
"""
import json
import math
import os
import threading
import time
from pathlib import Path

# 쌍을 이만큼은 모아야 푼다. 3 이면 수학적으로는 풀리지만 한 점만 튀어도 통째로 돈다
MIN_PAIRS = 6
# 잔차가 이보다 크면 **안 쓴다.** 태그 흩어짐(errPx 0.5 급 ≈ 수 mm)의 몇 배 — 이보다
# 나쁘면 맞춘 게 아니라 우연히 겹친 것이다
MAX_FIT_RMS_MM = 40.0
# 쌍을 이만큼 이상 떨어뜨려 모은다. 같은 자리에서 여러 번 찍으면 **회전이 안 풀린다**
# (같은 점만 쌓인다). 로봇이 움직여야 fit 이 좋아지는 이유가 이것이다
MIN_PAIR_SPACING_MM = 80.0
# 들고 있을 쌍의 최대 개수 — 오래된 것부터 버린다(코스가 바뀌면 옛 쌍이 방해가 된다)
MAX_PAIRS = 40
# 태그와 바퀴가 이보다 멀리 떨어진 시각의 값이면 **한 쌍으로 안 친다**
PAIR_MAX_SKEW_S = 0.6

_state = {"pose": None, "t": None, "note": None, "robotId": None,
          "host": None, "velocity": None}   # velocity — 조건 27 (2026-09-07)
_pairs = []
_fit = None
_lock = threading.Lock()


def note():
    """왜 안 도는지 한 줄. `None` 이면 도는 중이거나 **안 켠 것**이다."""
    return _state.get("note")


def pose():
    """터틀봇이 스스로 아는 자리. `None` 이면 아직 못 받았다.

    ⛔ **나이 판정은 여기서 안 한다** — 읽는 쪽이 자기 상한으로 자른다(`anchors` 와 같은
    태도다. 같은 값이라도 그리는 쪽과 움직이는 쪽의 상한이 다르다).
    """
    with _lock:
        p, t = _state.get("pose"), _state.get("t")
    if not p or t is None:
        return None
    return {"xMm": p["xMm"], "yMm": p["yMm"], "yawDeg": p["yawDeg"],
            "ageS": round(time.time() - t, 2), "robotId": _state.get("robotId")}


# 조건 27 — 이보다 낡은 상태는 「움직이는지 모른다」다 (계약 §상호 배제 · SAFETY-RULES §조건 27)
MOTION_FRESH_S = 2.0
# **데드밴드** (2026-09-07 실기) — 주차된 터틀봇의 odom(바퀴 엔코더)은 정확히 0 이 아니라 잡음으로 ~0.5mm/s·0.3°/s 를 낸다.
# 「0 보다 크면 움직임」으로 보면 세워 둔 로봇이 영영 「움직이는 중」이라 팔이 못 나간다. 실제 주행은 teleop 하한도 수십 mm/s·°/s 라
# (TB-CONTRACT §teleop 상한 150mm/s·60°/s) 이 문턱은 잡음 위·명령 아래에 넉넉히 있다. 넘으면 「움직인다」.
MOVE_DEADBAND_MM_S = 5.0
MOVE_DEADBAND_DEG_S = 3.0


def motion_status(fresh_s=MOTION_FRESH_S):
    """터틀봇이 **지금 움직이나** — 조건 27 의 판정 재료. 판정은 `safety` 가 한다, 여기는 사실만.

    `enabled` False = 주소를 안 줬다(기능을 안 켠 것 · 안 막는다). `moving` None = 모른다(막는다).
    """
    with _lock:
        host, v, t, note = _state.get("host"), _state.get("velocity"), _state.get("t"), _state.get("note")
    if not host:
        return {"enabled": False, "host": None, "velocity": None, "ageSec": None, "moving": None, "note": None}
    age = round(time.time() - t, 2) if t is not None else None
    if note or v is None or age is None or age > fresh_s:
        moving = None
    else:
        moving = bool(abs(v["linearMmS"]) > MOVE_DEADBAND_MM_S or abs(v["angularDegS"]) > MOVE_DEADBAND_DEG_S)
    return {"enabled": True, "host": host, "velocity": v, "ageSec": age, "moving": moving, "note": note}


def fit():
    """`odom → lab` 계수. `None` 이면 아직 못 맞췄다 — 그러면 **쓰지 않는다**."""
    with _lock:
        return dict(_fit) if _fit else None


def pair_count():
    with _lock:
        return len(_pairs)


# ── 맞추기 — 평면 강체변환 3-DOF (회전 1 + 이동 2) ──────────────────────────
def solve(pairs):
    """`(odom, lab)` 쌍들로 회전·이동을 푼다. 크기(scale)는 **안 푼다** — 둘 다 mm 다.

    닫힌 해다(Kabsch 의 2D 판): 두 무게중심을 맞추고, 남은 각도를 arctan2 로 한 번에 낸다.
    반복도 초기값도 없으므로 **실패할 자리가 없다** — 못 쓰는 해는 잔차로 거른다.
    """
    n = len(pairs)
    if n < MIN_PAIRS:
        return None, f"쌍이 {n}개 — {MIN_PAIRS}개는 있어야 푼다"
    ox = sum(p["odom"][0] for p in pairs) / n
    oy = sum(p["odom"][1] for p in pairs) / n
    lx = sum(p["lab"][0] for p in pairs) / n
    ly = sum(p["lab"][1] for p in pairs) / n
    num = den = 0.0
    for p in pairs:
        ax, ay = p["odom"][0] - ox, p["odom"][1] - oy
        bx, by = p["lab"][0] - lx, p["lab"][1] - ly
        num += ax * by - ay * bx        # 외적 합 → sin
        den += ax * bx + ay * by        # 내적 합 → cos
    if abs(num) < 1e-9 and abs(den) < 1e-9:
        return None, "쌍이 전부 한 점에 몰렸다 — 로봇을 움직여야 회전이 풀린다"
    th = math.atan2(num, den)
    c, s = math.cos(th), math.sin(th)
    tx = lx - (c * ox - s * oy)
    ty = ly - (s * ox + c * oy)
    sq = 0.0
    for p in pairs:
        px = c * p["odom"][0] - s * p["odom"][1] + tx
        py = s * p["odom"][0] + c * p["odom"][1] + ty
        sq += (px - p["lab"][0]) ** 2 + (py - p["lab"][1]) ** 2
    rms = math.sqrt(sq / n)
    if rms > MAX_FIT_RMS_MM:
        return None, f"잔차 {rms:.1f}mm > {MAX_FIT_RMS_MM} — 맞춘 게 아니다"
    return {"yawDeg": round(math.degrees(th), 3), "txMm": round(tx, 2), "tyMm": round(ty, 2),
            "n": n, "rmsMm": round(rms, 2), "fittedAt": round(time.time(), 1)}, None


def observe(odom_xy, lab_xy, odom_t, lab_t, out_path=None):
    """태그가 보인 순간의 두 자리를 **한 쌍으로** 받는다. 채택하면 `True`.

    부르는 쪽(`main.follow_target`)이 「태그가 신선하다」를 이미 판정한 뒤에 부른다 —
    여기서 다시 판정하면 상한이 두 곳이 되고, 그러면 언젠가 갈라진다.
    """
    if abs(float(odom_t) - float(lab_t)) > PAIR_MAX_SKEW_S:
        return False                     # 같은 순간이 아니면 한 쌍이 아니다
    with _lock:
        for p in _pairs:                 # 같은 자리는 안 쌓는다 — 회전이 안 풀린다
            if math.dist(p["odom"], odom_xy) < MIN_PAIR_SPACING_MM:
                return False
        _pairs.append({"odom": [float(odom_xy[0]), float(odom_xy[1])],
                       "lab": [float(lab_xy[0]), float(lab_xy[1])], "t": round(float(lab_t), 1)})
        del _pairs[:-MAX_PAIRS]
        pairs = list(_pairs)
    got, why = solve(pairs)
    with _lock:
        globals()["_fit"] = got if got else _fit
    if got and out_path:
        _write(out_path, got, pairs)
    return True


def _write(out_path, got, pairs):
    """원자적으로 남긴다 — 반쪽 파일을 읽히지 않는다(`marker_follow` 와 같은 규약)."""
    doc = {
        "_": "FR5/bridge/amr.py 산출물 — 직접 고치지 마라",
        "_무엇": "odom → lab 평면 강체변환. p_lab = R(yawDeg)·p_odom + (txMm, tyMm)",
        "_어떻게": "터틀봇 태그가 보인 순간의 (odom, lab) 쌍을 모아 푼다 (Kabsch 2D)",
        "_주의": "쌍이 한 자리에 몰리면 회전이 안 풀린다 — 로봇이 움직여야 좋아진다",
        "fit": got, "pairs": pairs,
    }
    path = Path(out_path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)
    except Exception:                    # noqa: BLE001 — 못 써도 상주는 계속 돈다
        pass


def load(out_path):
    """전에 맞춘 눈금을 받아 든다 — **브리지가 죽어도 눈금이 안 사라진다**."""
    global _fit
    try:
        doc = json.loads(Path(out_path).read_text(encoding="utf-8"))
    except Exception:                    # noqa: BLE001 — 없는 것은 고장이 아니다
        return
    got = doc.get("fit")
    if not got:
        return
    with _lock:
        _fit = got
        _pairs.clear()
        _pairs.extend(doc.get("pairs") or [])


# ── 상주 — 터틀봇 웹소켓을 **받기만** 한다 ─────────────────────────────────
def start_reader(tb_host, robot_id, out_path=None, period_s=1.0):
    """터틀봇 상태를 브리지 프로세스 **안에서** 계속 받는다.

    ⛔ **사이드카로 세우지 않는다** — 윈도우 sshd 가 세션 종료 때 자식을 거둬간다(D131).
    ⛔ **브리지를 죽이지 않는다** — daemon 스레드 · 루프가 예외를 통째로 먹는다 ·
       `websockets` 는 **함수 안에서 늦게 임포트**한다(없는 기계에서 통째로 안 뜨는 것을 막는다).
    **주소를 안 주면 안 돈다** = 기능을 안 켠 것이다. 고장이 아니다.
    """
    _state["host"] = (tb_host or "").strip() or None
    if not tb_host:
        _state["note"] = None
        return
    _state["robotId"] = robot_id
    if out_path:
        load(out_path)

    try:
        import asyncio                                     # noqa: PLC0415 — 늦은 임포트가 의도다
        import websockets                                  # noqa: PLC0415
    except Exception as e:                                 # noqa: BLE001
        _state["note"] = f"터틀봇 상주 꺼짐 — 임포트 실패 ({str(e)[:50]})"
        return

    url = f"ws://{tb_host}/ws/state"

    async def pump():
        while True:
            try:
                async with websockets.connect(url, open_timeout=5, ping_interval=20) as ws:
                    _state["note"] = None
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:                  # noqa: BLE001
                            continue
                        r = (msg.get("robots") or {}).get(robot_id)
                        if not r or not r.get("connected"):
                            _state["note"] = f"{robot_id} 가 브리지에 안 붙어 있다"
                            continue
                        p = r.get("pose") or {}
                        if p.get("xMm") is None:
                            continue
                        age = r.get("poseAgeSec")
                        # ⚠ **터틀봇이 말하는 나이를 존중한다.** 우리가 받은 시각이 아니라
                        # 그쪽 센서 시각이 정본이다 — 랜이 막히면 우리 시계는 거짓말한다
                        t = float(msg.get("t") or time.time()) - float(age or 0.0)
                        v = r.get("velocity") or {}
                        with _lock:
                            _state["pose"] = {"xMm": float(p["xMm"]), "yMm": float(p["yMm"]),
                                              "yawDeg": float(p.get("thetaDeg") or 0.0)}
                            _state["t"] = t
                            # 조건 27 의 재료 — 터틀봇이 **스스로 말하는** 속도. 없으면 None (모른다)
                            _state["velocity"] = ({"linearMmS": float(v.get("linearMmS") or 0.0),
                                                   "angularDegS": float(v.get("angularDegS") or 0.0)}
                                                  if v else None)
                        _state["note"] = None
            except Exception as e:                         # noqa: BLE001
                _state["note"] = f"터틀봇 {tb_host} 안 붙는다 — {str(e)[:60]}"
                await asyncio.sleep(max(1.0, period_s))

    def run():
        import asyncio                                     # noqa: PLC0415
        asyncio.new_event_loop().run_until_complete(pump())

    threading.Thread(target=run, daemon=True, name="amr-reader").start()


def host_of(config_dir):
    """터틀봇 주소. **새 스위치를 만들지 않는다** — `tb-host.json` 이 이미 정본이다.

    그 파일은 `.env FR5_TB_HOST` → `scripts/build/config.mjs` 가 만들고 배포가 실기로
    보낸다(화면이 `?tb=` 없이 붙게 하는 그 파일이다). 브리지가 두 번째 출처를 만들면
    **화면과 브리지가 서로 다른 터틀봇을 볼 수 있다.**

    환경변수는 **덮어쓰기용으로만** 남긴다 — 파일을 다시 굽지 않고 한 번 시험할 때
    (`FR5_CAM_HOST` 와 같은 관례). 둘 다 없으면 `""` = **안 켠 것**이다.
    """
    # **변수가 있으면 그 값이 답이다 — 빈 문자열이면 「끔」**(2026-09-07 · 조건 27). 파일이 랩 주소를 들고 있는 기계에서
    # 게이트를 돌리면 터틀봇이 없어 팔 명령이 전부 막히는데, 게이트는 로봇 없는 기계에서도 초록이어야 한다. 그래서 끄는 길이 필요하다
    raw = os.environ.get("FR5_TB_HOST")
    if raw is not None:
        return raw.strip()
    try:
        doc = json.loads((Path(config_dir) / "tb-host.json").read_text(encoding="utf-8"))
    except Exception:                    # noqa: BLE001 — 없는 것은 고장이 아니다
        return ""
    return (doc.get("host") or "").strip()
