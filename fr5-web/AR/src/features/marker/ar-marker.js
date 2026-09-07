// AR.js 초기화 — 마커 위에 물체를 올린다.
//
// 정답지는 AR.js 저장소의 `three.js/examples/default.html` 이다.
// **`minimal_ES6.html`·`basic.html` 을 베끼면 안 된다** — 그쪽은
// `changeMatrixMode: 'cameraTransformMatrix'` 로 카메라를 움직이는 방식이라
// 마커 위에 물체가 서지 않는다.
//
// 마커는 패턴이 아니라 **바코드 3x3 Hamming(6,3)** 이다 (STACK.md §마커, DECISION-LOG D10).

import * as THREE from 'three';
import {
  ArToolkitProfile, ArToolkitSource, ArToolkitContext, ArMarkerControls, ArSmoothedControls,
} from '../../external/ar-threex.mjs';
// 'threex' 라는 bare 지정자는 importmap 이 만들던 것이다. Vite 에서는 파일 경로로 직접 쓴다 —
// npm 레지스트리에 이 ESM 빌드가 없어서 vendor 로 남긴다 (archive/evidence-2026-07/2026-07-30/vite-gate.md).

/**
 * 스무딩 세기. 깜빡임(마커를 순간적으로 놓쳐 물체가 사라지는 것)을 줄이는 값들.
 *
 * **`minVisibleDelay` 는 전부 0 이다.** 이 값이 0 보다 크면 마커가 그 시간만큼
 * **연속으로** 잡혀야 물체가 뜨는데, 검출이 띄엄띄엄하면 조건이 영원히 안 차서
 * **아무것도 안 뜬다.** 실제로 0.05 를 넣었다가 로봇이 통째로 안 나오는 일을 겪었다.
 * 0 이면 잡히는 순간 바로 뜨므로, 스무딩을 켜도 "안 뜨는" 위험이 없다.
 *
 * 깜빡임에 듣는 값은 `minUnvisibleDelay` — **놓쳐도 유지하는 초** 다.
 * lerp* 는 목표를 따라가는 비율 (낮을수록 부드럽고 반응이 늦다).
 */
export const SMOOTHING = {
  없음: null,
  약: { lerpPosition: 0.7, lerpQuaternion: 0.4, lerpScale: 0.7, minVisibleDelay: 0, minUnvisibleDelay: 0.25 },
  중: { lerpPosition: 0.4, lerpQuaternion: 0.2, lerpScale: 0.4, minVisibleDelay: 0, minUnvisibleDelay: 0.6 },
  강: { lerpPosition: 0.22, lerpQuaternion: 0.12, lerpScale: 0.22, minVisibleDelay: 0, minUnvisibleDelay: 1.2 },
};

/**
 * 카메라 영상 위에 마커를 찾아 좌표계를 세운다.
 *
 * **원시 추적과 표시를 분리한다.** `ArMarkerControls` 가 잡는 값은 프레임마다 튀고,
 * 한 프레임만 놓쳐도 물체가 사라져 깜빡인다. 그래서 눈에 보이는 것은
 * `ArSmoothedControls` 로 감싼 쪽에 붙이고, 원시 쪽은 그것을 따라가게만 쓴다.
 *
 * @returns {{ markerRoot: THREE.Group, markerRaw: THREE.Group, camera: THREE.Camera,
 *             update: Function, onResize: Function, ready: () => boolean,
 *             setSmoothing: Function, stats: () => object }}
 */
export function initAR({
  renderer, scene, markerRoot, cameraParametersUrl, barcodeValue, onStatus,
  smoothing = '없음',      // 기본은 변경 이전 동작. 켜는 것은 ⚙ 에서 사람이 고른다
  detectCanvasWidth = 0,   // 0 이면 AR.js 자동(폰에서 320). 아래 §검출 해상도 참조
  sourceWidth = 0,         // 0 이면 AR.js 기본(640×480). 아래 §카메라 영상 크기
}) {
  ArToolkitContext.baseURL = './';

  // PerspectiveCamera 가 아니다. AR.js 가 투영행렬을 직접 넣는다.
  const camera = new THREE.Camera();
  scene.add(camera);

  // markerRoot 는 바깥에서 만들어 넘긴다 — AR 을 켜기 전에 이미 자식(로봇·궤적)이
  // 붙어 있어야 하기 때문이다. 없으면 여기서 만든다.
  if (!markerRoot) {
    markerRoot = new THREE.Group();
    scene.add(markerRoot);
  }

  // 원시 추적 대상. **화면에 보이지 않는다** — 여기에 물체를 붙이면 깜빡인다.
  const markerRaw = new THREE.Group();
  markerRaw.visible = false;
  scene.add(markerRaw);

  let smoothed = null;
  function setSmoothing(level) {
    const p = SMOOTHING[level];
    if (!p) { smoothed = null; return level; }
    smoothed = new ArSmoothedControls(markerRoot, p);
    return level;
  }
  setSmoothing(smoothing);

  const profile = new ArToolkitProfile();
  profile.sourceWebcam();

  // **카메라에 얼마나 큰 영상을 달라고 하나.** AR.js 기본은 640×480 이다 —
  // 요즘 폰이 1080p 를 주는데 그 절반도 안 받고 있었다.
  // 검출 한계가 픽셀 수라서 이 값이 곧 검출 거리다. `cv`(검출 캔버스)보다 앞선다 —
  // 소스가 작으면 캔버스를 키워도 없는 정보를 만들어내지 못한다.
  if (sourceWidth) {
    profile.sourceParameters.sourceWidth = sourceWidth;
    profile.sourceParameters.sourceHeight = Math.round((sourceWidth * 3) / 4);
  }

  // 기본값이 '../data/data/camera_para.dat' 라 우리 배치와 다르다. 명시한다.
  profile.contextParameters.cameraParametersUrl = cameraParametersUrl;
  // 바코드를 읽으려면 mono 만으로는 안 된다.
  profile.contextParameters.detectionMode = 'mono_and_matrix';
  profile.contextParameters.matrixCodeType = '3x3_HAMMING63';
  // patternRatio 는 기본 0.5 그대로 둔다 — 인쇄물의 테두리 비율(25% × 2)과 맞아야 한다.

  // **검출 해상도.** ArToolkitProfile 이 폰을 감지하면 `phone-normal`(320×240)을 고른다.
  // 카메라가 480×640 을 주는데 검출은 그 절반만 보는 것이다 —
  // 검출 한계는 "마커가 **검출 캔버스에서** 24px" 이라 이 값이 곧 검출 거리다.
  //
  // 2026-07-31 실측: 320 에서 80mm 마커가 1m 에서 인식률 61~96% 로 출렁였다.
  // 계산상 320 의 한계가 `0.087 × 거리(mm)` = 1m 에 87mm 라 정확히 경계였다.
  // 같은 판에서 fps 는 54 였다 — `AR-DEBUG` 위험선 15 의 3.6배다. 올릴 여유가 있다.
  //
  // **올리면 픽셀이 4배라 fps 를 먹는다.** 그래서 붙박이로 박지 않고 URL 로 뺀다 —
  // 대가를 못 재고 넘어가면 폰이 느려졌을 때 원인을 못 찾는다 (`?cv=` · AR-DEBUG §2).
  if (detectCanvasWidth) {
    profile.contextParameters.canvasWidth = detectCanvasWidth;
    profile.contextParameters.canvasHeight = Math.round((detectCanvasWidth * 3) / 4);
  }

  const source = new ArToolkitSource(profile.sourceParameters);
  let context = null;
  let markerControls = null;

  function onResize() {
    if (!source.ready) return;
    source.onResizeElement();
    source.copyElementSizeTo(renderer.domElement);
    // arController 캔버스까지 맞춰야 폰을 돌렸을 때 정합이 안 깨진다.
    if (context?.arController) source.copyElementSizeTo(context.arController.canvas);
  }

  /** iOS 는 세로/가로에 따라 소스 방향이 달라진다. 예제의 분기를 그대로 쓴다. */
  function sourceOrientation() {
    const el = source.domElement;
    return el.videoWidth > el.videoHeight ? 'landscape' : 'portrait';
  }

  function initContext() {
    context = new ArToolkitContext(profile.contextParameters);
    context.init(() => {
      camera.projectionMatrix.copy(context.getProjectionMatrix());
      const o = sourceOrientation();
      context.arController.orientation = o;
      context.arController.options.orientation = o;
      onStatus?.(`카메라 ${source.domElement.videoWidth}×${source.domElement.videoHeight} · ${o}`);
      onResize();
    });

    // **markerRaw 에 붙인다.** markerRoot(보이는 쪽)에 붙이면 스무딩이 무의미해진다.
    markerControls = new ArMarkerControls(context, markerRaw, {
      type: 'barcode',
      barcodeValue,
      smooth: true,       // 라이브러리 자체의 떨림 완화 (최근 5프레임)
      smoothCount: 5,
      smoothTolerance: 0.01,
      smoothThreshold: 2,
    });
  }

  source.init(
    () => {
      // canplay 전에 context 를 만들면 영상 크기를 몰라 방향 판단이 틀린다.
      source.domElement.addEventListener('canplay', initContext, { once: true });
      onResize();
    },
    (err) => onStatus?.(`카메라를 열 수 없다: ${err?.name ?? err}`),
  );

  addEventListener('resize', onResize);

  // --- 진단 수치. **폰에서는 콘솔을 못 본다.** 화면에 띄울 숫자를 여기서 모은다.
  //
  // `인식률` 하나로는 못 보는 것이 셋 있어서 같이 잰다 —
  //   기울기  평면 마커는 비스듬히 볼수록 유효 크기가 sin(각) 으로 깎인다.
  //           눕힌 마커를 서서 보면 2m 에서 약 34°, 즉 유효 크기가 **56%** 가 된다.
  //   회전급변 평면 사각형 하나로 자세를 풀면 **수학적으로 유효한 해가 둘**이다
  //           (pose ambiguity). 둘 사이를 오가면 로봇이 홱 뒤집힌다.
  //           한 프레임에 30° 넘게 도는 것은 물리적으로 불가능하다 — 그게 신호다.
  //   최장끊김 인식률 70% 가 "고르게 30% 놓침" 인지 "3초 붙고 3초 끊김" 인지
  //           완전히 다르다. 시연에서 아픈 것은 후자다.
  const diag = {
    frames: 0, hits: 0, losses: 0, lastSeenAt: 0, fps: 0,
    missStartAt: 0, maxMissMs: 0, tiltDeg: null, spinMaxDeg: 0,
  };
  let fpsFrames = 0;
  let fpsAt = performance.now();
  let wasRawVisible = false;
  const tmp = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const prevQuat = new THREE.Quaternion();
  let hasPrevQuat = false;

  /** 마커 한 변이 **검출 캔버스에서** 몇 픽셀인가.
   *
   * "24px 이 한계" 는 합성 이미지로 얻은 값이다 (archive/evidence-2026-07/2026-07-30/marker-detect.md).
   * 그동안은 크기와 거리로 **추정**했는데, 이 값은 그 임계를 실기에서 직접 잰다.
   * 인식률이 무너지는 지점의 픽셀 수 — 그게 우리가 진짜 알고 싶은 하나다.
   */
  function markerPx() {
    const cv = context?.arController?.canvas;
    if (!cv || !markerRaw.visible) return null;
    markerRaw.updateMatrixWorld();
    pA.set(-0.5, 0, 0).applyMatrix4(markerRaw.matrixWorld).project(camera);
    pB.set(0.5, 0, 0).applyMatrix4(markerRaw.matrixWorld).project(camera);
    return Math.round(Math.hypot(
      ((pB.x - pA.x) * cv.width) / 2,
      ((pB.y - pA.y) * cv.height) / 2,
    ));
  }

  return {
    markerRoot,   // 보이는 쪽 (스무딩됨) — 물체를 여기에 붙인다
    markerRaw,    // 원시 추적 — 진단용
    camera,
    ready: () => Boolean(context && source.ready),
    visible: () => markerRoot.visible,
    setSmoothing,

    update() {
      if (!context || !source.ready) return;
      context.update(source.domElement);

      diag.frames += 1;
      const tNow = performance.now();
      if (markerRaw.visible) {
        diag.hits += 1;
        diag.lastSeenAt = tNow;
        // 끊겨 있다가 돌아왔다 — 그 끊김이 지금까지 중 제일 길었는지 본다
        if (diag.missStartAt) {
          diag.maxMissMs = Math.max(diag.maxMissMs, tNow - diag.missStartAt);
          diag.missStartAt = 0;
        }

        // 기울기 — 마커 법선(면에서 수직으로 나오는 축)이 카메라를 얼마나 비껴 보나.
        // 0° 면 정면, 클수록 비스듬하다. 카메라는 원점에 고정이고 마커가 움직인다.
        //
        // **예각으로 접는다.** 법선의 부호는 규약 문제다 — ARToolKit 의 마커 Z 가
        // 보는 쪽인지 반대쪽인지에 따라 같은 자세가 57° 로도 123° 로도 나온다.
        // 실제로 처음엔 123° 가 찍혔다. 마커가 보이는데 법선이 뒤를 향할 수는 없다.
        // 우리가 알고 싶은 것은 "얼마나 비스듬한가" 하나뿐이라 크기만 남긴다.
        nrm.set(0, 0, 1).applyQuaternion(markerRaw.quaternion);
        toCam.copy(markerRaw.position).normalize().negate();
        const raw = THREE.MathUtils.radToDeg(
          Math.acos(THREE.MathUtils.clamp(nrm.dot(toCam), -1, 1)),
        );
        diag.tiltDeg = Math.round(Math.min(raw, 180 - raw));

        // 프레임 간 회전. **최댓값을 들고 있는다** — 뒤집힘은 평균이 아니라 튐이라
        // 평균을 내면 사라진다. stats() 가 읽어갈 때 0 으로 되돌린다.
        if (hasPrevQuat) {
          diag.spinMaxDeg = Math.max(
            diag.spinMaxDeg,
            Math.round(THREE.MathUtils.radToDeg(prevQuat.angleTo(markerRaw.quaternion))),
          );
        }
        prevQuat.copy(markerRaw.quaternion);
        hasPrevQuat = true;
      } else {
        if (wasRawVisible) diag.losses += 1;   // 잡고 있다가 놓친 횟수 = 깜빡임의 원인 지표
        if (!diag.missStartAt && diag.hits > 0) diag.missStartAt = tNow;
        hasPrevQuat = false;   // 끊긴 앞뒤를 이어 재면 거짓 급변이 찍힌다
      }
      wasRawVisible = markerRaw.visible;

      if (smoothed) smoothed.update(markerRaw);
      else markerRoot.visible = markerRaw.visible;
      if (markerRaw.visible && !smoothed) {
        markerRoot.position.copy(markerRaw.position);
        markerRoot.quaternion.copy(markerRaw.quaternion);
        markerRoot.scale.copy(markerRaw.scale);
      }

      fpsFrames += 1;
      const now = performance.now();
      if (now - fpsAt >= 1000) {
        diag.fps = Math.round((fpsFrames * 1000) / (now - fpsAt));
        fpsFrames = 0;
        fpsAt = now;
      }
    },

    /**
     * @param markerSizeMm 인쇄물 실측 크기. 거리를 실단위로 환산하는 데 쓴다.
     *
     * 마커 좌표계는 **마커 한 변 = 1 단위**다. 그래서 카메라(원점)에서
     * markerRaw 까지의 거리 × 마커 실측 크기 = 실제 거리다.
     * 이 값이 "몇 m까지 인식되나"를 현장에서 재는 유일한 방법이다.
     */
    stats(markerSizeMm) {
      const seen = markerRaw.visible;
      const distM = seen ? markerRaw.getWorldPosition(tmp).length() * (markerSizeMm / 1000) : null;
      const spin = diag.spinMaxDeg;
      diag.spinMaxDeg = 0;   // 읽어간 창(窓)의 최댓값이다. 읽을 때마다 비운다
      return {
        fps: diag.fps,
        인식률: diag.frames ? Math.round((diag.hits / diag.frames) * 100) : 0,
        놓침: diag.losses,
        프레임: diag.frames,
        보임: seen,
        표시중: markerRoot.visible,   // 스무딩 덕에 놓쳐도 잠시 true 로 남는다
        거리m: distM === null ? null : +distM.toFixed(2),
        마커px: markerPx(),          // 검출 캔버스에서 마커 한 변 — 24px 임계의 실측판
        기울기도: seen ? diag.tiltDeg : null,
        회전급변도: spin,             // 30° 넘으면 자세가 뒤집힌 것이다
        최장끊김ms: Math.round(diag.maxMissMs),
        카메라: source.domElement ? [source.domElement.videoWidth, source.domElement.videoHeight] : null,
        캔버스: context?.arController ? [context.arController.canvas.width, context.arController.canvas.height] : null,
      };
    },
    // 위치를 바꾸면 여기서 끊는다. **누적값을 전부 비운다** — 하나라도 남기면
    // 이전 거리의 성적이 다음 구간에 섞인다 (report-diag.py 가 이 지점으로 구간을 가른다).
    resetStats() {
      diag.frames = 0; diag.hits = 0; diag.losses = 0;
      diag.maxMissMs = 0; diag.missStartAt = 0; diag.spinMaxDeg = 0;
    },
    onResize,

    // 카메라 영상 엘리먼트. 녹화가 이것과 WebGL 캔버스를 합친다 (features/record/).
    // `#arjs-video` 를 직접 찾지 않는 이유 — 그 id 는 AR.js 내부 규약이라 우리 계약이 아니다.
    video: () => source.domElement ?? null,
  };
}
