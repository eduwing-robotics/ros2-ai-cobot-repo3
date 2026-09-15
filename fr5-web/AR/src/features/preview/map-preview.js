// 고르기 **전에** 무엇을 얹게 되는지 보여주는 회전 미리보기 — DOM 한 칸과 맵 하나만 받는다.
//
// 화면(`screens/xr.js`)에서 떼어낸 기준은 `place.js` 와 같다: **게이트가 폰 없이 판정할 수
// 있는가.** 이건 XR 결합이 0이라 PC 헤드리스에서 그대로 돌고, `xr-web-verify.mjs` 가 이미
// 각속도를 재고 있다. 반대로 `startAR` 은 떼어내도 게이트가 못 보므로 화면에 남겨 뒀다.
//
// 팔 URDF 는 안 받는다 — 대당 6MB 이고, 여기서 필요한 건 "무슨 방이고 뭐가 어디 있나" 지
// 로봇의 생김새가 아니다.

import * as THREE from 'three';
import { createLayoutView } from '@fr5/shared/view3d/lab/layout-view.js';
import { createStage } from '@fr5/shared/view3d/lab/stage.js';

/** 한 바퀴 ≈ 65초. 읽는 걸 방해하지 않는 속도 */
const SPIN = 0.0016;

/**
 * @param {object}      o
 * @param {HTMLElement} o.host   미리보기를 채울 칸
 * @param {HTMLElement} o.sheet  아래를 덮는 바텀시트. 높이만큼 프레이밍을 좁힌다
 * @param {object}      o.layout `buildPreset(...)` 결과
 * @returns {{dispose:() => void}}
 */
export function createMapPreview({ host, sheet, layout }) {
  const stage = createStage(host, { background: 0x181b20, controls: false });
  const view = createLayoutView(layout);
  stage.scene.add(view.root);

  // **바운딩 구로 거리를 잡는다.** AABB 로 잡으면 도는 동안 긴 변이 옆으로 누워 잘린다.
  const sph = new THREE.Box3().setFromObject(view.root).getBoundingSphere(new THREE.Sphere());

  // **시트가 덮는 비율.** 매 프레임 `getBoundingClientRect` 를 부르면 레이아웃이 강제로
  // 다시 계산된다 — 렌더 루프 안에서 이건 폰에서 비싸다. 바뀔 때만 다시 잰다.
  let seenFrac = 0.6;
  const measure = () => {
    seenFrac = Math.max(0.35, 1 - sheet.getBoundingClientRect().height / innerHeight);
  };
  const ro = new ResizeObserver(measure);
  ro.observe(sheet);
  measure();

  let a = Math.PI * 0.25;
  stage.onTick(() => {
    a += SPIN;
    // **시트가 아래를 덮는다.** 화면 한가운데에 맞추면 맵의 절반이 시트 밑으로 들어간다
    // (첫 실렌더가 그랬다). 안 가려지는 세로 비율만큼 좁혀 맞추고, 그만큼 위로 올린다.
    const seen = seenFrac;
    const tv = Math.tan((stage.camera.fov * Math.PI) / 360);
    const d = (sph.radius / Math.min(tv * seen, tv * stage.camera.aspect)) * 1.05;
    stage.camera.position.set(
      sph.center.x + d * 0.86 * Math.cos(a),
      sph.center.y + d * 0.5,
      sph.center.z + d * 0.86 * Math.sin(a),
    );
    stage.camera.lookAt(sph.center.x, sph.center.y - (1 - seen) * d * tv, sph.center.z);
    // 카메라 쪽 벽을 숨겨 안이 보인다 — 이 화면이 `updateCutaway` 를 처음 쓴다
    view.updateCutaway(stage.camera);
  });

  return {
    dispose() {
      ro.disconnect();
      view.dispose?.();
      stage.dispose();
    },
  };
}
