# fr5-bridge — FAIRINO FR5 의 유일한 관문 (API-CONTRACT.md 가 정본이다. 어긋나면 문서부터 고친다).
# 실행: bash scripts/dev/fr5-dev.sh  (준비물 없음 — 순수 파이썬 SDK · D42)
# 배포: npm run build:fr5 뒤 이 서버가 FR5/dist 를 같은 주소에서 서빙한다 —
# 주소를 여는 누구나 조작 후보다 (LAN·팀 신뢰). 보호는 조종권 1명·게이트·stop 상시가 맡는다.
#
# **여기는 조립과 라우트만 둔다** (D54 · tb-bridge 와 같은 모양 — 라우터를 안 쓴다).
# 상태와 I/O 는 도메인 모듈이 소유한다 — RobotSession(session) · Owner(owner) ·
# Commands(commands) · TeachService(teach) · 어댑터(robot_adapter/).
import asyncio
import copy
import json
import math
import os
import sys
import time
from pathlib import Path

import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import amr
import anchors
import fixture
import follow
import preflight
import safety
from commands import GRIPPER_FORCE_PCT, Commands
from owner import Owner
from robot_adapter import make_adapter
from runs import RunStore
from session import RobotSession
from slots import SlotStore
from teach import TeachService, frame_mismatch, run_recording

HERE = Path(__file__).parent
# 인코딩을 명시한다 — 윈도우 한국어 로케일의 기본은 cp949 라 한글 주석에서 터진다 (2026-08-11)
CONFIG = yaml.safe_load((HERE / "config.yaml").read_text(encoding="utf-8"))


def _borrow(cfg):
    """`borrowFrom: <robotId>` 인 프로필에 그 로봇의 작업영역·설정·hand-eye 를 **그대로** 채운다 (2026-09-06 · `fr5-mock-lab`).

    YAML 앵커로 하면 `Sim/scene/build-scene.mjs` 같은 줄 단위 손파서가 `&앵커` 줄을 못 읽는다 — 그래서 빌림은
    브리지가 로드 때 한 번 한다. 자기 값이 있으면 그것이 이기고(덮지 않는다), 가리킨 로봇이 없으면 **죽는다** —
    빌리려던 작업영역이 조용히 빠지면 게이트가 없는 채로 돈다."""
    by_id = {r.get("robotId"): r for r in cfg.get("robots") or []}
    keys = ("workspace", "settings", "handEye")

    # 빌리는 쪽이 또 빌린 프로필이면 **그쪽을 먼저 푼다** — 단일 패스로 YAML 순서에 기대면 C→B→A 순서일 때 C 가 「해소 전」
    # B 를 빌려 작업영역이 조용히 빠졌다(감사 2026-09-06 ①-2). 순환은 방문 집합으로 잡아 죽인다
    def resolve(r, seen):
        src_id = r.get("borrowFrom")
        if not src_id:
            return
        if src_id in seen:
            raise SystemExit(f"config.yaml: borrowFrom 이 돈다 — {' → '.join(seen)} → {src_id}")
        src = by_id.get(src_id)
        if src is None:
            raise SystemExit(f"config.yaml: {r.get('robotId')} 가 빌리려는 {src_id} 프로필이 없다")
        resolve(src, seen + [src_id])
        for k in keys:
            if k not in r and k in src:
                r[k] = copy.deepcopy(src[k])
        missing = [k for k in keys if k not in r]
        if missing:
            raise SystemExit(f"config.yaml: {r.get('robotId')} 가 {src_id} 에서 못 빌렸다 — {missing} 가 어디에도 없다")

    for r in cfg.get("robots") or []:
        resolve(r, [r.get("robotId")])
    return cfg


CONFIG = _borrow(CONFIG)
PROFILES = {r["robotId"]: r for r in CONFIG["robots"]}
SAMPLE_MS = CONFIG.get("sample_ms", 33)
# 어댑터 한 호출(read_state·stop·connect)의 무응답 상한 (감사 #5). 블랙홀 단선이면 소켓이
# RST 없이 매달려 스트림이 얼어붙고 stop 까지 늦는다 — 넘으면 연결 손실로 판정해 fail-closed.
# ponytail: wait_for 는 멈춘 스레드를 못 죽인다 — 완전한 해결은 어댑터 소켓 타임아웃이다
# (robot_adapter/, GAP OPEN). 여기선 **탐지해 fail-closed** 까지만 한다.
ROBOT_TIMEOUT_S = CONFIG.get("robot_timeout_ms", 2000) / 1000
# 프리플라이트만 따로 — 실측 3.0~3.8초라 2000 을 같이 쓰면 사유 없이 잘린다 (2026-08-10, config.yaml)
CONNECT_TIMEOUT_S = CONFIG.get("robot_connect_timeout_ms", 10000) / 1000
# 검증이 사람의 진짜 데이터에 쓰지 않게 env 로 갈아 끼운다 (`FR5_DATA_DIR`).
# 운영에서는 안 쓴다 — 정본은 config.yaml 이다.
DATA_DIR = Path(os.environ.get("FR5_DATA_DIR") or CONFIG.get("data_dir", "~/fr5-data")).expanduser()
# 녹화 주기는 **폴링 주기의 절반**이다 (33ms 폴링 → 15fps). 같은 속도로 적으면 결손이
# 필연이다 — 상태 스트림 실측이 27Hz 남짓이라 30fps 격자에는 빈 칸이 생기고(검증에서 3칸),
# 그러면 `measure` 궤적이 전부 비교에서 빠진다. 표본보다 성기게 적어야 `fps` 가 참이 된다.
REC_FPS = max(1, round(1000 / SAMPLE_MS / 2))

app = FastAPI(title="fr5-bridge")


# ⚠ **윈도우 호스트에서 로그가 명령을 죽였다** (2026-08-11 실기 · 로그 트레이스백으로 확인).
# 콘솔 코드페이지가 **cp949** 라 거부 사유에 쓰는 한글 대시 `—`(U+2014)를 못 써서
# `print` 가 `UnicodeEncodeError` 를 던졌고, 그 예외가 `commands.motion` → `jog` →
# 웹소켓 핸들러까지 올라가 **명령 처리 전체가 터졌다.** 즉 「거부」가 「크래시」로 바뀌어
# 화면은 아무 사유도 못 받았다 — 우리 거부 문구는 거의 다 `—` 를 쓰므로 **윈도우에서는
# 모든 거부가 크래시**였다. (로봇은 안 움직였다. 거부는 `move_j` 앞이다.)
#
# 두 겹으로 막는다. 하나만으로는 부족하다:
#   ① 출력 인코딩을 UTF-8 로 고정한다 (플랫폼이 안 받아 주면 조용히 지나간다)
#   ② 그래도 못 쓰면 **문자를 바꿔서라도 찍는다** — 로그 실패가 명령 실패가 되면 안 된다
try:                                     # 파이썬 3.7+ · 윈도우 cp949 콘솔 대비
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:                        # 못 바꿔도 아래 log 의 방어가 남는다
    pass


def log(event, detail=""):
    # 재연결·fail-closed·명령 기록 — stdout. 영속 기록은 사다리 4(History)에서 승격한다
    line = f"[fr5-bridge] {time.strftime('%H:%M:%S')} {event} {detail}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:           # 위 ② — 사유를 잃어도 명령은 산다
        print(line.encode("ascii", "backslashreplace").decode("ascii"), flush=True)


# 연결은 한 번에 하나 — 명령 주인이 한 명이듯 관문의 로봇도 하나다 (하드룰 4)
session = RobotSession(SAMPLE_MS, log)
cmds = Commands(session, log)
teach = TeachService(DATA_DIR, REC_FPS, log)
slots = SlotStore(DATA_DIR)
recordTask = None


def _owner_lost(who):
    # 조종권 소실 = 즉시 disarm — 주인 없는 ARMED 를 남기지 않는다
    if session.armed:
        session.disarm_hw(f"조종권 소실({who})")


owner = Owner(_owner_lost, lambda e, d: log(e, d))


def refuse(reasons, status=409):
    return JSONResponse(
        {"ok": False, "phase": session.current_phase(owner.get()), "reasons": reasons},
        status_code=status,
    )


# ── 추종 스위치 (계약 `VISION-CONTRACT.md` §추종 · D132) ─────────────────────
#
# **기본 꺼짐이다** (조건 1). 부팅하며 저절로 돌지 않는다 — 켜는 순간을 사람이 안다.
# ⛔ **켜졌다고 움직이는 것이 아니다.** 매 틱 조건 3·4·5 를 다시 본다. 특히
# **조건 5(표적을 지금 보고 있다)** 는 비전이 좌표를 줄 때만 참이다. 좌표는 밖에서 온다 —
# `scripts/map/amr-pose.py --watch` 가 글로벌캠으로 태그 18 을 풀어 `amr-pose.json` 에 적고
# 브리지는 **그 파일만 읽는다** (§follow_target). 그 산출기가 안 돌면 켜도 **사유만 내고
# 안 움직인다.** 그게 옳다 — 표적을 못 보는데 팔을 휘두르면 실물이 없는 자리로 간다.
# ⛔ **아직 움직임은 안 붙었다** (2026-08-28 · 단계 1/3). 지금은 표적을 **보여주기만** 한다.
follow_switch = follow.Switch()


def follow_cfg():
    # 프로필의 `follow:` 를 읽는다. **기본값을 코드에 두지 않는다** (계약 §기준값은 프로필에 산다)
    return follow.read_config(getattr(session, "profile", None) or {})


# 표적이 늙으면 **표적이 아니다.** 터틀봇은 달리므로 옛 자리는 「지금 거기 있다」가 아니다.
# 1초 주기로 쓰는 산출기(`amr-pose.py --watch`)를 두 판 놓칠 때까지만 봐 준다.
FOLLOW_TARGET_MAX_AGE_S = 2.5
# 바퀴(odom)는 **끊기지 않는다** — 이 상한을 넘으면 터틀봇이 죽었거나 랜이 막힌 것이다.
# 태그 상한보다 넉넉한 이유는 태그와 성질이 달라서다: 태그는 「낡으면 틀린 자리」지만
# 바퀴는 「낡으면 아예 없는 값」이다 (2026-08-31 · D158)
FOLLOW_ODOM_MAX_AGE_S = 3.0


# 창구 — `targetSource` 가 고른다 (계약 §무엇을 따라가나). 파일이 갈린 이유는 **나이 규칙이
# 달라서**다: 달리는 로봇은 못 보면 값이 사라져야 하고(`amr-pose.json`), 소품은 옛 값이
# 남아야 게이트가 계속 막는다(`scene-anchors.json` · D130). **읽는 쪽이 더 엄한 쪽을 쓴다.**
FOLLOW_SOURCE_FILE = {"amr": "amr-pose.json", "anchor": "scene-anchors.json",
                      "color": "carrier-pose.json",
                      # 손목캠 — 계약 §`wrist`. **글로벌캠을 안 지나는 유일한 창구**다
                      "wrist": "wrist-pose.json"}


def follow_target_tag(cfg):
    """표적 **태그** 자리 → `(표적, 사유)`. **못 보면 `None`** — 조건 5 의 재료다.

    창구는 **파일 하나**다 (`amr-pose.json` · 계약 §창구). 브리지가 카메라를 직접 물지 않는
    이유는 받침(`fixture.py`)과 같다 — 검출은 밖에서 돌고 브리지는 **결과만** 읽는다.
    그래야 검출기가 죽어도 브리지가 안 죽고, 「못 본다」가 사유로 나온다.

    ⛔ **옛 값을 붙들지 않는다.** 받침은 안 보이면 마지막 값으로 계속 막는 게 옳지만(D130 —
    가만히 있는 물체라 그 자리에 그대로 있다), 달리는 로봇에 같은 규칙을 쓰면 **없는 로봇을
    쫓는다.** 나이를 넘기면 표적이 사라진다.
    """
    tag_id, src = int(cfg["targetTagId"]), cfg["targetSource"]
    name = FOLLOW_SOURCE_FILE[src]
    doc = fixture._read(str(CONFIG_DIR / name))
    if not doc:
        return None, f"표적 파일 {name} 이 없다 — 추적기가 안 돌고 있다"
    v = (doc.get("anchors") or {}).get(str(tag_id))
    if not v:
        return None, f"{name} 에 id{tag_id} 가 없다 — 추적 목록에 넣었는지 본다"
    age = time.time() - float(v.get("t") or 0)
    if age > FOLLOW_TARGET_MAX_AGE_S:
        # ⛔ **소품 파일은 옛 값을 남긴다** — 나이를 안 보면 팔이 그 옛 자리로 간다.
        # 사람이 물건을 옮기는 동안은 손이 태그를 덮으므로 **여기서 서는 것이 정상**이다.
        return None, (f"표적 id{tag_id} 가 {age:.1f}초 낡았다 — 상한 {FOLLOW_TARGET_MAX_AGE_S}초 "
                      f"(가려졌거나 안 보이는 중)")
    # ⭐ **출처마다 사슬이 다르다** (2026-09-04 · D177). 앞의 셋은 글로벌캠이 푼 `lab` 을
    # 주므로 아래에서 `lab → user1` 을 태워야 하지만, `wrist` 는 **손목캠 → hand-eye → user1**
    # 로 이미 도착해 있다 — 계약 §`wrist` 의 *"camLab 을 안 지난다"* 가 그 뜻이다.
    # ⛔ 그 record 의 `labMm` 은 `null` 이다. 여기서 갈라 두지 않으면 `lab_to_user1(None)`
    # 이 터진다 — 실기에서 `/state` 가 통째로 **500** 이 됐다 (09-04 에 물렸다).
    if v.get("labMm") is None and v.get("user1Mm") is not None:
        return {"labMm": None,
                "user1Mm": [round(float(x), 1) for x in v["user1Mm"]],
                "yawDeg": v.get("yawDeg"), "errPx": v.get("errPx"),
                "ageS": round(age, 1), "basis": v.get("basis"),
                "source": src}, None
    base = fixture._read(str(CONFIG_DIR / "robot-base-in-tag.json"))
    if not base:
        return None, "robot-base-in-tag.json 이 없다 — lab→로봇 환산을 못 한다"
    # ⛔ **user1 을 모르면 안 낸다** (2026-08-28 실측 — 여기서 한 번 틀렸다).
    # 처음엔 없는 속성(`session.user1`)을 찾다 `[0,0,0]` 으로 떨어져 **베이스 좌표를 user1
    # 이라 이름 붙여** 내보냈다. 홈에 선 터틀봇이 460·654·432mm 어긋나 보였고, 실기 담당자가
    # 「지금 위치는 원점」 한마디로 잡으셨다. 이름이 맞는데 값이 틀린 게 제일 나쁘다 —
    # 없으면 **없다고 말한다**(제1원칙). 정본은 `coordDefs.user` 다 (`session._coord_defs`).
    user = ((getattr(session, "coordDefs", None) or {}).get("user"))
    if not user:
        return None, "user1 원점을 모른다 — 로봇 미연결이거나 좌표계를 못 읽었다"
    p = fixture.lab_to_user1(v["labMm"], base, user)
    return {"labMm": [round(float(x), 1) for x in v["labMm"]],
            "user1Mm": [round(float(x), 1) for x in p],
            "yawDeg": v.get("yawDeg"), "errPx": v.get("errPx"),
            "ageS": round(age, 1), "basis": v.get("basis"),
            # ⛔ **출처를 반드시 글자로 낸다** (D155). 숫자는 같은 모양이어도 믿을 범위가
            # 다르다 — 태그는 절대·mm 급이고 색은 **평면에 쏜 값**이라 평면이 틀리면 같이
            # 틀린다. 라벨이 `tag` 로 굳어 있으면 화면이 그 차이를 못 말한다.
            "source": src}, None


def follow_target(cfg):
    """표적을 **두 출처**로 낸다 — 태그(절대·7%)와 바퀴(연속·밀린다). 계약 §조건 5 의 출처가 둘.

    태그가 보이면 그것이 정본이고, **그 순간 바퀴 값과 한 쌍으로 묶어 눈금을 고친다.**
    안 보이면 그 눈금으로 바퀴를 옮겨 잇는다.

    ⛔ **출처를 반드시 글자로 낸다.** 숫자는 같은 모양이어도 믿을 범위가 다르다 —
    「이름은 맞는데 값이 틀린」 사고(D155)가 가르친 것이다.
    ⛔ **눈금이 없으면 바퀴를 안 쓴다** — `AMR_HOME` 으로 몰래 갈아타지 않는다. 그건 각도기로
    잰 적 없는 가정값이고, 조용히 쓰면 어느 쪽이 답했는지 아무도 모른다.
    """
    tag, why_tag = follow_target_tag(cfg)

    # ⓪ 바퀴가 없는 표적(거치대 등) — **태그 하나뿐이고, 못 보면 멈춘다.**
    # 여기서 갈라 두지 않으면 거치대를 놓쳤을 때 **터틀봇 바퀴로 이어 붙인다** —
    # 「이름은 맞는데 값이 틀린」(D155) 사고가 정확히 이 모양이다.
    if cfg["targetSource"] != "amr":
        if tag is not None:
            return {**tag, "correctedAgoS": None, "fit": None, "odomAgeS": None}, None
        # ⭐ **재획득** — 표적을 잃으면 바퀴가 가리키는 곳으로 (계약 §재획득 · D180).
        # 실기 담당자 *"표적이 없어지면 터틀봇 위치로 알아서 찾아가야 하는 거 아닌가"*.
        # ⛔ **몰래 갈아타지 않는다** — `source: "odom"` · `grade: "재획득"` 으로 글자로 말한다.
        # ⛔ **파지가 아니다** — 표적 위 standoff 로 가서 **화각에 담기만** 한다. `AMR_HOME`
        #    이 140mm 어긋나 있어도(09-04) 화각 반지름 안이면 눈을 돌려 주기엔 충분하다.
        re, why_re = follow_reacquire()
        if re is not None:
            return re, None
        return None, f"{why_tag} · 재획득도 못 한다 — {why_re}"


def follow_reacquire():
    """바퀴가 가리키는 **라이다 윗면**을 표적으로 (계약 §재획득 · 2026-09-04 · D180).

    ⛔ **바퀴가 낡으면 안 낸다** — 바퀴는 헛돌아도 태연히 값을 낸다(2026-08-19 에 제자리인
    로봇이 428mm 밖이라고 했다). `FOLLOW_ODOM_MAX_AGE_S` 를 그대로 쓴다.
    ⛔ **높이는 지어내지 않는다** — `AMR_HOME.topZMm + AMR_TAG.offsetMm.z` 는 둘 다 등재된
    실측이고, 09-04 손목 뎁스 대조에서 **7mm** 안에서 맞았다.
    """
    op = amr.pose()
    if op is None:
        return None, f"바퀴가 없다 — {amr.note() or 'FR5_TB_HOST 를 안 줬다'}"
    if op["ageS"] > FOLLOW_ODOM_MAX_AGE_S:
        return None, f"바퀴가 {op['ageS']:.1f}초 낡았다 (상한 {FOLLOW_ODOM_MAX_AGE_S}초)"
    geom = workcell_amr()
    if geom is None:
        return None, "workcell.js 의 AMR_HOME·AMR_TAG 를 못 읽었다"
    home, tagg = geom
    th = math.radians(float(op["yawDeg"]))
    off = tagg["offsetMm"]
    ox = op["xMm"] + float(off["x"]) * math.cos(th) - float(off.get("y") or 0) * math.sin(th)
    oy = op["yMm"] + float(off["x"]) * math.sin(th) + float(off.get("y") or 0) * math.cos(th)
    hh = math.radians(float(home["yawDeg"]))
    c, s = math.cos(hh), math.sin(hh)
    u1 = [c * ox - s * oy + float(home["xMm"]),
          s * ox + c * oy + float(home["yMm"]),
          float(home["topZMm"]) + float(off["z"])]
    return {"labMm": None, "user1Mm": [round(v, 1) for v in u1],
            "yawDeg": round(float(home["yawDeg"]) + float(op["yawDeg"]), 2),
            "errPx": None, "ageS": op["ageS"], "basis": "AMR_HOME(assumed yaw)",
            "source": "odom", "grade": "재획득",
            "correctedAgoS": None, "fit": None, "odomAgeS": op["ageS"]}, None


_WC_CACHE = {}


def workcell_amr():
    """`AMR_HOME`·`AMR_TAG` 를 **실행해서** 받고 캐시한다 — 상수라 매 틱 다시 안 읽는다."""
    if "v" not in _WC_CACHE:
        try:
            import subprocess                                  # noqa: PLC0415
            src = ("import('./Shared/data/workcell.js').then(m=>console.log("
                   "JSON.stringify({A:m.AMR_HOME,T:m.AMR_TAG})))")
            out = subprocess.run(["node", "-e", src], cwd=str(HERE.parent.parent),
                                 capture_output=True, text=True, encoding="utf-8",
                                 errors="replace", timeout=20)
            d = json.loads(out.stdout)
            _WC_CACHE["v"] = (d["A"], d["T"])
        except Exception:                                      # noqa: BLE001
            _WC_CACHE["v"] = None
    return _WC_CACHE["v"]

    op = amr.pose()

    # ① 태그가 보인다 — 정본이다. 그리고 **이 순간이 눈금을 고칠 기회**다
    if tag is not None:
        if op and op["ageS"] <= FOLLOW_ODOM_MAX_AGE_S:
            now = time.time()
            amr.observe([op["xMm"], op["yMm"]], tag["labMm"][:2],
                        now - op["ageS"], now - tag["ageS"],
                        out_path=str(CONFIG_DIR / "amr-frame.json"))
        f = amr.fit()
        return {**tag, "correctedAgoS": 0.0,
                "fit": f, "odomAgeS": (op or {}).get("ageS")}, None

    # ② 안 보인다 — 바퀴로 잇는다. **셋 다 있어야** 낸다(하나라도 없으면 사유를 낸다)
    if op is None:
        return None, f"{why_tag} · 바퀴도 없다 — {amr.note() or 'FR5_TB_HOST 를 안 줬다'}"
    if op["ageS"] > FOLLOW_ODOM_MAX_AGE_S:
        return None, f"{why_tag} · 바퀴도 {op['ageS']:.1f}초 낡았다 (상한 {FOLLOW_ODOM_MAX_AGE_S}초)"
    f = amr.fit()
    if not f:
        return None, (f"{why_tag} · 눈금이 아직 없다 — 태그가 보이는 동안 쌍을 "
                      f"{amr.MIN_PAIRS}개 모아야 한다 (지금 {amr.pair_count()}개)")
    base = fixture._read(str(CONFIG_DIR / "robot-base-in-tag.json"))
    if not base:
        return None, "robot-base-in-tag.json 이 없다 — lab→로봇 환산을 못 한다"
    user = ((getattr(session, "coordDefs", None) or {}).get("user"))
    if not user:
        return None, "user1 원점을 모른다 — 로봇 미연결이거나 좌표계를 못 읽었다"
    # 높이는 안 푼다 — 쌍이 상판 평면에서만 나온다. 태그가 마지막으로 준 z 를 쓴다
    z = follow_last_tag_z(cfg)
    if z is None:
        return None, f"{why_tag} · 태그 높이를 한 번도 못 받았다 — 눈금만으론 z 를 모른다"
    lab = fixture.odom_to_lab([op["xMm"], op["yMm"]], f, z)
    p = fixture.lab_to_user1(lab, base, user)
    return {"labMm": [round(float(x), 1) for x in lab],
            "user1Mm": [round(float(x), 1) for x in p],
            "yawDeg": round(op["yawDeg"] + float(f["yawDeg"]), 1), "errPx": None,
            "ageS": op["ageS"], "basis": None, "source": "odom",
            "correctedAgoS": round(time.time() - float(f["fittedAt"]), 1),
            "fit": f, "odomAgeS": op["ageS"]}, None


def follow_last_tag_z(cfg):
    """태그가 마지막으로 준 높이(lab z). **없으면 `None`** — 지어내지 않는다."""
    doc = fixture._read(str(CONFIG_DIR / FOLLOW_SOURCE_FILE[cfg["targetSource"]]))
    v = ((doc or {}).get("anchors") or {}).get(str(int(cfg["targetTagId"])))
    try:
        return float(v["labMm"][2])
    except Exception:                     # noqa: BLE001
        return None


# 마지막으로 **보낸** 목표 — `should_move` 가 이걸 기준으로 「따라갈 만한가」를 판정한다.
# ⛔ 단계 3(움직임)이 붙기 전에는 **아무도 여기에 안 쓴다.** 지금은 늘 `None` 이라
# 등급이 항상 「첫목표」로 나온다 — 그게 사실이다(아직 한 번도 안 보냈다).
follow_last_sent = None


# 손끝이 늙으면 **지금 자세가 아니다.** 표적과 같은 규율을 손끝에도 건다 — 다가가는 쪽과
# 기울기 판정이 둘 다 이 값을 쓰므로, 낡은 값이면 「어느 쪽에 서 있나」부터 틀린다.
FOLLOW_TCP_MAX_AGE_S = 2.0


def follow_tcp():
    """지금 손끝 자세 → `(tcp, 사유)`. **못 읽었거나 늙었으면 `None`** — 지어내지 않는다."""
    tcp = getattr(session, "tcpMmDeg", None)
    if not tcp:
        return None, "손끝 자세를 아직 한 번도 못 읽었다 — 로봇 미연결이다"
    age = time.time() - float(getattr(session, "tcpAt", 0) or 0)
    if age > FOLLOW_TCP_MAX_AGE_S:
        return None, f"손끝 자세가 {age:.1f}초 낡았다 — 상한 {FOLLOW_TCP_MAX_AGE_S}초"
    return tcp, None


def follow_goal(target, cfg):
    """표적 → **목표 손끝 자세**. 반환 `(goal, 사유)` — 움직이지 않는다.

    `follow.target_pose` 가 정본이고 여기는 **재료를 모아 부를 뿐**이다. 자세(rx·ry·rz)를
    우리가 만들지 않는 것도 그쪽 규약 그대로다 — 사람이 맞춰 둔 방향을 따라간다.
    """
    if target is None:
        return None, None                      # 표적이 없는 건 이미 조건 5 가 말했다
    tcp, why_tcp = follow_tcp()
    if tcp is None:
        return None, why_tcp
    pose, why = follow.target_pose(target["user1Mm"], tcp, cfg)
    if pose is None:
        return None, why
    go, dist, grade = follow.should_move(pose, follow_last_sent, cfg)
    return {"tcpMmDeg": [round(v, 1) for v in pose],
            "wouldMove": go, "distMm": round(dist, 1) if dist is not None else None,
            "grade": grade}, None


def follow_amr():
    """눈금이 **어떻게 자라고 있나**. 화면이 「지금 몇 쌍이나 모였나」를 말할 재료다.

    ⛔ 이게 없으면 사람은 「쌍을 모으는 중」과 「영영 못 모은다」를 구분 못 한다 —
    쌍은 **로봇이 움직여야** 모이므로(같은 자리는 안 쌓는다) 서 있으면 영영 1개다.
    그 사실이 화면에 안 보이면 고장으로 읽힌다.
    """
    return {"pose": amr.pose(), "fit": amr.fit(),
            "pairs": amr.pair_count(), "pairsNeeded": amr.MIN_PAIRS,
            "note": amr.note()}


def follow_snapshot():
    # 꺼져 있을 때도 낸다 (조건 7) — 마지막 사유를 들고 있어야 화면이 「왜 안 도나」에 답한다
    cfg, why = follow_cfg()
    if cfg is None:
        return {"on": False, "reason": f"설정이 없다 — {why}"}
    snap = follow_switch.snapshot(time.time(), cfg)
    if not snap.get("on"):
        # **꺼져 있어도 표적은 낸다.** 켜기 전에 「지금 보이나」를 눈으로 확인할 수 있어야
        # 한다 — 안 그러면 켠 뒤에야 조건 5 를 알게 되고, 그건 켜는 순간을 시험으로 만든다
        target, why_t = follow_target(cfg)
        goal, why_g = follow_goal(target, cfg)
        # ⛔ **꺼져 있을 때도 사유를 낸다** (2026-08-31 · GAP 08-28 을 닫는다).
        # 08-28 에 이 가지가 `_` 로 사유를 버려서 화면이 `target: null` 만 보여줬고,
        # 「왜 없나」에 답을 못 했다 — 원인(손끝 23.3° 기울기)을 내가 손계산해서야 알았다.
        # **켜야만 이유를 아는 것은 거꾸로다**: 켜는 순간이 곧 첫 시험이 된다.
        return {**snap, "target": target, "goal": goal, "amr": follow_amr(),
                **({"targetWhy": why_t} if target is None and why_t else {}),
                **({"goalWhy": why_g} if goal is None and why_g else {})}
    # 켜져 있어도 **지금 움직일 수 있나** 를 같이 낸다 — 화면이 크게 말할 재료다
    blockers = []
    if not session.armed:
        blockers.append("ARMED 가 아니다")
    tcp_now, why_tcp = follow_tcp()
    tilt = follow.tilt_deg(tcp_now)
    if tilt is None:
        blockers.append(why_tcp or "손끝 자세를 못 읽었다")
    elif tilt > float(cfg["maxTiltDeg"]):
        blockers.append(f"손끝이 수직에서 {tilt:.1f}도 기울었다 — 상한 {cfg['maxTiltDeg']}도")
    # 조건 5 — **표적을 지금 보고 있나.** 못 보면 여기서 막힌다(그게 사실이다)
    target, why_t = follow_target(cfg)
    if target is None:
        blockers.append(f"표적을 못 본다 — {why_t} (조건 5)")
    # ⛔ **여기까지가 계산이다. 아직 아무것도 안 보낸다** (2026-08-28 · 단계 2/3).
    # 목표 손끝 자세를 **미리 보여 주는** 이유는 하나다 — 움직이기 전에 사람이 숫자를
    # 볼 수 있어야 한다. 안 그러면 첫 움직임이 곧 첫 확인이 된다.
    goal, why_g = follow_goal(target, cfg)
    return {**snap, "blockers": blockers, "target": target, "goal": goal, "amr": follow_amr(),
            **({"targetWhy": why_t} if target is None and why_t else {}),
            **({"goalWhy": why_g} if goal is None and why_g else {})}


def snapshot():
    return {**session.snapshot(owner.get()), "follow": follow_snapshot()}


def owner_gate(body):
    """조종권 확인. 통과하면 None, 아니면 거부 응답. **쓰기만 조종권** — 읽기는 누구나 (D44)."""
    b = body or {}
    if not owner.is_owner(b.get("who"), b.get("token")):
        return refuse([f"조종권이 없다 — 보유자 {owner.get() or '없음'}"], 403)
    return None


# ── 프로필·연결 (API-CONTRACT §로봇 프로필과 읽기 전용 사전검증) ─────────────
@app.get("/robots")
async def robots():
    return [
        {"robotId": r["robotId"], "name": r["name"], "model": r["expectedModel"],
         "endpoint": r["endpoint"],
         # 구운 장면·픽스처의 이름 — 빌린 프로필(`fr5-mock-lab`)은 실기 것을 쓴다 (2026-09-06 · 시뮬 탭이 `/sim/scene/<sceneId>.xml` 을 연다)
         "sceneId": r.get("borrowFrom") or r["robotId"],
         "lastObserved": session.observedAt
         if session.profile and session.profile["robotId"] == r["robotId"] else None}
        for r in CONFIG["robots"]
    ]


@app.post("/connect")
async def connect(body: dict):
    robot_id = body.get("robotId")
    profile = PROFILES.get(robot_id)
    if not profile:
        return refuse([f"없는 robotId — {robot_id}"], 404)
    if body.get("observeOnly", True) is not True:
        return refuse(["연결은 observe-only 로만 열린다 — 명령 승격은 POST /arm (D41)"])
    if session.adapter is not None:
        return refuse([f"이미 {session.profile['robotId']} 에 연결 — 먼저 disconnect"])

    session.phase, session.failReason = "PREFLIGHT", None
    log("PREFLIGHT", f"robotId={robot_id} endpoint={profile['endpoint']}")
    adapter = make_adapter(profile)

    def _preflight():
        adapter.connect()
        return adapter.get_version(), adapter.read_state()

    try:
        version, state = await asyncio.wait_for(asyncio.to_thread(_preflight), CONNECT_TIMEOUT_S)
    except TimeoutError:
        # `asyncio.TimeoutError` 는 `str(e)` 가 비어 있다 — 그대로 내보내면 사유가 사라져
        # 로봇 탓으로 오진한다 (2026-08-10 실측: `reasons:[""]` 로 한나절을 썼다)
        try:
            adapter.disconnect()
        except Exception:
            pass
        msg = f"프리플라이트 {CONNECT_TIMEOUT_S:.0f}s 무응답 — 로봇·랜 확인"
        session.fail_closed(msg)
        return refuse([msg])
    except Exception as e:
        # 프리플라이트가 connect 뒤에서 터지면(get_version·read_state) 이미 열린 컨트롤러 세션이
        # 남는다 — 안 닫으면 반복 실패가 세션 슬롯을 먹어 펜던트 로그인까지 막는다 (감사 #4)
        try:
            adapter.disconnect()
        except Exception:
            pass
        session.fail_closed(str(e))
        return refuse([str(e)])

    reasons = preflight.check(profile, version, state)
    if reasons:
        try:
            adapter.disconnect()
        except Exception:
            pass
        session.fail_closed(" · ".join(reasons))
        return refuse(reasons)

    session.open(profile, adapter, version, state)
    log("OBSERVE_ONLY", f"robotId={robot_id} sdk={version.get('sdk')}")
    return {"ok": True, "phase": "OBSERVE_ONLY", "reasons": []}


@app.get("/version")
async def version():
    if session.version is None:
        return refuse(["미연결 — 관측된 버전이 없다"])
    v = session.version
    return {"robotId": session.profile["robotId"], "controller": v.get("controller"),
            "servo": v.get("servo"), "end": v.get("end"), "sdk": v.get("sdk"),
            "web": v.get("web"), "observedAt": session.observedAt}


@app.post("/disconnect")
async def disconnect(body: dict | None = None):
    # 주인이 있을 때는 주인만 끊는다 — 남의 실행을 아무나 중단시키면 그것도 사고다.
    # 주인이 없으면 누구나 끊을 수 있다 (observe-only 정리는 막을 이유가 없다).
    holder = owner.get()
    b = body or {}
    if holder and not owner.is_owner(b.get("who"), b.get("token")):
        return refuse([f"조종권이 {holder} 에게 있다 — 먼저 STOP 하거나 주인이 끊는다"], 403)
    await stop_recording("disconnect")     # 안 닫으면 프레임을 다 적고도 파일이 안 남는다
    await asyncio.to_thread(session.close)
    return {"ok": True, "phase": "DISCONNECTED", "reasons": []}


# ── 조종권 (API-CONTRACT §조종권) ────────────────────────────────────────────
@app.post("/owner/claim")
async def owner_claim(body: dict):
    okey, result = owner.claim(body.get("who"))
    # 토큰이 조종권을 증명한다 — 이름은 화면 표시용이다 (D55 · 계약 §조종권)
    return {"ok": True, "owner": owner.get(), "token": result} if okey \
        else refuse([result], 409)


@app.post("/owner/release")
async def owner_release(body: dict):
    okey, reason = owner.release(body.get("who"), body.get("token"))
    return {"ok": True, "owner": None} if okey else refuse([reason], 409)


# ── 명령 승격 (API-CONTRACT §명령 승격 — D41) ────────────────────────────────
@app.post("/arm")
async def arm(body: dict):
    who, token = body.get("who"), body.get("token")
    if body.get("confirm") != "현장확인":
        return refuse(['confirm: "현장확인" 이 없다 — 현장에 사람이 있음을 명시해야 한다'], 403)
    if not owner.is_owner(who, token):
        return refuse(["조종권이 없다 — 먼저 /owner/claim"], 403)
    if session.adapter is None:
        return refuse(["미연결"])
    if session.armed:
        return {"ok": True, "phase": session.current_phase(owner.get()), "reasons": []}

    try:
        reasons = await asyncio.to_thread(cmds.arm_sequence, SAMPLE_MS)
    except Exception as e:
        await asyncio.to_thread(session.disarm_hw, f"arm 실패 — {e}")
        return refuse([f"arm 시퀀스 실패 — {e}"])
    if reasons:
        return refuse(reasons)
    # arm 시퀀스가 도는 동안(수 초) 조종권이 넘어갔을 수 있다 — 그 사이 자동 해제가 돌면
    # armed 가 아직 False 라 _owner_lost 가 아무것도 안 하고, 여기서 주인 없는 ARMED 가 남는다
    if not owner.is_owner(who, token):
        await asyncio.to_thread(session.disarm_hw, "arm 중 조종권 소실")
        return refuse(["arm 중 조종권을 잃었다 — 다시 잡고 ARM"], 403)
    session.armed = True
    log("ARMED", f"who={who}")
    return {"ok": True, "phase": "ARMED", "reasons": []}


@app.post("/disarm")
async def disarm(body: dict):
    if not owner.is_owner(body.get("who"), body.get("token")):
        return refuse(["조종권이 없다"], 403)
    await asyncio.to_thread(session.disarm_hw, f"disarm by {body.get('who')}")
    return {"ok": True, "phase": session.current_phase(owner.get()), "reasons": []}


# ── 상태 (API-CONTRACT §상태값) ──────────────────────────────────────────────
@app.post("/stop")
async def stop_now(body: dict | None = None):
    """**같은 `stop` 의 두 번째 전송로다 — 새 명령이 아니다** (계약 §POST /stop · 2026-09-03).

    왜 둘인가 — WS 하나에만 걸려 있으면 ①앞 명령이 처리되는 동안 밀리고 ②그 소켓이 막히면
    **정지 수단이 사라진다.** 2026-08-10 목 브리지 로그에서 같은 소켓으로 이동 중에 보낸
    `stop` 이 **이동이 끝난 뒤** 실행됐다 — 지연이 남은 이동 시간과 같아 최대 60초였다.

    ⛔ **인자를 받지 않는다.** `who`·`token`·대상 관절을 요구하는 순간 그게 정지를 막는
    조건이 된다. 본문이 와도 **읽지 않는다** — 옛 클라이언트가 보내도 거부하지 않으려고
    받기만 한다(계약 「본문 없음」).
    ⛔ **허용목록이 늘지 않는다** — 실기에 닿는 이름은 여전히 다섯이고 `stop` 은 그중 하나다.
    """
    return await do_stop(None, via="post")


@app.get("/state")
async def state():
    return await asyncio.to_thread(snapshot)


# ── 추종 켜기·끄기 (계약 §추종 §창구) ────────────────────────────────────────
@app.post("/follow/on")
async def follow_on(body: dict):
    # `confirm` 을 요구하는 이유는 `/arm` 과 같다 — 조건 1 은 버튼 한 번으로 안 지켜진다.
    # **「사람이 곁에 있음」을 말로 적게 한다.**
    if (body or {}).get("confirm") != "현장확인":
        return refuse(['confirm: "현장확인" 이 없다 — 현장에 사람이 있음을 명시해야 한다'], 403)
    if (bad := owner_gate(body)) is not None:
        return bad
    if not session.armed:                                   # 조건 2
        return refuse(["ARMED 가 아니다 — 먼저 /arm"], 403)
    cfg, why = follow_cfg()
    if cfg is None:
        return refuse([f"추종 설정이 없다 — {why}"], 400)
    follow_switch.on((body or {}).get("who"), time.time())
    return {"ok": True, "follow": follow_snapshot(), "reasons": []}


@app.post("/follow/step")
async def follow_step(body: dict):
    """**지금 목표로 딱 한 번 간다** (계약 §`POST /follow/step`).

    ⭐ 스위치를 안 본다 — 한 번 가는 것은 **매번 사람이 켜는 것과 같아서** 조건 1 이
    호출 자체로 만족된다. 나머지 조건은 `/follow/on` 과 **같은 순서로 그대로** 본다.
    ⛔ 실행은 `cmds.motion` 이다 — `POST /ik` 가 `dry_run` 으로 타는 **같은 함수**라
    「미리보기는 통과인데 실제로는 거부」가 안 생긴다.
    """
    if (body or {}).get("confirm") != "현장확인":
        return refuse(['confirm: "현장확인" 이 없다 — 현장에 사람이 있음을 명시해야 한다'], 403)
    if (bad := owner_gate(body)) is not None:
        return bad
    if not session.armed:                                   # 조건 2
        return refuse(["ARMED 가 아니다 — 먼저 /arm"], 403)
    cfg, why = follow_cfg()
    if cfg is None:
        return refuse([f"추종 설정이 없다 — {why}"], 400)
    target, why_t = follow_target(cfg)                      # 조건 5
    if target is None:
        return refuse([f"표적을 못 본다 — {why_t}"], 409)
    goal, why_g = follow_goal(target, cfg)                  # 기울기 상한도 여기서 본다
    if goal is None:
        return refuse([why_g or "목표를 못 냈다"], 409)
    # **같은 자리를 두 번 가지 않는다** — 데드밴드 아래는 측정 잡음이라 팔이 떤다
    if not goal["wouldMove"]:
        return {"ok": True, "moved": False, "goal": goal, "target": target,
                "reasons": [f"데드밴드 안이다 ({goal['distMm']}mm) — 안 간다"]}
    ref = (session.lastState or {}).get("jointsDeg")
    joints = await asyncio.to_thread(session.adapter.inverse_kin, goal["tcpMmDeg"], ref)
    if joints is None:
        return refuse(["해가 없다 — 도달 밖이거나 그 자세가 불가능하다"], 409)
    # `scan_path=True` — 지점 이동이므로 경로를 5° 간격으로 표본해 전부 게이트에 태운다
    reasons = await asyncio.to_thread(cmds.motion, joints, cfg["speedPct"], True, False)
    if reasons:
        return refuse(reasons, 409)
    global follow_last_sent                                 # noqa: PLW0603 — 모듈 상태가 정본이다
    follow_last_sent = goal["tcpMmDeg"]
    log("follow-step", f"by={(body or {}).get('who')} → {goal['tcpMmDeg']}")
    return {"ok": True, "moved": True, "goal": goal, "target": target, "reasons": []}


@app.post("/follow/off")
async def follow_off(body: dict):
    # **끄는 길은 켜는 길보다 항상 넓다** — `confirm` 도 ARMED 도 안 묻는다
    if (bad := owner_gate(body)) is not None:
        return bad
    follow_switch.off("사람이 껐다")
    return {"ok": True, "follow": follow_snapshot()}


# ── Teach — 지점과 궤적 (API-CONTRACT §이동 지점 · §궤적 녹화 · D74) ──────────
@app.get("/points")
async def points_list():
    return await asyncio.to_thread(teach.points.list)


@app.post("/points")
async def points_capture(body: dict):
    if (bad := owner_gate(body)) is not None:
        return bad
    state, reasons = await asyncio.to_thread(session.fresh_state)
    if reasons:
        return refuse(reasons)
    point, reasons = await asyncio.to_thread(
        teach.points.capture, body.get("name"), state, (session.profile or {}).get("robotId"))
    if reasons:
        return refuse(reasons)
    # **재교시는 승인을 푼다.** 같은 이름이면 덮어쓰므로(teach.points.capture) 승인된
    # 프로그램의 동작이 승인 없이 바뀐다. 실행 직전 지문 대조가 이미 막지만(감사 #2),
    # 그건 사람이 로봇 앞에 선 뒤다 — 캡처한 이 화면에서 바로 알린다
    refs = await asyncio.to_thread(slots.refs_to_point, point["name"])
    unapproved = [n for n in refs if await asyncio.to_thread(slots.unapprove, n)]
    if unapproved:
        log("point-capture-unapprove", f"{point['name']} 재교시 → 승인 해제 {unapproved}")
    log("point-capture", f"{point['name']} joints={[round(v, 2) for v in point['jointsDeg']]}")
    return {"ok": True, "point": point, "unapproved": unapproved, "reasons": []}


@app.delete("/points/{name}")
async def points_delete(name: str, body: dict | None = None):
    if (bad := owner_gate(body)) is not None:
        return bad
    # 사다리 3 이 이 훅을 채웠다 — 참조하는 슬롯이 있으면 지우지 않는다 (감사 P1)
    refs = await asyncio.to_thread(slots.refs_to_point, name)
    ok, blocked = await asyncio.to_thread(teach.points.delete, name, refs)
    if blocked:
        return refuse([f"참조하는 슬롯이 있다 — {', '.join(blocked)}"], 409)
    if not ok:
        return refuse([f"없는 지점 — {name}"], 404)
    log("point-delete", name)
    return {"ok": True, "reasons": []}


async def goto_point(name, speed_pct=None):
    """지점으로 이동. **`moveJ` 로 번역해 같은 게이트를 처음부터 다시 태운다** —
    실기 명령 허용목록에 새 이름을 더하지 않는다 (VISION-CONTRACT 의 제안과 같은 규약).

    `speed_pct` 는 계약 §경로 검사 — 1~10, 없으면 상한(10). **여기서 자르지 않는다.**
    상한 초과는 `safety.check_motion` 이 사유와 함께 거부한다 (자르면 화면 버그가 숨는다).
    처음 만든 지점을 처음 눌러 볼 때 천천히 가려는 것이 이 값의 목적이다.

    반환: `(사유목록, 상태코드)`. 비면 보냈다. **슬롯 실행도 이 함수를 지난다** —
    복붙하면 한쪽만 고쳐진다 (계약 `PROGRAM-CONTRACT.md` §step 4번).
    """
    point = await asyncio.to_thread(teach.points.get, name)
    if not point:
        return [f"없는 지점 — {name}"], 404
    here = (session.profile or {}).get("robotId")
    if point.get("capturedRobotId") != here:
        return [f"다른 개체에서 잰 지점이다 — {point.get('capturedRobotId')} · 지금 {here}"], 409
    reasons = frame_mismatch(point, (session.lastState or {}).get("coord"))
    if reasons:
        return reasons, 409
    # **경로를 먼저 훑는다** (D75) — 조그용 5° 상한을 빼는 대신 가는 길을 검사한다
    speed = safety.SPEED_CAP_PCT if speed_pct is None else speed_pct
    reasons = await asyncio.to_thread(cmds.motion, point["jointsDeg"], speed, True)
    return reasons, 409


@app.post("/points/{name}/goto")
async def points_goto(name: str, body: dict):
    if (bad := owner_gate(body)) is not None:
        return bad
    if not session.armed:
        return refuse([f"ARMED 가 아니다 — phase={session.current_phase(owner.get())}"])
    reasons, code = await goto_point(name, body.get("speedPct"))
    if reasons:
        return refuse(reasons, code)
    return {"ok": True, "phase": session.current_phase(owner.get()), "reasons": []}


@app.post("/ik")
async def ik(body: dict):
    """계약 §손끝 자리 → 관절각. **로봇을 움직이지 않는다.**

    그래서 조종권도 ARMED 도 안 본다 — 컨트롤러에 묻기만 한다. 비전이 낸 자리를
    **보내기 전에** 「갈 수 있나 · 가는 길이 통과하나」로 가른다 (D131).
    """
    pose = (body or {}).get("tcpMmDeg")
    if not isinstance(pose, list) or len(pose) != 6:
        return refuse(["tcpMmDeg 는 6개다 — [x, y, z, rx, ry, rz] · mm·도"], 400)
    if session.adapter is None:
        return refuse(["연결이 없다 — 컨트롤러에 물을 수 없다"])
    # **지금 자세를 참조로 준다** — 여러 해 중 팔이 뒤집힌 것을 고르면 손끝은 맞아도
    # 가는 길이 전혀 다른 곳을 지나고, 그러면 경로 검사가 엉뚱한 길을 통과시킨다
    # 여러 칸을 잇는 화면은 **직전 칸의 해**를 참조로 준다 (계약 §/ik · 2026-09-06) — 전부 지금 자세를
    # 참조하면 칸마다 가지가 갈려 관측 칸 하나에 57초짜리 165° 회전이 생겼다. 없거나 모양이 틀리면 지금 자세
    ref = (body or {}).get("refJointsDeg")
    if not (isinstance(ref, list) and len(ref) == 6
            and all(isinstance(v, (int, float)) and math.isfinite(v) for v in ref)):
        ref = (session.lastState or {}).get("jointsDeg")
    joints = await asyncio.to_thread(session.adapter.inverse_kin, pose, ref)
    if joints is None:
        return {"jointsDeg": None, "reachable": False,
                "reason": "해가 없다 — 도달 밖이거나 그 자세가 불가능하다",
                "gate": {"ok": False, "reasons": ["해가 없어 판정할 것이 없다"]}}
    # 실제 이동과 **같은 함수**를 태운다 (`dry_run`) — 검사를 따로 짜면 갈린다
    reasons = await asyncio.to_thread(cmds.motion, joints, safety.SPEED_CAP_PCT, True, True)
    return {"jointsDeg": [round(float(v), 3) for v in joints],
            "reachable": True, "reason": None,
            "gate": {"ok": not reasons, "reasons": reasons}}


# ── 손목 스캔 — 2단 조준의 정밀 칸 (계약 §손목 스캔 · 2026-09-07 · D192) ────────────────
# **로봇을 움직이지 않는다.** 풀이는 `scripts/robot/carrier-find.py`(`depth-probe.py` 위) 한 곳 —
# 브리지는 그 `find` 를 부르고 hand-eye 로 user1 에 옮기기만 한다(색·손목 상주가 `color-find`·`wrist-find`
# 를 여는 것과 같은 방법 · 두 번째 풀이를 짜지 않는다).
SCAN_TARGETS = {
    # 표적 → (분기, 치수 키 출처, 높이/깊이 창 mm). 치수 숫자는 `props.js` 가 정본 — 여기 안 박는다
    # 거치대 높이 창은 props.js 에서 — 뎁스는 윗면 테두리를 못 보고 **안쪽 바닥(28)** 을 본다(`CARRIER.depthSignature` · 2026-09-07 실측). 창 = (바닥 −10, 키 +15)
    "carrier":         {"mode": "raised", "size": "CARRIER", "h": None},
    "basketFloor":     {"mode": "sunken", "size": "AMR_BASKET", "h": None},   # 깊이 창은 props.js innerHMm ±15 — 발판(2026-09-07 · 35)이 들어오면 같이 움직인다
    "carrierInBasket": {"mode": "raised", "size": "CARRIER", "h": None},
}
# 목업 뎁스 — **툴 프레임에 고정된 편향**을 진값에 얹는다. 거울 쌍(rz±90) 평균이 진값으로 돌아오는 것을
# 집에서 게이트가 확인하려는 값이다. 크기는 08-13 역산(3~5° @245mm ≈ 13~21mm)의 아래쪽
DEPTH_MOCK_BIAS_MM = (12.0, -8.0, 0.0)
_scan_mod = None


def _props_size(name):
    """`props.js` 의 `CARRIER`(wMm·dMm) 또는 `AMR_BASKET`(innerWMm·innerDMm) 치수를 **정본 파일에서** 읽는다."""
    import re                                                    # noqa: PLC0415
    txt = (HERE.parent.parent / "Shared" / "data" / "props.js").read_text(encoding="utf-8")
    m = re.search(rf"{name}\s*=\s*\{{(.*?)\n\}}", txt, re.S)
    if not m:
        raise ValueError(f"props.js 에서 {name} 을 못 찾았다")
    keys = ("innerWMm", "innerDMm") if name == "AMR_BASKET" else ("wMm", "dMm")
    g = lambda k: float(re.search(rf"\b{k}\s*:\s*(-?\d+(?:\.\d+)?)", m.group(1)).group(1))  # noqa: E731
    return g(keys[0]), g(keys[1])


def _props_num(name, key):
    """`props.js` 객체 하나의 숫자 필드 하나 — 정본에서 읽는다 (예 `AMR_BASKET.innerHMm`)."""
    import re                                                    # noqa: PLC0415
    txt = (HERE.parent.parent / "Shared" / "data" / "props.js").read_text(encoding="utf-8")
    m = re.search(rf"{name}\s*=\s*\{{(.*?)\n\}}", txt, re.S)
    if not m:
        raise ValueError(f"props.js 에서 {name} 을 못 찾았다")
    return float(re.search(rf"\b{key}\s*:\s*(-?\d+(?:\.\d+)?)", m.group(1)).group(1))


def _scan_module():
    global _scan_mod
    if _scan_mod is None:
        from importlib import util as _u                         # noqa: PLC0415
        sp = HERE.parent.parent / "scripts" / "robot" / "carrier-find.py"
        spec = _u.spec_from_file_location("carrierfind", sp)
        mod = _u.module_from_spec(spec)
        spec.loader.exec_module(mod)                             # noqa: S102 — 우리 저장소 파일이다
        _scan_mod = mod
    return _scan_mod


def _fold_yaw(deg):
    """69×85 · 110×120 은 180° 대칭 — `[−90, 90)` 로 접는다."""
    return ((float(deg) + 90.0) % 180.0) - 90.0


def _scan_mock(target, truth, tcp):
    """목업: 진값 + 툴 프레임 고정 편향(지금 자세로 돌린 것). `truth` 가 없으면 지어내지 않는다."""
    if not isinstance(truth, dict) or not isinstance(truth.get("user1Mm"), list) or len(truth["user1Mm"]) < 3:
        return None, ["목업 스캔은 truth.user1Mm(3) 이 있어야 답한다 — 지어내지 않는다 (source: mock)"]
    r = safety._rot_fixed_xyz(tcp[3], tcp[4], tcp[5])
    b = safety._apply(r, DEPTH_MOCK_BIAS_MM)
    p = [float(truth["user1Mm"][i]) + b[i] for i in range(3)]
    yaw = truth.get("yawDeg")
    return {"target": target, "rzDeg": round(float(tcp[5]), 3), "tcpMmDeg": [round(float(v), 3) for v in tcp],
            "camMm": None, "user1Mm": [round(v, 2) for v in p],
            "yawDeg": None if yaw is None else round(_fold_yaw(yaw), 2),
            "blob": {"kind": SCAN_TARGETS[target]["mode"], "areaPx": None, "sizeMm": None, "heightMm": None, "longAxisDeg": None},
            "source": "mock", "biasMm": list(DEPTH_MOCK_BIAS_MM), "t": time.time()}, []


def _scan_depth(target, tcp, hand_eye):
    """실기: 뎁스 한 판 → 덩어리 하나 → hand-eye → user1. 후보가 정확히 하나가 아니면 안 고른다."""
    cf = _scan_module()
    spec = SCAN_TARGETS[target]
    host = os.environ.get("FR5_DEPTH_HOST", "127.0.0.1:5058").strip()
    info = cf.get(f"http://{host}/api/camera/info")
    K = info.get("depthIntrinsics")
    if not K:
        return None, ["/api/camera/info 에 depthIntrinsics 가 없다 — 카메라가 안 붙었다"]
    z, _note = cf.dp.fetch_avg(f"http://{host}/api/camera/depth/frame", 5)
    w, d = _props_size(spec["size"])
    if spec["h"]:
        h_range = spec["h"]
    elif spec["size"] == "AMR_BASKET":
        h_range = (lambda h: (h - 15.0, h + 15.0))(_props_num("AMR_BASKET", "innerHMm"))
    else:
        h_range = (_props_num("CARRIER", "depthMinHeightMm"), _props_num("CARRIER", "hMm") + 15.0)
    cands, why = cf.find(z.astype("float32"), K, w, d, mode=spec["mode"], h_range=h_range)
    if why:
        return None, [why]
    picked = [c for c in cands if c["fits"]]
    if len(picked) != 1:
        return None, [f"{spec['size']} 크기·높이 판정선 안 후보가 {len(picked)}개 — 하나가 아니면 고르지 않는다"
                      + (f" · 후보 {[c['sizeMm'] for c in cands][:4]}" if cands else "")]
    c = picked[0]
    t_mm = (hand_eye or {}).get("tMm")
    p, reason = follow.cam_to_robot(c["camMm"], tcp, t_mm)
    if p is None:
        return None, [reason or "hand-eye 변환 실패"]
    # 요각 — **볼록 껍질 사각형** 장축(화면 x·y↑) + 손끝 rz. 규약 θ+rz 는 2026-09-07 두 프레임 교차(손목 5° 차 → 각 4.8° 이동)로 검증.
    #    PCA 장축(`longAxisDeg`)은 구멍 판에서 프레임마다 86° 뒤집혀 폐기 — 껍질이 없으면(점 부족) 요각을 **모른다**고 한다
    axis = c.get("hullAxisDeg")
    yaw = _fold_yaw(axis + float(tcp[5])) if axis is not None else None
    return {"target": target, "rzDeg": round(float(tcp[5]), 3), "tcpMmDeg": [round(float(v), 3) for v in tcp],
            "camMm": c["camMm"], "user1Mm": [round(float(v), 2) for v in p], "yawDeg": None if yaw is None else round(yaw, 2),
            "blob": {"kind": spec["mode"], "areaPx": c["areaPx"], "sizeMm": c["sizeMm"], "heightMm": c["heightMm"],
                     "longAxisDeg": c["longAxisDeg"], "hullSizeMm": c.get("hullSizeMm"), "hullAxisDeg": c.get("hullAxisDeg")},
            "source": "depth", "t": time.time()}, []


@app.post("/scan")
async def scan(body: dict):
    """계약 §손목 스캔. **로봇을 움직이지 않는다** — 조종권·ARMED 불필요(관측)."""
    target = (body or {}).get("target")
    if target not in SCAN_TARGETS:
        return refuse([f"target 은 {sorted(SCAN_TARGETS)} 중 하나다"], 400)
    if session.adapter is None:
        return refuse(["연결이 없다 — 손끝 자세를 모른다"])
    tcp = (session.lastState or {}).get("tcpMmDeg")
    if not (isinstance(tcp, list) and len(tcp) == 6):
        return refuse(["지금 손끝 자세를 못 읽었다 — 결측=차단"])
    if (session.profile or {}).get("adapter") == "mock":
        # 목업만 자세를 대신 받는다 — 거울 쌍을 집에서 돌리려면 두 rz 가 필요한데 목업 팔을 실제로 돌릴 이유가 없다.
        # ⛔ 실기는 이 키를 **무시한다**(아래 분기에 없다) — 실기는 언제나 지금 손끝 자세다 (계약 §손목 스캔)
        at = (body or {}).get("atTcpMmDeg")
        if isinstance(at, list) and len(at) == 6 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in at):
            tcp = [float(v) for v in at]
        view, reasons = _scan_mock(target, (body or {}).get("truth"), tcp)
    else:
        try:
            view, reasons = await asyncio.to_thread(_scan_depth, target, tcp, session.hand_eye())
        except Exception as e:                                   # noqa: BLE001 — 뎁스 호스트 없음 등
            view, reasons = None, [f"스캔 실패 — {type(e).__name__}: {str(e)[:80]}"]
    if reasons:
        return {"ok": False, "view": None, "reasons": reasons}
    log("scan", f"{target} rz={view['rzDeg']} → {view['user1Mm']} yaw={view['yawDeg']} ({view['source']})")
    return {"ok": True, "view": view, "reasons": []}


# ── 단계 기록 — 버튼 한 번 = 기록 한 줄 (계약 §단계 기록 · 2026-09-07 · D191) ──────────
runs = RunStore(DATA_DIR / "runs")      # 사람 데이터 폴더(`data_dir` · 기본 ~/fr5-data) — 검증은 `FR5_DATA_DIR` 로 갈아 끼운다


@app.post("/runs")
async def runs_append(body: dict):
    run_id, n, reasons = await asyncio.to_thread(runs.append, (body or {}).get("runId"), (body or {}).get("line"))
    if reasons:
        return refuse(reasons, 400)
    return {"ok": True, "runId": run_id, "n": n, "reasons": []}


@app.get("/runs")
async def runs_list():
    return await asyncio.to_thread(runs.list)


@app.get("/runs/{run_id}")
async def runs_read(run_id: str):
    doc = await asyncio.to_thread(runs.read, run_id)
    if doc is None:
        return refuse([f"없는 기록 — {run_id}"], 404)
    return doc


@app.get("/trajectories")
async def traj_list():
    return await asyncio.to_thread(teach.trajectories.list)


@app.get("/trajectories/{name}")
async def traj_get(name: str):
    traj = await asyncio.to_thread(teach.trajectories.get, name)
    return traj if traj else refuse([f"없는 궤적 — {name}"], 404)


def _read_for_record():
    """녹화 루프가 쓰는 읽기. **미연결이면 None** — 루프가 그걸로 끝을 판정한다."""
    return session.read_fresh_state() if session.adapter is not None else None


async def stop_recording(reason):
    """녹화를 닫는다. 중이 아니면 None — 두 번 불려도 안전하다."""
    global recordTask
    if recordTask:
        recordTask.cancel()
        recordTask = None
    return await asyncio.to_thread(teach.finish, reason)


@app.post("/trajectories/start")
async def traj_start(body: dict):
    global recordTask
    if (bad := owner_gate(body)) is not None:
        return bad
    st, reasons = await asyncio.to_thread(session.fresh_state)
    if reasons:
        return refuse(reasons)
    started, reasons = await asyncio.to_thread(
        teach.start, body.get("name"), body.get("purpose"), body.get("source"), session.stamp(GRIPPER_FORCE_PCT), st)
    if reasons:
        return refuse(reasons)
    recordTask = asyncio.create_task(
        run_recording(teach, _read_for_record, 1.0 / REC_FPS))
    return {"ok": True, **started, "reasons": []}


@app.post("/trajectories/stop")
async def traj_stop(body: dict):
    if (bad := owner_gate(body)) is not None:
        return bad
    name = teach.recording
    if not name:
        return refuse(["녹화 중이 아니다"])
    # 루프가 먼저 닫았을 수도 있다(상한·비상정지) — 그때는 저장된 것을 읽어 돌려준다
    traj = await stop_recording("done") or await asyncio.to_thread(teach.trajectories.get, name)
    if not traj:
        return refuse(["녹화를 저장하지 못했다"])
    return {"ok": True, "trajectory": TeachService.summary(traj), "reasons": []}


# ── 프로그램 슬롯 (PROGRAM-CONTRACT.md · 사다리 3) ───────────────────────────
def session_identity():
    """승인 당시와 지금을 대조할 정체. 슬롯은 이 넷이 다르면 실행하지 않는다.

    **`toolCoordMm` 는 번호가 아니라 값이다** — 핑거를 갈아 툴 오프셋만 바뀌면 번호 셋은
    전부 그대로인데 손끝만 더 나간다 (PROGRAM-CONTRACT §step 2번).
    """
    coord = (session.lastState or {}).get("coord") or {}
    return {"robotId": (session.profile or {}).get("robotId"),
            "toolId": coord.get("toolId"), "userId": coord.get("userId"),
            "toolCoordMm": session.tool_coord_now(),
            "firmware": (session.version or {}).get("controller")}


@app.get("/slots")
async def slots_list():
    return await asyncio.to_thread(slots.list)


@app.post("/slots")
async def slots_save(body: dict):
    """만들거나 덮어쓴다. **항상 draft 로 돌아간다** — 목록이 바뀌면 옛 승인은 다른 프로그램의 승인이다."""
    if (bad := owner_gate(body)) is not None:
        return bad
    known = {p["name"] for p in await asyncio.to_thread(teach.points.list)}
    slot, reasons = await asyncio.to_thread(
        slots.save, body.get("name"), body.get("steps"), known)
    if reasons:
        return refuse(reasons)
    log("slot-save", f"{slot['name']} 단계={len(slot['steps'])}")
    return {"ok": True, "slot": slot, "reasons": []}


@app.delete("/slots/{name}")
async def slots_delete(name: str, body: dict | None = None):
    if (bad := owner_gate(body)) is not None:
        return bad
    if not await asyncio.to_thread(slots.delete, name):
        return refuse([f"없는 슬롯 — {name}"], 404)
    log("slot-delete", name)
    return {"ok": True, "reasons": []}


@app.post("/slots/{name}/approve")
async def slots_approve(name: str, body: dict):
    """**로봇을 움직이지 않는다** — 그래서 ARMED 를 요구하지 않는다.
    `arm` 과 같은 현장확인 관문을 지난다 (계획 §확인 절차는 한 모양으로)."""
    if (bad := owner_gate(body)) is not None:
        return bad
    if body.get("confirm") != "현장확인":
        return refuse(["현장확인이 없다 — 승인하면 이 목록이 실기에서 실행된다"])
    # **정체를 못 박으면 승인하지 않는다.** 미연결이면 tool/user 가 None 으로 박히고,
    # 나중에 연결해 실행할 때 전부 불일치가 돼 그 승인이 영영 안 먹는다 (제1원칙)
    ident = session_identity()
    if any(ident.get(k) is None for k in ("robotId", "toolId", "userId", "toolCoordMm")):
        return refuse([f"연결하고 상태를 읽은 뒤에 승인한다 — 지금 정체를 못 박는다 {ident}"])
    points = {p["name"]: p.get("jointsDeg") for p in await asyncio.to_thread(teach.points.list)}
    slot, reasons = await asyncio.to_thread(
        slots.approve, name, body.get("who"), ident, points)
    if reasons:
        return refuse(reasons, 404)
    log("slot-approve", f"{name} by={body.get('who')} 정체={slot['approvedWith']}")
    return {"ok": True, "slot": slot, "reasons": []}


@app.post("/slots/{name}/step")
async def slots_step(name: str, body: dict):
    """**한 요청이 한 단계다.** 서버는 "다음 단계" 를 모른다 — 화면이 몇 번째인지 보낸다.
    그래서 중단해도 재개할 상태가 없고, 처음부터 다시 도는 사고도 구조적으로 없다 (D78)."""
    if (bad := owner_gate(body)) is not None:
        return bad
    # ARMED 를 여기서 명시적으로 본다 — 안쪽 게이트가 어차피 막지만, 사유가 phase 로 나와야
    # 화면이 "ARM 하세요" 를 말할 수 있다 (계약 §step 0번)
    if not session.armed:
        return refuse([f"ARMED 가 아니다 — phase={session.current_phase(owner.get())}"])
    points = {p["name"]: p.get("jointsDeg") for p in await asyncio.to_thread(teach.points.list)}
    step, reasons = await asyncio.to_thread(
        slots.step_plan, name, body.get("index"), session_identity(), points)
    if reasons:
        return refuse(reasons)
    # **칸 종류로 갈린다 — 게이트가 다르기 때문이다** (계약 §step 4번). 어느 쪽도 새 이름을
    # 만들지 않는다: `move` 는 `goto` 와, `grip` 은 WS `gripper` 와 **같은 함수**를 지난다.
    if step["type"] == "grip":
        # 관절 게이트(5°·URDF·모션큐)를 안 타고 그리퍼 전용으로 간다. `wait=True` —
        # 한 요청이 한 단계라 응답이 곧 「그 칸이 끝났다」여야 한다 (계약 §grip 칸)
        reasons = await asyncio.to_thread(cmds.gripper, step["pct"], True)
        if reasons:
            return refuse(reasons)
        log("slot-step", f"{name}[{body.get('index')}] → grip {step['pct']}%")
        return {"ok": True, "step": step,
                "phase": session.current_phase(owner.get()), "reasons": []}
    # goto 와 **같은 함수** — 게이트 전부 다시 탄다. 속도도 같은 길로 간다 (계약 §속도)
    reasons, code = await goto_point(step["pointName"], body.get("speedPct"))
    if reasons:
        return refuse(reasons, code)
    log("slot-step", f"{name}[{body.get('index')}] → {step['pointName']}")
    return {"ok": True, "pointName": step["pointName"], "step": step,
            "phase": session.current_phase(owner.get()), "reasons": []}


async def do_stop(who=None, via="ws"):
    """**정지 하나, 전송로 둘.** WS 와 `POST /stop` 이 이 함수를 같이 쓴다 (2026-09-03).

    제3원칙 그대로 — 조종권·신원·phase 를 **묻지 않는다.** 묻는 순간 그게 정지를 막는
    조건이 된다 (`SAFETY-RULES.md` §제3원칙 · `API-CONTRACT.md` §POST /stop).

    ⛔ **두 벌로 짜지 않는다.** 전송로가 둘이라고 판정도 둘이면, 한쪽만 고쳐진 날
    「어느 길로 눌렀나」에 따라 로봇이 다르게 선다. 그건 정지에서 낼 수 있는 제일 나쁜 버그다.

    **멱등이다** — 이미 서 있어도 `ok` 다. 화면이 WS 와 POST 를 **둘 다 쏘므로**
    중복이 사고가 되면 안 된다 (계약 §화면은 둘 다 쏘고 실패를 표시한다).
    """
    if session.adapter is None:
        return {"ok": True, "note": "미연결 — 보낼 곳이 없다"}
    try:
        await asyncio.wait_for(asyncio.to_thread(session.adapter.stop), ROBOT_TIMEOUT_S)
        log("stop", f"by={who or '무명'} via={via}")
        return {"ok": True}
    except Exception as e:                        # TimeoutError 포함 — 멈춤이 늦으면 그 사실을 알린다 (감사 #5)
        session.fail_closed(f"stop 실패 — {e}")   # 정지가 안 되는 연결은 유지하지 않는다
        return {"ok": False, "reason": f"stop 실패 — {e}"}


# ── 명령 (API-CONTRACT §명령) — 실기에 닿는 이름은 다섯뿐이다 ────────────────
async def handle_cmd(msg, who, token):
    cmd = msg.get("cmd")
    if cmd == "stop":                            # 제3원칙 — 조종권·신원·phase 무관 항상 실행
        return await do_stop(who, via="ws")
    if not who:
        return {"ok": False, "reason": "hello 로 신원을 먼저 묶는다 (stop 은 예외)"}
    if not owner.is_owner(who, token):
        return {"ok": False, "reason": f"조종권이 없다 — 보유자 {owner.get() or '없음'}"}
    if session.adapter is None:
        return {"ok": False, "reason": "로봇에 연결돼 있지 않다"}
    # mode 는 ARMED 전·후 어디서나 받는다 — 드래그 티칭은 서보가 켜져 있어야 되므로
    # ARM 을 풀게 만들면 잠긴 상태를 못 푼다 (계약 §모드 전환)
    if cmd == "mode":
        reasons = await asyncio.to_thread(cmds.mode, msg.get("manual"))
        return {"ok": True} if not reasons else {"ok": False, "reason": " · ".join(reasons)}
    # speed 도 ARMED 전에 받는다 — **배수는 ARM 전에 정하는 것이 자연스럽다** (계약 §speed).
    # 로봇을 움직이지 않으므로 `mode` 와 같은 자리에 둔다.
    if cmd == "speed":
        reasons = await asyncio.to_thread(cmds.speed_override, msg.get("pct"))
        return {"ok": True} if not reasons else {"ok": False, "reason": " · ".join(reasons)}
    if not session.armed:
        return {"ok": False,
                "reason": f"ARMED 가 아니다 — phase={session.current_phase(owner.get())}"}

    if cmd == "jog":
        reasons = await asyncio.to_thread(cmds.jog, msg.get("joint"), msg.get("deltaDeg"))
    elif cmd == "moveJ":
        reasons = await asyncio.to_thread(
            cmds.motion, msg.get("jointsDeg"), msg.get("speedPct", safety.SPEED_CAP_PCT))
    elif cmd == "gripper":
        pct = msg.get("pct")
        if pct is None and isinstance(msg.get("open"), bool):
            pct = 100.0 if msg["open"] else 0.0     # open 은 pct 의 별칭 (계약 §그리퍼)
        reasons = await asyncio.to_thread(cmds.gripper, pct)
    elif cmd == "gripperActivate":
        reasons = await asyncio.to_thread(cmds.gripper_activate)
    else:
        return {"ok": False, "reason": f"모르는 cmd — {cmd}"}
    return {"ok": True} if not reasons else {"ok": False, "reason": " · ".join(reasons)}


@app.websocket("/ws/state")
async def ws_state(ws: WebSocket):
    await ws.accept()
    who = None
    token = None
    log("ws-open", str(ws.client))

    async def sender():
        # ponytail: 접속마다 snapshot() = 접속마다 read_state(). 실기 다중 접속은 중복 폴링이
        # 된다 — 접속자가 늘면 단일 샘플러 태스크 + 팬아웃으로 승격.
        while True:
            try:
                # snapshot 은 읽기 **오류**를 스스로 fail-closed 로 잡는다. 여기서 감싸는 건
                # 읽기가 **멈추는**(hang) 경우다 — 상한을 넘으면 얼어붙기 전에 끊는다 (감사 #3·#5)
                snap = await asyncio.wait_for(asyncio.to_thread(snapshot), ROBOT_TIMEOUT_S)
            except asyncio.TimeoutError:
                session.fail_closed(f"상태 읽기 {ROBOT_TIMEOUT_S:.0f}s 무응답 — 연결 손실 판정")
                log("stream-timeout", str(ws.client))
                try:
                    await ws.send_text(json.dumps(
                        {"ok": False, "phase": "FAIL_CLOSED", "reason": "상태 읽기 무응답 — 연결 손실"}))
                except Exception:
                    pass
                return
            except Exception as e:
                # 읽기 밖의 예상 못 한 예외(직렬화 등) — 조용히 죽지 않게 알리고 닫는다 (감사 #3)
                log("stream-error", f"{ws.client} {e}")
                return
            try:
                await ws.send_text(json.dumps(snap))
            except Exception:
                return                        # 소켓이 닫히는 중 — 바깥 finally 가 정리한다
            await asyncio.sleep(SAMPLE_MS / 1000)

    send_task = asyncio.create_task(sender())

    # ── **수신과 실행을 가른다** (2026-09-03 · `SAFETY-RULES.md` §도착까지가 규약이다)
    #
    # ⛔ 전에는 `res = await handle_cmd(...)` 였다. 그래서 **이동 중에 온 `stop` 이 그 이동이
    # 끝날 때까지 버퍼에 머물렀다** — 「통과한다」는 참인데 로봇은 계속 움직였다. 지연은
    # 남은 이동 시간과 같아 지점 이동에서는 최대 `MOVE_SETTLE_CAP_S`(60초)까지 벌어진다
    # (2026-08-10 목 브리지 로그).
    #
    # 그래서 **`stop` 은 받은 자리에서 처리하고 나머지를 큐에 넣는다.** 큐는 하나라
    # `stop` 외의 순서는 그대로 지켜진다 — 동시에 돌리면 이동 두 개가 겹친다.
    # ⛔ **깊이에 상한을 둔다.** 무한 큐면 밀린 명령이 조용히 쌓이고, 사람은 「눌렀는데
    # 반응이 없다」만 본다. 넘치면 **거부를 돌려준다** — 삼키지 않는다.
    CMDQ_MAX = 32
    cmdq = asyncio.Queue(maxsize=CMDQ_MAX)

    async def worker():
        while True:
            m, m_who, m_token = await cmdq.get()
            try:
                # ⛔ **신원은 «받은 때» 것을 쓴다** (2026-09-03 자기리뷰에서 잡았다).
                # 클로저의 `who`·`token` 을 실행 시점에 읽으면, 큐에 넣은 뒤 `hello` 가
                # 오는 순간 **앞 명령이 새 사람 신원으로 실행된다** — 조종권 판정이
                # 뒤바뀐다. 직렬 실행이던 때는 둘이 같은 순간이라 안 보이던 자리다.
                res = await handle_cmd(m, m_who, m_token)
                if not res.get("ok"):
                    await ws.send_text(json.dumps(res))
            except Exception as e:                      # noqa: BLE001
                log("cmd-error", f"{ws.client} {e}")    # 조용히 죽으면 눌린 버튼이 사라진다
            finally:
                cmdq.task_done()

    work_task = asyncio.create_task(worker())
    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except json.JSONDecodeError:
                continue
            if msg.get("cmd") == "hello":
                # 이름은 표시용, 토큰이 조종권을 증명한다 (D55)
                if who:
                    owner.session_close(who)
                who = str(msg.get("who") or "") or None
                token = msg.get("token")
                if who:
                    owner.session_open(who)
                continue
            if msg.get("cmd") == "stop":
                # **줄서지 않는다.** 제3원칙 — 조종권·신원·phase 를 안 묻는다
                res = await do_stop(who, via="ws")
                if not res.get("ok"):
                    await ws.send_text(json.dumps(res))
                continue
            try:
                cmdq.put_nowait((msg, who, token))       # **받은 때의 신원**을 같이 넣는다
            except asyncio.QueueFull:
                await ws.send_text(json.dumps(
                    {"ok": False, "reason": f"명령이 {CMDQ_MAX}개 밀려 있다 — 잠시 뒤 다시",
                     "reasons": [f"명령이 {CMDQ_MAX}개 밀려 있다 — 잠시 뒤 다시"]}))
    except WebSocketDisconnect:
        pass
    finally:
        work_task.cancel()
        send_task.cancel()
        if who:
            owner.session_close(who)
        log("ws-close", str(ws.client))


# ── 받침 추적 — **브리지 안에서 돈다** (계약 §움직이는 장애물 · D130)
#
# 왜 사이드카가 아닌가 (2026-08-13): 옆 프로세스로 세 번 세웠고 세 번 다 **조용히** 죽었다.
# 원인은 하나였고 레포에 이미 적혀 있었다 — **윈도우 sshd 는 세션이 끊기면 자식을 거둬간다**
# (`docs/evidence/2026-08-11/windows-host-bringup.md` §상주). 여기 두면 **생사가 하나**다:
# 브리지가 살면 추적도 살고, 브리지가 죽으면 화면이 통째로 안 떠서 **아무도 못 속는다.**
#
# ⛔ **비전이 브리지를 죽이지 않는다** — 스레드는 daemon 이고 루프가 예외를 통째로 먹는다.
# cv2 가 없거나 주소를 안 주면 **조용히 안 돈다**(= 받침을 안 쓴다. 고장이 아니다).
@app.on_event("startup")
def _start_fixture_tracker():
    cam_host = os.environ.get("FR5_CAM_HOST", "").strip()
    fixture.start_tracker(
        cam_host,
        # ⛔ **id 를 안 주면 안 돈다** (D149). 설정에 `fixture_tag_id` 가 없으면 꺼진 것이고
        # 그게 지금 기본이다 — **고정 거치대는 프로필 작업영역 상자**로 들어갔다(로봇 실측).
        # 여기는 **자주 옮겨지는 받침**만 맡는다. 옛 코드는 `fixtureTags[0]` 을 집었는데
        # 목록이 9개로 늘고 맨 앞(id6 · 나무 정육면체)이 사라져 08-27 에 `noTag` 로 났다.
        tag_id=CONFIG.get("fixture_tag_id"),
        out_path=str(CONFIG_DIR / "fixture-pose.json"),
        spec_path=str(HERE.parent.parent / "Shared" / "assets" / "tag" / "tags.json"),
        calib_path=str(CONFIG_DIR / "global-cam.json"),
        base_path=str(CONFIG_DIR / "robot-base-in-tag.json"),
        # **user1 은 로봇이 붙어야 안다** — 매 틱 물어본다. 없으면 안 쓴다(제1원칙)
        user_getter=lambda: ((session.coordDefs or {}).get("user")
                             if getattr(session, "coordDefs", None) else None),
    )


# ── 장면 앵커 추적 — **같은 자리, 같은 이유** (계약 §앵커 상주 · D146)
#
# 받침(위)이 게이트 값을 내는 안전 경로라면 이쪽은 **이야기 레이어**(가상 소품 자리)다.
# 둘을 한 자리에 두는 이유는 하나 — **사이드카는 조용히 죽는다.** 2026-08-27 에 앵커가
# 7일 낡은 기준샷으로 서서 컨베이어를 844mm 어긋난 자리에 그렸는데 화면은 전부 초록이었다.
#
# 캘리브는 **자기 자신의 `/config`** 에서 읽는다 — 파일을 직접 열지 않는 이유는
# `Chain.refresh()` 를 그대로 얻기 위해서다(기준샷이 바뀌면 사슬을 갈아탄다).
@app.on_event("startup")
def _start_anchor_tracker():
    cam_host = os.environ.get("FR5_CAM_HOST", "").strip()
    anchors.start_tracker(
        cam_host,
        out_path=str(CONFIG_DIR / "scene-anchors.json"),
        repo_root=str(HERE.parent.parent),
        conf_url=f"http://127.0.0.1:{CONFIG.get('port', 5055)}/config/global-cam.json",
    )
    # ── 색으로 거치대 찾기 — **태그를 안 쓴다** (2026-09-04) ──────────────────
    # 실기 담당자 *"애초에 글로벌캠에 잡히는데"*. 영상에 물건이 보이는데 코드가 태그만 찾아서
    # 「보이는데 못 본다」였고, 그래서 표적이 물건이 아니라 **종이 태그**였다 —
    # 태그가 물건에 안 붙어 있으니 물건을 옮겨도 팔은 안 따라갔다.
    # ⛔ **파일을 가른다** (`carrier-pose.json`). 앵커 파일은 못 본 태그의 옛 값을 남기는데
    #    (소품에는 그게 옳다) 사람이 손으로 옮기는 물건에 같은 규칙을 쓰면 **없는 자리로
    #    팔을 보낸다.** 나이 판정은 읽는 쪽(`follow_target_tag`)이 한다.
    anchors.start_color_tracker(
        out_path=str(CONFIG_DIR / "carrier-pose.json"),
        repo_root=str(HERE.parent.parent),
        self_host=f"127.0.0.1:{CONFIG.get('port', 5055)}",
    )


# ── 터틀봇 자리 추적 — **앵커와 같은 뼈대, 다른 규칙** (2026-08-28)
#
# 왜 앵커에 같이 안 태우나: 뼈대는 안 보인 태그의 **옛 값을 남긴다.** 종이 소품에는 그게
# 옳지만(저 혼자 안 움직인다) 터틀봇은 달린다 — 안 보이는 동안 옛 자리를 남기면 추종이
# **없는 로봇을 쫓는다.** 그래서 **파일을 갈랐다**(`amr-pose.json`). 나이 판정은 읽는 쪽
# (§follow_target · 2.5초)이 한다.
#
# 왜 맥에서 안 돌리나: 처음엔 맥에서 돌려 scp 로 밀었는데 **표적 나이가 2.3초**까지 올라와
# 상한(2.5초)에 붙었다 — 서 있는 로봇에서 그렇다. 달리면 계속 끊긴다. 왕복이 원인이라
# 카메라를 보는 기계(브리지)로 옮긴다. 옆 프로세스로 세우지 않는 이유는 위 §받침·앵커와
# 같다 — **윈도우 sshd 가 세션 종료 때 자식을 거둬간다** (D131).
@app.on_event("startup")
def _start_amr_tracker():
    cam_host = os.environ.get("FR5_CAM_HOST", "").strip()
    anchors.start_tracker(
        cam_host,
        out_path=str(CONFIG_DIR / "amr-pose.json"),
        repo_root=str(HERE.parent.parent),
        conf_url=f"http://127.0.0.1:{CONFIG.get('port', 5055)}/config/global-cam.json",
        ids=(follow.AMR_TAG_ID,),
        # 소품(2.0초)보다 촘촘하다 — 이건 달린다
        period_s=1.0,
        name="amr",
    )
    # ── 터틀봇 바퀴 — **두 번째 출처** (2026-08-31 · D158) ────────────────────
    # 태그는 7% 밖에 안 잡힌다(실측). 바퀴는 100% 인데 밀린다. 둘을 같이 든다.
    # ⛔ 주소를 안 주면 안 돈다 = 기능을 안 켠 것이다 — `FR5_CAM_HOST` 와 같은 규약이다.
    amr.start_reader(
        amr.host_of(CONFIG_DIR),
        robot_id=CONFIG.get("amrRobotId", "tb3_2"),
        out_path=str(CONFIG_DIR / "amr-frame.json"),
    )

    # ── 손목캠 창구 — **글로벌캠을 안 지나는 유일한 출처** (2026-09-04 · D177) ──
    # 위 셋은 전부 폰 산출물이라 폰이 꺼지면 표적이 통째로 언다(그날 71분). 손목 뎁스는
    # 337mm 에서 라이다 윗면 **평면**을 직접 재므로 태그도 폰도 필요 없다.
    # ⛔ **옆 프로세스로 못 세운다** — ssh 자식은 세션 종료 때 거둬가고 `schtasks` 는
    #    결과 1 로 안 떴다(09-04 에 셋 다 실패). 그래서 여기, 앵커·색과 같은 자리다.
    anchors.start_wrist_tracker(
        out_path=str(CONFIG_DIR / "wrist-pose.json"),
        repo_root=str(HERE.parent.parent),
        self_host=f"127.0.0.1:{CONFIG.get('port', 5055)}",
        cam_host=os.environ.get("FR5_DEPTH_HOST", "127.0.0.1:5058").strip(),
        tag_id=follow.AMR_TAG_ID,
        # ⛔ **자기 `/state` 를 HTTP 로 부르지 않는다** — 0.5초마다 `read_fresh_state()` 가
        #    돌아 SDK 를 더 두드린다(09-04 에 추종이 3초 만에 FAIL_CLOSED 로 끊겼다).
        state_fn=lambda: {"tcpMmDeg": getattr(session, "tcpMmDeg", None),
                          "handEye": session.hand_eye()},
    )


@app.on_event("shutdown")
async def _shutdown():
    # 브리지가 죽을 때 CloseRPC 없이 나가면 컨트롤러가 세션을 쥔 채 남아
    # 펜던트 로그인까지 막을 수 있다 (2026-07-31 실측 추정) — 반드시 정리하고 나간다
    await stop_recording("disconnect")
    if session.adapter:
        session.close()
        log("shutdown-disconnect", "세션 정리")


# ── 보정값 서빙 — `Shared/data/config/*.json` 을 **디스크에서 그대로** 낸다 (계약 §정적 서빙).
#
# **번들에 넣으면 안 되는 값들이다.** 화면이 `import.meta.glob({eager:true})` 로 읽던 동안
# 캘리브레이션은 **빌드한 순간에 굳었고**, 카메라를 다시 거치해 파일이 바뀌어도 화면은 몰랐다 —
# 실제로 빌드본이 X 로 531mm 어긋난 채 그럴듯하게 겹치고 있었다 (2026-08-08).
# 여기는 요청할 때마다 디스크를 읽으므로 `extrinsics.py` 를 돌리면 **새로고침만으로** 반영된다.
#
# 이 파일들은 `scripts/map/*.py` 의 산출물이라 **캘리브레이션 전에는 정상적으로 없다.**
# 폴더가 없으면 마운트를 안 하고, 그러면 404 다 — 읽는 쪽이 그걸 "보정 없음"으로 읽는다.
# `/ar` · `/` catch-all **앞**에 둔다. 뒤에 두면 `/` 가 먼저 먹고 dist 안을 뒤진다.
CONFIG_DIR = HERE.parent.parent / "Shared" / "data" / "config"
if CONFIG_DIR.exists():
    app.mount("/config", StaticFiles(directory=CONFIG_DIR), name="config")

# ── AR 정적 서빙 — 라이브 셀(cell.html) 등 AR 화면을 **같은 출처**에서 낸다. 그래야 폰/노트북이
# `/ws/state` 에 프록시·혼합콘텐츠 없이 붙는다 (Vercel 공개본은 LAN 평문 ws 에 못 닿는다).
# AR 은 `base: './'` 로 빌드하므로 이 하위경로에서 에셋이 상대로 풀린다. `/` catch-all **앞**에 둔다.
# ── 구운 MJCF 장면 — `Sim/out/scene/` 을 **디스크에서 그대로** (계약 §정적 서빙 · 2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 0).
# 산출물이라 없을 수 있다(gitignore · 랩 브리지 호스트) — 그러면 404 이고 화면은 접촉 층을 「못 잼」으로 내린다.
# `check_dir=False` 라 폴더가 없어도 브리지는 뜬다. `/` catch-all **앞**에 둔다.
app.mount("/sim/scene", StaticFiles(directory=str(HERE.parent.parent / "Sim" / "out" / "scene"), check_dir=False), name="sim-scene")

AR_DIST = HERE.parent.parent / "AR" / "dist"
if AR_DIST.exists():
    app.mount("/ar", StaticFiles(directory=AR_DIST, html=True), name="ar")

# ── 웹 정적 서빙 — 빌드가 있으면 같은 주소에서 화면을 낸다 (API 라우트가 먼저 매칭된다)
DIST = HERE.parent / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
