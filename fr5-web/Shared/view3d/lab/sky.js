// 절차적 IBL 하늘 — **HDR 파일을 받지 않는다.** 64×32 그라디언트를 코드로 만든다.
//
// 기법 출처: `pascalorg/editor` (MIT) `packages/viewer/src/components/viewer/scene-environment.tsx`.
// 값은 우리 용도(클린룸)에 맞게 바꿨다. 그쪽이 적어둔 이유가 핵심이었다 —
//
//   > 수직 색 분리 덕에 **위를 보는 면이 수직면보다 다르게** 읽힌다.
//   > 전부 같은 방향 없는 물빛이 되는 대신.
//
// 즉 환경맵이 밝기만 주는 게 아니라 **방향감**을 준다. three.js 의 `RoomEnvironment` 는
// 방 하나를 흉내내 이걸 어느 정도 하지만, 값을 못 바꾼다. 여기선 바꾼다.
//
// **클린룸용으로 고친 것** — 실험실은 창이 없고 **천장 LED 패널이 광원**이다.
// 그래서 하늘색(파랑)이 아니라 위를 **밝은 중성**으로, 아래를 **흰 바닥 반사**로 둔다.
// 파란 천정을 그대로 쓰면 스테인리스가 야외처럼 파랗게 뜬다.

import * as THREE from 'three';

// 선형 공간 값이다. sRGB 로 생각하면 안 된다.
const ZENITH  = [1.00, 1.00, 0.99];  // 천장 LED — 밝은 중성
const HORIZON = [0.72, 0.74, 0.76];  // 벽 — 살짝 차가운 회색
const GROUND  = [0.55, 0.55, 0.54];  // 흰 에폭시 바닥 반사

const W = 64;
const H = 32;

/** 환경맵으로 쓸 등장방형 텍스처를 만든다. 파일을 받지 않는다. */
export function buildLabSky() {
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    // 0행 = 천저(nadir), 마지막 행 = 천정(zenith)
    const lat = ((y + 0.5) / H) * 2 - 1;
    let r; let g; let b;
    if (lat <= 0) {
      // 지평선 아래 — 바닥 반사. 천저로 갈수록 조금 어둡다
      const k = 1 + lat * 0.3;
      [r, g, b] = GROUND.map((v) => v * k);
    } else {
      // pow < 1 이 지평선 띠를 넓힌다 — 벽 높이만큼 벽색이 지배하게
      const t = lat ** 0.6;
      r = HORIZON[0] + (ZENITH[0] - HORIZON[0]) * t;
      g = HORIZON[1] + (ZENITH[1] - HORIZON[1]) * t;
      b = HORIZON[2] + (ZENITH[2] - HORIZON[2]) * t;
    }
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 환경 세기. 너무 올리면 그림자가 채워져 **실내가 평평해진다.** */
export const ENV_INTENSITY = 0.65;
