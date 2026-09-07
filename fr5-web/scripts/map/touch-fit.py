#!/usr/bin/env python3
"""로봇이 **짚은 점**으로 `robot-base-in-tag.json` 을 푼다 — 카메라를 한쪽만 쓴다.

    python3 scripts/map/touch-fit.py --add 15    # 지금 손끝 + 그 태그의 카메라 자리를 한 쌍으로 담는다
    python3 scripts/map/touch-fit.py             # 담긴 쌍으로 풀고 잔차만 본다 (아무것도 안 쓴다)
    python3 scripts/map/touch-fit.py --apply     # yaw·x·y 를 파일에 쓴다
    python3 scripts/map/touch-fit.py --list      # 담긴 쌍 · --drop N 으로 한 개 뺀다

## 왜 또 만드나 — `edge-fit.py` 와 무엇이 다른가 (2026-09-04)

**푸는 값도 쓰는 파일도 같다.** 다른 것은 **어디서 정답을 얻나** 하나뿐이다.

    edge-fit   영상 속 상판 모서리 실루엣  →  화소 잔차 7.6px (≈ 수 mm, 렌즈·조명에 흔들린다)
    touch-fit  로봇이 직접 짚은 점         →  **반복정밀도 ±0.02mm**, 카메라가 안 낀다

⭐ 2026-09-04 에 태그 15 를 짚어 보니 카메라 예측과 **평면 45.6mm** 어긋났다. 같은 크기가
전날 손목캠↔글로벌캠에서도 나왔는데(45.9mm), 그때는 핸드아이를 범인으로 적었다.
**손끝은 참값이라 이번 45.6mm 는 글로벌캠 사슬만의 몫이다** — 용의자가 바뀌는 관측이다.

## 축척도 같이 재지만 **안 쓴다** (파일이 못 담는 값이다)

`lab_to_user1` 은 축척 칸이 없다. 그래서 3변수(yaw·x·y)로 푼 값만 `--apply` 한다.
4변수(+s)는 **진단으로만** 찍는다 — 이 파일의 `_축척` 절이 이미 *"태그 좌표계가 2.3%
부풀어 있다 · 정본은 `tag-layout.json` 의 `tagSizeMm`"* 이라고 적어 뒀고, s 가 1 에서
멀면 그쪽을 고쳐야 한다는 **네 번째 증인**이 된다.

## ⛔ 하지 않는 것

- **`zMm` 을 안 쓴다.** `edge-fit.py` 와 같은 세 값만 만진다 — 한 파일을 두 도구가
  서로 다른 칸까지 건드리면 어느 쪽이 마지막이었는지로 값이 갈린다. z 는 찍기만 한다.
- **가려진 태그를 모르는 척 안 한다.** 짚는 순간 손이 태그를 덮으면 앵커가 **옛 값에
  얼어붙는다**. 태그가 안 움직였으면 옛 값이 곧 맞는 값이지만, 그 사이 옮겼다면 틀린다.
  그래서 나이를 같이 담고 `STALE_S` 를 넘으면 **담을 때 경고**한다.

## 한계 (ponytail)

**평면 강체(yaw·x·y)까지다.** 카메라가 기울어 생기는 오차는 여기서 안 풀린다 —
잔차가 점마다 제각각이고 축척으로도 안 줄면 그때 `extrinsics.py` 가 먼저다.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "Shared/data/config/robot-base-in-tag.json"
sys.path.insert(0, str(ROOT / "FR5/bridge"))

STALE_S = 60.0      # 앵커가 이보다 낡으면 «가려졌을 수 있다» 고 알린다
MIN_SPAN_MM = 300.0  # 점들이 이보다 안 벌어지면 yaw 가 안 풀린다 (지렛대가 없다)
MOVED_MM = 8.0       # 손을 뗀 뒤 태그가 이만큼 움직였으면 **짚는 동안 끌린 것**이다


def _get(host, path):
    with urllib.request.urlopen(f"http://{host}{path}", timeout=6) as r:
        return json.loads(r.read().decode())


def pairs_path(explicit=None):
    if explicit:
        return Path(explicit)
    return ROOT / "docs/evidence" / date.today().isoformat() / "touch-pairs.json"


def load(p):
    return json.loads(p.read_text(encoding="utf-8"))["pairs"] if p.exists() else []


def save(p, pairs):
    p.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "_": "로봇이 짚은 점 ↔ 글로벌캠이 본 같은 점. `touch-fit.py` 가 담고 푼다",
        "_단위": "밀리미터. `labMm` 은 상판 태그 좌표계 · `user1Mm` 은 사용자 좌표계 1",
        "pairs": pairs,
    }
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)                       # 원자적 — 반쯤 쓴 파일을 다음 실행이 읽지 않게


def add(host, tag_id, pairs, note):
    """지금 손끝과 그 태그의 카메라 자리를 한 쌍으로 담는다."""
    st = _get(host, "/state")
    anc = _get(host, "/config/scene-anchors.json")["anchors"].get(str(tag_id))
    if not anc:
        return None, f"태그 {tag_id} 를 앵커가 모른다 — 추적 목록에 있는지 본다"
    tcp = st.get("tcpMmDeg")
    if not tcp:
        return None, "손끝 자세를 못 읽었다 — 로봇이 연결됐는지 본다"
    age = time.time() - float(anc.get("t") or 0)
    row = {
        "tag": int(tag_id),
        "labMm": [round(v, 2) for v in anc["labMm"]],
        "user1Mm": [round(v, 2) for v in tcp[:3]],
        "errPx": anc.get("errPx"),
        "anchorAgeS": round(age, 1),
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "note": note or "",
    }
    pairs.append(row)
    warn = None
    if age > STALE_S:
        warn = (f"⚠ 앵커가 {age:.0f}초 낡았다 — 짚는 손이 태그를 덮은 것으로 보인다. "
                f"태그를 **안 옮겼으면** 이 값이 맞다. 옮겼으면 이 쌍을 버린다(--drop)")
    return row, warn


def settle(host, pairs):
    """손을 뗀 뒤 그 태그가 **그대로 있나**. 2026-09-04 에 여기서 한 번 속았다.

    종이 태그를 핑거로 눌러 짚고 팔을 빼자 태그가 **y 로 53mm 끌려갔다.** 그런데 그 53mm 가
    내가 「사슬 오차 45.6mm」라고 부른 값과 **같은 축·같은 크기**였다 — 즉 **오차인지 끌린
    것인지 구분이 안 됐다.** 짚기가 참값인 이유는 로봇이 정확해서지 종이가 안 움직여서가
    아니다. **재료가 움직였으면 그 쌍은 참값이 아니다.**
    """
    if not pairs:
        return None, "담긴 쌍이 없다"
    last = pairs[-1]
    anc = _get(host, "/config/scene-anchors.json")["anchors"].get(str(last["tag"]))
    if not anc:
        return None, f"태그 {last['tag']} 를 앵커가 지금 못 본다 — 손을 다 뗐는지 본다"
    age = time.time() - float(anc.get("t") or 0)
    if age > STALE_S:
        return None, (f"앵커가 아직 {age:.0f}초 낡았다 — 태그가 여전히 가려져 있다. "
                      f"팔을 더 물리고 다시 부른다")
    d = np.array(anc["labMm"], float) - np.array(last["labMm"], float)
    moved = float(np.linalg.norm(d[:2]))
    last["settleMm"] = round(moved, 1)
    return (moved, d), None


def fit(pairs, user):
    """평면 강체 적합. `base_xy = Rot(-yaw)·(lab_xy − t)` 를 푼다 (Procrustes 닫힌 해)."""
    lab = np.array([p["labMm"][:2] for p in pairs], float)
    # user1 → base. `lab_to_user1` 이 마지막에 `user[:3]` 을 뺐으므로 되돌린다
    tgt = np.array([p["user1Mm"][:2] for p in pairs], float) + np.array(user[:2], float)
    lc, tc = lab.mean(0), tgt.mean(0)
    L, T = lab - lc, tgt - tc
    dot = float((L * T).sum())
    crs = float((L[:, 0] * T[:, 1] - L[:, 1] * T[:, 0]).sum())
    th = np.arctan2(crs, dot)                       # base = Rot(th)·lab + c
    R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    out = {}
    for name, s in (("rigid", 1.0), ("scaled", dot / float((L * L).sum() or 1) / 1.0)):
        if name == "scaled":
            s = float((R @ L.T).T.reshape(-1) @ T.reshape(-1) / ((L * L).sum() or 1))
        c = tc - s * (R @ lc)
        pred = (s * (R @ lab.T)).T + c
        res = np.linalg.norm(pred - tgt, axis=1)
        t_lab = -np.linalg.inv(s * R) @ c            # 파일이 담는 값: 베이스가 lab 어디인가
        out[name] = {
            "yawDeg": float(np.degrees(-th)), "xMm": float(t_lab[0]), "yMm": float(t_lab[1]),
            "scale": s, "res": res, "rms": float(np.sqrt((res ** 2).mean())),
        }
    span = float(np.linalg.norm(lab.max(0) - lab.min(0)))
    return out, span


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--add", type=int, metavar="TAG", help="지금 손끝을 그 태그의 쌍으로 담는다")
    ap.add_argument("--note", default="", help="그 점이 어디였는지 한 줄")
    ap.add_argument("--settle", action="store_true",
                    help="손을 뗀 뒤 부른다 — 마지막 쌍의 태그가 안 움직였나 확인한다")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--drop", type=int, metavar="N", help="N 번째 쌍을 뺀다 (--list 의 번호)")
    ap.add_argument("--apply", action="store_true", help="yaw·x·y 를 robot-base-in-tag.json 에 쓴다")
    ap.add_argument("--pairs", help="쌍 파일 경로 (기본: docs/evidence/<오늘>/touch-pairs.json)")
    ap.add_argument("--host", default=os.environ.get("FR5_HOST_IP", ""))
    a = ap.parse_args()

    host = a.host if ":" in a.host else f"{a.host}:5055"
    pp = pairs_path(a.pairs)
    pairs = load(pp)

    if a.drop is not None:
        if not 1 <= a.drop <= len(pairs):
            print(f"⛔ {a.drop} 번 쌍이 없다 (1~{len(pairs)})"); return 1
        gone = pairs.pop(a.drop - 1); save(pp, pairs)
        print(f"뺐다 — 태그 {gone['tag']} @ {gone['at']}")

    if a.add is not None:
        if not a.host:
            print("⛔ 호스트를 모른다 — `eval \"$(bash scripts/dev/host.sh)\"` 뒤에 부른다"); return 1
        row, warn = add(host, a.add, pairs, a.note)
        if row is None:
            print(f"⛔ {warn}"); return 1
        save(pp, pairs)
        print(f"담았다 #{len(pairs)} — 태그 {row['tag']}  손끝 {row['user1Mm']}  카메라 lab {row['labMm']}"
              f"  (앵커 {row['anchorAgeS']}초 · {row['errPx']}px)")
        if warn:
            print(warn)

    if a.settle:
        if not a.host:
            print("⛔ 호스트를 모른다"); return 1
        got, why = settle(host, pairs)
        if got is None:
            print(f"⛔ {why}"); return 1
        moved, d = got
        save(pp, pairs)
        if moved > MOVED_MM:
            pairs.pop(); save(pp, pairs)
            print(f"⛔ 태그가 {moved:.1f}mm 움직였다 (x{d[0]:+.1f} y{d[1]:+.1f}) — **짚는 동안 "
                  f"끌렸다.** 그 쌍을 버렸다. 태그를 고정하고 다시 짚는다")
            return 1
        print(f"✅ 태그가 그대로다 ({moved:.1f}mm · 상한 {MOVED_MM}mm) — 쌍 #{len(pairs)} 유효")

    if a.list or not pairs:
        for i, p in enumerate(pairs, 1):
            print(f"  {i}. 태그 {p['tag']:>2}  lab {p['labMm']}  user1 {p['user1Mm']}"
                  f"  {p['at']}  {p['note']}")
        if not pairs:
            print(f"쌍이 없다 — `--add <태그>` 로 담는다 ({pp})"); return 0
        if a.list:
            return 0

    if len(pairs) < 2:
        print(f"\n쌍이 {len(pairs)} 개다 — **평면을 풀려면 둘 이상**이다. 태그를 옮겨 다시 짚는다.")
        return 0

    if not a.host:
        print("⛔ 호스트를 모른다 — user1 정의를 로봇에서 읽어야 한다"); return 1
    user = _get(host, "/state")["coordDefs"]["user"]
    cur = json.loads(BASE.read_text(encoding="utf-8"))
    out, span = fit(pairs, user)

    # 지금 파일이 내는 잔차 — 새 값과 견줄 기준선
    import fixture
    old = np.array([np.linalg.norm(
        np.asarray(fixture.lab_to_user1(p["labMm"], cur, user), float)[:2]
        - np.array(p["user1Mm"][:2], float)) for p in pairs])

    print(f"\n쌍 {len(pairs)} 개 · 벌어짐 {span:.0f}mm"
          + ("" if span >= MIN_SPAN_MM else f"  ⚠ {MIN_SPAN_MM:.0f}mm 미만이라 yaw 가 헐겁다"))
    print(f"\n지금 파일     yaw {cur['yawDeg']:7.3f}  x {cur['xMm']:7.1f}  y {cur['yMm']:7.1f}"
          f"   → 잔차 RMS {np.sqrt((old**2).mean()):6.2f}mm  최대 {old.max():6.2f}")
    r, s = out["rigid"], out["scaled"]
    print(f"짚어서 푼 값   yaw {r['yawDeg']:7.3f}  x {r['xMm']:7.1f}  y {r['yMm']:7.1f}"
          f"   → 잔차 RMS {r['rms']:6.2f}mm  최대 {r['res'].max():6.2f}")
    print(f"(진단) 축척까지 yaw {s['yawDeg']:7.3f}  s {s['scale']:7.4f}"
          f"                → 잔차 RMS {s['rms']:6.2f}mm")
    if len(pairs) < 3:
        print("  ⚠ 쌍이 둘이면 3변수 적합의 잔차가 **거의 0 으로 나온다** — 검산이 아니다. 셋째를 짚는다.")

    if not a.apply:
        print("\n(아무것도 안 썼다. 쓰려면 `--apply`)")
        return 0

    cur.update({"yawDeg": round(r["yawDeg"], 3), "xMm": round(r["xMm"], 1), "yMm": round(r["yMm"], 1)})
    cur["measuredAt"] = date.today().isoformat()
    cur["source"] = str(pp.relative_to(ROOT))
    cur["_근거"] = (f"{date.today().isoformat()} — **로봇이 짚은 {len(pairs)} 점**에 맞췄다 "
                  f"(`scripts/map/touch-fit.py`). 카메라가 한쪽에만 낀다: 손끝은 반복정밀도 "
                  f"±0.02mm 의 참값이고 lab 쪽만 카메라가 낸다. 평면 잔차 RMS {r['rms']:.2f}mm "
                  f"(옛 값 {np.sqrt((old**2).mean()):.2f}mm) · 점 벌어짐 {span:.0f}mm. "
                  f"⛔ zMm 은 안 건드렸다 — `edge-fit.py` 와 같은 세 칸만 만진다.")
    BASE.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n✅ 썼다 — {BASE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
