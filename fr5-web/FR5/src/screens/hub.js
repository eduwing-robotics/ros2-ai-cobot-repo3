// 허브 — `scripts/dev/health.sh` 의 일곱 고리를 **브라우저가 직접** 잰다 (2026-09-05 · phase 3).
//
// 왜 화면인가 — health.sh 는 맥 터미널에서만 돌고, 랩에서 폰·노트북으로 「지금 뭐가 붙었나」를 보려면
// 사람이 주소 일곱 개를 외워야 했다. 이 페이지는 FR5 브리지가 서빙하므로 **같은 출처가 곧 브리지 호스트**다.
// ⛔ **아무것도 안 고친다.** 처방은 글이다 — 브리지 재시작은 조종권을 끊으므로 사람이 고른다.
// 판정 규칙은 health.sh 와 같다: **포트가 열렸다고 사는 게 아니다** — 한 번은 부른다(2026-09-04 실측).
import { rememberedHost } from '@fr5/shared/data/datasource/remembered-host.js';

const REFRESH_MS = 10_000;
const host = location.hostname || 'localhost';
const camBridge = `${host}:5058`;
const $cells = document.getElementById('cells');
const $foot = document.getElementById('foot');

const FIX = {
  bridgeDead: '작업 상태가 Ready 여도 파이썬이 포트를 물고 있을 수 있다 — PID 를 끊고 띄운다 (skills/우분투 §가짜 재시작)',
  bridgeFrozen: '포트만 열리고 굳었다 — 프로세스를 죽인다. 파이썬만 죽이면 부모 cmd 가 로그를 쥐고 있어 새 인스턴스가 즉사한다 (skills/윈도우)',
  failClosed: '「프리플라이트 무응답」이면 20004 만 닫힌 것이다. 로봇 재부팅 말고 **브리지 완전 재시작**부터 (실측 08-31·09-03)',
  camDead: 'Start-ScheduledTask fr5-cam-bridge',
  camFrozen: 'D435 유령 인스턴스부터 — Get-PnpDevice *RealSense* 에 Unknown 이 쌓였으면 뽑았다 꽂는다',
  depthOff: 'PnP 로 허브가 Error(Problem 43) 인지 먼저 — 그러면 케이블이 아니라 허브다. Disable/Enable',
  usb2: 'USB2 다 — 848x480@30 이 통째로 사라진다. USB3 포트로 옮긴다',
  phoneDead: 'IP Webcam 앱이 꺼졌거나 폰이 다른 망이다. 주소 정본은 윈도우 환경변수 FR5_CAM_HOST',
  driftTags: '자동 재정합은 방 기준 4장이 필요하다 — 대개 위에 뭐가 얹혀 정숙영역을 먹은 것이다',
  tbDead: '부팅 후 ~90초. 그래도면 와이파이부터 — 파이가 team_2 로 되돌아가면 30 대역에서 영영 안 보인다 (/터틀봇 §2)',
  tbNoHost: '?tb=<host:port> 로 한 번 열거나 .env FR5_TB_HOST → node scripts/build/config.mjs',
};

const CELLS = [
  ['bridge', '팔 브리지 5055'], ['robot', '로봇'], ['cam', '카메라브리지 5058'], ['depth', '손목 뎁스 D435'],
  ['phone', '글로벌캠(폰)'], ['drift', '└ 정합'], ['tb', '터틀봇 5056'],
];
const state = Object.fromEntries(CELLS.map(([id]) => [id, { tone: 'off', detail: '재는 중…', fix: '' }]));

function render() {
  $cells.innerHTML = CELLS.map(([id, name]) => {
    const c = state[id];
    return `<section class="cell" data-t="hub-cell" data-id="${id}" data-tone="${c.tone}">
      <h2><span class="mark"></span>${name}</h2>
      <div class="detail">${esc(c.detail)}</div>
      ${c.fix ? `<p class="fix">└ ${esc(c.fix)}</p>` : ''}
    </section>`;
  }).join('');
  const bad = Object.values(state).filter((c) => c.tone === 'bad').length;
  $foot.textContent = bad === 0 ? `전부 초록 · ${new Date().toLocaleTimeString('ko-KR', { hour12: false })}`
    : `빨간 칸 ${bad} — 위에서부터 하나씩. 아래 것이 위 것 때문에 빨간 경우가 많다 · ${new Date().toLocaleTimeString('ko-KR', { hour12: false })}`;
  window.HUB_STATE = state;   // 실렌더 검증용 읽기 훅 (FR5_STATE 와 같은 규약)
}
const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
const set = (id, tone, detail, fix = '') => { state[id] = { tone, detail, fix }; render(); };

async function getJson(url, ms = 8000) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}
// 폰 영상은 <img> 로 잰다 — 다른 출처라 fetch 는 CORS 에 막히지만 이미지 로드는 안 막힌다
const imgUp = (url, ms = 5000) => new Promise((res) => {
  const im = new Image(); const t = setTimeout(() => { im.src = ''; res(false); }, ms);
  im.onload = () => { clearTimeout(t); res(true); }; im.onerror = () => { clearTimeout(t); res(false); };
  im.src = url;
});

async function probeBridge() {
  try {
    const s = await getJson('/state');
    set('bridge', 'ok', `열림 · /state 응답 · ${s.robotId ?? '미연결'}`);
    const phase = String(s.phase ?? '?');
    if (phase.startsWith('FAIL_CLOSED')) set('robot', 'bad', `${phase} · ${s.failReason ?? ''}`, FIX.failClosed);
    else if (!s.connected) set('robot', 'warn', `${phase} — 로봇에 안 붙었다`, '팔 조작 화면에서 프로필을 골라 연결한다');
    else set('robot', 'ok', `${phase} · 서보 ${s.enabled ? 'ON' : 'OFF'} · mode ${s.mode}`);
  } catch (e) {
    const frozen = e?.name === 'TimeoutError';
    set('bridge', 'bad', frozen ? '포트만 열리고 굳었다 — /state 무응답' : `무응답 (${e?.message ?? e})`, frozen ? FIX.bridgeFrozen : FIX.bridgeDead);
    set('robot', 'bad', '/state 가 없어 못 잰다', '브리지부터 본다');
  }
}

async function probeCam() {
  try {
    const s = await getJson(`http://${camBridge}/api/camera/state`, 10000);
    set('cam', 'ok', '열림 · 응답');
    const d = s.depth ?? {};
    if (s.connected) {
      const usb2 = String(s.usb ?? '').startsWith('2');
      set('depth', usb2 ? 'warn' : 'ok', `USB ${s.usb ?? '?'} · 유효율 ${Number(d.validRatio ?? 0).toFixed(3)} · ${d.validReason ?? ''}`, usb2 ? FIX.usb2 : '');
    } else set('depth', 'bad', String(d.validReason ?? s.reason ?? '안 붙음'), FIX.depthOff);
  } catch (e) {
    const frozen = e?.name === 'TimeoutError';
    set('cam', 'bad', frozen ? '포트만 열리고 굳었다' : `무응답 (${camBridge})`, frozen ? FIX.camFrozen : FIX.camDead);
    set('depth', 'off', '카메라브리지가 없어 못 잰다');
  }
}

async function probePhone() {
  let cam = rememberedHost('cam', 'fr5.camHost');
  if (!cam) { try { cam = (await getJson('/config/global-cam-host.json', 4000)).host; } catch { cam = null; } }
  if (!cam) { set('phone', 'bad', '주소 모름', FIX.phoneDead); set('drift', 'off', '—'); return; }
  const up = await imgUp(`http://${cam}/shot.jpg?cb=${Math.random()}`);
  set('phone', up ? 'ok' : 'bad', up ? cam : `${cam} 무응답`, up ? '' : FIX.phoneDead);
  try {
    const d = await getJson('/config/global-cam-drift.json', 4000);
    const tags = Number(d.tags ?? 0);
    const rms = d.rmsPx == null ? null : Number(d.rmsPx);
    const bad = tags < 4 || rms == null;
    set('drift', bad ? 'warn' : (rms > 2 ? 'warn' : 'ok'), `${rms == null ? '?' : rms.toFixed(2)}px · 태그 ${tags}장 · ${d.note ?? ''}`, bad ? FIX.driftTags : '');
  } catch { set('drift', 'off', '드리프트 파일 없음'); }
}

function probeTb() {
  let tb = rememberedHost('tb', 'fr5.tbHost');
  const go = (h) => new Promise((res) => {
    if (!h || h === 'mock') { set('tb', 'warn', h === 'mock' ? '목업 주소' : '주소 모름', FIX.tbNoHost); return res(); }
    const ws = new WebSocket(`ws://${h}/ws/state`);
    const t = setTimeout(() => { try { ws.close(); } catch { /* */ } set('tb', 'bad', `${h} 무응답`, FIX.tbDead); res(); }, 6000);
    ws.onmessage = (e) => {
      clearTimeout(t);
      try {
        const s = JSON.parse(e.data); const rs = Object.entries(s.robots ?? {});
        const on = rs.filter(([, r]) => r.connected);
        const batt = on.map(([id, r]) => `${id} ${r.batteryV != null ? r.batteryV.toFixed(1) + 'V' : (r.batteryPct ?? '?') + '%'}`).join(' · ');
        set('tb', on.length ? 'ok' : 'warn', `${h} · ${s.adapter} · 연결 ${on.length}/${rs.length}${batt ? ' · ' + batt : ''}`, on.length ? '' : '브리지는 떴는데 로봇이 안 붙었다 — 파이의 ROS 어댑터·도메인 210 을 본다');
      } catch { set('tb', 'warn', `${h} 응답 형식 이상`); }
      try { ws.close(); } catch { /* */ }
      res();
    };
    ws.onerror = () => { clearTimeout(t); set('tb', 'bad', `${h} 무응답`, FIX.tbDead); res(); };
  });
  if (tb) return go(tb);
  return getJson('/config/tb-host.json', 4000).then((j) => go(j.host)).catch(() => go(null));
}

async function tick() {
  if (document.hidden) return;   // 폰 화면이 꺼졌거나 다른 탭이면 안 잰다 — 배터리·브리지 부하 (UX 감사 2026-09-05)
  await Promise.all([probeBridge(), probeCam(), probePhone(), probeTb()]);
}
render();
tick();
setInterval(tick, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
