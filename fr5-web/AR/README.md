# AR — 폰이 여는 화면 (Vite + 바닐라)

- **React·차트를 넣지 않는다.** 폰이 열고 첫 로딩이 이미 7.5MB다
- **`Dashboard/` 를 import 하지 않는다.** 공유는 `Shared/` 로만
- `#arjs-video` 의 **크기를 CSS 로 건드리지 않는다** — 영상↔투영 대응이 깨져 로봇이 밀린다
- **`body` 에 배경을 주지 않는다.** 배경은 `html` 에만 — 안 그러면 폰에서 검은 화면 (D13)
- **헤드리스 계약을 빼지 않는다** — `robot`·`points`·`zone`·`mcfg`(ar) · `__cam`(cam) ·
  `__xr`·`__xrArms`·`__xrLive`·`__xrGhosts`·`__xrReplay`(xr). 기준값 대조가 걸려 있다 (`docs/archive/evidence-2026-07/2026-07-30/ar-baseline.md`)
- **판정은 폰이다.** 카메라 권한은 자동화로 못 넘는다 — 빌드 통과로 대체하지 않는다
- 자산은 `Shared/assets` 가 `publicDir` 이라 **루트에서 서빙**된다 → `/FAIRINO_FR5/…`

## 배포 — 두 갈래. 손으로 `vercel` 을 치지 않는다

| 무엇을 보나 | 어디 | 명령 |
|---|---|---|
| 배치안·마커 (라이브 없음) | Vercel `fr5ar.vercel.app` | `bash scripts/dev/deploy-ar.sh` |
| **브리지 라이브가 붙는 화면** (`cell`·`xr`) | 브리지 `/ar` | `npm run build:ar` → `bash scripts/deploy/fr5-ubuntu.sh` |

HTTPS 인 Vercel 은 평문 브리지를 못 부른다(혼합 콘텐츠) — 라이브는 브리지에서만 산다.
`build:ar` 를 빼면 `fr5-ubuntu.sh` 가 **옛 `AR/dist` 를 그대로 밀어 넣는다** (rsync 대상이라 조용히 성공한다).
Vercel 쪽은 모노레포라 원격 빌드가 `@fr5/shared` 를 못 받고(`vercel.json` 의 `buildCommand` 는 이관 전 유물),
스크립트가 **카메라 권한 헤더를 다시 심는다** — 빠지면 AR 이 통째로 죽는다.

## 폴더

| 경로 | 무엇 |
|---|---|
| `*.html` | 화면 6개 — `index`(랜딩) `ar`(겹쳐 보기) `cam`(글로벌 카메라) `xr`(WebXR 바닥) `robot`(그리퍼 정합) `cell`(역할-라이브). 엔트리 정본은 `vite.config.js` |
| `src/screens/` | 화면당 js+css 한 쌍 |
| `src/features/` | `marker/` 인식 · `place/` 배치 · `preview/` 맵 미리보기 · `record/` 녹화 · `ui/` 입력 위젯 |
| `src/external/` | AR.js 를 ESM 으로 구운 벤더 파일(1.5MB). **우리가 고치지 않는다** |
| `test/` | 마커 감지 테스트 화면·이미지 · **`tag-track.html`** 실패한 WebXR 이미지 추적 기록 · **`tag-cv-track.html`** 기존 AprilTag 4장 직접 검출, 폰 내부 파라미터 캡처(`?calibrate=1`), 3태그 이상 평면 자세와 이동 발자국(`?pose=1` · 명령 0) |

읽을 것 — `docs/ref/runbook/AR-DEBUG.md` (안 될 때) · `docs/ref/arch/BUILD-VITE.md` (경계)
