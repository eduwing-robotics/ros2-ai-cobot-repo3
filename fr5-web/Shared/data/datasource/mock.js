// 목업 출처 — **화면은 이 파일의 존재를 모른다.** `index.js` 한 줄이 이걸 고른다.
//
// 계약은 `LAYOUT-METRICS-CONTRACT.md` 다. 메서드 이름이 거기 REST 경로와 1:1 이라
// `http.js` 를 붙일 때 **화면이 안 바뀐다** — 그게 이 경계의 완료 판정이다.
//
//   GET    /layouts             → getLayouts()      목록만 (전문이 아니다)
//   GET    /layouts/{id}        → getLayout(id)
//   PUT    /layouts/{id}        → putLayout(L)
//   DELETE /layouts/{id}        → deleteLayout(id)
//   GET    /layouts/{id}/series → getSeries(layoutId)
//                               → getMetrics(layoutId)
//
// **천장** — 저장이 `localStorage` 라 이 브라우저 안에서만 산다. 팀 공유는 D46(이관 H)이고,
// 그때 바뀌는 것은 `index.js` 의 한 줄이다. 화면은 그 사실을 겪지 않는다.

import { migrateLayout } from '../layout/schema.js';
import { migrateScenario } from '../scenario/schema.js';
import { buildScenario, DEFAULT_SCENARIO } from '../scenario/presets.js';
import { migratePoseSet } from '../motion/schema.js';
import { buildPoseSet, DEFAULT_POSE_SET, POSE_PRESETS } from '../motion/presets.js';
import { SCENARIO_PRESETS } from '../scenario/presets.js';

/** 프리셋 id 집합 — 저장 전에도 그 id 로 물으면 내용을 낸다 */
const SCENARIO_IDS = new Set(SCENARIO_PRESETS.map((p) => p.id));
const POSESET_IDS = new Set(POSE_PRESETS.map((p) => p.id));
import { cycleSecOf, taskSignatureOf } from '../timeline/timeline.js';

const KEY = 'fr5.scenes';
// **시나리오는 따로 둔다.** 배치안에 넣으면 편집할 때마다 딸려 와 저장이 부푼다
// (`LAYOUT-METRICS-CONTRACT.md`). 배치안은 `scenarioId` 로 가리키기만 한다.
const SKEY = 'fr5.scenarios';
// 자세도 따로 둔다 — 배치안 A·B 가 같은 보관함을 가리킬 수 있어야 한다 (F8)
const PKEY = 'fr5.posesets';

/**
 * 보관함을 읽는다. **깨졌으면 조용히 빈 것으로 시작한다** —
 * 편집기가 아예 안 뜨는 것보다 낫다.
 *
 * 옛 모양(`{current, scenes}`)도 읽는다. `current` 는 이제 URL 이 들고 있어서 버린다 —
 * 그건 데이터가 아니라 이 탭이 무엇을 보고 있나이기 때문이다.
 */
function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object' && v.scenes && typeof v.scenes === 'object') {
      // **옛 모양을 여기서 한 번만 올린다.** 저장소에서 나오는 길목이 여기뿐이라,
      // 화면과 게이트는 언제나 지금 모양만 본다 (하드 룰 5).
      return Object.fromEntries(
        Object.entries(v.scenes).map(([id, L]) => [id, migrateLayout(L)]),
      );
    }
  } catch { /* 무시 */ }
  return {};
}

/**
 * 시나리오 보관함. **깨졌으면 조용히 빈 것으로 시작한다** — 배치안 `read()` 와 같은 규칙이다.
 * 시나리오가 없으면 프리셋으로 떨어지므로 빈 것이 곧 정상 동작이다.
 */
function readScenarios() {
  try {
    const v = JSON.parse(localStorage.getItem(SKEY) ?? 'null');
    if (v && typeof v === 'object' && v.items && typeof v.items === 'object') {
      return Object.fromEntries(
        Object.entries(v.items).map(([id, S]) => [id, migrateScenario(S)]),
      );
    }
  } catch { /* 무시 */ }
  return {};
}

function writeScenarios(items) {
  localStorage.setItem(SKEY, JSON.stringify({ items }));
}

/** 자세 보관함. **깨졌으면 조용히 빈 것으로 시작한다** — 시나리오 `readScenarios()` 와 같다. */
function readPoseSets() {
  try {
    const v = JSON.parse(localStorage.getItem(PKEY) ?? 'null');
    if (v && typeof v === 'object' && v.items && typeof v.items === 'object') {
      return Object.fromEntries(
        Object.entries(v.items).map(([id, P]) => [id, migratePoseSet(P)]),
      );
    }
  } catch { /* 무시 */ }
  return {};
}

function writePoseSets(items) {
  localStorage.setItem(PKEY, JSON.stringify({ items }));
}

/** **실패를 삼키지 않는다** — 사파리 프라이빗·용량 초과에서 던지고, 화면이 그걸 말한다. */
function write(scenes) {
  localStorage.setItem(KEY, JSON.stringify({ scenes }));
}

// 지표 목업 — `LAYOUT-METRICS-CONTRACT.md` §요구 모양 그대로다.
//
// **`B` 는 선택 필드를 일부러 뺐다.** 팀원이 처리량 하나만 내도 화면이 그날 도는지를
// 목업이 미리 겪게 하는 것이 이 파일의 절반이다 (SR_25). 지우면 그 검증이 사라진다.
const METRICS = {
  A: {
    layoutId: 'A',
    source: 'mock',
    cycles: 120,
    durationSec: 3600,
    metrics: {
      throughputPerHour: 120.0,
      cycleTimeSec: { mean: 30.0, p50: 29.1, p95: 38.4 },
      amrTravelMm: 480000,
      waitSec: { arm: 220, amr: 640 },
      interferences: 3,
    },
  },
  B: {
    layoutId: 'B',
    source: 'mock',
    cycles: 96,
    durationSec: 3600,
    metrics: {
      throughputPerHour: 96.0,
      cycleTimeSec: { mean: 37.5 },     // p50·p95 없음 — 화면은 그 칸만 비워야 한다
      // amrTravelMm · waitSec · interferences 없음
    },
  },
};


// ── 동작 — **같은 배치·같은 작업, 다른 움직임** (F10 · 2026-08-13) ───────────
//
// PRD 와우모먼트: *"같은 조립 작업의 시퀀스 타임이 **사람 시연 → 후처리 → 정책** 순으로
// 줄어드는 것을 나란히 보여준다."*
//
// ⛔ **목업이다. 그리고 화면이 배지로 그렇게 말한다.** 실물 궤적은 시연 녹화(모방학습 사다리 2)가
//    내고 그건 로봇을 탄다. 여기 두 벌은 **같은 사건 표 위에 자세 경로와 시간만 얹은 것**이다.
//
// ⛔ **사건·스테이션·단계를 안 건드린다.** 그래야 `taskSignatureOf` 가 두 벌을 **같은 작업**으로
//    보증한다 — 다른 작업의 시퀀스 타임을 나란히 놓으면 숫자가 거짓말을 한다 (골 §blocked).
//    바꾸는 것은 **`tSec` 배율**과 **조립 팔 `pose` 경로** 둘뿐이다.
//
// ⚠ **세 번째(`policy`)를 지어내지 않는다.** 정책은 모방학습 사다리 4가 있어야 나오고, 없는
//    능력을 화면에 세우면 그건 계측이 아니라 연출이다. 둘만으로 이 골은 성립한다 (골 §천장).
const MOTION_SPEC = [
  {
    id: 'demo',
    label: '사람 시연',
    source: 'demo',
    note: '직접교시로 끈 그대로 — 중간 자세를 다 밟고 매번 되돌아온다',
    timeScale: 1.35,
    // 사람이 끄는 팔은 팔꿈치를 먼저 들고 손목을 나중에 맞춘다. 자세 **일곱**을 거친다
    process: {
      feed: ['home', 'lift'],
      move: ['lift', 'approach'],
      hold: ['approach', 'preGrip'],
      fetch: ['preGrip', 'grip'],
      join: ['grip', 'unscrew'],
      hoist: ['unscrew', 'retreat'],
      drop: ['retreat', 'lift'],
      out: ['lift', 'home'],
    },
  },
  {
    id: 'postproc',
    label: '다듬은 궤적',
    source: 'postproc',
    note: '중간 자세를 접고 곧장 간다 — 되돌아옴을 뺐다',
    timeScale: 1,
    // 같은 일을 자세 **넷**으로 한다. `fetch` 가 제자리인 것이 후처리의 이득이다
    process: {
      feed: ['home', 'home'],
      move: ['home', 'approach'],
      hold: ['approach', 'grip'],
      fetch: ['grip', 'grip'],
      join: ['grip', 'unscrew'],
      hoist: ['unscrew', 'home'],
      drop: ['home', 'home'],
      out: ['home', 'home'],
    },
  },
];

/**
 * 사건 하나에 동작 프로파일을 얹는다. **`tSec` 과 조립 팔 자세만 바뀐다.**
 * `feed`(투입 팔)·`amr`·`stage` 는 그대로 둔다 — 그게 「같은 작업」의 몸통이다.
 */
const applyMotion = (e, spec) => ({
  ...e,
  tSec: Number((e.tSec * spec.timeScale).toFixed(2)),
  pose: e.pose
    ? { ...e.pose, ...(spec.process[e.event] ? { process: spec.process[e.event] } : {}) }
    : e.pose,
});

export const datasource = {
  /** 이 출처가 무엇인지. **화면이 배지로 띄운다** — 목업을 실측으로 오인하는 것이 가장 비싼 사고다 */
  source: 'mock',

  /** 목록만. 전문을 다 싣지 않는 것은 계약이 그렇게 생겼기 때문이다 */
  async getLayouts() {
    return Object.values(read()).map((s) => ({ id: s.id, name: s.name, verified: !!s.verified }));
  },

  async getLayout(id) {
    return read()[id] ?? null;
  },

  async putLayout(layout) {
    const all = read();
    all[layout.id] = layout;
    write(all);
  },

  async deleteLayout(id) {
    const all = read();
    delete all[id];
    write(all);
  },

  /**
   * 배치안 하나의 실행 결과. **없으면 `null`** — 아직 안 돌려본 배치안이 정상이다.
   * 수치는 팀원 알고리즘이 만든다. 우리는 받아서 보여준다 (`ARCHITECTURE.md` §우리 몫).
   */
  async getMetrics(layoutId) {
    return METRICS[layoutId] ?? null;
  },

  /**
   * 돌려본 **회차** 목록. F8 비교 화면이 고르는 대상이다.
   *
   * ⛔ **비교는 배치안이 아니라 회차끼리 한다.** 안 돌려본 배치안은 비교할 게 없고
   * (`getMetrics` 가 `null` 을 내는 것과 같은 이유), 배치안 목록으로 고르게 하면 새 브라우저에서
   * 저장분이 0개라 화면이 빈 채로 뜬다 — 2026-08-13 실렌더 게이트가 그걸 잡았다.
   *
   * 실물이 오면 이 함수가 서버 목록을 내고 화면은 안 바뀐다.
   */
  async getRuns() {
    return Object.values(METRICS)
      .map((r) => ({ layoutId: r.layoutId, source: r.source, cycles: r.cycles }));
  },

  /**
   * 이 배치안을 **어떤 움직임들로** 돌려봤나 (F10). 목록만 — 전문은 `getMotionSeries` 다.
   *
   * 시퀀스 타임을 여기서 세어 실어 보낸다. 화면이 목록만 받고도 표를 세울 수 있어야
   * 「하나뿐이면 그렇게 말한다」가 성립한다 (골 Outcome 3).
   */
  async getMotions(layoutId) {
    if (!layoutId) return [];
    const base = (await this.getSeries(layoutId)).series;
    if (!base.length) return [];
    return MOTION_SPEC.map((spec) => {
      const series = base.map((e) => applyMotion(e, spec));
      return {
        id: spec.id,
        label: spec.label,
        source: spec.source,
        note: spec.note,
        cycleSec: cycleSecOf(series),
        events: series.length,
        // **무슨 작업인가의 지문.** 이게 서로 다르면 화면이 나란히 놓지 않는다 (골 Outcome 5)
        task: taskSignatureOf(series),
        // 거친 자세 종류 — 「사람 시연이 더 많이 움직인다」가 숫자로 보이는 자리
        poses: new Set(series.flatMap((e) => e.pose?.process ?? [])).size,
      };
    });
  },

  /** 동작 한 벌의 시간축. `getSeries` 와 **같은 모양**이라 재생기가 그대로 받는다. */
  async getMotionSeries(layoutId, motionId) {
    const spec = MOTION_SPEC.find((m) => m.id === motionId);
    const base = await this.getSeries(layoutId);
    if (!spec) return base;
    const series = base.series.map((e) => applyMotion(e, spec));
    return { ...base, source: spec.source, motionId: spec.id, cycleSec: cycleSecOf(series), series };
  },

  /**
   * 한 사이클의 시간축. **배치안이 있으면 언제나 돌려준다** — 아직 안 돌려본 배치안이라도
   * 시연용 사이클을 태워 볼 수 있어야 화면이 오늘 돈다.
   *
   * `getMetrics` 와 다르게 `null` 을 잘 안 내는 이유가 이것이다 — 지표는 **잰 값**이라
   * 없으면 없는 것이고, 사이클은 **무대의 정의**라 목업이 성립한다.
   */
  /**
   * 이 배치안을 지금 **무엇으로 돌리나.** `scenarioId` → 저장분 → 프리셋 순으로 해결한다.
   *
   * **해결 규칙이 여기 한 곳에 있다.** 화면이 이걸 알면 화면마다 규칙이 갈라지고,
   * 그때부터 "왜 저 탭만 다른 사이클이 도나" 를 아무도 못 푼다.
   */
  async getSeries(layoutId) {
    if (!layoutId) return { source: 'mock', cycleSec: 0, series: [] };
    const L = read()[layoutId];
    const saved = readScenarios();
    // **가리키는 것을 저장분 → 프리셋 순으로 찾는다.** 프리셋을 안 보면 배치안이 `blank`
    // 을 가리켜도 못 찾아 조립 라인으로 떨어진다 — 빈 방에 사건 13개가 딸려 왔다 (2026-08-04).
    // 그래도 못 찾으면 기본값이다: **가리키는 시나리오가 지워져도 화면이 안 죽는다.**
    const want = L?.scenarioId;
    const S = (want && saved[want])
      || (want && SCENARIO_IDS.has(want) && buildScenario(want))
      || buildScenario(DEFAULT_SCENARIO);
    // **정렬하지 않고 저장된 순서 그대로 낸다.** 편집기가 사건을 **번호로** 집는데
    // 여기서 정렬하면 화면이 보는 번호와 저장된 번호가 어긋나 **엉뚱한 사건이 고쳐진다.**
    // 순서는 `stateAt`·`cycleSecOf` 가 스스로 잡으므로 재생은 영향이 없다.
    const events = S.events ?? [];
    return {
      source: 'mock', scenarioId: S.id, scenarioName: S.name,
      cycleSec: cycleSecOf(events), series: events.map((e) => ({ ...e })),
    };
  },

  // ── 시나리오 — **자기 id 를 가진 최상위 객체** (`LAYOUT-METRICS-CONTRACT.md`).
  //    배치안 넷과 같은 모양이라 나중에 http.js 로 갈아끼울 때 한 벌만 더 쓰면 된다.

  async getScenarios() {
    const saved = Object.values(readScenarios()).map((S) => ({ id: S.id, name: S.name }));
    // **프리셋을 전부 낸다.** 하나만 내면 빈 방이 가리키는 `blank` 를 화면이 못 찾아
    // 조립 라인 시나리오로 떨어진다 — 빈 방에 사건 13개가 딸려 오던 이유다 (2026-08-04).
    const presets = SCENARIO_PRESETS.map((x) => {
      const b3 = buildScenario(x.id);
      return { id: b3.id, name: b3.name, preset: true };
    });
    const have = new Set(saved.map((x) => x.id));
    return [...saved, ...presets.filter((x) => !have.has(x.id))];
  },

  async getScenario(id) {
    const saved = readScenarios()[id];
    if (saved) return saved;
    // 프리셋 id 로 물으면 프리셋을 낸다 — 저장 전에도 화면이 내용을 보여줄 수 있다
    return SCENARIO_IDS.has(id) ? buildScenario(id) : null;
  },

  async putScenario(scenario) {
    const all = readScenarios();
    all[scenario.id] = scenario;
    writeScenarios(all);
  },

  async deleteScenario(id) {
    const all = readScenarios();
    delete all[id];
    writeScenarios(all);
  },

  // ── 자세 보관함 — 시나리오 넷과 **같은 모양**이다.

  async getPoseSets() {
    const saved = Object.values(readPoseSets()).map((P) => ({ id: P.id, name: P.name }));
    if (saved.length) return saved;
    const p = buildPoseSet(DEFAULT_POSE_SET);
    return [{ id: p.id, name: p.name, preset: true }];
  },

  async getPoseSet(id) {
    const saved = readPoseSets()[id];
    if (saved) return saved;
    return POSESET_IDS.has(id) ? buildPoseSet(id) : null;
  },

  async putPoseSet(poseSet) {
    const all = readPoseSets();
    all[poseSet.id] = poseSet;
    writePoseSets(all);
  },

  async deletePoseSet(id) {
    const all = readPoseSets();
    delete all[id];
    writePoseSets(all);
  },
};
