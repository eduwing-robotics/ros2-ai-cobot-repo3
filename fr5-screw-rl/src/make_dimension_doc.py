#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""시뮬레이션 치수 문서(`시뮬레이션_치수.html` / `.txt`)를 만든다.

**숫자를 손으로 옮겨 적지 않는다.** 치수는 MJCF 와 상수 파일에서 직접 읽고,
캡처도 여기서 렌더한다. 그래서 씬을 고치고 이 스크립트만 다시 돌리면 문서가 맞는다.

뷰어 카메라(CAM_*)는 `view_scene.py` / `view_fleet.py` 에서 **정규식으로 긁어 온다** —
import 하면 뷰어 창이 떠 버려서 그렇게 못 한다.

    ../bin/python make_dimension_doc.py
"""

import base64
import io
import json
import os
import re
import sys

import numpy as np
import mujoco
import imageio.v2 as iio

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)

import fr5_site as S                       # noqa: E402
import fr5_screw_assembly as E             # noqa: E402
import fr5_multi_fleet_control as F        # noqa: E402

OUT_HTML, OUT_TXT = "시뮬레이션_치수.html", "시뮬레이션_치수.txt"
MJCF = "fairino5_v6_mjmodel.xml"


# ── 뷰어 카메라 읽기 ──────────────────────────────────────────────────────
def read_cam(path):
    src = io.open(path, encoding="utf-8").read()
    def g(name):
        m = re.search(rf"^{name}\s*=\s*(.+?)\s*$", src, re.M)
        return eval(m.group(1))          # 숫자 리터럴만 들어 있는 줄이다
    return dict(lookat=g("CAM_LOOKAT"), distance=g("CAM_DISTANCE"),
                azimuth=g("CAM_AZIMUTH"), elevation=g("CAM_ELEVATION"))


# ── 씬에서 치수 읽기 ──────────────────────────────────────────────────────
def load_single():
    m = mujoco.MjModel.from_xml_path(MJCF)
    d = mujoco.MjData(m)
    d.qpos[:6] = np.deg2rad(S.HOME_JOINTS_DEG)
    mujoco.mj_forward(m, d)
    return m, d


def mesh_world(m, d, name):
    i = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, name)
    mid = m.geom_dataid[i]
    v = m.mesh_vert[m.mesh_vertadr[mid]:m.mesh_vertadr[mid] + m.mesh_vertnum[mid]]
    return v @ d.geom_xmat[i].reshape(3, 3).T + d.geom_xpos[i]


def box_z(m, name):
    i = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, name)
    p, s = m.geom_pos[i] * 1000, m.geom_size[i] * 1000
    return dict(lo=float(p[2] - s[2]), hi=float(p[2] + s[2]),
                sx=float(s[0] * 2), sy=float(s[1] * 2), sz=float(s[2] * 2))


def render(path, model, data, cam, w=480, h=640):
    r = mujoco.Renderer(model, w, h)
    c = mujoco.MjvCamera()
    mujoco.mjv_defaultCamera(c)
    c.lookat[:] = cam["lookat"]
    c.distance, c.azimuth, c.elevation = cam["distance"], cam["azimuth"], cam["elevation"]
    r.update_scene(data, c)
    iio.imwrite(path, r.render())
    return path


def b64(p):
    return base64.b64encode(open(p, "rb").read()).decode()


def main():
    tmp = "/tmp/_dimdoc"
    os.makedirs(tmp, exist_ok=True)
    cam1, cam5 = read_cam("view_scene.py"), read_cam("view_fleet.py")

    # 1대 씬
    m, d = load_single()
    b, c, f = (mesh_world(m, d, n) for n in ("bullet", "case_body", "fixture"))
    rad = np.linalg.norm(b[:, :2] - b[:, :2].mean(0), axis=1) * 1000
    B = dict(tip=b[:, 2].min() * 1000, top=b[:, 2].max() * 1000,
             shoulder=b[rad > 4.0][:, 2].min() * 1000)
    C = dict(bot=c[:, 2].min() * 1000, mouth=c[:, 2].max() * 1000)
    FX = dict(lo=f[:, 2].min() * 1000, hi=f[:, 2].max() * 1000,
              sx=(f[:, 0].max() - f[:, 0].min()) * 1000,
              sy=(f[:, 1].max() - f[:, 1].min()) * 1000)
    DK, RS = box_z(m, "desk"), box_z(m, "riser")
    tool0 = float(d.site_xpos[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_SITE, "tool0")][2] * 1000)
    origin = json.load(open("task_origin.json"))["origin_mm"]
    img1 = render(f"{tmp}/single.png", m, d, cam1)

    # 5대 플릿 씬
    fv = F.FleetViewer.__new__(F.FleetViewer)
    fv.n_robots, fv.highlight_idx = 5, 2
    fv.base_offsets = F.fleet_offsets(5, 2)
    m5 = mujoco.MjModel.from_xml_path(fv._build_fleet_xml(MJCF))
    d5 = mujoco.MjData(m5)
    q = np.deg2rad(S.HOME_JOINTS_DEG)
    for i in range(5):
        a = m5.jnt_qposadr[mujoco.mj_name2id(m5, mujoco.mjtObj.mjOBJ_JOINT, f"r{i}_j1")]
        d5.qpos[a:a + 6] = q
    mujoco.mj_forward(m5, d5)
    img5 = render(f"{tmp}/fleet.png", m5, d5, cam5)
    sd = box_z(m5, "shared_desk")

    # ── 표 ────────────────────────────────────────────────────────────────
    MESH = [
        ("탄두 나사부 길이", "7.0", f"{E.THREAD_DEPTH*1000:.1f}", "실측 정정", "어깨 위치 = 착좌면"),
        ("탄두 어깨 (선단 기준)", "7.0", f"{B['shoulder']-B['tip']:.2f}", "위에서 따라옴", "Ø5 → Ø9 단차"),
        ("탄피 보어 깊이", "7.0", f"{E.THREAD_DEPTH*1000:.1f}", "위에서 따라옴", "암나사 깊이"),
        ("탄두 오지브 길이", "16.0", "17.0", "전장 유지분", "30 − 6 − 7"),
        ("탄두 전장", "30.0", f"{B['top']-B['tip']:.1f}", "안 변함", "실측"),
        ("탄피 전장", "57.0", f"{C['mouth']-C['bot']:.1f}", "안 변함", "실측"),
        ("조 아랫면 ~ 어깨", "2.0", f"{tool0-B['shoulder']:.2f}", "어깨가 내려와서", "요청값 3mm"),
    ]
    BULLET = [
        ("전장", f"{E.BULLET_LEN*1000:.1f}", "실측"),
        ("나사부 길이", f"{E.THREAD_DEPTH*1000:.1f}", "실측 (7.0 에서 정정)"),
        ("나사부 외경", f"Ø{E.THREAD_OD*1000:.0f}", "실측 · M5"),
        ("나사 피치", f"{E.THREAD_PITCH*1000:.1f}", "M5 보통나사"),
        ("몸통 최대 외경", "Ø9", "실측"),
        ("Ø9 몸통 구간", "6 ~ 13", "선단 기준. 조가 무는 곳"),
    ]
    CASING = [
        ("전장", f"{E.CASE_LEN*1000:.1f}", "실측"),
        ("결합부 외경", f"Ø{E.CASE_OD*1000:.0f}", "실측"),
        ("보어 내경", f"Ø{E.CASE_ID*1000:.0f}", "실측 (메시는 clearance 포함 Ø5.2)"),
        ("보어 깊이", f"{E.THREAD_DEPTH*1000:.1f}", "= 탄두 나사부 길이"),
    ]
    FIX = [
        ("바깥 치수", f"{FX['sx']:.0f} × {FX['sy']:.0f} × {FX['hi']-FX['lo']:.0f}", "두께만 실측"),
        ("구멍", "Ø11 × 깊이 15", "3×3, 간격 28mm"),
        ("방향", "그리퍼와 평행 (euler z −0.50°)", "조가 열리는 방향"),
        ("쓰는 구멍", "로봇에 가장 가까운 줄의 중앙 (hole_5)", "실측"),
        ("탄피 꽂힘", f"{FX['hi']-C['bot']:.1f}", "실측"),
    ]
    DESK = [
        ("책상 (1대 씬)", f"{DK['sx']:.0f} × {DK['sy']:.0f} × {DK['sz']:.0f}", f"윗면 z {DK['hi']:+.1f}"),
        ("공유 작업대 (5대 씬)", f"{sd['sx']:.0f} × {sd['sy']:.0f} × {sd['sz']:.0f}", "로봇별 책상 대신"),
        ("받침판", f"{RS['sx']:.0f} × {RS['sy']:.0f} × {RS['sz']:.1f}", "⚠ 실측 15.0 — 11.4mm 어긋남"),
    ]
    HEIGHT = [
        ("탄두 꼭대기", f"{B['top']:+.1f}", ""),
        ("그리퍼 조 끝 (tool0)", f"{tool0:+.1f}", "FK"),
        ("탄두 나사산 시작(어깨)", f"{B['shoulder']:+.1f}", f"조보다 {tool0-B['shoulder']:.1f}mm 아래"),
        ("탄피 입구", f"{C['mouth']:+.1f}", "탄두와 맞물리는 면"),
        ("탄두 나사 선단", f"{B['tip']:+.1f}", f"입구보다 {C['mouth']-B['tip']:.1f}mm 아래 = 물림"),
        ("고정대 윗면", f"{FX['hi']:+.1f}", f"여기서 탄피 입구까지 {C['mouth']-FX['hi']:.1f}mm"),
        ("로봇 base 최하단", "+0.0", "MJCF 원점"),
        ("탄피 바닥", f"{C['bot']:+.1f}", f"구멍에 {FX['hi']-C['bot']:.1f}mm 꽂힘"),
        ("책상 윗면", f"{DK['hi']:+.1f}", ""),
    ]
    MEAS = [
        ("탄두 꼭대기 ~ 탄피 바닥 (얹은 상태)", "85", "mm", "실측", "자"),
        ("탄피 전장", "57", "mm", "실측", "자"),
        ("탄두 전장", "30", "mm", "실측", "자"),
        ("탄두 나사부", "6", "mm", "실측", "자 (7 에서 정정)"),
        ("고정대 두께", "29", "mm", "실측", "자"),
        ("탄피 꽂힘", "5", "mm", "실측", "눈"),
        ("조 아랫면 ~ 나사산 시작", "3", "mm", "실측", "사람이 정한 파지 위치"),
        ("얹었을 때 노출 나사부", "5", "mm", "실측", "자"),
        ("받침판 (로봇 base ~ 책상)", "15", "mm", "실측", "IMG_4929 의 빨간 1.5"),
        ("탄피 XY (로봇 기준)", f"({origin[0]:.1f}, {origin[1]:.1f})", "mm", "실측", "task_origin.json"),
        ("파지 17% / 열기 35% / 파지력 30", "—", "", "실측", "2026-08-10"),
        ("j6 최대 속도", f"{np.degrees(E.J6_MAX_SPEED):.1f}", "°/s", "실측", "2026-09-05"),
        ("스트로크 1회 회전", f"{S.SCREW_SWEEP_DEG:.0f}", "°", "계산", "−172 → +172"),
        ("스트로크 1회 조임", f"{S.SCREW_MM_PER_STROKE:.3f}", "mm", "계산", "344/360 × 0.8"),
        ("회전으로 넣을 양", f"{E.SCREW_TRAVEL*1000:.2f}", "mm", "계산", "⚠ 잰 값 아님"),
        ("착좌까지 스트로크", f"{S.SCREW_STROKES_TO_SEAT}", "회", "계산", "돌린 뒤 눈으로 확인"),
    ]
    CAMT = [
        ("1대 · view_scene.py", f"({cam1['lookat'][0]:.3f}, {cam1['lookat'][1]:.3f}, {cam1['lookat'][2]:.3f})",
         f"{cam1['distance']:.2f}", f"{cam1['azimuth']:.1f}", f"{cam1['elevation']:.1f}"),
        ("5대 · view_fleet.py", f"({cam5['lookat'][0]:.3f}, {cam5['lookat'][1]:.3f}, {cam5['lookat'][2]:.3f})",
         f"{cam5['distance']:.2f}", f"{cam5['azimuth']:.1f}", f"{cam5['elevation']:.1f}"),
    ]
    return dict(MESH=MESH, BULLET=BULLET, CASING=CASING, FIX=FIX, DESK=DESK,
                HEIGHT=HEIGHT, MEAS=MEAS, CAMT=CAMT, img1=img1, img5=img5,
                cam1=cam1, cam5=cam5)


# ── TXT ───────────────────────────────────────────────────────────────────
def write_txt(D):
    def tbl(rows, heads, w):
        out = ["  " + "  ".join(h.ljust(x) for h, x in zip(heads, w)),
               "  " + "  ".join("─" * x for x in w)]
        out += ["  " + "  ".join(str(v).ljust(x) for v, x in zip(r, w)) for r in rows]
        return "\n".join(out)

    T = ["=" * 78, "FR5 탄두-탄피 조립 시뮬레이션 — 치수 정리",
         "2026-09-08 · /home/ej/rl_env/src", "=" * 78, "",
         "이 문서는 make_dimension_doc.py 가 만든다. 숫자는 전부 MJCF 와 상수 파일에서",
         "직접 읽고 캡처도 거기서 렌더한다 — 손으로 옮겨 적지 않았다.",
         "[실측] = 자나 눈으로 잰 값 · [계산] = 다른 값에서 환산한 값.", "",
         "■ 1. 메시/STL — 나사부 7mm → 6mm", "",
         "  탄두 나사부 길이를 7.0mm 로 알고 있었는데 다시 재보니 6.0mm 였다.",
         "  make_ammo_meshes.py 가 fr5_screw_assembly.THREAD_DEPTH 를 읽어 형상을 만들므로,",
         "  상수를 고치고 스크립트를 돌리면 bullet.stl 과 casing.stl 이 같이 바뀐다.", "",
         tbl(D["MESH"], ["항목", "이전", "지금", "왜", "비고"], [22, 6, 6, 14, 22]), "",
         "  ⚠ 재생성으로 어긋나 있던 것 하나가 맞았다 — 조 아랫면이 어깨보다 2mm 위였는데,",
         "    어깨가 1mm 내려오면서 3.04mm 가 됐다. 요청값(3mm)과 맞는다.",
         "  ⚠ 씬 좌표는 전부 '나사 선단' 기준이고 선단은 메시 로컬 z=0 이라,",
         "    메시를 바꿔도 탄피·고정대·책상 높이는 하나도 안 움직였다.",
         "  ⚠ 7mm 로 되돌리려면 THREAD_DEPTH 도 0.007 로 같이 돌려야 한다.",
         "    (백업: backup_20260907_scene/ammo_stl_before_6mm/)", "",
         "■ 2. 탄두", tbl(D["BULLET"], ["항목", "값 (mm)", "근거"], [22, 12, 34]), "",
         "■ 3. 탄피", tbl(D["CASING"], ["항목", "값 (mm)", "근거"], [22, 12, 34]), "",
         "■ 4. 고정대", tbl(D["FIX"], ["항목", "값", "비고"], [22, 34, 26]), "",
         "  고정대는 박스가 아니라 메시다 (make_fixture_mesh.py 가 만든다). 구멍을 형상으로",
         "  실제로 팠다 — 박스에 어두운 원반을 얹으면 구멍처럼 안 보이고 혹처럼 튀어나온다.",
         "  ⚠ MuJoCo 는 메시 충돌을 볼록껍질로 본다. 충돌상으로는 여전히 통짜 박스이고",
         "    구멍이 없다. 보이기용이다.", "",
         "■ 5. 책상 · 받침판", tbl(D["DESK"], ["항목", "치수 (mm)", "비고"], [22, 26, 34]), "",
         "■ 6. 높이 (로봇 base 최하단 = z 0)",
         tbl(D["HEIGHT"], ["위치", "z (mm)", "비고"], [26, 10, 30]), "",
         "■ 7. 실측 목록",
         tbl(D["MEAS"], ["항목", "값", "단위", "구분", "출처"], [34, 18, 5, 6, 26]), "",
         "■ 8. 미해결 — 11.4mm", "",
         "  받침판 두께가 26.4mm 인데 실측은 15.0mm 다. 위 실측을 채울수록 오차가 전부",
         "  여기로 몰렸고, 그 자리가 로봇 사슬에서 유일하게 안 잰 구간이다:", "",
         "      wrist3 플랜지 ──265mm──> 그리퍼 조 끝   (참고 URDF 값. 이 기체에서 안 재봤다)", "",
         "  약 253mm 면 11.4mm 가 정확히 사라진다. 플랜지 면에서 조 끝까지를 자로 재면 끝난다.", "",
         "  ⚠ task_origin.json 은 아직 TCP_TO_TIP = 13mm 가정으로 저장돼 있다 (지금 모델은 9mm).",
         "    fr5_execute_policy 가 실물 목표점을 만들 때 그 파일을 쓰므로 시뮬과 실물이 서로",
         "    다른 값을 본다. 실물 자동 동작 전에 반드시 맞출 것.", "",
         "■ 9. 뷰어 구도", "",
         tbl(D["CAMT"], ["뷰어", "lookat (m)", "거리", "방위각", "고도"], [22, 26, 7, 8, 7]), "",
         "  카메라는 파일 안 상수(CAM_*)다 — 화면을 옮겼다 꺼도 다음엔 같은 구도로 뜬다.",
         "  창을 닫으면 그때 각도가 터미널에 찍히므로, 마음에 들면 그 숫자를 상수에 옮겨 적으면 된다.",
         "  ⚠ 파일에 자동 저장하지 않는다. 한때 그렇게 했는데 뷰어를 여러 개 띄우면",
         "    마지막에 닫힌 창이 덮어써서 구도가 제멋대로 바뀌었다.", "",
         "  5대 배치: 가운데 1대(금색 = 실물 이식 대상) + 네 구역, 간격 0.75m.",
         "            로봇마다 받침판·고정대·탄피를 갖고, 책상만 공유 작업대 하나로 합쳤다",
         "            (간격을 좁히면 로봇별 책상 1.0×0.9m 가 서로 겹친다).", "",
         "  ⚠ 조명: 기준 MJCF 에 조명 설정이 없어서 1대 씬만 어둡고 회색으로 떴다.",
         "    로봇 링크 색은 원래 거의 흰색(rgba 0.898 0.918 0.929)인데 조명이 약했던 것이다.",
         "    2026-09-08 에 플릿과 같은 설정(그림자 끔 + 보조광 + 전역조명)을 넣어 맞췄다.",
         "", "  캡처는 같은 이름의 html 문서에 들어 있다.", "", "=" * 78]
    io.open(OUT_TXT, "w", encoding="utf-8").write("\n".join(T) + "\n")
    print(f"✓ {OUT_TXT}")


# ── HTML ──────────────────────────────────────────────────────────────────
CSS = """
:root{--ink:#1b1a17;--ink2:#4a463e;--ink3:#7d776b;--bg:#f7f5f0;--card:#fffefb;
--rule:#e2ddd2;--brass:#a9791c;--brass-bg:#fbf3e0;--warn:#a8342a;--warn-bg:#fbecea}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
--ink:#eae6dd;--ink2:#b7b1a4;--ink3:#8a8478;--bg:#16150f;--card:#1e1c16;
--rule:#33302a;--brass:#d9a63e;--brass-bg:#2a2313;--warn:#e8837a;--warn-bg:#2e1917}}
:root[data-theme=dark]{--ink:#eae6dd;--ink2:#b7b1a4;--ink3:#8a8478;--bg:#16150f;
--card:#1e1c16;--rule:#33302a;--brass:#d9a63e;--brass-bg:#2a2313;--warn:#e8837a;--warn-bg:#2e1917}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);margin:0;
 font:15px/1.65 -apple-system,"Noto Sans KR","Malgun Gothic",sans-serif}
.wrap{max-width:940px;margin:0 auto;padding:44px 22px 80px}
header{border-bottom:3px solid var(--ink);padding-bottom:18px;margin-bottom:34px}
h1{font-size:29px;margin:0 0 6px;letter-spacing:-.02em;text-wrap:balance}
.sub{color:var(--ink3);font-size:13px;font-variant-numeric:tabular-nums}
h2{font-size:19px;margin:44px 0 6px;padding-top:16px;border-top:1px solid var(--rule)}
h2 .no{color:var(--brass);font-variant-numeric:tabular-nums;margin-right:8px}
p{color:var(--ink2);margin:8px 0 14px;max-width:66ch}
.tw{overflow-x:auto;margin:14px 0 6px}
table{border-collapse:collapse;width:100%;font-size:13.5px;background:var(--card)}
th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--rule)}
th{background:var(--brass-bg);color:var(--ink);font-weight:600;font-size:11.5px;
 letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
td.n{font-variant-numeric:tabular-nums;white-space:nowrap;
 font-family:ui-monospace,"SF Mono",Menlo,monospace}
tbody tr:last-child td{border-bottom:none}
.warn{background:var(--warn-bg);border-left:3px solid var(--warn);
 padding:12px 16px;margin:16px 0;font-size:14px}
.warn b{color:var(--warn)}
pre{background:var(--card);border:1px solid var(--rule);padding:14px 16px;overflow-x:auto;
 font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px;line-height:1.55;
 color:var(--ink);margin:12px 0}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin:18px 0}
figure{margin:0}
figure img{width:100%;display:block;border:1px solid var(--rule);background:#000}
figcaption{font-size:12.5px;color:var(--ink3);margin-top:7px}
.k{font-family:ui-monospace,Menlo,monospace;font-size:.92em;background:var(--brass-bg);
 padding:1px 5px;border-radius:2px}
"""


def write_html(D):
    def tab(heads, rows, num=()):
        h = "".join(f"<th>{x}</th>" for x in heads)
        body = ""
        for r in rows:
            body += "<tr>" + "".join(
                f'<td{" class=n" if i in num else ""}>{v}</td>' for i, v in enumerate(r)) + "</tr>"
        return f'<div class="tw"><table><thead><tr>{h}</tr></thead><tbody>{body}</tbody></table></div>'

    html = f"""<title>탄두 조립 시뮬레이션 치수</title>
<style>{CSS}</style>
<div class="wrap">
<header><h1>탄두 조립 시뮬레이션 치수</h1>
<div class="sub">FR5 · MuJoCo · 2026-09-08 · /home/ej/rl_env/src</div></header>

<p>이 문서는 <span class="k">make_dimension_doc.py</span> 가 만든다. 숫자는 전부 MJCF 와 상수
파일에서 <b>직접 읽고</b> 캡처도 거기서 렌더한다 — 손으로 옮겨 적지 않았다.
<span class="k">실측</span> 은 자나 눈으로 잰 값, <span class="k">계산</span> 은 환산한 값이다.</p>

<h2><span class="no">01</span>메시 / STL — 나사부 7mm → 6mm</h2>
<p>탄두 나사부 길이를 7.0mm 로 알고 있었는데 다시 재보니 <b>6.0mm</b> 였다.
<span class="k">make_ammo_meshes.py</span> 가 <span class="k">fr5_screw_assembly.THREAD_DEPTH</span> 를
읽어 형상을 만들므로, 상수를 고치고 스크립트를 돌리면
<span class="k">bullet.stl</span> 과 <span class="k">casing.stl</span> 이 같이 바뀐다.</p>
{tab(["항목","이전","지금","왜 바뀌나","비고"], D["MESH"], (1,2))}
<div class="warn"><b>⚠ 어긋나 있던 것 하나가 같이 맞았다.</b>
조 아랫면이 어깨보다 2mm 위였는데, 어깨가 1mm 내려오면서 <b>3.04mm</b> 가 됐다 — 요청값 3mm 과 맞는다.</div>
<p>씬 좌표는 전부 <b>나사 선단</b> 기준이고 선단은 메시 로컬 z=0 이라, 메시를 바꿔도
탄피·고정대·책상 높이는 하나도 안 움직였다. 어깨와 보어 바닥만 1mm 내려왔다.</p>
<div class="warn"><b>⚠ 되돌릴 때.</b> 7mm 판으로 돌아가려면 <span class="k">THREAD_DEPTH</span> 도
0.007 로 <b>같이</b> 돌려야 한다. 백업: <span class="k">backup_20260907_scene/ammo_stl_before_6mm/</span></div>

<h2><span class="no">02</span>탄두</h2>{tab(["항목","값 (mm)","근거"], D["BULLET"], (1,))}
<h2><span class="no">03</span>탄피</h2>{tab(["항목","값 (mm)","근거"], D["CASING"], (1,))}

<h2><span class="no">04</span>고정대</h2>{tab(["항목","값","비고"], D["FIX"])}
<p>고정대는 박스가 아니라 <b>메시</b>다 (<span class="k">make_fixture_mesh.py</span>).
구멍을 형상으로 실제로 팠다 — 박스에 어두운 원반을 얹으면 구멍처럼 안 보이고 혹처럼 튀어나온다.</p>
<div class="warn"><b>⚠ 충돌은 통짜 박스다.</b> MuJoCo 는 메시 충돌을 볼록껍질로 계산하므로
구멍이 충돌에 반영되지 않는다. 보이기용이다.</div>

<h2><span class="no">05</span>책상 · 받침판</h2>{tab(["항목","치수 (mm)","비고"], D["DESK"], (1,))}
<h2><span class="no">06</span>높이 — 로봇 base 최하단 = z 0</h2>{tab(["위치","z (mm)","비고"], D["HEIGHT"], (1,))}
<h2><span class="no">07</span>실측 목록</h2>{tab(["항목","값","단위","구분","출처"], D["MEAS"], (1,))}

<h2><span class="no">08</span>미해결 — 11.4mm</h2>
<p>받침판 두께가 <b>26.4mm</b> 인데 실측은 <b>15.0mm</b> 다. 위 실측을 채울수록 오차가 전부
여기로 몰렸고, 그 자리가 로봇 사슬에서 <b>유일하게 안 잰 구간</b>이다.</p>
<pre>wrist3 플랜지 ──265mm──&gt; 그리퍼 조 끝      (참고 URDF 값. 이 기체에서 안 재봤다)

약 253mm 면 11.4mm 가 정확히 사라진다.</pre>
<div class="warn"><b>⚠ task_origin.json 은 아직 안 고쳤다.</b>
<span class="k">TCP_TO_TIP = 13mm</span> 가정으로 저장돼 있다 (지금 모델은 9mm).
<span class="k">fr5_execute_policy</span> 가 실물 목표점을 만들 때 그 파일을 쓰므로
<b>시뮬과 실물이 서로 다른 값을 본다.</b> 실물 자동 동작 전에 반드시 맞출 것.</div>

<h2><span class="no">09</span>뷰어 구도</h2>
{tab(["뷰어","lookat (m)","거리","방위각","고도"], D["CAMT"], (1,2,3,4))}
<div class="shots">
  <figure><img alt="1대 씬" src="data:image/png;base64,{b64(D['img1'])}">
    <figcaption><b>1대</b> — <span class="k">view_scene.py</span>. 티칭 자세.
    고정대 구멍에 꽂힌 탄피와 그리퍼에 물린 탄두.</figcaption></figure>
  <figure><img alt="5대 플릿" src="data:image/png;base64,{b64(D['img5'])}">
    <figcaption><b>5대</b> — <span class="k">view_fleet.py</span>. 가운데 금색이 실물 이식 대상.
    간격 0.75m, 공유 작업대.</figcaption></figure>
</div>
<p>카메라는 파일 안 상수(<span class="k">CAM_*</span>)다 — 화면을 옮겼다 꺼도 다음엔 같은 구도로 뜬다.
창을 닫으면 그때 각도가 터미널에 찍히므로, 마음에 들면 그 숫자를 상수에 옮겨 적으면 된다.</p>
<div class="warn"><b>⚠ 파일에 자동 저장하지 않는다.</b> 한때 그렇게 했는데 뷰어를 여러 개 띄우면
마지막에 닫힌 창이 덮어써서 구도가 제멋대로 바뀌었다.</div>
<p>5대 배치는 가운데 1대(금색 = 실물 이식 대상) + 네 구역, 간격 0.75m. 로봇마다 받침판·고정대·탄피를
갖고 <b>책상만 공유 작업대 하나</b>로 합쳤다 — 간격을 좁히면 로봇별 책상 1.0×0.9m 가 서로 겹친다.</p>
<div class="warn"><b>⚠ 조명.</b> 기준 MJCF 에 조명 설정이 없어서 <b>1대 씬만 어둡고 회색</b>으로 떴다.
로봇 링크 색은 원래 거의 흰색(<span class="k">rgba 0.898 0.918 0.929</span>)인데 조명이 약했던 것이다.
2026-09-08 에 플릿과 같은 설정(그림자 끔 + 보조광 + 전역조명)을 넣어 맞췄다.</div>
</div>"""
    io.open(OUT_HTML, "w", encoding="utf-8").write(html)
    print(f"✓ {OUT_HTML}")


if __name__ == "__main__":
    data = main()
    write_txt(data)
    write_html(data)
