# 깊이 유효 판정 — **순수 함수만 둔다.** 카메라도 HTTP 도 여기 없다.
#
# 왜 갈라놨나: 판정 규칙은 계약(`LAYOUT-METRICS-CONTRACT.md` §카메라)이 정하고 실기 없이
# 검증돼야 한다. `pyrealsense2` 를 import 하는 순간 카메라 없는 기계에서 테스트가 못 돈다 —
# 그러면 규칙이 실기에서만 확인되고, 실기는 늘 늦게 온다.
#
# 규칙 셋 (계약 원문):
#   ① 무효는 0 만이 아니다 — Z 가 **65535 로 포화된 쓰레기**가 섞여 나온다.
#      "0 이 아니면 유효"로 세면 통과한다. min~max 밖을 **버린 뒤** 비율을 낸다
#   ② 유효는 불리언이 아니라 **비율**이다. 판정은 `validRatioCenter` 로 한다 —
#      경계 근처에선 **중앙이 먼저 죽는다**(중앙 1.5% / 가장자리 37.4% · 2026-08-05 실측)
#   ③ 임계값은 실측 후 정하고 **그전까지 fail-closed**
import numpy as np

# 상한 — 이 위는 포화 쓰레기이거나 우리 작업대 밖이다 (계약 §카메라 기본 4000mm)
DEFAULT_MAX_MM = 4000

# `valid: false` 의 사유 넷. 계약 §사유 그대로 — 화면이 이걸로 **고칠 수 있는 것**을 가른다
NO_CAMERA = "noCamera"
NO_FRAME = "noFrame"
THRESHOLD_UNSET = "thresholdUnset"
BELOW_THRESHOLD = "belowThreshold"


def center_view(z_mm):
    """중앙 1/3 — **물건이 놓이는 곳**이다. 손목캠은 여기로 파지점을 본다."""
    h, w = z_mm.shape[:2]
    # 3 으로 나눠떨어지지 않아도 최소 1픽셀은 남긴다 — 빈 배열이면 `mean()` 이 nan 을 낸다
    y0, y1 = h // 3, max(h // 3 + 1, h - h // 3)
    x0, x1 = w // 3, max(w // 3 + 1, w - w // 3)
    return z_mm[y0:y1, x0:x1]


def ok_mask(z_mm, min_mm, max_mm=DEFAULT_MAX_MM):
    """유효 화소 마스크. **비율도 스냅샷도 이 한 곳을 쓴다.**

    규칙을 두 군데 적으면 갈린다 — 비율은 "유효" 라는데 스냅샷에는 값이 남아 있는 식이다
    (D103 · 값의 정본이 갈리면 소비처가 지어낸다). **경계는 포함이다** — `min_mm` 은
    데이터시트 Min-Z, 즉 "여기부터 쓸 만하다" 선이다.
    """
    return (z_mm >= min_mm) & (z_mm <= max_mm)


def valid_ratios(z_mm, min_mm, max_mm=DEFAULT_MAX_MM):
    """(전체 비율, 중앙 비율). `z_mm` 은 밀리미터 2차원 배열이다."""
    if z_mm is None or z_mm.size == 0:
        return 0.0, 0.0
    ok = ok_mask(z_mm, min_mm, max_mm)
    ok_c = ok_mask(center_view(z_mm), min_mm, max_mm)
    return float(ok.mean()), float(ok_c.mean())


def clean_mm(z_mm, min_mm, max_mm=DEFAULT_MAX_MM):
    """계약 §깊이 스냅샷 — 밀리미터 **정수** 배열, 유효 범위 밖은 `0`.

    포화 65535 도 `max_mm` 밖이라 여기서 함께 0 이 된다. **Min-Z 를 모르면 `None`** 이다 —
    범위를 모르는 채로 비우면 무엇을 버렸는지 아무도 모른다 (`min_z_mm` 과 같은 태도).
    """
    if z_mm is None or z_mm.size == 0 or min_mm is None:
        return None
    return np.where(ok_mask(z_mm, min_mm, max_mm), z_mm, 0).astype(np.uint16)


def judge(ratio_center, threshold):
    """(valid, reason). **임계값이 없으면 통과가 아니라 차단이다** (제1원칙).

    `threshold` 가 `None` 이면 아무도 실측하지 않은 것이다 — 그 상태를 "괜찮다"로 읽지 않는다.
    다만 사유를 갈라 두어 화면이 **못 고치는 경고**로 띄우지 않게 한다.
    """
    if threshold is None:
        return False, THRESHOLD_UNSET
    if ratio_center >= threshold:
        return True, None
    return False, BELOW_THRESHOLD


def min_z_mm(table, resolution):
    """해상도 → Min-Z. **모르는 해상도는 0 이 아니라 `None`** 이다.

    0 을 주면 `valid_ratios` 가 전 픽셀을 유효로 세어 조용히 통과한다 — 모르는 것은 모른다고
    말해야 위에서 fail-closed 로 갈 수 있다. 표의 정본은 `DEPTH-CAM.md` §Min-Z.
    """
    return table.get(resolution)
