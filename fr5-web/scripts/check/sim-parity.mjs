// 대조 게이트 — **시뮬의 「위반」과 실기의 「거부」가 같은 뜻인가.**
//
// 실행: `node scripts/check/sim-parity.mjs`
//
// 96벌을 돌리기 전에 이걸 먼저 세운다. 두 판정이 갈리면 그 뒤 나오는 숫자는 전부
// **어느 정의로 잰 건지 모르는 숫자**가 되고, 차트가 아무리 예뻐도 근거가 아니라 그림이다
// (`SIM-CONTRACT.md` 불변식 4 · `GOAL-sim-batch.md` §0 크럭스).
//
// **판정은 파이썬이 굽고 우리는 맞춰 본다** — `Sim/` 이 `FR5/bridge` 를 import 하지 않기
// 때문이다(불변식 1). 그 경계 자체도 여기서 grep 으로 잰다.
//
// ⚠ **이 게이트는 자기가 빨개질 수 있음을 매번 증명한다.** 통과한 뒤 사본의 여유값만
// 1mm 흔들어 다시 대조하고, 그래도 전부 맞으면 **실패로 친다** — 아무것도 안 재는
// 게이트가 초록을 내는 것이 제일 나쁜 결과다 (`SAFETY-RULES.md` 제1원칙).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { judgeWorkspace, RULE } from '../../Sim/runner/judge.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok, name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 판정 결과를 비교 가능한 한 줄로. 순서는 뜻이 없으므로 정렬한다
const key = (vs) => vs.map((v) => `${v.rule}:${v.name ?? '-'}`).sort().join('|') || '(통과)';

// ── ① 경계 — Sim 이 브리지를 부르지 않는다 ────────────────────────────────
let leaked = '';
try {
  leaked = execFileSync('grep', ['-rn', '-e', 'FR5/bridge', '-e', 'robot_adapter', 'Sim'],
    { cwd: ROOT, encoding: 'utf8' });
} catch { /* grep 은 못 찾으면 exit 1 이다 — 그게 통과다 */ }
// 주석에서 정본을 가리키는 것까지 막으면 출처를 못 적는다. **import 만** 본다
const badImport = leaked.split('\n').filter((l) => /^\S+:\d+:\s*(import|from|require)/.test(l));
check('Sim → FR5/bridge import 0건', badImport.length === 0, badImport.join(' / '));

// ── ② 픽스처 — 실기 게이트가 `n` 개를 판정한다 ────────────────────────────
// ⛔ **개수를 여기 베껴 적지 않는다** — 굽는 쪽(`sim-parity-poses.py`)의 `N` 이 정본이다.
// 2026-08-18 에 작업대가 세 판이 되며 경계 자세가 187 → 283 으로 늘었는데, 여기 박아 둔
// 200 때문에 **멀쩡한 대조(402/402 일치)가 거짓으로 붉었다.**
let fx;
try {
  fx = JSON.parse(execFileSync('python3', [join(ROOT, 'scripts/check/sim-parity-poses.py')],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
} catch (e) {
  check('픽스처를 굽는다', false, String(e.stderr || e.message).trim().split('\n').pop());
  process.exit(1);
}
check(`픽스처 ${fx.cases.length}건 (프로필 ${fx.robotId} · seed ${fx.seed} · 상한 ${fx.n})`,
  fx.cases.length === fx.n, fx.cases.length !== fx.n ? `${fx.n} 이어야 한다 — 사이에서 잘렸다` : '');

// ── ③ 대조 — 전부 같아야 한다 ────────────────────────────────────────────
const diff = [];
for (const [i, c] of fx.cases.entries()) {
  const mine = key(judgeWorkspace(c.tcpMm, fx.workspace, c.coord, c.jointsDeg, c.coordDefs));
  const theirs = key(c.verdicts);
  if (mine !== theirs) diff.push(`#${i} ${JSON.stringify(c.tcpMm)} 실기[${theirs}] ≠ 시뮬[${mine}]`);
}
for (const [i, c] of fx.brokenCases.entries()) {
  const mine = key(judgeWorkspace(c.tcpMm, fx.brokenWorkspace, c.coord, c.jointsDeg, c.coordDefs));
  const theirs = key(c.verdicts);
  if (mine !== theirs) diff.push(`망가진#${i} 실기[${theirs}] ≠ 시뮬[${mine}]`);
}
const total = fx.cases.length + fx.brokenCases.length;
const blocked = fx.cases.filter((c) => c.verdicts.length).length;
check(`판정 일치 ${total - diff.length}/${total}`, diff.length === 0, diff.slice(0, 5).join(' · '));
// 전부 통과이거나 전부 거부인 표본은 **대조가 아니다** — 경계를 안 지난 것이다
check(`표본이 경계를 지난다 (거부 ${blocked} · 통과 ${fx.cases.length - blocked})`,
  blocked > 10 && blocked < fx.cases.length - 10);

// **안 나는 규칙은 안 재진 규칙이다.** 2026-08-11 에 상판 격자만으로 200 이 차면서 벽 자세가
// 통째로 잘렸는데도 게이트는 `200/200 일치` 로 초록을 냈다. 그 사고를 여기서 막는다
const fired = new Set([...fx.cases, ...fx.brokenCases].flatMap((c) => c.verdicts.map((v) => v.rule)));
// **목록을 손으로 적지 않는다.** 규칙을 `RULE` 에 늘리고 여기를 잊으면 그 규칙은 영영
// 안 재진 채 초록이 난다 — 위 사고와 똑같은 모양이다. 셋만 뺀다: 형상 파일을 **치워야**
// 나는 것들이라, 그건 게이트가 자기 입력을 부수는 주입이고 중간에 죽으면 트리가 망가진다
// (`wallMalformed` 는 프로필만 흔들면 돼서 남아 있다). 그 셋은 단위 테스트가 따로 잰다.
const CANNOT_FIRE = new Set(['toolHullMissing', 'armHullMissing', 'armLinkMissing']);
const need = Object.values(RULE).filter((r) => !CANNOT_FIRE.has(r));
const missing = need.filter((r) => !fired.has(r));
check(`규칙 ${need.length}종이 모두 표본에 나온다`, missing.length === 0,
  missing.length ? `안 나온 규칙: ${missing.join(' · ')} — 그 규칙은 대조된 적이 없다` : '');

// ── ④ 결함 주입 — 사본을 1mm 흔들면 빨개지나 ──────────────────────────────
const bent = JSON.parse(JSON.stringify(fx.workspace));
for (const b of bent.boxes ?? []) b.marginMm = (b.marginMm ?? 0) + 1;
for (const w of bent.walls ?? []) w.marginMm = (w.marginMm ?? 0) + 1;
const bentDiff = fx.cases.filter(
  (c) => key(judgeWorkspace(c.tcpMm, bent, c.coord, c.jointsDeg, c.coordDefs)) !== key(c.verdicts)).length;
check(`여유 +1mm 를 넣으면 어긋난다 (${bentDiff}건)`, bentDiff > 0,
  bentDiff === 0 ? '아무것도 안 재고 있다 — 표본이 경계를 안 지났다' : '');

const bad = results.filter(([ok]) => !ok);
console.log(bad.length ? `\n${bad.length}개 실패 — ${bad.map(([, n]) => n).join(' · ')}`
  : `\n대조 OK — ${total}/${total} 일치 (규칙 ${need.length}종 전부), 결함 주입에 빨개진다`);
process.exit(bad.length ? 1 : 0);
