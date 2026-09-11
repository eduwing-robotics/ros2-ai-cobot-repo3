#!/usr/bin/env python3
"""글로벌캠 영상에서 **색으로 거치대를 찾는다** — 태그를 안 붙여도 된다 (2026-09-04).

    python3 scripts/map/color-find.py                 # 한 번 찾아 보고만 한다
    python3 scripts/map/color-find.py --json
    python3 scripts/map/color-find.py --watch --push <호스트경로>   # 상주 · 파일로 낸다

## 왜 만드나 — 주인님 *"애초에 글로벌캠에 잡히는데"* (2026-09-04)

그날 화면은 이랬다: 폰 영상에 **분홍 거치대가 또렷이 보이는데** 팔은 엉뚱한 데를 봤다.
이유는 하나였다 — **우리 코드가 그 영상에서 태그만 찾았다.** 색·형상으로 물건을 찾는
코드가 0줄이라 「보이는데 못 본다」가 됐고, 그래서 표적이 물건이 아니라 **종이 태그**였다.
태그는 물건에 안 붙어 있어서, 물건을 옮겨도 팔은 안 따라갔다.

⭐ **id 15 는 그대로 쓴다.** `tags.json` 이 id 15 를 *"거치대1 원료(탄두·탄피 분리)"* 로
정의하므로 그 번호는 **「어느 물건인가」**이지 「어떻게 찾았나」가 아니다. 센서만 바뀐다 —
그래서 추종 쪽 코드가 한 줄도 안 바뀐다(`targetSource` 만 고른다).

## 자리를 어떻게 내나 — **평면에 쏜다**

색은 2차원이라 깊이가 없다. 그래서 화소를 광선으로 펴서 **거치대 윗면 평면**과 만나게 한다.
평면 높이는 **태그가 알려 준다** — 같은 판에 누운 태그의 lab z 에 거치대 키를 더한다.

⛔ **그래서 이 값은 거치대 「윗면 중심」이지 파지점이 아니다.** 파지는 여전히 손목 뎁스가
맡는다 — 이건 **거친 조준**이고, 그 정확도로 집으려 들면 안 된다.

## ⛔ 색만 믿지 않는다

2026-09-03 에 초록 바구니를 색으로 찾다 **매트 전체가 마스크로 번졌다**(71,955px 오검출).
그래서 여기는 셋을 같이 건다 — **색 · 최소 면적 · 일감 구역 안**. 배경(사람 옷·다른 책상)이
같은 색이어도 구역 밖이라 떨어진다. 오늘 실측: 분홍 후보 6덩어리 중 **구역 안은 하나**.

## 한계 (ponytail)

**한 덩어리만 낸다** — 같은 색 물건이 구역 안에 둘이면 큰 쪽을 고른다. 둘을 갈라야 하는
날이 오면 그때 크기·모양을 판정에 넣는다. 지금은 거치대가 하나뿐이다.
"""
import argparse
import re
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))

TAG_ID = "15"          # `tags.json` §fixtureTags — 「거치대1 원료」. 센서가 바뀌어도 물건은 같다
MIN_AREA_PX = 600      # 이보다 작으면 물건이 아니다 (오늘 실측 4804px)
# 분홍/마젠타. OpenCV H 는 0~179 라 빨강 쪽 양끝을 같이 본다
HSV_LO_HI = (((150, 80, 90), (179, 255, 255)), ((0, 80, 90), (8, 255, 255)))


def get(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


# 갈라진 윗면을 다시 붙이는 커널 (2026-09-07 실측 — 거치대 윗면이 손잡이·총알로 **두 덩어리**(37×37 · 42×32px · 면적 ~910 vs ~930)로 갈라져
# 「제일 큰 것」이 매 틱 갈아탔다: 트윈에서 거치대가 46px(≈45mm) 씩 튀고 요각이 −3↔84 로 뒤집혔다). 21px 닫기로 한 덩어리(2761px)가 된다
CLOSE_PX = 21
# 카트 덱(camLab z=0) 은 base z −3.7 — `Shared/data/frames.js` EDGES camLab→base 의 유도값. 여기서 다시 재지 않는다
CAMLAB_ABOVE_BASE_MM = 3.7
# 장축/단축이 이보다 작으면 요각은 **모른다** — 정사각에 가까운 마스크의 minAreaRect 각은 잡음으로 90° 뒤집힌다. 지어내지 않고 null
YAW_MIN_ASPECT = 1.15
# 이력 — 직전 자리에서 이 화소 안의 덩어리를 **먼저** 고른다(크기보다). 두 물건이 있어도 매 틱 갈아타지 않는다
STICKY_PX = 80.0
_last_px = None


def pink_mask(img):
    """분홍 마스크 **한 벌** — `find_px` 와 `locate` 가 같은 마스크를 본다(전엔 둘이 각자 만들었다)."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m = np.zeros(hsv.shape[:2], np.uint8)
    for lo, hi in HSV_LO_HI:
        m |= cv2.inRange(hsv, np.array(lo, np.uint8), np.array(hi, np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((CLOSE_PX, CLOSE_PX), np.uint8))
    return m


def find_px(img):
    """색 덩어리 중 **제일 큰 것**의 중심 화소와 크기. 못 찾으면 `(None, 사유)`."""
    m = pink_mask(img)
    num, lab, stats, cent = cv2.connectedComponentsWithStats(m, 8)
    cands = [(stats[i, cv2.CC_STAT_AREA], i) for i in range(1, num)
             if stats[i, cv2.CC_STAT_AREA] >= MIN_AREA_PX]
    if not cands:
        return None, f"그 색 덩어리가 없다 (최소 {MIN_AREA_PX}px)"
    return sorted(cands, reverse=True), None


def to_lab(px, cal, img_w, z_plane):
    """화소 → lab. **평면에 쏜다** (위 §자리를 어떻게 내나)."""
    K0, E = cal["intrinsics"], cal["labToCam"]
    s = img_w / K0["widthPx"]                      # 사진이 캘리브보다 작게 온다 (실측 0.75)
    K = np.array([[K0["fx"] * s, 0, K0["cx"] * s],
                  [0, K0["fy"] * s, K0["cy"] * s], [0, 0, 1]])
    dist = np.array(K0["dist"], float).ravel()
    R, _ = cv2.Rodrigues(np.array(E["rvec"], float))
    C = -R.T @ np.array(E["tvecMm"], float)        # 카메라 중심 (lab)
    und = cv2.undistortPoints(np.array([[list(px)]], float), K, dist)[0, 0]
    d = R.T @ np.array([und[0], und[1], 1.0])
    if abs(d[2]) < 1e-9:
        return None, "광선이 평면과 나란하다 — 못 푼다"
    return C + (z_plane - C[2]) / d[2] * d, None


def setup(host):
    """한 번만 받는 재료. **상주가 매 판 다시 받지 않게** 갈라 둔다."""
    import re
    b = f"http://{host}"
    pj = ROOT / "Shared/data/props.js"
    if not pj.exists():
        # ⛔ 정본이 없으면 **키를 지어내지 않는다** — 틀린 높이로 평면에 쏘면 자리가 통째로 틀린다
        raise FileNotFoundError(f"거치대 키의 정본이 없다 — {pj} (배포 목록에 넣는다)")
    t = pj.read_text(encoding="utf-8")
    blk = re.search(r"CARRIER\s*=\s*\{(.*?)\n\}", t, re.S).group(1)
    h_mm = float(re.search(r"\bhMm\s*:\s*(-?[\d.]+)", blk).group(1))
    return {"b": b, "hMm": h_mm,
            "cal": get(f"{b}/config/global-cam.json"),
            "base": get(f"{b}/config/robot-base-in-tag.json"),
            "boxes": [x for x in ((get(f"{b}/state").get("workspace") or {}).get("boxes") or [])
                      if "작업대" in str(x.get("name", ""))]}


def locate(ctx, cam=None):
    """지금 한 판 찾는다 → `(hit, 사유)`. **브리지 상주와 CLI 가 이 하나를 같이 쓴다.**"""
    import fixture                                  # noqa: PLC0415 — 경로 주입 뒤에 온다
    b = ctx["b"]
    anc = get(f"{b}/config/scene-anchors.json")["anchors"]
    if TAG_ID not in anc:
        return None, f"평면 높이를 줄 태그 id{TAG_ID} 를 앵커가 모른다"
    cam = cam or anc[TAG_ID]["shot"].split("/")[0]
    user = get(f"{b}/state")["coordDefs"]["user"]
    # ⭐ 평면 높이는 **상판 SSOT** 에서 (2026-09-07). 전엔 태그 15 앵커 z + 거치대 키였는데 그 앵커 z 가 판보다 32mm 낮게 잡혀
    #    검출 「윗면」이 상판 아래로 나오고(트윈이 뚫림) 비스듬한 시선 때문에 xy 도 ~38mm 밀렸다. 상판(user1 −334 실측) + 패드 + 키 →
    #    base(user1 원점 z) → camLab(카트 덱 = base +3.7 · `frames.js` camLab→base z 오프셋). 정본을 못 읽으면 옛 방식으로 가되 note 에 남긴다
    plane_note = "상판 SSOT"
    try:
        wc = (ROOT / "Shared/data/workcell.js").read_text(encoding="utf-8")
        top = float(re.search(r"TABLE_TOP_REAL_ZMM\s*=\s*(-?[\d.]+)", wc).group(1))
        pad_m = re.search(r"thicknessMm:\s*(null|-?[\d.]+)", wc.split("TABLE_PADS")[1])
        pad = 0.0 if pad_m is None or pad_m.group(1) == "null" else float(pad_m.group(1))
        z_plane = (top + pad + ctx["hMm"] + float(user[2])) + CAMLAB_ABOVE_BASE_MM
        if pad == 0.0:
            plane_note += " · 패드 두께 미측(0 으로)"
    except Exception as e:                                       # noqa: BLE001 — 정본 없음은 사유를 남기고 옛 길
        z_plane = float(anc[TAG_ID]["labMm"][2]) + ctx["hMm"]
        plane_note = f"태그{TAG_ID} 앵커 z(낡을 수 있음) — SSOT 못 읽음 {type(e).__name__}"
    with urllib.request.urlopen(f"http://{cam}/shot.jpg", timeout=10) as r:
        img = cv2.imdecode(np.frombuffer(r.read(), np.uint8), cv2.IMREAD_COLOR)
    cands, why = find_px(img)
    if not cands:
        return None, why
    global _last_px
    m = pink_mask(img)
    _, lab, _, cent = cv2.connectedComponentsWithStats(m, 8)
    # 이력 우선 — 직전 자리 STICKY_PX 안의 후보를 앞으로 (없으면 크기순 그대로)
    if _last_px is not None:
        cands = sorted(cands, key=lambda ai: (float(np.hypot(*(cent[ai[1]] - np.array(_last_px)))) > STICKY_PX, -ai[0]))
    for area, i in cands:
        p_lab, e = to_lab(cent[i], ctx["cal"], img.shape[1], z_plane)
        if p_lab is None:
            continue
        u = fixture.lab_to_user1(p_lab, ctx["base"], user)
        # 요각 (2026-09-07 · VISION-CONTRACT §color `yawDeg`) — 덩어리 `minAreaRect` 두 축을 **같은 평면에 쏴**
        # user1 실거리로 장축을 다시 고른 뒤 atan2. 화소 길이를 믿으면 원근 때문에 장·단축이 뒤집힌다. 못 내면 None — 지어내지 않는다
        yaw = _yaw_user1(lab == i, cent[i], ctx, img.shape[1], z_plane, user, fixture)
        # ⛔ **일감 구역 밖은 버린다** — 배경에 같은 색이 널려 있다 (사람 옷·다른 책상)
        if any(bx["xMm"][0] <= u[0] <= bx["xMm"][1] and bx["yMm"][0] <= u[1] <= bx["yMm"][1]
               for bx in ctx["boxes"]):
            _last_px = (float(cent[i][0]), float(cent[i][1]))
            return {"labMm": [round(float(v), 1) for v in p_lab],
                    "user1Mm": [round(float(v), 1) for v in u],
                    "yawDeg": None if yaw is None else round(float(yaw), 1),
                    "px": [round(float(v), 1) for v in cent[i]],
                    "areaPx": int(area), "t": time.time(), "errPx": None,
                    "planeZLab": round(float(z_plane), 1), "planeNote": plane_note,
                    "note": "글로벌캠 색 검출 (분홍) · 태그 없이"}, None
    return None, f"그 색이 {len(cands)}덩어리 있지만 전부 일감 구역 밖이다 (배경)"


def _yaw_user1(mask, cent_px, ctx, img_w, z_plane, user, fixture):
    # `fixture` 는 `locate()` 가 경로 주입 뒤 늦게 import 한 모듈이라 **인자로 받는다** — 2026-09-07 실기에서 NameError 로 색 상주가 매 틱 죽었다
    """덩어리 장축 → user1 요각 `[−90, 90)`. 거치대(69×85)는 180° 대칭이라 반 바퀴로 접는다."""
    import math
    pts = np.column_stack(np.nonzero(mask))[:, ::-1].astype(np.float32)     # (x, y)
    if len(pts) < 20:
        return None
    (_, _), (w, h), ang = cv2.minAreaRect(pts)
    if w <= 0 or h <= 0:
        return None
    axes = []
    for px_len, deg in ((w, ang), (h, ang + 90.0)):
        a = math.radians(deg)
        ends = []
        for s in (-1.0, 1.0):
            q = (cent_px[0] + s * px_len / 2.0 * math.cos(a), cent_px[1] + s * px_len / 2.0 * math.sin(a))
            p_lab, _ = to_lab(q, ctx["cal"], img_w, z_plane)
            if p_lab is None:
                return None
            ends.append(fixture.lab_to_user1(p_lab, ctx["base"], user))
        dx, dy = ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]
        axes.append((math.hypot(dx, dy), math.degrees(math.atan2(dy, dx))))
    axes.sort(reverse=True)
    if axes[0][0] / axes[1][0] < YAW_MIN_ASPECT:
        return None                     # **실거리**가 정사각에 가까우면 장축이 잡음으로 뒤집힌다 — 모른다고 말한다
    yaw = axes[0][1]
    return ((yaw + 90.0) % 180.0) - 90.0


def write_out(path, hit, why):
    """산출은 **원자적으로** — 반쯤 쓴 파일을 브리지가 안 읽게."""
    doc = {"_": "글로벌캠 색 검출 — `color-find.py` 산출. **태그가 아니다**",
           "_주의": "거치대 **윗면 중심**이지 파지점이 아니다. 파지는 손목 뎁스가 맡는다",
           "anchors": ({TAG_ID: hit} if hit else {}), "why": why}
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("FR5_HOST_IP", ""), help="브리지 <ip> 또는 <ip:포트>")
    ap.add_argument("--cam", help="폰 <ip:포트> (기본: 앵커가 쓰는 것)")
    ap.add_argument("--height", type=float, default=None,
                    help="거치대 키(mm) — 기본은 props.js 의 CARRIER.hMm")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--watch", action="store_true", help="계속 돈다")
    ap.add_argument("--period", type=float, default=1.0)
    ap.add_argument("--out", help="이 경로에 쓴다 (`--watch` 의 산출)")
    a = ap.parse_args()
    if not a.host:
        print("⛔ 호스트를 모른다 — `eval \"$(bash scripts/dev/host.sh)\"` 뒤에 부른다"); return 1
    host = a.host if ":" in a.host else f"{a.host}:5055"
    b = f"http://{host}"

    ctx = setup(host)
    while True:
        try:
            hit, why = locate(ctx, a.cam)
            if a.json:
                print(json.dumps({"hit": hit, "why": why}, ensure_ascii=False))
            elif hit:
                print(f"분홍 거치대 user1 [{hit['user1Mm'][0]:.1f}, {hit['user1Mm'][1]:.1f}, "
                      f"{hit['user1Mm'][2]:.1f}] · {hit['areaPx']}px · 화소 {hit['px']}")
            else:
                print(f"⛔ 못 찾았다 — {why}")
            if a.out:
                write_out(a.out, hit, why)
        except Exception as e:                      # noqa: BLE001 — 상주는 한 번 실패로 안 죽는다
            print(f"⚠ {type(e).__name__}: {str(e)[:90]}", file=sys.stderr)
        if not a.watch:
            return 0
        time.sleep(a.period)


if __name__ == "__main__":
    raise SystemExit(main())
