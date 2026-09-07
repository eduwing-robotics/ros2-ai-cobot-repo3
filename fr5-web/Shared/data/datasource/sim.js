// 시뮬 출처 — **화면은 `Sim/out/…` 이라는 경로를 모른다.** (`SIM-CONTRACT.md` §화면)
//
// 칸 1(`GOAL-dash-datasource`)이 세운 「화면이 데이터 출처를 모르게」를 시뮬에서도 지킨다.
// 지금은 파일을 읽지만, 나중에 브리지·서버로 옮겨도 **화면은 그 사실을 겪지 않는다** —
// 바뀌는 것은 이 파일 하나다. 그게 이 경계의 완료 판정이다.
//
//   GET /sim/batches                  → listBatches()
//   GET /sim/<batchId>/batch.json     → getBatch(id)      조건 스탬프
//   GET /sim/<batchId>/agg.json       → getAgg(id)        사전 집계 (화면이 쓰는 것)
//   GET /sim/<batchId>/summary.csv    → getSummary(id)    인스턴스별 한 줄
//   GET /sim/<batchId>/events.jsonl   → getEvents(id)     한 줄에 사건 하나
//   GET /sim/<batchId>/sweep.json     → getSweep(id)      점군 (3층에서만)
//   GET /sim/<batchId>/frames.json    → getFrames(id)     재생 자세 (3층에서만)
//   GET /sim/scene/<robotId>.xml      → getSceneXml(id)   구운 장면 (토글에서만)
//
// ⛔ **집계를 여기서 다시 하지 않는다.** 분위수·bin 은 러너가 굽는다(`agg.json`) — 브라우저가
//    96개를 매번 접으면 화면이 안 돈다. 여기가 계산을 시작하면 그 규약이 조용히 무너진다.
//
// **천장** — dev 서버가 `Sim/out/` 을 정적으로 내주는 것에 기댄다(`Dashboard/vite.config.js`).
// 배포본에서는 아직 길이 없다. 그때 이 파일의 `BASE` 와 전송만 바뀐다.

const BASE = '/sim';

/** 배치 id 는 파일 경로가 된다 — **`.` 과 `/` 를 막는다**(경로 탈출). */
const safeId = (id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) {
    throw new Error(`배치 id 가 이상하다: ${id}`);
  }
  return id;
};

async function get(path, kind) {
  const r = await fetch(`${BASE}/${path}`);
  if (!r.ok) throw new Error(`${path} — HTTP ${r.status}`);
  if (kind === 'json') return r.json();
  return r.text();
}

/** `summary.csv` → 객체 배열. 머리글이 열 이름이다 — 열이 늘어도 여기는 안 고친다. */
export function parseSummary(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 1) return [];
  const head = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((l) => {
    const cells = l.split(',');
    const row = {};
    head.forEach((h, i) => {
      const v = cells[i];
      row[h] = v === '' || v === undefined ? null : (Number.isFinite(Number(v)) ? Number(v) : v);
    });
    return row;
  });
}

/** `events.jsonl` → 객체 배열. **깨진 줄은 버리지 않고 센다** — 조용히 줄면 화면이 덜 그린다. */
export function parseEvents(text) {
  const rows = [];
  let broken = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { broken += 1; }
  }
  return { rows, broken };
}

export const simSource = {
  source: 'sim-files',

  /** 있는 배치 목록. **없으면 빈 배열이다** — 화면이 「배치 없음」이라 말하면 된다. */
  async listBatches() {
    try { return await get('batches', 'json'); } catch { return []; }
  },

  async getBatch(id) { return get(`${safeId(id)}/batch.json`, 'json'); },
  async getAgg(id) { return get(`${safeId(id)}/agg.json`, 'json'); },
  async getSummary(id) { return parseSummary(await get(`${safeId(id)}/summary.csv`, 'text')); },
  async getEvents(id) { return parseEvents(await get(`${safeId(id)}/events.jsonl`, 'text')); },
  /** 점군은 **3층에서만** 부른다 — 1층만 볼 때까지 6천점을 받게 하지 않는다 */
  async getSweep(id) { return get(`${safeId(id)}/sweep.json`, 'json'); },
  /** 구운 장면(MJCF). **경로를 화면이 모르게** 여기서만 안다 — 3층 토글에서만 쓴다 */
  async getSceneXml(robotId) { return get(`scene/${safeId(robotId)}.xml`, 'text'); },
  /** 재생용 관절 자세 — **모달을 열 때만.** 445KB 라 1층에 얹으면 첫 화면이 느려진다 */
  async getFrames(id) { return get(`${safeId(id)}/frames.json`, 'json'); },
};
