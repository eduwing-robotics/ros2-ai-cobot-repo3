// 관절 기즈모 — **팔을 잡고 돌려 자세를 만든다.**
//
// **React 를 쓰지 않는다** (`Shared/view3d` 규약). 화면은 이걸 붙이고 포인터만 넘겨준다.
//
// 왜 링인가 — 관절은 **한 축을 도는 것**이라 그 축을 감는 원이 자기가 무엇을 하는지 스스로
// 설명한다. 축은 **URDF 가 들고 있다**(`joint.axis`) — 각도를 짐작하지 않는다는 이 프로젝트의
// 규칙이 방향에도 그대로 적용된다.
//
// ── 세 가지를 조심한다
//
// ① **자기 축을 도는 것은 자기 축을 안 바꾼다.** 그래서 끄는 동안 평면을 다시 안 잡는다.
//    부모 관절이 돌면 바뀌지만, 한 번에 하나만 끈다.
// ② **잡는 자리와 보이는 굵기를 나눈다.** 보이는 링은 얇아야 팔이 안 가려지고, 잡는 링은
//    두꺼워야 손가락으로 잡힌다. 투명(`opacity: 0`)한 두꺼운 링을 겹쳐 둔다 —
//    `visible = false` 로 두면 three 가 레이캐스트에서 **건너뛴다**.
// ③ **한계를 넘겨 끌면 화면이 말한다.** `urdf-loader` 는 말없이 자른다 — 그래서 300 을 적어
//    놓고 175 를 보면서 300 인 줄 알았다 (2026-08-04 · `limits.js` 주석).

import * as THREE from 'three';
import { JOINTS, clampJoint, JOINT_LIMITS_DEG } from '../../data/motion/limits.js';

const DEG = Math.PI / 180;
const Z = new THREE.Vector3(0, 0, 1);

// 링 반지름(m). **끝으로 갈수록 작아진다** — 팔이 그렇게 생겼기 때문이다.
//
// 처음엔 반대로 키웠는데(j1 이 제일 작고 j6 가 제일 큼) **손목에서 링 셋이 겹쳤다** —
// j4·j5·j6 는 원점이 서로 몇 cm 안이라, 큰 링을 주면 서로를 덮어 j6 를 겨눠도 j4 가 잡힌다
// (2026-08-04 실측). 굵기도 반지름에 비례시켜 작은 링이 큰 잡기 영역을 안 갖게 한다.
const R = [0.19, 0.165, 0.14, 0.115, 0.092, 0.07];
const TUBE = 0.03;         // 보이는 굵기 = 반지름 × 이 값
const GRAB = 0.16;         // 잡는 굵기 = 반지름 × 이 값 (투명)

/**
 * @param {object} o
 * @param {THREE.WebGLRenderer} o.renderer 포인터 좌표를 캔버스 기준으로 바꿀 때 쓴다
 * @param {THREE.Camera} o.camera
 */
export function createJointGizmo({ renderer, camera }) {
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  const plane = new THREE.Plane();
  const hit = new THREE.Vector3();
  const root = new THREE.Group();
  root.name = 'jointGizmo';

  const mat = new THREE.MeshBasicMaterial({ color: 0x2f6f8f, transparent: true, opacity: 0.85, depthTest: false });
  const matHot = new THREE.MeshBasicMaterial({ color: 0xe08a2b, transparent: true, opacity: 0.95, depthTest: false });
  const matGrab = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

  let robot = null;
  let rings = [];          // { joint, ring, grab }
  let drag = null;         // { joint, u, v, center, a0, start }
  let hot = null;

  const geos = [];
  const track = (g) => { geos.push(g); return g; };

  /** 팔 하나에 붙인다. 다시 부르면 앞의 것을 뗀다. */
  function attach(r) {
    detach();
    if (!r?.joints) return;
    robot = r;
    rings = JOINTS.map((name, i) => {
      const j = robot.joints[name];
      if (!j) return null;
      const r = R[i] ?? 0.1;
      const q = new THREE.Quaternion().setFromUnitVectors(Z, j.axis.clone().normalize());
      const ring = new THREE.Mesh(track(new THREE.TorusGeometry(r, r * TUBE, 8, 48)), mat);
      const grab = new THREE.Mesh(track(new THREE.TorusGeometry(r, r * GRAB, 6, 32)), matGrab);
      for (const m of [ring, grab]) {
        m.quaternion.copy(q);
        m.renderOrder = 999;              // 팔에 안 가린다 — 잡을 것이 보여야 잡는다
        m.userData.joint = name;
        j.add(m);
      }
      ring.raycast = () => {};            // **잡는 것은 두꺼운 쪽 하나뿐이다**
      return { joint: name, ring, grab, j };
    }).filter(Boolean);
  }

  function detach() {
    for (const r of rings) { r.ring.removeFromParent(); r.grab.removeFromParent(); }
    rings = [];
    robot = null;
    drag = null;
    hot = null;
  }

  function toPtr(clientX, clientY) {
    const b = renderer.domElement.getBoundingClientRect();
    ptr.x = ((clientX - b.left) / b.width) * 2 - 1;
    ptr.y = -((clientY - b.top) / b.height) * 2 + 1;
    return b;
  }

  function ringAt(clientX, clientY) {
    if (!rings.length) return null;
    toPtr(clientX, clientY);
    ray.setFromCamera(ptr, camera);
    const hits = ray.intersectObjects(rings.map((r) => r.grab), false);
    return hits.length ? rings.find((r) => r.grab === hits[0].object) : null;
  }

  /** 링 위에 있나 — 화면이 커서를 바꾸고, 궤도를 막을지 정한다. */
  function hover(clientX, clientY) {
    const r = drag ? rings.find((x) => x.joint === drag.joint) : ringAt(clientX, clientY);
    if (hot === r) return Boolean(r);
    if (hot) hot.ring.material = mat;
    hot = r;
    if (hot) hot.ring.material = matHot;
    return Boolean(r);
  }

  /** 각도를 재는 평면과 기준 벡터를 잡는다. **끄는 동안 다시 안 잡는다** (주석 ①). */
  function frameOf(r) {
    const axis = r.j.axis.clone().normalize().applyQuaternion(
      r.j.parent.getWorldQuaternion(new THREE.Quaternion()),
    ).normalize();
    const center = r.j.getWorldPosition(new THREE.Vector3());
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(u.dot(axis)) > 0.9) u.set(0, 1, 0);
    u.crossVectors(axis, u).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u).normalize();
    return { axis, center, u, v };
  }

  function angleAt(f, clientX, clientY) {
    toPtr(clientX, clientY);
    ray.setFromCamera(ptr, camera);
    plane.setFromNormalAndCoplanarPoint(f.axis, f.center);
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    const d = hit.clone().sub(f.center);
    return Math.atan2(d.dot(f.v), d.dot(f.u)) / DEG;
  }

  /** 링을 잡았으면 true. 화면은 이때 궤도를 막고 이벤트를 삼킨다. */
  function begin(clientX, clientY) {
    const r = ringAt(clientX, clientY);
    if (!r) return false;
    const f = frameOf(r);
    const a0 = angleAt(f, clientX, clientY);
    if (a0 == null) return false;
    drag = { joint: r.joint, f, a0, start: (r.j.angle ?? 0) / DEG, moved: false };
    hover(clientX, clientY);
    return true;
  }

  /**
   * @returns {null | { joint, deg, clampedTo }} 바뀐 값. `clampedTo` 가 있으면 한계에 걸렸다 —
   *   **화면이 그 사실을 말해야 한다.** 조용히 자르면 사람이 300 을 적고 175 를 본다.
   */
  function move(clientX, clientY) {
    if (!drag) return null;
    const a = angleAt(drag.f, clientX, clientY);
    if (a == null) return null;
    // 짧은 쪽으로 — 링을 한 바퀴 넘겨 끌 때 값이 튀지 않는다
    let d = ((a - drag.a0 + 540) % 360) - 180;
    const want = drag.start + d;
    const got = clampJoint(drag.joint, want);
    drag.moved = true;
    return { joint: drag.joint, deg: got, clampedTo: Math.abs(got - want) > 0.01 ? got : null };
  }

  function end() {
    const d = drag;
    drag = null;
    return d ? { joint: d.joint, moved: d.moved } : null;
  }

  return {
    root,
    attach,
    detach,
    hover,
    begin,
    move,
    end,
    isDragging: () => Boolean(drag),
    /** 지금 붙어 있는 관절 이름들 — 검증이 링 개수를 센다 */
    joints: () => rings.map((r) => r.joint),
    limits: JOINT_LIMITS_DEG,
    dispose() {
      detach();
      for (const g of geos) g.dispose();
      geos.length = 0;
      mat.dispose(); matHot.dispose(); matGrab.dispose();
    },
  };
}
