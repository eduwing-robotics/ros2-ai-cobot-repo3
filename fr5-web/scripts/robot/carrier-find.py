#!/usr/bin/env python3
"""손목 뎁스로 **총알 거치대가 지금 어디 있나**를 찾는다 (2026-09-03).

## 왜 만드나

`props.js` 가 거치대 자리를 **일부러 저장하지 않는다** — *"태그 옆 100mm 안에서 매번
달라진다. 그래서 「어디 있나」는 저장하지 않고 **손목 뎁스가 매번 찾는다**"*.
그런데 **그 찾는 코드가 0줄이었다.** 그래서 시뮬 8칸이 08-31 에 사람이 드래그 티칭으로
문 **한 자리**에 얼어붙어 있었고, 2026-09-03 실측에서 그 자리는 태그 15 에서 **139.8mm**
떨어져 있었다(정본이 말한 100mm 밖). 이 파일이 그 구멍을 메운다.

## 새로 짠 것이 거의 없다 — 있는 것을 쓴다 (하드 룰 5)

  평면·덩어리 찾기   `depth-probe.py` — 「판 위로 솟은 것」을 이미 한다
  카메라 → 로봇     `FR5/bridge/follow.py` `cam_to_robot` — 변환의 정본
  치수 판정선       `Shared/data/props.js` `CARRIER` — 여기 숫자를 다시 적지 않는다

## ⛔ 이 값으로 «집지» 마라 — 지금은 그럴 정확도가 아니다

2026-09-03 교차 검증: 손목 사슬과 글로벌캠 사슬이 **45.9mm** 어긋났다. 1순위 용의자는
`handEye` 에 **회전이 없다**는 것이다(평행이동 셋뿐 · `follow.cam_to_robot` 이 카메라 축 =
손끝 축을 전제한다). 거치대를 바구니에 넣을 때 남는 여유가 한쪽 **17.5mm** 이므로
**이 자리를 파지 좌표로 쓰면 못 집는다.**

그래서 이 도구가 지금 답하는 질문은 **「거기 있나 · 대략 어디쯤인가」**이지
**「어디를 물어야 하나」가 아니다.** 후자는 hand-eye 회전이 붙은 뒤에 열린다.
⛔ **그때까지 이 값을 `CARRIER_GRASP_TRUTH` 에 밀어 넣지 않는다.**

## 안 하는 것 — 파일을 안 쓴다

찾은 자리를 어디에도 저장하지 않는다. 정본에 박는 것은 사람이 보고 고르는 일이고,
저장한 값은 **얼어붙는다**(그 얼어붙음이 애초에 이 도구가 생긴 이유다).

    python3 scripts/robot/carrier-find.py
    python3 scripts/robot/carrier-find.py --json
    python3 scripts/robot/carrier-find.py --png shot.png     # 받아 둔 프레임으로
"""
import argparse
import json
import sys
import urllib.request
from importlib import util as _util
from pathlib import Path

import numpy as np
import cv2

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))
sys.path.insert(0, str(ROOT / "scripts/dev"))
from host import require as _require          # noqa: E402  (경로 주입 뒤에 온다)
import follow                                 # noqa: E402  변환의 정본

# 파일명에 `-` 가 있어 importlib 로 연다 (`handeye-probe.py` 와 같은 방법)
_spec = _util.spec_from_file_location("dprobe", Path(__file__).with_name("depth-probe.py"))
dp = _util.module_from_spec(_spec)
_spec.loader.exec_module(dp)

# ── 판정선 — **숫자는 `props.js` 가 정본이다.** 여기서는 «허용 폭»만 정한다 ──────────
# 실물 69 × 85 × 55(자 · 실기 담당자 08-31). ⚠ 2026-09-03 뎁스는 높이를 **47.3mm**(std 0.8)로
# 냈다 — 자와 7.7mm 갈린다(미해결). 그래서 높이 창을 **둘 다 품게** 넓게 연다.
FOOT_TOL = 0.45      # 발자국 허용 ±45% — 뎁스 덩어리 경계는 무르다(경사면이 잘린다)
H_MIN_MM, H_MAX_MM = 30.0, 75.0
CHAIN_ERR_MM = 45.9  # 2026-09-03 손목↔글로벌캠 교차 실측. **고지용** — 판정에 안 쓴다
HULL_WIN_PX = 70     # 껍질에 넣을 솟은 점의 범위(덩어리 중심 ± px) — 300mm 에서 ±60mm · 거치대 반대각 55 를 덮는다


def load_props():
    """`CARRIER` 치수를 **정본 파일에서** 읽는다 — 여기 숫자를 베끼지 않는다."""
    import re
    t = (ROOT / "Shared/data/props.js").read_text(encoding="utf-8")
    m = re.search(r"CARRIER\s*=\s*\{(.*?)\n\}", t, re.S)
    if not m:
        raise SystemExit("⛔ props.js 에서 CARRIER 를 못 찾았다")
    g = lambda k: float(re.search(rf"\b{k}\s*:\s*(-?\d+(?:\.\d+)?)", m.group(1)).group(1))  # noqa: E731
    return g("wMm"), g("dMm"), g("hMm")


def get(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def deproject(u, v, z_mm, K):
    """화소 → 카메라 좌표(mm). 뎁스 내부파라미터는 브리지가 준다 (`/api/camera/info`)."""
    return [(u - K["ppx"]) * z_mm / K["fx"], (v - K["ppy"]) * z_mm / K["fy"], z_mm]


def find(z, K, wMm, dMm, roi=None, mode="raised", h_range=(H_MIN_MM, H_MAX_MM)):
    """판 위로 **솟은**(`raised`) 또는 **파인**(`sunken` · 2026-09-07 · 바구니 바닥) 덩어리 중
    **치수에 드는 것**을 고른다. 반환 `(후보들, 사유)`. 파임 분기는 잔차 부호만 뒤집는다 — 풀이는 하나다.

    ⛔ **하나로 못 좁히면 안 고른다.** 둘 이상이 판정선에 들면 전부 돌려주고 사람이 본다 —
    「제일 큰 것」을 집는 코드는 목록이 자라면 지뢰가 된다 (D149 가 그 자리다).
    """
    # ⛔ **판이 둘이면 평면 하나로는 한쪽이 통째로 빠진다** (2026-09-03 실측 — 터틀봇이 선
    # 검은 매트와 거치대가 놓인 흰 판이 다른 높이라, 주 평면의 지지영역 밖으로 거치대가
    # 나갔다). `--roi` 로 좁히면 **그 안이 주 평면**이 되어 잡힌다. 근본 해결(다중 평면)은
    # 아직 없다 — 그래서 좁히는 것을 «해결» 이라 부르지 않고 옵션으로 둔다.
    off = (0, 0)
    if roi:
        x0, y0, x1, y1 = roi
        z = z[y0:y1, x0:x1]
        off = (x0, y0)
    valid = z > 0
    if valid.sum() < 500 or valid.mean() < 0.20:
        far = float(z[valid].max()) if valid.any() else 0.0
        why = f"깊이가 거의 없다 ({100*valid.mean():.1f}%)"
        # ⭐ **shift 50 을 여기서 짚는다** — 그 설정은 425mm 밖을 통째로 못 본다.
        # 2026-09-03 에 이걸 몰라 「카메라 고장」으로 반나절을 갈 뻔했다.
        if 0 < far <= 440:
            why += (f" · 유효분이 {far:.0f}mm 에서 끊긴다 — **`disparity_shift` 가 0 이 아니다**"
                    "(총알 근접용 50). 먼 거리를 보려면 0 으로 두고 다시 찍는다")
        return [], why

    plane, inliers, _ = dp.fit_plane(z, valid, want_coef=True)
    if plane is None:
        return [], "평면(판)을 못 맞췄다 — 카메라가 판을 안 보고 있다"
    resid = np.where(valid, plane - z, np.nan)
    rms = float(np.sqrt(np.nanmean(resid[inliers] ** 2)))
    thr = max(dp.RAISE_MM, dp.RAISE_SIGMA * rms)
    if mode == "sunken":
        resid = -resid                      # 파인 것을 「솟은 것」으로 뒤집어 같은 길을 태운다
    raised = valid & dp.plane_support(inliers) & (resid > thr)
    h_min, h_max = h_range

    out = []
    for blob in dp.all_blobs(raised):
        zb = z[blob & valid]
        if zb.size < dp.MIN_AREA_PX:
            continue
        zmid = float(np.median(zb))
        size = dp.blob_size_mm(blob, zmid)
        if not size:
            continue
        # `blob_size_mm` 은 **PCA 주축**으로 긴축·짧은축을 준다 (bbox 가 아니다 — 그쪽은
        # 물건이 비스듬하면 대각선을 감싸 자세를 탄다). 발자국 판정은 그 둘로 한다.
        a, b = sorted([size["shortMm"], size["longMm"]])
        want = sorted([wMm, dMm])
        fits_foot = all(abs(m - w) <= w * FOOT_TOL for m, w in zip((a, b), want))
        h = float(np.nanpercentile(resid[dp.core(blob)], 95))
        fits_h = h_min <= h <= h_max
        ys, xs = np.nonzero(blob)
        cu, cv = float(xs.mean()) + off[0], float(ys.mean()) + off[1]
        # ⭐ **요각·치수는 볼록 껍질 사각형으로** (2026-09-07 실기). 거치대 윗면은 구멍·총알로 마스크가 비어 PCA 장축이 프레임마다 86° 나 뒤집혔다
        #    (105° vs 19° · 같은 물체 · 손목 5° 차). 덩어리 근처(±70px)의 **모든 솟은 점**(테두리 꼭대기 45mm+ 포함)의 볼록 껍질에 minAreaRect 를 대면
        #    바깥 윤곽 78~85×98~101(69×85+번짐)이 나오고 각이 두 프레임에서 손목 회전만큼만 움직였다(175.9→171.1 · rz −175→−170). 요각 규약 θ+rz 검증
        hys, hxs = np.nonzero(raised)
        near = (np.abs(hxs - (cu - off[0])) < HULL_WIN_PX) & (np.abs(hys - (cv - off[1])) < HULL_WIN_PX)
        hull_size, hull_axis = None, None
        if near.sum() >= 20:
            hull = cv2.convexHull(np.column_stack([hxs[near], hys[near]]).astype(np.float32))
            (_, _), (hw, hh), hang = cv2.minAreaRect(hull)
            if hw > 0 and hh > 0:
                mmpx = zmid / K["fx"]
                hull_size = [round(min(hw, hh) * mmpx, 1), round(max(hw, hh) * mmpx, 1)]
                hull_axis = round((-(hang if hw >= hh else hang + 90.0)) % 180.0, 1)   # 화면 y-down → y-up(`blob_size_mm` 와 같은 규약)
        out.append({
            "hullSizeMm": hull_size, "hullAxisDeg": hull_axis,
            "areaPx": int(blob.sum()), "sizeMm": [round(a, 1), round(b, 1)],
            "longAxisDeg": size["longAxisDeg"],
            "heightMm": round(h, 1), "zMm": round(zmid, 1),
            "px": [round(cu, 1), round(cv, 1)],
            "camMm": [round(v, 1) for v in deproject(cu, cv, zmid, K)],
            "fits": bool(fits_foot and fits_h),
            "why": ("크기·높이 판정선 안" if fits_foot and fits_h
                    else ("발자국이 안 맞는다" if not fits_foot else "높이가 안 맞는다")),
        })
    out.sort(key=lambda c: (not c["fits"], -c["areaPx"]))
    return out, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", help="브리지 대신 이 파일을 읽는다")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--roi", help="x0,y0,x1,y1 — 판이 둘일 때 한쪽으로 좁힌다")
    ap.add_argument("--avg", type=int, default=5, help="이 장수를 화소별 평균 (기본 5)")
    a = ap.parse_args()

    wMm, dMm, _hMm = load_props()
    if a.png:
        from PIL import Image
        z = np.asarray(Image.open(a.png)).astype(np.float32)
        K = {"fx": dp.FX848, "fy": dp.FY848, "ppx": dp.CX848, "ppy": dp.CY848}
        st = None
    else:
        info = get(_require(5058, "/api/camera/info", "카메라 브리지"))
        K = info.get("depthIntrinsics")
        if not K:
            raise SystemExit("⛔ /api/camera/info 에 depthIntrinsics 가 없다 — 카메라가 안 붙었다")
        raw, _note = dp.fetch_avg(_require(5058, "/api/camera/depth/frame", "카메라 브리지"), a.avg)
        z = raw.astype(np.float32)
        st = get(_require(5055, "/state"))

    roi = tuple(int(v) for v in a.roi.split(",")) if a.roi else None
    cands, why = find(z, K, wMm, dMm, roi)
    picked = [c for c in cands if c["fits"]]

    # ── 카메라 좌표 → 로봇 좌표. **변환은 follow.py 가 한다** (하드 룰 5) ──────────
    for c in picked:
        if not st:
            c["user1Mm"], c["poseWhy"] = None, "프레임 파일 모드 — 손끝 자세가 없어 못 옮긴다"
            continue
        he = (st.get("handEye") or {}).get("tMm")
        p, reason = follow.cam_to_robot(c["camMm"], st.get("tcpMmDeg"), he)
        c["user1Mm"] = [round(v, 1) for v in p] if p else None
        c["poseWhy"] = reason

    if a.json:
        print(json.dumps({"candidates": cands, "picked": picked, "reason": why,
                          "chainErrMm": CHAIN_ERR_MM}, ensure_ascii=False, indent=1))
        return 0

    print(f"== 총알 거치대 찾기 == (판정선 {wMm:.0f}×{dMm:.0f}mm ±{FOOT_TOL:.0%} · "
          f"높이 {H_MIN_MM:.0f}~{H_MAX_MM:.0f}mm)")
    if why:
        print(f"  ⛔ {why}")
        return 1
    if not cands:
        print("  솟은 것이 없다 — 카메라가 판만 보고 있다")
        return 1
    for c in cands[:6]:
        mark = "✅" if c["fits"] else "  "
        u = c.get("user1Mm")
        print(f"  {mark} {c['sizeMm'][0]:5.1f}×{c['sizeMm'][1]:5.1f}mm · 높이 {c['heightMm']:5.1f}"
              f" · 거리 {c['zMm']:5.0f}mm · {c['areaPx']:6d}px"
              + (f"  → user1 [{u[0]:.1f}, {u[1]:.1f}, {u[2]:.1f}]" if u else "")
              + (f"   ({c['why']})" if not c["fits"] else ""))
        if c["fits"] and not u and c.get("poseWhy"):
            print(f"       ⛔ 로봇 좌표로 못 옮겼다 — {c['poseWhy']}")

    if len(picked) == 0:
        print("\n  ⛔ 판정선에 드는 것이 없다 — 거치대가 시야 밖이거나 크기가 정본과 다르다")
        return 1
    if len(picked) > 1:
        print(f"\n  ⛔ 판정선에 **{len(picked)}개**가 든다 — 하나로 못 좁혔다. 고르지 않는다")
        return 1

    print(f"\n  하나 찾았다 — user1 {picked[0].get('user1Mm')}")
    print(f"  ⛔ **이 값으로 집지 마라.** 손목↔글로벌캠 사슬이 {CHAIN_ERR_MM}mm 어긋나 있고"
          " (hand-eye 에 회전이 없다), 바구니 여유는 한쪽 17.5mm 다.")
    print("     지금 답한 것은 「거기 있나·대략 어디쯤인가」이지 「어디를 물어야 하나」가 아니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
