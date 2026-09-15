분류: **SSOT**. 코드를 짜거나 폴더를 만들기 전에 네이밍·단위·좌표계·안전 규칙을 확인한다.

# CODING-CONVENTIONS — 코딩 규약

## 1. 파일명과 폴더

| 종류 | 규칙 | 예시 |
|---|---|---|
| 서버 모듈 | snake_case | `robot.py`, `safety.py`, `kinematics.py` |
| 웹 자바스크립트 모듈 | camelCase | `robotView.js`, `arCamera.js` |
| 정적 페이지 | 소문자 | `index.html`, `ar.html` |
| 검증 스크립트 | `scripts/check/` 안에 둔다 | `scripts/check/urdf-load.py` |
| 개발 스크립트 | `scripts/dev/` 안에 둔다 | `scripts/dev/mock-robot.py` |
| 로봇 관련 스크립트 | `scripts/robot/` 안에 둔다 | `scripts/robot/calibrate-marker.py` |
| 에셋 스크립트 | `scripts/assets/` 안에 둔다 | `scripts/assets/copy-stl.sh` |

최상위 `scripts/`에 파일을 바로 두지 않는다. `check/`, `dev/`, `robot/`, `assets/` 중 하나에 담는다.

## 2. 단위

API 계약 바깥면은 **도(°)**와 **밀리미터(mm)**만 쓴다. 라디안·미터 변환은 서버 안쪽과 3D 화면 안쪽에서만 한다.

| 곳 | 단위 | 축 |
|---|---|---|
| 로봇 · API 계약 | °, mm | 로봇 베이스 기준 |
| URDF · 3D 내부 | 라디안, 미터 | Z-up |
| three.js 화면 | 라디안, 미터 | Y-up |
| AR 마커 | 미터 | 마커 원점 → 로봇 원점 변환은 설정값 |

변환은 경계에서 한 번만 한다. 중간에서 다시 변환하지 않는다.

## 3. 좌표계

- URDF와 three.js 내부는 **Z-up**이다.
- three.js 화면은 **Y-up**이다. `robot.rotation.x = -Math.PI / 2`로 둔다.
- AR 마커 원점에서 로봇 베이스 원점까지의 관계는 설정 파일에 둔다. 코드에 하드코딩하지 않는다.

## 4. 안전

서버가 강제한다. 클라이언트를 믿지 않는다.

| 규칙 | 값 |
|---|---|
| 기본 속도 상한 | 10% |
| 한 번에 허용되는 관절 변화 | 5° |
| 상한을 넘는 명령 | 거부하고 사유를 응답 |
| `stop` | 조종권·상한과 무관하게 즉시 실행 |

## 5. 관절과 모델

- 로봇 관절 이름은 `j1`~`j6`이다. URDF 기준 revolute.
- 그리퍼는 별도 링크로 다룬다. URDF 확정 후 이름은 `gripper`로 시작한다.

## 6. 구조 변경

API 계약과 구조 변경은 문서가 먼저다. `docs/ref/contract/API-CONTRACT.md`와 `docs/ref/arch/ARCHITECTURE.md`를 고치고 코드를 짠다.

## 7. 검증

- 3D·AR 변경은 브라우저를 띄워서 확인한다.
- 증거는 `docs/evidence/YYYY-MM-DD-제목.md`로 날짜별로 남긴다.
- `scripts/check/` 스크립트는 실패 시 반드시 `exit 1`로 종료한다.

## 8. DoD 게이트

기능을 완료로 표시하기 전에 아래를 확인한다.

- [ ] 단위 변환 누락 없음: 로봇/API는 °·mm, 화면은 라디안·미터
- [ ] 안전 상한을 서버에서 검사
- [ ] `stop` 명령이 조종권과 무관하게 동작
- [ ] 변경된 계약 문서에 먼저 반영
- [ ] 3D/AR 변경은 브라우저 실렌더 증거 남김
- [ ] `check/` 스크립트가 통과
