// 진짜 tb-bridge 클라이언트 — `tb-mock.js` 와 같은 얼굴 (TB-CONTRACT.md).
//
// **FR5 조작 화면의 「터틀봇」 탭이 쓴다** (D182 · 2026-09-05). 옛 터틀봇 웹앱은 브리지가
// 같은 출처에서 서빙해 주소가 코드에 없었는데, 이제 브리지는 **로봇 파이**(`:5056`)에 있고
// 화면은 FR5 브리지(`:5055`)가 서빙한다 — 그래서 주소를 **밖에서 받는다** (`getHost`).
// 주소는 늦게 올 수 있다(`/config/tb-host.json` 은 비동기) — 그래서 값이 아니라 **함수**다.
//
// 명령(hello·teleop·estop)은 상태 소켓에 같이 싣는다 — 계약 §명령 그대로. 관전만 하는
// `state-stream.js` 와 다른 이유가 그것이다(그쪽은 일부러 명령이 없다).
// 쓰기(`POST`…)는 브리지 CORS 가 FR5 화면 출처에만 연다 (계약 §미래 접점 ④).
const TRAIL_MAX = 400;

/**
 * @param {() => (string|null)} getHost 브리지 `host:port`. `null` 이면 「주소를 모른다」 —
 *   고장이 아니라 안 켠 것이고, 모든 호출이 사유를 돌려준다.
 */
export function createTbClient(getHost) {
  const stateSubs = new Set();
  const logSubs = new Set();
  const refusalSubs = new Set();   // 거부 사유 — 로그 패널을 접어도 조종 칸에 뜬다
  const trails = {};                 // 화면용 궤적은 클라이언트가 쌓는다 — 계약엔 없다
  let stateWs = null;
  let logWs = null;
  let logHost = null;
  let sentWho = null;
  let lastSnapshot = null;
  let wsHost = null;                 // 소켓이 붙은 주소 — 주소가 바뀌면 다시 붙는다

  const scheme = () => (location.protocol === 'https:' ? 'wss' : 'ws');
  const http = () => (location.protocol === 'https:' ? 'https' : 'http');   // REST 도 페이지 스킴을 따른다 — https 페이지에서 http 를 부르면 혼합 콘텐츠로 조용히 죽는다 (감사 2026-09-05)
  const NO_HOST = { ok: false, reason: '터틀봇 브리지 주소를 몰라요 — ?tb=<host:port> 로 알려줘요' };
  const MIXED = { ok: false, reason: 'https 화면에서는 LAN 브리지(http)를 못 부른다 — 브리지 호스트가 낸 http 화면으로 연다' };
  const mixed = (host) => location.protocol === 'https:' && /^(\d{1,3}\.){3}\d{1,3}|localhost|\.local/.test(host);

  function ensureStateWs() {
    const host = getHost();
    if (!host) return false;
    if (stateWs && wsHost === host && stateWs.readyState <= WebSocket.OPEN) return true;
    try { stateWs?.close(); } catch { /* 이미 닫힘 */ }
    wsHost = host;
    stateWs = new WebSocket(`${scheme()}://${host}/ws/state`);
    stateWs.onopen = () => { sentWho = null; };
    stateWs.onmessage = (e) => {
      let snap;
      try { snap = JSON.parse(e.data); } catch { return; }
      if (!snap.robots) {            // 명령 거부 응답 — 조용히 버리지 않고 로그 패널로 흘린다
        if (snap.ok === false) {
          logSubs.forEach((cb) => cb({
            t: Date.now() / 1000, robot: '—', source: 'bridge', level: 'warn', line: snap.reason,
          }));
          refusalSubs.forEach((cb) => cb(snap.reason));
        }
        return;
      }
      for (const [id, r] of Object.entries(snap.robots)) {
        const t = (trails[id] ??= []);
        if (r.velocity?.linearMmS !== 0 || r.velocity?.angularDegS !== 0) {
          t.push([r.pose.xMm, r.pose.yMm]);
          if (t.length > TRAIL_MAX) t.shift();
        }
        r.trail = t;
      }
      lastSnapshot = snap;
      stateSubs.forEach((cb) => cb(snap));
    };
    // 전체 스냅샷이라 재접속이 곧 복구. **끊기면 `null` 을 흘린다** — 안 흘리면 화면이
    // 마지막 자세에 로봇을 계속 세워 둔다 (「멈춘 시계」 · 2026-08-28 감사)
    stateWs.onclose = () => {
      lastSnapshot = null;
      stateSubs.forEach((cb) => cb(null));
      setTimeout(() => { if (stateSubs.size) ensureStateWs(); }, 1000);
    };
    return true;
  }

  function hello(who) {
    if (!who || sentWho === who || stateWs?.readyState !== WebSocket.OPEN) return;
    stateWs.send(JSON.stringify({ cmd: 'hello', who }));
    sentWho = who;
  }

  async function api(method, path, body) {
    const host = getHost();
    if (!host) return NO_HOST;
    if (mixed(host)) return MIXED;
    let res;
    try {
      res = await fetch(`${http()}://${host}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      return { ok: false, reason: `터틀봇 브리지(${host}) 응답 없음 — ${e?.name ?? e}` };
    }
    return res.json().catch(() => ({ ok: res.ok }));
  }
  // 목록을 받는 GET 은 실패해도 **빈 배열**을 돌려준다 — 화면이 `.map` 에서 죽지 않는다
  const list = async (path) => { const r = await api('GET', path); return Array.isArray(r) ? r : []; };

  return {
    // @face — 아래 메서드 집합이 tb-mock.js 와 같아야 한다 (tb-unit.sh)
    adapter: 'real-bridge',          // 실제 표기는 상태의 adapter 필드가 이긴다 (mock|real)
    host: () => getHost(),

    subscribeState(cb) {
      stateSubs.add(cb);
      if (ensureStateWs() && lastSnapshot) cb(lastSnapshot); else cb(null);
      // **주소가 늦게 온다** (`/config/tb-host.json` 은 비동기 · 감사 2026-09-05 P0) — 없으면 1초마다 다시 묻는다.
      // 안 그러면 마운트 때 주소가 없던 화면은 「기다리는 중」에서 영영 못 나온다
      const retry = getHost() ? null : setInterval(() => {
        if (!stateSubs.has(cb)) { clearInterval(retry); return; }
        if (getHost() && ensureStateWs()) clearInterval(retry);
      }, 1000);
      return () => { stateSubs.delete(cb); if (retry) clearInterval(retry); };
    },
    subscribeRefusals(cb) { refusalSubs.add(cb); return () => refusalSubs.delete(cb); },
    subscribeLogs(cb) {
      const open = () => {
        const host = getHost();
        if (!host) return false;
        if (logWs && logHost === host && logWs.readyState <= WebSocket.OPEN) return true;
        try { logWs?.close(); } catch { /* 이미 닫힘 */ }
        logHost = host;   // 주소가 늦게 오거나 바뀌면 로그 소켓도 따라간다 (감사 2026-09-05)
        logWs = new WebSocket(`${scheme()}://${host}/ws/logs`);
        logWs.onmessage = (e) => { try { const l = JSON.parse(e.data); logSubs.forEach((s) => s(l)); } catch { /* 잡음 */ } };
        return true;
      };
      logSubs.add(cb);
      const retry = open() ? null : setInterval(() => { if (!logSubs.has(cb) || open()) clearInterval(retry); }, 1000);
      return () => { logSubs.delete(cb); if (retry) clearInterval(retry); };
    },

    getSlots: () => list('/api/slots'),
    getPaths: () => list('/api/paths'),
    getPath: (name) => api('GET', `/api/paths/${name}`),
    putPath: (name, doc) => api('PUT', `/api/paths/${name}`, doc),
    appendHere: (name, robot) => api('POST', `/api/paths/${name}/append-here`, { robot }),
    popPath: (name) => api('POST', `/api/paths/${name}/pop`, {}),
    deletePath: (name) => api('DELETE', `/api/paths/${name}`),
    getMaps: () => list('/api/maps'),
    getRuns: () => list('/api/runs'),
    getRun: (id) => api('GET', `/api/runs/${id}`),
    getRunPath: (id) => api('GET', `/api/runs/${id}/path`),
    patchRun: (id, patch) => api('PATCH', `/api/runs/${id}`, patch),

    liveMapUrl: (robot) => (getHost() ? `http://${getHost()}/api/maps/live.png?robot=${robot}` : null),
    activateMap: (name, robot) => api('POST', `/api/maps/${name}/activate`, { robot }),
    recordStart: (robot) => api('POST', '/api/record/start', { robot }),
    recordStop: (robot) => api('POST', '/api/record/stop', { robot }),

    claimOwner: (robot, who) => api('POST', '/api/owner/claim', { robot, who }),
    releaseOwner: (robot, who) => api('POST', '/api/owner/release', { robot, who }),
    startSlot: (name, robot, who, params) => api('POST', `/api/slots/${name}/start`, { robot, who, params }),
    stopRobot: (robot) => api('POST', `/api/robots/${robot}/stop`, {}),
    resetOdom: (robot, who) => api('POST', `/api/robots/${robot}/reset-odom`, { who }),
    startMapping: (robot, who) => api('POST', '/api/mapping/start', { robot, who }),
    saveMap: (robot, name) => api('POST', '/api/mapping/save', { robot, name }),
    stopMapping: (robot) => api('POST', '/api/mapping/stop', { robot }),

    teleop(robot, linearMmS, angularDegS, who) {
      if (!ensureStateWs()) return NO_HOST;
      if (stateWs.readyState !== WebSocket.OPEN) return { ok: false, reason: '브리지 연결 대기 중' };
      hello(who);
      stateWs.send(JSON.stringify({ cmd: 'teleop', robot, linearMmS, angularDegS }));
      return { ok: true };           // 거부 사유는 WS 응답 → 로그 패널·조종 칸으로 온다
    },
    async estop(robot) {
      if (!ensureStateWs()) return NO_HOST;
      if (stateWs.readyState === WebSocket.OPEN) {
        stateWs.send(JSON.stringify({ cmd: 'estop', robot }));
        return { ok: true };
      }
      return { ok: false, reason: '브리지 연결이 없어요' };
    },
    /** STOP 하나가 둘 다 세운다 (계약 §미래 접점 ④) — **로봇을 안 고른다.** `robot` 없는 estop 은 브리지가
     *  등재된 로봇 전부에 보낸다(`main.py do_estop`). 스냅샷에 기대면 터틀봇 탭을 한 번도 안 연 세션·WiFi 순단
     *  직후(`lastSnapshot=null`)에 **아무것도 안 보내고 조용히 실패**했다 (감사 2026-09-05 P0). */
    async estopAll() {
      if (!ensureStateWs()) return NO_HOST;
      if (stateWs.readyState !== WebSocket.OPEN) {
        // 소켓이 막 열리는 중이면 열리자마자 보낸다 — 여기서 포기하면 그 순간이 곧 「세워야 하는 순간」이다
        return new Promise((res) => {
          const t = setTimeout(() => res({ ok: false, reason: '브리지 연결 대기 중 — 터틀봇 estop 을 못 보냈어요' }), 3000);
          stateWs.addEventListener('open', () => { clearTimeout(t); stateWs.send(JSON.stringify({ cmd: 'estop' })); res({ ok: true, robots: 'all' }); }, { once: true });
        });
      }
      stateWs.send(JSON.stringify({ cmd: 'estop' }));
      return { ok: true, robots: 'all' };
    },
  };
}
