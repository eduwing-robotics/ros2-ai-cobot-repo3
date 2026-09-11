// 접촉 검사 게이트 — **길 위의 충돌을 잡는가** (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 1).
//
// 2026-09-06 실렌더에서 ④→⑤(파지 +120 높이로 터틀봇 위로)가 몸통 모서리를 쓸었는데 자세 검사(08-31 스윕)는 초록이었다.
// 이 게이트는 그 사고를 **되살려** 검사기가 빨강을 내는지, 고친 높이(라이다 위 20)는 초록인지를 잰다 — 검사기가 그걸 못 가르면
// 시뮬 탭의 「부딪히나」는 그림이다.
//
// 재료: 구운 장면(`Sim/out/scene/fr5-lab-a.xml` · 없으면 `build-scene.mjs` 로 굽는다) + `scene-compose.js`(터틀봇·바구니·든 거치대)
// + 목업 IK(`robot_adapter/mock.py` · 실기 fkSamples 와 1.3mm). 실기 근거가 아니다 — 검사기 자체를 재는 판이다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { composeDemoScene, amrPlacement } from '../../Shared/data/sim/scene-compose.js';
import { checkArmPath, checkDrivePath, pathSamples } from '../../Shared/data/sim/contact-check.js';
import { makeLoadSteps, LIFT_MM, isHeld } from '../../Shared/data/sim/load-steps.js';
import { graspFromCenter, GRASP_INSET_CANDIDATES_MM } from '../../Shared/data/sim/grasp.js';
import { gripperFingerShiftMm } from '../../Shared/data/sim/gripper-geometry.js';
import { AMR_DROP, AMR_HOME } from '../../Shared/data/workcell.js';
import { CARRIER, CARRIER_GRASP_TRUTH } from '../../Shared/data/props.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCENE = join(ROOT, 'Sim/out/scene/fr5-lab-a.xml');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

if (!existsSync(SCENE)) execFileSync('node', [join(ROOT, 'Sim/scene/build-scene.mjs')], { stdio: 'inherit' });
const robotXml = readFileSync(SCENE, 'utf-8');
const fixture = JSON.parse(readFileSync(join(ROOT, 'Sim/fixtures/fr5-lab-a.json'), 'utf-8'));
const gripperConfig = JSON.parse(readFileSync(join(ROOT, 'Shared/data/config/gripper-mount.json'), 'utf-8'));
const userDef = fixture.coordDefs.user;

// 목업 IK — 파이썬 한 번에 전부 (컨트롤러 없이 · `GetInverseKinRef` 규약: 참조에서 가장 가까운 가지)
function ikAll(poses, ref) {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'FR5/bridge'))})
from robot_adapter.mock import MockFr5Adapter
a = MockFr5Adapter({"robotId": "fr5-mock-lab", "fixture": "fr5-lab-a"})
poses, ref = json.load(sys.stdin)
out = []
for p in poses:
    q = a.inverse_kin(p, ref)
    out.append(q); ref = q or ref
print(json.dumps(out))`;
  return JSON.parse(execFileSync('python3', ['-c', py], { input: JSON.stringify([poses, ref]), cwd: join(ROOT, 'FR5/bridge') }).toString());
}

// 엔진 래퍼 — `Shared/view3d/sim-scene.js` 와 같은 모양 (`at`·`moveAmr`). 메시는 디스크에서
const mj = await loadMujoco();
const dec = new TextDecoder();
function openScene(xml) {
  const files = [...xml.matchAll(/file="([^"]+)"/g)].map((m) => m[1]);
  try { mj.FS.mkdir('/asset'); } catch { /* 있다 */ }
  const dirs = new Set();
  for (const rel of files) {
    const dir = `/asset/${rel}`.replace(/\/[^/]+$/, '');
    if (!dirs.has(dir)) { dirs.add(dir); try { mj.FS.mkdir(dir); } catch { /* 있다 */ } }
    mj.FS.writeFile(`/asset/${rel}`, readFileSync(join(ROOT, 'Shared/assets/FAIRINO_FR5', rel)));
  }
  mj.FS.writeFile('/asset/scene.xml', xml);
  const model = mj.MjModel.from_xml_path('/asset/scene.xml');
  const data = new mj.MjData(model);
  const names = [];
  for (let g = 0; g < model.ngeom; g += 1) {
    const a = model.name_geomadr[g]; let s = '';
    if (a >= 0) { let e = a; while (model.names[e]) e += 1; s = dec.decode(model.names.slice(a, e)); }
    names.push(s);
  }
  const fingers = names.flatMap((name, geomId) => name.includes('finger')
    ? [{ geomId, name, restXM: model.geom_pos[geomId * 3] }]
    : []);
  const setGrip = (openPct = 100) => {
    for (const finger of fingers) {
      model.geom_pos[finger.geomId * 3] = finger.restXM
        + gripperFingerShiftMm(finger.name, openPct, gripperConfig.fingerHalfStrokeMm) / 1000;
    }
  };
  let mocap = -1;
  for (let b = 0; b < model.nbody; b += 1) if (model.body_mocapid[b] >= 0) { mocap = model.body_mocapid[b]; break; }
  const DEG = Math.PI / 180;
  return {
    names,
    moveAmr(posM, yawRad) {
      if (mocap < 0) return false;
      data.mocap_pos[mocap * 3] = posM[0]; data.mocap_pos[mocap * 3 + 1] = posM[1]; data.mocap_pos[mocap * 3 + 2] = posM[2];
      data.mocap_quat[mocap * 4] = Math.cos(yawRad / 2); data.mocap_quat[mocap * 4 + 1] = 0; data.mocap_quat[mocap * 4 + 2] = 0; data.mocap_quat[mocap * 4 + 3] = Math.sin(yawRad / 2);
      return true;
    },
    fingerLocalXM(openPct) {
      setGrip(openPct);
      return Object.fromEntries(fingers.map((finger) => [finger.name, model.geom_pos[finger.geomId * 3]]));
    },
    at(jointsDeg, gripperPct = 100) {
      setGrip(gripperPct);
      for (let j = 0; j < model.nq; j += 1) { data.qpos[j] = (jointsDeg[j] ?? 0) * DEG; }
      mj.mj_forward(model, data);
      const pairs = [];
      for (let i = 0; i < data.ncon; i += 1) { const c = data.contact.get ? data.contact.get(i) : data.contact[i]; if (c) pairs.push([names[c.geom1] ?? '', names[c.geom2] ?? '', c.dist]); }
      return { ncon: data.ncon, pairs };
    },
    dispose() { data.delete(); model.delete(); },
  };
}

const stop = AMR_DROP;
const steps = makeLoadSteps(stop);
const home = fixture.slots[0].points.home;
const J = ikAll(steps.map((s) => s.pose), home);
check('10칸이 목업 IK 로 전부 풀린다', J.every(Boolean), `${J.filter(Boolean).length}/10`);
if (!J.every(Boolean)) { console.log(`\n${results.filter(Boolean).length}/${results.length} PASS`); process.exit(1); }

// ── ① 고친 높이(라이다 위 20) — 싣기 10칸 길 전부. 든 거치대는 ③~⑧
const scene = composeDemoScene(robotXml, { amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: true });
check('장면이 합성된다 (터틀봇 mocap · 바구니 · 든 거치대)', !!scene && /name="amr" mocap="true"/.test(scene) && /carrier_box/.test(scene));
const simHeld = openScene(scene);
const simFree = openScene(composeDemoScene(robotXml, { amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: false }));
check('mocap 터틀봇을 옮길 수 있다', simHeld.moveAmr === undefined ? false : simHeld.moveAmr(amrPlacement([stop.xMm, stop.yMm, stop.yawDeg], userDef).posM, (stop.yawDeg * Math.PI) / 180));
const legs = [];
for (let k = 1; k < steps.length; k += 1) {
  const held = isHeld(steps, k) || isHeld(steps, k - 1);
  const r = checkArmPath(held ? simHeld : simFree, J[k - 1], J[k], {
    fromGripPct: steps[k - 1].grip, toGripPct: steps[k].grip,
  });
  legs.push({ from: steps[k - 1].id, to: steps[k].id, ...r });
}
const dirty = legs.filter((l) => l.hits.length);
// 엄격한 단언은 **고친 길(④→⑤)** 에만 — 그게 이 게이트가 재는 것이다. 다른 구간의 접촉은 검사기의 **발견**이라 숨기지 않고 적는다
const fixedLeg = legs.find((l) => l.from === 'lift' && l.to === 'carry');
check('고친 높이(라이다 위 20)의 ④→⑤ 길은 터틀봇에 안 닿는다', !!fixedLeg && fixedLeg.hits.length === 0,
  fixedLeg ? (fixedLeg.hits.join(', ') || `표본 ${fixedLeg.samples}`) : '구간 없음');
if (dirty.length) console.log(`NOTE  다른 구간의 접촉(발견 · 실측 기하): ${dirty.map((l) => `${l.from}→${l.to}: ${l.hits.join(', ')}`).join(' | ')}`);
else console.log(`NOTE  10칸 전 구간 접촉 없음 (표본 ${legs.reduce((a, l) => a + l.samples, 0)}개)`);

// ── ② 옛 높이(파지 +120 = 라이다 아래) 를 되살린다 — ④→⑤ 가 몸통을 쓸었던 그 길. 검사기가 **빨강**을 내야 한다
const g = steps.find((s) => s.id === 'grasp').pose;
const oldLift = [g[0], g[1], g[2] + LIFT_MM, g[3], g[4], g[5]];
const carry = steps.find((s) => s.id === 'carry');
const oldCarry = [carry.pose[0], carry.pose[1], g[2] + LIFT_MM, g[3], g[4], carry.pose[5]];
const [jLiftOld, jCarryOld] = ikAll([oldLift, oldCarry], J[steps.findIndex((s) => s.id === 'close')]);
const old = jLiftOld && jCarryOld ? checkArmPath(simHeld, jLiftOld, jCarryOld) : null;
check('옛 높이(파지 +120)의 ④→⑤ 길은 터틀봇에 닿는다 — 09-06 실렌더 사고를 검사기가 잡는다',
  !!old && old.hits.some((h) => /amr_|basket_/.test(h)), old ? `${old.hits.join(', ') || '접촉 0'} · 처음 닿은 진행률 ${old.worstAt}` : 'IK 실패');

// ── ③ 주행 — 팔이 ⑨ 자세로 서 있고 터틀봇이 정차 → 앞 500 → 정차로. 팔에 닿으면 안 된다
const p0 = amrPlacement([stop.xMm, stop.yMm, stop.yawDeg], userDef).posM;
const th = (stop.yawDeg * Math.PI) / 180;
const pFar = [p0[0] + Math.cos(th) * 0.5, p0[1] + Math.sin(th) * 0.5, p0[2]];
const drive = checkDrivePath(simFree, J[8], p0, pFar, th);
check('실은 채 앞으로 500mm 가는 동안 터틀봇이 팔에 안 닿는다', drive.samples > 0 && drive.hits.length === 0, drive.hits.join(', ') || `표본 ${drive.samples}`);

// ── ④ 현재 총알 — 검출 xy를 장면에 그대로 넣고, 손끝 중심에 일부러 둔 회귀가 tool 충돌을 내야 한다.
// 이 검사가 없으면 `roundsOnBoard=1` 중앙 그림과 구운 과거 총알로 되돌아가도 게이트가 초록이다(D219).
const graspIndex = steps.findIndex((s) => s.id === 'grasp');
const graspPose = steps[graspIndex].pose;
const liveCarrier = [graspPose[0], graspPose[1], AMR_HOME.topZMm + CARRIER.hMm];
const liveXml = composeDemoScene(robotXml, {
  amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: false,
  carrierUser1: liveCarrier, bulletsUser1Mm: [[graspPose[0], graspPose[1]]],
});
check('검출 총알 xy가 prop:live-round로 장면에 합성된다',
  /name="prop:live-round-0"/.test(liveXml ?? '') && !/name="prop:live-round-1"/.test(liveXml ?? ''));
const simLive = openScene(liveXml);
const openFingerX = simLive.fingerLocalXM(100);
const pregripFingerX = simLive.fingerLocalXM(70);
const closedFingerX = simLive.fingerLocalXM(4);
const leftFinger = Object.keys(openFingerX).find((name) => name.includes('left'));
const rightFinger = Object.keys(openFingerX).find((name) => name.includes('right'));
check('MuJoCo 손가락 형상이 100→70→4% 개폐값을 실제 geom 위치에 반영한다',
  leftFinger && rightFinger
    && Math.abs((pregripFingerX[leftFinger] - openFingerX[leftFinger]) * 1000 + 6) < 0.01
    && Math.abs((pregripFingerX[rightFinger] - openFingerX[rightFinger]) * 1000 - 6) < 0.01
    && Math.abs((closedFingerX[leftFinger] - openFingerX[leftFinger]) * 1000 + 19.2) < 0.01
    && Math.abs((closedFingerX[rightFinger] - openFingerX[rightFinger]) * 1000 - 19.2) < 0.01,
  `${leftFinger ?? 'left 없음'} · ${rightFinger ?? 'right 없음'}`);
const liveHit = checkArmPath(simLive, J[graspIndex], J[graspIndex], { fromGripPct: 70, toGripPct: 70 });
check('손끝 중심의 검출 총알은 전체 tool 접촉으로 빨강이다',
  liveHit.hits.some((h) => /(?:tool:[^↔]+|팔)↔prop:live-round-0/.test(h)), liveHit.hits.join(', ') || '접촉 0');
simLive.dispose();

// ── ⑤ D220 첫 완주 배치 — 28mm 사전 성형·7mm 추가 하강 뒤에도 현재 검출 총알과 전체 tool이 닿지 않아야 한다.
const firstPickCenter = [-113.98, -991.88];
const firstPickBullet = [[-101.6, -993.4]];
const firstPickYaw = -90.2;
const firstPickFlip = true;
const firstPickRzBase = CARRIER_GRASP_TRUTH.tcpMmDeg[5] + firstPickYaw;
const firstPickXy = graspFromCenter(firstPickCenter, firstPickRzBase, firstPickFlip);
const firstPickSteps = makeLoadSteps(stop, { graspXyMm: firstPickXy, graspRzDeg: firstPickYaw, graspFlip: firstPickFlip }).slice(0, 5);
const firstPickJ = ikAll(firstPickSteps.map((s) => s.pose), home);
const firstPickXml = composeDemoScene(robotXml, {
  amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: false,
  carrierUser1: [...firstPickCenter, AMR_HOME.topZMm + CARRIER.hMm], bulletsUser1Mm: firstPickBullet,
});
const firstPickSim = openScene(firstPickXml);
const firstPickHits = [];
for (let k = 1; k < firstPickSteps.length; k += 1) {
  if (!firstPickJ[k - 1] || !firstPickJ[k]) continue;
  const r = checkArmPath(firstPickSim, firstPickJ[k - 1], firstPickJ[k], {
    fromGripPct: firstPickSteps[k - 1].grip, toGripPct: firstPickSteps[k].grip,
  });
  firstPickHits.push(...r.hits.filter((h) => !h.startsWith('carrier_')));
}
check('D220 첫 완주 배치는 28mm 사전 성형·7mm 추가 하강 경로에서도 전체 tool 접촉 0',
  firstPickJ.every(Boolean) && firstPickHits.length === 0,
  firstPickJ.every(Boolean) ? (firstPickHits.join(', ') || '접촉 0') : `IK ${firstPickJ.filter(Boolean).length}/5`);
firstPickSim.dispose();

// ── ⑥ D221 작업대1(+X) 여유 — 09-10 최신 성공 배치를 그대로 쓰고 10→0mm를 검사한다.
// 가장 깊은 안전 후보를 고르는 UI와 같은 순서이며, 선택값은 긴 변 중앙을 따라 움직이지 않고 벽 법선으로만 들어간다.
const latestCenter = [-153.56, -1001.41];
const latestBullet = [[-140.8, -1004.4]];
const latestYaw = -91.5; // 실행 장부의 foldYaw 값. 원본 88.5°를 넣으면 flip과 합쳐 반대 벽이 된다.
const latestFlip = true;
const latestRzBase = CARRIER_GRASP_TRUTH.tcpMmDeg[5] + latestYaw;
const latestXml = composeDemoScene(robotXml, {
  amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: false,
  carrierUser1: [...latestCenter, AMR_HOME.topZMm + CARRIER.hMm], bulletsUser1Mm: latestBullet,
});
const latestSim = openScene(latestXml);
const insetResults = [];
for (const insetMm of GRASP_INSET_CANDIDATES_MM) {
  const xy = graspFromCenter(latestCenter, latestRzBase, latestFlip, insetMm);
  const st = makeLoadSteps(stop, { graspXyMm: xy, graspRzDeg: latestYaw, graspFlip: latestFlip }).slice(0, 5);
  const jj = ikAll(st.map((s) => s.pose), home);
  const hits = [];
  for (let k = 1; k < st.length && jj.every(Boolean); k += 1) {
    const r = checkArmPath(latestSim, jj[k - 1], jj[k], { fromGripPct: st[k - 1].grip, toGripPct: st[k].grip });
    hits.push(...r.hits.filter((h) => !h.startsWith('carrier_')));
  }
  insetResults.push({ insetMm, ik: jj.every(Boolean), hits: [...new Set(hits)] });
}
const chosenInset = insetResults.find((r) => r.ik && r.hits.length === 0)?.insetMm ?? null;
check('D221 최신 배치에서 0~10mm 후보를 전수 검사해 가장 깊은 안전 물림을 고른다',
  insetResults.length === 11 && chosenInset != null
    && insetResults.filter((r) => r.insetMm > chosenInset).every((r) => !r.ik || r.hits.length > 0),
  `선택 ${chosenInset ?? '없음'}mm · ${insetResults.map((r) => `${r.insetMm}:${r.ik ? (r.hits.length ? 'hit' : 'ok') : 'ik'}`).join(' ')}`);
latestSim.dispose();
simHeld.dispose(); simFree.dispose();

const bad = results.filter((v) => !v).length;
console.log(`\n${results.length - bad}/${results.length} PASS`);
process.exit(bad ? 1 : 0);
