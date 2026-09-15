#!/usr/bin/env python3
"""받침을 작업대 위 격자로 옮겨 가며 **추종 목표가 게이트를 통과하나**를 지도로 낸다.

    python3 scripts/dev/follow-map.py                    # 로컬만 — 손끝·툴까지
    python3 scripts/dev/follow-map.py --host 192.168.30.18:5055   # 실기 IK 로 팔뚝까지
    python3 scripts/dev/follow-map.py --step 25 --from truth

## 무엇을 답하나

**「받침을 여기 놓으면 팔이 따라올 수 있나」** 하나다. 자리마다 총알을 세우고,
`follow.target_pose` 로 추종 목표를 만들고, `safety.check_workspace` 로 판정한다.

⛔ **판정을 여기서 만들지 않는다.** 목표는 `FR5/bridge/follow.py`, 판정은 `safety.py` —
둘 다 실기가 쓰는 그 함수를 그대로 부른다. 여기서 다시 짜면 지도가 초록인데 실기가
거부하는 날이 오고, 그때 어느 쪽이 참인지 못 가른다 (`SIM-CONTRACT` 불변식 4 와 같은 논리).

⛔ **로봇을 안 움직인다.** `--host` 를 줘도 `POST /ik` 만 부른다 — 그 창구는 조종권도
ARM 도 요구하지 않고 답만 준다 (`API-CONTRACT.md` §손끝 자리 → 관절각 · D131).

## 팔뚝은 관절각이 있어야 잰다

`--host` 없이 돌리면 **손끝과 툴까지만** 판정된다. 팔 링크 판정은 관절각을 요구하고
(`safety._check_arm_links`), 관절각은 컨트롤러가 푸는 것이라 로봇이 있어야 한다.
그 사실을 숨기지 않는다 — 안 잰 칸은 `팔뚝?` 로 나오고 요약이 개수를 센다.

## 안 잰 값 하나 — **상판이 기울어 있다**

받침이 앉는 면을 `config.yaml` 의 평평한 상자(`topZMm`)로 잡는다. 실물은 1.20° 기울어
그 자리에서 최대 5.18mm 다르다 (`props.js FIXTURE.tableZMm` 은 아직 `null`).
추종은 165mm 띄우므로 이 차이가 판정을 안 뒤집지만, **파지 높이를 이 지도에서 인용하지
않는다** (`GOAL-sim-grasp.md` §0 과 같은 금지).
"""
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5" / "bridge"))

import follow                                            # noqa: E402
import safety                                            # noqa: E402

import yaml                                              # noqa: E402

# 관절각이 없을 때 팔 판정이 내는 사유. **이것만** 「거부」가 아니라 「미측정」으로 가른다 —
# 다른 차단 사유를 같이 걸러내면 그건 지도가 아니라 게이트 우회다
ARM_UNKNOWN = "관절각을 못 구했다"


def props():
    """`Shared/data/props.js` 를 **정본 그대로** 읽는다 — 치수를 여기 옮겨 적지 않는다."""
    out = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import {FIXTURE, ROUND, GRASP_TRUTH} from './Shared/data/props.js';"
         "console.log(JSON.stringify({FIXTURE, ROUND, GRASP_TRUTH}))"],
        cwd=ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"props.js 를 못 읽었다 — {out.stderr.strip()[:200]}")
    return json.loads(out.stdout)


def profile(robot_id):
    doc = yaml.safe_load((ROOT / "FR5/bridge/config.yaml").read_text(encoding="utf-8"))
    for r in doc.get("robots") or []:
        if r.get("robotId") == robot_id:
            return r
    sys.exit(f"프로필 {robot_id} 가 config.yaml 에 없다")


def frozen_coords(robot_id):
    """좌표계 정의는 **로봇이 주는 값**이라 픽스처로 얼려 둔 것을 쓴다 (`Sim/fixtures/`)."""
    p = ROOT / "Sim/fixtures" / f"{robot_id}.json"
    if not p.exists():
        sys.exit(f"픽스처가 없다: {p} — 로봇을 붙이고 node scripts/dev/sim-fixture.mjs")
    d = json.loads(p.read_text(encoding="utf-8"))
    return d.get("coord"), d.get("coordDefs"), d.get("fetchedAt")


def fixture_box(cx, cy, top_z, half):
    """받침이 게이트에 들어가는 모양. **`fixture.box_from` 이 내는 것과 같은 칸**이다 —
    실기에서는 비전이 태그를 봐서 이 상자를 만든다 (D130). 여기서는 우리가 놓는 자리라
    태그 없이 같은 상자를 세운다."""
    return {"name": "받침", "xMm": [cx - half, cx + half], "yMm": [cy - half, cy + half],
            "topZMm": top_z, "marginMm": 10, "source": "vision"}


def ik(host, tcp, timeout=6.0):
    """컨트롤러에 관절각을 묻는다. `(joints|None, 사유|None)`. **로봇은 안 움직인다.**"""
    body = json.dumps({"tcpMmDeg": [float(v) for v in tcp]}).encode()
    req = urllib.request.Request(f"http://{host}/ik", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, f"IK 못 물음 — {str(e)[:60]}"
    if not d.get("reachable"):
        return None, d.get("reason") or "해가 없다"
    return d.get("jointsDeg"), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--robot", default="fr5-lab-a")
    ap.add_argument("--step", type=float, default=50.0, help="격자 간격 mm")
    ap.add_argument("--host", default=None, help="브리지 주소 — 주면 IK 로 팔뚝까지 판정")
    ap.add_argument("--from", dest="frm", choices=["above", "truth"], default="above",
                    help="추종 시작 자세 — above=목표 높이에 떠 있음(정상) · truth=실측 파지 자세")
    ap.add_argument("--out", default="Sim/fixtures/follow-map.json")
    a = ap.parse_args()

    pr = profile(a.robot)
    cfg, why = follow.read_config(pr)
    if cfg is None:
        sys.exit(f"follow 설정이 없거나 스스로 모순이다 — {why}")
    ws = pr.get("workspace") or {}
    # ⛔ **「첫 번째 작업대」를 집지 않는다** — 상판이 여럿이면(2026-08-18 · 800×500 셋)
    # 하나만 훑고 「전부 통과」라고 말하게 된다. 못 본 판이 거부되는지는 **안 나온다.**
    tables = [b for b in ws.get("boxes") or [] if "작업대" in (b.get("name") or "")]
    if not tables:
        sys.exit("프로필에 작업대 상자가 없다 — 받침을 놓을 자리를 모른다")
    coord, defs, fetched = frozen_coords(a.robot)

    P = props()
    fx, rnd, truth = P["FIXTURE"], P["ROUND"], P["GRASP_TRUTH"]
    half = fx["wMm"] / 2.0
    pose0 = truth["standing"]["tcpMmDeg"]                 # 자세(rx·ry·rz)의 출처

    # 판마다 격자를 따로 만든다 — **높이가 판마다 다를 수 있다.** 한 판의 `topZMm` 을
    # 전부에 쓰면 낮은 판에서 받침이 공중에 뜨고 그 칸의 판정이 통째로 거짓이 된다
    grids = []
    for t in tables:
        # 받침 **발자국이 상판 안에 다 들어가는** 중심 범위만 훑는다
        x0, x1 = t["xMm"][0] + half, t["xMm"][1] - half
        y0, y1 = t["yMm"][0] + half, t["yMm"][1] - half
        if x1 < x0 or y1 < y0:
            print(f"  ⚠ {t.get('name')} 은 받침 발자국 {fx['wMm']:.0f}mm 보다 좁다 — 건너뛴다")
            continue
        top_z = t["topZMm"] + fx["heightMm"]              # 받침 윗면
        grids.append({
            "table": t, "topZ": top_z,
            "objZ": top_z + rnd["lengthMm"],              # 총알 꼭대기 — 뎁스가 위에서 보는 면
            "xs": [x0 + i * a.step for i in range(int((x1 - x0) // a.step) + 1)],
            "ys": [y0 + i * a.step for i in range(int((y1 - y0) // a.step) + 1)],
        })
    if not grids:
        sys.exit("어느 상판도 받침 발자국보다 넓지 않다 — 놓을 자리가 없다")

    rows = []
    for g in grids:
        top_z, obj_z = g["topZ"], g["objZ"]
        for cy, cx in [(y, x) for y in g["ys"] for x in g["xs"]]:
            obj = [cx, cy, obj_z]
            # 추종 시작 자세 — `above` 는 정상 상태(이미 띄워져 따라가는 중)
            tcp_now = ([cx, cy, obj_z + cfg["standoffMm"]] + list(pose0[3:6])
                       if a.frm == "above" else list(pose0))
            target, why_t = follow.target_pose(obj, tcp_now, cfg)
            row = {"table": g["table"].get("name"),
                   "fixtureMm": [round(cx, 1), round(cy, 1)], "objectMm": [round(v, 1) for v in obj],
                   "targetMm": None, "jointsDeg": None, "reasons": [], "armUnknown": True}
            if target is None:
                row["reasons"] = [why_t]
                rows.append(row)
                continue
            row["targetMm"] = [round(v, 2) for v in target]

            joints = None
            if a.host:
                joints, why_ik = ik(a.host, target)
                if joints is None:
                    row["reasons"] = [f"관절해 없음 — {why_ik}"]
                    rows.append(row)
                    continue
                row["jointsDeg"] = [round(v, 3) for v in joints]

            ws_eff = dict(ws)
            ws_eff["boxes"] = list(ws.get("boxes") or []) + [fixture_box(cx, cy, top_z, half)]
            reasons = safety.check_workspace(target, ws_eff, coord, joints, defs)
            row["armUnknown"] = any(ARM_UNKNOWN in r for r in reasons)
            row["reasons"] = [r for r in reasons if ARM_UNKNOWN not in r]
            rows.append(row)

    # ── 지도 ─────────────────────────────────────────────────────────────────
    ok = sum(1 for r in rows if not r["reasons"])
    print(f"받침 자리 {len(rows)}칸  (상판 {len(grids)}판 · {a.step:.0f}mm 격자)")
    print(f"  시작 자세 {a.frm} · 좌표계 {coord} (픽스처 {fetched})")
    print(f"  IK {'실기 ' + a.host if a.host else '안 씀 — 팔뚝 미판정'}")

    # **판마다 따로 그린다** — 판이 떨어져 있으면 한 격자에 합쳐 그릴 수 없고,
    # 합쳐 그리면 판 사이의 빈 곳이 「거부된 칸」처럼 보인다
    for g in grids:
        name, xs, ys = g["table"].get("name"), g["xs"], g["ys"]
        by_xy = {tuple(r["fixtureMm"]): r for r in rows if r["table"] == name}
        n_ok = sum(1 for r in by_xy.values() if not r["reasons"])
        print(f"\n  ── {name} ({len(xs)}×{len(ys)} = {len(by_xy)}칸 · 통과 {n_ok})")
        print(f"     받침 윗면 z {g['topZ']:.1f} · 총알 꼭대기 z {g['objZ']:.1f}"
              f" · 목표 = 그 위 {cfg['standoffMm']:.0f}mm ({cfg['faceAxis']}축)")
        for cy in ys:
            line = []
            for cx in xs:
                r = by_xy[(round(cx, 1), round(cy, 1))]
                line.append("·" if not r["reasons"] and not r["armUnknown"]
                            else "?" if not r["reasons"] else "X")
            print(f"     y{cy:8.1f}  {''.join(line)}")
        print(f"     {'':9s}  x {xs[0]:.0f} → {xs[-1]:.0f}")
    print("\n  ·통과   ?손끝·툴은 통과(팔뚝 미판정)   X거부")

    seen = {}
    for r in rows:
        for why in r["reasons"]:
            key = why.split("—")[0].strip()
            seen[key] = seen.get(key, 0) + 1
    print(f"\n통과 {ok}/{len(rows)}")
    for key, n in sorted(seen.items(), key=lambda kv: -kv[1]):
        print(f"  {n:4d}칸  {key}")

    out = ROOT / a.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "_무엇": "받침 자리별 추종 목표와 게이트 판정 — scripts/dev/follow-map.py 산출물",
        "_아닌것": "실기 검증이 아니다. 게이트 판정일 뿐 부딪힘은 안 봤다 (그건 Sim 이 잰다)",
        "robotId": a.robot, "stepMm": a.step, "from": a.frm,
        "ikHost": a.host, "coord": coord, "fixtureFetchedAt": fetched,
        "follow": cfg, "fixtureTopZMm": top_z, "objectZMm": obj_z,
        "_상판": "config.yaml 의 평평한 상자다 — 실물은 1.20° 기울어 최대 5.18mm 다르다",
        "rows": rows,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\n{a.out}  ({len(rows)}칸)")


if __name__ == "__main__":
    main()
