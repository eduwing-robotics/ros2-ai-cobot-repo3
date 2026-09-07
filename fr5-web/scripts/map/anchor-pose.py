#!/usr/bin/env python3
"""장면 앵커(컨베이어 32·33 등) — 태그 자리를 lab(mm)로 풀어 `scene-anchors.json` 으로.

**얇은 껍데기다** — 사슬·풀이·원자적 쓰기·상주·미러 전부 `marker_follow.py`(공용 뼈대)가
한다. 여기는 인자를 받아 넘길 뿐이다. 새 추종(거치대 15·18·21, 터틀봇 보정 등)을 붙일 때도
이 파일을 복사하지 말고 **같은 모듈에 얇은 CLI 하나**를 더 얹는다.

    python3 scripts/map/anchor-pose.py                       # 최신 사진 1회 · 기본 32,33
    python3 scripts/map/anchor-pose.py --shot 사진.jpg
    python3 scripts/map/anchor-pose.py --host 192.168.30.8:8080          # 폰에서 직접 1회
    python3 scripts/map/anchor-pose.py --host … --watch                  # 상주 — 종이를 따라간다
    python3 scripts/map/anchor-pose.py --host … --watch \
        --push "heeyoung park@192.168.30.18:FR5Web/Shared/data/config/scene-anchors.json"
                                                             # + 호스트 미러 (관제화면이 따라온다)

좌표계는 **lab(태그0 · 카트 덱 평면)** — 작업대 상판은 z ≈ -35mm 로 나온다 (음수가 정상).
⚠ 윈도우 호스트에 상주로 세우지 마라 — sshd 가 세션 종료 때 자식을 거둬간다 (D131).
상주가 필요해지면 받침처럼 **브리지 안**으로 넣는다 (재시작 창이 필요해 보류 중).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from marker_follow import (  # noqa: E402
    ROOT, Chain, Mirror, follow, latest_file_frame, phone_frame, write_anchors,
)

OUT = ROOT / "Shared/data/config/scene-anchors.json"
HEADER = {"_주의": "lab→로봇 환산은 robot-base-in-tag.json yaw 재측정 대기 (GAP P1 · 1.73° 회전 "
                  "오차 · 2026-08-19). 이 파일의 lab 값 자체는 그 yaw 를 안 타므로 안 흔들린다"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", help="사진 경로. 없으면 calib-shots/tags 의 최신")
    ap.add_argument("--host", help="폰 주소(host:port) — 파일 대신 /shot.jpg 를 직접 받는다")
    ap.add_argument("--ids", default="32,33", help="풀 태그 id (쉼표)")
    ap.add_argument("--watch", action="store_true", help="반복 — 종이를 따라간다 (--host 필요)")
    ap.add_argument("--period", type=float, default=2.0, help="--watch 주기(초)")
    ap.add_argument("--push", help="원격 미러 scp 목적지 — 자리가 바뀔 때 + 60초 심장박동만 민다")
    ap.add_argument("--calib-host", help="브리지 주소(host:port) — **살아 있는** 캘리브를 거기서 읽고 "
                                         "자동 재정합을 따라간다. 없으면 이 레포의 파일(정적)")
    a = ap.parse_args()
    if a.watch and not a.host:
        print("--watch 는 --host 가 필요하다 (파일은 스스로 안 바뀐다)", file=sys.stderr)
        return 2
    want = {int(x) for x in a.ids.split(",")}
    chain = Chain(conf_url=f"http://{a.calib_host}/config/global-cam.json" if a.calib_host else None)
    print(f"캘리브 기준 {chain.basis}" + (f" — {a.calib_host} 에서 (자동 재정합 추종)" if a.calib_host else " — 레포 파일(정적)"))
    mirror = Mirror(a.push) if a.push else None

    if a.watch:
        return follow(chain, want, OUT, a.host, period=a.period, mirror=mirror)

    if a.host:
        gray, name = phone_frame(a.host)
    else:
        gray, name, age_min = latest_file_frame(a.shot)
        print(f"{name} · 찍은 지 {age_min:.0f}분")   # 낡은 사진을 오늘 것으로 읽는 함정 방지
    solved = chain.solve(gray, want)
    for tid in sorted(want):
        if tid in solved:
            v = solved[tid]
            print(f"  id{tid}: lab ({v['labMm'][0]:.0f}, {v['labMm'][1]:.0f}, {v['labMm'][2]:.0f}) mm · "
                  f"yaw {v['yawDeg']:.0f}° · 재투영 {v['errPx']:.2f} px")
        else:
            print(f"  id{tid}: 안 보인다 — 자리·가림·거리 확인")
    if not solved:
        print("실패 — 하나도 못 풀었다. 파일을 안 바꾼다", file=sys.stderr)
        return 1
    doc = write_anchors(OUT, solved, chain, name, header_extra=HEADER)
    print(f"{OUT.relative_to(ROOT)} 갱신 — {len(solved)}개")
    if mirror:
        mirror.push(OUT, doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
