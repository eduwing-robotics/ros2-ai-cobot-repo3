// 부품 카탈로그 — **팔레트가 무엇을 보여줄지의 SSOT.**
//
// 형태는 `Shared/view3d/parts.js` 에, **이름·분류는 여기**에 있다.
// 렌더링이 없으므로 `data/` 에 산다 (`BUILD-VITE.md` §Shared 는 두 층이다).
//
// **새 부품 = 여기 한 줄.** 팔레트도 게이트도 이 배열에서 파생하므로,
// 목록을 두 곳에 적으면 반드시 한 곳이 낡는다.
//
// `scripts/check/layout.sh` 가 **양방향으로** 검사한다 —
// 카탈로그에 있는데 팩토리가 없거나, 팩토리가 있는데 카탈로그에 없으면 실패한다.

/** 팔레트 표시 순서 = 배열 순서. 빈 분류는 팔레트가 자동으로 숨긴다. */
export const CATEGORIES = [
  { id: 'shell',  label: '방 껍데기' },
  { id: 'line',   label: '조립 라인' },
  { id: 'safety', label: '안전' },
  { id: 'bench',  label: '작업대·보관' },
  { id: 'equip',  label: '장비' },
  { id: 'work',   label: '작업물' },
  { id: 'robot',  label: '로봇', note: '놓고 클릭하면 경로·자세를 켤 수 있어요' },
  { id: 'spot',   label: '작업 지점', note: '끌어다 바닥에 놓으세요. ①→⑥ 순서가 라인입니다' },
];

/**
 * `id` 는 `PROPS` 의 키와 **같아야 한다** (게이트가 강제).
 *
 * - `label`  화면에 보이는 이름. 한국어
 * - `hint`   카드 아래 한 줄. 없으면 생략
 * - `opts`   놓을 때 쓸 기본 인자. 없으면 팩토리 기본값
 * - `mount`  `'floor'`(기본) · `'wall'`(벽에 건다) · `'bench'`(작업대 위)
 *            — 놓는 높이가 다르다. 팔레트가 배지로 알려준다
 * - `status` `'legacy'` 면 팔레트에 안 뜬다. **지우지 않는 이유** — 옛 배치안이
 *            그 이름을 들고 있으면 화면이 빈 자리가 된다
 * - `kind`   `'prop'`(기본) · `'door'` · `'window'` — **데이터가 사는 곳이 다르다.**
 *            소품은 `layout.props`, 문·창은 `layout.doors`/`windows` 이고 벽에 구멍을 뚫는다.
 *            그래서 끌어서 못 옮기고 **어느 벽 · 벽 위 몇 mm** 로 고친다.
 *            `'station'` 은 **자리**다 — `layout.stations` 에 살고, 시나리오가 이 id 로 부른다
 */
export const CATALOG = [
  // ── 방 껍데기. 벽은 `floor` 치수에서 자동으로 나오므로 팔레트에 없다.
  { id: 'door',   label: '문',   category: 'shell', kind: 'door',
    hint: '벽에 낸 구멍이에요 · 유리 두 짝이에요', opts: { widthMm: 1200, heightMm: 2100 } },
  { id: 'window', label: '창',   category: 'shell', kind: 'window',
    hint: '벽 위쪽 · 아래는 벽이 남아요', opts: { widthMm: 1600, heightMm: 1300, sillMm: 900 } },

  // ── 조립 라인 (D51·D63)
  { id: 'conveyor',  label: '컨베이어',    category: 'line', hint: '롤러로 옮겨요 · 끝을 낮추면 로봇차가 올려요' },
  { id: 'lifter',    label: '리프트 클램프', category: 'line', hint: '밑에서 받쳐 공중으로 들어요' },
  { id: 'chuck',     label: '회전 척',     category: 'line', mount: 'bench', hint: '탄두를 물고 돌려요' },
  { id: 'partTray',  label: '부품 트레이', category: 'line', mount: 'bench', hint: '신관과 부품을 놓는 자리예요' },
  { id: 'crane',     label: '갠트리 크레인', category: 'line', mount: 'ceiling',
    hint: '천장을 가로질러요 · 규모가 여기서 나와요' },
  { id: 'ammoPallet', label: '탄약 팔레트', category: 'line', hint: '낮아요 · 로봇차가 붙는 높이예요' },

  // ── 안전
  { id: 'blastWall',   label: '방폭 격벽', category: 'safety', hint: '허리 높이라 안을 가리지 않아요' },
  { id: 'safetyFence', label: '안전 펜스', category: 'safety', hint: '유리 세 면이고 앞으로 드나들어요' },
  { id: 'beacon',      label: '경고 비콘', category: 'safety', hint: '작은데 신호가 세요' },

  // ── 작업대·보관
  { id: 'bench',       label: '작업대',   category: 'bench' },
  { id: 'benchRun',    label: '작업대 열', category: 'bench', hint: '길이를 늘리면 하부장이 이어져요' },
  { id: 'shelf',       label: '선반',     category: 'bench' },
  { id: 'wallCabinet', label: '상부장',   category: 'bench', mount: 'wall' },

  // ── 장비
  { id: 'isolator',    label: '차폐 부스', category: 'equip', hint: '멀리서 다루는 방이에요' },
  { id: 'instrument',  label: '검사 장비', category: 'equip' },
  { id: 'workstation', label: '제어반',   category: 'equip', mount: 'bench' },
  // 2026-08-31 에 팩토리만 만들고 카드를 안 만들어 **팔레트에 영영 안 떴다**(게이트가 잡았다).
  // 치수는 `props.js` 의 `CARRIER`·`AMR_BASKET` 이 정본이라 여기 숫자를 적지 않는다.
  { id: 'carrier',     label: '거치대(총알)', category: 'work',  mount: 'bench' },
  { id: 'amrBasket',   label: '초록 바구니',  category: 'work',  mount: 'bench' },
  { id: 'worker',      label: '작업자',   category: 'equip', hint: '크기 기준이에요 · 방이 얼마나 큰지 보여요' },

  // ── 작업물
  { id: 'warhead', label: '탄두 (완성)',    category: 'work', mount: 'bench', opts: { stage: 0 }, hint: '화면 표시용이에요 · 실물은 페트병이에요' },
  { id: 'warhead', label: '탄두 (신관 분리)', category: 'work', mount: 'bench', opts: { stage: 2 }, key: 'warhead-s2' },
  // 더미탄 — **실측 치수 그대로다** (`data/props.js ROUND` · 자 2026-08-11).
  // 크기 인자를 안 연다: 77mm 는 `SIZE_RANGE_MM.min` 100 보다 작아 칸이 뜻을 잃는다
  { id: 'round', label: '더미탄 (결합)', category: 'work', mount: 'bench', opts: { gapMm: 0 },
    hint: '7.92×57 모형 · 77×10mm 실측 · 탄피와 탄두 두 조각이에요' },
  { id: 'round', label: '더미탄 (분해)', category: 'work', mount: 'bench', opts: { gapMm: 18 }, key: 'round-split' },

  // ── 옛 실험실 소품. 해체 라인엔 안 맞아 팔레트에서 숨긴다 (S1)
];

/** 팔레트에 실제로 뜨는 것 — `legacy` 를 뺀 목록. */
/**
 * **자리 — 시나리오가 부르는 이름이다.**
 *
 * 소품은 "무엇이 놓여 있나" 이고 자리는 **"여기서 무슨 일을 하나"** 다. 그래서 이름을
 * 자유로 못 쓴다 — 시나리오(`series`)가 `pile`·`lift` 같은 **정해진 id** 로 부르고,
 * 배치안에 그 id 가 없으면 재생이 아무것도 안 한다 (실기 담당자 맵에서 실제로 그랬다 · 2026-08-04).
 *
 * 그래서 팔레트가 **역할 카드**를 준다. 사람이 이름을 짓는 게 아니라 역할을 고르는 것이다.
 * 한 배치안에 같은 역할이 둘일 수 없다 — 시나리오가 어느 쪽을 부르는지 알 수 없어진다.
 *
 * `prop` 을 주면 그 자리에 부품도 같이 선다. `zMm` 은 **작업물이 오는 높이**이고,
 * `baseMm` 은 부품이 놓이는 높이다 (리프터는 바닥에 서고 작업물만 공중에 있다).
 */
Object.assign(CATALOG, {});
CATALOG.push(
  // **AMR 을 팔레트에서 놓을 수 있어야 한다.** 전에는 프리셋에만 있어서 빈 방에서
  // 시작하면 터틀봇을 **추가할 방법이 아예 없었다** (실기 담당자 지적 · 2026-08-04).
  { id: 'amr', kind: 'amr', category: 'robot', label: '터틀봇 (AMR)',
    hint: '놓고 클릭하면 다닐 길을 그릴 수 있어요', reachMm: 380 },
  // **번호가 곧 순서다** — 어디에 놓을지 몰라 헤매던 것이 이 목록의 첫 결함이었다
  // (실기 담당자 지적 · 2026-08-04). `hint` 는 **무엇을 하나가 아니라 어디에 놓나**를 말한다.
  { id: 'pile', kind: 'station', category: 'spot', label: '① 탄체 더미',
    hint: '투입 팔이 닿는 곳이에요 · 로봇차가 여기로 와요', prop: 'ammoPallet', baseMm: 0, zMm: 500, rotDeg: 90 },
  { id: 'load', kind: 'station', category: 'spot', label: '② 컨베이어 투입구',
    hint: '컨베이어 낮은 끝 위예요 · 투입 팔이 닿아요', zMm: 400 },
  { id: 'lift', kind: 'station', category: 'spot', label: '③ 조립 자리',
    hint: '컨베이어 가운데예요 · 조립 팔이 닿아요', prop: 'lifter', baseMm: 0, zMm: 1050,
    opts: { wMm: 700, liftMm: 1050 } },
  { id: 'fuze', kind: 'station', category: 'spot', label: '④ 신관 놓는 곳',
    hint: '조립 자리 옆 작업대 위예요', prop: 'partTray', zMm: 900,
    opts: { wMm: 560, dMm: 380, cols: 4, rows: 3 } },
  { id: 'ship', kind: 'station', category: 'spot', label: '⑤ 완성품 내려놓는 곳',
    hint: '배출 컨베이어가 시작하는 자리예요', zMm: 900 },
  { id: 'exit', kind: 'station', category: 'spot', label: '⑥ 나가는 곳',
    hint: '배출 컨베이어 끝이에요 · 벽 구멍 앞이에요', zMm: 900 },
);

/** 자리 카드만 — 게이트와 화면이 "정해진 역할" 목록으로 쓴다. */
export const STATION_CARDS = CATALOG.filter((c) => c.kind === 'station');

export const VISIBLE = CATALOG.filter((c) => c.status !== 'legacy');

/** 소품만 — 게이트가 `PROPS` 와 대조하는 대상. 문·창은 팩토리가 없다. */
export const PROP_CARDS = CATALOG.filter((c) => (c.kind ?? 'prop') === 'prop');

export const kindOf = (c) => c.kind ?? 'prop';

/** 카드 하나를 고유하게 가리키는 값. 같은 `id` 를 옵션만 달리해 여러 장 둘 수 있다. */
export const cardKey = (c) => c.key ?? c.id;

/** 놓을 때의 바닥 높이(mm). `mount` 가 정한다 — 작업대 상판은 900 이다. */
export const BENCH_TOP_MM = 900;
export function mountZMm(c) {
  if (c.mount === 'bench') return BENCH_TOP_MM;
  if (c.mount === 'wall') return 0;      // 벽걸이는 팩토리가 `baseMm` 으로 스스로 올라간다
  return 0;
}

/**
 * AMR 실물 겉치수(mm). **이건 스타일이 아니라 측정값이다** — 도킹 간격·통로 폭·간섭 판정이
 * 전부 이 발자국에서 나오므로, 틀리면 배치 판정이 조용히 거짓말을 한다.
 *
 * 실물은 **TurtleBot3 Burger ×2** 다 (`TB-CONTRACT.md` §하드웨어).
 * 출처·검증 상태는 `STACK.md` §TurtleBot3 겉치수에 등재했다 (하드 룰 · /스택가드).
 *
 * ⚠ 전에는 화면이 `280 × 300 × 190` 을 그렸다 — **Waffle Pi 발자국(281×306)에 Burger 높이**를
 * 섞은 값이라 바닥 면적이 실물의 **3.4배**였고, 게다가 라이다를 몸통 위에 얹어 전체 높이가
 * 280mm 로 사양(192)보다 88mm 높았다 (2026-08-07 · `docs/evidence/2026-08-07/amr-burger-mm.md`).
 *
 * `heightMm` 은 **라이다 포함 전체**다 — 사양서가 그렇게 잰다. 몸통·라이다로 어떻게 쪼개든
 * 겉면이 이 값이어야 한다.
 */
export const AMR_MM = { widthMm: 178, depthMm: 138, heightMm: 192 };
/**
 * 바퀴 반지름 — ROBOTIS TurtleBot3 Burger 사양(바퀴 지름 66mm · `turtlebot3_burger.urdf` wheel 관절 z 0.033 = 바닥에서 축까지).
 * 화면의 바퀴 회전각 = 굴러간 거리 ÷ 이 값 (`Shared/view3d/burger.js` `rollWheels` · 2026-09-06 · `GRILL-conveyor-twin` #8).
 */
export const AMR_WHEEL_R_MM = 33;

// ── 크기 손잡이 ──────────────────────────────────────────────────────────────
//
// **부품마다 인자 이름이 다르다** — `lengthMm` · `wMm` · `diaMm`. 화면이 그걸 알아야
// 고른 물건의 크기를 고칠 수 있다. 여기 적힌 키는 **팩토리 인자 이름 그대로**이고,
// 값은 그 물건의 `opts` 로 들어간다 (하드 룰 5 — 단위는 mm 한 곳).
//
// `scripts/check/layout.sh` 가 **키마다 실제로 형태가 바뀌는지** 확인한다.
// 오타가 나면 화면에 칸은 뜨는데 아무 일도 안 일어난다 — 그게 제일 나쁜 실패다.

/** 인자 이름 → 사람 말. 부품이 달라도 같은 이름은 같은 뜻이다. */
export const SIZE_LABEL = {
  lengthMm: '길이', wMm: '폭', dMm: '깊이', hMm: '높이',
  diaMm: '지름', tMm: '두께', baseMm: '설치높이',
};

/** 부품 → 고칠 수 있는 치수. **순서가 화면 순서다.** */
export const SIZE_MM = {
  bench:       ['wMm', 'dMm', 'hMm'],
  benchRun:    ['lengthMm', 'dMm', 'hMm'],
  wallCabinet: ['lengthMm', 'dMm', 'hMm', 'baseMm'],
  shelf:       ['wMm', 'dMm', 'hMm'],
  isolator:    ['wMm', 'dMm', 'hMm'],
  instrument:  ['wMm', 'dMm', 'hMm'],
  workstation: ['wMm', 'hMm'],
  safetyFence: ['wMm', 'dMm', 'hMm'],
  conveyor:    ['lengthMm', 'wMm', 'hMm'],
  lifter:      ['wMm', 'dMm', 'hMm'],
  blastWall:   ['lengthMm', 'hMm', 'tMm'],
  beacon:      ['hMm'],
  crane:       ['lengthMm', 'dMm', 'baseMm'],
  worker:      ['hMm'],
  ammoPallet:  ['wMm', 'dMm'],
  chuck:       ['diaMm', 'hMm'],
  partTray:    ['wMm', 'dMm'],
  warhead:     ['diaMm', 'lengthMm'],
};

/** 크기 칸의 범위. **한 곳에서만 정한다** — 부품마다 다른 한계를 두면 아무도 못 외운다. */
export const SIZE_RANGE_MM = { min: 100, max: 12000, step: 100 };

/**
 * 치수 키 → **재서 읽을 축**. 화면이 현재 값을 보여줄 때 쓴다 (`sizeMmOf`).
 *
 * 뜻이 축에 묶여 있어 안 흔들린다 — `hMm` 은 어느 부품에서든 높이다.
 * `null` 은 잰 값으로 대신할 수 없는 것(설치 높이 같은 위치 인자)이다.
 */
export const SIZE_AXIS = {
  lengthMm: 'x', wMm: 'x', diaMm: 'x',
  dMm: 'z', tMm: 'z',
  hMm: 'y',
  baseMm: null,
};
