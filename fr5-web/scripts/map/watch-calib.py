#!/usr/bin/env python3
"""폰 프레임 → 저장된 `labToCam` 으로 재투영 → **겹침 오차를 파일로 낸다** (단계 A2 · V1).

`extrinsics.py` 는 **새로 푼다**(카메라가 어디 있나). 이쪽은 **안 푼다** — 이미 저장된 자세로
지금 프레임을 다시 그려 보고 **얼마나 어긋나는지만** 잰다. 그래서 카메라가 움직였는지를
사람이 안 물어봐도 알 수 있다 (GAP P1 · `Shared/data/camera/state.js` §driftRow).

    실측 2026-08-08 — 폰을 25mm 옮기니 이 값이 1.25px → **49.7px** 이 됐다.
    경고선 5.0px 은 그 사이에 있다.

**왜 파이썬인가 (V1)** — 검출도 `solvePnP` 도 `extrinsics.py` 에 이미 있다. 새 의존성 0,
새 배관 0(계약 §정적 서빙의 `/config` 를 그대로 쓴다). 여기서 나온 실제 잡음·오탐률이
경고선을 확정한다.
`ponytail:` **천장** — 이 프로세스가 폰과 같은 망에 떠 있어야 한다. "서버 없이 폰만 있으면
되게" 하고 싶어지면 그때 브라우저(OpenCV.js WASM · 2560 에서 5.9Hz 실측)로 올린다.

**감시기가 죽으면 파일이 얼어붙는다** — 그게 이 판에서 제일 위험한 고장이다. 마지막 초록값이
영원히 남아 화면이 계속 "괜찮다" 고 말한다. 그래서 **찍은 시각을 같이 싣고**, 판정하는 쪽이
낡은 값을 「확인 못 함」으로 읽는다. 값을 믿는 근거는 값이 아니라 **값의 나이**다.

    python3 scripts/map/watch-calib.py --host 192.168.30.8:8080
    python3 scripts/map/watch-calib.py --host … --once     # 한 번만 재고 끝낸다
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "Shared/assets/tag/tags.json"
CONF = ROOT / "Shared/data/config/global-cam.json"
LAYOUT = ROOT / "calib-shots/tag-layout.json"
OUT = ROOT / "Shared/data/config/global-cam-drift.json"

SHOTS = ROOT / "calib-shots/tags"
PERIOD_S = 1.0    # 화면은 3초마다 읽는다 — 그보다 촘촘하면 읽히지 않을 값을 만든다
TIMEOUT_S = 4.0   # 없는 주소에 매달리지 않는다 (`state.js` 의 4초와 같은 뜻)
MIN_TAGS = 3      # 평면 위 3장이면 자세가 풀린다. 그 아래는 **못 잰 것**이다

# ── 자동 재캘리브 (2026-08-13 · `--auto`) ────────────────────────────────────────
#
# **폰은 설치할 때마다 조금씩 자리가 바뀐다** (실기 담당자 2026-08-13). 그래서 "한 번 풀면 끝"
# 이라는 전제가 성립하지 않는다 — 같은 날 **한 시간 안에 두 번** 깨졌다
# (`docs/evidence/2026-08-13/cam-zone-overlay.md`: 하향각 18.83° → 23.4° → 18.3°).
# 알림만 내면 사람이 매번 `extrinsics.py` 를 불러야 하고, 안 부르면 화면이 **낡은 자세로
# 조용히 틀린 선**을 긋는다. 그 고장 종류를 없애려고 여기서 다시 푼다.
#
# ⚠ **자동으로 SSOT 를 덮는 코드다.** 그래서 가드가 넷이고, 하나라도 못 넘으면 안 쓴다.
AUTO_WARN_PX = 5.0     # 화면 경고선과 같은 값 (`Shared/data/camera/state.js`)
AUTO_STREAK = 5        # ① 연속 이 횟수(=초) 넘어야 한다 — 사람이 잠깐 가린 것과 가른다
AUTO_MAX_RMS = 2.0     # ② 새로 푼 해가 이보다 나쁘면 안 쓴다 (`extrinsics.py` MAX_RMS 와 같다)
AUTO_JUMP_MM = 500.0   # ③ 자세가 이보다 튀면 재거치가 아니라 **잘못 푼 것**이다. 거부하고 외친다
# ④ **몇 장인가가 아니라 어떻게 퍼졌는가**를 본다 (2026-08-19 개정).
#    3장(전부 한 평면)으로 풀면 **평면 안에서는 오차가 안 보인다**: 실측으로 x 가 176mm
#    틀렸는데 재투영 RMS 는 0.32px 로 완벽해 보였다 (`GAP-MATRIX` · id4 를 넣자 사라졌다).
#    ⛔ 그래서 예전엔 「배치도에 있는 것을 **전부**」로 막았는데, 그건 **가림에 통째로 진다** —
#    카트 상판 넉 장이 로봇 바로 옆에 몰려 있어 **팔이 한 장만 가려도 영영 안 푼다**.
#    2026-08-19 하루에만 그 이유로 세 번 멈췄다(id1: 팔·종이 겹침·팔).
#    ▶ 진짜로 필요한 것은 장수가 아니라 **기하**다 — 넓게 퍼졌나, 한 평면에만 있지 않나.
#    그래서 조건을 배치도 **자기 자신에 대한 비율**로 적는다. 방 기준 4장만 있는 옛 배치도에서는
#    예전과 같이 동작하고(3장 → 거부 · 4장 → 통과), 태그를 늘리면 그만큼 가림에 강해진다.
AUTO_MIN_TAGS = 4         # 평면 degeneracy 를 벗어나는 최소 장수
AUTO_MIN_SPAN_FRAC = 0.6  # 검출분이 배치도 전체 퍼짐의 이만큼은 덮어야 한다
AUTO_MIN_Z_FRAC = 0.5     # 배치도가 z 퍼짐을 가졌으면 그 절반은 살아 있어야 한다


def make_detector(dic):
    """태그 검출기 — **OpenCV 4.7 에서 API 가 갈렸다.**

    이 스크립트만 두 판을 다 탄다. `extrinsics.py` 는 맥(4.13)에서만 돌지만 이건 **브리지
    호스트에 상주**하는데 거기는 4.6 이다 — 4.6 에서 `DetectorParameters()` 를 생성자처럼
    부르면 **예외가 아니라 세그폴트**로 죽는다(2026-08-08 실측 exit 139). 그래서 유무를
    보고 가른다.

    ⚠ **두 판의 모서리가 같다는 보장은 없다.** 그래서 같은 사진으로 재투영을 재서
    차이를 확인했다 — `docs/evidence/2026-08-08/calib-runtime-and-drift-row.md` §판 차이.
    검출기 기본값 하나가 105mm 를 만든 게 D91 이라, 여기서 넘겨짚지 않는다.
    """
    if hasattr(cv2.aruco, "ArucoDetector"):                 # 4.7+
        p = cv2.aruco.DetectorParameters()
        p.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_APRILTAG
        det = cv2.aruco.ArucoDetector(dic, p)
        return det.detectMarkers
    p = cv2.aruco.DetectorParameters_create()               # 4.6
    p.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_APRILTAG
    return lambda g: cv2.aruco.detectMarkers(g, dic, parameters=p)


def layout_span(pts):
    """점무리의 **가로 퍼짐(최대 거리)** 과 **세로 퍼짐(z 범위)**. 가드 ④ 가 쓴다."""
    P = np.asarray(pts, float)
    if len(P) < 2:
        return 0.0, 0.0
    d = np.linalg.norm(P[:, None, :2] - P[None, :, :2], axis=-1)
    return float(d.max()), float(P[:, 2].max() - P[:, 2].min())


def geometry_ok(op, full_span, full_z):
    """가드 ④ — 이 검출분으로 **다시 풀어도 되는 기하인가**. `(ok, 사유)`."""
    # ⛔ **`if op` 로 묻지 않는다** (2026-08-19 실측). `op` 는 numpy 배열로 들어오는데
    # 다중 원소 배열의 참거짓은 `ValueError` 다 — 그리고 이 줄은 **자동 재정합이 걸리려는
    # 바로 그 순간에만** 지나가므로, 평소엔 멀쩡하다가 **정작 필요할 때 죽는다.**
    # 실제로 그렇게 됐다: 카메라가 움직여 rms 207 이 된 순간 감시기가 이 줄에서 터졌다.
    n = (len(op) // 4) if op is not None and len(op) else 0
    if n < AUTO_MIN_TAGS:
        return False, f"태그 {n}장 (최소 {AUTO_MIN_TAGS})"
    span, zspan = layout_span(op)
    if full_span > 0 and span < full_span * AUTO_MIN_SPAN_FRAC:
        return False, f"퍼짐 {span:.0f}mm (배치도 {full_span:.0f}의 {AUTO_MIN_SPAN_FRAC:.0%} 필요)"
    if full_z > 0 and zspan < full_z * AUTO_MIN_Z_FRAC:
        return False, f"높이 퍼짐 {zspan:.0f}mm (배치도 {full_z:.0f}의 {AUTO_MIN_Z_FRAC:.0%} 필요)"
    return True, ""


def corners_3d(t, size, default_yaw):
    """`extrinsics.py` 와 **같은 규약이어야 한다** — 다르면 여기서만 어긋난 값이 나온다."""
    # ⭐ **태그마다 크기가 다를 수 있다** (2026-08-19). 배치도에 방 기준 4장만 있을 때는
    # 전부 145mm 라 전역 하나로 충분했다. 조립셀 태그(84~134mm)를 배치도에 올리면서
    # 항목별 `tagSizeMm` 을 허용한다 — 없으면 전역값을 그대로 쓴다(옛 배치도 그대로 산다).
    h = t.get("tagSizeMm", size) / 2
    yaw = np.radians(t.get("yawDeg", default_yaw))
    c, s = np.cos(yaw), np.sin(yaw)
    local = [(-h, +h), (+h, +h), (+h, -h), (-h, -h)]
    return [(t["xMm"] + c * lx - s * ly, t["yMm"] + s * lx + c * ly, t.get("zMm", 0))
            for lx, ly in local]


def write(doc):
    """**원자적으로 쓴다** — 1초마다 덮어쓰는 파일을 화면이 3초마다 읽는다. 그냥 쓰면
    언젠가 반쪽짜리 JSON 을 읽고, 읽는 쪽은 그걸 「못 읽음」(경고)으로 처리한다 — 거짓 경고다.

    ⛔ **윈도우에서는 `os.replace` 가 읽는 사람이 있으면 거부한다** (2026-08-19 실측 · WinError 5).
    POSIX 는 열려 있는 파일 위로 rename 이 되지만 윈도우는 안 된다. 그런데 이 파일을 3초마다
    여는 사람이 바로 브리지(`StaticFiles`)라 **충돌은 확률이 아니라 시간 문제**였다 — 설치한 지
    한 시간 만에 감시기가 이 예외로 죽었고, **파일이 마지막 값(1.27px)에 얼어붙은 채** 화면은
    계속 초록을 냈다. 그 사이 카메라가 54mm 움직였는데 아무도 못 봤다. 이 파일의 머리말이
    *"제일 위험한 고장"* 이라 적어 둔 바로 그 모양이다.

    **그래서 못 바꾸면 죽지 않고 이번 틱을 건너뛴다.** 값이 안 바뀌면 `t` 가 안 올라가고,
    판정하는 쪽은 **나이로** 낡음을 안다 — 조용히 옛 값을 새 값인 척하지 않는다."""
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    for _ in range(20):                      # 읽는 쪽이 핸들을 놓는 데 보통 수 ms 다
        try:
            os.replace(tmp, OUT)
            return True
        except PermissionError:
            time.sleep(0.05)
    print("  파일을 못 바꿨다 — 읽는 사람이 안 놓는다. 이번 틱을 건너뛴다", file=sys.stderr)
    return False


class Frames:
    """**영상 스트림에서 최신 프레임을 뽑는다** — 정지촬영(`/shot.jpg`)을 안 쓴다 (2026-08-19).

    ⛔ **`/shot.jpg` 는 카메라를 잠깐 뺏는다.** IP Webcam 에서 그건 「사진 찍기」라, 같은 폰의
    MJPEG 을 보고 있는 사람 화면이 **하얗게 번쩍인다**. 감시기가 1초에 한 번 부르니 1초에 한 번
    번쩍였다. 게다가 영상과 부딪히면 **빈 응답**이 와서 `imdecode` 가 예외로 죽었고,
    작업 스케줄러가 재시작하며 또 찍었다 — 번쩍임이 더 잦아지는 되먹임이었다.

    ▶ 스트림 읽기는 카메라를 안 뺏는다. 실측(2026-08-19 · 20초·273프레임): 밝기 표준편차
      3.35 · 평균+3σ 넘는 프레임 **0장**.
    """

    def __init__(self, host):
        self.host, self.jpg, self.lock = host, None, threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        buf = b""
        while True:
            try:
                r = urllib.request.urlopen(f"http://{self.host}/video", timeout=TIMEOUT_S)
                while True:
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    buf += chunk
                    while True:      # 완성된 JPEG 만 꺼낸다 — 반쪽은 절대 안 넘긴다
                        a = buf.find(b"\xff\xd8")
                        b = buf.find(b"\xff\xd9", a + 2)
                        if a < 0 or b < 0:
                            break
                        with self.lock:
                            self.jpg = buf[a:b + 2]
                        buf = buf[b + 2:]
                    if len(buf) > 8 << 20:              # 프레임 경계를 잃었다 — 버리고 다시
                        buf = b""
            except Exception:                            # noqa: BLE001 — 끊기면 다시 붙는다
                pass
            self.jpg = self.jpg                          # 마지막 값은 남긴다. 나이로 낡음을 안다
            time.sleep(1.0)

    def latest(self):
        with self.lock:
            return self.jpg


def measure(host, detect, lay, I, E, K, dist, frames=None):
    """한 프레임 → `{rmsPx, tags}` 또는 `{rmsPx: None, reason}`.

    **못 잰 것을 0 으로 적지 않는다.** 0 은 "완벽하게 맞는다" 로 읽힌다 (제1원칙)."""
    raw = frames.latest() if frames is not None else None
    if raw is None:                                      # 스트림이 아직/영영 안 붙으면 정지컷으로
        try:
            with urllib.request.urlopen(f"http://{host}/shot.jpg", timeout=TIMEOUT_S) as r:
                raw = r.read()
        except Exception as e:                           # noqa: BLE001 — 무응답도 CORS 도 같은 뜻이다
            return {"rmsPx": None, "reason": "noFrame", "detail": str(e)[:80]}
    if not raw:
        return {"rmsPx": None, "reason": "noFrame", "detail": "빈 응답"}
    try:
        g = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
    except cv2.error as e:                               # 깨진 바이트에 **죽지 않는다**
        return {"rmsPx": None, "reason": "noFrame", "detail": str(e)[:80]}
    if g is None:
        return {"rmsPx": None, "reason": "noFrame", "detail": "디코드 실패"}

    # ── 해상도 — **스케일로 메운다** (2026-08-19 · 옛 결정을 뒤집는다)
    #
    # 예전엔 "해상도가 다르면 내부 파라미터가 안 맞는다 — 스케일로 메우지 않는다" 였다.
    # 그 조심은 **화각까지 달라질까 봐**였는데, 실측으로 아니었다: 같은 폰에서 2560x1440 /
    # 1920x1080 / 1280x720 으로 각각 풀어 카메라 위치가 **2.7mm · 0.5mm** 차이였다.
    # 폰은 센서를 다르게 자르지 않고 **줄이기만 한다** — 그러면 `fx·cx` 는 가로비에 정확히 비례한다.
    # ▶ 이걸 막아 두면 **보는 설정(가벼움)과 재는 설정(정밀)이 갈라져** 둘 중 하나를 포기해야 한다.
    #   폰을 뺐다 끼우는 한 카메라는 매번 움직이므로, **재는 쪽을 포기하면 안 된다.**
    # ⚠ 단 **가로세로비가 다르면** 잘라낸 것이라 비례가 안 통한다 — 그때는 여전히 거부한다.
    sx, sy = g.shape[1] / I["widthPx"], g.shape[0] / I["heightPx"]
    if abs(sx - sy) > 0.01:
        return {"rmsPx": None, "reason": "resolution",
                "detail": f"{g.shape[1]}x{g.shape[0]} — 가로세로비가 다르다 (잘렸다)"}
    if abs(sx - 1.0) > 1e-6:
        K = np.array([[I["fx"] * sx, 0, I["cx"] * sx],
                      [0, I["fy"] * sy, I["cy"] * sy], [0, 0, 1]])

    corners, ids, _ = detect(g)
    if ids is None:
        return {"rmsPx": None, "reason": "noTags", "detail": "0장"}
    op, ip = [], []
    for c, i in zip(corners, ids.ravel()):
        t = lay["tags"].get(str(int(i)))
        if t is None:
            continue
        op += corners_3d(t, lay["tagSizeMm"], lay.get("defaultYawDeg", 0))
        ip += list(map(tuple, c[0]))
    n = len(op) // 4
    if n < MIN_TAGS:
        return {"rmsPx": None, "reason": "noTags", "detail": f"{n}장 (최소 {MIN_TAGS})"}

    op, ip = np.array(op, np.float64), np.array(ip, np.float64)
    prj, _ = cv2.projectPoints(op, np.array(E["rvec"]), np.array(E["tvecMm"]), K, dist)
    d = np.linalg.norm(prj.reshape(-1, 2) - ip, axis=1)
    # `_op`·`_ip`·`_jpg` 는 **자동 재캘리브 전용**이라 밑줄로 가린다 — 파일로 나가면
    # 화면이 읽을 수 있는 값처럼 보이고, 이건 재는 값이 아니라 다시 풀 재료다
    return {"rmsPx": round(float(np.sqrt((d ** 2).mean())), 2),
            "maxPx": round(float(d.max()), 2), "tags": n,
            "_op": op, "_ip": ip, "_jpg": raw, "_K": K}


def resolve(op, ip, K, dist, prev_cam):
    """지금 프레임으로 자세를 **다시 푼다**. `extrinsics.py` 와 같은 규약이어야 한다.

    돌려주는 것은 판정까지 끝난 결과다 — 쓸지 말지는 부르는 쪽이 정한다.
    """
    # ⛔ **`SOLVEPNP_ITERATIVE` 하나만 믿지 않는다** — `extrinsics.py` 와 **같은 규약**이다.
    # 태그가 거의 한 평면이면 PnP 는 거울짝 해를 가진다. 아래 z 검사가 뒤집힌 해를 **거부**는
    # 하지만, 그러면 자동 재정합이 **조용히 영영 안 걸린다** — 거부만 하고 옳은 쪽을 못 찾는다.
    # 폰을 뺐다 끼울 때마다 카메라가 움직이는 판이라, 그건 기능이 없는 것과 같다.
    cands = []
    for flag in (cv2.SOLVEPNP_ITERATIVE, cv2.SOLVEPNP_SQPNP, cv2.SOLVEPNP_EPNP):
        try:
            got = cv2.solvePnPGeneric(op, ip, K, dist, flags=flag)
        except cv2.error:
            continue
        for rv_, tv_ in zip(got[1], got[2]):
            R_, _ = cv2.Rodrigues(rv_)
            if (-R_.T @ tv_).ravel()[2] <= 0:
                continue
            pr_, _ = cv2.projectPoints(op, rv_, tv_, K, dist)
            cands.append((float(np.sqrt(np.mean(np.sum((pr_.reshape(-1, 2) - ip) ** 2, axis=1)))),
                          rv_, tv_))
    if not cands:
        return None, "태그면 위에 있는 해가 없다"
    cands.sort(key=lambda c: c[0])
    rms, rvec, tvec = cands[0]
    R, _ = cv2.Rodrigues(rvec)
    cam = (-R.T @ tvec).ravel()
    fwd = (R.T @ np.array([0, 0, 1.0])).ravel()
    dep = float(np.degrees(np.arcsin(-fwd[2] / np.linalg.norm(fwd))))
    if rms > AUTO_MAX_RMS:                       # 가드 ② — 나쁜 해는 안 쓴다
        return None, f"새 해 RMS {rms:.2f} > {AUTO_MAX_RMS}"
    if cam[2] < 0:                               # `extrinsics.py` 와 같은 검사
        return None, "카메라가 태그 평면 아래로 나왔다"
    jump = float(np.linalg.norm(cam - np.array(prev_cam, float)))
    if jump > AUTO_JUMP_MM:                      # 가드 ③ — 재거치가 아니라 오해다
        return None, f"자세가 {jump:.0f}mm 튀었다 > {AUTO_JUMP_MM:.0f}"
    return {"rvec": rvec.ravel().tolist(), "tvecMm": tvec.ravel().tolist(),
            "camPosMm": cam.tolist(), "heightMm": round(float(cam[2]), 1),
            "depressionDeg": round(dep, 2), "rmsPx": round(rms, 3),
            "jumpMm": round(jump, 1)}, None


def main():
    ap = argparse.ArgumentParser()
    # ⛔ **주소를 두 곳에 두지 않는다** (하드 룰 5 · 2026-08-19). 브리지의 받침 추적도 **같은 폰**을
    # 보는데 그쪽은 `FR5_CAM_HOST` 로 받는다 (`FR5/bridge/main.py:652`). 여기 따로 박으면 폰이
    # 바뀔 때 **한 곳만 고치고 나머지는 조용히 옛 폰을 본다** — 그 고장은 화면이 **초록인 채로**
    # 난다(감시기는 옛 폰 화면으로 계속 「정합 좋음」을 낸다). 그래서 기본값을 같은 환경변수에서
    # 읽어 정본을 하나로 만든다. `--host` 는 그 위를 덮는 수동 우회로만 남는다.
    ap.add_argument("--host", default=os.environ.get("FR5_CAM_HOST", "").strip() or None,
                    help="폰 주소 (기본: 환경변수 FR5_CAM_HOST · 예 192.168.30.8:8080)")
    ap.add_argument("--once", action="store_true", help="한 번만 재고 끝낸다")
    ap.add_argument("--auto", action="store_true",
                    help="경고선을 연속으로 넘으면 **스스로 다시 푼다** (가드는 위 상수)")
    a = ap.parse_args()
    if not a.host:
        print("폰 주소가 없다 — FR5_CAM_HOST 를 설정하거나 --host 를 줘라", file=sys.stderr)
        return 1

    for p, what in ((CONF, "내부 파라미터·labToCam"), (LAYOUT, "태그 좌표")):
        if not p.exists():
            print(f"{what} 가 없다 — {p.relative_to(ROOT)}", file=sys.stderr)
            return 1
    doc = json.loads(CONF.read_text(encoding="utf-8"))
    I, E = doc.get("intrinsics"), doc.get("labToCam")
    if not I or not E:
        print("아직 안 풀렸다 — scripts/map/extrinsics.py 부터", file=sys.stderr)
        return 1
    lay = json.loads(LAYOUT.read_text(encoding="utf-8"))
    spec = json.loads(SPEC.read_text(encoding="utf-8"))

    dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, spec["family"]))
    # `extrinsics.py` 와 **같은 정밀화** — 다르면 여기 숫자가 저기서 안 산다 (D91)
    detect = make_detector(dic)
    K = np.array([[I["fx"], 0, I["cx"]], [0, I["fy"], I["cy"]], [0, 0, 1]])
    dist = np.array(I["dist"])

    # 가드 ④ 의 기준선 — **배치도 전체**의 퍼짐. 검출분을 여기 대고 잰다
    all_pts = [c for t_ in lay["tags"].values()
               for c in corners_3d(t_, lay["tagSizeMm"], lay.get("defaultYawDeg", 0))]
    full_span, full_z = layout_span(all_pts)
    print(f"{a.host} 감시 시작 · 기준 {E['shot']} (RMS {E['rmsPx']}px) → "
          f"{OUT.relative_to(ROOT)}")
    if a.auto:
        print(f"  자동 재캘리브 켜짐 — {AUTO_WARN_PX}px 를 연속 {AUTO_STREAK}회 넘고 "
              f"기하 조건(≥{AUTO_MIN_TAGS}장 · 퍼짐 ≥{full_span * AUTO_MIN_SPAN_FRAC:.0f}mm"
              + (f" · 높이 ≥{full_z * AUTO_MIN_Z_FRAC:.0f}mm" if full_z > 0 else "")
              + ")를 넘을 때만 다시 푼다")
    frames = Frames(a.host)      # 정지촬영 대신 영상 스트림에서 뽑는다 (§Frames)
    streak = 0
    conf_mtime = CONF.stat().st_mtime
    while True:
        # ⭐ **캘리브가 밖에서 바뀌면 받아 든다** (2026-08-19). 사람이 `extrinsics.py` 로 다시
        # 풀어 배포하면 이 프로세스는 **옛 기준으로 계속 재고**, drift 의 `basis` 도 안 바뀐다.
        # 그러면 화면도 「바뀐 줄」을 모른다 — 화면의 갈아타기가 `basis` 를 보기 때문이다.
        # 즉 **한 곳이 안 읽으면 사슬 전체가 안 갈아탄다.** mtime 만 보므로 값이 싸다.
        try:
            m = CONF.stat().st_mtime
            if m != conf_mtime:
                nd = json.loads(CONF.read_text(encoding="utf-8"))
                if nd.get("intrinsics") and nd.get("labToCam"):
                    conf_mtime, doc = m, nd
                    I, E = doc["intrinsics"], doc["labToCam"]
                    K = np.array([[I["fx"], 0, I["cx"]], [0, I["fy"], I["cy"]], [0, 0, 1]])
                    dist = np.array(I["dist"])
                    print(f"  기준을 밖에서 갈았다 — {E.get('shot')} (RMS {E.get('rmsPx')}px)")
        except Exception:            # noqa: BLE001 — 반쯤 쓰인 파일이면 다음 틱에 다시 본다
            pass

        r = measure(a.host, detect, lay, I, E, K, dist, frames)
        op, ip, jpg = r.pop("_op", None), r.pop("_ip", None), r.pop("_jpg", None)
        # ⚠ 다시 풀 때는 **그 프레임에서 실제로 쓴 K** 여야 한다 — 해상도가 다르면 스케일돼 있다
        Kf = r.pop("_K", K)
        note = None

        # ── 자동 재캘리브. **가드를 하나라도 못 넘으면 안 쓴다** (제1원칙과 같은 방향)
        if r["rmsPx"] is None or r["rmsPx"] <= AUTO_WARN_PX:
            streak = 0
        else:
            streak += 1
            if a.auto and streak >= AUTO_STREAK:        # 가드 ①
                ok4, why4 = geometry_ok(op, full_span, full_z)   # 가드 ④
                if not ok4:
                    note = f"다시 안 푼다 — {why4}"
                else:
                    new, why = resolve(op, ip, Kf, dist, E["camPosMm"])
                    if new is None:
                        note = f"다시 안 푼다 — {why}"
                    else:
                        # **프레임을 남긴다.** 근거 사진 없는 캘리브는 나중에 못 따진다.
                        # 이름이 곧 `basis` 라 화면이 「어느 기준으로 잰 값인가」를 대조한다
                        SHOTS.mkdir(parents=True, exist_ok=True)
                        name = f"tags-auto-{time.strftime('%Y%m%d-%H%M%S')}.jpg"
                        # `_jpg` 는 **bytes** 다 (2026-08-19 · numpy 배열에서 바꿨다)
                        (SHOTS / name).write_bytes(
                            jpg if isinstance(jpg, (bytes, bytearray)) else jpg.tobytes())
                        before = dict(E)
                        doc["labToCam"] = {**new, "tags": r["tags"], "shot": name}
                        doc["verified"] = True
                        CONF.write_text(json.dumps(doc, ensure_ascii=False, indent=1),
                                        encoding="utf-8")
                        E = doc["labToCam"]             # 다음 프레임부터 새 기준으로 잰다
                        streak = 0
                        # **조용히 바꾸지 않는다** — before/after 를 남겨야 나중에 추적된다.
                        # ⚠ `drift.json` 의 `note` 로는 안 된다: 그 파일은 **1초마다 덮어써져서**
                        # 기록이 증발한다. 표준출력도 안 된다: 상주 프로세스라 버퍼에 갇히고
                        # 유닛으로 돌리면 아무도 안 본다. **덧붙이는 파일**이라야 남는다.
                        line = (f"{time.strftime('%Y-%m-%d %H:%M:%S')}  "
                                f"RMS {r['rmsPx']:.1f} → {new['rmsPx']:.2f}px · "
                                f"하향각 {before.get('depressionDeg')}° → {new['depressionDeg']}° · "
                                f"이동 {new['jumpMm']}mm · {before.get('shot')} → {name}\n")
                        with (SHOTS.parent / "recalib.log").open("a", encoding="utf-8") as f:
                            f.write(line)
                        print("  ▶ 다시 풀었다 — " + line.strip(), flush=True)
                        note = f"자동 재캘리브 — {before.get('shot')} → {name}"

        # **찍은 시각을 싣는다** — 이게 없으면 감시기가 죽어도 화면이 계속 초록이다
        write({"_": "scripts/map/watch-calib.py 산출물 — 직접 고치지 마라",
               "t": time.time(), "basis": E["shot"], **r,
               **({"note": note} if note else {})})
        print(f"  {time.strftime('%H:%M:%S')}  "
              + (f"{r['rmsPx']:6.2f} px · 최대 {r['maxPx']:.2f} · 태그 {r['tags']}"
                 if r["rmsPx"] is not None else f"못 쟀다 — {r['reason']} ({r['detail']})")
              + (f"   [{note}]" if note and not note.startswith("자동") else ""))
        if a.once:
            return 0
        time.sleep(PERIOD_S)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n멈췄다 — 파일은 마지막 값 그대로다. **나이가 늙으므로 화면은 곧 「확인 못 함」이 된다**")
