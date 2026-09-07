"""브리지 호스트 주소를 **한 곳에서** — `host.sh` 의 파이썬 얼굴 (2026-09-03 · D164).

`scripts/dev/host.sh` 가 이름(`DESKTOP-EAADSGE.local`)으로 풀고 **살아 있는지까지** 본다.
셸 쪽은 `eval "$(bash scripts/dev/host.sh)"` 로 그걸 쓰는데, 파이썬 도구들은 쓸 길이 없어
각자 숫자를 기본값으로 들고 있었다 — 그리고 그 숫자가 **전부 `.18` 로 낡아 있었다**
(오늘 호스트는 다른 주소다). 주석에는 *"이 숫자를 믿지 않는다"* 라고 적혀 있었지만
**경고는 산문에 있고 위험은 코드에 있었다.** 이 파일이 그 틈을 없앤다.

⛔ **못 찾으면 `None` 이다. 숫자를 지어내지 않는다** — 조용히 틀린 기계에 붙는 것이
못 붙는 것보다 나쁘다 (D144 에서 겪었다).

    from host import bridge_host       # sys.path 에 scripts/dev 를 넣고
    host = bridge_host()               # '192.168.30.6' 또는 None
"""
import os
import subprocess
from pathlib import Path

_SH = Path(__file__).with_name("host.sh")


def bridge_host(timeout=15):
    """브리지 호스트 IP 문자열. **못 찾으면 `None`.**

    `FR5_WIN_HOST` 가 있으면 그것이 이긴다(사람이 이번 한 번만 다르게 쓸 때) — 그 규약은
    `host.sh` 가 든다. 여기서 다시 구현하지 않는다 (하드 룰 5).
    """
    env = os.environ.get("FR5_HOST_IP", "").strip()
    if env:
        return env
    try:
        out = subprocess.run(["bash", str(_SH)], capture_output=True, text=True, timeout=timeout)
    except Exception:                                    # noqa: BLE001
        return None
    for line in out.stdout.splitlines():
        if line.startswith("export FR5_HOST_IP="):
            v = line.split("=", 1)[1].strip().strip("'\"")
            return v or None
    return None


def require(port, path="", what="브리지"):
    """`http://<host>:<port><path>` 를 만든다. 호스트를 못 찾으면 **사유와 함께 멈춘다.**

    ⛔ 부르는 쪽이 `or '192.168...'` 를 붙이지 못하게 **예외로** 끝낸다 — 반환값을 `None`
    으로 두면 다음 사람이 그 자리에 숫자를 넣는다. 그게 D164 가 막으려던 그 손버릇이다.
    """
    h = bridge_host()
    if not h:
        raise SystemExit(
            f"⛔ {what} 호스트를 못 찾았다 — 그 PC 가 망에 없거나 꺼졌다.\n"
            "   이름으로 푸는 곳은 scripts/dev/host.sh 하나다. 이번만 다른 기계면\n"
            "   FR5_WIN_HOST=<ip> 를 주고 다시 돌린다. ⛔ 숫자를 코드에 박지 마라 (D164)."
        )
    return f"http://{h}:{port}{path}"
