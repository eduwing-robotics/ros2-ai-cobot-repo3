#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""발표용 — 5개 모듈을 한 프로세스에서 돌려 폐루프를 표로 보여준다.

    Virtual Sensor → Main Server → AI Safety Engine → Actuator → Simulation → (되돌아감)

브로커 없이 돈다(`InProcBus`). 실제 배포는 모듈 3개를 따로 띄우고 `--bus mqtt` 를 쓴다.
**모듈 코드는 같은 것을 그대로 쓴다** — 시연용으로 따로 만든 로직이 아니다.

사용
    python3 env_demo.py                 # 20초 주기 (요구사항 그대로)
    python3 env_demo.py --period 1      # 흐름만 빨리 확인
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

import argparse
import time

import env_config as C
import env_bus
import env_virtual_sensor as VS
import env_main_server as MS
import env_ai_safety as AI


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--period", type=float, default=C.PERIOD_S)
    ap.add_argument("--ticks", type=int, default=16)
    # ⚠ 기본은 **실제로 주기만큼 기다린다.** 전에는 sleep 이 없어서 `--period 20` 을
    #   줘도 즉시 끝났고, 시간 열만 20초씩 찍혀 진짜 주기처럼 보였다 (2026-09-09 수정).
    #   표만 빨리 보고 싶으면 --no-sleep 을 쓴다.
    ap.add_argument("--no-sleep", action="store_true",
                    help="기다리지 않고 표만 즉시 출력 (시간 열은 --period 기준으로 찍힌다)")
    a = ap.parse_args()

    bus = env_bus.InProcBus()
    env = VS.Environment()
    bus.subscribe(C.T_CONTROL, lambda _t, p: env.apply_control(p))
    srv = MS.MainServer(bus, verbose=False)
    AI.SafetyEngine(bus, verbose=False)

    print("═" * 100)
    print("AI 자율안전관리 — 가상 센서 폐루프 시연")
    print("═" * 100)
    total = a.period * (a.ticks - 1)
    print(f"정상 범위  온도 {C.TEMP_OK[0]}~{C.TEMP_OK[1]}℃ · 습도 {C.HUMI_OK[0]}~{C.HUMI_OK[1]}%"
          f"   |  주기 {a.period:g}초 × {a.ticks}회"
          f"{'' if a.no_sleep else f' = 약 {total/60:.1f}분'}"
          f"  |  저장 {_os.path.basename(srv.csv_path)}")
    print(f"토픽       {C.T_TEMP} · {C.T_HUMI} → {C.T_STATUS} → {C.T_CONTROL}\n")
    print(f"{'경과':>5s} {'온도':>7s} {'습도':>7s}  {'environment/status':<34s} {'AI 제어':<14s} 발행")
    print("─" * 100)

    events = []
    bus.subscribe(C.T_STATUS, lambda _t, p: events.append(p))

    t, fired = 0.0, set()
    for i in range(a.ticks):
        for k, (at, dt_, dh_, why) in enumerate(VS.SCENARIO):
            if k not in fired and i >= at:
                fired.add(k)
                env.inject(dt_, dh_)
        env.step()
        temp, humi = env.read()
        events.clear()
        bus.publish(C.T_TEMP, f"{temp:.1f}")
        bus.publish(C.T_HUMI, f"{humi:.1f}")

        status = C.STATUS_SEP.join(srv.states)
        on = [C.ACT_KO[k] for k in C.ACTUATORS if getattr(env, k)]
        mark = "  " if srv.states == [C.S_NORMAL] else "⚠️"
        print(f"{t:4.0f}s {temp:6.1f}℃ {humi:6.1f}%  {mark}{status:<32s} "
              f"{('+'.join(on) if on else '—'):<14s} {'◀ 발행' if events else ''}")
        t += a.period
        if not a.no_sleep and i < a.ticks - 1:
            time.sleep(a.period)

    srv.close()
    print("─" * 100)
    print(f"저장 완료: {srv.csv_path}")


if __name__ == "__main__":
    main()
