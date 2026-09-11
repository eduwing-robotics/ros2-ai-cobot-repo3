// 프리셋 — **빈 방에서 매번 다시 짓지 않게.**
//
// 전에는 `examples.js` 였고 A/B 토글만 이걸 읽었다. 토글을 없애면서 **게이트 말고는
// 아무도 안 읽는 데이터**가 됐다 — 그래서 프리셋으로 바꿨다. 팔레트의 `새로 ▾` 가
// 여기서 배치안을 꺼낸다. 꺼낸 뒤로는 그냥 씬이라 마음대로 고친다.
//
// 이 숫자들은 **가정이다.** 실험실 실측이 나오면 바꾼다 (`SHARED-CORE.md` §아직 안 정해진 것).
//
// **눈으로 안 맞춘다** — `scripts/check/layout.sh` 가 프리셋마다 스키마·부품 이름·도달·
// **3D 겹침**을 본다. 겹침 검사가 없으면 가구가 서로 파묻혀도 화면은 멀쩡해 보인다.

import { REACH_MM } from '../motion/limits.js';
import { emptyLayout } from './schema.js';

// 조립 라인은 **9:16 세로 방**이다 — 컨베이어가 한 줄로 방을 관통해 밖으로 나가야 하고,
// 정사각에 가까운 방에서는 그 줄이 안 선다. 6750 : 12000 = 9 : 16 (정확히).
const LINE_FLOOR = { widthMm: 6750, depthMm: 12000, heightMm: 3000 };

// 실물이 있는 팔은 **FR5 하나뿐이다** (`SHARED-CORE.md` §arms). 이송팔은 화면에만 있다.
// `robotId` — 이 팔이 실기 라이브로 물릴 브리지 로봇 ID. 준 팔만 실물 스트림을 따라간다
// (없으면 화면 재생/idle). 실물이 늘면 각 팔에 제 robotId 를 준다 (2026-08-08).
const fr5 = (id, x, y, yaw = 0, z = 900, robotId = null) => ({
  id, model: 'FR5', role: 'process', basePosMm: [x, y, z], baseYawDeg: yaw, reachMm: REACH_MM,
  ...(robotId ? { robotId } : {}),
});

// `laneOnly` — **경로를 절대 안 벗어난다.** 목적지가 경로 밖이면 경로 위 가장 가까운 점에
// 선다 (`layout-view.js` §laneOnly). 통로와 컨베이어를 나란히 그린 무대에서만 켠다.
//
// `robotId` — 이 AMR 이 실기 라이브로 물릴 **터틀봇 브리지 로봇 ID** (`fr5()` 와 같은 규약).
// 준 AMR 만 `/ws/state` 의 자세를 따라간다 (`LayoutView.jsx` §③ 실기 AMR).
// **브리지가 로봇을 둘 이상 낼 때는 이걸 안 주면 안 따라간다** — 화면이 짝을 지어내면
// 엉뚱한 로봇을 엉뚱한 자리에 세우고, 그건 안 그리는 것보다 나쁘다.
const AMR = (id, dock, waypointsMm, opts = {}) => ({
  id, model: 'TurtleBot', reachMm: 380, dockPosMm: dock, waypointsMm, ...opts,
});

// ─────────────────────────────────────────────────────────────────────────────
// 빈 방 — 벽과 문만. 새 배치안의 기본값이다.
// ─────────────────────────────────────────────────────────────────────────────
// **빈 방도 9:16 이다.** 가로 방을 기본으로 두면 거기서 라인을 짓다가 긴 축이 반대인 걸
// 나중에야 안다 (2026-08-04에 실제로 그랬다). 무대가 하나면 방 모양도 하나다.
const empty = () => ({
  floor: LINE_FLOOR,
  // **빈 방에는 빈 시나리오.** 조립 라인 사건이 딸려 오면 자리를 다 놓기 전까지
  // 재생이 "스테이션이 없어요" 만 말한다 (2026-08-04 실사용에서 막혔다).
  scenarioId: 'blank',
  doors: [{ id: 'door-1', wall: 'south', atMm: 6000, widthMm: 1800, heightMm: 2200 }],
  windows: [],
  props: [],
  stations: [],
  amrs: [],
  arms: [fr5('fr5', 2400, 6000)],
});

// ─────────────────────────────────────────────────────────────────────────────
// 조립 라인 — **주인님의 맵 1 을 정본으로 삼는다** (2026-08-04 · `Downloads/1.json`).
//
//   남(y=0)                                                        북(y=12000)
//   ┌ 벽 ────────────────────────────────────────────── 개구부 ─┐
//   │ [팔레트W]▸fr5b▸ ▁▂▃램프 ◂fr5c◂[팔레트E]
//   │            ═══ convA ═══[리프터 ◀ fr5a ◀ 신관트레이]═ convB ═▶ 밖
//   └─────────────────────────────────────────────────────────────┘
//
// 맵 1 에서 **그대로 가져온 것** — 방 치수 · 컨베이어 두 줄 · 격벽 · 비콘 · 크레인 ·
// 벽 가구 · 작업자 · **`partTray` + 받침 벤치를 조립 팔 옆에 둔 것**(808mm, 정확히 닿는다).
//
// **고친 것은 넷** — 맵 1 그대로는 사이클이 안 돌았다:
//   ① 팔 셋 중 아무도 팔레트에 안 닿았다 (1237·1432mm) → **팔레트를 팔 쪽으로 당겼다**
//   ② 아무도 투입 컨베이어에 안 닿았다 (1332·1462mm) → 램프 위 투입구를 양 팔 사이에
//   ③ 스테이션이 `load`·`lift` 둘뿐이라 재생이 못 돌았다 → `pile`·`fuze`·`ship`·`exit` 신설
//   ④ 탄두 3발이 **같은 점**에 겹쳐 있었다 → 재생기가 작업물을 그리므로 뺐다
// ─────────────────────────────────────────────────────────────────────────────
const LINE_X = 3375;          // 컨베이어·리프터·개구부가 전부 이 x 위에 선다
const LIFT_Y = 6000;          // 조립 자리 (맵 1 그대로)
const LIFT_Z = 1050;          // 들어 올린 탄두 축 높이
const FEED_Y = 900;           // 투입 팔 두 대가 서는 줄

const cell = () => ({
  floor: LINE_FLOOR,
  scenarioId: 'assembly49',
  doors: [
    { id: 'exit', wall: 'north', atMm: LINE_X, widthMm: 1100, heightMm: 1600, sillMm: 700 },
    { id: 'door-1', wall: 'south', atMm: 1400, widthMm: 1800, heightMm: 2200 },
    { id: 'door-2', wall: 'west',  atMm: 1800, widthMm: 1200, heightMm: 2100 },
  ],
  windows: [
    { id: 'win-1', wall: 'east', atMm: 4200, widthMm: 1600, heightMm: 1300, sillMm: 900 },
    { id: 'win-2', wall: 'east', atMm: 7800, widthMm: 1600, heightMm: 1300, sillMm: 900 },
    { id: 'win-3', wall: 'west', atMm: 8600, widthMm: 1600, heightMm: 1300, sillMm: 900 },
  ],

  // **역할이 셋이 아니라 둘이다** — 투입 두 대(양옆에서 램프에 올린다) · 조립 한 대.
  // 자리는 맵 1 의 것을 살렸고, 닿는 거리는 전부 3D 로 재서 맞췄다 (여유 90~117mm).
  arms: [
    fr5('fr5a', 2595, LIFT_Y, 0, 850, 'fr5-lab-a'),   // 조립 — 리프터 805 · 신관 트레이 808 · **실기 lab-a**
    fr5('fr5b', 2600, FEED_Y, 90, 700),       // 투입(서) — 팔레트 825 · 투입구 831
    fr5('fr5c', 4150, FEED_Y, 90, 700),       // 투입(동) — 팔레트 825 · 투입구 831
  ],

  stations: [
    { id: 'pile', name: '탄체 팔레트', posMm: [1800, FEED_Y, 500],
      prop: 'ammoPallet', baseMm: 0, rotDeg: 90 },
    { id: 'load', name: '투입 (램프)', posMm: [LINE_X, FEED_Y, 400] },
    { id: 'lift', name: '리프터 · 공중 고정', posMm: [LINE_X, LIFT_Y, LIFT_Z],
      prop: 'lifter', baseMm: 0, opts: { wMm: 700, liftMm: LIFT_Z } },
    // 맵 1 의 `partTray-1` 자리를 그대로 쓴다 — 조립 팔에서 808mm
    { id: 'fuze', name: '신관 트레이', posMm: [2700, 5200, 900],
      prop: 'partTray', rotDeg: 0, opts: { wMm: 560, dMm: 380, cols: 4, rows: 3 } },
    { id: 'ship', name: '배출 시작', posMm: [LINE_X, 7200, 900] },
    { id: 'exit', name: '실험실 밖으로', posMm: [LINE_X, 11200, 900] },
  ],

  props: [
    // ── 컨베이어 두 줄 — **맵 1 그대로**
    { id: 'convA', type: 'conveyor', posMm: [LINE_X, 2900], rotDeg: 90,
      opts: { lengthMm: 4800, wMm: 620, rampMm: 2600, dropMm: 620 } },
    { id: 'convB', type: 'conveyor', posMm: [LINE_X, 9100], rotDeg: 90,
      opts: { lengthMm: 4800, wMm: 620 } },
    { id: 'whIn1', type: 'warhead', posMm: [LINE_X, 2000, 470], rotDeg: 90, opts: { stage: 3 } },
    { id: 'whIn2', type: 'warhead', posMm: [LINE_X, 3600, 810], rotDeg: 90, opts: { stage: 3 } },
    { id: 'whOut', type: 'warhead', posMm: [LINE_X, 10200, 900], rotDeg: 90 },
    // ── 신관 트레이 받침 (맵 1 의 `bench-1`)
    { id: 'fuzeBench', type: 'bench', posMm: [2700, 5200], rotDeg: 90,
      opts: { wMm: 1000, dMm: 600, hMm: 900 } },
    // ── 여분 팔레트 (AMR 이 채워 놓는 자리) — 동쪽 투입 팔이 여기서 집는다
    { id: 'palE', type: 'ammoPallet', posMm: [4950, FEED_Y], rotDeg: 90, opts: { rows: 1 } },
    // ── 갠트리 크레인 — 리프터(6000) ↔ 배출 시작(7200) 을 다 덮는다
    { id: 'crane', type: 'crane', posMm: [LINE_X, 6600], rotDeg: 0,
      opts: { lengthMm: 5400, dMm: 3400, baseMm: 2050, hookDropMm: 900, trolleyAtMm: 0 } },
    // ── 셀 경계 · 경고 (맵 1 그대로)
    { id: 'bwW', type: 'blastWall', posMm: [1450, LIFT_Y], rotDeg: 90,
      opts: { lengthMm: 3200, hMm: 2000, windowMm: 1800 } },
    { id: 'bwE', type: 'blastWall', posMm: [5300, LIFT_Y], rotDeg: 90, opts: { lengthMm: 3200 } },
    { id: 'bcnW', type: 'beacon', posMm: [1750, 4700], rotDeg: 0 },
    { id: 'bcnE', type: 'beacon', posMm: [5000, 4700], rotDeg: 0 },
    // ── 벽 가구 · 작업자 (맵 1 그대로)
    { id: 'op1',  type: 'worker',      posMm: [1800, 8800], rotDeg: -90 },
    { id: 'runW', type: 'benchRun',    posMm: [325, 9900], rotDeg: 90, opts: { lengthMm: 3000, dMm: 650 } },
    { id: 'ws1',  type: 'workstation', posMm: [400, 10600, 900], rotDeg: 90 },
    { id: 'in1',  type: 'instrument',  posMm: [325, 9100, 900], rotDeg: 90 },
    { id: 'runE', type: 'benchRun',    posMm: [6400, 9600], rotDeg: -90, opts: { lengthMm: 3200 } },
    { id: 'ws2',  type: 'workstation', posMm: [6420, 9600, 900], rotDeg: -90 },
  ],

  // **경로가 시나리오를 실제로 섬긴다.** 전에는 `amr1` 의 경로가 목적지 `pile` 에서 1664mm
  // 빗나가 있었다 — 재생이 경로를 안 보고 직선으로 갔기 때문에 아무도 몰랐다 (2026-08-04).
  // `scripts/check/timeline.sh` 가 이제 그 거리를 잰다.
  //
  // 경로는 **도킹 자리에서 시작해 목적지 옆에서 끝난다** — 팔레트 위로 올라가지 않는다.
  amrs: [
    AMR('amr1', [700, 2500], [[700, 2500], [1000, 1900], [1800, 1500], [1800, 1200]]),
    AMR('amr2', [6000, 2700], [[6000, 2700], [5600, 900], [4950, 900]]),
  ],
});

// **비교 A·B 는 지웠다** (2026-08-04). 해체 시절 무대라 스테이션 이름이 조립 시나리오와
// 달라 **재생이 아무것도 안 했다** — 게이트가 `legacy` 로 표시해 두고 있던 것이다.
//
// 배치안 A·B 비교(F8)는 없어지지 않는다. **조립 라인을 복제해 팔 위치만 바꾸면** 되고,
// 그편이 낫다 — 둘 다 같은 시나리오가 돌아 사이클 타임을 실제로 견줄 수 있다.
// 옛 무대는 한쪽만 돌아서 애초에 비교가 성립하지 않았다.

// ─────────────────────────────────────────────────────────────────────────────
// 실맵 — **작업대 3판 실측을 그대로 세운다** (2026-08-19 · 컨베이어 슬라이스).
//
// 판·카트 숫자의 정본은 `FR5/bridge/config.yaml` §작업대다 (2026-08-18 실측 + 밀착 스냅).
// 그쪽은 로봇 베이스 좌표라 음수가 있고, 배치안은 방 좌표(모서리 원점 · 전부 양수)다.
// 변환은 **평행이동 하나**만 쓴다 — 회전을 섞으면 두 번째 사람이 못 따라온다:
//
//     방 = 로봇 + [1516.1, 2798.2]      (작업대3 왼쪽 면이 x 1000 · 카트 앞면이 y 2000 이 되게)
//
// 높이 — 상판은 바닥에서 965 (카트 상판 1000 − 35.1 · config.yaml topZMm -380.9 유도).
//
// **가정 셋** (실측으로 바꾸면 이 줄을 지운다):
//   · 방 치수 — 방을 잰 적이 없다. 판 섬이 들어가는 크기로만 잡았다
//   · 카트 겉치수 600×800 — 오른쪽 면은 데이터가 둘이고 36.2mm 갈린다 (GAP)
//   · 컨베이어·거치대 **자리** — 주인님 구상(33 일자 → jig2 조립 → 32 세로줄 → 작업대3)을 판 위에
//     그린 값이다. 실물 태그 32·33 을 놓고 `scripts/map/anchor-pose.py` 로 풀면
//     `Shared/data/config/scene-anchors.json` 의 실측이 이 가정을 대체한다
//
// 시나리오는 `assembly-amr` 이다 (2026-08-20 · D140 의 대응표를 그대로 세웠다).
// 전에는 'blank' 였고 `stations: []` 이라, 시나리오는 게이트를 통과하는데 **화면에서는
// 「재생할 사이클이 없어요」** 가 떴다 — 사건은 좌표가 아니라 **자리 id** 를 부르므로
// 부를 자리가 없으면 시각만 흐르고 아무도 안 움직인다.
//
// ⚠ **자리 다섯의 근거가 두 등급으로 갈린다.** 섞어 읽으면 안 된다:
//   · `pile`·`lift`·`ship` — **실측**. config.yaml 작업대 3판의 상판 중심 그대로다
//   · `load`·`exit` — **가정값**. 컨베이어 기하에서 끌어냈고 컨베이어 자체가 위 머리말대로
//     「주인님 구상을 판 위에 그린 값」이다. 태그 32·33 을 놓고 `anchor-pose.py` 로 풀면
//     `scene-anchors.json` 의 실측이 이 둘을 대체한다 (컨베이어와 같은 승급 경로)
//
// AMR 도 아직 없다 — 실물 터틀봇은 **상판 위**를 달리는데 amrs 는 바닥 z 뿐이다 (다음).
// 그래서 시나리오의 `amr`/`amrAt` 칸은 아직 그릴 대상이 없다. 자리부터 서는 것이 먼저다.
const realmap = () => ({
  floor: { widthMm: 3200, depthMm: 3600, heightMm: 2600 },
  scenarioId: 'assembly-amr',
  doors: [{ id: 'door-1', wall: 'south', atMm: 1500, widthMm: 1200, heightMm: 2100 }],
  windows: [],
  // D140 의 대응표 — `pile`①·`load`②·`lift`③·`ship`⑤·`exit`⑥. **새 id 를 만들지 않는다**
  // (없는 id 는 배치안에 놓을 카드가 없어 화면이 아무것도 못 그린다). ④`fuze` 는 안 쓴다 —
  // 실셀은 탄피·탄두 둘을 한 거치대에서 집으므로 신관 트레이가 따로 없다.
  stations: [
    // ① 1번 작업대 거치대1 — 탄피·탄두가 **분리된** 채 놓인다. 팔이 여기서 터틀봇에 싣는다
    { id: 'pile', name: '① 1번 판 거치대 (탄체)', posMm: [2204.2, 1750.0, 965] },
    // ② WP1 — 터틀봇 하차점. convIn 의 작업대1 쪽 끝(중심 1900 + 길이 640/2)
    { id: 'load', name: '② WP1 하차 (가정값)', posMm: [2220.0, 1850.0, 1045] },
    // ③ WP2 = 2번 작업대 거치대2 — 탄피를 **진짜로** 놓고 탄두와 결합한다
    { id: 'lift', name: '③ 2번 판 거치대 (조립)', posMm: [1404.2, 1750.0, 965] },
    // ⑤ WP4 = 3번 작업대 거치대3 — 완성품을 내려놓는다
    { id: 'ship', name: '⑤ 3번 판 거치대 (완성품)', posMm: [1250.0, 2400.0, 965] },
    // ⑥ 배출 끝 — 터틀봇이 180° 도는 자리. convOut 의 먼 끝(중심 2300 + 길이 560/2)
    { id: 'exit', name: '⑥ 180° 회전 (가정값)', posMm: [1350.0, 2580.0, 1045] },
  ],
  // ⭐ **이 무대만 실측이다** — 좌표가 `FRAMES.md` 의 `lab` 프레임 값이라는 선언.
  // 실기 텔레메트리(터틀봇 자세 등)를 겹쳐도 되는 무대인지 화면이 이걸로 가른다.
  // 연출 무대(`cell`·`defense-line`)에는 **안 붙인다** — 실측 좌표를 지어낸 방에 겹치면
  // 「저기 있다」가 거짓말이 된다 (2026-08-28 감사).
  frame: 'lab',
  amrs: [],
  // 실기 FR5 — **로봇 베이스의 lab 좌표**. `frames.js` 가 계산한다 (`toFrame(0,'base','lab')`).
  //
  // ⛔ **2026-08-28 에 고쳤다 (감사).** 옛 값 `(1516.1, 2798.2)` 는 로봇 베이스가 아니라
  // **user1 원점**이었다 — `config.yaml`(user1 기준) 값에 `user1→lab` 오프셋을 더해 놓고
  // 「로봇 베이스」라 적은 것이다. 둘은 725.1mm 떨어져 있다.
  //
  // 이 오류에 **결과가 있었다** — `layout.sh` 의 도달 판정이 **2/5 → 5/5** 로 바뀐다.
  // 팔이 725mm 밖에 서 있으니 판 셋을 「못 닿는다」고 보고했는데, 실물은 그 판들을 짚어
  // 교시했다(D149 · 거치대2 를 로봇이 직접 짚었다). **게이트가 거짓으로 막고 있었다.**
  arms: [fr5('fr5', 1917.9, 2300.9, 0, 1003.7, 'fr5-lab-a')],
  props: [
    // ── 작업대 3판 (config.yaml 실측 · 판마다 다리가 따로라 3상자)
    { id: 'table1', type: 'bench', posMm: [2204.2, 1750.0], rotDeg: 0,
      opts: { wMm: 800, dMm: 500, hMm: 965 } },
    { id: 'table2', type: 'bench', posMm: [1404.2, 1750.0], rotDeg: 0,
      opts: { wMm: 800, dMm: 500, hMm: 965 } },
    { id: 'table3', type: 'bench', posMm: [1250.0, 2400.0], rotDeg: 0,   // 90° 돈 판 — 폭·깊이를 바꿔 적었다
      opts: { wMm: 500, dMm: 800, hMm: 965 } },
    // ── 로봇 카트. **자리·치수 둘 다 실측으로 되돌렸다** (2026-08-28 감사).
    //    자리 = `config.yaml` 카트 상판 중앙(user1 `412.95, −504.55`) → lab.
    //    치수 = `workcell.js` `CART` 줄자값 808 × 598 × 1000.
    //    ⭐ 상판 높이가 lab z **1000.0** 으로 떨어진다 — 줄자 카트 높이와 같다(독립 검산).
    //    ⛔ 옛 값은 「깊이 1000」이었는데, 그건 실측이 아니라 **팔이 잘못 놓인 것을 덮는 꼼수**였다
    //       (옛 주석: "800 이면 뒷변에 걸터앉는다"). 팔을 제자리로 옮기니 필요 없어졌다.
    { id: 'cart', type: 'bench', posMm: [1929.0, 2293.6], rotDeg: 0,
      opts: { wMm: 808, dMm: 598, hMm: 1000 } },
    // ── 컨베이어 — **화면에만 있다** (실물은 터틀봇이 나른다 · 이야기 레이어).
    //    **일자 2개가 90° 로 만난다** — ㄱ자 토막·곡선 부품은 비채택 (D135 · 주인님 2026-08-19
    //    「곡선을 새로 만들거나 일자로만」→ 일자가 이긴다: 부품 0개 신설, 모퉁이는 만남으로 표현).
    //    convIn(33): 터틀봇 하차점(작업대1) → jig2. convOut(32): jig2 옆 → 작업대3 jig3 쪽.
    //    단면은 실물 감각으로 — 나르는 것이 77mm 더미탄이다. 250×150 은 판 폭 500 의 절반을
    //    먹어 공장 설비처럼 보였고(주인님 08-19), 150×100 도 실물 지그를 가려 **20% 더 줄였다**
    //    (같은 날 2차 지시 · cam.js `ANCHOR_PROPS` 와 같은 값 — 트윈과 AR 이 같은 크기를 그린다)
    //    `belt` — 평벨트. 77mm 탄은 롤러 틈(피치 100)에 빠진다 (주인님 08-19 3차)
    { id: 'convIn', type: 'conveyor', posMm: [1900.0, 1850.0, 965], rotDeg: 0,
      opts: { lengthMm: 640, wMm: 120, hMm: 80, belt: true } },
    { id: 'convOut', type: 'conveyor', posMm: [1350.0, 2300.0, 965], rotDeg: 90,
      opts: { lengthMm: 560, wMm: 120, hMm: 80, belt: true } },
    // ── 가상 지그는 뺐다 (주인님 08-19 2차) — **거치대는 실물이 온다.** 실물 자리는 태그
    //    15·18·21 을 붙여 비전이 말하게 한다 (D130 과 같은 규칙 — 그림으로 겹쳐 그리지 않는다)
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// 방산 조립 라인 — **연출 무대다** (2026-08-20 · 주인님 지시)
//
// ⛔ **이 배치안의 좌표는 하나도 실측이 아니다.** `realmap` 과 정반대 목적이다:
//   · `realmap` — 지금 교실을 실측 그대로. **실물과 대보는 자리**
//   · 여기      — 실제 방산 실험실처럼 보이게 지어낸 무대. **보여주는 자리**
//
// **과정은 같고 무대만 다르다.** 둘 다 `assembly-amr` 시나리오를 태운다 — 사건이 좌표가
// 아니라 **자리 id** 를 부르기 때문에 가능하고(D140), 그게 F8(배치안 A·B 비교)의 설계
// 의도 그대로다. 같은 사이클을 두 무대에 태워야 「무대가 결과를 가르나」를 물을 수 있다.
//
// ⚠ **연출이라고 이름이 말한다.** 라벨에 「연출 무대」가 박혀 있고 좌표에 근거가 없다 —
// 이 화면을 캡처해 「실기가 이렇다」로 인용하면 안 된다 (`SIM-CONTRACT` 불변식 5 와 같은 규칙).
//
// **부품은 0개 신설했다** (D135 의 규칙 그대로) — 방폭 격벽·안전 펜스·경고 비콘·차폐 부스·
// 검사 장비·제어반·갠트리 크레인이 카탈로그에 **이미 있었다.** 방산다움은 새 부품이 아니라
// 있는 부품의 배치에서 온다.
//
// 자리 다섯을 **팔 사거리 안에** 놓았다 — 지어낸 무대라 그럴 수 있다(실측 무대는 못 한다).
// `exit` 만 ✗ 인데 그건 결함이 아니라 **터틀봇만 가는 자리**라 그렇다.
// ⛔ **터틀봇 통로와 스테이션은 같은 선 위에 있어야 한다** (2026-08-20 · 주인님이 화면에서 잡음).
// 처음엔 통로를 라인 동쪽 900mm 로 뺐는데, `layout-view.js` 는 스테이션이 경로에서
// `reachMm`(380) 보다 멀면 **경로를 버리고 스테이션끼리 직선으로 간다.** 900 > 380 이라
// 매번 폴백이 걸렸고, 그 직선이 곧 컨베이어 한복판이라 **터틀봇이 컨베이어를 타고 다녔다.**
// 그 파일이 *「빗나가면 직선으로 떨어진다 — 그건 직선보다 나쁘다」* 라고 적어 둔 자리다.
// 그래서 통로는 스테이션 선 그대로 두고, **컨베이어를 옆으로 뺀다.**
//
// ⛔ **팔은 통로와 컨베이어 사이에 선다** (2026-08-20 · 주인님: 「팔이 AMR 에 닿은 다음
// 컨베이어에도 닿아야 해 — 탄두를 옮겨야 해서」). 팔을 통로 바깥(서쪽)에 두면 컨베이어까지
// **1746mm** 라 사거리 922 밖이었다. 가운데 세우면 양쪽이 다 820mm 안쪽으로 들어온다.
//   서 ──── 통로(터틀봇) ──── 팔 ──── 컨베이어 ──── 동
//        2600            3300      4000
// 통로 폭(±89) 과 컨베이어 폭(±300) 사이가 **1011mm** 라 둘이 안 겹친다(08-20 1차 결함).
const LX = 2600;          // 스테이션 · 터틀봇 통로 (같은 선) — **터틀봇은 이 선을 직진만 한다**
const ARM_X = LX + 700;   // 팔 — 통로와 컨베이어 사이 (한 대)
const CONV_X = LX + 1400; // 컨베이어
const defenseLine = () => ({
  // ⛔ **9:16 을 안 쓴다.** `LINE_FLOOR` 의 9:16 은 *컨베이어가 방을 관통해 밖으로 나가는*
  // 무대의 비율이다. 여기는 운송이 터틀봇이라 컨베이어가 방을 안 가로지르고, 팔을 둘로
  // 줄이며 자리가 사거리 안에 모였다 — 12000 을 쓰면 **북쪽 4.4m 가 통째로 빈다**
  // (크레인을 뺀 2026-08-20 에 그게 드러났다. 크레인이 빈 자리를 덮고 있었을 뿐이다).
  floor: { widthMm: 6750, depthMm: 8600, heightMm: 3000 },
  scenarioId: 'assembly-conv',
  doors: [{ id: 'door-n', wall: 'north', atMm: LX, widthMm: 1400, heightMm: 2400 }],
  windows: [],
  // ⛔ **팔은 둘이다. 셋이면 동작이 어색해진다** (2026-08-20 · 주인님이 화면에서 잡음).
  // 자세표의 역할은 `process`·`feed` **둘뿐**이고, 어느 팔이 `feed` 인지는
  // `layout-view.js feedArmIds()` 가 **`load` 에 닿느냐**로 정한다. 팔을 셋 세웠더니
  // 조립 팔과 배출 팔이 **둘 다 `process` 라 같은 자세표를 공유**했다 —
  // 배출 팔이 허공에서 나사를 돌렸다. 둘로 줄이면 역할이 1:1 로 갈린다:
  //   투입(feed)  ← pick · haul · feed · move
  //   조립(process) ← hold · join · drop · out
  // **실물 robotId 는 조립 팔 하나뿐이다** (SR_24) — 투입 팔은 화면에만 있다.
  // ⛔ **팔은 하나다** (2026-08-20). 둘이던 때 투입 팔이 **다른 무대에서 가르친 자세**를
  // 써서 손끝이 목표와 172° 반대쪽을 짚었다(잔차 240mm · 되돌려짐). 작업 셀을 사거리 안으로
  // 좁히니 **한 대가 네 자리를 다 닿는다** — pile 860 · load 862 · lift 735 · ship 892mm.
  // 실물 FR5 도 한 대다 (SR_24).
  arms: [fr5('fr5a', ARM_X, 4700, 0, 850, 'fr5-lab-a')],
  // ⭐ **자리가 두 줄로 갈린다** (2026-08-20 · 주인님: 「안 보이는 터틀봇을 사용하자」).
  //   · 통로 줄(`LX`)  — `pile`·`exit`. **터틀봇이 실제로 서는 자리**
  //   · 컨베이어 줄(`CONV_X`) — `load`·`lift`·`ship`. **팔이 탄두를 옮겨 놓는 자리**
  // 그래야 팔이 「터틀봇에서 집어 → 컨베이어에 올린다」를 한 사이클 안에서 둘 다 겨눈다.
  //
  // ⛔ **시나리오는 안 고쳤다.** `assembly-amr` 은 다섯 자리를 전부 `amrAt` 으로도 쓰므로
  // 컨베이어 줄에서는 터틀봇이 컨베이어 위로 올라간다 — 그래서 **경로 밖에서는 안 그린다**
  // (`layout-view.js` §통로 밖). D140 과 실맵 짝(F8)을 손대지 않고 푸는 길이다.
  stations: [
    { id: 'pile', name: '① 탄체 더미 (터틀봇 하차)', posMm: [LX, 4200, 850], prop: 'ammoPallet', baseMm: 0,
      opts: { wMm: 1200, dMm: 800, rows: 2, perRow: 6 } },
    { id: 'load', name: '② 컨베이어 투입구', posMm: [CONV_X, 4200, 900] },
    { id: 'lift', name: '③ 조립 자리', posMm: [CONV_X, 4800, 1050], prop: 'lifter', baseMm: 0,
      opts: { wMm: 700, liftMm: 1050 } },
    { id: 'ship', name: '⑤ 완성품 내려놓는 곳', posMm: [CONV_X, 5250, 900] },
    // ⛔ 팔이 안 닿는다 — **의도다.** 터틀봇이 완성품을 물고 문으로 나가는 자리다
    { id: 'exit', name: '⑥ 나가는 곳', posMm: [LX, 7900, 900] },
  ],
  // 터틀봇 — 자리 다섯을 남에서 북으로 훑는다. 도킹 자리는 라인 남쪽 끝
  // **통로 한 줄 직진뿐이다** (주인님 2026-08-20). 컨베이어 줄 자리로 가야 하는 구간은
  // 경로 밖이라 화면이 터틀봇을 **안 그린다** — 위 §자리 두 줄 참조
  amrs: [AMR('amr1', [LX, 1400], [[LX, 1400], [LX, 4200], [LX, 7900]], { laneOnly: true, robotId: 'tb3_2' })],
  // 소품 배치는 **`cell`(맵 1 정본 · 주인님) 의 문법을 그대로 따른다** (주인님 지시 2026-08-20
  // 「소품 18버전을 참고해서」). 첫 판은 가구를 방 가운데에 흩어 놨었고 창고처럼 보였다.
  // 옮겨 온 규칙 셋 — 이것이 「방산 실험실처럼」의 실체다:
  //
  //   ① **격벽 둘이 조립 자리를 서·동에서 대칭으로 감싼다.** 서쪽 것만 `windowMm` 으로
  //      창을 뚫어 안이 보이게 한다 — 셀이 닫혀 있다는 것과 그 안에서 뭘 하는지를 동시에 말한다
  //   ② **경고 비콘 둘이 그 셀 입구 양쪽.** 격벽 남단 바로 앞이라 「여기부터 위험구역」이 읽힌다
  //   ③ **벽 가구는 벽에 딱 붙인다** — x 325·6400 은 가구 **깊이의 절반**이다. 가운데로
  //      끌어내는 순간 실험실이 아니라 창고가 된다
  //
  // 소품 18개 — `cell` 과 같은 개수인 것은 우연이다(자리·팔이 달라 구성은 다르다).
  props: [
    // ── 라인 — 투입구에서 조립까지, 조립에서 배출까지
    { id: 'convIn', type: 'conveyor', posMm: [CONV_X, 3900], rotDeg: 90,
      opts: { lengthMm: 1000, wMm: 600, hMm: 850 } },
    { id: 'convOut', type: 'conveyor', posMm: [CONV_X, 5850], rotDeg: 90,
      opts: { lengthMm: 1200, wMm: 600, hMm: 850 } },
    // ⛔ 크레인은 안 쓴다 (주인님 2026-08-20) — 실셀에 없는 설비이고, 화면 위를 덮어
    //    안이 안 보이게 만든다. `cell` 에는 남아 있다(그쪽 무대는 크레인이 배출을 맡는다)

    // ── ① 격벽 대칭 둘 — 조립 자리(6000)를 감싼다
    { id: 'bwW', type: 'blastWall', posMm: [1450, 6000], rotDeg: 90,
      opts: { lengthMm: 3200, hMm: 2000, windowMm: 1800 } },
    { id: 'bwE', type: 'blastWall', posMm: [5150, 6000], rotDeg: 90,
      opts: { lengthMm: 3200 } },
    // ── ② 비콘 둘 — 격벽 남단 앞, 셀 입구 양쪽
    { id: 'bcnW', type: 'beacon', posMm: [1750, 4300] },
    { id: 'bcnE', type: 'beacon', posMm: [4850, 4300] },

    // ── ③ 벽 가구 — 서벽. 검사 장비·제어반은 **작업대 열 위에** 얹힌다 (z 900)
    { id: 'runW', type: 'benchRun', posMm: [325, 6900], rotDeg: 90,
      opts: { lengthMm: 3000, dMm: 650 } },
    { id: 'in1', type: 'instrument', posMm: [325, 6100, 900], rotDeg: 90 },
    { id: 'ws1', type: 'workstation', posMm: [400, 7600, 900], rotDeg: 90 },
    { id: 'shelfA', type: 'shelf', posMm: [400, 2600], rotDeg: 90 },
    { id: 'shelfB', type: 'shelf', posMm: [400, 3700], rotDeg: 90 },
    // ── ③ 벽 가구 — 동벽
    { id: 'runE', type: 'benchRun', posMm: [6400, 6600], rotDeg: -90,
      opts: { lengthMm: 3200 } },
    { id: 'ws2', type: 'workstation', posMm: [6420, 6600, 900], rotDeg: -90 },
    { id: 'isoBooth', type: 'isolator', posMm: [6000, 3400], rotDeg: 90,
      opts: { wMm: 1800, dMm: 900, hMm: 2200 } },

    // ── 여분 팔레트 — 터틀봇이 채워 놓는 자리 (`cell` 의 `palE` 와 같은 역할)
    { id: 'palE', type: 'ammoPallet', posMm: [5000, 1600], rotDeg: 90, opts: { rows: 1 } },

    // ── 사람 둘 — **스케일을 읽게 하는 유일한 부품이다.** 없으면 크기 감각이 안 선다
    { id: 'op1', type: 'worker', posMm: [1950, 6800], rotDeg: -90 },
    { id: 'op2', type: 'worker', posMm: [1900, 3400], rotDeg: -90 },
  ],
});

// 공장 답사 연출 — 실측 core를 옮기지 않고 주변에 가상 설비만 둔다 (D227).
// frame:'lab'은 core의 좌표계만 말한다. 늘린 방/배경은 실측이 아니며 AR 기본층으로 쓰지 않는다.
const factoryWalk = () => {
  const measured = realmap();
  return {
    ...measured,
    appearance: 'defense-reference-v1',
    floor: { widthMm: 4600, depthMm: 4800, heightMm: 3000 },
    windows: [
      { id: 'inspection-n', wall: 'north', atMm: 2200, widthMm: 2200, heightMm: 1100, sillMm: 1250 },
      { id: 'inspection-w', wall: 'west', atMm: 1900, widthMm: 1700, heightMm: 1000, sillMm: 1300 },
    ],
    props: [
      ...measured.props,
      // 북벽 검사대 + 계측 장비. 기존 팩토리의 서랍/화면/손잡이 형태를 재사용한다.
      { id: 'factory-inspection', type: 'benchRun', posMm: [2100, 4450],
        opts: { lengthMm: 2400, dMm: 600, hMm: 900 } },
      { id: 'factory-meter', type: 'instrument', posMm: [1500, 4400, 900],
        opts: { wMm: 650, dMm: 400, hMm: 450 } },
      { id: 'factory-control', type: 'workstation', posMm: [2700, 4400, 900] },
      // 상부장은 검사창을 가리지 않도록 동벽의 차폐 부스 옆으로 둔다.
      { id: 'factory-storage', type: 'benchRun', posMm: [4275, 4100], rotDeg: -90,
        opts: { lengthMm: 1100, dMm: 650, hMm: 900 } },
      { id: 'factory-upper', type: 'wallCabinet', posMm: [4425, 4100], rotDeg: -90,
        opts: { lengthMm: 1100, dMm: 350, hMm: 650, baseMm: 1550, open: true } },
      { id: 'factory-booth', type: 'isolator', posMm: [4050, 2450], rotDeg: -90,
        opts: { wMm: 1800, dMm: 900, hMm: 2200 } },
      { id: 'factory-shelf', type: 'shelf', posMm: [300, 3450], rotDeg: 90,
        opts: { wMm: 900, dMm: 450, hMm: 2100, levels: 5 } },
      { id: 'factory-partitions', type: 'blastWall', posMm: [2200, 3450],
        opts: { lengthMm: 2300, tMm: 140, hMm: 2000, windowMm: 1700 } },
      { id: 'factory-beacon', type: 'beacon', posMm: [3500, 3450], opts: { hMm: 1500 } },
    ],
  };
};

/** 팔레트의 `새로 ▾` 에 뜨는 순서 = 이 배열 순서. */
export const PRESETS = [
  { id: 'empty', label: '빈 방',
    hint: '벽과 문만 — 팔레트로 짓는다', build: empty },
  { id: 'cell', label: '조립 라인 · 일직선 (9:16)',
    hint: '팔레트→컨베이어→리프터에서 신관 결합→크레인이 배출로. FR5 2대가 투입·조립을 나눈다',
    build: cell },
  { id: 'realmap', label: '실맵 · 작업대 3판 (실측)',
    hint: '카트를 ㄱ자로 감싼 실측 3판 · 일자 컨베이어 둘이 90° 로 만난다 — 컨베이어는 화면에만, 거치대는 실물이 온다',
    build: realmap },
  { id: 'defense-line', label: '방산 조립 라인 · 연출 무대',
    hint: '실맵과 같은 사이클(assembly-amr)을 방산 실험실 무대에 태운다 — 격벽·펜스·비콘·차폐 부스. ⚠ 좌표는 실측이 아니라 연출이다',
    build: defenseLine },
  { id: 'factory-walk', label: '실측 셀 + 가상 공장 배경 · 연출',
    hint: '작업대·카트·FR5·경로 컨베이어는 실맵 그대로, 방·검사대·차폐 부스는 가상 배경. 현장 AR 기본 화면에는 자동 표시하지 않는다',
    build: factoryWalk },
];

export const DEFAULT_PRESET = 'empty';

/** 프리셋 하나를 **완전한 배치안**으로. 꺼낸 뒤로는 그냥 씬이라 프리셋과 인연이 끊긴다 (D56). */
export function buildPreset(presetId = DEFAULT_PRESET, id = presetId, name) {
  const p = PRESETS.find((x) => x.id === presetId) ?? PRESETS[0];
  return { ...emptyLayout(id, name ?? p.label), ...structuredClone(p.build()) };
}
