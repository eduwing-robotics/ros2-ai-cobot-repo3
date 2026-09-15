#!/usr/bin/env python3
"""시뮬 탭 4장 — 데이터 흐름 · 좌표계 체인 · 사이클 상태기계 · 파일 지도 (2026-09-06 · 주인님 「이해에 도움」).

그림 문법·색·`Svg` 는 `arch-svg.py` 것을 그대로 빌린다 — 그림 문법을 두 벌 두면 한쪽이 낡는다.
⛔ **구조만 그리고 진행률은 안 그린다** (`arch-svg.py` 끝 주석 · 2026-08-31 에 시뮬 그림이 로드맵을 복제하다 지워졌다).
정본
  데이터 흐름  `FR5/src/features/sim/SimPanel.jsx` · `docs/ref/contract/API-CONTRACT.md` §/ik · `SIM-CONTRACT.md` §화면
  좌표계       `Shared/data/frames.js` · `docs/ref/contract/FRAMES.md` (하드 룰 5 — 변환은 한 곳)
  사이클       `Shared/data/sim/cycle.js` (구간 id 는 코드의 것 그대로)
  파일 지도    import 관계 (`Shared/data/sim/*` · `FR5/src/features/sim/*`)

    python3 scripts/build/sim-svg.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from arch_svg_lib import Svg, OUT, DIM, ACCENT, FG, esc   # noqa: E402

VERIFIED = "2026-09-09"


def pill(s, x, y, w, text, color=DIM):
    """작은 라벨 상자 — 상태·프레임 이름 같은 짧은 것"""
    s.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="22" rx="11" fill="#ffffff" stroke="{color}"/>')
    s.o.append(f'<text x="{x + w / 2}" y="{y + 15}" font-size="11" font-weight="600" text-anchor="middle" '
               f'fill="{color}">{esc(text)}</text>')


# ── ① 데이터 흐름 ─────────────────────────────────────────────────────────
def data_flow():
    s = Svg(1360, 760, "시뮬 탭 — 데이터 흐름 (입력 한 줄 → 세 층 답 → 사이클 → 트윈)")
    s.legend(1110, 66, [("REST", "브리지에 묻는다"), ("FILE", "정적 파일"), ("WS", "화면 안 호출")])
    # 입력
    s.group(40, 86, 300, 190, "입력 한 줄", "plain", "우선순위 — 실측 > 가정 > 파지 자세")
    s.box(64, 136, 252, 36, "실측 표적", "색 검출 · follow.target")
    s.box(64, 180, 252, 36, "판 위 클릭 (가정)", "RobotTwin 레이캐스트 → user1")
    s.box(64, 224, 252, 36, "08-31 파지 자세", "props.CARRIER_GRASP_TRUTH")
    # 10칸 정본
    s.group(400, 86, 300, 190, "10칸 정본", "focal", "Shared/data/sim/load-steps.js")
    s.box(424, 136, 252, 50, "makeLoadSteps(stop, graspXy)", "접근·문·들기·옮기기·넣기·놓기·빠지기")
    s.box(424, 200, 252, 50, "정차 후보 7", "workcell.AMR_DROP(_CANDIDATES)")
    # 세 층 답
    s.group(760, 86, 320, 190, "세 층 답", "plain", "칸마다 · 못 재면 사유 (결측=차단)")
    s.box(784, 136, 272, 36, "① 닿나", "POST /ik · 참조 = 직전 칸의 해")
    s.box(784, 180, 272, 36, "② 게이트", "실기와 같은 함수 dry_run")
    s.box(784, 224, 272, 36, "③ 부딪히나", "브라우저 무조코 · 길 5° 표본 · 3mm")
    # 브리지
    s.group(760, 330, 320, 150, "FR5 브리지 :5055", "plain", "컨트롤러 또는 mock(URDF FK·수치 IK)")
    s.box(784, 380, 272, 40, "/ik { tcpMmDeg, refJointsDeg? }", "jointsDeg · reachable · gate")
    s.box(784, 428, 272, 40, "/sim/scene/<id>.xml", "구운 MJCF (Sim/out/scene)")
    # 접촉 층
    s.group(400, 330, 300, 150, "접촉 층", "plain", "scene-compose + contact-check")
    s.box(424, 380, 252, 40, "장면 합성", "mocap 터틀봇 · 손에 든 거치대")
    s.box(424, 428, 252, 40, "길 표본 · 관통 3mm", "MINE ↔ OBSTACLE 쌍만")
    # 사이클
    s.group(40, 330, 300, 150, "사이클", "focal", "Shared/data/sim/cycle.js")
    s.box(64, 380, 252, 40, "buildCycle(load, solved, stop…)", "26구간 · 실시간 축 · 배속")
    s.box(64, 428, 252, 40, "observedStop(in · back)", "⓪·⑩ 관측 → 싣기·내리기 재풀기")
    # 트윈
    s.group(40, 540, 1040, 150, "3D 트윈 — RobotTwin.jsx", "plain", "고스트 주인은 하나(사이클) · 실물은 안 움직인다")
    s.box(64, 590, 240, 40, "고스트 팔 · 그리퍼", "관절 보간")
    s.box(320, 590, 240, 40, "거치대", "손 안 = 고스트 손끝 노드 · 판/바구니 = 숫자")
    s.box(576, 590, 240, 40, "터틀봇 · 바퀴", "실물 메시 = 실제 자리 · 상자 = 명령 자리")
    s.box(832, 590, 224, 40, "손목 뎁스 발자국", "깊이 195~1000 · 보이나")
    # 배선
    s.wire(340, 180, 400, 180, "WS")
    s.wire(700, 160, 760, 160, "WS")
    s.wire(920, 276, 920, 330, "REST", both=True)
    s.wire(760, 448, 700, 448, "FILE")
    s.wire(400, 400, 340, 400, "WS")
    s.wire(190, 480, 190, 540, "WS")
    s.route([(550, 276), (550, 330)], "WS")
    s.note(40, 720, "정차 자리는 사이클이 고른다(후보 7 전부 평가 · 우선순위) · 시뮬 결과는 그림이지 실기 근거가 아니다 (SIM-CONTRACT §화면)")
    s.save("sim-data-flow.svg", VERIFIED, ["FR5/src/features/sim", "Shared/data/sim", "FR5/bridge/main.py", "docs/ref/contract/SIM-CONTRACT.md"])


# ── ② 좌표계 체인 ─────────────────────────────────────────────────────────
def frames():
    s = Svg(1360, 620, "시뮬 탭 — 좌표계 체인 (변환은 frames.js 한 곳 · 하드 룰 5)")
    s.legend(1110, 66, [("FILE", "실측 정본에서 온 변환"), ("TCP", "미측 (그리지 않는다)")])
    Y = 200
    frames_ = [
        (60, "odom", "터틀봇 자세 · 브링업 순간이 원점", "AMR pose · trail · 되감기"),
        (330, "user1", "작업대 좌표 · mm·도", "10칸 · 정차 자리 · 거치대 · 관측 표적"),
        (600, "base", "로봇 베이스 · 트윈은 m·z-up", "고스트 · 거치대 노드 · 터틀봇 노드"),
        (870, "tool (tcp)", "손끝 · 플랜지 + 99", "IK 의 tcpMmDeg · 손끝 노드"),
        (1140, "cam", "손목 뎁스 · hand-eye tMm", "관측 자세 · 발자국"),
    ]
    for x, name, sub, who in frames_:
        s.group(x, Y, 190, 150, name, "focal" if name in ("user1", "base") else "plain", sub)
        s.box(x + 16, Y + 62, 158, 34, "여기 사는 값")
        s.o.append(f'<text x="{x + 95}" y="{Y + 122}" font-size="11" text-anchor="middle" fill="{DIM}">{esc(who)}</text>')
    labels = ["AMR_HOME", "coordDefs.user", "URDF 체인", "handEye.tMm"]     # 짧게 — 80px 틈에 들어가야 한다
    for i, lab in enumerate(labels):
        x1 = 60 + 190 + i * 270
        s.wire(x1, Y + 75, x1 + 80, Y + 75, "FILE", both=True)
        s.o.append(f'<text x="{x1 + 40}" y="{Y + 52}" font-size="10.5" text-anchor="middle" fill="{DIM}">{esc(lab)}</text>')
    # camLab — 미측
    s.group(600, 420, 460, 120, "camLab (글로벌 카메라 · 태그0 덱 평면)", "plain", "base 와의 변환 미측 — 예측기(cam-view.js)는 이 안에서만 답한다", dashed=True)
    s.box(624, 472, 412, 40, "태그0 을 손끝으로 짚으면 열린다", "그 전엔 트윈에 못 세운다")
    s.route([(695, 420), (695, 350)], "TCP", dashed=True, label="unknown")   # base 상자 한가운데로
    s.note(40, 590, "단위 변환도 한 곳 — URDF 는 m·rad, 저장 지점은 mm·도. 그림 쪽(트윈)은 base 를 m·z-up 으로 받아 그린다 (hard rule 5)")
    s.save("sim-frames.svg", VERIFIED, ["Shared/data/frames.js", "docs/ref/contract/FRAMES.md", "Shared/data/sim/view-pose.js"])


# ── ③ 사이클 상태기계 ────────────────────────────────────────────────────
def cycle():
    s = Svg(1360, 700, "시뮬 탭 — 컨베이어 한 사이클 (구간 id 는 cycle.js 그대로)")
    s.legend(1110, 66, [("LAN", "주행 (mocap 터틀봇)"), ("WS", "팔 (관절 보간)"), ("FILE", "관측 → 자리 재풀기")])
    # D205 — 먼저 집어 안전 높이까지 들고, 그 자세를 고정한 뒤 터틀봇을 부른다.
    rows = [
        ("o-carrier", "⓪ 거치대를 본다 (이미 찾았으면 생략)", "WS"),
        ("approach → lift", "①~④ 집기 · 안전 높이까지 들기", "WS"),
        ("d-in", "터틀봇 홈 → 정차 (팔·그리퍼 고정)", "LAN"),
        ("o-amr-in-move · o-amr-in / o-basket-held", "⑤a 든 채 바구니를 본다", "WS"),
        ("carry → retreat", "⑤~⑨ 바구니에 놓고 물러남", "WS"),
        ("d-out · d-back", "실은 채 앞 이송 · 되돌아옴", "LAN"),
        ("o-amr-move · o-amr", "⑩ 터틀봇을 본다 — 되돌아온 자리", "WS"),
        ("u-over → u-retreat · d-home", "내리기 8칸 · 터틀봇 홈으로", "LAN"),
    ]
    x, y0, h, gap = 60, 96, 46, 14
    for i, (ident, label, kind) in enumerate(rows):
        y = y0 + i * (h + gap)
        s.box(x, y, 360, h, label, ident)
        if i:
            s.vwire(x + 180, y - gap, y, kind)
    # 거치대 주인
    s.group(480, 96, 300, 250, "거치대는 어디 있나", "focal", "한 곳에만 그린다")
    s.box(504, 146, 252, 40, "plate — 판 위", "숫자 (파지 자세)")
    s.box(504, 196, 252, 40, "hand — 손 안", "고스트 손끝 노드 FK · 요각도 따라간다")
    s.box(504, 246, 252, 40, "basket — 바구니 안", "실제 터틀봇(유령) 기준 상대 자리")
    s.note(504, 322, "③→손 · ⑧ 뒤→바구니 · ⑫→손 · ⑯ 뒤→판")
    # 관측 반영
    s.group(480, 380, 600, 200, "관측 반영 (스위치 · 기본 켬)", "plain", "observedStop — 유령과 같은 도착 오차 모델")
    s.box(504, 430, 268, 46, "⑤a 도착 자리 (in)", "든 채 본 바구니로 투입 5칸을 다시 푼다")
    s.box(788, 430, 268, 46, "⑩ 되돌아온 자리 (back)", "내리기 바구니 쪽 4칸을 이 자리로 푼다")
    s.note(504, 556, "D205: lift 전에는 터틀봇이 움직이지 않는다 · 끄면 열린 루프라 투입·내리기 어긋남이 그림에 난다")
    # ⑤~⑨ → 거치대 주인이 바뀐다 · ⑤a 관측 → 도착 자리 · ⑩ 관측 → 되돌아온 자리
    s.wire(420, 359, 480, 299, "WS")
    s.route([(420, 299), (450, 299), (450, 453), (504, 453)], "FILE")
    s.route([(420, 479), (462, 479), (462, 520), (920, 520), (920, 476)], "FILE")
    # 고스트 주인
    s.group(820, 96, 260, 250, "고스트 주인", "plain", "cycleT 하나")
    s.box(844, 146, 212, 40, "cycleT == null", "고스트를 놓는다 (실물만)")
    s.box(844, 196, 212, 40, "cycleT = ms", "sample(ms) 가 팔·그리퍼·거치대·터틀봇을 준다")
    s.box(844, 246, 212, 40, "구간을 누르면", "그 구간 끝 시각으로")
    s.note(40, 660, "시간축: 팔 = 관절 최대차 ÷ (실기 속도 × 10%) + 정착 · 주행 = 거리 ÷ 138.5mm/s 실측. 시연이다 — 실기 근거가 아니다")
    s.save("sim-cycle.svg", VERIFIED, ["Shared/data/sim/cycle.js", "FR5/src/features/live/RobotTwin.jsx"])


# ── ④ 파일 지도 ──────────────────────────────────────────────────────────
def files():
    s = Svg(1360, 720, "시뮬 탭 — 파일 지도 (누가 누구를 부르나)")
    s.legend(1090, 420, [("WS", "import / 호출"), ("REST", "HTTP"), ("FILE", "파일 읽기")])   # 오른쪽 열 아래 빈 자리 — 위에 두면 그룹이 덮는다
    s.group(40, 86, 400, 300, "FR5/src/features", "focal", "화면")
    s.box(64, 136, 352, 44, "sim/SimPanel.jsx", "절 하나 · evaluateStop · 사이클 재생")
    s.box(64, 190, 352, 44, "sim/contact.js", "runContactCheck — 브라우저 무조코")
    s.box(64, 244, 352, 44, "live/RobotTwin.jsx", "고스트 · 거치대 · 터틀봇 · 발자국 · 판 클릭")
    s.box(64, 298, 352, 44, "data/datasource/http.js", "ik(pose, ref) · robots() · sceneXml(id)")
    s.group(500, 86, 400, 460, "Shared/data/sim", "plain", "순수 함수 · node --test 가 잠근다")
    mods = [("load-steps.js", "10칸 정본"), ("stop-select.js", "후보 7 · 우선순위"), ("view-pose.js", "관측 자세 · rz 최근접 roll"),
            ("cycle.js", "26구간 · observedStop · unloadSteps"), ("scene-compose.js", "MJCF 합성"), ("contact-check.js", "길 표본 · 관통"),
            ("cam-view.js", "글로벌캠 예측기 (camLab 안)")]
    for i, (n, sub) in enumerate(mods):
        s.box(524, 136 + i * 54, 352, 44, n, sub)
    s.group(960, 86, 360, 300, "Shared/view3d · 자산", "plain", "")
    s.box(984, 136, 312, 44, "sim-scene.js", "무조코 wasm · contactsAt · moveAmr")
    s.box(984, 190, 312, 44, "robot.js · burger.js", "URDF 고스트 · tcp 노드 · 바퀴")
    s.box(984, 244, 312, 44, "Sim/out/scene/<id>.xml", "구운 장면 (build-scene)")
    s.box(984, 298, 312, 44, "workcell.js · props.js · catalog.js", "실측 SSOT — 새 좌표 0")
    s.group(40, 430, 400, 116, "FR5/bridge :5055", "plain", "")
    s.box(64, 480, 168, 44, "main.py /ik", "refJointsDeg · dry_run 게이트")
    s.box(248, 480, 168, 44, "robot_adapter/mock.py", "URDF FK · 수치 IK")
    s.group(40, 590, 1280, 100, "게이트 · 시험", "plain", "")
    s.box(64, 636, 280, 40, "scripts/check/sim-tab.mjs", "CDP 실렌더 · 훅으로 잰다")
    s.box(360, 636, 280, 40, "scripts/check/sim-contact.mjs", "Node 무조코 · 낮의 충돌 재현")
    s.box(656, 636, 280, 40, "Shared/data/sim/*.test.js", "node --test")
    s.box(952, 636, 344, 40, "scripts/dev/amr-stop-mujoco.mjs", "같은 모듈로 오프라인 정차 후보 훑기")
    s.wire(416, 158, 500, 158, "WS")
    s.wire(416, 212, 500, 428, "WS", mid=460)
    s.wire(876, 428, 984, 158, "WS", mid=930)
    s.route([(416, 266), (470, 266), (470, 78), (930, 78), (930, 212), (984, 212)], "WS")
    s.wire(240, 342, 240, 430, "REST", both=True)
    s.wire(876, 158, 984, 320, "FILE", mid=945)
    s.note(40, 704, "규칙: 좌표는 SSOT 에서만 · 변환은 frames.js 한 곳 · 시뮬(Sim/)은 실기가 정한 것만 읽는다(D96) — 여기 화면은 트윈 층이다")
    s.save("sim-files.svg", VERIFIED, ["FR5/src/features/sim", "Shared/data/sim", "Shared/view3d/sim-scene.js", "scripts/check/sim-tab.mjs"])


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    data_flow()
    frames()
    cycle()
    files()
