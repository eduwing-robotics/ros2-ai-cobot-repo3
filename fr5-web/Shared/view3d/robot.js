// FR5 로봇 3D 로딩 — 3D 화면과 AR 화면이 **함께 쓴다**. AR 전용으로 만들지 않는다.
//
// 단위 변환은 이 파일 한 곳에서만 한다 (하드 룰 5).
//   설정 파일: 밀리미터 · 도(°)
//   내부(URDF·three.js): 미터 · 라디안
//
// 함정 (docs/archive/evidence-2026-07/2026-07-29/urdf-web-render.md 실측)
//   ① STL 은 비동기로 늦게 붙는다. load 콜백 시점에 메시가 0개다 → manager.onLoad 를 기다려라.
//   ② 그리퍼 STL 은 밀리미터, 팔 URDF 는 미터다. meshScale 을 빼면 1000배로 뜬다.
//
// (해소됨) three.js 를 손으로 importmap 에 매핑하던 함정 —
//   r185 가 three.module.js + three.core.js 로 쪼개져 있어 core 를 빼면 에러 없이 화면이 죽었다.
//   Vite 로 옮기면서 npm 이 해결한다 (docs/archive/evidence-2026-07/2026-07-30/vite-gate.md).

import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const DEG = Math.PI / 180;
const MM = 0.001; // 밀리미터 → 미터

// 설정은 **빌드 시 import 한다. fetch 하지 않는다.**
// 파일이 없거나 깨지면 빌드가 실패한다 — 런타임에 조용히 실패하면
// 화면에 아무것도 안 뜨는데 콘솔 에러도 없다 (D15·D18, BUILD-VITE.md §설정).
// 두 JSON 은 .env 에서 굽는 산출물이다 → node scripts/build/config.mjs
import gripperConfig from '../data/config/gripper-mount.json';
import { gripperFingerShiftMm } from '../data/sim/gripper-geometry.js';
import markerConfig from '../data/config/marker-offset.json';

/** 설정 두 개. 값을 코드에 박지 않기 위한 유일한 경로. */
export function loadConfig() {
  // 조정 화면이 값을 직접 고치므로 사본을 준다 — 원본을 고치면 다른 화면이 같이 바뀐다.
  return {
    gripper: structuredClone(gripperConfig),
    marker: structuredClone(markerConfig),
  };
}

/**
 * URDF 팔 + 그리퍼를 하나의 Object3D 로 만든다.
 *
 * 반환값의 robot 은 **URDF 좌표계(Z-up, 미터)** 그대로다.
 * three.js 는 Y-up 이므로 화면에 세울 때 부모에서 rotation.x = -PI/2 를 준다 —
 * robot 자체를 돌리면 관절 각도 해석이 헷갈린다.
 */
// ── 팔 겉모습 — 실물 사진·매뉴얼로 잰 것만 얹는다 (2026-09-05 · 웹조사 + `docs/evidence/2026-08-27/ar-workbench-match.png`)
//
// 공식 시각 메시(`frcobot_ros2/fairino_description/meshes/FR5WML/visual/*.dae`)도 링크당 재질 하나(흰색 1 1 1 1)라
// 색 정보는 어디에도 없다. 그래서 실물 사진에서 보이는 것만 절차적으로 얹는다 —
//   ① 베이스 윗면 주황 고리 (윗면 반지름 58mm · STL 실측)
//   ② 관절 이음새의 회색 띠 — 회전 캡이 몸체와 만나는 **목(neck)** 자리. 자리·반지름은 STL 정점을 1mm 로 썰어 잰
//      단면 프로파일이라 형상에 붙는다(LatheGeometry). 추정으로 둘렀던 두 판은 허공에 떠서 걷어냈다(주인님 지적)
//   ③ 손목 끝 상태 LED 고리 — 매뉴얼 §The end LED: 파랑 자동 · 초록 수동 · 백청 드래그 · 빨강 오류. 자리는 wrist3
//      의 홈(z 0.089~0.093 · r 0.036) — `setEndLed(robot, hex|null)` 로 상태가 색을 정한다
// 실물 고리는 베이스 윗면 가장자리에서 **어깨 목(r 55) 바깥**으로 보인다 — 안쪽은 어깨가 덮는다. 바깥 r 은 윗면(58)보다
// 2mm 넘겨 가장자리를 두른다(사진의 폭 ≈ 5mm)
const BASE_RING = { z: 0.0795, rIn: 0.0555, rOut: 0.0605 };
const SEAM = {   // 자식 프레임 [z, r] — STL 단면 실측 + 0.6mm
  // j1 은 띠가 없다 — 그 자리는 베이스 주황 고리다 (사진)
  // j2·j3 는 띠가 없다 — 어깨·팔꿈치 하우징은 관절축 둘레의 회전체가 아니라(드럼 r≈90 이 목 r 58 을 덮는다)
  // 띠가 드럼 옆으로 삐져나왔다 (주인님 「여기가 어색」 2026-09-05). 손목 셋만 목이 진짜 원통(r 40 · STL 단면 일정)이다
  // 목(r 40 · z 53.5~61) **만** 두른다. 61~65 에서 r 57 로 벌어지는 구간을 넣었더니 드럼 옆으로 접시처럼 퍼졌다
  // (주인님 「아직 펑퍼짐」 2026-09-05) — 그 구간은 회전체가 아니다
  j4: [[0.0535, 0.040], [0.0610, 0.040]],
  j5: [[0.0535, 0.040], [0.0610, 0.040]],
  j6: [[0.0535, 0.040], [0.0585, 0.040]],
};
const END_LED = { z: 0.091, r: 0.0378, h: 0.003 };
const RING_MAT = new THREE.MeshStandardMaterial({ color: 0xe8622a, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });
const SEAM_MAT = new THREE.MeshStandardMaterial({ color: 0x9096a0, roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide });
export function addJointRings(robot) {
  const base = robot.links?.base_link;
  if (base) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(BASE_RING.rIn, BASE_RING.rOut, 64), RING_MAT);
    ring.position.z = BASE_RING.z;          // 윗면 0.2mm 위 — 면이 겹치면 반짝인다(parts.js 머리말)
    ring.name = 'ring-base';
    ring.castShadow = false; ring.receiveShadow = false;
    base.add(ring);
  }
  for (const [name, prof] of Object.entries(SEAM)) {
    const j = robot.joints?.[name];
    if (!j) continue;
    // Lathe 는 (x=r, y=z) 점을 Y 축 둘레로 돌린다 → 관절축 Z 로 세운다
    const pts = prof.map(([z, r]) => new THREE.Vector2(r + 0.0006, z));
    const band = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), SEAM_MAT);
    band.rotation.x = Math.PI / 2;
    band.name = `seam-${name}`;
    band.castShadow = false; band.receiveShadow = false;
    j.add(band);
  }
  // ── 드럼 끝 주황 고리 둘 — 제품 사진(주인님 2026-09-05)의 어깨·팔꿈치 큰 원판 테두리. **평면 검출로 잰 자리**:
  // upperarm STL 에서 법선 +z 의 큰 평면 두 장이 z 0.2031 에 (0,0)·(−0.425,0) 중심 r 0.0484 로 있고, 그 높이의
  // 겉 반지름이 0.058 이라 원판 가장자리~드럼 테두리(rIn 49 · rOut 58.5)에 납작한 고리를 얹는다. 나사 4개 자리가 이 띠 위다
  const ua = robot.links?.upperarm_link;
  if (ua) {
    for (const [x, name] of [[0, 'shoulder'], [-0.425, 'elbow']]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.049, 0.0585, 64), RING_MAT);
      ring.position.set(x, 0, 0.2031 + 0.0004);
      ring.name = `ring-${name}`;
      ring.castShadow = false; ring.receiveShadow = false;
      ua.add(ring);
    }
  }
  // 어깨 기둥 윗면 — 같은 평면 검출: shoulder_link 법선 +z 평면이 z 0.2131(r 58)과 0.2171(r 48.2 · 가운데가 4mm 솟음) 둘이라
  // 그 사이 고리 모양 턱(r 48.2~58)이 곧 주황 띠 자리다 (주인님 「하나 덜했어」 2026-09-05)
  const sh = robot.links?.shoulder_link;
  if (sh) {
    // 0.2131 평면 위에 두께 3.3mm 캡판(밑면 0.2138 · 윗면 0.2171 · r 48.2)이 얹혀 있어 아래 평면은 가려진다 —
    // 고리는 **캡판 윗면 테두리**(r 40.5~48.5)에 둔다. 0.2131 에 두었더니 머리카락 선만 남았다(실렌더로 잡음)
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.0405, 0.0485, 64), RING_MAT);
    ring.position.set(0, 0, 0.2171 + 0.0004);
    ring.name = 'ring-shoulder-top';
    ring.castShadow = false; ring.receiveShadow = false;
    sh.add(ring);
  }
  const w3 = robot.links?.wrist3_link;
  if (w3) {
    const led = new THREE.Mesh(new THREE.CylinderGeometry(END_LED.r, END_LED.r, END_LED.h, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x2b2f35, emissive: 0x000000, roughness: 0.4, side: THREE.DoubleSide }));
    led.rotation.x = Math.PI / 2;
    led.position.z = END_LED.z;
    led.name = 'end-led';
    led.castShadow = false; led.receiveShadow = false;
    w3.add(led);
  }
  return robot;
}

/** 손목 끝 LED 색 — `null` 이면 꺼짐. 브리지 상태(모드·오류)가 정한다 (매뉴얼 §The end LED). */
export function setEndLed(robot, hex) {
  const led = robot?.links?.wrist3_link?.getObjectByName('end-led');
  if (!led) return;
  const on = hex != null;
  led.material.emissive.setHex(on ? hex : 0x000000);
  led.material.emissiveIntensity = on ? 1.6 : 0;
  led.material.color.setHex(on ? hex : 0x2b2f35);
}

export function loadRobot({ urdfUrl, gripperCfg, gripperDir, onProgress }) {
  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    // loadMeshCb 는 건드리지 않는다. urdf-loader 의 기본 로더가 이미 STL 을 읽고
    // URDF 의 <material> 색을 입힌다 — 직접 짜면 시그니처
    // (path, manager, material, done) 를 틀리기 쉽다.

    let robot = null;
    let gripperGroup = null;
    const failed = [];

    manager.onProgress = (_url, loaded, total) => onProgress?.(loaded, total);
    manager.onError = (url) => failed.push(url);

    // ① 여기서 세면 0개다. manager.onLoad 까지 기다린다.
    //
    // ⚠ **그런데 `onLoad` 는 한 번만 울지 않는다.** urdf-loader 는 URDF 본문을 받은 뒤 메시
    // 요청을 **다음 틱으로 미루므로**, URDF 파일 하나가 끝난 순간 큐가 잠깐 비어 **메시가
    // 0개인 채로 한 번 운다.** 그 첫 울림에서 resolve 하면 부르는 쪽은 뼈대만 받는다.
    //
    // 2026-08-10 실측 — 고스트 로봇(`RobotTwin.jsx`)이 resolve 직후 `traverse` 로 재질을
    // 파랗게 물들이는데, **STL 10개가 하나도 안 물들고 절차적 박스 4개만 파랬다.** 뎁스캠
    // 브래킷을 붙이고 나서야 눈에 보였을 뿐, 고스트는 그 전부터 안 물들고 있었다.
    // `stats` 도 같은 이유로 실제보다 작았다.
    //
    // 그래서 **잠잠해질 때까지** 기다린다 — 새 로딩이 시작되면 타이머가 취소된다.
    // ponytail: `IDLE_MS` 는 마법의 숫자다. 재는 대상이 네트워크가 아니라 **파싱 후 요청까지의
    // 코드 지연**(마이크로태스크 몇 개)이라 여유가 크다. 천장 — 어떤 로더가 이보다 더 늦게
    // 요청을 걸면 다시 이른 resolve 가 난다. 그때는 이 값이 아니라 **로더별 완료 Promise** 로
    // 갈아탄다(그리퍼 STL 은 우리 코드라 바로 가능하고, 팔은 `loadMeshCb` 가 필요하다).
    const IDLE_MS = 80;
    let idle = 0;
    let settled = false;
    manager.onLoad = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (failed.length) {
          reject(new Error(`메시 로딩 실패 ${failed.length}개: ${failed.join(', ')}`));
          return;
        }
        resolve({ robot, gripperGroup, stats: countTriangles(robot) });
      }, IDLE_MS);
    };

    loader.load(
      urdfUrl,
      (result) => {
        robot = result;
        addJointRings(robot);
        if (gripperCfg) gripperGroup = attachGripper(robot, gripperCfg, gripperDir, manager);
      },
      undefined,
      (err) => reject(err),
    );
  });
}

/**
 * 그리퍼 STL 3개를 한 Group 에 담아 부모 링크에 붙인다.
 *
 * 세 파일이 **같은 조립 좌표계**에 구워져 있어 상대 배치를 계산할 필요가 없다
 * (min Z 가 셋 다 -334~-340mm 부근, 손가락은 X축 대칭 — STACK.md §그리퍼).
 * 그래서 모르는 값은 Group 하나의 위치·회전뿐이다.
 */
function attachGripper(robot, cfg, dir, manager) {
  const parent = robot.links?.[cfg.parentLink];
  if (!parent) throw new Error(`부모 링크가 없다: ${cfg.parentLink}`);

  // mount = 설정값(위치·회전)을 적용하는 바깥 껍데기.
  // 안쪽 meshRoot 가 밀리미터→미터 축소를 맡는다.
  // 둘을 한 노드에 합치면 회전이 스케일에 섞여 값을 조정할 때 헷갈린다.
  const mount = new THREE.Group();
  mount.name = 'gripperMount';
  const meshRoot = new THREE.Group();
  meshRoot.name = 'gripperMeshes';
  meshRoot.scale.setScalar(cfg.meshScale); // ② 밀리미터 보정
  mount.add(meshRoot);
  parent.add(mount);

  applyMount(mount, cfg);

  const stl = new STLLoader(manager);
  for (const file of cfg.meshes) {
    stl.load(`${dir}${file}`, (geom) => {
      geom.computeVertexNormals();
      // 실물색 — PGEA 몸체는 무광 검정, 손가락은 알루미늄(실물 사진 2026-08-27). 팔(흰색)과 저절로 갈린다.
      // 예전 파란회색(0x4a5a68)은 「구별되는 색」이 목적이었는데, 실물색으로도 구별은 된다.
      const finger = /finger/i.test(file);
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial(finger
        ? { color: 0xb8bcc2, metalness: 0.85, roughness: 0.35 }
        : { color: 0x25282c, metalness: 0.2, roughness: 0.55 }));
      mesh.name = file;              // 손가락 둘을 나중에 찾아 밀기 위해 이름을 남긴다
      mesh.userData.restX = 0;       // 구워진 원래 X (조립 좌표계 기준)
      meshRoot.add(mesh);
    });
  }

  // 카메라는 **STL 이 아니라 절차적 박스**다 — 아래 attachDepthCam 참고.
  // meshRoot 에 넣어야 0.001 축소를 같이 타고, 그리퍼를 조정하면 따라온다.
  if (cfg.depthCam) meshRoot.add(buildDepthCam(cfg.depthCam));

  // TCP(툴 중심점) — **형상 없는 빈 노드 하나.** 좌표를 새로 만들지 않는다: 조립좌표계(mm)의
  // `tcpYMm`·`toolAxisZMm` 이 이미 그 점이고 `meshRoot` 가 바로 그 좌표계다(scale 0.001).
  //
  // D108 — TCP = 핑거 끝 = 플랜지 +135mm. 2026-08-11 실측으로 **트윈 형상이 0.0mm 로 일치**함을
  // 확인했다 (`wrist3_link` −171 → 플랜지 −72 → 손끝 +63 mm · 자세 무관 ·
  // `docs/evidence/2026-08-11/twin-frame-axes.md`). 이 노드가 없으면 소비처가 `wrist3_link`(99mm 안쪽)
  // 이나 `gripperMount` 원점(326mm 밖 허공)을 TCP 로 착각한다 — 둘 다 틀린 자리다.
  //
  // ⚠ 값이 `depthCam` 아래 사는 것은 **설정 파일의 사정**이다(카메라 기하를 잴 때 같이 쟀다).
  //    그 파일은 `.env` 에서 굽는 산출물이라 여기서 키를 옮기지 않는다.
  // ⚠ **방향도 맞춘다 — 조립좌표계는 공구축이 `+Y`, 컨트롤러는 `+Z` 다** (2026-08-11 실측).
  //    실기 `fkSamples` 와 대조하니 축이 하나하나 맞는데 **이름표만 달랐다**:
  //      조립 X = 실기 X · 조립 **Y = 실기 Z** · 조립 **Z = −실기 Y** → X 축 **90.0018°** 하나 차이.
  //    `tcp` 라는 이름을 달았으니 **컨트롤러의 툴 프레임과 같은 뜻**이어야 한다. 안 돌리면
  //    이 축을 보는 사람이 **접근 방향을 +Z 로 읽는데 실제 손끝은 +Y 로 뻗는다** — 파지에서
  //    제일 비싼 오독이다. 회전은 원점을 안 움직이므로 위치(오차 0.7mm)는 그대로다.
  if (cfg.depthCam) {
    const tcp = new THREE.Object3D();
    tcp.name = 'tcp';
    tcp.position.set(0, cfg.depthCam.tcpYMm, cfg.depthCam.toolAxisZMm);
    tcp.rotation.x = -Math.PI / 2;
    meshRoot.add(tcp);
  }

  return mount;
}

/** 박스 하나. 크기·중심 다 **밀리미터**다 (그리퍼 조립좌표계). */
function mmBox(name, [w, h, d], [x, y, z], color) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.6 }),
  );
  mesh.name = name;
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * 손목 뎁스카메라(RealSense D435)와 외장 브래킷 — **박스 넷의 근사다.**
 *
 * URDF 에 없고 STL 도 없다. 실물은 3D 프린팅 브래킷이라 CAD 원본이 우리에게 없다.
 * 그래서 실측 넷(`DEPTH-CAM.md` §장착·§브래킷)으로 기하만 맞춘다.
 *
 * 조립좌표계 규약 두 개. 여기를 틀리면 카메라가 90° 돌아 붙는다 —
 *   **+Y 가 아래**(핑거가 뻗는 방향, 작업대 쪽). 2026-08-10 에 실기 관절값을 3D 에 얹어
 *     조립 +Y 가 월드 −Y 를 향하는 것(−0.996)으로 확인했다
 *   **브래킷은 +Z 로 뻗는다** (`outSign`). 옆면(X)이 아니다. 체결부는 그리퍼의 **벽을 보는
 *     면**(법선 +Z · X 35.6 × Y 87.5)에 붙고, 카메라는 거기서 나가 아래를 본다
 *
 * **실측 넷이 서로를 검산한다.** 체결부는 면 상단 Y −72 에서 `cleatDrop` 25mm 내려와 −47 에서
 * 시작하고, 높이 30mm 라 −17 에서 끝난다 — 그게 `tcpY − 80 = −16.98`, 즉 **렌즈면과 같은
 * 평면**이다. 그리고 카메라 90mm 를 판 79mm 에 얹으면 양끝으로 11mm 가 나와 실물에서
 * 선꽂는 쪽이 삐져나온 것과 맞는다. 넷 중 하나라도 틀리면 이 합이 안 닫힌다.
 *
 * ponytail: 박스 근사다. 천장 셋 —
 *   ① 흰 하우징을 안 그린다. 실물은 D435 가 프린팅 커버 안에 있는데 커버 치수를 안 쟀다.
 *      가려지는 부피라 기하 판정에는 영향이 없다
 *   ② 체결부와 카메라 판의 **Z 분배**는 실측이 아니다. 둘의 합(85mm)과 카메라 Z 위치만
 *      실측이고, 경계는 카메라 뒷면에 맞춰 잡았다
 *   ③ 카메라를 판 아래에 **수평**으로 달았다. 틸트 0°·롤 0° 가 실측이라 맞지만, 브래킷을
 *      다시 만들어 23° 틸트를 주면(§화각) 여기도 같이 고쳐야 한다
 * 업그레이드 경로 — 브래킷 STL 을 받으면 이 함수를 통째로 STL 로더로 바꾼다.
 */
function buildDepthCam(cam) {
  const g = new THREE.Group();
  g.name = 'depthCam';

  const [bodyW, bodyT, bodyD] = cam.bodySizeMm;   // 90 × 25 × 25
  const [cleatW, cleatH] = cam.cleatSizeMm;       // 27 × 30
  const s = cam.outSign;                          // 뻗는 쪽. +1 = +Z

  // 렌즈 중심 — 실측 둘이 직교로 만나는 점이다
  const lensY = cam.tcpYMm - cam.lensHeightMm;          // TCP 에서 위로 80 → −16.98
  const lensZ = cam.toolAxisZMm + s * cam.lensOffsetMm; // 툴 축에서 82 → −243.64

  const faceZ = cam.faceZMm;                        // 체결면 −311.1
  const tipZ = faceZ + s * cam.bracketReachMm;      // 브래킷 끝 −226.1
  const plateW = cam.bracketPlateWidthMm;           // 79

  // 브래킷 몸통의 높이대 — 면 상단에서 cleatDrop 만큼 내려온 자리. **아래 끝이 렌즈면이다**
  const railY = cam.faceTopYMm + cam.cleatDropMm + cleatH / 2;  // −32
  const camBackZ = lensZ - s * bodyD / 2;           // 카메라 뒷면 −256.14
  const cleatD = Math.abs(camBackZ - faceZ);        // 체결부 Z 길이 (ponytail ②)
  const plateD = Math.abs(tipZ - camBackZ);         // 카메라를 담는 부분

  // 카메라는 판 한가운데가 아니다 — 선꽂는 쪽으로 camJut 만큼 나와 있다 (실측).
  // 0 으로 두면 양쪽 5.5mm 씩 대칭이 되는데 실물은 한쪽만 15mm 다.
  const camX = plateW / 2 + cam.camJutMm - bodyW / 2;

  const WHITE = 0xe6e8ea;   // 3D 프린팅 브래킷
  const SILVER = 0xc9ced4;  // D435 알루미늄 바디
  const GLASS = 0x15181c;   // 렌즈면 — **방향을 눈으로 확인하는 면이다**

  g.add(mmBox('camBracketCleat', [cleatW, cleatH, cleatD],
    [0, railY, faceZ + s * cleatD / 2], WHITE));
  g.add(mmBox('camBracketPlate', [plateW, cleatH, plateD],
    [0, railY, camBackZ + s * plateD / 2], WHITE));
  g.add(mmBox('camBody', [bodyW, bodyT, bodyD],
    [camX, lensY - bodyT / 2, lensZ], SILVER));
  // 렌즈면은 몸통 밖으로 살짝 띄운다 — 같은 평면이면 z-fighting 으로 지글거린다
  g.add(mmBox('camLensFace', [bodyW * 0.92, 1.5, bodyD * 0.8],
    [camX, lensY - 0.55, lensZ], GLASS));

  return g;
}

/**
 * 로봇을 화면에 세울 홀더. **URDF 는 Z-up, three.js 는 Y-up** 이라 −90° 를 준다.
 *
 * 로봇이 아니라 **부모를 돌린다** — robot 자체를 돌리면 관절 각도 해석이 헷갈린다.
 * 위 `loadRobot` 주석이 이 규칙을 적어만 두고 구현은 안 갖고 있어서, 화면마다 각자
 * 베껴 쓰다 **다섯 벌**이 됐다 (`xr.js`·`ar.js`·`robot.js`·`LayoutView.jsx`·`RobotTwin.jsx`).
 * 이름도 다 달랐다(`holder`/`stage`/`zUpToYUp`) — 한 벌이 빠지면 **로봇이 누워서 뜬다**.
 * 하드 룰 5 와 같은 취지다: 좌표계를 바꾸는 자리는 한 곳뿐이어야 한다.
 *
 * 홀더에 얹는 것(위치 오프셋·그림자·피킹 해제)은 **부르는 쪽이 각자** 한다 —
 * 그건 화면마다 다르고, 여기 넣으면 다섯 화면의 사정이 이 함수로 새어 들어온다.
 *
 * @param {THREE.Object3D} robot `loadRobot` 이 준 URDF 로봇 (Z-up 그대로)
 * @returns {THREE.Group} Y-up 홀더. 씬·부모에 이걸 붙인다
 */
export function mountRobotYUp(robot) {
  const holder = new THREE.Group();
  holder.name = 'robotHolder';
  holder.rotation.x = -Math.PI / 2;
  if (robot) holder.add(robot);
  return holder;
}

/**
 * 손가락 개폐를 3D 에 반영한다 (2026-08-04).
 *
 * **관절이 아니라 메시 이동이다** — URDF 에 prismatic 관절이 없다. 손가락 STL 둘이 X 축
 * 대칭으로 구워져 있어(attachGripper 주석) 좌우를 반대 부호로 밀면 개폐로 보인다.
 * openPct 0=닫힘 100=열림. 값이 null 이면 아무것도 하지 않는다 — **모르면 안 움직인다**
 * (마지막 자세를 유지하는 편이, 없는 값을 0 으로 읽어 손가락을 닫아 보이는 것보다 정직하다).
 */
export function setGripperOpenPct(mount, openPct, halfStrokeMm) {
  if (!mount || openPct == null || !Number.isFinite(openPct)) return;
  // **STL 은 이미 벌어진 자세로 구워져 있다** (gripper-mount.json `_손가락`).
  // 그래서 여는 게 아니라 **닫을 때만 안쪽으로 당긴다** — 100% 에서 offset 0 이다.
  // 반대로 짜면 구워진 폭에 20mm 이 더해져 비현실적으로 벌어진다 (2026-08-04 육안 확인).
  for (const m of mount.getObjectByName('gripperMeshes')?.children ?? []) {
    if (!m.name.includes('finger')) continue;
    m.position.x = m.userData.restX + gripperFingerShiftMm(m.name, openPct, halfStrokeMm);
  }
}

/** 설정값을 mount 에 적용한다. 육안 정합 중 여러 번 다시 부른다. */
export function applyMount(mount, cfg) {
  const [x, y, z] = cfg.positionMm;
  mount.position.set(x * MM, y * MM, z * MM);
  const [rx, ry, rz] = cfg.rotationDeg;
  mount.rotation.set(rx * DEG, ry * DEG, rz * DEG);
}

/** 게이트 기준값과 대조할 수 있는 형태로 센다 (scripts/check/assets.sh). */
export function countTriangles(root) {
  let tris = 0;
  let meshes = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes += 1;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return { meshes, triangles: Math.round(tris) };
}

/** 관절 이름 → 각도(도). 로봇 API 가 도를 쓰므로 바깥 표면은 도로 맞춘다. */
/**
 * 고스트(계획·가정) 팔로 칠한다 — **파랑 반투명 · depthWrite 끔**. 규약: 불투명 = 실기 · 반투명 = 계획
 * (D195 · `evidence/2026-08-28/amr-in-fr5-twin.md` P2 「불투명 = 실기 · 반투명 = 가정」). 재질은 **복제해서** 간다 — 공유 재질을 그대로 물들이면 본체까지 파래진다
 * (`de1a7b5` · GAP-CLOSED 08-10). 이미 칠한 메시는 표시해 두고 새 것만 칠하므로 **여러 번 불러도 된다** —
 * 그리퍼·브래킷은 팔 STL 보다 늦게 붙어 한 번 칠하면 파란 팔에 흰 손이 남는다(2026-09-04). 400·1600ms 뒤에
 * 한 번씩 더 부르는 것이 호출처 규약이다. 칠한 메시 수를 돌려준다.
 * ponytail: `FR5/src/features/live/RobotTwin.jsx` 의 `dim()` 과 같은 값이다 — 그쪽이 배포 중이라 오늘은 안 합쳤다.
 */
export function paintGhost(robot, { color = 0x4a90d9, opacity = 0.5 } = {}) {
  const tint = new THREE.Color(color);
  const dim = (m) => {
    const c = m.clone();
    c.transparent = true;
    c.opacity = opacity;
    c.depthWrite = false;
    if (c.color) c.color = tint.clone();
    if ('emissive' in c) c.emissive = tint.clone().multiplyScalar(0.25);
    if ('metalness' in c) c.metalness = 0;   // PBR 반사가 파랑을 하얗게 덮는 걸 막는다
    if ('map' in c) c.map = null;             // 흰 텍스처를 지워 단색 홀로그램으로
    c.needsUpdate = true;
    return c;
  };
  let n = 0;
  robot.traverse((o) => {
    if (!o.isMesh || !o.material || o.userData.__ghosted) return;
    o.material = Array.isArray(o.material) ? o.material.map(dim) : dim(o.material);
    o.userData.__ghosted = true;
    n += 1;
  });
  return n;
}

export function setJointsDeg(robot, jointsDeg) {
  for (const [name, deg] of Object.entries(jointsDeg)) {
    robot.setJointValue?.(name, deg * DEG);
  }
}
