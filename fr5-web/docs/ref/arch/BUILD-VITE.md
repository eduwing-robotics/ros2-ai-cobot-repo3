# BUILD-VITE — 폴더 경계와 빌드

분류: **SSOT**. **무엇을 건드릴 때 어느 폴더인지**가 이 문서로 결정된다.
세션 시작 시 `docs/SESSION-START.md` §폴더 라우터가 여기로 보낸다.

관련 — 측정 근거 `docs/archive/evidence-2026-07/2026-07-30/vite-gate.md` · 공용 계약 `SHARED-CORE.md` ·
맵 편집기 `CONSOLE-REACT.md` · AR 디버깅 `AR-DEBUG.md` · 결정 `DECISION-LOG` D17

## 목차

12개 절. **`##` 절과 이 목록은 같아야 한다** — `docs-weight.sh` 가 잰다.

- 최상위 앱과 공용 경계
- `Shared/` 는 두 층이다
- 각 폴더 안
- 폴더 사이 규칙
- 두 프로젝트가 `Shared/` 를 어떻게 쓰나
- 설정은 fetch 하지 않고 빌드 시 import 한다
- 파일이 어디로 갔나 (전수 · **이관 완료**)
- 게이트를 먼저 고친다
- 배포 — 프로젝트 둘
- 이관 순서 (수렴 루프 반영 · 2026-07-30 재정리)
- 하지 말 것
- 폴더마다 `AGENTS.md` 를 둔다 — 이득이 있다

## 최상위 앱과 공용 경계

```
FR5Web/
  AR/                Vite + 바닐라.  폰이 연다. 카메라·마커·wasm 검출기
  Dashboard/         Vite + React.   PC 가 연다. 맵 편집·지표 비교
  FR5/               웹 조작 화면 + 브리지. 현재는 문서성 골격
  TurtleBot/         터틀봇 브리지(로봇 파이) — 웹은 없다. 화면은 FR5/ 의 「터틀봇」 탭 (D182)
  Shared/            두 쪽이 같이 쓰는 것. 여기가 갈라지면 프로젝트가 갈라진다
  scripts/  docs/
```

**둘로 가르는 이유가 셋이다.**

1. **폰이 여는 화면에 React·차트가 실려선 안 된다.** AR 은 이미 첫 로딩이 7.5MB다
2. **AR 은 지금 동작한다** (2026-07-30 폰 실기, D15). 대시보드 작업이 그 배포를 흔들지 않는 게
   낫다 — 폴더가 다르면 배포도 따로 나가고, 대시보드를 고치다 AR 이 죽는 일이 없다
3. 프레임워크가 다르다. 한 프로젝트에 섞으면 의존성·설정이 서로를 끌어당긴다

**레포는 가르지 않는다.** 두 쪽이 같은 맵 데이터를 쓰기 때문이다 — 갈라져도
두 화면 다 정상으로 보인다(D17). 그래서 `Shared/`가 있다.

## `Shared/` 는 두 층이다

```
Shared/
  data/           프레임워크 무관. 렌더링 없음. 데이터와 계약
    layout/       맵 모델         ← 두 쪽의 유일한 합의점
    units/        mm·도 ↔ m·라디안   ← 하드 룰 5, 여기 한 곳만
    config/       .env 에서 생성된 설정
    datasource/   지표·맵을 어디서 가져오나 (mock → http)
  view3d/         바닐라 three 공용. React 를 쓰지 않는다
    parts.js        무대 부품 카탈로그 (실험실 11 + 방산 5) · `assembleProps`
    robot.js        URDF 로딩 · 그리퍼 부착 · 관절
    path.js         FK 보간 · 경로선 · 재생
    reach-zone.js   도달 범위 표시
    global-cam.js   실제 카메라 ↔ 씬 변환
    lab/            방 껍데기 · 배치 뷰 · 편집 조작 · 하늘 (파일 4개)
  assets/         URDF · STL · 마커 (두 쪽이 다 쓴다)
```

**폴더는 파일이 둘 이상일 때 만든다.** 한 파일짜리 폴더는 경로만 길게 하고
`props/index.js`·`trajectory/trajectory.js` 같은 이름을 낳는다. 2026-08-03 에 그런 폴더
5개를 없앴다 — `view3d/` 는 파일 5개 + `lab/` 하나다.

**`Shared/view3d/` 가 React 를 쓰지 않는 것이 핵심이다.** 그래서 R3F 로 다시 쓰지 않고,
Dashboard 는 `ref` + `useEffect` 로 마운트한다 (`CONSOLE-REACT.md`).
R3F 로 가면 로봇 로딩 경로가 둘이 되고, 그게 배치가 갈라지는 두 번째 경로다.

**`Shared/` 에 화면을 두지 않는다.** 화면은 `AR/` 또는 `Dashboard/` 안에만 있다.

## 각 폴더 안

```
AR/
  index.html            랜딩 — JS 없음. 링크만
  ar.html               실물 배치 (본체)
  robot.html            카메라 없이 3D — 그리퍼 장착값 맞추는 도구
  test/marker-detect.html   검출률 측정 하네스
  src/
    entries/  ar.js · robot.js · markertest.js
    features/ marker/(정합·스무딩·진단)     ← overlay/ 는 L2 착수 때 만든다
    vendor/   ar-threex.mjs      ← npm 에 ESM 이 없어 파일로 남긴다
  vite.config.js  package.json

Dashboard/
  index.html
  src/
    entries/  main.jsx
    features/ layout/(맵 편집) · metrics/(지표 표시·비교) · control/(FR5 상태·연결 자리)
  vite.config.js  package.json

FR5/
  src/                  FR5 전용 웹 화면 경계
    features/           조작 · 티칭 · 슬롯 · 경로 · 기록
    data/datasource/    mock ↔ bridge ↔ Database 교체
  bridge/
    robot_adapter/      mock ↔ FAIRINO SDK 교체
```

`robot.html` 과 `test/` 를 `AR/` 에 두는 이유 — 둘 다 **마커 스케일과 그리퍼 장착값을
맞추는 도구**이고, 그 값이 제일 먼저 걸리는 화면이 AR 이다.

## 폴더 사이 규칙

| | 허용 |
|---|---|
| `AR/` → `Shared/data` `Shared/view3d` | ○ |
| `Dashboard/` → `Shared/data` `Shared/view3d` | ○ |
| `FR5/` → `Shared/data` `Shared/view3d` | ○ |
| `AR/` ↔ `Dashboard/` **직접 import** | **✗ 절대** |
| `Dashboard/` ↔ `FR5/` **직접 import** | **✗** — 계약·datasource로 연결 |
| `Shared/` → 화면 앱 | **✗** (거꾸로다) |
| `Shared/view3d/` → React | **✗** |

`AR/` 에서 `Dashboard/` 를 import 하는 순간 폰 번들에 React 가 실린다.
공유가 필요하면 **`Shared/` 로 내린다.**

## 두 프로젝트가 `Shared/` 를 어떻게 쓰나

**npm workspaces.** 현재 루트 `package.json` 하나가 실행 패키지 다섯을 묶는다.

```jsonc
// FR5Web/package.json
{ "private": true, "workspaces": ["Shared", "AR", "Dashboard", "FR5", "Sim"] }
```

- 루트에서 `npm install` 한 번. lockfile 하나. `FR5`는 2026-07-31 실행 패키지가 생겨 추가됐다
- 두 프로젝트가 `@fr5/shared` 를 보통 패키지처럼 import 한다
- 대안은 Vite `resolve.alias` + `server.fs.allow` 지만, dev 서버에서 경로 허용을
  따로 열어줘야 해서 걸림돌이 하나 더 생긴다. **workspaces 를 쓴다**

정적 자산은 각 `vite.config.js` 에서 `publicDir` 를 `Shared/assets` 로 가리킨다.
빌드하면 각 `dist/` 에 복사되지만, **URL 하나에는 하나만 배포되므로 낭비가 아니다.**

## 설정은 fetch 하지 않고 빌드 시 import 한다

지금은 `fetch('./config/marker-offset.json')` 이다. 바꾼다.

```js
import markerConfig from '@fr5/shared/data/config/marker-offset.json'
```

**이유** — 파일이 없거나 깨지면 **빌드가 실패한다.** 지금은 런타임에 조용히 실패하고,
그러면 화면에 아무것도 안 뜨는데 콘솔 에러도 없다. 그 부류로 이미 하루를 잃었다(D15).

**대가** — 마커 크기를 바꾸면 재빌드가 필요하다. 감수한다. 폰 하나만 바꾸는 것은
URL 파라미터(`?mm=`)와 `⚙` 가 이미 처리한다 (`AR-DEBUG.md` §2).

## 파일이 어디로 갔나 (전수 · **이관 완료**)

2026-07-30 전수조사 결과. **`web/` 아래 코드 파일 전부**다(자산·생성물 제외).

> **2026-07-31 — `web/` 폴더를 지웠다. 이 표는 이제 계획이 아니라 기록이다.**
> 지우기 전에 12개를 전수 대조했다 — 이관분은 목적지에 있고(설정 파일은 내용까지 동일),
> 삭제분은 npm 대체재(`three@0.185` · `urdf-loader@0.13`)가 설치돼 있으며
> `web/` 을 import 하는 코드는 0건이었다.
> **`web/.vercel` 만 이관표에 없었다** — 리포의 유일한 Vercel 링크(프로젝트 `web`
> = 공유 주소 `web-nine-rho-89.vercel.app`, D11)라 지우지 않고 `AR/.vercel` 로 옮겼다.
> 생성물이라 git 에 없어서, 지웠으면 되살릴 데가 없었다.

| 지금 | 어디로 | 비고 |
|---|---|---|
| `web/index.html` | `AR/index.html` | 그대로. JS 없음 |
| `web/ar.html` (526줄) | `AR/ar.html` + `src/screens/ar.js` + `features/` | **CSS·JS 를 뜯어낸다.** 이 파일이 가장 아팠다 |
| `web/robot.html` (290줄) | `AR/robot.html` + `src/screens/robot.js` | 같은 방식. **여기부터 먼저 옮긴다** |
| `web/test/marker-detect.html` | `AR/test/marker-detect.html` | 검증 하네스. 유지 |
| `web/test/smoothtest.html` (44줄) | **삭제** | `matrixAutoUpdate` 무해함을 증명한 1회용. 결론은 D15 에 있다 |
| `web/js/ar-marker.js` | `AR/src/features/marker/` | AR 전용 |
| `web/js/robot-view.js` | **`Shared/view3d/robot.js`** | 두 쪽이 다 쓴다 |
| `web/js/trajectory.js` | **`Shared/view3d/path.js`** | 두 쪽이 다 쓴다 |
| `web/js/loaders/TGALoader.js` (538줄) | **삭제** | **죽은 파일.** importmap 등록만 있고 import 하는 곳이 없다 |
| `web/js/vendor/three.module.js` `three.core.js` | **삭제** → npm `three` | |
| `web/js/vendor/URDFLoader.js` `URDFClasses.js` | **삭제** → npm `urdf-loader` | |
| `web/js/vendor/STLLoader.js` `OrbitControls.js` | **삭제** → npm `three/examples/jsm/` | |
| `web/js/vendor/ColladaStub.js` | **삭제** | npm 에 실물이 있어 꼼수가 불필요해진다 |
| `web/js/vendor/ar-threex.mjs` | `AR/src/external/` | **남긴다.** npm 에 ESM 빌드가 없다 |
| `web/config/*.json` | `Shared/data/config/` | 생성물. 위 §설정 참조 |
| `web/assets/**` | **`Shared/assets/**`** | 두 쪽이 다 쓴다 |
| `web/vercel.json` | `AR/vercel.json` + `Dashboard/vercel.json` | 아래 §배포 |

**삭제 대상이 9개 파일 · 약 2.2MB다.** 옮기는 일보다 지우는 일이 많다.

## 게이트를 먼저 고친다

폴더를 옮기면 게이트가 먼저 깨지고, 그 상태에서는 무엇이 진짜 문제인지 안 보인다.
**아래를 고친 뒤에 파일을 옮긴다.** 전수조사로 확인한 전부다.

| 파일 | 줄 | 지금 | 바꿀 값 |
|---|---|---|---|
| `scripts/check/assets.sh` | 14 | `ARM=web/assets/FAIRINO_FR5` | `Shared/assets/FAIRINO_FR5` |
| `scripts/check/assets.sh` | 15 | `GRIP=web/assets/PGEA_100_40` | `Shared/assets/PGEA_100_40` |
| `scripts/check/assets.sh` | 67 | `find web/assets ...` | `find Shared/assets ...` |
| `scripts/build/config.mjs` | 145–146 | `web/config/*.json` | `Shared/data/config/*.json` |
| `scripts/assets/sync-from-unity.sh` | 13–14, 36 | `web/assets/...` | `Shared/assets/...` |
| `scripts/dev/serve.sh` | 전체 | `python -m http.server` | `npm run dev -w AR` / `-w Dashboard` |
| `.gitignore` | — | `web/config/*.json` | `Shared/data/config/*.json` · `node_modules/` · `*/dist/` |

`scripts/check/consts.sh` 는 `config.mjs --check` 를 부르므로 **따로 고칠 것이 없다.**

## 배포 — 프로젝트 둘

```jsonc
// AR/vercel.json · Dashboard/vercel.json 각각
{ "framework": null,               // 자동추론이 vite build 를 잘못 부른 적이 있다
  "buildCommand": "npm run build",
  "installCommand": "npm install",
  "outputDirectory": "dist",
  "headers": [ /* AR 만: Permissions-Policy: camera=(self) */ ] }
```

- **AR 의 `Permissions-Policy` 헤더를 지우지 않는다.** 없으면 카메라가 안 열린다
- 공유 주소는 **공개 별칭**을 쓴다. `vercel` 이 찍는 해시 URL 은 로그인 벽이 걸린다 (D11)
- workspaces 를 쓰므로 Vercel 프로젝트의 **Root Directory 를 `AR`/`Dashboard` 로**
  지정하고 install 은 루트에서 돌게 한다
- **배포는 지시를 받고 한다** — 검증까지 하고 멈춘다

## 이관 순서 (수렴 루프 반영 · 2026-07-30 재정리)

**A·B·C0·C·C2 완료.** 엔트리 4개가 다 빌드되고 **기준값 7개가 이관 전후로 일치**한다
(`archive/evidence-2026-07/2026-07-30/ar-baseline.md`). 남은 미확인은 **폰의 카메라 하나**다.

### 전제가 하나 풀렸다 — 새 주소를 써도 된다

수렴 루프는 "팀원 별칭을 유지해야 한다"를 제약으로 뒀고, 그래서
Vercel 대시보드에서 Root Directory 를 바꾸는 **사람 단계**가 필요했다.
실기 담당자가 **새 주소도 괜찮고 기존 배포본을 지워도 된다**고 확정했다(2026-07-30).

**그러면 롤백이 공짜로 생긴다.** 새 프로젝트를 만들면 기존 `web` 배포는 **손대지 않은 채
계속 살아 있다** — 폰에서 새 것이 실패하면 옛 주소를 그대로 쓰면 된다.
기존 배포에 덮어쓰는 방식보다 오히려 안전하다.

| | 남은 단계 | 판정 | 누가 |
|---|---|---|---|
| **D** | 문서·README 의 경로 갱신 — 인쇄 경로가 `web/assets/…` 로 남아 있다 | `check/docs.sh` 통과 | 나 |
| **E** | 새 Vercel 프로젝트를 **소문자 이름**으로 만들어 `AR/` 배포. 기존 `web` 은 **건드리지 않는다** | 새 주소가 열린다 | **지시 받고** |
| **F** | ★ **폰 확인 — 카메라 하나만 본다** | 마커를 비추면 겹쳐 보인다 | 실기 담당자 |
| **G** | 통과 후 정리 — `web/` 삭제 · 죽은 파일 9개(약 2.2MB) · **기존 Vercel 프로젝트 삭제** · 문서의 주소 갱신 | 게이트 전체 통과 | 나 |
| **H** | 슬롯형 config + `/맵교체` (별 단계) | 슬롯 이름으로 교체된다 | 나 |

`Dashboard/` 신설은 **이관이 아니다** — 코드가 0줄이고 본체는 L1(맵 편집)이다.

### E 의 함정 — 프로젝트 이름은 소문자만 된다

**폴더가 `AR` 이라 그대로 링크하면 `400` 으로 거부된다** (2026-07-30 확인).
`Project names ... must be lowercase`. 그래서 이름을 명시해야 한다.

```bash
cd AR && vercel link --project fr5ar --yes --scope kimjuyoung1127s-projects
cd AR && vercel --prod --yes --scope kimjuyoung1127s-projects
```

- 공유 주소는 **공개 별칭**을 쓴다. `vercel` 이 찍는 해시 URL 은 로그인 벽이 걸린다 (D11)
- **`AR/vercel.json` 의 `Permissions-Policy: camera=(self)` 를 지우지 않는다.** 없으면 카메라가 안 열린다
- `framework: null` 을 유지한다 — 자동추론이 `vite build` 를 잘못 부른 전례가 있다

### G 를 F 앞으로 당기지 않는다

`web/` 을 먼저 지우면 **되돌릴 것이 없어진다.** 로컬 `web/` 은 이관 A 로 이미 깨져 있어
그 자체로는 롤백이 안 되지만, **git 이력 + 살아 있는 기존 배포** 둘이 롤백 경로다.
G 에서 그 둘을 같이 닫는다 — 폰 확인이 통과한 뒤에.

### 헤드리스 게이트가 재는 7개 (C2 에서 쓴 것)

카메라 없이 확인되는 전부다. **폰에는 카메라 하나만 남는다.**

| # | 값 | 왜 |
|---|---|---|
| 1 | 실패 요청 0 | 모듈 해석·자산 경로 |
| 2 | `ar-threex` 모듈 평가 | ESM import 해석 |
| 3 | 삼각형 **129,560 / 메시 11** | 자산·그리퍼·궤적 튜브 (`robot.html` 은 STL 128,584 + 뎁스캠 박스 48 / 메시 14 — **다른 것이 정상**) |
| 4 | 궤적 **1.2458m / 61점** | 월드·로컬 좌표 혼동으로 5배가 된 전례 |
| 5 | 안전 링 **.902 / .922**, 벽 **.922 × .9** | FR5 도달거리 |
| 6 | 마커 143mm · bc2 · 스케일 **6.993** | 로봇 크기를 결정한다 |
| 7 | `body` = `rgba(0,0,0,0)` · **`#arjs-video` 규칙 없음** | **D13** — 깨지면 폰에서 검은 화면 |

**`window` 노출을 빼지 않는다** — 이 대조가 거기 걸려 있다.

## 하지 말 것

- **`AR/` ↔ `Dashboard/` 직접 import** — 공유는 `Shared/` 로만
- **`Shared/view3d/` 에 React 넣기** — 두 쪽이 못 쓰게 된다
- **`Shared/` 에 화면 두기** — 경계가 무너진 신호다
- **자산을 양쪽에 복사하기** — `Shared/assets/` 하나. `publicDir` 로 가리킨다
- **`ar.html` 의 `#arjs-video` 크기를 CSS 로 건드리기** — 영상↔투영 대응이 깨져 로봇이 밀린다 (D13)
- **빌드 통과를 이관 완료로 판정하기** — wasm 초기화와 카메라 정합은 브라우저에서만 확인된다
- **`ar-threex.mjs` 를 npm 패키지로 바꾸려 시도** — 레지스트리에 ESM 빌드가 없다. 확인했다

## 폴더마다 `AGENTS.md` 를 둔다 — 이득이 있다

**현재 판정(D36)** — `AR` `Dashboard` `Shared` `FR5` `Database` `Vision` `TurtleBot`에
도메인 경계를 둔다. `FR5/`가 웹+브리지를 함께 소유하므로 루트 범용 `Backend/`는 두지 않는다.

2026-07-30에는 범용 백엔드 자리를 준비했지만, 2026-07-31 전수 확인에서 실행 파일·빌드·
배포 의존이 0개임을 확인했다. 로봇마다 관문 하나라는 이미 확정된 경계에 맞춰 FR5 안으로 옮겼다.

그리고 **`AGENTS.md` 가 들어간 폴더는 빈 폴더가 아니다** — 그 자리에 무엇이 오고
경계가 무엇인지 적힌 문서다. 착수하는 사람이 SSOT 를 뒤지지 않고 바로 시작한다.
그래서 "쓰지 않을 기계장치를 미리 만든다"는 적재 우려에도 걸리지 않는다.

**이득** — Claude Code·Codex·OpenCode가 같은 `AGENTS.md`를 읽는다.
`AR/` 을 고치는 세션이 `BUILD-VITE.md` + `SHARED-CORE.md` + `AR-DEBUG.md` 를 다 열지 않고
**그 폴더에서만 참인 규칙 3~5개**만 받는다. 매 세션 진입 비용이 준다.

**대가** — 드리프트할 곳이 4개 늘어난다. 그래서 규칙을 좁게 둔다.

| 폴더 `AGENTS.md` 에 적는다 | 적지 않는다 |
|---|---|
| 그 폴더 **안에서만** 참인 것 | 프로젝트 전역 규칙 — 루트 `CLAUDE.md` 하나 |
| 여기서 실제로 밟은 함정 | 배경·이유 — SSOT 로 **링크만** |
| 어느 SSOT 를 읽어야 하는지 (2~3개) | 문서 내용 복사 |

**25줄을 넘기지 않는다.** 넘으면 SSOT 로 옮긴다.
중복 서술이 시작되면 이득이 사라지고 드리프트만 남는다.
**`scripts/check/docs-weight.sh` 가 이 상한을 잰다.**
