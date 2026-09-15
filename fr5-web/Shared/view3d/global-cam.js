// 글로벌 카메라 캘리브레이션(OpenCV) → three.js 카메라.
//
// **좌표 규약이 세 번 어긋난다.** 하나라도 놓치면 겹친 3D 가 뒤집히거나 반전되거나
// 미묘하게 밀리는데, 실기에서 처음 보면 원인이 카메라인지 좌표계인지 못 가른다.
//
//   ① OpenCV 카메라: +X 오른쪽 · **+Y 아래** · **+Z 앞**
//      three.js 카메라: +X 오른쪽 ·  +Y 위   ·  −Z 앞      → diag(1,-1,-1)
//   ② 실험실 바닥 원점(Z-up · mm) → 씬(Y-up · m)          → planToScene 한 곳에서만
//   ③ 주점(cx, cy)이 화면 정중앙이 아니다                   → PerspectiveCamera(fov) 로는 표현 불가.
//                                                            투영 행렬을 직접 만든다
//
// **거울 좌표계는 카메라로 흡수할 수 없다.** planToScene 의 행렬식이 −1 이면
// 뷰 행렬 행렬식도 −1 이 되어 회전으로 표현이 안 된다 (스케일 −1 을 쓰면 이번엔
// 뒷면 컬링이 뒤집혀 벽이 사라진다). 그래서 이 모듈은 **행렬식을 먼저 검사하고 던진다.**
//
// 렌즈 왜곡은 three.js 가 표현하지 못한다 — 영상 쪽을 언디스토트하거나 왜곡이 작은
// 렌즈를 쓴다. `calib.intrinsics.dist` 가 크면 가장자리부터 어긋난다.

import * as THREE from 'three';
import { mm, planToScene } from '../data/units/units.js';

/** planToScene 을 3x3 선형 사상으로 뽑는다 (mm→m 스케일은 뺀다). */
function planAxes() {
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => planToScene(e).map((v) => v / mm(1)));
  // cols[i] = 실험실 i 축이 씬에서 향하는 방향
  return new THREE.Matrix3().set(
    cols[0][0], cols[1][0], cols[2][0],
    cols[0][1], cols[1][1], cols[2][1],
    cols[0][2], cols[1][2], cols[2][2],
  );
}

function det3(m) {
  const e = m.elements;   // column-major
  return (
    e[0] * (e[4] * e[8] - e[5] * e[7])
    - e[3] * (e[1] * e[8] - e[2] * e[7])
    + e[6] * (e[1] * e[5] - e[2] * e[4])
  );
}

/** 로드리게스 회전 벡터 → 3x3 행렬 */
function rodrigues([rx, ry, rz]) {
  const th = Math.hypot(rx, ry, rz);
  if (th < 1e-12) return new THREE.Matrix3();
  const [x, y, z] = [rx / th, ry / th, rz / th];
  const c = Math.cos(th), s = Math.sin(th), t = 1 - c;
  return new THREE.Matrix3().set(
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  );
}

/**
 * 캘리브레이션 결과를 three.js 카메라에 얹는다.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {object} calib  Shared/data/config/global-cam.json 그대로
 * @param {number} near_ 미터
 * @param {number} far_  미터
 */
export function applyCalibToCamera(camera, calib, near_ = 0.05, far_ = 200) {
  const I = calib.intrinsics;
  const E = calib.labToCam;
  if (!I || !E) throw new Error('global-cam.json 에 intrinsics 또는 labToCam 이 없다');

  const M = planAxes();
  const d = det3(M);
  if (d < 0) {
    throw new Error(
      `planToScene 이 거울 사상이다 (det=${d}). 실험실 좌표계가 오른손이면 `
      + '(x, z, -y) 여야 한다 — units.js 한 곳에서 고쳐라 (하드 룰 5).',
    );
  }

  // 뷰 회전 R_v = D · R · M⁻¹,  뷰 이동 t_v = D · t
  const D = new THREE.Matrix3().set(1, 0, 0, 0, -1, 0, 0, 0, -1);
  const R = rodrigues(E.rvec);
  const Minv = M.clone().invert();
  const Rv = D.clone().multiply(R).multiply(Minv);
  const tv = new THREE.Vector3(...E.tvecMm).applyMatrix3(D);

  // 카메라 월드 = 뷰의 역. 위치는 mm → m.
  const RvT = Rv.clone().transpose();
  const pos = tv.clone().applyMatrix3(RvT).multiplyScalar(-mm(1));

  const world = new THREE.Matrix4().setFromMatrix3(RvT);
  camera.quaternion.setFromRotationMatrix(world);
  camera.position.copy(pos);
  camera.matrixAutoUpdate = true;
  camera.updateMatrixWorld(true);

  // 투영 — 주점이 중앙이 아니므로 fov 로는 못 만든다. 직접 채운다.
  const { widthPx: W, heightPx: H, fx, fy, cx, cy } = I;
  const p = new THREE.Matrix4();
  p.set(
    2 * fx / W, 0, 1 - 2 * cx / W, 0,
    0, 2 * fy / H, 2 * cy / H - 1, 0,
    0, 0, -(far_ + near_) / (far_ - near_), -2 * far_ * near_ / (far_ - near_),
    0, 0, -1, 0,
  );
  camera.projectionMatrix.copy(p);
  camera.projectionMatrixInverse.copy(p).invert();
  // fov/aspect 는 참고값으로만 맞춰 둔다 — 렌더는 위 행렬을 쓴다
  camera.fov = 2 * Math.atan(H / (2 * fy)) * 180 / Math.PI;
  camera.aspect = W / H;
  camera.near = near_;
  camera.far = far_;
  return camera;
}

/** 실험실 좌표(mm) → 화면 픽셀. 검증·디버그용. */
export function labToPixel(camera, calib, labMm) {
  const v = new THREE.Vector3(...planToScene(labMm)).project(camera);
  const { widthPx: W, heightPx: H } = calib.intrinsics;
  return [(v.x * 0.5 + 0.5) * W, (0.5 - v.y * 0.5) * H];
}
