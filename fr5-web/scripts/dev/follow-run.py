#!/usr/bin/env python3
"""**기록된 주행을 팔이 따라간다면** 어떻게 움직일까 — 샘플마다 관절을 풀어 본다.

    python3 scripts/dev/follow-run.py --host 192.168.30.18:5055 \
        --run 2026-08-28-155910-tb3_2-run-path --tb 192.168.30.15:5056

## 무엇을 답하나

**「이 주행을 팔이 끝까지 따라갈 수 있었나」** 하나다. 실제로 남은 자취(1Hz)를 읽어
샘플마다 추종 목표를 만들고, 컨트롤러에게 관절을 묻고, 실기 게이트로 판정한다.

⛔ **목표도 판정도 여기서 만들지 않는다** — `FR5/bridge/follow.py` 의 `target_pose` 와
`safety.check_workspace` 를 그대로 부른다 (`follow-map.py` 와 같은 규약). 여기서 다시 짜면
시뮬은 초록인데 실기가 거부하는 날이 오고, 그때 어느 쪽이 참인지 못 가른다.

⛔ **로봇을 안 움직인다.** `POST /ik` 만 부른다 — 조종권도 ARM 도 요구하지 않는다.

## 하나 바꾼 것 — `faceAxis`

프로필의 `faceAxis` 는 `y`(옆에서)다. 세운 총알을 집으려고 그렇게 정했다(D122 · 08-27).
**터틀봇은 위에서 내려다본다**가 목적이라 `z` 로 바꿔 푼다 — 시뮬 인자이지 실기 설정이 아니다.
"""
import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))
import follow   # noqa: E402
import safety   # noqa: E402

ARM_UNKNOWN = "팔뚝"
AMR_TOP_MM = 192.0          # 버거 높이 — `catalog.js AMR_MM` (실측 · evidence 2026-08-07)
HOME = (833.1, -948.2, -324.0, 180.0)   # user1 · `workcell.js AMR_HOME` (2026-09-04 판이 +56.9mm 올랐다)


def get(url, timeout=8.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


def ik(host, tcp, timeout=6.0):
    body = json.dumps({"tcpMmDeg": [float(v) for v in tcp]}).encode()
    req = urllib.request.Request(f"http://{host}/ik", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
    except Exception as e:                                    # noqa: BLE001
        return None, f"IK 못 물음 — {str(e)[:50]}"
    return (d.get("jointsDeg"), None) if d.get("reachable") else (None, d.get("reason") or "해 없음")


def odom_to_user1(x, y):
    """odom → user1. **회전 180° 를 빼먹으면 전진이 반대로 간다** (`FRAMES.md` §odom).
    정본은 `Shared/data/frames.js` — 여기는 파이썬이라 같은 식을 옮겨 적었다."""
    d = math.radians(HOME[3])
    return HOME[0] + x * math.cos(d) - y * math.sin(d), HOME[1] + x * math.sin(d) + y * math.cos(d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True, help="FR5 브리지")
    ap.add_argument("--tb", required=True, help="터틀봇 브리지")
    ap.add_argument("--run", required=True)
    ap.add_argument("--out", default=None, help="관절 시계열을 여기에 (JSON)")
    ap.add_argument("--start", default=None,
                    help="시작 손끝 자세 user1 'x,y,z,rx,ry,rz' — 없으면 지금 실기 자세")
    a = ap.parse_args()

    st = get(f"http://{a.host}/state")
    ws, coord, defs = st.get("workspace"), st.get("coord"), st.get("coordDefs")
    cfg, why = follow.read_config({"follow": (st.get("follow") or {})} if st.get("follow") else
                                  {"follow": _cfg_from_repo()})
    if cfg is None:
        sys.exit(f"추종 설정을 못 읽었다 — {why}")
    cfg = dict(cfg)
    cfg["faceAxis"] = "z"                      # 위에서 내려다본다 (머리말 §faceAxis)

    trail = get(f"http://{a.tb}/api/runs/{a.run}/path")
    if not trail:
        sys.exit("자취가 없다")

    # **시작 자세가 판정을 가른다** — `follow.target_pose` 는 지금 자세가 수직에서 얼마나
    # 기울었나부터 본다(`maxTiltDeg`). 사람이 팔을 어디에 세워 두느냐가 추종의 전제다.
    tcp_now = ([float(v) for v in a.start.split(",")] if a.start
               else list(st.get("tcpMmDeg") or []))
    if len(tcp_now) < 6:
        sys.exit("시작 손끝 자세를 못 읽었다")
    print(f"시작 자세 {'(지정)' if a.start else '(지금 실기)'} "
          f"({tcp_now[0]:.0f},{tcp_now[1]:.0f},{tcp_now[2]:.0f}) "
          f"rx {tcp_now[3]:.1f} ry {tcp_now[4]:.1f} rz {tcp_now[5]:.1f}")

    rows, ok, blocked, noik = [], 0, 0, 0
    for s in trail:
        ux, uy = odom_to_user1(s["xMm"], s["yMm"])
        obj = [ux, uy, HOME[2] + AMR_TOP_MM]           # 터틀봇 **윗면**을 겨눈다
        target, why_t = follow.target_pose(obj, tcp_now, cfg)
        row = {"tSec": s["tSec"], "objMm": [round(v, 1) for v in obj], "reasons": []}
        if target is None:
            row["reasons"] = [why_t]; blocked += 1; rows.append(row); continue
        joints, why_ik = ik(a.host, target)
        if joints is None:
            row["reasons"] = [f"관절해 없음 — {why_ik}"]; noik += 1; rows.append(row); continue
        reasons = [r for r in safety.check_workspace(target, ws, coord, joints, defs)
                   if ARM_UNKNOWN not in r]
        row.update(targetMm=[round(v, 2) for v in target],
                   jointsDeg=[round(v, 3) for v in joints], reasons=reasons)
        if reasons:
            blocked += 1
        else:
            ok += 1
            tcp_now = target                            # 다음 샘플은 여기서 이어 간다
        rows.append(row)

    print(f"샘플 {len(rows)}개 — 따라감 {ok} · 게이트 거부 {blocked} · 관절해 없음 {noik}")
    bad = [r for r in rows if r["reasons"]]
    for r in bad[:6]:
        print(f"  t={r['tSec']:>4}s  {r['reasons'][0][:70]}")
    if len(bad) > 6:
        print(f"  … 외 {len(bad) - 6}개")
    if a.out:
        Path(a.out).write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        print(f"저장 {a.out}")


def _cfg_from_repo():
    """브리지가 `follow` 를 상태로 안 내주므로 프로필에서 읽는다 (읽기 전용)."""
    import yaml                                            # noqa: PLC0415
    p = ROOT / "FR5/bridge/config.yaml"
    d = yaml.safe_load(p.read_text(encoding="utf-8"))
    for prof in (d.get("robots") or []):
        if prof.get("follow"):
            return prof["follow"]
    raise SystemExit("config.yaml 에 follow 가 없다")


if __name__ == "__main__":
    main()
