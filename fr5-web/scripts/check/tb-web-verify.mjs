// 수동 검증용 — all.sh 가 자동으로 돌리지 않는다 (.sh 아님). FR5 dev 서버(:5176) 필요.
// D182 부터 터틀봇 화면은 FR5 조작의 「터틀봇」 탭이다 — `?tb=mock` 으로 목업 브리지를 세우고
// 조종권→슬롯→estop 왕복을 ground truth(datasource.tb) 로 판정한다.
//   npm run dev:fr5 &  node scripts/check/tb-web-verify.mjs
import { openPage } from './lib/cdp-harness.mjs';

const URL = process.env.FR5_URL ?? 'http://localhost:5176/?tb=mock';
const OUT = process.env.TB_VERIFY_OUT ?? '/tmp';
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); };
const clickByText = (text, sel = 'button') =>
  `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.includes(${JSON.stringify(text)}))?.click() ?? 'notfound'`;

const p = await openPage(URL, { port: 9340, windowSize: '1280,900' });
try {
  await p.waitFor(`document.querySelectorAll('nav button').length === 5`);
  await p.setLocalStorage('fr5-who', 'kim');
  await p.navigate(URL);
  await p.waitFor(`document.querySelectorAll('nav button').length === 5`);
  await p.eval(clickByText('터틀봇', 'nav button'));
  await p.waitFor(`!!document.querySelector('[data-t="tb-panel"][data-host="mock"]')`, { timeoutMs: 5000 });

  check('터틀봇 탭이 목업 브리지에 붙었다', (await p.eval(`document.querySelector('[data-t="tb-adapter"]')?.textContent`)) === 'mock');
  check('로봇 카드 2개', (await p.eval(`document.querySelectorAll('.tbpanel .robot-card').length`)) === 2);
  check('맵 캔버스는 없다 (D182 — 3D 트윈이 그린다)', !(await p.eval(`!!document.querySelector('.mapview')`)));

  // 조종권 claim (tb3_2 가 기본 선택)
  await p.eval(clickByText('내가 claim', '.tbpanel button'));
  check('조종권 claim → 소유자 kim', !!(await p.waitFor(`document.querySelector('[data-t="tb-owner"]')?.textContent.includes('소유자 kim')`, { timeoutMs: 3000 })));

  // 슬롯 시작 → mode 배지
  await p.eval(clickByText('patrol', '.tbpanel .slot-card'));
  await p.eval(clickByText('▶ 시작', '.tbpanel button'));
  check('슬롯 시작 → mode=slot', !!(await p.waitFor(`document.querySelector('.tbpanel .robot-card[aria-selected="true"]')?.textContent.includes('slot')`, { timeoutMs: 3000 })));
  await p.screenshot(`${OUT}/tb-tab-drive.png`);

  // E-STOP → idle
  await p.eval(`document.querySelector('[data-t="tb-estop"]').click()`);
  check('E-STOP → idle 복귀', !!(await p.waitFor(`document.querySelector('.tbpanel .robot-card[aria-selected="true"]')?.textContent.includes('idle')`, { timeoutMs: 3000 })));

  // 헤더 STOP 하나가 둘 다 — 팔 stop + 터틀봇 estopAll (목업이라 팔은 미연결이어도 예외 없이 지나가야 한다)
  await p.eval(clickByText('patrol', '.tbpanel .slot-card'));
  await p.eval(clickByText('▶ 시작', '.tbpanel button'));
  await p.waitFor(`document.querySelector('.tbpanel .robot-card[aria-selected="true"]')?.textContent.includes('slot')`, { timeoutMs: 3000 });
  await p.eval(`document.querySelector('[data-t="estop"]').click()`);
  check('헤더 STOP → 터틀봇도 idle (계약 ④)', !!(await p.waitFor(`document.querySelector('.tbpanel .robot-card[aria-selected="true"]')?.textContent.includes('idle')`, { timeoutMs: 3000 })));

  // 규칙 거부 — ground truth
  const noOwner = await p.eval(`JSON.stringify(window.FR5_TB.teleop('tb3_1', 100, 0, 'kim'))`);
  check('조종권 없는 teleop 거부', JSON.parse(noOwner).ok === false, noOwner);
  const overCap = await p.eval(`JSON.stringify(window.FR5_TB.teleop('tb3_2', 999, 0, 'kim'))`);
  check('상한 초과 teleop 거부', JSON.parse(overCap).ok === false, overCap);

  check('콘솔 에러 0', p.consoleErrors.length === 0, JSON.stringify(p.consoleErrors.slice(0, 3)));
} finally {
  p.close();
}

let fail = 0;
for (const [v, name, detail] of results) {
  if (v === 'FAIL') fail += 1;
  console.log(`${v}  ${name}${detail ? `  — ${detail}` : ''}`);
}
console.log(fail === 0 ? '\n전체 PASS' : `\nFAIL ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
