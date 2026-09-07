#!/usr/bin/env python3
"""ChArUco 사진 → 카메라 **내부 파라미터**(화각·주점·왜곡).

`Shared/data/config/global-cam.json` 의 `intrinsics` 를 쓴다.
**입력이 나쁘면 쓰지 않고 멈춘다** (build/ 규약) — 나쁜 캘리브레이션은 없는 것보다 해롭다.
겹친 3D 가 미묘하게 어긋나는데 원인을 카메라가 아니라 좌표계에서 찾게 만든다.

보드 제원은 `Shared/assets/tag/tags.json` 에서 읽는다. 여기 숫자를 다시 적지 않는다.
길이 단위는 **밀리미터** (하드 룰 5).

    python3 scripts/map/capture.py charuco        # 먼저 15~20 장
    python3 scripts/map/intrinsics.py
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

MIN_SHOTS = 8       # 이보다 적으면 왜곡 계수가 안 풀린다
MAX_RMS = 0.5       # 재투영 오차 상한 (px)
MIN_CORNERS = 8     # 한 장에서 이만큼 못 찾으면 그 장은 버린다
MAX_FX_SPREAD = 0.05  # 반으로 나눈 fx 가 이보다 벌어지면 화각이 안 정해진 것이다 (2026-08-04)


def load_board():
    s = json.loads(SPEC.read_text(encoding="utf-8"))
    c = s["charuco"]
    dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, s["family"]))
    board = cv2.aruco.CharucoBoard((c["cols"], c["rows"]), c["squareMm"], c["markerMm"], dic)
    return board, c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default="calib-shots/charuco", help="ChArUco 사진 폴더")
    a = ap.parse_args()

    if not SPEC.exists():
        print(f"{SPEC.relative_to(ROOT)} 가 없다 — 먼저 make-tags.py 를 돌려라", file=sys.stderr)
        return 1
    board, spec = load_board()
    det = cv2.aruco.CharucoDetector(board)

    files = sorted((ROOT / a.shots).glob("*.png")) + sorted((ROOT / a.shots).glob("*.jpg"))
    if not files:
        print(f"{a.shots}/ 에 사진이 없다 — scripts/map/capture.py charuco", file=sys.stderr)
        return 1

    obj_pts, img_pts, size, used = [], [], None, []
    for f in files:
        g = cv2.imread(str(f), cv2.IMREAD_GRAYSCALE)
        if g is None:
            continue
        if size is None:
            size = (g.shape[1], g.shape[0])
        elif (g.shape[1], g.shape[0]) != size:
            print(f"  {f.name}: 해상도가 다르다 {g.shape[1]}x{g.shape[0]} — 버린다")
            continue
        cc, ci, _, _ = det.detectBoard(g)
        if cc is None or len(cc) < MIN_CORNERS:
            print(f"  {f.name}: 코너 {0 if cc is None else len(cc)} 개 — 버린다")
            continue
        op, ip = board.matchImagePoints(cc, ci)
        obj_pts.append(op)
        img_pts.append(ip)
        used.append(f.name)
        print(f"  {f.name}: 코너 {len(cc)} 개")

    print(f"쓸 수 있는 사진 {len(used)}/{len(files)} · 해상도 {size[0]}x{size[1]}")
    if len(used) < MIN_SHOTS:
        print(f"실패 — 최소 {MIN_SHOTS} 장이 필요하다. 각도·거리를 바꿔 더 찍어라", file=sys.stderr)
        return 1

    rms, K, dist, _, _ = cv2.calibrateCamera(obj_pts, img_pts, size, None, None)
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
    hfov = np.degrees(2 * np.arctan(size[0] / (2 * fx)))
    vfov = np.degrees(2 * np.arctan(size[1] / (2 * fy)))
    print(f"재투영 RMS {rms:.3f} px   HFOV {hfov:.1f}°  VFOV {vfov:.1f}°")
    print(f"주점 ({cx:.0f}, {cy:.0f}) — 화면 중앙 ({size[0]/2:.0f}, {size[1]/2:.0f}) 에서 "
          f"{np.hypot(cx - size[0]/2, cy - size[1]/2):.0f}px")

    if rms > MAX_RMS:
        print(f"실패 — RMS {rms:.3f} > {MAX_RMS}. 쓰지 않고 멈춘다.\n"
              "  흔한 원인: 보드가 휘었다 · 초점이 안 맞았다 · 각도가 전부 정면이다",
              file=sys.stderr)
        return 1

    # ── 안정성 — **RMS 만으로는 못 잡는다** (2026-08-04 실측).
    #
    # 초점거리는 **원근이 변하는 정도**로 결정된다. 보드를 비슷한 거리·비슷한 각도로만
    # 찍으면 그 정보가 안 들어와 fx 가 사실상 미결정인데, 재투영 오차는 작게 나온다.
    # 실제로 20장에서 RMS 0.411 로 통과했는데 앞/뒤 절반이 fx 1757 / 2451
    # (**화각 72° / 55°**) 이었다. 그 값으로 푼 카메라 높이가 줄자와 20% 어긋났고,
    # 원인을 찾느라 하루를 썼다. 그래서 **반으로 갈라 서로 맞는지**를 같이 본다.
    #
    # **앞/뒤로 가른다.** 홀짝으로 가르면 두 묶음에 같은 시점이 번갈아 섞여 둘 다 같은 답을
    # 내놓는다 — 실측에서 홀짝은 3.3% 인데 앞/뒤는 39% 였다. 촬영은 시간순으로 자세가
    # 변하므로, 시간으로 가르는 쪽이 "다른 시점에서도 같은 값이 나오나" 를 실제로 묻는다.
    n = len(obj_pts) // 2
    half = [(obj_pts[:n], img_pts[:n]), (obj_pts[n:], img_pts[n:])]
    if min(len(a) for a, _ in half) >= 4:
        fxs = [cv2.calibrateCamera(o, i, size, None, None)[1][0, 0] for o, i in half]
        spread = abs(fxs[0] - fxs[1]) / min(fxs)
        print(f"안정성: 앞/뒤 절반의 fx {fxs[0]:.0f} / {fxs[1]:.0f} — 차이 {spread*100:.1f}%")
        if spread > MAX_FX_SPREAD:
            print(f"실패 — fx 가 {spread*100:.1f}% 흔들린다 (상한 {MAX_FX_SPREAD*100:.0f}%). "
                  "쓰지 않고 멈춘다.\n"
                  "  **RMS 가 작아도 화각은 안 정해진 상태다.** 원근 정보가 부족하다 —\n"
                  "  보드를 화면 **왼쪽 끝·오른쪽 끝**까지 옮기고, 기울기를 30·45·60° 로 크게 주고,\n"
                  "  초점이 허락하는 만큼 거리도 바꿔 다시 찍어라",
                  file=sys.stderr)
            return 1
    else:
        print("⚠ 사진이 적어 안정성 검사를 건너뛴다 — 8장 이상이면 fx 흔들림을 잡는다")

    # 화면을 얼마나 덮었나. 안 덮인 구역의 렌즈 값은 **측정이 아니라 추정**이다.
    A = np.vstack([p.reshape(-1, 2) for p in img_pts])
    cov_x = (A[:, 0].max() - A[:, 0].min()) / size[0]
    cov_y = (A[:, 1].max() - A[:, 1].min()) / size[1]
    print(f"덮은 범위: 가로 {cov_x*100:.0f}% · 세로 {cov_y*100:.0f}%"
          + ("" if min(cov_x, cov_y) >= 0.6 else "  ⚠ 덮이지 않은 구역의 왜곡은 추정값이다"))

    doc = json.loads(CONF.read_text(encoding="utf-8")) if CONF.exists() else {}
    doc.update({
        "_생성됨": "python3 scripts/map/{intrinsics,extrinsics}.py — 직접 고치지 마라",
        "_단위": "밀리미터 · 도. 하드 룰 5",
        "_원점": "labToCam 의 원점은 calib-shots/tag-layout.json 이 정의한다 (지금은 상판 태그 id0 · "
                 "상판 평면 z=0). **실험실 바닥 원점(SR_23)도 로봇 베이스도 아니다** — "
                 "docs/ref/contract/LAYOUT-METRICS-CONTRACT.md §원점은 하나가 아니다",
        "intrinsics": {
            "widthPx": size[0], "heightPx": size[1],
            "fx": fx, "fy": fy, "cx": cx, "cy": cy,
            "dist": dist.ravel().tolist(),
            "hfovDeg": round(float(hfov), 2), "vfovDeg": round(float(vfov), 2),
            "rmsPx": round(float(rms), 4), "shots": len(used),
        },
    })
    # 렌즈가 바뀌면 위치도 무효다 — 조용히 남겨 두면 다음 사람이 옛 값을 믿는다
    if doc.pop("labToCam", None) is not None:
        print("⚠ 기존 labToCam 을 지웠다 — 내부 파라미터가 바뀌면 위치도 다시 풀어야 한다")
    CONF.parent.mkdir(parents=True, exist_ok=True)
    CONF.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{CONF.relative_to(ROOT)} · 다음은 extrinsics.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
