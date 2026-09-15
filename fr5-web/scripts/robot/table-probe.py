#!/usr/bin/env python3
"""작업대 상판을 로봇으로 짚어 평면을 낸다 — 새 `topZMm` 과 기울기를 한 번에.

**왜 수평계가 아니라 로봇인가** — 게이트가 쓰는 것은 「진짜 수평」이 아니라 **로봇 좌표계에서의
상판 높이**다. 수평계는 중력 기준이라, 로봇이 얹힌 카트가 기울어 있으면 작업대를 아무리
수평으로 맞춰도 **로봇 눈에는 여전히 기울어 보인다.** 그래서 판정은 로봇이 직접 짚은 점으로만
선다. 수평계는 「어느 쪽이 기울었나」를 가르는 데는 쓸모가 있지만 게이트에 넣을 값은 못 낸다.

**왜 스크립트인가** — 2026-08-11 에 같은 측정을 즉석으로 하고 손계산했다. 그날 2.38° 를
찾아냈지만 `scripts/` 에 아무것도 안 남아서, 실기 담당자가 상판을 올리신 다음 날 처음부터 다시다.
`FR5/bridge/config.yaml` 주석이 이미 *"이 작업대는 바뀔 예정이다"* 라고 적어 뒀다 — 또 온다.

**손이 팔에 있으므로 키보드를 안 쓴다.** 드래그 티칭으로 한 점을 짚고 **가만히 두면** 그
자리가 저절로 잡힌다. 다음 점으로 옮기면 또 잡힌다. 끝내려면 Ctrl-C.

⛔ **이 스크립트는 `config.yaml` 을 안 고친다.** 값을 화면에 낼 뿐이고 넣는 것은 사람이 한다 —
2026-08-11 에 「통과시키려고 `topZMm` 을 고치면 제일 높은 자리에서 32.9mm 파고들어도 게이트가
조용해진다」를 겪었다. 게이트 값을 자동으로 쓰는 순간 그 사고가 사람 눈을 안 거치고 지나간다.

⚠ **TCP 가 핑거 끝이다** (D108). 그래서 핑거 끝으로 상판을 짚으면 `tcpMmDeg[2]` 가 곧 상판
높이다 — 오프셋 환산이 없다 (하드 룰 5). **핑거 옆면이 아니라 끝으로** 짚어야 맞는다.

사용:
    python3 scripts/robot/table-probe.py                  # 6점을 모아 평면을 낸다
    python3 scripts/robot/table-probe.py --points 8
    python3 scripts/robot/table-probe.py --box "카트 상판"
"""
import argparse
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / 'dev'))
from host import require as _require   # noqa: E402  (경로 주입 뒤에 온다)

import json
import math
import sys
import time
import urllib.request
from collections import deque

import numpy as np

# 호스트가 윈도우로 옮겨졌다 (2026-08-11 · D112). 옛 우분투는 240 이었다
# ⚠ **낡은 숫자다** — 호스트는 DHCP 라 바뀐다 (2026-08-31 에 `.18 → .6`).
# 주소는 `scripts/dev/host.sh` 가 **이름으로** 푼다 — 여기 숫자를 박지 않는다 (D164).
# ⛔ 옛 기본값 `192.168.30.18` 은 **이미 낡아 있었다**: 주석은 「믿지 마라」였는데
#    코드는 그 숫자를 그대로 썼다. 경고를 산문에 두지 말고 **코드에서 없앤다**.
# ⛔ **여기서 부르지 않는다** — 최상단에서 호스트를 요구하면 `--help` 도, 이 파일을
#    통째로 실행해 불러오는 `handeye-probe.py` 도 호스트 없이는 죽는다.
#    **쓸 때** 푼다 (`--url` 을 안 준 경우에만).
def default_url():
    return _require(5055, "/state")

POLL_S = 0.1        # `/state` 는 캐시를 돌려준다(백그라운드 샘플러 33ms) — xmlrpc 를 안 탄다
DWELL_S = 1.5       # 이만큼 가만히 있으면 「짚었다」로 본다
STILL_MM = 2.0      # 그 동안 이 안에 머물러야 한다. 드래그 티칭의 손 떨림·처짐을 덮는 값
MIN_SEP_MM = 40.0   # 앞 점과 이만큼 떨어져야 새 점이다 — 같은 자리를 두 번 세지 않는다
MIN_POINTS = 4      # 3점이면 잔차가 항상 0 이라 **틀려도 안 틀려 보인다**
# 연속 읽기 실패 상한. **없으면 관문이 죽었을 때 영원히 돈다** — 그동안 모은 점이 갇히고
# 화면은 같은 줄로 덮인다 (2026-08-12 가짜 브리지 시험에서 실제로 그랬다).
# `session.py` 의 `BAD_READS_LIMIT` 과 같은 생각이다: 못 읽으면 못 읽는다고 말하고 멈춘다
FAIL_LIMIT = 20     # × POLL_S = 2초
SPAN_MIN_MM = 60.0  # 짧은 축 퍼짐 하한 — 한 줄로 짚으면 평면이 그 축으로 안 정해진다


def fetch(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.load(r)


def frame_reasons(st, box_name):
    """숫자를 모으기 **전에** 막는다. 프레임이 다르면 잘 잰 점들이 전부 다른 좌표계 값이다."""
    out = []
    if not st.get("connected"):
        out.append("로봇 미연결 — 읽을 자세가 없다")
    ws = st.get("workspace") or {}
    frame, coord = ws.get("frame") or {}, st.get("coord") or {}
    now, want = (coord.get("toolId"), coord.get("userId")), (frame.get("toolId"), frame.get("userId"))
    if now != want:
        out.append(f"좌표계가 게이트와 다르다 — 지금 tool/user {now} · 게이트 {want}. "
                   "펜던트에서 맞춘 뒤 다시 돌린다")
    if not any(b.get("name") == box_name for b in ws.get("boxes") or []):
        have = [b.get("name") for b in ws.get("boxes") or []]
        out.append(f"「{box_name}」 상자가 없다 — 있는 것: {have}")
    return out


def collect(url, box_name, want_n):
    """가만히 있으면 잡는다. 반환은 로봇 좌표 mm 의 (x, y, z) 목록."""
    buf, pts, fails, last = deque(), [], 0, None
    print(f"드래그 티칭으로 「{box_name}」 윗면을 **핑거 끝**으로 짚으세요.\n"
          f"한 점에서 {DWELL_S}초 가만히 두면 잡힙니다 (앞 점과 {MIN_SEP_MM:.0f}mm 이상 떨어뜨리세요).\n"
          f"목표 {want_n}점 · 끝내려면 Ctrl-C\n", file=sys.stderr)
    while len(pts) < want_n:
        try:
            st = fetch(url)
        except KeyboardInterrupt:
            # **모은 것을 버리지 않는다** — 6점을 목표로 걸었어도 5점에서 그만두고 싶을 수 있다
            print(f"\n  중단 — {len(pts)}점으로 계산한다", file=sys.stderr)
            return pts, [], last, None
        except Exception as e:
            fails += 1
            print(f"  상태 읽기 실패 {fails}/{FAIL_LIMIT} — {e}", file=sys.stderr)
            if fails >= FAIL_LIMIT:
                msg = f"관문을 연속 {FAIL_LIMIT}회 못 읽었다 — {e}"
                # **손으로 짚은 점을 통신 끊김으로 버리지 않는다.** 이미 모은 점은 멀쩡하고,
                # 사람이 팔을 잡고 여섯 번 짚는 일은 다시 하기 비싸다. 상자 치수는 마지막으로
                # 읽은 상태에 있으므로 계산은 그대로 선다 — 대신 사유를 판정에 달아 보낸다
                if len(pts) >= MIN_POINTS and last is not None:
                    return pts, [], last, msg
                return pts, [msg], None, None
            time.sleep(POLL_S)
            continue
        fails, last = 0, st
        if reasons := frame_reasons(st, box_name):
            return pts, reasons, st, None
        now = time.time()
        buf.append((now, np.array(st["tcpMmDeg"][:3], float)))
        while buf and now - buf[0][0] > DWELL_S:
            buf.popleft()
        # 창이 다 차고 그 안에서 안 움직였을 때만 잡는다
        if buf[-1][0] - buf[0][0] >= DWELL_S * 0.9 and len(buf) >= 8:
            arr = np.array([p for _, p in buf])
            spread = float(np.linalg.norm(arr.max(0) - arr.min(0)))
            if spread <= STILL_MM:
                p = np.median(arr, axis=0)
                if all(np.linalg.norm(p - q) >= MIN_SEP_MM for q in pts):
                    pts.append(p)
                    drag = "" if (st.get("safety") or {}).get("inDragTeach") else "  ⚠ 드래그 티칭 꺼짐"
                    print(f"  {len(pts):2d}/{want_n}  ({p[0]:8.1f}, {p[1]:9.1f}, {p[2]:8.1f})"
                          f"  흔들림 {spread:.2f}mm{drag}", file=sys.stderr)
                    buf.clear()
        try:
            time.sleep(POLL_S)
        except KeyboardInterrupt:
            print(f"\n  중단 — {len(pts)}점으로 계산한다", file=sys.stderr)
            return pts, [], st, None
    return pts, [], st, None


def coef(pts):
    P = np.array(pts, float)
    A = np.c_[P[:, 0], P[:, 1], np.ones(len(P))]
    return np.linalg.lstsq(A, P[:, 2], rcond=None)[0]


def corner_top(cf, corners):
    a, b, c = cf
    return max(a * x + b * y + c for x, y in corners)


def leave_one_out(pts, corners):
    """점 하나를 빼면 답이 얼마나 움직이나 — **한 점에 매달린 답을 잡는다.**

    ⚠ **`3 × RMS` 로 이상점을 찾으려던 첫 판은 조용히 실패했다** (2026-08-12 가짜 브리지):
    +9mm 짜리 나쁜 점 하나가 답을 2.7mm 밀었는데, 그 점이 **RMS 를 스스로 부풀려**
    자기 문턱 밑에 숨었다(3.05 < 3×2.14). 잔차 통계로 잔차 이상점을 찾으면 이렇게 된다.
    그래서 통계가 아니라 **결과를 직접 흔들어 본다** — 우리가 걱정하는 것은 잔차가 아니라
    `topZMm` 이 한 사람의 손 하나에 매달렸는가이고, 이건 그걸 그대로 잰다.
    """
    base = corner_top(coef(pts), corners)
    return [corner_top(coef(pts[:i] + pts[i + 1:]), corners) - base for i in range(len(pts))]


def fit_plane(pts):
    """z = a·x + b·y + c. 평면은 z 에 대해 1차라 최소제곱 그대로다.

    ⚠ **한 줄로 짚으면 못 푼다** — 점들이 (x,y) 평면에서 직선에 가까우면 그 직각 방향
    기울기는 데이터가 안 정한다. `lstsq` 는 그래도 답을 내므로 **여기서 직접 막는다.**
    """
    P = np.array(pts, float)
    xy = P[:, :2] - P[:, :2].mean(0)
    # 짧은 축 퍼짐 = 공분산의 작은 고윳값의 제곱근 × 2 (≈ 그 방향 폭)
    ev = np.linalg.eigvalsh(np.cov(xy.T))
    minor = 2 * math.sqrt(max(ev.min(), 0.0))
    A = np.c_[P[:, 0], P[:, 1], np.ones(len(P))]
    cf = coef(pts)
    return tuple(cf), P[:, 2] - A @ cf, minor


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None, help="안 주면 host.sh 가 이름으로 푼다")
    ap.add_argument("--box", default="작업대")
    ap.add_argument("--points", type=int, default=6)
    args = ap.parse_args()
    if not args.url:
        args.url = default_url()

    pts, reasons, st, note = collect(args.url, args.box, args.points)
    if reasons:
        print(json.dumps({"verdict": " · ".join(reasons)}, ensure_ascii=False))
        return 1
    if len(pts) < MIN_POINTS:
        print(json.dumps({"verdict": f"{len(pts)}점 — {MIN_POINTS}점 미만이면 잔차가 없어 "
                                     "틀려도 안 틀려 보인다"}, ensure_ascii=False))
        return 1

    (a, b, c), res, minor = fit_plane(pts)
    if minor < SPAN_MIN_MM:
        print(json.dumps({"verdict": f"점들이 거의 한 줄이다 (짧은 축 퍼짐 {minor:.0f}mm < "
                                     f"{SPAN_MIN_MM:.0f}). 그 직각 방향 기울기를 데이터가 "
                                     "안 정한다 — 상판 네 귀 쪽으로 흩어 다시 짚는다"},
                         ensure_ascii=False))
        return 1

    tilt = math.degrees(math.atan(math.hypot(a, b)))
    rms = float(np.sqrt((res ** 2).mean()))
    worst = int(np.argmax(np.abs(res)))

    box = next(b_ for b_ in st["workspace"]["boxes"] if b_["name"] == args.box)
    xs, ys = box["xMm"], box["yMm"]
    corners = [(x, y) for x in xs for y in ys]
    zs = [a * x + b * y + c for x, y in corners]
    top, low = max(zs), min(zs)

    # 답이 한 점에 매달렸나 — 통계가 아니라 결과를 흔들어 본다 (§leave_one_out)
    loo = leave_one_out(pts, corners) if len(pts) >= MIN_POINTS + 1 else []
    loo_worst = int(np.argmax(np.abs(loo))) if loo else -1

    # 지금 게이트가 허용하는 가장 낮은 자리 — 이보다 상판이 높으면 **파고들어도 조용하다**
    old_top, old_margin = box["topZMm"], box.get("marginMm", 0)
    dig = top - (old_top + old_margin)

    P = np.array(pts)
    span = P.max(0) - P.min(0)
    # 짚은 점들의 바깥으로 얼마나 밀어서 귀 값을 냈나 — 외삽은 기울기 오차가 증폭되는 자리다
    extrap = max(max(0.0, min(P[:, 0]) - x, x - max(P[:, 0]))
                 + max(0.0, min(P[:, 1]) - y, y - max(P[:, 1])) for x, y in corners)

    out = {
        "box": args.box, "n": len(pts),
        "spanMm": [round(float(v), 1) for v in span[:2]],
        "tiltDeg": round(tilt, 2),
        "rmsMm": round(rms, 2), "maxResMm": round(float(abs(res[worst])), 2), "worstIdx": worst,
        "cornerTopZMm": round(top, 1), "cornerLowZMm": round(low, 1),
        "stepMm": round(top - low, 1),
        "suggest": {"topZMm": round(top, 1), "marginMm": max(10, int(math.ceil(3 * rms / 5) * 5))},
        "gateNow": {"topZMm": old_top, "marginMm": old_margin},
        "digIntoTopMm": round(dig, 1),
        "extrapMm": round(extrap, 0),
        "looMm": [round(float(v), 2) for v in loo],
    }

    say = [f"⚠ {note}"] if note else []
    if dig > 0:
        say.append(f"⛔ 지금 게이트는 제일 높은 자리에서 {dig:.1f}mm 파고듦을 허용한다 — 먼저 고친다")
    else:
        say.append(f"게이트가 상판 위 {-dig:.1f}mm 에서 막는다 — 파고듦 없음")
    if not loo:
        say.append(f"{len(pts)}점이라 한 점 빼기 검사를 못 했다 — 5점 이상 짚으면 답이 한 손에 "
                   "매달렸는지까지 잰다")
    elif abs(loo[loo_worst]) >= 1.0:
        say.append(f"#{loo_worst + 1} 점을 빼면 답이 {loo[loo_worst]:+.1f}mm 움직인다 — 그 점 하나가 "
                   "결론을 정하고 있다. 모서리를 짚었거나 핑거 옆면이 닿았는지 보고 다시 짚는다")
    if extrap > 100:
        say.append(f"귀 값이 짚은 범위 밖 {extrap:.0f}mm 로 외삽됐다 — 그만큼 기울기 오차가 커진다")
    out["verdict"] = " · ".join(say)

    print(json.dumps(out, ensure_ascii=False))
    print(f"""
평면   z = {a:+.5f}·x {b:+.5f}·y {c:+.2f}      기울기 {tilt:.2f}°
잔차   RMS {rms:.2f}mm · 최대 {abs(res[worst]):.2f}mm (#{worst + 1})
상자   {args.box}  x{xs}  y{ys}
       네 귀 최고 {top:.1f} · 최저 {low:.1f}  (기울기가 만드는 단차 {top - low:.1f}mm)

▶ FR5/bridge/config.yaml 의 「{args.box}」 에 넣을 값 — **사람이 넣는다**
       topZMm: {top:.1f}        # 네 귀 최고점. 낮게 잡으면 손끝이 파고든다
       marginMm: {out['suggest']['marginMm']}
  ⚠ 이 값이면 제일 낮은 자리에서 {top - low:.1f}mm 를 과보호한다 — 기울기가 치르는 값이다.
     반대로 가운데 값 + 큰 마진으로 덮으면 **제일 높은 자리가 뚫린다** (2026-08-11 실측).
""", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
