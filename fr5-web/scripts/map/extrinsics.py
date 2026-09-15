#!/usr/bin/env python3
"""태그 사진 + 실측 태그 좌표 → **labToCam** (태그 좌표계 → 카메라).

⚠ **여기서 "lab" 은 실험실 바닥 원점이 아니다** (2026-08-07 정정). 원점은
`calib-shots/tag-layout.json` 이 정의하는 것 — 지금은 **상판 태그 id0 중심 · 상판 평면이 z=0**
이고, 태그가 로봇 카트 데크에 붙어 있어 **바닥에서 약 1000mm 위**다. 예전 이 자리에
"실험실 바닥 원점(SR_23)" 이라 적혀 있었는데 틀린 문구였다 — 바닥으로 읽고 배치안을 얹으면
1m 아래에 그린다. 셋(바닥 · 태그 · 로봇 베이스)의 관계는
`docs/ref/contract/LAYOUT-METRICS-CONTRACT.md` §원점은 하나가 아니다.

이게 글로벌 카메라 AR 이 새로 필요로 하는 유일한 변환이다
(`docs/research/ar-global-camera.md` §좌표 사슬).

**태그를 네 장 다 같은 방향으로 놓아라.** 인쇄면의 위쪽이 실험실 +Y 를 향하게.
그러면 각 태그마다 재야 할 값이 **중심 x·y 두 개**로 줄어든다 — 방향까지 재게 하면
거기서 오차가 들어오고, 그 오차는 재투영 오차로 안 잡히고 결과만 조용히 틀어진다.
다르게 놓았다면 그 태그에만 `yawDeg` 를 적는다.

**입력이 나쁘면 쓰지 않고 멈춘다** (build/ 규약).

    python3 scripts/map/extrinsics.py --init      # 좌표 적을 서식을 만든다
    # calib-shots/tag-layout.json 에 자로 잰 값을 적는다
    python3 scripts/map/capture.py tags --shots 1
    python3 scripts/map/extrinsics.py
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "Shared/assets/tag/tags.json"
CONF = ROOT / "Shared/data/config/global-cam.json"
LAYOUT = ROOT / "calib-shots/tag-layout.json"

MAX_RMS = 2.0     # 재투영 오차 상한 (px)
MIN_TAGS = 3      # 평면 위 3 장이면 풀리지만 4 장이어야 오차가 평균화된다


def template(tag_mm):
    return {
        "_단위": "밀리미터 · 도. 원점은 **이 파일이 정의한다** — 태그 하나를 골라 (0,0,0) 으로 두고 "
                 "나머지를 그 기준으로 적는다. 바닥 원점(SR_23)이 아니다 "
                 "(LAYOUT-METRICS-CONTRACT §원점은 하나가 아니다)",
        "_방법": "태그 네 장을 같은 방향으로(인쇄면 위쪽 = +Y) 놓고 중심을 자로 잰다",
        # **파일 선언값이 아니라 인쇄물 실측값이다.** 프린터가 배율을 줄이면 여기만 틀리고
        # 나머지는 다 맞아 보이는데, 그 오차는 카메라 거리에 그대로 비례해 들어간다
        # (10% 작으면 높이 2.40m 가 2.65m 로 나온다). 2026-08-03 실측 인쇄본은 145mm 였다.
        "_크기": "↓ tagSizeMm 은 인쇄물의 **검은 사각형**을 자로 재서 고쳐라. 아래 값은 파일 기준일 뿐이다",
        "tagSizeMm": tag_mm,
        "defaultYawDeg": 0,
        "tags": {str(i): {"xMm": 0, "yMm": 0, "zMm": 0} for i in range(4)},
    }


def corners_3d(t, size, default_yaw):
    """태그 중심·yaw → 네 모서리의 실험실 좌표. 순서는 cv2 검출 순서와 맞춘다."""
    # ⭐ **태그마다 크기가 다를 수 있다** (2026-08-19). 배치도에 방 기준 4장만 있을 때는
    # 전부 145mm 라 전역 하나로 충분했다. 조립셀 태그(84~134mm)를 배치도에 올리면서
    # 항목별 `tagSizeMm` 을 허용한다 — 없으면 전역값을 그대로 쓴다(옛 배치도 그대로 산다).
    h = t.get("tagSizeMm", size) / 2
    yaw = np.radians(t.get("yawDeg", default_yaw))
    c, s = np.cos(yaw), np.sin(yaw)
    # cv2.aruco 는 태그 이미지 기준 좌상·우상·우하·좌하 순으로 준다.
    # 인쇄면 위쪽이 +Y 이므로 "위"가 +Y, "오른쪽"이 +X 다.
    local = [(-h, +h), (+h, +h), (+h, -h), (-h, -h)]
    return [(t["xMm"] + c * lx - s * ly, t["yMm"] + s * lx + c * ly, t.get("zMm", 0))
            for lx, ly in local]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", default=None, help="태그 사진 1장 (기본: calib-shots/tags 의 최신)")
    ap.add_argument("--init", action="store_true", help="좌표 서식만 만들고 끝낸다")
    a = ap.parse_args()

    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    if a.init:
        if LAYOUT.exists():
            print(f"{LAYOUT.relative_to(ROOT)} 가 이미 있다 — 덮어쓰지 않는다", file=sys.stderr)
            return 1
        LAYOUT.parent.mkdir(parents=True, exist_ok=True)
        LAYOUT.write_text(json.dumps(template(spec["sheets"][0]["tagSizeMm"]),
                                     ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{LAYOUT.relative_to(ROOT)} — 자로 잰 값을 적고 다시 실행하라")
        return 0

    if not CONF.exists() or "intrinsics" not in json.loads(CONF.read_text(encoding="utf-8")):
        print("내부 파라미터가 없다 — 먼저 scripts/map/intrinsics.py", file=sys.stderr)
        return 1
    if not LAYOUT.exists():
        print(f"{LAYOUT.relative_to(ROOT)} 가 없다 — --init 으로 서식을 만들어라", file=sys.stderr)
        return 1

    doc = json.loads(CONF.read_text(encoding="utf-8"))
    I = doc["intrinsics"]
    lay = json.loads(LAYOUT.read_text(encoding="utf-8"))

    if all(t.get("xMm", 0) == 0 and t.get("yMm", 0) == 0 for t in lay["tags"].values()):
        print("좌표가 전부 0 이다 — 서식에 자로 잰 값을 적어야 한다", file=sys.stderr)
        return 1

    # png 만 보면 폰으로 찍은 사진(jpg)을 폴더에 넣어도 "없다"고 한다 — intrinsics 와 맞춘다
    shots = list((ROOT / "calib-shots/tags").glob("*.png")) + \
        list((ROOT / "calib-shots/tags").glob("*.jpg"))
    shot = Path(a.shot) if a.shot else max(shots, key=lambda p: p.stat().st_mtime, default=None)
    if shot is None or not Path(shot).exists():
        print("태그 사진이 없다 — scripts/map/capture.py tags --shots 1", file=sys.stderr)
        return 1
    g = cv2.imread(str(shot), cv2.IMREAD_GRAYSCALE)
    if (g.shape[1], g.shape[0]) != (I["widthPx"], I["heightPx"]):
        print(f"실패 — 사진 {g.shape[1]}x{g.shape[0]} 이 내부 파라미터 "
              f"{I['widthPx']}x{I['heightPx']} 와 다르다. 같은 설정으로 다시 찍어라", file=sys.stderr)
        return 1

    dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, spec["family"]))
    # **모서리 정밀화를 반드시 켠다** (2026-08-08). 기본값은 `CORNER_REFINE_NONE` 이라
    # 모서리를 이진화 윤곽선으로만 잡는데, **멀고 흐린 태그에서는 검은 테두리를 갉아먹어
    # 사각형이 작게 잡힌다.** 작게 잡히면 그 태그만 "더 멀다" 로 풀려 평면 아래로 내려가고,
    # 거리·크기·기울기 어느 쪽을 의심해도 실물은 멀쩡하다 — 실측: 가장 먼 태그가 아예
    # 미검출되거나(3장) 재투영 5.62px 로 튀었고, 켜니 4장 · 1.19px · 카메라 위치 흔들림
    # 2.15mm → 0.06mm. `docs/evidence/2026-08-08/apriltag-corner-refine.md`
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_APRILTAG
    corners, ids, _ = cv2.aruco.ArucoDetector(dic, params).detectMarkers(g)
    if ids is None:
        print(f"실패 — {Path(shot).name} 에서 태그를 하나도 못 찾았다", file=sys.stderr)
        return 1
    found = {int(i) for i in ids.ravel()}
    print(f"{Path(shot).name}: 태그 {sorted(found)} 검출")

    op, ip = [], []
    for c, i in zip(corners, ids.ravel()):
        t = lay["tags"].get(str(int(i)))
        if t is None:
            print(f"  id{i}: 좌표가 서식에 없다 — 건너뛴다")
            continue
        op += corners_3d(t, lay["tagSizeMm"], lay.get("defaultYawDeg", 0))
        ip += list(map(tuple, c[0]))

    n = len(op) // 4
    if n < MIN_TAGS:
        print(f"실패 — 좌표가 있는 태그 {n} 장. 최소 {MIN_TAGS} 장이 보여야 한다", file=sys.stderr)
        return 1

    K = np.array([[I["fx"], 0, I["cx"]], [0, I["fy"], I["cy"]], [0, 0, 1]])
    dist = np.array(I["dist"])
    # ⛔ **`SOLVEPNP_ITERATIVE` 하나만 믿지 않는다** (2026-08-19). 태그가 거의 한 평면이면
    # PnP 는 **거울짝 해**를 가진다. 방 기준 4장만 쓸 때는 초기추정이 우연히 옳은 쪽으로
    # 떨어져 안 드러났는데, 작업대 태그를 더해 배치가 넓어지자 **뒤집힌 해로 수렴**했다 —
    # 재투영 RMS 130px · 카메라 z **−885mm**(태그면 **아래**, 물리적으로 불가능)였다.
    # ▶ 후보를 **전부** 받아서 ①카메라가 태그면 위(z>0)인 것만 남기고 ②그중 재투영이
    #   제일 작은 것을 고른다. 「그럴듯한 숫자」가 아니라 **가능한 자세**를 먼저 거른다.
    obj_a, img_a = np.array(op, np.float64), np.array(ip, np.float64)
    cands = []
    for flag in (cv2.SOLVEPNP_ITERATIVE, cv2.SOLVEPNP_SQPNP, cv2.SOLVEPNP_EPNP):
        try:
            # ⚠ 판마다 반환 개수가 다르다 — 4.x 는 (retval, rvecs, tvecs), 5.0 은 오차까지 넷
            got = cv2.solvePnPGeneric(obj_a, img_a, K, dist, flags=flag)
            rvs, tvs = got[1], got[2]
        except cv2.error:
            continue
        for rv_, tv_ in zip(rvs, tvs):
            R_, _ = cv2.Rodrigues(rv_)
            if (-R_.T @ tv_).ravel()[2] <= 0:       # ① 카메라가 태그면 아래 = 불가능
                continue
            pr_, _ = cv2.projectPoints(obj_a, rv_, tv_, K, dist)
            e = float(np.sqrt(np.mean(np.sum((pr_.reshape(-1, 2) - img_a) ** 2, axis=1))))
            cands.append((e, rv_, tv_))
    if not cands:
        print("실패 — 태그면 위에 있는 해가 없다. 태그가 일직선이거나 좌표가 틀렸다", file=sys.stderr)
        return 1
    cands.sort(key=lambda c: c[0])
    ok, rvec, tvec = True, cands[0][1], cands[0][2]

    proj, _ = cv2.projectPoints(np.array(op, np.float64), rvec, tvec, K, dist)
    rms = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - np.array(ip)) ** 2, axis=1))))

    R, _ = cv2.Rodrigues(rvec)
    cam_lab = (-R.T @ tvec).ravel()                 # 카메라 위치 — **태그 좌표계**다
    height = cam_lab[2]                             # 바닥이 아니라 **태그 평면 위** 높이
    fwd = (R.T @ np.array([0, 0, 1.0])).ravel()     # 카메라가 보는 방향
    depression = float(np.degrees(np.arcsin(-fwd[2] / np.linalg.norm(fwd))))

    print(f"태그 {n} 장 · 점 {len(op)} 개 · 재투영 RMS {rms:.2f} px")
    print(f"카메라 위치 ({cam_lab[0]:.0f}, {cam_lab[1]:.0f}, {cam_lab[2]:.0f}) mm · "
          f"태그면 위 {height/1000:.2f} m · 하향각 {depression:.1f}°")
    if rms > MAX_RMS:
        print(f"실패 — RMS {rms:.2f} > {MAX_RMS}. 쓰지 않고 멈춘다.\n"
              "  흔한 원인: 자로 잰 좌표가 틀렸다 · 태그 방향이 서로 다르다 · 태그가 안 평평하다",
              file=sys.stderr)
        return 1
    if height < 0:
        print("실패 — 카메라가 태그 평면 아래로 나왔다. +Y 방향이나 태그 방향 규약을 확인하라",
              file=sys.stderr)
        return 1

    doc["labToCam"] = {
        "rvec": rvec.ravel().tolist(), "tvecMm": tvec.ravel().tolist(),
        "camPosMm": cam_lab.tolist(),
        "heightMm": round(float(height), 1), "depressionDeg": round(depression, 2),
        "rmsPx": round(rms, 3), "tags": n, "shot": Path(shot).name,
    }
    doc["verified"] = True
    CONF.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{CONF.relative_to(ROOT)} — 카메라를 건드리면 이 단계만 다시 돌리면 된다")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
