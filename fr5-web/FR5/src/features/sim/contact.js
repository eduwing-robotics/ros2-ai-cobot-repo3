// 시뮬 탭의 10칸(9자세+사전성형) 사이 **길**을 브라우저 무조코로 잰다 (2026-09-06 · `SIM-TAB-CONVERGE-LOOP` phase 1).
//
// 세 층 답의 둘째 층이다: 닿나(IK) · **부딪히나(여기)** · 게이트(랩). 장면이 없으면(랩 호스트 · 산출물 없음) `why` 를 주고 **못 잼**이라
// 말한다 — 조용히 0 을 내면 거짓 초록이다. 계산은 전부 `Shared/data/sim/*` 이고 여기는 엔진을 열고 닫는 배선뿐이다.
import { datasource } from '../../data/datasource/index.js';
import { composeDemoScene, amrPlacement } from '@fr5/shared/data/sim/scene-compose.js';
import { checkArmPath } from '@fr5/shared/data/sim/contact-check.js';
import { isHeld } from '@fr5/shared/data/sim/load-steps.js';

let scene = null;          // 같은 검출 좌표의 장면 — 정차 자리는 mocap 으로 옮긴다
let sceneKey = null;

/**
 * @param {object} o
 * @param {string} o.sceneId  구운 장면 이름 (`/robots` 의 sceneId)
 * @param {Array} o.steps      10칸 (`makeLoadSteps`)
 * @param {Array} o.solved     칸별 `{jointsDeg}` — 전부 있어야 한다
 * @param {object} o.stop      정차 자리 `{xMm,yMm,yawDeg}`
 * @param {number[]} o.userDef 실기 `coordDefs.user`
 * @returns {Promise<{legs:Array, hitLegs:number, why:string|null}>}
 */
export async function runContactCheck({
  sceneId, steps, solved, stop, userDef, extra = [], carrierUser1 = null, bulletsUser1Mm = null,
}) {
  if (!Array.isArray(userDef)) return { legs: [], hitLegs: 0, why: '좌표계(user1)가 없어 못 잰다' };
  if (!solved?.every((o) => o?.jointsDeg)) return { legs: [], hitLegs: 0, why: '10칸이 다 풀려야 잰다' };
  const xml = await datasource.sceneXml(sceneId);
  if (!xml) return { legs: [], hitLegs: 0, why: `장면이 없어 못 잰다 — /sim/scene/${sceneId}.xml (배치를 한 번 구우면 생긴다)` };
  const composed = composeDemoScene(xml, {
    amrUser1: [stop.xMm, stop.yMm, stop.yawDeg], userDef, carried: true, carrierUser1, bulletsUser1Mm,
  });
  if (!composed) return { legs: [], hitLegs: 0, why: '장면 모양이 달라 합성하지 못했다' };
  try {
    // 총알 좌표가 바뀌면 이전 MuJoCo 모델 안의 geom은 움직이지 않는다. 같은 sceneId라는 이유로
    // 재사용하면 옛 총알을 재므로, 정적 구조+검출 좌표가 바뀔 때만 닫고 다시 연다(D219).
    const nextKey = JSON.stringify([sceneId, xml, userDef, carrierUser1, bulletsUser1Mm]);
    if (scene && sceneKey !== nextKey) { scene.dispose(); scene = null; sceneKey = null; }
    if (!scene) {
      const { openSimScene } = await import('@fr5/shared/view3d/sim-scene.js');
      scene = await openSimScene(composed);
      sceneKey = nextKey;
    }
    const place = amrPlacement([stop.xMm, stop.yMm, stop.yawDeg], userDef);
    scene.moveAmr(place.posM, place.yawRad);
  } catch (e) {
    return { legs: [], hitLegs: 0, why: `엔진을 못 열었다 — ${String(e?.message ?? e).slice(0, 80)}` };
  }
  const legs = [];
  for (let k = 1; k < steps.length; k += 1) {
    await new Promise((r) => setTimeout(r, 0));   // 구간마다 이벤트 루프에 양보 — 재생 시계·화면이 안 굳게
    const r = checkArmPath(scene, solved[k - 1].jointsDeg, solved[k].jointsDeg, {
      fromGripPct: steps[k - 1].grip, toGripPct: steps[k].grip,
    });
    // 안 든 구간의 거치대 접촉은 가짜다 — 장면엔 거치대가 늘 손에 붙어 있다(장면은 하나만 연다)
    const held = isHeld(steps, k) || isHeld(steps, k - 1);
    // 총알은 거치대 안에 원래 닿아 있는 payload다. 손에 붙인 carrier_box와 놓인 총알의
    // 겹침은 장면을 한 벌로 재사용하는 데서 생긴 자기접촉이므로 빼되, tool/팔↔총알은 남긴다.
    const external = r.hits.filter((h) => !h.startsWith('carrier_↔prop:live-round-'));
    const hits = held ? external : external.filter((h) => !h.startsWith('carrier_'));
    legs.push({ from: steps[k - 1].id, to: steps[k].id, toIndex: k, hits, samples: r.samples, worstAt: r.worstAt });
  }
  // 관측 전환 같은 **추가 구간** — `{from,to,fromJ,toJ,held}`. 10칸 목록 밖이라 `toIndex` 는 없다
  for (const x of extra) {
    if (!x?.fromJ || !x?.toJ) continue;
    await new Promise((r) => setTimeout(r, 0));
    const r = checkArmPath(scene, x.fromJ, x.toJ, {
      fromGripPct: x.fromGripPct, toGripPct: x.toGripPct,
    });
    const external = r.hits.filter((h) => !h.startsWith('carrier_↔prop:live-round-'));
    const hits = x.held ? external : external.filter((h) => !h.startsWith('carrier_'));
    legs.push({ from: x.from, to: x.to, toIndex: null, hits, samples: r.samples, worstAt: r.worstAt });
  }
  return { legs, hitLegs: legs.filter((l) => l.hits.length).length, why: null };
}
