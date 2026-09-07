"""웨이포인트 순찰 예시 — 슬롯 계약 데모 (rclpy 없이 맥에서도 돈다)"""
# 실기 슬롯은 rclpy 로 Nav2 goal 을 직접 보낸다 (README.md). 이 예시는 프로세스
# 수명주기(시작·stdout 로그·SIGTERM 정리)를 보여주는 뼈대다 — mock 어댑터가 움직임을 흉내낸다.
import json
import os
import signal
import sys
import time

robot = os.environ.get("TB_ROBOT", "?")
map_path = os.environ.get("TB_MAP", "")
params = json.loads(os.environ.get("TB_PARAMS", "{}"))

running = True


def on_sigterm(signum, frame):
    # 계약: SIGTERM 을 받으면 로봇을 세우고 종료한다. 실기에선 여기서 cmd_vel 0 · goal 취소.
    global running
    print("SIGTERM — 정리하고 종료해요")
    running = False


signal.signal(signal.SIGTERM, on_sigterm)

print(f"patrol 시작 — robot={robot} map={map_path or '(없음)'} params={params}")
lap = 0
while running and lap < 60:
    lap += 1
    print(f"lap {lap}: 순찰 중")
    time.sleep(2)

print("patrol 종료")
sys.exit(0)
