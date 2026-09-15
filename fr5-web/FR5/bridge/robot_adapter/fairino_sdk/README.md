# fairino_sdk — 공식 Python SDK 벤더링

출처: `FAIR-INNOVATION/fairino-python-sdk` 태그 **`v2.2.3_robot3.9.3`** (`linux/fairino/Robot.py`).
라이선스: **Apache-2.0** (원 저장소 명시).

**순수 표준 라이브러리 구현이다** — `xmlrpc.client`(20003 명령) + `socket`(20004 실시간 상태
바이너리, `RobotStatePkg` ctypes 파싱). `.so`·네이티브 의존이 없어 macOS/Linux 어디서나 돈다.
"Python SDK 는 리눅스 전용" 이라던 기존 가정은 2026-07-31 원본 확인으로 폐기됐다 (D42).

수정 금지 — 업그레이드는 로봇 펌웨어와 짝을 맞춘 태그로 통째 교체한다 (스택가드).
