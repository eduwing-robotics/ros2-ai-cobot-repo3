#!/usr/bin/env node
/**
 * 툴 충돌체를 **TCP 좌표계로 굽는다** — `Shared/data/config/tool-hull.json`.
 *
 *     node scripts/build/tool-hull.mjs            # 굽는다
 *     node scripts/build/tool-hull.mjs --check    # 쓰지 않고 대조만 (게이트용)
 *
 * ## 왜 있나
 *
 * 손끝 **한 점**만 보는 작업영역 게이트는 82mm 뻗은 깊이 카메라도, 40mm 벌어진 집게도
 * 못 본다. 2026-08-11 실측: 무작위 자세 4000개 중 **425개(10.6%)** 가 손끝은 통과인데
 * 툴이 구역 안이었다 (여유 차이 중앙값 72.7mm).
 *
 * 그걸 막으려면 **파이썬 게이트와 자바스크립트 사본이 같은 형상을 봐야 한다.** 형상을 양쪽에
 * 각각 적으면 반드시 한쪽이 낡고, 그 순간 시뮬이 초록인 것을 실기가 거부한다
 * (`SIM-CONTRACT.md` 불변식 4). 그래서 **여기서 한 번 굽고 둘 다 이 파일을 읽는다.**
 *
 * ## 왜 TCP 좌표계인가
 *
 * 툴은 플랜지에 볼트로 고정이라 **TCP 좌표계에서 형상이 상수**다. 그리고 컨트롤러가
 * `state.tcpMmDeg` 로 손끝의 위치 **와 방향**을 이미 준다 (x,y,z mm + rx,ry,rz 도).
 * 그러니 기구학 라이브러리를 들일 필요가 없다 — 상수점을 회전시켜 옮기면 끝이다.
 *
 * 회전 규약은 **고정축 XYZ**(RPY) 다: `R = Rz(rz)·Ry(ry)·Rx(rx)`.
 * 실기 4자세로 12개 후보를 가려 확정했다 (잔차 0.0048° · 2등과 32.96° 차이) —
 * `docs/evidence/2026-08-11/tcp-euler-convention.md`.
 *
 * ## 좌표계가 물리는 것을 확인했다
 *
 * 컨트롤러 툴 오프셋 **135mm** (`coordDefs.tool`) + URDF 플랜지면 **99mm**
 * (그리퍼 STL 의 wrist3 기준 z 최솟값) = **234mm** = 우리가 유도한 TCP. 셋이 맞았다.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK_ONLY = process.argv.includes('--check');
const OUT = join(ROOT, 'Shared/data/config/tool-hull.json');
const GRIPDIR = join(ROOT, 'Shared/assets/PGEA_100_40');
const die = (m) => { console.error(`tool-hull: ${m}`); process.exit(1); };

const GRIP = JSON.parse(readFileSync(join(ROOT, 'Shared/data/config/gripper-mount.json'), 'utf-8'));

/** 바이너리 STL 의 경계상자 (mm · 조립좌표계). ASCII 나 잘린 파일이면 죽는다. */
function stlAabbMm(path) {
  if (!existsSync(path)) die(`메시가 없다: ${path}`);
  const buf = readFileSync(path);
  if (buf.length < 84) die(`STL 이 너무 짧다: ${path}`);
  const n = buf.readUInt32LE(80);
  if (buf.length !== 84 + n * 50) die(`바이너리 STL 이 아니다(또는 잘렸다): ${path}`);
  if (!n) die(`STL 에 삼각형이 0개다: ${path}`);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i += 1) {
    const base = 84 + i * 50 + 12;                    // +12 = 법선 셋을 건너뛴다
    for (let v = 0; v < 3; v += 1) {
      for (let a = 0; a < 3; a += 1) {
        const x = buf.readFloatLE(base + v * 12 + a * 4);
        if (x < lo[a]) lo[a] = x;
        if (x > hi[a]) hi[a] = x;
      }
    }
  }
  return [lo, hi];
}

/** 조립좌표계 한 점 → `parentLink` 좌표계 (mm). **회전은 X 축 하나뿐이다** — 아래가 강제한다. */
function mountPointMm([mx, my, mz]) {
  const [px, py, pz] = GRIP.positionMm;
  const [rxDeg, ryDeg, rzDeg] = GRIP.rotationDeg;
  // Y·Z 회전이 생기면 **조용히 무시되어** 툴이 엉뚱한 데 붙는다. 값이 늘면 여기서 죽는다.
  if (ryDeg || rzDeg) die(`rotationDeg 의 Y·Z 를 안 쓴다: ${JSON.stringify(GRIP.rotationDeg)}`);
  const rx = (rxDeg * Math.PI) / 180;
  return [px + mx,
    py + my * Math.cos(rx) - mz * Math.sin(rx),
    pz + my * Math.sin(rx) + mz * Math.cos(rx)];
}

/** 손끝 — `parentLink` 기준. 이 값만큼 빼면 TCP 좌표계가 된다. */
const tcpOffsetMm = () => mountPointMm([0, GRIP.depthCam.tcpYMm, GRIP.depthCam.toolAxisZMm]);

const f = (v) => Number(v.toFixed(3));

/** 조립좌표계 경계상자 → TCP 좌표계 {centerMm, halfMm}. X 회전은 축을 맞바꿀 뿐이라 상자로 남는다. */
function toTcpBox(name, lo, hi, extra) {
  const a = mountPointMm(lo);
  const b = mountPointMm(hi);
  const t = tcpOffsetMm();
  const mn = a.map((v, i) => Math.min(v, b[i]) - t[i]);
  const mx = a.map((v, i) => Math.max(v, b[i]) - t[i]);
  return { name,
    centerMm: mn.map((v, i) => f((v + mx[i]) / 2)),
    halfMm: mn.map((v, i) => f((mx[i] - v) / 2)),
    ...extra };
}

const boxes = GRIP.meshes.map((m) => toTcpBox(basename(m, '.stl'), ...stlAabbMm(join(GRIPDIR, m)),
  { source: m, verified: GRIP.verified === true }));

// ── 카메라·브래킷 — 메시가 없어 `gripper-mount.json` 의 실측 치수에서 유도한다 ──────────
const d = GRIP.depthCam;
const [camW, camT, camH] = d.bodySizeMm;
const plateHalfX = d.bracketPlateWidthMm / 2;
// 카메라는 판 한가운데가 아니라 **판 끝에서 camJutMm 만큼 넘어 걸친다** (`_camJutMm`).
// 79/2 + 15 − 90/2 = 9.5mm — `_조립좌표계` 가 이탈각을 √(82²+9.5²) 로 적은 그 9.5 다.
const camCx = plateHalfX + d.camJutMm - camW / 2;
const camCy = d.tcpYMm - d.lensHeightMm;
const camCz = d.toolAxisZMm + d.outSign * d.lensOffsetMm;
const cleatY0 = d.faceTopYMm + d.cleatDropMm;
const bz = [d.faceZMm, d.faceZMm + d.outSign * d.bracketReachMm].sort((a, b) => a - b);
boxes.push(toTcpBox('cam-bracket',
  [-plateHalfX, cleatY0, bz[0]], [plateHalfX, cleatY0 + d.cleatSizeMm[1], bz[1]],
  { source: 'gripper-mount.json §depthCam', verified: d.verified === true }));
boxes.push(toTcpBox('cam-body',
  [camCx - camW / 2, camCy - camT / 2, camCz - camH / 2],
  [camCx + camW / 2, camCy + camT / 2, camCz + camH / 2],
  { source: 'gripper-mount.json §depthCam', verified: d.verified === true }));

const hull = {
  _생성됨: '이 파일은 생성물이다 (node scripts/build/tool-hull.mjs). **직접 고치지 마라.**'
    + ' 형상의 정본은 Shared/assets/PGEA_100_40/*.stl 과 Shared/data/config/gripper-mount.json 이다.',
  _단위: '밀리미터. **TCP(툴) 좌표계** — 원점은 손끝, 축 방향은 플랜지와 같다.',
  _쓰는법: 'p_user = R(rx,ry,rz) · p_tool + (x,y,z).  R 은 고정축 XYZ = Rz(rz)·Ry(ry)·Rx(rx).'
    + ' rx,ry,rz 와 x,y,z 는 state.tcpMmDeg 그대로다.'
    + ' 규약 근거: docs/evidence/2026-08-11/tcp-euler-convention.md (잔차 0.0048°).',
  _근사: '상자는 실제 형상의 **경계상자**다 — 실물보다 크므로 판정은 안전한 쪽으로만 틀린다.'
    + ' 천장 둘: ① 공용 안전 게이트는 손가락을 STL 원위치(100% 열림)에 고정하고, S4 MuJoCo 경로 검사만'
    + ' fingerHalfStrokeMm 식으로 100→70→4%를 움직인다. ② 벌어진 집게 사이 빈 공간은 두 상자 사이에 그대로 남는다.',
  flangeToTcpMm: f(tcpOffsetMm()[2]),
  _flangeToTcpMm: 'parentLink 원점 → 손끝. 컨트롤러 툴 오프셋 135mm + URDF 플랜지면 99mm 와 맞는다.',
  parentLink: GRIP.parentLink,
  boxes,
};

const next = `${JSON.stringify(hull, null, 2)}\n`;
if (CHECK_ONLY) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf-8') : '';
  if (cur !== next) die(`${OUT.replace(`${ROOT}/`, '')} 이 낡았다 — node scripts/build/tool-hull.mjs`);
  console.log(`tool-hull: 최신 (상자 ${boxes.length})`);
} else {
  writeFileSync(OUT, next);
  console.log(`툴 형상 구움  Shared/data/config/tool-hull.json  (상자 ${boxes.length} · TCP 기준)`);
  for (const b of boxes) {
    console.log(`  ${b.name.padEnd(26)} 중심 [${b.centerMm.join(', ')}]`
      + ` 반크기 [${b.halfMm.join(', ')}]${b.verified ? '' : '  ⚠ 미검증'}`);
  }
}
