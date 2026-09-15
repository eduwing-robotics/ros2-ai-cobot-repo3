# 슬롯 계약 — 여기에 .py 를 넣으면 대시보드에 뜬다

정본은 `docs/ref/contract/TB-CONTRACT.md` §스크립트 슬롯. 요약:

1. **파일명이 슬롯 이름** — `[a-z0-9-_]` 만. 첫 줄 docstring 한 줄이 설명으로 뜬다
2. 브리지가 **별도 프로세스**로 실행한다. env 로 받는다
   - `TB_ROBOT` — 로봇 네임스페이스 (예: tb3_1)
   - `TB_MAP` — 활성 맵 yaml 경로. **비어 있을 수 있다** — 맵 필수면 스스로 검사하고 종료
   - `TB_PARAMS` — JSON 문자열 (4KB 상한)
3. **stdout 한 줄 = 로그 한 줄** — 그대로 대시보드 로그 패널에 흐른다
4. **SIGTERM 을 받으면 로봇을 세우고 종료한다.** 5초 안에 안 죽으면 SIGKILL 당하고,
   어느 경로든 브리지가 cmd_vel 0 을 쏜다 — 그래도 goal 취소는 스크립트 책임이다
5. 종료 코드가 기록이 된다 — `exit 0` = completed · 그 외 = error
6. 주행은 rclpy 로 직접 한다 (Nav2 goal·cmd_vel). FR5 팔과 협업하려면 FR5 브리지
   REST/WS 클라이언트가 되면 된다 — 관문끼리는 서로 부르지 않는다 (§미래 접점 ①)

예시는 `example_patrol.py`.
