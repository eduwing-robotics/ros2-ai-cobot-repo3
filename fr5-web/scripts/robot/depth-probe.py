#!/usr/bin/env python3
"""깊이 한 장에서 「책상 위로 솟은 것」을 찾는다 — GOAL-depth-tuning 칸 1 의 계기.

**왜 평면 피팅인가** — 이 계기가 쓰는 `depth/frame`은 컬러와 정렬돼 있지 않다. 책상은 평면이고
물체는 그 위에 솟아 있으므로 일반 높이 측정은 **깊이 하나로** 갈린다. 다만 황동 총알처럼 깊이가
빠지는 대상은 D207의 `rgbd/frame`을 `carrier-find.py`가 따로 쓴다.

**내부 파라미터가 필요 없다.** 평면을 3D 로 세우면 초점거리가 필요하지만, 평면 위 점들은
**역깊이(1/z)가 화소 좌표의 1차식**이라는 성질이 있다 — (u,v)→(u',v') 가 어파인이라 선형성이
보존된다. 그래서 `1/z = a·u + b·v + c` 를 그냥 최소제곱으로 맞추면 되고, 높이는 mm 로 바로 나온다.
관문이 내부 파라미터를 안 내보내는 지금 상태에서 **기다릴 것이 없다**는 뜻이다.

사용:
    python3 scripts/robot/depth-probe.py                    # 브리지에서 한 장 받아 잰다
    python3 scripts/robot/depth-probe.py --png d.png        # 이미 받은 PNG 를 잰다
    python3 scripts/robot/depth-probe.py --save d.png       # 받은 원본을 남긴다
"""
import argparse
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / 'dev'))
from host import require as _require   # noqa: E402  (경로 주입 뒤에 온다)

import json
import sys
import urllib.request
from io import BytesIO

import math

import numpy as np
from PIL import Image

# 호스트가 윈도우로 옮겨졌다 (2026-08-11 · `windows-host-fr5-vision`). 옛 우분투는 240 이었다
# ⚠ **낡은 숫자다** — 호스트는 DHCP 라 바뀐다 (2026-08-31 에 `.18 → .6`).
# 주소는 `scripts/dev/host.sh` 가 **이름으로** 푼다 — 여기 숫자를 박지 않는다 (D164).
# ⛔ 옛 기본값 `192.168.30.18` 은 **이미 낡아 있었다**: 주석은 「믿지 마라」였는데
#    코드는 그 숫자를 그대로 썼다. 경고를 산문에 두지 말고 **코드에서 없앤다**.
# ⛔ **여기서 부르지 않는다** — 최상단에서 호스트를 요구하면 `--help` 도, 이 파일을
#    통째로 실행해 불러오는 `handeye-probe.py` 도 호스트 없이는 죽는다.
#    **쓸 때** 푼다 (`--url` 을 안 준 경우에만).
def default_url():
    return _require(5058, "/api/camera/depth/frame", "카메라 브리지")
# 깊이 내부 파라미터 — **관문이 안 내보내서 여기 박는다** (2026-08-11 실기 조회 · 848 폭 기준.
# `STACK.md` §깊이 노브 계열). 관문이 `/state` 로 내보내게 되면 여기를 지운다 — GAP 대상.
# 높이 판정 자체는 이 값을 안 타지만 **기울기 보정에는 필요하다** (아래 §tilt).
FX848, FY848, CX848, CY848 = 425.9, 425.9, 427.0, 247.3
# 실물 최대(림) 지름 10mm (`Shared/data/props.js` ROUND · 자 2026-08-11) ±30% —
# 계약이 아니라 **이 골의 판정선**이다.
# ⛔ **2026-08-13 정정.** 여기 9.6 / 6.7~12.5 로 적혀 있던 것은 `ROUND_5_56`(**다른 탄종의
# STL**) 값이었다. 실물이 다른 탄이라는 것은 08-11 에 확인됐는데 판정선이 안 따라왔고,
# 그래서 08-12 evidence 가 「실물 9.6 대비 −7.6%」로 적혔다 — 실제로는 10 대비 −11.3% 다.
# ⛔ **이 판정선은 「눕힌 총알」 기준이다** (2026-08-27 · 세워 꽂기가 정본이 된 뒤로 거짓).
#    실측: 세워 꽂으면 총알이 **스테레오 그림자로 자기를 지운다** — 받침 영역 **21%가 무효**이고
#    솟은 덩어리가 **4개뿐**(2~5mm · 8개가 꽂혀 있는데). 즉 **문턱을 낮춰도 안 고쳐진다** —
#    2mm 로 내리면 잡음까지 물고, 4/8 은 그대로다. 기하가 스스로를 막는 것이다(GAP P1 · D122).
#    ⛔ **그래서 숫자를 지어내 바꾸지 않았다.** 세운 자세용 판정은 「지름」이 아닌 다른 방법이
#    필요하고(비스듬히 40° 이내 · 컬러 · 무효 구멍 뒤집기 셋이 후보), 그건 실측이 정한다.
#    근거 `docs/evidence/2026-08-27/standing-bullets-depth-holes.png`
PEAK_MIN_MM, PEAK_MAX_MM = 7.0, 13.0
# ── 세운 총알 — **높이가 아니라 「덩어리가 실제로 몇 mm 인가」로 잰다** (2026-08-31 · D159) ──
#
# 위 §정정이 예고한 자리에 도착했다. 세우면 평면 위로 솟는 높이가 **지름이 아니라 길이**라
# 7~13mm 자를 그대로 대면 영원히 거부다 — 2026-08-31 실측: 총알 넷을 또렷이 잡아 놓고
# 「솟았지만 판정선 밖」으로 버렸다(솟음 139.7mm).
#
# ⛔ **숫자를 지어내지 않았다.** 판정선은 `Shared/data/props.js` 의 `ROUND` 실측(전장 77.0 ·
# 지름 10.0 · 자 2026-08-11)에 **위 지름 판정과 똑같은 ±30%** 를 건 것이다. 새 관용도가 아니라
# **같은 관용도를 옳은 치수에 거는 것**이다.
#
# **왜 길이만 거나** — 2026-08-31 실측에서 긴축 71.1mm(참값 77 대비 **−7.7%**)로 잘 맞았지만
# 짧은축은 15.5mm(참값 10 대비 **+55%**)로 부풀었다. 깊이 덩어리는 가장자리가 번지고 옆 물체가
# 붙는다. 그래서 **짧은축은 재서 보고하되 판정에 안 쓴다** — 통과시키려고 관용도를 +60% 로
# 늘리는 것이 곧 「숫자를 지어내는 것」이다.
#
# ⚠ **자세를 가르는 자가 아니다.** 누운 총알도 옆에서 보면 긴축이 77mm 다. 이 판정이 답하는
# 것은 「총알 크기의 물체가 거기 있나」이고, 「어느 쪽으로 누웠나」는 긴축 방향(`longAxisDeg`)이
# 따로 말한다. 파지 방향을 정하는 쪽이 그 각을 본다.
ROUND_LEN_MM, ROUND_DIA_MM = 77.0, 10.0          # `Shared/data/props.js` ROUND (자 2026-08-11)
SIZE_TOL = 0.30                                   # 위 지름 판정선(7~13 = 10±30%)과 같은 관용도
LEN_MIN_MM = ROUND_LEN_MM * (1 - SIZE_TOL)        # 53.9
LEN_MAX_MM = ROUND_LEN_MM * (1 + SIZE_TOL)        # 100.1
# 솟음 문턱의 **바닥값**. 실제 문턱은 아래 §문턱은 잡음을 따라간다 에서 평면 RMS 로 정해진다
RAISE_MM = 2.0
# 문턱 = max(RAISE_MM, RAISE_SIGMA × 평면 RMS).
# ⚠ **고정 문턱은 거리를 못 버틴다** (2026-08-11 실측 — 148mm 에서 RMS 0.40mm 이던 것이
# 394mm 에서 1.37mm 로 3배가 됐고, 2mm 고정은 그 자리에서 겨우 1.5σ 라 잡음이 물체로
# 새어 들어와 펜이 +33% 로 부풀었다). 잡음이 커지면 문턱도 같이 커져야 한다.
RAISE_SIGMA = 3.0
# **신뢰 하한** — 솟음 높이가 평면 잡음의 이 배수 밑이면 문턱을 어디에 놔도 값이 요동한다.
# 2026-08-11 실측: 225mm(RMS 0.67 · SNR 14)에서 기준물 오차 **+1.7%** 로 안정, 385mm
# (RMS 1.39 · SNR 6.9)에서는 문턱 1.5~6.0mm 를 훑는 동안 기준물이 **−6.7~+121%** 로 튀었다.
# 깊이 오차는 **거리²** 로 커지는데 물체 높이는 고정이라 SNR 이 그렇게 떨어진다.
# 그 구간에서 숫자를 내면 **틀린 값을 낸 줄 모르고 쓴다** — 못 재면 못 잰다고 말한다 (제1원칙).
SNR_MIN = 8.0
# 이보다 작은 덩어리는 화소 잡음이다 (예상 총알 면적 ~1,000px 의 5%)
MIN_AREA_PX = 50
# Min-Z 를 모를 때 쓰는 약한 신호 — 덩어리의 이 비율 이상이 **프레임 최소 한 값**에 눌려 있으면
# 클램프로 본다 (2026-08-12 실측: 1,574화소 중 95% 가 195.0 하나였다 · 아래 §Min-Z)
CLAMP_PINNED = 0.5

# 높이 보정 — **거리가 아니라 「물체의 화소 폭」의 함수다** (2026-08-11 실측 · 참값 10mm).
# 스테레오 매칭 창이 좁은 물체의 꼭대기를 주변 평면 쪽으로 끌어내린다. 폭이 24.3→16.9px 로
# 1.4배 줄자 편향이 −13.5 → −22.0% 로 커졌다(모드별 σ 0.03~0.16mm 라 잡음의 5~28배).
# **실측 구간 밖은 외삽하지 않는다** — 양끝 값을 그대로 문다.
WIDTH_GAIN = [(16.9, 1.282), (18.4, 1.263), (20.0, 1.190), (24.3, 1.156)]


def width_gain(w_px):
    """화소 폭 → 높이 보정 계수. 실측 네 점 사이는 선형보간, 밖은 끝값 고정."""
    pts = WIDTH_GAIN
    if w_px <= pts[0][0]:
        return pts[0][1]
    if w_px >= pts[-1][0]:
        return pts[-1][1]
    for (w0, g0), (w1, g1) in zip(pts, pts[1:]):
        if w0 <= w_px <= w1:
            return g0 + (g1 - g0) * (w_px - w0) / (w1 - w0)
    return 1.0


# 프레임 평균 — **정지 장면에서 잡음은 √N 로 준다.** 우리 병목이 정확히 잡음이라
# (2026-08-12 · 440mm 에서 평면 RMS 1.29mm · 총알 SNR 5.5) 이 한 줄이 팔을 안 옮기고
# 240mm 접근과 같은 효과를 낸다. **의존성 0 · 관문 수정 0.**
# ⚠ **`validRatio` 규약을 안 깬다** — 화소마다 유효였던 회차를 세서 이 비율 미만이면
# **그 화소는 무효로 남긴다.** 없는 값을 지어내지 않는다 (골 §후퇴 금지).
# ⚠ **카메라와 장면이 둘 다 정지해 있어야 한다.** 움직이면 번진다 — `--watch` 는 팔이
# 멈춘 뒤에만 부르므로 성립한다.
AVG_FRAMES = 8
AVG_MIN_VALID = 0.6


def fetch_avg(url, n):
    """`n` 장을 받아 화소별로 평균. 반환은 (깊이 mm, 메모)."""
    st = [np.asarray(Image.open(BytesIO(fetch(url)))).astype(np.float32) for _ in range(n)]
    return average_frames(st)


def average_frames(st):
    """이미 받은 깊이 배열들을 `fetch_avg`와 같은 결측 규칙으로 평균한다."""
    if not st:
        raise ValueError("평균할 깊이 프레임이 없다")
    n = len(st)
    Z = np.stack(st)
    ok = Z > 0
    cnt = ok.sum(0)
    keep = cnt >= max(1, int(round(AVG_MIN_VALID * n)))
    out = np.zeros(Z.shape[1:], np.float32)
    out[keep] = np.where(ok, Z, 0).sum(0)[keep] / cnt[keep]
    # 회차 간 표준편차 = 이 장면의 실제 잡음. 평균이 얼마나 줄였는지 사람이 본다
    both = keep & (cnt == n)
    sd = float(np.std(Z[:, both], axis=0).mean()) if both.sum() > 100 else None
    return out, {"avgFrames": n,
                 "frameNoiseMm": round(sd, 3) if sd else None,
                 "expectedAfterMm": round(sd / math.sqrt(n), 3) if sd else None}


def fetch(url):
    with urllib.request.urlopen(url, timeout=8) as r:      # noqa: S310 — LAN 고정 주소
        if r.status != 200:
            raise SystemExit(f"깊이 프레임 못 받음: HTTP {r.status}")
        return r.read()


# 지배 평면만 남기는 창 — 중앙값의 ±이 비율. 물체는 평면에서 mm 단위로 떠 있으니 안 잘리고,
# **책상 너머 배경**(다른 평면)은 잘린다
DOMINANT_BAND = 0.35


def dominant(z, mask):
    """가장 넓은 깊이 덩어리만 남긴다.

    ⚠ **실제 장면엔 평면이 하나가 아니다** (2026-08-11 실측 — 카메라를 올리자 책상 끝 너머
    바닥 1200mm 가 프레임에 들어와 피팅 RMS 가 **269mm** 로 깨졌다). 두 평면을 한 식으로
    맞추면 둘 다 아닌 면이 나오고, 그 위에서 잰 높이는 전부 거짓말이다.
    중앙값 기준 창으로 자른다 — 물체는 평면에서 mm 단위로 떠 있어 같이 남는다.
    """
    v = z[mask]
    if v.size == 0:
        return mask
    m = float(np.median(v))
    return mask & (np.abs(z - m) < m * DOMINANT_BAND)


def fit_plane(z, mask, rounds=4, want_coef=False):
    """`1/z = a·u + b·v + c` 를 강건 최소제곱으로 맞춘다.

    솟은 물체가 피팅을 끌어당기므로 **반복하며 이상치를 뺀다** — 한 번만 맞추면 총알이
    평면을 자기 쪽으로 당겨 자기 높이를 스스로 깎는다.
    """
    h, w = z.shape
    vv, uu = np.mgrid[0:h, 0:w]
    mask = dominant(z, mask)      # 배경 평면을 먼저 버린다 — 위 §dominant
    keep = mask.copy()
    a = None
    for _ in range(rounds):
        if keep.sum() < 100:
            return None, None
        A = np.stack([uu[keep], vv[keep], np.ones(keep.sum())], 1).astype(float)
        inv = 1.0 / z[keep].astype(float)
        a, *_ = np.linalg.lstsq(A, inv, rcond=None)
        pred_inv = a[0] * uu + a[1] * vv + a[2]
        with np.errstate(divide="ignore", invalid="ignore"):
            plane = np.where(pred_inv > 0, 1.0 / pred_inv, np.nan)
        resid = plane - z                       # + 면 카메라 쪽으로 솟았다
        r = resid[keep]
        s = np.nanstd(r)
        if not np.isfinite(s) or s == 0:
            break
        keep = mask & (np.abs(resid) < 2.5 * s)  # 솟은 것을 빼고 다시 맞춘다
    pred_inv = a[0] * uu + a[1] * vv + a[2]
    with np.errstate(divide="ignore", invalid="ignore"):
        plane = np.where(pred_inv > 0, 1.0 / pred_inv, np.nan)
    return (plane, keep, a) if want_coef else (plane, keep)


def tilt_deg(a, w):
    """피팅한 평면이 광축에 대해 얼마나 기울었나 (도).

    **왜 필요한가** — 잔차는 **시선 방향**으로 재는데 물체 높이는 **평면에 수직**이다.
    평면이 θ 기울면 측정 높이가 `h / cos θ` 로 부푼다 (30° 에서 +15%, 45° 에서 +41%).
    보정 없이 쓰면 파지 좌표가 각도만큼 조용히 틀린다.

    `1/z = a·u + b·v + c` 의 계수에서 법선을 되찾는다 — 화소 좌표를 정규화 좌표로 되돌리면
    `n ∝ (a·fx, b·fy, c + a·cx + b·cy)` 다.
    """
    sc = w / 848.0                      # 848 기준 내부 파라미터를 현재 폭으로 환산
    fx, fy, cx, cy = FX848 * sc, FY848 * sc, CX848 * sc, CY848 * sc
    n = np.array([a[0] * fx, a[1] * fy, a[2] + a[0] * cx + a[1] * cy], float)
    nrm = np.linalg.norm(n)
    if nrm == 0:
        return None, 1.0
    nz = abs(n[2] / nrm)
    return float(math.degrees(math.acos(min(1.0, nz)))), float(nz)


def erode(m, r):
    """최소 필터. `scipy` 를 안 들이려고 이동-AND 로 만든다."""
    o = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            o &= np.roll(np.roll(m, dy, 0), dx, 1)
    return o


def core(blob):
    """높이를 잴 **속살**. 실루엣 가장자리 2화소를 깎는다.

    ⚠ **경사에서 가장자리가 튄다** (2026-08-11 실측 · 43.6°) — 물체 옆면에서 시선이 평면까지
    멀리 가므로 깊이 단차가 크고, 그 자리 화소가 물체보다 높게 찍힌다("flying pixels").
    각도가 급할수록 심해서 43.6° 에서 높이가 **+9.6%** 부풀었다. 2화소를 깎으면 **+0.3%** 다
    (1화소 +4.7% · 3화소 −3.9% — 2가 바닥이다).
    **면적·bbox 는 원본을 쓴다** — 깎은 것은 높이를 재기 위한 것이지 물체가 작아진 게 아니다.
    """
    for r in (2, 1):
        e = erode(blob, r)
        if e.sum() >= max(MIN_AREA_PX, 0.25 * blob.sum()):
            return e
    return blob


def fill_holes(m):
    """`m` 안의 구멍을 메운다 — 가장자리에서 여집합을 흘려 넣고 안 닿은 곳이 구멍이다."""
    comp = ~m
    out = np.zeros_like(m)
    st = [(y, x) for y in (0, m.shape[0] - 1) for x in range(m.shape[1]) if comp[y, x]]
    st += [(y, x) for x in (0, m.shape[1] - 1) for y in range(m.shape[0]) if comp[y, x]]
    while st:
        cy, cx = st.pop()
        if not (0 <= cy < m.shape[0] and 0 <= cx < m.shape[1]):
            continue
        if out[cy, cx] or not comp[cy, cx]:
            continue
        out[cy, cx] = True
        st += [(cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)]
    return m | (comp & ~out)


def spans(m):
    """행·열 각각에서 참 사이를 채운다 — **볼록껍질의 값싼 근사**.

    **왜 이게 「보간 영역」인가** — 평면 식은 프레임 전체에 정의되지만 우리가 믿을 수 있는 건
    실제로 점이 있던 자리 **사이**뿐이다. 어떤 화소의 좌우(또는 상하) 양쪽에 인라이어가 있으면
    그 자리의 평면 값은 보간이고, 한쪽에만 있으면 외삽이다. 두 방향을 모두 만족하는 곳만 남긴다.
    """
    out = np.zeros_like(m)
    for axis in (1, 0):
        mm = m if axis == 1 else m.T
        n = mm.shape[1]
        idx = np.arange(n)
        has = mm.any(1)
        first = np.where(has, mm.argmax(1), n)
        last = n - 1 - np.where(has, mm[:, ::-1].argmax(1), n)
        band = (idx[None, :] >= first[:, None]) & (idx[None, :] <= last[:, None]) & has[:, None]
        out = band if axis == 1 else (out & band.T)
    return out


def plane_support(inliers):
    """평면이 **실제로 받치는 영역**. 물체는 이 안에서만 찾는다.

    ⚠ **평면 식은 프레임 전체에 정의되지만 평면은 그렇지 않다** (2026-08-11 실측 — 카메라를
    32° 기울이자 책상 끝 너머가 들어왔고, 거기 잔차는 뜻이 없는데도 「가장 큰 덩어리」 경쟁에서
    총알을 **6배 차이로** 이겼다). 책상은 하나의 연결된 면이고 물체는 그 안의 구멍이다 —
    최대 연결요소를 잡아 구멍을 메우면 그게 받침면이다.

    ⚠ **구멍 메우기만으로는 부족하다** (2026-08-12 실측 — 카메라를 45° 로 눕히자 눕힌 총알이
    「구멍」이 아니라 인라이어 덩어리의 **가장자리에 붙은 만입부**가 됐다. 가장자리에서 흘려 넣은
    여집합이 거기까지 닿아 안 메워졌고, 1,311화소 · 솟음 10.9mm 짜리 진짜 물체가 통째로
    잘렸다). 그래서 **보간 영역**(§spans)을 같이 쓴다 — 좌우·상하 양쪽에 인라이어가 있는
    자리는 평면 값이 보간이라 믿을 수 있고, 책상 너머(한쪽에만 있다)는 여전히 빠진다.
    """
    d = largest_blob(inliers)
    return inliers if d is None else (fill_holes(d) | spans(d))


def all_blobs(m, min_area=None):
    """연결요소 **전부** (넓은 순). ⚠ **가장 큰 것만 보면 작은 물체를 영원히 못 본다** —
    2026-08-12 에 종이 상자(26,000화소)가 총알(1,300화소)을 매번 이겨서, 상자를 치우지 않으면
    총알을 볼 수 없었다. 크기로 고르는 것은 부르는 쪽 몫이다."""
    lab, cur = _label(m)
    out = [(int((lab == i).sum()), i) for i in range(1, cur + 1)]
    lo = MIN_AREA_PX if min_area is None else min_area
    return [lab == i for a, i in sorted(out, reverse=True) if a >= lo]


def _label(m):
    """연결요소 라벨링. `scipy` 를 안 들이려고 손으로 훑는다 — 프레임이 작아 충분하다."""
    lab = np.zeros(m.shape, np.int32)
    cur = 0
    for y, x in zip(*np.nonzero(m)):
        if lab[y, x]:
            continue
        cur += 1
        st = [(y, x)]
        while st:
            cy, cx = st.pop()
            if not (0 <= cy < m.shape[0] and 0 <= cx < m.shape[1]):
                continue
            if lab[cy, cx] or not m[cy, cx]:
                continue
            lab[cy, cx] = cur
            st += [(cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1),
                   (cy + 1, cx + 1), (cy - 1, cx - 1), (cy + 1, cx - 1), (cy - 1, cx + 1)]
    return lab, cur


def largest_blob(m):
    """가장 큰 연결요소 (없으면 None)."""
    b = all_blobs(m, min_area=1)
    return b[0] if b else None



TOP_SEED = 0.7   # 씨앗 = 1단 잔차가 꼭대기의 이 비율 이상인 화소 (= 물체 높이의 위쪽 30%)


def blob_size_mm(blob, z_mm, fx=FX848, fy=FY848):
    """덩어리의 **실제 치수**(긴축·짧은축 mm)와 긴축 방향. 반환 `dict` 또는 `None`.

    ⛔ **바깥 상자(bbox)로 재지 않는다.** 총알이 비스듬히 서면 상자가 대각선을 감싸 길이가
    부풀고, 그 부풀림이 **자세에 따라 달라져** 판정이 자세를 탄다. 화소 분포의 주축(PCA)은
    회전에 안 흔들린다.

    길이는 **주축 방향 화소 퍼짐의 4σ** 로 본다 — 균일한 막대의 표준편차가 길이/√12 이므로
    √12 ≈ 3.46 이 이론값이고, 깊이 가장자리가 번지는 것을 감안해 널리 쓰는 4σ 를 쓴다.
    ⚠ 이 상수는 **모양에서 나온 것이지 오늘 숫자에 맞춘 것이 아니다** — 오늘 값(71.1mm)은
    이 식으로 나온 결과이지 이 식을 정한 근거가 아니다.
    """
    ys, xs = np.nonzero(blob)
    if ys.size < 3 or not z_mm:
        return None
    pts = np.stack([xs.astype(np.float64), ys.astype(np.float64)])
    pts -= pts.mean(axis=1, keepdims=True)
    cov = np.cov(pts)
    if not np.all(np.isfinite(cov)):
        return None
    vals, vecs = np.linalg.eigh(cov)
    order = np.argsort(vals)[::-1]
    vals, vecs = vals[order], vecs[:, order]
    sd = np.sqrt(np.maximum(vals, 0.0))
    px_long, px_short = 4.0 * sd[0], 4.0 * sd[1]
    # 화소 → mm. fx·fy 가 같은 기기라 한 배율이지만 규약대로 축마다 나눈다
    mm_per_px_x, mm_per_px_y = z_mm / fx, z_mm / fy
    ax = vecs[:, 0]
    scale_long = math.hypot(ax[0] * mm_per_px_x, ax[1] * mm_per_px_y)
    scale_short = math.hypot(-ax[1] * mm_per_px_x, ax[0] * mm_per_px_y)
    return {"longMm": round(px_long * scale_long, 1),
            "shortMm": round(px_short * scale_short, 1),
            # 화면 +x 에서 반시계. 90 이면 화면에서 **세로로 서 있다**
            "longAxisDeg": round(math.degrees(math.atan2(-ax[1], ax[0])) % 180.0, 1)}


def verdict_of(peak, ontop, size=None):
    """끝줄 한 문장. **2단이 찾았으면 1단이 놓친 것을 덮는다.**

    받침 위의 물체는 1단에서 「받침+물체」한 덩어리라 **반드시 판정선 밖으로 나온다** —
    그걸 그대로 끝줄에 쓰면 실제로는 본 장면을 못 봤다고 보고하게 된다 (2026-08-12).

    **세운 총알은 높이로 못 가른다** (2026-08-31 · 위 §세운 총알). 높이 판정이 둘 다 빗나가면
    **덩어리 실치수**로 한 번 더 본다 — 그게 옳은 자다.
    """
    if PEAK_MIN_MM <= peak <= PEAK_MAX_MM:
        return "깊이가 총알을 본다"
    on = (ontop or {}).get("peakMm")
    if on is not None and PEAK_MIN_MM <= on <= PEAK_MAX_MM:
        return f"받침 위에서 총알을 본다 — {on}mm (덩어리 전체는 {peak:.1f}mm 라 1단은 못 본다)"
    ln = (size or {}).get("longMm")
    if ln is not None and LEN_MIN_MM <= ln <= LEN_MAX_MM:
        return (f"세운 총알을 본다 — 긴축 {ln}mm (전장 {ROUND_LEN_MM} 대비 "
                f"{100*(ln/ROUND_LEN_MM-1):+.1f}%). **높이 판정은 안 쓴다** — 세우면 "
                f"솟음이 지름이 아니라 길이다")
    return (f"솟았지만 높이가 판정선 밖이다 ({PEAK_MIN_MM}~{PEAK_MAX_MM}mm)"
            + (f" · 긴축 {ln}mm 도 총알 길이 밖 ({LEN_MIN_MM:.0f}~{LEN_MAX_MM:.0f}mm)"
               if ln is not None else ""))


def on_top_of(z, valid, blob, resid1, peak1):
    """**받침 위의 물체** — 기준면을 한 번 더 갈아 끼운다 (2단 탐색).

    ⚠ **「책상 위로 솟은 것」 하나로는 못 푸는 장면이 있다** (2026-08-12 실측 — 종이 상자
    위에 총알을 올려 두니 둘이 **이어진 한 덩어리 26,196화소**로 잡혔다. 크기로 걸러도 안
    갈린다 — 애초에 두 덩어리가 아니다). 그런데 상자 윗면도 평면이므로 **그 면을 새 기준으로
    삼으면** 총알이 다시 「면 위로 솟은 것」이 된다. 같은 피팅을 한 번 더 부르는 것뿐이다.

    이건 임시방편이 아니라 **최종 시스템이 요구하는 모양**이다 — 탄피가 받침 소켓에 꽂히면
    언제나 「받침 위의 물체」를 봐야 한다 (`PRD` §조립).

    받침면 안쪽만 보므로 1단에서 쓴 가드(Min-Z 클램프 · 보간 영역)가 그대로 적용된다.
    """
    sub = blob & valid
    if sub.sum() < 300:
        return None
    # ⚠ **덩어리 전체로 피팅하면 안 된다** (2026-08-12 실측 — 상자의 **윗면과 옆면**을 한
    # 평면으로 맞추려다 RMS **18.17mm**, 문턱이 54.5mm 가 되어 아무것도 못 찾았다).
    # 씨앗을 **물체 높이의 위쪽 30%** 로 주면 윗면만 남아 RMS **1.26mm** 로 떨어진다.
    # 깊이로 자르는 것(가까운 N%)은 안 됐다 — 덩어리가 배경까지 물어 범위가 넓어서다.
    seed = sub & (resid1 > TOP_SEED * peak1)
    if seed.sum() < 300:
        return None
    plane, inl, _ = fit_plane(z, seed, want_coef=True)
    if plane is None or inl is None or inl.sum() < 100:
        return None
    resid = np.where(sub, plane - z, np.nan)
    rms = float(np.sqrt(np.nanmean(np.where(inl, plane - z, np.nan)[inl] ** 2)))
    if not np.isfinite(rms) or rms <= 0:
        return None
    thr = max(RAISE_MM, RAISE_SIGMA * rms)
    raised = sub & plane_support(inl) & (resid > thr)
    out = {"faceRmsMm": round(rms, 2), "raiseThrMm": round(thr, 2)}
    if raised.sum() < MIN_AREA_PX:
        return out | {"peakMm": None, "areaPx": int(raised.sum()),
                      "verdict": "받침 위에 솟은 것이 없다"}
    b2 = largest_blob(raised)
    if b2 is None or b2.sum() < MIN_AREA_PX:
        return out | {"peakMm": None, "areaPx": int(raised.sum()),
                      "verdict": "받침 위 덩어리가 하한 미만"}
    peak = float(np.nanpercentile(resid[core(b2)], 95))
    snr = peak / rms
    ys, xs = np.nonzero(b2)
    out |= {"areaPx": int(b2.sum()), "snr": round(snr, 1),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
            "zMm": round(float(np.median(z[b2])), 1)}
    if snr < SNR_MIN:
        return out | {"peakMm": None,
                      "verdict": f"받침 위 솟음/잡음 {snr:.1f} < {SNR_MIN} — 못 잰다"}
    return out | {"peakMm": round(peak, 2),
                  "verdict": ("받침 위에서 총알을 본다" if PEAK_MIN_MM <= peak <= PEAK_MAX_MM
                              else f"받침 위에 솟았지만 판정선 밖 ({PEAK_MIN_MM}~{PEAK_MAX_MM}mm)")}


def probe(png_bytes, min_z=None):
    z = (png_bytes.astype(np.float32) if isinstance(png_bytes, np.ndarray)
         else np.asarray(Image.open(BytesIO(png_bytes))).astype(np.float32))
    valid = z > 0                                # 계약 §깊이 스냅샷 — 무효는 0 이다
    out = {"shape": list(z.shape), "validRatio": round(float(valid.mean()), 4)}
    if valid.sum() < 500:
        return out | {"verdict": "깊이가 거의 없다", "peakMm": None}
    # ⚠ **사유를 거꾸로 말하지 않는다.** 유효가 이만큼 적으면 평면 피팅부터 무의미해서 아래
    # SNR 가드가 "거리가 멀어"로 잘못 답한다 — 실제로는 **Min-Z 안쪽(너무 가까움)** 이거나
    # 표면이 깊이를 안 돌려준 것이다. 처방이 정반대라 틀린 사유가 사람을 반대로 보낸다
    # (2026-08-11 실측 — 195mm 아래로 내려간 프레임에 "멀어서"가 나왔다)
    if valid.mean() < 0.20:
        return out | {"peakMm": None,
                      "verdict": f"깊이가 거의 없다 ({100*valid.mean():.1f}%) — **Min-Z 안쪽**"
                                 f"(너무 가깝다)이거나 표면이 깊이를 안 준다. 근접 모드나 "
                                 f"disparity shift 로"}

    plane, inliers, coef = fit_plane(z, valid, want_coef=True)
    if plane is None:
        return out | {"verdict": "평면을 못 맞췄다", "peakMm": None}

    resid = np.where(valid, plane - z, np.nan)
    rms = float(np.sqrt(np.nanmean(resid[inliers] ** 2)))
    out["planeRmsMm"] = round(rms, 3)
    # 문턱은 잡음을 따라간다 — 위 §RAISE_SIGMA
    thr = max(RAISE_MM, RAISE_SIGMA * rms)
    out["raiseThrMm"] = round(thr, 2)

    # 받침면 안에서만 찾는다 — 위 §plane_support
    support = plane_support(inliers)
    out["supportRatio"] = round(float(support.mean()), 4)
    raised = valid & support & (resid > thr)
    # ⭐ **덩어리를 전부 재고 「총알 같은 것」을 고른다** — 가장 큰 것을 고르면 종이 상자가
    # 매번 이긴다 (2026-08-12 · 26,000 대 1,300화소). 판정선 안에 드는 것이 있으면 그것을
    # 주인공으로 삼고, 없으면 예전처럼 가장 넓은 것을 쓴다(그래야 받침 자체도 잴 수 있다).
    cands = all_blobs(raised)
    picks = []
    for cb in cands:
        cp = float(np.nanpercentile(resid[core(cb)], 95))
        picks.append((cb, cp))
    out["blobs"] = [{"areaPx": int(cb.sum()), "peakMm": round(cp, 2)} for cb, cp in picks[:6]]
    fit = [(cb, cp) for cb, cp in picks if PEAK_MIN_MM <= cp * tilt_deg(coef, z.shape[1])[1] <= PEAK_MAX_MM]
    blob = (fit[0][0] if fit else (picks[0][0] if picks else None))
    if fit:
        out["pickedBy"] = "판정선 안"
    if blob is None or blob.sum() < MIN_AREA_PX:
        return out | {"verdict": "솟은 것이 없다 — 깊이가 물체를 못 본다",
                      "peakMm": None, "areaPx": int(raised.sum())}

    # **꼭대기는 최대값이 아니라 상위 5% 분위다.** 한 화소짜리 스파이크가 판정을 정하면
    # 잡음이 통과시킨다 (깊이는 가장자리에서 튄다 — "flying pixels")
    peak = float(np.nanpercentile(resid[core(blob)], 95))
    # 기울기 보정 — 위 §tilt. 원값도 같이 낸다(보정을 믿을지 사람이 본다)
    tdeg, nz = tilt_deg(coef, z.shape[1])
    out["tiltDeg"] = round(tdeg, 1) if tdeg is not None else None
    out["peakRawMm"] = round(peak, 2)
    peak = peak * nz
    ys, xs = np.nonzero(blob)
    box = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]

    # ⛔ **Min-Z 에 붙은 덩어리는 잰 게 아니라 잘린 것이다** (2026-08-12 실측에서 잡혔다).
    # 받침 95mm 위에 총알을 세우니 받침 윗면이 렌즈에서 181mm 가 됐는데, 848×480 의
    # Min-Z 가 195mm 라 **1,574화소 전부가 정확히 195.0 하나로** 돌아왔다(프레임 최소값과
    # 같고 그 아래로는 유효화소 0개). 그 상태에서 높이가 **92.35mm** 로 나와 실물 95mm 와
    # −2.8% 로 맞아 버렸다 — **우연히 맞은 잘린 값**이고, 이대로면 사람이 「쟀다」로 읽는다.
    # 판정: 덩어리 깊이가 프레임 최소값에 붙어 있고 퍼짐이 없으면 **숫자를 안 낸다** (제1원칙).
    zb = z[blob & valid]
    zmid = float(np.median(zb)) if zb.size else None
    out["blobZMm"] = round(zmid, 1) if zmid is not None else None
    if zmid is not None and min_z:
        if zmid <= min_z * 1.02:
            return out | {"peakMm": None, "areaPx": int(blob.sum()), "bbox": box,
                          "minZMm": min_z,
                          "verdict": f"덩어리가 Min-Z 에 걸렸다 — 덩어리 깊이 {zmid:.0f}mm ≤ "
                                     f"이 모드의 Min-Z {min_z}mm. **높이가 아니라 한계다.** "
                                     f"물러나거나 근접 모드(480×270 · Min-Z 116)로"}
    elif zmid is not None:
        # Min-Z 를 모를 때(--png 단독)의 약한 신호. **퍼짐으로는 못 가른다** — 이 거리의
        # 스테레오 양자화 간격이 z²/(f·b) = 1.8mm 라 진짜 평면도 두세 값에만 얹힌다.
        # 대신 「한 값에 눌렸고 그 값이 프레임 최소」를 본다 (2026-08-12 실측: 95% 가 195.0)
        pinned = float((zb == z[valid].min()).mean())
        if pinned >= CLAMP_PINNED and float(zb.min()) <= float(z[valid].min()) + 1e-3:
            return out | {"peakMm": None, "areaPx": int(blob.sum()), "bbox": box,
                          "pinnedFrac": round(pinned, 2),
                          "verdict": f"덩어리의 {100*pinned:.0f}% 가 프레임 최소값 "
                                     f"{z[valid].min():.0f}mm **한 값에 눌려 있다** — Min-Z 클램프로 "
                                     f"보인다. `--min-z` 를 주거나 브리지에서 직접 재라"}

    snr = peak / rms if rms > 0 else float("inf")
    out["snr"] = round(snr, 1)
    if snr < SNR_MIN:
        return out | {"peakMm": None, "areaPx": int(blob.sum()),
                      "verdict": f"거리가 멀어 못 잰다 — 솟음/잡음 {snr:.1f} < {SNR_MIN} "
                                 f"(평면 RMS {rms:.2f}mm). 가까이 가거나 근접 모드로"}
    # 2단은 **항상 가장 넓은 덩어리(=받침) 위**를 본다 — 주인공으로 고른 작은 덩어리가 아니다.
    # ⚠ **「주인공과 다를 때만」이라는 조건을 달았다가 정확히 거꾸로 돌았다** (2026-08-12 실측) —
    # 받침과 물체가 **이어진 한 덩어리**로 잡히는 것이 2단을 만든 바로 그 이유인데, 그 경우가
    # `big is blob` 이라 건너뛰었다. 손으로 같은 함수를 부르면 총알이 나왔다(1,431px · 9.4mm).
    # 조건 없이 항상 돈다 — 위에 아무것도 없으면 「받침 위에 솟은 것이 없다」가 나올 뿐이다.
    if picks:
        big, bigpeak = picks[0]
        out["onTop"] = on_top_of(z, valid, big, resid, bigpeak)
    # 덩어리 실치수 — **항상 잰다.** 판정에 안 쓰이는 날에도 사람이 「저게 총알만 하나」를
    # 눈으로 못 재는 것보다 낫다 (2026-08-31: 이 숫자가 없어서 내가 손계산을 했다)
    size = blob_size_mm(blob, zmid)
    out |= {
        "peakMm": round(peak, 2),
        "areaPx": int(blob.sum()),
        "bbox": box,
        "sizeMm": size,
        "validRatioInBlob": round(float(valid[blob].mean()), 4),
        "verdict": verdict_of(peak, out.get("onTop"), size),
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None, help="안 주면 host.sh 가 이름으로 푼다")
    ap.add_argument("--png", help="브리지 대신 이 파일을 읽는다")
    ap.add_argument("--save", help="받은 원본 PNG 를 여기 남긴다")
    ap.add_argument("--label", default="", help="표에 붙일 이름 (노브 값 등)")
    ap.add_argument("--avg", type=int, default=AVG_FRAMES,
                    help=f"이 장수를 받아 화소별 평균 (기본 {AVG_FRAMES} · 1 이면 안 함)")
    ap.add_argument("--min-z", type=float, default=None,
                    help="이 모드의 Min-Z(mm). 안 주면 브리지 /state 에서 읽는다")
    args = ap.parse_args()
    if not args.png and not args.url:
        args.url = default_url()      # 파일을 읽는 모드면 호스트가 필요 없다

    note = {}
    if args.png:
        raw = open(args.png, "rb").read()
    elif args.avg > 1:
        raw, note = fetch_avg(args.url, args.avg)      # ndarray 를 그대로 넘긴다
    else:
        raw = fetch(args.url)
    if args.save and isinstance(raw, (bytes, bytearray)):
        open(args.save, "wb").write(raw)
    # **제원을 추측하지 않는다** — 관문이 이 모드의 Min-Z 를 알고 있으므로 그걸 읽는다.
    # 이게 없으면 Min-Z 에 잘린 값을 「쟀다」로 읽는다 (2026-08-12 · 받침 95mm 가 92.35 로 나왔다)
    min_z = args.min_z
    if min_z is None and not args.png:
        try:
            st = json.loads(urllib.request.urlopen(
                args.url.replace("depth/frame", "state"), timeout=5).read())
            min_z = (st.get("depth") or {}).get("minZmm")
        except Exception:
            min_z = None
    res = note | probe(raw, min_z)
    if args.label:
        res = {"label": args.label} | res
    print(json.dumps(res, ensure_ascii=False))
    # 판정이 서면 0, 안 서면 1 — 스윕 스크립트가 그냥 돌 수 있게
    return 0 if res.get("peakMm") is not None else 1


if __name__ == "__main__":
    sys.exit(main())
