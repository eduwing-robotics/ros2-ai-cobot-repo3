#!/usr/bin/env python3
"""손목캠 창구 — **깊이로 터틀봇을 찾아 `wrist-pose.json` 에 쓴다** (2026-09-04 · D177).

    python3 scripts/map/wrist-find.py                     # 한 번 찾아 보고만 한다
    python3 scripts/map/wrist-find.py --json
    python3 scripts/map/wrist-find.py --watch --out <경로>  # 상주 · 파일로 낸다

## 왜 만드나 — 폰이 꺼지면 표적이 언다

추종의 표적 창구가 셋(`amr`·`anchor`·`color`) 다 **글로벌캠(폰) 산출물**이었다. 2026-09-04 에
폰이 꺼져 `carrier-pose.json` 이 **71분**을 얼어붙었고, 그동안 팔은 사유만 냈다.
실기 담당자 *"글로벌카메라없이도 추종가능할지"* 의 답이 이 파일이다.

⭐ **태그를 안 쓴다.** 글로벌캠 태그 18 은 84mm 가 1126mm 밖이라 **45초에 2회(7%)** 만
잡혔다. 손목캠은 **337mm** 에서 라이다 윗면 **평면**을 직접 재 16,395점을 얻는다 —
같은 물건을 보는데 화소가 열 배다.

## 무엇을 표적으로 삼나 — **라이다 윗면**이지 거치대가 아니다

⛔ **거치대는 깊이로 못 잡는다.** **구멍 판**이라 구멍마다 스테레오가 깨진다 — 09-04 실측에서
평면 RMS **13mm**(정상 <2mm)에 `depth-probe` 가 *"솟은 것이 없다"* 를 냈다.
라이다 윗면은 같은 프레임에서 **지름 106mm** 로 잡힌다. **재는 것과 집는 것을 가른다.**

## ⛔ 계약이 못 박은 것 둘

1. **`camLab` 을 안 지난다** — 사슬이 `camera → tcp → base → user1` 이라 글로벌캠 쪽
   `unknown` 갈래와 무관하다. 환산은 `follow.cam_to_robot`(hand-eye) 하나를 그대로 부른다
2. **못 보면 안 쓴다** — 덩어리가 의심스러우면 `anchors` 를 **비우고** `why` 만 낸다.
   옛 값을 남기면 추종이 **모르는 자리로 팔을 보낸다** (계약 §못 보면)

## ⚠ `standoffMm` 을 그대로 쓰면 안 된다

프로필의 165 는 **거치대 윗면** 기준이다. 라이다 윗면은 그보다 77mm 높아 카메라가 D435 의
Min-Z **195mm** 안으로 들어가고, 그러면 덩어리가 통째로 잘린다(2026-08-12 에 그 병으로
92.35mm 라는 「우연히 맞은 잘린 값」이 나왔다). **`wrist` 를 쓸 때는 220** 으로 올린다.
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/robot"))
sys.path.insert(0, str(ROOT / "FR5/bridge"))


def _measure_mod():
    """`amr-pair.py` 의 `measure` 를 **그대로 빌린다** — 같은 산수를 두 벌 갖지 않는다.

    그쪽에는 **변환 자기검증**(`follow.cam_to_robot` 대조)과 덩어리 지름 검사가 이미 들어
    있다. 여기서 다시 짜면 한쪽만 고쳐지고, 그 순간 창구와 계측기가 다른 말을 한다.
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location("amrpair", ROOT / "scripts/robot/amr-pair.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# ⛔ **바퀴와 이만큼 넘게 어긋나면 안 낸다** (2026-09-04 · D178 · 실측으로 물렸다).
# 지름 검사(60~200mm)만으로는 **태그판**을 못 거른다 — 터틀봇이 화각에 아예 없는데
# 추적기가 검은 매트 위 흰 태그판을 물고 `0.2초 신선한` 표적을 자신 있게 냈다.
# 그때 바퀴 예측과 **668mm** 어긋나 있었다. 「이름은 맞는데 값이 틀린」(D155) 그 모양이다.
#
# 문턱을 왜 300 으로 잡나 — `AMR_HOME` 자체가 실측 대비 **140mm** 어긋나 있고(09-04),
# 화각 반경이 약 250mm 다. 둘을 합쳐도 못 넘는 값이면서 태그판(668mm)은 확실히 자른다.
# ⚠ 눈금(`AMR_HOME`)을 고치는 날 이 값을 **줄인다** — 느슨한 채로 두면 가드가 무뎌진다.
ODOM_AGREE_MAX_MM = 300.0


def setup(ap):
    """한 번만 받는 재료. **상주가 매 판 다시 받지 않게** 갈라 둔다.

    ⛔ 이걸 루프 안에 두면 매 판 `node` 를 띄워 주기가 10초를 넘고, 그러면 브리지가
    **매번 「낡았다」로 거부한다**(상한 2.5초). 2026-09-04 첫 판이 정확히 그랬다 —
    `color-find.py` 가 같은 이유로 `setup()` 을 갈라 놓은 것을 안 따랐다.
    """
    w = ap.sjs("workcell.js", "AMR_HOME", "AMR_TAG")
    home, tag = w["AMR_HOME"], w["AMR_TAG"]
    return {"tag": tag, "home": home,
            "lidarZ": home["topZMm"] + float(tag["offsetMm"]["z"])}


def odom_predicted(pose, home, tag):
    """바퀴가 말하는 **라이다 윗면**의 user1 자리. `aim-carrier` 와 같은 산수다."""
    import math
    th = math.radians(float(pose["yawDeg"]))
    o = tag["offsetMm"]
    ox = pose["xMm"] + float(o["x"]) * math.cos(th)
    oy = pose["yMm"] + float(o["x"]) * math.sin(th)
    c, s = math.cos(math.radians(home["yawDeg"])), math.sin(math.radians(home["yawDeg"]))
    return [c * ox - s * oy + home["xMm"], s * ox + c * oy + home["yMm"]]


def locate(fr5, cam, ap, ctx, state_fn=None):
    """지금 한 판 찾는다 → `(hit, 사유)`. **상주와 CLI 가 이 하나를 같이 쓴다.**"""
    got, why = ap.measure(fr5, cam, ctx["tag"], ctx["lidarZ"], state_fn=state_fn)
    if got is None:
        return None, why

    # ⭐ **바퀴와 대조한다** — 깊이만으로는 「라이다 윗면처럼 생긴 것」을 못 가른다(위 §문턱).
    # 바퀴는 화각과 무관한 **독립 출처**라, 둘이 크게 어긋나면 하나는 거짓이다. 그러면 안 낸다.
    try:
        pose = ((ap.get(f"{fr5}/state").get("follow") or {}).get("amr") or {}).get("pose")
    except Exception:                                # noqa: BLE001 — 못 물어보면 대조를 건너뛴다
        pose = None
    if pose:
        import math
        pred = odom_predicted(pose, ctx["home"], ctx["tag"])
        d = math.dist(got["user1Mm"][:2], pred)
        if d > ODOM_AGREE_MAX_MM:
            return None, (f"바퀴와 {d:.0f}mm 어긋난다 (상한 {ODOM_AGREE_MAX_MM:.0f}) — "
                          f"깊이가 문 것이 터틀봇이 아니다. 바퀴 예측 "
                          f"[{pred[0]:.0f}, {pred[1]:.0f}] · 깊이 {got['user1Mm'][:2]}")
    return {"user1Mm": got["user1Mm"], "labMm": None,
            "points": got["points"], "diaMm": got["diaMm"],
            "t": time.time(), "errPx": None,
            "note": "손목 뎁스 — 라이다 윗면 평면 (태그 없이 · camLab 안 지남)"}, None


def write_out(path, tag_id, hit, why):
    """산출은 **원자적으로** — 반쯤 쓴 파일을 브리지가 안 읽게 (`color-find.py` 와 같은 규약)."""
    doc = {"_": "손목캠 깊이 검출 — `wrist-find.py` 산출. **태그가 아니다**",
           "_주의": "터틀봇 **라이다 윗면**이다. 거치대가 아니다 — 거치대는 구멍 판이라 깊이가 깨진다",
           "_사슬": "camera → tcp → base → user1 (hand-eye) · **camLab 을 안 지난다**",
           "anchors": ({str(tag_id): hit} if hit else {}), "why": why}
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(p)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--fr5", default="192.168.30.6:5055")
    a.add_argument("--cam", default="192.168.30.6:5058")
    a.add_argument("--tag", type=int, default=18, help="터틀봇 번호 (`tags.json` §fixtureTags)")
    a.add_argument("--out", default=str(ROOT / "Shared/data/config/wrist-pose.json"))
    a.add_argument("--watch", action="store_true")
    a.add_argument("--period", type=float, default=1.0)
    a.add_argument("--json", action="store_true")
    p = a.parse_args()
    ap = _measure_mod()
    fr5, cam = f"http://{p.fr5}", f"http://{p.cam}"
    ctx = setup(ap)

    while True:
        try:
            hit, why = locate(fr5, cam, ap, ctx)
        except Exception as e:                       # noqa: BLE001 — 상주가 한 판에 안 죽는다
            hit, why = None, f"읽기 실패 — {str(e)[:120]}"
        if p.watch or p.json:
            write_out(p.out, p.tag, hit, why)
        if p.watch:
            pass                                     # 상주는 조용히 — 파일이 산출이다
        elif p.json:
            print(json.dumps({"hit": hit, "why": why}, ensure_ascii=False))
        elif hit:
            print(f"✅ 라이다 윗면 user1 {hit['user1Mm']}  ({hit['points']}점 · 지름 {hit['diaMm']}mm)")
        else:
            print(f"⛔ {why}")
        if not p.watch:
            return 0 if hit else 1
        time.sleep(p.period)


if __name__ == "__main__":
    sys.exit(main())
