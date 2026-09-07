#!/usr/bin/env python3
"""터틀봇 자리 — 라이다 위 태그 18 을 풀어 `amr-pose.json` 으로 (2026-08-28).

**얇은 껍데기다** — 사슬·풀이·원자적 쓰기·상주·미러는 전부 `marker_follow.py`(공용 뼈대)가
한다. `anchor-pose.py` 와 형제이고, 다른 것은 **무엇을 따라가나** 하나뿐이다.

    python3 scripts/map/amr-pose.py --host 192.168.30.8:8080            # 1회
    python3 scripts/map/amr-pose.py --host … --watch                    # 상주 — 로봇을 따라간다
    python3 scripts/map/amr-pose.py --host … --watch \
        --push "heeyoung park@192.168.30.18:FR5Web/Shared/data/config/amr-pose.json"

## 왜 `scene-anchors.json` 에 같이 안 넣나

저쪽은 **가만히 있는 소품**의 자리다 — 안 보이면 옛 값을 남기는 것이 옳다(종이는 저 혼자
안 움직인다). 터틀봇은 **달린다.** 안 보이는 동안 옛 자리를 남기면 화면과 추종이 「멈춘
시계」를 읽는다. 파일을 가르면 그 규칙도 갈라진다 — 여기서는 **못 보면 못 봤다고 적는다.**

## lab 로만 적는다 — 로봇 좌표로 안 바꾼다

`robot-base-in-tag.json`(lab→베이스)이 있지만 **여기서 환산하지 않는다** (하드 룰 5).
쓰는 쪽이 하나가 아니다 — 화면은 lab 로 그리고 브리지는 베이스로 움직인다. 둘 다 쓰라고
여기서 미리 바꿔 두면 변환이 두 곳에 생기고, 그러면 `robot-base-in-tag.json` 을 다시 잰
날 한쪽만 고쳐진다. **사실만 적고 환산은 쓰는 쪽에서** — `frames.js` 가 화면 쪽 정본이다.

⛔ **안전 경로가 아니다.** 이 값으로 게이트를 대신하지 마라 — 추종의 정본 규칙은
`VISION-CONTRACT.md` §추종이고, 이 파일은 그 조건 5(표적을 지금 보고 있다)의 **재료**다.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from marker_follow import (  # noqa: E402
    ROOT, Chain, Mirror, follow, phone_frame, write_anchors,
)

OUT = ROOT / "Shared/data/config/amr-pose.json"
# ⚠ 쌍둥이가 `FR5/bridge/follow.py` 에 하나 더 있다 — 산출기(여기)는 브리지 코드를 임포트할
# 수 없어서 갈라졌다. 태그를 갈면 **두 곳을 같이** 고친다. 제원은 `tags.json` 이 든다.
AMR_TAG_ID = 18
HEADER = {
    "_무엇": "터틀봇(tb3_2) 라이다 윗면 태그 18 의 자리. 로봇 자체가 아니라 **태그**의 자리다 — "
             "받침점까지의 오프셋은 workcell.js AMR_TAG 가 든다",
    "_주의": "달리는 로봇이다. `t` 가 늙었으면 **그 자리에 있다는 뜻이 아니다** — 읽는 쪽이 "
             "나이를 보고 fail-closed 한다 (안 보이면 안 그린다·안 따라간다)",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True, help="폰 주소(host:port) — /shot.jpg 를 받는다")
    ap.add_argument("--watch", action="store_true", help="반복 — 로봇을 따라간다")
    ap.add_argument("--period", type=float, default=1.0,
                    help="--watch 주기(초). 소품(2.0)보다 촘촘하다 — 이건 달린다")
    ap.add_argument("--push", help="원격 미러 scp 목적지")
    ap.add_argument("--calib-host", help="브리지 주소(host:port) — **살아 있는** 캘리브를 "
                                         "거기서 읽고 자동 재정합을 따라간다")
    a = ap.parse_args()

    want = {AMR_TAG_ID}
    chain = Chain(conf_url=f"http://{a.calib_host}/config/global-cam.json" if a.calib_host else None)
    print(f"캘리브 기준 {chain.basis}"
          + (f" — {a.calib_host} 에서 (자동 재정합 추종)" if a.calib_host else " — 레포 파일(정적)"))
    mirror = Mirror(a.push) if a.push else None

    if a.watch:
        return follow(chain, want, OUT, a.host, period=a.period, mirror=mirror)

    gray, name = phone_frame(a.host)
    solved = chain.solve(gray, want)
    if AMR_TAG_ID not in solved:
        print(f"  id{AMR_TAG_ID}: 안 보인다 — 자리·가림·거리 확인", file=sys.stderr)
        print("실패 — 파일을 안 바꾼다", file=sys.stderr)
        return 1
    v = solved[AMR_TAG_ID]
    print(f"  id{AMR_TAG_ID}: lab ({v['labMm'][0]:.0f}, {v['labMm'][1]:.0f}, {v['labMm'][2]:.0f}) mm · "
          f"yaw {v['yawDeg']:.0f}° · 재투영 {v['errPx']:.2f} px")
    doc = write_anchors(OUT, solved, chain, name, header_extra=HEADER)
    print(f"{OUT.relative_to(ROOT)} 갱신")
    if mirror:
        mirror.push(OUT, doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
