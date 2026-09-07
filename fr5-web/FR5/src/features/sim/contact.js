// 시뮬 탭의 접촉 층 — 9칸 사이 **길**을 브라우저 무조코로 잰다 (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 1).
//
// 세 층 답의 둘째 층이다: 닿나(IK) · **부딪히나(여기)** · 게이트(랩). 장면이 없으면(랩 호스트 · 산출물 없음) `why` 를 주고 **못 잼**이라
// 말한다 — 조용히 0 을 내면 거짓 초록이다. 계산은 전부 `Shared/data/sim/*` 이고 여기는 엔진을 열고 닫는 배선뿐이다.
import { datasource } from '../../data/datasource/index.js';
import { composeDemoScene, amrPlacement } from '@fr5/shared/data/sim/scene-compose.js';
import { checkArmPath } from '@fr5/shared/data/sim/contact-check.js';
import { isHeld } from '@fr5/shared/data/sim/load-steps.js';

let scene = null;          // 한 번 연 장면(거치대 붙인 채) — 정차 자리는 mocap 으로 옮긴다

/**
 * @param {object} o
 * @param {string} o.sceneId  구운 장면 이름 (`/robots` 의 sceneId)
 * @param {Array} o.steps      9칸 (`makeLoadSteps`)
 * @param {Array} o.solved     칸별 `{jointsDeg}` — 전부 있어야 한다
 * @param {object} o.stop      정차 자리 `{xMm,yMm,yawDeg}`
 * @param {number[]} o.userDef 실기 `coordDefs.user`
 * @returns {Promise<{legs:Array, hitLegs:number, why:string|null}>}
 */
export async function runContactCheck({ sceneId, steps, solved, stop, userDef, extra = [] }) {
  if (!Array.isArray(userDef)) return { legs: [], hitLegs: 0, why: '좌표계(user1)가 없어 못 잰다' };
  if (!solved?.every((o) => o?.jointsDeg)) return { legs: [], hitLegs: 0, why: '9칸이 다 풀려야 잰다' };
  const xml = await datasource.sceneXml(sceneId);
  if (!xml) return { legs: [], hitLegs: 0, why: `장면이 없어 못 잰다 — /sim/scene/${sceneId}.xml (배치를 한 번 구우면 생긴다)` };
  const composed = composeDemoScene(xml, { amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: true });
  if (!composed) return { legs: [], hitLegs: 0, why: '장면 모양이 달라 합성하지 못했다' };
  try {
    if (!scene) {
      const { openSimScene } = await import('@fr5/shared/view3d/sim-scene.js');
      scene = await openSimScene(composed);
    }
    const place = amrPlacement([stop.xMm, stop.yMm, stop.yawDeg], userDef);
    scene.moveAmr(place.posM, place.yawRad);
  } catch (e) {
    return { legs: [], hitLegs: 0, why: `엔진을 못 열었다 — ${String(e?.message ?? e).slice(0, 80)}` };
  }
  const legs = [];
  for (let k = 1; k < steps.length; k += 1) {
    await new Promise((r) => setTimeout(r, 0));   // 구간마다 이벤트 루프에 양보 — 재생 시계·화면이 안 굳게
    const r = checkArmPath(scene, solved[k - 1].jointsDeg, solved[k].jointsDeg);
    // 안 든 구간의 거치대 접촉은 가짜다 — 장면엔 거치대가 늘 손에 붙어 있다(장면은 하나만 연다)
    const held = isHeld(steps, k) || isHeld(steps, k - 1);
    const hits = held ? r.hits : r.hits.filter((h) => !h.startsWith('carrier_'));
    legs.push({ from: steps[k - 1].id, to: steps[k].id, toIndex: k, hits, samples: r.samples, worstAt: r.worstAt });
  }
  // 관측 전환 같은 **추가 구간** — `{from,to,fromJ,toJ,held}`. 9칸 목록 밖이라 `toIndex` 는 없다
  for (const x of extra) {
    if (!x?.fromJ || !x?.toJ) continue;
    await new Promise((r) => setTimeout(r, 0));
    const r = checkArmPath(scene, x.fromJ, x.toJ);
    const hits = x.held ? r.hits : r.hits.filter((h) => !h.startsWith('carrier_'));
    legs.push({ from: x.from, to: x.to, toIndex: null, hits, samples: r.samples, worstAt: r.worstAt });
  }
  return { legs, hitLegs: legs.filter((l) => l.hits.length).length, why: null };
}
