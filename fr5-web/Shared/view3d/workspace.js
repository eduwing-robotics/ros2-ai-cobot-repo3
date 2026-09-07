// 작업셀을 로봇 옆에 세운다 — **판정면과 소품을 색으로 가른다.**
//
// 왜 필요한가: 브리지는 상판·벽을 알고 명령을 거부하는데(`safety.py` check_workspace)
// 화면은 격자 하나뿐이었다. 그래서 사람은 거부 사유를 글로만 읽었다.
// 여기서 그리는 건 장식이 아니라 **판정 근거를 눈에 보이게 하는 것**이다.
//
// **좌표는 로봇 그대로다** — Z-up · 미터. `mountRobotYUp` 이 준 홀더에 그대로 add 한다.
// 단위 변환은 `Shared/data/units` 한 곳만 쓴다 (하드 룰 5).
import * as THREE from 'three';
import { mm } from '../data/units/units.js';
import { CART, MOUNT_PLATE, SIDE_STAND, floorZMm } from '../data/workcell.js';
import { robotCart, sideStand, scanTexture } from './parts.js';
// 판정면은 파랑, 여유는 주황(여기부터 거부), 소품은 회색. 색이 곧 "근거인가"다.
// **값은 여기 없다** — 배경이 정반대인 두 화면(어두운 트윈 / 밝은 실영상)이 같은 함수를
// 쓰므로 팔레트를 밖으로 뺐다. 색을 고칠 자리는 `zone-theme.js` 하나다 (2026-08-13)
import { resolveTheme } from './zone-theme.js';

/**
 * 판정면·테두리를 실물보다 이만큼 **위로 띄운다**(mm). 2026-08-08 실기 담당자:
 * *"상판이 화면 이동에 따라 번쩍번쩍 빛난다."*
 *
 * 판정면 z 가 잰 값 그대로라 **소품 상판 윗면과 정확히 같은 평면**이었다 —
 * 카트 천판 1000.0 vs 판정 1000.0 · 거치대 상판 888.2 vs 판정 888.2.
 * 면이 정확히 겹치면 깊이 버퍼가 앞뒤를 못 정해 카메라가 움직일 때마다 승자가 바뀐다
 * (z-fighting). `parts.js` 머리말이 소품끼리는 경고해 뒀는데 **판정면에는 아무도 적용한 적이
 * 없었다** — 소품이 생기기 전에는 겹칠 상대가 없어서 드러나지 않았다.
 *
 * 1mm 인 이유 — 여유(10·20mm)의 1/10 이라 "어디부터 거부되나" 를 흐리지 않고,
 * 판정면이 실물 **위**에 뜨는 쪽이라 상판을 파고든 것처럼 보이지도 않는다.
 * ⚠ **그림 전용이다.** 게이트는 `config.yaml` 의 값 그대로 판정한다.
 */
const MARK_LIFT_MM = 1;

function plane(w, h, color, opacity) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }),
  );
  m.renderOrder = -1;                      // 로봇보다 먼저 그린다 — 반투명이 팔을 흐리지 않게
  return m;
}

function edges(geom, color) {
  return new THREE.LineSegments(new THREE.EdgesGeometry(geom), new THREE.LineBasicMaterial({ color }));
}

/**
 * 게이트 값(**사용자 좌표계 1 기준**)을 **로봇 베이스 기준**으로 옮긴다.
 *
 * 이게 없으면 상판이 로봇에서 600mm 떨어진 허공에 그려진다 — 2026-08-07 에 실제로 그랬다.
 * `coordDefs.user` 는 `[x,y,z,rx,ry,rz]` 이고 실측상 **회전이 0** 이라 평행이동만 한다.
 * ⚠ 회전이 0 이 아닌 사용자 좌표계가 오면 **환산을 포기하고 null 을 준다** — 반쯤 맞는
 * 자리에 판정면을 그리는 것이 안 그리는 것보다 나쁘다 (계약 §좌표계 정의).
 */
export function toBase(ws, userDef) {
  if (!ws) return null;
  if (!Array.isArray(userDef) || userDef.length < 6) return null;
  // ⛔ **`Number()` 전에 원본 타입부터 본다** (2026-08-28 감사 · `frames.js` 와 같은 규칙).
  // `Number(null)=0` 이라 값 없음이 「회전 0」으로 둔갑하고, `NaN > 0.5` 는 항상 false 라
  // 문턱도 못 잡는다. 여기는 **판정면**이라 더 무겁다 — 브리지가 좌표계를 파싱 실패해
  // 회전 칸에 쓰레기를 실으면 게이트가 지키는 자리를 화면이 **틀리게 그린다.**
  if (!userDef.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const [dx, dy, dz, rx, ry, rz] = userDef.map(Number);
  if (Math.max(Math.abs(rx), Math.abs(ry), Math.abs(rz)) > 0.5) return null;   // 도(°) 단위
  return {
    ...ws,
    boxes: (ws.boxes ?? []).map((b) => ({
      ...b,
      xMm: b.xMm.map((v) => v + dx),
      yMm: b.yMm.map((v) => v + dy),
      topZMm: b.topZMm + dz,
    })),
    // 벽은 **선분**이라 두 끝점을 다 옮긴다 (2026-08-08 일반화)
    // ⚠ **`seenZMm` 도 옮긴다** — 2026-08-08 저녁까지 여기가 빠져 있어서 벽이 **342mm 낮게**
    // 섰다. `topZMm` 은 옮기면서 벽의 z 만 빠뜨린, 눈에 안 띄는 종류의 누락이다.
    // 확인: 저장값 `−142~538` + 342.1 = **200~880**, 뎁스 스윕 문서가 적은 실측 높이대와 같다.
    // 이 파일이 좌표계로 다친 세 번째 자리다 (D87 · `seenZMm` 오해 · 여기).
    walls: (ws.walls ?? []).map((w) => ({
      ...w,
      aMm: [w.aMm[0] + dx, w.aMm[1] + dy],
      bMm: [w.bMm[0] + dx, w.bMm[1] + dy],
      ...(Array.isArray(w.seenZMm) && w.seenZMm.length === 2
        ? { seenZMm: [w.seenZMm[0] + dz, w.seenZMm[1] + dz] } : {}),
    })),
  };
}

// **점 하나를 옮기는 일은 여기 없다 — `Shared/data/frames.js` 가 한다.**
// 한때 여기 `pointToBase()` 가 있었는데(2026-08-28), 좌표계 SSOT 를 세우면서 옮겼다.
// 같은 일을 하는 길이 둘이면 한쪽만 고쳐지고, 그 갈래가 이 저장소를 네 번 다치게 했다.
// 이 파일은 **상자·벽 뭉치**를 옮기는 `toBase()` 만 든다 (게이트 값 전용).

/** 그림용 바닥 기준 — 첫 상판(카트)이 기준이다. 없으면 0 */
const topZOf = (ws) => ws?.boxes?.[0]?.topZMm ?? 0;


/**
 * @param {object|null} ws 상태 스트림의 `workspace` (mm · 로봇 기준). **없으면 판정면을 안 그린다** —
 *   브리지가 `null` 로 주는 것은 "판정을 안 한다"는 뜻이고, 화면이 없는 판정면을 그리면 거짓말이다.
 * @param {boolean} showProps 카트·바닥 같은 소품을 그릴지
 * @returns {THREE.Group} Z-up·미터. `mountRobotYUp` 홀더에 add 한다
 */
export function makeWorkspace(ws, { showProps = true, theme } = {}) {
  const T = resolveTheme(theme);
  const g = new THREE.Group();
  g.name = 'workspace';

  if (showProps) {
    // ── 바닥
    const floorZ = floorZMm(topZOf(ws));
    const floor = plane(6, 6, T.floor, T.floorA);
    floor.position.z = mm(floorZ);
    g.add(floor);

    // ── 카트 — `parts.js` 의 절차적 팩토리를 그대로 쓴다.
    // **좌표계를 두 번 안 겹치게 한다** — parts.js 는 Y-up·mm·원점 바닥중앙이고
    // 여기는 로봇 Z-up·미터다. 홀더 하나에서만 돌린다 (하드 룰 5 와 같은 정신).
    const holder = new THREE.Group();
    holder.rotation.x = Math.PI / 2;                 // Y-up → Z-up
    holder.rotation.z = CART.facingRad ?? 0;         // ⚠ 문이 어느 쪽인지 미검증
    holder.position.set(mm(CART.offsetMm[0]), mm(CART.offsetMm[1]), mm(floorZ));
    holder.name = 'workcellProps';
    const cart = robotCart({
      wMm: CART.wMm, dMm: CART.dMm,
      hMm: CART.heightMm,                            // 바닥 → 데크 윗면 (줄자)
      mountTMm: MOUNT_PLATE.thickMm, mountMm: MOUNT_PLATE.sideMm,
      deckMap: scanTexture('deck-top'),              // 스캔에서 뽑은 덱 무늬 (parts.js §scanTexture · 노드면 null)
    });
    cart.name = 'cart';
    holder.add(cart);
    g.add(holder);
  }

  if (!ws) return g;                        // 판정을 안 하는 프로필 — 여기서 끝낸다

  // ── 상판들 (카트 상판 · 작업대 …) ────────────────────────────────────────
  // **평면이 아니라 사각 기둥이다** (D73) — x·y 가 안일 때만 높이를 건다. 그래서 윗면만 그린다.
  // 여러 개다 (2026-08-08) — 작업대가 카트 옆에 생기면 목록에 줄 하나가 는다.
  const cellFloorZ = floorZMm(topZOf(ws));      // 바닥 — 상자·벽·거치대가 같이 쓴다
  (ws.boxes ?? []).forEach((b, i) => {
    // ⚠ **낡은/가정값도 그린다 — 다만 다른 색으로** (2026-08-13 · 받침).
    // 예전엔 건너뛰었다. 그런데 게이트는 그 상자로 **실제로 막는다**(`safety.py` §낡은 값도
    // 막는다) — 안 그리면 사람이 **왜 막히는지 화면에서 못 찾는다.** 그렇다고 판정면과
    // 같은 색으로 그리면 실측인 척하는 거짓말이다. 그래서 **세 번째 색**을 쓴다.
    // 소품은 안 세운다 — 실물 치수를 모르는데 실물을 흉내 내면 그게 제일 나쁘다.
    const provisional = Boolean(b.staleReason);
    const [x0, x1] = b.xMm;
    const [y0, y1] = b.yMm;

    // ── 거치대 — **판정면 밑에 실물을 세운다.** `i === 0` 은 카트 상판이라 건너뛴다
    // (`topZOf` 가 이미 그 규약을 쓴다); 그 뒤로 오는 줄은 전부 **따로 선 거치대**다.
    // 이름이 아니라 자리로 가르는 이유 — 프로필마다 이름이 다르고(`상판`/`작업대`),
    // 앞으로 거치대가 더 는다(실기 담당자 2026-08-08). 이름을 박으면 그때마다 여기를 고친다.
    //
    // **크기도 자리도 상자에서 온다. 상수로 안 베낀다** — `config.yaml` 이
    // *"이 작업대는 바뀔 예정이다 — 바뀌면 이 세 줄만 다시 잰다"* 라고 적어 뒀다.
    // 베끼면 다시 재는 날 그림만 옛 자리에 남는다. 그래서 **게이트가 모르면 안 그린다.**
    // 상자는 이미 베이스 기준(`toBase`)이라 카트 홀더 밖에 세운다 — 홀더에 넣으면
    // `facingRad` 로 한 번 더 돌아 실측 자리를 벗어난다.
    if (showProps && i > 0 && !provisional) {
      // ⚠ **상자를 보정하지 않고 그대로 세운다.** 그래서 상자가 틀리면 그림이 카트를 뚫는다 —
      // 그게 버그가 아니라 **검출기**다. 2026-08-08 에 `작업대` 가 196mm 어긋난 것을 잡은 게
      // 정확히 이 방식이었다 (`docs/evidence/2026-08-08/stand-vs-cart-overlap.md`).
      // 그림에서 겹침을 밀어 감추는 코드를 한 번 넣었다가 뺐다 — 감추면 다음 어긋남은
      // 아무도 못 본다. 고칠 곳은 언제나 `config.yaml` 이다.
      const sh = new THREE.Group();
      sh.rotation.x = Math.PI / 2;                     // Y-up → Z-up (카트 홀더와 같은 다리)
      sh.position.set(mm((x0 + x1) / 2), mm((y0 + y1) / 2), mm(cellFloorZ));
      sh.name = `stand:${b.name ?? i}`;
      // 작업대 상판 무늬 — 스캔 정사영(2026-09-05 · 작업대 올리기 전 스캔이지만 **무늬는 판의 것**이라 유효).
      // 이름으로 고른다 — 상자가 늘면 여기에 한 줄 (`Shared/assets/scan/<name>-top.jpg` · 없으면 흰 판)
      const BENCH_MAPS = { 작업대1: 'bench1-top', 작업대2: 'bench2-top', 작업대3: 'bench3-top' };
      sh.add(sideStand({
        topMap: BENCH_MAPS[b.name] ? scanTexture(BENCH_MAPS[b.name]) : null,
        wMm: x1 - x0, dMm: y1 - y0,
        hMm: b.topZMm - cellFloorZ,                     // 바닥 → 상판 윗면
        shelfHMm: SIDE_STAND.shelfHMm,
        tubeMm: SIDE_STAND.tubeMm,
        casterMm: SIDE_STAND.casterMm,
      }));
      g.add(sh);
    }

    // ── 무엇을 그릴지 (2026-08-08 실기 담당자 판정 · 두 번에 걸쳐 좁혀졌다)
    //
    // **소품이 그 면을 실물로 보여주면 판정면·테두리는 안 그린다.** 중복이라 "상판이 두 개" 로
    // 읽힌다. 카트에서 판만 걷고 테두리를 남겼더니 **그 선이 또 두 번째 상판이 됐다** —
    // 게이트 상자 858×587 이 실측 겉치수 808×598 과 범위가 달라(x 로 나가고 y 로 들어온다)
    // 어긋난 판 하나가 떠 있는 그림이 되기 때문이다.
    // 처음엔 "범위를 볼 방법이 사라진다" 며 남겼는데, **읽히지 않는 근거는 근거가 아니다.**
    // 그림에서 빼고 `userData.boxVsProp` 로 올린다 — 화면이 필요하면 글로 말하면 된다.
    //
    // **여유면(주황)은 남긴다** — 상판보다 위에 떠 있어 실물이 표현 못 하는 정보이고,
    // 게이트가 실제로 거부하는 선이 그것이다.
    // ⚠ **카트만 여유면도 뺀다** — 여유가 10mm 뿐이라 데크에 붙어 또 한 겹으로 보인다.
    //
    // 소품을 끄면(`showProps: false`) 판정면이 유일한 근거이므로 그때는 전부 그린다.
    const drawFace = !showProps;                  // 소품이 있으면 판정면은 소품이 대신한다
    const drawMargin = !showProps || i > 0;       // 카트(i=0)는 여유가 10mm 라 뺀다
    const cx = mm((x0 + x1) / 2);
    const cy = mm((y0 + y1) / 2);
    const pw = mm(x1 - x0);
    const ph = mm(y1 - y0);

    if (drawFace) {
      const face = plane(pw, ph, provisional ? T.stale : T.face, T.faceA);
      face.position.set(cx, cy, mm(b.topZMm + MARK_LIFT_MM));
      face.name = `box:${b.name ?? i}`;
      const line = edges(face.geometry, provisional ? T.stale : T.face);
      line.position.copy(face.position);
      g.add(face, line);
    } else {
      (g.userData.boxVsProp ??= []).push(
        `${b.name ?? i} — 게이트가 막는 범위 ${Math.round(x1 - x0)}×${Math.round(y1 - y0)}mm `
        + '(실측 겉치수와 다르다 — 로봇이 못 짚은 쪽은 넓게 잡았다)');
    }

    // 여유(margin) — **"어디부터 거부되나"가 이 선이다.** 상판보다 위에 뜬다.
    // ⚠ 위 `if` 블록 밖에서 `top` 을 쓰지 않는다 — 한 번 그랬다가 **`window.top` 을 집어**
    // 화면이 통째로 죽었다 (2026-08-08). `top`·`self`·`parent` 는 전역에 이미 있어서
    // 블록 밖으로 새면 `ReferenceError` 도 안 나고 조용히 딴 것을 읽는다.
    const mg = b.marginMm ?? 0;
    if (drawMargin && mg) {
      const p = plane(pw, ph, T.margin, T.marginA);
      p.position.set(cx, cy, mm(b.topZMm + mg));
      p.name = `boxMargin:${b.name ?? i}`;
      g.add(p);
    }
  });

  // ── 벽들 — **선분이다.** 끝이 있어서 788mm 짜리 판이 그대로 그려진다 (2026-08-08).
  // 옛 그림은 무한 평면을 y축에 나란히 놓아서, 카트를 돌리자 **엉뚱한 자리에 벽을
  // 세우고 있었다.** 사람이 그걸 보고 실제 공간과 헷갈렸다 — 이 화면의 존재 이유가 그거다.
  // 높이는 **실측이 있으면 실측을 쓴다** (`zMm`). 고정 2.2m 로 그렸더니 680mm 짜리 판이
  // 방을 가로지르는 벽처럼 서서, 실제 공간과 닮게 하려던 목적을 정면으로 배신했다.
  // ⚠ 게이트는 높이를 안 본다(위아래로 넘는 것을 막는 쪽이 보수적) — 이 값은 **그림 전용**이다.
  const FALLBACK_H_MM = 2200;
  // 낡았다고 표시된 것은 **안 그린다.** 게이트는 계속 막지만(안전), 화면은 거짓을 그리느니
  // 비워 둔다 — 카트를 돌린 뒤 옛 벽이 엉뚱한 자리에 서서 사람이 실제 공간과 헷갈린 것이
  // 이 일의 시작이었다. 무엇이 빠졌는지는 `userData.stale` 로 올려 화면이 말하게 한다
  g.userData.stale = [...(ws.boxes ?? []), ...(ws.walls ?? [])]
    .filter((o) => o.staleReason)
    .map((o) => `${o.name ?? '판정면'} — ${o.staleReason}`);

  (ws.walls ?? []).forEach((w, i) => {
    if (w.staleReason) return;
    const [ax, ay] = w.aMm;
    const [bx, by] = w.bMm;
    const len = Math.hypot(bx - ax, by - ay);
    if (!(len > 0)) return;                 // 선분이 아니면 안 그린다 (게이트도 차단한다)
    const yaw = Math.atan2(by - ay, bx - ax);
    // **바닥부터 그린다.** `seenZMm` 은 물체 높이가 아니라 **뎁스 화각이 본 만큼**이다 —
    // 그대로 그리면 바닥에 선 판이 **공중에 뜬다** (2026-08-08 실렌더에서 실제로 그랬다).
    // 위끝은 "적어도 여기까지" 이고, 아래는 바닥까지 있다고 본다 (바닥에 선 물건이므로).
    const seen = Array.isArray(w.seenZMm) && w.seenZMm.length === 2 ? w.seenZMm : null;
    const zLo = cellFloorZ;
    const zHi = seen ? seen[1] : cellFloorZ + FALLBACK_H_MM;
    const hM = mm(Math.max(1, zHi - zLo));
    const place = (obj, offMm) => {
      // 선분 중점에서 법선 방향으로 offMm 만큼 띄운다 (여유선이 벽 앞에 선다)
      const nx = -Math.sin(yaw);
      const ny = Math.cos(yaw);
      // 로봇 밑동(원점)이 있는 쪽 — 게이트가 안전한 쪽으로 보는 그 방향이다
      const s = ((0 - ax) * (by - ay) - (0 - ay) * (bx - ax)) > 0 ? -1 : 1;
      obj.position.set(mm((ax + bx) / 2 + nx * offMm * s),
        mm((ay + by) / 2 + ny * offMm * s), mm((zLo + zHi) / 2));
      obj.rotation.set(Math.PI / 2, 0, yaw, 'ZXY');   // XZ 평면을 선분 방향으로 세운다
    };
    const wall = plane(mm(len), hM, T.face, T.wallA);
    place(wall, 0);
    wall.name = `wall:${w.name ?? i}`;
    // 테두리를 그린다 — 반투명 면만이면 어디서 끝나는지 안 보인다
    const wl = edges(wall.geometry, T.face);
    wl.position.copy(wall.position);
    wl.rotation.copy(wall.rotation);
    g.add(wall, wl);

    // 여유가 크면 그 크기 자체가 정보다 — 얇게 그리면 정밀한 척이 된다
    const wmg = w.marginMm ?? 0;
    if (wmg) {
      const m = plane(mm(len), hM, T.margin, T.wallMarginA);
      place(m, wmg);
      m.name = `wallMargin:${w.name ?? i}`;
      g.add(m);
    }
  });

  return g;
}
