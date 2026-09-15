#!/usr/bin/env python3
"""받침(거치대) 태그를 글로벌캠으로 풀어 **자리를 파일로 낸다** (2026-08-13).

**왜 만드나** — 받침은 **자주 옮겨진다**(실기 담당자 2026-08-13). 작업대처럼 `config.yaml` 에
박아 두면 옮길 때마다 사람이 고쳐야 하고, 안 고치면 게이트가 **빈 자리를 막고 진짜 받침을
안 막는다.** 둘째가 위험하다.

작업대와 갈리는 지점 하나 — **받침에는 태그가 붙어 있다**(`tags.json` `fixtureTags` id6).
그래서 자기 자리를 스스로 말할 수 있다. 작업대는 고정물이라 로봇이 짚는 게 맞고, 받침은
움직이는 물건이라 이쪽이 맞다.

## ⛔ 안 보일 때 지우지 않는다 — 이게 설계의 전부다

사람이 태그를 가리는 일이 잦다 (2026-08-13 실측: 하루에 태그가 4→3→1장까지 떨어졌다).
그때 상자를 **지우면 막던 것이 안 막힌다** — 제한을 **푸는** 방향이고 fail-danger 다.
그래서 못 보면 **마지막 값을 그대로 두고 `staleReason` 만 붙인다.** 게이트는 계속 막고,
화면은 「가정값」 색으로 그린다 (`zone-theme.js` §stale).

즉 이것은 「추적」이 아니라 **「볼 수 있을 때 갱신하고, 못 보면 계속 막는다」** 이다.

## 프레임

산출은 **user1** 이다 — `config.yaml` 의 `workspace.boxes` 와 **같은 프레임**이라야 쓰는 쪽이
헷갈리지 않는다. 사슬: `카메라 → 태그6 → 기준태그(lab) → 로봇 베이스 → user1`.
앞의 둘은 여기서, 셋째는 `robot-base-in-tag.json`, 넷째는 브리지 `/state.coordDefs.user`.
정확도 근거 — `docs/evidence/2026-08-12/fixture-tag-chain.md` (카메라 vs 핑거 **23.0mm**).

    python3 scripts/map/fixture-pose.py --host 192.168.30.8:8080 --bridge 192.168.30.18:5055
    python3 scripts/map/fixture-pose.py --host … --watch      # 상주 (1Hz)
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

# ⛔ **솔브 로직의 정본은 브리지다** (2026-08-13). 추적은 브리지 프로세스 안에서 상주하고
# (`FR5/bridge/fixture.py` §추적), 이 CLI 는 **사람이 손으로 한 번 재볼 때** 쓰는 얇은 껍데기다.
# 사본을 두면 CLI 로 잰 값과 브리지가 잰 값이 갈리고, 그때 어느 쪽이 진짜인지 못 가른다.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "FR5" / "bridge"))
from fixture import (  # noqa: E402
    HALF_MM, HEIGHT_MM, JUMP_MM, JUMP_ACCEPT_AFTER, cam_to_user1, solve_tag,
)

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "Shared/assets/tag/tags.json"
CONF = ROOT / "Shared/data/config/global-cam.json"
BASE = ROOT / "Shared/data/config/robot-base-in-tag.json"
OUT = ROOT / "Shared/data/config/fixture-pose.json"

PERIOD_S = 1.0
TIMEOUT_S = 4.0
# **크게 잡는다.** 95mm 지그가 어느 방향으로 놓여도 들어가고, 사슬 오차 23mm 도 삼킨다.
# 넓게 막는 쪽 오차라 안전 방향이다 — 좁게 잡으면 실제 받침이 상자 밖으로 나간다.
# 받침 윗면 높이. ⚠ **태그가 말해 주지 않는다** — 태그는 옆면에 세워 붙어 있다.
# 실측값(`fixture-pushes-object-into-minz.md`)이고, **받침을 바꾸면 이 값을 다시 잰다.**
# 자세가 이보다 튀면 **한 프레임 잘못 푼 것**으로 본다 (자동 재캘리브 §가드 ③ 과 같은 정신).
# 받침은 사람이 손으로 옮기므로 1초에 이보다 멀리 가지 않는다.
# ⛔ **거부가 영원해지면 안 된다** (2026-08-13 실측 사고). 점프 가드가 한 번 걸리면
# `prev` 가 옛 자리에 남아 **다음 프레임도 같은 거리라 또 거부**되고, 그렇게 추적이 죽는다.
# 실제로 받침을 215mm 옮기자 그 자리에서 139초 동안 얼어붙었다.
# 그래서 **같은 거부가 이만큼 이어지면 「진짜 옮긴 것」으로 받는다** — 한 프레임 튄 것은
# 이어지지 않고, 사람이 옮긴 것은 이어진다. 그것이 둘을 가르는 유일한 신호다.


def http_json(url):
    with urllib.request.urlopen(url, timeout=TIMEOUT_S) as r:
        return json.loads(r.read())


def write(doc):
    """원자적으로 쓴다 — 읽는 쪽이 반쪽 JSON 을 「못 읽음」으로 처리하면 거짓 경고다."""
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, OUT)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True, help="폰 주소 (예: 192.168.30.8:8080)")
    ap.add_argument("--bridge", required=True, help="브리지 주소 (user1 정의를 받는다)")
    ap.add_argument("--watch", action="store_true", help="상주해서 1Hz 로 갱신한다")
    a = ap.parse_args()

    for p in (SPEC, CONF, BASE):
        if not p.exists():
            print(f"없다 — {p.relative_to(ROOT)}", file=sys.stderr)
            return 1
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    cal = json.loads(CONF.read_text(encoding="utf-8"))
    base = json.loads(BASE.read_text(encoding="utf-8"))
    I, E = cal["intrinsics"], cal["labToCam"]
    K = np.array([[I["fx"], 0, I["cx"]], [0, I["fy"], I["cy"]], [0, 0, 1]])
    dist = np.array(I["dist"])

    try:
        user = (http_json(f"http://{a.bridge}/state").get("coordDefs") or {}).get("user")
    except Exception as e:                                  # noqa: BLE001
        print(f"브리지에서 user1 정의를 못 받았다 — {e}", file=sys.stderr)
        return 1
    if not user:
        # **없으면 안 쓴다** — user1 을 모르면 프레임이 틀린 값을 내게 된다 (제1원칙)
        print("user1 좌표계가 없다 (로봇 미연결?) — 쓰지 않고 멈춘다", file=sys.stderr)
        return 1

    # 마지막 값을 이어받는다 — **못 보면 유지가 이 파일의 존재 이유**다
    prev = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else None
    jump_streak = 0
    print(f"{a.host} 받침 추적 · 기준 {E.get('shot')} → {OUT.relative_to(ROOT)}")

    while True:
        p_cam, why = solve_tag(a.host, spec, I, K, dist)
        now = time.time()
        if p_cam is None:
            # ⛔ **지우지 않는다.** 마지막 자리를 그대로 두고 「못 봤다」만 갱신한다
            if prev:
                prev = {**prev, "seenAt": prev.get("seenAt"), "checkedAt": now,
                        "staleReason": f"태그를 못 본다 — {why}"}
                write(prev)
            print(f"  {time.strftime('%H:%M:%S')}  못 봤다 — {why}"
                  + ("  (마지막 자리 유지)" if prev else "  (아직 한 번도 못 봤다)"))
        else:
            u = cam_to_user1(p_cam, E, base, user)
            jump = None
            if prev and prev.get("centerMm"):
                jump = float(np.linalg.norm(u - np.array(prev["centerMm"], float)))
            if jump is not None and jump > JUMP_MM and jump_streak < JUMP_ACCEPT_AFTER:
                # 사람이 1초에 이만큼 못 옮긴다 — 일단 **한 프레임 잘못 푼 것**으로 본다.
                # ⚠ **거부해도 반드시 쓴다.** 안 쓰면 `checkedAt` 이 안 늙어 파일이
                # 「방금 확인함」인 척하고, 화면은 초록인데 자리는 틀린 상태가 된다 —
                # 나이로도 못 잡는 조용한 거짓말이다 (2026-08-13 실측: 139초 동안 215mm 틀렸다)
                jump_streak += 1
                if prev:
                    write({**prev, "checkedAt": now,
                           "staleReason": f"큰 이동을 확인 중 — {jump:.0f}mm ({jump_streak}/{JUMP_ACCEPT_AFTER})"})
                print(f"  {time.strftime('%H:%M:%S')}  보류 — {jump:.0f}mm 튐 "
                      f"({jump_streak}/{JUMP_ACCEPT_AFTER} · 이어지면 받는다)")
            else:
                if jump is not None and jump > JUMP_MM:
                    # 같은 거부가 이어졌다 = 한 프레임 오류가 아니라 **사람이 옮긴 것**이다
                    print(f"  {time.strftime('%H:%M:%S')}  큰 이동을 받는다 — {jump:.0f}mm "
                          f"({JUMP_ACCEPT_AFTER}회 연속)")
                jump_streak = 0
                prev = {
                    "_": "scripts/map/fixture-pose.py 산출물 — 직접 고치지 마라",
                    "_프레임": "user1 (config.yaml workspace.boxes 와 같은 프레임)",
                    "centerMm": [round(float(v), 1) for v in u],
                    "halfMm": HALF_MM, "heightMm": HEIGHT_MM,
                    "seenAt": now, "checkedAt": now, "basis": E.get("shot"),
                    "jumpMm": None if jump is None else round(jump, 1),
                }
                write(prev)
                print(f"  {time.strftime('%H:%M:%S')}  "
                      f"({u[0]:7.1f}, {u[1]:8.1f}, {u[2]:7.1f}) mm"
                      + (f" · {jump:.0f}mm 이동" if jump else ""))
        if not a.watch:
            return 0
        time.sleep(PERIOD_S)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n멈췄다 — 파일은 마지막 값 그대로다. **나이가 늙으므로 쓰는 쪽이 「가정값」으로 읽는다**")
