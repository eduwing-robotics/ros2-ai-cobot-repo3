// 수동 검증용 — 전 사이클(매핑→저장→활성→주행→녹화→기록). `bash scripts/dev/tb-dev.sh` 후 실행.
// P3 검증 — **API 로 직접** 돈다 (D182 · 터틀봇 웹앱 퇴역). 매핑 UI 는 없고 계약이 곧 검증 대상이다.
//   node scripts/check/tb-cycle-verify.mjs      (환경 TB_BRIDGE=host:port · 기본 localhost:5056)
import { openBridge, check, report } from './tb-api-harness.mjs';

const HOST = process.env.TB_BRIDGE ?? 'localhost:5056';
const png = async () => new Uint8Array(await (await fetch(`http://${HOST}/api/maps/live.png?robot=tb3_1&raw=${Math.random()}`)).arrayBuffer());
const pngWidth = (u8) => (u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19];   // IHDR width

const b = await openBridge();
try {
  await b.snapWait((s) => s?.adapter === 'mock', 5000);

  // 1. 조종권 + 매핑 시작
  await b.post('/api/owner/claim', { robot: 'tb3_1', who: 'kim' });
  await b.snapWait((s) => s.robots.tb3_1.owner === 'kim', 4000);
  await b.post('/api/mapping/start', { robot: 'tb3_1', who: 'kim' });
  check('mapping 시작', !!(await b.snapWait((s) => s.robots.tb3_1.mode === 'mapping', 5000)));

  // 2. live.png 가 온다 (240px 격자)
  const before = await b.pollUntil(png, (u) => u.length > 8 && pngWidth(u) === 240, 6000);
  check('live.png 수신 (240px 격자)', pngWidth(before) === 240, `${before.length}b`);

  // 3. 매핑 중 teleop 로 몰면 탐색 영역이 자란다 (png 바이트 변화) — 계약 예외: mapping 중 teleop 수락
  b.send({ cmd: 'hello', who: 'kim' });
  const drive = setInterval(() => b.send({ cmd: 'teleop', robot: 'tb3_1', linearMmS: 140, angularDegS: 10 }), 150);
  await b.sleep(3000);
  clearInterval(drive);
  const after = await png();
  check('live.png 성장 (teleop 주행 반영)', Buffer.compare(Buffer.from(before), Buffer.from(after)) !== 0, `${before.length}b → ${after.length}b`);

  // 4. 저장 → 맵 슬롯 등재
  await b.post('/api/mapping/save', { robot: 'tb3_1', name: 'lab-p3' });
  check('맵 저장 로그', !!(await b.logWait((l) => l.line.includes('map saved — lab-p3'), 5000)));
  check('맵 슬롯 lab-p3 등재', (await b.get('/api/maps')).some((m) => m.name === 'lab-p3'));

  // 5. 다른 맵 활성화 → nav 재기동 → activeMap 반영
  await b.post('/api/maps/lab-p3/activate', { robot: 'tb3_1' });
  check('맵 활성화 → activeMap', !!(await b.snapWait((s) => s.robots.tb3_1.activeMap === 'lab-p3', 5000)));
  check('nav 재기동 완료 (starting→running)', !!(await b.snapWait((s) => s.robots.tb3_1.nav === 'running', 5000)));

  // 6. 슬롯 주행 + rosbag 녹화 → bagPath
  await b.post('/api/slots/example_patrol/start', { robot: 'tb3_1', who: 'kim' });
  await b.snapWait((s) => s.robots.tb3_1.mode === 'slot', 4000);
  check('run 진행 중 activeRunId', !!b.snap().robots.tb3_1.activeRunId);
  await b.post('/api/record/start', { robot: 'tb3_1' });
  const bagged = await b.pollUntil(async () => (await b.get('/api/runs'))[0], (r) => !!r?.bagPath, 5000);
  check('run 에 bagPath 기록', !!bagged?.bagPath);

  // 7. 정지 → stopped 마감 → 기록에 맵·bag
  await b.post('/api/robots/tb3_1/stop', {});
  const run = await b.pollUntil(async () => (await b.get('/api/runs'))[0], (r) => r?.result === 'stopped', 10000);
  check('기록 최신 = stopped + 맵 lab-p3 + bag', run?.result === 'stopped' && JSON.stringify(run).includes('lab-p3') && !!run?.bagPath,
    JSON.stringify(run).slice(0, 160));
} finally {
  b.close();
}
report();
