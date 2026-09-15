"""장면 앵커 상주 — **브리지 안에서 돈다** (계약 `API-CONTRACT.md` §앵커 상주 · D146).

`fixture.py` 와 **같은 자리, 같은 이유**다: 윈도우 sshd 는 세션이 끊기면 자식을 거둬가서
옆 프로세스로 세우면 **조용히 죽는다.** 그러면 `scene-anchors.json` 이 마지막 값에 얼어붙는데
화면은 초록이라 아무도 모른다 — 2026-08-27 에 앵커가 **7일 낡은 기준샷**으로 서서 컨베이어를
**844mm** 어긋난 자리에 그리고 있었다. 브리지 안에 두면 **생사가 하나**다.

⛔ **풀이를 여기서 다시 짜지 않는다.** 사슬·검출·원자적 쓰기 전부 `scripts/map/marker_follow.py`
(공용 뼈대 · D135)가 한다. 여기는 **그 뼈대를 스레드에 얹을 뿐**이다. `anchor-pose.py` 가
같은 뼈대를 CLI 로 얹는 것과 짝이다 — 한 구현을 둘이 쓴다.

⚠ **안전 경로가 아니다.** 게이트가 읽을 값은 `fixture.py` 가 낸다(D130·D131 — 점프 가드 ·
「못 보면 마지막 값으로 계속 막는다」). 여기는 **이야기 레이어**(가상 소품 자리)까지다.

⛔ **id18(터틀봇)은 기본 목록에서 뺐다** (2026-08-28). 뼈대는 안 보인 태그의 **옛 값을
남긴다** — 종이 소품에는 그게 옳다(저 혼자 안 움직이니까). 그런데 터틀봇은 달린다.
같은 파일에 같이 두면 「안 보이는 동안 옛 자리에 서 있는 로봇」이 소품 취급으로 남는다.
그래서 **출력을 갈랐다**(`amr-pose.json`) — 이 모듈을 두 번째로 얹어서 쓴다. 규칙이 다르면
파일이 달라야 하고, 나이 판정은 읽는 쪽(`main.follow_target`)이 한다.
"""
import os
import sys
import threading
import time
from pathlib import Path

# 상주 상태 — **추적기마다 한 칸**이다 (2026-08-28). 예전엔 칸이 하나였고, 터틀봇 추적기를
# 두 번째로 얹는 순간 둘이 서로의 사유를 덮어썼다 — 「왜 안 도나」에 **엉뚱한 놈의 답**이
# 나오는 자리다. `fixture.py` 의 `_cache` 가 같은 날 같은 이유로 갈라졌다.
_states = {}


def note(name="anchor"):
    """왜 안 도는지 한 줄. `None` 이면 도는 중이거나 안 켠 것이다."""
    return (_states.get(name) or {}).get("note")


def start_tracker(cam_host, out_path, repo_root, conf_url, ids=(15, 21, 32, 33),
                  period_s=2.0, name="anchor"):
    """앵커 추종을 **브리지 프로세스 안에서** 상주시킨다. 실패해도 브리지를 안 죽인다.

    `conf_url` 은 **살아 있는 캘리브** 주소다(보통 자기 자신의 `/config/global-cam.json`).
    파일을 직접 읽지 않고 이 주소를 쓰는 이유는 `Chain.refresh()` 를 그대로 얻기 위해서다 —
    호스트가 스스로 재정합하면(`watch-calib --auto`) 기준샷이 바뀌고, 그때 사슬이 갈아탄다.
    """
    st = _states.setdefault(name, {"note": None, "at": None})
    if not cam_host:
        st["note"] = None          # 주소를 안 준 것 = 기능을 안 켠 것. 경고가 아니다
        return

    # ⛔ **무거운 것은 여기서 늦게 임포트한다.** 최상단에 두면 cv2 가 없는 기계에서
    # **브리지가 통째로 안 뜬다** (`fixture.py` §추적이 같은 이유로 그렇게 한다).
    try:
        sys.path.insert(0, str(Path(repo_root) / "scripts" / "map"))
        from marker_follow import Chain, follow      # noqa: PLC0415 — 늦은 임포트가 의도다
    except Exception as e:                            # noqa: BLE001
        st["note"] = f"{name} 상주 꺼짐 — 뼈대 임포트 실패 ({str(e)[:50]})"
        return

    def loop():
        chain = None
        while True:
            try:
                if chain is None:
                    # 캘리브가 아직 없거나 못 읽으면 여기서 걸린다 — **계속 다시 본다**.
                    # 브리지가 먼저 뜨고 감시기가 나중에 뜨는 순서가 정상이라서다
                    chain = Chain(conf_url=conf_url)
                    st["note"] = None
                follow(chain, set(ids), Path(out_path), cam_host,
                       period=period_s, mirror=None, log=lambda *_: None)
                # `follow` 는 정상적으로 안 끝난다 — 돌아왔으면 다시 건다
            except Exception as e:                    # noqa: BLE001 — 무엇이 나오든 다시 본다
                st["note"] = f"{name} 상주 쉬는 중 — {str(e)[:60]}"
                st["at"] = round(time.time(), 1)
                chain = None
            time.sleep(period_s * 2)

    threading.Thread(target=loop, name=f"{name}-tracker", daemon=True).start()


def start_color_tracker(out_path, repo_root, self_host, period_s=1.5, name="color"):
    """**색으로 거치대를 찾는 추적기**를 브리지 안에서 상주시킨다 (2026-09-04).

    위 태그 추적기와 **같은 자리, 같은 이유**다 — 옆 프로세스로 세우면 윈도우 sshd 가
    조용히 거둬가고, 그러면 산출 파일이 마지막 값에 얼어붙는데 화면은 초록이다.

    ⛔ **풀이를 여기서 다시 짜지 않는다.** `scripts/map/color-find.py` 가 정본이고 여기는
    그 `setup`/`locate` 를 스레드에 얹을 뿐이다 — CLI 와 상주가 **한 구현을 같이 쓴다.**
    """
    st = _states.setdefault(name, {"note": None, "at": None})
    try:
        from importlib import util as _u
        sp = Path(repo_root) / "scripts" / "map" / "color-find.py"
        spec = _u.spec_from_file_location("colorfind", sp)
        mod = _u.module_from_spec(spec)
        sys.path.insert(0, str(Path(repo_root) / "FR5" / "bridge"))
        spec.loader.exec_module(mod)                # noqa: S102 — 우리 저장소 파일이다
    except Exception as e:                          # noqa: BLE001
        st["note"] = f"{name} 상주 꺼짐 — 임포트 실패 ({str(e)[:60]})"
        return

    def loop():
        ctx = None
        while True:
            try:
                if ctx is None:
                    ctx = mod.setup(self_host)
                hit, why = mod.locate(ctx)
                mod.write_out(out_path, hit, why)
                st["note"] = None if hit else why
                st["at"] = time.time()
            except Exception as e:                  # noqa: BLE001 — 한 번 실패로 안 죽는다
                st["note"] = f"{type(e).__name__}: {str(e)[:60]}"
                ctx = None                          # 재료부터 다시 받는다
            time.sleep(period_s)

    threading.Thread(target=loop, daemon=True, name=f"{name}-tracker").start()


def start_wrist_tracker(out_path, repo_root, self_host, cam_host,
                        tag_id=18, period_s=0.5, name="wrist", state_fn=None):
    """**손목 깊이로 터틀봇을 찾는 추적기**를 브리지 안에서 상주시킨다 (2026-09-04 · D177).

    위 둘과 **같은 자리, 같은 이유**다 — 2026-09-04 에 이걸 옆 프로세스로 세우려다 세 번
    실패했다(ssh 자식은 세션 종료 때 거둬가고, `schtasks` 는 결과 1 로 안 떴다). 그 두 시간이
    이 함수가 여기 있어야 하는 이유 전부다.

    ⛔ **풀이를 여기서 다시 짜지 않는다.** `scripts/map/wrist-find.py` 가 정본이고 여기는
    그 `setup`/`locate`/`write_out` 을 스레드에 얹을 뿐이다 — CLI 와 상주가 한 구현을 쓴다.

    ⭐ **주기가 앵커(2.0)·색(1.5)보다 촘촘한 0.5 초다.** 읽는 쪽 상한이 2.5초인데 한 판이
    실측 **0.08초**라 여유가 크고, 표적이 달리는 로봇이라 촘촘할수록 낫다.
    """
    st = _states.setdefault(name, {"note": None, "at": None})
    try:
        from importlib import util as _u
        sp = Path(repo_root) / "scripts" / "map" / "wrist-find.py"
        spec = _u.spec_from_file_location("wristfind", sp)
        mod = _u.module_from_spec(spec)
        sys.path.insert(0, str(Path(repo_root) / "FR5" / "bridge"))
        spec.loader.exec_module(mod)                # noqa: S102 — 우리 저장소 파일이다
    except Exception as e:                          # noqa: BLE001
        st["note"] = f"{name} 상주 꺼짐 — 임포트 실패 ({str(e)[:60]})"
        return

    fr5, cam = f"http://{self_host}", f"http://{cam_host}"

    def loop():
        ap = ctx = None
        while True:
            try:
                if ctx is None:
                    ap = mod._measure_mod()
                    ctx = mod.setup(ap)
                hit, why = mod.locate(fr5, cam, ap, ctx, state_fn=state_fn)
                mod.write_out(out_path, tag_id, hit, why)
                st["note"] = None if hit else why
                st["at"] = time.time()
            except Exception as e:                  # noqa: BLE001 — 한 번 실패로 안 죽는다
                st["note"] = f"{type(e).__name__}: {str(e)[:60]}"
                ctx = None                          # 재료부터 다시 받는다
            time.sleep(period_s)

    threading.Thread(target=loop, daemon=True, name=f"{name}-tracker").start()
