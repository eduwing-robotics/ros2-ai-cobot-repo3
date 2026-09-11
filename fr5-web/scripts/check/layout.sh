#!/usr/bin/env bash
# 배치안 게이트 — 출하 예제가 스키마를 지키고, 부품 이름이 실제로 존재하는지.
#
# 왜 있나 — `validateLayout()` 이 저장소에 있는데 **아무도 안 불렀다.** 그래서
# `store.posMm` 이 2개짜리인 채로 계속 실패하고 있었고 (2026-08-03 발견),
# 소품 이름을 바꿔도 배치안이 조용히 빈 자리로 남았다.
# 실패하면 exit 1.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 배치안 =="
node --input-type=module -e "
import { PRESETS, buildPreset } from './Shared/data/layout/presets.js';
import { validateLayout, reachCheck, crossings } from './Shared/data/layout/schema.js';
import { DEFENSE_M, M, PROPS, assembleProps } from './Shared/view3d/parts.js';
import { createAnchorOverlay, ANCHOR_PROPS } from './Shared/view3d/anchor-overlay.js';
import assert from 'node:assert/strict';
import { CATALOG, CATEGORIES, PROP_CARDS, cardKey, SIZE_MM, SIZE_LABEL, SIZE_RANGE_MM } from './Shared/data/layout/catalog.js';
import * as THREE from 'three';

let fail = 0;
const note = (s) => console.log('  ' + s);
const bad  = (s) => { console.log('  FAIL  ' + s); fail = 1; };

// 겹침 판정은 **맞닿는 것을 허용한다** — 컨베이어를 작업대 끝에 붙이는 건 정상이다.
const TOUCH_M = 0.003;   // 3mm

// 공장 연출/경로 평벨트 회귀 — 실측 core 보존, 고정 프레임, 되감기, 실주행 방향/연결 초기화.
{
  let passed = 0;
  const check = (name, fn) => {
    try { fn(); passed += 1; } catch (e) { bad('공장 벨트 ' + name + ': ' + e.message); }
  };
  const real = buildPreset('realmap');
  const stage = buildPreset('factory-walk');
  check('실측 core 보존', () => {
    for (const key of ['stations', 'arms', 'amrs', 'frame']) assert.deepEqual(stage[key], real[key]);
    for (const prop of real.props) assert.deepEqual(stage.props.find((p) => p.id === prop.id), prop);
    assert.match(PRESETS.find((p) => p.id === 'factory-walk').label, /연출/);
  });
  check('레퍼런스 외관 계약', () => {
    assert.equal(stage.appearance, 'defense-reference-v1');
    assert.equal(real.appearance, undefined);
    assert.ok(validateLayout({ ...real, appearance: 'unknown-look' }).some((e) => e.includes('appearance')));
  });
  check('재질 적용 범위', () => {
    const styled = assembleProps(stage.props, {
      materialStyle: stage.appearance,
      materialFilter: (p) => p.id === 'convIn' || p.id === 'convOut' || p.id?.startsWith('factory-'),
    });
    const materials = (id) => {
      const found = new Set();
      styled.getObjectByName(id).traverse((o) => {
        if (!o.isMesh) return;
        for (const material of Array.isArray(o.material) ? o.material : [o.material]) found.add(material);
      });
      return found;
    };
    const originals = new Set(Object.values(M));
    const defense = new Set(Object.values(DEFENSE_M));
    assert.ok([...materials('table1')].some((m) => originals.has(m)));
    assert.ok(![...materials('table1')].some((m) => defense.has(m) && !originals.has(m)));
    assert.ok([...materials('factory-inspection')].some((m) => defense.has(m)));
    assert.ok([...materials('convIn')].some((m) => defense.has(m)));
    assert.equal(DEFENSE_M.floor.map?.isDataTexture, true);
  });
  const group = assembleProps(real.props);
  const input = group.getObjectByName('convIn');
  const output = group.getObjectByName('convOut');
  const api = group.userData;
  const belt = input.userData.belt;
  const seam = input.getObjectByName('belt-surface');
  input.updateMatrixWorld(true);
  const installedAt = input.position.toArray();
  const initial = Array.from(seam.instanceMatrix.array);
  const fixed = input.children.filter((o) => o !== seam).map((o) => o.matrix.toArray());
  check('치수와 태그 일치', () => {
    for (const [id, tag] of [['convIn', 33], ['convOut', 32]]) {
      const prop = real.props.find((p) => p.id === id);
      assert.deepEqual(prop.opts, ANCHOR_PROPS[tag].opts);
      const size = new THREE.Box3().setFromObject(PROPS.conveyor(prop.opts));
      const dimensions = size.getSize(new THREE.Vector3()).multiplyScalar(1000);
      assert.ok(Math.abs(size.min.y) < 1e-7);
      assert.ok(Math.abs(dimensions.x - prop.opts.lengthMm) < 0.01);
      assert.ok(Math.abs(dimensions.z - prop.opts.wMm) < 0.01);
      assert.ok(Math.abs(dimensions.y - prop.opts.hMm) < 0.01);
    }
  });
  check('표면만 전진', () => {
    assert.equal(api.setConveyorTravel('convIn', 17), true);
    assert.equal(belt.travelMm, 17);
    assert.notDeepEqual(Array.from(seam.instanceMatrix.array), initial);
    assert.deepEqual(input.children.filter((o) => o !== seam).map((o) => o.matrix.toArray()), fixed);
    assert.deepEqual(input.position.toArray(), installedAt);
  });
  check('정지와 절대 되감기', () => {
    assert.equal(api.setConveyorTravel('convIn', 17), false);
    api.setConveyorTravel('convIn', -17);
    assert.notDeepEqual(Array.from(seam.instanceMatrix.array), initial);
    api.setConveyorTravel('convIn', 0);
    assert.deepEqual(Array.from(seam.instanceMatrix.array), initial);
  });
  check('잘못된 입력 보존', () => {
    for (const value of [NaN, Infinity, '15', null]) assert.equal(api.setConveyorTravel('convIn', value), false);
    assert.equal(api.setConveyorTravel('missing', 10), false);
    assert.equal(api.setConveyorPose('convIn', { xMm: NaN, yMm: 0 }), false);
    assert.equal(belt.travelMm, 0);
  });
  check('pose 정지와 순방향', () => {
    assert.equal(api.setConveyorPose('convIn', { xMm: 10, yMm: 20 }), false);
    assert.equal(api.setConveyorPose('convIn', { xMm: 10, yMm: 20, thetaDeg: 90 }), false);
    assert.equal(api.setConveyorPose('convIn', { xMm: 30, yMm: 20 }), true);
    assert.equal(belt.travelMm, 20);
  });
  check('90도 구간과 역방향', () => {
    api.setConveyorPose('convOut', { xMm: 0, yMm: 0 });
    api.setConveyorPose('convOut', { xMm: 0, yMm: 25 });
    assert.equal(output.userData.belt.travelMm, 25);
    api.setConveyorPose('convOut', { xMm: 0, yMm: -10 });
    assert.equal(output.userData.belt.travelMm, -10);
    assert.equal(belt.travelMm, 20);
  });
  check('연결 해제/절대 주입 후 첫 pose는 기준만', () => {
    api.setConveyorPose('convIn', null);
    api.setConveyorPose('convIn', { xMm: 1000, yMm: 1000 });
    assert.equal(belt.travelMm, 20);
    api.setConveyorTravel('convIn', 100);
    api.setConveyorPose('convIn', { xMm: 2000, yMm: 2000 });
    assert.equal(belt.travelMm, 100);
  });
  check('앵커 공용 API와 재정합', () => {
    const scene = new THREE.Scene();
    const overlay = createAnchorOverlay(scene);
    assert.equal(overlay.setConveyorTravel(33, 10), false);
    const doc = { anchors: { 33: { labMm: [100, 200, 965], yawDeg: 0 } } };
    overlay.update(doc);
    assert.equal(overlay.setConveyorTravel(33, 10), true);
    let disposed = false;
    scene.getObjectByName('belt-surface').addEventListener('dispose', () => { disposed = true; });
    assert.equal(overlay.update(doc).changed, false);
    assert.equal(scene.getObjectByName('anchor-33').userData.belt.travelMm, 10);
    doc.anchors[33].labMm[0] = 120;
    overlay.update(doc);
    assert.equal(disposed, true);
    assert.equal(scene.getObjectByName('anchor-33').userData.belt.travelMm, 0);
    overlay.setConveyorPose(33, { xMm: 0, yMm: 0 });
    overlay.setConveyorPose(33, { xMm: -5, yMm: 0 });
    assert.equal(scene.getObjectByName('anchor-33').userData.belt.travelMm, -5);
    overlay.dispose();
    assert.equal(scene.children.length, 0);
    assert.equal(overlay.setConveyorPose(33, null), false);
  });
  note('공장 연출/벨트 회귀 ' + passed + '/11 통과');
}

for (const preset of PRESETS) {
  const k = preset.id;
  const L = buildPreset(k);
  const errs = validateLayout(L);
  if (Array.isArray(errs) && errs.length) errs.forEach((e) => bad(k + ': ' + e));
  else note(k + ': 스키마 OK — ' + preset.label);

  // **모르는 부품 이름은 화면에서 조용히 빈 자리가 된다.** 경고만 나오고 앱은 안 죽는다.
  for (const p of L.props ?? []) {
    if (!PROPS[p.type]) bad(k + ': 없는 부품 type — ' + p.id + ' → ' + p.type);
  }
  for (const s of L.stations ?? []) {
    if (s.prop && !PROPS[s.prop]) bad(k + ': 없는 스테이션 prop — ' + s.id + ' → ' + s.prop);
  }

  // 도달 판정이 **화면과 같은 좌표**로 서는지 — 하나도 안 닿으면 배치가 깨진 것이다
  const r = reachCheck(L);
  const inReach = r.filter((x) => x.inReach).length;
  if (r.length && inReach === 0) bad(k + ': 팔이 닿는 스테이션이 하나도 없다');
  note(k + ': 부품 ' + (L.props?.length ?? 0)
    + ' · 스테이션 ' + r.length
    + (r.length ? ' (도달 ' + inReach + '/' + r.length + ' — ' + r.map((x) => x.id + (x.inReach ? '○' : '✗')).join(' ') + ')' : '')
    + ' · AMR ' + (L.amrs?.length ?? 0) + '대 교착 ' + crossings(L).length + '곳');

  // **가구가 서로 파묻혀도 화면은 멀쩡해 보인다.** 눈으로 안 잡히므로 상자로 잡는다.
  //
  // 판정이 둘로 갈린다 — **바닥에 선 것끼리는 겹치면 안 되고, 올려 놓은 것은
  // 받칠 것 위에 있어야 한다.** 한 잣대로 보면 작업대 위 물건이 전부 겹침으로 잡힌다
  // (벤치 뒷턱이 상판보다 50mm 높아 AABB 가 물린다).
  const items = [
    ...(L.props ?? []),
    // **\`baseMm\` 이 실제로 놓이는 높이다** — 화면(\`layout-view.js\`)이 그렇게 놓는데
    // 게이트만 \`posMm[2]\` 를 보면, 바닥에 선 리프터를 '떠 있다' 고 잡는다 (2026-08-04).
    ...(L.stations ?? []).filter((s) => s.prop)
      .map((s) => ({ ...s, type: s.prop, posMm: [s.posMm[0], s.posMm[1], s.baseMm ?? s.posMm[2] ?? 0] })),
  ];
  const g = assembleProps(items);
  const boxes = g.children.map((c, i) => ({
    id: items[i].id, type: items[i].type, zMm: items[i].posMm[2] ?? 0,
    box: new THREE.Box3().setFromObject(c).expandByScalar(-TOUCH_M),
  })).filter((b) => !b.box.isEmpty());

  const room = new THREE.Box3(
    new THREE.Vector3(0, 0, -L.floor.depthMm / 1000),
    new THREE.Vector3(L.floor.widthMm / 1000, L.floor.heightMm / 1000, 0),
  ).expandByScalar(TOUCH_M);
  for (const b of boxes) {
    if (!room.containsBox(b.box)) bad(k + ': 방 밖으로 나갔다 — ' + b.id + ' (' + b.type + ')');
  }

  // **머리 위 구조물은 바닥 겹침 규칙 밖이다.** 갠트리 크레인의 AABB 는 그 아래를 통째로
  // 덮으므로, 같은 잣대로 보면 크레인 하나가 방 안 모든 것과 '겹친다' 고 나온다.
  // 그렇다고 검사를 끄지 않는다 — **방 안에 있는지는 그대로 본다** (천장을 뚫으면 잡힌다).
  const ceiling = new Set(PROP_CARDS.filter((c) => c.mount === 'ceiling').map((c) => c.id));
  const floor = boxes.filter((b) => !b.zMm && !ceiling.has(b.type));
  for (let i = 0; i < floor.length; i += 1) {
    for (let j = i + 1; j < floor.length; j += 1) {
      if (floor[i].box.intersectsBox(floor[j].box)) {
        bad(k + ': 바닥 부품이 겹친다 — ' + floor[i].id + ' ↔ ' + floor[j].id);
      }
    }
  }

  // 올려 놓은 것 — **네 모서리가 각각 어느 받침 위엔가 있어야 한다.** 안 그러면 공중에 떠 있다.
  // 통째로 한 받침 안이라는 옛 잣대는 실맵에서 깨졌다 (2026-08-19) — 실물 작업대 3판이
  // **밀착으로 스냅**돼 있어(config.yaml §작업대) 판 두 장에 걸친 컨베이어가 정상이다.
  // 모서리 넷이 다 받쳐지면 다리 사이를 가로지르는 것도 통과한다 — 그건 다리(bridge)라 실물도 된다.
  // 공차 1mm — 받침 변에 **딱 맞춘** 물건이 부동소수점(1.6−0.1 ≠ 1.5) 때문에 2e-16 밖으로
  // 판정된다. 1mm 걸침은 실물에서도 안 떨어진다.
  const EPS = 0.001;
  const onAny = (x, z) => floor.some((f) => x >= f.box.min.x - EPS && x <= f.box.max.x + EPS
    && z >= f.box.min.z - EPS && z <= f.box.max.z + EPS);
  for (const b of boxes.filter((x) => x.zMm)) {
    const c = b.box;
    const corners = [[c.min.x, c.min.z], [c.min.x, c.max.z], [c.max.x, c.min.z], [c.max.x, c.max.z]];
    if (!corners.every(([x, z]) => onAny(x, z))) {
      bad(k + ': 받칠 것 없이 떠 있다 — ' + b.id + ' (' + b.type + ' · z=' + b.zMm + 'mm)');
    }
  }
  note(k + ': 상자 ' + boxes.length + '개 (바닥 ' + floor.length + ') — 방 안 · 안 겹침 · 받침 위');
}

// 팔 규약 — **이송팔에 FR5 모형을 달지 않는다** (\`SHARED-CORE.md\` §arms).
// 실물이 없는 팔에 실물 모형을 달면 실측 수치가 어디에 붙는지 화면이 말하지 못한다. **검사가 실제로 잡는지 일부러 어겨서 확인한다** — 안 그러면
// \`validateLayout\` 이 조용히 헛돌아도 모른다 (2026-08-03 에 실제로 그랬다).
{
  const base = buildPreset('cell');
  const bad2 = [
    ['이송팔이 FR5', { ...base, arms: [...base.arms, { id: 'tfX', role: 'transfer', model: 'FR5', basePosMm: [0, 0, 0], reachMm: 800 }] }],
    ['팔 id 중복', { ...base, arms: base.arms.map((a) => ({ ...a, id: 'same' })) }],
    ['팔이 없다', { ...base, arms: [] }],
  ];
  for (const [why, L] of bad2) {
    if (!validateLayout(L).length) bad('팔 규약을 어겼는데 통과했다 — ' + why);
  }
  note('팔 규약 — 어긴 배치안 ' + bad2.length + '종을 전부 잡는다');
}

// 카탈로그 자체 — 규약 두 개는 전 부품이 지켜야 한다.
//
// **설치 높이는 인자로만 올라간다.** 벽걸이(\`wallCabinet.baseMm\`)는 기본값이 공중이지만,
// 그 인자를 0 으로 주면 바닥에 내려와야 한다.
// 코드에 높이를 박아 두면 배치안이 그 부품만 못 옮긴다 (하드 룰 5).
const LIFT = { wallCabinet: { baseMm: 0 }, crane: { baseMm: 0 } };
for (const [name, make] of Object.entries(PROPS)) {
  let g;
  try { g = make(LIFT[name] ?? {}); } catch (e) { bad('부품 ' + name + ' 생성 실패: ' + e.message); continue; }
  if (!g.isGroup) { bad('부품 ' + name + ': THREE.Group 이 아니다'); continue; }
  // **원점이 발자국 가운데여야 배치안이 부품을 예측대로 놓는다.** 한쪽으로 치우치면
  // 좌표는 작업대 위인데 형태가 밖으로 흘러나온다 (workstation 이 그랬다 · 2026-08-04).
  const bb = new THREE.Box3().setFromObject(g);
  const c = bb.getCenter(new THREE.Vector3());
  const sz = bb.getSize(new THREE.Vector3());
  // clutter 만 뺀다 — **흩뿌린 잔물건이라 무게중심이 씨앗마다 다르다.** 규약 위반이 아니다.
  for (const ax of name === 'clutter' ? [] : ['x', 'z']) {
    if (sz[ax] > 1e-6 && Math.abs(c[ax]) / sz[ax] > 0.15) {
      bad('부품 ' + name + ': 원점이 ' + ax + ' 로 치우쳤다 ('
        + Math.round(c[ax] * 1000) + 'mm · 폭의 ' + Math.round((c[ax] / sz[ax]) * 100) + '%)');
    }
  }

  const y = bb.min.y;
  if (Math.abs(y) > 1e-6) {
    bad('부품 ' + name + ': 바닥에 안 선다 (y최소 ' + (y * 1000).toFixed(1) + 'mm)'
      + (LIFT[name] ? ' — 설치 높이 인자를 0 으로 줬는데도' : ' — 공중에 뜨려면 설치 높이를 인자로 받아라'));
  }
}
note('부품 ' + Object.keys(PROPS).length + '종 — Group 반환 · 바닥에 선다 (설치 높이는 인자로만)');

// 카탈로그 ↔ 팩토리 **양방향**. 한쪽만 검사하면 반대쪽이 조용히 낡는다 —
// 카탈로그에만 있으면 팔레트가 없는 부품을 내놓고, 팩토리에만 있으면 팔레트에 영영 안 뜬다.
const catIds = new Set(PROP_CARDS.map((c) => c.id));
for (const c of PROP_CARDS) {
  if (!PROPS[c.id]) bad('카탈로그에 있는데 팩토리가 없다 — ' + c.id);
  if (!CATEGORIES.some((g) => g.id === c.category)) bad('없는 분류 — ' + c.id + ' → ' + c.category);
}
for (const name of Object.keys(PROPS)) {
  if (!catIds.has(name)) bad('팩토리에 있는데 카탈로그에 없다 — ' + name + ' (팔레트에 영영 안 뜬다)');
}
// 크기 손잡이 — **키마다 실제로 형태가 바뀌어야 한다.**
// 오타가 나면 화면에 칸은 뜨는데 아무 일도 안 일어난다. 그게 제일 나쁜 실패다.
for (const [name, keys2] of Object.entries(SIZE_MM)) {
  if (!PROPS[name]) { bad('크기 손잡이가 없는 부품을 가리킨다 — ' + name); continue; }
  // **크기가 아니라 상자 전체를 본다** — \`baseMm\` 처럼 위치만 옮기는 손잡이도 살아 있는 키다.
  const b0 = new THREE.Box3().setFromObject(PROPS[name]({}));
  for (const k of keys2) {
    if (!SIZE_LABEL[k]) bad(name + ': 이름표 없는 치수 키 — ' + k);
    // 기본값을 모르므로 **범위 양끝**으로 흔들어 본다. 하나라도 달라지면 살아 있는 키다.
    let moved = false;
    for (const v of [SIZE_RANGE_MM.min * 3, 2400]) {
      const b = new THREE.Box3().setFromObject(PROPS[name]({ [k]: v }));
      if (!b.min.equals(b0.min) || !b.max.equals(b0.max)) moved = true;
    }
    if (!moved) bad(name + ': 치수 키가 형태를 안 바꾼다 — ' + k + ' (오타면 칸만 뜨고 아무 일도 안 난다)');
  }
}
note('크기 손잡이 ' + Object.keys(SIZE_MM).length + '종 · '
  + Object.values(SIZE_MM).flat().length + '칸 — 전부 형태를 바꾼다');

const keys = CATALOG.map(cardKey);
if (new Set(keys).size !== keys.length) bad('카탈로그 카드 키가 겹친다 — 같은 id 를 여러 장 두려면 key 를 준다');
note('카탈로그 ' + CATALOG.length + '장(소품 ' + PROP_CARDS.length + ') · 분류 ' + CATEGORIES.length + '개 — 팩토리와 양방향 일치');

console.log('');
// ── AMR 경로 교차 — **선분으로 본다.**
//
// 2026-08-04 까지는 꼭짓점끼리만 비교해서, 가운데서 대각으로 완전히 교차하는 두 경로도
// **검출 0건**이었다 (꼭짓점 사이가 5657mm 라서). 교착이 날 자리를 미리 보여주는 것이
// 이 함수의 목적인데 정작 교차를 못 잡았다. 그 판을 여기 박아 둔다.
{
  const mk = (id, w) => ({ id, model: 'TurtleBot', reachMm: 380, dockPosMm: w[0], waypointsMm: w });
  const T = [
    ['대각으로 엇갈린다', [[0, 0], [4000, 4000]], [[0, 4000], [4000, 0]], 1, 0],
    ['멀리 나란하다', [[0, 0], [4000, 0]], [[0, 5000], [4000, 5000]], 0, null],
    ['가까이 나란하다', [[0, 0], [4000, 0]], [[0, 300], [4000, 300]], 1, 300],
    ['T 자로 닿는다', [[0, 0], [4000, 0]], [[2000, 0], [2000, 3000]], 1, 0],
    ['점 하나씩', [[1000, 1000]], [[1200, 1000]], 1, 200],
  ];
  for (const [name, wa, wb, want, gap] of T) {
    const c = crossings({ amrs: [mk('a', wa), mk('b', wb)] });
    if (c.length !== want) bad('교차 ' + name + ' — ' + c.length + '건 (기대 ' + want + ')');
    else if (gap !== null && c[0].gapMm !== gap) bad('교차 ' + name + ' 틈 ' + c[0].gapMm + ' (기대 ' + gap + ')');
  }
  // **묶는다** — 나란한 선분이 길면 표시가 수십 개 쏟아져 바닥이 구슬밭이 된다
  const many = crossings({ amrs: [
    mk('a', [[0, 0], [1000, 0], [2000, 0], [3000, 0], [4000, 0]]),
    mk('b', [[0, 200], [1000, 200], [2000, 200], [3000, 200], [4000, 200]]),
  ] });
  if (many.length > 4) bad('나란한 경로에서 표시가 ' + many.length + '개 — 묶이지 않았다');
  note('경로 교차 — 엇갈림·나란함·T자·한 점 ' + T.length + '종 · 묶기 ' + many.length + '개');
}

console.log(fail ? '배치안 실패' : '배치안 OK');
process.exit(fail);
" 2>&1 | grep -v '^모르는 부품'
exit "${PIPESTATUS[0]}"
