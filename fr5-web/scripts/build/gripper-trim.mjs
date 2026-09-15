#!/usr/bin/env node
// 그리퍼 몸통 메시를 실물 길이에 맞춘다 — 툴축(메시 +Y)에서 22mm 를 도려낸다.
//
// 왜: 유니티에서 가져온 `PGEA-100-40_body.stl` 은 플랜지→몸통 끝이 132.00mm 인데
// 실물은 110mm 다 (2026-08-05 실측 · 총 길이는 핑거 25mm 포함 135mm).
// 대환 공식 사양서 총장은 118(브레이크 없음)/138(있음) 이라 132+25=157 은 어느 쪽도 아니다.
//
// 어떻게: **단면이 일정한 구간에서만** 잘라 붙인다. 정점 Y 히스토그램에 구멍이 있는
// 곳(= 옆면 삼각형이 통으로 지나가는 프리즘 구간)을 고르면, 그 안의 평면 하나를 기준으로
// 위쪽 정점을 전부 22mm 내려도 옆면이 그대로 짧아질 뿐 형상이 깨지지 않는다.
// 균일 축소(Y 스케일)를 쓰지 않는 이유는 플랜지 볼트면·조 슬롯까지 같이 눌리기 때문이다.
//
// ponytail: **어느 22mm 가 잉여인지는 모른다.** 유일하게 단면이 일정한 구간(플랜지 기준
// 80.55~104.00mm · 목 구간)에서 도려냈을 뿐이다. 길이는 맞고 형상은 근사다.
// 천장 — 대환 공식 STEP(`PGEA-100-40-W-F` · 제품 페이지 Download, 개인정보 폼 뒤)을
// 받으면 이 스크립트를 버리고 메시를 통째로 교체한다. 그때 오프셋도 다시 검산한다.
//
// 멱등이 아니다 — 두 번 돌리면 44mm 가 준다. 원본은 git 이 들고 있다.
//   node scripts/build/gripper-trim.mjs            # 검사만 (dry-run)
//   node scripts/build/gripper-trim.mjs --write    # 실제로 쓴다
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'Shared/assets/PGEA_100_40';
const CUT_FROM = 9.5;      // 프리즘 구간(8.56~32.02) 안쪽. 양끝에 여유를 둔다
const CUT_MM = 22.0;       // 132 → 110
const WRITE = process.argv.includes('--write');

// 목표 치수는 **설정에서 온다** (2026-08-11). 전에는 110·25·135 가 여기 박혀 있어서,
// 핑거를 갈고 이 스크립트를 다시 돌리면 옛 목표로 FAIL 하고 사람이 이유를 찾아야 했다.
// `.env` 의 FR5_GRIPPER_FINGER_MM 이 정본이고 `scripts/check/assets.sh` 가 STL 과 대조한다.
const CFG = JSON.parse(readFileSync('Shared/data/config/gripper-mount.json', 'utf8'));
const WANT_FINGER = CFG.fingerProtrusionMm;
const WANT_TOTAL = CFG.toolLengthMm;
const WANT_BODY = WANT_TOTAL - WANT_FINGER;

/** 바이너리 STL 의 정점을 (x,y,z)→(x,y,z) 함수로 옮긴다. 삼각형 수·법선은 건드리지 않는다. */
function mapVertices(path, fn) {
  const buf = readFileSync(path);
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 !== buf.length) throw new Error(`${path}: 바이너리 STL 이 아니다`);
  let min = Infinity, max = -Infinity;      // 정점이 18만 개다 — spread 로 모으면 스택이 터진다
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50 + 12;          // +12 = 법선 건너뛰기
    for (let v = 0; v < 3; v++) {
      const o = base + v * 12;
      const p = [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
      const q = fn(p);
      buf.writeFloatLE(q[0], o); buf.writeFloatLE(q[1], o + 4); buf.writeFloatLE(q[2], o + 8);
      if (q[1] < min) min = q[1];
      if (q[1] > max) max = q[1];
    }
  }
  return { buf, n, min, max };
}

const jobs = [
  // 몸통 — 잘라내는 평면 **위쪽만** 내린다 (아래쪽 = 플랜지 면은 제자리)
  ['PGEA-100-40_body.stl', ([x, y, z]) => [x, y > CUT_FROM ? y - CUT_MM : y, z]],
  // 핑거 둘 — 통째로 잘린 구간보다 위에 있으므로 전부 같이 내린다
  ['PGEA-100-40_finger_left.stl', ([x, y, z]) => [x, y - CUT_MM, z]],
  ['PGEA-100-40_finger_right.stl', ([x, y, z]) => [x, y - CUT_MM, z]],
];

const out = [];
for (const [name, fn] of jobs) {
  const path = `${DIR}/${name}`;
  const { buf, n, min, max } = mapVertices(path, fn);
  out.push({ name, n, min, max, buf, path });
}

const body = out[0];
const tip = Math.max(out[1].max, out[2].max);
console.log(`  잘라낼 평면 Y=${CUT_FROM} 위쪽을 ${CUT_MM}mm 내린다 (몸통) · 핑거는 전체 이동`);
for (const o of out) console.log(`  ${o.name.padEnd(32)} tri ${o.n}  Y ${o.min.toFixed(2)} ~ ${o.max.toFixed(2)}`);
console.log(`  → 플랜지 면 Y=${body.min.toFixed(2)}`);
console.log(`  → 몸통 길이 ${(body.max - body.min).toFixed(2)}mm  (목표 ${WANT_BODY})`);
console.log(`  → 핑거 돌출 ${(tip - body.max).toFixed(2)}mm  (목표 ${WANT_FINGER})`);
console.log(`  → 총 길이   ${(tip - body.min).toFixed(2)}mm  (목표 ${WANT_TOTAL})`);

const ok = Math.abs(body.max - body.min - WANT_BODY) < 0.05
  && Math.abs(tip - body.max - WANT_FINGER) < 0.05
  && Math.abs(tip - body.min - WANT_TOTAL) < 0.05;
if (!ok) { console.error('  FAIL  목표 치수와 다르다 — 쓰지 않는다'); process.exit(1); }

if (!WRITE) { console.log('  (dry-run — 쓰려면 --write)'); process.exit(0); }
for (const o of out) writeFileSync(o.path, o.buf);
console.log('  기록 완료. Shared/data/config/gripper-mount.json 은 안 바뀐다 (플랜지 면 Y 그대로)');
