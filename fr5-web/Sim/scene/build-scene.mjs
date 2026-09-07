// 시뮬 장면을 **굽는다** — `config.yaml`·URDF 에서. 좌표를 손으로 옮겨 적는 곳은 0곳이다
// (SIM-CONTRACT 불변식 3, 하드 룰 5). 값이 바뀌면 다시 구우면 되고, 안 구우면 옛 장면이
// 남아 「어느 값으로 잰 숫자인가」를 못 가린다 — 그래서 산출물은 커밋하지 않는다 (D14).
//
//     node Sim/scene/build-scene.mjs                 # Sim/out/scene/fr5-lab-a.xml
//     node Sim/scene/build-scene.mjs --robot fr5-mock-a
//
// **왜 URDF 를 변환기로 안 돌리나** — 엔진이 URDF 를 그대로 읽는 것을 2026-08-08 에 실측했다
// (`SIM-CONTRACT.md` §S0 표 1행). `urdf2mjcf` 류 서드파티는 의존성만 늘리고 우리는 쓸 일이 없다.
//
// ⚠ **URDF 는 MJCF 와 달리 스키마 검사를 안 받는다** — 오타난 속성 이름이 **조용히 무시된다**
//   (MuJoCo `doc/modeling.rst` §URDF extensions). 그래서 굽고 끝내지 않고 **되읽어 센다**
//   (`verify()`). 2026-08-11 에 「200/200 초록인데 벽 규칙은 0건」을 겪은 것과 같은 종류다.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { mm } from '@fr5/shared/data/units/units.js';
import { floorZMm } from '@fr5/shared/data/workcell.js';
import { FIXTURE, ROUND } from '@fr5/shared/data/props.js';
import loadMujoco from '@mujoco/mujoco';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CFG = join(ROOT, 'FR5/bridge/config.yaml');
const GRIP = JSON.parse(readFileSync(join(ROOT, 'Shared/data/config/gripper-mount.json'), 'utf-8'));
const URDF = join(ROOT, 'Shared/assets/FAIRINO_FR5/fairino5_v6.urdf');
const MESHES = join(ROOT, 'Shared/assets/FAIRINO_FR5/meshes');
const OUT = join(ROOT, 'Sim/out/scene');

const die = (m) => { console.error(`build-scene: ${m}`); process.exit(1); };

// ── config.yaml → workspace ────────────────────────────────────────────────
// **yaml 파서를 새로 들이지 않는다** — `scripts/check/measurements.mjs:97` 이 같은 이유로
// 같은 짓을 한다(들여쓰기가 고정이라 줄만 떠 오면 된다). 대신 **모르는 줄이 나오면 죽는다** —
// 조용히 건너뛰면 상자 하나가 빠진 장면이 초록으로 나온다. 게이트가 pyyaml 로 **독립 파싱해**
// 대조하므로, 이 손파서가 틀리면 파서 둘이 갈려서 빨간불이 난다.
const num = (s) => { const v = Number(s); if (!Number.isFinite(v)) die(`숫자가 아니다: ${s}`); return v; };
const pair = (s) => {
  const m = s.match(/^\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]$/);
  if (!m) die(`[a, b] 꼴이 아니다: ${s}`);
  return [num(m[1]), num(m[2])];
};

export function readWorkspace(robotId) {
  const lines = readFileSync(CFG, 'utf-8').split('\n');
  // robotId 가 있는 줄부터 다음 `- robotId:` 전까지가 그 프로필이다
  const start = lines.findIndex((l) => new RegExp(`^\\s*-?\\s*robotId:\\s*${robotId}\\s*$`).test(l));
  if (start < 0) die(`프로필을 못 찾았다: ${robotId}`);
  const end = lines.findIndex((l, i) => i > start && /^\s*-\s*robotId:/.test(l));
  const body = lines.slice(start, end < 0 ? lines.length : end);

  const at = body.findIndex((l) => /^\s*workspace:\s*$/.test(l));
  if (at < 0) die(`${robotId}: workspace 블록이 없다`);
  const pad = body[at].search(/\S/);

  const ws = { frame: null, boxes: [], walls: [] };
  let bucket = null;         // 'boxes' | 'walls'
  let cur = null;
  for (const raw of body.slice(at + 1)) {
    if (raw.trim() && raw.search(/\S/) <= pad) break;      // 블록 끝
    const l = raw.split('#')[0].replace(/\s+$/, '');
    if (!l.trim()) continue;
    const t = l.trim();
    if (/^frame:/.test(t)) {
      const m = t.match(/toolId:\s*(\d+).*userId:\s*(\d+)/);
      if (!m) die(`frame 을 못 읽었다: ${t}`);
      ws.frame = { toolId: num(m[1]), userId: num(m[2]) };
      continue;
    }
    if (/^boxes:$/.test(t)) { bucket = 'boxes'; continue; }
    if (/^walls:$/.test(t)) { bucket = 'walls'; continue; }
    // workspace 수준 메타(`measuredAt`·`rev`…)는 **상자가 시작되기 전에만** 온다 — 값이 아니라
    // 이력이라 시뮬이 읽을 것이 없다. 키를 하나씩 적어 두면 다음 메타가 생길 때 또 깨진다
    // (2026-08-27 실측 — `rev` 하나가 실렌더·시뮬 게이트 넷을 붉혔다).
    // ⛔ 상자 **안**의 모르는 키는 여전히 아래에서 죽는다 — 그 방어선은 안 걷는다
    if (!bucket) continue;
    if (/^-\s*name:/.test(t)) {
      if (!bucket) die(`boxes/walls 밖에서 항목이 나왔다: ${t}`);
      cur = { name: t.replace(/^-\s*name:\s*/, '').trim() };
      ws[bucket].push(cur);
      continue;
    }
    if (!cur) die(`이름 없는 줄이 먼저 나왔다: ${t}`);
    const kv = t.match(/^([a-zA-Z]+):\s*(.+)$/);
    if (!kv) die(`key: value 꼴이 아니다: ${t}`);
    const [, k, v] = kv;
    if (k === 'xMm' || k === 'yMm' || k === 'aMm' || k === 'bMm' || k === 'seenZMm') cur[k] = pair(v);
    else if (k === 'topZMm' || k === 'marginMm') cur[k] = num(v);
    else die(`모르는 키다: ${k} — 계약(§제한구역)에 없는 값이 config 에 생겼다`);
  }
  if (!ws.boxes.length && !ws.walls.length) die(`${robotId}: 상자도 벽도 없다`);
  return ws;
}

// ── URDF → 로봇만 있는 MJCF ────────────────────────────────────────────────
// 메시는 **가상 파일시스템에 먼저 올려야** 한다 (2026-08-08 실측 · 계약 §S0 재현 ①).
function bakeRobot(mj) {
  mj.FS.mkdirTree('/asset/meshes');
  mj.FS.writeFile('/asset/robot.urdf', readFileSync(URDF));
  const stls = readdirSync(MESHES).filter((f) => /\.stl$/i.test(f));
  if (!stls.length) die(`메시가 0개다: ${MESHES}`);
  for (const f of stls) mj.FS.writeFile(`/asset/meshes/${f}`, readFileSync(join(MESHES, f)));

  const model = mj.MjModel.from_xml_path('/asset/robot.urdf');
  const counts = { body: model.nbody, joint: model.njnt, geom: model.ngeom, mesh: model.nmesh };
  mj.mj_saveLastXML('/asset/robot.xml', model);
  const xml = new TextDecoder().decode(mj.FS.readFile('/asset/robot.xml'));
  model.delete();          // ⚠ Embind 핸들은 GC 되지 않는다 — 손으로 지운다 (wasm/README §Memory)
  return { xml, counts, meshCount: stls.length };
}

// ── 장면 = 로봇 MJCF + config 의 상자·벽 + 바닥 ────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const f = (v) => Number(v.toFixed(6));

function zones(ws, userT, fx = FIXTURE) {
  // ⛔ **좌표계를 바꾼다.** `config.yaml` 의 상자·벽은 `workspace.frame`(tool1/user1) 좌표계
  // 값이고, MJCF 의 worldbody 는 **로봇 베이스**다. `p_base = p_user + t`, `t` 는 컨트롤러의
  // 유저 좌표계 원점(`coordDefs.user`).
  //
  // ⚠ **2026-08-11 에 이걸 빼먹은 장면을 한 번 구웠다.** 게이트는 초록이었다 — 「입력을 흔들면
  // 따라오나」만 재기 때문이다. 드러난 것은 배치를 돌렸을 때였고, 상자가 **약 725mm** 어긋나
  // 팔이 제자리에서 상판에 박혀 있었다. **따라온다고 해서 옳은 자리라는 뜻은 아니다.**
  const [ux, uy, uz] = userT;
  const cartTop = (ws.boxes.find((b) => /카트/.test(b.name)) ?? ws.boxes[0]).topZMm;
  const floor = floorZMm(cartTop) + uz;
  const out = [`    <geom name="floor" type="plane" pos="0 0 ${f(mm(floor))}" size="5 5 0.1" rgba="0.85 0.85 0.85 1"/>`];

  for (const b of ws.boxes) {
    // ponytail: 상자의 **아랫면은 실측이 없다** — 게이트는 「x·y 안 → z < topZ+여유」로만 재서
    // 바닥면을 안 본다(`safety.py:187`). 그래서 상판에서 바닥까지 채운다. 접촉이 일어나는
    // 윗면 z 는 실측 그대로이므로 물리에는 영향이 없다. 천장 — 옆면 아래쪽 접촉을 재려면
    // 카트 몸통 치수(`workcell.js` CART)로 갈아탄다.
    const [x0, x1] = [b.xMm[0] + ux, b.xMm[1] + ux];
    const [y0, y1] = [b.yMm[0] + uy, b.yMm[1] + uy];
    const hz = (b.topZMm + uz - floor) / 2;
    out.push(`    <geom name="box:${esc(b.name)}" type="box"`
      + ` pos="${f(mm((x0 + x1) / 2))} ${f(mm((y0 + y1) / 2))} ${f(mm(floor + hz))}"`
      + ` size="${f(mm((x1 - x0) / 2))} ${f(mm((y1 - y0) / 2))} ${f(mm(hz))}"`
      + ` rgba="0.55 0.55 0.6 1"/>`);
  }

  for (const w of ws.walls) {
    // 벽은 선분이다. 높이는 **본 높이대의 위끝까지, 바닥부터** — 계약이 화면에 대해 이미
    // 정한 규칙 그대로다(`config.yaml` §벽: "바닥부터 이 값의 위끝까지 · 바닥에 선 판이라는 가정").
    // 두께는 실측이 없으므로 **게이트의 여유값을 쓴다** — 지어낸 값이 아니라 이미 판정에 쓰는 값이다.
    const [ax, ay] = [w.aMm[0] + ux, w.aMm[1] + uy];
    const [bx, by] = [w.bMm[0] + ux, w.bMm[1] + uy];
    const top = (w.seenZMm ? w.seenZMm[1] : 0) + uz;
    const len = Math.hypot(bx - ax, by - ay);
    const hz = (top - floor) / 2;
    const yaw = Math.atan2(by - ay, bx - ax);
    out.push(`    <geom name="wall:${esc(w.name)}" type="box"`
      + ` pos="${f(mm((ax + bx) / 2))} ${f(mm((ay + by) / 2))} ${f(mm(floor + hz))}"`
      + ` euler="0 0 ${f(yaw)}"`
      + ` size="${f(mm(len / 2))} ${f(mm(w.marginMm ?? 0))} ${f(mm(hz))}"`
      + ` rgba="0.7 0.68 0.6 1"/>`);
  }
  out.push(...propGeoms(ws, userT, fx));
  return out.join('\n');
}

// URDF 에는 구동기도 감쇠도 없다. **P 제어만 걸면 팔이 발산한다** — 2026-08-11 실측:
// 최대 관절속도가 **52,000°/s** 까지 갔다(실기는 28.9°/s). 그래서 공식 `mujoco_menagerie` 의
// 6축 팔 관례를 따른다: **PD**(`kp`+`kv`) · `armature`(로터 관성) · `implicitfast` 적분기.
//
// ⛔ **이 값들은 실기 게인이 아니다.** 안정적으로 도달시키는 값일 뿐이고, 그래서 시뮬
//    사이클타임을 실기 사이클타임으로 인용하지 않는다(`batch.json` 이 글자로 말한다).
//    실기 속도의 정본은 `workcell.js` 의 `JOINT_DEG_S_AT_FULL` 이다.
const KP = 2000, KV = 400, ARMATURE = 0.1, FORCE = 150;

function actuators(robotXml) {
  // 관절 이름은 **구운 MJCF 에서 읽는다** — URDF 를 따로 파싱해 이름을 또 적으면 둘이 갈라진다.
  const names = [...robotXml.matchAll(/<joint[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
  if (!names.length) die('구운 MJCF 에 관절이 0개다');
  const rows = names.map((n) => `    <position name="act:${esc(n)}" joint="${esc(n)}"`
    + ` kp="${KP}" kv="${KV}" forcerange="-${FORCE} ${FORCE}" ctrlrange="-6.2832 6.2832"/>`);
  return `  <actuator>\n${rows.join('\n')}\n  </actuator>`;
}

/** 관절에 로터 관성을 붙이고, 적분기를 바꾸고, 중력을 보상한다. */
function stabilize(xml) {
  let out = xml.replace(/<joint (name="j)/g, `<joint armature="${ARMATURE}" $1`);
  if (!/<option[^>]*integrator=/.test(out)) {
    out = out.replace('<compiler', '<option integrator="implicitfast"/>\n  <compiler');
  }
  // **`gravcomp="1"` — 실기가 하는 일을 시뮬도 하게 한다.** 산업용 팔은 컨트롤러가 중력을
  // 보상해 자세를 유지한다. 안 걸면 PD 만으로는 정상상태 처짐이 남아(실측 j2 **1.7°**)
  // 손끝이 수 mm 어긋난 채 "도착" 으로 읽힌다 — 구역 판정이 그만큼 거짓이 된다.
  // ⚠ 중력 자체는 살아 있다 — 장면의 물체는 그대로 떨어진다. 보상은 팔 링크에만 건다.
  out = out.replace(/<body name="(shoulder|upperarm|forearm|wrist\d)_link"/g,
    '<body gravcomp="1" name="$1_link"');

  // ⛔ **베이스와 첫 링크의 가짜 충돌을 끈다.** 무조코는 부모-자식 몸통 충돌을 자동으로
  // 거르는데 **world 는 그 예외**다(그래야 바닥에 닿는다). URDF 의 `base_link` geom 은
  // 몸통이 아니라 worldbody 에 붙으므로, 첫 링크와 **영구 접촉**이 생긴다 — 2026-08-11 실측
  // **5.0mm 침투 · 접촉쌍 4개**. 그 마찰이 j1 을 붙들어 팔이 목표에 못 갔다(오차 0.6° 고정).
  // 실물이 자기 베이스에 박혀 있는 게 아니라 **메시를 볼록껍질로 근사해서** 생긴 것이다
  // (계약 §제한구역 이 이미 적어 둔 그 근사).
  const first = out.match(/<body[^>]*name="(\w+_link)"/)?.[1];
  if (!first) die('첫 링크 몸통을 못 찾았다');
  if (!/<contact>/.test(out)) {
    out = out.replace('</worldbody>',
      `</worldbody>\n\n  <contact>\n    <exclude body1="world" body2="${first}"/>\n  </contact>`);
  }
  return out;
}

// ── 손끝(TCP) ─────────────────────────────────────────────────────────────
// URDF 에 그리퍼가 없다(STACK §그리퍼). 그래서 손끝 자리를 **`gripper-mount.json` 에서 유도한다** —
// 3D 쌍둥이(`Shared/view3d/robot.js:275 applyMount`)가 그리퍼를 얹을 때 쓰는 바로 그 값이라,
// 새로 지어내는 게 아니라 **같은 정본을 같은 식으로** 읽는 것이다.
//
// 유도가 맞는지는 **서로 독립인 셋이 같은 값을 낸다**(2026-08-11 검산):
//   ① 조립좌표계 TCP (0, 63.02, −325.64) 에 mount 회전 X+90° · 위치 (0,−325.64,170.98) → **z 234.00mm**
//   ② 플랜지 99mm(STL Z 최댓값) + 그리퍼 총길이 135mm(실기 담당자 실측) = **234mm**
//   ③ positionMm.z 170.98 + tcpYMm 63.02 = **234.00mm**
//
// ⚠ **이것이 컨트롤러의 `GetForwardKin` 과 같다는 증거는 아직 없다** — 우리 3D 와 같을 뿐이다.
//    그 대조는 `GAP-MATRIX` 첫 행이 들고 있다.
/** 조립좌표계 한 점 → `parentLink` 좌표계 (mm). **회전은 X 축 하나뿐이다** — 아래가 그것을 강제한다. */
function mountPointMm(grip, [mx, my, mz]) {
  const [px, py, pz] = grip.positionMm;
  const [rxDeg, ryDeg, rzDeg] = grip.rotationDeg;
  // 이 파일은 X 회전만 구현한다. Y·Z 가 생기면 **조용히 무시되어** 그리퍼가 엉뚱한 데 붙는다 —
  // 그 침묵이 725mm 어긋난 장면과 같은 종류의 사고다. 값이 늘면 여기서 죽는다.
  if (ryDeg || rzDeg) die(`rotationDeg 의 Y·Z 를 안 쓴다: ${JSON.stringify(grip.rotationDeg)}`);
  const rx = (rxDeg * Math.PI) / 180;
  return [px + mx,
    py + my * Math.cos(rx) - mz * Math.sin(rx),
    pz + my * Math.sin(rx) + mz * Math.cos(rx)];
}

export function tcpOffsetMm(grip) {
  return mountPointMm(grip, [0, grip.depthCam.tcpYMm, grip.depthCam.toolAxisZMm]);
}

// ── 툴 충돌체 — **그리퍼는 site 가 아니라 물체여야 한다** ────────────────────
// 2026-08-11 까지 그리퍼는 `<site name="tcp">` 점 하나였다. site 는 질량도 충돌도 없는 표식이라
// 무조코가 **그리퍼가 벽에 박히는 것을 물리적으로 볼 수 없었다** — 박힐 물체가 없으니까.
// 「위반 0 · 최소여유 13mm」의 13mm 는 그래서 손끝 한 점의 여유였고, 거기서 옆으로 82mm 뻗은
// 깊이 카메라는 계산에 아예 없었다. 여기서 그 다섯을 물체로 세운다.
//
// ⛔ **형상을 여기서 유도하지 않는다.** 정본은 `Shared/data/config/tool-hull.json` 이고
//    실기 게이트(`FR5/bridge/safety.py`)도 **같은 파일**을 읽는다. 양쪽이 각각 유도하면
//    반드시 한쪽이 낡고, 그 순간 시뮬이 초록인 것을 실기가 거부한다 (불변식 4).
//    파일이 낡았는지는 `node scripts/build/tool-hull.mjs --check` 가 잰다.
const HULL = JSON.parse(readFileSync(join(ROOT, 'Shared/data/config/tool-hull.json'), 'utf-8'));

// 색은 형상이 아니라 보기 좋으라는 것이라 이름으로 고른다 — 정본(`tool-hull.json`)에 색을 넣지 않는다.
// **접두사로 고르지 않는다** — `cam-bracket` 과 `cam-body` 가 같이 잡힌다 (2026-08-11 에 그랬다).
const HULL_RGBA = { 'cam-bracket': '0.45 0.42 0.30 1', 'cam-body': '0.20 0.20 0.22 1' };
const rgbaOf = (name) => HULL_RGBA[name] ?? '0.30 0.34 0.40 1';

/**
 * `parentLink` 안에 들어갈 충돌체들. **개수가 곧 게이트의 기대값**이라 배열로 돌려준다.
 *
 * `tool-hull.json` 은 **TCP 기준**이고 MJCF 는 `parentLink` 기준이라 손끝만큼 더한다 —
 * 그 값은 `tcpOffsetMm` 하나에서만 나온다 (하드 룰 5).
 */
export function toolGeoms(grip = GRIP, hull = HULL) {
  const t = tcpOffsetMm(grip);
  return hull.boxes.map((b) => {
    const at = (g) => [0, 1, 2].map((a) => f(mm(g(a)))).join(' ');
    return `      <geom name="${esc(`tool:${b.name}`)}" type="box"`
      + ` pos="${at((a) => b.centerMm[a] + t[a])}" size="${at((a) => b.halfMm[a])}"`
      + ` mass="0" rgba="${rgbaOf(b.name)}"/>`;
  });
}

// ── 소품 — 받침과 작업물 ────────────────────────────────────────────────────
// ⛔ **구역이 아니라 충돌체다** (`SIM-CONTRACT.md` §받침·작업물은 충돌체이지 구역이 아니다).
//    `config.yaml` 에 상자로 넣으면 실기 게이트가 같이 바뀌는데 넣을 이유가 없다 — 파지점이
//    금지바닥 위 약 115mm 라 지금 게이트로 이미 열려 있다.
//
// ⛔ **치수·자리를 여기 안 적는다.** 정본은 `Shared/data/props.js` 이고 소품은 교체된다
//    (그 파일 머리 규약). 여기 적으면 소품을 갈 때 고칠 자리가 몇 군데인지 아무도 모른다.
//
// ⚠ **안 잰 값이 있으면 그 소품을 안 세운다.** `null` 을 0 으로 읽어 크기 0 짜리 물체를
//    장면에 세우면, 「없다」와 「0 이다」가 같아 보인다.
//
// ponytail: **고정 물체다 — 물리로 들지 못한다.** 몸통이 아니라 worldbody 의 geom 이라
// 중력도 접촉 반력도 이 물체를 안 움직인다. 계약이 파지를 **기하까지만** 재기로 했으므로
// (D123) 지금은 이걸로 충분하다. 천장 — 「집어서 옮긴다」를 물리로 보이려면 free joint 를
// 단 몸통으로 승격하고 마찰을 정해야 하는데, 그 값에 출처가 없다.
const propsUsable = (fx, obj) => fx?.centerMm?.length === 2
  && [fx.heightMm, fx.wMm, fx.dMm, obj?.lengthMm, obj?.diaMm].every((v) => Number.isFinite(v) && v > 0);

/**
 * 받침 + 그 위에 선 작업물. **작업대 상판 위에 앉힌다** — 게이트가 아는 그 상자다.
 * `userT` 만큼 밀어 베이스 좌표계로 옮기는 것은 `zones()` 와 같은 규약이다.
 *
 * ⚠ 장면의 상판은 `config.yaml` 의 **평평한** 상자(`topZMm`)이고 실물은 1.20° 기울어 있다.
 *   그래서 소품 높이는 실기의 그 자리보다 최대 상판 기울기만큼 다르다 — 파지 자세를 실기로
 *   옮길 때 그 차이가 어디서 왔는지 잊지 않게 여기 적어 둔다 (`table-raised-plane.md`).
 */
export function propGeoms(ws, userT, fx = FIXTURE, obj = ROUND) {
  if (!propsUsable(fx, obj)) return [];
  const [ux, uy, uz] = userT;
  // ⛔ **「첫 번째 작업대」를 집지 않는다.** 상판이 여럿이면(2026-08-18 · 800×500 셋)
  // 받침이 **어느 판 위에 있느냐**가 앉는 높이를 정한다 — 이름만 보고 하나를 집으면
  // 틀린 답이 아니라 **그럴듯한 답**이 나와서 안 들킨다. 받침 중심을 품는 판을 고른다.
  const tables = ws.boxes.filter((b) => /작업대/.test(b.name));
  const table = tables.find((b) => fx.centerMm[0] >= b.xMm[0] && fx.centerMm[0] <= b.xMm[1]
    && fx.centerMm[1] >= b.yMm[0] && fx.centerMm[1] <= b.yMm[1]);
  if (!table) return [];   // 상판이 없거나 받침이 어느 판 위도 아니다 — 세울 자리가 없다
  const [cx, cy] = [fx.centerMm[0] + ux, fx.centerMm[1] + uy];
  const topZ = table.topZMm + uz;              // 받침이 앉는 면
  const fixHalf = fx.heightMm / 2;
  return [
    `    <geom name="prop:${esc(fx.id)}" type="box"`
    + ` pos="${f(mm(cx))} ${f(mm(cy))} ${f(mm(topZ + fixHalf))}"`
    + ` size="${f(mm(fx.wMm / 2))} ${f(mm(fx.dMm / 2))} ${f(mm(fixHalf))}"`
    + ` rgba="0.80 0.74 0.62 1"/>`,
    // 세운다 (D122). 무조코 원기둥의 기본 축은 로컬 Z 라 회전이 없다 — 세운 것이 기본이다
    `    <geom name="prop:${esc(obj.id)}" type="cylinder"`
    + ` pos="${f(mm(cx))} ${f(mm(cy))} ${f(mm(topZ + fx.heightMm + obj.lengthMm / 2))}"`
    + ` size="${f(mm(obj.diaMm / 2))} ${f(mm(obj.lengthMm / 2))}"`
    + ` rgba="0.72 0.60 0.36 1"/>`,
  ];
}

/** 장면에 있어야 할 geom 수. **정의를 한 곳에 둔다** — 게이트도 이걸 부른다. */
export const wantGeomCount = (robot, ws, grip = GRIP) =>
  robot.counts.geom + 1 + ws.boxes.length + ws.walls.length + toolGeoms(grip).length
  + propGeoms(ws, [0, 0, 0]).length;

/**
 * 구운 로봇 MJCF 의 `</worldbody>` 앞에 구역을, 그 뒤에 구동기를 끼운다.
 * `userT` = 베이스 기준 유저 좌표계 원점 (mm · `coordDefs.user` 앞 셋). **로봇이 주는 값**이라
 * 픽스처로 얼려 건넨다 — `Sim/` 은 브리지에 못 묻는다(불변식 1).
 */
// ⚠ **받침 자리를 인자로 받는다** — 추종 검증이 받침을 격자로 옮겨 가며 같은 장면을 다시
// 굽기 때문이다 (`scripts/dev/follow-map.py` 가 낸 자리들). 기본값은 `props.js` 그대로라
// 안 주면 지금까지와 같은 장면이 나온다 — 게이트가 기대하는 geom 수도 안 바뀐다.
export function composeScene(robotXml, ws, userT, grip = GRIP, fx = FIXTURE) {
  if (!Array.isArray(userT) || userT.length < 3 || !userT.every(Number.isFinite)) {
    die('유저 좌표계 원점이 없다 — 구역이 725mm 어긋난 장면이 나온다 (Sim/fixtures/<robot>.json)');
  }
  const anchor = robotXml.lastIndexOf('</worldbody>');
  if (anchor < 0) die('구운 MJCF 에 <worldbody> 가 없다');

  // 손끝 site 를 마지막 링크 안에 넣는다. **몸통 이름을 박지 않는다** — `parentLink` 가 정본이다
  const parent = grip.parentLink;
  const at = robotXml.indexOf(`<body name="${parent}"`);
  if (at < 0) die(`구운 MJCF 에 ${parent} 몸통이 없다 — gripper-mount.json 의 parentLink 를 본다`);
  const close = robotXml.indexOf('>', at) + 1;
  const [tx, ty, tz] = tcpOffsetMm(grip);
  // site 는 잴 점이고, geom 은 **부딪히는 물체**다. 둘 다 같은 몸통 안에 들어간다 —
  // 한 몸통 안의 geom 끼리는 무조코가 접촉을 만들지 않으므로 그리퍼가 자기 손목과 싸우지 않는다.
  const site = `\n      <site name="tcp" pos="${f(mm(tx))} ${f(mm(ty))} ${f(mm(tz))}" size="0.004" rgba="1 0.3 0.1 1"/>`
    + `\n${toolGeoms(grip).join('\n')}`;
  const withSite = robotXml.slice(0, close) + site + robotXml.slice(close);

  const fixed = stabilize(withSite);
  const a2 = fixed.lastIndexOf('</worldbody>');
  return fixed.slice(0, a2) + zones(ws, userT, fx) + '\n  '
    + fixed.slice(a2)
      .replace('</worldbody>', `</worldbody>\n\n${actuators(fixed)}\n`);
}

export { bakeRobot };

/**
 * 베이스 기준 유저 좌표계 원점 (mm). **로봇이 정한 값**이라 픽스처에서만 온다 —
 * 없으면 죽는다. 기본값 0 을 넣으면 725mm 어긋난 장면이 조용히 나온다.
 */
export function userOrigin(robotId) {
  const path = join(ROOT, 'Sim/fixtures', `${robotId}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf-8')).coordDefs.user.slice(0, 3);
  } catch {
    return die(`픽스처가 없다: ${path} — 로봇을 붙이고 node scripts/dev/sim-fixture.mjs`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const robotId = argv.includes('--robot') ? argv[argv.indexOf('--robot') + 1] : 'fr5-lab-a';
  const mj = await loadMujoco();

  const ws = readWorkspace(robotId);
  const robot = bakeRobot(mj);
  const scene = composeScene(robot.xml, ws, userOrigin(robotId));

  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${robotId}.xml`);
  writeFileSync(path, scene);

  let v;
  try { v = verify(mj, scene, ws, robot); } catch (e) { die(e.message); }
  console.log(`장면 구움  ${basename(path)}  (${robotId})`);
  console.log(`  링크 ${v.body} · 관절 ${v.joint} · 메시 ${v.mesh}/${robot.meshCount}`
    + ` · 구역 ${ws.boxes.length}상자+${ws.walls.length}벽 · 툴 ${toolGeoms().length}`
    + ` · 구동기 ${v.actuator}`);
  console.log(`  ${path.replace(ROOT + '/', '')}`);
}

// **굽고 끝내지 않는다.** URDF 는 스키마 검사를 안 받으므로 조용히 빠진 것이 있어도
// 구워지기는 한다. 되읽어서 로봇 쪽 개수가 그대로인지, 구역이 다 들어갔는지 센다.
// ⛔ **`die()` 가 아니라 던진다.** 게이트가 「빠뜨리면 정말 죽나」를 결함 주입으로 확인해야
//    하는데, `process.exit` 이면 그 확인이 게이트 자신을 죽인다 (`sim-scene.mjs` ④).
export function verify(mj, scene, ws, robot) {
  // ⚠ **가상 FS 안에 쓴다.** `from_xml_path` 는 호스트 경로를 못 본다 — 메시도 여기 있어야
  // `meshdir` 상대경로가 풀린다. 호스트에 쓴 파일을 그대로 넘기면 `Error opening file` 이다.
  mj.FS.writeFile('/asset/scene.xml', scene);
  const model = mj.MjModel.from_xml_path('/asset/scene.xml');
  const got = { body: model.nbody, joint: model.njnt, geom: model.ngeom, mesh: model.nmesh,
    actuator: model.nu, site: model.nsite };
  model.delete();
  const bad = (m) => { throw new Error(m); };
  const wantGeom = wantGeomCount(robot, ws);   // 로봇 + 바닥 + 구역 + 툴 충돌체
  if (got.body !== robot.counts.body) bad(`링크가 ${robot.counts.body} → ${got.body} 로 바뀌었다`);
  if (got.joint !== robot.counts.joint) bad(`관절이 ${robot.counts.joint} → ${got.joint} 로 바뀌었다`);
  if (got.mesh !== robot.counts.mesh) bad(`메시가 ${robot.counts.mesh} → ${got.mesh} 로 바뀌었다`);
  if (got.geom !== wantGeom) bad(`geom 이 ${wantGeom} 이어야 하는데 ${got.geom} 이다`
    + ` — 구역(${ws.boxes.length}+${ws.walls.length}) 이나 툴 충돌체(${toolGeoms().length}) 가 빠졌다`);
  if (got.actuator !== robot.counts.joint) bad(`구동기가 관절 수(${robot.counts.joint})와 다르다: ${got.actuator}`);
  if (got.site < 1) bad('손끝 site 가 없다 — 위반 판정이 잴 점이 사라진다');
  return got;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
