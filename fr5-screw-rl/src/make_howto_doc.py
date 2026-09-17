#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`실행방법.html` / `.txt` 를 만든다.

**숫자를 손으로 옮겨 적지 않는다.** 성공 기준 깊이·스트로크 회차·파지값·스냅샷 파일명
형식 같은 것은 전부 상수와 코드에서 읽는다. 그래서 치수나 설정을 고치고 이 스크립트만
다시 돌리면 문서가 맞는다.

    ../bin/python make_howto_doc.py

⚠ 소요 시간(학습 몇 초 등)은 코드에서 못 뽑는다. 아래 MEASURED 에 **잰 값**으로 적어
  두고, 재면 여기를 고친다.
"""

import glob
import io
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)

import fr5_site as S                       # noqa: E402
import fr5_screw_assembly as E             # noqa: E402

OUT_HTML, OUT_TXT = "실행방법.html", "실행방법.txt"
PY = "python3"          # 0번에서 venv 를 activate 하면 이게 가상환경을 가리킨다

# ⚠ 코드에서 못 뽑는 값 — 실제로 재서 적는다
#   아래 4개는 2026-09-08 18:01 에 ①~④ 를 문서에 적힌 명령 그대로 순서대로
#   돌려서 잰 벽시계 시간이다 (--steps 340 기준).
MEASURED = {
    "train_300k": "약 1분",             # 실측 54초
    # ⚠ 검증은 **실시간으로 돈다** — 340스텝 x CONTROL_DT 1.5초 = 510초가 하한이고,
    #   여기에 로스터 평가·모델 로드가 얹혀 실측 519초였다.
    #   OP_STROKE_PER_MIN 을 바꾸면 CONTROL_DT 가 바뀌므로 이 값도 다시 재야 한다.
    #   ⚠ 한때 "약 4분" 이라고 적혀 있었다. 실행 끝에 찍히는
    #     "중앙 로봇이 235.5초 만에 체결했습니다" 를 실행 시간으로 잘못 읽은 값이다.
    #     그건 시뮬 안에서 1회 체결에 걸린 시간이지, 스크립트가 도는 시간이 아니다.
    "verify": "약 8분 40초",            # 실측 519초
    "record": "약 3분 40초",            # 실측 220초 (렌더 소요. 만들어지는 영상은 510초짜리다)
    "summarize": "약 10초",             # 실측 9초
    "gohome": "약 8초",
    "screw_in_4": "약 9분",
}


def grep1(path, pattern, default="?"):
    """소스에서 한 줄 뽑아 쓴다 — 문서와 코드가 어긋나지 않게."""
    try:
        m = re.search(pattern, io.open(path, encoding="utf-8").read(), re.M)
        return m.group(1) if m else default
    except OSError:
        return default


def runs():
    return sorted(os.path.basename(os.path.dirname(p))
                  for p in glob.glob("train_runs/*/progress.csv"))


def snapshots():
    out = []
    for p in sorted(glob.glob("models_screw/**/*.zip", recursive=True)):
        out.append(os.path.relpath(p))
    return out


def collect():
    n_env = grep1("train_screw_ppo.py", r"^N_ENVS\s*=\s*(\d+)")
    snap_fmt = "candidate_<스텝>steps_<실행시각>.zip"
    stroke_mm = S.SCREW_MM_PER_STROKE
    seat_mm = E.SEAT_DEPTH * 1000

    # ── 표들 ──────────────────────────────────────────────────────────────
    STEPS = [
        ("① 학습", f"{PY} train_screw_ppo.py --steps 300000", MEASURED["train_300k"],
         f"30만 스텝 / {n_env}환경 병렬. 25,000 스텝마다 성공률·체결깊이가 찍힌다"),
        ("② 검증", f"{PY} verify_screw_policy.py --steps 340 --every 30", MEASURED["verify"],
         "MuJoCo 창이 뜬다. 화면이 있는 터미널에서 돌려야 한다"),
        ("③ 녹화", f"{PY} record_screw_video.py --models ./models_screw/ --steps 340",
         MEASURED["record"], "screw_wide / closeup / macro .mp4 세 개"),
        ("④ 종합표", f"{PY} summarize_run.py", MEASURED["summarize"],
         "학습 소요 + 평가 추이 + 영상이 어느 학습 결과인지 대조"),
    ]
    ENVV = [
        ("성공 기준 깊이", f"{seat_mm:.2f} mm",
         "SEAT_DEPTH = PLACED_DEPTH + SCREW_TRAVEL. 나사부 길이(6mm)가 아니다"),
        ("얹으면 들어가는 깊이", f"{E.PLACED_DEPTH*1000:.2f} mm", "PLACED_DEPTH [실측]"),
        ("회전으로 넣을 양", f"{E.SCREW_TRAVEL*1000:.2f} mm", "SCREW_TRAVEL [계산]"),
        ("착좌까지 회전", f"{E.SEAT_TURNS:.3f} 바퀴", "SCREW_TRAVEL / 피치 0.8"),
        ("탄두 나사부", f"{E.THREAD_DEPTH*1000:.1f} mm", "[실측] 7.0 에서 정정"),
        ("에피소드 상한", f"{E.MAX_STEPS} 스텝", "MAX_STEPS — 회전량이 절반이라 372 에서 줄었다"),
        ("손목 가동", f"±{np.degrees(E.WRIST_LIMIT):.0f}°", "실기 여유 3° 반영"),
    ]
    SITEV = [
        ("파지 / 열기", f"{S.GRIP_PCT}% / {S.OPEN_PCT}%", "[실측] 2026-08-10"),
        ("파지력", f"{S.GRIP_FORCE}", "[실측] 이 값에서 안 미끄러졌다"),
        ("스트로크 1회", f"{S.SCREW_SWEEP_DEG:.0f}° = {stroke_mm:.3f} mm", "-172° → +172°"),
        ("착좌까지 스트로크", f"{S.SCREW_STROKES_TO_SEAT} 회", "돌린 뒤 눈으로 확인"),
        ("j6 최대 속도", f"{S.J6_DEG_S_AT_FULL:.1f} °/s", "[실측] 2026-09-05"),
        ("정상 회전 속도", f"{S.QD_NORMAL_AT_VEL3:.1f} °/s @ vel 3%", "[실측] actual_qd_6"),
        ("로봇 IP", S.ROBOT_IP, "컨트롤러 0번 포트"),
    ]
    REAL = [
        ("원점 복귀", f"{PY} go_home.py --run", MEASURED["gohome"],
         "6축을 티칭 자세로. 한계·자기충돌 검사 후 이동"),
        ("조립 4 스트로크", f"{PY} fr5_screw_in.py --strokes 4 --start -172 --run",
         MEASURED["screw_in_4"], f"최대 조임 {4*stroke_mm:.2f} mm"),
        ("센서 확인 (안 움직임)", f"{PY} measure_j6_torque.py --seconds 5", "5초",
         "토크·속도 필드가 채워지는지"),
        ("충돌 감지 검증", f"{PY} verify_collision_stop.py --run", "약 10초",
         "⚠ 고정대에 볼트를 물려놓고 해야 한다"),
    ]
    GATES = [
        ("ZSIGN_VERIFIED", S.ZSIGN_VERIFIED, "툴축 부호 — 빈 그리퍼로 몇 mm 움직여 위아래 확인"),
        ("COLLISION_STOP_VERIFIED", S.COLLISION_STOP_VERIFIED,
         "충돌 감지가 실제로 멈추는지 — 볼트 물리고 verify_collision_stop.py"),
    ]
    return dict(STEPS=STEPS, ENVV=ENVV, SITEV=SITEV, REAL=REAL, GATES=GATES,
                runs=runs(), snaps=snapshots(), snap_fmt=snap_fmt,
                stroke_mm=stroke_mm, seat_mm=seat_mm)


# ── TXT ───────────────────────────────────────────────────────────────────
def write_txt(D):
    def tbl(rows, heads, w):
        out = ["  " + "  ".join(h.ljust(x) for h, x in zip(heads, w)),
               "  " + "  ".join("─" * x for x in w)]
        out += ["  " + "  ".join(str(v).ljust(x) for v, x in zip(r, w)) for r in rows]
        return "\n".join(out)

    T = ["═" * 78, " FR5 탄두-탄피 나사 체결 — 실행 방법",
         " 이 문서는 make_howto_doc.py 가 만든다. 숫자는 상수에서 직접 읽는다.", "═" * 78, "",
         "─" * 78, " 0. 준비 — 새 터미널 창을 열 때마다 한 번", "─" * 78, "",
         "    rl                       # .bashrc 별칭 = source ~/rl_env/bin/activate",
         "    cd /home/ej/rl_env/src", "",
         "  프롬프트가 (rl_env) 로 시작하면 켜진 것이다. 그때부터 python3 가 가상환경을 가리킨다.",
         "  아래 명령은 전부 이 상태를 전제로 한다.",
         "",
         "  ⚠ 스크립트나 크론처럼 셸을 안 거치는 데서는 활성화가 안 된다. 그럴 때는",
         "    python3 대신 ../bin/python 을 쓴다 — 어디서 돌리든 확실하다.", "",
         "  MUJOCO_GL 은 스크립트가 알아서 glfw 로 잡는다.",
         "  (OSMesa 는 PyTorch 와 충돌해 세그폴트가 난다)", "",
         "─" * 78, " 1. 시뮬레이션 — 순서대로", "─" * 78, ""]
    for name, cmd, t, note in D["STEPS"]:
        T += [f"  {name}{' ' * max(1, 58 - len(name) - len(t))}{t}",
              "  " + "─" * 74, f"    {cmd}", f"    {note}", ""]
    T += ["─" * 78, " 2. 지금 환경 값 (fr5_screw_assembly)", "─" * 78, "",
          tbl(D["ENVV"], ["항목", "값", "비고"], [22, 16, 40]), "",
          "─" * 78, " 3. 실기 값 (fr5_site)", "─" * 78, "",
          tbl(D["SITEV"], ["항목", "값", "비고"], [22, 22, 34]), "",
          "─" * 78, " 4. 실물 로봇", "─" * 78, ""]
    for name, cmd, t, note in D["REAL"]:
        T += [f"  {name}{' ' * max(1, 58 - len(name) - len(t))}{t}",
              "  " + "─" * 74, f"    {cmd}", f"    {note}", ""]
    T += ["  ■ 조립 전 점검 — 사람이 눈으로",
          "",
          "    탄두를 얹고 17% 로 문 뒤 **한 번 열어 탄두가 서 있는지 본다.**",
          "      서 있다   -> 나사가 걸렸다. 스트로크 돌려도 된다",
          "      빠진다    -> 안 걸렸다. 다시 얹는다",
          "    ⚠ 그리퍼가 물고 있는 동안은 물린 것처럼 보인다. 열어봐야 안다.",
          "      (2026-09-08 에 이걸 안 보고 4 스트로크를 헛돌렸다)",
          "",
          "  ■ 선행 조건 — 아래가 False 면 fr5_assemble_sdk.py 가 실행을 거부한다", ""]
    T += [tbl([(n, "True" if v else "False ⚠", d) for n, v, d in D["GATES"]],
              ["플래그", "지금", "확인 방법"], [26, 10, 42]), "",
          "─" * 78, " 5. 알아둘 것", "─" * 78, "",
          f"  ■ 스냅샷 파일명   {D['snap_fmt']}",
          "    실행 시각이 붙어 실행끼리 덮어쓰지 않는다. 실행 폴더에는 그 실행이",
          "    만든 것만 복사된다. (2026-09-08 이전에는 스텝 수뿐이라 서로 덮어썼다)", "",
          "  ■ 시드 분산이 크다",
          "    같은 설정 30만 스텝에서 최종 성공률 100% 와 0% 가 둘 다 나왔다.",
          "    한 번 잘 나온 것을 실력으로 보면 안 되고, 한 번 실패를 설정 탓으로",
          "    보아도 안 된다. 판단하려면 여러 시드로 돌려 분포를 봐야 한다.", "",
          "  ■ 학습 기록은 안 지워진다",
          f"    train_runs/ 아래 실행마다 폴더가 생긴다. 지금 {len(D['runs'])}개:",
          "      " + (", ".join(D["runs"]) if D["runs"] else "(없음)"), "",
          "    2026-09-08 이전 결과는 archive_train_20260908/ 로 옮겼다.",
          "    그 안의 7mm 시절 정책은 **지금 환경에서 평가하면 안 된다** —",
          "    성공 기준과 보상 스케일이 다르다.", "",
          f"  ■ 지금 models_screw 에 있는 것 ({len(D['snaps'])}개)"]
    T += ["      " + p for p in D["snaps"]] or ["      (없음)"]
    T += ["", "═" * 78]
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
header{border-bottom:3px solid var(--ink);padding-bottom:18px;margin-bottom:30px}
h1{font-size:29px;margin:0 0 6px;letter-spacing:-.02em;text-wrap:balance}
.sub{color:var(--ink3);font-size:13px}
h2{font-size:19px;margin:42px 0 6px;padding-top:16px;border-top:1px solid var(--rule)}
h2 .no{color:var(--brass);margin-right:8px;font-variant-numeric:tabular-nums}
p{color:var(--ink2);margin:8px 0 14px;max-width:66ch}
pre{background:var(--card);border:1px solid var(--rule);padding:12px 14px;overflow-x:auto;
 font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px;line-height:1.55;
 color:var(--ink);margin:10px 0}
.step{background:var(--card);border:1px solid var(--rule);margin:12px 0;padding:14px 16px}
.step h3{margin:0 0 4px;font-size:15px;display:flex;justify-content:space-between;gap:12px}
.step h3 .t{color:var(--brass);font-weight:500;font-size:13px;white-space:nowrap}
.step pre{margin:8px 0 6px}
.step .note{color:var(--ink3);font-size:13px;margin:0}
.tw{overflow-x:auto;margin:14px 0 6px}
table{border-collapse:collapse;width:100%;font-size:13.5px;background:var(--card)}
th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--rule)}
th{background:var(--brass-bg);font-size:11.5px;letter-spacing:.06em;
 text-transform:uppercase;white-space:nowrap}
td.n{font-variant-numeric:tabular-nums;white-space:nowrap;
 font-family:ui-monospace,Menlo,monospace}
tbody tr:last-child td{border-bottom:none}
.warn{background:var(--warn-bg);border-left:3px solid var(--warn);padding:12px 16px;
 margin:16px 0;font-size:14px}
.warn b{color:var(--warn)}
.k{font-family:ui-monospace,Menlo,monospace;font-size:.92em;background:var(--brass-bg);
 padding:1px 5px;border-radius:2px}
"""


def write_html(D):
    def tab(heads, rows, num=()):
        h = "".join(f"<th>{x}</th>" for x in heads)
        b = "".join("<tr>" + "".join(
            f'<td{" class=n" if i in num else ""}>{v}</td>'
            for i, v in enumerate(r)) + "</tr>" for r in rows)
        return f'<div class="tw"><table><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table></div>'

    def steps(items):
        out = ""
        for name, cmd, t, note in items:
            out += (f'<div class="step"><h3><span>{name}</span><span class="t">{t}</span></h3>'
                    f'<pre>{cmd}</pre><p class="note">{note}</p></div>')
        return out

    gates = tab(["플래그", "지금", "확인 방법"],
                [(f'<span class="k">{n}</span>',
                  "True" if v else "<b>False ⚠</b>", d) for n, v, d in D["GATES"]])
    runs = ", ".join(D["runs"]) or "(없음)"
    snaps = "\n".join(D["snaps"]) or "(없음)"

    html = f"""<title>FR5 조립 실행 방법</title>
<style>{CSS}</style>
<div class="wrap">
<header><h1>FR5 탄두-탄피 나사 체결 — 실행 방법</h1>
<div class="sub">이 문서는 <span class="k">make_howto_doc.py</span> 가 만든다 · 숫자는 상수에서 직접 읽는다</div></header>

<h2><span class="no">00</span>준비 — 새 터미널 창을 열 때마다 한 번</h2>
<pre>rl                       # .bashrc 별칭 = source ~/rl_env/bin/activate
cd /home/ej/rl_env/src</pre>
<p>프롬프트가 <span class="k">(rl_env)</span> 로 시작하면 켜진 것이다. 그때부터
<span class="k">python3</span> 가 가상환경을 가리킨다. 아래 명령은 전부 이 상태를 전제로 한다.</p>
<div class="warn"><b>⚠ 셸을 안 거치는 데서는</b> 활성화가 안 된다 (스크립트, 크론 등).
그럴 때는 <span class="k">python3</span> 대신 <span class="k">../bin/python</span> 을 쓴다 —
어디서 돌리든 확실하다.</div>
<p><span class="k">MUJOCO_GL</span> 은 스크립트가 알아서 glfw 로 잡는다 — OSMesa 는 PyTorch 와 충돌해 세그폴트가 난다.</p>

<h2><span class="no">01</span>시뮬레이션 — 순서대로</h2>
{steps(D["STEPS"])}

<h2><span class="no">02</span>지금 환경 값</h2>
<p><span class="k">fr5_screw_assembly.py</span> 에서 읽은 값이다.</p>
{tab(["항목","값","비고"], D["ENVV"], (1,))}

<h2><span class="no">03</span>실기 값</h2>
<p><span class="k">fr5_site.py</span> 에서 읽은 값이다.</p>
{tab(["항목","값","비고"], D["SITEV"], (1,))}

<h2><span class="no">04</span>실물 로봇</h2>
{steps(D["REAL"])}
<div class="warn"><b>⚠ 조립 전 점검 — 사람이 눈으로.</b>
탄두를 얹고 17% 로 문 뒤 <b>한 번 열어 탄두가 서 있는지 본다.</b>
서 있으면 나사가 걸린 것이고, 빠지면 안 걸린 것이다.
그리퍼가 물고 있는 동안은 물린 것처럼 보인다 — 열어봐야 안다.
(2026-09-08 에 이걸 안 보고 4 스트로크를 헛돌렸다)</div>
<p>선행 조건 — 아래가 False 면 <span class="k">fr5_assemble_sdk.py</span> 가 실물 실행을 거부한다.</p>
{gates}

<h2><span class="no">05</span>알아둘 것</h2>
<p><b>스냅샷 파일명</b> — <span class="k">{D['snap_fmt']}</span>.
실행 시각이 붙어 실행끼리 덮어쓰지 않고, 실행 폴더에는 그 실행이 만든 것만 복사된다.
2026-09-08 이전에는 스텝 수뿐이라 서로 덮어썼다.</p>
<div class="warn"><b>⚠ 시드 분산이 크다.</b> 같은 설정 30만 스텝에서 최종 성공률
<b>100% 와 0%</b> 가 둘 다 나왔다. 한 번 잘 나온 것을 실력으로 보면 안 되고, 한 번 실패를
설정 탓으로 보아도 안 된다. 판단하려면 여러 시드로 돌려 분포를 봐야 한다.</div>
<p><b>학습 기록은 안 지워진다</b> — <span class="k">train_runs/</span> 아래 실행마다 폴더가 생긴다.
지금 {len(D['runs'])}개: <span class="k">{runs}</span></p>
<p>2026-09-08 이전 결과는 <span class="k">archive_train_20260908/</span> 로 옮겼다.
⚠ 그 안의 7mm 시절 정책은 <b>지금 환경에서 평가하면 안 된다</b> — 성공 기준과 보상 스케일이 다르다.</p>
<p><b>지금 <span class="k">models_screw</span> 에 있는 것</b> ({len(D['snaps'])}개)</p>
<pre>{snaps}</pre>
</div>"""
    io.open(OUT_HTML, "w", encoding="utf-8").write(html)
    print(f"✓ {OUT_HTML}")


if __name__ == "__main__":
    data = collect()
    write_txt(data)
    write_html(data)
