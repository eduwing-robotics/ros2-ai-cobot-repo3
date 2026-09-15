// 터틀봇3 버거 메시 한 장 — **받는 곳을 한 곳으로 모은다.**
//
// 배치 뷰(`lab/layout-view.js`)와 FR5 조작 화면(`FR5/.../RobotTwin.jsx`)이 같은 로봇을
// 그린다. 로더가 둘이면 경로·실패규약이 갈라지고, 갈라진 쪽은 아무도 안 고친다.
//
// GLB 는 `scripts/build/burger-glb.py` 가 ROBOTIS STL 4장을 구운 것이다 —
// 원점 **바닥 중앙** · 정면 **+Z** · 미터(glTF). 치수 정본은 `catalog.js` 의 `AMR_MM`.
//
// **조용히 실패하지 않는다** (D15·D18) — 못 받으면 이유를 콘솔에 남기고 `null` 을 돌려주며,
// 부르는 쪽은 제 대체 상자를 그대로 둔다. 메시가 없어도 발자국은 판단 근거로 남는다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AMR_WHEEL_R_MM } from '../data/layout/catalog.js';

const URL = '/turtlebot3_burger/burger.glb';

let promise = null;

/** @returns {Promise<import('three').Object3D|null>} 씬에 붙일 메시. 실패하면 `null` */
export function loadBurger() {
  if (promise) return promise;
  // **DOM 없는 곳에서는 안 받는다.** `check/xr-place.sh`·`ar-render.sh` 가 이 모듈을 **Node 에서**
  // 불러 겹치기 기하만 계산한다. 거기서 `GLTFLoader.load` 는 기준 URL 이 없어 `Invalid URL` 로
  // **던지고**, 게이트가 미처리 거부로 죽는다 (2026-08-07 에 실제로 죽였다).
  // 자산 로딩은 화면의 일이다.
  if (typeof document === 'undefined') {
    promise = Promise.resolve(null);
    return promise;
  }
  promise = new Promise((res) => {
    const fail = (err) => {
      console.warn('터틀봇 메시를 못 불러왔다 — 대체 상자로 간다:', err?.message ?? err);
      res(null);
    };
    // `load` 는 콜백으로도 오고 **동기로 던지기도 한다.** 둘 다 같은 자리로 모은다
    try {
      new GLTFLoader().load(URL, (gltf) => res(gltf.scene), undefined, fail);
    } catch (err) { fail(err); }
  });
  return promise;
}


/**
 * 이 GLB 가 **어느 쪽으로 구워졌나** — 자세(yaw)와 **별개의 값**이다.
 *
 * `scripts/build/burger-glb.py` 가 정한 규약: 원점 **바닥 중앙** · 정면 **+Z** · 미터(glTF Y-up).
 * 로봇이 어디를 보는지(`yawDeg`)와 모델이 어떻게 구워졌는지(이 상수)를 **한 값에 섞으면**
 * 한쪽을 고칠 때 다른 쪽이 조용히 틀어진다 — 2026-08-28 에 실제로 그랬다:
 * `deg 180` 을 「작업대2 쪽」으로 넣었는데 화면은 **카트 쪽**을 봤다(90° 어긋남).
 */
export const BURGER_MODEL = {
  frontAxis: '+Z',        // glTF 안에서의 정면
  upAxis: '+Y',           // glTF Y-up
  originAt: 'bottom-center',
  wheelNodes: ['wheel_left', 'wheel_right'],   // 2026-09-06 부터 별도 노드 — 없으면(옛 GLB) 회전만 건너뛴다
  // 바퀴 축은 **로컬 z** 다 — Blender 가 Y-up 으로 내보내며 자식 축을 (x, y, z)→(x, z, −y) 로 옮긴다
  // (ROS 축 +Y 가 glTF 로컬 −Z). **부호는 검산했다** (2026-09-06 · three.js 로 루트 쿼터니언·마운트 그룹을 세워
  // 접지점을 돌려 봄): `rotation.z += +a` 면 접지점이 **앞(+x)** 으로 갔다 — 그래서 앞으로 구를 때 **−** 다.
  wheelAxis: 'z',
  wheelSign: -1,
};

/**
 * 바퀴를 굴린다 — **굴러간 거리(mm · 앞이 +)** 만큼. 회전각 = 거리 ÷ 반지름(`catalog.js` `AMR_WHEEL_R_MM`).
 * 옛 GLB(한 덩어리)나 대체 상자에는 바퀴 노드가 없다 — 그때는 조용히 아무것도 안 한다(D15·D18: 죽지 않는다).
 * 축·부호는 `BURGER_MODEL.wheelAxis`·`wheelSign` — 추론이 아니라 검산값이다 (그 주석 참조).
 * @param {import('three').Object3D} mesh `loadBurger()` 가 준 씬(clone 포함) 또는 그것을 담은 그룹
 * @param {number} deltaMm 이번 틱에 굴러간 거리. 뒤로 가면 음수
 * @returns {number} 돌린 바퀴 개수 (0 이면 노드가 없었다)
 */
export function rollWheels(mesh, deltaMm) {
  if (!mesh || !Number.isFinite(deltaMm) || deltaMm === 0) return 0;
  let n = 0;
  for (const name of BURGER_MODEL.wheelNodes) {
    const w = mesh.getObjectByName(name);
    if (!w) continue;
    w.rotation[BURGER_MODEL.wheelAxis] += BURGER_MODEL.wheelSign * deltaMm / AMR_WHEEL_R_MM;
    n += 1;
  }
  return n;
}

/**
 * Z-up 씬(로봇 베이스 홀더)에 **정면이 +x 가 되도록** 얹어 돌려준다.
 *
 * 이 함수를 거치고 나면 부르는 쪽은 **`rotation.z = yaw` 만 넣으면 된다** —
 * yaw 0 = +x, 반시계 +. 표준 규약이고 로봇 좌표계와 같다.
 *
 * 회전을 **중첩 그룹 둘로 나눈다.** 한 노드에 오일러 셋을 넣으면 적용 순서(three 는 'XYZ')를
 * 읽는 사람이 매번 되짚어야 하고, 그 되짚기가 위 90° 사고의 온상이다. 여기서는
 * 바깥 = 축 정렬(Y-up→Z-up), 안 = 정면 정렬(+Z→+x) 로 **한 그룹에 회전 하나**만 둔다.
 *
 * @param {import('three').Object3D} mesh `loadBurger()` 가 준 씬(또는 그 clone)
 * @returns {import('three').Group} 씬에 그대로 add 할 수 있는 그룹
 */
export function mountBurgerZUpXForward(mesh) {
  const axis = new THREE.Group();     // glTF Y-up → 씬 Z-up. 이때 정면(+Z)은 −y 로 간다
  axis.rotation.x = Math.PI / 2;
  axis.add(mesh);
  const front = new THREE.Group();    // 그 −y 를 +x 로 돌린다 (+90°)
  front.rotation.z = Math.PI / 2;
  front.add(axis);
  return front;
}

/**
 * **Y-up 씬**(배치 뷰)에 정면이 평면도 `+x` 가 되도록 얹어 돌려준다.
 *
 * 배치 뷰는 Y-up 이고 그룹에 `rotation.y = θ` 를 넣는데, θ 는 평면도 `atan2(Δy, Δx)` 라
 * **θ=0 이 평면도 +x** 를 뜻한다. 그런데 GLB 정면은 `+Z` 이고 그 축은 평면도로 `−Y` 다
 * (`layout-view.js` 머리의 `Z` 규약 · D43). 그래서 보정 없이 붙이면 **90° 어긋난 채**
 * 로봇이 진행 방향과 옆으로 틀어져 「옆걸음」을 한다 (2026-08-28 감사에서 검산으로 잡혔다).
 *
 * `mountBurgerZUpXForward` 와 **같은 일을 다른 씬 규약으로** 한다 — 정면의 0점을
 * 정하는 곳이 둘이면 한쪽만 고쳐진다.
 */
export function mountBurgerYUpXForward(mesh) {
  const front = new THREE.Group();
  front.rotation.y = Math.PI / 2;     // GLB 정면 +Z → 씬 +X
  front.add(mesh);
  return front;
}
