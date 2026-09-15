// 장면 게이트 — **장면이 정말 생성물인가.**
//
// 실행: `node scripts/check/sim-scene.mjs`
//
// 손으로 옮겨 적은 좌표가 하나라도 있으면 `config.yaml` 을 고쳐도 장면이 안 따라오고,
// 그때부터 시뮬은 **옛 작업대 앞에서** 도는데 화면은 새 값이라고 말한다 (불변식 3).
// 그래서 이 게이트가 재는 것은 「장면이 만들어졌나」가 아니라 **「입력을 바꾸면 따라오나」** 다.
//
// ⚠ **`config.yaml` 을 건드리지 않는다.** 값을 흔드는 것은 파싱된 사본이고 디스크는 그대로다 —
//    게이트가 소스를 고쳤다가 되돌리는 방식은 중간에 죽으면 트리를 망가뜨린다.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { readWorkspace, bakeRobot, composeScene, verify, userOrigin, toolGeoms, wantGeomCount, propGeoms } from '../../Sim/scene/build-scene.mjs';
import { FIXTURE, ROUND } from '../../Shared/data/props.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ROBOT = 'fr5-lab-a';           // **실측 프로필** — mock 으로 재면 아무것도 안 잰다
const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok, name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// geom 하나의 속성을 꺼낸다. 이름에 한글·콜론이 들어가므로 이름으로 찾는다
const geomOf = (xml, name) => {
  const m = xml.match(new RegExp(`<geom name="${name}"[^>]*>`));
  if (!m) return null;
  const attr = (k) => (m[0].match(new RegExp(`${k}="([^"]+)"`)) ?? [])[1];
  return { pos: attr('pos'), size: attr('size'), euler: attr('euler') };
};

const mj = await loadMujoco();

// ── ① 손파서 ↔ pyyaml — 파서 둘이 갈리면 빨간불 ───────────────────────────
// `build-scene.mjs` 는 yaml 파서를 안 들이려고 고정 들여쓰기를 손으로 읽는다. 그 손파서가
// 상자 하나를 조용히 빠뜨리면 장면은 **초록으로** 나온다. 여기서 진짜 파서와 맞춰 본다.
const mine = readWorkspace(ROBOT);
const userT = userOrigin(ROBOT);
let theirs;
try {
  theirs = JSON.parse(execFileSync('python3', ['-c', `
import json, pathlib, yaml
cfg = yaml.safe_load(pathlib.Path("FR5/bridge/config.yaml").read_text())
for r in cfg.get("robots", []):
    if r.get("robotId") == "${ROBOT}":
        ws = r["workspace"]
        print(json.dumps({
            "frame": ws.get("frame"),
            "boxes": [{k: b.get(k) for k in ("name","xMm","yMm","topZMm","marginMm")} for b in ws.get("boxes") or []],
            "walls": [{k: w.get(k) for k in ("name","aMm","bMm","marginMm","seenZMm")} for w in ws.get("walls") or []],
        }, ensure_ascii=False))
        break
else:
    raise SystemExit("프로필 없음")
`], { cwd: ROOT, encoding: 'utf8' }));
} catch (e) {
  check('pyyaml 로 독립 파싱', false, String(e.stderr || e.message).trim().split('\n').pop());
  process.exit(1);
}
const norm = (o) => JSON.stringify(o, Object.keys(o).sort());
const cmp = [];
if (norm(mine.frame ?? {}) !== norm(theirs.frame ?? {})) cmp.push('frame');
for (const kind of ['boxes', 'walls']) {
  if (mine[kind].length !== theirs[kind].length) { cmp.push(`${kind} 개수 ${mine[kind].length}≠${theirs[kind].length}`); continue; }
  for (const [i, a] of mine[kind].entries()) {
    const b = theirs[kind][i];
    for (const k of Object.keys(b)) {
      if (b[k] === null || b[k] === undefined) continue;
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) cmp.push(`${kind}[${i}].${k} ${JSON.stringify(a[k])}≠${JSON.stringify(b[k])}`);
    }
  }
}
check(`파서 둘이 같은 값을 읽는다 (상자 ${mine.boxes.length} · 벽 ${mine.walls.length})`,
  cmp.length === 0, cmp.slice(0, 4).join(' · '));

// ── ② 굽는다 · 되읽어 센다 ────────────────────────────────────────────────
const robot = bakeRobot(mj);
const scene = composeScene(robot.xml, mine, userT);
let counts = null;
try { counts = verify(mj, scene, mine, robot); } catch { /* verify 는 실패하면 죽는다 */ }
check(`구운 장면을 되읽으면 링크 ${robot.counts.body} · 관절 ${robot.counts.joint} · 메시 ${robot.counts.mesh}`,
  counts !== null && counts.geom === wantGeomCount(robot, mine),
  counts ? '' : 'verify 가 죽었다');

// ── ③ 생성물 증명 — 입력을 흔들면 장면이 따라온다 ─────────────────────────
// **이게 이 게이트의 심장이다.** 좌표가 하나라도 손으로 박혀 있으면 여기서 안 움직인다.
const moved = [];
for (const [i, b] of mine.boxes.entries()) {
  const bent = JSON.parse(JSON.stringify(mine));
  bent.boxes[i].xMm = [b.xMm[0] + 137, b.xMm[1] + 137];        // 137mm — 우연히 같아질 수 없는 값
  const g0 = geomOf(scene, `box:${b.name}`);
  const g1 = geomOf(composeScene(robot.xml, bent, userT), `box:${b.name}`);
  if (!g0 || !g1) { moved.push(`${b.name}: geom 을 못 찾았다`); continue; }
  const dx = Number(g1.pos.split(' ')[0]) - Number(g0.pos.split(' ')[0]);
  if (Math.abs(dx - 0.137) > 1e-6) moved.push(`${b.name}: x 가 ${dx}m 움직였다 (0.137 이어야)`);
  if (g1.size !== g0.size) moved.push(`${b.name}: 평행이동인데 크기가 바뀌었다`);
}
for (const [i, w] of mine.walls.entries()) {
  const bent = JSON.parse(JSON.stringify(mine));
  bent.walls[i].bMm = [w.bMm[0], w.bMm[1] + 137];
  const g0 = geomOf(scene, `wall:${w.name}`);
  const g1 = geomOf(composeScene(robot.xml, bent, userT), `wall:${w.name}`);
  if (!g0 || !g1) { moved.push(`${w.name}: geom 을 못 찾았다`); continue; }
  if (g1.euler === g0.euler) moved.push(`${w.name}: 끝점을 옮겼는데 각도가 그대로다`);
  if (g1.size === g0.size) moved.push(`${w.name}: 끝점을 옮겼는데 길이가 그대로다`);
}
check(`입력을 137mm 흔들면 장면이 따라온다 (상자 ${mine.boxes.length} · 벽 ${mine.walls.length})`,
  moved.length === 0, moved.slice(0, 4).join(' · '));

// ── ③-2 툴 충돌체도 생성물인가 — 마운트를 흔들면 따라온다 ─────────────────
// **그리퍼가 site 한 점이던 시절의 재발 방지다.** 여기가 비면 무조코는 그리퍼가 벽에 박히는
// 것을 못 본다 — 박힐 물체가 없어서다. 개수와 「마운트를 옮기면 따라오나」 둘 다 잰다.
const GRIP = JSON.parse(readFileSync(join(ROOT, 'Shared/data/config/gripper-mount.json'), 'utf-8'));
const tool = [];
const names = toolGeoms(GRIP).map((g) => (g.match(/name="([^"]+)"/) ?? [])[1]);
if (names.length < GRIP.meshes.length + 1) tool.push(`툴 충돌체가 ${names.length}개뿐이다`);
for (const n of names) if (!geomOf(scene, n)) tool.push(`${n} 이 장면에 없다`);
{
  // 마운트를 137mm 올리면 툴 충돌체 전부가 그만큼 따라와야 한다 (회전 X+90 → z 는 my 축이다)
  const bent = JSON.parse(JSON.stringify(GRIP));
  bent.positionMm = [GRIP.positionMm[0], GRIP.positionMm[1], GRIP.positionMm[2] + 137];
  const after = composeScene(robot.xml, mine, userT, bent);
  for (const n of names) {
    const g0 = geomOf(scene, n);
    const g1 = geomOf(after, n);
    if (!g0 || !g1) continue;
    const dz = Number(g1.pos.split(' ')[2]) - Number(g0.pos.split(' ')[2]);
    if (Math.abs(dz - 0.137) > 1e-6) tool.push(`${n}: z 가 ${dz}m 움직였다 (0.137 이어야)`);
    if (g1.size !== g0.size) tool.push(`${n}: 평행이동인데 크기가 바뀌었다`);
  }
}
check(`툴 충돌체 ${names.length}개가 마운트를 따라온다 (그리퍼·카메라가 물체다)`,
  tool.length === 0, tool.slice(0, 4).join(' · '));

// ── ③-3 소품 — 받침·작업물이 **충돌체**로 서나 (칸 2) ─────────────────────
// 계약 §받침·작업물은 충돌체이지 구역이 아니다. 재는 것 셋 —
//   ① 둘 다 장면에 있다  ② 크기가 `props.js` 정본과 같다  ③ **구역이 아니다**
// 치수를 여기 안 적는다. 정본에서 유도해 대조하므로 `props.js` 가 바뀌면 따라온다.
const prop = [];
const round1 = (v) => Math.round(v * 1e6) / 1e6;
const box = geomOf(scene, `prop:${FIXTURE.id}`);
const cyl = geomOf(scene, `prop:${ROUND.id}`);
if (!box) prop.push('받침이 장면에 없다');
if (!cyl) prop.push('작업물이 장면에 없다');
if (box) {
  const want = [FIXTURE.wMm / 2, FIXTURE.dMm / 2, FIXTURE.heightMm / 2].map((v) => round1(v / 1000));
  const has = box.size.split(' ').map(Number);
  if (want.some((v, i) => Math.abs(v - has[i]) > 1e-6)) {
    prop.push(`받침 크기가 props.js 와 다르다: ${box.size} ≠ ${want.join(' ')}`);
  }
}
if (cyl) {
  const want = [ROUND.diaMm / 2, ROUND.lengthMm / 2].map((v) => round1(v / 1000));
  const has = cyl.size.split(' ').map(Number);
  if (want.some((v, i) => Math.abs(v - has[i]) > 1e-6)) {
    prop.push(`작업물 크기가 props.js 와 다르다: ${cyl.size} ≠ ${want.join(' ')}`);
  }
}
if (box && cyl) {
  // 총알 밑동이 받침 윗면이다 — 세워 뒀으니(D122) 그 둘이 닿아 있어야 한다
  const boxTop = Number(box.pos.split(' ')[2]) + Number(box.size.split(' ')[2]);
  const objBase = Number(cyl.pos.split(' ')[2]) - Number(cyl.size.split(' ')[1]);
  if (Math.abs(boxTop - objBase) > 1e-6) prop.push(`총알이 받침 위에 안 선다 (${objBase} ≠ ${boxTop})`);
}
// **구역이 아님을 잰다** — 소품 이름이 config 의 상자·벽에 없어야 한다 (불변식 4)
for (const z of [...mine.boxes, ...mine.walls]) {
  if (z.name === FIXTURE.label || /받침/.test(z.name)) {
    prop.push(`받침이 config.yaml 의 구역이 됐다: ${z.name} — 실기 게이트가 같이 바뀐다`);
  }
}
check('받침·총알이 충돌체로 선다 (구역이 아니다 · 크기는 props.js)',
  prop.length === 0, prop.slice(0, 4).join(' · '));

// 안 잰 값이 있으면 **안 세운다** — `null` 을 0 으로 읽어 크기 0 짜리 물체를 두지 않는다
{
  const blind = composeScene(robot.xml, mine, userT);
  const before = (blind.match(/name="prop:/g) ?? []).length;
  const gone = propGeoms(mine, userT, { ...FIXTURE, wMm: null }).length;
  check(`발자국을 지우면 소품이 사라진다 (${before}개 → ${gone}개)`, before === 2 && gone === 0,
    '안 잰 값이 0 으로 세워지면 「없다」와 「0 이다」가 같아 보인다');
}

// ── ④ 되읽기 검사가 진짜로 잡나 — 구역을 하나 빼 본다 ─────────────────────
// 「검사가 있다」와 「검사가 잡는다」는 다르다 (D97). 상자 하나를 없앤 장면을 만들어
// `verify` 가 죽는지 본다. 여기서 안 죽으면 ②의 초록은 아무 뜻이 없다.
const short = JSON.parse(JSON.stringify(mine));
short.boxes.pop();
let caught = false;
try { verify(mj, composeScene(robot.xml, short, userT), mine, robot); } catch { caught = true; }
check('구역을 하나 빼면 되읽기 검사가 죽는다', caught,
  caught ? '' : '빠진 것을 통과로 냈다 — 검사가 안 재고 있다');

// ── ⑤ 산출물은 커밋되지 않는다 ────────────────────────────────────────────
let tracked = '';
try {
  tracked = execFileSync('git', ['ls-files', 'Sim/out'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch { /* git 이 없으면 건너뛴다 */ }
check('Sim/out 은 커밋되지 않는다 (D14)', tracked === '', tracked.split('\n').slice(0, 3).join(' · '));

const bad = results.filter(([ok]) => !ok);
console.log(bad.length ? `\n${bad.length}개 실패 — ${bad.map(([, n]) => n).join(' · ')}`
  : `\n장면 OK — 파서 둘 일치 · 입력을 흔들면 따라온다 · 빠뜨리면 죽는다`);
process.exit(bad.length ? 1 : 0);
