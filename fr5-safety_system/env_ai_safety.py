#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""③ AI Safety Engine — 상태를 받아 어떤 조치를 할지 정한다.

    environment/status ─(구독)→ [판단] ─(발행)→ environment/control → Actuator/Simulation

[요구사항]
    고온 > 28℃  → 냉방
    고습 > 40%  → 제습 + 필요 시 환기
    저온 < 21℃  → 난방
    저습 < 35%  → 가습

⚠ **status 는 여러 상태가 함께 온다.** "HIGH_TEMPERATURE,HIGH_HUMIDITY" 처럼.
  하나만 보고 분기하면(예: 첫 항목만) 고온·고습이 동시에 왔을 때 제습기가 안 돈다.
  그래서 **집합으로 받아 각각 독립적으로** 켠다.

⚠ control 만 JSON 이다. 불리언이 5개라 스칼라 토픽 하나로는 표현이 안 된다.
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

import argparse
from datetime import datetime

import env_config as C
import env_bus


def decide(states):
    """상태 집합 → (제어 dict, 사람이 읽는 사유). 상태끼리 서로 막지 않는다."""
    st = set(states)
    ctl = {
        "cooling":      C.S_HIGH_T in st,
        "heating":      C.S_LOW_T in st,
        "dehumidifier": C.S_HIGH_H in st,
        "humidifier":   C.S_LOW_H in st,
        # [요구사항] "제습기 가동 및 환기" — 환기는 고습에 딸려 간다.
        "ventilation":  C.S_HIGH_H in st,
    }
    why = []
    if ctl["cooling"]:
        why.append(f"고온(>{C.TEMP_OK[1]}℃) → 냉방 ON")
    if ctl["heating"]:
        why.append(f"저온(<{C.TEMP_OK[0]}℃) → 난방 ON")
    if ctl["dehumidifier"]:
        why.append(f"고습(>{C.HUMI_OK[1]}%) → 제습 ON + 환기 ON")
    if ctl["humidifier"]:
        why.append(f"저습(<{C.HUMI_OK[0]}%) → 가습 ON")
    if not why:
        why.append("정상 — 전 장비 OFF")
    return ctl, " / ".join(why)


class SafetyEngine:
    def __init__(self, bus, verbose=True):
        self.bus, self.verbose, self.last = bus, verbose, None
        bus.subscribe(C.T_STATUS, self.on_status)

    def on_status(self, _topic, payload):
        states = [s.strip() for s in str(payload).split(C.STATUS_SEP) if s.strip()]
        unknown = [s for s in states if s not in C.KO]
        if unknown:                     # 모르는 상태를 조용히 넘기지 않는다
            print(f"   ⚠️ [AI Safety] 모르는 상태 {unknown} — 무시하고 나머지로 판단")
            states = [s for s in states if s in C.KO]
        ctl, why = decide(states)
        if ctl == self.last:
            return                      # 같은 명령을 반복해 보내지 않는다
        self.last = dict(ctl)
        out = dict(ctl)
        out.update({"ts": datetime.now().isoformat(timespec="seconds"),
                    "cause_status": str(payload), "reason": why})
        self.bus.publish(C.T_CONTROL, out)
        if self.verbose:
            on = [C.ACT_KO[k] for k in C.ACTUATORS if ctl[k]]
            print(f"   🤖 [AI Safety] {str(payload):<38s} → "
                  f"{('+'.join(on) if on else 'ALL OFF'):<16s} | {why}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bus", default="mqtt", choices=("mqtt", "inproc"))
    a = ap.parse_args()
    bus = env_bus.make_bus(a.bus, "ai-safety")
    SafetyEngine(bus)
    print(f"③ AI Safety Engine — {C.T_STATUS} 구독 / {C.T_CONTROL} 발행, bus={a.bus}")
    try:
        bus.loop_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
