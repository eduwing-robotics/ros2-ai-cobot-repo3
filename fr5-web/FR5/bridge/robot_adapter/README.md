# FR5 robot adapter 경계

예정 구현은 `mock`과 `fairino` 두 어댑터가 같은 최소 인터페이스를 구현한다.

- connect / disconnect
- read state
- jog / moveJ / gripper / stop
- servo / mode / drag-teach 전이

웹·라우트·안전 계층은 SDK 타입을 직접 알지 않는다. 실제 SDK 필드와 중국어 주석은 구현 시
원본 전체 목록을 확인하고, 영어 동의어 검색만으로 “없음”을 판정하지 않는다.
