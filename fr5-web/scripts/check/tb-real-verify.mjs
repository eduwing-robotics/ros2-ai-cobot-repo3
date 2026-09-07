// 수동 검증용 — 우분투 real 브리지가 떠 있을 때. IP·포트는 TB_REAL 로 덮어쓴다.
// 포트 5056 은 `TurtleBot/bridge/config.yaml` 이 정본이다 — 5055 는 같은 PC 의 FR5 브리지 (D80).
// 스크린샷 폴더는 **끝난 세션의 스크래치패드를 기본값으로 두지 않는다** — 그 폴더는 사라져
// 있고 `cdp-harness` 의 screenshot 은 writeFileSync 뿐이라 만들지 않는다. 검사가 전부 PASS
// 해도 마지막 줄에서 ENOENT 로 죽어 결과를 못 본다 (2026-08-06 실기 · GAP `OUT` 행과 같은 뿌리).
import { mkdirSync } from 'node:fs';
import { openPage } from './lib/cdp-harness.mjs';
const URL = process.env.TB_REAL ?? 'http://192.168.30.240:5056/';
const OUT = process.env.TB_OUT ?? `${import.meta.dirname}/../../.diag/tb-real`;
mkdirSync(OUT, { recursive: true });
const R=[]; const ck=(n,ok,d='')=>R.push([ok?'PASS':'FAIL',n,d]);
const p = await openPage(URL, { port: 9350, windowSize: '1280,900' });
try {
  await p.waitFor(`window.TB_TABS?.length === 3`, { timeoutMs: 15000 });
  ck('우분투 브리지가 웹앱 서빙 (탭 3)', (await p.eval(`window.TB_TABS?.join(',')`)) === 'drive,mapping,runs');
  const badge = await p.waitFor(`document.querySelector('.source')?.textContent`, { timeoutMs: 8000 });
  ck('adapter 배지 = real (실기 어댑터 물림)', badge === 'adapter:real', `배지=${badge}`);
  const cards = await p.eval(`document.querySelectorAll('.robot-card').length`);
  ck('로봇 카드 2대 (config: tb3_1·tb3_2)', cards === 2, `${cards}대`);
  // 로봇 bringup 없음 → fail-safe: connected=false
  const conn = await p.eval(`[...document.querySelectorAll('.robot-card')].map(c=>c.textContent).join(' | ')`);
  ck('로봇 fail-safe 표시 (bringup 전 → disconnected)', /disconnected/.test(conn), conn.slice(0,120));
  ck('슬롯 목록 로드', await p.eval(`fetch('/api/slots').then(r=>r.json()).then(s=>s.length>0)`));
  ck('콘솔 에러 0', p.consoleErrors.length === 0, JSON.stringify(p.consoleErrors.slice(0,3)));
  await p.screenshot(`${OUT}/p4-real.png`);
} finally { p.close(); }
let f=0; for(const[v,n,d]of R){if(v==='FAIL')f++;console.log(`${v}  ${n}${d?'  — '+d:''}`);}
console.log(f===0?'\n전체 PASS':`\nFAIL ${f}건`); process.exit(f?1:0);
