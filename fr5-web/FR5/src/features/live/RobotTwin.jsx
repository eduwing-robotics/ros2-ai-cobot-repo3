// 3D 쌍둥이 — 상태 스트림의 관절각을 URDF 에 그대로 얹는다. 렌더 파이프는
// AR/src/screens/robot.js 와 같은 재료(@fr5/shared robot-view)를 쓴다.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { createStage } from '@fr5/shared/view3d/lab/stage.js';
import {
  loadConfig, loadRobot, setJointsDeg, setEndLed, setGripperOpenPct, mountRobotYUp,
} from '@fr5/shared/view3d/robot.js';
import { makeWorkspace, toBase } from '@fr5/shared/view3d/workspace.js';
import { createFrameAxes } from '@fr5/shared/view3d/frame-axes.js';
import { URDF_BASE_Z_MM, AMR_HOME, AMR_HOME_ALT, DEPTH_USEFUL_MM } from '@fr5/shared/data/workcell.js';
import { toFrame, yawToFrame } from '@fr5/shared/data/frames.js';
import { REACH_MM } from '@fr5/shared/data/motion/limits.js';
import { AMR_MM } from '@fr5/shared/data/layout/catalog.js';
import { loadBurger, mountBurgerZUpXForward, rollWheels } from '@fr5/shared/view3d/burger.js';
// 소품 — **옮기는 거치대**와 **터틀봇 바구니.** 치수 정본은 `props.js` 고 여기는 그리기만 한다.
import { carrier, amrBasket } from '@fr5/shared/view3d/parts.js';
import { CARRIER, CARRIER_GRASP_TRUTH, AMR_BASKET, carrierBodyOffset } from '@fr5/shared/data/props.js';
import { mm } from '@fr5/shared/data/units/units.js';

/**
 * 미리보기 안전 높이 — 터틀봇 **윗면에서** 이만큼 떠서 내려다본다.
 *
 * ⚠ **정본은 여기가 아니다.** 실기는 브리지 `FR5/bridge/config.yaml` 의 `follow.standoffMm`
 * 를 쓴다(지금 165 — 카메라 최적 250 − hand-eye z 85). 그 값은 브리지 안에 살고 상태로
 * 안 나오므로 화면이 못 읽는다. 여기 숫자가 어긋나도 **실기에는 영향이 없다** — 이건
 * 그리기만 하는 미리보기다.
 * ▶ 브리지가 `follow` 를 상태에 실어 주면 그때 이 상수를 지우고 그 값을 쓴다.
 */
const PREVIEW_STANDOFF_MM = 165;

/** 시선 화살 길이 — 보기용이다. 카메라 사거리와 무관하다 */
const SIGHT_MM = 400;

/**
 * 뎁스카메라 화각 — D435 · 848×480 실측 내부파라미터(fx 425.91)에서 나온 값.
 * 가로 2·atan(848/2fx) = 89.5° · 세로 2·atan(480/2fx) = 58.8°
 * (세로 58.8° 는 `FR5/bridge/config.yaml` 주석에도 같은 값으로 적혀 있다.)
 * ⚠ 정본은 카메라 관문(`:5058/api/camera/info`)이 주는 내부파라미터다 — 여기는 미리보기 사본이다.
 */
const CAM_FOV = { hDeg: 89.5, vDeg: 58.8 };

/**
 * 손끝 자세 → 회전행렬. **고정축 XYZ (`R = Rz·Ry·Rx`)**.
 *
 * ⛔ **규약을 추측하지 않는다.** 정본은 `FR5/bridge/safety.py` 의 `_rot_fixed_xyz` 이고,
 * 실기 4자세로 후보 12개를 가려 확정했다 — 이것만 잔차 **0.0048°**, 2등이 32.96° 였다
 * (`docs/evidence/2026-08-11/tcp-euler-convention.md`). 그래서 여기서 오일러 순서를
 * 고르지 않고 **행렬을 그대로 옮겨 적는다.**
 */
function rotFixedXYZ(rxDeg, ryDeg, rzDeg) {
  const d = Math.PI / 180;
  const cx = Math.cos(rxDeg * d); const sx = Math.sin(rxDeg * d);
  const cy = Math.cos(ryDeg * d); const sy = Math.sin(ryDeg * d);
  const cz = Math.cos(rzDeg * d); const sz = Math.sin(rzDeg * d);
  return new THREE.Matrix4().set(
    cz * cy, cz * sy * sx - sz * cx, sz * sx + cz * sy * cx, 0,
    sz * cy, cz * cx + sz * sy * sx, sz * sy * cx - cz * sx, 0,
    -sy, cy * sx, cy * cx, 0,
    0, 0, 0, 1,
  );
}

export function RobotTwin({
  jointsDeg, gripperPct, ghostJointsDeg, ghostGripperPct, workspace, coordDefs,
  ledColor = null,   // 손목 끝 LED — 브리지 모드·오류가 정한다 (robot.js §setEndLed)
  axesFrames = [],   // 켤 프레임 축 이름들 — 계측 전용 (`SHARED-CORE.md` §프레임 축)
  amrPose = null,    // 터틀봇 실기 자세 — **홈 기준**(odom).
                     // `null` = 「아직/더는 모른다」 → 홈에 **반투명**으로 세운다(가정 표시)
  tcpMmDeg = null,   // 실기 손끝 — ⚠ **user1 기준**이다 (D87). 그릴 때 `toFrame` 을 거친다
  handEye = null,    // { tMm:[x,y,z] } — 손끝 프레임에서 본 카메라 원점 (실기 실측)
  amrTrail = null,   // 주행 기록의 자취 — **odom 샘플 배열**. 그릴 때 `toFrame` 을 거친다
  // 시뮬이 「거치대를 들고 있다」고 할 때의 **손끝 자리**(user1 mm). `null` 이면 판 위에 둔다.
  // ⛔ 자리 계산은 **여기서 한 번만** 한다 — 파지 자세와의 차를 아는 곳이 여기다 (하드 룰 5)
  carrierHeldTcp = null,
  carrierInHand = false,           // 참이면 거치대를 숫자가 아니라 고스트 손끝 노드에 건다 (팔 그림과 같은 FK)
  // **지금 거치대가 어디 있나** (user1 mm · 윗면 중심) — 글로벌캠 색 검출이 준다.
  // ⛔ 없으면 **안 그린다.** 예전에는 08-31 에 가르친 파지 자세에 세워 뒀는데, 그 값은
  // 판이 56.9mm 올라가며 **거짓이 됐다**(`props.js` §stale). 모르는 자리에 그럴듯하게
  // 그리는 것이 이 저장소가 제일 싫어하는 것이다 — 사람이 화면을 믿는 만큼 더 나쁘다.
  carrierAtMm = null,
  carrierYawDeg = null,            // 검출이 낸 거치대 요각(user1 · 가로 85 가 x 와 평행이면 0 · [−90,90)). 실측일 때만 뜻이 있다
  amrIsReplay = false, // 되감는 중인가 — **실물이 아니면 화면이 그렇게 말해야 한다**
  amrDriftPose = null, // 도착 오차 유령(odom) — 시연이 「실제로 선 자리」를 줄 때만. 회색 반투명 상자 (2026-09-06 · GRILL #12)
  // 가상 손끝 — 주어지면 **시야 발자국·시선을 이것으로** 그린다 (「이 자세로 두면 어떻게 보이나」).
  // ⛔ 실기를 그 자세로 보내는 것이 아니다. 그리기만 한다.
  simTcpMmDeg = null,
  // 거치대 **자리 고르기** (2026-09-06 · phase 4) — 켜지면 판 위 클릭 한 번이 user1 (x, y) 를 낸다. 궤도 조작과 안 싸우게 「모드」로 둔다.
  // ⛔ 입력은 가정이다 — 실측 표적(색 검출)이 있으면 그것이 이긴다(`main.jsx` 가 가른다). 여기는 좌표를 내기만 한다
  pickCarrier = false,
  onPickCarrier = null,
}) {
  const hostRef = useRef(null);
  const jointsRef = useRef(jointsDeg);
  jointsRef.current = jointsDeg;
  const gripRef = useRef(gripperPct);   // 손가락 개폐 — 관절과 같은 틱에서 그린다
  gripRef.current = gripperPct;
  const ledRef = useRef(ledColor);
  ledRef.current = ledColor;
  // 고스트(실물 현재 자세를 반투명으로 겹치는 두 번째 로봇) — null 이면 안 그린다
  const ghostJointsRef = useRef(ghostJointsDeg);
  ghostJointsRef.current = ghostJointsDeg;
  const ghostGripRef = useRef(ghostGripperPct);
  ghostGripRef.current = ghostGripperPct;
  const heldRef = useRef(carrierHeldTcp);
  heldRef.current = carrierHeldTcp;
  const inHandRef = useRef(carrierInHand);
  inHandRef.current = carrierInHand;
  const atRef = useRef(carrierAtMm);
  atRef.current = carrierAtMm;
  const yawRef = useRef(carrierYawDeg);
  yawRef.current = carrierYawDeg;
  // **게이트 값은 사용자 좌표계 기준이라 그대로 그리면 600mm 어긋난다** (2026-08-07).
  // 베이스로 환산해서 들고 다닌다 — 환산이 안 되면 `null` 이고, 그러면 판정면을 안 그린다.
  const wsRef = useRef(null);
  wsRef.current = toBase(workspace, coordDefs?.user);
  // 사용자 좌표계 정의와 축 선택 — 둘 다 매 렌더 바뀔 수 있으니 ref 로 들고 간다
  const userDefRef = useRef(null);
  userDefRef.current = coordDefs?.user ?? null;
  const axesRef = useRef([]);
  axesRef.current = axesFrames;
  // 터틀봇 — 매 프레임 최신값을 읽는다 (관절과 같은 규약: 리렌더 없이 ref)
  const amrRef = useRef(null);
  amrRef.current = amrPose;
  const tcpRef = useRef(null);
  tcpRef.current = tcpMmDeg;
  const heRef = useRef(null);
  heRef.current = handEye;
  const trailRef = useRef(null);
  trailRef.current = amrTrail;
  const replayRef = useRef(false);
  replayRef.current = amrIsReplay;
  const driftRef = useRef(null);
  driftRef.current = amrDriftPose;
  const simTcpRef = useRef(null);
  simTcpRef.current = simTcpMmDeg;
  const pickRef = useRef(false);
  pickRef.current = pickCarrier;
  const onPickRef = useRef(null);
  onPickRef.current = onPickCarrier;

  useEffect(() => {
    const host = hostRef.current;
    // **무대는 `Shared` 한 벌이다** (phase 2 · 2026-09-05). 조명·환경맵·그림자·톤매핑·궤도 조작·리사이즈·
    // 애니메이션 루프를 `createStage()` 가 갖는다. 전엔 이 파일·ReplayView·LayoutView 가 각자 무대를
    // 조립해 같은 카트가 화면마다 다른 색이었다(여기는 HemisphereLight 1.1 + Directional 1.5 · 환경맵 없음).
    const stage = createStage(host, { background: 0xeae8e5 });   // 밝은 테마 (D38)
    // 검증 훅 — `globalThis.__stage` 는 **마지막에 만든 무대**(PiP 가 덮어쓴다)라 트윈 무대는 여기로 낸다
    window.__twin = { ...(window.__twin ?? {}), stage };
    const { scene, camera, renderer, controls } = stage;
    camera.fov = 45; camera.near = 0.01; camera.far = 100;   // 손끝 근접 확인용 — 무대 기본(42 · 0.05)보다 가깝게
    camera.updateProjectionMatrix();
    camera.position.set(1.9, 1.5, 1.9);
    controls.target.set(0, 0.1, 0);

    // Z-up→Y-up 은 `Shared` 한 곳에서만 한다 (`mountRobotYUp`).
    const zUpToYUp = mountRobotYUp(null);
    scene.add(zUpToYUp);

    // ── 자리 고르기 — 판 평면(그려진 상판 · user1 z = AMR_HOME.topZMm)에 레이를 쏴 user1 (x, y) 를 낸다.
    //    좌표계가 없으면(미연결) 안 낸다(결측=차단). 클릭만 — 드래그는 궤도 조작 몫이다
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pickAt = (clientX, clientY) => {
      const userDef = userDefRef.current;
      if (!Array.isArray(userDef)) return null;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // 판 평면: 홀더 로컬 z = 상판(base) → 월드 평면으로. 홀더는 Z-up→Y-up 회전만이라 법선은 월드 +y
      const topBase = toFrame({ xMm: 0, yMm: 0, zMm: AMR_HOME.topZMm }, 'user1', 'base', { user1: userDef });
      if (!topBase) return null;
      const pWorld = zUpToYUp.localToWorld(new THREE.Vector3(0, 0, mm(topBase.zMm)));
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -pWorld.y);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      const local = zUpToYUp.worldToLocal(hit.clone());
      const u = toFrame({ xMm: local.x * 1000, yMm: local.y * 1000, zMm: local.z * 1000 }, 'base', 'user1', { user1: userDef });
      return u ? [Math.round(u.xMm * 10) / 10, Math.round(u.yMm * 10) / 10] : null;
    };
    let downAt = null;
    const onDown = (e) => { downAt = [e.clientX, e.clientY]; };
    const onUp = (e) => {
      if (!pickRef.current || !downAt) return;
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
      downAt = null;
      if (moved > 6) return;                         // 끌었으면 궤도 조작이다
      const xy = pickAt(e.clientX, e.clientY);
      if (xy) onPickRef.current?.(xy);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    // 계측 훅 — 게이트가 화면 좌표 없이 같은 길로 입력을 넣는다
    window.__twin = { ...(window.__twin ?? {}), pickCarrierAt: (xy) => onPickRef.current?.(xy), pickFromScreen: pickAt };

    // 작업셀 — 카트·바닥은 항상, **판정면(상판·벽)은 브리지가 값을 줄 때만** 그린다.
    // 홀더 안에 넣으므로 좌표가 로봇과 같다 (Z-up·미터). 여기서 변환하지 않는다.
    let cell = null;
    const drawCell = (ws) => {
      if (cell) { zUpToYUp.remove(cell); cell.traverse((o) => o.geometry?.dispose?.()); }
      cell = makeWorkspace(ws ?? null);
      zUpToYUp.add(cell);
    };
    drawCell(wsRef.current);
    let lastWs = wsRef.current;

    // ── 옮기는 거치대 — **판 위에 놓인 소품.** (2026-08-31 · D161)
    //
    // ⚠ **자리는 실측이 아니라 「마지막으로 사람이 문 자리」다.** 거치대는 태그 옆 100mm
    // 안에서 매번 움직이므로(실기 담당자 2026-08-31) 저장된 자리가 곧 지금 자리가 아니다.
    // 그래서 **반투명**으로 그린다 — 판정면(`makeWorkspace`)과 달리 이건 「여기쯤」이다.
    // ▶ 손목 뎁스가 실제 자리를 내는 날 이 노드의 position 만 그 값으로 바꾼다.
    let carrierNode = null;
    try {
      const g = CARRIER_GRASP_TRUTH.tcpMmDeg;
      carrierNode = new THREE.Group();
      const model = carrier();
      // `parts` 규약 = **바닥 중앙 원점 · Y-up**. 홀더는 Z-up 이라 한 번 세운다.
      model.rotation.x = Math.PI / 2;
      carrierNode.add(model);
      // **어느 쪽을 보고 서 있나** — 파지 자세의 손목 각 + 정본의 상대각.
      // 그리퍼가 **가로 변을 가로질러** 물므로 그림도 그 방향으로 서야 한다
      // (2026-08-31 · 처음엔 90° 돌아 있어 세로 변을 무는 것처럼 보였다).
      carrierNode.rotation.z = ((CARRIER_GRASP_TRUTH.tcpMmDeg[5]
        + (CARRIER.yawFromGraspDeg ?? 0)) * Math.PI) / 180;
      carrierNode.userData.yaw0 = carrierNode.rotation.z;   // 판 위 기본 요각 — 손에 들리면 손목이 돈 만큼 더한다
      carrierNode.traverse((o) => {
        if (!o.material) return;
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.55;       // 「가정한 자리」 — 실측이 아니다
      });
      // 실물 거치대는 **분홍**이다(2026-09-04 · 실기 담당자가 검정→분홍으로 바꿔 색 검출이 살았다). 카메라가 본 자리(실측)면 분홍·거의 불투명,
      // 가정(08-31 자리·판 클릭)이면 회색 반투명 — 「불투명 = 실기 · 반투명 = 가정」 규약(D128)
      carrierNode.userData.paint = (seenNow) => {
        if (carrierNode.userData.painted === seenNow) return;
        carrierNode.userData.painted = seenNow;
        carrierNode.traverse((o) => {
          if (!o.material?.color) return;
          o.material.color.setHex(seenNow ? 0xe8579b : 0x9aa0a6);
          o.material.opacity = seenNow ? 0.95 : 0.55;
          o.material.needsUpdate = true;
        });
      };
      // 판 윗면에 세운다. z 는 `user1` 이라 아래 틱과 같은 변환을 거친다
      // ⛔ **자리는 마운트가 아니라 틱에서 잡는다.** 마운트 순간엔 로봇이 아직 안 붙어
      // `coordDefs` 가 없다 — 그때 한 번 판정하고 끝내면 **연결된 뒤에도 영영 안 그려진다**
      // (2026-08-31 실렌더에서 그렇게 안 보였다). 아래 틱이 좌표계가 생기면 세운다.
      carrierNode.visible = false;
      zUpToYUp.add(carrierNode);
    } catch { carrierNode = null; }      // 소품이 로봇을 못 죽인다

    // ── 터틀봇 — **바닥이 아니라 작업대 판 위를 달린다** (D134: 상판 주행 · 낙하가 위험이다).
    //
    // 자리는 `AMR_HOME` 이 정본이다 (`workcell.js` · 2026-08-28 줄자, 판은 로봇이 짚은 실측).
    // **여기서 좌표를 새로 만들지 않는다** — 실측 SSOT 를 읽어 쓰기만 한다.
    //
    // 홀더(`zUpToYUp`) 안은 **로봇 베이스** 기준이다 (Z-up · 미터).
    //
    // ⛔ **`AMR_HOME` 을 그대로 넣지 않는다 — 그건 `user1` 기준이다.** 판정면 상자가
    // `toBase()` 를 거치듯 홈도 `pointToBase()` 를 거친다. 2026-08-28 에 이걸 빼먹고
    // 터틀봇이 **판 밑 342.1mm** 에 떴다 (= user1 의 z 오프셋). 자리는 아래 틱에서 정한다.
    const amrNode = new THREE.Group();
    amrNode.visible = false;    // 옮길 수 있기 전에는 **안 그린다** (아래 틱이 켠다)
    zUpToYUp.add(amrNode);
    // 초록 바구니 — **터틀봇 등에 달려 같이 움직인다** (실기 담당자 2026-08-31). 그래서 씬에서도
    // `amrNode` 의 **자식**이다. 형제로 두면 로봇이 갈 때 바구니만 제자리에 남는다.
    // ⚠ 로봇 기준 자리(`AMR_BASKET.offsetMm`)를 **아직 안 쟀다** — 그동안은 「등 뒤 절반」이라는
    //   말만 알고 있으므로 그 뜻대로 뒤쪽에 세우고, 잰 값이 오면 이 분기가 사라진다.
    try {
      const b = amrBasket();
      b.rotation.x = Math.PI / 2;                 // parts 는 Y-up · 홀더는 Z-up
      const off = AMR_BASKET.offsetMm;
      // ⛔ **몸통과 겹치지 않고 뒤에 이어 붙는다** (실기 담당자 2026-08-31 정정 — 처음엔 절반을
      // 겹쳐 그려 바구니가 로봇을 먹었다). 그래서 절반이 아니라 **두 깊이의 절반 합**이다.
      const wall = AMR_BASKET.wallMm ?? 3;
      const back = -(AMR_MM.depthMm / 2 + (AMR_BASKET.innerDMm + 2 * wall) / 2);
      b.position.set(mm(off?.x ?? back), mm(off?.y ?? 0),
        mm((off?.z ?? (AMR_BASKET.floorAboveGroundMm ?? 0))));
      // ⚠ **`offsetMm` 이 없으면 이 자리는 「등 뒤」라는 말에서 유도한 값이다.** 잰 값이
      // 아니므로 흐리게 그린다 — 소품이 실측처럼 또렷하면 사람이 그 자리를 믿는다 (D128).
      if (!off) {
        b.traverse((o) => {
          if (!o.material) return;
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.5;
        });
      }
      amrNode.add(b);
    } catch { /* 소품이 로봇을 못 죽인다 */ }
    // 대체 상자를 **먼저** 세우고 GLB 가 오면 갈아 끼운다. 안 오면 상자로 버틴다 (D15·D18) —
    // 메시가 없다고 로봇이 사라지면 「판 위에 뭐가 있나」라는 판단 근거가 같이 사라진다.
    // 치수는 `AMR_MM` 이 정본이다 (Burger 실물 · `docs/evidence/2026-08-07/amr-burger-mm.md`).
    const amrBody = new THREE.Mesh(
      new THREE.BoxGeometry(mm(AMR_MM.widthMm), mm(AMR_MM.depthMm), mm(AMR_MM.heightMm)),
      new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.8 }),
    );
    amrBody.position.z = mm(AMR_MM.heightMm) / 2;   // 판 위에 **얹는다** — 원점은 바닥 중앙
    amrNode.add(amrBody);

    // ── 도착 오차 유령 (2026-09-06 · `GRILL-conveyor-twin` #12) — 시연이 `amrDriftPose` 를 줄 때만 보인다.
    //    명령 자리(위 amrNode)와 실제로 선 자리(이 상자)가 실측 37.5mm 만큼 벌어지는 것을 **보여주기만** 한다.
    //    회색·반투명·상자 — 실물 메시를 쓰면 「저기 진짜 있다」로 읽힌다(D128).
    const driftNode = new THREE.Mesh(
      new THREE.BoxGeometry(mm(AMR_MM.widthMm), mm(AMR_MM.depthMm), mm(AMR_MM.heightMm)),
      new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    driftNode.position.z = mm(AMR_MM.heightMm) / 2;
    const driftGroup = new THREE.Group();
    driftGroup.add(driftNode);
    driftGroup.visible = false;
    zUpToYUp.add(driftGroup);

    // ── 홈 두 후보 (#14) — 정본 `AMR_HOME`(줄자 · 실선) 과 `AMR_HOME_ALT`(손목 뎁스 쌍 · 점선). 141mm 갈린 P0 를
    //    바닥에 발자국 둘로 그려 둔다. **`replay` 가 있을 때만** 보인다 — 되감기·9칸·관측 자세·사이클 전부(`amrIsReplay = Boolean(replay)`). 실기만 그리는 화면에서 「후보」가 실물처럼 읽히면 안 되기 때문이다.
    const homeRect = (dashed) => {
      const w = mm(AMR_MM.widthMm) / 2; const d = mm(AMR_MM.depthMm) / 2;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-d, -w, 0), new THREE.Vector3(d, -w, 0), new THREE.Vector3(d, w, 0), new THREE.Vector3(-d, w, 0), new THREE.Vector3(-d, -w, 0),
      ]);
      const m = dashed
        ? new THREE.LineDashedMaterial({ color: 0xd08432, dashSize: mm(18), gapSize: mm(10) })
        : new THREE.LineBasicMaterial({ color: 0x2f6fd0 });
      const l = new THREE.Line(g, m);
      if (dashed) l.computeLineDistances();
      l.visible = false;
      zUpToYUp.add(l);
      return l;
    };
    const homeLines = [homeRect(false), homeRect(true)];
    const HOME_CANDIDATES = [AMR_HOME, AMR_HOME_ALT];

    // ── 실측인가 추정인가를 **눈으로 가른다** (2026-08-28 감사).
    //
    // 실기 자세가 없을 때 홈에 **불투명하게** 세우면, 화면은 「저기 있다」고 단정하는
    // 셈이다 — 터틀봇이 켜져 있지도 않은데. 고스트 팔이 반투명으로 「이건 실물이 아니다」
    // 를 말하는 것과 같은 규약을 쓴다: **불투명 = 실기가 준 자세 · 반투명 = 홈이라고 가정한 자리.**
    //
    // ⚠ **재질을 복제해서 바꾼다** — 공유 재질을 건드리면 팔까지 같이 물든다 (`de1a7b5`).
    const amrMats = [];
    const ownMat = (o) => {
      if (!o.isMesh || !o.material) return;
      o.material = o.material.clone();
      amrMats.push(o.material);
    };
    const setAmrGhost = (on) => {
      for (const m of amrMats) {
        m.transparent = on; m.opacity = on ? 0.32 : 1; m.depthWrite = !on;
      }
    };
    ownMat(amrBody);

    // 바퀴 굴리기 (2026-09-06 · `GRILL-conveyor-twin` #8) — 실물 메시가 붙은 뒤에만 있다. 옛 GLB·대체 상자면 null 로 남는다
    let burgerMounted = null;
    let lastAmrXY = null;        // 지난 틱의 자리(base mm) — 이번 틱과의 차가 굴러간 거리다
    loadBurger().then((proto) => {
      if (disposed || !proto) return;
      // **축·정면 정렬은 `burger.js` 가 한다** — 여기서 오일러를 만지지 않는다.
      // 그 한 줄을 여기서 짜다가 90° 틀렸다 (2026-08-28 · 카트를 봤다).
      // 나온 그룹은 **정면이 +x** 라, 아래 틱은 `rotation.z = yaw` 만 넣으면 된다.
      amrNode.remove(amrBody);
      amrBody.geometry.dispose();
      amrMats.length = 0;
      const mounted = mountBurgerZUpXForward(proto.clone(true));
      mounted.traverse(ownMat);
      amrNode.add(mounted);
      burgerMounted = mounted;  // 바퀴 굴리기(아래 틱)가 이 안에서 `wheel_*` 노드를 찾는다
      lastAmrKey = ' ';        // 재질이 바뀌었으니 다음 틱이 고스트 상태를 다시 칠하게 한다
    });
    // ── 추적선 — **화면에서만 따라간다.** 실기에는 한 줄도 안 보낸다.
    //
    // 손끝에서 터틀봇까지 선을 긋고, 닿는 거리 안이면 초록·밖이면 주황으로 칠한다.
    // 이건 연출이 아니라 **자(尺)** 다 — 터틀봇이 「자기가 있다고 말하는 자리」를 향해
    // 긋는 선이므로, 카메라로 본 실제 자리와 어긋난 만큼이 **드리프트로 눈에 보인다.**
    // 그 숫자가 아직 없어서 실기 추적을 안 켠다 (`GAP-MATRIX` 최대 관문).
    //
    // ⚠ **손끝 좌표는 user1 기준이다** (D87). 반드시 `toFrame` 을 거친다.
    const trackMat = new THREE.LineBasicMaterial({ color: 0x2e9e5b, transparent: true, opacity: 0.9 });
    const trackGeo = new THREE.BufferGeometry();
    trackGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const trackLine = new THREE.Line(trackGeo, trackMat);
    trackLine.visible = false;
    zUpToYUp.add(trackLine);
    // 표적 고리 — 터틀봇 발치에 눕혀 둔다. 선만 있으면 어디를 가리키는지 끝점이 안 보인다
    const trackRing = new THREE.Mesh(
      new THREE.RingGeometry(mm(110), mm(135), 32),
      new THREE.MeshBasicMaterial({ color: 0x2e9e5b, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    trackRing.visible = false;
    zUpToYUp.add(trackRing);
    let lastTrackKey = ' ';
    let aimAt = null;         // 이번 틱에 겨눌 점 (홀더 좌표 · 미터)
    let lastAimKey = ' ';
    // 시선 화살 — **카메라가 어디를 보는가.** 손끝 자리만 맞추는 솔버(`reach.js`)는 방향을
    // 안 푸므로, 자리는 맞는데 **카메라가 벽을 볼 수 있다**(실기 담당자 지적 2026-08-28).
    // 그래서 방향을 숫자로 감추지 않고 **그려서 보인다.** 공구축은 `tcp` 노드의 local **+Y**
    // 다 (`frame-axes.js` §TCP). 노드가 조립좌표계(scale 0.001) 안이라 스케일을 되돌린다.
    // ── 시야 발자국 — **카메라가 판 위 어디를 보고 있나.**
    //
    // 팔을 움직이지 않는다. 대신 지금 자세에서 카메라 시야를 판 평면에 잘라 **사각형**으로
    // 그린다. 터틀봇이 그 안에 있으면 초록, 벗어나면 회색 — 「보이나」에 눈으로 답한다.
    // 이것이 실기 추종의 전제다: 자세는 사람이 잡고 시스템은 **판정만** 한다 (`follow.py`).
    const fovMat = new THREE.LineBasicMaterial({ color: 0x2e9e5b, transparent: true, opacity: 0.9 });
    const fovGeo = new THREE.BufferGeometry();
    fovGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    const fovLoop = new THREE.LineLoop(fovGeo, fovMat);
    fovLoop.visible = false;
    zUpToYUp.add(fovLoop);
    let lastFovKey = ' ';
    const camPos = new THREE.Vector3();
    const dirV = new THREE.Vector3();
    const hitV = new THREE.Vector3();

    // ── 자취 — 주행 기록이 남긴 길을 판 위에 선으로. **실측이 지나간 자리다.**
    // 되감기를 끄면 사라진다 — 옛 길이 남아 「지금 저 길로 간다」로 읽히면 안 된다.
    const trailMat = new THREE.LineBasicMaterial({ color: 0x7a5cc4, transparent: true, opacity: 0.85 });
    let trailLine = null;
    let lastTrailKey = ' ';

    let sightLine = null;
    const attachSight = (gripGroup) => {
      const tcpNode = gripGroup?.getObjectByName?.('tcp');
      if (!tcpNode) return null;
      const g = new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, mm(SIGHT_MM), 0)],
      );
      const l = new THREE.Line(g, new THREE.LineDashedMaterial({
        color: 0x2f6fd0, dashSize: mm(20), gapSize: mm(12), transparent: true, opacity: 0.85,
      }));
      l.computeLineDistances();
      tcpNode.updateWorldMatrix(true, false);
      const sc = tcpNode.getWorldScale(new THREE.Vector3());
      const avg = (sc.x + sc.y + sc.z) / 3;
      if (avg > 0 && Math.abs(avg - 1) > 1e-9) l.scale.setScalar(1 / avg);
      tcpNode.add(l);
      return l;
    };

    let lastAmrKey = ' ';

    let robot = null;
    let gripMount = null;
    let axes = null;      // 프레임 축 — 켜기 전에는 아무것도 안 만든다 (SHARED-CORE §2)
    let disposed = false;
    const { gripper } = loadConfig();
    loadRobot({
      urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf',
      gripperCfg: gripper,
      gripperDir: '/PGEA_100_40/',
    }).then((r) => {
      if (disposed) return;
      robot = r.robot;
      gripMount = r.gripperGroup ?? null;
      // **URDF 원점(장착면) ≠ 컨트롤러 원점(어깨).** 화면은 게이트와 같은 컨트롤러 기준으로
      // 그리므로 로봇만 152mm 내린다 — 안 내리면 카트 위에 떠 있다 (`workcell.js` 참조).
      robot.position.z = mm(URDF_BASE_Z_MM);   // 실측상 0 — 근거는 workcell.js
      zUpToYUp.add(robot);
      // 프레임 축 — **계측 전용·기본 꺼짐.** 화면 스위치는 셋(베이스·사용자1·손끝)뿐이고,
      // 링크별 축은 개발 콘솔에 남긴다 — 목록이 열 개가 되면 아무도 안 쓴다.
      //   `__twin.axes.show('*')` 전부 · `__twin.axes.show('wrist3_link')` 하나 · `show(null)` 끔
      //   이름 목록은 `__twin.axes.names`
      axes = createFrameAxes({ robot, gripperGroup: gripMount });
      if (import.meta.env.DEV) window.__twin = { ...(window.__twin ?? {}), robot, gripMount, axes };
      host.dataset.ready = '1';                            // 실렌더 검증이 이 깃발을 본다
    }).catch((e) => { host.dataset.error = String(e.message || e); });

    // 고스트 로봇 — 두 번째 URDF 인스턴스. **미리보기를 볼 때 실물 현재 자세를 반투명으로**
    // 겹쳐, 실기를 안 쳐다봐도 "지금 어디 ↔ 가면 어디"를 한 화면에서 본다 (2026-08-07 요청).
    // 재료를 **복제**해 반투명으로 만든다 — 공유하면 본체 로봇까지 비쳐 버린다.
    let ghost = null;
    let ghostGrip = null;
    const ghostPaintTimers = [];
    loadRobot({
      urdfUrl: '/FAIRINO_FR5/fairino5_v6.urdf',
      gripperCfg: gripper,
      gripperDir: '/PGEA_100_40/',
    }).then((r) => {
      if (disposed) return;
      ghost = r.robot;
      ghostGrip = r.gripperGroup ?? null;
      ghost.position.z = mm(URDF_BASE_Z_MM);
      ghost.visible = false;
      // 고스트를 **파랑 반투명**으로 — 흰 로봇 위에 흰 로봇을 얹으면 투명도만으론 구분이 안 된다
      // (2026-08-07 실기 확인: "메시가 똑같이 생겼어"). 팔레트의 '실물 없는 팔 = 파랑'을 그대로
      // 쓴다(layout-view `C.virtual` 0x4a90d9). 텍스처·금속성을 지워야 파랑이 안 묻힌다.
      const GHOST = new THREE.Color(0x4a90d9);
      const dim = (m) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.5;
        c.depthWrite = false;
        if (c.color) c.color = GHOST.clone();
        if ('emissive' in c) c.emissive = GHOST.clone().multiplyScalar(0.25);
        if ('metalness' in c) c.metalness = 0;   // PBR 반사가 파랑을 하얗게 덮는 걸 막는다
        if ('map' in c) c.map = null;             // 흰 텍스처를 지워 단색 홀로그램으로
        c.needsUpdate = true;
        return c;
      };
      // ⛔ **한 번만 칠하면 늦게 붙는 메시가 하얗게 남는다** (2026-09-04 · 실기 담당자
      // *"같은 재질로 보여서 헷갈림"*). `robot.js` 의 `IDLE_MS` 가 팔 STL 은 잡아 주지만
      // 그리퍼는 우리 코드가 나중에 붙이고, 브래킷도 그렇다 — 그러면 파란 팔에 **흰 손**이
      // 달려 실물과 구분이 안 된다. 이미 칠한 재질은 표시해 두고 **새 것만 다시 칠한다.**
      const paint = () => {
        let n = 0;
        ghost.traverse((o) => {
          if (!o.isMesh || !o.material || o.userData.__ghosted) return;
          o.material = Array.isArray(o.material) ? o.material.map(dim) : dim(o.material);
          o.userData.__ghosted = true;
          n += 1;
        });
        return n;
      };
      paint();
      // 늦게 오는 것들을 두 번 더 훑는다 — 공짜에 가깝고(대개 0개) 놓치면 눈이 속는다
      const late = [setTimeout(paint, 400), setTimeout(paint, 1600)];
      ghostPaintTimers.push(...late);
      zUpToYUp.add(ghost);
      // 진단 훅 — **개발 서버에서만.** 고스트가 정말 다 물들었는지는 씬을 열어야 알 수 있고,
      // React 안에 갇혀 있으면 콘솔에서 셀 방법이 없다 (2026-08-10 에 이걸로 원인을 찾았다).
      sightLine = attachSight(ghostGrip);
      // ⛔ **배포본에서도 연다** (2026-09-04). `DEV` 로 막아 뒀더니 실기에서 「파란 게 안
      // 보인다」를 콘솔로도 못 갈랐다 — 고스트가 안 뜬 건지 로드가 죽은 건지 알 길이 없었다.
      window.__twin = { ...(window.__twin ?? {}), ghost, ghostGrip, ghostError: null };
    }).catch((e) => {
      // ⛔ **조용히 삼키지 않는다** (2026-09-04). 전에는 `catch(() => {})` 라 고스트 로드가
      // 죽어도 화면이 멀쩡해 보였고, 사람은 「스위치를 잘못 눌렀나」를 먼저 의심했다.
      // 본체 트윈은 살아 있으니 화면을 죽이진 않되, **사유는 반드시 남긴다.**
      const msg = String(e?.message || e);
      host.dataset.ghostError = msg;
      window.__twin = { ...(window.__twin ?? {}), ghost: null, ghostError: msg };
    });

    // ── 사용자 좌표계 축 — 실기 `coordDefs.user` 가 올 때만 세운다 ──────────────
    //
    // **화면의 손끝 숫자가 재어지는 원점**이다(D87 — 이걸 베이스로 읽어 하루를 잃었다).
    // 실측 `(−401.8, +497.3, +342.1)` 만큼 떨어져 있고 **회전이 0** 이라 축 방향은 베이스와
    // 같다 — 값은 방향이 아니라 **떨어진 거리**에 있으므로 두 원점을 선으로 잇는다.
    //
    // ⚠ `toBase()` 와 **같은 문턱**을 쓴다: 회전이 0.5° 를 넘으면 세우지 않는다. 그쪽이
    //    판정면을 안 그리는 조건과 갈리면, 축은 서 있는데 게이트는 꺼진 화면이 된다.
    //    돌아간 사용자 좌표계에서는 **축이 안 뜨는 것이 신호다.**
    let userNode = null;
    let userLine = null;
    let lastUserKey = ' ';
    let lastAxesKey = ' ';
    const syncUser = () => {
      // ⚠ **로봇보다 먼저 좌표계가 올 수 있다.** 여기서 걸러 두지 않으면 첫 틱에 키만 기록되고
      //    로봇이 온 뒤에는 「같은 키」로 읽혀 `user1` 이 **영영 안 세워진다.**
      if (!robot) return;
      const d = userDefRef.current;
      const ok = Array.isArray(d) && d.length >= 6
        && d.slice(0, 3).every((v) => Number.isFinite(Number(v)))
        && Math.max(...d.slice(3, 6).map((v) => Math.abs(Number(v)))) <= 0.5;
      const key = ok ? d.slice(0, 3).join(',') : '';
      if (key === lastUserKey) return;
      const had = !!userNode;
      lastUserKey = key;
      if (userNode) { userNode.removeFromParent(); userNode = null; userLine = null; }
      if (!ok) { if (had) rebuildAxes(); return; }   // 없어졌을 때만 다시 만든다
      userNode = new THREE.Object3D();
      userNode.name = 'user1';
      userNode.position.set(mm(Number(d[0])), mm(Number(d[1])), mm(Number(d[2])));
      // 베이스 원점(로컬로는 −자기위치)까지 잇는 선. 고스트와 같은 파랑을 쓴다
      userLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-userNode.position.x, -userNode.position.y, -userNode.position.z),
          new THREE.Vector3(0, 0, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0x4a90d9, depthTest: false, transparent: true }),
      );
      userLine.renderOrder = 998;
      userLine.visible = false;
      userNode.add(userLine);
      robot.add(userNode);
      rebuildAxes();
    };
    // `createFrameAxes` 는 만들 때 호스트를 한 번 센다 — 나중에 붙은 `user1` 을 태우려면
    // 다시 만들어야 한다. 켜기 전에는 아무것도 안 만드는 물건이라 다시 만드는 값이 싸다.
    const rebuildAxes = () => {
      if (!robot) return;
      axes?.dispose();
      axes = createFrameAxes({ robot, gripperGroup: gripMount });
      lastAxesKey = ' ';                        // 선택을 다시 걸어야 한다
      if (import.meta.env.DEV) window.__twin = { ...(window.__twin ?? {}), axes };
    };

    const tick = () => {
      if (wsRef.current !== lastWs) { lastWs = wsRef.current; drawCell(lastWs); }
      // 터틀봇 — **홈에서 얼마나 갔나**를 얹는다. 브리지 pose 의 원점이 곧 홈이다
      // (홈에서 브링업하므로 · 실기 담당자 2026-08-28 「항상 홈에서 시작」).
      //
      // ⚠ **홈의 요각이 실측이 아니다** (`AMR_HOME.deg` 는 가정 0). 그래서 회전 합성을
      // 여기서 만들지 않고 **더하기만** 한다 — 요각을 재는 날 `AMR_HOME.deg` 한 값만 고치면
      // 이 식이 그대로 맞는다. 지금 0 이 아닌 값을 넣으면 그 가정이 코드로 굳는다.
      const a = amrRef.current;
      // 터틀봇 자세는 **odom 기준**이다 — 홈에서 얼마나 갔나. 그걸 베이스로 옮기는 일은
      // **`frames.js` 한 곳**이 한다 (`FRAMES.md`). 여기서 홈을 더하거나 축을 돌리지 않는다.
      //
      // ⚠ **odom 은 자리만이 아니라 축도 돈다** — 브링업 순간의 자세가 기준축이라
      // odom `+x` 는 user1 `−x`(작업대2 쪽)다. 손으로 더하다가 전진이 반대로 그려졌다.
      //
      // `null` 이면 **안 그린다** (규약 3) — 사용자 좌표계가 없거나(미연결) 0.5° 넘게 돌았을 때다.
      // 판정면이 같은 조건에서 안 그려지는 것과 같은 규칙이다.
      const live = { user1: userDefRef.current };
      const at = toFrame({ xMm: a?.xMm ?? 0, yMm: a?.yMm ?? 0, zMm: 0 }, 'odom', 'base', live);
      const yaw = yawToFrame(a?.thetaDeg ?? 0, 'odom', 'base', live);
      // **실측 여부를 key 에 넣는다** — 실기 자세가 우연히 홈과 같아도 고스트가 안 벗겨지면
      // 「확인된 자리」와 「가정한 자리」가 화면에서 같아진다.
      // 거치대 — 좌표계가 생기면 세운다. **매 틱 다시 판정한다**(연결이 늦게 와도 살아난다)
      if (carrierNode) {
        const g2 = CARRIER_GRASP_TRUTH.tcpMmDeg;
        const held = heldRef.current;
        // **들려 있으면 손끝을 따라간다.** 파지 순간의 손끝은 판 윗면보다
        // `g2[2] − topZ` 만큼 높았으므로, 그 차를 빼면 거치대 바닥이 손끝 아래 그 자리에 온다.
        // ⛔ 두 군데에 동시에 그리지 않는다 — 판 위와 손 안에 같이 있으면 어느 게 진짜인지 모른다.
        const lift = CARRIER_GRASP_TRUTH.tcpAboveTableMm;   // 실측 14.9 — 안전선 상판과의 차(옛 식)는 10mm 낮게 그렸다 (2026-09-06)
        // ⛔ **파지점은 벽이지 중심이 아니다.** 미는 식은 **`props.carrierBodyOffset` 한 곳**이
        // 든다 — 여기와 시뮬에 각각 적었다가 한쪽만 고쳐 8mm 어긋난 적이 있다 (2026-08-31).
        const { dxMm: ox, dyMm: oy } = carrierBodyOffset(g2[5]);
        // 주인은 하나다 — **들려 있으면 손 · 아니면 지금 본 자리 · 둘 다 없으면 안 그린다.**
        const seen = atRef.current;
        // **손에 들려 있으면 고스트의 손끝 노드에서 잰다** (2026-09-06). 팔은 관절 보간으로 그리는데 `held` 숫자는 직선 보간이라
        // 칸 중간에서 거치대가 손가락 옆으로 빠져 보였다. 손끝 노드(`tcp` · 컨트롤러 툴 프레임과 같은 뜻)의 자리·요각을 그대로 쓰면
        // 팔이 어떻게 보간되든 거치대는 손에 붙어 있다. 손목이 파지 때보다 돈 만큼 몸통 오프셋과 요각도 같이 돈다.
        let hand = null;
        // 고스트 손끝(FK) — 고스트가 그려지는 동안 늘 잰다(계측 훅 `__ghostTcpMm` 은 손에 안 들렸을 때도 게이트가 「손끝-거치대 거리」를 재는 재료다)
        const gj0 = ghostJointsRef.current;
        const tcpNode = ghost && Array.isArray(gj0) && gj0.length >= 6 ? ghost.getObjectByName('tcp') : null;
        let yawNow = null;
        if (tcpNode) {
          setJointsDeg(ghost, { j1: gj0[0], j2: gj0[1], j3: gj0[2], j4: gj0[3], j5: gj0[4], j6: gj0[5] });
          ghost.updateMatrixWorld(true);
          const wp = zUpToYUp.worldToLocal(tcpNode.getWorldPosition(new THREE.Vector3()));          // base · m · z-up
          const ql = zUpToYUp.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(tcpNode.getWorldQuaternion(new THREE.Quaternion()));
          const xa = new THREE.Vector3(1, 0, 0).applyQuaternion(ql);                                 // 툴 x축의 베이스 요각 = rz
          yawNow = Math.atan2(xa.y, xa.x);
          window.__ghostTcpMm = { x: wp.x * 1000, y: wp.y * 1000, z: wp.z * 1000, headingDeg: (yawNow * 180) / Math.PI };
          window.__ghostTcpMm.wp = wp;
        } else if (window.__ghostTcpMm) window.__ghostTcpMm = null;
        if (tcpNode && held && inHandRef.current) {
          const wp = window.__ghostTcpMm.wp;
          const yawGrasp = (yawToFrame(g2[5], 'user1', 'base', live) * Math.PI) / 180;
          const dYaw = Math.atan2(Math.sin(yawNow - yawGrasp), Math.cos(yawNow - yawGrasp));
          const tu = toFrame({ xMm: wp.x * 1000, yMm: wp.y * 1000, zMm: wp.z * 1000 }, 'base', 'user1', live);
          if (tu) {
            const c = Math.cos(dYaw); const s = Math.sin(dYaw);
            hand = { xMm: tu.xMm + ox * c - oy * s, yMm: tu.yMm + ox * s + oy * c, zMm: tu.zMm - lift, dYaw };
          }
        }
        // 판 위 실측이면 검출 요각을 더한다(손에 들리면 손목이 돈 만큼만). 요각은 user1 기준이고 user1 은 회전 0 이라 그대로 라디안으로
        const seenYaw = !hand && !held && seen && Number.isFinite(yawRef.current) ? (yawRef.current * Math.PI) / 180 : 0;
        carrierNode.rotation.z = (carrierNode.userData.yaw0 ?? carrierNode.rotation.z) + (hand?.dYaw ?? 0) + seenYaw;
        carrierNode.userData.paint?.(Boolean(seen) && !hand && !held);
        const src = hand ? { xMm: hand.xMm, yMm: hand.yMm, zMm: hand.zMm } : held
          ? { xMm: held[0] + ox, yMm: held[1] + oy, zMm: held[2] - lift }
          // ⚠ 검출은 **윗면 중심**이라 키를 빼야 바닥이 된다(노드 원점이 바닥이다).
          //    그리고 여기엔 `carrierBodyOffset` 을 **안 쓴다** — 그 보정은 「파지점이 벽이라
          //    중심이 아니다」를 메우는 값인데, 색 검출은 처음부터 중심을 준다.
          : seen ? { xMm: seen[0], yMm: seen[1], zMm: seen[2] - CARRIER.hMm }
            : null;
        carrierNode.visible = false;
        const cp = src ? toFrame(src, 'user1', 'base', live) : null;
        carrierNode.visible = cp !== null;
        if (cp) carrierNode.position.set(mm(cp.xMm), mm(cp.yMm), mm(cp.zMm));
        // 계측 훅 — 거치대가 어디에(base mm) · 무엇을 따라(hand/number/seen) 서 있나. 게이트가 「손에 붙어 있나」를 잰다
        window.__carrierMm = cp ? { paint: carrierNode.userData.painted ? 'pink' : 'grey', x: cp.xMm, y: cp.yMm, z: cp.zMm, src: hand ? 'hand' : (held ? 'number' : 'seen'), yawDeg: (carrierNode.rotation.z * 180) / Math.PI } : null;
      }
      // 도착 오차 유령 — 시연이 준 자리에만 선다. 명령 자리와의 거리를 계측 훅으로 낸다
      const dp = driftRef.current;
      const dAt = dp ? toFrame({ xMm: dp.xMm, yMm: dp.yMm, zMm: 0 }, 'odom', 'base', live) : null;
      const dYaw = dp ? yawToFrame(dp.thetaDeg ?? 0, 'odom', 'base', live) : null;
      driftGroup.visible = Boolean(dAt && dYaw !== null && at);
      if (driftGroup.visible) {
        driftGroup.position.set(mm(dAt.xMm), mm(dAt.yMm), mm(dAt.zMm));
        driftGroup.rotation.z = (dYaw * Math.PI) / 180;
        window.__amrDriftMm = Math.hypot(dAt.xMm - at.xMm, dAt.yMm - at.yMm);
      } else if (window.__amrDriftMm !== undefined) window.__amrDriftMm = null;
      // 홈 두 후보 — 되감기·시연 중에만. 좌표계가 없으면 못 옮기므로 안 그린다(규약 3)
      homeLines.forEach((l, i) => {
        const h = HOME_CANDIDATES[i];
        const hb = replayRef.current ? toFrame({ xMm: h.xMm, yMm: h.yMm, zMm: AMR_HOME.topZMm }, 'user1', 'base', live) : null;
        l.visible = hb !== null;
        if (hb) { l.position.set(mm(hb.xMm), mm(hb.yMm), mm(hb.zMm) + 0.002); l.rotation.z = (h.yawDeg * Math.PI) / 180; }
      });
      window.__amrHomeCandidates = homeLines.filter((l) => l.visible).length;
      const key = at ? `${a ? 'L' : 'G'}|${at.xMm},${at.yMm},${at.zMm},${yaw}` : '-';
      if (key !== lastAmrKey) {
        lastAmrKey = key;
        amrNode.visible = at !== null && yaw !== null;
        if (amrNode.visible) {
          // 바퀴 — **굴러간 거리만큼** 돈다 (반지름 33 · `catalog.js`). 앞뒤는 요각 방향과의 내적으로 가른다.
          // 자리가 뛰면(리플레이 스크럽·홈 리셋) 그만큼 한 번에 돈다 — 화면이 「미끄러졌다」고 말하지 않게
          if (burgerMounted && lastAmrXY) {
            const th = (yaw * Math.PI) / 180;
            const signed = (at.xMm - lastAmrXY[0]) * Math.cos(th) + (at.yMm - lastAmrXY[1]) * Math.sin(th);
            if (rollWheels(burgerMounted, signed)) {
              // 계측 훅 — 게이트(`scripts/check/sim-tab.mjs`)가 「굴러간 거리 ÷ 33 만큼 돌았나」를 읽는다
              window.__amrWheelRad = burgerMounted.getObjectByName('wheel_left')?.rotation.z ?? null;
            }
          }
          lastAmrXY = [at.xMm, at.yMm];
          amrNode.position.set(mm(at.xMm), mm(at.yMm), mm(at.zMm));
          // 모델 정면은 `burger.js` 가 이미 +x 로 맞춰 왔다 — 여기는 요각만 넣는다
          amrNode.rotation.z = (yaw * Math.PI) / 180;
          // 실기 자세가 없거나(가정) **되감는 중이면**(기록) 반투명이다 — 둘 다 「지금 실물」이 아니다
          setAmrGhost(!a || replayRef.current);
        }
      }

      // ── 손끝을 베이스로. ⚠ **실기 `tcpMmDeg` 는 user1 기준이다** (D87)
      // 가상 손끝이 있으면 그것이 이긴다 — **시뮬 자세로 두면 무엇이 보이나**를 답한다
      const tcpU = simTcpRef.current ?? tcpRef.current;
      const tcpB = Array.isArray(tcpU) && tcpU.length >= 3
        ? toFrame({ xMm: tcpU[0], yMm: tcpU[1], zMm: tcpU[2] }, 'user1', 'base', live)
        : null;
      // ── 추적선 갱신
      const tKey = tcpB && at ? `${tcpB.xMm.toFixed(1)},${tcpB.yMm.toFixed(1)},${tcpB.zMm.toFixed(1)}|${at.xMm.toFixed(1)},${at.yMm.toFixed(1)}` : '-';
      if (tKey !== lastTrackKey) {
        lastTrackKey = tKey;
        const on = Boolean(tcpB && at && amrNode.visible);
        trackLine.visible = on;
        trackRing.visible = on;
        if (on) {
          const p = trackGeo.getAttribute('position');
          p.setXYZ(0, mm(tcpB.xMm), mm(tcpB.yMm), mm(tcpB.zMm));
          // 선의 먼 끝은 **팔이 겨누는 그 점**이다 — 둘이 갈리면 선이 거짓말한다
          p.setXYZ(1, mm(at.xMm), mm(at.yMm), mm(at.zMm + AMR_MM.heightMm + PREVIEW_STANDOFF_MM));
          p.needsUpdate = true;
          trackGeo.computeBoundingSphere();
          trackRing.position.set(mm(at.xMm), mm(at.yMm), mm(at.zMm) + 0.002);
          // **닿나** — 손끝까지가 아니라 **베이스에서** 잰다. 도달거리는 베이스 기준 사양이다
          const d = Math.hypot(at.xMm, at.yMm, at.zMm + AMR_MM.heightMm + PREVIEW_STANDOFF_MM);
          const col = d <= REACH_MM ? 0x2e9e5b : 0xd08432;
          trackMat.color.setHex(col);
          trackRing.material.color.setHex(col);
        }
      }
      // 겨눌 곳 — **터틀봇 윗면에서 안전 높이만큼 떠서** 내려다본다.
      //
      // ⛔ 한때 몸 한가운데를 겨눴는데(2026-08-28), 그러면 그리퍼가 로봇 **안으로** 들어간다.
      // 계약이 추종을 *"안전 높이를 유지하며 따라만 간다"* 로 정의한다
      // (`VISION-CONTRACT.md` §추종 · D132) — 닿는 동작이 아니라 **따라가는** 동작이다.
      // **높이는 지금 그대로 두고 터틀봇 바로 위로만 미끄러진다** (실기 담당자 2026-08-28).
      //
      // 왜 내려가지 않나 — 실기 추종(`follow.py`)이 **평행이동만** 한다. 손목 방향은 풀지 않고
      // *"수직에서 N° 기울었다"* 로 **검사만** 하고 넘는다. 즉 자세는 사람이 잡아 두는 것이고,
      // 추종은 그 자세를 유지한 채 따라가는 것이다. 화면도 같은 규칙을 쓴다.
      //
      // 내려가면 잃는 것도 있다 — 카메라가 가까워질수록 보는 범위가 좁아져 **움직이는 로봇을
      // 놓친다.** 관찰이 목적이면 높은 자리가 낫다.
      // 바닥으로는 안 내려간다 — 터틀봇 윗면 + 안전높이가 하한이다.
      const floorZ = at ? at.zMm + AMR_MM.heightMm + PREVIEW_STANDOFF_MM : 0;
      aimAt = at && tcpB
        ? new THREE.Vector3(mm(at.xMm), mm(at.yMm), mm(Math.max(tcpB.zMm, floorZ)))
        : null;
      syncUser();
      if (axes) {
        const key = (axesRef.current ?? []).join(',');
        if (key !== lastAxesKey) {
          lastAxesKey = key;
          axes.show(key ? key.split(',') : null);
          if (userLine) userLine.visible = key.split(',').includes('user1');
        }
      }
      if (robot) {
        const j = jointsRef.current;
        setJointsDeg(robot, { j1: j[0], j2: j[1], j3: j[2], j4: j[3], j5: j[4], j6: j[5] });
        setEndLed(robot, ledRef.current);
        setGripperOpenPct(gripMount, gripRef.current, gripper.fingerHalfStrokeMm);
      }
      // ── 자취 갱신 — 샘플이 바뀐 때만 다시 만든다 (매 프레임 지오메트리를 새로 만들지 않는다)
      const tr = trailRef.current;
      const trKey = tr ? `${tr.length}|${tr[0]?.tSec}|${tr[tr.length - 1]?.tSec}` : '-';
      if (trKey !== lastTrailKey) {
        lastTrailKey = trKey;
        if (trailLine) { trailLine.removeFromParent(); trailLine.geometry.dispose(); trailLine = null; }
        // 프레임 변환은 `frames.js` 한 곳 — 여기서 홈을 더하거나 축을 돌리지 않는다
        const pts = (tr ?? []).map((s2p) => toFrame(
          { xMm: s2p.xMm, yMm: s2p.yMm, zMm: 0 }, 'odom', 'base', live,
        )).filter(Boolean);
        if (pts.length >= 2) {
          const g = new THREE.BufferGeometry().setFromPoints(
            pts.map((p2) => new THREE.Vector3(mm(p2.xMm), mm(p2.yMm), mm(p2.zMm) + 0.004)),
          );
          trailLine = new THREE.Line(g, trailMat);
          zUpToYUp.add(trailLine);
        }
      }

      // ── 시야 발자국 갱신
      const he = heRef.current?.tMm;
      if (Array.isArray(he) && he.length >= 3 && Array.isArray(tcpU) && tcpU.length >= 6 && tcpB && at) {
        // 카메라 원점 — `follow.py` 의 `P = R·(C + t) + p` 에서 C=0 인 자리다.
        // **hand-eye 는 손끝 프레임 오프셋**이고 카메라 축은 손끝 축과 나란하다.
        const R = rotFixedXYZ(tcpU[3], tcpU[4], tcpU[5]);
        camPos.set(he[0], he[1], he[2]).applyMatrix4(R).add(new THREE.Vector3(tcpU[0], tcpU[1], tcpU[2]));
        const camB = toFrame({ xMm: camPos.x, yMm: camPos.y, zMm: camPos.z }, 'user1', 'base', live);
        const planeZ = at.zMm;                    // 판 상판 (터틀봇이 서 있는 면)
        const D = Math.PI / 180;
        const th = Math.tan((CAM_FOV.hDeg / 2) * D);
        const tv = Math.tan((CAM_FOV.vDeg / 2) * D);
        // 카메라 프레임 — x 오른쪽 · y 아래 · **z 앞**(화면이 적은 「접근 방향 +Z」와 같은 축)
        const quad = [];
        for (const [u, v] of [[-th, -tv], [th, -tv], [th, tv], [-th, tv]]) {
          dirV.set(u, v, 1).transformDirection(R);
          // 판을 아래로 내려다볼 때만 만난다. 위를 보면 발자국이 없다 — 그게 사실이다
          const t = dirV.z < -1e-6 ? (planeZ - camB.zMm) / dirV.z : -1;
          if (t <= 0 || t > 4000) { quad.length = 0; break; }
          hitV.copy(dirV).multiplyScalar(t).add(new THREE.Vector3(camB.xMm, camB.yMm, camB.zMm));
          quad.push([hitV.x, hitV.y]);
        }
        const key = quad.length === 4 ? quad.map((q) => q.map(Math.round).join()).join('|') : '-';
        if (key !== lastFovKey) {
          lastFovKey = key;
          fovLoop.visible = quad.length === 4;
          if (fovLoop.visible) {
            const pa = fovGeo.getAttribute('position');
            quad.forEach(([x, y], i) => pa.setXYZ(i, mm(x), mm(y), mm(planeZ) + 0.003));
            pa.needsUpdate = true;
            fovGeo.computeBoundingSphere();
            // 터틀봇이 그 안에 있나 — 다각형 내부 판정(광선 교차 홀짝)
            let inside = false;
            for (let i = 0, j = 3; i < 4; j = i, i += 1) {
              const [xi, yi] = quad[i]; const [xj, yj] = quad[j];
              if ((yi > at.yMm) !== (yj > at.yMm)
                && at.xMm < ((xj - xi) * (at.yMm - yi)) / (yj - yi) + xi) inside = !inside;
            }
            // **깊이도 본다** (2026-09-06 · `GRILL-conveyor-twin` #11). 발자국 안이어도 라이다 윗면이 렌즈에서
            // Min-Z(195) 안이면 뎁스가 죽고, 상한(1000) 밖이면 못 믿는다 — 광축(카메라 +z) 방향 거리로 잰다.
            // 바구니 위에서 팔은 라이다보다 **낮게** 내려가므로 싣는 동안은 「뒤」가 나온다 — 그게 사실이다.
            dirV.set(0, 0, 1).transformDirection(R);
            const depthMm = (at.xMm - camB.xMm) * dirV.x + (at.yMm - camB.yMm) * dirV.y
              + (at.zMm + AMR_MM.heightMm - camB.zMm) * dirV.z;
            const depthOk = depthMm >= DEPTH_USEFUL_MM.minZMm && depthMm <= DEPTH_USEFUL_MM.farMm;
            const seen = inside && depthOk;
            fovMat.color.setHex(seen ? 0x2e9e5b : 0x9aa0a6);
            // 계측 훅 — 게이트가 「왜 안 보이나」까지 읽는다
            window.__depthSees = {
              ok: seen, inside, depthMm: Math.round(depthMm),
              // 사유는 깊이가 먼저다 — 너무 가까우면 발자국 안이어도 못 보고, 그게 더 근본 원인이다
              why: seen ? null
                : depthMm <= 0 ? '카메라 뒤'
                  : depthMm < DEPTH_USEFUL_MM.minZMm ? `너무 가깝다 ${Math.round(depthMm)} < ${DEPTH_USEFUL_MM.minZMm}`
                    : depthMm > DEPTH_USEFUL_MM.farMm ? `너무 멀다 ${Math.round(depthMm)} > ${DEPTH_USEFUL_MM.farMm}`
                      : '발자국 밖',
            };
          }
        }
      } else if (fovLoop.visible) { fovLoop.visible = false; lastFovKey = ' '; window.__depthSees = null; }
      if (!fovLoop.visible && window.__depthSees) window.__depthSees = null;   // 발자국이 없으면 판정도 없다 — 옛 값이 남아 게이트가 믿는 것을 막는다 (감사 F5)

      if (ghost) {
        // 고스트는 **교시 자세 미리보기 전용**으로 되돌렸다 (2026-08-28).
        // 한때 여기서 관절을 풀어 터틀봇을 겨눴는데, 솔버가 **손끝 자리만** 맞추고 방향은
        // 안 풀어 **카메라가 벽을 봤다**(실기 담당자 지적 · 시선 화살이 그걸 보여줬다).
        // 실기 추종(`follow.py`)도 방향을 풀지 않고 **검사만** 한다 — 자세는 사람이 잡는다.
        // 그래서 화면도 팔을 움직이지 않고, 대신 아래 §시야 발자국으로 **보이나**를 답한다.
        const gj = ghostJointsRef.current;
        ghost.visible = Array.isArray(gj) && gj.length >= 6;
        if (ghost.visible) {
          setJointsDeg(ghost, { j1: gj[0], j2: gj[1], j3: gj[2], j4: gj[3], j5: gj[4], j6: gj[5] });
          setGripperOpenPct(ghostGrip, ghostGripRef.current, gripper.fingerHalfStrokeMm);
        }
      }
    };
    stage.onTick(tick);   // 궤도 갱신·렌더는 무대가 한다

    return () => {
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      ghostPaintTimers.forEach(clearTimeout);
      disposed = true;
      axes?.dispose();
      stage.dispose();
      host.replaceChildren();
    };
  }, []);

  return <div className="twin" data-t="twin" ref={hostRef} style={pickCarrier ? { cursor: 'crosshair' } : undefined} data-pick={String(!!pickCarrier)} />;
}
