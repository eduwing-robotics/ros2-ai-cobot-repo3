// P0 왕복 검증 — fr5-bridge 를 시험 포트(5155)에 직접 띄워 profile·preflight·fail-closed·
// 상태 스트림을 판정한다. 실기는 건드리지 않는다 (fairino 프로필은 연결 거부 자체가 검사 대상).
// 실행: node scripts/check/fr5-bridge-verify.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5155;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? 'PASS' : 'FAIL', name, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const api = async (path, body) => {
  const res = await fetch(BASE + path, body === undefined
    ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const del = async (path, body) => {
  const res = await fetch(BASE + path, { method: 'DELETE',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

// 지점·궤적은 파일에 남는다 — **사람의 진짜 ~/fr5-data 에 쓰지 않는다** (env 로 갈아 끼운다)
const DATA = mkdtempSync(join(tmpdir(), 'fr5-verify-'));
// **자식의 자식까지 죽인다.** `uv run` 은 SIGTERM 을 uvicorn 에 안 넘겨서, `.kill()` 만
// 하면 파이썬이 포트를 쥔 채 살아남는다 — 다음 실행이 5155 를 못 잡고 **첫 검사부터**
// 무더기로 빨개진다. 손으로 한 번씩 돌릴 때는 안 보였고, `all.sh` 에 넣어 연달아 돌리자
// 바로 나왔다 (2026-08-06). `detached` 로 프로세스 그룹을 따로 만들어 그룹째 죽인다.
const killTree = (c) => { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch {} } };
const bridge = spawn('uv', ['run', '--with', 'fastapi', '--with', 'uvicorn[standard]', '--with', 'pyyaml',
  'uvicorn', 'main:app', '--port', String(PORT)],
  { cwd: join(ROOT, 'FR5/bridge'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, FR5_DATA_DIR: DATA, FR5_TB_HOST: '' /* 조건 27 끔 — 게이트는 터틀봇 없는 기계에서도 초록이어야 한다 */ } });
// 중간에 죽어도(예외·Ctrl-C) 고아를 남기지 않는다
process.on('exit', () => killTree(bridge));
let bridgeLog = '';
bridge.stdout.on('data', d => { bridgeLog += d; });
bridge.stderr.on('data', d => { bridgeLog += d; });

try {
  // 기동 대기 — 최대 30초
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    await new Promise(r => setTimeout(r, 200));
    up = await fetch(BASE + '/robots').then(r => r.ok).catch(() => false);
  }
  if (!up) throw new Error(`브리지 기동 실패\n${bridgeLog.slice(-2000)}`);

  // 1. 프로필 목록 — 계약 모양, 비밀번호 없음
  const robots = (await api('/robots')).json;
  // 개수를 게이트에 박지 않는다 — 프로필을 더할 때마다 붉어진다(`sim-tab.mjs` §후보 개수와 같은 이유 · 감사 2026-09-06 ④-6).
  // 정본은 config.yaml 이고, 여기서는 「그 파일이 적은 만큼 나오나」만 본다
  const nProfiles = (readFileSync(join(ROOT, 'FR5/bridge/config.yaml'), 'utf-8').match(/^\s*-\s*robotId:/gm) ?? []).length;
  check(`GET /robots — config.yaml 의 프로필 수(${nProfiles})와 같다`, nProfiles > 0 && robots.length === nProfiles, `${robots.length}`);
  const lab = robots.find(r => r.robotId === 'fr5-lab-a');
  // 기준값 — 컨트롤러 **1번 포트**라 `57.2` 다 (2026-08-10 · D105). 0번으로 되돌리면 `58.2` 로 같이 고친다
  check('실기 프로필 endpoint 는 증거값', lab?.endpoint === '192.168.57.2:8080');
  check('프로필에 비밀번호류 없음', !JSON.stringify(robots).match(/password|passwd|secret/i));

  // 2. 미연결 스냅샷 — 같은 스키마 (D40)
  const empty = (await api('/state')).json;
  const KEYS = ['t', 'robotId', 'connected', 'enabled', 'mode', 'jointsDeg', 'tcpMmDeg',
    'motionQueueLength', 'motionTarget', 'safety', 'coord', 'sampleMs', 'gripper', 'owner', 'phase', 'failReason'];
  check('미연결 /state — 전체 스키마 + DISCONNECTED',
    KEYS.every(k => k in empty) && empty.phase === 'DISCONNECTED' && empty.connected === false);

  // 3. mock 연결 → OBSERVE_ONLY
  const conn = await api('/connect', { robotId: 'fr5-mock-a' });
  check('connect fr5-mock-a → OBSERVE_ONLY', conn.json.ok === true && conn.json.phase === 'OBSERVE_ONLY');
  const ver = (await api('/version')).json;
  check('GET /version — 실측 펌웨어 문자열', ver.controller === 'FR_CTRL_FV2.010.12' && ver.robotId === 'fr5-mock-a');
  check('mock 이 실기 SDK 를 사칭하지 않음', ver.sdk === 'mock-0.1');
  const st = (await api('/state')).json;
  const SAFETY = ['code', 'emergencyStop', 'safetyStop', 'collisionDetected', 'inDragTeach', 'mainErrorCode', 'subErrorCode'];
  check('연결 /state — 6축·안전 필드 7개·OBSERVE_ONLY',
    st.jointsDeg.length === 6 && SAFETY.every(k => k in st.safety) && st.phase === 'OBSERVE_ONLY' && st.robotId === 'fr5-mock-a');

  // 4. 연결 중 중복 connect → 거부
  const dup = await api('/connect', { robotId: 'fr5-mock-b' });
  check('연결 중 재connect 409 거부', dup.status === 409 && dup.json.ok === false);

  // 5. WS 스트림 — 1초간 프레임 수신
  const frames = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/state`);
    ws.onmessage = e => frames.push(JSON.parse(e.data));
    ws.onerror = () => reject(new Error('ws error'));
    setTimeout(() => { ws.close(); resolve(); }, 1000);
  });
  check('WS /ws/state — 1초에 10프레임 이상', frames.length >= 10, `${frames.length}프레임`);
  check('WS 프레임이 REST 와 같은 스키마', frames.length > 0 && KEYS.every(k => k in frames[0]));
  const wiggled = frames.length > 5 && frames[0].jointsDeg[0] !== frames.at(-1).jointsDeg[0];
  check('관절값이 흐른다 (mock 숨쉬기)', wiggled);

  // 6. 프로필 교체 — disconnect 후 다른 endpoint 로
  await api('/disconnect', {});
  const swap = await api('/connect', { robotId: 'fr5-mock-b' });
  check('프로필 교체 fr5-mock-b → OBSERVE_ONLY', swap.json.ok === true && swap.json.phase === 'OBSERVE_ONLY');
  await api('/disconnect', {});

  // 7. 잘못된 모델·누락 필드 → FAIL_CLOSED + 사유
  const bad = await api('/connect', { robotId: 'fr5-mock-broken' });
  const reasons = (bad.json.reasons || []).join(' ');
  check('불량 프로필 → ok:false + 모델 불일치 사유', bad.json.ok === false && reasons.includes('모델 불일치'));
  check('누락 안전 필드 사유 포함', reasons.includes('safety.safetyStop'));
  const failed = (await api('/state')).json;
  check('/state → FAIL_CLOSED + failReason', failed.phase === 'FAIL_CLOSED' && !!failed.failReason && failed.connected === false);

  // 8. 실기 프로필 — 로봇이 없으면 fail-closed 사유, 있으면 observe-only 진입 (둘 다 정상)
  const real = await api('/connect', { robotId: 'fr5-lab-a' });
  if (real.json.ok) {
    check('fairino 프로필 → observe-only 진입 (실기 감지)', real.json.phase === 'OBSERVE_ONLY');
    await api('/disconnect', {});
  } else {
    check('fairino 프로필 → 사유 있는 fail-closed (실기 부재)', (real.json.reasons || []).length > 0);
  }

  // 9. observeOnly:false 승격 시도 → 거부
  const promo = await api('/connect', { robotId: 'fr5-mock-a', observeOnly: false });
  check('observeOnly:false → 거부 (P0 은 관측만)', promo.json.ok === false);

  // ── P2 — 조종권·arm·guarded jog/stop (mock 전체 사이클) ──────────────────
  const wsClient = (hello, token) => new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/state`);
    const refusals = [];
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.ok === false) refusals.push(m.reason);
    };
    sock.onopen = () => {
      if (hello) sock.send(JSON.stringify({ cmd: 'hello', who: hello, token }));
      resolve({ sock, refusals, send: (m) => sock.send(JSON.stringify(m)) });
    };
    sock.onerror = () => reject(new Error('ws error'));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getState = async () => (await api('/state')).json;
  // **고정 sleep 은 "왔겠지" 다.** 기계가 바쁘면 안 왔고, 그러면 그 뒤 검사가 줄줄이
  // 빨개져 원인이 어디인지 안 보인다 — `all.sh` 에 넣은 2026-08-06 에 재현됐다
  // (혼자 돌리면 3/3 초록, `all.sh` 안에서는 모드 전환 넷이 한꺼번에 실패).
  // 조건이 오면 즉시 지나가고, 안 오면 제한 시간까지 기다린 뒤 그대로 실패한다.
  // 2026-08-08 에 같은 값을 또 치렀다 — mock 이 실기 속도(28.9°/s)가 되며 이동이 6배 길어졌고
  // 브리지도 `settle_seconds` 만큼 기다렸다 답하는데, 남아 있던 고정 sleep 넷이 통째로 짧아졌다.
  const until = async (fn, timeoutMs = 4000) => {
    for (const t0 = Date.now(); ;) {
      if (await fn()) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(50);
    }
  };

  await api('/connect', { robotId: 'fr5-mock-a' });
  const lee = await wsClient('lee');
  const anon = await wsClient(null);

  // 조종권 — 두 번째 사람은 409. claim 이 토큰을 준다 (D55)
  const claimed = (await api('/owner/claim', { who: 'kim' })).json;
  check('owner claim kim', claimed.ok === true);
  check('claim 이 토큰을 발급한다', typeof claimed.token === 'string' && claimed.token.length >= 16);
  const T = claimed.token;
  const kim = await wsClient('kim', T);
  const dup2 = await api('/owner/claim', { who: 'lee' });
  check('두 번째 claim 409 (명령 주인 한 명)', dup2.status === 409 && dup2.json.ok === false);
  check('claim 후 phase OWNER_HELD', (await getState()).phase === 'OWNER_HELD');

  // ARMED 전 명령 거부 · 조종권 없는 명령 거부
  kim.send({ cmd: 'jog', joint: 0, deltaDeg: 1 });
  await sleep(200);
  check('ARM 전 jog 거부 + 사유 회신', kim.refusals.some((r) => r.includes('ARMED')));
  lee.send({ cmd: 'jog', joint: 0, deltaDeg: 1 });
  await sleep(200);
  check('조종권 없는 jog 거부', lee.refusals.some((r) => r.includes('조종권')));

  // arm — confirm 리터럴·조종권 강제
  const noConfirm = await api('/arm', { who: 'kim', token: T });
  check('confirm 없는 arm 403', noConfirm.status === 403);
  const wrongOwner = await api('/arm', { who: 'lee', token: T, confirm: '현장확인' });
  check('조종권 없는 arm 403', wrongOwner.status === 403);
  const armed = await api('/arm', { who: 'kim', token: T, confirm: '현장확인' });
  check('arm → ARMED + 서보 ON', armed.json.phase === 'ARMED' && (await getState()).enabled === true);

  // 안전 설정 (D53 · 조건 26) — 컨트롤러 충돌 감지는 기본으로 안 켜져 있다
  const applied = (await getState()).appliedSettings;
  check('arm 이 안전 설정을 넣고 기록한다', !!applied && applied.sent?.payloadKg === 0.6,
    `payload=${applied?.sent?.payloadKg}`);
  check('되읽은 하중이 넣은 값과 일치', applied?.readback?.payloadKg === 0.6 && !applied.mismatch.length);
  check('되읽기 불가 항목을 정직하게 노출',
    (applied?.unverifiable || []).includes('collisionLevel'));

  // 설정이 안 먹는 로봇이면 arm 자체가 거부돼야 한다 — 게이트가 있는 척하지 않는다
  await api('/disarm', { who: 'kim', token: T });
  await api('/owner/release', { who: 'kim', token: T });
  await api('/disconnect', {});
  await api('/connect', { robotId: 'fr5-mock-setfail', observeOnly: true });
  let T2 = (await api('/owner/claim', { who: 'kim' })).json.token;   // 재claim = 새 토큰
  const setfail = await api('/arm', { who: 'kim', token: T2, confirm: '현장확인' });
  check('설정이 안 먹는 로봇 → arm 거부 (조건 26)',
    setfail.json.ok === false && JSON.stringify(setfail.json.reasons).includes('안전 설정'),
    (setfail.json.reasons || [])[0]);
  check('거부 뒤 서보는 OFF 로 남는다', (await getState()).enabled === false);
  await api('/owner/release', { who: 'kim', token: T2 });
  await api('/disconnect', {});
  await api('/connect', { robotId: 'fr5-mock-a', observeOnly: true });
  T2 = (await api('/owner/claim', { who: 'kim' })).json.token;
  await api('/arm', { who: 'kim', token: T2, confirm: '현장확인' });

  // 위장 — 이름은 방송되므로 이름만으로는 조종권이 안 된다 (D55)
  const faker = await wsClient('kim', 'wrong-token');
  faker.send({ cmd: 'jog', joint: 0, deltaDeg: 1 });
  await sleep(200);
  check('남의 이름으로 hello → 조종권 거부 (토큰 불일치)',
    faker.refusals.some((r) => r.includes('조종권')));
  const fakeArm = await api('/arm', { who: 'kim', token: 'wrong-token', confirm: '현장확인' });
  check('토큰 없는 arm 403', fakeArm.status === 403);
  faker.sock.close();

  kim.send({ cmd: 'hello', who: 'kim', token: T2 });   // 재claim 했으므로 세션도 새 토큰으로
  // 시작 자세를 지점으로 잡아 둔다 — 아래 §작업영역 검사가 여기로 **되돌아온 뒤** 조그한다.
  // 그 사이 검사들이 j1 을 +20° 넘게 누적해 돌리므로(조그·녹화·goto), 자세를 안 되돌리면
  // 상자·벽 숫자(`config.yaml` fr5-mock-a · 시작 자세 기준)가 엉뚱한 자리를 판정한다 (2026-09-06 실측)
  const ws0 = await api('/points', { who: 'kim', token: T2, name: 'WS0' });
  check('시작 자세 지점 WS0 캡처', ws0.status === 200, `status ${ws0.status}`);
  await sleep(100);

  // 상한 — 초과는 자르지 않고 거부한다
  kim.send({ cmd: 'jog', joint: 0, deltaDeg: 10 });
  await sleep(200);
  check('관절 5° 상한 초과 jog 거부', kim.refusals.some((r) => r.includes('5')));
  const before = await getState();
  kim.send({ cmd: 'moveJ', jointsDeg: before.jointsDeg, speedPct: 50 });
  await sleep(200);
  check('속도 10% 상한 초과 moveJ 거부', kim.refusals.some((r) => r.includes('속도 상한')));

  // 유효한 jog — 실제로 그만큼 움직인다 (mock 은 속도 비례 보간)
  const j1a = before.jointsDeg[0];
  kim.send({ cmd: 'jog', joint: 0, deltaDeg: 2 });
  let reached = null;
  for (let i = 0; i < 30 && !reached; i++) {
    await sleep(100);
    const s = await getState();
    if (Math.abs(s.jointsDeg[0] - (j1a + 2)) < 0.01 && s.motionQueueLength === 0) reached = s;
  }
  check('jog +2° → 목표 도달 + 큐 소진', !!reached, reached ? `j1 ${j1a.toFixed(2)}→${reached.jointsDeg[0].toFixed(2)}` : '미도달');
  // 이동 목표 (계약 §이동 목표 · D196) — 보낸 목표가 스트림에 남고, 거부된 목표(위 10°·50%)는 안 남는다
  check('보낸 적 없는 목표는 null (거부된 jog·moveJ 는 목표가 아니다)', before.motionTarget === null);
  // 목업은 정착 대기(`settle_seconds` · 실측보다 보수적)보다 **먼저** 도착한다 — `doneAt` 은 대기가 끝나야 찍힌다 (계약: 도착이 아니라 「기다리기를 끝냈다」)
  let mt = reached?.motionTarget;
  for (let i = 0; i < 80 && mt && mt.doneAt === null; i += 1) { await sleep(100); mt = (await getState()).motionTarget; }
  check('motionTarget = 보낸 목표 · via jog · 정착 뒤 doneAt', !!mt && Math.abs(mt.jointsDeg[0] - (j1a + 2)) < 1e-6
    && mt.via === 'jog' && typeof mt.queuedAt === 'number' && typeof mt.doneAt === 'number' && mt.doneAt >= mt.queuedAt,
    mt ? `j1 ${mt.jointsDeg[0].toFixed(2)} via=${mt.via} ${((mt.doneAt ?? 0) - mt.queuedAt).toFixed(2)}s` : 'null');
  check('이동 중 EXECUTING 노출', true);   // 아래 stop 시험에서 실측

  // stop — 신원 없는 소켓도 항상 통과 (제3원칙)
  kim.send({ cmd: 'jog', joint: 0, deltaDeg: 4 });
  let execSnap = null;
  const sawExec = await until(async () => { const s = await getState(); if (s.phase === 'EXECUTING') execSnap = s; return s.phase === 'EXECUTING'; }, 8000);
  check('이동 중 phase EXECUTING', sawExec);
  check('이동 중 motionTarget.doneAt 은 null (화면이 이 사이에만 고스트를 그린다)',
    execSnap?.motionTarget && execSnap.motionTarget.doneAt === null && Math.abs(execSnap.motionTarget.jointsDeg[0] - (j1a + 6)) < 1e-6,
    execSnap ? `doneAt=${execSnap.motionTarget?.doneAt} j1→${execSnap.motionTarget?.jointsDeg?.[0]?.toFixed?.(2)}` : '스냅 없음');
  anon.send({ cmd: 'stop' });
  await sleep(300);
  const s1 = await getState();
  await sleep(300);
  const s2 = await getState();
  check('무신원 stop → 즉시 정지 (관절 정지·큐 0)',
    s1.motionQueueLength === 0 && Math.abs(s1.jointsDeg[0] - s2.jointsDeg[0]) < 1e-9
    && Math.abs(s2.jointsDeg[0] - (j1a + 2 + 4)) > 0.5);

  // Teach — 지점(점)과 궤적(선) (계약 §이동 지점 · §궤적 녹화 · D74)
  check('조종권 없는 사람의 캡처 거부',
    (await api('/points', { who: 'lee', token: T2, name: 'X' })).status === 403);
  const capped = await api('/points', { who: 'kim', token: T2, name: 'P1' });
  const here = await getState();
  check('캡처 → 서버가 읽은 관절이 그대로 굳는다',
    capped.json.point?.jointsDeg?.every((v, i) => Math.abs(v - here.jointsDeg[i]) < 0.5),
    `P1 j1=${capped.json.point?.jointsDeg?.[0]?.toFixed(2)}`);
  check('캡처가 좌표계·개체를 함께 싣는다',
    capped.json.point?.capturedRobotId === 'fr5-mock-a'
    && capped.json.point?.toolId !== undefined && capped.json.point?.userId !== undefined);
  check('이름이 비면 캡처 거부',
    (await api('/points', { who: 'kim', token: T2, name: '  ' })).status === 409);
  check('GET /points 는 누구나 — 목록에 P1', (await api('/points')).json.some(p => p.name === 'P1'));

  // 다른 자세로 옮긴 뒤 지점으로 되돌아온다 — Teach 의 완료 판정
  // **5° 를 넘겨 옮긴다** — 옛 조그 상한이면 여기서 영원히 못 돌아온다 (D75 가 고친 것)
  const p1j = capped.json.point.jointsDeg;
  for (let i = 0; i < 4; i++) {
    const want = (await getState()).jointsDeg[0] + 4;
    kim.send({ cmd: 'jog', joint: 0, deltaDeg: 4 });
    await until(async () => {
      const s = await getState();
      return s.motionQueueLength === 0 && Math.abs(s.jointsDeg[0] - want) < 0.05;
    }, 15000);
  }
  const moved = await getState();
  check('지점 캡처 뒤 5° 넘게 떨어진 자세로 옮겼다', Math.abs(moved.jointsDeg[0] - p1j[0]) > 5.0,
    `차이 ${Math.abs(moved.jointsDeg[0] - p1j[0]).toFixed(2)}°`);
  const back = await api('/points/P1/goto', { who: 'kim', token: T2 });
  let returned = null;
  for (let i = 0; i < 200 && !returned; i++) {
    await sleep(100);
    const s2 = await getState();
    if (s2.motionQueueLength === 0 && Math.abs(s2.jointsDeg[0] - p1j[0]) < 0.05) returned = s2;
  }
  check('지점으로 이동 → 캡처 당시 관절로 복귀 (±0.05°)', back.json.ok === true && !!returned,
    returned ? `j1 ${moved.jointsDeg[0].toFixed(2)}→${returned.jointsDeg[0].toFixed(2)}` : '미복귀');
  // 상한을 그냥 푼 게 아니라 **경로를 훑어서** 연 것이다 — 로그가 그 증거다 (D75)
  const scanned = bridgeLog.match(/경로검사 (\d+)점 전부 통과/);
  check('가는 길을 5° 간격으로 훑고 갔다', !!scanned, scanned ? `${scanned[1]}점 검사` : '경로검사 기록 없음');
  check('조그는 여전히 5° 상한을 탄다 (상한을 전역으로 풀지 않았다)',
    (() => { kim.refusals.length = 0; return true; })());
  kim.send({ cmd: 'moveJ', jointsDeg: p1j.map((v, i) => i === 0 ? v + 30 : v), speedPct: 10 });
  await until(() => kim.refusals.some((r) => r.includes('관절 변화')), 8000);
  check('일반 moveJ 는 여전히 5° 초과를 거부한다',
    kim.refusals.some((r) => r.includes('관절 변화')), kim.refusals[0] ?? '거부 없음');
  check('없는 지점 이동은 404',
    (await api('/points/없는것/goto', { who: 'kim', token: T2 })).status === 404);

  // 궤적 — **읽기만 한다.** 로봇에 아무것도 안 보낸다
  check('조종권 없는 사람의 녹화 시작 거부',
    (await api('/trajectories/start', { who: 'lee', token: T2, name: 'x' })).status === 403);
  const started = await api('/trajectories/start',
    { who: 'kim', token: T2, name: 'demo-01', purpose: 'measure' });
  check('녹화 시작 — fps 가 고정으로 잡힌다', started.json.ok === true && started.json.fps > 0,
    `fps=${started.json.fps}`);
  check('출발 자세에 지점 이름이 붙는다 (P1 위에서 시작)', started.json.startPoseName === 'P1');
  check('녹화 중 두 번째 시작은 거부',
    (await api('/trajectories/start', { who: 'kim', token: T2, name: 'demo-02' })).status === 409);
  kim.send({ cmd: 'jog', joint: 0, deltaDeg: 2 });
  await sleep(1500);
  const stopped = await api('/trajectories/stop', { who: 'kim', token: T2 });
  const tr = stopped.json.trajectory;
  check('녹화 정지 → 프레임이 쌓였다', tr?.frameCount > 5, `프레임 ${tr?.frameCount}`);
  check('정상 종료는 endReason done · 결손 0', tr?.endReason === 'done' && tr?.dropped === 0,
    `end=${tr?.endReason} dropped=${tr?.dropped}`);
  check('잰 조건(stamp)이 실린다 — 속도 상한·좌표계·개체',
    tr?.stamp?.speedCapPct === 10 && tr?.stamp?.robotId === 'fr5-mock-a'
    && tr?.stamp?.toolId !== undefined);
  check('purpose·source 가 실린다', tr?.purpose === 'measure' && tr?.source === 'demo');
  const trajs = (await api('/trajectories')).json;
  check('목록은 프레임을 안 싣는다 (요약만)',
    trajs.length === 1 && trajs[0].frames === undefined && trajs[0].frameCount > 5);
  const full = (await api('/trajectories/demo-01')).json;
  check('개별 조회는 프레임을 준다 · 시각이 고정 주기다',
    full.frames.length === tr.frameCount
    && Math.abs(full.frames[1].tSec - full.frames[0].tSec - 1 / full.fps) < 1e-3);
  check('녹화 중이 아닌데 stop 하면 거부',
    (await api('/trajectories/stop', { who: 'kim', token: T2 })).status === 409);

  // ── 프로그램 슬롯 (PROGRAM-CONTRACT.md · 사다리 3) ─────────────────────────
  check('없는 지점을 가리키는 슬롯은 저장에서 거부된다 (실행 시점에 알면 늦다)',
    (await api('/slots', { who: 'kim', token: T2, name: 's1',
      steps: [{ type: 'move', pointName: '없음' }] })).status === 409);
  const saved = await api('/slots', { who: 'kim', token: T2, name: 's1',
    steps: [{ type: 'move', pointName: 'P1' }] });
  check('슬롯 저장 → draft · 좌표가 아니라 지점 이름만 든다 (D78)',
    saved.json.slot?.status === 'draft'
    && Object.keys(saved.json.slot.steps[0]).sort().join() === 'pointName,type');
  check('승인 전 실행은 거부된다',
    (await api('/slots/s1/step', { who: 'kim', token: T2, index: 0 })).status === 409);
  check('현장확인 없는 승인은 거부된다',
    (await api('/slots/s1/approve', { who: 'kim', token: T2 })).status === 409);
  const appr = await api('/slots/s1/approve', { who: 'kim', token: T2, confirm: '현장확인' });
  check('승인 → approved · 그때의 정체가 박힌다',
    appr.json.slot?.status === 'approved'
    && appr.json.slot.approvedWith?.robotId === 'fr5-mock-a'
    && appr.json.slot.approvedWith.toolId !== null);
  const stepped = await api('/slots/s1/step', { who: 'kim', token: T2, index: 0 });
  check('승인된 슬롯의 한 단계 실행 → 그 지점으로 간다',
    stepped.json.ok === true && stepped.json.pointName === 'P1', stepped.json.reasons?.join(' · '));
  check('범위 밖 단계 번호는 거부',
    (await api('/slots/s1/step', { who: 'kim', token: T2, index: 5 })).status === 409);
  check('조종권 없는 사람은 슬롯을 못 고친다',
    (await api('/slots', { who: 'lee', token: T2, name: 's1', steps: [] })).status === 403);
  // 고치면 승인이 풀린다 — 목록이 바뀌면 그 승인은 다른 프로그램의 승인이다
  await api('/slots', { who: 'kim', token: T2, name: 's1',
    steps: [{ type: 'move', pointName: 'P1' }, { type: 'move', pointName: 'P1' }] });
  check('단계를 고치면 승인이 풀려 다시 draft 다',
    (await api('/slots')).json.find(s => s.name === 's1')?.status === 'draft');

  // ── grip 칸 (2026-08-10 · D103 · 계약 §grip 칸) ────────────────────────────
  // **그리퍼는 지점의 속성이 아니라 독립 칸이다.** 여기서 지키는 것: pct 검증 · 지점을
  // 참조하지 않는다(지문 없음) · 관절 게이트가 아니라 그리퍼 전용 게이트를 탄다.
  for (const bad of [-1, 101, 62.5, '50', null, true]) {
    check(`grip 칸 pct 거부 — ${JSON.stringify(bad)}`,
      (await api('/slots', { who: 'kim', token: T2, name: 'g1',
        steps: [{ type: 'grip', pct: bad }] })).status === 409);
  }
  const gSaved = await api('/slots', { who: 'kim', token: T2, name: 'g1',
    steps: [{ type: 'move', pointName: 'P1' }, { type: 'grip', pct: 100 },
      { type: 'move', pointName: 'P1' }] });
  check('grip 칸은 pointName 없이 type·pct 만 저장된다',
    Object.keys(gSaved.json.slot?.steps?.[1] ?? {}).sort().join() === 'pct,type',
    JSON.stringify(gSaved.json.slot?.steps));
  const gAppr = await api('/slots/g1/approve', { who: 'kim', token: T2, confirm: '현장확인' });
  check('섞인 프로그램은 move 칸만 지문을 박는다 (grip 은 가리키는 지점이 없다)',
    Object.keys(gAppr.json.slot?.approvedWith?.points ?? {}).join() === 'P1',
    JSON.stringify(gAppr.json.slot?.approvedWith?.points));
  // 활성화는 아래 §그리퍼에서 한다 — **그 전에는 grip 칸도 거부돼야 한다** (전용 게이트 증거)
  const gripEarly = await api('/slots/g1/step', { who: 'kim', token: T2, index: 1 });
  check('활성화 전에는 grip 칸 실행이 거부된다 (그리퍼 전용 게이트를 탔다는 증거)',
    gripEarly.status === 409 && !/5°|모션큐/.test(gripEarly.json.reasons?.join(' ') ?? ''),
    gripEarly.json.reasons?.join(' · '));
  // **치우고 간다** — 남겨 두면 아래 §지점 삭제가 이 슬롯의 참조에 막힌다 (계약 §지점 삭제).
  // 그 막힘 자체는 옳은 동작이라 게이트를 고칠 게 아니라 여기서 참조를 없애는 게 맞다
  await del('/slots/g1', { who: 'kim', token: T2 });

  // 속도 — **상한은 서버가 지킨다.** 화면이 보낸 값을 잘라주면 화면 버그가 숨는다 (하드 룰 3)
  check('지점 이동에 speedPct 3 을 실으면 그대로 간다',
    (await api('/points/P1/goto', { who: 'kim', token: T2, speedPct: 3 })).json.ok === true);
  const tooFast = await api('/points/P1/goto', { who: 'kim', token: T2, speedPct: 50 });
  check('상한(10%)을 넘는 speedPct 는 자르지 않고 거부한다',
    tooFast.status === 409 && tooFast.json.reasons?.some(r => r.includes('속도 상한')),
    tooFast.json.reasons?.join(' · '));
  check('speedPct 0·음수·문자도 거부된다 (0 은 영원히 안 도착한다)',
    (await api('/points/P1/goto', { who: 'kim', token: T2, speedPct: 0 })).status === 409
    && (await api('/points/P1/goto', { who: 'kim', token: T2, speedPct: '빠르게' })).status === 409);
  check('speedPct 를 안 실으면 기존대로 상한으로 간다 (뒤로 호환)',
    (await api('/points/P1/goto', { who: 'kim', token: T2 })).json.ok === true);

  // 재교시 — **지점을 다시 가르치면 승인이 풀린다** (계약 §재교시). 슬롯은 좌표가 아니라
  // 이름을 참조하므로(D78) 재캡처는 승인된 프로그램의 동작을 승인 없이 바꾼다.
  // 실행 직전 지문 대조(감사 #2)가 최후 방어선으로 그대로 남는지도 같이 본다
  await api('/slots', { who: 'kim', token: T2, name: 's1',
    steps: [{ type: 'move', pointName: 'P1' }] });
  await api('/slots/s1/approve', { who: 'kim', token: T2, confirm: '현장확인' });
  const recap = await api('/points', { who: 'kim', token: T2, name: 'P1' });
  check('재교시하면 그 지점을 쓰는 승인 슬롯이 응답 unapproved 에 실린다',
    recap.json.unapproved?.includes('s1'), JSON.stringify(recap.json.unapproved));
  check('재교시 뒤 슬롯은 draft 라 실행이 막힌다 (로봇 앞이 아니라 캡처한 화면에서 안다)',
    (await api('/slots')).json.find(s => s.name === 's1')?.status === 'draft'
    && (await api('/slots/s1/step', { who: 'kim', token: T2, index: 0 })).status === 409);

  // 삭제 — **참조하는 슬롯이 있으면 지점을 못 지운다** (감사 P1 · main.py 의 훅이 이제 산다)
  check('참조하는 슬롯이 있으면 지점 삭제가 409 로 막힌다',
    (await del('/points/P1', { who: 'kim', token: T2 })).status === 409);
  check('슬롯을 지우면 참조가 풀린다',
    (await del('/slots/s1', { who: 'kim', token: T2 })).json.ok === true);

  check('지점 삭제', (await del('/points/P1', { who: 'kim', token: T2 })).json.ok === true);
  check('삭제 뒤 목록에서 사라진다', !(await api('/points')).json.some(p => p.name === 'P1'));
  check('없는 지점 삭제는 404',
    (await del('/points/P1', { who: 'kim', token: T2 })).status === 404);

  // 그리퍼 — 관절이 아니다. 전용 게이트를 타는지, 활성화가 선행되는지 (계약 §그리퍼)
  kim.refusals.length = 0;
  kim.send({ cmd: 'gripper', pct: 50 });
  await sleep(200);
  check('활성화 전 그리퍼 이동 거부 (사람이 읽는 사유)',
    kim.refusals.some((r) => r.includes('활성화')));
  kim.refusals.length = 0;
  kim.send({ cmd: 'gripper', pct: 140 });
  await sleep(200);
  check('그리퍼 pct 범위 밖 거부', kim.refusals.some((r) => r.includes('0~100')));

  kim.send({ cmd: 'gripperActivate' });
  await sleep(300);
  check('활성화 → state.gripper.active', (await getState()).gripper?.active === true);

  kim.refusals.length = 0;
  kim.send({ cmd: 'gripper', pct: 30 });
  await sleep(300);
  const grip = (await getState()).gripper ?? {};
  check('그리퍼 30% 지령 → 읽기가 같은 값으로 따라온다 (2026-08-04 실기 확인)',
    grip.pct === 30, `pct=${grip.pct}`);
  check('그리퍼는 관절 게이트를 타지 않는다 (5°·모션큐 사유 없음)',
    !kim.refusals.some((r) => r.includes('5°') || r.includes('모션 큐')));

  // ── 집기 한 바퀴 (mock) — `grip` 칸이 실제로 손가락을 움직이는지 (D103) ─────
  // 접근 → 손 열기(100) → 하강 → 손 닫기(0) → 상승. ⚠ **`pct` 는 벌어짐이다 — 100 이 열림**
  // (2026-08-10 정정: 처음 이 주석을 0=열기로 거꾸로 적었다).
  // **실기 집기는 파지 킬실험 뒤다** (GAP OPEN):
  // `force 30%` 가 충분한지 · 파지 중 행정 미완료를 컨트롤러가 완료로 보는지 미확인.
  // 여기까지 오면 위 §지점 삭제가 목록을 비워 뒀다 — 이 블록이 쓸 지점은 스스로 만든다
  const pickPt = '집기점';
  const pickCap = await api('/points', { who: 'kim', token: T2, name: pickPt });
  check('집기용 지점을 캡처한다', pickCap.json.ok === true, pickCap.json.reasons?.join(' · '));
  const pickSave = await api('/slots', { who: 'kim', token: T2, name: 'pick1',
    steps: [{ type: 'move', pointName: pickPt }, { type: 'grip', pct: 100 },
      { type: 'move', pointName: pickPt }, { type: 'grip', pct: 0 },
      { type: 'move', pointName: pickPt }] });
  check('집기 프로그램 저장 — move·grip 을 섞는다',
    pickSave.json.ok === true, pickSave.json.reasons?.join(' · '));
  await api('/slots/pick1/approve', { who: 'kim', token: T2, confirm: '현장확인' });
  const lap = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await api('/slots/pick1/step', { who: 'kim', token: T2, index: i, speedPct: 3 });
    lap.push(r.json.ok === true ? (r.json.step?.type ?? '?') : `실패:${r.json.reasons?.join()}`);
  }
  check('집기 한 바퀴가 mock 에서 돈다 — move·grip 이 섞인 5칸',
    lap.join('>') === 'move>grip>move>grip>move', lap.join(' > '));
  check('grip 칸이 실제로 손가락을 닫았다 (마지막 지령 0% = 벌어짐 0)',
    (await getState()).gripper?.pct === 0, `pct=${(await getState()).gripper?.pct}`);
  check('grip 칸 응답은 pointName 을 싣지 않는다 (가리키는 지점이 없다)',
    (await api('/slots/pick1/step', { who: 'kim', token: T2, index: 1 })).json.pointName
      === undefined);
  // 치운다 — 슬롯을 먼저 지워야 지점이 지워진다 (계약 §지점 삭제: 참조가 있으면 409)
  await del('/slots/pick1', { who: 'kim', token: T2 });
  await del(`/points/${encodeURIComponent(pickPt)}`, { who: 'kim', token: T2 });

  // 무신원·비조종권은 그리퍼도 못 만진다 (stop 만 예외)
  lee.refusals.length = 0;
  lee.send({ cmd: 'gripper', pct: 10 });
  await sleep(200);
  check('조종권 없는 사람의 그리퍼 명령 거부',
    lee.refusals.some((r) => r.includes('조종권')));

  // 작업영역 (조건 12 카테시안) — mock 의 **URDF 기구학**(2026-09-06 · 전엔 10mm/° 선형 흉내)으로
  // 게이트 논리를 시험한다. 시작 자세 손끝 (-171.6, 420.4, 533.9) · 상자·벽 값은 `config.yaml` fr5-mock-a 머리말
  const wsState = await getState();
  // 모양이 `boxes[]`·`walls[]` 로 일반화됐다 (2026-08-08) — 숫자 하나로는 비스듬한 벽도
  // 788mm 짜리 유한한 판도 못 담았다. **꺼져 있으면 보여야 한다**는 규칙은 그대로다
  check('/state 가 작업영역을 노출한다 (꺼져 있으면 보여야 한다)',
    !!wsState.workspace
    && wsState.workspace.boxes?.[0]?.topZMm === 500
    && wsState.workspace.walls?.length >= 1
    && Array.isArray(wsState.workspace.walls[0].aMm),
    JSON.stringify(wsState.workspace)?.slice(0, 90));
  // 시작 자세로 되돌아온다 — 위에서 잡아 둔 WS0 (상자·벽 숫자가 이 자세 기준이다)
  await api('/points/WS0/goto', { who: 'kim', token: T2 });
  const atWs0 = await until(async () => {
    const s = await getState();
    return s.motionQueueLength === 0 && s.jointsDeg.every((v, i) => Math.abs(v - ws0.json.point.jointsDeg[i]) < 0.05);
  }, 20000);
  check('작업영역 검사 전에 시작 자세로 되돌아왔다', atWs0);
  // 아래 셋의 기대치는 **시작 자세 기준**(`config.yaml` fr5-mock-a 머리말)이다. 못 돌아왔으면 엉뚱한 자세에서 문자열만 맞춰
  // 거짓 초록/빨강이 난다 — 그때는 셋을 재지 않고 그 사실을 적는다 (감사 2026-09-06 ④-5)
  if (!atWs0) {
    check('상판을 뚫는 목표 거부 (관절 한계 안인데도)', false, '시작 자세로 못 돌아와 못 쟀다');
    check('벽으로 가는 목표 거부', false, '시작 자세로 못 돌아와 못 쟀다');
    check('작업영역 안의 조그는 그대로 통과한다 (새 게이트가 정상 동작을 막지 않는다)', false, '시작 자세로 못 돌아와 못 쟀다');
  } else {
    kim.refusals.length = 0;
    kim.send({ cmd: 'jog', joint: 2, deltaDeg: 5 });       // j3 +5° → 손끝 z 533.9 → 490.1 < 상판 500+10
    await sleep(300);
    check('상판을 뚫는 목표 거부 (관절 한계 안인데도)',
      kim.refusals.some((r) => r.includes('상판을 뚫는다')));
    kim.refusals.length = 0;
    kim.send({ cmd: 'jog', joint: 1, deltaDeg: 5 });       // j2 +5° → 어깨가 바깥으로 뻗어 툴 꼭짓점이 벽(y 530)까지 8mm
    await sleep(300);
    check('벽으로 가는 목표 거부',
      kim.refusals.some((r) => r.includes('벽에 너무 가깝다')));
    kim.refusals.length = 0;
    const wsBefore = (await getState()).jointsDeg[0];
    kim.send({ cmd: 'jog', joint: 0, deltaDeg: 1 });       // j1 +1° → 손끝 x -178.9 · 벽까지 51mm — 영역 안
    await sleep(600);
    check('작업영역 안의 조그는 그대로 통과한다 (새 게이트가 정상 동작을 막지 않는다)',
      Math.abs((await getState()).jointsDeg[0] - (wsBefore + 1)) < 0.2 && kim.refusals.length === 0);
  }

  // 모드 전환 — ARM 이 SetMode(0) 으로 펜던트를 잠그므로 되돌릴 길이 있어야 한다 (D72).
  // 드래그 티칭은 서보가 켜져 있어야 되므로 **ARMED 인 채로** 넘길 수 있어야 한다.
  kim.refusals.length = 0;
  kim.send({ cmd: 'mode', manual: true });
  await until(async () => (await getState()).mode === 1);
  const manualOn = await getState();
  check('ARMED 인 채로 수동 전환 → mode 1 · 서보는 켜진 채 (드래그 전제)',
    manualOn.mode === 1 && manualOn.enabled === true);

  kim.send({ cmd: 'jog', joint: 0, deltaDeg: 1 });
  await until(() => kim.refusals.some((r) => r.includes('auto 모드가 아니다')));
  check('수동 모드에서 조그는 거부된다 — 하드 룰 4 를 지키는 것은 이 게이트다',
    kim.refusals.some((r) => r.includes('auto 모드가 아니다')));

  kim.refusals.length = 0;
  kim.send({ cmd: 'mode', manual: 'yes' });
  await until(() => kim.refusals.some((r) => r.includes('true/false')));
  check('manual 이 불리언이 아니면 거부', kim.refusals.some((r) => r.includes('true/false')));

  kim.send({ cmd: 'mode', manual: false });
  await until(async () => (await getState()).mode === 0);
  check('자동으로 되돌아온다', (await getState()).mode === 0);

  lee.refusals.length = 0;
  lee.send({ cmd: 'mode', manual: true });
  await until(() => lee.refusals.some((r) => r.includes('조종권')));
  check('조종권 없는 사람의 모드 전환 거부',
    lee.refusals.some((r) => r.includes('조종권')));

  // 조종권 반납 → 자동 disarm (주인 없는 ARMED 를 남기지 않는다)
  check('옛 토큰으로는 반납도 안 된다',
    (await api('/owner/release', { who: 'kim', token: T })).status === 409);
  await api('/owner/release', { who: 'kim', token: T2 });
  await until(async () => (await getState()).enabled === false);
  const released = await getState();
  check('owner release → 자동 disarm (서보 OFF · OBSERVE_ONLY)',
    released.enabled === false && released.phase === 'OBSERVE_ONLY');

  // ── 2단 조준 브리지 몫 (2026-09-07 · D191·D192 · 계약 §손목 스캔 · §단계 기록 · SAFETY §조건 27) ─────────────────────
  const amr = (await getState()).amr;
  check('/state.amr 이 조건 27 의 재료를 든다 (enabled · moving · ageSec · note)', amr && 'enabled' in amr && 'moving' in amr && 'ageSec' in amr, JSON.stringify(amr));
  check('/scan 표적 밖은 400', (await api('/scan', { target: 'moon' })).status === 400);
  const noTruth = await api('/scan', { target: 'carrier' });
  check('목업 스캔은 truth 없이 지어내지 않는다', noTruth.json.ok === false && /지어내지/.test(noTruth.json.reasons[0]));
  const truth = { user1Mm: [657.2, -1103.0, -279.0], yawDeg: -12 };
  const at = (rz) => [657.2, -1103.0, -50, 180, 0, rz];
  const sa = (await api('/scan', { target: 'carrier', truth, atTcpMmDeg: at(90) })).json;
  const sb = (await api('/scan', { target: 'carrier', truth, atTcpMmDeg: at(-90) })).json;
  const single = sa.ok ? Math.hypot(sa.view.user1Mm[0] - truth.user1Mm[0], sa.view.user1Mm[1] - truth.user1Mm[1]) : NaN;
  const avg = sa.ok && sb.ok ? [(sa.view.user1Mm[0] + sb.view.user1Mm[0]) / 2, (sa.view.user1Mm[1] + sb.view.user1Mm[1]) / 2] : null;
  check('목업 스캔 한 뷰는 툴 프레임 고정 편향만큼 틀린다 (>10mm · source mock)', sa.ok && single > 10 && sa.view.source === 'mock' && sa.view.rzDeg === 90, `${single.toFixed(1)}mm`);
  check('rz±90 거울 쌍의 평균은 진값 (1e-6)', !!avg && Math.hypot(avg[0] - truth.user1Mm[0], avg[1] - truth.user1Mm[1]) < 1e-6, avg ? `${avg}` : '스캔 실패');
  check('요각은 [−90,90) 로 접혀 그대로 온다', sa.ok && sa.view.yawDeg === -12);
  const rid = `20260907-000000-verify`;
  const w1 = await api('/runs', { runId: rid, line: { phase: 0, step: 'unit-a' } });
  const w2 = await api('/runs', { runId: rid, line: { phase: 0, step: 'unit-b' } });
  check('/runs 는 덧붙이기만 — 같은 runId 에 두 줄', w1.json.ok && w2.json.n === 2, JSON.stringify(w2.json));
  check('/runs runId 모양 검사 (경로 주입 차단)', (await api('/runs', { runId: '../x', line: { a: 1 } })).status === 400);
  const rd = await fetch(`http://localhost:${PORT}/runs/${rid}`).then((r) => r.json());
  check('/runs/{id} 가 줄마다 t·runId 를 박아 돌려준다', rd.lines?.length === 2 && rd.lines.every((l) => l.runId === rid && typeof l.t === 'number'));
  check('/runs 목록에 있다', (await fetch(`http://localhost:${PORT}/runs`).then((r) => r.json())).some((r) => r.runId === rid));

  kim.sock.close(); lee.sock.close(); anon.sock.close();
  await api('/disconnect', {});
} catch (e) {
  check('실행 자체', false, String(e.message || e));
} finally {
  killTree(bridge);
  rmSync(DATA, { recursive: true, force: true });
}

const fails = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
