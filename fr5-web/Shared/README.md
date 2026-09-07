# shared — AR · Dashboard · FR5 가 같이 쓰는 것

**여기가 갈라지면 프로젝트가 갈라진다.** 두 화면이 다른 배치안을 보는데
양쪽 다 정상으로 보인다 — 에러가 안 난다 (D17).

- `data/` — 데이터·계약. **프레임워크 무관, 렌더링 없음**
- **`data/datasource/` 가 데이터 출처를 아는 유일한 곳이다** — 화면은 `fetch`·저장소를
  직접 부르지 않는다. 교체는 `index.js` 한 줄 (`scripts/check/datasource.sh` 가 지킨다)
- `view3d/` — 바닐라 three 공용. **React 를 쓰지 않는다**
- `tokens/` — codegate 시각 정본의 런타임 미러. **컴포넌트 스타일은 공유하지 않는다**
- **화면을 두지 않는다** — 화면은 `AR/` · `Dashboard/` · `FR5/` 안에만
- **배치안 원점은 실험실 바닥이다. 로봇 베이스가 아니다** — 팔 위치가 변수라서 (SR_23)
- **단위 변환은 `data/units/` 한 곳** (하드 룰 5)
- `data/config/*.json` 은 `.env` 에서 굽는 **산출물**이다. 손으로 고치지 않는다

## 폴더

| 경로 | 무엇 |
|---|---|
| `assets/` | URDF, 마커, 그리퍼 STL 등 정적 자산 |
| `data/` | `layout` 배치안 · `units` 단위변환 · `config` 굽힌 설정 · `datasource` 출처 경계 · `motion` 자세·한계·프리셋 · `scenario` 시나리오 스키마 · `timeline` 재생 · `sim` 시뮬 재생 자세(`frames.js` · ReplayView·XR 공용) · `camera` 카메라/뎁스 상태 |
| `data/*.js` | `workcell.js`(작업셀 실측) · `props.js`(작업물·소품 실측) — **실측값의 단일 출처.** 화면·스크립트가 숫자를 따로 들고 있지 않는다 |
| `build/` | 빌드 시점 변환. `strip-notes.js` — `_` 로 시작하는 설정 키를 **배포 번들에서만** 턴다 (원본·dev 는 그대로) |
| `tokens/` | 색·간격·타이포 CSS 변수 |
| `view3d/` | 바닐라 three.js 3D 뷰 모듈. `lab/` 이 실험실 무대(스테이지·배치뷰·기즈모·상호작용) · `zone-overlay.js` 판정면 겹치기(조작대·AR 공용) · `zone-theme.js` **색을 갈아끼우는 자리 하나** |

읽을 것 — `docs/ref/contract/SHARED-CORE.md`
