// 위반 판정 — **새 정의가 아니라 옮긴 정의다.**
//
// 정본은 `FR5/bridge/safety.py:187 check_workspace` 하나뿐이고 여기는 그것을 자바스크립트로
// 옮긴 사본이다. 시뮬이 구역을 새로 정의하면 화면이 초록인 프로그램을 실기가 거부한다 —
// 계약 `SIM-CONTRACT.md` 불변식 4 가 막는 것이 정확히 그 자리다.
//
// **사본이라는 사실이 이 파일의 전부다.** 그래서:
//   · 여기서 규칙을 "개선" 하지 않는다. 개선하고 싶으면 `safety.py` 를 고치고 여기로 옮긴다
//   · 여유값(`marginMm`)을 시뮬 사정에 맞춰 흔들지 않는다 — 그게 게이트 우회로다
//   · 고쳤으면 `node scripts/check/sim-parity.mjs` 로 자세 200개를 다시 대조한다
//
// **사유 문장은 안 옮긴다.** 저쪽은 사람에게 보여줄 한국어 문장(조사까지 맞춘다)이고
// 이쪽은 96벌을 집계할 구조다. 대조는 **어느 규칙이 어느 이름에 걸렸나**로 한다 —
// 문장을 맞추려 들면 조사 하나 바뀔 때마다 게이트가 거짓으로 빨개진다.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 판정 결과 한 건. `name` 은 프로필에서 온 이름(좌표계·손끝은 없다). */
const RULE = {
  tcpUnreadable: 'tcpUnreadable',   // 손끝을 못 구했다 (결측=차단 · 제1원칙)
  frame: 'frame',                   // 잰 좌표계와 지금이 다르다 — 값 자체가 거짓
  box: 'box',                       // 상판을 뚫는다
  wall: 'wall',                     // 벽에 너무 가깝거나 뚫고 반대편이다
  wallMalformed: 'wallMalformed',   // 벽 값이 선분이 아니다 (결측=차단)
  // ── 툴 전체 (조건 12 · `SAFETY-RULES.md` §작업영역은 손끝 한 점이 아니라) ──
  toolOrientMissing: 'toolOrientMissing',   // 손끝 방향이 없다 — 툴이 어디를 향하는지 모른다
  toolHullMissing: 'toolHullMissing',       // 툴 형상을 못 읽었다 (결측=차단)
  toolBox: 'toolBox',                       // 툴이 상판을 뚫는다
  toolWall: 'toolWall',                     // 툴이 벽에 너무 가깝거나 뚫고 반대편이다
  // ── 팔 링크 (조건 12 · 같은 절) ──
  armHullMissing: 'armHullMissing',         // 팔 형상을 못 읽었다 (결측=차단)
  armFrameMissing: 'armFrameMissing',       // 유저 좌표계 원점을 모른다 (결측=차단)
  armJointsMissing: 'armJointsMissing',     // 관절각을 못 구했다 (결측=차단)
  armLinkMissing: 'armLinkMissing',         // 링크 자세가 빠졌다 (결측=차단)
  armBox: 'armBox',                         // 팔이 상판을 뚫는다
  armWall: 'armWall',                       // 팔이 벽에 너무 가깝거나 뚫고 반대편이다
};

/**
 * @param {number[]} tcpMm 손끝 `[x, y, z]` (mm · 프로필을 잰 좌표계)
 * @param {object|null} ws `config.yaml` 의 `workspace` 프로필 그대로
 * @param {object|null} coord 지금 `{toolId, userId}`
 * @returns {{rule:string, name:string|null}[]} 빈 배열이면 통과
 */
export function judgeWorkspace(tcpMm, ws, coord = null, jointsDeg = null, coordDefs = null) {
  // **ws 가 없으면 판정하지 않는다** — 저쪽과 같다. 없는 규칙을 지어내 막으면
  // mock·미측정 프로필에서 시뮬만 빨개지고, 그 빨간불은 실기에 대응물이 없다
  if (!ws) return [];

  if (!Array.isArray(tcpMm) || tcpMm.length < 3
      || !tcpMm.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return [{ rule: RULE.tcpUnreadable, name: null }];
  }

  const out = [];
  // 값은 잰 좌표계에서만 참이다. 둘 중 하나가 비어 있으면 판정하지 않는 것도 저쪽과 같다 —
  // 파이썬에서 `{}` 는 거짓이라 `want and have` 가 건너뛴다. JS 의 `{}` 는 참이므로 직접 센다
  const want = ws.frame ?? {};
  const have = coord ?? {};
  if (Object.keys(want).length && Object.keys(have).length
      && (want.toolId !== have.toolId || want.userId !== have.userId)) {
    out.push({ rule: RULE.frame, name: null });
  }

  const [x, y, z] = [Number(tcpMm[0]), Number(tcpMm[1]), Number(tcpMm[2])];

  // 상판 — **평면이 아니라 사각 기둥이다.** x·y 가 안일 때만 높이를 건다
  for (const b of ws.boxes ?? []) {
    const [x0, x1] = b.xMm;
    const [y0, y1] = b.yMm;
    const floor = b.topZMm + (b.marginMm ?? 0);
    if (x0 <= x && x <= x1 && y0 <= y && y <= y1 && z < floor) {
      out.push({ rule: RULE.box, name: b.name ?? '상판' });
    }
  }

  // 벽 — **선분까지의 거리다.** 무한 평면으로 재면 카트를 돌리는 순간 값이 거짓이 된다
  for (const w of ws.walls ?? []) {
    const hit = wallHit(x, y, w.aMm, w.bMm, w.marginMm ?? 0);
    if (hit === null) out.push({ rule: RULE.wallMalformed, name: w.name ?? '벽' });
    else if (hit.blocked) out.push({ rule: RULE.wall, name: w.name ?? '벽' });
  }

  out.push(...judgeTool(tcpMm, ws));
  out.push(...judgeArm(jointsDeg, coordDefs, ws));
  return out;
}

/**
 * 벽 선분 a—b 에 대해 손끝 `(x, y)` 가 막히나. 값이 이상하면 `null`.
 *
 * **가까이 가도 안 되고 넘어가도 안 된다.** 거리만 재면 여유 밖으로 관통해 반대편에
 * 서는 것이 통과된다. 안전한 쪽은 **로봇 밑동(원점)이 있는 쪽**이고, 넘어감은
 * **선분 구간 안에서만** 본다 — 그래야 유한한 판 옆으로 돌아가는 정상 동작이 안 막힌다.
 */
function wallHit(x, y, a, b, margin) {
  const nums = [a?.[0], a?.[1], b?.[0], b?.[1], margin].map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const [ax, ay, bx, by, m] = nums;
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  if (L2 <= 0) return null;                       // 두 끝점이 같다 — 선분이 아니다
  const t = ((x - ax) * dx + (y - ay) * dy) / L2;
  const tc = Math.max(0, Math.min(1, t));
  const dist = Math.hypot(x - (ax + tc * dx), y - (ay + tc * dy));
  if (dist < m) return { blocked: true, why: 'near', dist };
  const side = (x - ax) * dy - (y - ay) * dx;
  const originSide = (0 - ax) * dy - (0 - ay) * dx;
  if (t >= 0 && t <= 1 && side * originSide < 0) return { blocked: true, why: 'through', dist };
  return { blocked: false, why: '', dist };
}

// ── 툴 전체 판정 — `safety._check_tool` 의 사본 ───────────────────────────────
// 형상은 **정본에서 읽는다** (`Shared/data/config/tool-hull.json`). 실기 게이트도 같은
// 파일을 읽으므로 여기 숫자를 적을 자리가 없다 — 적는 순간 둘이 갈린다.
const HULL_PATH = join(HERE, '../../Shared/data/config/tool-hull.json');

/** TCP 좌표계 꼭짓점 `[[부위, x, y, z], …]`. 못 읽으면 `Error` 를 값으로 들고 있는다. */
const TOOL_CORNERS_MM = (() => {
  try {
    const hull = JSON.parse(readFileSync(HULL_PATH, 'utf-8'));
    const out = [];
    for (const b of hull.boxes) {
      const { centerMm: c, halfMm: h } = b;
      if (c?.length !== 3 || h?.length !== 3) throw new Error(`상자 ${b.name} 의 값이 셋이 아니다`);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            out.push([b.name, c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]]);
          }
        }
      }
    }
    if (!out.length) throw new Error('상자가 0개다');
    return out;
  } catch (e) { return e; }
})();

/**
 * 고정축 XYZ(RPY) — `R = Rz·Ry·Rx`. 규약 근거는 저쪽 주석과 같은 evidence 다.
 *
 * **내보내는 이유** — `grasp.mjs` 도 손끝 자세를 써야 하는데, 거기서 같은 식을 다시 적으면
 * 회전 규약이 두 곳에 산다. 규약이 갈리는 날 한쪽만 고쳐지고 그 사실은 안 보인다 (하드 룰 5).
 * ⛔ **규칙이 아니라 수학이라 내보내도 「사본」이 안 깨진다** — 판정 분기는 이 파일에만 있다.
 */
export function rotFixedXyz(rxDeg, ryDeg, rzDeg) {
  const d = Math.PI / 180;
  const [cx, sx] = [Math.cos(rxDeg * d), Math.sin(rxDeg * d)];
  const [cy, sy] = [Math.cos(ryDeg * d), Math.sin(ryDeg * d)];
  const [cz, sz] = [Math.cos(rzDeg * d), Math.sin(rzDeg * d)];
  return [[cz * cy, cz * sy * sx - sz * cx, sz * sx + cz * sy * cx],
    [sz * cy, cz * cx + sz * sy * sx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx]];
}

/** 구역 하나당 판정 한 건 — 저쪽이 사유를 한 줄만 내므로 여기도 하나만 낸다. */
function judgeTool(tcpMm, ws) {
  if (TOOL_CORNERS_MM instanceof Error) return [{ rule: RULE.toolHullMissing, name: null }];
  // 파이썬의 `bool` 은 `int` 의 하위형이라 저쪽은 명시적으로 거른다. JS 는 typeof 로 갈린다
  if (tcpMm.length < 6 || !tcpMm.slice(3, 6).every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return [{ rule: RULE.toolOrientMissing, name: null }];
  }
  const r = rotFixedXyz(Number(tcpMm[3]), Number(tcpMm[4]), Number(tcpMm[5]));
  const [ox, oy, oz] = [Number(tcpMm[0]), Number(tcpMm[1]), Number(tcpMm[2])];
  const pts = TOOL_CORNERS_MM.map(([part, px, py, pz]) => [part,
    ox + r[0][0] * px + r[0][1] * py + r[0][2] * pz,
    oy + r[1][0] * px + r[1][1] * py + r[1][2] * pz,
    oz + r[2][0] * px + r[2][1] * py + r[2][2] * pz]);

  const out = [];
  for (const b of ws.boxes ?? []) {
    const [x0, x1] = b.xMm;
    const [y0, y1] = b.yMm;
    const floor = b.topZMm + (b.marginMm ?? 0);
    if (pts.some(([, x, y, z]) => x0 <= x && x <= x1 && y0 <= y && y <= y1 && z < floor)) {
      out.push({ rule: RULE.toolBox, name: b.name ?? '상판' });
    }
  }
  for (const w of ws.walls ?? []) {
    // 망가진 벽은 **손끝 판정이 이미 말했다** — 여기서 또 내면 저쪽보다 한 줄이 많아진다
    const hit = pts.some(([, x, y]) => {
      const h = wallHit(x, y, w.aMm, w.bMm, w.marginMm ?? 0);
      return h !== null && h.blocked;
    });
    if (hit) out.push({ rule: RULE.toolWall, name: w.name ?? '벽' });
  }
  return out;
}

// ── 팔 링크 판정 — `safety._check_arm` 의 사본 ────────────────────────────────
// 형상·체인은 정본(`Shared/data/config/arm-hull.json`)에서 읽는다. 실기 게이트도 같은 파일이다.
const ARM_PATH = join(HERE, '../../Shared/data/config/arm-hull.json');
const ARM_SKIP = new Set(['base_link']);   // 카트에 볼트로 앉아 있어 언제나 구역 안이다 (100%)

const ARM_HULL = (() => {
  try {
    const h = JSON.parse(readFileSync(ARM_PATH, 'utf-8'));
    if (h.chain?.length !== 6) throw new Error(`관절이 6개가 아니다: ${h.chain?.length}`);
    return h;
  } catch (e) { return e; }
})();

const mul3 = (a, b) => a.map((row, i) => [0, 1, 2].map((j) =>
  row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const apply3 = (r, p) => [0, 1, 2].map((i) => r[i][0] * p[0] + r[i][1] * p[1] + r[i][2] * p[2]);

/** 관절각(도) → `{링크: [회전, 위치mm]}`. base_link 기준. 저쪽 `link_poses_mm` 와 같은 식. */
function linkPosesMm(jointsDeg, h = ARM_HULL) {
  if (h instanceof Error) return h;
  if (!Array.isArray(jointsDeg) || jointsDeg.length < 6
      || !jointsDeg.slice(0, 6).every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return new Error('관절각을 못 구했다');
  }
  const out = { [h.baseLink]: [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0]] };
  h.chain.forEach((j, i) => {
    const [pr, pp] = out[j.parent];
    const rr = rotFixedXyz(...j.rpyDeg);
    const q = (Number(jointsDeg[i]) * j.axisSign * Math.PI) / 180;
    const [c, s] = [Math.cos(q), Math.sin(q)];
    const r = mul3(pr, mul3(rr, [[c, -s, 0], [s, c, 0], [0, 0, 1]]));
    const moved = apply3(pr, j.xyzMm);
    out[j.child] = [r, [0, 1, 2].map((k) => pp[k] + moved[k])];
  });
  return out;
}

/** 구역 하나당 판정 한 건 — 저쪽이 사유를 한 줄만 내므로 여기도 하나만 낸다. */
function judgeArm(jointsDeg, coordDefs, ws) {
  if (ARM_HULL instanceof Error) return [{ rule: RULE.armHullMissing, name: null }];
  const user = coordDefs?.user;
  if (!Array.isArray(user) || user.length < 3
      || !user.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return [{ rule: RULE.armFrameMissing, name: null }];
  }
  const poses = linkPosesMm(jointsDeg);
  if (poses instanceof Error) return [{ rule: RULE.armJointsMissing, name: null }];
  const [ux, uy, uz] = user.slice(0, 3).map(Number);

  const pts = [];
  for (const link of ARM_HULL.links) {
    if (ARM_SKIP.has(link.name) || !link.halfMm) continue;
    const pose = poses[link.name];
    if (!pose) return [{ rule: RULE.armLinkMissing, name: link.name }];
    const [r, p] = pose;
    const { centerMm: c, halfMm: h } = link;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const w = apply3(r, [c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]]);
          pts.push([p[0] + w[0] - ux, p[1] + w[1] - uy, p[2] + w[2] - uz]);
        }
      }
    }
  }

  const out = [];
  for (const b of ws.boxes ?? []) {
    const [x0, x1] = b.xMm;
    const [y0, y1] = b.yMm;
    const floor = b.topZMm + (b.marginMm ?? 0);
    if (pts.some(([x, y, z]) => x0 <= x && x <= x1 && y0 <= y && y <= y1 && z < floor)) {
      out.push({ rule: RULE.armBox, name: b.name ?? '상판' });
    }
  }
  for (const w of ws.walls ?? []) {
    // 망가진 벽은 손끝 판정이 이미 말했다 — 여기서 또 내면 저쪽보다 한 줄이 많아진다
    if (pts.some(([x, y]) => {
      const h = wallHit(x, y, w.aMm, w.bMm, w.marginMm ?? 0);
      return h !== null && h.blocked;
    })) out.push({ rule: RULE.armWall, name: w.name ?? '벽' });
  }
  return out;
}

/**
 * 판정 지문 — **이 회차를 무엇이 판정했나** (계약 §화면 · 2026-08-12 신설).
 *
 * 왜 필요한가 — 게이트가 손끝 한 점 → 툴 전체 → 팔 링크로 넓어진 날(2026-08-11 20:59),
 * **19:42 에 구운 `agg.json` 이 화면에 그대로 떠 있었다.** 물리는 같은데 판정이 달라
 * 숫자가 다른 회차인데, `sceneBuiltFrom`(장면 지문)은 둘을 구분하지 못한다.
 *
 * **형상 파일까지 센다** — 판정 코드가 그대로여도 `arm-hull.json` 의 상자 하나가 커지면
 * 같은 물리에서 다른 위반이 난다. `clearance.mjs` 도 넣는다: 밴드의 세로축 값을 그 파일이
 * 정하므로, 판정이 안 바뀌어도 그게 바뀌면 회차를 나란히 놓을 수 없다.
 *
 * ⚠ **버전 문자열을 손으로 올리지 않는다** — 올리는 걸 잊는 날이 반드시 온다.
 */
export function judgeFingerprint() {
  // `grasp.mjs` 도 센다 — 판정이 안 바뀌어도 파지 계측이 바뀌면 회차를 나란히 못 놓는다.
  // `clearance.mjs` 를 넣은 것과 같은 이유이고, 칸 4 의 순위가 이 값 위에 선다.
  const covers = ['judge.mjs', 'clearance.mjs', 'grasp.mjs',
    '../../Shared/data/config/tool-hull.json', '../../Shared/data/config/arm-hull.json',
    '../../Shared/data/config/gripper-mount.json'];
  const h = createHash('sha256');
  for (const rel of covers) h.update(readFileSync(join(HERE, rel)));
  return {
    fingerprint: h.digest('hex').slice(0, 12),
    rules: Object.keys(RULE).length,
    covers: covers.map((c) => c.replace('../../', '')),
  };
}

export { RULE };
