// 판정면 겹치기 — **게이트가 막는 경계를 실영상 위 제자리에 세운다.**
//
// 왜 `Shared` 인가 (2026-08-13): 이 겹치기를 쓰는 화면이 **둘**이다 — AR 겹치기 화면
// (`AR/src/screens/cam.js`)과 FR5 조작대의 실영상 패널(`FR5/src/features/live/CamView.jsx`).
// 좌표 사슬과 정합 판정을 화면마다 짜면 **두 화면이 서로 다른 경계를 그리기 시작한다.**
// 안전 표시에서 그게 제일 나쁘다 (`workspace.js` 머리말과 같은 정신 · 하드 룰 5).
//
// 좌표 사슬 넷 중 앞의 둘은 `Shared` 가 이미 한다:
//   게이트값(user1) ──`toBase`──▶ 로봇 베이스 ──여기──▶ 태그(=lab) ──`planToScene`──▶ 씬
// 세 번째 칸만 이 파일이 하고, 값은 `robot-base-in-tag.json` 하나에서만 온다.
//
// ⛔ **배치안 레이어에 얹지 않는다.** 그쪽은 `?fit=` 수동 맞춤이라 축척도 원점도 눈으로 맞춘
// 값이다. 캘리브된 경계를 안 캘리브된 변환으로 그리면 화면이 실제와 다른 자리에 선을 긋는다.
// 부르는 쪽은 **캘리브 카메라가 붙은 씬**에 그대로 add 한다 (D125).
import * as THREE from 'three';
import { planToScene } from '../data/units/units.js';
import { makeWorkspace, toBase } from './workspace.js';
import { mountRobotYUp } from './robot.js';
import { resolveTheme } from './zone-theme.js';

/** 로봇 베이스 기준 (x,y,z)mm → 태그(lab) 기준 mm. yaw 는 lab +Z 둘레다. */
export function baseToLab(base, [x, y, z]) {
  const th = (base.yawDeg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  return [base.xMm + c * x - s * y, base.yMm + s * x + c * y, base.zMm + z];
}

/**
 * 판정 경계의 **꼭짓점**만 뽑는다 (베이스 기준 mm).
 *
 * 높이는 `topZMm + marginMm` — **게이트가 실제로 거부하는 면**이지 실물 상판이 아니다.
 * 이 점들로 화면 왜곡을 재므로 실물이 아니라 판정면을 재는 것이 맞다.
 */
export function zoneCornersMm(ws) {
  const pts = [];
  (ws?.boxes ?? []).forEach((b) => {
    if (b.staleReason) return;
    const z = b.topZMm + (b.marginMm ?? 0);
    for (const x of b.xMm) for (const y of b.yMm) pts.push([x, y, z]);
  });
  (ws?.walls ?? []).forEach((w) => {
    const [z0, z1] = Array.isArray(w.seenZMm) && w.seenZMm.length === 2 ? w.seenZMm : [0, 0];
    for (const p of [w.aMm, w.bMm]) for (const z of [z0, z1]) pts.push([p[0], p[1], z]);
  });
  return pts;
}

// 실측 왜곡 (2026-08-07 · `GAP-MATRIX` 렌즈 왜곡 행) — 주점에서의 거리(px) → 어긋남(px).
// **언디스토트 경로가 없어서 이 대가는 실제로 치른다.** 추정 k1 이 아니라 잰 값이다:
// 정중앙 0 · ≤1px 344 · ≤2px 442 · ≤5px 612 · ≤10px 810 · 모서리(r≈1468) 82.
// 사이는 선형보간한다 — 정확한 곡선이 아니라 **자릿수**를 말하는 것이 목적이다.
const DISTORT_PX = [[0, 0], [344, 1], [442, 2], [612, 5], [810, 10], [1468, 82]];
export function errAtPx(r) {
  if (r <= 0) return 0;
  for (let i = 1; i < DISTORT_PX.length; i += 1) {
    const [r0, e0] = DISTORT_PX[i - 1], [r1, e1] = DISTORT_PX[i];
    if (r <= r1) return e0 + ((e1 - e0) * (r - r0)) / (r1 - r0);
  }
  return DISTORT_PX[DISTORT_PX.length - 1][1];
}

/**
 * 정합 상태 셋.
 *
 * ⚠ **「모른다」와 「틀렸다」를 가른다** (D126). `global-cam-drift.json` 은 감시기가 죽으면
 * 마지막 값에서 얼어붙는다 — 2026-08-13 실측: `rmsPx 347.42` 가 08-10 18:25 에 멈춰 있는데
 * 그 값은 같은 날 18:38 에 닫힌 사건의 **직전** 값이고, 캘리브는 08-12 것이었다. 얼어붙은
 * 빨간불을 「무효」로 읽으면 **멀쩡한 캘리브 위에서 화면이 스스로를 지운다.**
 *
 * 초록/노랑 자체는 `Shared/data/camera/state.js` 가 정한다(나이·결측·형식까지) —
 * **여기서 다시 짜지 않는다.** 이 함수는 그 노랑 안에서 「지울지 흐릴지」만 가른다.
 *
 * @param {object|null|undefined} drift  `global-cam-drift.json` + `ageMs`
 * @param {object|null} calib            `global-cam.json`
 * @param {{tone:string,label:string}|null} driftRow  `cameraState()` 의 `drift` 행
 */
const DRIFT_WARN_PX = 5.0;
export function calibTrust(drift, calib, driftRow) {
  if (!driftRow || driftRow.tone === 'mute') {
    return { key: 'none', tone: 'mute', label: driftRow?.label ?? '정합 감시 없음' };
  }
  if (driftRow.tone === 'ok') return { key: 'ok', tone: 'ok', label: null };

  const shot = calib?.labToCam?.shot;
  const basisKnown = Boolean(shot && drift?.basis);
  if (basisKnown && drift.basis !== shot) {
    return { key: 'stale', tone: 'warn', label: '정합 미확인 — 감시 꺼짐(옛 기준)' };
  }
  // **「무효」는 증거가 있어야 하는 주장이다.** 기준을 대조 못 하면 이 값이 지금 캘리브를
  // 잰 것인지 옛것을 잰 것인지 모른다 — 그때 「틀렸다」로 떨어뜨리면 안 된다
  if (basisKnown && Number(drift?.rmsPx) > DRIFT_WARN_PX) {
    return { key: 'invalid', tone: 'warn', label: `정합 무효 ${Number(drift.rmsPx).toFixed(1)}px` };
  }
  return { key: 'unknown', tone: 'warn', label: `정합 미확인 — ${driftRow.label}` };
}

/**
 * 색이 무엇을 뜻하는지 **화면이 말하게 한다** (2026-08-13).
 *
 * ⚠ 없으면 **거꾸로 읽힌다.** 사람은 진한 쪽(파랑)을 「위험」으로 읽는데 실제로 거부가
 * 시작되는 선은 **주황**이다. 개수(`판정면 2·벽 2`)만 적어 두면 그 오해를 못 막는다.
 * 색은 팔레트에서 그대로 읽는다 — 범례와 그림이 갈리면 범례가 거짓말이 된다.
 *
 * @returns {{key:string, hex:string, label:string, note:string}[]}
 */
export function zoneLegend(theme, { stale = false } = {}) {
  const T = resolveTheme(theme);
  const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
  const out = [
    { key: 'face', hex: hex(T.face), label: '판정면', note: '게이트가 아는 상판·벽' },
    { key: 'margin', hex: hex(T.margin), label: '여유', note: '여기부터 거부된다' },
  ];
  // **가정값이 하나라도 있을 때만 낸다** — 없는 색을 범례에 두면 사람이 그 색을 찾는다
  if (stale) out.push({ key: 'stale', hex: hex(T.stale), label: '가정값',
    note: '막지만 자리를 못 믿는다' });
  return out;
}

/**
 * 판정면을 세운다. **부르는 쪽이 씬과 카메라를 준다.**
 *
 * @param {THREE.Scene} scene  캘리브 카메라가 붙은 씬
 * @returns {{update:Function, dispose:Function, last:object|null}}
 */
export function createZoneOverlay(scene) {
  let root = null;
  let last = null;

  const clear = () => {
    if (root) { scene.remove(root); root = null; }
    last = null;
  };

  /**
   * @param {object} a
   * @param {object|null} a.ws        `/state.workspace` (게이트가 쓰는 그 값)
   * @param {number[]|null} a.userDef `/state.coordDefs.user`
   * @param {object|null} a.base      `robot-base-in-tag.json`
   * @param {object|null} a.calib     `global-cam.json`
   * @param {THREE.Camera} a.camera   투영을 재는 데 쓴다 (왜곡 예산)
   * @param {object} a.trust          `calibTrust()` 결과
   * @param {string} [a.theme]        `zone-theme.js` 이름. 기본 실영상용
   * @returns {{ok:boolean, why:string|null, boxes:number, walls:number,
   *            errPx:number, rMax:number, trust:string, dim:boolean}}
   */
  const update = ({ ws, userDef, base, calib, camera, trust, theme = 'video' }) => {
    clear();
    const no = (why) => ({ ok: false, why, boxes: 0, walls: 0, errPx: 0, rMax: 0,
      trust: trust?.key ?? 'none', dim: false, staleNames: [] });

    if (!base) return no('로봇 베이스 미등재');
    if (!ws) return no('브리지가 작업영역을 안 준다');
    // 회전이 0 이 아닌 사용자 좌표계면 `toBase` 가 `null` 을 준다.
    // **반쯤 맞는 자리에 판정면을 그리는 것이 안 그리는 것보다 나쁘다** (`workspace.js`)
    const wsBase = toBase(ws, userDef);
    if (!wsBase) return no('사용자 좌표계 환산 불가');
    if (trust?.key === 'invalid') return no(trust.label);

    root = mountRobotYUp(null);          // Z-up(로봇·m) → Y-up(씬). 축 변환은 Shared 한 곳
    root.name = 'zoneOverlay';
    const [sx, sy, sz] = planToScene([base.xMm, base.yMm, base.zMm]);
    root.position.set(sx, sy, sz);
    const yaw = new THREE.Group();       // lab +Z 둘레 = 홀더 로컬 Z (planToScene 과 같은 축)
    yaw.rotation.z = (base.yawDeg * Math.PI) / 180;
    // **소품은 끈다** — 카트도 바닥도 진짜가 영상에 이미 있다. 두 번 그리면 "상판이 두 개"다
    yaw.add(makeWorkspace(wsBase, { showProps: false, theme }));
    root.add(yaw);

    // ── 왜곡 대가를 **숫자로** 말한다. 언디스토트 경로가 없어서 이 대가는 실제로 치른다
    let rMax = 0;
    const I = calib?.intrinsics;
    if (I && camera) {
      const v = new THREE.Vector3();
      zoneCornersMm(wsBase).forEach((p) => {
        v.set(...planToScene(baseToLab(base, p))).project(camera);
        const x = (v.x * 0.5 + 0.5) * I.widthPx;
        const y = (0.5 - v.y * 0.5) * I.heightPx;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          rMax = Math.max(rMax, Math.hypot(x - I.cx, y - I.cy));
        }
      });
    }

    // 정합을 못 믿는 상태(노랑)면 **지우지 않고 흐린다** — 「모른다」는 「틀렸다」가 아니다.
    // 계수는 팔레트가 들고 있다 — 화면마다 배경이 달라 같은 값이 한쪽에서는 「흐리다」이고
    // 다른 쪽에서는 「안 보인다」가 된다 (D128)
    const dim = (trust?.key ?? 'none') !== 'ok';
    if (dim) {
      const { dimA } = resolveTheme(theme);
      root.traverse((o) => {
        if (!o.material) return;
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = (o.material.opacity ?? 1) * dimA;
      });
    }
    scene.add(root);

    const staleNames = [...(wsBase.boxes ?? []), ...(wsBase.walls ?? [])]
      .filter((o) => o.staleReason).map((o) => o.name ?? '판정면');
    last = { ok: true, why: null, staleNames,
      boxes: (wsBase.boxes ?? []).length, walls: (wsBase.walls ?? []).length,
      errPx: errAtPx(rMax), rMax, trust: trust?.key ?? 'none', dim, root };
    return last;
  };

  return { update, dispose: clear, get last() { return last; }, get root() { return root; } };
}
