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
import { AMR_DROP, AMR_HOME } from '../../Shared/data/workcell.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCENE = join(ROOT, 'Sim/out/scene/fr5-lab-a.xml');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

if (!existsSync(SCENE)) execFileSync('node', [join(ROOT, 'Sim/scene/build-scene.mjs')], { stdio: 'inherit' });
const robotXml = readFileSync(SCENE, 'utf-8');
const fixture = JSON.parse(readFileSync(join(ROOT, 'Sim/fixtures/fr5-lab-a.json'), 'utf-8'));
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
    at(jointsDeg) {
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
check('9칸이 목업 IK 로 전부 풀린다', J.every(Boolean), `${J.filter(Boolean).length}/9`);
if (!J.every(Boolean)) { console.log(`\n${results.filter(Boolean).length}/${results.length} PASS`); process.exit(1); }

// ── ① 고친 높이(라이다 위 20) — 싣기 9칸 길 전부. 든 거치대는 ③~⑧
const scene = composeDemoScene(robotXml, { amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: true });
check('장면이 합성된다 (터틀봇 mocap · 바구니 · 든 거치대)', !!scene && /name="amr" mocap="true"/.test(scene) && /carrier_box/.test(scene));
const simHeld = openScene(scene);
const simFree = openScene(composeDemoScene(robotXml, { amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: false }));
check('mocap 터틀봇을 옮길 수 있다', simHeld.moveAmr === undefined ? false : simHeld.moveAmr(amrPlacement([stop.xMm, stop.yMm, stop.yawDeg], userDef).posM, (stop.yawDeg * Math.PI) / 180));
const legs = [];
for (let k = 1; k < steps.length; k += 1) {
  const held = isHeld(steps, k) || isHeld(steps, k - 1);
  const r = checkArmPath(held ? simHeld : simFree, J[k - 1], J[k]);
  legs.push({ from: steps[k - 1].id, to: steps[k].id, ...r });
}
const dirty = legs.filter((l) => l.hits.length);
// 엄격한 단언은 **고친 길(④→⑤)** 에만 — 그게 이 게이트가 재는 것이다. 다른 구간의 접촉은 검사기의 **발견**이라 숨기지 않고 적는다
const fixedLeg = legs.find((l) => l.from === 'lift' && l.to === 'carry');
check('고친 높이(라이다 위 20)의 ④→⑤ 길은 터틀봇에 안 닿는다', !!fixedLeg && fixedLeg.hits.length === 0,
  fixedLeg ? (fixedLeg.hits.join(', ') || `표본 ${fixedLeg.samples}`) : '구간 없음');
if (dirty.length) console.log(`NOTE  다른 구간의 접촉(발견 · 실측 기하): ${dirty.map((l) => `${l.from}→${l.to}: ${l.hits.join(', ')}`).join(' | ')}`);
else console.log(`NOTE  9칸 전 구간 접촉 없음 (표본 ${legs.reduce((a, l) => a + l.samples, 0)}개)`);

// ── ② 옛 높이(파지 +120 = 라이다 아래) 를 되살린다 — ④→⑤ 가 몸통을 쓸었던 그 길. 검사기가 **빨강**을 내야 한다
const g = steps[1].pose;
const oldLift = [g[0], g[1], g[2] + LIFT_MM, g[3], g[4], g[5]];
const oldCarry = [steps[4].pose[0], steps[4].pose[1], g[2] + LIFT_MM, g[3], g[4], steps[4].pose[5]];
const [jLiftOld, jCarryOld] = ikAll([oldLift, oldCarry], J[2]);
const old = jLiftOld && jCarryOld ? checkArmPath(simHeld, jLiftOld, jCarryOld) : null;
check('옛 높이(파지 +120)의 ④→⑤ 길은 터틀봇에 닿는다 — 09-06 실렌더 사고를 검사기가 잡는다',
  !!old && old.hits.some((h) => /amr_|basket_/.test(h)), old ? `${old.hits.join(', ') || '접촉 0'} · 처음 닿은 진행률 ${old.worstAt}` : 'IK 실패');

// ── ③ 주행 — 팔이 ⑨ 자세로 서 있고 터틀봇이 정차 → 앞 500 → 정차로. 팔에 닿으면 안 된다
const p0 = amrPlacement([stop.xMm, stop.yMm, stop.yawDeg], userDef).posM;
const th = (stop.yawDeg * Math.PI) / 180;
const pFar = [p0[0] + Math.cos(th) * 0.5, p0[1] + Math.sin(th) * 0.5, p0[2]];
const drive = checkDrivePath(simFree, J[8], p0, pFar, th);
check('실은 채 앞으로 500mm 가는 동안 터틀봇이 팔에 안 닿는다', drive.samples > 0 && drive.hits.length === 0, drive.hits.join(', ') || `표본 ${drive.samples}`);
simHeld.dispose(); simFree.dispose();

const bad = results.filter((v) => !v).length;
console.log(`\n${results.length - bad}/${results.length} PASS`);
process.exit(bad ? 1 : 0);
