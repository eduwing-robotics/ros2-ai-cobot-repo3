#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""관제 서버용 **참조 구독자** — 이 파일만 관제 팀에 넘기면 된다.

관제 화면은 상황의 **결과만** 보여주면 되므로, 구독할 토픽은 사실상 하나다.

    environment/status   ← 이것만 받으면 화면을 채울 수 있다
    environment/temperature / humidity   ← 숫자를 같이 띄우고 싶을 때만

받는 쪽이 알아야 할 것 네 가지
  1. payload 는 JSON 이 아니라 **평문**이다.  "HIGH_TEMPERATURE,HIGH_HUMIDITY"
  2. **상태가 여러 개 올 수 있다.** 쉼표로 끊어 각각 표시한다.
     첫 항목만 보면 고온·고습이 동시일 때 하나를 놓친다.
  3. **상태가 바뀔 때만 발행된다.** 20초마다 오지 않는다.
     화면은 마지막 수신값을 계속 들고 있어야 한다.
  4. retain 이 걸려 있어 **접속하는 순간 현재 상태가 바로 한 번 온다.**
     그래서 빈 화면으로 시작하지 않는다.

실행
    python3 env_dashboard_client.py --host 192.168.0.10
"""
import argparse
import json
from datetime import datetime

import paho.mqtt.client as mqtt

T_STATUS = "environment/status"
T_TEMP   = "environment/temperature"
T_HUMI   = "environment/humidity"

# 화면 표시용 매핑. 관제 UI 의 색·문구는 여기만 고치면 된다.
DISPLAY = {
    "NORMAL":           ("정상", "green",  "🟢"),
    "LOW_TEMPERATURE":  ("저온", "blue",   "🔵"),
    "HIGH_TEMPERATURE": ("고온", "red",    "🔴"),
    "LOW_HUMIDITY":     ("저습", "yellow", "🟡"),
    "HIGH_HUMIDITY":    ("고습", "orange", "🟠"),
}


class Dashboard:
    """화면 상태를 들고 있는 최소 모델. 실제 UI 는 render() 자리를 대체하면 된다."""

    def __init__(self):
        self.states = ["NORMAL"]
        self.temp = self.humi = None
        self.updated = None

    def on_status(self, payload):
        # ⚠ 쉼표로 끊는다. 모르는 값이 오면 버리되 조용히 넘기지 않는다.
        states, unknown = [], []
        for s in str(payload).split(","):
            s = s.strip()
            if not s:
                continue
            (states if s in DISPLAY else unknown).append(s)
        if unknown:
            print(f"  ⚠️ 정의에 없는 상태 {unknown} — 무시함. 발신측 버전을 확인하라")
        self.states = states or ["NORMAL"]
        self.updated = datetime.now()
        self.render()

    def render(self):
        alarm = [s for s in self.states if s != "NORMAL"]
        badges = " ".join(f"{DISPLAY[s][2]} {DISPLAY[s][0]}" for s in self.states)
        t = f"{self.temp:.1f}℃" if self.temp is not None else "--"
        h = f"{self.humi:.1f}%" if self.humi is not None else "--"
        print(f"[{self.updated:%H:%M:%S}] {'🚨 이상' if alarm else '✅ 정상'} "
              f"| {badges:<20s} | {t} / {h}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--client-id", default="dashboard-1",
                    help="⚠ 브로커에서 유일해야 한다. 겹치면 서로를 끊는다")
    a = ap.parse_args()

    dash = Dashboard()

    def on_connect(cli, _ud, _flags, rc, _props=None):
        print(f"연결됨 {a.host}:{a.port} (rc={rc}) — 구독 시작")
        # QoS 1 — 상태는 변화 시에만 나가므로 한 건도 놓치면 안 된다.
        cli.subscribe([(T_STATUS, 1), (T_TEMP, 1), (T_HUMI, 1)])

    def on_message(_cli, _ud, msg):
        payload = msg.payload.decode("utf-8", errors="replace")
        if msg.topic == T_STATUS:
            dash.on_status(payload)
        elif msg.topic == T_TEMP:
            dash.temp = _f(payload)
        elif msg.topic == T_HUMI:
            dash.humi = _f(payload)

    def on_disconnect(_cli, _ud, rc, _p=None, _q=None):
        # 끊겨도 죽지 않는다. paho 가 reconnect 를 재시도한다.
        print(f"⚠️ 연결 끊김 (rc={rc}) — 재접속 대기")

    cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=a.client_id)
    cli.on_connect, cli.on_message, cli.on_disconnect = on_connect, on_message, on_disconnect
    cli.connect(a.host, a.port, 60)
    print("관제 구독자 — Ctrl-C 로 종료")
    try:
        cli.loop_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


def _f(s):
    try:
        return float(s)
    except ValueError:
        return None


if __name__ == "__main__":
    main()
