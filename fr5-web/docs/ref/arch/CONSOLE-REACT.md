# CONSOLE-REACT — `Dashboard` 폴더

분류: **SSOT**. `Dashboard/`(Vite + React)를 건드릴 때 여기부터 본다.
아직 코드가 없다 — 이 문서가 먼저다.

관련 — 폴더 경계 `BUILD-VITE.md` · 공용 맵 모델 `SHARED-CORE.md` ·
서버 계약 `API-CONTRACT.md`

## 검증은 `data-t` 만 본다 (2026-08-04 · D54)

실렌더 검증(`scripts/check/fr5-web-verify.mjs` 등)은 **CSS 클래스를 선택자로 쓰지 않는다.**
클래스는 스타일이 소유하고, 검증은 `data-t="..."` 속성만 본다.

- 이유 — 검증 51곳이 클래스에 묶여 있어 레이아웃을 바꾸면 전부 깨졌다. 스타일 변경과
  검증 파손이 같이 오면 **무엇이 진짜 회귀인지** 못 가른다
- 새 화면을 만들 때 검증이 잡을 요소에 `data-t` 를 단다. 이름은 역할로 짓는다
  (`data-t="jogrow"` 처럼 — 위치나 모양이 아니라)

## 이 화면이 하는 일

새 목표는 **방산 탄두 조립 라인에서 배치와 동작에 따라 생산성이 얼마나 차이나는가**다 (D51·D66).
맵 편집기는 그 실험의 **계기판**이다.

| # | 하는 일 | 왜 React 가 필요한가 |
|---|---|---|
| 1 | 맵 편집 — 평면도에서 팔·스테이션·AMR 경로를 놓는다 | 드래그마다 도달 링·경고가 같이 갱신된다 |
| 2 | 생산성 지표 표시 — 처리량·시퀀스타임·AMR 이동거리·대기시간 | 표와 차트가 여러 개 |
| 3 | **맵 A vs B 비교** | 실험의 결론이 나오는 화면 |
| 4 | FR5 상태 요약·별도 조작 앱 연결 | 배치·실험 맥락을 끊지 않고 상태를 확인한다 |

1~3은 이 폴더가 소유한다. FR5 조작·티칭·슬롯·기록은 `FR5/`에 둔다(D36).
Dashboard는 읽기 전용 상태 요약과 링크만 제공하며 로봇 명령을 보내지 않는다.

## 왜 여기만 React 인가

`STACK.md`가 **"React는 화면이 복잡해진 뒤에"**라고 적어뒀다. AR 화면 하나는 그 시점이
아니었지만, **맵 편집 + 지표 비교는 그 시점이다.**

`AR/`에는 React를 넣지 않는다. 폰이 여는 화면이고 이미 첫 로딩이 7.5MB다
(`BUILD-VITE.md` §최상위 셋).

## 3D 는 R3F 로 다시 쓰지 않는다

맵 편집에도 3D가 필요하다(팔을 세우고 도달 범위를 본다). 그래도 **React Three Fiber를
쓰지 않는다.**

이유는 하나다 — `Shared/view3d/`(URDF + 그리퍼 로딩)은 바닐라 three이고
**`AR/`과 `Dashboard/`가 같이 쓴다.** R3F로 가면 이걸 선언형으로 다시 써야 하고,
그러면 로봇 로딩 경로가 둘이 된다. **그게 배치가 갈라지는 두 번째 경로다** — 레포를
나누지 않은 이유와 똑같다(D17).

바닐라 three를 React에 얹는 것은 어렵지 않다.

```jsx
// 3D 는 React 밖에서 산다. React 는 붙일 자리와 생명주기만 준다
function LayoutView({ layout }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  useEffect(() => {
    viewRef.current = createLayoutView(hostRef.current);   // features/ 의 바닐라 코드
    return () => viewRef.current.dispose();                // 렌더러·지오메트리 정리
  }, []);
  useEffect(() => { viewRef.current?.setLayout(layout); }, [layout]);
  return <div ref={hostRef} />;
}
```

**`dispose()`를 반드시 쓴다.** 탭을 왕복하면 WebGL 컨텍스트가 쌓여 브라우저가 막는다.

## 상태 규약

| 무엇 | 어디에 |
|---|---|
| **맵** | `Shared/data/layout/` 모델. React state 로 모양을 새로 만들지 않는다 |
| **지표 데이터** | `Shared/data/datasource/`에서 받는다. 화면이 `fetch`를 부르지 않는다 |
| FR5 요약 상태 (연결·모드·조종권) | datasource → 읽기 전용으로 받아 내려준다 (`API-CONTRACT.md`) |
| UI 상태 (열린 탭, 선택된 맵, 접힘) | React state |

**맵의 모양을 컴포넌트 안에서 재정의하지 않는다.** 그 순간 AR과 갈라진다.

## 의존성 — 먼저 넣지 않는다

| | 결정 | 왜 |
|---|---|---|
| React | 쓴다 | 위 참조 |
| 상태 관리 라이브러리 | **안 쓴다** | 맵 하나 + 선택 상태다. `useState`·`useReducer`로 된다 |
| 라우터 | **안 쓴다** | 탭이면 된다. 화면이 늘면 그때 |
| 차트 라이브러리 | **안 쓴다** | 막대·꺾은선은 SVG로 직접 그린다. 의존성 0 |
| UI 프레임워크 | **안 쓴다** | 지금 CSS로 충분하다 |

**필요해진 뒤에 넣는다.** 미리 넣은 의존성은 나중에 빼기 어렵다.
새 라이브러리를 넣을 때는 `/스택가드`로 버전을 `STACK.md`에 등재한 뒤 코드에 박는다.

## 폴더

```
Dashboard/
  index.html
  src/screens/main.jsx
  src/features/
    layout/     맵 편집 (평면도 · 드래그 · 도달 범위 검사)
    metrics/    지표 표시·비교           ← 계산하지 않는다
    control/    FR5 상태 요약·별도 앱 연결 자리 (명령 금지)
  vite.config.js  package.json

Shared/                        ← 여기를 고치면 AR 도 같이 확인한다
  model/layout/                맵 모델 (SSOT)
  data/scenario/               시나리오(타임라인) 모델 — 사건은 **이름만** 든다
  data/motion/                 자세표 — 화면에 박지 않는다
  data/datasource/            지표·맵을 어디서 가져오나 — mock.js → http.js
  view3d/{robot,trajectory,safety}/   바닐라 three 공용
```

`features/layout/`·`metrics/`·`control/`은 **`Dashboard/` 전용**이다.
AR은 맵을 읽기만 하므로 편집기를 쓰지 않는다.

**`Shared/view3d/`를 고칠 때는 AR도 같이 확인한다.** 두 쪽이 같은 코드를 쓴다.

## 수치는 우리가 만들지 않는다

**생산성 수치는 팀원 알고리즘이 낸다** (`ARCHITECTURE.md` §우리 몫).
이 화면은 계산하지 않고 **받아서 보여준다.**

그래서 팀원을 기다리지 않는다. 순서가 이렇다.

1. **목업 두 개**를 `Shared/data/datasource/mock.js`에 넣는다 (맵 A·B)
2. 비교 화면을 **끝까지** 만든다 — 목업으로 판정이 선다
3. 팀원 수치가 나오면 `Dashboard/src/data/datasource/http.js` 를 짜서 **바꿔 끼운다**
   (**아직 없다** — datasource 는 `Shared/` 가 아니라 앱마다 산다: `FR5/src/data/datasource/`)

**화면에서 `fetch`를 직접 부르지 않는다.** 부르는 순간 출처가 화면에 박히고,
나중에 백엔드·데이터베이스를 붙일 때 화면을 다시 짜야 한다.
교체가 **파일 한 개**여야 하고, 그게 이 경계의 완료 판정이다.

### 없는 필드는 화면을 깨지 않는다

필수는 `throughputPerHour`와 `cycleTimeSec.mean` 둘뿐이다
(`API-CONTRACT.md` §요구 모양). 나머지는 **없으면 그 칸만 "—"로 비운다.**

팀원이 처리량 하나만 내도 비교 화면이 그날 동작해야 한다.
선택 필드가 없을 때 화면이 죽으면, 우리 진행이 팀원 일정에 묶인다.

### 출처를 화면에 표시한다

`source`가 `mock`·`sim`·`measured` 중 무엇인지 **화면에 적는다.**
목업 숫자를 실측으로 착각한 채 팀에 보고하는 것이 이 프로젝트에서 가장 비싼 사고다.

## 하지 말 것

- **R3F 도입** — 위 참조
- **`AR/`에서 이 폴더를 import** — 폰 번들에 React가 실린다
- **맵을 React state 로 새로 모양 잡기** — `Shared/data/layout/`이 SSOT다
- **`dispose()` 없이 3D 마운트** — WebGL 컨텍스트가 쌓인다
- **지표를 화면에서 계산하기** — 우리 몫이 아니다. 받아서 보여준다
- **화면에서 `fetch` 직접 부르기** — `Shared/data/datasource/`를 거친다
- **목업 데이터를 출처 표시 없이 보여주기** — 실측으로 오인된다
- **맵 편집기에서 안전 판단하기** — 서버가 한다 (`ARCHITECTURE.md` §각 층)
- **맵 편집기에서 로봇 명령 보내기** — FR5 조작은 `FR5/`만 소유한다
