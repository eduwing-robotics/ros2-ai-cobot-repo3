#!/usr/bin/env python3
"""정합 — **같은 물건을 여럿이 볼 때 같은 자리라고 말하나** (2026-09-03 개설).

`frames.sh`·`frames-chain.sh` 는 **표(선언)** 를 검사한다 — 갈래가 등재됐나, 환산이
손계산과 맞나. 그런데 셋 다 통과해도 **실제 센서 둘이 다른 자리를 가리킬 수 있다.**
그건 코드가 아니라 **실물이 옮겨져서** 나는 어긋남이라 문법으로는 안 잡힌다.

## 왜 필요한가 — 사람이 눈으로 잡은 사고 셋

  · `base→lab` 이라 적힌 갈래가 실은 `user1→lab` 이었다 — **725.1mm** (2026-08-28)
  · `follow_target` 이 user1 원점을 못 찾아 베이스 좌표를 내보냈다 — **654mm** (D155)
  · `AMR_HOME` 을 base 로 읽어 터틀봇이 판 밑 **342.1mm** 허공에 떴다 (2026-08-28)

셋 다 **아무 게이트도 안 울렸다.** 값이 틀렸을 뿐 이름·타입·문법은 전부 옳았기 때문이다.
이 게이트가 그 자리를 맡는다 — **아는 물건을 두 사슬로 재서 답이 같은지 본다.**

## 무엇을 재나

표적은 **터틀봇 윗면 태그(id 18)** 다. 새로 설치할 게 없다 — 이미 둘이 본다:

  사슬 A  글로벌캠 → `amr-pose.json`(camLab) → `fixture.lab_to_user1` → user1
  사슬 B  터틀봇 odom → `AMR_TAG` 오프셋 → `AMR_HOME` 으로 odom→user1

⛔ **`unknown` 갈래를 지나면 초록을 주지 않는다.** `frames.js` 가 `camLab→base` 를
`unknown` 으로 적어 뒀다(태그0 의 base x·y 미측정). 사슬 A 는 그 갈래를 지나므로
**절대값은 「모른다」** 로 보고한다 — 브리지가 `robot-base-in-tag.json` 으로 조용히
환산하고 있는 것과 이 게이트가 다른 점이 정확히 여기다.

⭐ **그래도 재는 이유 — 절대값은 몰라도 «변했나» 는 안다.** 실물이 안 움직였는데 숫자가
움직였으면 사슬 어딘가가 변한 것이다. `--save-baseline` 으로 오늘 값을 박아 두고
다음부터는 **그 차이**를 본다. 「모른다」와 「달라졌다」는 다른 말이다.

## 문턱 (2026-09-03 실측 근거)

  5.74mm   hand-eye 흩어짐 — 우리가 가진 제일 좋은 사슬이 내는 폭
  17.5mm   거치대를 바구니에 넣을 때 한쪽에 남는 여유 (`carrier-into-basket-feasibility.md`)

이보다 크게 어긋나면 **그 사슬로는 바구니에 못 넣는다.** 문턱의 뜻이 그것이다.

    bash scripts/check/agree.sh
    bash scripts/check/agree.sh --save-baseline
"""
import json
import math
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))
BASELINE = Path(__file__).with_name("agree-baseline.json")

GREEN_MM = 5.74     # hand-eye 흩어짐
AMBER_MM = 17.5     # 바구니 한쪽 여유
MAX_AGE_S = 5.0     # 달리는 로봇이다 — 늙은 값으로 판정하지 않는다 (D154)

fails = []
warns = []


def get(url, timeout=6):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def workcell(*names):
    """`workcell.js` 의 값을 **모듈을 직접 읽어** 가져온다. 못 읽으면 `None` — 0 으로 안 채운다.

    ⛔ **정규식으로 파싱하지 않는다** (2026-09-03 · 이 스크립트가 첫 판에 밟았다).
    `topZMm\\s*:\\s*(-?\\d+)` 이 파일 앞쪽 **작업대**의 같은 이름을 집어 `-380.9` 대신
    `6.4` 를 읽었고, 판정이 **408mm** 틀어졌다. 이름도 타입도 옳고 값만 틀린 — 이 게이트가
    잡으라고 있는 바로 그 병이다. SSOT 를 «해석» 하지 말고 «실행» 해서 받는다.
    """
    import subprocess
    src = "import('./Shared/data/workcell.js').then(m=>console.log(JSON.stringify({%s})))" % (
        ",".join(f"{n}:m.{n}" for n in names))
    try:
        out = subprocess.run(["node", "-e", src], cwd=ROOT, capture_output=True,
                             text=True, timeout=30)
        return json.loads(out.stdout) if out.returncode == 0 else None
    except Exception:                                            # noqa: BLE001
        return None


def verdict(mm, trusted):
    if mm is None:
        return "  ?  ", "못 쟀다"
    if not trusted:
        return " 모름", f"{mm:.1f}mm — unknown 갈래를 지난다. 절대값은 판정 못 한다"
    if mm <= GREEN_MM:
        return "  OK ", f"{mm:.1f}mm"
    if mm <= AMBER_MM:
        return " WARN", f"{mm:.1f}mm — 여유({AMBER_MM}mm) 안이지만 hand-eye 폭({GREEN_MM}mm)을 넘었다"
    return " FAIL", f"{mm:.1f}mm — 바구니 여유 {AMBER_MM}mm 를 넘는다. 이 사슬로는 못 넣는다"


def main():
    import numpy as np
    import fixture

    host = os.environ.get("FR5_HOST_IP", "").strip()
    if not host:
        print("  대기 브리지 호스트를 못 찾았다 — 그 PC 가 망에 없다. 실기가 붙은 세션에서 부른다")
        return 0
    tb = os.environ.get("FR5_TB_HOST", "192.168.30.15:5056")

    cfg = f"http://{host}:5055/config"
    # ⛔ **이름이 풀렸다고 브리지가 열린 건 아니다** (2026-09-04 · 이 게이트가 여기서 죽었다).
    # `host.sh` 는 22 번으로 살아있음을 보지만 5055 는 따로다 — PC 는 켜져 있고 브리지만
    # 내려간 상태가 실재한다(어젯밤이 그랬다). 못 읽으면 **터지지 말고 「대기」**다.
    try:
        base = get(f"{cfg}/robot-base-in-tag.json")
        state = get(f"http://{host}:5055/state")
    except Exception as e:                                       # noqa: BLE001
        print(f"  대기 브리지(5055)를 못 읽었다 — {str(e)[:60]}. 실기가 붙은 세션에서 부른다")
        return 0
    user = (state.get("coordDefs") or {}).get("user")

    # ── fail-closed: user1 원점이 없으면 **답을 내지 않는다.** D155 가 난 그 자리다 ──
    if not user or len(user) < 3:
        # 로봇 미연결이면 **재료가 없는 것**이지 결함이 아니다 — 위 규약 그대로 「대기」다
        print("  대기 user1 원점이 없다 (로봇 미연결) — 환산할 재료가 없어 판정하지 않는다")
        return 0
    rot = max(abs(float(v)) for v in user[3:6]) if len(user) >= 6 else 0.0
    if rot > 0.5:
        print(f"  FAIL user1 회전 {rot:.3f}° — 이 게이트의 평면 모델이 깨진다 (ROT_TOL 0.5°)")
        return 1

    print("== 정합 — 같은 물건을 둘이 같은 자리라고 말하나 ==")
    print(f"   표적: 터틀봇 윗면 태그 18 · 문턱 초록 {GREEN_MM}mm / 노랑 {AMBER_MM}mm\n")

    # ── 사슬 A — 글로벌캠 ───────────────────────────────────────────────────
    a_user1 = a_age = None
    try:
        doc = get(f"{cfg}/amr-pose.json")
        v = (doc.get("anchors") or {}).get("18")
        if v:
            a_age = time.time() - float(v.get("t") or 0)
            a_user1 = np.asarray(fixture.lab_to_user1(v["labMm"], base, user), float)
            print(f"  A 글로벌캠   camLab {[round(x,1) for x in v['labMm']]}"
                  f" → user1 [{a_user1[0]:7.1f}, {a_user1[1]:7.1f}, {a_user1[2]:7.1f}]"
                  f"  ({a_age:.1f}s · {v.get('errPx')}px)")
        else:
            warns.append("글로벌캠이 태그 18 을 못 보고 있다")
            print("  A 글로벌캠   태그 18 이 산출 파일에 없다 — 지금 안 보인다")
    except Exception as e:                                       # noqa: BLE001
        warns.append(f"글로벌캠 읽기 실패 — {e}")
        print(f"  A 글로벌캠   읽기 실패 — {e}")

    # ── 사슬 B — 터틀봇 odom ───────────────────────────────────────────────
    b_user1 = b_age = None
    try:
        import asyncio
        import websockets

        async def read_tb():
            async with websockets.connect(f"ws://{tb}/ws/state", open_timeout=6) as ws:
                for _ in range(3):
                    m = json.loads(await asyncio.wait_for(ws.recv(), 6))
                return m

        m = asyncio.run(read_tb())
        r = (m.get("robots") or {}).get("tb3_2") or {}
        if r.get("connected") and r.get("pose"):
            b_age = float(r.get("poseAgeSec") or 0)
            wc = workcell("AMR_HOME", "AMR_TAG")
            if not wc:
                warns.append("workcell.js 에서 AMR_HOME·AMR_TAG 를 못 읽었다 (node 필요)")
            else:
                H, TG = wc["AMR_HOME"], wc["AMR_TAG"]
                hx, hy, hz, hyaw = H["xMm"], H["yMm"], H["topZMm"], H["yawDeg"]
                o = TG["offsetMm"]
                off = (float(o["x"]), float(o["y"]), float(o["z"]))
                p = r["pose"]
                # 로봇 프레임 → odom : 로봇 요각만큼 돌려 더한다
                th = math.radians(float(p.get("thetaDeg") or 0))
                ox = float(p["xMm"]) + off[0] * math.cos(th) - off[1] * math.sin(th)
                oy = float(p["yMm"]) + off[0] * math.sin(th) + off[1] * math.cos(th)
                oz = off[2]
                # odom → user1 : `frames.js` EDGES 의 measured 갈래 (회전이 진짜로 있다)
                hh = math.radians(hyaw)
                b_user1 = np.array([hx + ox * math.cos(hh) - oy * math.sin(hh),
                                    hy + ox * math.sin(hh) + oy * math.cos(hh),
                                    hz + oz], float)
                print(f"  B 터틀봇     odom ({p['xMm']:.0f}, {p['yMm']:.0f}, {p.get('thetaDeg'):.1f}°)"
                      f" → user1 [{b_user1[0]:7.1f}, {b_user1[1]:7.1f}, {b_user1[2]:7.1f}]"
                      f"  ({b_age:.1f}s)")
        else:
            warns.append("터틀봇이 안 붙어 있다 — 자리를 말하지 않는다")
            print("  B 터틀봇     안 붙어 있다")
    except Exception as e:                                       # noqa: BLE001
        warns.append(f"터틀봇 읽기 실패 — {e}")
        print(f"  B 터틀봇     읽기 실패 — {e}")

    # ── 사슬 C — 손목캠 (아직 못 한다. **왜 못 하는지 정확히 적는다**) ────────
    print("  C 손목캠     미지원 — 5058 `/api/camera/info` 가 color intrinsics 를 안 준다.")
    print("               한 줄이면 열린다: info 응답에 `colorIntrinsics` 추가 (API-CONTRACT 먼저)")
    print("               2026-09-03 손실측 A↔C = 45.9mm (hand-eye 에 회전이 없는 것이 1순위 용의자)\n")

    # ── 나이 ────────────────────────────────────────────────────────────────
    # ⛔ **못 잰 것을 실패로 적지 않는다** (2026-09-03 · `all.sh` 가 `check/*.sh` 를 자동
    # 발견하는 것을 몰라 이 게이트가 로봇 없는 세션을 통째로 붉혔다). `grasp-rank.sh` 가
    # 쓰는 규약 그대로 — **재료가 없으면 「대기」로 통과**하고, 다른 게이트를 안 붉힌다.
    # 실패로 남기는 것은 **잰 값이 기준선에서 움직였을 때** 하나뿐이다.
    for nm, age in (("글로벌캠", a_age), ("터틀봇", b_age)):
        if age is not None and age > MAX_AGE_S:
            warns.append(f"{nm} 값이 {age:.1f}초 낡았다 (상한 {MAX_AGE_S}초) — 지금 자리라는 뜻이 아니다")
            print(f"  대기 {nm} 값이 {age:.1f}초 낡았다 — 이 값으로는 판정하지 않는다")

    # ── 판정 ────────────────────────────────────────────────────────────────
    print("== 판정 ==")
    now = None
    if a_user1 is not None and b_user1 is not None:
        d = a_user1 - b_user1
        now = float(np.linalg.norm(d))
        mark, why = verdict(now, trusted=False)   # A 가 unknown 갈래를 지난다
        print(f" {mark} A(글로벌캠) ↔ B(터틀봇)  Δ=[{d[0]:6.1f}, {d[1]:6.1f}, {d[2]:6.1f}]  {why}")
    else:
        print("  ?   A ↔ B — 한쪽이 없어서 못 쟀다")

    # ── 드리프트 — 절대값은 몰라도 «변했나» 는 안다 ──────────────────────────
    if "--save-baseline" in sys.argv:
        if now is None:
            print("\n  ⛔ 잴 수 없어서 기준선을 안 남겼다 — 빈 값을 기준선으로 두지 않는다")
        else:
            BASELINE.write_text(json.dumps(
                {"_": "agree.py 기준선 — 실물이 안 움직였는데 이 값이 변하면 사슬이 변한 것이다",
                 "atagVsOdomMm": round(now, 2), "savedAt": time.strftime("%Y-%m-%d %H:%M")},
                ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"\n  기준선 저장 — {now:.1f}mm")
    elif BASELINE.exists() and now is not None:
        b = json.loads(BASELINE.read_text(encoding="utf-8"))
        drift = abs(now - float(b["atagVsOdomMm"]))
        if drift > AMBER_MM:
            fails.append(f"기준선 대비 {drift:.1f}mm 움직였다")
            print(f"  FAIL 기준선({b['atagVsOdomMm']}mm · {b['savedAt']}) 대비 {drift:.1f}mm 변했다"
                  f" — 실물이 안 움직였다면 사슬이 변한 것이다")
        else:
            print(f"  OK   기준선({b['atagVsOdomMm']}mm · {b['savedAt']}) 대비 {drift:.1f}mm")
    elif now is not None:
        print("  --   기준선이 없다. `--save-baseline` 으로 오늘 값을 박아 두면 다음부터 변화를 본다")

    for w in warns:
        print(f"  경고 {w}")
    print("\n정합 OK" if not fails else "\n정합 FAIL")
    # ⛔ 여기서 1 을 내는 것은 **기준선에서 움직였을 때**뿐이다 (위 §못 잰 것)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
