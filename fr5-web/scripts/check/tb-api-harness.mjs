// tb-bridge 를 **브라우저 없이** 묻는 하네스 — `tb-bridge-verify.mjs` · `tb-cycle-verify.mjs` 가 쓴다.
// 상태 소켓(`/ws/state`)·로그 소켓(`/ws/logs`)을 열고, REST 는 fetch 로 부른다 (TB-CONTRACT).
// Node 22+ 의 전역 `WebSocket`·`fetch` 만 쓴다 — 의존성 0.
const HOST = process.env.TB_BRIDGE ?? 'localhost:5056';
const results = [];
export const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); };
export function report() {
  let fail = 0;
  for (const [v, name, detail] of results) {
    if (v === 'FAIL') fail += 1;
    console.log(`${v}  ${name}${detail ? `  — ${detail}` : ''}`);
  }
  console.log(fail === 0 ? '\n전체 PASS' : `\nFAIL ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
}

export async function openBridge() {
  let snap = null;
  const logs = [];
  const refusals = [];
  const ws = new WebSocket(`ws://${HOST}/ws/state`);
  const lws = new WebSocket(`ws://${HOST}/ws/logs`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.robots) snap = m; else if (m.ok === false) refusals.push(m.reason);
  };
  lws.onmessage = (e) => { try { logs.push(JSON.parse(e.data)); } catch { /* 잡음 */ } };
  await Promise.all([ws, lws].map((s) => new Promise((res, rej) => {
    s.onopen = res; s.onerror = () => rej(new Error(`브리지 ${HOST} 에 못 붙었다 — bash scripts/dev/tb-dev.sh`));
  })));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const json = async (method, path, body, headers = {}) => {
    const r = await fetch(`http://${HOST}${path}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json().catch(() => ({ ok: r.ok, status: r.status }));
  };
  return {
    snap: () => snap,
    sleep,
    send: (msg) => ws.send(JSON.stringify(msg)),
    get: (path) => json('GET', path),
    post: (path, body) => json('POST', path, body),
    raw: (method, path, body, headers) => fetch(`http://${HOST}${path}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
    snapWait: (pred, ms) => until(() => (snap && pred(snap) ? snap : null), ms),
    logWait: (pred, ms) => until(() => logs.find(pred) ?? null, ms),
    refusalWait: (pred, ms) => until(() => refusals.find(pred) ?? null, ms),
    async pollUntil(getter, pred, ms) {
      const t0 = Date.now();
      let v = null;
      while (Date.now() - t0 < ms) { v = await getter(); if (pred(v)) return v; await sleep(300); }
      return v;
    },
    close: () => { try { ws.close(); lws.close(); } catch { /* 이미 닫힘 */ } },
  };
}
