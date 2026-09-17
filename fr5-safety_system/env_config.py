#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 자율안전관리 — 환경(온·습도) 제어 시스템 설정.

**숫자를 코드 여기저기 흩지 않는다.** 임계값·주기·토픽 이름을 전부 여기 모은다.

구성
    Virtual Sensor → Main Server → AI Safety Engine → Actuator → Simulation
                                                                      └→ 다시 Virtual Sensor
"""
import os as _os

# ── 정상 유지 범위 — [요구사항] "온도(21~28℃)·습도(35~40%)를 유지" ────────
TEMP_OK = (21.0, 28.0)      # ℃
HUMI_OK = (35.0, 40.0)      # %RH  ← 폭이 5%p 뿐이라 제어가 예민하다

# 되돌아올 때 얼마나 더 들어와야 정상으로 보나 (채터링 방지 여유).
#   0.0 이면 요구사항 그대로 — 28.0 을 넘으면 고온, 28.0 이하면 곧바로 정상.
TEMP_HYST = 0.0             # ℃
HUMI_HYST = 0.0             # %p

PERIOD_S = 20.0             # [요구사항] 가상 센서 데이터 생성 주기

# ── 상태 이름 ─────────────────────────────────────────────────────────────
# ⚠ **외부로 나가는 계약이다.** 구독자가 문자열을 그대로 비교하므로 함부로 바꾸지 마라.
#   설계 논의에 HIGH_TEMP 와 HIGH_TEMPERATURE 가 섞여 있었다 — 열거된 쪽으로 통일한다.
S_NORMAL  = "NORMAL"
S_LOW_T   = "LOW_TEMPERATURE"
S_HIGH_T  = "HIGH_TEMPERATURE"
S_LOW_H   = "LOW_HUMIDITY"
S_HIGH_H  = "HIGH_HUMIDITY"

# 한국어 표기 — 화면·보고서용. 토픽으로는 나가지 않는다.
KO = {S_NORMAL: "정상", S_LOW_T: "저온", S_HIGH_T: "고온",
      S_LOW_H: "저습", S_HIGH_H: "고습"}

# status payload 에서 여러 상태를 잇는 구분자.
#   ⚠ **온도와 습도는 동시에 벗어날 수 있다.** 상태를 하나만 보내면 그 상황을
#     표현할 수 없다 — "HIGH_TEMPERATURE,HIGH_HUMIDITY" 처럼 둘 다 보낸다.
#     정상이면 목록이 비므로 S_NORMAL 하나만 보낸다.
STATUS_SEP = ","

# ── MQTT 토픽 ─────────────────────────────────────────────────────────────
# 온·습도를 **각각 스칼라 토픽**으로 낸다. 대시보드·그래프 도구가 JSON 파싱 없이
# 바로 붙을 수 있고, retain 이 걸려 있어 접속하자마자 현재값을 본다.
T_TEMP    = "environment/temperature"   # payload: "30.0"        (숫자 문자열)
T_HUMI    = "environment/humidity"      # payload: "45.0"
T_STATUS  = "environment/status"        # payload: "HIGH_TEMPERATURE,HIGH_HUMIDITY"
T_CONTROL = "environment/control"       # payload: JSON (불리언이 여러 개라 스칼라로 못 낸다)

# ⚠ **판단 시점 계약.** Virtual Sensor 는 한 주기에 온도 → 습도 순으로 낸다.
#   Main Server 는 **습도를 받았을 때만** 판단한다. 두 토픽이 따로 오므로 온도만
#   갱신된 순간에 판단하면 습도는 한 주기 전 값이라, 있지도 않은 전이가 한 번 튄다.
JUDGE_ON = T_HUMI

MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE = "localhost", 1883, 60

# ── 액추에이터 — [요구사항] 표의 제어 열 ──────────────────────────────────
#   고온 → 냉방 / 고습 → 제습 + 필요 시 환기 / 저온 → 난방 / 저습 → 가습
ACTUATORS = ("cooling", "heating", "dehumidifier", "humidifier", "ventilation")
ACT_KO = {"cooling": "냉방", "heating": "난방", "dehumidifier": "제습",
          "humidifier": "가습", "ventilation": "환기"}

# ── 저장 — [요구사항] "온·습도를 맞추기 위한 데이터는 실시간으로 저장" ──────
# 실행 위치가 아니라 **이 파일 기준**으로 고정한다. 아니면 로그가 흩어진다.
LOG_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "env_logs")

# ── Simulation(환경 모델) 계수 — [추정] 시연이 눈에 보이도록 고른 값 ────────
# 실측이 아니다. 실제 챔버 시상수를 재면 바꾼다.
AMBIENT_TEMP, AMBIENT_HUMI = 24.0, 37.0
DRIFT = 0.05
NOISE_TEMP, NOISE_HUMI = 0.15, 0.4
COOL_RATE, HEAT_RATE = 1.2, 1.0           # ℃ / 주기
DEHUM_RATE, HUMID_RATE = 1.5, 1.2         # %p / 주기
VENT_TEMP_RATE, VENT_HUMI_RATE = 0.5, 1.0
OUTDOOR_TEMP, OUTDOOR_HUMI = 22.0, 45.0
