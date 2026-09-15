#!/usr/bin/env python3
"""영상에서 **작업대 모서리를 찾아** 좌표 사슬을 다듬는다 — `robot-base-in-tag.json` 의 정밀화.

    python3 scripts/map/edge-fit.py                 # 재기만 한다 (아무것도 안 쓴다)
    python3 scripts/map/edge-fit.py --apply         # yaw·x·y 를 파일에 쓴다
    python3 scripts/map/edge-fit.py --shot a.jpg    # 저장된 사진으로

## 왜 필요한가 (2026-08-19)

`extrinsics.py` 는 **태그까지만** 맞춘다 — 카메라가 태그 좌표계 어디 있나. 그 뒤 칸인
**로봇↔태그**(`robot-base-in-tag.json`)는 2026-08-07 에 **229mm 정사각 밑판**을 하향 10.8°
사진에 맞춰 얻었고, 그 각도 분해능은 잔차 2.2mm ÷ 229mm ≈ **0.55°** 였다. 그 각을 1300mm
작업대에 쓰면 **5.7배로 증폭**된다. 화면에서 「판이 비뚤다」로 보이던 것의 정체가 이것이다.

▶ 이 도구는 **쓸 때의 지렛대(작업대 1600mm)로 잰다.** 상판 모서리는 로봇이 짚은 값
(`config.yaml`)이 아는 자리이고, 영상에도 **긴 실루엣**으로 나온다 — 둘을 맞추면 된다.

## ⛔ 하지 않는 것

- **그림을 감지선에 스냅하지 않는다.** 판정면이 보여주는 건 「게이트가 거부하는 자리」이고
  그건 `config.yaml` 에서 온다. 그림만 실물에 붙이면 **화면은 예뻐지고 게이트는 틀린 채**
  남는다 — 사람은 맞았다고 믿고 팔은 여전히 엉뚱한 데서 멈춘다.
- **`config.yaml` 의 `topZMm` 을 안 쓴다.** 적합이 상판 높이를 알려 주지만 그 값은
  **진단일 뿐**이다. `-380.9` 는 「짚은 셋 중 제일 높은 것 + 여유 10」이라 **일부러 위로 잡은
  안전선**이고, 낮추면 금지구역이 얇아져 팔이 판을 파고든다. 높이를 고치려면 로봇으로
  다시 짚는다 (`scripts/robot/table-probe.py`).

## 한계 (ponytail)

**처음부터 세우는 도구가 아니라 다듬는 도구다.** 투영선 둘레 ±`SEARCH_PX` 만 훑으므로
정합이 크게 틀어져 있으면 못 찾는다 — 그때는 `extrinsics.py` 가 먼저다.
가장자리에 물건(터틀봇·상자)이 있으면 그 점은 물건 윤곽을 잡는다. 그래서 **로버스트 적합**
으로 이상점을 빼고, 몇 개를 뺐는지 항상 찍는다.
"""
import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[2]
CONF = ROOT / "Shared/data/config/global-cam.json"
BASE = ROOT / "Shared/data/config/robot-base-in-tag.json"
PROFILE = ROOT / "FR5/bridge/config.yaml"

SEARCH_PX = 55       # 투영선에서 이만큼만 훑는다. 넓히면 옆 물건을 모서리로 착각한다
STEP_MM = 40.0       # 모서리를 따라 이 간격으로 표본
MIN_PTS = 20         # 이보다 적으면 판정하지 않는다 — 못 잰 것을 0 으로 적지 않는다 (제1원칙)
MIN_EDGE_PTS = 5    # 한 변에서 이보다 적게 찾히면 그 변은 «못 본 것» 이다
TOUCH_MM = 20.0     # 이만큼 안에서 다른 상자와 만나면 «물린 변» 으로 본다
OUTLIER_K = 3.0      # 중앙절대편차의 이 배를 넘으면 물건에 걸린 점으로 본다


def frame(host, shot):
    """사진 한 장. **`/shot.jpg` 대신 영상 스트림**에서 뽑는다 — 정지촬영은 화면을 번쩍이게 한다."""
    if shot:
        img = cv2.imread(str(shot))
        if img is None:
            sys.exit(f"사진을 못 읽었다 — {shot}")
        return img
    buf = b""
    with urllib.request.urlopen(f"http://{host}/video", timeout=6) as r:
        while len(buf) < 4 << 20:
            c = r.read(65536)
            if not c:
                break
            buf += c
            a, b = buf.find(b"\xff\xd8"), buf.find(b"\xff\xd9", 2)
            if a >= 0 and b > a:
                img = cv2.imdecode(np.frombuffer(buf[a:b + 2], np.uint8), cv2.IMREAD_COLOR)
                if img is not None:
                    return img
                buf = buf[b + 2:]
    sys.exit(f"프레임을 못 받았다 — http://{host}/video")


def top_edges(profile):
    """`config.yaml` 상자들의 **윗면 네 변**. 값을 여기 베껴 적지 않는다 (하드 룰 5)."""
    def walk(o):
        if isinstance(o, dict):
            if "boxes" in o and (o.get("frame") or {}).get("userId") == 1:
                yield o
            for v in o.values():
                yield from walk(v)
        elif isinstance(o, list):
            for v in o:
                yield from walk(v)
    ws = next(walk(profile), None)
    if ws is None:
        sys.exit("config.yaml 에 user1 작업영역이 없다")
    boxes = [b for b in ws.get("boxes", [])
             if "xMm" in b and b.get("source", "profile") == "profile"]

    def interior(b, mid):
        """이 변이 **다른 상자에 물려 있나.** 물린 변은 실루엣이 없다 — 거길 훑으면
        옆 물건의 윤곽을 모서리로 착각한다. 오늘 작업대 셋을 서로·카트에 **딱 물려** 놓아서
        네 변 중 절반이 이 경우다 (`config.yaml` §작업대 셋: 접촉 틈 0.0mm)."""
        for o in boxes:
            if o is b:
                continue
            (ax0, ax1), (ay0, ay1) = o["xMm"], o["yMm"]
            if ax0 - TOUCH_MM <= mid[0] <= ax1 + TOUCH_MM and ay0 - TOUCH_MM <= mid[1] <= ay1 + TOUCH_MM:
                return o["name"]
        return None

    out, skipped = [], []
    for b in boxes:
        (x0, x1), (y0, y1), z = b["xMm"], b["yMm"], b["topZMm"]
        for name, a, c in ((f"{b['name']} 앞변", (x0, y0), (x1, y0)),
                           (f"{b['name']} 뒷변", (x0, y1), (x1, y1)),
                           (f"{b['name']} 왼변", (x0, y0), (x0, y1)),
                           (f"{b['name']} 오른변", (x1, y0), (x1, y1))):
            mid = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
            who = interior(b, mid)
            if who:
                skipped.append(f"{name}→{who}")
                continue
            n = max(2, int(np.hypot(c[0] - a[0], c[1] - a[1]) / STEP_MM))
            t = np.linspace(0, 1, n)
            out.append((name, [(a[0] + (c[0] - a[0]) * s, a[1] + (c[1] - a[1]) * s, z) for s in t]))
    if skipped:
        print(f"  물려 있어 건너뛴 변 {len(skipped)}개: {' · '.join(skipped)}")
    return out


def make_projector(cal, K, dist):
    U = np.array([-401.846, 497.329, 342.076])   # user1 원점의 base 좌표 (coordDefs.user)
    rv, tv = np.array(cal["rvec"], float), np.array(cal["tvecMm"], float)

    def px(pts, yaw, tx, ty, dz=0.0):
        th = np.radians(yaw)
        Rz = np.array([[np.cos(th), -np.sin(th), 0], [np.sin(th), np.cos(th), 0], [0, 0, 1]])
        t = np.array([tx, ty, 0.0])
        P = np.array([(Rz @ (np.array([p[0], p[1], p[2] + dz]) + U)) + t for p in pts], float)
        return cv2.projectPoints(P, rv, tv, K, dist)[0].reshape(-1, 2)
    return px


def find_edges(img, px, edges, yaw, tx, ty):
    """투영선 **수직 방향**으로 훑어 밝기 기울기가 제일 큰 자리를 모서리로 본다."""
    g = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (5, 5), 0).astype(float)
    H, W = g.shape
    obs, per = [], {}
    ts = np.arange(-SEARCH_PX, SEARCH_PX + 0.5, 1.0)
    for name, pts in edges:
        q = px(pts, yaw, tx, ty)
        d = np.gradient(q, axis=0)
        n = np.stack([-d[:, 1], d[:, 0]], 1)
        n /= (np.linalg.norm(n, axis=1, keepdims=True) + 1e-9)
        got = 0
        for w, p, nv in zip(pts, q, n):
            if not (12 < p[0] < W - 12 and 12 < p[1] < H - 12):
                continue
            xy = p[None, :] + nv[None, :] * ts[:, None]
            if xy[:, 0].min() < 0 or xy[:, 0].max() > W - 1 or xy[:, 1].min() < 0 or xy[:, 1].max() > H - 1:
                continue
            prof = g[xy[:, 1].astype(int), xy[:, 0].astype(int)]
            k = int(np.argmax(np.abs(np.gradient(prof))))
            if abs(ts[k]) > SEARCH_PX - 5:      # 훑은 끝에서 잡혔다 = 모서리가 아니다
                continue
            obs.append((w, p + nv * ts[k], nv, name))
            got += 1
        per[name] = got
    return obs, per


def rms(r):
    """**이상점을 빼고 본다** — 상판 가장자리에 물건이 있으면 그 점은 물건 윤곽을 잡는다."""
    if len(r) == 0:
        return float("nan"), 0
    m = np.abs(r) < np.median(np.abs(r)) * OUTLIER_K + 3.0
    return float(np.sqrt((r[m] ** 2).mean())), int((~m).sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("FR5_CAM_HOST", "").strip() or None,
                    help="폰 주소 (기본: FR5_CAM_HOST)")
    ap.add_argument("--shot", default=None, help="저장된 사진으로 (스트림 대신)")
    ap.add_argument("--apply", action="store_true", help="yaw·x·y 를 robot-base-in-tag.json 에 쓴다")
    a = ap.parse_args()
    if not a.host and not a.shot:
        sys.exit("폰 주소가 없다 — FR5_CAM_HOST 를 설정하거나 --shot 을 줘라")

    cam = json.loads(CONF.read_text(encoding="utf-8"))
    B = json.loads(BASE.read_text(encoding="utf-8"))
    I, E = cam.get("intrinsics"), cam.get("labToCam")
    if not I or not E:
        sys.exit("아직 안 풀렸다 — scripts/map/extrinsics.py 부터")
    img = frame(a.host, a.shot)
    H, W = img.shape[:2]
    # 해상도가 달라도 **비례**로 메운다 — 폰이 자르지 않고 줄이기만 하는 것을 실측으로 확인했다
    # (2560/1920/1280 에서 카메라 위치 2.7mm·0.5mm 차이 · 2026-08-19)
    sx, sy = W / I["widthPx"], H / I["heightPx"]
    if abs(sx - sy) > 0.01:
        sys.exit(f"가로세로비가 다르다 {W}x{H} — 잘린 영상은 못 쓴다")
    K = np.array([[I["fx"] * sx, 0, I["cx"] * sx], [0, I["fy"] * sy, I["cy"] * sy], [0, 0, 1]])
    dist = np.array(I["dist"])
    px = make_projector(E, K, dist)
    edges = top_edges(yaml.safe_load(PROFILE.read_text(encoding="utf-8")))
    obs, per = find_edges(img, px, edges, B["yawDeg"], B["xMm"], B["yMm"])
    # ── 변 단위로 거른다 — **한 변이 통째로 틀리면 점 몇 개 빼는 걸로는 못 막는다.**
    # 가려졌거나(팔·터틀봇) 옆 물건 윤곽을 잡은 변은 점들이 **한 방향으로 몰려** 어긋난다.
    # 지금 자세로 재서 중앙값이 나쁜 변은 아예 뺀다 — 그 변은 이 프레임에서 «안 보이는 것»이다.
    if obs:
        base = [float(np.dot(p - o[1], o[2]))
                for p, o in zip(px([o[0] for o in obs], B["yawDeg"], B["xMm"], B["yMm"]), obs)]
        byedge = {}
        for (o, e) in zip(obs, base):
            byedge.setdefault(o[3], []).append(abs(e))
        # 점이 몇 개뿐인 변은 **잰 게 아니다** — 가려졌거나 화면 끝에 걸쳤다
        thin = [k for k, v in byedge.items() if len(v) < MIN_EDGE_PTS]
        if thin:
            print(f"  점이 적어 뺀 변 {len(thin)}개: " + " · ".join(f"{k}({len(byedge[k])}점)" for k in thin))
            obs = [o for o in obs if o[3] not in thin]
            byedge = {k: v for k, v in byedge.items() if k not in thin}
        med = {k: float(np.median(v)) for k, v in byedge.items()}
        keep = float(np.median(list(med.values()))) * 2.5 + 8.0
        bad = [k for k, v in med.items() if v > keep]
        if bad:
            print(f"  변 단위로 뺀 것 {len(bad)}개: " + " · ".join(f"{k}({med[k]:.0f}px)" for k in bad))
            obs = [o for o in obs if o[3] not in bad]
    print(f"프레임 {W}x{H} (배율 {sx:.3f}) · 모서리 후보 {len(obs)}점")
    for k, v in per.items():
        if v:
            print(f"    {k:22} {v:3d}점")
    if len(obs) < MIN_PTS:
        sys.exit(f"점이 {len(obs)}개뿐이다 (최소 {MIN_PTS}) — 정합이 크게 틀어졌으면 extrinsics.py 가 먼저다")

    P0 = [o[0] for o in obs]

    def resid(yaw, tx, ty, dz=0.0):
        q = px(P0, yaw, tx, ty, dz)
        return np.array([float(np.dot(p - o[1], o[2])) for p, o in zip(q, obs)])

    from scipy.optimize import least_squares
    cur = [B["yawDeg"], B["xMm"], B["yMm"]]
    r0, n0 = rms(resid(*cur))
    s1 = least_squares(lambda p: resid(p[0], p[1], p[2]), cur)
    r1, n1 = rms(resid(*s1.x))
    s2 = least_squares(lambda p: resid(p[0], p[1], p[2], p[3]), cur + [0.0])
    r2, n2 = rms(resid(*s2.x))
    print(f"\n{'':22} {'yaw':>8} {'x':>8} {'y':>9} {'상판 z 보정':>11} {'RMS':>8}")
    print(f"{'지금':22} {cur[0]:8.2f} {cur[1]:8.1f} {cur[2]:9.1f} {'—':>11} {r0:6.1f}px (뺀 점 {n0})")
    print(f"{'맞춤 (yaw·x·y)':22} {s1.x[0]:8.2f} {s1.x[1]:8.1f} {s1.x[2]:9.1f} {'—':>11} {r1:6.1f}px (뺀 점 {n1})")
    print(f"{'참고 (+상판 높이)':22} {s2.x[0]:8.2f} {s2.x[1]:8.1f} {s2.x[2]:9.1f} {s2.x[3]:+10.1f} {r2:6.1f}px (뺀 점 {n2})")
    if abs(s2.x[3]) > 5:
        print(f"\n  ⚠ 상판이 실제보다 {abs(s2.x[3]):.0f}mm {'높게' if s2.x[3] < 0 else '낮게'} 그려지고 있다.")
        print("    `config.yaml` 의 `topZMm` 은 **일부러 위로 잡은 안전선**이라 여기서 안 고친다.")
        print("    진짜 높이를 알려면 로봇으로 짚는다 — scripts/robot/table-probe.py --points 8")
    if not a.apply:
        print("\n  아무것도 안 썼다. 쓰려면 --apply")
        return 0
    if r1 >= r0:
        print(f"\n  ⛔ 안 쓴다 — 맞춰도 안 좋아진다 ({r0:.1f} → {r1:.1f}px)")
        return 1
    B["_옛값들"] = (B.get("_옛값들", []) + [f"{B['measuredAt']}: yaw {B['yawDeg']} · x {B['xMm']} · y {B['yMm']}"])[-5:]
    B["xMm"], B["yMm"], B["yawDeg"] = round(float(s1.x[1]), 1), round(float(s1.x[2]), 1), round(float(s1.x[0]), 2)
    B["measuredAt"] = __import__("datetime").date.today().isoformat()
    B["source"] = f"scripts/map/edge-fit.py — 모서리 {len(obs)}점 · RMS {r0:.1f} → {r1:.1f}px"
    BASE.write_text(json.dumps(B, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n  ✅ 썼다 — {BASE.relative_to(ROOT)}  (RMS {r0:.1f} → {r1:.1f}px)")
    print("     배포: scp Shared/data/config/robot-base-in-tag.json <호스트>:FR5Web/Shared/data/config/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
