// 시나리오 프리셋 — **출하되는 기본값.** 저장소가 비어도 재생이 돈다.
//
// 2026-08-04 까지 이 배열은 `datasource/mock.js` 안 `DEMO_CYCLE` 상수였다. 데이터가 아니라
// 코드라서 고칠 방법도, 배치안마다 다르게 줄 방법도 없었다.
//
// **꺼낸 뒤로는 그냥 시나리오다** — 프리셋을 나중에 고쳐도 이미 만든 것은 안 따라간다
// (배치안의 D56 과 같은 규칙). 저장분이 발밑에서 바뀌는 것보다 낫다.
//
// **게이트는 저장소가 아니라 여기를 본다.** 출하되는 기본값이 성립하는지가 판정 대상이고,
// 저장소는 브라우저마다 다르다 (`timeline.sh` ⑩ · `motion.sh` ⑥ · `scenario.sh`).

import { emptyScenario } from './schema.js';

// 한 사이클 — **1발 조립 = 1사이클** (D51 · D63). 모양은 `SHARED-CORE.md` §1.7.
//
// **좌표가 아니라 스테이션 id** 다. 그래서 배치안을 옮겨도 재생이 따라오고, 같은 사이클을
// 배치안 A·B 에 태워 비교할 수 있다 (F8). 스테이션 id 가 없는 배치안에서는 아무것도 안 움직인다 —
// 그건 정상이고, 화면이 "이 배치안엔 … 스테이션이 없어서 못 돌려요" 라고 말한다.
//
// 실물은 시연 녹화에서 온다 (`GOAL-imitation-demo.md`). **이건 시연용 흉내이고 배지가 그렇게 말한다.**
// **조립이다** (D63) — `stage` 가 **3 → 0** 으로 간다. 빈 케이싱에 신관이 붙어 완성품이 된다.
// 탄두는 리프터에서 안 움직인다: 14~36초가 전부 `lift` 이고 그동안 바뀌는 것은 `stage` 뿐이다.
// 팔 둘의 역할이 갈린다 — `pick`·`feed` 는 투입 팔, `join` 은 조립 팔, `hoist`·`drop` 은 크레인.
const ASSEMBLY_49 = [
  // **AMR 이 먼저 붙는다** — 팔레트를 채우고 나서야 팔이 집을 것이 생긴다.
  // `amr`/`amrAt` 은 작업물과 별개로 흐른다 (`SHARED-CORE.md` §1.5)
  { tSec: 0,  event: 'haul',  station: 'pile', stage: 3, pose: { feed: ['lowIdle', 'lowPile'] } },
  // AMR 은 **시각 0 에 도킹 자리에서 출발해** 여기서 팔레트에 닿는다 (그 사이를 화면이 잇는다)
  { tSec: 4,  event: 'pick',  station: 'pile', amr: 'amr1', amrAt: 'pile', stage: 3, pose: { feed: ['lowPile', 'lowBelt'] }, carry: 'feed' },
  { tSec: 9,  event: 'feed',  station: 'load', stage: 3, pose: { process: ['home', 'home'], feed: ['lowBelt', 'lowIdle'] } },   // 팔이 들고 가 컨베이어에 놓는다
  { tSec: 14, event: 'move',  station: 'lift', stage: 3, pose: { process: ['home', 'approach'], feed: ['lowIdle', 'lowIdle'] } },   // 컨베이어가 리프터까지 나른다
  { tSec: 17, event: 'hold',  station: 'lift', stage: 3, pose: { process: ['approach', 'grip'] } },   // 리프터가 밑에서 받쳐 공중으로
  // **작업물은 리프터에 있고 팔만 트레이로 간다** — `armAt` 이 그 둘을 가른다.
  //
  // **`fetch` 의 자세가 `home` 인 것은 지금 그렇게 돈다는 뜻이지 그게 옳다는 뜻이 아니다.**
  // 옛 전역 표에 `fetch` 칸이 아예 없어서 팔이 대기 자세로 서 있었고, 사건이 자세를 들게
  // 바꾸면서 **그 사실을 그대로 적었다** (2026-08-04). 화면 글자는 "신관을 가지러 간다" 인데
  // 팔은 안 간다 — 이제 이 두 줄만 고치면 된다. 그게 이 구조의 요점이다.
  { tSec: 20, event: 'fetch', station: 'lift', armAt: 'fuze', stage: 3, pose: { process: ['home', 'home'] } },
  { tSec: 24, event: 'join',  station: 'lift', stage: 2, pose: { process: ['grip', 'unscrew'] } },   // 가져와 결합
  { tSec: 28, event: 'fetch', station: 'lift', armAt: 'fuze', stage: 2, pose: { process: ['home', 'home'] } },
  { tSec: 32, event: 'join',  station: 'lift', stage: 1, pose: { process: ['grip', 'unscrew'] } },
  { tSec: 36, event: 'join',  station: 'lift', stage: 0, pose: { process: ['grip', 'unscrew'] } },   // 완성
  { tSec: 39, event: 'hoist', station: 'lift', stage: 0, pose: { process: ['retreat', 'home'] } },   // 크레인이 든다
  { tSec: 43, event: 'drop',  station: 'ship', stage: 0, pose: { process: ['home', 'home'] } },   // 배출 컨베이어에 내려놓는다
  { tSec: 49, event: 'out',   station: 'exit', stage: 0, pose: { process: ['home', 'home'] } },   // 실험실 밖으로
];

// 실셀 한 사이클 — **실측 3판 위에서 터틀봇이 나른다** (D140 · 실기 담당자 2026-08-20).
//
// `ASSEMBLY_49` 와 무대가 다르다. 저건 9:16 가상 방(리프터·크레인)이고 이건 **실측 작업대
// 3판**(`realmap`)이다. 그래서 나르는 것이 컨베이어가 아니라 **터틀봇**이고, 컨베이어 둘은
// 화면에만 있다 — 실물 운송은 터틀봇이고 동기화는 시계가 아니라 **진행률 결합**이다 (D135).
//
// **스테이션 id 는 카탈로그 6개를 그대로 쓴다** — 새 id 를 만들면 배치안에 놓을 카드가 없다:
//   pile ① = 1번 작업대 거치대1 — 탄피·탄두가 **분리된** 채 놓여 있다. 팔이 터틀봇에 싣는다
//   load ② = WP1 — 팔이 부품을 내리는 **시늉만** 한다. 컨베이어1 이 여기서 같이 돈다
//   lift ③ = WP2 = 2번 작업대 거치대2 — 탄피를 **진짜로** 놓고 탄두와 결합한다
//   ship ⑤ = WP4 = 3번 작업대 거치대3 — 완성품을 내려놓는다
//   exit ⑥ = 터틀봇이 **180° 돈 자세** — 역방향 **분리** 시나리오의 출발 자세다
// **WP3(코너)는 스테이션이 아니다** — 90° 오른쪽으로 도는 **경유점**이라 좌표(경로)에만 산다.
// `run-path` 가 점과 점을 직선으로 잇기 때문에 꺾이는 자리마다 점이 필요하다 (§경로).
//
// ⛔ **`tSec` 은 임시값이다.** 실주행을 아직 안 쟀다. 진짜 구간 경계는 시계가 아니라
// **터틀봇 도착·팔 완료 이벤트**이고(D135 진행률 결합), 그 어댑터는 아직 없다. 재고 나서 고친다.
// ⛔ **`pose` 를 안 적었다.** 팔을 실셀에서 아직 교시하지 않았다 — 없는 자세를 지어내면
// 화면이 거짓말을 한다(GAP «팔 6축 궤적» 과 같은 이유). ⚠ 다만 `migrateScenario` 가 저장분을
// 읽을 때 **event 이름으로 옛 무대(가상 방) 자세를 채운다** — 교시한 뒤 이름을 실셀 것으로 바꾼다.
// ⛔ **웨이포인트 좌표는 여기 없다.** 사건은 이름과 숫자만 든다(§1.7) — 좌표는 브리지의
// 경로 파일(odom)에 살고, 그 둘을 잇는 것이 위 대응표다.
const ASSEMBLY_AMR = [
  // ① 1번 작업대 — 팔이 거치대1 에서 하나씩 집어 터틀봇에 싣는다
  { tSec: 0,  event: 'pick', station: 'pile', amr: 'amr1', amrAt: 'pile', stage: 1, carry: 'process' },
  { tSec: 6,  event: 'feed', station: 'pile', amr: 'amr1', amrAt: 'pile', stage: 1 },
  // ② WP1 — 터틀봇이 가서 서고, 팔은 내리는 **시늉만** 한다
  { tSec: 12, event: 'haul', station: 'load', amr: 'amr1', amrAt: 'load', stage: 1 },
  { tSec: 18, event: 'feed', station: 'load', amr: 'amr1', amrAt: 'load', stage: 1 },
  // ③ WP2 — 컨베이어1 이 같이 돌고, 여기서부터 **진짜** 작업이다
  { tSec: 24, event: 'move', station: 'lift', amr: 'amr1', amrAt: 'lift', stage: 1 },
  { tSec: 30, event: 'hold', station: 'lift', stage: 1 },                                   // 탄피를 거치대2 에
  { tSec: 38, event: 'join', station: 'lift', stage: 0 },                                   // 탄두와 결합 = 완성
  { tSec: 44, event: 'pick', station: 'lift', stage: 0, carry: 'process' },                  // 완성품을 집어
  { tSec: 48, event: 'feed', station: 'lift', amr: 'amr1', amrAt: 'lift', stage: 0 },        // 터틀봇에 싣는다
  // ④ WP3 코너(경유) → WP4 — 컨베이어2 가 같이 돈다
  { tSec: 54, event: 'move', station: 'ship', amr: 'amr1', amrAt: 'ship', stage: 0 },
  { tSec: 66, event: 'drop', station: 'ship', stage: 0 },                                    // 거치대3 에 내려놓는다
  // ⑤ 180° 회전 — 여기가 역방향 **분리** 시나리오의 출발 자세다
  { tSec: 72, event: 'out',  station: 'exit', amr: 'amr1', amrAt: 'exit', stage: 0 },
];

// 컨베이어 시연 — **조립 없이** 싣기 → 주행 → 내리기만 (2026-09-06 · `docs/archive/GRILL-conveyor-twin-progresslog-2026-09-06.md` #1).
// `ASSEMBLY_AMR` 에서 조립 사건(hold·join)과 그 뒤 완성품 처리를 뺀 것이다. 터틀봇이 컨베이어 역할을 하고
// 팔 하나가 양끝에서 싣고 내린다. ⚠ 시간은 실시간이 아니라 사건 순서다 — 실시간 축은 시뮬 탭
// (`Shared/data/sim/cycle.js`)이 실측 속도로 낸다.
const HAUL_ONLY = [
  { tSec: 0,  event: 'pick', station: 'pile', amr: 'amr1', amrAt: 'pile', stage: 1, carry: 'process' },  // 거치대를 집어
  { tSec: 6,  event: 'feed', station: 'pile', amr: 'amr1', amrAt: 'pile', stage: 1 },                     // 터틀봇에 싣는다
  { tSec: 12, event: 'haul', station: 'load', amr: 'amr1', amrAt: 'load', stage: 1 },                     // 터틀봇이 나른다
  { tSec: 18, event: 'drop', station: 'load', stage: 1 },                                                 // 팔이 내려놓는다
  { tSec: 24, event: 'out',  station: 'exit', amr: 'amr1', amrAt: 'exit', stage: 1 },                     // 터틀봇이 돌아간다
];

// 방산 라인 한 사이클 — **컨베이어가 있는 무대의 것** (2026-08-20 · 실기 담당자 결정).
//
// 왜 따로 파나 — `ASSEMBLY_AMR` 은 **실셀**의 것이다. 실셀엔 컨베이어가 없어서 터틀봇이
// 작업대 셋 사이를 나른다. 그 시나리오를 컨베이어가 있는 무대에 얹으면 **운송 수단이 둘**이
// 되고, 08-20 하루 동안 겪은 마찰이 전부 거기서 나왔다:
//   · 터틀봇이 컨베이어를 타고 다녔다 (자리가 컨베이어 줄인데 `amrAt` 이 그 자리를 가리켜서)
//   · 터틀봇이 6초 뒤부터 할 일 없이 컨베이어를 따라다녔다
//   · 투입 팔이 **다른 무대에서 가르친 자세**라 몸이 뒤로 접혔다 (잔차 240mm)
//
// **역할을 갈랐다** — 실제 라인이 그렇게 한다:
//   터틀봇 = 라인에 **대주는** 것 (원점 → 하차 → 퇴장 · 직진 한 번)
//   컨베이어 = 라인 **안에서** 나르는 것
//   팔 = 터틀봇 ↔ 컨베이어 사이를 옮기고, 조립하고, 완성품을 내린다
//
// **자리 다섯을 그대로 쓴다** — `assembly-amr` 과 같은 id 라 배치안을 갈아 끼울 수 있다.
//
// ⭐ **`pose` 를 두 역할에 같은 값으로 넣는다.** 어느 팔이 `feed` 인지는 화면이
// 「`load` 에 닿느냐」로 정하는데(`layout-view.js feedArmIds()`), 팔이 하나면 그 판정에 따라
// 자세표가 통째로 갈린다. 같은 값을 두 칸에 넣으면 **어느 쪽으로 판정되든 같은 자세**가 선다.
// ⛔ **자세를 지어낸 것이 아니다** — 이름은 전부 교시된 자세이고, 고른 것은 「어느 사건에
// 어느 자세를 쓰나」뿐이다. `POSE_AT` 전역 표가 하던 일과 같은 종류다.
const both = (a, b) => ({ process: [a, b], feed: [a, b] });
const ASSEMBLY_CONV = [
  // ① 터틀봇이 라인에 대준다 — 팔은 마중 나가는 자세로 미리 내려간다
  { tSec: 0,  event: 'haul', station: 'pile', amr: 'amr1', amrAt: 'pile', stage: 1, pose: both('home', 'approach') },
  // ② 팔이 터틀봇에서 집는다
  { tSec: 6,  event: 'pick', station: 'pile', amr: 'amr1', amrAt: 'pile', stage: 1, carry: 'feed', pose: both('approach', 'grip') },
  // ③ 컨베이어 투입구에 올린다 — **여기서부터 라인이 나른다**
  { tSec: 12, event: 'feed', station: 'load', stage: 1, pose: both('grip', 'home') },
  // ④ 컨베이어가 조립 자리로
  { tSec: 18, event: 'move', station: 'lift', stage: 1, pose: both('home', 'home') },
  { tSec: 24, event: 'hold', station: 'lift', stage: 1, pose: both('home', 'approach') },
  { tSec: 32, event: 'join', station: 'lift', stage: 0, pose: both('grip', 'unscrew') },   // 결합 = 완성
  // ⑤ 완성품을 집어 배출 자리로
  { tSec: 38, event: 'pick', station: 'lift', stage: 0, carry: 'feed', pose: both('unscrew', 'grip') },
  { tSec: 44, event: 'drop', station: 'ship', stage: 0, pose: both('grip', 'home') },
  // ⑥ 터틀봇이 나간다 — 들어올 때와 같은 통로를 계속 직진한다
  { tSec: 50, event: 'out',  station: 'exit', amr: 'amr1', amrAt: 'exit', stage: 0, pose: both('home', 'home') },
];

/** 드롭다운의 `새로 ▾` 에 뜨는 순서 = 이 배열 순서. */
export const SCENARIO_PRESETS = [
  // **빈 방에는 빈 시나리오.** 전에는 빈 방에도 조립 라인 사건 13개가 딸려 와서, 자리
  // 6개를 다 놓기 전에는 아무것도 못 돌았다 — 빈 방에서 짓기 시작한 사람이 "왜 안 되지"
  // 로 막힌다 (실기 담당자 실사용 · 2026-08-04). 사건은 시나리오 탭에서 하나씩 더한다.
  { id: 'blank', label: '빈 시나리오',
    hint: '사건이 없다 — 시나리오 탭에서 하나씩 더한다', build: () => [] },
  { id: 'assembly49', label: '조립 라인 · 49초',
    hint: 'AMR 투입 → 컨베이어 → 리프터에서 신관 3번 결합 → 크레인이 배출로',
    build: () => ASSEMBLY_49.map((e) => ({ ...e })) },
  // **실측 3판 위에서 도는 것.** `realmap` 배치안과 짝이다 — 무대가 실물이라 나르는 것도
  // 컨베이어가 아니라 터틀봇이다. 자세·시각은 아직 임시다 (위 머리말의 ⛔ 둘).
  { id: 'assembly-conv', label: '방산 라인 조립 · 컨베이어',
    hint: '터틀봇이 라인에 대주고(직진 한 번) 컨베이어가 나른다 — 팔 하나가 터틀봇↔컨베이어를 옮기고 조립한다',
    build: () => ASSEMBLY_CONV.map((e) => ({ ...e, pose: { ...e.pose } })) },
  { id: 'assembly-amr', label: '실셀 조립 · 터틀봇 왕복',
    hint: '1번 거치대 적재 → WP1 하차 시늉 → WP2 조립 → 코너 90° → WP4 하차 → 180° 분리 준비',
    build: () => ASSEMBLY_AMR.map((e) => ({ ...e })) },
  { id: 'haul-only', label: '컨베이어 시연 · 싣기→주행→내리기',
    hint: '조립 없음 — 터틀봇이 컨베이어다. 팔이 싣고, 터틀봇이 나르고, 팔이 내린다 (시뮬 탭 「컨베이어 한 사이클」과 같은 이야기)',
    build: () => HAUL_ONLY.map((e) => ({ ...e })) },
];

export const DEFAULT_SCENARIO = 'assembly49';

/** 프리셋 하나를 **완전한 시나리오**로. 꺼낸 뒤로는 프리셋과 인연이 끊긴다. */
export function buildScenario(presetId = DEFAULT_SCENARIO, id = presetId, name) {
  const p = SCENARIO_PRESETS.find((x) => x.id === presetId) ?? SCENARIO_PRESETS[0];
  return { ...emptyScenario(id, name ?? p.label), events: p.build() };
}
