// 접촉 검사 — **자세가 아니라 길을 잰다** (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 1).
//
// 2026-08-31 무조코 스윕(`amr-stop-mujoco.mjs`)은 칸의 **자세**만 세워 봤다. 09-06 실렌더에서 ④→⑤ 로 가는 **길**이
// 터틀봇 몸통 모서리를 쓸었는데 스윕은 초록이었다 — 그래서 칸 사이를 관절 5° 간격으로 표본해 하나하나 접촉을 센다
// (`safety.path_samples` 와 같은 간격 · 게이트가 경로를 보는 방식과 같다). 근거: MuJoCo 문서 §Simulation — `qpos` 를 넣고
// `mj_forward` 만 불러도 위치 단계가 접촉을 채운다.
//
// 엔진은 인자로 받는다 — `{ at(jointsDeg) → {ncon, pairs}, moveAmr?(posM, yawRad) }`. 브라우저는 `Shared/view3d/sim-scene.js`,
// Node 게이트는 같은 모양의 래퍼를 자기가 만든다. 이 파일은 three 도 mujoco 도 모른다.
import { MINE_RE, OBSTACLE_RE } from './scene-compose.js';

/** 관절 경로 표본 — 제일 많이 도는 관절이 `stepDeg` 이내가 되게 나눈다. 시작 자세는 안 넣는다(직전 칸이 이미 봤다) */
export function pathSamples(fromJ, toJ, stepDeg = 5) {
  const maxD = Math.max(...toJ.map((v, i) => Math.abs(v - fromJ[i])));
  const n = Math.max(1, Math.ceil(maxD / stepDeg));
  return Array.from({ length: n }, (_, k) => {
    const t = (k + 1) / n;
    return fromJ.map((v, i) => v + (toJ[i] - v) * t);
  });
}

/** 「닿음」과 「파고듦」을 가른다 — 거치대를 바구니 바닥에 **놓는** 동작은 닿아야 정상이다. 이보다 깊이 파고들면 충돌.
 *  3mm 인 이유: 파지 자세가 rx 178.8·ry −1.3 으로 1.3° 기울어 85×69 상자 모서리가 바닥판에 최대 2.4mm 파고든다(2026-09-06 게이트 실측).
 *  1mm 로 두면 놓는 동작이 늘 빨강이고, 진짜 충돌(09-06 사고 10~40mm)은 3 으로도 넉넉히 잡힌다 */
export const PENETRATION_MM = 3;

/**
 * 접촉 쌍 중 「우리 것(팔·툴·든 거치대) ↔ 놓인 것」만, 그것도 `PENETRATION_MM` 보다 깊이 파고든 것만 남긴다.
 * `pairs` 원소는 `[이름1, 이름2, distM]` — `dist` 는 MuJoCo 접촉 거리(음수 = 파고듦 · m). 없으면 파고든 것으로 친다(옛 래퍼)
 * @returns {string[]} `"a↔b −2.3mm"` 꼴
 */
export function relevantHits(pairs) {
  const mine = (n) => n === '' || MINE_RE.test(n);
  const out = [];
  for (const [a, b, dist] of pairs) {
    const depthMm = Number.isFinite(dist) ? -dist * 1000 : PENETRATION_MM + 1;
    if (depthMm <= PENETRATION_MM) continue;
    if (mine(a) && OBSTACLE_RE.test(b)) out.push(`${a || '팔'}↔${b} −${depthMm.toFixed(1)}mm`);
    else if (mine(b) && OBSTACLE_RE.test(a)) out.push(`${b || '팔'}↔${a} −${depthMm.toFixed(1)}mm`);
  }
  return out;
}

/**
 * 팔 구간 — `fromJ` 에서 `toJ` 로 가는 길. 터틀봇은 서 있다.
 * @returns {{hits:string[], samples:number, worstAt:number|null}} hits 는 중복 제거한 쌍 이름들 · worstAt 은 처음 닿은 표본 진행률(0~1)
 */
export function checkArmPath(sim, fromJ, toJ, { stepDeg = 5 } = {}) {
  const samples = pathSamples(fromJ, toJ, stepDeg);
  const hits = new Map();          // 쌍 이름 → 최대 파고듦
  let worstAt = null;
  samples.forEach((q, k) => {
    const r = (sim.contactsAt ?? sim.at).call(sim, q);      // 접촉만 — 그리는 비용을 안 낸다
    const h = relevantHits(r.pairs ?? []);
    if (h.length && worstAt === null) worstAt = (k + 1) / samples.length;
    h.forEach((x) => { const [name, d] = x.split(' −'); const v = parseFloat(d); if (!(hits.get(name) >= v)) hits.set(name, v); });
  });
  return { hits: [...hits].map(([n, v]) => `${n} −${v.toFixed(1)}mm`), samples: samples.length, worstAt };
}

/**
 * 주행 구간 — 팔은 `armJ` 로 서 있고 터틀봇이 `fromM`→`toM`(base · m) 으로 간다. `stepMm` 마다 옮겨 잰다.
 * `sim.moveAmr` 가 없으면(옛 장면) 못 잰다고 답한다 — 조용히 0 을 내지 않는다.
 */
export function checkDrivePath(sim, armJ, fromM, toM, yawRad, { stepMm = 50 } = {}) {
  if (typeof sim.moveAmr !== 'function') return { hits: [], samples: 0, worstAt: null, why: '터틀봇을 못 옮기는 장면' };
  const len = Math.hypot(toM[0] - fromM[0], toM[1] - fromM[1]) * 1000;
  const n = Math.max(1, Math.ceil(len / stepMm));
  const hits = new Map();
  let worstAt = null;
  for (let k = 0; k <= n; k += 1) {
    const t = k / n;
    sim.moveAmr(fromM.map((v, i) => v + (toM[i] - v) * t), yawRad);
    const r = (sim.contactsAt ?? sim.at).call(sim, armJ);
    const h = relevantHits(r.pairs ?? []);
    if (h.length && worstAt === null) worstAt = t;
    h.forEach((x) => { const [name, d] = x.split(' −'); const v = parseFloat(d); if (!(hits.get(name) >= v)) hits.set(name, v); });
  }
  return { hits: [...hits].map(([n2, v]) => `${n2} −${v.toFixed(1)}mm`), samples: n + 1, worstAt };
}
