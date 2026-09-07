// 팔 FK 게이트 — **손으로 짠 파이썬 FK 가 진짜 기구학과 같은가.**
//
// 실행: `node scripts/check/arm-fk.mjs`
//
// `safety.link_poses_mm` 은 Pinocchio 없이 URDF 체인을 직접 돈다. 짧아서 넣은 것이지
// 믿을 만해서 넣은 게 아니다 — **틀리면 팔 판정이 통째로 엉뚱한 자리를 막는다.**
// 그래서 같은 URDF 를 읽는 무조코와 자세 2000개로 대조한다. 둘은 서로 독립 구현이다.
//
// ⚠ **무조코 이름표는 `MjData` 를 만들기 전에 문자열로 복사한다** — 힙이 커지면 뷰가 끊어진다
//    (`detached ArrayBuffer`. 2026-08-11 에 겪었다).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { bakeRobot } from '../../Sim/scene/build-scene.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const N = 2000;
const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok, name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const mj = await loadMujoco();
const robot = bakeRobot(mj);
mj.FS.writeFile('/asset/fk.xml', robot.xml);
const m = mj.MjModel.from_xml_path('/asset/fk.xml');

// 몸통 이름표를 먼저 굳힌다
const dec = new TextDecoder();
const BODY = [];
{
  const nm = m.names; const adr = m.name_bodyadr;
  for (let b = 0; b < m.nbody; b += 1) {
    const a = adr[b];
    let n = '';
    if (a >= 0) { let e = a; while (nm[e]) e += 1; n = dec.decode(nm.slice(a, e)); }
    BODY.push(n);
  }
}
const d = new mj.MjData(m);

// **난수는 재현되게** — seed 를 박아 매번 같은 2000자세다 (`SIM-CONTRACT` §증식과 같은 이유)
let s = 20260812 >>> 0;
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const DEG = Math.PI / 180;

const poses = [];
const mine = [];
for (let it = 0; it < N; it += 1) {
  const q = [];
  for (let j = 0; j < m.nq; j += 1) {
    const lo = m.jnt_range[j * 2]; const hi = m.jnt_range[j * 2 + 1];
    const v = lo < hi ? lo + rnd() * (hi - lo) : (rnd() * 2 - 1) * Math.PI;
    q.push(v / DEG);
    d.qpos[j] = v;
  }
  mj.mj_kinematics(m, d);
  poses.push(q.map((v) => +v.toFixed(6)));
  const one = {};
  for (let b = 0; b < m.nbody; b += 1) {
    if (!BODY[b] || BODY[b] === 'world') continue;
    one[BODY[b]] = {
      p: [d.xpos[b * 3] * 1000, d.xpos[b * 3 + 1] * 1000, d.xpos[b * 3 + 2] * 1000],
      r: Array.from({ length: 9 }, (_, k) => d.xmat[b * 9 + k]),
    };
  }
  mine.push(one);
}
d.delete(); m.delete();

// ── 파이썬 쪽에 같은 자세를 물어본다 ────────────────────────────────────────
let theirs;
try {
  theirs = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path("FR5/bridge").resolve()))
import safety
poses = json.load(sys.stdin)
out = []
for q in poses:
    lp = safety.link_poses_mm(q)
    if isinstance(lp, Exception):
        raise SystemExit(f"link_poses_mm 이 죽었다: {lp}")
    out.append({k: {"p": v[1], "r": [x for row in v[0] for x in row]} for k, v in lp.items()})
print(json.dumps(out))
`], { cwd: ROOT, input: JSON.stringify(poses), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
} catch (e) {
  check('파이썬 FK 가 돈다', false, String(e.stderr || e.message).trim().split('\n').pop());
  process.exit(1);
}

// ── 대조 ────────────────────────────────────────────────────────────────────
// **6개가 맞다.** URDF 의 `base_link` 는 무조코에서 몸통이 아니라 worldbody 에 붙으므로
// 움직이는 몸통은 여섯이다 (`build-scene.mjs` §stabilize 가 같은 사실을 다루고 있다).
// 파이썬은 `base_link` 를 항등으로 하나 더 내는데, 항등이라 대조할 것이 없다.
const linkNames = Object.keys(mine[0]);
check(`무조코가 움직이는 링크 6개를 준다 (base_link 는 worldbody)`,
  linkNames.length === 6, linkNames.join(' · '));

let worstPos = 0; let worstRot = 0; let missing = null;
for (let i = 0; i < N; i += 1) {
  for (const nmL of linkNames) {
    const a = mine[i][nmL]; const b = theirs[i][nmL];
    if (!b) { missing = nmL; continue; }
    worstPos = Math.max(worstPos, Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]));
    let tr = 0;
    for (let k = 0; k < 9; k += 1) tr += a.r[k] * b.r[k];
    worstRot = Math.max(worstRot, Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / DEG);
  }
}
check('파이썬이 같은 링크 집합을 낸다', missing === null, missing ? `${missing} 이 없다` : '');
// 0.001mm·0.001° — 같은 수식을 서로 다르게 구현했을 때의 부동소수 오차 수준이다.
// 여기가 통과하면 **우리 FK 는 무조코와 같은 기구학**이다 (URDF 가 같으니 당연해야 한다).
check(`자세 ${N}개 · 링크 ${linkNames.length}개에서 무조코와 같다`,
  worstPos < 1e-3 && worstRot < 1e-3,
  `위치 최대 ${worstPos.toExponential(2)}mm · 회전 최대 ${worstRot.toExponential(2)}°`);

// ── 결함 주입 — 관절 하나를 1° 틀면 빨개지나 (D97) ──────────────────────────
let injected = 0;
try {
  const bent = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path("FR5/bridge").resolve()))
import safety
poses = json.load(sys.stdin)
out = []
for q in poses:
    q2 = list(q); q2[1] += 1.0        # j2 만 1도 틀어 본다 — 아래 링크 다섯이 따라 움직인다
    lp = safety.link_poses_mm(q2)
    out.append({k: {"p": v[1]} for k, v in lp.items()})
print(json.dumps(out))
`], { cwd: ROOT, input: JSON.stringify(poses.slice(0, 50)), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  for (let i = 0; i < bent.length; i += 1) {
    for (const nmL of linkNames) {
      const a = mine[i][nmL]; const b = bent[i][nmL];
      if (b && Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) > 0.5) injected += 1;
    }
  }
} catch { /* 아래 check 가 0 으로 잡는다 */ }
// **자식 링크의 원점은 안 움직인다** — 원점이 곧 관절 자리라 j2 를 돌려도 `upperarm` 은
// 방향만 바뀐다. 위치가 움직이는 것은 그 아래 넷(forearm·wrist1~3)이고, 자세 50개면 200쌍이다.
// (방향까지 맞는지는 위 2000자세 대조가 이미 쟀다.)
check('관절을 1° 틀면 그 아래 링크 넷이 따라 움직인다', injected >= 50 * 4,
  `움직인 (자세,링크) 쌍 ${injected} / 200 — 적으면 대조가 덜 재고 있다`);

const bad = results.filter(([ok]) => !ok);
console.log(bad.length ? `\n${bad.length}개 실패 — ${bad.map(([, n]) => n).join(' · ')}`
  : `\n팔 FK OK — 자세 ${N}개에서 무조코와 일치, 틀면 빨개진다`);
process.exit(bad.length ? 1 : 0);
