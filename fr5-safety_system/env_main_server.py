#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""② Main Server — 수신 · 저장 · 상태 판단 · 이벤트 발행.

    environment/temperature ─┐
    environment/humidity  ───┴(구독)→ [저장 CSV] + [판단] ─(발행)→ environment/status

[요구사항] "실시간 데이터 수신 / 온·습도 상태 모니터링 / 데이터 저장 / 위험 상태 판단"

⚠ **두 토픽이 따로 온다.** 온도만 갱신된 순간에 판단하면 습도는 한 주기 전 값이라,
  있지도 않은 전이가 한 번 튄다. 그래서 `env_config.JUDGE_ON`(= 습도 토픽)을 받았을
  때만 판단한다. Virtual Sensor 가 온도 → 습도 순으로 내는 것이 그 전제다.

⚠ **status 는 상태가 바뀔 때만 낸다.** 매 주기 내보내면 20초마다 같은 알람이 쌓여
  진짜 전이가 묻힌다. 현재값이 필요하면 온·습도 토픽을 보면 된다(매 주기 나간다).
  단 첫 판단 한 번은 무조건 낸다 — 구독자가 초기 상태를 알아야 한다.
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

import argparse
import csv
import os
from datetime import datetime

import env_config as C
import env_bus


def classify(temp, humi, prev=()):
    """온·습도를 각각 판정해 **상태 목록**을 돌려준다.

    하나가 아니라 목록인 이유: 온도와 습도는 동시에 벗어날 수 있다.
    30℃ · 45% 는 `[HIGH_TEMPERATURE, HIGH_HUMIDITY]` 다. 하나로 줄이면 그 상황을
    표현할 수 없고, 받는 쪽이 제습기를 못 켠다.

    `prev` 는 직전 상태 목록. 되돌아올 때 여유(HYST)를 주려고 받는다.
    HYST 가 0 이면 이력과 무관하게 요구사항 그대로 동작한다.
    """
    return [x for x in (
        _axis(temp, C.TEMP_OK, C.TEMP_HYST, prev, C.S_LOW_T, C.S_HIGH_T),
        _axis(humi, C.HUMI_OK, C.HUMI_HYST, prev, C.S_LOW_H, C.S_HIGH_H),
    ) if x] or [C.S_NORMAL]


def _axis(v, ok, hyst, prev, s_lo, s_hi):
    """한 축(온도 또는 습도)을 판정한다.

    ⚠ 히스테리시스로 **직전 상태를 유지할지 먼저 보고, 아니면 반드시 새로 판정한다.**
      전에는 '고습 유지 조건'만 확인하고 빠져나가서, 고습에서 곧바로 저습으로
      건너뛸 때 저습을 놓쳤다 (2026-09-09 수정).
    """
    lo, hi = ok
    if s_hi in prev and v > hi - hyst:
        return s_hi
    if s_lo in prev and v < lo + hyst:
        return s_lo
    if v > hi:
        return s_hi
    if v < lo:
        return s_lo
    return None

    return out or [C.S_NORMAL]


class MainServer:
    def __init__(self, bus, log_path=None, verbose=True):
        self.bus, self.verbose = bus, verbose
        self.temp = self.humi = None
        self.states = []
        self.act = {}
        self.csv_path = log_path or os.path.join(
            C.LOG_DIR, f"env_{datetime.now():%Y%m%d_%H%M%S}.csv")
        os.makedirs(os.path.dirname(self.csv_path), exist_ok=True)
        self._fh = open(self.csv_path, "w", newline="", encoding="utf-8")
        self._w = csv.writer(self._fh)
        self._w.writerow(["ts", "temp_c", "humi_pct", "status"] + list(C.ACTUATORS))
        bus.subscribe(C.T_TEMP, self.on_temp)
        bus.subscribe(C.T_HUMI, self.on_humi)
        bus.subscribe(C.T_CONTROL, self.on_control)     # 로그에 남길 액추에이터 상태

    # ── 수신 ──────────────────────────────────────────────────────────────
    def on_temp(self, _t, p):
        self.temp = _num(p)
        if C.JUDGE_ON == C.T_TEMP:
            self.judge()

    def on_humi(self, _t, p):
        self.humi = _num(p)
        if C.JUDGE_ON == C.T_HUMI:
            self.judge()

    def on_control(self, _t, p):
        if isinstance(p, dict):
            self.act = {k: bool(p.get(k, False)) for k in C.ACTUATORS}

    # ── 판단 ──────────────────────────────────────────────────────────────
    def judge(self):
        if self.temp is None or self.humi is None:
            return                              # 둘 다 받기 전에는 판단하지 않는다
        first = not self.states
        states = classify(self.temp, self.humi, self.states)
        changed = states != self.states
        self.states = states

        payload = C.STATUS_SEP.join(states)
        self._w.writerow([datetime.now().isoformat(timespec="seconds"),
                          self.temp, self.humi, payload]
                         + [self.act.get(k, False) for k in C.ACTUATORS])
        self._fh.flush()                        # 시연 중 끊어도 마지막 줄까지 남는다

        if changed or first:
            self.bus.publish(C.T_STATUS, payload)
            if self.verbose:
                ko = " + ".join(C.KO[s] for s in states)
                mark = "✅" if states == [C.S_NORMAL] else "⚠️"
                print(f"   {mark} [Main Server] {self.temp:5.1f}℃ / {self.humi:5.1f}% "
                      f"→ {C.T_STATUS} = {payload}  ({ko})")

    def close(self):
        self._fh.close()


def _num(p):
    """스칼라 토픽 payload("30.0")를 float 으로. 못 읽으면 None."""
    try:
        return float(p)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bus", default="mqtt", choices=("mqtt", "inproc"))
    a = ap.parse_args()
    bus = env_bus.make_bus(a.bus, "main-server")
    srv = MainServer(bus)
    print(f"② Main Server — {C.T_TEMP} · {C.T_HUMI} 구독 / {C.T_STATUS} 발행, bus={a.bus}")
    print(f"   판단 시점: {C.JUDGE_ON} 수신 시   |  저장: {srv.csv_path}")
    try:
        bus.loop_forever()
    except KeyboardInterrupt:
        srv.close()
        print(f"\n저장 완료: {srv.csv_path}")


if __name__ == "__main__":
    main()
