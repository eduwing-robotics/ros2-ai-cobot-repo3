#!/usr/bin/env python3
"""쌍 모으기 — **손목캠으로 터틀봇을 재서 `odom → user1` 을 푼다** (2026-09-04).

    python3 scripts/robot/amr-pair.py --add     # 지금 이 자리에서 쌍 하나를 잰다
    python3 scripts/robot/amr-pair.py           # 쌓인 쌍을 보고 6개면 푼다
    python3 scripts/robot/amr-pair.py --reset   # 쌓인 쌍을 버린다

## 왜 만드나 — 폰 없이 눈금을 맞춘다

브리지의 눈금 맞추기(`amr.observe`)는 **글로벌캠 태그**가 준 자리와 바퀴 자리를 짝짓는다.
그런데 그 태그는 **45초에 2회(7%)** 밖에 안 잡히고, 폰이 꺼지면 아예 0 이다(2026-09-04 에
71분을 그것으로 잃었다).

⭐ **손목캠은 같은 일을 337mm 에서 한다.** 태그가 아니라 **라이다 윗면 평면**을 직접 재므로
태그가 필요 없다. 2026-09-04 실측에서 z 는 예측과 **7mm**, y 는 **15mm** 안에 들어왔다 —
사슬이 산다는 증거다. 남은 x −140mm 가 바로 이 도구가 풀 값이다.

## 무엇을 짝짓나 — **라이다 윗면**을 두 프레임에서 본다

    odom 쪽   터틀봇이 말하는 자리 + `AMR_TAG.offsetMm` 을 로봇 요각만큼 돌려 더한다
    user1 쪽  손목 뎁스 구름에서 라이다 윗면 평면의 무게중심

같은 물리적 점을 두 프레임으로 적은 것이라, 이 쌍들을 풀면 나오는 3-DOF 강체변환이
**곧 `odom → user1`** 이다 — 즉 `AMR_HOME` 의 `xMm·yMm·yawDeg` 그 자체다.

## ⛔ 「lab」이라고 안 적는다

`amr-frame.json` 은 `odom → lab` 이다. **여기는 `odom → user1` 이라 다른 물건이다.**
같은 파일에 쓰면 「이름은 맞는데 값이 틀린」(D155) 사고가 그대로 재현된다. 그래서
산출을 갈랐고(`amr-pairs.json`), 사람이 읽는 키에 **`lab` 이라는 글자를 안 쓴다.**
푸는 산수만 `amr.solve` 를 그대로 빌린다 — 그건 프레임을 안 가리는 2D Kabsch 다.

## 터틀봇은 사람이, 팔은 `--aim` 이 (2026-09-04 추가)

**터틀봇은 언제나 사람이 몬다** — 조종권이 터틀봇 화면에 있다(하드 룰 4).
**팔은 `--aim` 을 주면 스스로 간다.** 자리마다 손으로 조그하면 6번을 사람이 다 하게 된다.

⛔ **`ARM` 은 그래도 사람이 한다** — 화면에서 `confirm: "현장확인"` 을 거친다(하드 룰 3).
`--aim` 은 **ARMED 를 확인만** 하고, 아니면 사유를 내고 **멈춘다.** 승격은 안 한다.

⛔ **주행과 이동을 동시에 하지 않는다** — `API-CONTRACT` §상호 배제가 금지한 상태다
(⚠ 그 금지는 아직 **구현 0줄**이라 코드가 안 막아 준다). 그래서 `--aim` 은 터틀봇이
**움직이고 있으면 거부한다** — 계약이 못 박은 것을 여기서만이라도 지킨다.

## `--aim` 이 자세를 어떻게 내나 — **광축을 표적에 꽂는다**

자세(회전)는 **지금 것을 그대로 쓴다** — 사람이 맞춰 둔 방향을 우리가 새로 만들지 않는다
(`follow.target_pose` 와 같은 규약). 자리만 푼다:

    카메라 = R·hand-eye + TCP           광축 = R·(0,0,1)
    TCP = 표적 − 거리·광축 − R·hand-eye

⛔ **거리를 250mm 로 둔다.** 추종의 `standoffMm 165` 를 그대로 쓰면 안 된다 — 그건
**거치대 윗면** 기준이라 라이다 윗면과는 170mm 가 되고, D435 의 Min-Z **195mm** 안이라
덩어리가 통째로 잘린다(2026-08-12 에 그 병으로 92.35mm 라는 「우연히 맞은 잘린 값」이 나왔다).
250mm 는 오늘 16,395점을 낸 그 거리다.

## 한계 (ponytail)

**라이다 윗면을 「그 높이의 제일 큰 덩어리」로 고른다.** 같은 높이에 비슷한 크기의 평면이
또 있으면 헷갈린다 — 그래서 지름을 재서 범위 밖이면 **거부한다**(숫자를 안 낸다).
자리마다 사람이 눈으로 한 번 보는 것이 아직 제일 싼 방어다.
"""
import argparse
import json
import math
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))

PAIRS = Path(__file__).with_name("amr-pairs.json")

# 라이다 윗면을 z 로 오려내는 창. **예측 높이 기준 ±이만큼** — 자리를 옮겨도 판이 같아서
# 이 창은 안 변한다. 넉넉히 잡되(15mm) 다른 층이 섞이면 지름 검사가 걸러낸다.
Z_WINDOW_MM = 15.0
# 덩어리 지름의 허용 범위. 버거 윗판이 138mm 각이고 일부만 보이는 일이 흔하다
DIA_MIN_MM, DIA_MAX_MM = 60.0, 200.0
MIN_POINTS = 800
# 값이 늙으면 **지금 자리가 아니다.** 표적·손끝에 같은 규율을 건다
MAX_ODOM_AGE_S = 2.0
MAX_TCP_AGE_S = 2.0


def get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def sjs(module, *names):
    """`Shared/data/*.js` 를 **실행해서** 받는다 (`aim-carrier.py` 와 같은 규약)."""
    src = "import('./Shared/data/%s').then(m=>console.log(JSON.stringify({%s})))" % (
        module, ",".join(f"{n}:m.{n}" for n in names))
    # ⛔ **인코딩을 명시한다** — 윈도우에서 `text=True` 는 시스템 코드페이지(cp949)로
    # 디코드해서 한글이 든 SSOT 를 못 읽는다 (2026-09-04 실기에서 물렸다).
    out = subprocess.run(["node", "-e", src], cwd=ROOT, capture_output=True,
                         text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        raise RuntimeError(f"{module} 를 못 읽었다 — {out.stderr.strip()[:200]}")
    return json.loads(out.stdout)


def measure(fr5, cam, tag, lidar_z_pred, state_fn=None):
    """손목 뎁스 → **라이다 윗면 무게중심(user1)**. 반환 `(점, 사유)`.

    ⛔ **덩어리를 못 믿으면 숫자를 안 낸다** — 지름이 범위 밖이면 다른 평면을 문 것이다.

    ⭐ **`state_fn` 은 브리지 안 상주용이다** (2026-09-04). 상주가 자기 브리지의 `/state` 를
    0.5초마다 HTTP 로 부르면 매번 `read_fresh_state()` 가 돌아 **SDK 를 더 두드린다** —
    그날 추종이 3초 만에 `FAIL_CLOSED` 로 끊겼고 이게 유력한 범인이다. 상주는 세션 객체를
    **직접** 읽어 왕복도 SDK 부하도 0 으로 만든다. CLI 는 `state_fn` 없이 그대로 HTTP 다.
    """
    import follow
    from safety import _rot_fixed_xyz

    st = state_fn() if state_fn else get(f"{fr5}/state")
    tcp, he = st.get("tcpMmDeg"), (st.get("handEye") or {}).get("tMm")
    if not tcp:
        return None, "손끝 자세를 못 읽었다 — 로봇 미연결이다"
    if not he:
        return None, "hand-eye 가 없다 — 카메라 좌표를 로봇 좌표로 못 옮긴다"

    info = get(f"{cam}/api/camera/info")
    K = info.get("depthIntrinsics")
    if not K:
        return None, "깊이 내부 파라미터를 못 읽었다"

    # ⛔ **PIL 을 안 쓴다** — 브리지 uv 환경에 `pillow` 가 없어서 여기 임포트 하나가
    # 상주 전체를 **조용히** 안 뜨게 만들었다 (2026-09-04 · 11분을 그렇게 잃었다).
    # `opencv-python` 은 브리지가 이미 들고 있다. 16비트를 살리려면 `IMREAD_UNCHANGED` 다.
    import cv2                                       # noqa: PLC0415
    with urllib.request.urlopen(f"{cam}/api/camera/depth/frame", timeout=15) as r:
        buf = np.frombuffer(r.read(), np.uint8)
    z = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if z is None:
        return None, "깊이 PNG 를 못 읽었다"
    z = z.astype(np.float32)

    v = z > 0
    ys, xs = np.nonzero(v)
    zz = z[v]
    # ⛔ **원본(hand-eye 더하기 전)을 따로 든다** — 아래 자기검증이 `cam_to_robot` 에
    # 넘겨야 하는 것이 이쪽이다. 더한 값을 넘기면 hand-eye 가 두 번 들어간다(첫 판에 밟았다).
    Craw = np.stack([(xs - K["ppx"]) * zz / K["fx"],
                     (ys - K["ppy"]) * zz / K["fy"], zz], 1)
    C = Craw + np.asarray(he, float)
    R = np.asarray(_rot_fixed_xyz(*[float(x) for x in tcp[3:6]]), float)
    P = C @ R.T + np.asarray(tcp[:3], float)

    # ⭐ **자기검증** — 뭉텅이 변환이 SSOT(`follow.cam_to_robot`)와 같은 답을 내나.
    # 같은 산수를 두 벌 갖는 것이 이 파일의 유일한 위험이라, 매번 한 점으로 대조한다.
    chk, why = follow.cam_to_robot([float(x) for x in Craw[0]], tcp, he)
    if chk is None or max(abs(chk[i] - P[0][i]) for i in range(3)) > 0.5:
        return None, f"변환이 SSOT 와 갈렸다 — {why or '값이 다르다'}. 여기를 고치기 전엔 안 쓴다"

    lo, hi = lidar_z_pred - Z_WINDOW_MM, lidar_z_pred + Z_WINDOW_MM
    Q = P[(P[:, 2] > lo) & (P[:, 2] < hi)]
    if len(Q) < MIN_POINTS:
        return None, (f"z {lo:.0f}~{hi:.0f} 에 점이 {len(Q)}개뿐이다 (최소 {MIN_POINTS}) — "
                      f"팔이 터틀봇을 안 보고 있거나 너무 기울었다")

    # 가장 큰 덩어리로 수렴 — 중심에서 반지름 안의 점만 남기기를 몇 번
    keep = np.ones(len(Q), bool)
    for _ in range(4):
        if not keep.any():
            break
        cx, cy = Q[keep, 0].mean(), Q[keep, 1].mean()
        keep = np.hypot(Q[:, 0] - cx, Q[:, 1] - cy) < DIA_MAX_MM / 2
    G = Q[keep]
    # ⛔ **빈 덩어리에서 `.max()` 를 부르지 않는다** — 넘파이가 `zero-size array` 로 터지고,
    # 상주가 그걸 「읽기 실패」로 적어 **진짜 사유(못 찾았다)를 덮는다** (2026-09-04 실측).
    if len(G) < MIN_POINTS:
        return None, f"수렴 뒤 덩어리가 {len(G)}점뿐이다 (최소 {MIN_POINTS}) — 흩어져 있다"
    dia = float(max(G[:, 0].max() - G[:, 0].min(), G[:, 1].max() - G[:, 1].min()))
    if not (DIA_MIN_MM <= dia <= DIA_MAX_MM):
        return None, (f"덩어리 지름 {dia:.0f}mm 가 범위 {DIA_MIN_MM:.0f}~{DIA_MAX_MM:.0f} 밖이다 — "
                      f"라이다 윗면이 아니라 다른 평면을 문 것 같다")

    return {"user1Mm": [round(float(G[:, 0].mean()), 1), round(float(G[:, 1].mean()), 1),
                        round(float(G[:, 2].mean()), 1)],
            "points": int(len(G)), "diaMm": round(dia, 1),
            "tcpMm": [round(float(x), 1) for x in tcp[:3]]}, None


# 광축이 표적에서 이만큼 떨어져 선다. **`standoffMm` 을 안 빌린다** — 위 §거리 참조
AIM_DIST_MM = 250.0
SPEED_PCT = 10.0                       # 하드 룰 3 — 기본 상한 10%
ARRIVE_TOL_MM, ARRIVE_WAIT_S = 8.0, 25.0
# 한 걸음(5°)이 10% 속도로 닿는 데 드는 시간 — 넉넉히 잡고 **못 닿으면 실패**로 적는다
ARRIVE_TOL_DEG, STEP_WAIT_S = 0.8, 20.0


def aim_tcp(target_user1, tcp_now, he):
    """광축을 `target` 에 꽂는 TCP 자리. **자세는 지금 것을 그대로 쓴다.**"""
    from safety import _rot_fixed_xyz
    R = np.asarray(_rot_fixed_xyz(*[float(v) for v in tcp_now[3:6]]), float)
    axis = R @ np.array([0.0, 0.0, 1.0])
    p = np.asarray(target_user1, float) - AIM_DIST_MM * axis - R @ np.asarray(he, float)
    return [round(float(v), 1) for v in p] + [float(v) for v in tcp_now[3:6]]


def move_arm(fr5, joints, who="amr-pair"):
    """`moveJ` 를 WebSocket 으로 보낸다. 반환 `(간다, 사유)`. **속도는 상한 10%.**

    ⛔ **ARM 을 안 한다** — ARMED 가 아니면 사유를 내고 만다(하드 룰 3 · 사람이 화면에서).
    조종권은 잡고 **반드시 반납한다** — 안 놓으면 사람이 화면에서 못 움직인다(하드 룰 4).
    """
    import asyncio

    import websockets

    tok = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{fr5}/owner/claim", data=json.dumps({"who": who}).encode(),
        headers={"Content-Type": "application/json"}), timeout=8).read())
    if not tok.get("ok"):
        return False, f"조종권을 못 잡았다 — {tok}"
    token = tok["token"]

    # ⛔ **한 번에 안 보낸다.** 경로 검사 없는 `moveJ` 는 관절당 **5°**(`JOINT_DELTA_CAP_DEG`)
    # 가 상한이라 먼 자리는 통째로 거부된다. 그래서 5° 씩 쪼갠다 — `scan_path=True` 가
    # 경로를 **5° 간격으로 표본해 전부 게이트에 태우는** 것과 같은 촘촘함이고, 여기는
    # 표본마다 **실제로 멈춰 서서** 게이트를 탄다. ⛔ 상한을 우회하는 것이 아니라 **지킨다.**
    cur = list((get(f"{fr5}/state").get("jointsDeg") or []))
    if len(cur) != len(joints):
        return False, "지금 관절각을 못 읽었다"
    steps = max(1, int(math.ceil(max(abs(joints[i] - cur[i]) for i in range(len(cur)))
                                 / 5.0)))
    waypoints = [[cur[i] + (joints[i] - cur[i]) * k / steps for i in range(len(cur))]
                 for k in range(1, steps + 1)]

    async def go():
        host = fr5.replace("http://", "")
        async with websockets.connect(f"ws://{host}/ws/state", open_timeout=8) as ws:
            await ws.send(json.dumps({"cmd": "hello", "who": who, "token": token}))
            for n, wp in enumerate(waypoints, 1):
                await ws.send(json.dumps({"cmd": "moveJ", "jointsDeg": wp,
                                          "speedPct": SPEED_PCT}))
                # ⛔ **응답을 못 보면 성공으로 가정하지 않는다** (2026-09-04 에 이걸로 데었다).
                # 그때 10걸음을 「완료」로 보고했는데 실측은 **36.27° 어긋나** 있었다 —
                # 거부를 못 보고 지나친 것이다. 못 보면 **실패로 적는다.**
                ack = None
                for _ in range(40):
                    m = json.loads(await asyncio.wait_for(ws.recv(), 15))
                    if "ok" in m:
                        ack = m
                        break
                if ack is None:
                    return {"ok": False, "reason": f"{n}/{steps} 걸음의 응답을 못 봤다 — 못 갔다고 본다"}
                if not ack.get("ok"):
                    return {"ok": False, "reason": f"{n}/{steps} 걸음에서 거부 — {ack.get('reason')}"}
                # ⛔ **도착을 기다린다.** 10% 속도로 5° 는 0.8초보다 오래 걸린다 — 안 기다리고
                # 다음을 쏘면 이전 동작 중이라 조용히 흘러가고, 팔은 두 걸음만 가고 선다.
                t0 = time.time()
                while time.time() - t0 < STEP_WAIT_S:
                    cur_j = (get(f"{fr5}/state").get("jointsDeg") or [])
                    if cur_j and max(abs(cur_j[i] - wp[i]) for i in range(6)) <= ARRIVE_TOL_DEG:
                        break
                    time.sleep(0.3)
                else:
                    return {"ok": False, "reason": f"{n}/{steps} 걸음이 {STEP_WAIT_S}초 안에 안 닿았다"}
            return {"ok": True, "steps": steps}

    try:
        r = asyncio.run(go())
    finally:                              # ⛔ 무슨 일이 나도 조종권은 놓는다
        try:
            urllib.request.urlopen(urllib.request.Request(
                f"{fr5}/owner/release", data=json.dumps({"who": who, "token": token}).encode(),
                headers={"Content-Type": "application/json"}), timeout=8).read()
        except Exception:                 # noqa: BLE001
            pass
    return bool(r.get("ok")), (r.get("reason") or "")


def odom_lidar_xy(pose, tag):
    """터틀봇이 말하는 **라이다 윗면**의 odom xy. `agree.py` 사슬 B 와 같은 산수다."""
    th = math.radians(float(pose["yawDeg"]))
    o = tag["offsetMm"]
    ox, oy = float(o["x"]), float(o["y"] or 0.0)
    return [pose["xMm"] + ox * math.cos(th) - oy * math.sin(th),
            pose["yMm"] + ox * math.sin(th) + oy * math.cos(th)]


def load():
    try:
        return json.loads(PAIRS.read_text(encoding="utf-8")).get("pairs", [])
    except Exception:                     # noqa: BLE001 — 없는 것은 고장이 아니다
        return []


def save(pairs):
    PAIRS.write_text(json.dumps(
        {"_": "손목캠으로 모은 (odom, user1) 쌍 — `amr-pair.py` 산출",
         "_주의": "**user1 이지 lab 이 아니다.** `amr-frame.json`(odom→lab) 과 다른 물건이다",
         "_표적": "터틀봇 라이다 윗면 (태그가 아니라 평면을 직접 잰다)",
         "pairs": pairs}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def solve_and_report(pairs, home):
    """쌓인 쌍 → `odom → user1`. **산수는 `amr.solve` 를 그대로 빌린다.**"""
    import amr
    if len(pairs) < amr.MIN_PAIRS:
        print(f"\n  쌍 {len(pairs)}개 — {amr.MIN_PAIRS}개는 있어야 푼다. "
              f"터틀봇을 옮겨 세우고 `--add` 를 {amr.MIN_PAIRS - len(pairs)}번 더")
        return 0
    # ⛔ 키 이름만 `solve` 규약에 맞춘다. **파일에는 `lab` 이라고 안 적혀 있다**
    got, why = amr.solve([{"odom": p["odom"], "lab": p["user1"]} for p in pairs])
    if not got:
        print(f"\n  ⛔ 못 풀었다 — {why}")
        return 1
    print(f"\n== 풀렸다 — 이것이 `odom → user1` 이다 ==")
    print(f"  쌍 {got['n']}개 · 잔차 {got['rmsMm']}mm (상한 {amr.MAX_FIT_RMS_MM})")
    print(f"\n  실측  xMm {got['txMm']}   yMm {got['tyMm']}   yawDeg {got['yawDeg']}")
    print(f"  등재  xMm {home['xMm']}   yMm {home['yMm']}   yawDeg {home['yawDeg']}"
          f"   ({home['measured']['by']} · {home['measured']['date']})")
    print(f"  차이  x {got['txMm'] - home['xMm']:+.1f}  y {got['tyMm'] - home['yMm']:+.1f}"
          f"  yaw {got['yawDeg'] - home['yawDeg']:+.2f}°")
    print(f"\n  ⚠ 등재된 yaw 180° 는 「벽을 등지고」에서 유도한 값이다 — 위 실측이 그것도 잰다.")
    print(f"  ▶ 고칠지는 사람이 정한다. 고친다면 `Shared/data/workcell.js` AMR_HOME 하나다.")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fr5", default="192.168.30.6:5055")
    ap.add_argument("--cam", default="192.168.30.6:5058")
    ap.add_argument("--tb", default="192.168.30.15:5056")
    ap.add_argument("--add", action="store_true", help="지금 자리에서 쌍 하나를 잰다")
    ap.add_argument("--aim", action="store_true",
                    help="재기 전에 팔을 표적으로 옮긴다 (ARMED 여야 한다 · ARM 은 사람이)")
    ap.add_argument("--reset", action="store_true")
    a = ap.parse_args()

    if a.reset:
        save([])
        print("쌍을 비웠다")
        return 0

    import amr
    w = sjs("workcell.js", "AMR_HOME", "AMR_TAG")
    home, tag = w["AMR_HOME"], w["AMR_TAG"]
    lidar_z = home["topZMm"] + float(tag["offsetMm"]["z"])
    pairs = load()

    if not a.add:
        print(f"쌓인 쌍 {len(pairs)}개 (필요 {amr.MIN_PAIRS})")
        for i, p in enumerate(pairs, 1):
            print(f"  {i}  odom [{p['odom'][0]:7.1f}, {p['odom'][1]:7.1f}]"
                  f"  → user1 [{p['user1'][0]:7.1f}, {p['user1'][1]:7.1f}]"
                  f"   {p.get('note', '')}")
        return solve_and_report(pairs, home)

    # ── 쌍 하나 잰다 ────────────────────────────────────────────────────────
    st = get(f"http://{a.fr5}/state")
    pose = ((st.get("follow") or {}).get("amr") or {}).get("pose")
    if not pose:
        print("⛔ 터틀봇 자리를 못 받았다 — 브리지가 터틀봇에 안 붙어 있다")
        return 1
    if float(pose.get("ageS") or 99) > MAX_ODOM_AGE_S:
        print(f"⛔ 바퀴 값이 {pose['ageS']}초 낡았다 (상한 {MAX_ODOM_AGE_S}) — 지금 자리가 아니다")
        return 1

    fr5 = f"http://{a.fr5}"
    if a.aim:
        st = get(f"{fr5}/state")
        # ⛔ **터틀봇이 움직이는 동안 팔을 안 움직인다** — §상호 배제 (계약이 못 박았다)
        v = pose.get("velocity") or {}
        if abs(float(v.get("linearMmS") or 0)) > 1 or abs(float(v.get("angularDegS") or 0)) > 1:
            print("⛔ 터틀봇이 움직이는 중이다 — 세우고 다시 (§상호 배제)")
            return 1
        if st.get("phase") != "ARMED":
            print(f"⛔ ARMED 가 아니다 (phase={st.get('phase')}) — **화면에서 ARM** 하고 다시.\n"
                  f"   승격은 사람이 한다(하드 룰 3). 여기는 확인만 한다")
            return 1
        tcp_now, he = st.get("tcpMmDeg"), (st.get("handEye") or {}).get("tMm")
        # 표적 = 지금 odom 이 말하는 라이다 윗면 (AMR_HOME 기준 · 140mm 어긋나 있지만
        # 화각이 498mm 라 들어온다. **눈금이 풀리면 이 예측이 저절로 좋아진다**)
        o = odom_lidar_xy(pose, tag)
        c, s = math.cos(math.radians(home["yawDeg"])), math.sin(math.radians(home["yawDeg"]))
        tgt = [c * o[0] - s * o[1] + home["xMm"], s * o[0] + c * o[1] + home["yMm"], lidar_z]
        want = aim_tcp(tgt, tcp_now, he)
        print(f"표적(예측) {[round(v, 1) for v in tgt]}   →  조준 TCP {want[:3]}")
        body = json.dumps({"tcpMmDeg": want}).encode()
        d = json.loads(urllib.request.urlopen(urllib.request.Request(
            f"{fr5}/ik", data=body, headers={"Content-Type": "application/json"}), timeout=12).read())
        if not d.get("reachable") or not d.get("jointsDeg"):
            print(f"⛔ 못 간다 — {d.get('reason') or d}")
            return 1
        okey, why_m = move_arm(fr5, d["jointsDeg"])
        if not okey:
            print(f"⛔ 못 움직였다 — {why_m}")
            return 1
        t0 = time.time()
        while time.time() - t0 < ARRIVE_WAIT_S:      # 도착까지 기다린다
            cur = (get(f"{fr5}/state").get("tcpMmDeg") or [0, 0, 0])[:3]
            if math.dist(cur, want[:3]) <= ARRIVE_TOL_MM:
                break
            time.sleep(1.0)
        print(f"   도착 {[round(v, 1) for v in cur]}  (목표까지 {math.dist(cur, want[:3]):.1f}mm)")

    # ⭐ **브리지가 이미 재고 있으면 그 값을 쓴다** (2026-09-04). 상주가 0.5초마다 같은
    # 사슬로 재고 **바퀴 대조까지 통과시킨** 값이 `follow.target` 이다. 여기서 또 재면
    # 나쁜 프레임 하나에 걸려 실패하고(실측 593점), 같은 순간의 두 측정이 갈릴 수도 있다.
    # ⛔ 낡으면 안 쓴다 — 신선한 것만 빌리고, 없으면 그때 직접 잰다.
    tgt = ((st.get("follow") or {}).get("target"))
    # ⛔ **`odom` 출처를 쌍으로 쌓지 않는다** (2026-09-04 에 밟았다). 재획득 표적은 **측정이
    # 아니라 `AMR_HOME` 예측**이다 — 그걸 쌓으면 눈금이 자기가 자기를 확인하는 꼴이 되고,
    # 6쌍을 다 모아도 `AMR_HOME` 을 **그대로 되돌려 준다.** 우리가 고치려는 그 값이다.
    if (tgt and tgt.get("source") != "odom" and tgt.get("user1Mm")
            and float(tgt.get("ageS") or 99) <= MAX_ODOM_AGE_S):
        got, why = {"user1Mm": tgt["user1Mm"], "points": None, "diaMm": None,
                    "tcpMm": [round(float(v), 1) for v in (st.get("tcpMmDeg") or [0, 0, 0])[:3]]}, None
        src = f"브리지 상주 ({tgt['ageS']}초)"
    else:
        got, why = measure(fr5, f"http://{a.cam}", tag, lidar_z)
        src = "직접 측정"
    if got is None:
        print(f"⛔ {why}")
        return 1

    o = odom_lidar_xy(pose, tag)
    u = got["user1Mm"][:2]
    # ⛔ **같은 자리를 두 번 안 쌓는다** — 한 점에 몰리면 회전이 안 풀린다 (`amr.solve` §)
    for p in pairs:
        if math.dist(p["odom"], o) < amr.MIN_PAIR_SPACING_MM:
            print(f"⛔ 이미 쌓은 자리와 {math.dist(p['odom'], o):.0f}mm 밖에 안 떨어졌다 "
                  f"(최소 {amr.MIN_PAIR_SPACING_MM}) — 터틀봇을 더 옮기고 다시")
            return 1

    pairs.append({"odom": [round(v, 1) for v in o], "user1": [round(v, 1) for v in u],
                  "zMm": got["user1Mm"][2], "points": got["points"], "diaMm": got["diaMm"],
                  "tcpMm": got["tcpMm"], "odomYawDeg": round(pose["yawDeg"], 2),
                  "note": src if got["points"] is None
                          else f"{got['points']}점 · 지름 {got['diaMm']}mm"})
    save(pairs)
    print(f"쌍 {len(pairs)}번째를 쌓았다")
    print(f"  odom  [{o[0]:7.1f}, {o[1]:7.1f}]  (요각 {pose['yawDeg']:.1f}°)")
    print(f"  user1 [{u[0]:7.1f}, {u[1]:7.1f}]  z {got['user1Mm'][2]}"
          f"  ({src if got['points'] is None else str(got['points']) + '점 · 지름 ' + str(got['diaMm']) + 'mm'})")
    print(f"  높이 검산  예측 {lidar_z:.0f}  실측 {got['user1Mm'][2]}"
          f"  차이 {got['user1Mm'][2] - lidar_z:+.0f}mm")
    return solve_and_report(pairs, home)


if __name__ == "__main__":
    sys.exit(main())
