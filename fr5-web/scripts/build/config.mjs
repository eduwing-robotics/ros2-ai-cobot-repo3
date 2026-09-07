#!/usr/bin/env node
/**
 * .env → Shared/data/config/*.json 생성.
 *
 * 왜 있나
 *   **브라우저는 환경변수를 읽을 수 없다.** `process.env` 가 없다.
 *   그래서 `.env` 를 SSOT 로 두고 여기서 JSON 으로 굽는다. 브라우저는 그 JSON 을 fetch 한다.
 *   `Shared/data/config/*.json` 은 **산출물이다 — 직접 고치지 않는다.**
 *
 * 왜 값 검증까지 하나
 *   바코드 번호가 인쇄물과 다르면 **아무것도 안 뜬다.** 콘솔 에러도 없이 조용히 실패한다.
 *   실제로 코드 버그로 번호가 0 이 되어 로봇이 통째로 안 뜬 적이 있다.
 *   틀린 값이면 JSON 을 쓰지 않고 **여기서 멈춘다.**
 *
 * 우선순위: 셸 환경변수 > .env > (없으면 실패)
 *
 * 사용
 *   node scripts/build/config.mjs
 *   FR5_MARKER_BARCODE=5 node scripts/build/config.mjs    # 한 번만 다르게
 *   node scripts/build/config.mjs --check                 # 쓰지 않고 대조만 (게이트용)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK_ONLY = process.argv.includes('--check');

// ---- .env 읽기. 셸 환경변수가 이긴다.
function loadEnv() {
  const env = {};
  for (const name of ['.env', '.env.example']) {
    const p = join(ROOT, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2];
    }
    break; // .env 가 있으면 .env.example 은 안 본다
  }
  return { ...env, ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('FR5_')),
  ) };
}

const env = loadEnv();
const problems = [];

function req(key) {
  const v = env[key];
  if (v === undefined || v === '') problems.push(`${key} 가 없다`);
  return v;
}
function num(key, min, max) {
  const v = Number(req(key));
  if (!Number.isFinite(v)) { problems.push(`${key}="${env[key]}" 는 숫자가 아니다`); return null; }
  if (v < min || v > max) { problems.push(`${key}=${v} 는 범위 ${min}~${max} 밖이다`); return null; }
  return v;
}
function int(key, min, max) {
  const v = num(key, min, max);
  if (v !== null && !Number.isInteger(v)) { problems.push(`${key}=${v} 는 정수여야 한다`); return null; }
  return v;
}
function vec3(key) {
  const raw = req(key);
  if (raw === undefined) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    problems.push(`${key}="${raw}" 는 "숫자,숫자,숫자" 형식이어야 한다`);
    return null;
  }
  return parts;
}
function bool(key) {
  const raw = String(req(key)).toLowerCase();
  if (!['true', 'false'].includes(raw)) { problems.push(`${key}="${env[key]}" 는 true/false 여야 한다`); return null; }
  return raw === 'true';
}

// ---- 값 읽고 검증
// 하한은 **⚙ 슬라이더와 같아야 한다**(10). 여기만 40 이면 크기 시험 시트의
// 10~35mm 를 설정으로 못 박고 매번 URL·슬라이더로 넣어야 한다 —
// 같은 값을 두 곳이 다르게 제한하면 한 곳은 반드시 거짓말을 한다.
const markerMm = num('FR5_MARKER_MM', 10, 400);
const barcode = int('FR5_MARKER_BARCODE', 0, 7);
const markerToRobot = vec3('FR5_MARKER_TO_ROBOT_MM');
const markerVerified = bool('FR5_MARKER_VERIFIED');

const parentLink = req('FR5_GRIPPER_PARENT_LINK');
const meshScale = num('FR5_GRIPPER_MESH_SCALE', 1e-6, 1000);
const gripPos = vec3('FR5_GRIPPER_POSITION_MM');
const gripRot = vec3('FR5_GRIPPER_ROTATION_DEG');
const gripVerified = bool('FR5_GRIPPER_VERIFIED');
// **핑거 돌출은 이 프로젝트에서 유일하게 「갈아 끼울 값」이다** — 핑거팁은 대환 공식 STEP 에도
// 없는 고객 부품이고 우리 것은 자작이다 (STACK.md §그리퍼). 그래서 여기 하나만 두고 나머지를
// 전부 유도한다. 상한 200 은 FR5 가반하중이 아니라 **자릿수 오타를 잡는 선**이다.
const fingerMm = num('FR5_GRIPPER_FINGER_MM', 1, 200);

const camLensOffset = num('FR5_DEPTHCAM_LENS_OFFSET_MM', 0, 300);
const camReach = num('FR5_DEPTHCAM_BRACKET_REACH_MM', 0, 300);
const camCleatW = num('FR5_DEPTHCAM_CLEAT_W_MM', 0, 100);
const camCleatH = num('FR5_DEPTHCAM_CLEAT_H_MM', 0, 100);
const camCleatDrop = num('FR5_DEPTHCAM_CLEAT_DROP_MM', 0, 100);
const camJut = num('FR5_DEPTHCAM_CAM_JUT_MM', -60, 60);
const camOutSign = num('FR5_DEPTHCAM_OUT_SIGN', -1, 1);
const camVerified = bool('FR5_DEPTHCAM_VERIFIED');

// 체결부가 그리퍼 면(35.6mm)보다 넓으면 붙을 자리가 없다 — 값을 잘못 옮긴 것이다.
if (camCleatW !== null && camCleatW > 35.6) {
  problems.push(`FR5_DEPTHCAM_CLEAT_W_MM=${camCleatW} — 체결면 폭 35.6mm 를 넘는다 (DEPTH-CAM.md §브래킷)`);
}
// 뻗는 쪽은 두 값뿐이다. 0 을 받으면 카메라가 그리퍼 속에 파묻혀 조용히 사라진다.
if (camOutSign !== null && camOutSign !== 1 && camOutSign !== -1) {
  problems.push(`FR5_DEPTHCAM_OUT_SIGN=${camOutSign} — +1 또는 -1 만 된다`);
}

// 인쇄된 원본이 있는 번호만 허용한다 — 없는 번호를 넣으면 조용히 실패한다
const AVAILABLE_BARCODES = [2, 3, 5];
if (barcode !== null && !AVAILABLE_BARCODES.includes(barcode)) {
  problems.push(
    `FR5_MARKER_BARCODE=${barcode} — 원본이 있는 것은 ${AVAILABLE_BARCODES.join('·')} 뿐이다. `
    + '다른 번호는 출처에서 받아 Shared/assets/marker/barcode/ 에 넣어라 (STACK.md §마커)',
  );
}

if (problems.length) {
  console.error('설정이 틀렸다 — JSON 을 쓰지 않는다:');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

// ---- JSON 조립. `_` 로 시작하는 키는 사람이 읽는 주석이다.
const GEN = '이 파일은 .env 에서 생성된다 (node scripts/build/config.mjs). **직접 고치지 마라** — 다음 생성에서 덮어써진다.';

const marker = {
  _생성됨: GEN,
  _단위: '밀리미터. 하드 룰 5 — 변환은 robot-view.js 한 곳에서만.',
  markerSizeMm: markerMm,
  _markerSizeMm: '인쇄물의 검은 사각형 한 변. 자로 재서 .env 의 FR5_MARKER_MM 에 넣는다.',
  barcodeValue: barcode,
  _barcodeValue: '3x3_HAMMING63 마커 번호. 인쇄한 시트와 반드시 같아야 한다 — 다르면 아무것도 안 뜬다.',
  markerToRobotMm: markerToRobot,
  _markerToRobotMm: '마커 원점 → 로봇 베이스 원점. 실물 옆 시연에서 한 번 잰다.',
  verified: markerVerified,
  _verified: 'false 면 화면에 "실측값이 아니다" 경고가 뜬다.',
};

// ---- 그리퍼 STL 조립좌표계의 고정점 셋. STL 을 직접 열어 잰 값이다.
// 카메라는 이 좌표계에 세운다 — 그래야 meshRoot 의 0.001 축소를 그대로 타고,
// 그리퍼 마운트를 조정할 때 카메라가 따라온다 (실물에서 같이 움직이는 것과 같다).
// STL 이 바뀌면 scripts/check/assets.sh 의 삼각형 수 게이트가 먼저 잡는다.
// **핑거 길이가 걸린 세 값은 여기서 산술로 나온다** (2026-08-11). 전에는 63.02·80 이 각각
// 박혀 있어서, 핑거를 갈면 두 곳을 따로 고쳐야 했고 하나를 잊으면 카메라가 조용히 어긋났다.
const STL_FLANGE_Y = -71.98;  // 조립좌표계의 플랜지 면. 몸통을 갈지 않는 한 안 바뀐다
const GRIP_BODY_MM = 110;     // 플랜지 → 몸통 끝 (2026-08-05 줄자 실측 · gripper-trim.mjs 가 맞춘 값)
// 플랜지 → 렌즈면. **브래킷은 몸통에 붙으므로 핑거와 무관하다** — 핑거를 갈아도 이 값은
// 그대로고, 바뀌는 것은 「TCP 에서 렌즈까지」(lensHeightMm) 쪽이다.
// 체결 기하가 독립으로 검산한다: cleatDropMm 25 + cleatSize Y 30 = 55.
const LENS_FROM_FLANGE_MM = 55;

// 0.01mm 로 접는다 — STL 을 잰 정밀도가 그 자리다. 접지 않으면 −71.98 + 135 이
// `63.019999999999996` 으로 굳어 `--check` 대조와 문서(63.02)가 눈으로 안 맞는다.
const mm = (v) => Math.round(v * 100) / 100;

const TOOL_LEN_MM = mm(GRIP_BODY_MM + fingerMm);   // 플랜지 → 핑거 끝 = 컨트롤러 툴 Z (D108)
const STL_TCP_Y = mm(STL_FLANGE_Y + TOOL_LEN_MM);  // 핑거 밑면 = TCP
const camLensHeight = mm(TOOL_LEN_MM - LENS_FROM_FLANGE_MM);   // TCP → 렌즈
const STL_TOOL_Z = -325.64;   // 툴 축이 지나는 Z. 그리퍼 마운트 positionMm[1] 이 이걸 상쇄한다
// 브래킷이 붙는 면 — 법선 **+Z**, X ±17.8(폭 35.6) · Y −72.0~15.5(높이 87.5).
// **옆면(X)이 아니다.** 현재 자세에서 조립 +Y 가 월드 −Y(작업대)를 향하므로 이 면은
// 수평으로 벽을 본다 — 실물에서 브래킷이 붙은 그 면이다 (2026-08-10 관절값으로 판정).
// 처음에 반대편(−Z)으로 잡았다가 실렌더에서 브래킷이 팔 안쪽을 향해 정정했다.
const STL_FACE_Z = -311.1;
const STL_FACE_TOP_Y = -72.0;  // 면의 플랜지 쪽 끝. 체결부는 여기서 cleatDrop 만큼 내려온다

const gripper = {
  _생성됨: GEN,
  _단위: '위치는 밀리미터, 회전은 도(°).',
  _왜필요한가: 'fairino5_v6.urdf 에는 팔 링크 7개만 있고 그리퍼가 없다 (STACK.md §그리퍼).',
  parentLink,
  meshScale,
  _meshScale: '그리퍼 STL은 밀리미터, 팔 URDF는 미터다. 이 값을 빼면 1000배로 뜬다.',
  positionMm: gripPos,
  rotationDeg: gripRot,
  _유도: '실측으로 확정 — 플랜지 간격 0.00mm. 회전 X는 +90 (−90은 반대 방향). 상세는 docs/archive/evidence-2026-07/2026-07-30/gripper-mount.md',
  verified: gripVerified,
  meshes: [
    'PGEA-100-40_body.stl',
    'PGEA-100-40_finger_left.stl',
    'PGEA-100-40_finger_right.stl',
  ],
  fingerProtrusionMm: fingerMm,
  _fingerProtrusionMm: '몸통 끝 → 핑거 끝. **갈아 끼울 값은 이것 하나다** — `.env` 의 '
    + 'FR5_GRIPPER_FINGER_MM 을 고치면 toolLengthMm·depthCam.tcpYMm·depthCam.lensHeightMm 이 '
    + '같이 따라온다. 핑거 STL 을 갈면 scripts/check/assets.sh 의 길이 대조가 둘을 맞춰 본다.',
  toolLengthMm: TOOL_LEN_MM,
  _toolLengthMm: '플랜지 → 핑거 끝. **컨트롤러의 활성 툴 Z 와 같아야 하는 값이다** (D108 — '
    + 'TCP 는 핑거 끝). 실기 tool1 = [0,0,135,0,0,0] 이 이 값이고, 핑거를 갈면 펜던트에서 '
    + '여기를 같이 고쳐야 한다. 안 고치면 화면이 손끝을 틀리게 그리고, 고치면 슬롯 승인이 '
    + '깨진다 (PROGRAM-CONTRACT §step 2번 — 깨지는 것이 맞다).',
  fingerHalfStrokeMm: 20,
  _손가락: '개폐를 3D 에 반영한다 (2026-08-04). 손가락 STL 둘을 X 축 대칭으로 밀어 흉내 낸다 — '
    + 'URDF 에 prismatic 관절이 없어 관절이 아니라 메시 이동이다. 20mm 은 총 행정 40mm 의 '
    + '절반이고, 40mm 는 대환 사양서 Stroke 항목이다 (2026-08-05 사양서 대조로 근사 딱지 뗌).',

  // 손목 뎁스카메라. **별도 JSON 을 안 만든 이유** — 카메라는 그리퍼에 얹혀 같이 움직인다.
  // 파일을 가르면 화면 다섯이 각자 import 해야 하는데, 여기 넣으면 loadConfig 가 이미 전파한다.
  depthCam: {
    _출처: '기하의 정본은 docs/ref/arch/DEPTH-CAM.md §브래킷. 80·82 는 2026-08-05, 나머지는 2026-08-10 실측.',
    _구조: '그리퍼의 **벽을 보는 면**(법선 +Z)에 체결부가 붙고, 거기서 +Z 로 뻗은 브래킷에 '
      + '카메라를 꽂아 **작업대를 내려다보게** 한다. 옆면(X)으로 뻗는 게 아니다.',
    outSign: camOutSign,
    _outSign: '브래킷이 뻗는 쪽(+1 = +Z). 실렌더에서 팔 안쪽으로 붙어 한 번 뒤집었다 — '
      + '값 하나로 되뒤집을 수 있게 남긴다.',
    lensOffsetMm: camLensOffset,
    _lensOffsetMm: '툴 축 → 렌즈 중앙. 브래킷이 뻗는 방향(outSign×Z)이다.',
    lensHeightMm: camLensHeight,
    _lensHeightMm: 'TCP → 렌즈, **+Y(작업대) 반대 방향**. lensOffsetMm 과 직교한다 — 같은 축으로 '
      + '읽으면 카메라 두께 25mm 가 들어갈 자리가 없어 모순처럼 보인다. '
      + '⚠ **실측 상수가 아니라 유도값이다** — 렌즈는 몸통에 붙어 안 움직이고 TCP 만 핑거를 '
      + '따라 내려가므로, 핑거를 갈면 이 값이 그만큼 커진다 (= 몸통110+핑거 − 플랜지→렌즈55).',
    bracketReachMm: camReach,
    _bracketReachMm: '체결면(faceZMm) → 브래킷 끝.',
    cleatSizeMm: [camCleatW, camCleatH],
    cleatDropMm: camCleatDrop,
    _cleatSizeMm: '그리퍼에 닿는 체결 단면 (X × Y). 면 상단(faceTopYMm)에서 cleatDropMm 만큼 '
      + '내려와 시작한다 — **그 아래 끝이 렌즈면 높이와 같다.** '
      + '−72 + 25 = −47, −47 + 30 = −17 ≈ 63.02 − 80 = −16.98. 실측 셋이 서로를 검산한다.',
    bracketPlateWidthMm: 79,
    _bracketPlateWidthMm: '카메라를 담는 판의 폭(X). 카메라 90mm 와 11mm 차이가 난다.',
    camJutMm: camJut,
    _camJutMm: '카메라가 판 끝에서 선꽂는 쪽으로 나온 길이(+ = +X). **한가운데가 아니다** — '
      + '15mm 는 폭 차이 11mm 보다 커서 카메라가 판 한쪽 끝을 넘어 걸치고 반대쪽은 판이 4mm '
      + '더 길다. 중앙 정렬로 두면 양쪽 5.5mm 씩 대칭이 되는데 실물이 그렇지 않다.',
    bodySizeMm: [90, 25, 25],
    _bodySizeMm: 'D435 외형. 데이터시트 337029-017 Table 3-52 — 질량 75g 을 뽑은 그 표다. '
      + '긴 축 90 이 X 인 것은 롤 0°(카메라 X축 = 툴 X축 · 2026-08-08 실측)에서 나온다.',
    faceZMm: STL_FACE_Z,
    faceTopYMm: STL_FACE_TOP_Y,
    tcpYMm: STL_TCP_Y,
    toolAxisZMm: STL_TOOL_Z,
    _조립좌표계: '위 넷은 그리퍼 STL 을 열어 잰 고정점이다. 렌즈 중심은 조립좌표계로 '
      + '(camJut 보정 X, tcpYMm−lensHeightMm, toolAxisZMm+outSign×lensOffsetMm) 에 온다. '
      + '⚠ X 가 0 이 아니므로 §화각의 이탈각 45.7°(=atan 82/80)는 X 를 뺀 값이다 — '
      + '실제는 √(82²+9.5²)/80 로 45.9° 다. 차이가 작아 판정은 안 바뀐다.',
    verified: camVerified,
  },
};

// 터틀봇 브리지 주소 — **화면이 사람에게 안 묻게** 한다 (2026-08-28).
//
// 여태는 브라우저마다 `?tb=` 를 한 번씩 쳐야 했고, 안 치면 화면이 터틀봇을 **반투명(가정)**
// 으로만 그렸다. 윈도우 화면이 실제로 그 상태로 하루를 갔다. `?cam=` 이 같은 함정을 겪고
// `global-cam-host.json` 으로 푼 그 방식이다 — 브리지가 `/config` 로 내주고 화면이 묻는다.
//
// **비워 두면 파일을 안 만든다.** 없으면 화면은 「주소를 모른다」로 남고 그건 고장이 아니다.
// ⚠ 파이가 DHCP 라 주소가 바뀔 수 있다 — 바뀌면 `.env` 를 고치고 이 스크립트를 다시 돌린다.
const tbHost = (env.FR5_TB_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

const targets = [
  ['Shared/data/config/marker-offset.json', marker],
  ['Shared/data/config/gripper-mount.json', gripper],
  ...(tbHost ? [['Shared/data/config/tb-host.json', {
    _생성됨: 'node scripts/build/config.mjs — 직접 고치지 마라 (.env FR5_TB_HOST)',
    _무엇: '터틀봇 브리지 주소. 화면이 `?tb=` 없이도 붙게 한다',
    host: tbHost,
  }]] : []),
];

let drift = 0;
for (const [rel, obj] of targets) {
  const path = join(ROOT, rel);
  const next = `${JSON.stringify(obj, null, 2)}\n`;
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (CHECK_ONLY) {
    if (prev !== next) { console.error(`  FAIL  ${rel} 가 .env 와 다르다 — node scripts/build/config.mjs 를 돌려라`); drift = 1; }
    else console.log(`  ${rel}`);
  } else {
    writeFileSync(path, next);
    console.log(`  ${prev === next ? '변화없음' : '생성'}  ${rel}`);
  }
}

if (CHECK_ONLY) process.exit(drift);

console.log(`\n마커 #${barcode} · ${markerMm}mm · verified=${markerVerified}`);
console.log(`그리퍼 ${parentLink} · ${gripPos.join(',')}mm · ${gripRot.join(',')}° · scale ${meshScale}`);
console.log(
  `뎁스캠 체결면 Z=${STL_FACE_Z} (법선 ${camOutSign > 0 ? '+' : '-'}Z) · 체결부 ${camCleatW}×${camCleatH}mm `
  + `(상단에서 ${camCleatDrop}mm 아래) · 브래킷 ${camReach}mm · `
  + `렌즈 TCP 위 ${camLensHeight}mm / 축에서 ${camLensOffset}mm · verified=${camVerified}`,
);
