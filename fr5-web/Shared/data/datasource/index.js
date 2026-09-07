// 데이터 출처를 아는 유일한 곳 (`SHARED-CORE.md` §4 · `ARCHITECTURE.md` §확장성).
// **화면은 fetch 를 부르지 않는다.** 목업 ↔ 실물 교체는 이 한 줄이다 — 그게 완료 판정이다.
//
// 형제 둘이 같은 패턴을 이미 돌린다 — `FR5/src/data/datasource/` · `TurtleBot/src/data/datasource/`.
// 저장을 팀 공유로 올릴 때(D46 · 이관 H) `./http.js` 를 만들고 이 줄만 바꾼다.
export { datasource } from './mock.js';

// 시뮬 산출은 **다른 출처**다 — 배치안·지표와 수명주기가 다르고(러너가 굽고 커밋 안 한다)
// 섞으면 「어느 쪽 숫자인가」를 화면이 못 가린다 (`SIM-CONTRACT.md` 불변식 5 와 같은 이유).
export { simSource } from './sim.js';
