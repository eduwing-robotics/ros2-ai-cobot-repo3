#!/usr/bin/env node
// 5.56×45 더미탄 메시를 탄피·탄두 둘로 가른다 — 화면 표시용.
//
// 왜: 데모 작업물이 페트병에서 더미탄으로 바뀌었고(팀원이 실물을 나사 결합식으로 개조 중),
// 뷰어·AR 이 두 파트를 따로 그려야 조립 진행을 보여줄 수 있다. **나사산은 여기서 안 만든다** —
// 그건 파라메트릭 CAD 의 일이고 실물 제작 쪽 몫이다.
//
// 어떻게: 케이스 입구 평면 z=44.7 에서 삼각형을 그냥 나눈다. **자를 게 없다** — 원본 메시에
// 이미 그 높이에 각진 링(내경 φ5.70 · 외경 φ6.43)이 있어 평면을 가로지르는 삼각형이 0개다.
// 그래서 클리핑이 필요 없고 원본 형상이 한 점도 안 바뀐다. 44.7 은 5.56×45 규격의
// 케이스 길이와 소수점까지 같다 (정점 링 실측 2026-08-10).
//
// 잘린 자리는 경계 모서리(삼각형 하나만 쓰는 모서리)를 고리로 엮어 무게중심 부채꼴로 막는다.
// 막고 나서 **모든 모서리가 정확히 두 번 쓰이는지**로 밀폐를 검사하고, 아니면 안 쓴다.
//
//   node scripts/build/round-split.mjs            # 검사만 (dry-run)
//   node scripts/build/round-split.mjs --write    # 실제로 쓴다
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'Shared/assets/round_5_56x45';
const SRC = `${DIR}/round.stl`;
const CUT = 44.7;          // 케이스 입구. 여기 위가 탄두 노출부(12.7mm)다
const EPS = 1e-3;
const WRITE = process.argv.includes('--write');

/** 바이너리 STL → 삼각형 배열. 각 삼각형은 정점 3개 [x,y,z]. */
function readStl(path) {
  const buf = readFileSync(path);
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 !== buf.length) throw new Error(`${path}: 바이너리 STL 이 아니다`);
  const tris = [];
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50 + 12;                 // +12 = 법선 건너뛰기
    const t = [];
    for (let v = 0; v < 3; v++) {
      const o = base + v * 12;
      t.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)]);
    }
    tris.push(t);
  }
  return tris;
}

function writeStl(path, tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    const [a, b, c] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = u[1] * w[2] - u[2] * w[1];
    const ny = u[2] * w[0] - u[0] * w[2];
    const nz = u[0] * w[1] - u[1] * w[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / len, o); buf.writeFloatLE(ny / len, o + 4); buf.writeFloatLE(nz / len, o + 8);
    t.forEach((p, v) => {
      const q = o + 12 + v * 12;
      buf.writeFloatLE(p[0], q); buf.writeFloatLE(p[1], q + 4); buf.writeFloatLE(p[2], q + 8);
    });
  });
  writeFileSync(path, buf);
}

const key = (p) => `${Math.round(p[0] / EPS)},${Math.round(p[1] / EPS)},${Math.round(p[2] / EPS)}`;

/**
 * 열린 경계를 무게중심 부채꼴로 막는다. 고리가 여러 개면 각각 막는다.
 *
 * 경계는 **무방향 모서리 사용 횟수 1** 로 찾는다. 감김 방향으로 찾으면 안 된다 —
 * 이 원본은 첨두(z=57.40)의 240면이 감김이 뒤집혀 있어(밀폐는 정상 · 법선만 어긋남)
 * 방향으로 세면 경계가 240 → 480 으로 부풀었다 (실측 2026-08-10).
 *
 * @param {number} up 자른 몸통이 평면 **아래**면 +1, **위**면 -1. 뚜껑 법선을 이걸로 강제한다
 */
function capHoles(tris, up) {
  const und = new Map();                            // "a|b"(정렬) → 사용 횟수
  const pos = new Map();                            // 키 → 좌표
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      const ka = key(a), kb = key(b);
      pos.set(ka, a); pos.set(kb, b);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      und.set(k, (und.get(k) || 0) + 1);
    }
  }
  const adj = new Map();                            // 경계 정점 → 이웃들
  for (const [k, c] of und) {
    if (c !== 1) continue;
    const [a, b] = k.split('|');
    if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b);
    if (!adj.has(b)) adj.set(b, []); adj.get(b).push(a);
  }
  if (adj.size === 0) return { caps: [], loops: 0 };

  const caps = [];
  const seen = new Set();
  let loops = 0;
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let cur = start, prev = null;
    while (cur && !seen.has(cur)) {
      seen.add(cur); loop.push(cur);
      const nx = adj.get(cur).find((v) => v !== prev && !seen.has(v));
      prev = cur; cur = nx;
    }
    if (loop.length < 3) continue;
    loops++;
    const c = [0, 0, 0];
    for (const k of loop) { const p = pos.get(k); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= loop.length; c[1] /= loop.length; c[2] /= loop.length;

    // 고리는 절단면(z 일정) 위에 있으므로 부채꼴 법선은 ±z 뿐이다. 한 장으로 재고 뒤집는다
    const p0 = pos.get(loop[0]), p1 = pos.get(loop[1]);
    const nz = (p0[0] - c[0]) * (p1[1] - c[1]) - (p0[1] - c[1]) * (p1[0] - c[0]);
    const flip = Math.sign(nz) !== Math.sign(up);
    for (let i = 0; i < loop.length; i++) {
      const a = pos.get(loop[i]), b = pos.get(loop[(i + 1) % loop.length]);
      caps.push(flip ? [b, a, c] : [a, b, c]);
    }
  }
  return { caps, loops };
}

/** 모든 모서리가 정확히 두 번 쓰이면 밀폐다. */
function isWatertight(tris) {
  const m = new Map();
  for (const t of tris) for (let i = 0; i < 3; i++) {
    const a = key(t[i]), b = key(t[(i + 1) % 3]);
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  let open = 0;
  for (const c of m.values()) if (c !== 2) open++;
  return { ok: open === 0, open };
}

const bbox = (tris) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of t) for (let i = 0; i < 3; i++) {
    if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i];
  }
  return { lo, hi };
};

// ── 분할 ────────────────────────────────────────────────────────────────────
const src = readStl(SRC);
const straddle = src.filter((t) => Math.max(...t.map((p) => p[2])) > CUT + EPS
                                && Math.min(...t.map((p) => p[2])) < CUT - EPS);
if (straddle.length) {
  // ponytail: 클리핑을 구현하지 않았다. 이 메시에서는 필요가 없었기 때문이다(0개).
  // 다른 높이에서 자르려면 여기서 삼각형을 평면으로 쪼개는 코드가 먼저다.
  console.error(`  FAIL  평면을 가로지르는 삼각형 ${straddle.length}개 — 이 스크립트는 클리핑을 안 한다`);
  process.exit(1);
}
const caseTris = src.filter((t) => Math.max(...t.map((p) => p[2])) <= CUT + EPS);   // 입구 링 포함
const tipTris  = src.filter((t) => Math.min(...t.map((p) => p[2])) >= CUT - EPS
                                && Math.max(...t.map((p) => p[2])) > CUT + EPS);

const jobs = [
  ['round-case.stl', caseTris, '탄피', 44.70, 9.60, +1],   // 몸통이 평면 아래 → 뚜껑 법선 +z
  ['round-tip.stl',  tipTris,  '탄두', 12.70, 5.70, -1],   // 몸통이 평면 위   → 뚜껑 법선 -z
];

console.log(`  원본 ${SRC}  삼각형 ${src.length}`);
console.log(`  평면 z=${CUT} 를 가로지르는 삼각형 ${straddle.length}개 — 클리핑 불필요\n`);

const out = [];
let fail = 0;
for (const [name, tris, label, wantLen, wantDia, up] of jobs) {
  const { caps, loops } = capHoles(tris, up);
  const whole = [...tris, ...caps];
  const wt = isWatertight(whole);
  const { lo, hi } = bbox(whole);
  const len = hi[2] - lo[2];
  const dia = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  const lenOk = Math.abs(len - wantLen) < 0.05;
  const diaOk = Math.abs(dia - wantDia) < 0.05;
  console.log(`  ${label}  ${name}`);
  console.log(`    삼각형 ${tris.length} + 뚜껑 ${caps.length} (고리 ${loops}) = ${whole.length}`);
  console.log(`    z ${lo[2].toFixed(2)} ~ ${hi[2].toFixed(2)}   길이 ${len.toFixed(2)}mm  (목표 ${wantLen})  ${lenOk ? 'OK' : 'FAIL'}`);
  console.log(`    최대 지름 ${dia.toFixed(2)}mm  (목표 ${wantDia})  ${diaOk ? 'OK' : 'FAIL'}`);
  console.log(`    밀폐 ${wt.ok ? 'OK' : `FAIL — 열린 모서리 ${wt.open}개`}`);
  if (!lenOk || !diaOk || !wt.ok) fail = 1;
  out.push([`${DIR}/${name}`, whole]);
}

const totalOut = out.reduce((s, [, t]) => s + t.length, 0);
console.log(`\n  합계 ${totalOut} 삼각형 (원본 ${src.length} + 뚜껑 ${totalOut - src.length})`);
if (fail) { console.error('  FAIL  목표와 다르다 — 쓰지 않는다'); process.exit(1); }
if (!WRITE) { console.log('  (dry-run — 쓰려면 --write)'); process.exit(0); }
for (const [path, tris] of out) writeStl(path, tris);
console.log('  기록 완료.');
