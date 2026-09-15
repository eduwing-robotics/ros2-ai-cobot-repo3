// 태그 직결 앵커 겹치기 — **한 구현을 둘이 쓴다** (`zone-overlay.js` 와 같은 이유 · D135).
//
// AR 글로벌캠 화면(`AR/src/screens/cam.js ?anchors=1`)과 조작대 PiP(`FR5 CamView`)가
// 같은 소품을 같은 자리에 세운다. 화면마다 짜면 두 화면이 서로 다른 자리에 컨베이어를
// 그리기 시작한다 — 이야기 레이어라도 자리가 갈리면 사람이 어느 쪽을 믿을지 모른다.
//
// 값은 `scene-anchors.json`(`scripts/map/anchor-pose.py` 산출 · 계약 §정적 서빙) — lab 좌표
// 1:1 이라 planToScene 이 그대로 투영하고, **캘리브 말고는 아무 가정도 안 탄다**
// (`robot-base-in-tag.json` yaw 재측정 대기와 무관).

import { assembleProps } from './parts.js';

/**
 * 앵커 id → 세울 소품. **태그 중심이 아니라 태그 = 끝이다** (주인님 08-19) — 중심으로
 * 잡으면 몸이 양쪽으로 자라 판을 빠져나간다. 길이·단면은 실맵 프리셋과 같은 값
 * (나르는 것이 77mm 더미탄 · `presets.js realmap`).
 *
 * `yawOffsetDeg` — 종이 방위에 **더하는** 관례 각. 종이를 돌리지 않고 소품 방위만 보정할 때 쓴다.
 */
export const ANCHOR_PROPS = {
  // `anchor: 'end'` — 태그가 **끝**이고 몸은 진행방향으로 뻗는다 (긴 물건 전용).
  // 없으면 태그가 **중심**이다 — 지그처럼 정사각에 가까운 것은 중심이 자연스럽다.
  // ⛔ **32(컨베이어2) — 2026-09-13.** 실물 위를 가려도 계획 고스트가 계속 보여 촬영과
  //    상태 확인을 방해했다. 주인님 확인으로 글로벌카메라 AR 앵커층에서 제거한다.
  //    실물 컨베이어 자체는 배치안(`realmap`)에 남고, 여기서는 더 이상 덮어 그리지 않는다.
  33: { type: 'conveyor', anchor: 'end',                                    // 컨베이어1 · 투입
    opts: { lengthMm: 640, wMm: 120, hMm: 80, belt: true } },
  // 시나리오 거치대 (주인님 08-19) — **실물이 오기 전까지의 가상 지그.**
  // 실물이 자리에 서면 그 줄을 지운다 — 실물을 그림으로 덮지 않는다 (D135 §only 와 같은 규칙)
  //
  // ⛔ **18(거치대2) — 2026-08-27 (D149).** 실물이 섰다. 가상 지그는 200×200 인데 실물은
  //    **122×122 · 두께 27.9mm** 였고, 태그가 물건에서 **351mm** 떨어져 그 자리도 틀렸다 —
  //    **크기도 자리도 틀린 그림을 실물 위에 덮고 있었다.**
  // ⛔ **15(거치대1) · 21(거치대3) — 2026-09-04.** 주인님 *"AR 에서의 거치대는 이제 없어도
  //    될 듯. 글로벌캠 화면에서 AR 이 거치대를 가려버림. 그냥 충돌 표시만."*
  //    분홍 실물 거치대가 섰고, 그 자리는 이제 **색 검출**이 매 판 낸다
  //    (`scripts/map/color-find.py` · D173). 태그 자리에 200×200 판을 덮으면 **사람이
  //    실물을 못 본다** — 겹쳐 보기는 실물을 **보이게** 하려고 있는 것이지 가리려고 있는
  //    것이 아니다. 남는 것은 **충돌 구역**뿐이고 그건 `zone-overlay.js` 가 그린다.
  //
  // ⚠ **다시 켜려면**: 실물이 없어진 자리에만 켠다. 지금 이 표에는 컨베이어1만 남는다.
};

/** `scene-anchors.json` 문서 → 세울 소품 목록. 몸은 태그에서 진행방향(+)으로만 뻗는다 —
 *  반대로 뻗으면 **종이를 180° 돌리면 된다** (종이가 리모컨). */
export function anchorItems(adoc) {
  return Object.entries(adoc?.anchors ?? {})
    .filter(([id]) => ANCHOR_PROPS[id])
    .map(([id, a]) => {
      const p = ANCHOR_PROPS[id];
      const rot = (a.yawDeg ?? 0) + (p.yawOffsetDeg ?? 0);
      const r = (rot * Math.PI) / 180;
      const half = p.anchor === 'end' ? (p.opts.lengthMm ?? 0) / 2 : 0;
      return { id: `anchor-${id}`, type: p.type, rotDeg: rot, opts: p.opts,
        posMm: [a.labMm[0] + Math.cos(r) * half, a.labMm[1] + Math.sin(r) * half, a.labMm[2]] };
    });
}

/**
 * 앵커 층 하나를 씬에 얹는다. `update(adoc)` 를 폴링마다 불러도 **값이 그대로면 안 다시
 * 그린다** — 돌려주는 `changed` 가 true 일 때만 호출자가 렌더 한 장을 찍으면 된다
 * (조작대 PiP 는 상시 렌더를 꺼 둔 정적 무대다 · `CamView` §상시 렌더를 끈다).
 */
export function createAnchorOverlay(scene, { materialStyle = null } = {}) {
  let group = null;
  let lastKey = '';
  const clear = () => {
    if (!group) return;
    scene.remove(group);
    // 지오메트리만 버린다 — 재질(`parts.js M.*`)은 팩토리끼리 **공유**라 버리면 다음 그림이 깨진다
    group.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
    group = null;
  };
  return {
    /** tagId 32/33의 활성 구간. 반환 true일 때만 정적 PiP를 다시 그리면 된다. */
    setConveyorTravel(tagId, signedMm) {
      return group?.userData.setConveyorTravel(`anchor-${tagId}`, signedMm) ?? false;
    },
    setConveyorPose(tagId, pose) {
      return group?.userData.setConveyorPose(`anchor-${tagId}`, pose) ?? false;
    },
    update(adoc) {
      const items = anchorItems(adoc);
      const ids = items.map((i) => i.id.replace('anchor-', ''));
      const key = JSON.stringify(items.map((i) => [i.id, i.posMm, i.rotDeg]));
      if (key === lastKey) return { count: items.length, ids, changed: false };
      lastKey = key;
      clear();
      if (items.length) { group = assembleProps(items, { materialStyle }); scene.add(group); }
      return { count: items.length, ids, changed: true };
    },
    dispose() { clear(); lastKey = ''; },
  };
}
