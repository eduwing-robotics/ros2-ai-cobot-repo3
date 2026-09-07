// 손끝을 목표로 당긴다 — **「닿는 척」의 정직한 판** (2026-08-20 · 실기 담당자 결정).
//
// 왜 필요했나 — 재생 중 팔이 **허공을 짚었다.** `poses.js` 의 자세표는 실기에서 잰
// 키프레임이고 그 사이를 섞을 뿐이라, 자리가 조금만 달라도 손끝이 자리를 안 지난다.
// 실기 담당자가 화면에서 여러 번 잡으셨고 08-20 에 **「닿는 척을 한다」**로 정하셨다.
//
// ⛔ **이 파일이 내는 관절값은 실기가 갈 값이 아니다.** 실기 궤적은 시연 녹화로만 온다
// (`GOAL-imitation-demo.md` · GAP «팔 6축 궤적»). 화면이 이 값을 쓰는 순간 그 화면은
// **근거가 아니라 그림**이므로, 부르는 쪽이 그 사실을 글자로 말해야 한다.
//
// **그래도 지어낸 것은 최소 하나뿐이다.** 나머지는 전부 정본에서 온다:
//   · 기구학 — `urdf-loader` 가 읽은 **URDF 실물** (손으로 짠 FK 가 아니다)
//   · 한계   — `limits.js` (URDF 사본 · `motion.sh` 가 원본과 대조한다)
//   · 씨앗   — **교시된 키프레임 자세**. 거기서 출발해 손끝만 당기므로 모양이 안 망가진다
//   · 결과   — **손끝 잔차(mm)를 돌려준다.** 「닿는 척」인지 「진짜 닿았는지」를 숫자가 말한다
//
// **이력에 안 묶인다** — 매 프레임 키프레임 자세를 다시 얹은 뒤 부르므로 같은 시각이면
// 같은 그림이 나온다. `layout-view.js` 의 요각이 접선으로 도는 것과 같은 이유다
// (다중 패스 컷에서 로봇이 튀면 안 된다).

import * as THREE from 'three';
import { JOINT_LIMITS_DEG } from '../data/motion/limits.js';

const DEG = Math.PI / 180;

// 손목 → 팔꿈치 → 어깨 순. **`j1` 은 빼 놓는다** — 겨눔각이라 배치안이 정하고
// (`layout-view.js armAim()`), 여기서 또 돌리면 두 주인이 같은 관절을 다툰다 (하드 룰 4의 정신).
// ⛔ **`j1` 도 넣는다 — 다만 씨앗은 배치안의 겨눔각이다** (2026-08-20 실측).
// 처음엔 뺐는데(「두 주인이 같은 관절을 다툰다」), 투입 팔의 교시 자세(`lowIdle`·`lowPile`)가
// **뒤로 접혀 있어** 손끝이 목표와 **172° 반대쪽**을 짚었다. j1 을 고정하면 그 자세에서
// 앞으로 펼 방법이 없다 — 잔차 263~286mm 로 매번 되돌려졌다.
// **주인이 둘이 되는 게 아니다** — 배치안이 겨눔각을 주고(씨앗), 솔버는 거기서 다듬는다.
const DEFAULT_CHAIN = ['j5', 'j4', 'j3', 'j2', 'j1'];

/**
 * CCD(cyclic coordinate descent) — 관절 하나씩 「손끝이 목표에 제일 가까워지는 각」으로 돌린다.
 * 야코비안을 안 쓰므로 특이점에서 안 터지고, 한 관절씩 한계로 자를 수 있다.
 *
 * @param robot        `loadRobot()` 이 준 URDF 로봇
 * @param targetWorld  목표 (THREE.Vector3 · **월드** 좌표 · 미터)
 * @returns `{ residualMm, iters }` · 못 풀면 `null`
 */
export function solveReach(robot, targetWorld, {
  tipLink = 'wrist3_link',
  chain = DEFAULT_CHAIN,
  maxIters = 24,
  tolMm = 15,
} = {}) {
  const tip = robot?.links?.[tipLink];
  if (!tip || !targetWorld) return null;

  // **씨앗을 적어 둔다.** 못 닿으면 되돌린다 — 아래 §부분 수렴
  const seed = {};
  for (const n of chain) seed[n] = robot.joints?.[n]?.angle ?? 0;

  const t = new THREE.Vector3();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const ax = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  // **손끝은 손목이 아니라 그리퍼다.** 손목 원점을 목표에 맞추면 그리퍼 길이(~150mm)만큼
  // 남고, 화면에서는 여전히 안 짚은 것으로 보인다. 헤드리스 탐침이 재는 정의와 같게 쓴다
  // (`LayoutView.jsx` §arms.tipMm — 두 곳이 갈리면 게이트가 딴 데를 잰다).
  const tipWorld = (out) => {
    robot.updateMatrixWorld(true);
    out.set(0, 0, 0);
    let n = 0;
    tip.traverse((o) => { if (o !== tip && o.isMesh) { out.add(o.getWorldPosition(c)); n += 1; } });
    if (n) out.divideScalar(n); else tip.getWorldPosition(out);
    return out;
  };
  const distM = () => tipWorld(t).distanceTo(targetWorld);

  const tol = tolMm / 1000;
  let best = distM();
  let it = 0;
  for (; it < maxIters && best > tol; it += 1) {
    for (const name of chain) {
      const j = robot.joints?.[name];
      if (!j) continue;
      robot.updateMatrixWorld(true);
      j.getWorldPosition(p);
      j.getWorldQuaternion(q);
      // 회전축은 관절 로컬이다 — 월드로 돌려야 평면 투영이 맞는다
      ax.copy(j.axis ?? c.set(0, 0, 1)).applyQuaternion(q).normalize();

      tipWorld(t);
      a.copy(t).sub(p).projectOnPlane(ax);
      b.copy(targetWorld).sub(p).projectOnPlane(ax);
      // **축 위에 얹힌 점은 건너뛴다** — 투영이 0 이면 각이 정의되지 않는다
      if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10) continue;
      a.normalize();
      b.normalize();
      let ang = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
      if (c.copy(a).cross(b).dot(ax) < 0) ang = -ang;

      const lim = JOINT_LIMITS_DEG[name];
      let next = (j.angle ?? 0) + ang;
      // **한계로 자른다.** 자르지 않으면 `urdf-loader` 가 말없이 자르고, 그러면
      // 우리가 계산한 각과 화면에 선 각이 갈린다 (`limits.js` 머리말의 그 사고)
      if (lim) next = Math.min(lim[1] * DEG, Math.max(lim[0] * DEG, next));
      robot.setJointValue(name, next);
    }
    const now = distM();
    // **더 안 좋아지면 멈춘다** — 못 닿는 자리에서 계속 돌면 팔이 몸을 접는다
    if (now >= best - 1e-5) { best = now; break; }
    best = now;
  }
  // ⛔ **부분 수렴은 교시 자세보다 나쁘다** (2026-08-20 · `dash-render` 가 잡았다).
  // j1 을 안 건드리므로 임의의 3D 점에는 못 닿을 수 있고, 그때 팔이 **교시 자세도 아니고
  // 목표도 아닌 중간**에 선다. 게이트의 `fetch` 분리(>800mm)가 439mm 로 무너졌다.
  // **닿으면 쓰고 못 닿으면 되돌린다** — 어중간한 자세를 화면에 세우지 않는다.
  const applied = best <= tol;
  if (!applied) for (const [n, v] of Object.entries(seed)) robot.setJointValue(n, v);
  robot.updateMatrixWorld(true);
  return { residualMm: Math.round(best * 1000), iters: it, applied };
}
