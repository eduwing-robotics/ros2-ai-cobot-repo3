#!/usr/bin/env python3
"""hand-eye 킬실험 — 「캘리브레이션이 필요한가」를 30분에 가른다 (비전 사다리 6).

**hand-eye 는 `T[손목←카메라]` 한 칸이다.** 카메라는 「카메라 기준 어디」를 말하고 로봇은
자기 좌표로만 움직이므로, 이 칸이 비면 검출 결과로 **집으러 갈 목적지를 못 만든다.**

**정식 절차(AX=XB)를 안 돌린다.** 우리는 회전을 이미 실측으로 갖고 있다 —
틸트 0°(2026-08-07) · 롤 0°(2026-08-08) · 카메라 X축 = 툴 X축 (`arch/DEPTH-CAM.md`).
회전이 알려지면 남은 미지수는 **평행이동 셋뿐이고 식이 선형이 된다**:

    P = R·(C + t)  + p        (R,p = TCP 자세 · C = 카메라 좌표 · P = 참값)
    →  t = Rᵀ·(P − p) − C     ← **관측 한 번이 t 를 바로 준다**

그래서 자세를 두세 번만 바꿔 보면 **t 가 매번 같은 값으로 나오는지**로 회전 가정까지 같이
검증된다. 흩어지면 회전이 틀린 것이고 그때 비로소 정식 절차다. **자세 10~20개를 찍기 전에
안 찍어도 되는지부터 가른다** (사다리 규칙: 싸고 일정을 바꾸는 실험 먼저).

⚠ **문서의 82/9.5/80 은 「어느 축이 82냐」를 안 정해 준다** — 하우징의 렌즈 구멍까지 잰
값이고 깊이 좌표의 원점은 **왼쪽 적외선 이미저**다. 이 실험은 그 모호함을 **재서** 없앤다
(2026-08-12 에 "915" 로 같은 「어디서 어디까지」에 세 번째로 걸렸다).

사용 — **물체를 실험 내내 안 움직인다**:
    1) 핑거 끝을 물체 **꼭대기 중앙**에 대고
       python3 scripts/robot/handeye-probe.py --touch
    2) 팔을 들어 카메라가 물체를 보게 한 뒤 (자세를 바꿔 가며 2~3회)
       python3 scripts/robot/handeye-probe.py --look
    3) python3 scripts/robot/handeye-probe.py --solve
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.request
from importlib import util as _util
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))
sys.path.insert(0, str(ROOT / "scripts/dev"))
from host import require as _require   # noqa: E402  (경로 주입 뒤에 온다)
from safety import _rot_fixed_xyz          # noqa: E402  — 규약 정본 (D113 · 잔차 0.0048°)

# 깊이 덩어리 찾기는 `depth-probe.py` 가 이미 한다. 파일명에 `-` 가 있어 importlib 로 연다
_spec = _util.spec_from_file_location("dprobe", Path(__file__).with_name("depth-probe.py"))
dp = _util.module_from_spec(_spec)
_spec.loader.exec_module(dp)

# ⚠ **낡은 숫자다** — 호스트는 DHCP 라 바뀐다 (2026-08-31 에 `.18 → .6`).
# 주소는 `scripts/dev/host.sh` 가 **이름으로** 푼다 — 여기 숫자를 박지 않는다 (D164).
# ⛔ 옛 기본값 `192.168.30.18` 은 **이미 낡아 있었다**: 주석은 「믿지 마라」였는데
#    코드는 그 숫자를 그대로 썼다. 경고를 산문에 두지 말고 **코드에서 없앤다**.
# ⛔ **여기서 부르지 않는다** — 최상단이면 `--help` 도 호스트 없이는 죽는다. 쓸 때 푼다.
def state_url():
    return _require(5055, "/state")


def depth_url():
    return _require(5058, "/api/camera/depth/frame", "카메라 브리지")
OBS = Path(os.environ.get("TMPDIR", "/tmp")) / "fr5-handeye-obs.json"

# 문서가 말하는 값 — **판정 기준이 아니라 대조 대상**이다 (`arch/DEPTH-CAM.md` §장착 실측)
DOC_HORIZ_MM = math.hypot(82.0, 9.5)   # 82.5 — 어느 축인지는 문서가 안 정한다
DOC_Z_MM = -80.0                       # 렌즈가 핑거 끝보다 80mm 뒤(플랜지 쪽)
# 지름 10mm 를 무는 데 필요한 정밀도. 이 안이면 **캘리브레이션을 더 안 해도 된다**
SPREAD_OK_MM = 3.0
SPREAD_BAD_MM = 15.0                   # 넘으면 회전이 틀렸다 — 정식 AX=XB

# ⛔ **자세가 안 벌어지면 흩어짐 검사가 거짓으로 통과한다.** `t = Rᵀ(P−p) − C` 에서 R 이 거의
# 같으면 회전이 틀려도 t 가 똑같이 틀려서 **흩어짐이 0 으로 나온다.** 흩어짐은 「자세를 바꿨는데도
# 같은가」를 묻는 검사이므로 **바꾼 적이 없으면 물어본 적이 없는 것**이다 (2026-08-12 자기리뷰).
DIVERSITY_MIN_DEG = 20.0

# --watch — 시퀀스를 재생하며 **멈출 때마다 저절로** 한 장 잡는다. 손으로 부르면 자세가
# 눈대중이라 재현이 안 되는데, 가르친 시퀀스는 같은 자세를 몇 번이고 다시 준다
WATCH_POLL_S = 0.1
WATCH_DWELL_S = 1.2      # 이만큼 멈춰 있으면 「도착했다」
WATCH_STILL_MM = 2.0     # 그 동안 위치가 이 안
WATCH_STILL_DEG = 0.5    # 그 동안 자세가 이 안
WATCH_SEP_DEG = 8.0      # 앞서 잡은 자세와 이만큼은 달라야 새 관측이다
WATCH_SEP_MM = 40.0


def get(url, raw=False):
    with urllib.request.urlopen(url, timeout=8) as r:
        return r.read() if raw else json.load(r)


def robot_now():
    """TCP 자세 + 좌표계. **프레임이 다르면 숫자가 다른 자리를 가리킨다** (하드 룰 5)."""
    st = get(state_url())
    if not st.get("connected"):
        raise SystemExit(json.dumps({"verdict": "로봇 미연결"}, ensure_ascii=False))
    return st["tcpMmDeg"], st.get("coord") or {}, st


def cam_point():
    """깊이 한 장에서 물체 **꼭대기 중앙**의 카메라 좌표 (mm).

    광학 규약 — X 오른쪽 · Y 아래 · Z 앞. `Z = 깊이값`, `X = (u−cx)·Z/fx` 그대로다.
    """
    png = get(depth_url(), raw=True)
    z = np.asarray(dp.Image.open(dp.BytesIO(png))).astype(np.float32)
    h, w = z.shape
    valid = z > 0
    if valid.mean() < 0.20:
        return None, {"verdict": f"깊이가 거의 없다 ({100*valid.mean():.1f}%) — Min-Z 안쪽이거나 "
                                 "표면이 깊이를 안 준다"}
    plane, inliers, coef = dp.fit_plane(z, valid, want_coef=True)
    if plane is None:
        return None, {"verdict": "평면을 못 맞췄다"}
    resid = np.where(valid, plane - z, np.nan)
    rms = float(np.sqrt(np.nanmean(resid[inliers] ** 2)))
    thr = max(dp.RAISE_MM, dp.RAISE_SIGMA * rms)
    raised = valid & dp.plane_support(inliers) & (resid > thr)
    if raised.sum() < dp.MIN_AREA_PX:
        return None, {"verdict": "솟은 것이 없다 — 물체가 화면에 없거나 너무 멀다"}
    blob = dp.largest_blob(raised)
    top = dp.core(blob)                       # 가장자리 2px 침식 — flying pixel 을 뺀다
    if top.sum() < 10:
        top = blob
    peak = float(np.nanpercentile(resid[top], 95))
    snr = peak / rms if rms > 0 else float("inf")
    if snr < dp.SNR_MIN:
        return None, {"verdict": f"솟음/잡음 {snr:.1f} < {dp.SNR_MIN} — 가까이 가거나 근접 모드로"}

    # ⛔ **「꼭대기 면만 골라 쓰기」를 넣었다가 되돌렸다** (2026-08-12 · 흩어짐 41.3 → 72.9mm).
    # 생각은 맞았다(옆면이 섞여 중심이 밀린다) — 그런데 **잔차는 시선 방향으로 재므로 평평한
    # 윗면에서도 일정하지 않다.** 거리 330mm·한 변 95mm 면 시선각이 면을 가로질러 24°~40° 로
    # 변해 잔차가 94~112mm 로 **18mm 벌어진다.** 거기에 4mm 띠를 씌우니 면의 **한쪽 모서리**만
    # 남았고, 어느 모서리인지가 자세마다 달라 오히려 더 흔들렸다.
    # 제대로 하려면 화소마다 기울기를 보정한 뒤 띠를 씌워야 한다 — **낮고 납작한 표적이면
    # 이 문제 자체가 사라진다**(높이 10mm 면 시선각이 만드는 차이가 2mm 미만).
    ys, xs = np.nonzero(top)
    u, v = float(xs.mean()), float(ys.mean())
    zc = float(np.median(z[top]))             # 꼭대기 면의 깊이
    # 내부 파라미터는 848 폭 기준이라 다른 모드면 폭 비로 늘린다 (핀홀은 선형이다)
    s = w / 848.0
    fx, fy, cx, cy = dp.FX848 * s, dp.FY848 * s, dp.CX848 * s, dp.CY848 * s
    C = [(u - cx) * zc / fx, (v - cy) * zc / fy, zc]
    return C, {"uv": [round(u, 1), round(v, 1)], "zMm": round(zc, 1), "shape": [h, w],
               "areaPx": int(blob.sum()), "peakMm": round(peak, 2), "snr": round(snr, 1)}


def rot_angle(a, b):
    """두 자세 사이의 회전각(도) — `arccos((tr(AᵀB) − 1) / 2)`."""
    A, B = np.array(_rot_fixed_xyz(*a[3:]), float), np.array(_rot_fixed_xyz(*b[3:]), float)
    c = (np.trace(A.T @ B) - 1.0) / 2.0
    return float(math.degrees(math.acos(max(-1.0, min(1.0, c)))))


def watch(url, want_n, d):
    """시퀀스를 재생하는 동안 **멈출 때마다** 관측을 잡는다. 사람이 부를 필요가 없다."""
    from collections import deque
    buf, fails = deque(), 0
    print(f"시퀀스를 재생하세요. 자세마다 {WATCH_DWELL_S}초 이상 멈추면 저절로 잡습니다.\n"
          f"앞 자세와 {WATCH_SEP_DEG:.0f}° 또는 {WATCH_SEP_MM:.0f}mm 이상 달라야 새 관측입니다. "
          f"목표 {want_n} · Ctrl-C 로 중단\n", file=sys.stderr)
    while len(d["looks"]) < want_n:
        try:
            st = get(url)
        except KeyboardInterrupt:
            break
        except Exception as e:
            fails += 1
            print(f"  상태 읽기 실패 {fails}/20 — {e}", file=sys.stderr)
            if fails >= 20:
                break
            time.sleep(WATCH_POLL_S)
            continue
        fails = 0
        if (st.get("coord") or {}) != d["coord"]:
            print(json.dumps({"verdict": "좌표계가 --touch 때와 다르다"}, ensure_ascii=False))
            return d
        now, tcp = time.time(), st["tcpMmDeg"]
        buf.append((now, tcp))
        while buf and now - buf[0][0] > WATCH_DWELL_S:
            buf.popleft()
        if buf[-1][0] - buf[0][0] >= WATCH_DWELL_S * 0.9 and len(buf) >= 8:
            P = np.array([b[1][:3] for b in buf], float)
            still_mm = float(np.linalg.norm(P.max(0) - P.min(0)))
            still_deg = max(rot_angle(buf[0][1], b[1]) for b in buf)
            if still_mm <= WATCH_STILL_MM and still_deg <= WATCH_STILL_DEG:
                prev = [l["tcp"] for l in d["looks"]]
                if all(rot_angle(tcp, q) >= WATCH_SEP_DEG
                       or np.linalg.norm(np.array(tcp[:3]) - np.array(q[:3])) >= WATCH_SEP_MM
                       for q in prev):
                    C, info = cam_point()
                    if C is None:
                        print(f"  (멈췄지만 못 봤다 — {info['verdict'][:40]})", file=sys.stderr)
                    else:
                        tt = solve_t(d["truth"], tcp, C)
                        d["looks"].append({"tcp": tcp, "C": C, "t": tt.tolist(), "info": info})
                        save(d)
                        turn = f"{rot_angle(tcp, prev[-1]):.0f}°" if prev else "첫 자세"
                        print(f"  {len(d['looks'])}/{want_n}  t=({tt[0]:7.1f},{tt[1]:7.1f},"
                              f"{tt[2]:7.1f})  앞 자세와 {turn}", file=sys.stderr)
                    buf.clear()
        try:
            time.sleep(WATCH_POLL_S)
        except KeyboardInterrupt:
            break
    return d


def load():
    return json.loads(OBS.read_text(encoding="utf-8")) if OBS.exists() else {}


def save(d):
    OBS.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def solve_t(P, tcp, C):
    """t = Rᵀ·(P − p) − C — 카메라 원점이 **툴 좌표계**의 어디인가."""
    R = np.array(_rot_fixed_xyz(tcp[3], tcp[4], tcp[5]), float)
    p = np.array(tcp[:3], float)
    return R.T @ (np.array(P, float) - p) - np.array(C, float)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--touch", action="store_true", help="핑거 끝이 물체 꼭대기에 닿은 지금을 참값으로")
    g.add_argument("--look", action="store_true", help="지금 자세에서 카메라로 한 번 본다")
    g.add_argument("--watch", action="store_true",
                   help="시퀀스를 재생하는 동안 멈출 때마다 저절로 잡는다")
    g.add_argument("--solve", action="store_true", help="모은 관측으로 t 를 낸다")
    ap.add_argument("--points", type=int, default=6, help="--watch 가 모을 관측 수")
    g.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    if args.reset:
        OBS.unlink(missing_ok=True)
        print(json.dumps({"verdict": "지웠다"}, ensure_ascii=False))
        return 0

    d = load()

    if args.touch:
        tcp, coord, _ = robot_now()
        d = {"truth": tcp[:3], "coord": coord, "looks": []}
        save(d)
        print(json.dumps({"truth": [round(v, 1) for v in tcp[:3]], "coord": coord,
                          "verdict": "참값을 잡았다 — **이제 물체를 건드리지 않는다**. "
                                     "팔을 들어 카메라가 보게 한 뒤 --look"}, ensure_ascii=False))
        return 0

    if not d.get("truth"):
        print(json.dumps({"verdict": "참값이 없다 — 먼저 --touch"}, ensure_ascii=False))
        return 1

    if args.watch:
        d = watch(STATE_URL, args.points, d)
        print(json.dumps({"n": len(d["looks"]),
                          "verdict": f"{len(d['looks'])}개 모았다 — --solve"}, ensure_ascii=False))
        return 0

    if args.look:
        tcp, coord, _ = robot_now()
        if coord != d["coord"]:
            print(json.dumps({"verdict": f"좌표계가 --touch 때와 다르다 — 그때 {d['coord']} "
                                         f"지금 {coord}. 같은 자리를 다른 숫자로 부르게 된다"},
                             ensure_ascii=False))
            return 1
        C, info = cam_point()
        if C is None:
            print(json.dumps(info, ensure_ascii=False))
            return 1
        t = solve_t(d["truth"], tcp, C)
        d["looks"].append({"tcp": tcp, "C": C, "t": t.tolist(), "info": info})
        save(d)
        print(json.dumps({"n": len(d["looks"]), "camMm": [round(v, 1) for v in C],
                          "tMm": [round(v, 1) for v in t], **info,
                          "verdict": f"{len(d['looks'])}번째 관측. 자세를 바꿔 한 번 더 하거나 "
                                     "--solve"}, ensure_ascii=False))
        return 0

    # --solve
    looks = d["looks"]
    if len(looks) < 2:
        print(json.dumps({"n": len(looks),
                          "verdict": "관측이 1개다 — **흩어짐을 못 재면 회전 가정을 검증 못 한다.** "
                                     "자세를 바꿔 --look 을 한 번 더"}, ensure_ascii=False))
        return 1
    # ⛔ **자세를 안 바꿨으면 흩어짐은 아무것도 안 잰 것이다** — 위 §DIVERSITY_MIN_DEG
    poses = [l["tcp"] for l in looks]
    div = max(rot_angle(a, b) for a in poses for b in poses)
    T = np.array([l["t"] for l in looks], float)
    mean = T.mean(0)
    spread = float(max(np.linalg.norm(a - b) for a in T for b in T))

    # ⛔ **한 관측이 흩어짐을 끌면 「회전이 틀렸다」가 거짓이 된다** (2026-08-12 실측 — 5개 중
    # 하나가 41.3mm 를 만들었고, 그 하나를 빼면 10.6mm 였다). `table-probe.py` 에 같은 이유로
    # 넣은 「한 점 빼기」를 여기에도 둔다 — 잔차 통계가 아니라 **결과를 직접 흔들어** 본다.
    loo = []
    if len(T) >= 4:
        for i in range(len(T)):
            R = np.delete(T, i, axis=0)
            loo.append(float(max(np.linalg.norm(a - b) for a in R for b in R)))
    worst = int(np.argmin(loo)) if loo else -1
    horiz = float(math.hypot(mean[0], mean[1]))

    if div < DIVERSITY_MIN_DEG:
        print(json.dumps({
            "n": len(looks), "diversityDeg": round(div, 1),
            "tMeanMm": [round(v, 2) for v in mean], "spreadMm": round(spread, 2),
            "verdict": f"⛔ 자세가 {div:.0f}° 밖에 안 벌어졌다 (최소 {DIVERSITY_MIN_DEG:.0f}°) — "
                       f"흩어짐 {spread:.1f}mm 는 **아무것도 검증하지 않는다.** R 이 거의 같으면 "
                       f"회전이 틀려도 t 가 똑같이 틀려서 흩어짐이 0 으로 나온다. "
                       f"자세를 크게 틀어 관측을 더한다",
        }, ensure_ascii=False))
        return 1

    if spread <= SPREAD_OK_MM:
        say = (f"✅ 회전 가정(틸트0·롤0)이 섰다 — 자세를 바꿔도 t 가 {spread:.1f}mm 안에서 같다. "
               f"**정식 캘리브레이션 불필요.** 이 t 를 hand-eye 로 박고 calibId 를 적는다")
    elif spread <= SPREAD_BAD_MM:
        say = (f"⚠ 흩어짐 {spread:.1f}mm — 경계다. 관측을 늘리고, 그래도 남으면 회전이 조금 틀렸다. "
               f"물체를 건드렸는지·핑거 끝이 꼭대기 중앙이었는지부터 본다")
    else:
        say = (f"⛔ 흩어짐 {spread:.1f}mm — **회전 가정이 틀렸다.** 틸트0·롤0 이 실제와 다르다는 "
               f"뜻이고, 여기서부터는 자세 10~20개로 정식 AX=XB 다")

    if loo and loo[worst] < spread * 0.5 and spread > SPREAD_OK_MM:
        say = (f"⚠ **흩어짐 {spread:.1f}mm 를 #{worst + 1} 하나가 끌고 있다** — 그것만 빼면 "
               f"{loo[worst]:.1f}mm 다. 회전이 아니라 그 관측이 문제일 수 있으니 "
               f"먼저 그 자세에서 무엇을 봤는지 확인한다")
    dh, dz = horiz - DOC_HORIZ_MM, mean[2] - DOC_Z_MM
    say += (f" · 문서 대조: 수평 {horiz:.1f} vs {DOC_HORIZ_MM:.1f} ({dh:+.1f}) · "
            f"z {mean[2]:.1f} vs {DOC_Z_MM:.1f} ({dz:+.1f})")
    if max(abs(dh), abs(dz)) > 20:
        say += " ⚠ 문서와 20mm 넘게 벌어졌다 — 기준점이 하우징이냐 좌측 IR 이미저냐를 의심한다"

    print(json.dumps({
        "n": len(looks), "diversityDeg": round(div, 1), "tMeanMm": [round(v, 2) for v in mean], "spreadMm": round(spread, 2),
        "horizMm": round(horiz, 1), "perLook": [[round(v, 1) for v in t] for t in T],
        "docHorizMm": round(DOC_HORIZ_MM, 1), "docZMm": DOC_Z_MM,
        "looSpreadMm": [round(v, 1) for v in loo], "verdict": say,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
