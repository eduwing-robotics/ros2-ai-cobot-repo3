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
import zipfile
from io import BytesIO
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
# 실물 69 × 85 × 55(자 · 주인님 08-31). ⚠ 2026-09-03 뎁스는 높이를 **47.3mm**(std 0.8)로
# 냈다 — 자와 7.7mm 갈린다(미해결). 그래서 높이 창을 **둘 다 품게** 넓게 연다.
FOOT_TOL = 0.45      # 발자국 허용 ±45% — 뎁스 덩어리 경계는 무르다(경사면이 잘린다)
H_MIN_MM, H_MAX_MM = 30.0, 75.0
CHAIN_ERR_MM = 45.9  # 2026-09-03 손목↔글로벌캠 교차 실측. **고지용** — 판정에 안 쓴다
HULL_WIN_PX = 70     # (옛 고정 창 · 2026-09-07 저녁부터는 아래 mm 창을 깊이로 px 환산해 쓴다)
HULL_WIN_MM = 75     # 껍질 창 반폭(mm) — 거치대 80×100 의 반대각 64 + 여유. 깊이로 px 환산(356mm → ±90px · 300mm → ±106px)
MIN_FILL = 0.08      # 후보(조각 합친 면적)가 발자국 픽셀 면적의 이 비율보다 작으면 물체가 아니다 — 큰 물체 옆 부스러기(107~466px)가 껍질만 빌려 통과했다(자세 A 실기)
MERGE_MM = 25          # 껍질 중심이 이 안(mm)이면 같은 물체의 조각 — 거치대 짧은 변 80 의 1/4
YAW_MIN_ASPECT = 1.15  # 껍질 긴/짧은 비율이 이보다 작으면 요각을 모른다고 한다(색 검출과 같은 문턱)     # 껍질에 넣을 솟은 점의 범위(덩어리 중심 ± px) — 300mm 에서 ±60mm · 거치대 반대각 55 를 덮는다
RGBD_AVG_FRAMES = 9    # D218: 250mm 정지 자세 5장 3/7 → 9장 5/5. 문턱 대신 표본을 늘린다

# 정렬 컬러에서 분홍 거치대 안 황동 총알을 가르는 허용창(D207). 전역 색 찾기보다 좁은
# 깊이 ROI 안에서만 쓰므로 연한 분홍 테두리도 놓치지 않게 채도 하한을 낮춘다.
PINK_HSV = (((150, 25, 60), (179, 255, 255)), ((0, 25, 60), (8, 255, 255)))
# 황동은 정반사 하이라이트가 V=255까지 간다. 밝기 상한으로 자르면 한 총알이 조각나므로
# 색상·채도·면적·형상 관문만 쓴다(D217).
BRASS_HSV = ((5, 45, 50), (35, 255, 255))
BRASS_AREA_FRAC = (0.002, 0.08)   # 분홍 외곽 bbox 면적 대비. 여러 개면 전부 보고한다
BRASS_MEDIAN_S_MIN = 80            # 어두운 분홍 격자 반사(실측 중앙 S=58)를 황동으로 세지 않는다. 실제 총알 129·138.5


def load_props():
    """`CARRIER` 치수를 **정본 파일에서** 읽는다 — 여기 숫자를 베끼지 않는다."""
    import re
    t = (ROOT / "Shared/data/props.js").read_text(encoding="utf-8")
    m = re.search(r"CARRIER\s*=\s*\{(.*?)\n\}", t, re.S)
    if not m:
        raise SystemExit("⛔ props.js 에서 CARRIER 를 못 찾았다")
    g = lambda k: float(re.search(rf"\b{k}\s*:\s*(-?\d+(?:\.\d+)?)", m.group(1)).group(1))  # noqa: E731
    return g("wMm"), g("dMm"), g("hMm")


def footprint_fits(measured, wanted, clipped=False):
    """볼록 껍질 발자국이 정본 치수 창 안인지 판정한다."""
    return bool(measured and not clipped
                and all(abs(m - w) <= w * FOOT_TOL for m, w in zip(sorted(measured), sorted(wanted))))


def get(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def deproject(u, v, z_mm, K):
    """화소 → 해당 렌즈의 광학 좌표(mm). 내부 파라미터는 카메라 브리지가 준다."""
    return [(u - K["ppx"]) * z_mm / K["fx"], (v - K["ppy"]) * z_mm / K["fy"], z_mm]


def fetch_rgbd_avg(url, n):
    """동기화 ZIP `n`개를 받아 깊이는 결측 보존 평균, 컬러는 화소 중앙값으로 합친다."""
    depths, colors, stamps = [], [], []
    intrinsics = extrinsics = None
    for _ in range(n):
        with zipfile.ZipFile(BytesIO(dp.fetch(url))) as zf:
            if set(zf.namelist()) != {"manifest.json", "color.jpg", "depth.png"}:
                raise ValueError("RGB·깊이 ZIP 파일 구성이 계약과 다르다")
            meta = json.loads(zf.read("manifest.json"))
            if meta.get("alignment") != "depthToColor" or meta.get("depthUnit") != "mm":
                raise ValueError("RGB·깊이 정렬 또는 단위가 계약과 다르다")
            intr = meta.get("intrinsics")
            if not isinstance(intr, dict) or not all(k in intr for k in ("fx", "fy", "ppx", "ppy")):
                raise ValueError("RGB·깊이 묶음에 컬러 내부 파라미터가 없다")
            extr = meta.get("colorToDepth")
            if (not isinstance(extr, dict) or len(extr.get("rotationRowMajor") or []) != 9
                    or len(extr.get("translationMm") or []) != 3):
                raise ValueError("RGB·깊이 묶음에 컬러→깊이 외부 파라미터가 없다")
            if intrinsics is not None and intr != intrinsics:
                raise ValueError("RGB·깊이 묶음 사이 컬러 내부 파라미터가 바뀌었다")
            if extrinsics is not None and extr != extrinsics:
                raise ValueError("RGB·깊이 묶음 사이 컬러→깊이 외부 파라미터가 바뀌었다")
            intrinsics = intr
            extrinsics = extr
            color = cv2.imdecode(np.frombuffer(zf.read("color.jpg"), np.uint8), cv2.IMREAD_COLOR)
            depth = cv2.imdecode(np.frombuffer(zf.read("depth.png"), np.uint8), cv2.IMREAD_UNCHANGED)
            if color is None or depth is None or color.shape[:2] != depth.shape:
                raise ValueError("RGB·깊이 모양이 다르거나 디코딩하지 못했다")
            if (depth.shape[1], depth.shape[0]) != (meta.get("widthPx"), meta.get("heightPx")):
                raise ValueError("RGB·깊이 모양이 manifest와 다르다")
            colors.append(color)
            depths.append(depth.astype(np.float32))
            stamps.append(float(meta["t"]))
    z, note = dp.average_frames(depths)
    rgb = np.median(np.stack(colors), axis=0).astype(np.uint8)
    return z, rgb, {**note, "rgbdFrames": n, "capturedAt": max(stamps),
                    "captureSpanMs": round((max(stamps) - min(stamps)) * 1000, 1),
                    "intrinsics": intrinsics, "colorToDepth": extrinsics}


def transform_point(point, extrinsics):
    """manifest의 row-major 강체변환으로 컬러 광학점(mm)을 깊이 광학점(mm)으로 옮긴다."""
    if extrinsics is None:
        return [float(v) for v in point]
    R = np.asarray(extrinsics["rotationRowMajor"], float).reshape(3, 3)
    t = np.asarray(extrinsics["translationMm"], float)
    return (R @ np.asarray(point, float) + t).tolist()


def find_bullets_rgb(img, center_px, win_px, z_mm, K, color_to_depth=None):
    """깊이 후보 주변의 분홍 외곽을 하나로 좁힌 뒤 황동 연결 성분을 카메라 mm로 낸다."""
    if img is None or img.ndim != 3 or img.shape[2] != 3:
        return None, [], "정렬 컬러가 없다"
    h, w = img.shape[:2]
    cx, cy = center_px
    x0, y0 = max(0, int(cx - win_px)), max(0, int(cy - win_px))
    x1, y1 = min(w, int(cx + win_px + 1)), min(h, int(cy + win_px + 1))
    if x1 - x0 < 10 or y1 - y0 < 10:
        return None, [], "깊이 거치대 주변 컬러 ROI가 너무 작다"

    roi = img[y0:y1, x0:x1]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    pink = np.zeros(hsv.shape[:2], np.uint8)
    for lo, hi in PINK_HSV:
        pink |= cv2.inRange(hsv, np.array(lo, np.uint8), np.array(hi, np.uint8))
    k = max(3, int(round(8.0 * K["fx"] / z_mm)))
    k += 1 - k % 2
    pink = cv2.morphologyEx(pink, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    num, _lab, stats, cent = cv2.connectedComponentsWithStats(pink, 8)
    min_pink = max(40, int(0.02 * roi.shape[0] * roi.shape[1]))
    pcands = []
    local_c = np.array([cx - x0, cy - y0])
    for i in range(1, num):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_pink:
            continue
        if np.linalg.norm(cent[i] - local_c) <= win_px * 0.65:
            pcands.append(i)
    if len(pcands) != 1:
        return None, [], f"깊이 거치대 주변 분홍 ROI가 {len(pcands)}개 — 하나가 아니면 총알을 고르지 않는다"

    px, py, pw, ph, _ = (int(v) for v in stats[pcands[0]])
    pad = max(2, int(round(min(pw, ph) * 0.12)))
    if pw <= 2 * pad or ph <= 2 * pad:
        return None, [], "분홍 ROI 안쪽이 너무 작다"
    inner = hsv[py + pad:py + ph - pad, px + pad:px + pw - pad]
    brass = cv2.inRange(inner, np.array(BRASS_HSV[0], np.uint8), np.array(BRASS_HSV[1], np.uint8))
    brass = cv2.morphologyEx(brass, cv2.MORPH_OPEN,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    # D217: 한 황동 원의 위·아래 정반사가 4px 이하 틈으로 갈리는 것만 잇는다.
    # 후보 좌표끼리 사후 병합하지 않아 가까운 두 총알은 계속 둘로 보고한다.
    brass = cv2.morphologyEx(brass, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n2, _l2, s2, c2 = cv2.connectedComponentsWithStats(brass, 8)
    box_area = pw * ph
    amin = max(5, int(round(BRASS_AREA_FRAC[0] * box_area)))
    amax = max(amin, int(round(BRASS_AREA_FRAC[1] * box_area)))
    bullets, pixels = [], []
    for i in range(1, n2):
        bx, by, bw, bh, area = (int(v) for v in s2[i])
        if not amin <= area <= amax or min(bw, bh) <= 0:
            continue
        if max(bw, bh) / min(bw, bh) > 1.8 or area / (bw * bh) < 0.35:
            continue
        if float(np.median(inner[_l2 == i, 1])) < BRASS_MEDIAN_S_MIN:
            continue
        u = float(c2[i][0] + x0 + px + pad)
        v = float(c2[i][1] + y0 + py + pad)
        pixels.append([round(u, 1), round(v, 1)])
        bullets.append([round(q, 1) for q in transform_point(
            deproject(u, v, z_mm, K), color_to_depth)])
    return bullets, pixels, f"분홍 ROI 안 황동 연결 성분 {len(bullets)}개"


def find(z, K, wMm, dMm, roi=None, mode="raised", h_range=(H_MIN_MM, H_MAX_MM), rgb=None,
         color_to_depth=None):
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
    h_min, h_max = h_range
    # ⭐ **판(plateau) 분기** (2026-09-07 19:50 실기 · 바구니 바닥) — 바구니 위 300mm 에서 보면 화면을 지배하는 평면은 **상판**이고 바구니 바닥은 상판보다
    #    115 솟은 판, 테두리는 150 솟은 띠다. 「파임(sunken)」은 덱 평면이 지배할 때의 가정이라 여기선 안 맞았다(실기 프레임: 파임 후보 0 · 잔차 +100~130 띠 40k px).
    #    그래서 잔차 띠 [h_min, h_max] 를 그대로 마스크로 잡아 제일 큰 덩어리의 minAreaRect 를 발자국과 댄다. 껍질 창·조각 병합은 안 쓴다 — 띠 자체가 하나의 판이다
    if mode == "plateau":
        band = valid & (resid >= h_min) & (resid <= h_max)
        band = cv2.morphologyEx(band.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)).astype(bool)
        out = []
        for blob in dp.all_blobs(band):
            if blob.sum() < dp.MIN_AREA_PX:
                continue
            zb = z[blob]
            zmid = float(np.median(zb))
            mmpx = zmid / K["fx"]
            ys, xs = np.nonzero(blob)
            (cx, cy), (rw, rh), ang = cv2.minAreaRect(np.column_stack([xs, ys]).astype(np.float32))
            size_mm = sorted([rw * mmpx, rh * mmpx])
            want = sorted([wMm, dMm])
            fits_foot = footprint_fits(size_mm, want, clipped=False)
            fill = float(blob.sum()) / max(1.0, rw * rh)
            h = float(np.nanmedian(resid[blob]))
            axis = round((-(ang if rw >= rh else ang + 90.0)) % 180.0, 1)
            # 화면 가장자리에 닿은 판은 **잘린 것**이다 — 보이는 부분만으로 65×88 이 「맞는 것처럼」 통과했다(실기 19:45 프레임). 그쪽으로 카메라를 옮겨 다시 본다
            H_, W_ = z.shape
            clipped = xs.min() <= 2 or ys.min() <= 2 or xs.max() >= W_ - 3 or ys.max() >= H_ - 3
            out.append({
                "hullSizeMm": [round(size_mm[0], 1), round(size_mm[1], 1)], "hullAxisDeg": axis,
                "areaPx": int(blob.sum()), "sizeMm": [round(size_mm[0], 1), round(size_mm[1], 1)], "longAxisDeg": axis,
                "heightMm": round(h, 1), "zMm": round(zmid, 1), "px": [round(float(cx) + off[0], 1), round(float(cy) + off[1], 1)],
                "camMm": [round(v, 1) for v in deproject(float(cx) + off[0], float(cy) + off[1], zmid, K)],
                "fits": bool(fits_foot and fill >= 0.6 and not clipped), "frags": 1, "fillPx": int(blob.sum()), "clipped": bool(clipped),
                "why": (f"화면 가장자리에 잘렸다 — 보이는 부분 중심이 카메라에서 ({deproject(float(cx) + off[0], float(cy) + off[1], zmid, K)[0]:.0f}, {deproject(float(cx) + off[0], float(cy) + off[1], zmid, K)[1]:.0f})mm · 그쪽으로 옮겨 다시" if clipped
                        else ("크기·높이 판정선 안" if fits_foot and fill >= 0.6 else ("발자국이 안 맞는다" if not fits_foot else f"사각형 채움 {fill:.2f} < 0.6"))),
            })
        out.sort(key=lambda c: (not c["fits"], -c["areaPx"]))
        return out, None
    raised = valid & dp.plane_support(inliers) & (resid > thr)

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
        h = float(np.nanpercentile(resid[dp.core(blob)], 95))
        fits_h = h_min <= h <= h_max
        ys, xs = np.nonzero(blob)
        cu, cv = float(xs.mean()) + off[0], float(ys.mean()) + off[1]
        # ⭐ **요각·치수는 볼록 껍질 사각형으로** (2026-09-07 실기). 거치대 윗면은 구멍·총알로 마스크가 비어 PCA 장축이 프레임마다 86° 나 뒤집혔다
        #    (105° vs 19° · 같은 물체 · 손목 5° 차). 덩어리 근처(±70px)의 **모든 솟은 점**(테두리 꼭대기 45mm+ 포함)의 볼록 껍질에 minAreaRect 를 대면
        #    바깥 윤곽 78~85×98~101(69×85+번짐)이 나오고 각이 두 프레임에서 손목 회전만큼만 움직였다(175.9→171.1 · rz −175→−170). 요각 규약 θ+rz 검증
        # ⭐ 껍질엔 **테두리 높이(h_max) 이하** 점만 (2026-09-07 20:19 충돌) — 거치대 안에 서 있는 총알(테두리 위 30~40 돌출)이 솟은 점으로 껍질에 섞여 93.9×97.2 로 부풀고
        #    중심을 총알 쪽으로 밀었다. 총알은 따로 무리 지어 `bulletsCamMm` 로 보고한다 — 부르는 쪽이 그 벽을 피한다
        # 총알 문턱 = 테두리(hMm) + 5 — 부르는 쪽 창은 (바닥, hMm+15) 라 h_max − 10 이 그 자리다. 구멍에 선 총알 끝은 판 위 +60~70 에 온다(20:00 프레임: 긴 변 115 로 부풀림)
        tall = raised & (resid > (h_max - 10.0))
        hys, hxs = np.nonzero(raised & ~tall)
        hull_size, hull_axis, hull_c = None, None, None
        hc = (cu - off[0], cv - off[1])
        # ⭐ **2패스** (2026-09-07 자세 B 실기) — 첫 창은 조각 중심, 둘째 창은 껍질 중심. 구멍 판 바닥이 뎁스 그늘로 5조각으로 갈라지면 제일 큰 조각의
        #    중심이 물체 중심에서 17mm 치우쳐 ±70px 창이 반대쪽 끝을 잘랐다(껍질 88 vs 실물 100). 창을 껍질 중심에 다시 놓으면 끝이 들어온다.
        mmpx = zmid / K["fx"]
        win = max(HULL_WIN_PX, int(np.ceil(HULL_WIN_MM / mmpx)))
        clipped = False
        for _ in range(2):
            near = (np.abs(hxs - hc[0]) < win) & (np.abs(hys - hc[1]) < win)
            if near.sum() < 20:
                break
            hull = cv2.convexHull(np.column_stack([hxs[near], hys[near]]).astype(np.float32))
            (hx, hy), (hw, hh), hang = cv2.minAreaRect(hull)
            if hw <= 0 or hh <= 0:
                break
            # 껍질이 창 끝까지 닿으면 **창보다 큰 물체**다 — 창이 그것을 발자국 크기로 잘라 「맞는 것처럼」 보이게 한다(자세 A 실기: 141×149 물체가 110×110 껍질로 통과)
            clipped = max(hw, hh) >= 2 * win - 4
            hull_size = [round(min(hw, hh) * mmpx, 1), round(max(hw, hh) * mmpx, 1)]
            hull_axis = round((-(hang if hw >= hh else hang + 90.0)) % 180.0, 1)   # 화면 y-down → y-up(`blob_size_mm` 와 같은 규약)
            hull_c = (float(hx), float(hy))
            hc = hull_c
        if hull_c is not None:
            cu, cv = hull_c[0] + off[0], hull_c[1] + off[1]     # 자리도 껍질 중심 — 조각 중심은 그늘 쪽으로 치우친다
        # 껍질이 정사각에 가까우면 긴 축을 못 가른다 — 요각을 「모른다」고 한다(부르는 쪽이 폰 요각·정본각으로 간다)
        if hull_size and hull_size[0] > 0 and hull_size[1] / hull_size[0] < YAW_MIN_ASPECT:
            hull_axis = None
        # 총알 — 정렬 컬러가 있으면 분홍 ROI 안 황동 성분, 없으면 옛 깊이 높이 마스크.
        bullets = []
        if hull_c is not None and tall.any():
            tys, txs = np.nonzero(tall)
            near_t = (np.abs(txs - hull_c[0]) < win) & (np.abs(tys - hull_c[1]) < win)
            if near_t.sum() >= 5:
                tmask = np.zeros_like(tall); tmask[tys[near_t], txs[near_t]] = True
                for tb in dp.all_blobs(tmask):
                    if tb.sum() < 5:
                        continue
                    tys2, txs2 = np.nonzero(tb); zt = float(np.median(z[tb]))
                    bullets.append([round(v, 1) for v in deproject(float(txs2.mean()) + off[0], float(tys2.mean()) + off[1], zt, K)])
        bullet_source, bullet_pixels = "depth", []
        bullet_why = f"깊이 높이 성분 {len(bullets)}개"
        if rgb is not None and hull_c is not None:
            bullets, bullet_pixels, bullet_why = find_bullets_rgb(
                rgb, (hull_c[0] + off[0], hull_c[1] + off[1]), win, zmid, K, color_to_depth)
            bullets = bullets or []
            bullet_source = "rgb-aligned"
        # 발자국은 **껍질**로 판정한다 — 조각이 갈라져도 바깥 윤곽은 하나다. 껍질이 없으면(점 부족) 조각 자체로 본다
        foot = sorted(hull_size) if hull_size else [a, b]
        # 발자국 정본은 구멍·총알·뎁스 그늘을 감싼 `hull_size`다. 같은 물체의 조각 PCA는
        # 실제 5묶음에서 118~145mm로 부풀었지만 껍질은 85~104mm로 안정적이었다(2026-09-10).
        # 큰 물체는 껍질 치수창과 `clipped`, 부스러기는 아래 MIN_FILL이 계속 차단한다.
        fits_foot = footprint_fits(foot, want, clipped)
        foot_px = (wMm * dMm) / (mmpx * mmpx)                                            # 발자국의 픽셀 면적(이 깊이에서)
        out.append({
            "hullSizeMm": hull_size, "hullAxisDeg": hull_axis,
            "areaPx": int(blob.sum()), "sizeMm": [round(a, 1), round(b, 1)],
            "longAxisDeg": size["longAxisDeg"],
            "heightMm": round(h, 1), "zMm": round(zmid, 1),
            "px": [round(cu, 1), round(cv, 1)],
            "camMm": [round(v, 1) for v in transform_point(
                deproject(cu, cv, zmid, K), color_to_depth)],
            "fits": bool(fits_foot and fits_h),
            "why": ("크기·높이 판정선 안" if fits_foot and fits_h
                    else ("껍질이 창에 잘렸다 — 발자국보다 큰 물체" if clipped else ("발자국이 안 맞는다" if not fits_foot else "높이가 안 맞는다"))),
            "_footPx": foot_px, "_mmpx": mmpx, "bulletsCamMm": bullets,
            "bulletsPx": bullet_pixels, "bulletSource": bullet_source, "bulletWhy": bullet_why,
        })
    # 같은 껍질을 가리키는 조각들은 **하나**다 (2026-09-07 자세 B · 바닥 5조각이 전부 같은 윤곽) — 중심 MERGE_PX 안이면 면적 큰 것 하나만 남기고 개수를 적는다
    uniq = []
    for c in sorted(out, key=lambda c: -c["areaPx"]):
        twin = next((u for u in uniq if np.hypot(c["px"][0] - u["px"][0], c["px"][1] - u["px"][1]) * u["_mmpx"] < MERGE_MM), None)
        if twin is not None:
            twin["frags"] += 1
            twin["fillPx"] += c["areaPx"]
            continue
        c["frags"] = 1
        c["fillPx"] = c["areaPx"]
        uniq.append(c)
    for c in uniq:
        # 합친 면적이 발자국의 MIN_FILL 도 안 되면 물체가 아니라 부스러기다 — 껍질은 옆 물체에서 빌린 것
        if c["fits"] and c["fillPx"] < MIN_FILL * c["_footPx"]:
            c["fits"] = False
            c["why"] = f"채움이 {100 * c['fillPx'] / c['_footPx']:.0f}% — 부스러기(발자국의 {100 * MIN_FILL:.0f}% 미만)"
        c.pop("_footPx", None)
        c.pop("_mmpx", None)
    out = uniq
    out.sort(key=lambda c: (not c["fits"], -c["areaPx"]))
    return out, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", help="브리지 대신 이 파일을 읽는다")
    ap.add_argument("--rgb", help="--png와 같은 깊이 화소계에 이미 정렬된 컬러 파일")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--roi", help="x0,y0,x1,y1 — 판이 둘일 때 한쪽으로 좁힌다")
    ap.add_argument("--avg", type=int, default=RGBD_AVG_FRAMES,
                    help=f"이 장수를 화소별 중앙값 (기본 {RGBD_AVG_FRAMES})")
    a = ap.parse_args()

    wMm, dMm, _hMm = load_props()
    if a.png:
        from PIL import Image
        z = np.asarray(Image.open(a.png)).astype(np.float32)
        K = {"fx": dp.FX848, "fy": dp.FY848, "ppx": dp.CX848, "ppy": dp.CY848}
        rgb = cv2.imread(a.rgb) if a.rgb else None
        st = None
    else:
        info = get(_require(5058, "/api/camera/info", "카메라 브리지"))
        K = info.get("depthIntrinsics")
        if not K:
            raise SystemExit("⛔ /api/camera/info 에 depthIntrinsics 가 없다 — 카메라가 안 붙었다")
        raw, rgb, _note = fetch_rgbd_avg(_require(5058, "/api/camera/rgbd/frame", "카메라 브리지"), a.avg)
        K = _note["intrinsics"]
        z = raw.astype(np.float32)
        st = get(_require(5055, "/state"))

    roi = tuple(int(v) for v in a.roi.split(",")) if a.roi else None
    cands, why = find(z, K, wMm, dMm, roi, rgb=rgb,
                      color_to_depth=(_note.get("colorToDepth") if not a.png else None))
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
