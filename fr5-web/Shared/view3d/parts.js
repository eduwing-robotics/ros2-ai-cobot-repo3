// 실험실 내부 부품 카탈로그 — **실물색 화이트 모형.**
//
// 출발은 `pascalorg/editor` 의 컷어웨이 백색 모형이었다 — 텍스처 없이 디테일이 **형태**에서
// 오는 건 그대로다. 2026-09-01 에 규약을 한 번 바꿨다(주인님 판정 · 전면 교체): **실물이
// 있는 부품은 실물 색을 입는다.** 실험실 환경(테이블·스탠드·카트)은 실물도 백색이라
// 화이트 모형과 겹치고, 갈라지는 건 소품 셋 — 거치대(유광 검정 3D프린트)·바구니(진초록
// 펠트)·총알(황동)이다. 색값은 실사진에서 화이트밸런스 보정 후 실측했다
// (`docs/evidence/2026-09-01/real-color-palette.md`). 텍스처는 여전히 안 쓴다.
//
// **조립 규약** — 팩토리는 전부 이 계약을 지킨다:
//   · 입력은 **밀리미터**. 배치안과 같은 단위다 (하드 룰 5)
//   · 원점은 **바닥 중앙**. 그래야 `y=0` 에 놓기만 하면 선다
//   · 반환은 `THREE.Group`. 재질은 공유본을 쓴다 (드로우콜·메모리)
//   · **회전은 부르는 쪽이 한다.** 팩토리는 항상 정면(+Z)을 본다
//   · **두 조각의 겉면을 같은 평면에 두지 마라.** 덧대는 것(캡·테두리·판)은 감싸거나
//     파묻는다. 면이 정확히 겹치면 깊이 버퍼가 앞뒤를 못 정해 카메라가 움직일 때마다
//     승자가 바뀌어 **반짝인다**(z-fighting). 재질을 아무리 고쳐도 안 없어진다.
//     `blastWall` 캡에서 두 번 놓쳤다 — 처음엔 옆면만 고치고 **윗면**을 남겼다 (2026-08-04)
//
// `img2threejs` 로 만든 부품도 **같은 계약으로 맞춰서** 여기 넣으면 그대로 조립된다.

import * as THREE from 'three';
import { mm } from '../data/units/units.js';
import { WORKPIECE_MESH, ROUND, ROUND_5_56, CARRIER, AMR_BASKET } from '../data/props.js';

// ── 재질. 환경은 화이트라 **거칠기**로, 실물 소품은 **실측 색**으로 구분한다.
export const M = {
  shell:  new THREE.MeshStandardMaterial({ color: 0xf2f2f3, roughness: 0.92, metalness: 0.0 }),
  body:   new THREE.MeshStandardMaterial({ color: 0xe8e9ea, roughness: 0.75, metalness: 0.0 }),
  steel:  new THREE.MeshStandardMaterial({ color: 0xd6d9dc, roughness: 0.32, metalness: 0.55 }),
  dark:   new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.5,  metalness: 0.2 }),
  // 유리 — 실물 펜스 판은 무색 투명이다. 파란 건축모형 유리를 쓰다 실물색 전환 때 뺐다
  glass:  new THREE.MeshStandardMaterial({
    color: 0xdfe4e8, roughness: 0.08, metalness: 0.0,
    transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false,
  }),
  // ── 실물색 셋 (2026-09-01 실측 · real-color-palette.md). 사진 중앙값이 유광에서는
  // 반사광을 먹어 회색으로 나온다 — 그래서 검정은 albedo 를 낮추고 광은 roughness 로 낸다.
  printBlack: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.40, metalness: 0.0 }),
  felt:  new THREE.MeshStandardMaterial({ color: 0x2a3c34, roughness: 1.0,  metalness: 0.0 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xa8874f, roughness: 0.35, metalness: 0.9 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.28, metalness: 0.1 }),
  // E-stop — **화이트 모형 규칙의 두 번째 예외다** (첫째는 glass).
  // 실물이 황/적이고, 그 두 색이 곧 "누르면 선다" 는 신호다. 흰색으로 칠하면
  // 형태만 남고 의미가 사라진다 — 안전 요소는 색이 정보다.
  estopBody: new THREE.MeshStandardMaterial({ color: 0xe8c11a, roughness: 0.45, metalness: 0.0 }),
  estopBtn: new THREE.MeshStandardMaterial({ color: 0xc0271d, roughness: 0.40, metalness: 0.0 }),
};

// 레퍼런스의 사진 분위기를 `factory-walk` 안에만 닫아 두는 공유 재질이다 (D229).
// ponytail: 24px 반복 무늬는 근접 실사 복제가 아니라 원경에서 재질을 구분하는 최소 질감이다.
// 실제 긁힘/오염까지 필요해지면 촬영한 PBR 맵으로 이 공유본만 교체한다.
function toneTexture(hex, variation = 4, brushed = false) {
  const size = 24;
  const data = new Uint8Array(size * size * 4);
  const rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const noise = ((x * 17 + y * 31 + x * y * 7) % 19) - 9;
    const grain = brushed ? (((y * 5) % 9) - 4 + noise * 0.18) : noise;
    const i = (y * size + x) * 4;
    for (let c = 0; c < 3; c += 1) data[i + c] = Math.max(0, Math.min(255, rgb[c] + grain * variation));
    data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 8);
  t.needsUpdate = true;
  return t;
}

const factoryTex = {
  epoxy: toneTexture(0x4b4e50, 0.35),
  wall: toneTexture(0x5e6062, 0.22),
  coat: toneTexture(0x737678, 0.28),
  body: toneTexture(0x54575a, 0.28),
  steel: toneTexture(0xb0b3b5, 0.4, true),
  dark: toneTexture(0x282a2c, 0.25),
};

/** `defense-reference-v1` 전용. 기존 M을 바꾸지 않아 realmap과 현장 AR 기본층은 그대로다. */
export const DEFENSE_M = {
  floor: new THREE.MeshStandardMaterial({ map: factoryTex.epoxy, roughness: 0.88, metalness: 0.05 }),
  wall: new THREE.MeshStandardMaterial({ map: factoryTex.wall, roughness: 0.78, metalness: 0.08 }),
  frame: new THREE.MeshStandardMaterial({ map: factoryTex.dark, roughness: 0.48, metalness: 0.32 }),
  shell: new THREE.MeshStandardMaterial({ map: factoryTex.coat, roughness: 0.68, metalness: 0.16 }),
  body: new THREE.MeshStandardMaterial({ map: factoryTex.body, roughness: 0.72, metalness: 0.12 }),
  steel: new THREE.MeshStandardMaterial({ map: factoryTex.steel, roughness: 0.32, metalness: 0.68 }),
  dark: new THREE.MeshStandardMaterial({ map: factoryTex.dark, roughness: 0.44, metalness: 0.24 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0x8ba0aa, roughness: 0.1, metalness: 0,
    transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false,
  }),
  printBlack: new THREE.MeshStandardMaterial({ color: 0x111315, roughness: 0.46, metalness: 0.02 }),
  felt: M.felt,
  brass: M.brass,
  screen: new THREE.MeshStandardMaterial({ color: 0x17252c, roughness: 0.25, metalness: 0.14 }),
  estopBody: M.estopBody,
  estopBtn: M.estopBtn,
};

const defenseSwap = new Map(Object.keys(M).map((key) => [M[key], DEFENSE_M[key] ?? M[key]]));
function applyDefenseMaterials(root) {
  const swap = (material) => defenseSwap.get(material) ?? material;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
}

// ── 스캔에서 뽑은 표면 무늬 (2026-09-05 · phase 1). **텍스처 규약의 첫 예외다.**
// RealityScan 방 스캔을 카트 덱 고정 태그 넷으로 lab 좌표계에 정합(RMS 1.5mm)하고, 덱 윗면을
// 1mm/px 정사영·무조명으로 뽑았다. v2(같은 날 저녁): 팔·태그 자리를 메우는 대신 **깨끗한 홈 4주기를 평균한 프로파일로
// 전체를 다시 짰다** — 색·홈 간격(실측 30mm)·명암은 스캔 것, 얼룩·케이블·태그 종이는 없다. 작업대 셋(`bench{1,2,3}-top`)은
// 판 색·매트 색·매트 자리만 스캔에서 재고 다시 그렸다(`Shared/assets/scan/bench-top.json`).
// 출처·촬영일·정합값은 `docs/evidence/2026-09-05/realityscan-inventory.md` · `scan-tag-registration.json`.
// 파일은 `Shared/assets/scan/deck-top.jpg`(808×598 · 1mm/px · 45KB) — 이미지 위가 카트 **뒤(−Z)**, 왼쪽이 **−X**
// (BoxGeometry 윗면 UV 와 같게 굽는 단계에서 180° 돌려 저장했다 · `scripts` 없이 스크래치에서 뽑았다).
// ⚠ 노드(게이트 `layout.sh`)에서도 이 모듈을 읽는다 — 브라우저가 아니면 로더를 만들지 않는다.
const _scanTex = {};
export function scanTexture(name) {
  if (typeof document === 'undefined') return null;
  if (_scanTex[name] !== undefined) return _scanTex[name];
  const t = new THREE.TextureLoader().load(`/scan/${name}.jpg`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  _scanTex[name] = t;
  return t;
}

const box = (wMm, hMm, dMm, material = M.body) =>
  new THREE.Mesh(new THREE.BoxGeometry(mm(wMm), mm(hMm), mm(dMm)), material);

/** 원통. 기본 축은 Y — 눕히려면 부르는 쪽이 돌린다 (box 와 같은 규약). */
const cyl = (diaMm, lenMm, material = M.body, seg = 12) =>
  new THREE.Mesh(new THREE.CylinderGeometry(mm(diaMm / 2), mm(diaMm / 2), mm(lenMm), seg), material);

/** 그림자를 켜서 붙인다 — 접지감이 없으면 물체가 떠 보인다. */
function add(group, mesh, xMm = 0, yMm = 0, zMm = 0) {
  mesh.position.set(mm(xMm), mm(yMm), mm(zMm));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

// ── 작업대. 실험실에서 가장 많은 것.
export function bench({ wMm = 1600, dMm = 700, hMm = 900 } = {}) {
  const g = new THREE.Group();
  const topH = 40;
  add(g, box(wMm, topH, dMm, M.steel), 0, hMm - topH / 2, 0);          // 상판
  const legT = 60;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add(g, box(legT, hMm - topH, legT, M.dark),
      sx * (wMm / 2 - legT), (hMm - topH) / 2, sz * (dMm / 2 - legT));
  }
  add(g, box(wMm - 160, 380, dMm - 200, M.body), 0, 250, -40);          // 하부 수납
  return g;
}

// ── 아이솔레이터 / 글러브박스. 보내주신 클린룸 사진의 그것 — **가장 실험실다운 형태다.**
export function isolator({ wMm = 1800, dMm = 900, hMm = 2200 } = {}) {
  const g = new THREE.Group();
  const deskH = 950;
  add(g, box(wMm, deskH, dMm, M.body), 0, deskH / 2, 0);                // 하부 캐비닛
  add(g, box(wMm, 50, dMm, M.steel), 0, deskH + 25, 0);                 // 작업면
  const chamberH = hMm - deskH - 250;
  add(g, box(wMm, chamberH, dMm, M.glass), 0, deskH + 50 + chamberH / 2, 0);   // 유리 챔버
  add(g, box(wMm, 60, dMm, M.shell), 0, deskH + 50 + chamberH, 0);      // 챔버 테두리
  add(g, box(wMm, 190, dMm, M.shell), 0, hMm - 95, 0);                  // 상부 필터 유닛
  // 글러브 포트 — 원 두 개가 이 물건의 정체를 만든다
  for (const sx of [-1, 1]) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(mm(160), mm(34), 10, 24), M.shell,
    );
    ring.position.set(mm(sx * wMm * 0.22), mm(deskH + 50 + chamberH * 0.45), mm(dMm / 2));
    ring.castShadow = true;
    g.add(ring);
  }
  return g;
}

// ── 선반. 층이 보이면 "보관"으로 읽힌다.
export function shelf({ wMm = 900, dMm = 450, hMm = 1900, levels = 4 } = {}) {
  const g = new THREE.Group();
  const t = 30;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add(g, box(50, hMm, 50, M.dark), sx * (wMm / 2 - 25), hMm / 2, sz * (dMm / 2 - 25));
  }
  for (let i = 0; i < levels; i += 1) {
    add(g, box(wMm, t, dMm, M.shell), 0, 250 + (i * (hMm - 300)) / (levels - 1), 0);
  }
  return g;
}

// ── 계측기. 화면 + 손잡이가 있으면 장비로 읽힌다.
export function instrument({ wMm = 700, dMm = 600, hMm = 550 } = {}) {
  const g = new THREE.Group();
  add(g, box(wMm, hMm, dMm, M.body), 0, hMm / 2, 0);
  add(g, box(wMm * 0.55, hMm * 0.4, 20, M.screen), 0, hMm * 0.62, dMm / 2);   // 화면
  add(g, box(wMm * 0.8, 40, 40, M.dark), 0, hMm * 0.22, dMm / 2);             // 손잡이
  add(g, box(wMm * 0.9, 60, dMm * 0.9, M.shell), 0, hMm + 30, 0);             // 상판 뚜껑
  return g;
}

// ── 모니터 + 키보드. 작업대 위에 이게 있으면 "쓰는 자리" 가 된다.
export function workstation({ wMm = 620, hMm = 420 } = {}) {
  const g = new THREE.Group();
  // **원점은 발자국 가운데다** (파일 머리 규약). 키보드가 260mm 앞으로 나와 있어
  // 그냥 두면 원점이 122mm 뒤로 치우친다 — 자리를 작업대 밖으로 흘리는 원인이었다.
  // 모니터를 그만큼 뒤로 물려 앞뒤를 맞춘다.
  const dz = -122;
  add(g, box(120, 30, 180, M.dark), 0, 15, dz);                          // 받침
  add(g, box(60, hMm * 0.4, 60, M.dark), 0, hMm * 0.2, dz);              // 기둥
  const panel = add(g, box(wMm, hMm * 0.6, 24, M.screen), 0, hMm * 0.62, dz);
  panel.rotation.x = -0.12;
  add(g, box(420, 18, 150, M.shell), 0, 9, 260 + dz);                    // 키보드
  return g;
}

/** 이름 → 팩토리. 배치안이 이 이름으로 부품을 부른다. */
export const PROPS = { bench, isolator, shelf, instrument, workstation, carrier, amrBasket };

/**
 * 부품의 **지금 크기**(mm). 화면의 크기 칸이 현재 값을 보여주려고 쓴다.
 *
 * 팩토리 기본값은 코드 안에만 있어서 화면이 알 길이 없다. 서명을 문자열로 파싱하는
 * 방법도 있지만 **압축 빌드에서 인자 이름이 바뀌어** 개발에선 되고 배포에선 깨진다 —
 * 그 종류의 버그는 안 만든다. 그래서 **실제로 만들어 재고** 결과를 캐시한다.
 */
const sizeCache = new Map();
export function sizeMmOf(type, opts = {}) {
  const key = type + JSON.stringify(opts);
  let v = sizeCache.get(key);
  if (!v) {
    const make = PROPS[type];
    if (!make) return null;
    const s = new THREE.Box3().setFromObject(make(opts)).getSize(new THREE.Vector3());
    v = { x: Math.round(s.x * 1000), y: Math.round(s.y * 1000), z: Math.round(s.z * 1000) };
    sizeCache.set(key, v);
  }
  return v;
}

/**
 * 배치안의 `props` 배열을 실제 3D 로 조립한다.
 *
 * 배치안이 **이름과 좌표만** 들고 있고 형태는 여기 있다 —
 * 그래야 부품을 고쳐도 배치안이 안 바뀐다.
 */
export function assembleProps(props = [], { materialStyle = null, materialFilter = null } = {}) {
  const g = new THREE.Group();
  g.name = 'props';
  const conveyors = new Map();
  for (const p of props) {
    const make = PROPS[p.type];
    if (!make) { console.warn(`모르는 부품: ${p.type}`); continue; }
    const node = make(p.opts ?? {});
    if (materialStyle === 'defense-reference-v1' && (!materialFilter || materialFilter(p))) {
      applyDefenseMaterials(node);
    }
    // 배치안은 Z-up(x,y 바닥) · three 는 Y-up → y 와 z 를 바꾸고 **평면도 Y 는 부호를 뒤집는다**.
    // 그냥 맞바꾸면 거울 사상이 된다 (D43 · `layout-view.js` 의 Z 와 같은 규약).
    node.position.set(mm(p.posMm[0]), mm(p.posMm[2] ?? 0), -mm(p.posMm[1]));
    node.rotation.y = ((p.rotDeg ?? 0) * Math.PI) / 180;
    node.name = p.id ?? p.type;
    // **편집 단위 표식.** 인터랙션이 맞은 메시에서 위로 올라가며 이걸 찾는다.
    node.userData.item = { kind: 'prop', id: p.id ?? p.type, type: p.type };
    g.add(node);
    if (node.userData.belt?.setTravelMm) {
      conveyors.set(node.name, { belt: node.userData.belt, yaw: node.rotation.y, previous: null });
    }
  }
  // 절대 거리는 되감기용, pose는 순서대로 온 실주행용. 활성 구간은 호출자가 고른다.
  g.userData.setConveyorTravel = (id, signedMm) => {
    const c = conveyors.get(id);
    if (!c || !Number.isFinite(signedMm)) return false;
    c.previous = null;
    return c.belt.setTravelMm(signedMm);
  };
  g.userData.setConveyorPose = (id, pose) => {
    const c = conveyors.get(id);
    if (!c) return false;
    if (pose === null) { c.previous = null; return false; }
    if (!Number.isFinite(pose?.xMm) || !Number.isFinite(pose?.yMm)) return false;
    const previous = c.previous;
    c.previous = { xMm: pose.xMm, yMm: pose.yMm };
    if (!previous) return false;
    const delta = (pose.xMm - previous.xMm) * Math.cos(c.yaw)
      + (pose.yMm - previous.yMm) * Math.sin(c.yaw);
    if (Math.abs(delta) < 1e-9) return false;
    return c.belt.setTravelMm(c.belt.travelMm + delta);
  };
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// 아래는 Codex 로 뽑은 레퍼런스 이미지를 보고 (그 png 는 리포에 안 들어왔다 · 2026-08-08)
// **빠져 있던 것**을 채운 것들이다. 그림과 대조해 다섯 가지가 없었다:
//   ① 벤치가 끊긴 박스였다 → **연속 열**이어야 실험실로 읽힌다
//   ② **상부장**이 없었다 → 벽면이 비어 창고처럼 보였다
//   ③ 로봇 셀에 **안전 펜스**가 없었다 → "작업 셀" 로 안 읽혔다
//   ④ 문이 개구부뿐이었다 → **유리 문짝**이 있어야 입구다
//   ⑤ 위에 **작은 물건**이 없었다 → 디테일은 큰 가구가 아니라 잔물건에서 온다
// ─────────────────────────────────────────────────────────────────────────────

/** 벤치 열 — 길이를 주면 하부장을 반복해 채운다. 실험실 벽면의 기본 단위다. */
export function benchRun({ lengthMm = 4000, dMm = 700, hMm = 900, sink = false } = {}) {
  const g = new THREE.Group();
  const topH = 40;
  add(g, box(lengthMm, topH, dMm, M.steel), 0, hMm - topH / 2, 0);       // 연속 상판
  add(g, box(lengthMm, 60, 40, M.shell), 0, hMm + 20, -dMm / 2 + 20);    // 뒷턱

  // 하부장 — 900mm 모듈로 나눠 문·서랍 선을 낸다. 그 선이 "실험실 가구" 신호다.
  const unit = 900;
  const n = Math.max(1, Math.round(lengthMm / unit));
  const w = lengthMm / n;
  for (let i = 0; i < n; i += 1) {
    const cx = -lengthMm / 2 + w * (i + 0.5);
    add(g, box(w - 20, hMm - topH - 120, dMm - 60, M.body), cx, (hMm - topH) / 2 + 40, 0);
    // 문 두 짝 (홈이 파인 것처럼 얇은 판을 앞에 띄운다)
    for (const s of [-1, 1]) {
      add(g, box(w / 2 - 40, hMm - topH - 200, 16, M.shell),
        cx + s * (w / 4 - 5), (hMm - topH) / 2 + 40, dMm / 2 - 22);
    }
    add(g, box(w - 60, 14, 20, M.dark), cx, hMm - topH - 110, dMm / 2 - 14);  // 손잡이
  }
  add(g, box(lengthMm, 120, dMm - 100, M.dark), 0, 60, 0);               // 걸레받이(그림자용)

  if (sink) {
    const s = add(g, box(500, 60, 400, M.steel), -lengthMm / 2 + 500, hMm - topH - 20, 0);
    s.material = M.steel;
    add(g, box(30, 260, 30, M.steel), -lengthMm / 2 + 500, hMm + 130, -140);  // 수전
  }
  return g;
}

/** 상부장 — 벤치 위 벽에 붙는다. **이게 없으면 벽면이 비어 창고처럼 보인다.** */
export function wallCabinet({ lengthMm = 2400, dMm = 350, hMm = 700, baseMm = 1450, open = false } = {}) {
  const g = new THREE.Group();
  add(g, box(lengthMm, hMm, dMm, M.body), 0, baseMm + hMm / 2, 0);
  const unit = 800;
  const n = Math.max(1, Math.round(lengthMm / unit));
  const w = lengthMm / n;
  for (let i = 0; i < n; i += 1) {
    const cx = -lengthMm / 2 + w * (i + 0.5);
    // 열린 칸은 유리, 닫힌 칸은 흰 문 — 섞이면 훨씬 실제 같다
    add(g, box(w - 24, hMm - 40, 14, open ? M.glass : M.shell), cx, baseMm + hMm / 2, dMm / 2 - 8);
    if (open) add(g, box(w - 40, 16, dMm - 40, M.shell), cx, baseMm + hMm / 2, 0);  // 중간 선반
  }
  return g;
}

/** 안전 펜스 — 로봇 셀 둘레. **이게 있어야 "작업 셀" 로 읽힌다.** 앞면은 비운다(출입). */
export function safetyFence({ wMm = 2600, dMm = 2000, hMm = 1500 } = {}) {
  const g = new THREE.Group();
  const post = 70;
  const sides = [
    [wMm, post, 0, -dMm / 2],                    // 뒤
    [post, dMm, -wMm / 2, 0],                    // 좌
    [post, dMm, wMm / 2, 0],                     // 우
  ];
  for (const [w, d, x, z] of sides) {
    add(g, box(w, hMm, d, M.glass), x, hMm / 2, z);
    add(g, box(w, 60, d + 10, M.dark), x, hMm - 30, z);      // 상단 프레임
    add(g, box(w, 60, d + 10, M.dark), x, 40, z);            // 하단 프레임
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add(g, box(post, hMm, post, M.dark), sx * wMm / 2, hMm / 2, sz * dMm / 2);
  }
  return g;
}

/** 잔물건 — 병·랙·상자. **디테일은 큰 가구가 아니라 여기서 온다.** */
Object.assign(PROPS, { benchRun, wallCabinet, safetyFence });

// ─────────────────────────────────────────────────────────────────────────────
// 방산 해체 라인 소품 (D51 · S1). 레퍼런스는 Codex 로 뽑았고 **문구가 정본이다** —
// `MILESTONES.md` §S1 의 스타일 문구. 이미지는 저장소에 안 넣는다 (한 장 1.2MB,
// `Shared/assets/` 는 publicDir 로 dist 에 통째 복사된다).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 롤러 컨베이어 — 해체 라인의 입구. **1사이클의 시작점**이다.
 *
 * `hMm` 은 다리 높이가 아니라 **이송면(롤러 윗면) 높이**다. 기본 900 은 `bench`·`benchRun`
 * 상판과 같은 값이라 라인이 끊기지 않는다 — 여기를 바꾸면 물건이 턱을 넘는다.
 */
export function conveyor({
  lengthMm = 2400, wMm = 600, hMm = 900, rollerDiaMm = 76, pitchMm = 100,
  rampMm = 0, dropMm = 0, belt = false,
} = {}) {
  const g = new THREE.Group();
  // 작은 컨베이어에는 레일도 비례로 — 600mm 폭 기준의 90/40 을 그대로 쓰면 폭 120 에서
  // 레일 두 짝(80)이 벨트(40)보다 넓어 홈통으로 읽힌다
  const railH = Math.min(90, Math.max(24, hMm * 0.45));   // 사이드 레일 높이
  const railT = Math.min(40, Math.max(10, wMm * 0.12));   // 사이드 레일 두께
  // **레일 상단이 롤러 상단보다 낮다.** 실물 롤러 컨베이어가 그렇고, 반대로 하면
  // 롤러가 홈에 파묻혀 컨베이어가 아니라 벤치로 읽힌다 (첫 렌더의 결함).
  // 평벨트(`belt`)는 이송면이 연속이라 살짝만 낮춘다.
  const railTop = hMm - (belt ? 6 : rollerDiaMm * 0.16);
  const railY = railTop - railH / 2;
  const legT = Math.min(70, Math.max(20, wMm * 0.3));       // 작은 폭에선 다리도 비례로
  const legInset = Math.min(220, lengthMm * 0.15);          // 다리는 끝에서 안쪽으로 — 이미지의 그 비율

  // ── 램프 — **−X 끝이 낮아진다.** AMR 이 900mm 상판 위로 물건을 들어 올릴 수는 없다.
  // 낮은 끝에 대면 밀어 넣는 것으로 끝나고, 나머지는 경사가 한다.
  // `rampMm` 은 경사 구간의 **수평 길이**이고 `dropMm` 은 그 구간에서 낮아지는 높이다.
  const ramp = Math.max(0, Math.min(rampMm, lengthMm - 2 * railT));
  const drop = ramp > 0 ? Math.max(0, Math.min(dropMm, hMm - railH - 100)) : 0;
  const flat = lengthMm - ramp;
  const x0 = -lengthMm / 2;                       // 낮은 끝
  const slope = ramp > 0 ? Math.atan2(drop, ramp) : 0;
  const hyp = Math.hypot(ramp, drop);
  /** 길이축 x 에서의 이송면 높이. 램프 밖은 그냥 `hMm` 이다. */
  const topAt = (x) => (ramp > 0 && x < x0 + ramp ? hMm - drop * (1 - (x - x0) / ramp) : hMm);

  // ── 사이드 레일 (길이 방향 X, 폭 방향 Z). 램프가 있으면 두 토막이다
  for (const s of [-1, 1]) {
    const z = s * (wMm / 2 - railT / 2);
    add(g, box(flat, railH, railT, M.steel), x0 + ramp + flat / 2, railY, z);
    if (ramp > 0) {
      const m = box(hyp, railH, railT, M.steel);
      m.rotation.z = slope;                       // +X 쪽이 올라간다
      add(g, m, x0 + ramp / 2, railY - drop / 2, z);
    }
  }

  // ── 이송면 — 롤러 또는 평벨트.
  const span = lengthMm - 2 * railT;
  let setTravelMm = null;
  let travelMm = 0;
  if (belt) {
    // **평벨트** (주인님 2026-08-19) — 77mm 더미탄 같은 작은 작업물은 롤러 틈(피치 100)에
    // 빠진다. 벨트는 고무라 어둡게 — 흰색이면 판때기로 읽힌다 (롤러의 그 교훈 그대로).
    const beltT = Math.min(12, hMm * 0.15);
    const bw = wMm - 2 * railT;
    add(g, box(flat - 2 * railT, beltT, bw, M.printBlack), x0 + ramp + flat / 2, hMm - beltT / 2, 0);
    if (ramp > 0) {
      const m = box(hyp, beltT, bw, M.printBlack);
      m.rotation.z = slope;
      add(g, m, x0 + ramp / 2, hMm - drop / 2 - beltT / 2, 0);
    }
    // 단부 드럼·반환 벨트. 설치 치수 안에 넣어 실맵/앵커의 점유 면적을 늘리지 않는다.
    const drumD = Math.min(railH * 0.8, wMm * 0.25);
    for (const s of [-1, 1]) {
      const x = s * (lengthMm - drumD) / 2;
      const drum = cyl(drumD, bw, M.printBlack, 24);
      drum.rotation.x = Math.PI / 2;
      add(g, drum, x, topAt(x) - drumD / 2, 0);
      for (const side of [-1, 1]) {
        const bearing = cyl(drumD * 0.46, railT * 0.6, M.dark, 12);
        bearing.rotation.x = Math.PI / 2;
        add(g, bearing, x, topAt(x) - drumD / 2, side * (wMm / 2 - railT * 0.4));
      }
    }
    add(g, box(flat - 2 * railT, beltT * 0.5, bw, M.printBlack),
      x0 + ramp + flat / 2, hMm - drumD + beltT * 0.25, 0);

    // ponytail: 표면 이음만 인스턴스 한 벌로 움직인다. 고무 변형/드럼 회전은 이 축척에서 생략.
    const count = Math.max(2, Math.min(96, Math.ceil(span / 45)));
    const step = span / count;
    const seamWidth = Math.min(1.5, step * 0.06);
    const seams = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, mm(0.6), mm(bw * 0.96)), M.screen, count,
    );
    seams.name = 'belt-surface';
    // 기존 모든 소비자는 geometry를 정리한다. 그때 인스턴스 GPU 행렬도 같이 놓는다.
    seams.geometry.addEventListener('dispose', () => seams.dispose());
    seams.frustumCulled = false;  // 이동 행렬만 갱신; 작은 부품의 bounds 재계산을 매 pose마다 안 한다
    seams.receiveShadow = true;
    g.add(seams);
    const seam = new THREE.Object3D();
    setTravelMm = (value) => {
      if (!Number.isFinite(value) || value === travelMm) return false;
      travelMm = value;
      const phase = ((value % span) + span) % span;
      for (let i = 0; i < count; i += 1) {
        const x = -span / 2 + ((step * (i + 0.5) + phase) % span);
        seam.position.set(mm(x), mm(topAt(x) - 0.3), 0);
        seam.rotation.z = ramp > 0 && x < x0 + ramp ? slope : 0;
        seam.scale.set(mm(Math.min(seamWidth, 2 * (span / 2 - Math.abs(x)))), 1, 1);
        seam.updateMatrix();
        seams.setMatrixAt(i, seam.matrix);
      }
      seams.instanceMatrix.needsUpdate = true;
      return true;
    };
    travelMm = NaN; // 첫 0mm도 행렬을 채운다
    setTravelMm(0);
  } else {
    // ── 롤러. 축이 Z 이므로 X 로 90° 눕힌다.
    // ponytail: 롤러 축 볼트(레일 바깥면의 작은 머리)는 안 그린다 — 배치 축척에서 1px 미만이고
    // 롤러당 2개면 메시가 48개 는다. 근접 뷰가 필요해지면 그때 넣는다.
    const n = Math.max(2, Math.floor(span / pitchMm));
    const step = span / n;
    for (let i = 0; i < n; i += 1) {
      // 롤러는 금속이다 — `shell`(거의 흰색) 로 두면 베드가 흰 판때기로 읽힌다 (2차 렌더의 결함)
      const r = cyl(rollerDiaMm, wMm - 2 * railT, M.steel);
      r.rotation.x = Math.PI / 2;
      const x = -span / 2 + step * (i + 0.5);
      add(g, r, x, topAt(x) - rollerDiaMm / 2, 0);
    }
  }

  // ── 낮은 끝의 짧은 다리 한 쌍. 없으면 램프가 허공에서 시작한다
  if (ramp > 0) {
    const lowH = topAt(x0) - railH - rollerDiaMm * 0.16;
    for (const sz of [-1, 1]) {
      add(g, box(legT, Math.max(60, lowH), legT, M.dark),
        x0 + legT, Math.max(60, lowH) / 2, sz * (wMm / 2 - (legT + 50) / 2));
    }
  }

  // ── 다리 4개 + 발판
  const legH = railTop - railH;
  const footT = Math.min(legT + 50, wMm * 0.5);
  // 다리는 레일보다 살짝 안쪽이다 — **발판까지 `wMm` 안에 들어와야** bbox 가 폭과 같아지고,
  // 배치 충돌·도달범위 검사가 실제 점유 면적을 본다.
  const legZ = wMm / 2 - footT / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (lengthMm / 2 - legInset);
    add(g, box(legT, legH, legT, M.dark), x, legH / 2, sz * legZ);
    add(g, box(footT, 16, footT, M.dark), x, 8, sz * legZ);          // 발판
  }

  // **벨트가 자기 이송면을 말해 준다.** 작업물이 컨베이어 위에 앉으려면 화면 쪽이
  // "여기 높이가 몇인가" 를 물어야 하는데, 램프 때문에 그 값이 위치마다 다르다.
  // 계산을 여기 한 곳에 두고 밖에서는 부르기만 한다 (하드 룰 5).
  g.userData.belt = {
    lengthMm, wMm,
    ...(setTravelMm ? { setTravelMm } : {}),
    get travelMm() { return travelMm; },
    /** 길이축 로컬 x(mm) 에서의 이송면 높이(mm). 벨트 밖이면 `null`. */
    topAtMm(localXMm, localZMm) {
      if (Math.abs(localXMm) > lengthMm / 2 || Math.abs(localZMm) > wMm / 2) return null;
      return topAt(localXMm);
    },
  };

  // ── 하부 브레이스. 길이 방향 2줄 + 다리쌍마다 가로 1줄 — 이게 있어야 "구조물" 로 읽힌다.
  const braceY = legH * 0.22;
  const braceH = Math.min(50, legH * 0.35);
  for (const sz of [-1, 1]) {
    add(g, box(lengthMm - 2 * legInset, braceH, Math.min(30, railT), M.dark), 0, braceY, sz * legZ);
  }
  for (const sx of [-1, 1]) {
    add(g, box(30, braceH, wMm - railT, M.dark), sx * (lengthMm / 2 - legInset), braceY, 0);
  }
  return g;
}

/**
 * 탄두 — **소품이 아니라 작업물이다.** 다른 부품은 놓이지만 이건 로봇이 집고 분해한다.
 *
 * ⚠ **치수는 실물보다 크면 안 된다** (D50). 실제 포탄 치수로 그리면 실물 점유 부피를 넘어
 * AR 에서 사람이 충돌 여지를 오판한다. **비율만 탄두처럼 간다.**
 * 기본값은 `Shared/data/props.js` 의 `WORKPIECE_MESH` 다 — **여기에 숫자를 다시 적지 않는다.**
 * 실물과 얼마나 벌어져 있는지는 `scripts/check/measurements.sh` 가 매번 말해 준다.
 *
 * `stage` 가 해체 4단계다 — 0 완성 · 1 유도부 분리 · 2 신관 분리 · 3 주탄약 분리(빈 케이싱).
 * 사이클이 진행되며 이게 쪼개지는 것이 곧 진행률이다 (F10).
 */
export function warhead({
  stage = 0, diaMm = WORKPIECE_MESH.diaMm, lengthMm = WORKPIECE_MESH.lengthMm,
} = {}) {
  const g = new THREE.Group();
  const noseLen = lengthMm * 0.34;
  const bodyLen = lengthMm - noseLen;
  // `diaMm` 은 **최대 외경(회전 밴드 기준)** 이다 — 동체는 그보다 얇다.
  // 밴드를 동체보다 굵게 두면서 이걸 안 맞추면 바닥을 파고들고 bbox 가 인자를 넘는다.
  const y = diaMm / 2;                       // 눕혀 놓는다 — 바닥에서 최대 반지름만큼
  const bodyDia = (stage >= 3 ? diaMm * 0.92 : diaMm) - 6;
  const body = cyl(bodyDia, bodyLen, M.body, 20);
  body.rotation.z = Math.PI / 2;             // 축을 X 로 눕힌다
  add(g, body, (lengthMm - bodyLen) / 2 - lengthMm / 2 + bodyLen / 2 - bodyLen / 2, y, 0);
  body.position.x = mm(lengthMm / 2 - bodyLen / 2);

  // 회전 밴드 2줄 — 이게 있어야 매끈한 원통이 아니라 탄체로 읽힌다
  for (const f of [0.22, 0.74]) {
    const band = cyl(diaMm, 10, M.dark, 20);
    band.rotation.z = Math.PI / 2;
    add(g, band, lengthMm / 2 - bodyLen * f, y, 0);
  }

  // 노즈. stage 0 완전 · 1 유도부만 잘려 뭉툭 · 2 이상 없음
  if (stage <= 1) {
    const cut = stage === 0 ? 1 : 0.55;
    const nose = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(diaMm * (stage === 0 ? 0.06 : 0.42)), mm(diaMm / 2),
        mm(noseLen * cut), 20),
      M.body,
    );
    // +90° 여야 좁은 끝이 −X(바깥) 을 본다. −90° 면 뒤집혀 뾰족한 쪽이 동체에 박힌다.
    nose.rotation.z = Math.PI / 2;
    add(g, nose, -lengthMm / 2 + noseLen * cut / 2, y, 0);
  }
  return g;
}

/**
 * 책상 위 더미탄 — **두 파트.** 탄피(아래)와 탄두(위)가 나사로 물린다 (3바퀴 · 팀원 개조 중).
 *
 * **STL 을 안 읽는다.** 이 모듈은 외부 에셋 없는 화이트 모형 카탈로그고(파일 머리),
 * 썸네일도 동기 렌더라 비동기 로더가 못 들어온다. 대신 **프로파일을 그대로 회전**시킨다
 * — 형상은 STL 과 같고 삼각형은 27,600 → 900 이다.
 *
 * ⛔ **프로파일은 5.56×45 STL 이고 실물은 7.92×57 모형이다** (2026-08-11 확인). 그래서
 * 그리기 전에 **실측(`ROUND`)으로 늘린다** — 안 늘리면 화면이 실물보다 34% 짧은 것을 그리고,
 * 그 그림이 다음 사람에게 실측으로 읽힌다. 배율은 `props.js` 의 두 상수에서만 나온다.
 *
 * **축 배율이 하나가 아니다** — 케이스 1.25배 · 탄두 2.13배다. 하나로 걸면 탄두가 뭉툭해진다.
 *
 * `gapMm` 이 조립 진행이다 — 0 이면 결합, 양수면 탄두가 그만큼 떠서 분해도가 된다.
 * 나사산은 그리지 않는다. 이 지름에서 안 보이고, 모델에도 없다.
 */
export function round({ gapMm = 0, seg = 24 } = {}) {
  const g = new THREE.Group();
  const stlTipLen = ROUND_5_56.lengthMm - ROUND_5_56.splitZmm;   // 12.7
  const kr = ROUND.diaMm / ROUND_5_56.diaMm;                     // 반지름 — 파트 공통
  const kCase = ROUND.caseLenMm / ROUND_5_56.splitZmm;           // 56 / 44.7
  const kTip = ROUND.tipLenMm / stlTipLen;                       // 27 / 12.7
  const lathe = (pts, material, ky) => new THREE.Mesh(
    new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(mm(r * kr), mm(y * ky))), seg),
    material,
  );

  // 탄피 — 림·추출홈·몸통 테이퍼·어깨·넥. 입구는 **막힌 원판이다** (원본에 보어가 없다)
  // 실물은 황동 한 덩어리로 읽힌다 (`real-carrier13-black-crate.png` · 8/27 standing-bullets)
  const caseMesh = lathe([
    [0, 0], [4.80, 0], [4.80, 1.10], [4.20, 1.60], [4.20, 2.80],
    [4.78, 3.60], [4.50, 35.70], [3.215, 38.70], [3.215, 44.70], [0, 44.70],
  ], M.brass, kCase);

  // 탄두 — 원통 4.5mm + 오지브. 프로파일은 STL 정점 링에서 뽑았다
  const tipMesh = lathe([
    [0, 0], [2.85, 0], [2.85, 4.50], [2.69, 6.30], [2.38, 7.80], [1.895, 9.30],
    [1.325, 10.60], [0.73, 11.60], [0.31, 12.30], [0.30, 12.70], [0, 12.70],
  ], M.brass, kTip);

  add(g, caseMesh, 0, 0, 0);
  // 탄두 밑동은 케이스 입구가 아니라 **나사 물림만큼 내려온 자리**다 — `splitZmm + tipLenMm = 전장`
  add(g, tipMesh, 0, ROUND.splitZmm + gapMm, 0);
  return g;
}

/**
 * 작업대2에 고정된 **하얀 거치대2** — 3×3 구멍과 현재 꽂힌 총알 둘까지 그린다.
 *
 * 입력 크기는 안전 게이트 상자에서 온다. 구멍·클램프의 아직 안 잰 치수는
 * `workcell.js FIXTURE2_VISUAL`이 명시적으로 `approx`라 적은 그림 전용 값이다.
 * 원점은 다른 팩토리와 같이 몸통 바닥 중앙(Y-up)이다.
 */
export function fixture2({ wMm, dMm, hMm, holes, roundSlots, clamps } = {}) {
  const w = wMm; const d = dMm; const h = hMm;
  const g = new THREE.Group();
  g.name = 'fixture2-model';
  if (![w, d, h].every((v) => Number.isFinite(v) && v > 0)) return g;

  add(g, box(w, h, d, M.shell), 0, h / 2, 0);

  const rows = holes?.rows ?? 0; const cols = holes?.cols ?? 0;
  const pitch = Math.min(w, d) * (holes?.pitchRatio ?? 0);
  const holeDia = holes?.diaMm ?? 0;
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    // ponytail: 실제 보어를 boolean으로 뚫지 않고 1.2mm 검은 원판으로 읽히게 한다.
    // 근접 계측 뷰가 필요해지면 실측 지름을 받은 뒤 CSG/실메시로 교체한다.
    const recess = add(g, cyl(holeDia, 1.2, M.printBlack, 20),
      (col - (cols - 1) / 2) * pitch, h + 0.4, (row - (rows - 1) / 2) * pitch);
    recess.name = `fixture2-hole-${row}-${col}`;
  }

  for (const [col, row] of (roundSlots ?? [])) {
    const cartridge = add(g, round(), col * pitch, h - 2, row * pitch);
    cartridge.name = `fixture2-round-${col}-${row}`;
  }

  // 실영상의 좌·우·앞 클램프 세 개. 길이는 아직 실측 전이라 점유·충돌 판정에 넣지 않는다.
  const railL = clamps?.railMm ?? 0; const railW = clamps?.railWMm ?? 0; const railH = clamps?.railHMm ?? 0;
  if (railL > 0 && railW > 0 && railH > 0) {
    for (const sx of [-1, 1]) {
      const rail = add(g, box(railL, railH, railW, M.steel), sx * (w / 2 + railL / 2 - 6), railH / 2, 0);
      rail.name = `fixture2-rail-${sx < 0 ? 'left' : 'right'}`;
      add(g, box(14, 12, 18, M.dark), sx * (w / 2 - 3), 6, 0);
    }
    const frontRail = add(g, box(railW, railH, railL, M.steel), 0, railH / 2, d / 2 + railL / 2 - 6);
    frontRail.name = 'fixture2-rail-front';
    add(g, box(18, 12, 14, M.dark), 0, 6, d / 2 - 3);
  }
  return g;
}

/**
 * **옮기는 거치대** — 팔이 통째로 집어 터틀봇 바구니에 넣는 구멍 판 (2026-08-31 · D160).
 *
 * 치수는 `props.js` 의 `CARRIER` 가 정본이다 — **여기에 숫자를 적지 않는다**(그 파일 머리말
 * §복사하지 않는다). 실물은 69 × 85 × 55mm 이고 윗면에 격자 구멍이 뚫려 총알이 선다.
 *
 * ⚠ **구멍 격자는 아직 안 쟀다.** `CARRIER.holes` 가 `null` 이면 여기서 **그리지 않는다** —
 * 개수를 지어내 그리면 화면이 실물과 다른 물건을 보여주고, 사람은 그걸 실측으로 읽는다.
 * 재는 날 `holes: { cols, rows, pitchMm, diaMm }` 를 채우면 이 함수가 자동으로 그린다.
 *
 * 원점은 규약대로 **바닥 중앙**이고 정면은 +Z 다. `dMm`(85) 변이 Z 축을 향한다 —
 * 그 변의 중앙을 그리퍼가 문다 (`CARRIER_GRASP_TRUTH`).
 */
export function carrier({ wMm, dMm, hMm, holes, rounds } = {}) {
  const w = wMm ?? CARRIER.wMm;
  const d = dMm ?? CARRIER.dMm;
  const h = hMm ?? CARRIER.hMm;
  const H = holes ?? CARRIER.holes;
  // 살 두께 = **무는 부위 두께**다 (그리퍼가 문 1.6mm · `CARRIER.grip`). 실물이 얇은
  // 플라스틱이라 벽도 바닥살도 그 두께다 — 새 숫자를 만들지 않는다.
  const t = CARRIER.grip?.gripThicknessMm ?? 2;
  const g = new THREE.Group();
  const box = (bw, bh, bd, mat, x, y, z) =>
    add(g, new THREE.Mesh(new THREE.BoxGeometry(mm(bw), mm(bh), mm(bd)), mat), x, y, z);

  // ── 벽 넷 — **속은 비었다** (주인님 2026-08-31 「격자형태로 비어있게」).
  // 처음엔 꽉 찬 상자로 그려 총알이 들어갈 자리가 없었다.
  // 실물은 통째로 유광 검정 3D프린트다 (`real-carrier13-black-crate.png`).
  for (const sz of [-1, 1]) box(w, h, t, M.printBlack, 0, h / 2, sz * (d / 2 - t / 2));
  for (const sx of [-1, 1]) box(t, h, d - 2 * t, M.printBlack, sx * (w / 2 - t / 2), h / 2, 0);

  // ── 바닥 격자 — 총알은 **이 위에** 선다 (주인님 「거치대 두께만큼의 높이 위에 담겨있음」).
  // ⚠ **칸 간격은 아직 확정이 아니다** (`CARRIER.holes.pitchMm` · 주인님 「1.5」를 cm 로
  //    읽었는데 사진에서 세면 더 촘촘하다). 간격이 바뀌면 살 개수만 달라지고
  //    **총알 높이는 안 바뀐다** — 그래서 판정에 쓰는 값은 이 그림에 안 걸린다.
  const pitch = H?.pitchMm ?? 15;
  const inW = w - 2 * t;
  const inD = d - 2 * t;
  for (let x = -inW / 2 + pitch; x < inW / 2 - 1e-6; x += pitch) box(t, t, inD, M.printBlack, x, t / 2, 0);
  for (let z = -inD / 2 + pitch; z < inD / 2 - 1e-6; z += pitch) box(inW, t, t, M.printBlack, 0, t / 2, z);
  // 격자를 잡아 주는 테두리 — 없으면 살들이 공중에 뜬 것처럼 보인다
  for (const sz of [-1, 1]) box(inW, t, t, M.printBlack, 0, t / 2, sz * (inD / 2 - t / 2));
  for (const sx of [-1, 1]) box(t, t, inD, M.printBlack, sx * (inW / 2 - t / 2), t / 2, 0);

  // ── 총알 — **바닥살 위에 담겨 있다.** 밑동 높이 = 살 두께
  const n = rounds ?? CARRIER.roundsOnBoard ?? 0;
  if (n > 0) {
    const base = CARRIER.roundSeatMm != null ? (h - CARRIER.roundSeatMm) : t;
    const gap = Math.min(inW, inD) / (n + 1);
    for (let k = 0; k < n; k += 1) {
      // `round()` 는 **Y-up · 바닥 원점**이라 세우는 데 회전이 필요 없다
      add(g, round(), n === 1 ? 0 : (k - (n - 1) / 2) * gap, base, 0);
    }
  }
  return g;
}

/**
 * **터틀봇 초록 바구니** — 거치대가 들어가는 곳. 치수 정본은 `props.js` 의 `AMR_BASKET`.
 *
 * 안쪽 치수를 받아 **벽을 바깥으로** 세운다 — 안쪽이 실측이고 겉은 벽 두께만큼 커진다.
 * ⚠ `AMR_BASKET.wallMm` 이 `null` 이면 형태용 기본값 3mm 로 그린다. **겉치수를 이 그림에서
 * 읽지 마라** — 재는 날 그 필드를 채운다.
 */
export function amrBasket({ innerWMm, innerDMm, innerHMm, wallMm } = {}) {
  const w = innerWMm ?? AMR_BASKET.innerWMm;
  const d = innerDMm ?? AMR_BASKET.innerDMm;
  const h = innerHMm ?? AMR_BASKET.innerHMm;
  const t = wallMm ?? AMR_BASKET.wallMm ?? 3;
  const g = new THREE.Group();
  // 실물은 진초록 펠트다 — 무광 천이라 metalness 0 · roughness 최대 (`real-turtlebot-basket-side.png`)
  add(g, new THREE.Mesh(new THREE.BoxGeometry(mm(w + 2 * t), mm(t), mm(d + 2 * t)), M.felt), 0, t / 2, 0);
  for (const [sx, sz, bw, bd] of [[0, -1, w + 2 * t, t], [0, 1, w + 2 * t, t],
                                  [-1, 0, t, d], [1, 0, t, d]]) {
    add(g, new THREE.Mesh(new THREE.BoxGeometry(mm(bw), mm(h), mm(bd)), M.felt),
        sx * (w / 2 + t / 2), t + h / 2, sz * (d / 2 + t / 2));
  }
  return g;
}

/**
 * 리프트 클램프 — **탄두를 밑에서 받쳐 공중으로 들어 올린다.** 돌리는 물건이 아니다.
 *
 * 레퍼런스는 Codex 로 뽑았고 문구가 정본이다 (`MILESTONES.md` §S1 스타일 문구).
 * 형태의 정체는 셋이다 — **① 양쪽 승강 기둥(볼스크류+리니어 레일) ② 그 사이를 오르내리는
 * 크로스바 ③ 크로스바 위의 V블록 한 쌍.** 이 셋이 없으면 그냥 받침대로 읽힌다.
 *
 * `liftMm` 은 **V홈 바닥 높이**다 — 여기에 작업물 축이 얹힌다. 컨베이어 이송면(기본 900)
 * 보다 높아야 "들어 올렸다" 가 되고, 배치안의 스테이션 z 가 이 값과 같아야 한다.
 */
export function lifter({ wMm = 900, dMm = 620, hMm = 1150, liftMm = 1050, cradleMm } = {}) {
  const g = new THREE.Group();
  const baseH = 45;
  const colW = 95;                       // 승강 기둥 단면
  const colX = wMm / 2 - colW / 2 - 40;
  // **아무것도 베이스 밖으로 안 나간다.** 처음엔 옆 클램프가 `wMm` 을 270mm 넘겨
  // 배치안에서 옆 물건과 겹쳤고, 게이트가 잡았다 (2026-08-04). 인자가 곧 발자국이어야
  // 겹침 검사·크기 칸이 같은 숫자를 본다 (파일 머리 규약).
  const cradle = cradleMm ?? wMm * 0.58;
  const barH = 95;                       // 크로스바 높이
  const barY = Math.min(Math.max(liftMm - barH - 90, baseH + 120), hMm - barH - 60);

  add(g, box(wMm, baseH, dMm, M.body), 0, baseH / 2, 0);                    // 베이스 판
  add(g, box(wMm - 120, 14, dMm - 120, M.dark), 0, baseH + 7, 0);           // 상면 홈

  for (const s of [-1, 1]) {
    const x = s * colX;
    add(g, box(colW, hMm, colW, M.body), x, baseH + hMm / 2, 0);            // 기둥
    add(g, box(colW + 40, 26, colW + 40, M.body), x, baseH + hMm + 13, 0);  // 캡
    // 볼스크류 + 리니어 레일 — **이 둘이 "승강" 신호다.** 없으면 그냥 기둥이다
    add(g, cyl(34, hMm - 80, M.steel, 12), x, baseH + hMm / 2, colW / 2 - 4);
    add(g, box(22, hMm - 60, 12, M.steel), x, baseH + hMm / 2, -(colW / 2 - 2));
    add(g, box(colW + 26, 130, colW + 26, M.dark), x, barY + barH / 2, 0);  // 캐리지 블록
    add(g, box(colW + 60, 30, colW + 30, M.body), x, baseH + 15, 0);        // 기둥 발
  }

  add(g, box(2 * colX - colW, barH, 120, M.body), 0, barY + barH / 2, 0);   // 크로스바

  // V블록 한 쌍 — **V홈이 이 물건의 정체다.** 기울인 판 두 짝으로 만든다.
  for (const s of [-1, 1]) {
    const x = s * (cradle / 2);
    add(g, box(150, 60, 190, M.body), x, barY + barH + 30, 0);              // 받침 발
    for (const t of [-1, 1]) {
      const v = box(120, 22, 150, M.body);
      v.rotation.x = t * 0.72;                                              // 약 41° — V 각 82°
      add(g, v, x, barY + barH + 95, t * 52);
    }
  }

  // 옆 클램프 두 짝 — 가볍게 문다. 작업물 축(=`liftMm`) 높이에 온다
  for (const s of [-1, 1]) {
    const x = s * Math.min(cradle / 2 + 190, wMm / 2 - 70);
    add(g, box(70, 200, 60, M.dark), x, barY + barH + 100, 0);              // 클램프 기둥
    for (const t of [-1, 1]) {
      add(g, box(60, 26, 90, M.steel), x, liftMm + t * 46, t * 30);         // 집게 두 짝
    }
  }
  return g;
}

/**
 * 경고 비콘 — **작은데 신호가 세다.** 화이트 모형에서 색이 있는 것은 유리뿐이라,
 * 돔 하나가 시선을 끌고 "여기는 위험구역" 을 한 글자도 없이 말한다.
 *
 * 색을 재질로 넣지 않고 **공유 재질 `dark` + 유리 돔**으로 낸다 — 새 재질을 만들면
 * 화이트 모형의 6색 규약이 무너진다 (파일 머리 규약).
 */
export function beacon({ hMm = 1400, diaMm = 120 } = {}) {
  const g = new THREE.Group();
  const poleH = hMm - diaMm;
  add(g, box(diaMm * 1.6, 24, diaMm * 1.6, M.dark), 0, 12, 0);            // 바닥 판
  add(g, cyl(46, poleH, M.dark, 10), 0, poleH / 2, 0);                    // 기둥
  add(g, cyl(diaMm * 1.15, 30, M.dark, 14), 0, poleH + 15, 0);            // 베이스 링
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(mm(diaMm / 2), 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    M.glass,
  );
  dome.position.y = mm(poleH + 30);
  g.add(dome);
  add(g, cyl(diaMm, 26, M.dark, 14), 0, poleH + diaMm / 2 + 30, 0);       // 상단 캡
  return g;
}


/**
 * 갠트리 크레인 — **이 화면에서 가장 큰 구조물이다.**
 *
 * 지금까지 모든 것이 허리 높이였다. 천장 3m 가 통째로 비어 사진이 납작했고, 이 하나가
 * **수직과 규모**를 동시에 채운다. 방산 라인에서 실제로 쓰는 장비이기도 하다 — 리프터가
 * 못 드는 무거운 탄체를 옮긴다.
 *
 * 형태의 정체 넷 — **양쪽 주행 레일 · 걸쳐진 상자형 거더 · 그 위를 달리는 트롤리 ·
 * 내려온 호이스트 갈고리.** 하나라도 빠지면 그냥 대들보로 읽힌다.
 *
 * `baseMm` 은 **레일 밑면 높이**다 (`wallCabinet` 과 같은 규약) — 0 을 주면 바닥에 내려온다.
 * 인자 이름은 공용 치수 이름을 쓴다: `lengthMm` = 거더 스팬 · `dMm` = 레일 길이.
 */
export function crane({ lengthMm = 5000, dMm = 3400, baseMm = 2400, hookDropMm = 900, trolleyAtMm = 0 } = {}) {
  const g = new THREE.Group();
  const railH = 260, railW = 130;
  const girH = 330, girD = 300;                 // 거더 단면
  const railY = baseMm + railH / 2;
  const girY = baseMm + railH + girH / 2;
  const halfSpan = lengthMm / 2;

  // 주행 레일 2줄 (깊이 방향 Z) — I 형강처럼 위아래 플랜지를 둔다
  for (const sx of [-1, 1]) {
    const x = sx * halfSpan;
    add(g, box(railW, railH * 0.55, dMm, M.steel), x, railY, 0);              // 웨브
    for (const sy of [-1, 1]) {
      add(g, box(railW * 1.7, railH * 0.22, dMm, M.steel), x, railY + sy * railH * 0.39, 0);
    }
    // 레일 받침 — `baseMm` 이 0 이 아니면 바닥까지 기둥이 내려온다
    if (baseMm > 1) {
      for (const sz of [-1, 1]) {
        add(g, box(railW * 1.4, baseMm, railW * 1.4, M.dark), x, baseMm / 2, sz * (dMm / 2 - railW));
      }
    }
  }

  // 거더 — 레일 위에 걸친다. 양 끝에 주행 대차(엔드트럭).
  // **브리지 전체가 부분그룹이다** — 레일을 따라 달리는 것은 거더 통째이지 트롤리가 아니다.
  // 트롤리는 거더 위(x)를, 브리지는 레일 위(z)를 달린다 — 축이 다르다.
  const bridge = new THREE.Group();
  bridge.name = 'bridge';
  g.add(bridge);
  add(bridge, box(lengthMm + railW * 2, girH, girD, M.body), 0, girY, 0);
  for (const sx of [-1, 1]) {
    add(bridge, box(railW * 2.4, girH * 0.7, girD * 1.5, M.dark), sx * halfSpan, girY, 0);
    for (const sz of [-1, 1]) {                                              // 바퀴
      const w = cyl(150, 90, M.steel, 12);
      w.rotation.x = Math.PI / 2;
      add(bridge, w, sx * halfSpan, baseMm + railH, sz * girD * 0.6);
    }
  }

  // 트롤리 + 호이스트 — **부분그룹으로 뗀다.** 재생기가 이것만 옮기면 되고,
  // 매 프레임 크레인 30개 메시를 다시 만들 이유가 없다 (`userData.crane` 로 찾는다).
  const t = new THREE.Group();
  t.name = 'trolley';
  const tx = Math.max(-halfSpan + 400, Math.min(halfSpan - 400, trolleyAtMm));
  t.position.x = mm(tx);
  bridge.add(t);
  // 거더 **위**를 달리는 대차. 이게 있어야 "크레인" 이 된다
  add(t, box(560, 210, girD * 1.2, M.body), 0, girY + girH / 2 + 105, 0);
  for (const sz of [-1, 1]) {
    const w = cyl(120, 70, M.steel, 10);
    w.rotation.x = Math.PI / 2;
    add(t, w, 0, girY + girH / 2, sz * girD * 0.5);
  }

  // 호이스트 — 케이블 + 갈고리 블록. **아래로 내려온 선 하나가 높이를 설명한다**
  const drop = Math.max(120, Math.min(hookDropMm, girY - 200));
  const hoist = new THREE.Group();
  hoist.name = 'hoist';
  t.add(hoist);
  add(hoist, cyl(26, drop, M.dark, 8), 0, girY + girH / 2 - drop / 2, 0);
  add(hoist, box(190, 150, 150, M.dark), 0, girY + girH / 2 - drop - 60, 0);
  const hookR = 90;
  const hook = new THREE.Mesh(
    new THREE.TorusGeometry(mm(hookR), mm(26), 8, 14, Math.PI * 1.45), M.steel,
  );
  hook.position.y = mm(girY + girH / 2 - drop - 140 - hookR);
  hook.rotation.z = Math.PI / 2;
  hook.castShadow = true;
  hoist.add(hook);
  // 재생기가 찾을 손잡이 — **스팬을 같이 실어** 트롤리가 거더 밖으로 못 나가게 한다
  // `hookYMm` — 갈고리 블록이 매달린 높이. 재생기가 작업물을 여기에 매단다
  g.userData.crane = { trolley: t, bridge, halfSpanMm: halfSpan, halfRailMm: dMm / 2,
    baseXMm: tx, hookYMm: girY + girH / 2 - drop - 60 };
  return g;
}

/**
 * 작업자 — **건축 화이트 모형의 스케일 인물상이다.**
 *
 * 사람 하나가 서 있으면 방 크기가 즉시 읽힌다. 그게 이 부품의 전부이고, 그래서
 * **얼굴·손가락·옷 주름을 안 그린다** — 디테일을 넣는 순간 인물상이 아니라 캐릭터가 되고
 * 화이트 모형의 문법이 깨진다. 헬멧만 있으면 "작업자" 로 읽힌다.
 */
export function worker({ hMm = 1750 } = {}) {
  const g = new THREE.Group();
  const u = hMm / 1750;                        // 기준 키에 대한 배율
  const S = (v) => v * u;
  add(g, cyl(S(560), S(30), M.dark, 20), 0, S(15), 0);                        // 받침 원판
  for (const sx of [-1, 1]) {                                                 // 다리
    add(g, cyl(S(150), S(830), M.shell, 10), sx * S(105), S(30 + 415), 0);
    add(g, box(S(170), S(90), S(300), M.dark), sx * S(105), S(75), S(50));    // 신발
  }
  add(g, cyl(S(320), S(70), M.shell, 12), 0, S(880), 0);                      // 골반
  add(g, box(S(420), S(520), S(230), M.shell), 0, S(1160), 0);                // 몸통
  for (const sx of [-1, 1]) {                                                 // 팔
    add(g, cyl(S(120), S(620), M.shell, 8), sx * S(255), S(1150), 0);
  }
  add(g, cyl(S(150), S(120), M.shell, 10), 0, S(1470), 0);                    // 목
  add(g, cyl(S(230), S(220), M.shell, 12), 0, S(1620), 0);                    // 머리
  // 헬멧 — **이 한 조각이 "작업자" 를 만든다**
  const helm = new THREE.Mesh(
    new THREE.SphereGeometry(mm(S(140)), 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.body,
  );
  helm.position.y = mm(S(1700));
  helm.castShadow = true;
  g.add(helm);
  add(g, cyl(S(330), S(24), M.body, 16), 0, S(1700), 0);                      // 챙
  return g;
}

/**
 * 탄약 팔레트 — **반복이 규모를 만든다.** 탄두 한 발보다 열두 발 쌓인 쪽이 훨씬 세다.
 *
 * 그리고 이건 장식이 아니라 **모순을 고친다** — AMR 은 높이 190mm 인데 공급 자리가
 * 1900mm 선반이면 거기서 아무것도 못 받는다. 저상 팔레트가 AMR 이 실제로 붙는 높이다.
 */
export function ammoPallet({ wMm = 1200, dMm = 800, rows = 2, perRow = 6, shellDiaMm = 155 } = {}) {
  const g = new THREE.Group();
  const deckH = 130;                            // 팔레트 상면
  add(g, box(wMm, 40, dMm, M.dark), 0, deckH - 20, 0);                        // 상판
  add(g, box(wMm, 26, dMm, M.dark), 0, 13, 0);                                // 하판
  // 지게차 포크 구멍 — 받침 블록 3개 사이의 빈 곳이 곧 구멍이다
  for (const sx of [-1, 0, 1]) {
    add(g, box(wMm * 0.16, deckH - 66, dMm, M.dark), sx * (wMm / 2 - wMm * 0.08), 26 + (deckH - 66) / 2, 0);
  }
  const len = Math.min(dMm - 60, shellDiaMm * 5.2);
  const pitch = Math.min((wMm - 80) / perRow, shellDiaMm * 1.12);
  const layerH = shellDiaMm + 40;               // 간살 두께 포함
  for (let r = 0; r < rows; r += 1) {
    const y = deckH + 30 + r * layerH + shellDiaMm / 2;
    add(g, box(wMm - 40, 26, dMm - 60, M.body), 0, y - shellDiaMm / 2 - 13, 0);   // 간살(분리대)
    for (let i = 0; i < perRow; i += 1) {
      const c = cyl(shellDiaMm, len, M.body, 14);
      c.rotation.x = Math.PI / 2;                                             // 축을 Z 로 눕힌다
      add(g, c, -((perRow - 1) * pitch) / 2 + i * pitch, y, 0);
      add(g, cyl(shellDiaMm * 1.04, 14, M.dark, 14), 0, 0, 0).position.set(
        mm(-((perRow - 1) * pitch) / 2 + i * pitch), mm(y), mm(len * 0.22),
      );
      g.children[g.children.length - 1].rotation.x = Math.PI / 2;             // 회전 밴드
    }
  }
  return g;
}

/** 회전 척 — 탄두를 물고 돌린다. **3점 조가 이 물건의 정체다.** */
export function chuck({ diaMm = 320, hMm = 420, boreMm = 90 } = {}) {
  const g = new THREE.Group();
  const cy = hMm - diaMm / 2;                // 척 중심 높이
  add(g, box(diaMm * 0.9, 40, diaMm * 0.8, M.dark), 0, 20, 0);              // 베이스 판
  // **받침은 척 뒤에 둔다.** 같은 z 에 두면 기둥이 척 앞을 가려 3점 조가 안 보인다.
  const faceD = 120, pedD = diaMm * 0.42;
  add(g, box(diaMm * 0.5, cy, pedD, M.body), 0, cy / 2, -(faceD / 2 + pedD / 2));

  const face = cyl(diaMm, faceD, M.body, 28);                               // 척 몸통 (축 Z)
  face.rotation.x = Math.PI / 2;
  add(g, face, 0, cy, 0);
  const bore = cyl(boreMm, faceD + 20, M.dark, 16);                         // 중앙 보어
  bore.rotation.x = Math.PI / 2;
  add(g, bore, 0, cy, 0);

  // 조 3개 — 120° 간격. 계단 2단이라 "물린다" 는 느낌이 난다.
  for (let i = 0; i < 3; i += 1) {
    const a = (i * 2 * Math.PI) / 3 + Math.PI / 2;   // 12시부터 120° 간격
    const jx = Math.cos(a), jy = Math.sin(a);
    // 조는 **반경 방향으로 길고 얇은 계단**이다. 정사각 단면으로 만들면 큐브가 떠 있는
    // 것처럼 보인다(2차 렌더의 결함). 반지름은 조 절반을 빼고 잡아 hMm 을 안 넘긴다.
    for (const [r, len, wide, thick] of [[0.26, 78, 54, 40], [0.38, 62, 44, 26]]) {
      const j = add(g, box(len, wide, thick, M.steel),
        jx * diaMm * r, cy + jy * diaMm * r, faceD / 2 + thick / 2);
      j.rotation.z = a;
    }
  }
  return g;
}

/** 부품 트레이 — 해체 4단계 "분류" 의 산출물 자리. 격자가 있어야 분류대로 읽힌다. */
export function partTray({ wMm = 700, dMm = 480, cols = 6, rows = 4, filled = 4 } = {}) {
  const g = new THREE.Group();
  const wall = 22, h = 70;
  add(g, box(wMm, 18, dMm, M.body), 0, 9, 0);                               // 바닥
  for (const [w, d, x, z] of [
    [wMm, wall, 0, -(dMm - wall) / 2], [wMm, wall, 0, (dMm - wall) / 2],
    [wall, dMm, -(wMm - wall) / 2, 0], [wall, dMm, (wMm - wall) / 2, 0]]) {
    add(g, box(w, h, d, M.body), x, h / 2, z);                              // 테두리
  }
  // ponytail: 구멍은 안 뚫는다 (CSG 비용). 어두운 얕은 원통이 같은 값을 낸다 — 축척상 구별 불가.
  const dia = Math.min((wMm - 80) / cols, (dMm - 80) / rows) * 0.72;
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
    const x = -wMm / 2 + (wMm / cols) * (c + 0.5);
    const z = -dMm / 2 + (dMm / rows) * (r + 0.5);
    add(g, cyl(dia, 26, M.dark, 12), x, 22, z);                             // 구멍
    if ((r * cols + c) % Math.max(2, Math.round((rows * cols) / filled)) === 0) {
      add(g, cyl(dia * 0.8, 90, M.shell, 12), x, 63, z);                    // 꽂힌 부품
    }
  }
  return g;
}

/**
 * 방폭 격벽 — 해체 셀을 가른다.
 *
 * **기본 높이가 1200(허리)인 이유** — 2400 으로 세웠더니 메인뷰에서 셀 안이 통째로
 * 안 보였다. 배치를 보는 화면인데 배치를 가리면 소품이 아니라 방해물이다.
 * 전신 차폐가 필요하면 `hMm` 을 올리되 **관측창이 시선 높이(1500)에 오는지** 보고 정한다.
 */
export function blastWall({ lengthMm = 3000, hMm = 1200, tMm = 300, windowMm = 0 } = {}) {
  const g = new THREE.Group();
  const capH = 90;
  const winH = 520;
  // 창이 없으면 통벽. 있으면 **좌·우·위·아래로 쪼개** 진짜 구멍을 낸다 —
  // 통벽 안에 유리판을 묻으면 렌더에서 아예 안 보인다 (첫 렌더의 결함).
  const winW = windowMm > 0 ? Math.min(windowMm, lengthMm - 400) : 0;
  if (winW > 0 && hMm > winH + 400) {
    const side = (lengthMm - winW) / 2;
    const yc = hMm * 0.62;
    for (const s of [-1, 1]) {
      add(g, box(side, hMm, tMm, M.body), s * (lengthMm - side) / 2, hMm / 2, 0);
    }
    add(g, box(winW, hMm - yc - winH / 2, tMm, M.body), 0, (hMm + yc + winH / 2) / 2, 0);  // 창 위
    add(g, box(winW, yc - winH / 2, tMm, M.body), 0, (yc - winH / 2) / 2, 0);              // 창 아래
    add(g, box(winW, winH, tMm - 60, M.glass), 0, yc, 0);
  } else {
    add(g, box(lengthMm, hMm, tMm, M.body), 0, hMm / 2, 0);
  }
  // 캡·기초는 **본체를 감싼다 — 면을 하나도 맞추지 않는다.**
  //
  // 두 면이 정확히 같은 평면이면 깊이 버퍼가 앞뒤를 못 정해 카메라가 움직일 때마다
  // 픽셀 단위로 승자가 바뀐다(z-fighting) — 벽이 반짝거린다. 재질 문제가 아니다.
  // 처음엔 옆면만 어긋나게 했다가 **윗면이 둘 다 y=hMm** 인 걸 놓쳤다 (2026-08-04).
  // 그래서 캡을 세 방향 전부 키워 본체 밖으로 내민다 — 실제 코핑도 그렇게 생겼다.
  const OVER = 30;                                    // 옆으로 내미는 양(편측 15mm)
  add(g, box(lengthMm + OVER, capH + 8, tMm + OVER, M.dark), 0, hMm - capH / 2 + 4, 0);
  add(g, box(lengthMm + OVER, 120, tMm + OVER, M.dark), 0, 60, 0);            // 하단 기초
  return g;
}

Object.assign(PROPS, { conveyor, warhead, round, chuck, partTray, blastWall, lifter, beacon,
  crane, worker, ammoPallet });

/**
 * 로봇이 올라앉은 이동식 카트 — **알루미늄 프레임 + 백색 외판 + T슬롯 상판.**
 *
 * 출처: 주인님 줄자 실측 `810 × 597 × 1000mm` (2026-08-07) + 가우시안 스플랫
 * 4시점 렌더 관찰 (`docs/evidence/2026-08-07/splat-pipeline-dryrun.md`).
 *
 * **완벽 일치가 목적이 아니다 — 교체가 쉬운 게 목적이다** (주인님 판정 2026-08-07).
 * 맵 세팅이 끝나면 실측값으로 갈아끼운다. 그래서 **모든 치수가 인자로 나와 있고**
 * 기본값이 곧 지금 실측값이다. 바꿀 때 이 함수 안을 읽을 필요가 없다.
 *
 * 근사로 남긴 것 (스플랫 4시점에서도 안 보였다):
 *   · 캐스터 형식·지름 — 하부가 가려짐. 75mm 일반 캐스터로 근사
 *   · 후면판 — 어느 시점에도 안 나옴. 좌우와 같다고 가정
 *   · T슬롯 골 개수 — 10~12 로 읽혀 11 로 둠 (`grooves` 인자)
 */
export function robotCart({
  wMm = 810, dMm = 597, hMm = 1000,      // 겉치수 — 줄자 실측
  frameMm = 40,                           // 압출재 한 변
  // ⚠ **T슬롯 데크가 상판 전체다. 흰 천판은 없다** (2026-08-08 주인님 정정 · 영상 원본 확인).
  // 예전 기본값 `500×440` + 흰 천판은 **오독이었다** — 스플랫 렌더에서 흰 A4 태그 4장이
  // 얹힌 걸 보고 "가운데 작은 데크 + 넓은 흰 상판" 으로 읽었다. 실물은 **홈 파인 알루미늄
  // 판이 끝까지 덮고**, 흰 것은 그 위에 놓인 **태그 종이**다 (`scratchpad` 영상 t=2s 원본).
  // 태그는 그리지 않는다 — 옮기고 떼는 소모품이라 형상에 굳히면 다음 사람이 실측으로 읽는다.
  // `null` 이면 상판을 꽉 채운다 — `wMm` 을 바꿔도 데크가 따라온다.
  deckWMm = null, deckDMm = null, deckTMm = 30,
  groovePitchMm = 30,                     // 골 **간격**. 개수 대신 간격이 실물 상수다 (크기가 변해도 안 틀린다)
                                          // 2026-09-05 스캔 정사영 자기상관으로 **30mm 실측** (옛 42 는 영상 눈대중)
  // 덱 윗면 무늬 — `scanTexture('deck-top')`(브라우저) 또는 `null`(홈을 형상으로 그린다). 무늬가 있으면
  // 홈 상자를 안 얹는다 — 무늬에 홈이 있어 겹치면 두 겹 홈이 된다
  deckMap = null,
  mountMm = 240, mountTMm = 37,           // 로봇 마운트판 — 두께는 계산값(§workcell.js)
  casterMm = 75,                          // 근사
  estop = true,
} = {}) {
  const g = new THREE.Group();
  const f = frameMm;
  // 프레임을 4mm 안으로 들인다 — 예전엔 프레임 바깥면과 천판 바깥면이 **둘 다 ±405** 라
  // 옆면에서도 같은 평면 두 장이었다. 실물도 판이 프레임보다 조금 나온다.
  const hx = (wMm - f) / 2 - 4;
  const hz = (dMm - f) / 2 - 4;
  const deckW = deckWMm ?? wMm;
  const deckD = deckDMm ?? dMm;
  const deckT = deckTMm;
  const deckBot = hMm - deckT;            // 데크 윗면이 곧 `hMm` 이다 (§workcell.js 바닥→데크 1000)
  // ⚠ **상단 레일은 데크 속으로 들어간다.** 예전엔 `hMm − f/2` 라 레일 윗면이 상판 윗면과
  // **둘 다 1000.0** 이었다 — 둘레 띠에서 두 면이 정확히 겹쳐, 화면을 돌릴 때마다
  // 가장자리가 줄무늬로 깨지고 **상판이 두 장으로 보였다** (2026-08-08 주인님 사진).
  // 6mm 파묻어 겹침을 없앤다 — 이 하나로 레일↔상판 · 레일 밑면↔외판 윗면 · 기둥 윗면이
  // 같이 풀린다. 데크가 프레임보다 4mm 나와서 앞쪽 **알루미늄 립**으로 보이는 것도 실물과 같다.
  const topY = deckBot + 6 - f / 2;
  const botY = casterMm + f / 2;          // 캐스터 위에 프레임이 앉는다

  // ── 프레임 12본. 압출재라 **중앙 홈**이 있다 — 이게 없으면 그냥 흰 상자가 된다.
  const groove = (len, axis) => {
    const t = f * 0.22;
    return axis === 'y' ? box(t, len, t, M.dark) : axis === 'x' ? box(len, t, t, M.dark) : box(t, t, len, M.dark);
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    // 기둥도 레일 윗면까지 올린다 — 예전엔 `hMm − casterMm − f` 라 기둥 윗면(980)이
    // **천판 밑면과 같은 평면**이었다. 레일이 모서리까지 안 닿아서(±365 vs 기둥 ±385)
    // 가려지지도 않아, 밑에서 올려다보면 거기서 반짝였다. 이제 둘 다 천판 속에 묻힌다.
    const len = topY + f / 2 - botY;
    add(g, box(f, len, f, M.steel), sx * hx, botY + len / 2, sz * hz);
    // 홈은 **파묻는다** — 겉면을 맞추면 z-fighting 이다 (이 파일 머리말 규약)
    add(g, groove(len * 0.98, 'y'), sx * hx, botY + len / 2, sz * hz);
  }
  for (const y of [topY, botY]) {
    for (const sz of [-1, 1]) {
      add(g, box(wMm - 2 * f, f, f, M.steel), 0, y, sz * hz);
      add(g, groove((wMm - 2 * f) * 0.98, 'x'), 0, y, sz * hz);
    }
    for (const sx of [-1, 1]) {
      add(g, box(f, f, dMm - 2 * f, M.steel), sx * hx, y, 0);
      add(g, groove((dMm - 2 * f) * 0.98, 'z'), sx * hx, y, 0);
    }
  }

  // ── 외판. 겉면을 **데크와 정확히 맞춘다 — 립이 없다** (2026-08-08 주인님).
  //
  // 34mm 안쪽 → 4mm 립 → **0**. 여기서 "겉면 정렬 금지" 규약과 부딪히는 것 같지만 아니다:
  // z-fighting 은 두 면이 **같은 평면 + 같은 자리**에서 겹칠 때 난다. 데크는 y 970~1000,
  // 외판은 y 115~960 이라 **같은 x 면(±405)을 써도 겹치는 구간이 없다.** 프레임만 4mm
  // 안(±401)에 있어서, 그 사이 10mm 띠가 얕은 **그림자 홈**으로 보인다 — 실물의 그 선이다.
  const panelT = 10;
  const inner = hMm - casterMm - f * 2;
  const faceX = wMm / 2 - panelT / 2;             // 외판 겉면 = 데크 겉면 (립 0)
  const faceZ = dMm / 2 - panelT / 2;
  for (const sx of [-1, 1]) add(g, box(panelT, inner, dMm - 2 * f, M.shell), sx * faceX, botY + f / 2 + inner / 2, 0);
  add(g, box(wMm - 2 * f, inner, panelT, M.shell), 0, botY + f / 2 + inner / 2, -faceZ);

  // ── 문 2짝 (+Z 정면). 매입 손잡이는 **어두운 슬릿**으로 — 형태로 읽힌다
  for (const sx of [-1, 1]) {
    const dw = (wMm - 2 * f) / 2 - 6;
    add(g, box(dw, inner, panelT, M.shell), sx * (dw / 2 + 3), botY + f / 2 + inner / 2, faceZ);
    add(g, box(dw * 0.42, 26, 6, M.dark), sx * (dw / 2 + 3), botY + f / 2 + inner - 90, faceZ + panelT / 2);
  }

  // ── 상판 2층: **T슬롯 데크(상판 전체)** → 마운트판. 흰 천판은 없앴다 (위 §데크).
  // 이 카트의 인상은 **홈 파인 회색 판이 위를 다 덮는 것**이다.
  // **높이 기준은 데크 윗면 = `hMm`** (`workcell.js` §CART: 바닥→데크 윗면 1000).
  if (deckMap) {
    // 윗면(+Y · BoxGeometry 재질 순서 +x −x +y −y +z −z 의 셋째)만 무늬, 옆·밑은 강판 그대로
    // 무늬를 요철로도 쓴다(bumpMap) — 홈이 빛을 받아 파인 것으로 읽힌다. 알루미늄이라 금속감을 조금 올린다
    const deckTop = new THREE.MeshStandardMaterial({ map: deckMap, bumpMap: deckMap, bumpScale: 0.0018,
      roughness: 0.42, metalness: 0.35 });
    add(g, new THREE.Mesh(new THREE.BoxGeometry(mm(deckW), mm(deckT), mm(deckD)),
      [M.steel, M.steel, deckTop, M.steel, M.steel, M.steel]), 0, hMm - deckT / 2, 0);
  } else add(g, box(deckW, deckT, deckD, M.steel), 0, hMm - deckT / 2, 0);
  // 골 개수는 **간격에서 나온다.** 개수를 박으면 데크가 커질 때 홈이 성겨진다
  const grooves = deckMap ? 0 : Math.max(1, Math.round(deckW / groovePitchMm) - 1);
  const pitch = deckW / (grooves + 1);
  for (let i = 1; i <= grooves; i += 1) {
    // ⚠ **0.6mm 내밀어 얹는다.** 예전엔 골 윗면이 데크 윗면과 **정확히 같아서**
    // 카메라가 움직일 때마다 데크 상판 전체가 반짝였다 (2026-08-08 주인님 지적).
    // 이 파일 머리말이 경고한 바로 그것인데 정작 여기서 밟고 있었다 — 골은 어차피
    // 어두운 색이라 조금 얹혀도 홈으로 읽힌다. 파묻으면 데크 안에 갇혀 안 보인다.
    add(g, box(pitch * 0.34, 6, deckD * 0.96, M.dark), -deckW / 2 + i * pitch, hMm + 0.6 - 3, 0);
  }
  // 마운트판 밑면을 데크에 **4mm 파묻는다** — 딱 얹으면 두 면이 다 `hMm` 이라 또 반짝인다
  add(g, box(mountMm, mountTMm, mountMm, M.steel), 0, hMm + mountTMm / 2 - 4, 0);

  // ── 캐스터 4. 가려져 못 봤다 — 지름만 맞춘 근사다
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const w = cyl(casterMm, 30, M.dark);
    w.rotation.z = Math.PI / 2;
    add(g, w, sx * hx, casterMm / 2, sz * hz);
  }

  // ── E-stop. 문에 달린 황/적 박스 — 작지만 이게 있어야 "장비"로 읽힌다
  if (estop) {
    add(g, box(75, 110, 60, M.estopBody), -hx + 10, hMm - 300, hz + 20);
    const btn = cyl(42, 22, M.estopBtn);
    btn.rotation.x = Math.PI / 2;
    add(g, btn, -hx + 10, hMm - 300, hz + 60);
  }
  return g;
}

/**
 * 카트 앞에 선 **이동식 승강 거치대** — 흰 각파이프 + 백색 상판 + 하단 선반 + 캐스터 4.
 *
 * ⚠ **상판 치수(`wMm`·`dMm`·`hMm`)의 정본은 게이트 상자 `작업대` 다** — `workspace.js` 가
 * 거기서 읽어 넘긴다. 여기 기본값은 그 상자 없이 부를 때의 자리표시일 뿐이고 **실측이 아니다.**
 * 상판 밑(선반·파이프·캐스터)만 `workcell.js SIDE_STAND` 의 영상 관찰값이다.
 *
 * 이 물건을 "승강식"으로 읽히게 하는 건 크기가 아니라 **기둥 중간의 검은 클램프 레버**다
 * (E-stop 이 카트를 "장비"로 읽히게 하는 것과 같은 자리). 없으면 그냥 흰 책상이다.
 *
 * 근사로 남긴 것 (영상 6프레임에서도 안 보였다):
 *   · 기둥 단면·캐스터 지름 — 25mm 각파이프 / 50mm 캐스터로 근사
 *   · 선반이 판인지 와이어 바구니인지 — 상자에 가려 안 보여 **얕은 트레이**로 근사
 *   · 상판 모서리 R — 영상에선 둥근데 각으로 뒀다 (형태 정체에 안 걸린다)
 */
export function sideStand({
  wMm = 795, dMm = 453, hMm = 888,       // 자리표시 — 정본은 게이트 상자 `작업대`
  topTMm = 18,                            // 상판 두께
  tubeMm = 25,                            // 각파이프 한 변
  legInsetMm = 90,                        // 상판 끝 → 기둥 중심
  shelfHMm = 200, shelfDMm = 300,         // 하단 선반 윗면 높이 · 안깊이
  casterMm = 50,
  clamp = true,
  // 상판 무늬 — `scanTexture('bench1-top')` 등(브라우저) 또는 `null`. 스캔 정사영에서 뽑은 흰 판+검은 매트다
  topMap = null,
} = {}) {
  const g = new THREE.Group();
  const hx = wMm / 2 - legInsetMm;                 // 기둥 x
  const hz = dMm / 2 - tubeMm;                     // 기둥 z
  const legTopY = hMm - topTMm;                    // 기둥 윗끝 — 상판에 **파묻는다**
  const legLen = legTopY - casterMm;

  // ── 상판. 겉면을 기둥과 맞추지 않는다 (파일 머리말 z-fighting 규약)
  if (topMap) {
    const topMat = new THREE.MeshStandardMaterial({ map: topMap, roughness: 0.75, metalness: 0.0 });
    add(g, new THREE.Mesh(new THREE.BoxGeometry(mm(wMm), mm(topTMm), mm(dMm)),
      [M.shell, M.shell, topMat, M.shell, M.shell, M.shell]), 0, hMm - topTMm / 2, 0);
  } else add(g, box(wMm, topTMm, dMm, M.shell), 0, hMm - topTMm / 2, 0);

  // ── 기둥 4 + 옆면 발바닥. 좌우 한 벌씩이 "ㅁ" 자로 서 있다
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(g, box(tubeMm, legLen, tubeMm, M.shell), sx * hx, casterMm + legLen / 2, sz * hz);
      const w = cyl(casterMm, 22, M.dark);
      w.rotation.z = Math.PI / 2;
      add(g, w, sx * hx, casterMm / 2, sz * hz);
    }
    // 발바닥(앞뒤 기둥을 잇는 가로대) + 중간 가로대 — 이 둘이 없으면 기둥이 허공에 뜬다
    add(g, box(tubeMm, tubeMm, dMm - tubeMm, M.shell), sx * hx, casterMm + tubeMm / 2, 0);
    add(g, box(tubeMm, tubeMm, dMm - tubeMm, M.shell), sx * hx, shelfHMm, 0);
  }

  // ── 하단 선반 — 얕은 트레이. 이게 있어야 "짐 싣는 거치대"로 읽힌다
  const shelfW = 2 * hx - tubeMm;
  add(g, box(shelfW, 12, shelfDMm, M.shell), 0, shelfHMm + 6, 0);
  for (const sz of [-1, 1]) {
    add(g, box(shelfW, 46, tubeMm, M.shell), 0, shelfHMm + 29, sz * (shelfDMm / 2 - tubeMm / 2));
  }

  // ── 승강 클램프 레버. 기둥보다 굵게 내밀어야 실루엣에 남는다
  if (clamp) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(g, box(tubeMm * 1.5, 34, tubeMm * 1.5, M.dark), sx * hx, casterMm + legLen * 0.58, sz * hz);
      add(g, box(20, 14, 62, M.dark), sx * hx, casterMm + legLen * 0.58, sz * hz + sz * 24);
    }
  }
  return g;
}

// **둘 다 `PROPS` 에 등록하지 않는다.** `PROPS` 는 배치안 팔레트에 뜨는 소품 카탈로그인데,
// 카트와 거치대는 배치안이 정하는 물건이 아니라 **실물이 실제로 그 자리에 선 고정물**이다.
// 팔레트에 넣으면 한 배치안에 카트를 여러 대 놓을 수 있게 되고 그건 뜻이 없다.
// `Shared/view3d/workspace.js` 가 이름으로 직접 가져다 쓴다.
