#!/usr/bin/env python3
"""실렌더 검증용 **합성 고정물** — 사진 1장 + 그 사진에서 푼 캘리브레이션.

웹캠도 인쇄물도 없이 글로벌 카메라 화면(`AR/cam.html`)을 띄워 보기 위한 것이다.
`check-overlay.sh` 와 같은 장면을 쓰되, 지우지 않고 파일로 남긴다.

**참값을 파일에 넣지 않는다.** 캘리브레이션은 사진에서 태그를 검출해 solvePnP 로 푼 값이다 —
화면이 그걸 그대로 쓰므로 실기와 같은 경로를 탄다.

    python3 scripts/map/make-fixture.py
"""
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "AR/test/cam-fixture"

W, H = 1920, 1080
K = np.array([[1371.0, 0, 953.0], [0, 1352.0, 566.0], [0, 0, 1]])
DIST = np.zeros(5)
EYE, TGT = np.array([1500., -800., 2400.]), np.array([1500., 800., 0.])
POS = {0: (300., 300.), 1: (2700., 300.), 2: (2700., 1300.), 3: (300., 1300.)}


def quad(cx, cy, s):
    h = s / 2
    return [(cx - h, cy + h, 0), (cx + h, cy + h, 0), (cx + h, cy - h, 0), (cx - h, cy - h, 0)]


def main():
    spec = json.loads((ROOT / "Shared/assets/tag/tags.json").read_text(encoding="utf-8"))
    dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, spec["family"]))
    tag = spec["sheets"][0]["tagSizeMm"]

    f = TGT - EYE; f /= np.linalg.norm(f)
    r = np.cross(f, [0, 0, 1.]); r /= np.linalg.norm(r)
    R = np.vstack([r, -np.cross(r, f), f]); t = (-R @ EYE).reshape(3, 1)
    rv = cv2.Rodrigues(R)[0]

    # 바닥을 옅은 회색으로 깔아 벽·바닥 경계가 보이게 한다 (흰 배경이면 정합이 안 읽힌다)
    canvas = np.full((H, W), 245, np.uint8)
    floor = np.array([[0., 0., 0.], [3000., 0., 0.], [3000., 1600., 0.], [0., 1600., 0.]])
    fp, _ = cv2.projectPoints(floor, rv, t, K, DIST)
    cv2.fillPoly(canvas, [fp.reshape(-1, 2).astype(np.int32)], 214)
    cv2.polylines(canvas, [fp.reshape(-1, 2).astype(np.int32)], True, 120, 3)

    for i, (cx, cy) in POS.items():
        png = cv2.aruco.generateImageMarker(dic, i, 800)
        src = np.array([[0, 0], [800, 0], [800, 800], [0, 800]], np.float32)
        dst, _ = cv2.projectPoints(np.array(quad(cx, cy, tag)), rv, t, K, DIST)
        Hm = cv2.getPerspectiveTransform(src, dst.reshape(-1, 2).astype(np.float32))
        canvas = np.minimum(canvas, cv2.warpPerspective(png, Hm, (W, H), borderValue=255,
                                                        flags=cv2.INTER_AREA))

    OUT.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(OUT / "shot.png"), canvas)

    # ── 여기서부터 참값을 안 쓴다. 사진에서만 푼다 (실기와 같은 경로).
    corners, ids, _ = cv2.aruco.ArucoDetector(
        dic, cv2.aruco.DetectorParameters()).detectMarkers(canvas)
    assert ids is not None and len(ids) == 4, "태그 검출 실패"
    op, ip = [], []
    for c, i in zip(corners, ids.ravel()):
        op += quad(*POS[int(i)], tag); ip += list(map(tuple, c[0]))
    ok, rv2, tv2 = cv2.solvePnP(np.array(op), np.array(ip), K, DIST,
                                flags=cv2.SOLVEPNP_ITERATIVE)
    assert ok, "solvePnP 실패"
    cam = (-cv2.Rodrigues(rv2)[0].T @ tv2).ravel()

    (OUT / "global-cam.json").write_text(json.dumps({
        "_생성됨": "python3 scripts/map/make-fixture.py — 합성 고정물이다. 실기 값이 아니다",
        "intrinsics": {"widthPx": W, "heightPx": H, "fx": K[0, 0], "fy": K[1, 1],
                       "cx": K[0, 2], "cy": K[1, 2], "dist": DIST.tolist(), "rmsPx": 0.0},
        # `shot` 은 **실측 산출물(`extrinsics.py`)이 늘 싣는 칸**이라 고정물도 같은 모양이어야
        # 한다. 없으면 화면이 「이 정합값이 어느 기준으로 잰 것인가」를 대조할 수 없어
        # (`cam.js` `calibTrust`) **「감시 꺼짐」과 「정합 무효」를 못 가른다** — 그 갈래를 덮는
        # 게이트(`cam-web-verify` 정합 3단)가 고정물에서 통째로 안 돌게 된다 (2026-08-13).
        "labToCam": {"rvec": rv2.ravel().tolist(), "tvecMm": tv2.ravel().tolist(),
                     "camPosMm": cam.tolist(), "heightMm": round(float(cam[2]), 1),
                     "shot": "cam-fixture-shot.png"},
        "verified": False,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    # 같은 장면의 배치안 — **여기서 같이 낸다.** 태그 자리를 화면 쪽에 손으로 다시 적으면
    # 사진과 배치안이 조용히 어긋나고, 그러면 겹침이 틀린 건지 코드가 틀린 건지 못 가른다.
    (OUT / "layout.json").write_text(json.dumps({
        "id": "FIX", "name": "합성 고정물", "unit": "mm-deg",
        "floor": {"widthMm": 3000, "depthMm": 1600, "heightMm": 2000},
        "arms": [{"id": "fr5", "model": "FR5", "role": "process",
                  "basePosMm": [1500, 800, 900], "baseYawDeg": 0, "reachMm": 922}],
        "stations": [{"id": f"tag{i}", "name": f"tag{i}", "posMm": [int(x), int(y), 0]}
                     for i, (x, y) in sorted(POS.items())],
        "amrs": [], "props": [], "verified": False,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{OUT.relative_to(ROOT)}/ · 사진에서 푼 카메라 "
          f"({cam[0]:.0f}, {cam[1]:.0f}, {cam[2]:.0f}) mm · 참값 대비 "
          f"{np.linalg.norm(cam - EYE):.1f}mm")
    # **이 고정물이 무엇이 아닌지 같이 말한다** (2026-08-08 · GAP-MATRIX P1).
    # `DIST = np.zeros(5)` 이고 `fx 1371` 은 (1080p · HFOV 70°) 의 산물이다 — 실기 잠금은
    # 2560×1440 · 73.05° 이고 실측 `fx` 는 1728.17 이다. 이걸 안 적으면 이 고정물로 통과한
    # 게이트가 실기 정합까지 덮은 것으로 읽힌다.
    print("  ⚠ 왜곡 0 · 1080p/HFOV 70° 합성이다 — 실기(2560×1440 · 73.05°) 정합 근거가 아니다")


if __name__ == "__main__":
    main()
