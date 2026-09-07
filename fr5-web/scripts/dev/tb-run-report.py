#!/usr/bin/env python3
"""주행 기록 한 건을 사람이 읽는 표로 — 「왜 거기서 돌았나」를 숫자로 답한다.

    python3 scripts/dev/tb-run-report.py              # 가장 최근 run-path
    python3 scripts/dev/tb-run-report.py <run-id>
    TB_HOST=192.168.20.7 python3 scripts/dev/tb-run-report.py

2026-08-19 에 이 표가 카트 사고의 원인을 짚었다 — 직진은 600mm 에 0.4도인데
회전이 목표를 2.1도 넘겼고, 15도 안에 들자마자 전진해 **호를 그렸다**.
⚠ 샘플은 1Hz 다. 45도/s 회전은 한 틱에 45도가 지나가므로 회전의 모양까지는 안 보인다."""
import json, math, os, sys, urllib.request
B = f"http://{os.environ.get('TB_HOST', '192.168.30.15')}:5056"
get = lambda p: json.load(urllib.request.urlopen(B + p, timeout=8))
if len(sys.argv) > 1:
    r = get(f"/api/runs/{sys.argv[1]}")
else:
    runs = [x for x in get("/api/runs?limit=10") if x["scriptSlot"] == "run-path"]
    if not runs: raise SystemExit("run-path 기록 없음")
    r = runs[0]
pts = get(f"/api/runs/{r['id']}/path")
if not pts:
    raise SystemExit(f"샘플 0개 — 주행 중 브리지가 죽었을 수 있다 (result={r['result']})")
wps = get("/api/paths/" + r["params"]["path"])["points"]
print(f"■ 가장 최근 주행  {r['id']}")
print(f"  경로={r['params']['path']}  결과={r['result']}  travelMm={r.get('metrics',{}).get('travelMm')}  샘플 {len(pts)}개\n")

# 각 웨이포인트에 가장 가까이 간 순간 = 도착. 그때의 오차를 잰다
print("  점  목표좌표            가장 가까웠던 거리   그때 방향   목표방향   방향오차")
# ⚠ 「전체 최소」로 고르면 같은 점을 두 번 지나는 경로에서 엉뚱한 샘플을 집는다
# (2026-08-19: 왕복 경로에서 도착을 397mm 로 읽었다). **순서대로, 판정선 안에 처음 든 순간**을 도착으로 본다.
used = 0
for i, w in enumerate(wps, 1):
    arrive = w.get("arriveMm", 30)
    best, bi = None, None
    for j in range(used, len(pts)):
        d = math.hypot(w["xMm"]-pts[j]["xMm"], w["yMm"]-pts[j]["yMm"])
        if best is None or d < best: best, bi = d, j
        if d <= arrive:                      # 판정선 안에 들면 그 순간이 도착이다
            best, bi = d, j
            break
    if bi is None: break
    th = pts[bi]["thetaDeg"]; tgt = w["thetaDeg"]
    err = "—" if tgt is None else f"{((tgt-th+540)%360-180):+6.1f}도"
    print(f"  {i:2}. ({w['xMm']:7.0f},{w['yMm']:7.0f})   {best:7.0f}mm         {th:6.1f}도   "
          f"{'—' if tgt is None else f'{tgt:6.1f}도'}   {err}")
    used = bi

# 회전 구간의 오버슛 — 방향이 목표를 지나쳤다가 돌아오면 오버슛이다
print("\n  회전 구간 (Δ방향 8도 이상 · 이동 40mm 미만)")
prev = pts[0]; run_start = None; peak = 0
for p in pts[1:]:
    dth = (p["thetaDeg"]-prev["thetaDeg"]+540)%360-180
    dxy = math.hypot(p["xMm"]-prev["xMm"], p["yMm"]-prev["yMm"])
    if abs(dth) > 8 and dxy < 40:
        if run_start is None: run_start, peak = prev, 0
        peak += dth
    elif run_start is not None:
        print(f"    {run_start['tSec']:4.1f}s → {p['tSec']:4.1f}s   {run_start['thetaDeg']:6.1f}도 → {prev['thetaDeg']:6.1f}도  (총 {peak:+.1f}도)")
        run_start = None
    prev = p
