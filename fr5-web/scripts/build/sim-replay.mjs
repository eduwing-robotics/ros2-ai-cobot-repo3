// 시뮬 배치 한 인스턴스를 **폰 XR 이 읽는 재생 표본**으로 굽는다 → `Shared/assets/sim/replay.json`.
//
// 왜 굽나 — `Sim/out/` 은 gitignore 라 Vercel·브리지가 서빙하는 AR 번들에 없다. 인스턴스 하나(120프레임×6)는
// 6KB 라 자산으로 들고 다닌다. 배치가 바뀌면 다시 굽는다 — 표본에는 batchId·instance·cycleMs 가 남는다.
//   node scripts/build/sim-replay.mjs [batchId] [instance]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const batch = process.argv[2] ?? 'fr5-lab-a-slot1-n4-seed1';
const inst = Number(process.argv[3] ?? 0);
const f = JSON.parse(readFileSync(join(ROOT, 'Sim/out', batch, 'frames.json'), 'utf8'));
const it = f.instances.find((x) => x.i === inst) ?? f.instances[0];
if (!it) throw new Error(`${batch} 에 인스턴스 ${inst} 가 없다`);
const out = {
  _무엇: '폰 XR 시뮬 재생 표본 — scripts/build/sim-replay.mjs 가 굽는다. 직접 고치지 마라',
  _단위: '도(°) · frame→joint 평평한 배열 · 인스턴스 하나',
  batchId: f.batchId, instance: it.i, jointCount: f.jointCount, framesPerInstance: f.framesPerInstance,
  cycleMs: it.cycleMs ?? null, deg: it.deg, madeAt: new Date().toISOString().slice(0, 10),
};
mkdirSync(join(ROOT, 'Shared/assets/sim'), { recursive: true });
writeFileSync(join(ROOT, 'Shared/assets/sim/replay.json'), JSON.stringify(out));
console.log(`replay.json ← ${f.batchId} #${it.i} · ${f.framesPerInstance}프레임 · cycle ${it.cycleMs}ms`);
