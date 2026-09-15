#!/usr/bin/env python3
"""연속 추종 — **`POST /follow/step` 을 반복해서** 팔이 표적을 따라가게 한다 (2026-09-04).

    python3 scripts/robot/follow-live.py                 # 4분 돌고 곱게 반납
    python3 scripts/robot/follow-live.py --seconds 600
    python3 scripts/robot/follow-live.py --who admin     # 화면이 쥔 조종권을 이어받는다

## 왜 이 파일이 있나 — 내가 두 번 잘못 만들었다

첫 판은 WebSocket `moveJ` 를 손으로 5° 씩 쪼갰다. 그러다 셋을 밟았다:

1. **미리 만든 경로**가 도착 오차로 다음 델타를 5° 상한 위로 밀어 거부됐다
2. 브리지 WS 는 **실패만 보낸다**(`if not res.get("ok")`) — 성공이 조용한 걸 모르고
   「응답 못 봄」을 실패로 뒤집었다. **도착이 곧 응답**이다
3. 루프가 상태 조회에 붙들려 **keepalive ping** 에 못 답해 소켓이 1011 로 끊겼다

⭐ **셋 다 `/follow/step` 을 쓰면 애초에 안 생긴다.** 그쪽은 표적→목표→IK→게이트→이동을
브리지가 **한 함수**로 하고, `scan_path=True` 라 5° 쪼개기가 필요 없다(경로를 5° 간격으로
표본해 전부 게이트에 태운다). 2026-09-04 에 거치대 추종이 **0.0mm** 로 간 바로 그 경로다.

## ⛔ WebSocket 을 안 연다

조종권은 **WS 세션이 닫히고 10초** 뒤 자동 해제되고, 해제는 `disarm` 을 부르고, `disarm` 은
`enable(False)` 로 **서보를 내린다.** 그런데 이 펌웨어는 `RobotEnable` 을 **끄는 건 받고 켜는 건
거부**한다(2026-07-31 등재) — 그래서 서보를 다시 켜려면 **사람이 펜던트로** 가야 한다.
09-04 에 짧은 스크립트를 여러 번 돌리다 그 왕복을 다섯 번 시켰다.
**HTTP 만 쓰면 세션이 열린 적이 없어 그 사슬이 통째로 안 걸린다.**

## ⛔ 무엇을 안 하나

- **ARM 을 승격하지 않는다** — 이미 `ARMED` 일 때만 돈다. 아니면 사유를 내고 멈춘다(하드 룰 3)
- **표적을 만들지 않는다** — 브리지의 `follow.target` 을 그대로 쓴다. 없으면 **쉰다**
- **터틀봇을 안 몬다** — 사람이 몬다(하드 룰 4). 움직이는 동안엔 팔을 안 보낸다(§상호 배제)
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

# 표적이 이만큼 안 움직였으면 안 간다. 브리지에도 `follow.deadbandMm` 이 있지만 그건
# **손끝 목표** 기준이고 여기는 **표적** 기준이라 왕복을 한 번 더 줄인다.
TARGET_MOVE_MM = 40.0
POLL_S = 1.0


def call(base, path, body=None, timeout=60):
    if body is None:
        return json.load(urllib.request.urlopen(base + path, timeout=timeout))
    r = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            return json.loads(f.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.30.6:5055")
    ap.add_argument("--who", default="admin",
                    help="조종권 이름. 화면이 쥐고 있으면 **같은 이름**을 줘야 이어받는다 — "
                         "다른 이름으로 뺏으면 disarm 이 걸려 서보가 꺼진다")
    ap.add_argument("--seconds", type=float, default=240.0)
    a = ap.parse_args()
    B = f"http://{a.host}"

    st = call(B, "/state")
    print(f"서보 {st.get('enabled')} · phase {st.get('phase')} · "
          f"전역속도 {st.get('speedOverridePct')}% · owner {st.get('owner')}")
    if not st.get("enabled"):
        print("⛔ 서보가 꺼져 있다 — **펜던트에서 로봇 Enable** 후 다시. "
              "이 펌웨어는 SDK 로 못 켠다(2026-07-31 등재)")
        return 1

    c = call(B, "/owner/claim", {"who": a.who})
    if not c.get("ok"):
        print(f"⛔ 조종권 — {c.get('reasons')}")
        return 1
    tok = c["token"]
    print(f"조종권 {a.who} · 이어받음\n")

    moved = skipped = refused = 0
    last = None
    try:
        if call(B, "/state").get("phase") != "ARMED":
            r = call(B, "/arm", {"who": a.who, "token": tok, "confirm": "현장확인"})
            print("ARM:", json.dumps({k: r.get(k) for k in ("ok", "phase", "reasons")},
                                     ensure_ascii=False))
            if not r.get("ok"):
                return 1

        end = time.time() + a.seconds
        while time.time() < end:
            s = call(B, "/state")
            if s.get("phase") != "ARMED":
                print(f"⛔ ARM 이 풀렸다 — {s.get('phase')}")
                break
            f = s.get("follow") or {}
            t = f.get("target")
            if not t:
                print(f"   … 표적 없음 — {f.get('targetWhy') or s.get('wristNote')}")
                time.sleep(POLL_S * 2)
                continue
            # ⛔ **터틀봇이 움직이는 동안 팔을 안 보낸다** — 계약 §상호 배제.
            # 그 금지는 브리지에 구현이 0줄이라, 부르는 쪽인 여기서 지킨다.
            v = ((f.get("amr") or {}).get("pose") or {})
            if abs(float(v.get("linearMmS") or 0)) > 1 or abs(float(v.get("angularDegS") or 0)) > 1:
                print("   … 터틀봇이 움직이는 중 — 선 뒤에 간다")
                time.sleep(POLL_S)
                continue
            u = t["user1Mm"]
            if last and ((u[0] - last[0]) ** 2 + (u[1] - last[1]) ** 2) ** 0.5 < TARGET_MOVE_MM:
                skipped += 1
                time.sleep(POLL_S)
                continue
            last = u

            before = s.get("jointsDeg")
            r = call(B, "/follow/step", {"who": a.who, "token": tok, "confirm": "현장확인"})
            if not r.get("ok"):
                refused += 1
                print(f"   ⛔ 거부 — {'; '.join(map(str, r.get('reasons') or []))[:90]}")
                time.sleep(POLL_S)
                continue
            if not r.get("moved"):
                skipped += 1
                print(f"   · 데드밴드 — {'; '.join(map(str, r.get('reasons') or []))[:60]}")
                time.sleep(POLL_S)
                continue
            moved += 1
            g = r.get("goal") or {}
            after = call(B, "/state").get("jointsDeg") or []
            dj = (max(abs(after[i] - before[i]) for i in range(6))
                  if before and len(after) == 6 else None)
            print(f"[{moved}] 표적 [{u[0]:7.1f},{u[1]:8.1f}] ({t['ageS']}s) → 손끝 "
                  f"{[round(x) for x in g.get('tcpMmDeg', [])[:3]]}"
                  + (f" · 관절 최대이동 {dj:.1f}°" if dj is not None else ""))
            time.sleep(POLL_S)
    finally:
        # ⚠ **반납하면 disarm 되고 서보가 꺼진다** — 그게 옳다(주인 없는 ARMED 를 안 남긴다).
        # 다음 판에는 사람이 펜던트에서 다시 켜야 한다. 그래서 **한 판을 길게** 돌린다.
        print(f"\n간 횟수 {moved} · 건너뜀 {skipped} · 거부 {refused}")
        print("반납:", call(B, "/owner/release", {"who": a.who, "token": tok}).get("ok"),
              "(disarm → 서보 OFF · 다음엔 펜던트에서 켠다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
