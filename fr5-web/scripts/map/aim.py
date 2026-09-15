#!/usr/bin/env python3
"""카메라를 **보면서** 맞춘다 — 태그가 몇 px/칸으로 잡히는지 실시간으로 띄운다.

높이·각도를 줄자로 계산해 맞추려면 화각을 알아야 하는데, 화각은 캘리브레이션을
해야 나온다. 순서가 물린다. 그래서 **재지 말고 본다** — 카메라를 옮기면서
숫자가 5 를 넘는 자리를 찾으면 그 자리가 정답이다.

판정은 **가장 나쁜 태그의 가장 짧은 변**으로 한다. 눕힌 태그는 부각만큼 한쪽이
단축되고, 화면 중앙의 여유는 먼 구석에서 사라진다 — 평균을 보면 놓친다.

    python3 scripts/map/aim.py                       # 웹캠 0
    python3 scripts/map/aim.py --device 1 --width 1920 --height 1080

Q 종료. 창이 안 뜨면 터미널에 카메라 권한을 준 뒤 다시 실행한다.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "Shared/assets/tag/tags.json"

SAFE = 5.0     # 안전선 (px/칸) — 이 위면 조명이 나빠도 잡힌다
RISKY = 3.0    # 이 아래는 조명이 조금만 나빠도 놓친다


def px_per_cell(corner, cells):
    """네 모서리 → **가장 짧은 변** 기준 칸당 픽셀. 단축된 방향이 곧 한계다."""
    p = corner.reshape(4, 2)
    sides = [np.linalg.norm(p[i] - p[(i + 1) % 4]) for i in range(4)]
    return min(sides) / cells


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="0", help="웹캠 번호 또는 MJPEG URL")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    a = ap.parse_args()

    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    cells = spec["cellsPerSide"]
    dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, spec["family"]))
    # 모서리 정밀화 — `extrinsics.py` 와 **같은 설정이어야** 여기서 본 px/칸 이 거기서도 산다
    # (기본 `NONE` 은 멀고 흐린 태그를 놓치거나 작게 잡는다 · 2026-08-08).
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_APRILTAG
    det = cv2.aruco.ArucoDetector(dic, params)

    dev = int(a.device) if a.device.isdigit() else a.device
    cap = cv2.VideoCapture(dev)
    if not cap.isOpened():
        print(f"카메라 {a.device} 를 못 연다 — 다른 앱이 쓰고 있거나 권한이 없다", file=sys.stderr)
        return 1
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, a.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, a.height)
    cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"실제 적용 해상도 {w}x{h}")
    if (w, h) != (a.width, a.height):
        print(f"⚠ 요청({a.width}x{a.height})이 무시됐다 — 이 카메라가 못 내는 해상도다")
    print(f"안전선 {SAFE} px/칸 · 위험선 {RISKY} px/칸 · Q 종료")

    while True:
        ok, frame = cap.read()
        if not ok:
            print("프레임을 못 읽는다", file=sys.stderr)
            break
        corners, ids, _ = det.detectMarkers(frame)
        worst = None
        if ids is not None:
            cv2.aruco.drawDetectedMarkers(frame, corners, ids)
            for c, i in zip(corners, ids.ravel()):
                v = px_per_cell(c, cells)
                worst = v if worst is None else min(worst, v)
                p = c.reshape(4, 2).mean(axis=0).astype(int)
                cv2.putText(frame, f"{int(i)}:{v:.1f}", (p[0] - 30, p[1]),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)

        n = 0 if ids is None else len(ids)
        if worst is None:
            msg, col = f"tags 0/4  --  move camera", (0, 0, 255)
        else:
            col = (0, 200, 0) if worst >= SAFE else (
                (0, 165, 255) if worst >= RISKY else (0, 0, 255))
            verdict = "OK" if worst >= SAFE else ("TIGHT" if worst >= RISKY else "TOO SMALL")
            msg = f"tags {n}/4   worst {worst:.1f} px/cell   {verdict}"
        cv2.putText(frame, msg, (16, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9, col, 2)
        cv2.putText(frame, "green>=5.0  orange>=3.0  red<3.0", (16, h - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
        cv2.imshow("map/aim  -  Q to quit", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
