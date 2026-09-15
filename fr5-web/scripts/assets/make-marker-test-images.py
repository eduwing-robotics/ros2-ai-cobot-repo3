#!/usr/bin/env python3
"""마커 검출 실측용 합성 이미지 생성 — `AR/test/marker-detect.html` 이 먹는다.

왜 스크립트로 두나
  `AR/test/marker-images/` 의 117장은 **생성물**이다. 손으로 만든 자산이 아니다.
  조건(크기·흐림·대비·JPEG·여백)을 바꿔 다시 재려면 여기를 고친다.

무엇을 만드나
  ① 기본   — 크기 × 기울기. 마커 #5(정본)와 #2(예비)
  ② 스트레스 — 흐림·낮은 대비·JPEG 압축. **실제 폰 조건**
  ③ 대비    — 명도차를 단계로 낮춘다. 임계값을 찾는다
  ④ 음성 대조군 — 마커가 없거나 다른 마커. **이게 없으면 측정이 아니다**
  ⑤ 흰 여백  — 여백만 0~40%로 바꾼다. 인쇄 시트의 여백 폭을 정하는 근거

결과 해석은 `docs/archive/evidence-2026-07/2026-07-30/marker-detect.md`.
"""

import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
# **D23 이관(`web/` → `Shared/`·`AR/`)을 이 파일만 안 따라왔다** (2026-08-08 정정).
# `web/` 은 저장소에 없어서 이 스크립트는 그동안 "마커 원본이 없다"로 죽어 있었다.
# 형제 `make-marker-sheet.py` 는 같은 사고를 이미 겪고 자기 경로만 고쳤다.
# 산출물 자리의 근거는 `.gitignore` 다 — `AR/test/marker-images/` 옆에 이 스크립트 이름이 적혀 있다.
SRC = ROOT / "Shared" / "assets" / "marker" / "barcode"
OUT = ROOT / "AR" / "test" / "marker-images"

W, H = 640, 480  # 흔한 웹캠·AR.js 기본 캔버스 크기
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"

PRIMARY, BACKUP = 5, 2


def frame(marker_px, barcode, blur=0.5, contrast=1.0, jpeg=None, angle=0):
    """마커 한 장을 흰 프레임 가운데 놓고 카메라 열화를 흉내낸다."""
    im = Image.new("L", (W, H), 255)
    m = Image.open(SRC / f"{barcode}.png").convert("L").resize((marker_px, marker_px), Image.LANCZOS)
    if angle:
        m = m.rotate(angle, resample=Image.BICUBIC, fillcolor=255, expand=True)
    im.paste(m, ((W - m.width) // 2, (H - m.height) // 2))
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    if contrast != 1.0:
        im = ImageEnhance.Contrast(im).enhance(contrast)
    return im


def separation(im, marker_px):
    """마커 영역의 흑백 명도차. **사진에서도 잴 수 있는 값**이라야 사람이 쓸 수 있다."""
    a = np.array(im.convert("L"))
    roi = a[(H - marker_px) // 2:(H + marker_px) // 2, (W - marker_px) // 2:(W + marker_px) // 2].astype(int)
    return int(np.percentile(roi, 95)) - int(np.percentile(roi, 5))


def to_jpeg(im, quality):
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    # ① 기본 — 크기 × 기울기
    base = []
    for bc in (PRIMARY, BACKUP):
        for px in (240, 160, 120, 80, 60, 44, 32, 24, 16):
            for angle in (0, 12):
                im = frame(px, bc, angle=angle)
                name = f"bc{bc}_{px}px_{angle}deg.png"
                im.convert("RGB").save(OUT / name)
                base.append({"file": name, "barcode": bc, "px": px, "deg": angle})
    (OUT / "cases.json").write_text(json.dumps(base, ensure_ascii=False))

    # ② 스트레스 — 실제 폰 조건
    stress = []
    for px in (120, 80, 60, 44, 32, 24, 16):
        for blur, contrast, jpeg in [
            (0.5, 1.0, None), (1.5, 1.0, None), (3.0, 1.0, None),
            (1.5, 0.45, None), (1.5, 1.0, 35), (3.0, 0.45, 35),
        ]:
            im = frame(px, PRIMARY, blur=blur, contrast=contrast)
            im = to_jpeg(im, jpeg) if jpeg else im.convert("RGB")
            name = f"st_{px}px_blur{blur}_c{contrast}_j{jpeg or 0}.png"
            im.save(OUT / name)
            stress.append({"file": name, "barcode": PRIMARY, "px": px,
                           "blur": blur, "contrast": contrast, "jpeg": jpeg or 0})
    (OUT / "stress.json").write_text(json.dumps(stress, ensure_ascii=False))

    # ③ 대비 — 임계값 찾기. 명도차를 함께 기록한다
    ct = []
    for c in (1.0, 0.85, 0.7, 0.6, 0.5, 0.45, 0.35):
        for px in (120, 60, 32):
            im = frame(px, PRIMARY, blur=1.0, contrast=c)
            name = f"ct_{px}px_c{c}.png"
            im.convert("RGB").save(OUT / name)
            ct.append({"file": name, "barcode": PRIMARY, "px": px,
                       "contrast": c, "sep": separation(im, px)})
    (OUT / "contrast.json").write_text(json.dumps(ct, ensure_ascii=False))

    # ⑤ 흰 여백(quiet zone) — 인쇄 시트의 여백 폭을 정하는 근거.
    #    마커 크기는 고정하고 **여백만** 바꾸며, 여백 밖은 어두운 배경으로 둔다.
    #    어두운 판·테이블에 붙이거나 종이 끝까지 마커가 가는 상황이 실제 위험이다.
    qz = []
    for marker_px in (120, 80):
        for pct in (0, 3, 6, 10, 16, 25, 40):
            pad_px = round(marker_px * pct / 100)
            im = Image.new("L", (W, H), 60)  # 어두운 배경 (밝기 60)
            white = Image.new("L", (marker_px + 2 * pad_px,) * 2, 255)
            src = Image.open(SRC / f"{PRIMARY}.png").convert("L")
            white.paste(src.resize((marker_px, marker_px), Image.LANCZOS), (pad_px, pad_px))
            im.paste(white, ((W - white.width) // 2, (H - white.height) // 2))
            im = im.filter(ImageFilter.GaussianBlur(1.0))
            name = f"qz_{marker_px}px_{pct}pct.png"
            im.convert("RGB").save(OUT / name)
            qz.append({"file": name, "barcode": PRIMARY, "px": marker_px,
                       "qz_pct": pct, "qz_px": pad_px})
    (OUT / "quietzone.json").write_text(json.dumps(qz, ensure_ascii=False))

    # ④ 음성 대조군 — 검출되면 안 되는 것들
    neg = []
    Image.new("RGB", (W, H), "white").save(OUT / "neg_blank.png")
    neg.append({"file": "neg_blank.png", "desc": "빈 흰 화면"})

    frame(240, 3).convert("RGB").save(OUT / "neg_bc3.png")  # 등록하지 않는 번호
    neg.append({"file": "neg_bc3.png", "desc": "등록 안 한 마커 #3"})

    im = Image.new("RGB", (W, H), "white")
    ImageDraw.Draw(im).rectangle([200, 120, 440, 360], fill="black")
    im.filter(ImageFilter.GaussianBlur(0.5)).save(OUT / "neg_solid.png")
    neg.append({"file": "neg_solid.png", "desc": "검은 사각형만 (패턴 없음)"})

    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, 34)
    for i in range(9):
        d.text((40, 40 + i * 46), "검출 오탐 확인용 문서 ABCDEFG 0123456789", font=f, fill="black")
    im.filter(ImageFilter.GaussianBlur(0.5)).save(OUT / "neg_text.png")
    neg.append({"file": "neg_text.png", "desc": "글자 있는 문서"})

    (OUT / "negatives.json").write_text(json.dumps(neg, ensure_ascii=False))

    total = len(base) + len(stress) + len(ct) + len(qz) + len(neg)
    print(f"기본 {len(base)} · 스트레스 {len(stress)} · 대비 {len(ct)}"
          f" · 여백 {len(qz)} · 대조군 {len(neg)} = {total}장")
    print(f"→ {OUT.relative_to(ROOT)}")
    # `serve.sh` 는 포트 인자를 안 받는다 — `ar|dash` 워크스페이스를 받아 vite 를 띄운다
    # (옛 `python3 -m http.server <포트> -d web` 시절 문구가 남아 있었다 · 2026-08-08 정정).
    print("실행: bash scripts/dev/serve.sh ar → /test/marker-detect.html")


if __name__ == "__main__":
    main()
