# AI 자율안전관리 — 환경(온·습도) 제어 시스템

가상 센서로 온·습도를 만들고, 이상 상황을 판단해 냉방·제습·환기를 돌리고,
그 결과가 다시 환경에 반영되는 **폐루프**다. 실제 센서는 쓰지 않는다 —
발표에서는 **Virtual Sensor** 라고 명확히 부른다.

```
Virtual Sensor ─environment/temperature─┐
               ─environment/humidity ───┴→ Main Server ─environment/status→ AI Safety Engine
      ↑                                                                            │
      └──────────── Simulation ←──── Actuator ←──── environment/control ────────────┘
```

## 파일

| 파일 | 모듈 | 역할 |
|---|---|---|
| `env_config.py` | — | 임계값·주기·토픽. **숫자는 전부 여기에 있다** |
| `env_bus.py` | — | MQTT / 인프로세스 두 방식을 같은 API 로 |
| `env_virtual_sensor.py` | ① Virtual Sensor + ④ Simulation | 가상 온·습도 생성, 제어 결과 반영 |
| `env_main_server.py` | ② Main Server | 수신 · CSV 저장 · 상태 판단 · 이벤트 발행 |
| `env_ai_safety.py` | ③ AI Safety Engine | 상태 → 냉방·난방·제습·가습·환기 결정 |
| `env_dashboard_client.py` | 관제 | **관제 서버용 참조 구독자.** 이 파일을 관제 팀에 넘긴다 |
| `env_demo.py` | 발표용 | 위 4개를 한 프로세스로 묶어 표로 출력 |
| `broker.yaml` | 설정 | `amqtt` 브로커. bind 주소가 외부 접속 여부를 가른다 |
| `broker_mosquitto.conf` | 설정 | `mosquitto` 용 동등 설정 |
| `requirements.txt` | 설치 | `paho-mqtt` · `amqtt` |
| `.gitignore` | 저장소 | `env_logs/` · `__pycache__/` 제외 |
| `env_logs/` | 산출물 | 실시간 저장 CSV (매 주기 1행). **저장소에 올리지 않는다** |
| `가상센서_시험보고서_20260909_1445.html` | 문서 | 20초 주기 5분 시험의 방법·결과·결함 보고서 |

## 기준값 — 요구사항 문서 그대로

| 상태 | 조건 | 제어 |
|---|---|---|
| 🟢 `NORMAL` | 21~28℃ **AND** 35~40% | 유지 |
| 🔵 `LOW_TEMPERATURE` | 온도 < 21℃ | 난방 |
| 🔴 `HIGH_TEMPERATURE` | 온도 > 28℃ | 냉방 |
| 🟡 `LOW_HUMIDITY` | 습도 < 35% | 가습 |
| 🟠 `HIGH_HUMIDITY` | 습도 > 40% | 제습 + 환기 |

주기 20초. 습도 정상폭이 5%p 뿐이라 제어가 예민하다.

## 토픽

| 토픽 | payload | 발행 시점 |
|---|---|---|
| `environment/temperature` | `30.0` (숫자 문자열) | **매 주기** |
| `environment/humidity` | `45.0` | **매 주기** |
| `environment/status` | `HIGH_TEMPERATURE,HIGH_HUMIDITY` | **상태가 바뀔 때만** (+ 최초 1회) |
| `environment/control` | JSON (불리언 5개) | 제어가 바뀔 때만 |

**온·습도는 스칼라 토픽이다.** JSON 으로 감싸지 않아 대시보드·그래프 도구가 파싱
없이 바로 붙고, retain 이 걸려 있어 접속하자마자 현재값을 본다.

**status 는 여러 상태를 쉼표로 잇는다.** 온도와 습도는 동시에 벗어날 수 있다.
30℃ · 45% 는 `HIGH_TEMPERATURE,HIGH_HUMIDITY` 다. 하나로 줄이면 받는 쪽이
제습기를 못 켠다. 정상이면 `NORMAL` 하나만 나간다.

`status` 를 매 주기 내보내지 않는 이유: 20초마다 같은 알람이 쌓이면 진짜 전이가
묻힌다. 현재값이 필요하면 온·습도 토픽을 보면 된다.

### ⚠ 발행 순서가 계약이다

Virtual Sensor 는 한 주기에 **온도 → 습도 순서로** 낸다. Main Server 는
**습도를 받았을 때만** 판단한다(`env_config.JUDGE_ON`). 두 토픽이 따로 오므로
온도만 갱신된 순간에 판단하면 습도는 한 주기 전 값이라, 있지도 않은 전이가 한 번 튄다.

## 실행

### 발표·시험 — 브로커 없이

```bash
../../bin/python env_demo.py                # 20초 주기 (요구사항 그대로)
../../bin/python env_demo.py --period 1     # 흐름만 빨리 확인
```

### 실제 배포 — MQTT

```bash
# 0) 브로커  (둘 중 하나)
../../bin/amqtt -c broker.yaml              # sudo 불필요
sudo apt install mosquitto                  # 표준

# 1) 모듈 3개를 각각 다른 터미널에서
../../bin/python env_main_server.py    --bus mqtt
../../bin/python env_ai_safety.py      --bus mqtt
../../bin/python env_virtual_sensor.py --bus mqtt

# 2) 외부에서 구독
mosquitto_sub -t 'environment/#' -v
```

## 브로커 설정

브로커는 **이 PC 에 둔다** (2026-09-09 결정). 관제 서버가 다른 PC 에서 붙으므로
`bind` 를 `0.0.0.0` 으로 열어 두었다.

```yaml
# broker.yaml
listeners:
  default:
    type: tcp
    bind: 0.0.0.0:1883      # 127.0.0.1 이면 이 PC 안에서만 접속된다
auth:
  allow-anonymous: true
```

mosquitto 를 쓸 때는 `broker_mosquitto.conf` 를 `/etc/mosquitto/conf.d/` 로 복사하고
`sudo systemctl restart mosquitto`.

```conf
listener 1883 0.0.0.0
allow_anonymous true
```

**바뀌는 것은 설정 한 줄뿐이다.** 파이썬 소스는 건드리지 않는다.
`env_config.MQTT_HOST` 도 `localhost` 그대로 둔다 — 모듈들이 같은 PC 의 브로커에 붙기 때문이다.

### ⚠ 시연 전 확인

```bash
sudo ufw status                 # 1883 이 허용돼 있나
sudo ufw allow 1883/tcp         # 없으면 추가
```

이 PC 는 `ufw` 가 active 다. LAN 주소(`192.168.30.13`)로 연결·구독·수신은 확인했지만
**다른 PC 에서 붙는 것은 방화벽을 확인해야 한다.**

`allow_anonymous true` 는 **인증이 없다는 뜻**이다. 폐쇄망 시연 전제이므로,
외부에 열 때는 계정과 TLS 를 붙여야 한다. 실제 주소·계정이 들어가면
이 설정 파일을 공개 저장소에 올리지 마라.

### 브로커를 관제 서버 쪽에 두는 경우

관제 팀이 이미 브로커를 운영 중이면 방향이 뒤집힌다. 그때는 이 PC 의 `broker.yaml` 을
쓰지 않고 `env_config.MQTT_HOST` 를 관제 서버 주소로 바꾼다. **어느 쪽이든 소스 로직은
그대로다.**

## 관제 서버 연동

관제 화면은 상황의 **결과만** 보여주면 되므로 구독할 토픽은 사실상 하나다.

| 토픽 | QoS | 필수 | 화면에서 쓰는 곳 |
|---|---|---|---|
| `environment/status` | 1 | **필수** | 정상 / 이상 배지 |
| `environment/temperature` | 1 | 선택 | 현재 온도 숫자 |
| `environment/humidity` | 1 | 선택 | 현재 습도 숫자 |
| `environment/control` | 1 | 불필요 | 장비 가동 표시가 필요할 때만 |

### 받는 쪽이 반드시 알아야 할 네 가지

| 규칙 | 이유 | 안 지키면 |
|---|---|---|
| payload 는 **JSON 이 아니라 평문** | 파싱 없이 붙게 하려고 | `json.loads` 가 예외를 낸다 |
| **쉼표로 끊어 여러 상태**를 각각 표시 | 온도·습도는 동시에 벗어날 수 있다 | 첫 항목만 보면 고온·고습 중 하나를 놓친다 |
| **상태가 바뀔 때만** 발행된다 | 20초마다 같은 알람이 쌓이면 전이가 묻힌다 | 주기 수신을 기대하면 화면이 빈다 — 마지막 값을 유지해야 한다 |
| 접속 즉시 현재 상태가 **한 번 온다** | 발행 시 `retain=True` | (빈 화면으로 시작하지 않는 근거) |

### 상태 → 화면 매핑

| 수신 문자열 | 표시 | 색 | 의미 |
|---|---|---|---|
| `NORMAL` | 🟢 정상 | green | 온·습도 모두 범위 안 |
| `LOW_TEMPERATURE` | 🔵 저온 | blue | 온도 < 21.0℃ |
| `HIGH_TEMPERATURE` | 🔴 고온 | red | 온도 > 28.0℃ |
| `LOW_HUMIDITY` | 🟡 저습 | yellow | 습도 < 35.0% |
| `HIGH_HUMIDITY` | 🟠 고습 | orange | 습도 > 40.0% |

### 참조 구현

`env_dashboard_client.py` 하나만 관제 팀에 넘기면 된다. 위 네 규칙이 코드와 주석에 들어 있다.

```bash
python3 env_dashboard_client.py --host 192.168.30.13 --client-id dashboard-1
```

```
연결됨 192.168.30.13:1883 (rc=Success) — 구독 시작
[14:57:35] ✅ 정상 | 🟢 정상          | 24.6℃ / 37.4%
[14:57:37] 🚨 이상 | 🔴 고온          | 30.3℃ / 37.6%
[14:57:46] 🚨 이상 | 🔴 고온 🟠 고습    | 31.0℃ / 48.1%
[14:57:52] 🚨 이상 | 🔵 저온 🟡 저습    | 18.8℃ / 32.7%
```

`client_id` 는 **브로커에서 유일해야 한다.** 관제 화면이 여럿이면 각각 다른 값을 준다.
겹치면 브로커가 먼저 붙은 쪽을 끊어 두 화면이 번갈아 죽는다.

## 설계 메모 — 나중에 고칠 때 읽어라

**상태는 목록이다. 하나로 줄이지 마라.** `classify()` 가 리스트를 돌려주고
`decide()` 가 집합으로 받아 각 장비를 **독립적으로** 켠다. 첫 항목만 보고 분기하면
고온·고습이 동시에 왔을 때 제습기가 안 돈다.

**히스테리시스는 직전 상태 유지만 판단한다.** 유지 조건이 아니면 반드시 새로
판정해야 한다. 처음에는 '고습 유지 조건'만 확인하고 빠져나가서, 고습에서 곧바로
저습으로 건너뛸 때 저습을 놓쳤다 (2026-09-09 수정, `env_main_server._axis`).

**시나리오는 주기 번호로 적는다.** `env_virtual_sensor.SCENARIO` 를 절대 시각(초)으로
적으면 `--period` 를 줄여도 이상 주입이 원래 시각에 나서, 빨리 돌려봐도 아무 일도
일어나지 않는다.

**히스테리시스는 0 이 기본이다** (`env_config.TEMP_HYST` / `HUMI_HYST`). 요구사항 그대로
동작시키기 위해서다. 값이 경계에 걸쳐 떨려 이벤트가 폭주하면 0.3 / 0.5 정도로 올린다.
