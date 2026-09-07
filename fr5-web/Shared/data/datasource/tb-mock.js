// 가짜 tb-bridge — TB-CONTRACT.md 의 상태·명령·기록 모양을 그대로 흉내낸다.
// 브리지가 강제하는 규칙(조종권·모드 전이·워치독·상한)도 여기서 같은 값으로 흉내낸다.
// 화면이 규칙 위반을 미리 겪어봐야 실물로 바꿨을 때 놀라지 않는다.
//
// **FR5 조작 화면의 「터틀봇」 탭이 `?tb=mock` 으로 고른다** (D182 · 2026-09-05) — 옛
// 옛 터틀봇 웹앱의 `datasource/mock.js` 를 그대로 올렸다. 얼굴은 `tb-client.js` 와 같아야
// 한다 (`scripts/check/tb-unit.sh` 가 두 파일의 메서드 집합을 대조한다).

const TICK_MS = 200;
const TELEOP_WATCHDOG_MS = 500;      // TB-CONTRACT §안전 규칙
const LINEAR_CAP = 150;              // |mm/s|
const ANGULAR_CAP = 60;              // |°/s|

// 실험실 모형 12×8m (mm) — mock 이 로봇을 세워 두는 가짜 지형. 화면은 이제 이걸 안 그린다
// (2D 맵 캔버스는 D182 로 퇴역 · 트윈이 실측을 그린다). PATROL 좌표의 배경일 뿐이다.
const MAP_GEOMETRY = {
  widthMm: 12000, heightMm: 8000,
  walls: [
    [0, 0, 12000, 0], [12000, 0, 12000, 8000], [12000, 8000, 0, 8000], [0, 8000, 0, 0],
    [3000, 0, 3000, 2500], [3000, 5500, 3000, 8000],
    [7500, 2500, 12000, 2500], [7500, 0, 7500, 1200],
  ],
  obstacles: [
    { xMm: 1200, yMm: 5600, wMm: 900, hMm: 700 },
    { xMm: 5200, yMm: 3600, wMm: 1100, hMm: 800 },
    { xMm: 8600, yMm: 5200, wMm: 900, hMm: 900 },
  ],
};

const PATROL = [[1500, 1500], [5500, 1500], [6200, 4800], [9800, 4300], [9800, 6800], [4500, 6500]];

const paths = {};                    // 이름 → { name, frame, points[] }

const state = {
  adapter: 'mock',
  mocked: ['mapping', 'maps', 'liveMap', 'rosbag'],   // 계약 §목업 목록 — 브리지와 같은 값
  robots: {
    tb3_1: robotInit(1500, 1500, 0),
    tb3_2: { ...robotInit(9800, 6800, 180), batteryV: 11.3 },   // 경고선(11.5V) 아래 — 배너 경로를 목업에서 본다
  },
};

function robotInit(xMm, yMm, thetaDeg) {
  return {
    connected: true, poseAgeSec: 0.1, mode: 'idle', nav: 'running',
    pose: { xMm, yMm, thetaDeg },
    velocity: { linearMmS: 0, angularDegS: 0 },
    batteryPct: 87, batteryV: 12.4, activeMap: 'lab-0801', activeSlot: null, activeRunId: null, owner: null,
    // 아래는 mock 내부용 (스냅샷에 안 나간다)
    _waypointIdx: 0, _teleopAt: 0, _trail: [],
  };
}

const slots = [
  { name: 'patrol', description: '웨이포인트 6개 순찰 (mock)' },
  { name: 'goto-station', description: '지정 스테이션으로 이동 (mock)' },
  { name: 'square-test', description: '1m 사각 주행 테스트 (mock)' },
];

const maps = [
  { name: 'lab-0801', mapToLab: { xMm: 0, yMm: 0, thetaDeg: 0 }, savedAt: 1785490000 },
];

let runSeq = 0;
const runs = [
  mockRun('tb3_1', 'patrol', 'completed', 522, { travelMm: 18420, source: 'mock' }),
  mockRun('tb3_2', 'goto-station', 'stopped', 196, { travelMm: 6180, source: 'mock' }),
  mockRun('tb3_1', 'square-test', 'estop', 108, { travelMm: 3900, source: 'mock' }),
  mockRun('tb3_2', 'patrol', 'error', 38, { source: 'mock' }),
];
function mockRun(robot, slot, result, durSec, metrics) {
  runSeq += 1;
  // 지금 기준 과거로 깐다 — 절대값을 박으면 시간이 지나 "미래 기록"이 돼 정렬이 뒤집힌다
  const startedAt = Date.now() / 1000 - runSeq * 3600;
  return {
    id: `2026-07-31-${1000 + runSeq}-${robot}-${slot}`,
    robot, mapSlot: 'lab-0801', scriptSlot: slot, params: {}, layoutId: null,
    startedAt, endedAt: startedAt + durSec, result, note: '', metrics, bagPath: runSeq % 2 ? `bags/${robot}-${slot}` : null,
  };
}

// ── 구독 ────────────────────────────────────────────────────────────────────
const stateSubs = new Set();
const logSubs = new Set();
const logBuffer = [];               // 최근 500줄 (TB-CONTRACT §로그)

function log(robot, source, level, line) {
  const entry = { t: Date.now() / 1000, robot, source, level, line };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  logSubs.forEach((cb) => cb(entry));
}

function snapshot() {
  const robots = {};
  for (const [id, r] of Object.entries(state.robots)) {
    const { _waypointIdx, _teleopAt, _trail, ...pub } = r;
    robots[id] = { ...pub, pose: { ...r.pose }, velocity: { ...r.velocity }, trail: _trail.slice() };
  }
  return { t: Date.now() / 1000, adapter: state.adapter, robots };
}

// ── 움직임 시뮬레이션 ───────────────────────────────────────────────────────
function tick() {
  const dt = TICK_MS / 1000;
  for (const [id, r] of Object.entries(state.robots)) {
    const teleopActive = r.velocity.linearMmS !== 0 || r.velocity.angularDegS !== 0;
    if ((r.mode === 'teleop' || (r.mode === 'mapping' && teleopActive))
        && Date.now() - r._teleopAt > TELEOP_WATCHDOG_MS) {
      r.velocity = { linearMmS: 0, angularDegS: 0 };
      if (r.mode === 'teleop') r.mode = 'idle';
      log(id, 'bridge', 'warn', 'teleop watchdog 500ms — 정지');
    }
    if (r.mode === 'slot') steerToWaypoint(id, r);   // mapping 은 수동(조이스틱)으로만 몬다
    // 속도 적분 → pose
    const th = (r.pose.thetaDeg * Math.PI) / 180;
    r.pose.xMm += Math.cos(th) * r.velocity.linearMmS * dt;
    r.pose.yMm += Math.sin(th) * r.velocity.linearMmS * dt;
    r.pose.thetaDeg = (r.pose.thetaDeg + r.velocity.angularDegS * dt + 360) % 360;
    if (r.velocity.linearMmS !== 0) {
      r._trail.push([r.pose.xMm, r.pose.yMm]);
      if (r._trail.length > 400) r._trail.shift();
    }
  }
  const snap = snapshot();
  stateSubs.forEach((cb) => cb(snap));
}
setInterval(tick, TICK_MS);

function steerToWaypoint(id, r) {
  const [wx, wy] = PATROL[r._waypointIdx % PATROL.length];
  const dx = wx - r.pose.xMm, dy = wy - r.pose.yMm;
  const dist = Math.hypot(dx, dy);
  if (dist < 150) {
    r._waypointIdx += 1;
    log(id, 'slot', 'info', `waypoint ${(r._waypointIdx % PATROL.length) + 1}/${PATROL.length} 도착`);
    return;
  }
  const target = (Math.atan2(dy, dx) * 180) / Math.PI;
  let diff = ((target - r.pose.thetaDeg + 540) % 360) - 180;
  r.velocity.angularDegS = Math.max(-ANGULAR_CAP, Math.min(ANGULAR_CAP, diff * 2));
  r.velocity.linearMmS = Math.abs(diff) < 40 ? 140 : 40;
}

function stopMotion(id, r, why) {
  r.velocity = { linearMmS: 0, angularDegS: 0 };
  if (r.activeRunId) endRun(r, why === 'estop' ? 'estop' : 'stopped');
  r.mode = 'idle';
  r.activeSlot = null;
}

function endRun(r, result) {
  const run = runs.find((x) => x.id === r.activeRunId);
  if (run) {
    run.endedAt = Date.now() / 1000;
    run.result = result;
    run.metrics = { ...run.metrics, travelMm: Math.round(r._trail.length * 30), source: 'mock' };
  }
  r.activeRunId = null;
}

// ── 데이터소스 API — http.js 가 같은 모양으로 대체된다 ─────────────────────
export const tbMock = {
  // @face — 아래 메서드 집합이 tb-client.js 와 같아야 한다 (tb-unit.sh)
  adapter: 'mock',
  host: () => 'mock',

  subscribeState(cb) { stateSubs.add(cb); cb(snapshot()); return () => stateSubs.delete(cb); },
  subscribeRefusals() { return () => {}; },   // mock 은 teleop 이 즉시 사유를 돌려준다
  subscribeLogs(cb) { logBuffer.forEach(cb); logSubs.add(cb); return () => logSubs.delete(cb); },

  async getSlots() { return slots.slice(); },

  // 경로 — 브리지와 같은 얼굴 (계약 §경로). mock 은 메모리에만 산다
  async getPaths() {
    return Object.entries(paths).map(([name, d]) => ({ name, points: d.points.length, frame: d.frame }));
  },
  async getPath(name) { return paths[name] ?? null; },
  async putPath(name, doc) { paths[name] = { name, ...doc }; return { ok: true }; },
  async appendHere(name, robot) {
    const r = state.robots[robot];
    if (r.poseAgeSec > 2) return { ok: false, reason: 'pose 가 늙었어요 — 지금 자리로 찍을 수 없어요' };
    const d = (paths[name] ??= { name, frame: 'odom', points: [] });
    d.points.push({ xMm: Math.round(r.pose.xMm), yMm: Math.round(r.pose.yMm),
                    thetaDeg: Math.round(r.pose.thetaDeg), arriveMm: 30, arriveDeg: 10 });
    log(robot, 'bridge', 'info', `경로 ${name}: ${d.points.length}번째 점`);
    return { ok: true, points: d.points.length };
  },
  async popPath(name) {
    const d = paths[name];
    if (!d?.points.length) return { ok: false, reason: '되돌릴 점이 없어요' };
    d.points.pop();
    return { ok: true, points: d.points.length };
  },
  async deletePath(name) { delete paths[name]; return { ok: true }; },
  async getMaps() { return maps.slice(); },
  async getRuns() { return runs.slice().sort((a, b) => b.startedAt - a.startedAt); },
  async getRun(id) { return runs.find((r) => r.id === id) ?? null; },
  async patchRun(id, patch) {
    const run = runs.find((r) => r.id === id);
    if (!run) return { ok: false, reason: '없는 run' };
    if (typeof patch.note === 'string') run.note = patch.note;
    if (patch.metrics) run.metrics = { ...run.metrics, ...patch.metrics };   // 얕은 병합 (계약)
    return { ok: true };
  },
  async getRunPath(id) {
    // mock: 순찰 모양을 1Hz 샘플처럼 흉내낸다
    return PATROL.map(([xMm, yMm], i) => ({ tSec: i * 8, xMm, yMm, thetaDeg: 0 }));
  },

  async claimOwner(robot, who) {
    const r = state.robots[robot];
    if (r.owner && r.owner !== who) return { ok: false, reason: `조종권은 ${r.owner} 에게 있어요 (409)` };
    r.owner = who;
    log(robot, 'bridge', 'info', `owner claim — who=${who}`);
    return { ok: true };
  },
  async releaseOwner(robot, who) {
    const r = state.robots[robot];
    if (r.owner !== who) return { ok: false, reason: 'owner 불일치 (409)' };
    r.owner = null;
    log(robot, 'bridge', 'info', `owner release — who=${who}`);
    return { ok: true };
  },

  async startSlot(name, robot, who) {
    const r = state.robots[robot];
    if (r.owner !== who) return { ok: false, reason: '조종권이 없어요' };
    if (r.mode !== 'idle') return { ok: false, reason: `mode=${r.mode} — 시작은 idle 에서만 (TB-CONTRACT §모드 전이)` };
    runSeq += 1;
    const run = {
      id: `${new Date().toISOString().slice(0, 10)}-${1000 + runSeq}-${robot}-${name}`,
      robot, mapSlot: r.activeMap, scriptSlot: name, params: {}, layoutId: null,
      startedAt: Date.now() / 1000, endedAt: null, result: null, note: '', metrics: {}, bagPath: null,
    };
    runs.push(run);
    Object.assign(r, { mode: 'slot', activeSlot: name, activeRunId: run.id, _waypointIdx: 0, _trail: [] });
    log(robot, 'slot', 'info', `${name}: 시작 (runId=${run.id})`);
    return { ok: true, runId: run.id };
  },
  async stopRobot(robot) {
    const r = state.robots[robot];
    log(robot, 'bridge', 'info', 'stop — SIGTERM, cmd_vel 0');
    stopMotion(robot, r, 'stop');
    return { ok: true };
  },
  async estop(robot) {
    const targets = robot ? [robot] : Object.keys(state.robots);
    targets.forEach((id) => {
      log(id, 'bridge', 'warn', 'E-STOP — 즉시 정지 + 슬롯 종료 (owner 유지)');
      stopMotion(id, state.robots[id], 'estop');
    });
    return { ok: true };
  },

  /** STOP 하나가 둘 다 세운다 — 로봇 전부에 estop (tb-client.js 와 같은 얼굴) */
  async estopAll() {
    const ids = Object.keys(state.robots);
    for (const id of ids) await this.estop(id);
    return { ok: true, robots: 'all' };
  },
  teleop(robot, linearMmS, angularDegS, who) {
    const r = state.robots[robot];
    if (r.owner !== who) return { ok: false, reason: '조종권이 없어요' };
    if (r.mode !== 'idle' && r.mode !== 'teleop' && r.mode !== 'mapping')
      return { ok: false, reason: `mode=${r.mode} — teleop 거부` };
    if (!Number.isFinite(linearMmS) || !Number.isFinite(angularDegS)) return { ok: false, reason: '값이 숫자가 아니에요' };
    if (Math.abs(linearMmS) > LINEAR_CAP || Math.abs(angularDegS) > ANGULAR_CAP)
      return { ok: false, reason: `상한 초과 (|${LINEAR_CAP}|mm/s · |${ANGULAR_CAP}|°/s) — 거부` };
    if (r.mode === 'idle') r.mode = 'teleop';
    r._teleopAt = Date.now();
    r.velocity = { linearMmS, angularDegS };
    return { ok: true };
  },

  async resetOdom(robot, who) {
    const r = state.robots[robot];
    if (r.owner !== who) return { ok: false, reason: '조종권이 없어요' };
    if (r.mode !== 'idle') return { ok: false, reason: `mode=${r.mode} — 달리는 중에는 좌표계를 못 바꿔요` };
    r.pose = { xMm: 0, yMm: 0, thetaDeg: 0 };
    log(robot, 'bridge', 'info', '원점 재설정 — 지금 자세가 (0,0,0)');
    return { ok: true };
  },

  liveMapUrl() { return null; },   // mock 은 브리지가 없다 — 화면이 벡터 맵으로 폴백

  async activateMap(name, robot) {
    const r = state.robots[robot];
    if (!maps.some((m) => m.name === name)) return { ok: false, reason: '없는 맵' };
    r.nav = 'starting';
    r.activeMap = name;
    setTimeout(() => { r.nav = 'running'; log(robot, 'nav', 'info', `map activate — ${name}`); }, 800);
    return { ok: true };
  },
  async recordStart(robot) {
    const r = state.robots[robot];
    if (!r.activeRunId) return { ok: false, reason: '진행 중인 run 이 없어요' };
    const run = runs.find((x) => x.id === r.activeRunId);
    run.bagPath = `bags/${run.id}`;
    log(robot, 'bridge', 'info', `rosbag record → ${run.bagPath}`);
    return { ok: true };
  },
  async recordStop(robot) {
    log(robot, 'bridge', 'info', 'rosbag stop');
    return { ok: true };
  },

  async startMapping(robot, who) {
    const r = state.robots[robot];
    if (r.owner !== who) return { ok: false, reason: '조종권이 없어요' };
    if (r.mode !== 'idle') return { ok: false, reason: `mode=${r.mode} — 시작은 idle 에서만` };
    Object.assign(r, { mode: 'mapping', nav: 'starting', _waypointIdx: 0, _trail: [] });
    setTimeout(() => { r.nav = 'running'; log(robot, 'nav', 'info', 'slam_toolbox 기동'); }, 800);
    log(robot, 'bridge', 'info', 'mapping start');
    return { ok: true };
  },
  async saveMap(robot, name) {
    if (!/^[a-z0-9-_]+$/.test(name)) return { ok: false, reason: '이름은 [a-z0-9-_] 만 (TB-CONTRACT §단위와 좌표)' };
    const r = state.robots[robot];
    maps.push({ name, mapToLab: { xMm: 0, yMm: 0, thetaDeg: 0 }, savedAt: Date.now() / 1000 });
    r.activeMap = name;
    stopMotion(robot, r, 'stop');
    log(robot, 'bridge', 'info', `map saved — ${name}`);
    return { ok: true };
  },
  async stopMapping(robot) {
    stopMotion(robot, state.robots[robot], 'stop');
    log(robot, 'bridge', 'info', 'mapping stop (저장 없음)');
    return { ok: true };
  },
};
