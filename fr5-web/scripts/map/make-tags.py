#!/usr/bin/env python3
"""글로벌 카메라 캘리브레이션용 인쇄물을 만든다 — AprilTag 36h11 + ChArUco 보드.

**폰 AR 마커(`Shared/assets/marker/`)와 다른 물건이다.**
저쪽은 AR.js 가 브라우저에서 읽는 3x3 바코드, 이쪽은 OpenCV 가 파이썬에서 읽는 태그다.
용도가 다르니 섞지 않는다 (`docs/research/ar-global-camera.md` §마커 판정).

왜 AprilTag 36h11 인가 — 같은 크기에서 ArUco 보다 원거리 검출이 낫고 로봇공학 표준이다.
그런데 **OpenCV 에 사전이 내장돼 있어 추가 의존성이 0 이다.** 검출은 cv2.aruco 로 한다.

크기 규약 — **선언 크기 = 검은 사각형의 바깥 한 변.** solvePnP 에 넣는 값이 이것이다.
바깥 흰 여백은 검출용 정숙영역(quiet zone)이지 크기에 포함되지 않는다.

    python3 scripts/map/make-tags.py
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

DPI = 300
MM = DPI / 25.4                      # 1mm 당 픽셀
A4 = (int(210 * MM), int(297 * MM))  # 2480 x 3508
A3 = (int(297 * MM), int(420 * MM))

# 크기는 **최원거리 모서리의 칸당 픽셀**로 정한다. 36h11 은 8칸이고 눕힌 태그는
# 카메라 부각만큼 단축되므로, 화면 중앙의 여유가 먼 모서리에서 사라진다.
# 맵 3.0×1.6m·높이 2.4m·**HFOV 70°·1080p 가정** (2026-08-02). ⚠ 둘 다 지금은 옛 값이다 —
# 실측 HFOV 는 **73.05°**, 잠금 해상도는 **2560×1440** 이다 (2026-08-07 · global-cam.json).
# **결론(A4 160mm)은 안 바뀐다** — 화각만 73.05° 로 고치면 px/칸이 0.945 배가 되어
# 긴 변 중앙 160mm 가 5.9 → **5.58** 로 여전히 안전선 5.0 위이고, 실제 2560px 까지 넣으면
# 오히려 약 7.4 로 는다. 여유가 18% → 12% 로 준 것뿐이라 표를 다시 안 그린다 (2026-08-08).
#
#            배치         해상도   150mm      220mm
#   모서리 위          1080p   3.6px/칸   5.2px/칸
#   긴 변 중앙 위      1080p   5.5px/칸   8.0px/칸
#
# 5px/칸이 안전선, 3px/칸은 조명이 나쁘면 놓친다.
# → **A4 150mm 는 "긴 변 중앙 위 + 1080p 이상" 조건에서만 쓴다.**
#
# **A4 만 낸다** (2026-08-03) — 인쇄 환경이 A4 뿐이다. A3 가 생기면 `(A3, 220)` 을 되돌린다.
#
# **A4 상한은 종이 폭 210mm 이지 프린터 여백이 아니다.** 정숙영역은 흰색이라 인쇄가
# 필요 없어서, 프린터가 못 찍는 가장자리에 걸쳐도 된다. 따라서 `크기 × 1.25 ≤ 210`
# → 최대 168mm. 160 은 종이 끝에 양쪽 5mm 를 남긴 값이다 (긴 변 중앙·1080p 에서 5.9px/칸).
# ⚠ 168 까지 밀면 정숙영역 경계가 곧 종이 가장자리라 **흰 판이 아니면 깨진다.**
SHEETS = [(A4, 160)]
QUIET_RATIO = 1 / 8   # 정숙영역 = 태그 1칸 폭. 이보다 좁으면 임계화가 흔들린다

# 0~3 은 맵 네 모서리(바닥). **4 는 바닥이 아니다** — 로봇이 얹힌 테이블 위 같은
# 높이 있는 면에 올려놓고 정합이 z>0 에서도 맞는지 보는 **이동식 기준자**다.
# 바닥 태그로 푼 카메라는 바닥에서만 검증됐고, 팔은 900mm 위에서 움직인다.
TAG_IDS = [0, 1, 2, 3, 4]

# 받침(이동식 지그)에 붙일 태그 — 위 0~4 와 **용도가 다르다.** 저쪽은 방을 한 번 재는 기준물이고
# 이쪽은 **매번 움직이는 지그의 자세**를 낸다. 그래서 크기 상한이 종이(210mm)가 아니라
# **붙일 면**이다: 정숙영역까지 평평하게 얹혀야 하므로 `크기 × 1.25 ≤ 면 한 변`.
#   95mm 받침 → 상한 76mm. 재단·부착 여유를 두고 **70** 을 쓴다 (여백 한쪽 3.75mm).
#
# ⚠ **id 5 를 건너뛴다.** AprilTag 로는 비어 있지만 폰 AR 마커가 이미 「#5」를 쓰고 있어
# (`Shared/assets/marker/` · 위 docstring 이 두 체계를 섞지 말라고 적어 둔 그 자리다),
# 숫자 5 가 두 체계에 동시에 존재하면 사람이 반드시 헷갈린다.
#
# ⚠ **눕혀 붙이면 한 축이 단축된다.** 글로벌캠 부각 22.86° 에서 바닥에 평평히 누운 태그는
# 깊이 방향이 `sin 22.86° = 0.388` 배로 눌려 70mm 가 9.7 → **3.8 px/칸** 이 된다(안전선 5.0).
# **카메라 쪽으로 세우거나 기울여** 붙인다 — 45° 만 세워도 0.93 배라 9.0 px/칸이 남는다.
# ⛔ **id 6 을 맨 앞에서 옮기지 마라.** `FR5/bridge/fixture.py:180,224` 가 `fixtureTags[0]` 을
# 집는다 — 순서가 바뀌면 안전 게이트가 **다른 물건의 기하로** 받침을 세운다. 새 태그는 뒤에 붙인다.
# (id 로 찾게 고치는 것이 옳지만 안전 경로라 이번 범위 밖이다 — GAP 에 남겼다)
#
# ── 2026-08-18 조립 시나리오 8장 ─────────────────────────────────────────────
# **크기는 취향이 아니라 계산이다.** 글로벌캠에서 5.0 px/칸(안전선)을 넘겨야 하고,
# 36h11 은 8칸, fx 1728.17 이므로
#     최소 크기 = 5.0 × 8 × 거리 ÷ 1728.17 ÷ 단축계수
# 카메라는 user1 (528, −2265, 339) — 작업대 **바깥**에서 카트 쪽을 본다. 부각 17.32° 라
# **눕히면 0.298 배**로 눌린다 (70mm 가 2.9px/칸 → 조명 나쁘면 놓친다). 그래서 전부
# **카메라 쪽(−y)으로 45° 기울여** 붙인다 — 그때 0.886 배다.
#     실측 거리   작업대 1378 / 1565 / 2289 · 거치대 1521 / 1591 / 2229 · 터틀봇 1273~1935
#     최소 크기   36 / 41 / 60 · 40 / 42 / 58 · 51
# 아래 값은 전부 그 **1.4~1.9 배**다. 부착면 상한도 같이 지켜야 한다 — 크기 × 1.25 ≤ 면 한 변.
#
# ⛔ **이 태그들이 파지 정밀도를 주지 않는다.** 카메라↔핑거 사슬은 실측 **23.0mm** 다
# (`docs/evidence/2026-08-12/fixture-tag-chain.md`). 집는 정밀도는 **기계적 도킹 + 티칭**에서
# 나오고, 이 태그의 일은 **「그 사이에 뭔가 움직였나」를 잡는 것**이다. 둘을 바꿔 읽지 마라.
# ── 인쇄 배율 — **파일은 맞고 프린터가 줄인다** ───────────────────────────────
# 2026-08-18: 실기 담당자가 8장을 인쇄해 자로 재셨다. 선언 140→118 · 160→134 · 120→100 · 100→84.
# 여덟 개가 **한 배율(0.8392 · 개별 폭 1.0%)** 로 맞고, 받침 id6 이 08-12 에 낸 **0.840** 과
# 0.1% 차이다 — **같은 배율이 재현됐다.** 생성기 자가검증은 PNG 를 되읽어 선언 mm 와 0.1mm
# 안에서 맞다고 찍으므로 **범인은 파일이 아니라 인쇄 설정**이다(맞춤 인쇄가 켜져 페이지째 줄었다).
#
# ⛔ **선언값으로 solvePnP 를 풀면 깊이가 통째로 틀린다** — 크기 오류가 깊이 오류로 나온다.
# 그래서 여기 실측을 적는다. **다시 인쇄하면 다시 잰다** (배율이 달라진다 — 방 기준 태그는
# 같은 규약으로 0.906 이었다. 프린터·설정마다 다르다).
PRINT_SCALE = 0.840
_SCALE_WHY = ("실기 담당자가 인쇄해 자로 잰 배율 0.840 을 선언값에 곱한 값 (2026-08-18 · 8장 일치 · "
              "받침 id6 의 08-12 실측과 같다). 파일은 맞다 — 자가검증이 선언 mm 로 되읽는다. "
              "**다시 인쇄하면 다시 잰다.**")


def printed(declared_mm):
    """인쇄물의 **실측 한 변**. solvePnP 에 들어가는 값은 선언이 아니라 이것이다."""
    return {"measuredMm": round(declared_mm * PRINT_SCALE, 1), "_measuredMm": _SCALE_WHY,
            "measuredAt": "2026-08-18"}


FIXTURE_TAGS = [
    # 5번째 칸 = **출력 위치**. "" 면 지금까지처럼 `tag/` 바로 아래다(옛 인쇄물 경로를 안 깬다).
    # "<폴더>/<이름>" 이면 그 폴더에 넣고 파일명 끝에 이름을 붙인다 — **인쇄물을 손에 들었을 때
    # id 번호만 보고 어디에 붙일지 헷갈리지 않게** 하는 것이 목적이다. 폴더를 손으로 옮기지 마라:
    # 다음에 이 스크립트를 돌리면 다시 흩어진다. 위치는 **여기가 정본**이다.
    # ⛔ **네 번째 칸(잰 값)을 지우지 마라.** 예전엔 이 값들이 `tags.json` 에만 살아서,
    #    이 스크립트를 다시 돌리는 것만으로 **손으로 잰 셋이 조용히 사라졌다** (2026-08-18 실측 —
    #    게이트 `test_실제_tags_json_이_기하를_들고_있다` 가 잡았다). 이제 여기가 정본이다.
    (6, 70, '받침 = 나무 정육면체. 태그는 **옆면**에 세워 붙인다 (윗면이 아니다 — 손목캠은 이 태그를 못 본다)',
     {'measuredMm': 58.8,
      '_measuredMm': '인쇄 배율 0.840 을 반영한 **실측 한 변** (evidence/2026-08-12/fixture-tag-chain.md). 선언 70 으로 '
                     '풀면 215.8mm 어긋난다 — solvePnP 는 크기 오류를 깊이 오류로 낸다. **다시 인쇄하면 다시 잰다.**',
      'halfMm': 95.0,
      '_halfMm': '게이트 상자의 반폭(mm). **실물보다 크게** 잡는다 — 넓게 막는 쪽 오차라 안전 방향이고, 카메라 사슬 오차 23mm 도 삼킨다. ⚠ 받침이 '
                 '바뀌면 **실물 바닥 넓이를 재서** 다시 적는다. 받침이 상자 모양이 아니어도(V블록·판 등) 그 물건을 통째로 덮는 값이면 된다.',
      'tagCenterToTopMm': 47.5,
      '_tagCenterToTopMm': '태그 중심에서 **받침 윗면까지의 수직 거리**(mm · 위가 +). 게이트는 윗면을 막아야 하는데 **태그가 옆면이라 윗면을 못 '
                           '본다** — 그래서 이 한 값이 필요하다. 예전 코드는 이걸 `높이/2` 로 가정했는데 그건 **태그가 옆면 정중앙일 때만** 참이다. '
                           '⚠ 받침이 바뀌면 **자로 재서** 다시 적는다. 지금 값은 95mm 정육면체 · 태그 중앙 부착 기준(95/2=47.5)이고 '
                           '**실측이 아니라 유도값**이다. ⛔ **실측 높이와 어긋난다** (감사 2026-08-13): `props.js '
                           'FIXTURE.heightMm=86.5`(뎁스 실측·증인 3개)라 95 전제와 8.5mm 차이 — 윗면을 실물보다 **위로** 잡아 '
                           '게이트는 넓게 막지만(안전 방향), 파지 높이 계획엔 틀린 값이다. **자로 재서 실측으로 바꾸기 전까지 이 값으로 파지 높이를 정하지 '
                           '않는다.**',
      'measuredAt': '2026-08-13',
      '_measuredAt': '이 셋(`measuredMm`·`halfMm`·`tagCenterToTopMm`)을 마지막으로 확인한 날. 받침이나 인쇄물이 바뀌면 갱신한다.'}, ""),
    # ── id 는 **테두리 링이 두꺼운 것**으로 골랐다 (실기 담당자 2026-08-18 「흰 부분이 더 많으면
    #    불리하지 않나」). 검은 테두리 **바로 안쪽 20칸**이 희면 테두리가 얇아 보이고,
    #    멀고 흐릴 때 검출기가 그 테두리를 갉아먹어 사각형이 작게 잡힌다 — 그러면 그 태그만
    #    「더 멀다」로 풀린다 (`extrinsics.py:118` · 실측 재투영 5.62px → 1.19px).
    #    처음 고른 id 11(흰 14칸)·13(13칸)을 버리고 **전부 9칸 이하**로 바꿨다. id 는 587개라 공짜다.
    # ── 자세는 **세움(수직)**. 45° 보다 단축계수가 0.886 → **0.955** 로 오르고 발자국이 0 이라
    #    차선을 안 먹는다. 대신 키가 1.25×크기 다 — 그만큼 **팔이 칠 수 있는 장애물**이 된다.
    (7, 140, "작업대1 — 먼 변(y -1236) 판 중앙 · 세워서 카메라 쪽", printed(140), "scenario-assembly/table1"),
    (10, 140, "작업대2 — 먼 변(y -1236) 판 중앙 · 세워서 카메라 쪽", printed(140), "scenario-assembly/table2"),
    (12, 160, "작업대3 — 먼 변(x -450) 판 중앙 · 세움 (2.2m 로 제일 멀다)", printed(160), "scenario-assembly/table3"),
    (15, 100, "거치대1 원료(탄두·탄피 분리) · 세움", printed(100), "scenario-assembly/jig1-stock"),
    # ── 18 재용도 (2026-08-28 · 실기 담당자 결정) — 원래 **거치대2 조립 지그**용이었다.
    #    거치대2 가 **고정**으로 확정돼(D149) 카메라 사슬을 뗐고, 그래서 이 태그가 놀았다 —
    #    `FR5/bridge/config.yaml` 의 `fixture_tag_id:` 가 비어 있는 것이 그 결과다.
    #    **터틀봇 윗면으로 옮긴다.** 목적이 바뀐다 — 「받침이 어디 있나」가 아니라
    #    **「터틀봇이 지금 어디 있나」** 이고, 그러면 글로벌캠이 경로 전체를 mm 로 잰다.
    #    ⭐ **세움이 아니라 눕힘이다** — 다른 태그는 손목캠이 옆에서 보라고 세웠는데, 이건
    #    글로벌캠이 **위에서** 내려다본다. 붙이는 면이 다르면 자세 해석도 다르다.
    #    부착면 규칙(크기×1.25 ≤ 면 한 변) — 실측 84.0 × 1.25 = 105 ≤ 터틀봇 윗면 짧은 변 138 ✓
    #    **인쇄물은 08-18 그대로 재사용**한다 (재인쇄하면 배율을 다시 잰다 · 32·33 과 같은 규약).
    #    ⚠ **아직 안 잰 것 둘** — ①태그 중심 ↔ 로봇 중심(odom 원점) 평면 오프셋
    #       ②태그 중심 높이(판 위). 이 둘이 있어야 태그 자세가 로봇 자세가 된다.
    (18, 100, "터틀봇 윗면 — 위치·방향 실측용 · **눕힘**(글로벌캠이 위에서 본다)",
     printed(100), "scenario-assembly/amr-top"),
    (21, 140, "거치대3 완제품 · 세움 (2.2m 로 제일 멀다)", printed(140), "scenario-assembly/jig3-output"),
    # ── 32·33 재용도 (2026-08-19 · 실기 담당자 결정) — 원래 터틀봇 거치대용이었다.
    #    브래킷이 작아 부착면 규칙(크기×1.25 ≤ 면 한 변)을 못 지키고, 파지 정밀도는 어차피
    #    도킹·티칭·총알 비전(D131·132)이 담당이라 잃는 게 없다. **인쇄물은 08-18 그대로 재사용**
    #    (재인쇄하면 배율을 다시 재야 한다) — 종이에 찍힌 옛 문구만 손글씨로 고친다.
    (32, 120, "컨베이어 ㄱ자 앵커 — 거치대2→작업대3 꺾임 자리 · 세움", printed(120), "scenario-assembly/conv-elbow"),
    (33, 120, "컨베이어 일자 앵커 — 터틀봇 하차점→거치대2 · 세움", printed(120), "scenario-assembly/conv-straight"),
]

# ChArUco — 168 x 224mm. 30mm 사각으로 하면 240mm 라 아래 설명줄과 겹친다 (실렌더 확인 2026-08-02)
SQ_MM, MK_MM, COLS, ROWS = 28, 21, 6, 8

OUT = Path(__file__).resolve().parents[2] / "Shared/assets/tag"

FONTS = [
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def font(px):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, px)
        except OSError:
            continue
    return ImageFont.load_default()      # 최후 폴백 — 크기는 못 맞지만 인쇄는 된다


def ruler(d, cx, y, mm_len=100):
    """인쇄 배율 검증선. 이걸 자로 재서 100mm 가 아니면 배율이 틀린 것이다."""
    half = mm_len * MM / 2
    d.line([(cx - half, y), (cx + half, y)], fill=0, width=4)
    for x in (cx - half, cx + half):
        d.line([(x, y - 18), (x, y + 18)], fill=0, width=4)
    d.text((cx, y + 30), f"{mm_len}.0 mm — 자로 재서 확인", font=font(34), fill=0, anchor="ma")


def sheet_tag(dic, tag_id, page_size, tag_mm, note=""):
    px = int(round(tag_mm * MM))
    img = cv2.aruco.generateImageMarker(dic, tag_id, px)
    q = int(round(tag_mm * QUIET_RATIO * MM))
    img = cv2.copyMakeBorder(img, q, q, q, q, cv2.BORDER_CONSTANT, value=255)

    page = Image.new("L", page_size, 255)
    x = (page_size[0] - img.shape[1]) // 2
    y = int(22 * MM)
    page.paste(Image.fromarray(img), (x, y))

    cx = page_size[0] // 2
    d = ImageDraw.Draw(page)
    ty = y + img.shape[0] + int(14 * MM)
    d.text((cx, ty), f"APRILTAG 36h11   ID = {tag_id}", font=font(64), fill=0, anchor="ma")
    d.text((cx, ty + 92),
           f"{tag_mm}.0 mm — 검은 사각형 바깥 한 변 (solvePnP 입력값)",
           font=font(38), fill=0, anchor="ma")
    if note:
        d.text((cx, ty + 148), note, font=font(38), fill=0, anchor="ma")
    ruler(d, cx, ty + int(20 * MM))
    d.text((cx, page_size[1] - int(20 * MM)),
           "무광 용지 · 배율 100% (맞춤 인쇄 끄기) · 딱딱한 판에 평평하게",
           font=font(38), fill=0, anchor="ma")
    return page


def sheet_charuco(dic):
    # 길이 단위는 **밀리미터**. 생성 이미지에는 영향이 없지만(비율만 씀) 캘리브레이션
    # 스크립트가 같은 보드를 mm 로 다시 만들므로 여기서부터 단위를 맞춰 둔다 (하드 룰 5).
    board = cv2.aruco.CharucoBoard((COLS, ROWS), SQ_MM, MK_MM, dic)
    w, h = int(round(COLS * SQ_MM * MM)), int(round(ROWS * SQ_MM * MM))
    img = board.generateImage((w, h))

    page = Image.new("L", A4, 255)
    top = int(18 * MM)
    page.paste(Image.fromarray(img), ((A4[0] - w) // 2, top))

    d = ImageDraw.Draw(page)
    ty = top + h + int(8 * MM)
    d.text((A4[0] // 2, ty), "CHARUCO — 카메라 내부 파라미터용", font=font(60), fill=0, anchor="ma")
    d.text((A4[0] // 2, ty + 88),
           f"{COLS} x {ROWS} · 사각 {SQ_MM}mm · 마커 {MK_MM}mm · APRILTAG 36h11",
           font=font(38), fill=0, anchor="ma")
    d.text((A4[0] // 2, ty + 88 + 62),
           "무광 용지 · 배율 100% · 각도·거리를 바꿔 15~20 장 촬영 → cv2.calibrateCamera",
           font=font(38), fill=0, anchor="ma")
    ruler(d, A4[0] // 2, ty + int(22 * MM))
    return page


def main():
    dic = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36H11)
    OUT.mkdir(parents=True, exist_ok=True)
    made = []
    for page_size, tag_mm in SHEETS:
        paper = "A4" if page_size == A4 else "A3"
        for i in TAG_IDS:
            p = OUT / f"apriltag36h11-{tag_mm}mm-id{i}-{paper}.png"
            sheet_tag(dic, i, page_size, tag_mm).save(p, dpi=(DPI, DPI))
            made.append((p, tag_mm))
    for tag_id, tag_mm, note, _, where in FIXTURE_TAGS:
        sub, _sep, slug = where.rpartition("/")
        d = OUT / sub if sub else OUT
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"apriltag36h11-{tag_mm}mm-id{tag_id}-A4{'-' + slug if slug else ''}.png"
        sheet_tag(dic, tag_id, A4, tag_mm, note).save(p, dpi=(DPI, DPI))
        made.append((p, tag_mm))
    # 폴더별 안내문 — **같은 데이터에서 뽑는다.** 손으로 적으면 태그를 늘렸을 때 조용히 낡는다.
    groups = {}
    for tag_id, tag_mm, note, _x, where in FIXTURE_TAGS:
        sub = where.rpartition("/")[0]
        if sub:
            groups.setdefault(sub, []).append((tag_id, tag_mm, note))
    for sub, rows in groups.items():
        lines = [f"{sub} — 인쇄해서 붙일 태그 {len(rows)}장", "",
                 "  무광 용지 · 배율 100%(맞춤 인쇄 끄기) · 딱딱한 판에 평평하게.",
                 "  시트마다 100mm 자가 찍혀 있다 — 인쇄 후 재서 확인한다.", "",
                 "  ⚠ 전부 카메라 쪽(user1 -y)을 향해 **세워서**(수직) 붙인다. 눕히면 0.298배로",
                 "     눌리고 45도로도 0.886배다 — 세우면 0.955배로 제일 낫다.",
                 "  ⚠ 키가 크기의 1.25배다. 팔 도달 안이면 config.yaml 상자에 넣어야 안 친다.",
                 "  ⚠ 크기 x 1.25 <= 붙일 면 한 변 (정숙영역 포함).", "",
                 "  ⛔ 붙이기 전에 검은 사각형 한 변을 자로 재서 tags.json 의 measuredMm 에 적는다.",
                 "     지금까지 인쇄물이 전부 선언보다 작게 나왔다 — 방 기준 160 -> 145(0.906),",
                 "     받침 70 -> 58.8(0.840). 선언값으로 풀면 깊이가 통째로 틀린다:",
                 "     id6 은 그렇게 215.8mm 어긋났다. solvePnP 는 크기 오류를 깊이 오류로 낸다.", ""]
        for tag_id, tag_mm, note in sorted(rows):
            lines.append(f"  id {tag_id:<3} {tag_mm:>4}mm   {note}")
        lines += ["", "  이 파일과 폴더는 scripts/map/make-tags.py 가 만든다 — 손으로 옮기지 마라.",
                  "  제원 정본은 Shared/assets/tag/tags.json.", ""]
        (OUT / sub / "README.txt").write_text("\n".join(lines), encoding="utf-8")

    p = OUT / f"charuco-{COLS}x{ROWS}-{SQ_MM}mm-A4.png"
    sheet_charuco(dic).save(p, dpi=(DPI, DPI))

    # 보드 제원을 JSON 으로 함께 떨군다 — 캘리브레이션 스크립트가 이걸 읽는다.
    # 코드에 6x8·28mm 를 두 번 적으면 한쪽만 고쳐졌을 때 조용히 틀린 값이 나온다.
    (OUT / "tags.json").write_text(json.dumps({
        "_생성됨": "python3 scripts/map/make-tags.py — 직접 고치지 마라",
        "_단위": "밀리미터",
        "family": "DICT_APRILTAG_36H11",
        "cellsPerSide": 8,
        "quietRatio": QUIET_RATIO,
        "sheets": [{"paper": "A4" if s == A4 else "A3", "tagSizeMm": t, "ids": TAG_IDS}
                   for s, t in SHEETS],
        "_받침태그": "붙일 면이 크기를 정한다 — 크기 × 1.25 ≤ 면 한 변 (정숙영역 포함)",
        "fixtureTags": [{"id": i, "tagSizeMm": m, "note": n, "sheet": w or "(tag/ 바로 아래)", **x}
                        for i, m, n, x, w in FIXTURE_TAGS],
        "charuco": {"cols": COLS, "rows": ROWS, "squareMm": SQ_MM, "markerMm": MK_MM},
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    # 자가검증 — 만든 것을 되읽어 전부 제 ID 로, 선언한 mm 로 검출되는지 본다.
    det = cv2.aruco.ArucoDetector(dic, cv2.aruco.DetectorParameters())
    ok = 0
    for p, tag_mm in made:
        g = np.array(Image.open(p).convert("L"))
        corners, ids, _ = det.detectMarkers(g)
        want = int(p.stem.split("-id")[1].split("-")[0])   # ⚠ [0] 이면 id10 이 「1」이 된다
        if ids is not None and int(ids[0][0]) == want:
            side = np.linalg.norm(corners[0][0][0] - corners[0][0][1]) / MM
            if abs(side - tag_mm) <= 0.5:
                ok += 1
            print(f"  {p.name}: 검출 OK · 한 변 {side:.1f}mm (선언 {tag_mm})")
        else:
            print(f"  {p.name}: 검출 실패", file=sys.stderr)

    print(f"{p.parent.relative_to(OUT.parents[2])}/ 에 {len(made) + 1} 장")
    print(f"자가검증 {ok}/{len(made)}")
    return 0 if ok == len(made) else 1


if __name__ == "__main__":
    raise SystemExit(main())
