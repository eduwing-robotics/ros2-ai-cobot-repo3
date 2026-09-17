#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""모듈 사이를 잇는 pub/sub 버스. **MQTT 와 인프로세스, 두 가지 등을 같은 API 로 쓴다.**

왜 두 가지인가
    발표·개발 단계에서 브로커(mosquitto)가 없어도 5개 모듈이 그대로 돌아가야 한다.
    `InProcBus` 는 같은 프로세스 안에서 콜백을 직접 부르므로 설치가 필요 없고,
    `MqttBus` 는 진짜 토픽으로 나가므로 외부 시스템·대시보드가 붙을 수 있다.
    **모듈 코드는 어느 쪽인지 모른다** — 그래서 시연과 실제가 갈라지지 않는다.

    payload 는 dict 면 JSON, 그 밖이면 **문자열 그대로** 나간다.
    온·습도(`environment/temperature`)와 상태(`environment/status`)는 스칼라 토픽이라
    JSON 으로 감싸지 않는다 — 대시보드·그래프 도구가 파싱 없이 바로 붙게 하려는 것이다.
    인프로세스라고 값을 그냥 넘기지 않고 **양쪽 다 실제 직렬화를 거친다.**
    그래야 MQTT 로 바꿨을 때 뒤늦게 터지는 값이 없다.
"""
import json
import time

import env_config as C


class Bus:
    def publish(self, topic, payload: dict): raise NotImplementedError
    def subscribe(self, topic, cb): raise NotImplementedError
    def loop_forever(self): raise NotImplementedError
    def close(self): pass


def encode(payload):
    """dict 면 JSON, 아니면 문자열. 브로커로 나가는 바이트를 여기서만 만든다."""
    return json.dumps(payload, ensure_ascii=False) if isinstance(payload, dict) else str(payload)


def decode(raw):
    """JSON 이면 dict, 아니면 문자열 그대로. 남이 보낸 쓰레기에 죽지 않는다."""
    try:
        v = json.loads(raw)
    except ValueError:
        return raw
    return v if isinstance(v, dict) else raw    # "30.0" 은 숫자가 아니라 원문으로 준다


class InProcBus(Bus):
    """브로커 없이 같은 프로세스에서 주고받는다 (시연·시험용)."""

    def __init__(self):
        self._subs = {}

    def publish(self, topic, payload):
        raw = encode(payload)                   # MQTT 와 같게 — 직렬화를 실제로 거친다
        for cb in self._subs.get(topic, []):
            cb(topic, decode(raw))

    def subscribe(self, topic, cb):
        self._subs.setdefault(topic, []).append(cb)

    def loop_forever(self):
        while True:
            time.sleep(3600)


class MqttBus(Bus):
    """진짜 MQTT 브로커로 나간다."""

    def __init__(self, client_id, host=C.MQTT_HOST, port=C.MQTT_PORT):
        import paho.mqtt.client as mqtt
        self._m = mqtt
        self.cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        self.cli.on_message = self._on_message
        self._subs = {}
        self.cli.connect(host, port, C.MQTT_KEEPALIVE)
        self.cli.loop_start()

    def _on_message(self, _cli, _ud, msg):
        try:
            raw = msg.payload.decode("utf-8")
        except UnicodeDecodeError:
            return                               # 남이 보낸 쓰레기에 죽지 않는다
        for cb in self._subs.get(msg.topic, []):
            cb(msg.topic, decode(raw))

    def publish(self, topic, payload):
        # retain=True — 나중에 붙는 구독자도 **마지막 값을 즉시** 받는다.
        # 대시보드가 접속하자마자 빈 화면이 아니라 현재 상태를 보여준다.
        self.cli.publish(topic, encode(payload), qos=1, retain=True)

    def subscribe(self, topic, cb):
        self._subs.setdefault(topic, []).append(cb)
        self.cli.subscribe(topic, qos=1)

    def loop_forever(self):
        while True:
            time.sleep(1.0)

    def close(self):
        self.cli.loop_stop()
        self.cli.disconnect()


def make_bus(kind, client_id="env"):
    """`kind` 는 'mqtt' 또는 'inproc'."""
    return MqttBus(client_id) if kind == "mqtt" else InProcBus()
