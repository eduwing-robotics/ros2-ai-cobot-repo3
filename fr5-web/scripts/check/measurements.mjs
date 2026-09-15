#!/usr/bin/env node
// 현실값 전람 — **잰 것 전부를 한 화면에.** 그리고 출처 없는 숫자를 막는다.
//
// 왜 필요했나 — 실측값이 여섯 군데에 흩어져 있었다(`workcell.js` · `props.js` ·
// `global-cam.json` · `tag-layout.json` · `config.yaml` · `evidence/`). 다시 재려던 값이
// 이미 어딘가에 있는 일이 실제로 있었고(GAP #10: *"재기 전에 evidence 를 먼저 찾는다"*),
// 그때마다 사람이 여섯 군데를 뒤졌다. **뒤지는 대신 한 번 부른다.**
//
// 이건 보는 도구이자 게이트다. **출처(`method`)가 없는 값이 하나라도 있으면 실패한다** —
// 출처 없는 숫자는 다음 사람에게 "누가 언제 어떻게 얻었나" 를 다시 묻게 만들고, 그 질문에
// 답이 없으면 결국 다시 잰다. 그게 이 파일이 없애려는 낭비다.
//
//     bash scripts/check/measurements.sh      # all.sh 가 자동으로 집어 간다
//
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => p.replace(`${ROOT}/`, '');

let bad = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); bad += 1; };
const warn = (m) => console.log(`  WARN  ${m}`);

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null);
const load = (p) => import(pathToFileURL(join(ROOT, p)).href);

/** `{label, method, date}` 목록을 찍고, 출처가 빠진 줄을 실패로 센다. */
function table(title, file, rows) {
  console.log(`\n== ${title}  (${file}) ==`);
  if (!rows?.length) return warn(`${file} 에 읽을 값이 없다`);
  for (const r of rows) {
    if (!r?.label) { fail(`${file}: 라벨 없는 값이 있다`); continue; }
    if (!r.method) { fail(`${file}: "${r.label}" 에 출처가 없다 — 어떻게 얻었는지 적어라`); continue; }
    if (!r.date) { fail(`${file}: "${r.label}" 에 날짜가 없다`); continue; }
    console.log(`  ${r.label.padEnd(46)} ${r.method}  (${r.date})`);
  }
}

console.log('현실값 — 잰 것 전부. 값 하나마다 출처가 붙는다.');

// ── 작업셀 · 소품 (사람이 적는다)
const wc = await load('Shared/data/workcell.js');
table('작업셀', 'Shared/data/workcell.js', wc.MEASUREMENTS);

const pr = await load('Shared/data/props.js');
table('작업물·소품', 'Shared/data/props.js', pr.MEASUREMENTS);

// ── 카메라 (스크립트가 적는다 — 손으로 고치면 안 되는 자리)
const CAM = join(ROOT, 'Shared/data/config/global-cam.json');
const cam = readJson(CAM);
console.log(`\n== 글로벌 카메라  (${rel(CAM)} · 생성물) ==`);
if (!cam) {
  warn('아직 없다 — scripts/map/intrinsics.py → extrinsics.py');
} else {
  if (!cam._생성됨) fail(`${rel(CAM)}: 생성물인데 "_생성됨" 표기가 없다 — 손으로 고쳐졌을 수 있다`);
  const i = cam.intrinsics;
  if (i) {
    console.log(`  화각 HFOV ${i.hfovDeg}° · VFOV ${i.vfovDeg}°`.padEnd(48)
      + `ChArUco ${i.shots}장 · RMS ${i.rmsPx}px`);
    console.log(`  해상도 ${i.widthPx}×${i.heightPx} · fx ${i.fx?.toFixed(2)}`.padEnd(48)
      + 'scripts/map/intrinsics.py');
  } else fail(`${rel(CAM)}: intrinsics 가 없다`);
  const L = cam.labToCam;
  if (L) {
    console.log(`  태그면 위 ${L.heightMm} mm · 하향 ${L.depressionDeg}°`.padEnd(48)
      + `태그 ${L.tags}장 · RMS ${L.rmsPx}px`);
    // 원점이 셋이라 늘 헷갈린다 — 값 옆에 원점을 같이 적는다 (LAYOUT-METRICS-CONTRACT).
    console.log('  ↑ 원점은 바닥도 로봇 베이스도 아니다 — 상판 태그 id0 (z=0 은 태그 평면)');
  } else warn('labToCam 이 아직 없다 — 카메라 자리를 안 풀었다');
}

// ── 태그 (사람이 자로 잰다)
const LAY = join(ROOT, 'calib-shots/tag-layout.json');
const lay = readJson(LAY);
console.log(`\n== 태그 배치  (${rel(LAY)}) ==`);
if (!lay) warn('아직 없다 — python3 scripts/map/extrinsics.py --init');
else {
  console.log(`  인쇄물 태그 한 변 ${lay.tagSizeMm} mm`.padEnd(48) + '자 (인쇄물 실측)');
  // **원점 태그는 (0,0,0) 이 정상이다** — 0 을 "안 적었다" 로 세면 원점을 결측으로 읽는다.
  // 판정은 `extrinsics.py` 와 같게: **전부** 0 일 때만 안 적은 것이다.
  const tags = Object.entries(lay.tags ?? {});
  const zero = tags.filter(([, t]) => !t.xMm && !t.yMm);
  console.log(`  좌표를 적은 태그 ${tags.length}장`.padEnd(48)
    + `자 · 원점 id${zero.map(([id]) => id).join(',') || '없음'}`);
  if (tags.length && zero.length === tags.length) {
    fail(`${rel(LAY)}: 좌표가 전부 0 이다 — 자로 잰 값을 안 적었다`);
  }
}

// ── 작업영역 (로봇이 직접 짚는다)
const CFG = join(ROOT, 'FR5/bridge/config.yaml');
console.log(`\n== 작업영역 — 로봇이 직접 짚은 값  (${rel(CFG)}) ==`);
if (!existsSync(CFG)) fail(`${rel(CFG)} 가 없다`);
else {
  // yaml 파서를 새로 들이지 않는다 — 이 블록은 들여쓰기가 고정이라 줄만 떠 오면 된다.
  const lines = readFileSync(CFG, 'utf-8').split('\n');
  const at = lines.findIndex((l) => /^\s*workspace:\s*$/.test(l));
  if (at < 0) fail(`${rel(CFG)}: workspace 블록이 없다 — 작업영역 게이트가 꺼져 있다`);
  else {
    const pad = lines[at].search(/\S/);
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && l.search(/\S/) <= pad) break;
      const kv = l.split('#')[0].trim();
      if (kv) console.log(`  ${kv}`);
    }
    console.log('  ↑ 사용자 좌표계 1 기준이다 — 베이스로 보려면 workspace.js toBase()');
  }
}

// ── 표시(메시) ↔ 실물. **여기가 D50 이 지키라는 선이다.**
console.log('\n== 표시 ↔ 실물 ==');
const { WORKPIECE: W, WORKPIECE_MESH: M } = pr;
const line = (name, mesh, real) => {
  const over = mesh > real;
  console.log(`  ${name.padEnd(10)} 메시 ${String(mesh).padStart(4)} mm  실물 ${String(real).padStart(4)} mm`
    + (over ? `   ⚠ 메시가 ${(mesh / real).toFixed(1)}배 크다` : ''));
  return over;
};
const overDia = line('지름', M.diaMm, W.diaMm);
const overLen = line('길이', M.lengthMm, W.lengthMm);
if (overDia || overLen) {
  // **실패로 만들지 않는다.** 이미 `GAP-MATRIX` 가 들고 있는 열린 항목이고, 무엇보다 실물
  // 지름이 아직 예측이다. 예측을 근거로 게이트를 빨갛게 하면 사람이 게이트를 끄는 법을 배운다.
  warn('D50 "메시는 실물 점유 부피 이하" 를 지금 어긴다 — GAP-MATRIX OPEN · 실물 지름 실측 후 고친다');
}
if (!W.diaMeasured) warn(`${W.label} 지름 ${W.diaMm}mm 는 **제원에서 나눈 값**이다 — 자로 대면 diaMeasured 를 true 로`);

console.log('');
if (bad) { console.log(`현실값 — 출처 없는 값 ${bad}건`); process.exit(1); }
console.log('현실값 OK');
