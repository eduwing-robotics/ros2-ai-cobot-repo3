// 실기에서 **시뮬 입력을 굽는다** — 승인된 슬롯 · 좌표계 정의 · 손끝 대조 표본.
//
//     node scripts/dev/sim-fixture.mjs                    # 기본 호스트
//     node scripts/dev/sim-fixture.mjs --host 192.168.30.240:5055
//
// **왜 Sim 이 직접 안 가져오나** — `Sim/` 은 브리지 주소를 모른다 (SIM-CONTRACT 불변식 1).
// 그래서 `scripts/` 가 실기에 묻고 파일로 건네고, 시뮬은 그 파일만 읽는다.
// `sim-parity-poses.py` 가 판정을 굽는 것과 같은 모양이다.
//
// ⚠ **로봇이 붙어 있어야 돈다. 사람이 부른다** — 게이트가 아니다. 산출물은 커밋한다
//    (얼린 입력이라야 게이트가 로봇 없이 돈다).
//
// ⚠ **`coordDefs` 를 왜 얼리나** — `config.yaml` 의 상자·벽은 `user1` 좌표계 값이고 무조코는
//    베이스를 준다. 2026-08-11 실측: 이 변환을 빼면 손끝이 **725.7mm** 어긋난다. 로봇 쪽에서
//    툴/유저를 다시 잡는 날 이 파일이 낡으므로, 스탬프를 보고 다시 굽는다.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const HOST = argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : '192.168.30.240:5055';
const die = (m) => { console.error(`sim-fixture: ${m}`); process.exit(1); };

const get = async (path) => {
  const r = await fetch(`http://${HOST}${path}`, { signal: AbortSignal.timeout(8000) })
    .catch((e) => die(`${path} — ${e.message} (로봇·브리지가 떠 있나)`));
  if (!r.ok) die(`${path} — HTTP ${r.status}`);
  return r.json();
};

const state = await get('/state');
const slots = await get('/slots');

// **손끝 표본은 여러 자세를 모은다.** 한 자세만 맞으면 「그 자세에서만 맞는 것」과
// 구분이 안 된다. 로봇을 우리가 움직이지 않으므로(하드 룰 3) 사람이 조그하는 동안
// 잡히는 만큼만 모은다 — 정지해 있으면 1개다. 그것도 정직한 결과다.
const seen = new Map();
for (let i = 0; i < 10; i++) {
  const s = i === 0 ? state : await get('/state');
  const key = s.jointsDeg.map((v) => v.toFixed(2)).join();
  if (s.tcpMmDeg) seen.set(key, { jointsDeg: s.jointsDeg, tcpMmDeg: s.tcpMmDeg });
  if (i < 9) await new Promise((r) => setTimeout(r, 2000));
}

const approved = slots.filter((s) => s.status === 'approved' && s.approvedWith);
if (!approved.length) die('승인된 슬롯이 0개다 — 시뮬은 승인된 것만 읽는다 (불변식: 방향이 반대다)');

// **승인 당시의 좌표계와 지금 좌표계가 다르면 굽지 않는다.** 다르면 그 슬롯의 지점 좌표는
// 지금 프레임에서 다른 자리를 뜻한다 — 실기 게이트가 거부하는 것과 같은 이유다.
for (const s of approved) {
  const a = s.approvedWith;
  if (a.toolId !== state.coord.toolId || a.userId !== state.coord.userId) {
    die(`슬롯 "${s.name}" 은 tool${a.toolId}/user${a.userId} 로 승인됐는데 지금은 `
      + `tool${state.coord.toolId}/user${state.coord.userId} 다 — 좌표계가 갈렸다`);
  }
}

const fixture = {
  _무엇: '시뮬 입력. 실기에서 구운 것이고 손으로 고치지 않는다 (node scripts/dev/sim-fixture.mjs)',
  robotId: state.robotId,
  fetchedAt: new Date().toISOString(),
  firmware: approved[0].approvedWith.firmware ?? null,
  coord: state.coord,
  coordDefs: {
    tool: state.coordDefs.tool,
    user: state.coordDefs.user,
    _단위: '앞 셋 mm · 뒤 셋 도(°). user 는 베이스 기준 원점이라 p_user = p_base − user[0..2] 다',
  },
  slots: approved.map((s) => ({ name: s.name, steps: s.steps, points: s.approvedWith.points })),
  fkSamples: [...seen.values()],
  _fkSamples: '컨트롤러가 낸 (관절, 손끝) 쌍들. 시뮬 기구학을 대조하는 유일한 실기 근거다',
};

const dir = join(ROOT, 'Sim/fixtures');
mkdirSync(dir, { recursive: true });
const path = join(dir, `${state.robotId}.json`);
writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`픽스처 구움  ${path.replace(`${ROOT}/`, '')}`);
console.log(`  로봇 ${state.robotId} · 펌웨어 ${fixture.firmware} · tool${state.coord.toolId}/user${state.coord.userId}`);
console.log(`  슬롯 ${fixture.slots.length}개 — ${fixture.slots.map((s) => `"${s.name}"(${s.steps.length}칸)`).join(' · ')}`);
console.log(`  손끝 표본 ${fixture.fkSamples.length}개 (서로 다른 자세)`);
