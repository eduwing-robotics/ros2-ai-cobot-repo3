// 자세 보관함 모델 — **배치안은 공간, series 는 시간, 여기는 팔이 어떤 모양인가.**
//
// `scenario/schema.js` 와 같은 문법이다. 자세 하나는 `{ j1..j6, source }` 이고,
// 보관함은 **이름 → 자세** 다. 사건은 그 **이름**을 부른다 — 각도를 부르면 팔을 200mm
// 옮겼을 때 허공을 가리키고, 같은 시나리오를 배치안 A·B 에 못 태운다 (F8 · `SHARED-CORE.md` §1.5).
//
// **`source` 를 반드시 든다** — 손으로 만든 자세와 실기에서 잰 자세가 같은 목록에 섞이면
// 안 된다. 목업을 실측으로 오인해 보고하는 것이 이 프로젝트에서 가장 비싼 사고다 (SR_24).
// 실기 티칭(`/points`)이 붙으면 `taught` 가 그 자리로 들어온다.

import { JOINTS, outOfLimit } from './limits.js';

/** 자세가 들 수 있는 칸. 여기 없는 칸은 `validatePoseSet` 이 이름을 대며 거부한다. */
export const POSE_KEYS = [...JOINTS, 'source', 'note'];

/** 어디서 온 자세인가. 늘어나면 화면 배지도 같이 늘린다. */
export const SOURCES = ['hand', 'taught'];

export function emptyPoseSet(id = 'p1', name = '이름 없는 자세 보관함') {
  return { id, name, unit: 'mm-deg', poses: {} };
}

/**
 * 옛 모양을 지금 모양으로. **읽는 길목 한 곳에서만 부른다** (하드 룰 5).
 *
 * `source` 가 없는 자세는 **`hand` 로 본다** — 2026-08-04 이전 자세는 전부 손으로 적은 것이다.
 * 여기서 안 채우면 화면 배지가 빈칸이 되고, 빈칸은 "실측인가?" 로 읽힌다.
 */
export function migratePoseSet(P) {
  if (!P || typeof P !== 'object' || !P.poses) return P;
  const poses = Object.fromEntries(Object.entries(P.poses).map(([k, v]) => [
    k, v && typeof v === 'object' && !v.source ? { ...v, source: 'hand' } : v,
  ]));
  return { ...P, poses };
}

/**
 * 어긴 곳을 **전부** 돌려준다. 첫 번째에서 멈추지 않는다 — 고치는 사람이 한 번에 보게.
 *
 * **한계 밖 각을 여기서 잡는다.** `urdf-loader` 는 말없이 자르므로(2026-08-04 · `j6: 300`),
 * 검사가 없으면 표에 적힌 값과 화면에 선 자세가 영영 다르다.
 */
export function validatePoseSet(P) {
  const bad = [];
  if (!P || typeof P !== 'object') return ['자세 보관함이 객체가 아니다'];
  if (!P.id) bad.push('id 가 없다');
  if (!P.name) bad.push('name 이 없다');
  if (P.unit !== 'mm-deg') bad.push(`unit 이 'mm-deg' 가 아니다: ${P.unit}`);
  if (!P.poses || typeof P.poses !== 'object') return [...bad, 'poses 가 객체가 아니다'];

  for (const [name, pose] of Object.entries(P.poses)) {
    if (!pose || typeof pose !== 'object') { bad.push(`${name}: 자세가 객체가 아니다`); continue; }
    for (const j of JOINTS) {
      if (!Number.isFinite(Number(pose[j]))) bad.push(`${name}.${j}: 숫자가 아니다 — ${pose[j]}`);
    }
    for (const k of Object.keys(pose)) {
      if (!POSE_KEYS.includes(k)) bad.push(`${name}: '${k}' — 계약에 없는 칸이다`);
    }
    // **출처를 안 적은 자세는 안 받는다** — 빈칸은 "실측인가?" 로 읽힌다 (SR_24)
    if (!SOURCES.includes(pose.source)) {
      bad.push(`${name}: source 가 ${SOURCES.join('|')} 가 아니다 — ${pose.source}`);
    }
    for (const m of outOfLimit(Object.fromEntries(JOINTS.map((j) => [j, pose[j]])))) {
      bad.push(`${name}.${m}`);
    }
  }
  return bad;
}
