#!/usr/bin/env python3
"""**어느 자세로 서면 이 점들을 카메라가 다 보나** — 관절 여섯 개를 다 써서 고른다.

    # 보고 싶은 점(user1 mm)을 주면 최적 관찰 자세를 고른다
    python3 scripts/dev/observe-map.py --host 192.168.30.18:5055 \
        --targets "216,-951;-230,-953;-231,-953;-322,-369;-322,-369"

## 무엇을 답하나

**「팔을 어디에 세우면 저 점들이 손목 카메라 시야에 다 들어오나」** 하나다.
자리·높이·손목 요각을 격자로 훑고, 자세마다

  ① `POST /ik` 로 **관절 여섯 개**를 컨트롤러에게 묻고 (로봇은 안 움직인다 · D131)
  ② `safety.check_workspace` 로 손끝·툴·**팔뚝**까지 판정하고
  ③ 손끝 + hand-eye 로 카메라 자세를 만들어 **시야 발자국**을 판에 자르고
  ④ 점 몇 개가 그 안인지 세고, 팔이 금지 형상에서 얼마나 떨어졌는지 잰다

점수는 **커버리지 우선, 동점이면 여유**다 (실기 담당자 2026-08-28).

⛔ **판정을 여기서 만들지 않는다** — `follow-map.py` 와 같은 규약이다. 목표·판정은 실기가
쓰는 그 함수를 그대로 부른다. 여기서 다시 짜면 지도가 초록인데 실기가 거부하는 날이 온다.

⛔ **로봇을 안 움직인다.** `/ik` 는 조종권도 ARM 도 요구하지 않고 답만 준다.

## 좌표계

입력 `--targets` 와 출력 자세는 **user1 mm** 다 — `/ik` 와 `check_workspace` 가 쓰는 그 좌표계다
(`docs/ref/contract/FRAMES.md`). **여기서 프레임 변환을 하지 않는다** — 부르는 쪽이
`Shared/data/frames.js` 로 옮겨서 넘긴다. 오늘 하루 여섯 번 난 사고가 전부 그 갈래였다.
"""
import argparse
import json
import math
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))
import safety  # noqa: E402

# 뎁스 화각 — D435 848×480 · fx 425.91 에서. 정본은 카메라 관문 `/api/camera/info`
FOV_H_DEG, FOV_V_DEG = 89.5, 58.8
ARM_UNKNOWN = "팔뚝"


def rot_fixed_xyz(rx, ry, rz):
    """손끝 자세 → 회전행렬. **정본은 `safety._rot_fixed_xyz`** — 같은 것을 부른다."""
    return safety._rot_fixed_xyz(rx, ry, rz)  # noqa: SLF001


def ik(host, tcp, timeout=6.0):
    """컨트롤러에 관절각을 묻는다. `(joints|None, 사유|None)`. **로봇은 안 움직인다.**"""
    body = json.dumps({"tcpMmDeg": [float(v) for v in tcp]}).encode()
    req = urllib.request.Request(f"http://{host}/ik", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, f"IK 못 물음 — {str(e)[:60]}"
    if not d.get("reachable"):
        return None, d.get("reason") or "해가 없다"
    return d.get("jointsDeg"), None


def get_state(host, timeout=8.0):
    with urllib.request.urlopen(f"http://{host}/state", timeout=timeout) as r:
        return json.loads(r.read())


def footprint(tcp, he, plane_z):
    """시야 발자국 — 카메라에서 네 모서리 광선을 쏴 판 평면에서 자른다. 못 만나면 `None`.

    카메라 원점은 `follow.cam_to_robot` 의 `P = R·(C+t)+p` 에서 C=0 인 자리다 —
    **hand-eye 는 손끝 프레임 오프셋**이고 카메라 축은 손끝 축과 나란하다."""
    R = rot_fixed_xyz(*tcp[3:6])
    cam = [sum(R[r][k] * he[k] for k in range(3)) + tcp[r] for r in range(3)]
    th, tv = math.tan(math.radians(FOV_H_DEG / 2)), math.tan(math.radians(FOV_V_DEG / 2))
    quad = []
    for u, v in ((-th, -tv), (th, -tv), (th, tv), (-th, tv)):
        d = [sum(R[r][k] * (u, v, 1.0)[k] for k in range(3)) for r in range(3)]
        n = math.dist(d, (0, 0, 0))
        d = [c / n for c in d]
        if d[2] > -1e-6:                      # 위를 보면 판을 안 만난다 — 그게 사실이다
            return None, cam
        t = (plane_z - cam[2]) / d[2]
        if t <= 0 or t > 4000:
            return None, cam
        quad.append((cam[0] + d[0] * t, cam[1] + d[1] * t))
    return quad, cam


def inside(quad, px, py):
    c = False
    j = 3
    for i in range(4):
        xi, yi = quad[i]
        xj, yj = quad[j]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def clearance_mm(tcp, ws):
    """손끝에서 **가장 가까운 금지 형상**까지 (mm). 상자는 3D 점-AABB 거리, 벽은 평면 선분 거리.

    ⚠ **판정이 아니라 계측이다** — 판정은 `safety.check_workspace` 가 한다
    (`clearance.mjs` 머리말과 같은 태도). 여기 숫자로 합격을 정하지 않는다."""
    best = float("inf")
    x, y, z = tcp[0], tcp[1], tcp[2]
    for b in ws.get("boxes") or []:
        dx = max(b["xMm"][0] - x, 0, x - b["xMm"][1])
        dy = max(b["yMm"][0] - y, 0, y - b["yMm"][1])
        dz = max(0.0, b["topZMm"] - z) if z < b["topZMm"] else z - b["topZMm"]
        best = min(best, math.sqrt(dx * dx + dy * dy + dz * dz))
    for w in ws.get("walls") or []:
        ax, ay = w["aMm"]
        bx, by = w["bMm"]
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * vx + (y - ay) * vy) / L2))
        best = min(best, math.hypot(x - (ax + t * vx), y - (ay + t * vy)))
    return None if best == float("inf") else best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True, help="브리지 주소 (예 192.168.30.18:5055)")
    ap.add_argument("--targets", required=True,
                    help="보고 싶은 점들 — user1 mm, 'x,y;x,y;…'")
    ap.add_argument("--step", type=float, default=120.0, help="손끝 자리 격자 mm")
    ap.add_argument("--heights", default="450,550,650,750",
                    help="판 위 높이 후보 mm (쉼표)")
    ap.add_argument("--yaws", default="0,45,90,135", help="손목 요각 후보 도 (쉼표)")
    ap.add_argument("--top", type=int, default=5, help="상위 몇 개를 보일까")
    a = ap.parse_args()

    pts = [tuple(float(v) for v in p.split(",")) for p in a.targets.split(";") if p.strip()]
    st = get_state(a.host)
    ws, coord, defs = st.get("workspace"), st.get("coord"), st.get("coordDefs")
    he = (st.get("handEye") or {}).get("tMm")
    if not ws or not he:
        sys.exit("작업영역이나 hand-eye 가 없다 — 로봇이 붙어 있어야 한다")
    plane_z = min(b["topZMm"] for b in ws["boxes"] if "작업대" in (b.get("name") or ""))

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    span = a.step
    gx = [round(v) for v in frange(min(xs) - span, max(xs) + span, a.step)]
    gy = [round(v) for v in frange(min(ys) - span, max(ys) + span, a.step)]
    hs = [float(v) for v in a.heights.split(",")]
    yaws = [float(v) for v in a.yaws.split(",")]

    print(f"보고 싶은 점 {len(pts)}개 · 판 상판 z {plane_z:.1f} (user1)")
    print(f"격자 {len(gx)}×{len(gy)} · 높이 {len(hs)} · 요각 {len(yaws)} "
          f"= 후보 {len(gx) * len(gy) * len(hs) * len(yaws)}개\n")

    rows, asked = [], 0
    for x in gx:
        for y in gy:
            for h in hs:
                for yaw in yaws:
                    # 손끝은 **똑바로 내려다본다** — rx 180 이면 공구축 +Z 가 아래다.
                    # 기울임 0 이라 `follow.py` 의 `maxTiltDeg 20` 안에 넉넉히 든다.
                    tcp = [float(x), float(y), plane_z + h, 180.0, 0.0, float(yaw)]
                    quad, cam = footprint(tcp, he, plane_z)
                    if quad is None:
                        continue
                    seen = sum(1 for px, py in pts if inside(quad, px, py))
                    if seen == 0:
                        continue                      # 아무것도 못 보는 자세는 물어볼 값도 없다
                    joints, why = ik(a.host, tcp)
                    asked += 1
                    if joints is None:
                        continue
                    reasons = safety.check_workspace(tcp, ws, coord, joints, defs)
                    hard = [r for r in reasons if ARM_UNKNOWN not in r]
                    if hard:
                        continue
                    rows.append({"tcp": tcp, "joints": joints, "seen": seen,
                                 "clearMm": clearance_mm(tcp, ws), "cam": cam,
                                 "armUnknown": any(ARM_UNKNOWN in r for r in reasons)})

    print(f"IK 질의 {asked}회 · 게이트 통과 {len(rows)}자세")
    if not rows:
        sys.exit("통과한 자세가 없다 — 격자·높이를 넓히거나 점이 팔 밖이다")
    # **커버리지 우선, 동점이면 여유** (실기 담당자 2026-08-28)
    rows.sort(key=lambda r: (-r["seen"], -(r["clearMm"] or 0)))
    print(f"\n최적 {min(a.top, len(rows))}개 — 본 점 / 여유 / 손끝(user1) / 관절")
    for r in rows[:a.top]:
        t = r["tcp"]
        print(f"  {r['seen']}/{len(pts)}점 · 여유 {r['clearMm']:.0f}mm · "
              f"({t[0]:.0f},{t[1]:.0f},{t[2]:.0f}) rz {t[5]:.0f}°"
              + ("  ⚠팔뚝미판정" if r["armUnknown"] else ""))
        print(f"        관절 {[round(v, 1) for v in r['joints']]}")


def frange(lo, hi, step):
    v = lo
    while v <= hi + 1e-9:
        yield v
        v += step


if __name__ == "__main__":
    main()
