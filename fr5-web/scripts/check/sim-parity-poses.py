#!/usr/bin/env python3
"""경계 자세를 **실기 게이트로** 판정해 픽스처를 굽는다 (상한 N · 지금 283). 판정은 여기서만 한다.

`Sim/` 은 `FR5/bridge` 를 import 하지 않는다 (SIM-CONTRACT 불변식 1). 그래서 대조는
"양쪽을 한 프로세스에서 부른다" 가 아니라 **정본이 답을 파일로 굽고 사본이 맞춰 보는**
모양이다. 이 파일이 정본 쪽이다 — `scripts/check/sim-parity.mjs` 가 부른다.

**표본은 무작위가 아니다.** 두 정의가 갈리는 자리는 언제나 경계다 — 상판 모서리,
벽에서 여유거리 안팎, 선분 끝 너머, 원점 반대편. 무작위로 뿌리면 쉬운 자리만 맞고
지나간다. 그래서 경계를 **일부러** 노려 뽑고 남는 자리만 난수로 채운다.

⛔ 사유 **문장**을 픽스처에 싣지 않는다. 문장은 사람 몫이고 조사까지 맞춰져 있어
한 글자만 바뀌어도 대조가 거짓으로 빨개진다. 여기서 `(규칙, 이름)` 으로 분류해 싣고,
**분류가 안 되는 문장이 나오면 죽는다** — 규칙이 늘었는데 사본이 모르는 상태이기 때문이다.
"""
import json
import math
import pathlib
import random
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "FR5/bridge"))
import safety  # noqa: E402  — 경로를 넣은 뒤라야 보인다

import yaml  # noqa: E402

SEED = 20260811
# **상자·벽 수에 따라 자동으로 는다** — 상자 하나가 4×4×3 = 48 자세, 벽 하나가 6×7 = 42 다.
# 2026-08-18 에 작업대가 한 판 → 세 판이 되며 상자가 2 → 4 가 됐고 187 → 283 으로 뛰었다.
# ⛔ **자르지 않고 상한을 올린다** — 자르면 안 잰 규칙이 생기고, 그건 초록이 거짓이 되는 길이다.
# 여유는 상자 두 개(96) 몫이다. 또 넘치면 그때도 **줄이지 말고 올린다**.
N = 400
ROBOT = "fr5-lab-a"          # **실측 프로필이다** — mock 값으로 대조하면 아무것도 안 잰다

# 손끝 방향 `[rx, ry, rz]` (도 · 고정축 XYZ). 툴이 아래·위·옆을 골고루 보게 섞는다.
# 마지막 하나는 **실기 표본**과 같은 계열이다 (`Sim/fixtures/fr5-lab-a.json` fkSamples).
ROTS = [[0.0, 0.0, 0.0],          # 툴이 −z 로 — 실제 작업 자세에 가깝다
        [180.0, 0.0, 0.0],        # 툴이 +z 로
        [90.0, 0.0, 0.0],
        [0.0, 90.0, 0.0],
        [126.05, 35.54, 107.50]]


def profile():
    cfg = yaml.safe_load((ROOT / "FR5/bridge/config.yaml").read_text())
    for r in cfg.get("robots", []):
        if r.get("robotId") == ROBOT:
            return r["workspace"]
    raise SystemExit(f"프로필을 못 찾았다: {ROBOT}")


def poses(ws):
    """경계를 노린 자세 + 난수 채움. `random.Random(SEED)` 이라 매번 같은 200개다.

    ⚠ **경계 자세를 뒤에서 자르지 않는다.** 처음에 상판 격자만으로 정확히 200개가 차서
    벽·결측 자세가 통째로 잘렸고, 그래도 게이트는 `200/200 일치` 로 초록을 냈다
    (2026-08-11). **제일 어려운 규칙이 안 재진 채 통과하는 것**이 이 파일의 최대 위험이라,
    난수는 남는 자리에만 붓고 모자라면 죽는다.
    """
    out = []
    # 자세마다 **다른 방향**을 물린다. 전부 같은 방향이면 툴 규칙의 한 갈래만 재고 지나간다 —
    # 위 경고("제일 어려운 규칙이 안 재진 채 통과")가 방향 축에서도 그대로 성립한다.
    def rot():
        return ROTS[len(out) % len(ROTS)]

    # ── 상판: 네 옆면과 윗면을 ±1mm 로 넘나든다. 높이는 여유선 바로 위/아래를 본다
    for b in ws.get("boxes") or []:
        (x0, x1), (y0, y1) = b["xMm"], b["yMm"]
        floor = b["topZMm"] + b.get("marginMm", 0)
        xs = [x0 - 1, x0 + 1, (x0 + x1) / 2, x1 + 1]
        ys = [y0 - 1, y0 + 1, (y0 + y1) / 2, y1 + 1]
        for x in xs:
            for y in ys:
                for z in (floor - 50, floor - 0.5, floor + 0.5):
                    out.append([x, y, z, *rot()])
    # ── 벽: 선분을 따라가며 법선 방향으로 여유 안팎, 그리고 **원점 반대편**까지 넘어간다
    for w in ws.get("walls") or []:
        ax, ay = w["aMm"]
        bx, by = w["bMm"]
        m = w.get("marginMm", 0)
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / L, dx / L                      # 선분에 수직인 단위벡터
        for t in (-0.2, 0.0, 0.35, 0.7, 1.0, 1.2):
            px, py = ax + t * dx, ay + t * dy
            for off in (-(m + 40), -(m + 1), -(m - 1), 0.0, m - 1, m + 1, m + 40):
                out.append([px + nx * off, py + ny * off, -300.0, *rot()])
    # ── 못 읽는 손끝 — 결측=차단이 양쪽에서 같은지 본다 (NaN 은 JSON 을 깨므로 안 쓴다)
    out += [["x", 0.0, 0.0], [1.0, 2.0], [], [None, 1.0, 2.0]]
    # ── 방향이 빠진 손끝 — **툴 규칙의 결측=차단.** 위치는 멀쩡하므로 손끝 규칙은 통과하고
    #    툴 규칙만 차단해야 한다. 이 갈래가 없으면 `toolOrientMissing` 이 안 재진다
    out += [[400.0, -400.0, -100.0],                       # 셋뿐
            [400.0, -400.0, -100.0, 0.0, 0.0],             # 다섯뿐
            [400.0, -400.0, -100.0, None, 0.0, 0.0]]       # 값이 숫자가 아니다
    if len(out) > N:
        raise SystemExit(f"경계 자세가 {len(out)}개로 N={N} 을 넘었다 — 자르면 안 잰 규칙이 "
                         f"생긴다. N 을 올리거나 격자를 줄여라")
    rng = random.Random(SEED)
    while len(out) < N:
        out.append([rng.uniform(-1500, 1500), rng.uniform(-2600, 400), rng.uniform(-600, 900),
                    *rot()])
    return out


def joint_sets(n):
    """자세마다 물릴 **관절각**. 팔 판정은 손끝이 아니라 여기서 나온다.

    ⚠ **손끝 좌표와 물리적으로 맞을 필요가 없다.** 대조가 재는 것은 「같은 입력에 두 구현이
    같은 답을 내나」이지 「그 입력이 실재하는 자세인가」가 아니다. 손끝 자세는 구역 경계를
    노려 뽑았고(위 `poses`), 관절은 팔이 구역을 드나들도록 따로 뽑는다 — 둘을 억지로 맞추려면
    역기구학이 필요하고, 그건 이 파일이 지불할 값이 아니다.

    관절 한계 안에서 뽑으면 팔이 구역에 드는 비율이 3할쯤이다 (2026-08-11 실측) — 경계가
    저절로 채워진다. 마지막 넷은 **결측=차단** 갈래다.
    """
    rng = random.Random(SEED + 1)
    out = [[rng.uniform(lo, hi) for lo, hi in safety.JOINT_LIMITS_DEG] for _ in range(n - 4)]
    out += [None,                                   # 아예 없다
            [0.0, 0.0, 0.0],                        # 셋뿐
            [0.0] * 5 + ["x"],                      # 숫자가 아니다
            [0.0] * 5 + [None]]
    return out


def classify(reason, ws):
    """사유 문장 → `(규칙, 이름)`. **모르는 문장이면 죽는다.**"""
    if "손끝 위치를 못 구했다" in reason:
        return ("tcpUnreadable", None)
    if "좌표계가 잴 때와 다르다" in reason:
        return ("frame", None)
    # ⚠ **툴을 먼저 가른다.** 툴 사유에도 "조건 12" 가 들어 있어 아래 손끝 패턴에 걸린다 —
    #    순서를 바꾸면 툴 위반이 손끝 위반으로 분류되고, 사본은 그 거짓에 맞춰 초록이 된다
    if "손끝 방향(rx·ry·rz)이 없다" in reason:
        return ("toolOrientMissing", None)
    if "툴 형상을 못 읽었다" in reason:
        return ("toolHullMissing", None)
    if "팔 형상을 못 읽었다" in reason:
        return ("armHullMissing", None)
    if "유저 좌표계 원점을 모른다" in reason:
        return ("armFrameMissing", None)
    if "관절각을 못 구했다" in reason:
        return ("armJointsMissing", None)
    if reason.startswith("링크 ") and "자세를 못 구했다" in reason:
        return ("armLinkMissing", None)
    for tag, wall_rule, box_rule in (("조건 12 · 툴", "toolWall", "toolBox"),
                                     ("조건 12 · 팔", "armWall", "armBox")):
        if tag not in reason:
            continue
        for w in ws.get("walls") or []:
            name = w.get("name", "벽")
            if reason.startswith(f"{name}에 "):
                return (wall_rule, name)
        for b in ws.get("boxes") or []:
            name = b.get("name", "상판")
            if reason.startswith(name) and "뚫는다 — " in reason:
                return (box_rule, name)
    for w in ws.get("walls") or []:
        name = w.get("name", "벽")
        if reason.startswith(f"{name} 값이 선분이 아니다"):
            return ("wallMalformed", name)
        if reason.startswith(f"{name}에 ") and "조건 12" in reason:
            return ("wall", name)
    for b in ws.get("boxes") or []:
        name = b.get("name", "상판")
        if reason.startswith(name) and "뚫는다 — 손끝 z" in reason:
            return ("box", name)
    raise SystemExit(f"분류 못 한 거부 사유 — 규칙이 늘었는데 사본이 모른다:\n  {reason}")


def main():
    ws = profile()
    want = ws.get("frame") or {}
    # 대부분은 잰 좌표계 그대로, 열 개는 **일부러 어긋나게** 준다 — 그 분기도 사본이 같아야 한다
    ok_coord = {"toolId": want.get("toolId"), "userId": want.get("userId")}
    bad_coord = {"toolId": (want.get("toolId") or 0) + 7, "userId": want.get("userId")}
    # 유저 좌표계 원점 — **실기에서 구운 값**을 쓴다 (팔 FK 가 베이스 기준이라 필요하다).
    # 열 개는 일부러 비워 `armFrameMissing` 갈래도 대조한다.
    fx = json.loads((ROOT / "Sim/fixtures" / f"{ROBOT}.json").read_text(encoding="utf-8"))
    ok_defs = {"user": fx["coordDefs"]["user"]}
    jsets = joint_sets(N)
    cases = []
    for i, p in enumerate(poses(ws)):
        coord = bad_coord if i % 20 == 19 else ok_coord
        defs = {} if i % 25 == 24 else ok_defs
        joints = jsets[i]
        reasons = safety.check_workspace(p, ws, coord, joints, defs)
        cases.append({"tcpMm": p, "coord": coord, "jointsDeg": joints, "coordDefs": defs,
                      "verdicts": [{"rule": r, "name": n}
                                   for r, n in (classify(x, ws) for x in reasons)]})
    # ── 망가진 프로필 — `wallMalformed` 는 정상 값으로는 절대 안 난다. 그런데 **안 나는
    # 규칙은 안 재진 규칙**이라, 벽 하나의 두 끝점을 같게 만들어 그 분기도 대조한다
    broken = json.loads(json.dumps(ws))
    if broken.get("walls"):
        broken["walls"][0]["bMm"] = list(broken["walls"][0]["aMm"])
    broken_cases = [{"tcpMm": p, "coord": ok_coord, "jointsDeg": jsets[0], "coordDefs": ok_defs,
                     "verdicts": [{"rule": r, "name": n}
                                  for r, n in (classify(x, broken)
                                               for x in safety.check_workspace(
                                                   p, broken, ok_coord, jsets[0], ok_defs))]}
                    for p in ([0.0, -500.0, -300.0], [1050.0, -600.0, -300.0])]

    # `n` 을 같이 낸다 — 대조 쪽이 숫자를 **베껴 적지 않게** 한다 (2026-08-18).
    # 200 을 손으로 박아 뒀더니 상자가 늘자 게이트가 거짓으로 붉었다.
    out = {"robotId": ROBOT, "seed": SEED, "n": N, "workspace": ws, "cases": cases,
           "brokenWorkspace": broken, "brokenCases": broken_cases,
           "bakedBy": "scripts/check/sim-parity-poses.py"}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
