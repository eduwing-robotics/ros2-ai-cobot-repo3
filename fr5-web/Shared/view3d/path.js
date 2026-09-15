// 궤적 — 시작·끝 자세 사이를 FK 로 보간해 경로를 그리고 로봇을 그 위로 움직인다.
//
// **역기구학(IK)은 필요 없다.** 저장된 자세가 6축 관절 각도이고 MoveJ 가 관절을
// 직접 보간하기 때문이다 (STACK.md §궤적). 우리가 하는 건 MoveJ 가 실제로 하는 계산과 같다.
//
// 얇은 Line 을 쓰지 않는다 — WebGL 에서 선 굵기 조절이 안 돼 폰 화면에서 거의 안 보인다.
// TubeGeometry(가는 관)로 그린다.

import * as THREE from 'three';

const DEG = Math.PI / 180;

/** 관절 각도(도) 두 벌 사이를 steps 단계로 선형 보간한다. MoveJ 와 같은 방식. */
export function interpolateJoints(fromDeg, toDeg, steps) {
  const names = Object.keys(fromDeg);
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const frame = {};
    for (const n of names) frame[n] = fromDeg[n] + (toDeg[n] - fromDeg[n]) * t;
    out.push(frame);
  }
  return out;
}

/**
 * 각 보간 단계에서 손끝(tipLink)의 위치를 뽑는다.
 *
 * 점은 **로봇 자신의 좌표계(base_link 기준, 미터)** 로 돌려준다. 월드 좌표로 돌려주면
 * AR 에서 마커 스케일(1/마커크기 ≈ 5배)이 섞여 경로 길이가 5배로 나오고
 * 관도 5배로 커진다 — 실제로 밟은 함정이다. 그래서 관은 `robot` 의 자식으로 붙인다.
 *
 * 관절을 실제로 움직여 재므로 **원래 자세를 반드시 되돌려 놓는다** —
 * 안 되돌리면 궤적을 만든 뒤 로봇이 마지막 자세로 남는다.
 */
export function tipPath(robot, frames, tipLink = 'wrist3_link') {
  const link = robot.links[tipLink];
  if (!link) throw new Error(`링크가 없다: ${tipLink}`);

  const saved = {};
  for (const n of Object.keys(frames[0])) saved[n] = robot.joints[n].angle;

  const points = [];
  for (const frame of frames) {
    for (const [n, deg] of Object.entries(frame)) robot.setJointValue(n, deg * DEG);
    robot.updateMatrixWorld(true);
    const p = link.getWorldPosition(new THREE.Vector3());
    points.push(robot.worldToLocal(p)); // 월드 → 로봇 로컬
  }

  for (const [n, rad] of Object.entries(saved)) robot.setJointValue(n, rad);
  robot.updateMatrixWorld(true);
  return points;
}

/** 경로 길이(미터). 궤적이 제대로 만들어졌는지 한 숫자로 확인하는 용도. */
export function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i += 1) d += points[i].distanceTo(points[i - 1]);
  return d;
}

/**
 * 경로를 반투명 관으로 만든다. 부모(로봇과 같은 좌표계)에 붙여야 위치가 맞는다.
 * radius 는 미터.
 */
export function makeTube(points, { radius = 0.018, color = 0x4dd6a0, opacity = 0.55 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geom = new THREE.TubeGeometry(curve, Math.max(24, points.length), radius, 8, false);
  return new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    color, transparent: true, opacity, roughness: 0.4, depthWrite: false,
  }));
}

/**
 * 궤적 재생기. 렌더 루프에서 update(deltaSec) 를 부른다.
 * 왕복(pingpong)이 기본 — 시연에서 로봇이 화면 밖으로 사라지지 않는다.
 */
export function createPlayer(robot, frames, { secondsPerLoop = 4, pingpong = true } = {}) {
  let t = 0;
  let dir = 1;
  let playing = false;

  function seek(u) {
    const clamped = Math.min(1, Math.max(0, u));
    const idx = clamped * (frames.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(frames.length - 1, i0 + 1);
    const f = idx - i0;
    for (const n of Object.keys(frames[0])) {
      const deg = frames[i0][n] + (frames[i1][n] - frames[i0][n]) * f;
      robot.setJointValue(n, deg * DEG);
    }
  }

  seek(0);
  return {
    get playing() { return playing; },
    play() { playing = true; },
    pause() { playing = false; },
    toggle() { playing = !playing; return playing; },
    reset() { t = 0; dir = 1; seek(0); },
    update(dt) {
      if (!playing) return;
      t += (dt / secondsPerLoop) * dir;
      if (pingpong) {
        if (t > 1) { t = 1; dir = -1; }
        if (t < 0) { t = 0; dir = 1; }
      } else if (t > 1) {
        t -= 1;
      }
      seek(t);
    },
  };
}
