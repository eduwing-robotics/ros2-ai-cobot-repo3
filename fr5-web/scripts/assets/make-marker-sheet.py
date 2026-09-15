#!/usr/bin/env python3
"""AR 마커 인쇄 시트 생성 — 바코드 3x3 Hamming(6,3).

왜 이 스크립트가 있나
  마커를 다시 뽑을 일이 생긴다 (크기 변경·마커 번호 변경·인쇄 실패).
  그때 손으로 다시 만들면 첫 시도의 실수를 반복한다 —
  캡션을 quiet zone 안에 넣어 사각형 검출을 방해했다.

이 스크립트가 지키는 것 — 넷 다 **자기 출력을 픽셀로 검사**해서 강제한다
  ① 표기는 quiet zone **밖**에만 놓는다 (검출 방해 금지)
  ② quiet zone 은 마커 한 변의 6% 이상 (실측 최소 3%의 2배)
  ③ 자르기 선은 **연회색** — 검게 그리면 그것이 마커로 오인된다
  ④ 배치가 용지를 벗어나면 파일을 만들지 않고 실패한다

시트에 인쇄·부착 지침을 넣지 않는다 — 인쇄하기 **전에** 읽는 내용이고
`AR/index.html` 과 `docs/ref/arch/STACK.md` 에 있다. 종이에는 한 줄만 남긴다:
어느 마커이고 몇 mm인지. 그게 없으면 종이만 보고 barcodeValue 를 알 수 없다.

사용
    python3 scripts/assets/make-marker-sheet.py             # 정본 #5
    python3 scripts/assets/make-marker-sheet.py --barcode 2 # 예비 마커
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

DPI = 300
MM = DPI / 25.4  # 1mm 당 픽셀

ROOT = Path(__file__).resolve().parents[2]
# D23 에서 `web/` 이 `Shared/` 로 갈렸는데 이 경로만 안 따라와서 스크립트가 죽어 있었다.
MARKER_DIR = ROOT / "Shared" / "assets" / "marker"
SRC_DIR = MARKER_DIR / "barcode"

FONT_PATH = "/System/Library/Fonts/AppleSDGothicNeo.ttc"

# 용지별 배치.
#
# 마커 크기를 제한하는 것은 **용지 가로폭**이다 (세로는 남는다).
#   marker + 2*quiet + 좌우 여백 ≤ 용지 폭
#
# quiet zone(흰 여백) 비율은 **실측으로 정했다** (archive/evidence-2026-07/2026-07-30/marker-detect.md).
# 어두운 배경에 붙인 최악 조건에서 **3%면 검출된다.** 0%(마커가 어두운 면에 바로 닿음)만 실패.
# 8%는 그 2.7배 여유다 — 처음 쓴 16%는 필요량의 5배였고, 그만큼 마커가 작았다.
QUIET_RATIO_MIN = 0.06  # 게이트: 실측 최소(3%)의 2배 밑으로는 못 내린다
SHEETS = [
    # 이름   용지 W×H(mm)   마커(mm)  quiet(mm)  시트 상단 여백(mm)
    ("A4", (210, 297), 170, 14, 14),   # 170+28=198, 용지 210 → 좌우 6mm
    ("A3", (297, 420), 240, 20, 20),   # 240+40=280, 용지 297 → 좌우 8.5mm
]

CAPTION_GAP = 8  # quiet zone 아래 이만큼 띄우고 한 줄 표기를 넣는다

# --- 크기 실험 시트 (--test)
#
# 터틀봇3 **버거** 상판은 138×178mm 이고 라이다(LDS-02, 지름 약 70mm)가 가운데를 먹는다.
# 남는 자리는 좌우 (138-70)/2 = **34mm**, 앞뒤 (178-70)/2 = **54mm** 다.
# quiet zone 6mm 를 양쪽에 빼면 실제로 붙일 수 있는 마커는 **좌우 22mm · 앞뒤 42mm** 다.
#
# 그래서 아래로 10mm 까지 내려간다. 10mm 는 이론상 24cm 앞에서나 잡히는 크기라
# **쓸 값이 아니라 절벽이 어디인지 재는 값**이다 — 실패하는 칸이 있어야 경계가 나온다.
# 80mm 는 반대쪽 대조군이다. 이것까지 안 잡히면 크기가 아니라 **시험 방법이 틀린 것**이다.
TEST_SIZES = [10, 15, 20, 25, 35, 45, 55, 80]
TEST_PAGE = (210, 297)   # A4
TEST_MARGIN = 12
TEST_GAP = 8
CAP_H = 5                # 크기 표기 한 줄이 차지하는 높이

# 자르기 선과 quiet zone 사이의 흰 띠. **테이프는 여기에만 붙인다** —
# quiet zone 을 덮으면 3%까지 견디던 여백이 0 이 되어 검출이 죽는다.
TAPE_MM = 3

GRAY = (170, 170, 170)
INK = (0, 0, 0)
DIM = (90, 90, 90)


def mm(v):
    return int(round(v * MM))


def font(size_pt):
    """size_pt = 포인트. 300DPI 에서 1pt = 300/72 px."""
    return ImageFont.truetype(FONT_PATH, int(round(size_pt * DPI / 72)))


def build(name, page_mm, marker_mm, quiet_mm, top_mm, barcode, out_path):
    pw, ph = page_mm
    outer_mm = marker_mm + 2 * quiet_mm

    # --- 배치가 물리적으로 성립하는지 먼저 검사한다. 실패하면 만들지 않는다.
    side_margin = (pw - outer_mm) / 2
    if side_margin < 5:
        raise SystemExit(
            f"{name}: 좌우 여백 {side_margin:.1f}mm — 5mm 미만이라 인쇄가 잘린다. "
            f"마커 {marker_mm}mm 또는 quiet {quiet_mm}mm 를 줄여라"
        )
    ratio = quiet_mm / marker_mm
    if ratio < QUIET_RATIO_MIN:
        raise SystemExit(
            f"{name}: quiet zone 이 마커의 {ratio:.0%} — "
            f"{QUIET_RATIO_MIN:.0%} 미만은 안 된다 (실측 최소 3%, 그 2배가 하한)"
        )

    img = Image.new("RGB", (mm(pw), mm(ph)), "white")
    d = ImageDraw.Draw(img)

    # --- 마커 (원본 PNG 는 검은 테두리까지 포함한 전체 사각형이다)
    src = SRC_DIR / f"{barcode}.png"
    if not src.exists():
        raise SystemExit(f"마커 원본이 없다: {src}")
    marker = Image.open(src).convert("RGB").resize((mm(marker_mm), mm(marker_mm)), Image.NEAREST)

    outer_x0 = (pw - outer_mm) / 2
    outer_y0 = top_mm
    mx0, my0 = outer_x0 + quiet_mm, outer_y0 + quiet_mm
    img.paste(marker, (mm(mx0), mm(my0)))

    # --- 자르기 선 = quiet zone 경계. 연회색이라 검출에 영향을 주지 않는다.
    d.rectangle(
        [mm(outer_x0), mm(outer_y0), mm(outer_x0 + outer_mm), mm(outer_y0 + outer_mm)],
        outline=GRAY,
        width=max(1, mm(0.3)),
    )

    # --- 표기 한 줄. quiet zone **아래** CAPTION_GAP mm. 이 안쪽으로는 아무것도 그리지 않는다.
    #
    # 처음에는 인쇄·부착 지침 6줄을 넣었는데 **시트에 있을 이유가 없다** —
    # 인쇄할 때 읽는 것이고, 그건 화면(AR/index.html)과 문서에 있다.
    # 다만 **어느 마커이고 몇 mm인지**는 종이에 남아야 한다. 나중에 이 종이만 보고는
    # barcodeValue 를 알 방법이 없고, 코드 설정이 어긋나면 아무것도 안 뜬다.
    f_small = font(8)
    text_w_mm = outer_mm  # 표기는 quiet zone 폭 안에서만 쓴다

    def wrap(text, fnt, avail_mm):
        """폭을 넘기면 어절 단위로 접는다. 넘친 채 그리면 용지 밖으로 나간다."""
        limit = mm(avail_mm)
        out, cur = [], ""
        for word in text.split(" "):
            trial = f"{cur} {word}".strip()
            if d.textlength(trial, font=fnt) <= limit or not cur:
                cur = trial
            else:
                out.append(cur)
                cur = word
        if cur:
            out.append(cur)
        return out

    def put(x_mm, y_mm, text, fnt, fill, avail_mm, lead):
        for i, ln in enumerate(wrap(text, fnt, avail_mm)):
            d.text((mm(x_mm), mm(y_mm + i * lead)), ln, font=fnt, fill=fill)
        return y_mm + len(wrap(text, fnt, avail_mm)) * lead

    y = put(
        outer_x0,
        outer_y0 + outer_mm + CAPTION_GAP,
        f"FR5Web AR 마커 · 3x3_HAMMING63 · barcodeValue {barcode}"
        f" · 검은 사각형 {marker_mm}mm · 흰 여백 {quiet_mm}mm · 100% 배율 인쇄 · 2026-07-30",
        f_small,
        GRAY,
        text_w_mm,
        4.5,
    )

    if y > ph - 8:
        raise SystemExit(f"{name}: 캡션이 용지 아래로 넘친다 (y={y:.0f}mm / {ph}mm)")

    img.save(out_path, dpi=(DPI, DPI))

    # --- 자가검사. 첫 시도의 결함(캡션이 quiet zone 안)을 픽셀로 확인한다.
    #     파라미터를 손으로 다시 적으면 검사도 같이 틀린다 — 그래서 여기 안에 둔다.
    a = np.array(Image.open(out_path).convert("L"))
    rx, ry = mm(outer_x0), mm(outer_y0)
    ring = a[ry:mm(outer_y0 + outer_mm), rx:mm(outer_x0 + outer_mm)].copy()
    # 마커 자리는 **붙일 때 쓴 좌표 그대로** 뺀다.
    # mm(a+b) != mm(a)+mm(b) (각자 반올림) 이라 다시 계산하면 1px 어긋나 마커가 새어든다.
    ex, ey = mm(mx0) - rx, mm(my0) - ry
    side = mm(marker_mm)
    ring[ey:ey + side, ex:ex + side] = 255
    dark = int((ring < 128).sum())
    if dark:
        raise SystemExit(f"{name}: quiet zone 안에 검은 잉크 {dark}px — 사각형 검출을 방해한다")
    stray = sorted(set(ring[ring < 250].tolist()) - {GRAY[0]})
    if stray:
        raise SystemExit(f"{name}: quiet zone 안에 회색 안내선 아닌 값 {stray}")

    # 마커 영역의 검정 비율 — 테두리(면적 75%) + 내부 3x3 중 검정칸
    mk_px = a[mm(my0):mm(my0) + side, mm(mx0):mm(mx0) + side]
    black_ratio = float((mk_px < 128).mean())
    if not 0.85 < black_ratio < 0.95:
        raise SystemExit(f"{name}: 마커 검정 비율 {black_ratio:.1%} — 마커가 제대로 안 들어갔다")

    return {
        "file": out_path.name,
        "marker_mm": marker_mm,
        "quiet_mm": quiet_mm,
        "quiet_ratio": ratio,
        "outer_mm": outer_mm,
        "side_margin_mm": side_margin,
        "caption_top_mm": outer_y0 + outer_mm + CAPTION_GAP,
        "caption_bottom_mm": y,
        "px": img.size,
        "black_ratio": black_ratio,
    }


def quiet_for(marker_mm):
    """작은 마커일수록 비율만으로는 여백이 종잇장이 된다 — 절대 하한 6mm 를 같이 건다.

    25mm 마커의 8% 는 2mm 다. 인쇄 오차·자르기 오차가 그것보다 크다.
    """
    return max(round(marker_mm * 0.10), 6)


def check_clean(path, boxes):
    """quiet zone(+테이프 띠) 안에 검은 잉크가 없는지 **출력 픽셀로** 확인한다.

    `build()` 의 자가검사와 같은 규칙이다. 규칙이 두 곳에 있으면 한쪽만 낡는다 —
    그래서 실험 시트도 이 함수를 통과해야 파일이 남는다.
    """
    a = np.array(Image.open(path).convert("L"))
    for b in boxes:
        rx, ry = mm(b["x0"]), mm(b["y0"])
        ring = a[ry:mm(b["y0"] + b["outer_mm"]), rx:mm(b["x0"] + b["outer_mm"])].copy()
        # 마커 자리는 **붙일 때 쓴 좌표 그대로** 뺀다 (mm(a+b) != mm(a)+mm(b) — build() 주석 참조)
        ex, ey = mm(b["mx0"]) - rx, mm(b["my0"]) - ry
        side = mm(b["marker_mm"])
        ring[ey:ey + side, ex:ex + side] = 255
        dark = int((ring < 128).sum())
        if dark:
            raise SystemExit(f"{b['marker_mm']}mm: quiet zone 안에 검은 잉크 {dark}px")
        stray = sorted(set(ring[ring < 250].tolist()) - {GRAY[0]})
        if stray:
            raise SystemExit(f"{b['marker_mm']}mm: quiet zone 안에 회색 안내선 아닌 값 {stray}")

        mk = a[mm(b["my0"]):mm(b["my0"]) + side, mm(b["mx0"]):mm(b["mx0"]) + side]
        r = float((mk < 128).mean())
        if not 0.85 < r < 0.95:
            raise SystemExit(f"{b['marker_mm']}mm: 마커 검정 비율 {r:.1%} — 제대로 안 들어갔다")


def build_test(barcode, out_path):
    """크기별 마커를 A4 한 장에 담는다. **잘라서 하나씩** 쓴다.

    번호를 전부 같게 두는 것이 요점이다 — 크기만 바꾸면 `.env` 도 코드도 안 건드린다.
    (`FR5_MARKER_MM` 은 화면의 '거리m' 환산에만 쓰이지 검출에는 안 쓰인다)
    """
    pw, ph = TEST_PAGE
    img = Image.new("RGB", (mm(pw), mm(ph)), "white")
    d = ImageDraw.Draw(img)
    f_small = font(8)
    f_cap = font(7)

    d.text((mm(TEST_MARGIN), mm(TEST_MARGIN)),
           f"FR5Web 마커 크기 실험 · 3x3_HAMMING63 · barcodeValue {barcode} 전부 동일"
           f" · 100% 배율 · 무광 용지 · 버거 상판 가용 34~54mm",
           font=f_small, fill=DIM)

    src = SRC_DIR / f"{barcode}.png"
    if not src.exists():
        raise SystemExit(f"마커 원본이 없다: {src}")

    boxes = []
    x = TEST_MARGIN
    y = TEST_MARGIN + 10
    row_h = 0
    for size in TEST_SIZES:
        quiet = quiet_for(size)
        pad = quiet + TAPE_MM
        outer = size + 2 * pad
        if x + outer > pw - TEST_MARGIN:          # 줄바꿈
            x = TEST_MARGIN
            y += row_h + CAP_H + TEST_GAP
            row_h = 0
        if y + outer + CAP_H > ph - TEST_MARGIN:
            raise SystemExit(f"{size}mm 가 용지를 벗어난다 — TEST_SIZES 를 줄여라")

        mk = Image.open(src).convert("RGB").resize((mm(size), mm(size)), Image.NEAREST)
        mx0, my0 = x + pad, y + pad
        img.paste(mk, (mm(mx0), mm(my0)))
        d.rectangle([mm(x), mm(y), mm(x + outer), mm(y + outer)],
                    outline=GRAY, width=max(1, mm(0.3)))
        d.text((mm(x), mm(y + outer + 1)), f"{size}mm", font=f_cap, fill=DIM)

        boxes.append({"x0": x, "y0": y, "outer_mm": outer, "mx0": mx0, "my0": my0,
                      "marker_mm": size, "quiet_mm": quiet})
        row_h = max(row_h, outer)
        x += outer + TEST_GAP

    img.save(out_path, dpi=(DPI, DPI))
    check_clean(out_path, boxes)
    return boxes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true",
                    help="크기 실험 시트 (A4 한 장에 25·35·45·55·80mm)")
    # 원본은 쓰는 것만 남겼다 — 5(정본) · 2(예비) · 3(검출 테스트 음성 대조군).
    # 다른 번호가 필요하면 출처에서 다시 받는다 (docs/ref/arch/STACK.md §마커).
    ap.add_argument("--barcode", type=int, default=5, help="바코드 번호 (원본이 있는 것: 2·3·5)")
    args = ap.parse_args()

    MARKER_DIR.mkdir(parents=True, exist_ok=True)

    if args.test:
        out = MARKER_DIR / f"marker-test-sizes-bc{args.barcode}.png"
        boxes = build_test(args.barcode, out)
        print(f"A4 실험 시트  {out.name}")
        for b in boxes:
            print(f"     마커 {b['marker_mm']:>3}mm · quiet {b['quiet_mm']}mm"
                  f" · 테이프 띠 {TAPE_MM}mm · 오려낼 크기 {b['outer_mm']}mm")
        print("\n  자르기: 연회색 선. 테이프는 선과 마커 사이 흰 띠에만 붙인다.")
        print("  한 번에 하나만 카메라에 보인다 — 번호가 전부 같아서 여러 장이 보이면 엉킨다.")
        return 0

    for name, page, marker_mm, quiet_mm, top_mm in SHEETS:
        out = MARKER_DIR / f"marker-print-{name}-{marker_mm}mm-bc{args.barcode}.png"
        info = build(name, page, marker_mm, quiet_mm, top_mm, args.barcode, out)
        print(
            f"{name}  {info['file']}\n"
            f"     마커 {info['marker_mm']}mm · quiet {info['quiet_mm']}mm ({info['quiet_ratio']:.0%})"
            f" · 바깥 {info['outer_mm']}mm · 용지 여백 {info['side_margin_mm']:.1f}mm"
            f" · 캡션 시작 {info['caption_top_mm']:.0f}mm · {info['px'][0]}×{info['px'][1]}px"
        )


if __name__ == "__main__":
    sys.exit(main())
