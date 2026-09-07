@echo off
rem 글로벌캠 정합 감시 + **자동 재정합** — 예약 작업 `fr5-drift` 가 로그온에 돌린다.
rem 2026-08-19: --auto 를 켰다. 폰을 뺐다 끼우면 카메라가 매번 움직이는데(그날 다섯 번)
rem 거치로는 못 막는다 — 사람이 손으로 다시 푸는 대신 스스로 다시 푼다.
rem 가드 넷이 막는다: 연속 5회 초과 · 새 해 RMS<=2.0 · 자세 점프<=500mm · 기하(>=4장,퍼짐,높이).
rem 되돌리려면 이 줄 끝의 --auto 만 지우면 감시(재기)만 한다.
cd /d "%USERPROFILE%\FR5Web"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
"%USERPROFILE%\.local\bin\uv.exe" run --python 3.11 --with opencv-python --with numpy python "scripts\map\watch-calib.py" --auto >> "%USERPROFILE%\fr5-drift.log" 2>&1
