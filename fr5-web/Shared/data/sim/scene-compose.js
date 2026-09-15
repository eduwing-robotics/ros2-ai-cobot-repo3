// 시연 장면 합성 — 구운 MJCF(`/sim/scene/<robotId>.xml` · 팔+툴+구역 상자)에 **터틀봇·바구니·든 거치대**를 얹는다
// (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 1). 전엔 `scripts/dev/amr-stop-mujoco.mjs` 만 이걸 문자열로 했다 —
// 화면과 스크립트가 같은 모듈을 쓴다(하드 룰 5).
//
// **터틀봇+바구니는 mocap 바디 하나다** — 자리만 `mocap_pos/quat` 로 옮기면 되므로 주행 구간도 장면을 다시 굽지 않고 잰다.
// ⚠ MuJoCo 는 월드에 고정된 바디끼리(mocap↔정적 상자)는 접촉을 안 센다 — 우리가 재는 건 팔(동적)↔터틀봇이라 문제없다.
// **좌표는 실측 SSOT** — `AMR_MM`·`AMR_BASKET`·`CARRIER`·`AMR_HOME`·`coordDefs.user`. 여기서 새 숫자를 만들지 않는다.
// 단위: MJCF 는 미터 · base 프레임. user1 → base 는 `userDef`(실기 coordDefs.user) 로 옮긴다(위치만 · 회전 0.005° 가정 · `safety.py` 와 같다).
import { AMR_BASKET, CARRIER, CARRIER_GRASP_TRUTH, ROUND, carrierBodyOffset } from '../props.js';
import { AMR_MM } from '../layout/catalog.js';
import { AMR_HOME } from '../workcell.js';

/** 파지 자세 회전(고정축 XYZ · `safety._rot_fixed_xyz` 와 같은 식)으로 user1 벡터를 툴 프레임으로 — Rᵀ·v */
export function bodyOffsetInTool() {
  const d = Math.PI / 180;
  const [rx, ry, rz] = CARRIER_GRASP_TRUTH.tcpMmDeg.slice(3).map((v) => v * d);
  const cx = Math.cos(rx); const sx = Math.sin(rx); const cy = Math.cos(ry); const sy = Math.sin(ry); const cz = Math.cos(rz); const sz = Math.sin(rz);
  const R = [[cz * cy, cz * sy * sx - sz * cx, sz * sx + cz * sy * cx], [sz * cy, cz * cx + sz * sy * sx, sz * sy * cx - cz * sx], [-sy, cy * sx, cy * cx]];
  const o = carrierBodyOffset(CARRIER_GRASP_TRUTH.tcpMmDeg[5]);
  const u = [o.dxMm, o.dyMm, 0];
  return [0, 1, 2].map((i) => R[0][i] * u[0] + R[1][i] * u[1] + R[2][i] * u[2]);
}

const m = (mm) => (mm / 1000).toFixed(5);
const half = (w, d, h) => `${m(w / 2)} ${m(d / 2)} ${m(h / 2)}`;

/** user1 → base (mm). `userDef` 는 실기 `coordDefs.user` 여섯. 없으면 null — 결측=차단 */
export function userToBase(p, userDef) {
  if (!Array.isArray(userDef) || userDef.length < 3 || !userDef.slice(0, 3).every(Number.isFinite)) return null;
  return [p[0] + userDef[0], p[1] + userDef[1], p[2] + userDef[2]];
}

/** 터틀봇 mocap 바디의 base 자리·요각 — `moveAmr` 와 XML 이 같은 식을 쓴다 */
export function amrPlacement(amrUser1, userDef) {
  const [x, y, yawDeg] = amrUser1;
  const b = userToBase([x, y, AMR_HOME.topZMm], userDef);
  if (!b) return null;
  return { posM: b.map((v) => v / 1000), yawRad: (yawDeg * Math.PI) / 180 };
}

/** 바구니 중심의 로봇 기준 뒤쪽 오프셋(mm · +x 앞). 실측(−115)이 유도값을 이긴다 */
export function basketBackMm() {
  const wall = AMR_BASKET.wallMm ?? 3;
  return Number.isFinite(AMR_BASKET.offsetMm?.x)
    ? AMR_BASKET.offsetMm.x
    : -(AMR_MM.depthMm / 2 + (AMR_BASKET.innerDMm + 2 * wall) / 2);
}

/**
 * 합성한다.
 * @param {string} robotXml 구운 MJCF (`/sim/scene/<robotId>.xml`)
 * @param {object} o
 * @param {number[]} o.amrUser1 터틀봇 자리 `[xMm, yMm, yawDeg]` (user1)
 * @param {number[]} o.userDef 실기 `coordDefs.user`
 * @param {boolean} [o.carried] 거치대를 손에 들었나 — 들면 툴 바디 안에 상자로 붙는다
 * @param {number[]} [o.carrierUser1] 현재 거치대 윗면 중심 `[x,y,z]` (user1 mm)
 * @param {number[][]} [o.bulletsUser1Mm] 같은 손목 스캔이 낸 총알 중심 xy 배열 (user1 mm)
 * @param {Array} [o.zones] 추가 정적 상자 `[{xMm:[a,b], yMm:[a,b], topZMm}]` (user1) — 구운 장면에 이미 있으면 안 넣는다
 * @returns {string|null} XML. 좌표계가 없으면 null
 */
export function composeDemoScene(robotXml, {
  amrUser1, userDef, carried = false, zones = [], carrierUser1 = null, bulletsUser1Mm = null,
}) {
  if (typeof robotXml !== 'string' || !robotXml.includes('</worldbody>')) return null;
  const place = amrPlacement(amrUser1, userDef);
  if (!place) return null;
  const q = [Math.cos(place.yawRad / 2), 0, 0, Math.sin(place.yawRad / 2)].map((v) => v.toFixed(6)).join(' ');
  const wall = AMR_BASKET.wallMm ?? 3;
  const bw = AMR_BASKET.innerWMm; const bd = AMR_BASKET.innerDMm; const bh = AMR_BASKET.innerHMm;
  const fz = AMR_BASKET.floorAboveGroundMm ?? 0;
  const back = basketBackMm();
  // 바구니는 터틀봇 바디의 **자식** — 같이 움직인다. 로봇 프레임 +x 가 앞이라 뒤쪽은 x 음수
  const amr = `
    <body name="amr" mocap="true" pos="${place.posM.map((v) => v.toFixed(5)).join(' ')}" quat="${q}">
      <geom name="amr_body" type="box" size="${half(AMR_MM.depthMm, AMR_MM.widthMm, AMR_MM.heightMm)}" pos="0 0 ${m(AMR_MM.heightMm / 2)}" rgba="0.5 0.5 0.55 1"/>
      <body name="basket" pos="${m(back)} 0 ${m(fz)}">
        <!-- 바구니 바디 원점 = 안쪽 바닥면(floorAboveGroundMm 60 · 실측 유도). 바닥판은 그 아래, 벽은 그 위 - 판을 위에 깔면 거치대가 판 속에 놓인 것으로 3mm 파고든다 (2026-09-06 게이트가 잡음) -->
        <geom name="basket_floor" type="box" size="${half(bw + 2 * wall, bd + 2 * wall, wall)}" pos="0 0 ${m(-wall / 2)}" rgba="0.1 0.4 0.2 1"/>
        <geom name="basket_wx0" type="box" size="${half(wall, bd, bh)}" pos="${m(-(bw + wall) / 2)} 0 ${m(bh / 2)}" rgba="0.1 0.4 0.2 1"/>
        <geom name="basket_wx1" type="box" size="${half(wall, bd, bh)}" pos="${m((bw + wall) / 2)} 0 ${m(bh / 2)}" rgba="0.1 0.4 0.2 1"/>
        <geom name="basket_wy0" type="box" size="${half(bw + 2 * wall, wall, bh)}" pos="0 ${m(-(bd + wall) / 2)} ${m(bh / 2)}" rgba="0.1 0.4 0.2 1"/>
        <geom name="basket_wy1" type="box" size="${half(bw + 2 * wall, wall, bh)}" pos="0 ${m((bd + wall) / 2)} ${m(bh / 2)}" rgba="0.1 0.4 0.2 1"/>
      </body>
    </body>`;
  const zonesXml = zones.map((z, i) => {
    const c = userToBase([(z.xMm[0] + z.xMm[1]) / 2, (z.yMm[0] + z.yMm[1]) / 2, z.topZMm - 40], userDef);
    return `
    <body name="zone${i}" pos="${c.map((v) => m(v)).join(' ')}">
      <geom name="zone_${i}" type="box" size="${m((z.xMm[1] - z.xMm[0]) / 2)} ${m((z.yMm[1] - z.yMm[0]) / 2)} ${m(40)}" rgba="0.7 0.7 0.75 0.4"/>
    </body>`;
  }).join('');
  // 현재 놓인 총알 — **S2가 본 xy 그대로** 넣는다. `roundsOnBoard`만 보고 중앙에 만들거나
  // 구운 장면의 과거 소품 좌표를 현재 총알로 쓰지 않는다(D219). 원통은 실제 최대 지름의
  // 보수적 외피이며 축은 MJCF 기본 z다. z는 거치대 윗면·높이·바닥살·총알 길이 정본에서 유도한다.
  let liveRoundsXml = '';
  if (carrierUser1 !== null || bulletsUser1Mm !== null) {
    const validCarrier = Array.isArray(carrierUser1) && carrierUser1.length >= 3 && carrierUser1.slice(0, 3).every(Number.isFinite);
    const validBullets = Array.isArray(bulletsUser1Mm)
      && bulletsUser1Mm.every((p) => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite));
    if (!validCarrier || !validBullets) return null;
    const floorSkinMm = CARRIER.roundSeatMm != null
      ? CARRIER.hMm - CARRIER.roundSeatMm
      : (CARRIER.grip?.gripThicknessMm ?? 2);
    const centerZ = carrierUser1[2] - CARRIER.hMm + floorSkinMm + ROUND.lengthMm / 2;
    liveRoundsXml = bulletsUser1Mm.map((p, i) => {
      const b = userToBase([p[0], p[1], centerZ], userDef);
      return `
    <geom name="prop:live-round-${i}" type="cylinder" size="${m(ROUND.diaMm / 2)} ${m(ROUND.lengthMm / 2)}" pos="${b.map((v) => m(v)).join(' ')}" rgba="0.66 0.53 0.31 1"/>`;
    }).join('');
  }
  // 든 거치대 — `wrist3_link` 바디 안, 손끝(`tcp` 사이트 · 플랜지 99 + 툴 135) 기준. 파지 때 손끝은 거치대 바닥 위
  // `tcpAboveTableMm`(현재 33.3)라 바닥은 손끝에서 툴 축(+z)으로 그만큼 더 나간 자리, 거치대 중심은 거기서 판 높이 절반 위다.
  // xy 는 파지 벽 오프셋을 안 넣는다(근사 · 상자 여유 안)
  let withHeld = robotXml;
  if (carried) {
    const tcp = robotXml.match(/<site name="tcp" pos="0 0 ([\d.]+)"/);
    const w3 = robotXml.indexOf('name="wrist3_link"');
    if (!tcp || w3 < 0) return null;                       // 장면 모양이 다르면 짓지 않는다 — 조용히 빈 손으로 재면 거짓 초록
    const zM = Number(tcp[1]) + (CARRIER_GRASP_TRUTH.tcpAboveTableMm - CARRIER.hMm / 2) / 1000;
    // 손끝은 거치대 **벽**이라 몸통은 옆으로 비껴 있다 — 실측 오프셋(`carrierBodyOffset` · user1)을 파지 자세의 회전으로
    // 툴 프레임에 옮긴다(2026-09-06 검산: (0.2, 34.5) → 툴 (−34.5, 0)). 이걸 빼면 상자가 바구니 벽에 7.7mm 겹친다
    const [dxT, dyT] = bodyOffsetInTool();
    const held = `
      <body name="carried" pos="${m(dxT)} ${m(dyT)} ${zM.toFixed(5)}">
        <geom name="carrier_box" type="box" size="${half(CARRIER.wMm, CARRIER.dMm, CARRIER.hMm)}" rgba="0.8 0.8 0.2 0.6"/>
      </body>`;
    const close = robotXml.indexOf('</body>', w3);         // wrist3 안엔 자식 바디가 없다 — 첫 닫힘이 그 바디다
    withHeld = robotXml.slice(0, close) + held + robotXml.slice(close);
  }
  return withHeld.replace('</worldbody>', `${amr}${zonesXml}${liveRoundsXml}</worldbody>`);
}

/** 접촉 이름 규약 — 팔 링크는 이름이 없다(구운 MJCF), 든 거치대는 `carrier_`, 놓인 것은 아래 셋 */
export const HELD_RE = /^carrier_/;
export const OBSTACLE_RE = /^(basket_|amr_|zone_|box:|wall:|prop:)/;
/** 우리 것 — 팔 링크('' · 구운 MJCF 는 링크 geom 에 이름이 없다) · 툴(`tool:` · 손가락·카메라) · 든 거치대 */
export const MINE_RE = /^(tool:|carrier_)/;
