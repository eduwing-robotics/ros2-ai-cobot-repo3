#!/usr/bin/env python3
"""좌표 사슬 — **브리지(파이썬) 쪽이 SSOT 를 실제로 보고 있나** (2026-08-28).

`frames.mjs` 는 화면(JS) 안쪽만 본다. 그런데 같은 환산이 **두 언어에 각각** 있다 —
화면은 `Shared/data/frames.js`, 브리지는 `FR5/bridge/fixture.py`. 둘이 갈라져도
아무도 안 본다. 이 게이트가 그 틈을 맡는다.

## 왜 문법 검사로는 안 되나 (2026-08-28 실사고)

`follow_target()` 이 없는 속성(`session.user1`)을 찾다 `[0,0,0]` 으로 떨어져
**베이스 좌표를 `user1Mm` 이라는 이름으로** 내보냈다. 함수 이름도(`lab_to_user1`),
변수 이름도(`user`), 반환 키도(`user1Mm`) 전부 옳았다 — **값만 틀렸다.**
「SSOT 를 안 본다」를 grep 으로 찾는 게이트였다면 통과시켰을 것이다.
잡을 수 있는 유일한 길은 **아는 점을 넣고 아는 답이 나오나 보는 것**이다.

## 무엇을 재나

1. `lab_to_user1` 이 손계산과 맞나 — 파일(`robot-base-in-tag.json`)에서 바로 유도한다
2. **왕복** — lab→user1→lab 이 제자리로 오나 (부호·회전 방향 실수를 잡는다)
3. **fail-closed** — user1 원점이 없으면 **답을 내면 안 된다.** 위 실사고 그 자리다
4. 쌍둥이 상수 — `AMR_TAG_ID` 가 브리지와 산출기에서 같나
5. 화면 쪽 값 넘겨주기 — `frames.mjs` 가 받아 두 사슬을 맞춰 본다 (`--emit`)
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))

CONFIG = ROOT / "Shared/data/config"
fails = []


def ok(cond, name, got=None):
    if cond:
        print(f"  OK   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  — 받은 값 {got}" if got is not None else ""))


def near(a, b, tol):
    return abs(float(a) - float(b)) <= tol


def main():
    import fixture

    base = json.loads((CONFIG / "robot-base-in-tag.json").read_text(encoding="utf-8"))
    # 실기에서 읽은 값 — `coordDefs.user`. 게이트는 로봇에 안 붙으므로 실측값을 박는다.
    # 바뀌면 여기도 바뀌어야 한다(그게 이 게이트가 하는 일이다 — 조용히 갈라지지 않게).
    USER1 = [-401.846, 497.329, 342.076, -0.005, 0.0, 0.001]

    # ① 손계산과 맞나 — lab 원점을 넣으면 베이스에서 로봇이 어디 있나의 **부호 반대**가 나온다
    th = math.radians(base["yawDeg"])
    c, s = math.cos(th), math.sin(th)
    dx, dy, dz = -base["xMm"], -base["yMm"], -base["zMm"]
    want_base = [c * dx + s * dy, -s * dx + c * dy, dz]
    got = fixture.lab_to_user1([0, 0, 0], base, [0, 0, 0])
    ok(all(near(g, w, 1e-6) for g, w in zip(got, want_base)),
       "lab 원점 → 베이스 가 손계산과 같다", [round(float(v), 3) for v in got])

    # ② 왕복 — user1 을 빼고 다시 더하면 제자리
    P = [123.4, -56.7, 8.9]
    u = fixture.lab_to_user1(P, base, USER1)
    back_base = [u[i] + USER1[i] for i in range(3)]
    d = [back_base[0] - want_base[0], back_base[1] - want_base[1], back_base[2] - want_base[2]]
    # 역회전해 lab 로 되돌린다
    lab_again = [c * d[0] - s * d[1], s * d[0] + c * d[1], d[2]]
    ok(all(near(a, b, 1e-6) for a, b in zip(lab_again, P)), "lab→user1→lab 이 제자리", lab_again)

    # ③ ⛔ **fail-closed** — user1 을 모르면 답을 내면 안 된다 (2026-08-28 실사고 그 자리).
    # `follow_target` 은 브리지 상태를 타므로 여기서는 **그 규칙이 코드에 있나**를 본다.
    main_src = (ROOT / "FR5/bridge/main.py").read_text(encoding="utf-8")
    ok('user = ((getattr(session, "coordDefs", None) or {}).get("user"))' in main_src,
       "follow_target 이 coordDefs.user 를 정본으로 읽는다")
    ok("user1 원점을 모른다" in main_src,
       "user1 이 없으면 표적을 안 낸다 (fail-closed)")
    ok("getattr(session, \"user1\"" not in main_src,
       "없는 속성 session.user1 을 다시 찾지 않는다")

    # ④ 쌍둥이 상수 — 태그를 갈면 두 곳을 같이 고쳐야 한다
    import re
    def const_of(path, name):
        m = re.search(rf"^{name} = (\d+)$", (ROOT / path).read_text(encoding="utf-8"), re.M)
        return int(m.group(1)) if m else None
    a = const_of("FR5/bridge/follow.py", "AMR_TAG_ID")
    b = const_of("scripts/map/amr-pose.py", "AMR_TAG_ID")
    ok(a is not None and a == b, f"AMR_TAG_ID 쌍둥이가 같다 (브리지 {a} · 산출기 {b})")
    spec = json.loads((ROOT / "Shared/assets/tag/tags.json").read_text(encoding="utf-8"))
    sizes = {t["id"]: t.get("measuredMm") for t in spec.get("fixtureTags", [])}
    ok(sizes.get(a) is not None, f"tags.json 에 id{a} 의 measuredMm 가 있다", sizes.get(a))

    # ⑤ 화면 쪽이 맞춰 볼 수 있게 값을 넘긴다
    if "--emit" in sys.argv:
        # ⚠ **읽는 참조가 아니라 쓰는 대상**이다 — `--emit` 일 때만 생긴다(gitignore)
        (ROOT / "scripts/check/.frames-chain.json").write_text(json.dumps({
            "base": base, "user1": USER1[:3],
            "labOriginInBase": [round(float(v), 4) for v in want_base],
        }, ensure_ascii=False), encoding="utf-8")

    print(f"  — {'실패 ' + str(len(fails)) if fails else '전부 통과'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
