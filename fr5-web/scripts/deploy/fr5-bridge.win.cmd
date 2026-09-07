@echo off
rem FR5 브리지 상주 — 윈도우 호스트(192.168.30.5). 예약 작업 `fr5-bridge` 가 로그온에 돌린다.
rem 정본은 이 파일이다. 호스트의 %%USERPROFILE%%\fr5-bridge.cmd 는 이것의 사본이다.
rem
rem ⛔ `uvicorn main:app` 로 부르지 마라 (2026-08-19 실측). uv 가 매번 새 venv 에 만드는
rem    uvicorn.exe 는 서명·평판이 없어 Smart App Control 이 막는다 (os error 4551).
rem    python.exe 는 서명돼 있어 안 막힌다 — 그래서 `python -m uvicorn` 이다.
rem    ⛔ Smart App Control 을 끄지 마라: 한 번 끄면 윈도우 재설치 전까지 못 켠다.
rem
rem ⛔ 폰 주소를 여기 박지 마라 — 사용자 환경변수 FR5_CAM_HOST 가 정본이다 (하드 룰 5).
rem    감시기(fr5-drift.win.cmd)도 같은 것을 본다. 바꾸려면:
rem      setx FR5_CAM_HOST 192.168.30.8:8080   (새 프로세스부터 적용 — 작업을 다시 시작한다)
cd /d "%USERPROFILE%\FR5Web\FR5\bridge"
"%USERPROFILE%\.local\bin\uv.exe" run --with fastapi --with "uvicorn[standard]" --with pyyaml --with opencv-python --with numpy python -m uvicorn main:app --host 0.0.0.0 --port 5055 >> "%USERPROFILE%\fr5-bridge.log" 2>&1
