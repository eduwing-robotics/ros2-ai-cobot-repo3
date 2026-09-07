// fr5-bridge 클라이언트 (API-CONTRACT.md 가 정본).
// dev 는 vite proxy(계약 경로 → :5055), 운영은 브리지가 같은 출처에서 서빙한다 — 주소가 코드에 없다.
import { subscribeRobotState } from '@fr5/shared/data/datasource/state-stream.js';
import { rememberedHost } from '@fr5/shared/data/datasource/remembered-host.js';
import { AMR_HOME } from '@fr5/shared/data/workcell.js';
import { createTbClient } from '@fr5/shared/data/datasource/tb-client.js';
import { tbMock } from '@fr5/shared/data/datasource/tb-mock.js';

const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const stateSubs = new Set();
const refusalSubs = new Set();     // 명령 거부 사유 — 조용히 버리지 않고 화면으로 흘린다
let ws = null;
let lastSnapshot = null;
let reconnects = -1;               // 첫 접속은 재연결이 아니다
let who = null;
let sentWho = null;
// claim 이 발급한다. 조종권을 증명하는 것은 이름이 아니라 이것 (D55).
// **탭 저장소에 남긴다** — 메모리에만 두면 새로고침 한 번에 자기 조종권에서 잠긴다.
// 화면은 owner 이름만 보고 "내 것"이라 판단하는데 토큰이 없어 반납도 안 됐다 (2026-08-04 실측).
const TOKEN_KEY = 'fr5.ownerToken';
const store = (() => { try { return window.sessionStorage; } catch { return null; } })();
let ownerToken = store?.getItem(TOKEN_KEY) || null;

// ── 글로벌 카메라 주소. **빌드에 박지 않는다** — 폰이 DHCP 라 IP 가 바뀐다
// (2026-08-06 실측: USB 세션의 폰이 WiFi 로 붙으며 `.10` 을 새로 받았다).
// `?cam=192.168.30.10:8080` 를 한 번 주면 기억한다. `?cam=` (빈 값) 이면 잊는다.
// **탭 저장소가 아니라 localStorage 다** — 조종권 토큰과 달리 이건 비밀이 아니고,
// 새로고침마다 주소를 다시 치게 만들 이유가 없다 (`AR/src/screens/cam.js` 와 같은 규약).
const CAM_KEY = 'fr5.camHost';
const camStore = (() => { try { return window.localStorage; } catch { return null; } })();
let camHost = (() => {
  const q = new URLSearchParams(location.search).get('cam');
  if (q === null) return camStore?.getItem(CAM_KEY) || null;
  const v = q.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (v) camStore?.setItem(CAM_KEY, v); else camStore?.removeItem(CAM_KEY);
  return v || null;
})();

// **아무도 안 정했으면 브리지에게 묻는다** (2026-08-10 · 계약 §정적 서빙 `global-cam-host.json`).
// 여태는 사람이 `?cam=` 을 브라우저마다 한 번씩 쳐야 했는데, 폰 IP 가 바뀌면 그게 전부
// 옛 주소로 굳는다 — 실제로 `.10` → `.4` 로 바뀐 뒤 화면이 카메라를 통째로 못 봤다.
// 정합 감시기가 어차피 폰을 찾으므로 **그 결과를 받아 쓴다.** 새 탐색을 여기서 또 만들지 않는다.
//
// **사람이 준 주소를 덮지 않는다** — `?cam=`·localStorage 가 있으면 묻지도 않는다.
// 404 면 `null` 인 채로 둔다 = "주소를 아무도 모른다" 이고, 그건 고장이 아니라 안 켠 것이다.
const camHostSubs = new Set();
if (!camHost) {
  fetch('/config/global-cam-host.json',
    { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const v = j?.host;
      if (!v || camHost) return;   // 그 사이 사람이 정했으면 사람이 이긴다
      camHost = v;
      camHostSubs.forEach((cb) => cb(camHost));
    })
    .catch(() => { /* 못 받으면 null 인 채로 둔다 — 위 주석 */ });
}

// ── 손목 뎁스카메라 관문 주소. **폰과 달리 물어보지 않는다** — 관문은 이 화면을 서빙하는
// 기계에서 같이 돈다(D86 · 우분투 직결). 그래서 **여기서 유도한다**: 지금 보고 있는 호스트 +
// 관문 포트. 폰처럼 사람이 주소를 치게 만들면, 고정된 주소를 매 브라우저마다 다시 치는 꼴이다.
// ⚠ **포트 정본은 `Vision/bridge/config.yaml`** 이다 — 브라우저가 yaml 을 못 읽어 여기 적는다.
// 거기를 바꾸면 여기도 바꾼다 (`?depth=host:port` 로 한 판만 덮어쓸 수 있다).
const DEPTH_PORT = 5058;
const DEPTH_KEY = 'fr5.depthHost';
let depthHost = (() => {
  const q = new URLSearchParams(location.search).get('depth');
  if (q !== null) {
    const v = q.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (v) camStore?.setItem(DEPTH_KEY, v); else camStore?.removeItem(DEPTH_KEY);
    return v || null;
  }
  const saved = camStore?.getItem(DEPTH_KEY);
  if (saved) return saved;
  // dev 서버(5173 등)에서 열면 그 포트에는 관문이 없다 — 그래도 **호스트는 맞으므로**
  // 포트만 갈아 끼운다. 로컬에서 열었으면 관문도 로컬에 있다고 본다
  return location.hostname ? `${location.hostname}:${DEPTH_PORT}` : null;
})();

// ── 터틀봇 브리지 주소. 이 화면이 **터틀봇을 모는 유일한 화면**이다 (`TB-CONTRACT.md`
// §미래 접점 ④ · D182 · 2026-09-05) — 「터틀봇」 탭이 `datasource.tb` 로 조종권·WASD·슬롯을
// 보낸다. 하드룰 4 는 브리지 조종권이 지킨다. `?tb=mock` 이면 목업(`tb-mock.js`)이다.
//
// `?tb=192.168.30.15:5056` 을 한 번 주면 기억한다. `?tb=` (빈 값) 이면 잊는다 —
// `?cam=`·`?depth=` 와 **같은 규약**이다.
//
// ⚠ **`depth` 처럼 포트만 갈아 끼우지 않는다.** 터틀봇 브리지는 **파이 안**에서 돌아
// 이 페이지를 서빙하는 호스트(윈도우·우분투)와 **다른 기계**다 (`우분투` 스킬 §터틀봇은
// 이 스킬이 아니다). 유도하면 없는 주소를 찍고 끝없이 재접속한다.
// 아무도 안 줬으면 `null` = "주소를 모른다" 이고, 그건 고장이 아니라 안 켠 것이다.
// **규약은 공용 모듈이 든다** (2026-08-28) — 대시보드에도 같은 해석기가 한 벌 더 있었고,
// 게이트가 그쪽을 잡았을 때 「같은 `?tb=` 가 화면마다 다르게 동작할 수 있다」가 드러났다.
// 아래 §브리지에게 묻는다 는 여기만의 덧붙임이다(FR5 는 브리지가 이 페이지를 서빙한다).
let tbHost = rememberedHost('tb', 'fr5.tbHost');
// 실물 클라이언트 — 주소를 **매번** 묻는다(늦게 오거나 `?tb=` 로 바뀐다)
const tbClient = createTbClient(() => (tbHost && tbHost !== 'mock' ? tbHost : null));

// **아무도 안 정했으면 브리지에게 묻는다** — `?cam=` 과 **같은 규약**이다 (2026-08-28).
// 여태는 사람이 `?tb=` 를 브라우저마다 한 번씩 쳐야 했고, 안 치면 화면이 터틀봇을
// **반투명(가정)** 으로만 그렸다 — 실제로 윈도우 화면이 그 상태로 하루를 갔다.
// 파이도 DHCP 라 주소가 바뀔 수 있어, 사람이 굳혀 둔 옛 주소가 조용히 틀리는 것도 같은 함정이다.
//
// **사람이 준 주소를 덮지 않는다** — `?tb=`·localStorage 가 있으면 묻지도 않는다.
// 404 면 `null` 인 채로 둔다 = "주소를 아무도 모른다" 이고, 그건 고장이 아니라 안 켠 것이다.
const tbHostSubs = new Set();
if (!tbHost) {
  fetch('/config/tb-host.json', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const v = j?.host;
      if (!v || tbHost) return;      // 그 사이 사람이 정했으면 사람이 이긴다
      tbHost = v;
      tbHostSubs.forEach((cb) => cb(tbHost));
    })
    .catch(() => {});                // 못 물어본 것과 주소가 없는 것은 화면에서 같다
}

function setToken(v) {
  ownerToken = v || null;
  if (ownerToken) store?.setItem(TOKEN_KEY, ownerToken);
  else store?.removeItem(TOKEN_KEY);
}

function ensureWs() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  reconnects += 1;
  ws = new WebSocket(`${WS_BASE}/ws/state`);
  ws.onopen = () => { sentWho = null; sendHello(); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.ok === false) {        // 거부 응답 — 상태 스냅샷이 아니다
      refusalSubs.forEach((cb) => cb(msg.reason ?? '거부됨'));
      return;
    }
    lastSnapshot = msg;
    stateSubs.forEach((cb) => cb(msg));
  };
  // 미연결에도 같은 스키마가 오므로(D40) 끊김 = 브리지 자체가 죽은 것 — 1초 후 재시도
  ws.onclose = () => setTimeout(ensureWs, 1000);
}

function sendHello() {
  // 토큰이 바뀌면(재claim) 다시 보낸다 — 이름만 같고 세션이 다른 경우가 있다
  if (!who || ws?.readyState !== WebSocket.OPEN) return;
  if (sentWho === who + '\u0000' + (ownerToken ?? '')) return;
  ws.send(JSON.stringify({ cmd: 'hello', who, token: ownerToken }));
  sentWho = who + '\u0000' + (ownerToken ?? '');
}

function sendCmd(msg) {
  ensureWs();
  if (ws.readyState !== WebSocket.OPEN) {
    // stop 포함 모든 명령이 재연결 창(끊김→1초 재시도)에 걸릴 수 있다. 반환값만 주면
    // 호출처가 전부 버려서 「stop 은 항상 통과」(제3원칙)가 사람 몰래 깨진다 —
    // 서버 거부와 같은 길(거부 구독)로 흘려 화면이 반드시 말하게 한다 (감사 2026-08-13)
    const reason = '브리지 연결 대기 중 — 명령이 전송되지 않았다';
    refusalSubs.forEach((cb) => cb(reason));
    return { ok: false, reason };
  }
  sendHello();
  ws.send(JSON.stringify(msg));
  return { ok: true };             // 거부 사유는 WS 응답 → subscribeRefusals 로 온다
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // 4xx/5xx 의 JSON 본문({detail:…} 등)엔 `ok` 가 없어, 소비처의 「실패로 명시되지 않으면
  // 성공」 판정(ProgramPanel 커서 전진)을 그대로 통과한다 — 상태코드가 정본이다 (감사 2026-08-13)
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = j?.reason ?? (typeof j?.detail === 'string' ? j.detail : `HTTP ${res.status}`);
    // 본문을 버리지 않는다 — `/connect` 는 `reasons:[…]` 배열로 거부하고 화면(run 헬퍼)이
    // 그 배열을 읽는다. {ok,reason} 둘로 누르면 사유가 「HTTP 400」이 된다 (게이트가 잡았다)
    return { ...(j && typeof j === 'object' ? j : {}), ok: false, reason };
  }
  return j ?? { ok: true };
}

export const datasource = {
  setWho(name) { who = name || null; sendHello(); },
  subscribeState(cb) {
    ensureWs();
    stateSubs.add(cb);
    if (lastSnapshot) cb(lastSnapshot);
    return () => stateSubs.delete(cb);
  },
  /**
   * 터틀봇 자세 관전 — `/ws/state` 스냅샷에서 로봇 하나의 `pose` 만 흘린다.
   *
   * **명령 소켓(`ensureWs`)에 합치지 않는다.** 그건 조종권을 잡고 moveJ 를 보내는 소켓이고,
   * 이건 남의 로봇을 구경만 하는 소켓이다 — 합치면 관전 화면이 명령 능력을 갖는다
   * (`state-stream.js` 머리말이 같은 이유를 적어 뒀다).
   *
   * 주소가 없으면 **구독하지 않고** `null` 을 한 번 흘린 뒤 끝낸다 — 부르는 쪽이
   * 「안 켰다」와 「끊겼다」를 같게 다루면 되도록.
   *
   * @param cb `({ xMm, yMm, thetaDeg } | null)` — 로봇이 없거나 값이 깨졌으면 `null`
   */
  subscribeTbPose(cb) {
    // **주소가 늦게 올 수 있다** — 위 `/config/tb-host.json` 은 비동기다. 그때는 오면 붙는다.
    // 안 그러면 화면이 뜬 순서에 따라 터틀봇이 보이기도 안 보이기도 한다.
    if (!tbHost) {
      let stop = null;
      const onHost = () => { stop = datasource.subscribeTbPose(cb); tbHostSubs.delete(onHost); };
      tbHostSubs.add(onHost);
      cb(null);
      return () => { tbHostSubs.delete(onHost); stop?.(); };
    }
    if (tbHost === 'mock') {           // 목업 — 트윈도 같은 가짜 로봇을 본다
      return tbMock.subscribeState((snap) => {
        const r = snap?.robots?.[AMR_HOME.robotId];
        cb(r ? { xMm: r.pose.xMm, yMm: r.pose.yMm, thetaDeg: Number(r.pose.thetaDeg) || 0 } : null);
      });
    }
    return subscribeRobotState({
      host: tbHost,
      // **끊기면 즉시 `null`.** 안 흘리면 화면이 마지막 자세에 로봇을 계속 세워 둔다
      // — 「멈춘 시계」 (2026-08-28 감사에서 잡혔다).
      onStale: () => cb(null),
      onSnapshot: (snap) => {
        const robots = snap?.robots ?? {};
        const ids = Object.keys(robots);
        // **어느 로봇인지 지어내지 않는다.** 브리지는 둘을 등재하지만 실기는 한 대뿐이고,
        // 그게 누구인지는 `AMR_HOME.robotId` 가 든다 (`workcell.js` — 실행 기록 27/28 근거).
        // 그 이름이 스냅샷에 없으면, **하나뿐일 때만** 짝이 자명하다고 본다.
        // 둘 이상인데 이름도 못 찾으면 안 그린다 — 엉뚱한 로봇을 판 위에 세우는 것이
        // 안 그리는 것보다 나쁘다.
        const id = robots[AMR_HOME.robotId] ? AMR_HOME.robotId : (ids.length === 1 ? ids[0] : null);
        const pose = id ? robots[id]?.pose : null;
        cb(Number.isFinite(pose?.xMm) && Number.isFinite(pose?.yMm)
          ? { xMm: pose.xMm, yMm: pose.yMm, thetaDeg: Number(pose.thetaDeg) || 0 }
          : null);
      },
    });
  },
  /**
   * 손끝 자리 → 관절각. **로봇을 안 움직인다** (`API-CONTRACT` §손끝 자리 → 관절각 · D131) —
   * 조종권도 ARM 도 요구하지 않고 답만 준다. 화면이 「가면 이렇게 된다」를 그릴 때 쓴다.
   */
  async ik(tcpMmDeg, refJointsDeg = null) {
    // `refJointsDeg` — 해를 고를 참조 자세(계약 §/ik). 칸을 잇는 쪽은 직전 칸의 해를 준다. 없으면 브리지가 지금 자세를 쓴다
    const r = await fetch('/ik', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.isArray(refJointsDeg) && refJointsDeg.length === 6 ? { tcpMmDeg, refJointsDeg } : { tcpMmDeg }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    // ⛔ **본문을 통째로 준다** (2026-08-31 정정). 예전엔 `jointsDeg` 배열만 돌려줘서
    // 브리지가 같이 보낸 `gate`(통과 여부·거부 사유)와 `reason`(왜 해가 없나)이 **화면에
    // 닿기 전에 버려졌다.** 그래서 두 소비처(`useFollowSim`·`SimPanel`)가 객체를 기대하고
    // 배열을 받아 **언제나 「해가 없어요」로 보였다** — 실제로는 해가 있었다.
    // 「못 갔다」와 「갈 수 있는데 게이트가 막았다」는 사람이 할 일이 다르다. 안 뭉갠다.
    return d ?? null;
  },

  /** 프로필 목록 — `sceneId`(구운 장면·픽스처 이름 · 빌린 프로필은 실기 것)를 여기서 읽는다 (계약 `GET /robots` · 2026-09-06) */
  async robots() {
    const r = await fetch('/robots', { signal: AbortSignal.timeout(4000) });
    return r.ok ? r.json() : [];
  },
  /**
   * 구운 MJCF 장면 — 브리지 `/sim/scene/<sceneId>.xml` (계약 §정적 서빙). **없으면 null** — 산출물이라 랩 호스트엔 없을 수 있고,
   * 그때 화면은 접촉 층을 「못 잼」으로 내린다 (조용히 0 을 내지 않는다)
   */
  async sceneXml(sceneId) {
    if (!sceneId || /[^A-Za-z0-9_-]/.test(sceneId)) return null;
    const r = await fetch(`/sim/scene/${sceneId}.xml`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || !r.ok) return null;
    const xml = await r.text();
    return xml.includes('<mujoco') ? xml : null;
  },

  /** 터틀봇 브리지 주소를 아나 — 화면이 「안 켠 것」과 「고장」을 가르는 데 쓴다 */
  tbHost: () => tbHost,
  /** 터틀봇 클라이언트 — 「터틀봇」 탭의 전부 (D182). 주소가 `mock` 이면 목업이 대신 선다 */
  get tb() { return tbHost === 'mock' ? tbMock : tbClient; },

  // ── 주행 기록 — **읽기만 한다** (`TB-CONTRACT.md` §미래 접점 ④ · 명령 전송 금지).
  // 터틀봇이 1Hz 로 남긴 자취를 되감아 보려고 받아 온다. 로봇이 꺼져 있어도 파일은 남아
  // 있으므로, **실기 없이도 되감기가 된다** — 그게 이 기록의 값어치다.
  async tbRuns() {
    if (!tbHost) return [];
    if (tbHost === 'mock') return tbMock.getRuns();
    const r = await fetch(`http://${tbHost}/api/runs`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`목록 못 받음 (${r.status})`);
    return r.json();
  },
  async tbRunPath(runId) {
    if (!tbHost) return [];
    if (tbHost === 'mock') { const d = await tbMock.getRunPath(runId); return Array.isArray(d) ? d : (d?.samples ?? []); }
    const r = await fetch(`http://${tbHost}/api/runs/${encodeURIComponent(runId)}/path`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`자취 못 받음 (${r.status})`);
    const d = await r.json();
    return Array.isArray(d) ? d : (d?.samples ?? []);
  },

  subscribeRefusals(cb) {
    refusalSubs.add(cb);
    return () => refusalSubs.delete(cb);
  },
  wsReconnects: () => Math.max(0, reconnects),   // 재연결 기록 — V0 완료 증거의 일부

  // 글로벌 카메라 MJPEG. **브리지를 거치지 않는다** — 중계를 만들면 계약·라우트·vite proxy
  // 세 곳이 늘고(`vite.config.js` §API_PATHS 는 손으로 미러링한다), 얻는 게 없다.
  // 브라우저가 폰을 직접 본다. 화면은 주소를 모르고 이 함수만 부른다 (`FR5/AGENTS.md`).
  cameraFeedUrl: () => (camHost ? `http://${camHost}/video` : null),
  cameraHost: () => camHost,
  /** 주소가 **나중에** 정해질 수 있다 (위 §글로벌 카메라 주소 — 브리지에게 묻는 경로).
   *  화면이 첫 렌더의 `null` 에 갇히지 않게 알린다. 반환값은 구독 해제 함수다. */
  onCamHost: (cb) => { camHostSubs.add(cb); return () => camHostSubs.delete(cb); },

  /** 글로벌 카메라 보정값 (계약 §정적 서빙). **없으면 `null` 이고 그게 정상이다.**
   *
   * **번들에 넣지 않는다** (2026-08-08). `import.meta.glob({eager:true})` 로 읽던 동안
   * 이 값은 **빌드한 순간에 굳었다** — 카메라를 다시 거치해 파일이 바뀌어도 화면은 모른 채
   * 옛 자리로 겹쳤고, 실제로 빌드본이 X 로 531mm 어긋나 있었다. 여기서 받으면
   * `extrinsics.py` 를 돌린 뒤 **새로고침 한 번**이면 반영된다.
   *
   * `no-store` 다 — 여기서 캐시가 굳으면 번들에 넣은 것과 같아진다. 못 받으면 `null` 을
   * 내고, 그걸 "보정 없음"으로 읽는 것은 `Shared/data/camera/state.js` 다 (제1원칙).
   */
  getCamCalib: async () => {
    try {
      const r = await fetch('/config/global-cam.json',
        { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },

  /** 로봇 베이스가 상판 태그 좌표계 어디에 있나 (`robot-base-in-tag.json`).
   *
   * 판정면 겹치기의 **세 번째 좌표 칸**이다 — 게이트값(user1)→베이스 는 `toBase` 가,
   * 베이스→태그(lab) 는 이 값이, 태그→씬 은 `planToScene` 이 한다.
   * **`/config` 중 유일하게 사람이 손으로 쓰는 파일**이라(계약 §정적 서빙) 로봇을 다시
   * 앉히기 전에는 안 변한다. 못 받으면 `null` 이고 그러면 **판정면을 안 그린다**(제1원칙).
   */
  getRobotBaseInTag: async () => {
    try {
      const r = await fetch('/config/robot-base-in-tag.json',
        { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },

  /** 겹침 오차 + **나이** (`scripts/map/watch-calib.py` 산출 · 단계 A2).
   *
   * **나이를 여기서 붙인다.** 감시기가 죽으면 파일이 마지막 초록값으로 얼어붙는데, 나이가
   * 없으면 화면이 영원히 "괜찮다" 고 말한다 — 이 판에서 제일 위험한 고장이다.
   * 판정은 `Shared/data/camera/state.js` 가 하고, 못 읽으면 `null`(=모른다)이다.
   *
   * **없는 것(404)과 못 읽은 것을 가른다** — 파일이 아예 없으면 아무도 감시를 안 건 것이라
   * `undefined`(조용함)다. 못 끄는 경고를 벽 화면에 상주시키면 사람이 경고를 무시하는 법을
   * 배운다. **죽은 감시기는 이쪽으로 안 온다** — 파일이 남고 나이만 늙어 판정이 잡는다.
   *
   * ponytail: `t` 는 **쓴 쪽 시계**라 랜 안 NTP 동기를 전제한다 (계약 §카메라 `clock`).
   * 음수는 0 으로 눌러 둔다. 관문이 `clockSkewMs` 를 싣게 되면 그걸로 보정한다.
   */
  getCamDrift: async () => {
    try {
      const r = await fetch('/config/global-cam-drift.json',
        { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (r.status === 404) return undefined;   // 감시를 안 걸었다 — 경고가 아니다
      if (!r.ok) return null;                   // 있다는데 못 받았다 — 모르는 것이다
      const d = await r.json();
      return { ...d, ageMs: Math.max(0, Date.now() - d.t * 1000) };
    } catch { return null; }
  },

  /** 장면 앵커 — 태그가 정한 가상 컨베이어 자리 (`scene-anchors.json` · D135 · 계약 §정적 서빙).
   *
   * 판정면과 달리 **이야기 레이어**라 없어도 경고가 아니다 — 404 는 `undefined`(안 켠 것),
   * 못 읽은 것은 `null`(모른다). 그리기는 `Shared/view3d/anchor-overlay.js` 한 곳이 한다.
   */
  getSceneAnchors: async () => {
    try {
      const r = await fetch('/config/scene-anchors.json',
        { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (r.status === 404) return undefined;
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },

  // 손목 뎁스카메라 관문 (D86). 폰과 같은 이유로 **브리지를 거치지 않는다**.
  // 미리보기는 MJPEG 이 아니라 **낱장 JPEG** 이라 화면이 주기적으로 다시 받는다 —
  // 계약 §카메라가 "실시간 경로는 압축 컬러뿐" 이라 스트림을 안 만든 것이다.
  depthHost: () => depthHost,
  depthStateUrl: () => (depthHost ? `http://${depthHost}/api/camera/state` : null),
  // ⛔ `/api/camera/info` 는 **주소를 안 만든다** (2026-08-27 · D145). 계약에는 남아 있지만
  // (`calibId` = 프레임 출처 참조) 그걸 쓸 주인은 시연 녹화이고 아직 없다. 손목 변환 판정은
  // 로봇 프로필(`/state.handEye`)이 답한다 — 부를 사람 없는 주소를 미리 만들지 않는다
  depthPreviewUrl: () => (depthHost ? `http://${depthHost}/api/camera/preview` : null),

  getRobots: () => api('GET', '/robots'),
  getVersion: () => api('GET', '/version'),
  connect: (robotId) => api('POST', '/connect', { robotId, observeOnly: true }),
  disconnect: (w) => api('POST', '/disconnect', { who: w, token: ownerToken }),  // 주인만 끊는다

  // 조종권은 이름이 아니라 토큰이 증명한다 (D55). 토큰은 이 모듈만 들고 화면은 모른다
  hasOwnerToken: () => ownerToken !== null,   // 이름만으로 "내 것"이라 하지 않는다
  claimOwner: async (w) => {
    const res = await api('POST', '/owner/claim', { who: w });
    if (res?.token) setToken(res.token);      // 같은 이름의 재claim 도 새 토큰을 준다 (owner.py)
    return res;
  },
  releaseOwner: async (w) => {
    const res = await api('POST', '/owner/release', { who: w, token: ownerToken });
    if (res?.ok !== false) setToken(null);
    return res;
  },
  arm: (w) => api('POST', '/arm', { who: w, token: ownerToken, confirm: '현장확인' }),
  disarm: (w) => api('POST', '/disarm', { who: w, token: ownerToken }),

  // Teach — 지점(점)과 궤적(선). **좌표를 올리지 않는다** — 캡처의 정본은 서버가 읽은 상태다.
  // 읽기는 누구나, 쓰기는 조종권자만 (D44). goto 는 서버가 moveJ 로 번역해 같은 게이트를 탄다.
  getPoints: () => api('GET', '/points'),
  capturePoint: (w, name) => api('POST', '/points', { who: w, token: ownerToken, name }),
  deletePoint: (w, name) =>
    api('DELETE', `/points/${encodeURIComponent(name)}`, { who: w, token: ownerToken }),
  // speedPct — 1~10, 없으면 서버가 상한(10)을 쓴다. **상한은 서버가 지킨다** (계약 §경로 검사):
  // 여기서 자르지 않고 그대로 보내야 화면 버그가 거부 사유로 드러난다
  gotoPoint: (w, name, speedPct) =>
    api('POST', `/points/${encodeURIComponent(name)}/goto`, { who: w, token: ownerToken, speedPct }),

  getTrajectories: () => api('GET', '/trajectories'),
  getTrajectory: (name) => api('GET', `/trajectories/${encodeURIComponent(name)}`),
  // purpose — measure(조건 차단) / collect(일부러 랜덤화). 섞이면 둘 다 못 쓴다 (D74)
  startRecording: (w, name, purpose = 'measure', source = 'demo') =>
    api('POST', '/trajectories/start', { who: w, token: ownerToken, name, purpose, source }),
  stopRecording: (w) => api('POST', '/trajectories/stop', { who: w, token: ownerToken }),

  // Program — 지점을 순서로 엮어 승인한 것만 실행 (PROGRAM-CONTRACT.md).
  // **슬롯은 좌표를 안 보낸다** — 지점 이름만 올린다 (D78). step 은 서버가 goto 로 번역해
  // 같은 게이트를 처음부터 다시 태우므로, 실기 cmd 허용목록은 그대로다.
  getSlots: () => api('GET', '/slots'),
  saveSlot: (w, name, steps) => api('POST', '/slots', { who: w, token: ownerToken, name, steps }),
  deleteSlot: (w, name) =>
    api('DELETE', `/slots/${encodeURIComponent(name)}`, { who: w, token: ownerToken }),
  // 승인은 arm 과 같은 현장확인 관문을 탄다 (계획 §확인 절차는 한 모양으로)
  approveSlot: (w, name) => api('POST', `/slots/${encodeURIComponent(name)}/approve`,
    { who: w, token: ownerToken, confirm: '현장확인' }),
  // **한 요청이 한 단계다.** 몇 번째인지는 화면이 보낸다 — 서버는 커서를 안 든다
  slotStep: (w, name, index, speedPct) => api('POST', `/slots/${encodeURIComponent(name)}/step`,
    { who: w, token: ownerToken, index, speedPct }),

  // 2단 조준 (계약 §손목 스캔 · §단계 기록 · 2026-09-07 · D191·D192). 스캔은 로봇을 안 움직인다(관측) —
  // 목업은 `truth`·`atTcpMmDeg` 를 받아 「그 자세에서 본 것처럼」 답하고, 실기는 둘을 무시한다(지금 자세·진짜 뎁스)
  scan: (target, extra = {}) => api('POST', '/scan', { target, ...extra }),
  // 글로벌캠 색 검출 산출(브리지 상주가 쓴다 · 계약 §color) — `follow.targetSource` 와 무관하게 마법사 ① 의 대강값이 읽는다
  carrierPose: () => api('GET', '/config/carrier-pose.json'),
  runs: () => api('GET', '/runs'),
  run: (runId) => api('GET', `/runs/${encodeURIComponent(runId)}`),
  logRun: (runId, line) => api('POST', '/runs', { runId, line }),
  // 임의 관절 목표 — 계약 §명령의 여섯 중 하나(`moveJ`). 서버가 같은 게이트(조건 26·27 포함)를 태운다. 화면은 `speedPct` 상한 10 을 넘기지 않는다
  moveJ: (jointsDeg, speedPct = 10) => sendCmd({ cmd: 'moveJ', jointsDeg, speedPct: Math.min(10, speedPct) }),
  jog: (joint, deltaDeg) => sendCmd({ cmd: 'jog', joint, deltaDeg }),
  gripper: (pct) => sendCmd({ cmd: 'gripper', pct }),
  gripperActivate: () => sendCmd({ cmd: 'gripperActivate' }),
  setMode: (manual) => sendCmd({ cmd: 'mode', manual }),
  // 전역 속도 오버라이드 (계약 §speed · 1~30). **되읽기가 없다** — 서버가 「보낸 값」만 안다
  setSpeedOverride: (pct) => sendCmd({ cmd: 'speed', pct }),
  stop: () => sendCmd({ cmd: 'stop' }),          // 신원·조종권 없어도 항상 통과 (계약)
};
