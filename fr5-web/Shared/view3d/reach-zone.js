// 안전 범위 표시 — 도달거리를 원기둥 + 바닥 링으로 그린다.
//
// **AR 과 Dashboard 가 같이 쓴다.** AR 은 실물 바닥에 겹치고,
// 대시보드는 배치안에서 스테이션이 링 안인지 본다 (SHARED-CORE.md).
//
// 반환값은 **Z-up 좌표계**다 — URDF 안에 넣으라고 만든 것이다.
// three.js 화면에 세울 때는 부모에서 rotation.x = -PI/2 를 준다.

import * as THREE from 'three';

/** FR5 도달거리 (m). 스펙값이다 — 편집 대상이 아니다 (docs/ref/arch/STACK.md). */
export const FR5_REACH_M = 0.922;

/**
 * 도달 범위를 그린다.
 *
 * 벽처럼 진하게 그리면 **주인공인 로봇이 안 보인다.** 설득이 목적이므로
 * 면은 아주 옅게 두고 바닥 테두리를 진하게 둔다 — "여기까지 오지 마라"는
 * 바닥 선 하나로 읽힌다.
 */
export function makeReachZone({
  radius = FR5_REACH_M,
  height = 0.9,
  rimWidth = 0.02,
  color = 0xffb347,
} = {}) {
  const zone = new THREE.Group();
  zone.name = 'reachZone';

  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 48, 1, true),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  wall.rotation.x = Math.PI / 2; // 이 그룹 안은 Z-up 이다
  wall.position.z = height / 2;
  zone.add(wall);

  // 바닥 테두리 — 얇은 링을 눕혀서 쓴다. Line 은 굵기 조절이 안 된다.
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(radius - rimWidth, radius, 64),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  rim.position.z = 0.002; // 바닥과 겹쳐 깜빡이는 것을 막는다
  zone.add(rim);

  return zone;
}
