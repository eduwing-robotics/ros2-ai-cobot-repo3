#!/usr/bin/env python3
"""1단 조준 — **터틀봇이 스스로 말하는 자리**로 거치대를 화각에 넣는다 (2026-09-04).

    python3 scripts/robot/aim-carrier.py            # 지금 자리 → 조준 자세 · 지금 TCP 와 대조
    python3 scripts/robot/aim-carrier.py --json

## 왜 만드나 — 2단의 첫 칸이다

추종을 2단으로 갈랐다. **1단(대략)이 표적을 손목캠 화각에 넣고, 2단(정밀)이 그 안에서 잡는다.**
이 파일이 1단이다.

⭐ **1단은 카메라를 안 쓴다.** 터틀봇은 자기가 어디 있는지 이미 말하고 있고(`odom`,
`poseAgeSec 0.0`), 바구니는 로봇에 **붙어** 있다. 그래서 「거치대가 대충 어디인가」는
**보지 않고도** 안다 — 폰이 꺼져 있어도, 태그가 가려져 있어도 돈다.

⭐ **정차 자리를 안 박는다.** `AMR_DROP` 을 읽지 않고 **지금 odom** 을 읽는다. 정차 경로를
다시 잡아도 이 파일은 안 고친다 — 로봇이 어디에 서든 그 자리를 그대로 따라간다.

## ⛔ 이건 `AMR_HOME` 기준이고, 그 사실을 크게 말한다

`odom → user1` 은 `FRAMES.md` 에서 **measured + assumed** 다 — 자리는 줄자(2026-08-28)지만
**회전 180° 는 「벽을 등지고」에서 유도한 값이지 각도기로 잰 값이 아니다.**

브리지의 추종은 눈금(`amr-frame.json`)이 없으면 **바퀴를 안 쓴다** — `AMR_HOME` 으로 몰래
갈아타지 않는다(`main.py` §표적). 그 규약을 안 깬다. 여기는 **몰래가 아니라 대놓고** 그
가정으로 도는 별도 도구이고, 출력이 매번 `basis: "AMR_HOME(assumed yaw)"` 를 달고 나온다.

## ⛔ 로봇을 안 움직인다

계산하고 보고만 한다. 낸 자세를 실제로 갈지는 사람이 화면에서 정한다 (하드 룰 3·4).

## ⛔ 진짜 한계는 「홈 표시 위에 정확히 섰나」다 (2026-09-04 실측)

이 파일은 `odom` 을 믿는 게 아니라 **`odom` 이 0 인 자리가 `AMR_HOME` 이다**를 믿는다.
그 둘은 다른 가정이고, 어긋나면 **어긋난 만큼 통째로 밀린다.**

실측으로 그 자리를 밟았다 — 터틀봇을 재연결해 원점에 주차하고 `reset-odom` 을 눌러
`odom (0,0)` 을 만든 뒤, 손목 뎁스 5만 점을 user1 로 펴서 라이다 윗면을 쟀다:

| | 실측 | 예측(`AMR_HOME`+`AMR_TAG`) | 차이 |
|---|---|---|---|
| z | −139 | −132 | **−7mm** ✅ |
| y | −933 | −948 | **+15mm** ✅ |
| x | 725 | 865 | **−140mm** ⛔ |

⭐ **`reset-odom` 을 눌러도 이 −140 은 안 변했다** — 누르기 전에도 odom 은 이미 `(0,0)`
이었기 때문이다. **odom 은 무죄다.** 「0 이 어디인가」를 아는 것은 odom 이 아니라 `AMR_HOME`
이고, 그 값은 2026-08-28 줄자(작업대1 벽쪽 끝 1088.1 − 255 = 833.1) 그대로다.

⛔ **그러니 `reset-odom` 은 이 사슬을 안 고친다.** 계약이 이미 적어 뒀다 —
*"홈 표시 위에 정확히 놓고 눌러야 한다. 어긋난 채 누르면 그만큼 전부 어긋난다"*
(`TB-CONTRACT` §원점 재설정). 재설정은 odom 을 0 으로 만들 뿐 **그 0 의 user1 자리는 안 정한다.**

▶ 가르는 법은 **줄자 하나**다 — 작업대1 벽쪽 끝에서 터틀봇까지. **255mm** 면 이 사슬에
버그가 있고, **395mm** 근처면 로봇이 홈 표시에서 그만큼 벗어나 선 것이다(그러면
`AMR_HOME` 이 아니라 **정차 자리**를 고친다).

## 한계 (ponytail)

**옆(y) 오프셋을 0 으로 둔다.** `AMR_BASKET._offsetY` 가 *"옆 25.1mm — 크기는 쟀고
**부호를 모른다**"* 라 적어 뒀다. 지어내지 않고 0 으로 두되, 그 25.1 을 `slackMm` 으로
같이 낸다 — **화각이 그만큼은 먹어 줘야 한다**는 뜻이고, 2단이 나머지를 잡는다.
부호가 등재되는 날 여기서 `y` 를 더한다.
"""
import argparse
import json
import math
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 손목캠이 표적을 담는 거리. **프로필이 정본**이고 여기 기본값을 안 둔다 —
# `follow.standoffMm` 이 오늘만 165→220→165 로 두 번 왕복한 값이라, 복사해 두면 갈라진다.
STANDOFF_KEY = "standoffMm"


def sjs(module, *names):
    """`Shared/data/*.js` 의 값을 **실행해서** 받는다. 못 읽으면 예외 — 0 으로 안 채운다.

    ⛔ **정규식으로 파싱하지 않는다.** `agree.py` 가 첫 판에 그걸로 408mm 를 틀렸다
    (`topZMm` 이 파일 앞쪽 작업대의 같은 이름을 물었다). ⚠ 그 파일에 `workcell.js` 전용
    쌍둥이가 있다 — 읽는 모듈이 늘어나면 둘을 한 곳으로 합친다.
    """
    src = "import('./Shared/data/%s').then(m=>console.log(JSON.stringify({%s})))" % (
        module, ",".join(f"{n}:m.{n}" for n in names))
    # ⛔ **인코딩을 명시한다** — 윈도우에서 `text=True` 는 시스템 코드페이지(cp949)로
    # 디코드해서 한글이 든 SSOT 를 못 읽는다 (2026-09-04 실기에서 물렸다).
    out = subprocess.run(["node", "-e", src], cwd=ROOT, capture_output=True,
                         text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        raise RuntimeError(f"{module} 를 못 읽었다 — {out.stderr.strip()[:200]}")
    return json.loads(out.stdout)


def get(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def rot2(deg):
    r = math.radians(deg)
    return math.cos(r), math.sin(r)


def odom_to_user1(p_odom, home):
    """터틀봇 odom 자리 → user1. **`frames.js` 의 `odom → user1` 갈래 그대로다.**

        p_user1 = R(AMR_HOME.yawDeg) · p_odom + (AMR_HOME.x, AMR_HOME.y)

    ⚠ **회전이 진짜로 있다** (`frames.js` 주석) — odom +x 는 홈에서 로봇이 본 쪽이라
    user1 −x 다. 자리만 더하면 전진이 반대로 나온다.
    """
    c, s = rot2(home["yawDeg"])
    return [c * p_odom[0] - s * p_odom[1] + home["xMm"],
            s * p_odom[0] + c * p_odom[1] + home["yMm"]]


def aim(pose, home, basket, carrier, standoff_mm):
    """지금 터틀봇 자리 → **거치대 윗면**과 **조준 TCP 자세**. 반환 `(결과, 사유)`."""
    if pose is None:
        return None, "터틀봇 자리를 못 받았다 — 브리지가 터틀봇에 안 붙어 있다"

    # ① 로봇 몸통이 user1 어디에 있나
    body = odom_to_user1([pose["xMm"], pose["yMm"]], home)
    # 몸통이 바라보는 쪽. odom 축이 홈 자세를 따라가므로 **더한다**
    heading = home["yawDeg"] + pose["yawDeg"]

    # ② 바구니는 로봇에 **붙어** 있다 — 몸통 좌표계에서 뒤로 offsetMm.x
    #    ⛔ y 는 부호를 모른다(§한계). 0 으로 두고 그 크기를 slack 으로 낸다
    c, s = rot2(heading)
    ox = float(basket["offsetMm"]["x"])
    center = [c * ox + body[0], s * ox + body[1]]

    # ③ 높이. **`SimPanel.basketFloorZ()` 와 같은 식이다** — 환산은 한 곳이다(하드 룰 5)
    floor_z = home["topZMm"] + basket["floorAboveGroundMm"]
    top_z = floor_z + carrier["hMm"]

    # ④ 조준 자세 — 윗면을 정면으로(faceAxis z), 표면에서 standoff 만큼 떨어져 선다
    return {
        "basis": "AMR_HOME(assumed yaw)",
        "amr": {"odomMm": [round(pose["xMm"], 1), round(pose["yMm"], 1)],
                "odomYawDeg": round(pose["yawDeg"], 2),
                "ageS": pose.get("ageS"), "robotId": pose.get("robotId")},
        "bodyUser1Mm": [round(v, 1) for v in body],
        "headingDeg": round(heading, 2),
        "carrierTopUser1Mm": [round(center[0], 1), round(center[1], 1), round(top_z, 1)],
        "basketFloorZMm": round(floor_z, 1),
        "aimTcpMm": [round(center[0], 1), round(center[1], 1), round(top_z + standoff_mm, 1)],
        "standoffMm": standoff_mm,
        # 화각이 먹어 줘야 하는 여유. **잰 값만 더한다** — 부호 미상인 옆 오프셋은
        # 숫자로 안 넣고 사유로 넘긴다(§한계). 지어내는 것보다 「모른다」가 낫다
        "slackMm": round(float(basket.get("offsetSpreadMm") or 0), 1),
        "slackWhy": basket.get("_offsetY"),
    }, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.30.6", help="FR5 브리지 <ip> 또는 <ip:포트>")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    b = f"http://{a.host if ':' in a.host else a.host + ':5055'}"

    st = get(f"{b}/state")
    follow = st.get("follow") or {}
    pose = ((follow.get("amr") or {}).get("pose"))

    w = sjs("workcell.js", "AMR_HOME")
    p = sjs("props.js", "AMR_BASKET", "CARRIER")

    # standoff 는 **브리지 프로필이 정본**이다. 상태에 안 실려 오면 사유를 내고 멈춘다
    standoff = (st.get("appliedSettings") or {}).get("follow", {}).get(STANDOFF_KEY)
    if standoff is None:
        standoff = 165.0
        standoff_src = "⚠ 상태에 안 실려 있다 — config.yaml 실측값 165.0 을 손으로 씀"
    else:
        standoff_src = "브리지 프로필"

    out, why = aim(pose, w["AMR_HOME"], p["AMR_BASKET"], p["CARRIER"], float(standoff))
    if out is None:
        print(json.dumps({"ok": False, "why": why}, ensure_ascii=False) if a.json else f"⛔ {why}")
        return 1
    out["standoffSrc"] = standoff_src

    # ── 대조 — 지금 손끝이 어디 있나. **이게 1단의 검산이다**
    tcp = st.get("tcpMmDeg")
    if tcp:
        d = [round(tcp[i] - out["aimTcpMm"][i], 1) for i in range(3)]
        out["nowTcpMm"] = [round(v, 1) for v in tcp[:3]]
        out["deltaMm"] = d
        out["distMm"] = round(math.dist(tcp[:3], out["aimTcpMm"]), 1)

    if a.json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0

    print(f"기준      {out['basis']}   ⚠ 회전 180° 는 유도값(각도기 아님)")
    print(f"터틀봇    odom {out['amr']['odomMm']} yaw {out['amr']['odomYawDeg']}°"
          f"  ({out['amr']['ageS']}초 전 · {out['amr']['robotId']})")
    print(f"몸통      user1 {out['bodyUser1Mm']}  바라보는 쪽 {out['headingDeg']}°")
    print(f"바구니바닥 z {out['basketFloorZMm']}")
    print(f"거치대윗면 user1 {out['carrierTopUser1Mm']}")
    print(f"조준 TCP  {out['aimTcpMm']}   (standoff {out['standoffMm']} · {out['standoffSrc']})")
    print(f"화각여유  ±{out['slackMm']}mm(잰 값) · {out['slackWhy']}")
    if "distMm" in out:
        print(f"\n지금 손끝  {out['nowTcpMm']}")
        print(f"차이       {out['deltaMm']}   거리 {out['distMm']}mm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
