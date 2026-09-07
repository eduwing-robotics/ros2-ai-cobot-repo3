# FR5 datasource 경계

화면이 아는 유일한 데이터 입구다.

- 개발: mock 어댑터
- 실기: `FR5/bridge/`의 REST/WebSocket 어댑터
- 기록·최적 경로: `Database/` 계약 어댑터

화면 컴포넌트의 직접 `fetch`, 로봇 SDK 호출, DB 드라이버 사용은 금지한다.
교체가 이 폴더 안에서 끝나야 한다.
