#!/usr/bin/env python3
"""웹캠 사진을 찍어 폴더에 쌓는다 — 캘리브레이션 입력물 수집.

**되돌릴 수 있는 것만 한다** (dev/ 규약). 설정 파일을 안 건드리고 사진만 남긴다.

카메라 설정을 여기서 **잠근다** — 캘리브레이션 결과는 해상도·초점에 종속이라
찍을 때와 쓸 때가 다르면 값이 통째로 무효가 된다.

  · 오토포커스 OFF — 초점이 변하면 화각도 같이 변한다 (focus breathing)
  · 해상도 고정 — 요청이 무시되는 웹캠이 많아서 **실제 적용값을 찍어 준다**

    python3 scripts/map/capture.py charuco          # ChArUco 15~20 장
    python3 scripts/map/capture.py tags --shots 1   # 태그 배치 1 장
    python3 scripts/map/capture.py charuco --device 1 --width 2560 --height 1440
    python3 scripts/map/capture.py tags --device http://192.168.0.9:8080/video   # 폰 IP캠

SPACE 저장 · Q 종료. 창이 안 뜨면 터미널에 카메라 권한을 준 뒤 다시 실행한다.

## `--auto` — 창 없이, 화면을 **구석까지** 채우게 시킨다 (2026-08-06)

카메라가 벽에 붙어 있으면 창을 볼 사람이 그 앞에 없다. 그리고 손으로 SPACE 를 누르면
**보드가 편한 자리(가운데)에만 모인다** — 실측: 20장이 화면 폭의 28% 안에서만 찍혔고,
그 결과 fx 가 1351~2351 로 아예 안 정해졌다 (RMS 는 0.38 로 멀쩡했다).

`--auto` 는 화면을 3x3 으로 나눠 **아직 안 찬 칸에 보드가 들어왔을 때만** 저장한다.
사람은 보드를 들고 걸어 다니기만 하면 되고, 다 차면 스스로 멈춘다.

    python3 scripts/map/capture.py charuco --auto \
        --device http://192.168.30.8:8080/video --width 2560 --height 1440
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "calib-shots"      # .gitignore 대상 — 측정 원본이지 SSOT 가 아니다
SPEC = ROOT / "Shared/assets/tag/tags.json"

MIN_CORNERS = 12        # 이보다 적으면 자세가 안 풀린다 (intrinsics.py 와 같은 기준)
CELLS = 3               # 화면을 3x3 으로 본다 — 구석 네 칸이 초점거리를 정하는 칸이다
MOVE_MM_PX = 120        # 같은 칸 안에서도 이만큼은 움직여야 새 장으로 친다


def load_detector():
    """ChArUco 보드 규격은 `tags.json` 이 주인이다 (intrinsics.py 와 같은 것을 읽는다)."""
    s = json.loads(SPEC.read_text(encoding="utf-8"))
    c = s["charuco"]
    dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, s["family"]))
    board = cv2.aruco.CharucoBoard((c["cols"], c["rows"]), c["squareMm"], c["markerMm"], dic)
    return cv2.aruco.CharucoDetector(board)


def grid_map(counts, per_cell):
    """3x3 진행 상황을 글자로 — 사람이 다음에 어디로 갈지 한눈에 본다."""
    rows = []
    for r in range(CELLS):
        rows.append(" ".join(
            ("■" if counts.get((r, c), 0) >= per_cell else
             "▨" if counts.get((r, c), 0) else "□") for c in range(CELLS)))
    return rows


def next_index(out):
    """다음 번호는 **파일 개수가 아니라 최대 번호 + 1** 이다.

    개수로 정하면 중간이 비었을 때(못 쓰는 장을 골라내면 늘 빈다) 번호가 되감겨
    **이미 있는 사진을 덮어쓴다** — 실측 2026-08-07: 019~038 이 있는 폴더에서
    021 부터 다시 시작해 어제 17장을 지웠다.
    """
    ns = [int(p.stem.rsplit("-", 1)[-1]) for p in out.glob("*.png")
          if p.stem.rsplit("-", 1)[-1].isdigit()]
    return max(ns, default=0)


def auto_charuco(cap, out, kind, per_cell, size):
    """빈 칸에 보드가 들어왔을 때만 저장한다. 다 차면 멈춘다."""
    det = load_detector()
    counts, last = {}, {}
    n = next_index(out)
    total = CELLS * CELLS * per_cell
    print(f"칸마다 {per_cell} 장 · 목표 {total} 장. 보드를 들고 화면 구석까지 다녀라.\n"
          "  ■ 다 참 · ▨ 모자람 · □ 빈 칸    (Ctrl-C 로 언제든 중단)")
    while sum(min(v, per_cell) for v in counts.values()) < total:
        # MJPEG 는 버퍼가 쌓여 몇 초 전 장면이 나온다 — 버리고 최신 프레임을 쓴다
        for _ in range(4):
            cap.grab()
        ok, frame = cap.read()
        if not ok:
            print("프레임을 못 읽는다", file=sys.stderr)
            return n
        cc, ci, _, _ = det.detectBoard(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        if cc is None or len(cc) < MIN_CORNERS:
            time.sleep(0.2)
            continue
        ctr = cc.reshape(-1, 2).mean(axis=0)
        cell = (min(int(ctr[1] / size[1] * CELLS), CELLS - 1),
                min(int(ctr[0] / size[0] * CELLS), CELLS - 1))
        if counts.get(cell, 0) >= per_cell:
            time.sleep(0.2)
            continue
        # 같은 자리에서 연사하면 장수만 늘고 정보는 안 는다
        if cell in last and np.hypot(*(ctr - last[cell])) < MOVE_MM_PX:
            time.sleep(0.2)
            continue
        n += 1
        counts[cell] = counts.get(cell, 0) + 1
        last[cell] = ctr
        cv2.imwrite(str(out / f"{kind}-{n:03d}.png"), frame)   # 오버레이 없는 원본
        print(f"  저장 {kind}-{n:03d}.png · 칸 {cell} · 코너 {len(cc)}")
        for row in grid_map(counts, per_cell):
            print(f"      {row}")
        time.sleep(0.6)     # 사람이 다음 자리로 옮길 틈
    print("다 찼다 — 이제 python3 scripts/map/intrinsics.py")
    return n


def _phone_host(device):
    """`http://192.168.30.8:8080/video` → `192.168.30.8:8080`. 폰 IP캠이 아니면 None.

    USB 웹캠(번호)에는 잠글 HTTP 설정이 없다 — 그건 `cap.set()` 으로 이미 한다.
    """
    m = re.match(r"^https?://([^/]+)/", str(device))
    return m.group(1) if m else None


def _lock_phone(host):
    """`cam-lock.sh` 를 그대로 부른다 — 값·판정을 여기서 다시 짜지 않는다.

    잠금 규칙은 그 스크립트 하나가 정본이고, 값은 `Shared/data/camera/lock.json` 이다.
    여기서 흉내 내면 **세 곳이 되어** 갈린다 (하드 룰 5).
    """
    lock = ROOT / "scripts" / "map" / "cam-lock.sh"
    print(f"== 찍기 전 폰 설정 잠금 ({host}) ==")
    return subprocess.call(["bash", str(lock), "--host", host])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["charuco", "tags"], help="무엇을 찍는가")
    # USB 웹캠은 번호(0,1,...), 폰 IP캠은 MJPEG **URL**. cv2 가 둘 다 받는다.
    ap.add_argument("--device", default="0", help="웹캠 번호 또는 MJPEG URL")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--shots", type=int, default=20, help="이 장수를 채우면 알려준다")
    ap.add_argument("--auto", action="store_true",
                    help="창 없이 3x3 빈 칸을 채운다 (charuco 전용 · 위 §--auto)")
    ap.add_argument("--per-cell", type=int, default=2, help="--auto 에서 칸마다 몇 장")
    ap.add_argument("--no-lock", action="store_true",
                    help="폰 설정 자동 잠금을 건너뛴다 (USB 웹캠이거나 일부러 다른 설정으로 찍을 때)")
    a = ap.parse_args()
    if a.auto and a.kind != "charuco":
        print("--auto 는 charuco 전용이다 — tags 는 한 장이면 되므로 그냥 찍어라", file=sys.stderr)
        return 2

    # **찍기 전에 폰 설정을 잠근다** (2026-08-08). IP Webcam 에 저장·부팅시작 옵션이 없어
    # 앱을 재시작할 때마다 해상도·화질이 되돌아간다 — 사람이 매번 기억해야 했다.
    # 잊어도 사고는 안 났다(`extrinsics.py` 가 해상도 불일치를 거부한다). 대가가 "다시
    # 찍기" 였을 뿐인데, 랩에 가서 다시 찍는 것이 이 프로젝트에서 제일 비싼 왕복이다.
    if not a.no_lock and (host := _phone_host(a.device)):
        rc = _lock_phone(host)
        if rc != 0:
            print("잠금 실패 — 그대로 찍으면 캘리브레이션이 무효가 될 수 있다.", file=sys.stderr)
            print("  일부러 이 설정으로 찍는 것이면 --no-lock 을 붙여라", file=sys.stderr)
            return rc

    dev = int(a.device) if a.device.isdigit() else a.device
    cap = cv2.VideoCapture(dev)
    if not cap.isOpened():
        print(f"카메라 {a.device} 를 못 연다 — 다른 앱이 쓰고 있거나 권한이 없다", file=sys.stderr)
        print("  URL 이면 폰과 같은 와이파이인지, 브라우저로 그 주소가 열리는지 먼저 보라",
              file=sys.stderr)
        return 1

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, a.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, a.height)
    cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)

    got = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    af = cap.get(cv2.CAP_PROP_AUTOFOCUS)
    print(f"실제 적용 해상도 {got[0]}x{got[1]}   오토포커스 {af}")
    if got != (a.width, a.height):
        print(f"⚠ 요청({a.width}x{a.height})이 무시됐다 — 이 카메라가 못 내는 해상도다")
    if af not in (0, -1):
        print("⚠ 오토포커스가 안 꺼졌다 — 카메라 제조사 앱에서 수동으로 끄고 다시 찍어라")

    out = SHOTS / a.kind
    out.mkdir(parents=True, exist_ok=True)
    n = next_index(out)
    if a.auto:
        try:
            n = auto_charuco(cap, out, a.kind, a.per_cell, got)
        except KeyboardInterrupt:
            print("\n중단 — 찍은 것은 남는다")
        cap.release()
        print(f"총 {len(list(out.glob('*.png')))} 장 · {out.relative_to(ROOT)}/")
        return 0
    print(f"{out.relative_to(ROOT)}/ 에 이미 {len(list(out.glob('*.png')))} 장 "
          f"— 다음 번호 {n + 1:03d} · SPACE 저장, Q 종료")

    while True:
        ok, frame = cap.read()
        if not ok:
            print("프레임을 못 읽는다", file=sys.stderr)
            break
        view = frame.copy()
        cv2.putText(view, f"{n}/{a.shots}  SPACE=save  Q=quit", (16, 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
        cv2.imshow("map/capture", view)

        k = cv2.waitKey(1) & 0xFF
        if k == ord("q"):
            break
        if k == ord(" "):
            n += 1
            p = out / f"{a.kind}-{n:03d}.png"
            cv2.imwrite(str(p), frame)          # 원본 저장 — 오버레이가 없는 프레임이다
            print(f"  저장 {p.name}")
            if n == a.shots:
                print(f"  {a.shots} 장 채웠다. 각도·거리를 더 바꿔 찍으면 정확도가 오른다")

    cap.release()
    cv2.destroyAllWindows()
    print(f"총 {len(list(out.glob('*.png')))} 장 · {out.relative_to(ROOT)}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
