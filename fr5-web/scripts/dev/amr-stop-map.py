#!/usr/bin/env python3
"""⛔ **대체됨 — `amr-stop-mujoco.mjs` 를 쓴다** (2026-08-31 · D164).

이 파일은 x·y 격자를 훑는데, 터틀봇은 **차동구동이라 대각선으로 못 간다.** 그래서 나온
추천(673, −788)은 **갈 수 없는 자리**였다. 그리고 판정이 `check_workspace`(상자)뿐이라
**손에 든 거치대가 바구니 벽에 걸리는 것**을 못 본다.

무조코판이 셋을 다 고쳤다 — 직선만 훑고, 메시 충돌을 보고, **집는 순서까지** 함께 판정한다.

⚠ **지우지 않고 남긴다** — 이쪽은 **실기 안전 함수를 그대로 부르는** 유일한 훑기라
독립 대조군으로 값이 있다(둘이 요각 270° 로 일치한 것이 그 값어치다). 다만 **추천값을
여기서 읽지 않는다.**

──────────────────────────────────────────────────────────────────────────
**터틀봇이 어디 서야 팔이 바구니에 넣을 수 있나** — 정차 자리를 격자로 훑어 고른다.

    python3 scripts/dev/amr-stop-map.py --host 192.168.30.6:5055

## 무엇을 답하나

「거치대를 집은 팔이 **터틀봇 바구니에 넣으려면 터틀봇이 어디 서야 하나**」 하나다.
터틀봇 자리(x·y)와 방향(요각)을 격자로 훑고, 자리마다

  ① 그 자리의 **바구니 중심**을 구하고 (터틀봇 프레임 → user1)
  ② 넣는 자세 둘(테두리 위 · 바닥까지)을 만들어
  ③ `POST /ik` 로 관절 여섯을 컨트롤러에게 묻고 (로봇은 안 움직인다 · D131)
  ④ `safety.check_workspace` 로 손끝·툴·팔뚝까지 판정하고
  ⑤ 통과한 자리의 **여유**를 잰다

⛔ **판정을 여기서 만들지 않는다** — `observe-map.py`·`follow-map.py` 와 같은 규약이다.
실기가 쓰는 그 함수를 그대로 부른다. 여기서 다시 짜면 지도가 초록인데 실기가 거부한다.

⛔ **로봇을 안 움직인다.** `/ik` 는 조종권도 ARM 도 요구하지 않고 답만 준다.
그리고 `check_workspace` 를 직접 부르므로 **펜던트가 수동 모드여도 판정이 나온다** —
브리지의 전체 게이트는 `mode=1` 에서 앞단에 막혀 뒤를 못 본다.

## ⚠ 이 지도가 서 있는 가정 둘

1. **바구니가 터틀봇 어디에 달렸는지 안 쟀다** (`AMR_BASKET.offsetMm` 이 `null`).
   그동안은 「등에 달려 상판에 나란히」라는 말에서 유도한다 — 등 = 정면(+x) 반대 · 절반 깊이.
   ▶ 재는 날 그 값이 들어오면 이 지도가 **통째로 정확해진다.** 지금은 **자리를 좁히는 용도**다.
2. **터틀봇이 상판 위에 있다** (D134). 그래서 z 는 `AMR_HOME.topZMm` 기준이다.

산출은 자리 하나가 아니라 **되는 자리들**이다 — 주행 경로는 사람이 그중에서 고른다.
"""
import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))
import safety  # noqa: E402

ARM_UNKNOWN = "팔"          # `observe-map.py` 와 같은 관용구 — 팔뚝 미판정은 하드 실패가 아니다


def load_ssot():
    """치수 정본은 **JS 모듈**이다. ⛔ 정규식으로 긁지 않는다 — 파일 모양이 바뀌면 조용히
    다른 값을 읽거나(더 나쁘다) 못 읽는다. `node` 로 **그 모듈을 실제로 평가해** 받아 온다.
    여기 숫자를 적지 않는 이유는 `props.js` 머리말 §복사하지 않는다 그대로다."""
    import subprocess
    js = """
    Promise.all([import('./Shared/data/props.js'),
                 import('./Shared/data/workcell.js'),
                 import('./Shared/data/layout/catalog.js')]).then(([p, w, c]) => {
      console.log(JSON.stringify({
        carrierH: p.CARRIER.hMm,
        rim: p.AMR_BASKET.rimAboveGroundMm,
        innerH: p.AMR_BASKET.innerHMm,
        innerW: p.AMR_BASKET.innerWMm,
        innerD: p.AMR_BASKET.innerDMm,
        offset: p.AMR_BASKET.offsetMm,
        wall: p.AMR_BASKET.wallMm,
        amrDepth: c.AMR_MM.depthMm,
        homeX: w.AMR_HOME.xMm, homeY: w.AMR_HOME.yMm,
        topZ: w.AMR_HOME.topZMm, homeYaw: w.AMR_HOME.yawDeg,
      }));
    });
    """
    out = subprocess.run(["node", "-e", js], cwd=str(ROOT), capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"정본을 못 읽었다 — {out.stderr.strip()[:200]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def ik(host, tcp, timeout=8.0):
    body = json.dumps({"tcpMmDeg": [float(v) for v in tcp]}).encode()
    req = urllib.request.Request(f"http://{host}/ik", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310 — 랜 고정 주소
            d = json.load(r)
    except Exception as e:                                        # noqa: BLE001
        return None, str(e)[:60]
    return (d.get("jointsDeg"), d.get("reason"))


def get_state(host, timeout=8.0):
    with urllib.request.urlopen(f"http://{host}/state", timeout=timeout) as r:   # noqa: S310
        return json.load(r)


def basket_center(x, y, yaw_deg, S):
    """터틀봇이 (x, y, yaw) 에 섰을 때 **바구니 중심**(user1 mm).

    ⚠ 로봇 프레임 오프셋을 **안 쟀다** — 「등에 달렸다」에서 유도한다. 그 사실을 부르는
    쪽이 알아야 하므로 값과 함께 `assumed` 를 돌려준다 (조용히 지어내지 않는다).
    """
    off = S.get("offset")
    assumed = off is None
    # ⛔ **겹치지 않고 뒤에 이어 붙는다** (실기 담당자 2026-08-31). 절반이 아니라 절반 합이다 —
    # `RobotTwin` 의 같은 유도와 **한 뜻이어야 한다**(그림과 지도가 갈리면 아무도 못 믿는다).
    wall = S.get("wall") or 3.0
    ox = float(off["x"]) if off else -(S["amrDepth"] / 2.0 + (S["innerD"] + 2 * wall) / 2.0)
    oy = float(off["y"]) if off else 0.0
    th = math.radians(yaw_deg)
    bx = x + ox * math.cos(th) - oy * math.sin(th)
    by = y + ox * math.sin(th) + oy * math.cos(th)
    return bx, by, assumed


def frange(lo, hi, step):
    v = lo
    while v <= hi + 1e-9:
        yield v
        v += step


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.30.6:5055")
    ap.add_argument("--span", type=float, default=300.0, help="홈에서 ±이만큼 훑는다 (mm)")
    ap.add_argument("--step", type=float, default=60.0)
    ap.add_argument("--yaws", default="0,90,180,270", help="터틀봇 방향 후보 (도)")
    ap.add_argument("--top", type=int, default=8)
    a = ap.parse_args()

    S = load_ssot()
    # ⚠ `offset` 은 **없는 게 정상**이다 — 안 쟀고 아래 `basket_center` 가 유도로 대신한다.
    # 나머지는 없으면 멈춘다(결측=차단). 「없어도 되는 것」과 「없으면 안 되는 것」을 가른다.
    miss = [k for k, v in S.items() if v is None and k not in ("offset", "wall")]
    if miss:
        sys.exit(f"정본에서 못 읽은 값: {miss} — 지어내지 않고 멈춘다")

    st = get_state(a.host)
    ws = st.get("workspace")
    defs = st.get("coordDefs")
    coord = st.get("coordIds") or {"toolId": 1, "userId": 1}
    if not ws or not defs:
        sys.exit("작업영역·좌표계를 못 읽었다 — 로봇에 연결돼 있어야 한다 (결측=차단)")

    # 넣는 높이 둘 — 테두리 위(진입)와 바닥까지(놓기). 둘 다 돼야 「넣을 수 있다」다
    z_rim = S["topZ"] + S["rim"] + 40.0
    z_ins = S["topZ"] + (S["rim"] - S["innerH"]) + S["carrierH"]
    yaws = [float(v) for v in a.yaws.split(",")]
    gx = list(frange(S["homeX"] - a.span, S["homeX"] + a.span, a.step))
    gy = list(frange(S["homeY"] - a.span, S["homeY"] + a.span, a.step))

    print(f"홈 ({S['homeX']:.0f}, {S['homeY']:.0f}) · 상판 z {S['topZ']:.1f}")
    print(f"바구니 테두리 z {z_rim - 40:.1f} · 진입 z {z_rim:.1f} · 놓기 z {z_ins:.1f}")
    print(f"격자 {len(gx)}×{len(gy)} · 요각 {len(yaws)} = 후보 {len(gx)*len(gy)*len(yaws)}개")
    print("⚠ 바구니 오프셋은 **유도값**이다 (`AMR_BASKET.offsetMm` 미측정)\n")

    rows, asked = [], 0
    for x in gx:
        for y in gy:
            for yaw in yaws:
                bx, by, assumed = basket_center(x, y, yaw, S)
                ok, joints_at = True, {}
                for tag, z in (("rim", z_rim), ("insert", z_ins)):
                    # 똑바로 내려다본다 — 거치대를 위에서 넣는 자세다
                    tcp = [bx, by, z, 180.0, 0.0, 0.0]
                    j, _ = ik(a.host, tcp)
                    asked += 1
                    if j is None:
                        ok = False
                        break
                    reasons = safety.check_workspace(tcp, ws, coord, j, defs)
                    hard = [r for r in reasons if ARM_UNKNOWN not in r]
                    if hard:
                        ok = False
                        break
                    joints_at[tag] = j
                if ok:
                    d = math.hypot(bx, by)          # 로봇 베이스에서 바구니까지
                    rows.append({"amr": (x, y, yaw), "basket": (bx, by),
                                 "reach": d, "joints": joints_at})

    print(f"IK 질의 {asked}회 · 두 자세 모두 통과한 정차 자리 {len(rows)}개")
    if not rows:
        sys.exit("되는 자리가 없다 — span 을 넓히거나 바구니 오프셋을 재야 한다")

    # **가까울수록 좋다** — 팔이 뻗을수록 오차가 커지고 여유가 준다 (`REACH_MM` 근처는 피한다)
    rows.sort(key=lambda r: r["reach"])
    print(f"\n좋은 자리 {min(a.top, len(rows))}개 — 터틀봇(x, y, 요각) · 바구니중심 · 베이스거리")
    for r in rows[:a.top]:
        x, y, yaw = r["amr"]
        bx, by = r["basket"]
        print(f"  터틀봇 ({x:7.0f}, {y:7.0f}) {yaw:5.0f}°  →  바구니 ({bx:7.0f}, {by:7.0f})"
              f"  ·  베이스에서 {r['reach']:.0f}mm")
    best = rows[0]
    print(f"\n추천 정차 자리 — ({best['amr'][0]:.0f}, {best['amr'][1]:.0f}) "
          f"요각 {best['amr'][2]:.0f}°")
    print(f"  홈({S['homeX']:.0f}, {S['homeY']:.0f})에서 "
          f"{math.hypot(best['amr'][0]-S['homeX'], best['amr'][1]-S['homeY']):.0f}mm")
    print("⛔ **이 값을 경로에 바로 박지 않는다** — 바구니 오프셋을 잰 뒤 다시 돌린다")
    return 0


if __name__ == "__main__":
    sys.exit(main())
