#!/usr/bin/env node
/**
 * 팔의 **운동사슬과 링크별 충돌상자**를 URDF 에서 굽는다 — `Shared/data/config/arm-hull.json`.
 *
 *     node scripts/build/arm-hull.mjs            # 굽는다
 *     node scripts/build/arm-hull.mjs --check    # 쓰지 않고 대조만 (게이트용)
 *
 * ## 왜 있나
 *
 * 작업영역 게이트는 손끝과 **툴**까지 본다(`tool-hull.json`). 그런데 팔은 아직 못 본다 —
 * 2026-08-11 실측: 무작위 4000자세 중 **720개(18.0%)** 가 게이트는 통과인데 팔 링크가
 * 구역을 **실제로 관통**했다. 여유 침범이 아니라 관통이라 툴(10.6%)보다 심한 조건이다.
 *
 * ## 왜 Pinocchio 를 안 들이나
 *
 * 브리지는 **순수 표준 라이브러리**다 (`requirements.txt` 조차 없다). 안전 게이트에 첫
 * 무거운 의존성을 넣는 값보다, URDF 에서 체인을 굽고 파이썬으로 6줄짜리 FK 를 도는 값이 싸다.
 * FR5 는 관절 6개가 **전부 로컬 Z 회전**인 직렬 사슬이라 FK 가 짧다.
 *
 * 대신 **손으로 짠 FK 를 믿지 않는다** — `scripts/check/arm-fk.mjs` 가 무조코와
 * 자세 2000개로 대조하고, 실기 `fkSamples` 와도 맞춘다.
 *
 * ## 왜 tool-hull.json 과 따로 두나
 *
 * 다시 굽는 계기가 다르다. 툴은 **그리퍼를 바꾸면** 낡고, 팔은 **URDF 를 바꿔야** 낡는다.
 * 한 파일에 두면 그리퍼를 갈 때마다 팔까지 다시 굽고, 그 차이를 아무도 안 본다.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK_ONLY = process.argv.includes('--check');
const URDF = join(ROOT, 'Shared/assets/FAIRINO_FR5/fairino5_v6.urdf');
const MESHES = join(ROOT, 'Shared/assets/FAIRINO_FR5/meshes');
const OUT = join(ROOT, 'Shared/data/config/arm-hull.json');
const die = (m) => { console.error(`arm-hull: ${m}`); process.exit(1); };

/** 바이너리 STL 경계상자. **미터다** (URDF 는 scale 이 없다 = 1). ASCII·잘림이면 죽는다. */
function stlAabbM(path) {
  if (!existsSync(path)) die(`메시가 없다: ${path}`);
  const buf = readFileSync(path);
  if (buf.length < 84) die(`STL 이 너무 짧다: ${path}`);
  const n = buf.readUInt32LE(80);
  if (buf.length !== 84 + n * 50) die(`바이너리 STL 이 아니다(또는 잘렸다): ${path}`);
  if (!n) die(`STL 에 삼각형이 0개다: ${path}`);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i += 1) {
    const base = 84 + i * 50 + 12;                  // +12 = 법선을 건너뛴다
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

// ── URDF 파싱 — **정규식으로 읽는다.** xml 파서를 새로 들이지 않는다 (이 파일은 고정 서식이고,
//    빠뜨리면 아래 개수 검사가 죽는다). 모르는 것이 나오면 조용히 넘기지 않고 죽는다.
const xml = readFileSync(URDF, 'utf-8');
const nums = (s) => s.trim().split(/\s+/).map((v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) die(`숫자가 아니다: ${v}`);
  return n;
});

const chain = [];
for (const m of xml.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"[\s\S]*?<\/joint>/g)) {
  const [block, name, type] = m;
  if (type !== 'revolute') die(`${name}: revolute 만 구현했다 (type=${type})`);
  const org = block.match(/<origin[^>]*xyz="([^"]*)"[^>]*rpy="([^"]*)"/)
    ?? block.match(/<origin[^>]*rpy="([^"]*)"[^>]*xyz="([^"]*)"/);
  if (!org) die(`${name}: origin 을 못 읽었다`);
  const axis = block.match(/<axis[^>]*xyz="([^"]*)"/);
  if (!axis) die(`${name}: axis 가 없다`);
  const parent = block.match(/<parent\s+link="([^"]+)"/);
  const child = block.match(/<child\s+link="([^"]+)"/);
  if (!parent || !child) die(`${name}: parent/child 를 못 읽었다`);
  const a = nums(axis[1]);
  // 로컬 Z 회전만 구현했다. 다른 축이 생기면 **조용히 틀린 자세**가 나오므로 여기서 죽는다
  if (!(a[0] === 0 && a[1] === 0 && Math.abs(a[2]) === 1)) die(`${name}: axis 가 ±Z 가 아니다 (${a})`);
  chain.push({ joint: name, parent: parent[1], child: child[1],
    xyzMm: nums(org[1]).map((v) => Number((v * 1000).toFixed(4))),
    rpyDeg: nums(org[2]).map((v) => Number((v * 180 / Math.PI).toFixed(6))),
    axisSign: a[2] });
}
if (chain.length !== 6) die(`관절이 6개가 아니다: ${chain.length}`);

// ── 링크 상자 — 메시 하나당 하나. **origin 이 원점이 아니면 죽는다** (지금은 전부 0 이고,
//    아니게 되면 상자를 그만큼 옮겨야 하는데 조용히 틀리면 안 된다)
const links = [];
for (const m of xml.matchAll(/<link\s+name="([^"]+)"([\s\S]*?)<\/link>/g)) {
  const [, name, body] = m;
  const col = body.match(/<collision>([\s\S]*?)<\/collision>/);
  if (!col) { links.push({ name, boxes: [] }); continue; }
  const org = col[1].match(/<origin[^>]*xyz="([^"]*)"[^>]*rpy="([^"]*)"/);
  if (org && (nums(org[1]).some((v) => v !== 0) || nums(org[2]).some((v) => v !== 0))) {
    die(`${name}: collision origin 이 원점이 아니다 — 상자를 옮기는 코드가 없다`);
  }
  const mesh = col[1].match(/<mesh[^>]*filename="([^"]*)"/);
  if (!mesh) die(`${name}: collision 에 mesh 가 없다`);
  if (/scale=/.test(col[1])) die(`${name}: mesh scale 을 안 쓴다 — 값이 생겼다`);
  const file = basename(mesh[1]);
  const [lo, hi] = stlAabbM(join(MESHES, file));
  links.push({ name,
    centerMm: [0, 1, 2].map((a) => Number(((lo[a] + hi[a]) / 2 * 1000).toFixed(3))),
    halfMm: [0, 1, 2].map((a) => Number(((hi[a] - lo[a]) / 2 * 1000).toFixed(3))),
    source: file });
}
const have = new Set(readdirSync(MESHES).filter((f) => /\.stl$/i.test(f)));
const used = new Set(links.map((l) => l.source).filter(Boolean));
if (used.size !== have.size) die(`메시 ${have.size}개 중 ${used.size}개만 썼다 — 링크가 빠졌다`);

const hull = {
  _생성됨: '이 파일은 생성물이다 (node scripts/build/arm-hull.mjs). **직접 고치지 마라.**'
    + ' 정본은 Shared/assets/FAIRINO_FR5/fairino5_v6.urdf 와 그 meshes/*.STL 이다.',
  _단위: '밀리미터·도. 상자는 **각 링크의 자기 좌표계**, 체인은 부모 링크 기준 관절 원점이다.',
  _FK: 'T_child = T_parent · Trans(xyzMm) · Rz(rpy.z)·Ry(rpy.y)·Rx(rpy.x) · Rz(axisSign·q).'
    + ' 관절은 여섯 다 로컬 Z 회전이라 마지막이 Rz 하나다. 검증은 scripts/check/arm-fk.mjs.',
  _근사: '상자는 링크 메시의 **경계상자**다 — 실물보다 크므로 판정은 안전한 쪽으로만 틀린다.'
    + ' 팔은 가늘고 긴 부품이라 경계상자가 실제보다 꽤 굵다(특히 upperarm·forearm).',
  baseLink: chain[0].parent,
  chain,
  links,
};

const next = `${JSON.stringify(hull, null, 2)}\n`;
if (CHECK_ONLY) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf-8') : '';
  if (cur !== next) die(`${OUT.replace(`${ROOT}/`, '')} 이 낡았다 — node scripts/build/arm-hull.mjs`);
  console.log(`arm-hull: 최신 (관절 ${chain.length} · 링크 ${links.length})`);
} else {
  writeFileSync(OUT, next);
  console.log(`팔 형상 구움  Shared/data/config/arm-hull.json  (관절 ${chain.length} · 링크 ${links.length})`);
  for (const l of links) {
    console.log(`  ${l.name.padEnd(15)} 반크기 [${(l.halfMm ?? []).join(', ')}]`);
  }
}
