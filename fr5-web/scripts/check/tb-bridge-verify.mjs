// 수동 검증용 — tb-bridge(:5056 · mock 어댑터) 필요. `bash scripts/dev/tb-dev.sh` 후 실행.
// 포트 정본은 `TurtleBot/bridge/config.yaml` 이다 — **5055 는 FR5 브리지**다 (D80).
//
// P2 왕복 검증 — **API 로 직접** 브리지 ↔ mock 어댑터 ↔ 진짜 슬롯 프로세스를 돈다.
// D182(2026-09-05) 부터 터틀봇 웹앱이 없다 — 화면 쪽은 `tb-web-verify.mjs`(FR5 「터틀봇」 탭)가 보고,
// 여기는 브라우저 없이 계약(TB-CONTRACT)의 상태·명령·기록·CORS 를 그대로 묻는다.
//   node scripts/check/tb-bridge-verify.mjs      (환경 TB_BRIDGE=host:port · 기본 localhost:5056)
import { openBridge, check, report } from './tb-api-harness.mjs';

const b = await openBridge();
try {
  // 1. 상태 스트림 — adapter 는 상태의 필드가 정본이다 (mock|real)
  const snap = await b.snapWait((s) => s?.adapter === 'mock', 5000);
  check('WS 상태 수신 → adapter:mock (브리지 정본)', snap?.adapter === 'mock');
  check('로봇 2대 (브리지 config 기준)', Object.keys(snap?.robots ?? {}).length === 2);
  check('로그 백로그 수신 (500줄 버퍼)', !!(await b.logWait(() => true, 5000)));

  // 2. 조종권 — REST 왕복
  check('claim → 소유자 kim', (await b.post('/api/owner/claim', { robot: 'tb3_1', who: 'kim' })).ok === true
    && !!(await b.snapWait((s) => s.robots.tb3_1.owner === 'kim', 4000)));

  // 3. 슬롯 시작 — 진짜 파이썬 프로세스 stdout 이 로그로 흐른다
  check('슬롯 start 수락', (await b.post('/api/slots/example_patrol/start', { robot: 'tb3_1', who: 'kim' })).ok === true);
  check('mode=slot', !!(await b.snapWait((s) => s.robots.tb3_1.mode === 'slot', 4000)));
  check('슬롯 stdout → 로그 (patrol 시작)', !!(await b.logWait((l) => l.line.includes('patrol 시작 — robot=tb3_1'), 5000)));
  check('spawn 로그 (pid)', !!(await b.logWait((l) => l.line.includes('pid='), 3000)));
  const p0 = { ...b.snap().robots.tb3_1.pose };
  await b.sleep(2500);
  const p1 = b.snap().robots.tb3_1.pose;
  check('로봇 이동 (mock 어댑터 · pose 변화)', Math.hypot(p1.xMm - p0.xMm, p1.yMm - p0.yMm) > 5, `${Math.hypot(p1.xMm - p0.xMm, p1.yMm - p0.yMm).toFixed(0)}mm`);

  // 4. estop → 프로세스 SIGTERM · idle · run=estop
  b.send({ cmd: 'estop', robot: 'tb3_1' });
  check('estop → idle', !!(await b.snapWait((s) => s.robots.tb3_1.mode === 'idle', 8000)));
  check('슬롯 프로세스 SIGTERM 정리 로그', !!(await b.logWait((l) => l.line.includes('SIGTERM — 정리하고 종료해요'), 8000)));

  // 5. 거부 사유가 WS 응답으로 온다 (계약 §명령)
  b.send({ cmd: 'hello', who: 'kim' });
  b.send({ cmd: 'teleop', robot: 'tb3_2', linearMmS: 100, angularDegS: 0 });
  check('조종권 없는 teleop → 거부 사유', !!(await b.refusalWait((r) => r.includes('조종권'), 4000)));
  b.send({ cmd: 'teleop', robot: 'tb3_1', linearMmS: 999, angularDegS: 0 });
  check('상한 초과 → 거부 사유', !!(await b.refusalWait((r) => r.includes('상한'), 4000)));

  // 6. 매핑 → 저장 → 맵 슬롯 등장 (매핑 UI 는 없다 — API 가 계약이다)
  check('mapping 시작 (202 비동기)', (await b.post('/api/mapping/start', { robot: 'tb3_1', who: 'kim' })).ok === true
    && !!(await b.snapWait((s) => s.robots.tb3_1.mode === 'mapping', 5000)));
  await b.post('/api/mapping/save', { robot: 'tb3_1', name: 'lab-p2' });
  check('맵 저장 로그', !!(await b.logWait((l) => l.line.includes('map saved — lab-p2'), 5000)));
  const maps = await b.get('/api/maps');
  check('맵 슬롯 등재 + mapToLab 메타', maps.some((m) => m.name === 'lab-p2' && m.mapToLab), JSON.stringify(maps).slice(0, 120));

  // 7. 기록 — estop run + 1Hz 경로 + travelMm 자동. 슬롯은 SIGTERM 후 잔여 sleep(≤2s)을 마치고 종료한다
  const run = await b.pollUntil(async () => (await b.get('/api/runs'))[0], (r) => r?.result === 'estop', 10000);
  check('estop run 으로 마감됨 (프로세스 종료 → result 매핑)', run?.result === 'estop');
  check('run.metrics.travelMm 자동 기입', Number.isFinite(run?.metrics?.travelMm), JSON.stringify(run?.metrics));
  const path = run ? await b.get(`/api/runs/${run.id}/path`) : [];
  check('1Hz 경로 샘플 ≥ 2', Array.isArray(path) && path.length >= 2, `${path?.length}점`);

  // 8. CORS 울타리 (계약 §미래 접점 ④ · D182) — 쓰기는 FR5 조작 화면의 출처에서만
  const evil = await b.raw('POST', '/api/owner/release', { robot: 'tb3_1', who: 'kim' }, { Origin: 'http://evil.example:1234' });
  check('낯선 출처의 POST 는 403', evil.status === 403, `status ${evil.status}`);
  const fr5 = await b.raw('POST', '/api/owner/release', { robot: 'tb3_1', who: 'kim' }, { Origin: 'http://192.168.30.240:5055' });
  check('FR5 출처(:5055)의 POST 는 통과', fr5.status === 200, `status ${fr5.status}`);
  const read = await b.raw('GET', '/api/runs', null, { Origin: 'http://evil.example:1234' });
  check('낯선 출처도 GET 은 읽는다', read.status === 200 && read.headers.get('access-control-allow-origin') === '*');
} finally {
  b.close();
}
report();
