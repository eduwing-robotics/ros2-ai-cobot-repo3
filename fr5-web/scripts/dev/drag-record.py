#!/usr/bin/env python3
"""직접교시 킬실험 기록기 — 사다리 1번 (`docs/ref/plan/VISION-SERVO-LADDER.md`).

절차는 `docs/ref/runbook/WORKCELL-MEASURE.md` §순서 그대로다. 이 스크립트는 그 옆에서
**값만 받아적는다** — 판정 ①(팔이 사람 힘으로 밀리나)은 사람 눈이고, 판정 ②(그동안
20004 관절값이 따라오나)를 눈이 아니라 **수치로** 내는 것이 여기 목적이다.

## 읽기 전용이다 — 이유가 있다

`GET /state` 만 부른다. **조종권을 잡지 않고 WebSocket 도 열지 않는다.** 잡으면 세션이
끊길 때 10초 뒤 자동 해제가 돌고(`FR5/bridge/owner.py` AUTO_RELEASE_S), 그 자리에서
브리지가 `disarm` 한다 — 사람이 팔을 잡고 있는 중에 서보가 내려간다. 기록기가 실험을
망가뜨리는 경로를 아예 만들지 않는다.

## 「따라온다」는 주기가 아니라 **갱신과 결측**이다 (2026-08-10 정정)

처음엔 `t` 간격을 20004 주기로 읽었는데 **틀렸다.** `/state` 는 요청마다 새로 읽으므로
(`main.py:236` · WS 도 접속마다 — `:515` ponytail) 그 간격은 **우리 왕복 시간**이지 스트림
주기가 아니다. 실제로 물어야 할 것은 둘이다.

- **결측 0** — `read_state` 의 `inDragTeach` 는 **xmlrpc(20003)** 호출이다(`fairino.py:286`).
  못 읽으면 `missing` 에 남고 게이트가 fail-closed 한다. 결측이 나면 명령 채널이 답을 못 한 것이다
- **관절값이 표본마다 갱신** — 사람이 미는데 연속 표본이 완전히 같으면 20004 가 얼었다는 뜻이다

## 느리게 묻는다 — 빨리 물으면 명령 채널을 두드린다

위 이유로 폴링 1회 = xmlrpc 1회다. 그 채널은 **연결이 하나뿐이고 `stop` 도 거기로 나간다.**
2026-08-05 에 그 연결이 굳어 상태가 통째로 죽은 적이 있다
(`docs/evidence/2026-08-05/teach-points-trajectory.md`). 사람 손이 팔에 올라간 실험에서 기록기가
그 채널을 초당 30번 두드릴 이유가 없다 — 사람 동작은 초 단위다.

  ponytail: 그래서 이 기록기는 **킬실험 전용**이다. 사다리 9번(시연 20~50회 녹화)은 이 경로로
  하지 않는다 — `main.py:515` 가 지목한 **단일 샘플러 + 팬아웃** 승격이 선행이다. 한 번 읽어
  여럿에게 뿌려야 녹화가 명령 채널을 잠식하지 않는다.

    사용:  python3 scripts/dev/drag-record.py                    # 기본 호스트
           python3 scripts/dev/drag-record.py --host 192.168.30.240:5055
           Ctrl-C 로 끝내면 판정이 나온다. 원값은 .diag/drag-<시각>.jsonl

  ponytail: 관절 이동량은 **합**만 낸다(축별 궤적 분석 없음). 킬실험의 질문은 "밀리나 ·
  값이 따라오나" 둘뿐이고, 궤적 품질은 사다리 9번(시연 녹화) 차례다. 그때 이 파일의
  jsonl 을 그대로 입력으로 쓴다 — 포맷을 바꾸지 않는다.
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent.parent
DEFAULT_HOST = "192.168.30.240:5055"

# 이만큼도 안 움직였으면 사람이 못 민 것이다 (관절 6축 변화량 합).
MOVED_MIN_DEG = 1.0
# 폴링 1회 = xmlrpc 1회다 (위 §느리게 묻는다). 사람이 미는 동작은 초 단위라 7Hz 면 넘친다.
POLL_S = 0.15
# 미는 동안 관절값이 통째로 같은 표본이 이만큼 이어지면 스트림이 언 것이다.
# 7Hz 기준 5표본 ≈ 0.7초 — 사람이 잠깐 멈춘 것과 구분되도록 넉넉히 잡는다.
FROZEN_RUN_MAX = 5


def fetch(url, timeout=1.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))


def fmt_settings(applied):
    """ARM 이 넣고 되읽은 하중값. **사다리 0번이 실기에 닿았는지가 여기서 보인다.**

    값은 top-level 이 아니라 `sent`/`readback` 아래에 있다 (조건 26 — 넣은 것과 되읽은 것을
    따로 들고 대조한다). 되읽기가 되는 항목은 하중·무게중심·툴 좌표·소프트리밋 넷뿐이고
    나머지는 `unverifiable` 로 정직하게 남는다 (`SAFETY-RULES.md` §조건 26).
    """
    if not applied:
        return "appliedSettings 없음 — ARM 전이다"
    sent = applied.get("sent") or {}
    back = applied.get("readback") or {}
    mism = applied.get("mismatch") or []
    line = (f"넣은 값 {sent.get('payloadKg')} kg · {sent.get('cogMm')} mm"
            f"  →  되읽음 {back.get('payloadKg')} kg · {back.get('cogMm')} mm")
    if mism:
        return line + f"\n      ⚠ 어긋난 항목: {mism}"
    return line + f"  (일치 · 되읽기 불가 {len(applied.get('unverifiable') or [])}개)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--out", default=None, help="기본 .diag/drag-<시각>.jsonl")
    # 실험은 Ctrl-C 로 끝내지만, 스모크로 한 번 돌려볼 때는 손이 필요 없어야 한다
    ap.add_argument("--seconds", type=float, default=None, help="이 시간이 지나면 스스로 끝낸다")
    args = ap.parse_args()
    deadline = (time.monotonic() + args.seconds) if args.seconds else None

    url = f"http://{args.host}/state"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = Path(args.out) if args.out else HERE / ".diag" / f"drag-{stamp}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        first = fetch(url)
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"브리지에 못 붙었다 — {url}\n  {e}", file=sys.stderr)
        return 2

    print(f"기록: {out}")
    print(f"로봇: {first.get('robotId')} · phase {first.get('phase')} · "
          f"서보 {'ON' if first.get('enabled') else 'off'}")
    print(f"설정: {fmt_settings(first.get('appliedSettings'))}")
    print("\n펜던트에서 드래그를 켜고 팔을 미세요. 끝나면 Ctrl-C.\n")
    print(f"{'서버프레임':>8} {'드래그':>6} {'모드':>4}  {'관절 이동합(°)':>14}  {'최근간격(ms)':>12}")

    frames = []          # 서버가 실제로 갱신한 프레임만 (t 로 중복 제거)
    last_t = None
    moved_deg = 0.0
    stalls = 0           # 폴링했는데 t 가 그대로였던 횟수 (참고용)
    fails = 0
    missing = 0          # `inDragTeach` 키가 없던 표본 — xmlrpc 가 답을 못 했다
    disconnected = 0     # 브리지가 로봇을 잃은 채였던 표본 — 실험이 아니라 연결 문제다
    frozen = frozen_max = 0   # 미는 중인데 관절값이 통째로 같았던 연속 표본

    with out.open("w", encoding="utf-8") as fp:
        try:
            while deadline is None or time.monotonic() < deadline:
                time.sleep(POLL_S)
                try:
                    s = fetch(url)
                except (urllib.error.URLError, OSError, ValueError):
                    fails += 1
                    continue

                t = s.get("t")
                if t is None or t == last_t:
                    stalls += 1
                    continue

                # **연결부터 본다.** 브리지가 로봇을 잃으면 `snapshot()` 은 기본값 껍데기를
                # 낸다(`session.py` clear) — `mode`·`inDragTeach` 가 그럴싸한 거짓으로 온다.
                # 이걸 안 보면 "드래그가 안 켜졌다(막힘)" 로 읽는데 진실은 "로봇이 없다" 다.
                # 2026-08-10 에 실제로 이 착각을 했다 — 20표본을 받아적고 막힘을 냈다.
                if not s.get("connected"):
                    disconnected += 1
                    continue
                sf = s.get("safety") or {}
                # **`get()` 으로 뭉개지 않는다.** 키가 아예 없으면 xmlrpc 가 답을 못 한 것이고
                # (`fairino.py:298` — 결측이면 safety 에 키를 안 넣는다), 그걸 False 로 읽으면
                # "드래그 아님" 이 된다 — fail-open 이다. 셋(참·거짓·결측)을 그대로 들고 간다.
                drag = sf.get("inDragTeach")
                # fail-closed — 드래그가 참인 표본만 판정에 쓴다.
                # 런북 §순서 4 의 "드래그중 이 True 가 아니면 그 값은 버린다" 와 같은 규칙이다.
                rec = {"t": t, "mode": s.get("mode"), "inDragTeach": drag,
                       "jointsDeg": s.get("jointsDeg"), "tcpMmDeg": s.get("tcpMmDeg")}
                fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
                if drag is None:
                    missing += 1

                if frames and drag and frames[-1]["inDragTeach"]:
                    a, b = frames[-1]["jointsDeg"], rec["jointsDeg"]
                    if a and b:
                        step = sum(abs(y - x) for x, y in zip(a, b))
                        moved_deg += step
                        # 완전히 같은 값이 이어지면 20004 가 언 것이다 — 가장 긴 구간만 들고 간다
                        frozen = frozen + 1 if step == 0.0 else 0
                        frozen_max = max(frozen_max, frozen)
                gap = (t - last_t) * 1000.0 if last_t else 0.0
                frames.append(rec)
                last_t = t

                if len(frames) % 10 == 0:
                    print(f"\r{len(frames):>8} {str(rec['inDragTeach']):>6} "
                          f"{str(rec['mode']):>4}  {moved_deg:>14.2f}  {gap:>12.1f}",
                          end="", flush=True)
        except KeyboardInterrupt:
            pass
    print("\n")

    return verdict(frames, moved_deg, missing, frozen_max, stalls, fails, disconnected, out)


def verdict(frames, moved_deg, missing, frozen_max, stalls, fails, disconnected, out):
    """`GOAL` 보고 형식 그대로 — 재현됨 / 근사됨 / 막힘 / 불확실."""
    drag = [f for f in frames if f["inDragTeach"] is True]
    print(f"표본 {len(frames)}개 · 그중 드래그 중 {len(drag)}개 "
          f"(같은 t 반복 {stalls} · 요청 실패 {fails} · **결측 {missing}**)")
    print(f"원값: {out}")

    if fails and not frames:
        print("\n판정: **불확실** — 브리지 응답을 못 받았다. 실험이 아니라 연결 문제다")
        return 3
    if disconnected:
        # 연결이 먼저다 — 로봇이 없는데 "드래그가 안 켜졌다" 로 읽으면 엉뚱한 데를 고친다
        print(f"\n판정: **불확실** — 브리지가 로봇을 잃은 표본 {disconnected}개.")
        print("  실험이 아니라 연결 문제다. `docs/ref/runbook/FR5-BRINGUP.md` §안 될 때 로 간다")
        return 3
    if missing:
        # 결측은 게이트가 fail-closed 하는 값이다 — 실험 결과보다 이게 먼저다
        print(f"\n판정: **불확실** — `inDragTeach` 결측 {missing}회. xmlrpc(20003)가 답을 못 했다.")
        print("  값이 아니라 채널 문제다. 다시 재기 전에 연결부터 본다")
        print("  (`docs/evidence/2026-08-05/teach-points-trajectory.md` — 그 연결이 굳은 전례)")
        return 3
    if not drag:
        print("\n판정: **막힘** — `inDragTeach` 가 한 번도 True 가 아니었다.")
        print("  갈라볼 것 셋: ①펜던트 인에이블을 쥐고 있었나 ②`수동으로`(mode 1)로 넘겼나")
        print("  ③말단 하중·설치방향이 들어갔나 (`docs/ref/arch/DEPTH-CAM.md` §하중)")
        return 1

    gaps = [(b["t"] - a["t"]) * 1000.0 for a, b in zip(drag, drag[1:]) if b["t"] > a["t"]]
    if gaps:
        # **참고값이다** — 20004 주기가 아니라 우리 왕복 시간이다 (위 §「따라온다」)
        print(f"왕복 시간(참고): 중앙 {statistics.median(gaps):.1f}ms")
    print(f"관절 이동합: {moved_deg:.2f}° · 최장 정지 연속 {frozen_max}표본")

    if moved_deg < MOVED_MIN_DEG:
        print(f"\n판정: **막힘** — 드래그는 켜졌는데 팔이 {MOVED_MIN_DEG}° 도 안 움직였다.")
        print("  드래그 스위치는 먹었으나 팔이 안 풀린 것이다 — 하중·설치방향을 먼저 본다")
        return 1
    if frozen_max > FROZEN_RUN_MAX:
        print(f"\n판정: **근사됨** — 팔은 밀렸는데 관절값이 {frozen_max}표본 동안 굳어 있었다.")
        print("  시연 방식은 확정이다. 남은 것은 스트림이 끊긴 자리라 따로 잡는다")
        print("  (사람이 손을 멈춘 것과 구분하려면 원값의 그 구간을 눈으로 본다)")
        return 0
    print("\n판정: **재현됨** — 팔이 밀리고 관절값이 결측 없이 따라온다.")
    print("  사다리 1번 닫힘 → 9번(시연 녹화)을 A축과 병렬로 착수할 수 있다")
    print("  ⚠ 단 9번은 이 경로로 하지 않는다 — 단일 샘플러 + 팬아웃 승격이 선행 (`main.py:515`)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
