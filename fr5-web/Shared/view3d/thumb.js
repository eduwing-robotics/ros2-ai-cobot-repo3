// 부품 썸네일 — **파일이 아니라 코드로 굽는다.**
//
// 왜 파일이 아닌가 셋 —
//   ① `Shared/assets/` 는 `publicDir` 라 `dist` 에 통째 복사된다. 지금도 6.6MB 가 STL 이다
//   ② 부품 형태를 고치면 그림이 낡는다. 코드에서 구우면 **항상 지금 형태**다
//   ③ 부품이 절차적이라 구울 것이 이미 손에 있다
//
// 렌더러 하나를 공유하고 결과는 dataURL 로 캐시한다 — 부품 17종이면 굽는 것은 한 번뿐이다.
// **WebGL 컨텍스트는 브라우저당 개수 제한이 있다** (보통 16). 팔레트가 카드마다 캔버스를
// 만들면 그것만으로 한도를 넘긴다. 그래서 오프스크린 하나로 돌려 쓴다.

import * as THREE from 'three';
import { PROPS } from './parts.js';

const cache = new Map();
let R = null;

function renderer(size) {
  if (R) return R;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  R.setSize(size, size, false);
  R.setPixelRatio(1);
  return R;
}

/**
 * 부품 하나를 정면 3/4 로 구워 dataURL 로 돌려준다.
 *
 * 실패하면 `null` — **팔레트가 죽지 않는다.** WebGL 이 없는 환경(헤드리스 일부,
 * 소프트웨어 렌더 꺼진 브라우저)에서도 목록은 보여야 한다.
 */
export function thumbFor(type, opts = {}, size = 96) {
  const key = `${type}|${JSON.stringify(opts)}|${size}`;
  if (cache.has(key)) return cache.get(key);

  let url = null;
  try {
    const make = PROPS[type];
    if (!make) throw new Error(`모르는 부품: ${type}`);
    const obj = make(opts);

    const scene = new THREE.Scene();
    scene.add(obj);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8dde1, 1.4));
    const key1 = new THREE.DirectionalLight(0xffffff, 1.25);
    key1.position.set(-1, 2, 1.4);
    scene.add(key1);

    const bb = new THREE.Box3().setFromObject(obj);
    const c = bb.getCenter(new THREE.Vector3());
    const r = Math.max(...bb.getSize(new THREE.Vector3()).toArray()) || 1;
    const cam = new THREE.PerspectiveCamera(30, 1, r / 100, r * 20);
    cam.position.set(c.x - r * 1.05, c.y + r * 0.62, c.z + r * 1.5);
    cam.lookAt(c);

    const gl = renderer(size);
    gl.render(scene, cam);
    url = gl.domElement.toDataURL('image/png');

    // **한 장 굽고 바로 버린다.** 안 버리면 팔레트를 열 때마다 지오메트리가 쌓인다.
    scene.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
  } catch {
    url = null;
  }
  cache.set(key, url);
  return url;
}

/** 탭을 떠날 때 부른다 — 컨텍스트를 놓아주지 않으면 왕복하다 브라우저가 막는다. */
export function disposeThumbs() {
  R?.dispose?.();
  R = null;
  cache.clear();
}
