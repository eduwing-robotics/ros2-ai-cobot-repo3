// 단위 변환 — **하드 룰 5. 이 파일 한 곳에서만 한다.**
//
// 이 프로젝트에서 가장 자주 틀린 곳이 단위·좌표계다. 실제로 밟은 것 둘:
//   · 그리퍼 STL 은 밀리미터, 팔 URDF 는 미터 → 보정을 빼면 1000배로 떴다
//   · 궤적 점을 월드 좌표로 돌려줘 마커 스케일(약 7배)이 섞여 길이가 4.754m 로 나왔다
//     (정답 0.951m)
//
// 규칙 — **바깥면은 항상 mm·도(°)**. 라디안·미터는 3D 내부에서만 쓴다.
//   배치안 · 서버 계약 · 로봇 API  →  mm · 도
//   URDF · three.js 내부           →  m · 라디안

export const MM_TO_M = 0.001;
export const DEG_TO_RAD = Math.PI / 180;

/** 밀리미터 → 미터 */
export const mm = (v) => v * MM_TO_M;
/** 미터 → 밀리미터 */
export const toMm = (v) => v / MM_TO_M;
/** 도 → 라디안 */
export const deg = (v) => v * DEG_TO_RAD;
/** 라디안 → 도 */
export const toDeg = (v) => v / DEG_TO_RAD;

/** [x,y,z] 밀리미터 배열 → 미터 배열. 배치안 좌표를 3D 로 넘길 때 쓴다. */
export const mmVec = (v) => v.map(mm);

/**
 * 배치안 좌표(바닥 원점 · Z-up · mm) → three.js 화면 좌표(Y-up · m).
 *
 * **배치안은 Z-up 이다** — 바닥 평면이 x·y 이고 z 가 위다 (SR_23).
 * three.js 는 Y-up 이라 축을 바꿔야 한다. 부모 그룹을 돌리는 방법도 있지만,
 * 평면도 좌표를 화면 좌표로 **직접** 바꿔야 할 때가 있어 여기 함수로 둔다.
 *
 * **Y 부호를 뒤집는다.** 축을 그냥 맞바꾸면(`[x, z, y]`) 행렬식이 −1 인 **거울 사상**이라
 * 씬이 실제의 좌우 반전이 된다. 배치안만 볼 때는 아무도 눈치채지 못하지만, 글로벌 카메라
 * 영상 위에 겹치는 순간 첫 프레임에 드러나고 **카메라로는 흡수할 수 없다** —
 * 뷰 행렬 행렬식이 −1 이 되어 회전으로 표현이 안 된다
 * (`Shared/view3d/global-cam.js`, 게이트 `scripts/map/check-camera.sh`).
 *
 * 실험실 좌표계는 **오른손**이다 — ROS 맵(`mapToLab`)도 OpenCV `solvePnP` 도 오른손을 전제한다.
 */
export const planToScene = ([x, y, z]) => [mm(x), mm(z), -mm(y)];

/** 두 평면도 좌표 사이 거리 (mm). 경로 길이·도달 판정에 쓴다. */
export function distMm(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = (a[2] ?? 0) - (b[2] ?? 0);
  return Math.hypot(dx, dy, dz);
}
