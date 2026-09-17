#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""치수·설정이 바뀌었으면 문서를 다시 만든다.

**왜 필요한가.** 문서(`시뮬레이션_치수.*`, `실행방법.*`)는 상수에서 자동으로 뽑지만,
생성기를 돌려야 반영된다. 상수만 고치고 생성기를 안 돌리면 **문서가 조용히 낡는다.**
그게 이 프로젝트에서 여러 번 사고를 냈다 (성공 기준 7.00mm 가 4.50 으로 바뀐 뒤에도
출력에 7.00 이 찍히던 것 등).

**어떻게 판단하나.** git 저장소가 아니라 훅을 못 쓴다. 그래서 **파일 수정 시각**을 본다:
입력(상수·MJCF·뷰어) 중 하나라도 출력(문서)보다 새로우면 그 생성기를 돌린다.
바뀐 게 없으면 아무것도 안 한다 — 매번 불러도 싸다.

    python3 sync_docs.py            # 필요한 것만 다시 만든다
    python3 sync_docs.py --check    # 만들지 않고 낡았는지만 알려준다 (종료코드 1)
    python3 sync_docs.py --force    # 무조건 다시 만든다
"""

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

PY = sys.executable          # 지금 돌고 있는 인터프리터 = 가상환경 그대로 쓴다

# 생성기 : (입력들, 출력들)
# ⚠ 입력에 빠진 게 있으면 그 파일을 고쳐도 문서가 안 따라온다. 새 상수 파일을 만들면 여기 추가.
JOBS = {
    "make_dimension_doc.py": (
        ["fr5_site.py", "fr5_screw_assembly.py", "fairino5_v6_mjmodel.xml",
         "view_scene.py", "view_fleet.py", "fr5_multi_fleet_control.py",
         "make_fixture_mesh.py", "make_ammo_meshes.py",
         "../share/urdf/meshes/ammo/fixture.stl",
         "../share/urdf/meshes/ammo/bullet.stl",
         "../share/urdf/meshes/ammo/casing.stl"],
        ["시뮬레이션_치수.html", "시뮬레이션_치수.txt"],
    ),
    "make_howto_doc.py": (
        ["fr5_site.py", "fr5_screw_assembly.py", "train_screw_ppo.py"],
        ["실행방법.html", "실행방법.txt"],
    ),
}


def mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def stale(gen, inputs, outputs):
    """다시 만들어야 하나. (그렇다/아니다, 이유)"""
    missing = [o for o in outputs if mtime(o) is None]
    if missing:
        return True, f"출력 없음: {', '.join(missing)}"
    oldest_out = min(mtime(o) for o in outputs)
    g = mtime(gen)
    if g is not None and g > oldest_out:
        return True, f"생성기가 더 새롭다: {gen}"
    newer = [i for i in inputs if (m := mtime(i)) is not None and m > oldest_out]
    if newer:
        return True, "입력이 더 새롭다: " + ", ".join(os.path.basename(n) for n in newer)
    gone = [i for i in inputs if mtime(i) is None]
    if gone:
        # 입력이 사라진 것은 낡음이 아니라 설정 오류다 — 알려만 주고 넘어간다
        print(f"  ⚠ {gen}: 입력이 없다 — {', '.join(gone)}")
    return False, "최신"


def main():
    ap = argparse.ArgumentParser(description="치수·설정이 바뀌었으면 문서를 다시 만든다")
    ap.add_argument("--check", action="store_true",
                    help="만들지 않고 낡았는지만 본다. 낡았으면 종료코드 1")
    ap.add_argument("--force", action="store_true", help="무조건 다시 만든다")
    a = ap.parse_args()

    todo = []
    for gen, (inputs, outputs) in JOBS.items():
        need, why = (True, "강제") if a.force else stale(gen, inputs, outputs)
        mark = "낡음" if need else "최신"
        print(f"  {mark:4s} {gen:24s} {why}")
        if need:
            todo.append(gen)

    if not todo:
        print("\n문서가 최신이다.")
        return 0
    if a.check:
        print(f"\n⚠ {len(todo)}개가 낡았다 — `python3 sync_docs.py` 로 다시 만들어라.")
        return 1

    print()
    for gen in todo:
        print(f"── {gen} ──")
        r = subprocess.run([PY, gen])
        if r.returncode != 0:
            print(f"⛔ {gen} 실패 (code={r.returncode})")
            return r.returncode
    print("\n문서를 다시 만들었다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
