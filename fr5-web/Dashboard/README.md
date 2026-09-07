# Dashboard — 관제화면 (Vite + React)

본체는 **L1 배치안 편집**이다 (`docs/ref/plan/MILESTONES.md`). `control`은 기존 자리 이름만
유지하며 FR5 상태 요약·별도 앱 연결로 바꾼다. 로봇 명령은 `FR5/` 소유다(D36).

- **R3F 를 쓰지 않는다.** 3D 는 `Shared/view3d/` 의 바닐라 코드를 `ref` + `useEffect` 로 마운트.
  R3F 로 가면 로봇 로딩 경로가 둘이 되고, 그게 배치가 갈라지는 두 번째 경로다
- **`dispose()` 없이 3D 를 마운트하지 않는다** — 탭을 왕복하면 WebGL 컨텍스트가 쌓인다
- **지표를 여기서 계산하지 않는다.** 팀원 알고리즘이 낸다. 받아서 보여준다
- **화면에서 `fetch` 를 부르지 않는다** — `Shared/data/datasource/` 를 거친다
- **출처(`mock`/`sim`/`measured`) 배지를 지우지 않는다.** 목업을 실측으로 오인해 보고하는 것이
  이 프로젝트에서 가장 비싼 사고다 (SR_24)
- 상태관리·라우터·차트 라이브러리를 **미리 넣지 않는다**. 탭이면 된다

## 폴더

| 경로 | 무엇 |
|---|---|
| `src/screens/` | 화면 진입점. jsx+css 한 쌍 |
| `src/features/control/` | FR5 상태 요약·별도 앱 연결 자리. 명령 금지 |
| `src/features/layout/` | 배치안 편집/보기 |
| `src/features/metrics/` | 지표 비교 |
| `index.html` | 브라우저 진입점 |

읽을 것 — `docs/ref/arch/CONSOLE-REACT.md`
