#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""① Virtual Sensor + ④ Simulation(환경 모델).

두 역할을 한 프로세스에 둔 이유: 폐루프이기 때문이다. 제어 결과가 다시 환경에
반영되고, 그 환경을 센서가 읽는다. 나누면 환경 상태를 두 곳에서 들고 있게 된다.

    environment/control ─(구독)→ 환경 모델 ─(발행)→ environment/temperature
                                              └─(발행)→ environment/humidity

    ⚠ 한 주기에 **온도 → 습도 순서로** 낸다. Main Server 가 습도를 받았을 때만
      판단하기로 되어 있다(env_config.JUDGE_ON). 순서를 바꾸면 판단이 한 주기 밀린다.

**가상 센서다.** 실제 센서가 아니라는 것을 발표에서 명확히 한다.

시나리오
    정상만 흘려보내면 이상 상황을 못 본다. `SCENARIO` 가 정해진 시각에 값을
    의도적으로 밀어 이상환경을 만든다 (요구사항 문서의 예시 표와 같은 방식).

사용
    python3 env_virtual_sensor.py                 # MQTT 로 발행
    python3 env_virtual_sensor.py --bus inproc    # 브로커 없이 (단독 시험)
    python3 env_virtual_sensor.py --period 2      # 빨리 돌려보기
"""
import argparse
import random
import time
from datetime import datetime

import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

import env_config as C
import env_bus


# (몇 번째 주기에, 온도밀기℃, 습도밀기%p, 설명) — 누적이 아니라 그때 한 번 더한다
#   ⚠ 절대 시각(초)이 아니라 **주기 번호**다. 그래야 `--period 1` 로 줄였을 때
#     시연 전체가 같이 압축된다. 초로 적어두면 주기만 빨라지고 이상 주입은
#     원래 시각에 그대로 나서, 빨리 돌려봐도 아무 일도 안 일어난다.
SCENARIO = [
    (1,  +6.0,  0.0, "고온 주입"),
    (4,   0.0, +8.0, "고습 주입"),
    (7,  +6.0, +8.0, "고온 + 고습 **동시** 주입"),   # ← 복합 상황. 이게 핵심 시연이다
    (11, -8.0, -10.0, "저온 + 저습 **동시** 주입"),
]


def _toward(cur, target, rate):
    """`target` 쪽으로 한 주기에 최대 `rate` 만큼. 지나쳐서 넘어가지 않는다."""
    return max(-rate, min(rate, target - cur))


class Environment:
    """④ Simulation — 가상 챔버. 제어 입력을 받아 온·습도가 실제로 움직인다."""

    def __init__(self):
        self.temp = (C.TEMP_OK[0] + C.TEMP_OK[1]) / 2      # 24.5℃ 에서 시작
        self.humi = (C.HUMI_OK[0] + C.HUMI_OK[1]) / 2      # 37.5%
        for name in C.ACTUATORS:
            setattr(self, name, False)

    def apply_control(self, c):
        for name in C.ACTUATORS:
            setattr(self, name, bool(c.get(name, False)))

    def step(self):
        """한 주기만큼 환경을 굴린다. 제어가 없으면 주변값으로 서서히 돌아간다."""
        self.temp += (C.AMBIENT_TEMP - self.temp) * C.DRIFT
        self.humi += (C.AMBIENT_HUMI - self.humi) * C.DRIFT
        if self.cooling:
            self.temp -= C.COOL_RATE
        if self.heating:
            self.temp += C.HEAT_RATE
        if self.dehumidifier:
            self.humi -= C.DEHUM_RATE
        if self.humidifier:
            self.humi += C.HUMID_RATE
        if self.ventilation:                                # 외기와 섞인다
            self.temp += _toward(self.temp, C.OUTDOOR_TEMP, C.VENT_TEMP_RATE)
            self.humi += _toward(self.humi, C.OUTDOOR_HUMI, C.VENT_HUMI_RATE)

    def inject(self, d_temp, d_humi):
        self.temp += d_temp
        self.humi += d_humi

    def read(self):
        """센서가 읽는 값 = 실제값 + 잡음. 실제값을 그대로 주지 않는다."""
        return (round(self.temp + random.gauss(0, C.NOISE_TEMP), 2),
                round(max(0.0, min(100.0, self.humi + random.gauss(0, C.NOISE_HUMI))), 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bus", default="mqtt", choices=("mqtt", "inproc"))
    ap.add_argument("--period", type=float, default=C.PERIOD_S)
    ap.add_argument("--no-scenario", action="store_true", help="이상 주입 없이 정상만")
    a = ap.parse_args()

    bus = env_bus.make_bus(a.bus, "virtual-sensor")
    env = Environment()
    bus.subscribe(C.T_CONTROL, lambda _t, p: env.apply_control(p))

    print(f"① Virtual Sensor + ④ Simulation — {a.period:.0f}초 주기, bus={a.bus}")
    print(f"   정상 범위 온도 {C.TEMP_OK[0]}~{C.TEMP_OK[1]}℃ / 습도 {C.HUMI_OK[0]}~{C.HUMI_OK[1]}%")
    print(f"   발행 {C.T_TEMP} → {C.T_HUMI} (이 순서가 계약이다)")
    try:
        run(bus, env, a.period, not a.no_scenario)
    except KeyboardInterrupt:
        print("\n종료합니다.")


def run(bus, env, period, use_scenario, seq0=0, on_tick=None):
    """루프 본체. `env_demo.py` 가 같은 함수를 재사용한다."""
    t0, seq, fired = time.time(), seq0, set()
    while True:
        elapsed = time.time() - t0
        tick = seq - seq0                       # 0 부터 시작하는 주기 번호
        if use_scenario:
            for i, (at, dt_, dh_, why) in enumerate(SCENARIO):
                if i not in fired and tick >= at:
                    fired.add(i)
                    env.inject(dt_, dh_)
                    print(f"   ⚡ [{tick}주기 / {elapsed:.0f}s] {why} "
                          f"(온도 {dt_:+.1f}℃ / 습도 {dh_:+.1f}%p)")
        env.step()
        temp, humi = env.read()
        seq += 1
        # 스칼라 2토픽. 순서가 계약이다 — 온도 먼저, 습도 나중.
        bus.publish(C.T_TEMP, f"{temp:.1f}")
        bus.publish(C.T_HUMI, f"{humi:.1f}")
        if on_tick:
            on_tick(elapsed, temp, humi)
        time.sleep(period)


if __name__ == "__main__":
    main()
