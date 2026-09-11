// 기존 AprilTag 평면 → 움직이는 폰 카메라 자세.
// D226: 왜곡이 제거된 브라우저 영상이라, 보이는 모든 태그 모서리를 호모그래피 하나로 푼다.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => Math.hypot(...v);
const normalize = (v) => {
  const n = norm(v);
  if (!Number.isFinite(n) || n < 1e-12) throw new Error('자세 축이 퇴화했습니다');
  return v.map((x) => x / n);
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) throw new Error('태그 모서리 배치가 퇴화했습니다');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= d;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const k = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= k * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function leastSquares(rows, values) {
  const n = rows[0].length;
  const ata = Array.from({ length: n }, () => Array(n).fill(0));
  const atb = Array(n).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < n; j += 1) {
      atb[j] += rows[i][j] * values[i];
      for (let k = 0; k < n; k += 1) ata[j][k] += rows[i][j] * rows[i][k];
    }
  }
  return solveLinear(ata, atb);
}

const multiply3 = (a, b) => a.map((row) => [0, 1, 2].map((col) =>
  row[0] * b[0][col] + row[1] * b[1][col] + row[2] * b[2][col]));

function rotationIncrement([x, y, z]) {
  const angle = Math.hypot(x, y, z);
  if (angle < 1e-12) return [[1, -z, y], [z, 1, -x], [-y, x, 1]];
  const [kx, ky, kz] = [x / angle, y / angle, z / angle];
  const c = Math.cos(angle); const s = Math.sin(angle); const v = 1 - c;
  return [
    [kx * kx * v + c, kx * ky * v - kz * s, kx * kz * v + ky * s],
    [ky * kx * v + kz * s, ky * ky * v + c, ky * kz * v - kx * s],
    [kz * kx * v - ky * s, kz * ky * v + kx * s, kz * kz * v + c],
  ];
}

function poseMetrics(rotation, translation, worldPoints, imagePoints, intrinsics) {
  const projected = worldPoints.map((point) => projectWorld(point, { rotation, translation }, intrinsics));
  if (!projected.every(Boolean)) return { rmsPx: Infinity, projected };
  const rmsPx = Math.sqrt(projected.reduce((sum, p, i) =>
    sum + (p.x - imagePoints[i].x) ** 2 + (p.y - imagePoints[i].y) ** 2, 0) / projected.length);
  return { rmsPx, projected };
}

function refinePose(initial, worldPoints, imagePoints, intrinsics) {
  let rotation = initial.rotation.map((row) => [...row]);
  let translation = [...initial.translation];
  let best = poseMetrics(rotation, translation, worldPoints, imagePoints, intrinsics);
  // 회전과 이동의 단위 차이를 없앤 6개 무차원 증분. ponytail: 평면 16점 이하라 수치 Jacobian이
  // 8회여도 검출 100ms보다 작다. 점이 수백 개가 되면 해석 Jacobian으로 바꾼다.
  const units = [0.01, 0.01, 0.01, 10, 10, 10];
  const epsilon = 1e-3;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const rows = [];
    const values = [];
    const base = best.projected;
    const columns = units.map((unit, axis) => {
      const delta = unit * epsilon;
      const r = axis < 3 ? multiply3(rotationIncrement([0, 1, 2].map((i) => i === axis ? delta : 0)), rotation) : rotation;
      const t = axis >= 3 ? translation.map((value, i) => value + (i === axis - 3 ? delta : 0)) : translation;
      return poseMetrics(r, t, worldPoints, imagePoints, intrinsics).projected;
    });
    for (let i = 0; i < imagePoints.length; i += 1) {
      rows.push(columns.map((points) => (points[i].x - base[i].x) / epsilon));
      values.push(imagePoints[i].x - base[i].x);
      rows.push(columns.map((points) => (points[i].y - base[i].y) / epsilon));
      values.push(imagePoints[i].y - base[i].y);
    }
    // 아주 작은 Tikhonov 항은 정면 평면에서 약한 축이 수치적으로 터지는 것만 막는다.
    for (let i = 0; i < 6; i += 1) {
      rows.push([0, 1, 2, 3, 4, 5].map((j) => i === j ? 1e-3 : 0)); values.push(0);
    }
    let step;
    try { step = leastSquares(rows, values).map((value) => Math.max(-5, Math.min(5, value))); }
    catch { break; }
    const candidateRotation = multiply3(rotationIncrement(step.slice(0, 3).map((v, i) => v * units[i])), rotation);
    const candidateTranslation = translation.map((value, i) => value + step[i + 3] * units[i + 3]);
    const candidate = poseMetrics(candidateRotation, candidateTranslation, worldPoints, imagePoints, intrinsics);
    if (!(candidate.rmsPx < best.rmsPx - 1e-7)) break;
    rotation = candidateRotation; translation = candidateTranslation; best = candidate;
    if (Math.hypot(...step) < 1e-5) break;
  }
  const r1 = [rotation[0][0], rotation[1][0], rotation[2][0]];
  const r2 = [rotation[0][1], rotation[1][1], rotation[2][1]];
  const r3 = [rotation[0][2], rotation[1][2], rotation[2][2]];
  const cameraMm = { x: -dot(r1, translation), y: -dot(r2, translation), z: -dot(r3, translation) };
  return { rotation, translation, cameraMm, rmsPx: best.rmsPx };
}

export function tagCornersMm(tag, sizeMm, defaultYawDeg = 0) {
  const half = Number(tag.tagSizeMm ?? sizeMm) / 2;
  const yaw = Number(tag.yawDeg ?? defaultYawDeg) * Math.PI / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [[-half, half], [half, half], [half, -half], [-half, -half]].map(([x, y]) => ({
    x: Number(tag.xMm) + c * x - s * y,
    y: Number(tag.yMm) + s * x + c * y,
    z: Number(tag.zMm ?? 0),
  }));
}

export function projectWorld(point, pose, intrinsics) {
  const { rotation: r, translation: t } = pose;
  const xc = r[0][0] * point.x + r[0][1] * point.y + r[0][2] * (point.z ?? 0) + t[0];
  const yc = r[1][0] * point.x + r[1][1] * point.y + r[1][2] * (point.z ?? 0) + t[1];
  const zc = r[2][0] * point.x + r[2][1] * point.y + r[2][2] * (point.z ?? 0) + t[2];
  if (zc <= 1e-6) return null;
  return { x: intrinsics.fx * xc / zc + intrinsics.cx,
    y: intrinsics.fy * yc / zc + intrinsics.cy, depthMm: zc };
}

export function solvePlanarPose(worldPoints, imagePoints, intrinsics) {
  if (worldPoints.length !== imagePoints.length || worldPoints.length < 4) {
    throw new Error('평면 자세에는 대응 모서리 4점 이상이 필요합니다');
  }
  const ox = worldPoints.reduce((sum, p) => sum + p.x, 0) / worldPoints.length;
  const oy = worldPoints.reduce((sum, p) => sum + p.y, 0) / worldPoints.length;
  const span = Math.max(1, ...worldPoints.map((p) => Math.hypot(p.x - ox, p.y - oy)));
  const rows = [];
  const values = [];
  for (let i = 0; i < worldPoints.length; i += 1) {
    const xw = (worldPoints[i].x - ox) / span;
    const yw = (worldPoints[i].y - oy) / span;
    const x = (imagePoints[i].x - intrinsics.cx) / intrinsics.fx;
    const y = (imagePoints[i].y - intrinsics.cy) / intrinsics.fy;
    rows.push([xw, yw, 1, 0, 0, 0, -x * xw, -x * yw]); values.push(x);
    rows.push([0, 0, 0, xw, yw, 1, -y * xw, -y * yw]); values.push(y);
  }
  const h = [...leastSquares(rows, values), 1];
  const nx = [h[0], h[3], h[6]];
  const ny = [h[1], h[4], h[7]];
  const nc = [h[2], h[5], h[8]];
  const hx = nx.map((v) => v / span);
  const hy = ny.map((v) => v / span);
  const hc = nc.map((v, i) => v - nx[i] * ox / span - ny[i] * oy / span);

  const candidates = [1, -1].map((sign) => {
    const lambda = sign * 2 / (norm(hx) + norm(hy));
    const r1 = normalize(hx.map((v) => v * lambda));
    const r2raw = hy.map((v) => v * lambda);
    const r2 = normalize(r2raw.map((v, i) => v - dot(r1, r2raw) * r1[i]));
    const r3 = normalize(cross(r1, r2));
    const translation = hc.map((v) => v * lambda);
    const rotation = [
      [r1[0], r2[0], r3[0]],
      [r1[1], r2[1], r3[1]],
      [r1[2], r2[2], r3[2]],
    ];
    const cameraMm = { x: -dot(r1, translation), y: -dot(r2, translation), z: -dot(r3, translation) };
    const projected = worldPoints.map((point) => projectWorld(point, { rotation, translation }, intrinsics));
    const valid = projected.every(Boolean) && cameraMm.z > 0;
    const rmsPx = valid ? Math.sqrt(projected.reduce((sum, p, i) =>
      sum + (p.x - imagePoints[i].x) ** 2 + (p.y - imagePoints[i].y) ** 2, 0) / projected.length) : Infinity;
    return { rotation, translation, cameraMm, rmsPx };
  }).filter((candidate) => Number.isFinite(candidate.rmsPx));
  if (!candidates.length) throw new Error('태그면 위의 물리적으로 가능한 자세가 없습니다');
  candidates.sort((a, b) => a.rmsPx - b.rmsPx);
  const refined = refinePose(candidates[0], worldPoints, imagePoints, intrinsics);
  if (refined.cameraMm.z <= 0 || !Number.isFinite(refined.rmsPx)) return candidates[0];
  return refined.rmsPx <= candidates[0].rmsPx ? refined : candidates[0];
}

export function poseFromMarkers(markers, geometry, intrinsics) {
  const unique = [...new Map(markers.map((marker) => [Number(marker.id), marker])).values()]
    .filter((marker) => geometry.tags?.[marker.id] && marker.corners?.length === 4);
  if (unique.length < 3) throw new Error('자세 계산에는 서로 다른 태그 3장 이상이 필요합니다');
  const worldPoints = [];
  const imagePoints = [];
  for (const marker of unique) {
    worldPoints.push(...tagCornersMm(geometry.tags[marker.id], geometry.tagSizeMm, geometry.defaultYawDeg));
    imagePoints.push(...marker.corners.map((corner) => ({ x: Number(corner.x), y: Number(corner.y) })));
  }
  return { ...solvePlanarPose(worldPoints, imagePoints, intrinsics), tags: unique.length,
    tagIds: unique.map((marker) => marker.id).sort((a, b) => a - b), points: worldPoints.length };
}

export function smoothPose(previous, next, alpha = 0.3) {
  if (!previous) return next;
  const column = (r, i) => [r[0][i], r[1][i], r[2][i]];
  const blend = (a, b) => a.map((v, i) => v * (1 - alpha) + b[i] * alpha);
  const r1 = normalize(blend(column(previous.rotation, 0), column(next.rotation, 0)));
  const r2raw = blend(column(previous.rotation, 1), column(next.rotation, 1));
  const r2 = normalize(r2raw.map((v, i) => v - dot(r1, r2raw) * r1[i]));
  const r3 = normalize(cross(r1, r2));
  const cameraMm = {
    x: previous.cameraMm.x * (1 - alpha) + next.cameraMm.x * alpha,
    y: previous.cameraMm.y * (1 - alpha) + next.cameraMm.y * alpha,
    z: previous.cameraMm.z * (1 - alpha) + next.cameraMm.z * alpha,
  };
  const rotation = [[r1[0], r2[0], r3[0]], [r1[1], r2[1], r3[1]], [r1[2], r2[2], r3[2]]];
  const c = [cameraMm.x, cameraMm.y, cameraMm.z];
  const translation = rotation.map((row) => -dot(row, c));
  return { ...next, rotation, translation, cameraMm };
}
