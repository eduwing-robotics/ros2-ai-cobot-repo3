// 프레임 축 — **좌표계를 눈에 보이게 한다. 조작 도구가 아니다.**
//
// 회전 기즈모(`lab/joint-gizmo.js`)는 잡고 돌리는 물건이다. 이건 반대다 — 아무것도 안 잡고,
// 링크마다 **자기 좌표계의 XYZ 를 100mm 자로** 세워 보여준다. 규약은 `SHARED-CORE.md` §2.
//
// 왜 필요한가 — 트윈에는 좌표계가 **넷** 겹쳐 있다 (저장 지점 mm·° / URDF m·rad Z-up /
// three.js Y-up / AR 마커 한 변=1). 변환이 틀리면 **에러도 안 나고 그럴싸한 그림**이 나온다.
// 잡으려는 것 셋:
//   ① **그리퍼 장착 회전** — `gripper-mount.json` 이 스스로 「+90 이고 −90 은 반대 방향」이라 적었다
//   ② **AR 겹침 오차의 출처** — 루트부터 어긋났나(마커) vs 팔 중간부터 벌어지나(관절 부호·축)
//   ③ **1000배 스케일 사고** — 축이 100mm 고정이라 **축이 팔보다 크면** 그 사고다 (`robot.js` 함정 ②)
//
// ⚠ **끌 수 있게 만들지 않는다.** 로봇은 관절만 움직인다. 파츠를 XYZ 로 옮기면 실기에 없는
//    자세가 만들어져 트윈이 거짓말을 시작한다 — 레이캐스트도 포인터 핸들러도 없다.
// ⚠ **`depthTest` 를 끄지 않으면 기능이 아니라 장식이다.** 링크 원점은 보통 금속 껍데기 **안**이라
//    깊이 검사를 켜 두면 축이 통째로 묻힌다.
//
// 색은 three 기본 규약 — **빨강 X · 초록 Y · 파랑 Z**.

import * as THREE from 'three';
import { mm } from '../data/units/units.js';

/** 축 길이. **자를 겸하므로 바꾸지 않는다** — 이 길이가 판정 기준이다 (SHARED-CORE §2). */
export const AXES_LEN_MM = 100;

/**
 * 링크·그리퍼마다 축을 켤 수 있는 표시기를 만든다. **켜기 전에는 아무것도 만들지 않는다.**
 *
 * @param {{ robot: object, gripperGroup?: object|null }} arg
 *   `robot` 은 `loadRobot()` 이 준 URDF 로봇 (`links` 를 들고 있다),
 *   `gripperGroup` 은 같은 함수가 준 그리퍼 홀더 — URDF 에 없는 파츠라 이름을 따로 붙인다.
 * @returns {{ names: string[], show: (sel: string|string[]|null) => string[],
 *             shown: () => string[], dispose: () => void }}
 */
export function createFrameAxes({ robot, gripperGroup = null }) {
  // 이름 → 축을 붙일 Object3D. URDF 링크가 정본이고, 그리퍼만 우리가 더한다.
  //
  // ⚠ **이름이 `gripper` 가 아니라 `gripper-mount-origin` 인 이유** (2026-08-11 실측).
  //    그 그룹의 원점은 **물리적 프레임이 아니라 장부상의 점**이고, 그리퍼가 그려지는 자리에서
  //    **Y 로 326mm 떨어진 허공**에 있다 — 그룹이 `positionMm[1] = -325.64` 만큼 물러나 있고
  //    STL 정점이 자기 안에 +326 을 품어 그것을 상쇄한다. 렌더는 정상이다.
  //    **방향(회전)은 이 축으로 봐도 맞다** — `rotationDeg` 가 걸리는 곳이 바로 이 그룹이다.
  //    **위치는 보지 마라.** `gripper` 라고 부르면 「툴 프레임이 저기 있다」로 읽혀
  //    없는 결함을 만들어낸다.
  //
  // ⚠ **TCP 는 「없는」 게 아니다** (2026-08-11 실측 · 앞선 서술 정정). D108 이 핑거 끝
  //    (플랜지 +135mm)으로 정했고 **트윈 형상이 그 자리를 오차 0.0mm 로 재현한다.** 없는 것은
  //    **그 점에 세운 노드 하나**뿐이다. 세울 자리는 **그룹 지역좌표 `(0, 0.06302, -0.32564)` m** —
  //    공구축은 local **+Y** 이고 `wrist3_link`(−171) → 플랜지(−72) → 손끝(+63) 순이다(mm).
  //    설정의 `depthCam.tcpYMm = 63.02` 가 바로 그 값이다. 자세를 바꿔도 불변임을 확인했다.
  //    ⚠ 이 mm 값을 **그룹에 그대로 넣으면 325미터로 튄다** — 그룹은 미터이고 `meshScale 0.001`
  //    은 메시에 걸려 있다. 상세는 `docs/evidence/2026-08-11/twin-frame-axes.md`.
  const hosts = new Map(Object.entries(robot?.links ?? {}));
  if (gripperGroup) hosts.set('gripper-mount-origin', gripperGroup);
  // TCP — `robot.js` 가 조립좌표계에 세워 둔 빈 노드. **여기서 좌표를 계산하지 않는다.**
  const tcp = gripperGroup?.getObjectByName?.('tcp');
  if (tcp) hosts.set('tcp', tcp);
  // 사용자 좌표계 — 화면이 실기 `coordDefs.user` 로 세워 둔 빈 노드다(있을 때만).
  // **설정이 아니라 실기에서 흐르는 값**이라 여기서 만들지 않고 이름으로 집어 온다.
  const user = robot?.getObjectByName?.('user1');
  if (user) hosts.set('user1', user);

  const made = new Map();          // 이름 → AxesHelper (처음 켤 때 만든다)
  const on = new Set();            // 지금 켜져 있는 이름

  const build = (host) => {
    const ax = new THREE.AxesHelper(mm(AXES_LEN_MM));
    ax.material.depthTest = false;   // 껍데기 안에 묻히지 않게 위에 겹쳐 그린다 (위 ⚠)
    ax.material.transparent = true;
    ax.renderOrder = 999;
    // ⚠ **부모의 스케일을 되돌린다 — 안 하면 자가 자가 아니게 된다.** `tcp` 는 조립좌표계
    //    (`gripperMeshes`, scale 0.001) 안에 살아서 그냥 붙이면 100mm 축이 **0.1mm** 로 그려진다.
    //    이 파일의 ⚠ 둘과 같은 부류의 함정이라 여기서 한 번에 막는다 (2026-08-11).
    host.updateWorldMatrix(true, false);
    const s = host.getWorldScale(new THREE.Vector3());
    const avg = (s.x + s.y + s.z) / 3;
    if (avg > 0 && Math.abs(avg - 1) > 1e-9) ax.scale.setScalar(1 / avg);
    host.add(ax);
    return ax;
  };

  /**
   * 축을 켠다. `null` 이면 전부 끄고, `'*'` 면 전부 켠다 (AR 오차 출처를 가를 때 체인이 필요하다).
   * **없는 이름은 조용히 무시한다** — 이름을 지어내지 않는다는 규칙을 여기서도 지킨다.
   */
  function show(sel) {
    const want = sel === '*' ? [...hosts.keys()]
      : sel == null ? []
        : (Array.isArray(sel) ? sel : [sel]).filter((n) => hosts.has(n));
    for (const name of on) if (!want.includes(name)) made.get(name).visible = false;
    on.clear();
    for (const name of want) {
      if (!made.has(name)) made.set(name, build(hosts.get(name)));
      made.get(name).visible = true;
      on.add(name);
    }
    return [...on];
  }

  function dispose() {
    for (const ax of made.values()) {
      ax.removeFromParent();
      ax.geometry.dispose();
      ax.material.dispose();
    }
    made.clear();
    on.clear();
  }

  return { names: [...hosts.keys()], show, shown: () => [...on], dispose };
}
