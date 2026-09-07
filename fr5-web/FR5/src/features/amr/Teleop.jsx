// 조종 — **WASD 키패드가 기본**이고 아날로그 패드는 선택이다 (2026-08-19).
// 워치독 500ms 라 누르고 있는 동안 계속 보낸다. 떼면 안 보내고, 그러면 서버가 세운다.
// 상한 검사는 서버(mock 포함)가 한다 — 여기는 상한 안의 값만 만들어 보낸다.
//
// 옛 터틀봇 웹앱의 `drive/Teleop.jsx`(퇴역)를 그대로 옮겼다 (D182 · 2026-09-05).
// 달라진 것 하나 — 출처가 `datasource.tb` 다 (주소는 FR5 datasource 가 안다).
import { useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';

const SEND_MS = 150;               // 워치독 500ms 보다 충분히 짧게
const LINEAR_MAX = 150, ANGULAR_MAX = 60;
const PAD = 130;                   // 아날로그 패드 지름 px
const KEYS = ['w', 'a', 's', 'd'];

// **「미세」 배율 — 상한이 아니라 키가 내는 값을 줄인다** (2026-08-20 · 실기 담당자 실사용).
// 키는 온·오프뿐이라 한 번 누르면 **워치독 500ms 동안 최대 속도가 유지된다** — 즉 최소 회전이
// `60°/s × 0.5s ≈ 30°` 라 웨이포인트 θ 를 손으로 맞출 수 없다. 25% 면 한 번에 ~7.5° 다.
// ⛔ **서버 상한(150·60)은 안 건드린다** — 그건 안전값이고, 낮추면 자율 실행기까지 같이 묶인다.
const FINE = 0.25;

// 키 하나가 만드는 속도. 대각(w+a)은 더해져 「전진하며 좌회전」이 된다
const velFromKeys = (keys, k = 1) => ({
  linearMmS: Math.round(((keys.has('w') ? LINEAR_MAX : 0) + (keys.has('s') ? -LINEAR_MAX : 0)) * k),
  angularDegS: Math.round(((keys.has('a') ? ANGULAR_MAX : 0) + (keys.has('d') ? -ANGULAR_MAX : 0)) * k),
});

export function Teleop({ robot, who }) {
  const [vel, setVel] = useState({ linearMmS: 0, angularDegS: 0 });
  const [held, setHeld] = useState([]);          // 지금 눌린 키 — 화면 강조용
  const [analog, setAnalog] = useState(false);   // 아날로그 패드는 기본 꺼짐
  const [fine, setFine] = useState(false);       // 미세 — 키가 내는 값을 FINE 배로
  const [reason, setReason] = useState('');
  const velRef = useRef(vel);
  const fineRef = useRef(fine);
  const keysRef = useRef(new Set());
  const padRef = useRef(null);

  velRef.current = vel;
  fineRef.current = fine;

  const applyKeys = () => {
    setHeld([...keysRef.current]);
    setVel(velFromKeys(keysRef.current, fineRef.current ? FINE : 1));
  };

  // 누른 채로 미세를 켜고 끌 수 있다 — 그때 값이 안 따라오면 화면과 실제가 갈린다
  useEffect(() => {
    if (keysRef.current.size) setVel(velFromKeys(keysRef.current, fine ? FINE : 1));
  }, [fine]);

  // 잡고 있는 동안 주기 전송 — 놓으면 보내지 않는다 → 워치독이 세운다
  useEffect(() => {
    const timer = setInterval(() => {
      const v = velRef.current;
      if (v.linearMmS === 0 && v.angularDegS === 0) return;
      const res = datasource.tb.teleop(robot, v.linearMmS, v.angularDegS, who);
      setReason(res.ok ? '' : res.reason);
    }, SEND_MS);
    return () => clearInterval(timer);
  }, [robot, who]);

  // 거부 사유는 **WS 로 늦게** 온다 (teleop 은 보내고 끝이라 즉답이 없다). 조종 칸에 직접 띄운다 (D114)
  useEffect(() => datasource.tb.subscribeRefusals?.((why) => {
    setReason(why);
    const t = setTimeout(() => setReason(''), 4000);
    return () => clearTimeout(t);
  }), []);

  // 키보드 — 화면 버튼과 같은 집합을 만진다 (둘이 한 상태를 쓴다).
  // ⚠ FR5 화면에는 입력칸이 많다(이름·지점 이름·좌표) — 거기서는 WASD 가 글자다
  useEffect(() => {
    const down = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (KEYS.includes(k)) { e.preventDefault(); keysRef.current.add(k); applyKeys(); }
    };
    const up = (e) => { keysRef.current.delete(e.key.toLowerCase()); applyKeys(); };
    // 창을 벗어나면 키를 뗀 것으로 친다 — 안 그러면 keyup 을 못 받아 계속 눌린 채로 남는다
    const blur = () => { keysRef.current.clear(); applyKeys(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // 화면 버튼 — 누르고 있는 동안만. 떼면(pointerup·leave·cancel) 즉시 0 이다
  const press = (k) => (e) => { e.preventDefault(); keysRef.current.add(k); applyKeys(); };
  const lift = (k) => () => { keysRef.current.delete(k); applyKeys(); };
  const stopAll = () => { keysRef.current.clear(); applyKeys(); };

  const onPointer = (e) => {
    if (e.buttons !== 1 && e.type !== 'pointerdown') return;
    const rect = padRef.current.getBoundingClientRect();
    const dx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const dy = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    const k = fineRef.current ? FINE : 1;   // 패드가 미세를 안 먹으면 「미세인데 패드만 빠르다」가 된다
    setVel({
      linearMmS: Math.round(Math.max(-1, Math.min(1, -dy)) * LINEAR_MAX * k),
      angularDegS: Math.round(Math.max(-1, Math.min(1, -dx)) * ANGULAR_MAX * k),
    });
  };

  const key = (k, label) => (
    <button key={k} type="button" className="teleop-key" aria-pressed={held.includes(k)}
            onPointerDown={press(k)} onPointerUp={lift(k)}
            onPointerLeave={lift(k)} onPointerCancel={lift(k)}>
      <b>{k.toUpperCase()}</b><span>{label}</span>
    </button>
  );

  return (
    <div className="teleop" data-t="tb-teleop">
      <div className="teleop-keys">
        <div className="teleop-keyrow">{key('w', '전진')}</div>
        <div className="teleop-keyrow">{key('a', '좌회전')}{key('s', '후진')}{key('d', '우회전')}</div>
        <button type="button" className="teleop-stop" onClick={stopAll}>손 떼기 (정지)</button>
      </div>

      <div className="teleop-readout">
        <div>
          <b>{vel.linearMmS >= 0 ? '+' : ''}{vel.linearMmS}</b> mm/s
          {' · '}<b>{vel.angularDegS >= 0 ? '+' : ''}{vel.angularDegS}</b> °/s
        </div>
        <div className="teleop-note">
          키보드 <b>WASD</b> · 상한 |{LINEAR_MAX}|·|{ANGULAR_MAX}| · watchdog 500ms
          {' · '}
          <label>
            <input type="checkbox" checked={fine} onChange={(e) => setFine(e.target.checked)} />
            미세 {Math.round(FINE * 100)}%
          </label>
          {' '}
          <label>
            <input type="checkbox" checked={analog} onChange={(e) => setAnalog(e.target.checked)} />
            아날로그
          </label>
        </div>
        {reason && <div className="teleop-reason" data-t="tb-refusal">{reason}</div>}
      </div>

      {analog && (
        <div className="teleop-pad" ref={padRef} style={{ width: PAD, height: PAD }}
             onPointerDown={onPointer} onPointerMove={onPointer}
             onPointerUp={stopAll} onPointerLeave={stopAll}>
          <div className="teleop-knob" style={{
            transform: `translate(${(-vel.angularDegS / ANGULAR_MAX) * PAD * 0.3}px,
                                  ${(-vel.linearMmS / LINEAR_MAX) * PAD * 0.3}px)`,
          }} />
        </div>
      )}
    </div>
  );
}
