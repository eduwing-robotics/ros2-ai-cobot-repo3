// 무대 — 렌더러·카메라·조명·톤매핑. **"압도적 시각화" 의 8할이 여기다.**
//
// 에셋이 0바이트다. `RoomEnvironment` 는 three.js 에 내장돼 있어 다운로드가 없는데,
// 이것만 붙여도 스테인리스·흰 플라스틱이 산다 — 지금 로봇이 밋밋한 이유가 정확히 조명이다.
// 부족해지면 Poly Haven 실내 HDRI(CC0) 1~2K 로 갈아끼운다. `setEnvironment()` 한 곳만 바뀐다.
//
// **React 를 쓰지 않는다** (Shared/view3d 규약). Dashboard 는 이걸 ref 로 마운트한다.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildLabSky, ENV_INTENSITY } from './sky.js';
import { applyCalibToCamera } from '../global-cam.js';

/**
 * 무대를 만든다. 반환값의 `dispose()` 를 **반드시** 부른다 —
 * 탭을 왕복하면 WebGL 컨텍스트가 쌓여 브라우저가 막는다 (CONSOLE-REACT.md).
 */
// 배경은 UI 배경(#faf9f7)보다 **어둡게** 둔다. 흰 방을 흰 배경에 놓으면 경계가 사라진다.
/**
 * 무대를 만든다.
 *
 * 글로벌 카메라 화면은 배치안 뷰와 **셋이 반대**라 옵션으로 연다 (새 stage 를 만들면
 * 조명·톤매핑이 갈라져 두 화면 색이 달라진다):
 *   · `alpha`    배경 투명 — 뒤에 카메라 영상이 비쳐야 한다
 *   · `calib`    카메라를 캘리브레이션 값으로 **고정** — 화각·주점·포즈를 밖에서 주입
 *   · `controls` 궤도 조작 끄기 — 천장에 박힌 실카메라는 돌아가지 않는다
 */
export function createStage(host, {
  background = 0xd7dade, alpha = false, controls: useControls = true, calib = null,
} = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha });
  // 폰은 dpr 3 이 흔하다. 2 로만 잘라도 픽셀이 4배라 그림자 갱신이 눈에 띄게 느려진다.
// 좁은 화면에서는 1.5 로 더 자른다 — 흰색 모형이라 계단이 잘 안 보인다 (질감이 없다).
const _narrow = matchMedia?.('(max-width: 820px)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, _narrow ? 1.5 : 2));
  // 사진 같은 느낌은 톤매핑이 만든다. 선형으로 두면 밝은 곳이 하얗게 날아간다.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  // 접지감. 없으면 물체가 떠 보인다. **`PCFSoft` 는 three 0.185 에서 폐기됐다** —
  // 콘솔이 경고하고 어차피 `PCF` 로 대체해 그린다 (2026-08-06 실렌더에서 잡았다).
  renderer.shadowMap.type = THREE.PCFShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // 투명 배경은 `background = null` **과** clearAlpha 0 을 둘 다 해야 한다.
  // 하나만 하면 검은 화면이 깔려 영상이 안 보인다.
  if (alpha) renderer.setClearAlpha(0);
  else scene.background = new THREE.Color(background);

  // 환경광 — 반사·거칠기가 여기서 나온다. 조명 몇 개로는 이 느낌이 안 난다.
  // **파일을 받지 않는다.** 64×32 절차적 하늘을 코드로 만든다 (sky.js).
  // `RoomEnvironment` 보다 가볍고 **클린룸 색으로 조절된다** — 그게 바꾼 이유다.
  const sky = buildLabSky();
  scene.environment = sky;
  scene.environmentIntensity = ENV_INTENSITY;

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
  if (calib) applyCalibToCamera(camera, calib);

  const controls = useControls ? new OrbitControls(camera, renderer.domElement) : null;
  if (controls) {
    controls.enableDamping = true;     // 손맛. 이거 하나로 "잘 만든 것" 처럼 보인다
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49;  // 바닥 아래로 못 내려가게
  }

  // 주광 — 그림자를 만드는 유일한 빛. 환경광이 나머지를 채운다.
  // 주광 — 그림자를 만드는 유일한 빛. 환경광이 나머지를 채운다.
  //
  // 그림자 수치는 `pascalorg/editor`(MIT) 가 실측으로 정한 값을 가져왔다.
  // 그쪽 주석이 근거를 적어 뒀다 —
  //   · normalBias 0.3 은 그림자를 표면에서 30cm 띄워 **벽 그림자가 바닥에서 떨어져 보인다**
  //   · 0.07 이하는 1024 맵에서 얼룩(acne)이 남는다 → **0.08 이 얼룩 없는 최소값**
  //   · depth bias 는 그것만으로 부족해 -0.0005 를 같이 쓴다
  // **빛의 방향은 이 벡터 하나가 정한다.** 아래 `fitShadow` 가 광원과 표적을 같은 만큼
  // 옮기므로, 그림자 부피가 방으로 가도 조명은 한 톨도 안 바뀐다.
  const KEY_DIR = new THREE.Vector3(5, 8, 4);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.copy(KEY_DIR);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);   // 2048 은 이 규모에 낭비다
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.08;
  key.shadow.radius = 2;                // 부드러운 가장자리
  const c = key.shadow.camera;
  c.left = -6; c.right = 6; c.top = 6; c.bottom = -6; c.near = 0.5; c.far = 40;
  scene.add(key, key.target);

  /**
   * 그림자 부피를 **방에 맞춘다.** 방을 씬에 넣은 직후에 부른다.
   *
   * 위 기본값(±6 상자 · 원점)은 **방이 원점에 있다고 가정한다. 방은 원점에 없다.**
   * 조립 라인 프리셋은 6.75×12m 이고 중심이 (3.4, −6) 이라 그림자 카메라 중심에서
   * 6.9m 떨어져 있었다 — 반경 6m 상자에 방 반경 7m 가 들어갈 수 없어서
   * **방 대부분에 그림자가 아예 없었다.** 밋밋해 보이던 게 스타일이 아니라 이것이었다
   * (2026-08-07 실측 · `docs/evidence/2026-08-07/shadow-fit.md`).
   *
   * **조명은 안 바뀐다** — 광원과 표적을 같은 만큼 옮기므로 입사 방향이 보존된다.
   * 색·세기를 건드리지 않으니 화이트 모형 규약(D62)도 그대로다.
   */
  function fitShadow(object3d) {
    const box = new THREE.Box3().setFromObject(object3d);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const at = box.getCenter(new THREE.Vector3()).setY(0);
    // **빛이 비스듬히 들어온다.** 가로·세로 반쪽이 아니라 **바닥 대각 반경**이 필요하다 —
    // 정사영이 어느 축으로 눕든 대각선만큼은 늘 덮는다.
    const R = Math.hypot(size.x, size.z) / 2 + 0.5;
    key.target.position.copy(at);
    key.position.copy(at).add(KEY_DIR);
    c.left = -R; c.right = R; c.top = R; c.bottom = -R;
    // **`far` 도 같이 좁힌다.** 40 은 이 규모에 과했고, 깊이 범위가 넓으면 같은 맵에서
    // 정밀도가 떨어진다 — 넓히는 변경에 좁히는 변경이 딸려 오는 게 우연이 아니다.
    c.far = KEY_DIR.length() + R + size.y + 2;
    c.updateProjectionMatrix();
  }

  // **앰비언트를 올리지 않는다.** 그쪽 주석: "0.55 클램프가 주광의 45% 를 그림자에 새게 해
  // 실내가 평평해졌다". 채움은 환경맵이 한다 — 여기선 아주 약하게만 둔다.
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe8e9ea, 0.12));

  // ── 시점 맞추기.
  //
  // **가로·세로 화각을 둘 다 본다.** 전에는 `dist = r / tan(fov/2)` 로 세로 화각만 썼고,
  // three.js 의 `fov` 는 세로라서 **한 코드가 정반대 두 방향으로 틀렸다** — 가로 화면에선
  // 남고 세로 화면에선 넘쳤다. 2026-08-04 실측(`docs/evidence/2026-08-04/assembly-line.md`):
  //   1600×900  방이 화면의 13.6% (좌 34% · 우 36% 여백)
  //   900×1600  가로 140% — **양옆 40% 가 화면 밖으로 잘렸다**
  //
  // 그리고 `r = max(size.x, size.z)` 로 바닥의 가장 긴 축을 세로 화각에 예약했는데,
  // 45° 대각에서 보면 그 축은 화면에서 **대각선으로 눕는다.** 세로로 필요한 건 절반도
  // 안 되는데 통째로 비워 뒀다 — 낭비의 대부분이 여기였다.
  //
  // 지금은 **AABB 8모서리를 카메라 축으로 분해**해 두 화각을 동시에 만족하는 최소 거리를
  // 구한다. 짐작이 없어지므로 `pad` 는 손으로 고르는 값이 아니라 여유분(6%)일 뿐이다.
  const UP = new THREE.Vector3(0, 1, 0);
  let framed = null;   // 마지막으로 맞춘 대상 — 창 비율이 바뀌면 다시 잡는다

  function frameTo(object3d, { pitch = 0.42, pad = 1.06 } = {}) {
    if (calib) return;               // 실카메라 시점은 옮기는 게 아니다
    const box = new THREE.Box3().setFromObject(object3d);
    if (box.isEmpty()) return;
    framed = { object: object3d, opts: { pitch, pad } };

    // **정규화한다.** 전에는 `(0.75, pitch, 0.75)` 를 거리에 그대로 곱했는데
    // 이 벡터의 길이가 1.141 이라 계산한 거리보다 **늘 14% 뒤에** 섰다.
    const back = new THREE.Vector3(0.75, pitch, 0.75).normalize();
    const right = new THREE.Vector3().crossVectors(back, UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, back);
    const tv = Math.tan((camera.fov * Math.PI) / 360);
    const th = tv * camera.aspect;

    const corners = [];
    for (const X of [box.min.x, box.max.x]) {
      for (const Y of [box.min.y, box.max.y]) {
        for (const Z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(X, Y, Z));
      }
    }

    // **맞춘 뒤 가운데로 민다.** 비스듬히 본 상자는 화면에서 상하·좌우가 대칭이 아니라,
    // 상자 중심을 겨누면 한쪽만 화면 끝에 닿고 반대쪽에 여백이 남는다 (실측: 위 27% ·
    // 아래 3%). 투영된 상자의 가운데를 다시 겨누면 그 여백이 회수된다. 두 번이면 붙는다.
    const target = box.getCenter(new THREE.Vector3());
    const v = new THREE.Vector3();
    let dist = 0;
    for (let pass = 0; pass < 3; pass++) {
      dist = 0;
      for (const c of corners) {
        // 모서리를 (가로 · 세로 · 카메라쪽 깊이) 로 나눈다. 가까운 쪽 모서리는
        // 깊이가 양수라 그만큼 더 물러나야 화면에 들어온다.
        v.copy(c).sub(target);
        const depth = v.dot(back);
        dist = Math.max(dist,
          Math.abs(v.dot(up)) / tv + depth,
          Math.abs(v.dot(right)) / th + depth);
      }
      dist = Math.max(dist * pad, camera.near * 2);
      if (pass === 2) break;
      let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
      for (const c of corners) {
        v.copy(c).sub(target);
        const d = Math.max(dist - v.dot(back), 1e-3);
        const x = v.dot(right) / (d * th); const y = v.dot(up) / (d * tv);
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      target.addScaledVector(right, ((x0 + x1) / 2) * dist * th)
        .addScaledVector(up, ((y0 + y1) / 2) * dist * tv);
    }

    controls?.target.copy(target);
    camera.position.copy(target).addScaledVector(back, dist);
    camera.updateProjectionMatrix();
    controls?.update();
  }

  function resize() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    // **캘리브레이션 카메라는 화면 크기에 반응하지 않는다.** 투영 행렬이 실측 화각·주점이라
    // 여기서 aspect 로 덮어쓰면 애써 잰 값이 날아간다. 화면 비율은 CSS 로 맞춘다.
    if (!calib) {
      const prev = camera.aspect;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // **비율이 바뀌면 다시 맞춘다.** 시점을 배치안마다 한 번만 잡던 탓에, 창을 키워도
      // 방은 그대로 작았고 폰을 돌리면 양옆이 잘린 채 남았다. 폭만 바뀌는 것도 비율이다.
      if (framed && Math.abs(prev - camera.aspect) > 1e-3) frameTo(framed.object, framed.opts);
    }
    // **updateStyle 을 끄지 않는다.** 끄면 캔버스 CSS 크기가 버퍼 크기(=픽셀비 배)로 남아
    // 컨테이너의 몇 배가 되고 왼쪽 위 일부만 보인다. 실제로 밟았다.
    renderer.setSize(w, h);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const ticks = [];
  renderer.setAnimationLoop(() => {
    controls?.update();
    for (const f of ticks) f();
    renderer.render(scene, camera);
  });

  const api = {
    scene, camera, renderer, controls,
    /** 매 프레임 부를 함수를 등록한다 */
    onTick: (f) => ticks.push(f),
    /** 대상 전체가 화면에 담기게 시점을 잡는다. 이후 창 비율이 바뀌면 자동으로 다시 잡는다 */
    frame: frameTo,
    /** 그림자 부피를 대상에 맞춘다. **방을 씬에 넣은 직후 부른다** — 안 부르면 기본 ±6 이다 */
    fitShadow,
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls?.dispose();
      sky.dispose();
      renderer.dispose();
      // ⚠ **`dispose()` 는 컨텍스트를 안 놓는다.** 탭·모달을 여닫으면 컨텍스트가 쌓이고 브라우저 상한(보통 16)에
      // 닿는 순간 다음 캔버스가 조용히 안 생긴다 (2026-08-12 ReplayView 에서 실측). 무대가 대신 놓는다
      renderer.forceContextLoss();
      host.removeChild(renderer.domElement);
      if (globalThis.__stage === api) delete globalThis.__stage;
    },
  };

  // 헤드리스 검증용. 카메라·씬을 밖에서 봐야 "정말 그렇게 보이나" 를 숫자로 판정할 수 있다.
  globalThis.__stage = api;
  return api;
}
