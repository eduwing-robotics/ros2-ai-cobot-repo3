// 브리지 상태 스트림 — **읽기 전용 관전**. `/ws/state` 를 구독해 스냅샷만 흘린다.
// hello·claim·명령이 없다: 관전자는 명령을 못 보낸다 (하드룰 4 — 명령 주인은 한 명).
//
// FR5 조작 화면의 소켓(`FR5/src/data/datasource/http.js`)은 **명령+상태를 한 소켓에** 싣는
// 별개 클라이언트다. 그건 조종권을 잡고 moveJ 를 보내야 하므로 여기로 합치지 않는다 —
// 합치면 관전용 화면(AR·대시보드 요약)이 명령 능력을 갖게 되어 단일 소유 규칙이 샌다.
// 계약상 `/ws/state` 는 "접속한 전원이 같은 것을 받는" 공용 브로드캐스트다 (API-CONTRACT §상태).
//
// **주소는 same-origin 이 아닐 수 있다.** FR5 는 브리지가 페이지를 서빙해 `location.host` 가
// 곧 브리지지만, AR 은 카메라 때문에 HTTPS 로 자기 출처에서 서빙된다 — 그 출처엔 `/ws/state`
// 가 없다. dev 는 vite 프록시로 same-origin 을 만들고(`AR/vite.config.js`), 프록시가 없는
// 배포에선 `host` 를 넘긴다. cam(`?cam=`)·depth(`?depth=`) 와 같은 규약이다.
//
// ⚠ HTTPS 페이지에서 `host` 로 평문 브리지(`ws://…:5055`)를 직접 가리키면 브라우저가
// 혼합 콘텐츠로 막는다. 그때는 vite/터널 프록시로 same-origin(`wss`)을 쓴다 (host 생략).
/**
 * @param {object} o
 * @param {string} [o.host] 브리지 주소. 없으면 `location.host`
 * @param {(snap:object)=>void} [o.onSnapshot] 스냅샷 하나
 * @param {()=>void} [o.onStale] **연결이 끊겼다.** 스냅샷이 더는 안 온다는 뜻이다.
 *
 * ⛔ **`onStale` 을 안 받으면 화면이 「멈춘 시계」가 된다** (2026-08-28 감사).
 * 끊겨도 마지막 스냅샷이 상태에 남아, 브리지가 죽은 뒤에도 화면은 그 자리에 로봇을
 * 계속 그린다 — 그것도 **살아 있을 때와 똑같은 신뢰도로.** 실물이 어디 있는지 아무도
 * 모르는데 화면만 안다고 말하는 셈이라, 틀린 자리를 그리는 것보다 나쁠 수 있다.
 */
export function subscribeRobotState({ host, onSnapshot, onStale } = {}) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${scheme}://${host || location.host}`;
  let ws = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${base}/ws/state`);
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.ok === false) return;   // 거부 응답 — 상태 스냅샷이 아니다
      onSnapshot?.(msg);
    };
    // 미연결에도 같은 스키마가 오므로(D40) 끊김 = 브리지 자체가 죽은 것 — 1초 후 재시도.
    // **재시도 전에 먼저 알린다** — 다시 붙기까지 최소 1초 동안 화면이 옛 값을 들고 있다.
    ws.onclose = () => {
      if (closed) return;
      try { onStale?.(); } catch { /* 구독자 사정은 여기서 안 다룬다 */ }
      setTimeout(connect, 1000);
    };
  };
  connect();

  return () => { closed = true; try { ws?.close(); } catch { /* 이미 닫힘 */ } };
}
