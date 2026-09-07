// 브라우저에서 **시뮬레이션이 보는 것**을 꺼낸다 — 충돌 형상과 접촉점.
//
// 왜 이게 있어야 하나 — 재생 화면의 팔·구역은 URDF 와 `config.yaml` 만 있으면 그릴 수 있다.
// 즉 **엔진이 없어도 똑같이 나온다.** 엔진만 아는 것은 따로 있다:
//   · 판정에 실제로 쓰이는 **충돌 형상**(캡슐·상자 — 보기용 메시가 아니다)
//   · 그 자세에서 **닿아 있는 지점**(`ncon`·`contact`)
// 그래서 이 모듈은 `mjv_updateScene` 이 채운 `scene.geoms` 를 그대로 넘긴다 —
// 우리가 형상을 다시 짓지 않는다. 지으면 그건 엔진이 본 것이 아니라 우리 그림이다.
//
// ⚠ **엔진(9.7MB)은 이 파일을 부를 때 처음 받는다.** 1층만 보는 사람은 안 받는다 —
//    호출부가 `import()` 로 지연 로드한다.
// ⚠ **`from_xml_path` 는 가상 파일 시스템만 읽는다.** 호스트 경로를 주면 못 연다 —
//    XML 과 STL 을 먼저 `FS.writeFile` 로 넣는다 (러너와 같은 함정 · `batch.mjs` 주석).
// ⚠ **Embind 핸들은 GC 되지 않는다** — `dispose()` 로 손수 지운다.

const MESH_BASE = '/FAIRINO_FR5/';
// mjtCatBit — 1 정적 · 2 동적 · 4 장식 · 7 전부
const CAT_DYNAMIC = 2;

let pending = null;

/**
 * 장면 하나를 연다. 여러 번 불러도 **한 번만** 받는다 (엔진이 9.7MB 다).
 *
 * ⛔ **장면 XML 은 인자로 받는다 — 여기서 경로를 모른다.** `Sim/out/…` 은 datasource 만
 *    아는 것이고(계약 §화면), 화면이 경로를 알기 시작하면 그 경계가 시뮬에서만 깨진다.
 *    메시는 다르다 — 정적 자산이라 `robot.js` 와 같은 자리에서 받는다.
 */
export function openSimScene(xml) {
  if (!pending) pending = build(xml).catch((e) => { pending = null; throw e; });
  return pending;
}

async function build(xml) {
  if (typeof xml !== 'string' || !xml.includes('<mujoco')) {
    throw new Error('장면 XML 이 아니다 — 배치를 한 번 구우면 생긴다');
  }
  const { default: loadMujoco } = await import('@mujoco/mujoco');
  const mj = await loadMujoco();

  // XML 이 부르는 메시만 받는다 — 목록을 여기 박지 않는다(장면이 바뀌면 같이 바뀐다)
  const files = [...xml.matchAll(/file="([^"]+)"/g)].map((m) => m[1]);
  mj.FS.mkdir('/asset');
  const dirs = new Set();
  await Promise.all(files.map(async (rel) => {
    const dir = `/asset/${rel}`.replace(/\/[^/]+$/, '');
    if (!dirs.has(dir)) { dirs.add(dir); try { mj.FS.mkdir(dir); } catch { /* 이미 있다 */ } }
    const buf = await fetch(MESH_BASE + rel).then((r) => r.arrayBuffer());
    mj.FS.writeFile(`/asset/${rel}`, new Uint8Array(buf));
  }));
  mj.FS.writeFile('/asset/scene.xml', xml);

  const model = mj.MjModel.from_xml_path('/asset/scene.xml');
  const data = new mj.MjData(model);
  const scene = new mj.MjvScene(model, 2000);       // maxgeom — 이 장면은 geom 17개다
  const opt = new mj.MjvOption();
  const cam = new mj.MjvCamera();
  const pert = new mj.MjvPerturb();
  mj.mjv_defaultOption(opt);
  mj.mjv_defaultCamera(cam);
  mj.mjv_defaultPerturb(pert);

  const nq = model.nq;
  const DEG = Math.PI / 180;

  // geom 이름 — 접촉 쌍을 「팔↔터틀봇」처럼 부르려면 필요하다 (`contact-check.js`). 한 번만 푼다
  const dec = new TextDecoder();
  const names = [];
  for (let g = 0; g < model.ngeom; g += 1) {
    const a = model.name_geomadr[g]; let s = '';
    if (a >= 0) { let e = a; while (model.names[e]) e += 1; s = dec.decode(model.names.slice(a, e)); }
    names.push(s);
  }
  // mocap 바디(터틀봇+바구니 · `scene-compose.js`) — 있으면 자리만 옮겨 주행 구간도 잰다
  const amrMocap = (() => {
    for (let b = 0; b < model.nbody; b += 1) if (model.body_mocapid[b] >= 0) return model.body_mocapid[b];
    return -1;
  })();

  return {
    nq,
    names,
    /** 터틀봇(mocap) 자리를 옮긴다 — base 미터 · 요각 rad. mocap 바디가 없으면 false */
    moveAmr(posM, yawRad) {
      if (amrMocap < 0) return false;
      const o = amrMocap * 3; const oq = amrMocap * 4;
      data.mocap_pos[o] = posM[0]; data.mocap_pos[o + 1] = posM[1]; data.mocap_pos[o + 2] = posM[2];
      data.mocap_quat[oq] = Math.cos(yawRad / 2); data.mocap_quat[oq + 1] = 0; data.mocap_quat[oq + 2] = 0; data.mocap_quat[oq + 3] = Math.sin(yawRad / 2);
      return true;
    },
    /**
     * 접촉만 — 그리지 않는다. `mjv_updateScene`·geom 추출을 건너뛰어 `at()` 보다 훨씬 싸다 (경로 표본 700개를 돌릴 때
     * 메인 스레드를 잡아 재생 시계가 멈췄다 · 2026-09-06). `contact-check.js` 가 이걸 먼저 찾는다
     * @returns {{ncon:number, pairs:Array}}
     */
    contactsAt(jointsDeg) {
      for (let j = 0; j < nq; j += 1) { data.qpos[j] = (Number(jointsDeg[j]) || 0) * DEG; data.ctrl[j] = data.qpos[j]; }
      mj.mj_forward(model, data);
      const pairs = [];
      for (let i = 0; i < data.ncon; i += 1) {
        const c = data.contact.get(i);
        if (c) pairs.push([names[c.geom1] ?? '', names[c.geom2] ?? '', c.dist]);
      }
      return { ncon: data.ncon, pairs };
    },
    /**
     * 그 자세에서 엔진이 그리는 geom 목록. **월드 좌표(m)·행 우선 회전행렬**이다 —
     * 화면이 좌표를 다시 만들지 않는다.
     * @returns {{geoms: Array, ncon: number}}
     */
    at(jointsDeg) {
      for (let j = 0; j < nq; j += 1) {
        data.qpos[j] = (Number(jointsDeg[j]) || 0) * DEG;
        data.ctrl[j] = data.qpos[j];
      }
      mj.mj_forward(model, data);
      // **움직이는 것만 받는다** (`mjCAT_DYNAMIC` = 2). 정적 구역까지 받으면 붉은 상자가
      // 화면을 덮는데, 그 구역은 `makeWorkspace` 가 이미 읽기 좋게 그려 놨다 — 두 번 그리면
      // 정작 보여주려던 **팔·툴의 충돌 형상**이 그 안에 묻힌다 (2026-08-12 실렌더).
      mj.mjv_updateScene(model, data, opt, pert, cam, CAT_DYNAMIC, scene);
      const out = [];
      for (let i = 0; i < scene.ngeom; i += 1) {
        const g = scene.geoms.get(i);
        if (!g) continue;
        out.push({
          type: g.type,
          pos: [g.pos[0], g.pos[1], g.pos[2]],
          mat: Array.from({ length: 9 }, (_, k) => g.mat[k]),
          size: [g.size[0], g.size[1], g.size[2]],
          rgba: [g.rgba[0], g.rgba[1], g.rgba[2], g.rgba[3]],
        });
      }
      // **닿은 지점** — 엔진만 아는 것 중 가장 읽기 쉬운 것. 팔의 충돌 형상은 메시라
      // 껍질을 못 그리지만, 접촉점은 좌표 하나라 그대로 찍을 수 있다.
      // ⚠ `data.contact` 는 **스텝마다 새 사본**이다(README §Memory) — 들고 있지 않고 즉시 읽는다
      const contacts = [];
      const pairs = [];        // [이름1, 이름2] — 팔 링크는 '' (구운 MJCF 는 링크 geom 에 이름이 없다)
      for (let i = 0; i < data.ncon; i += 1) {
        const c = data.contact.get(i);
        if (!c) continue;
        contacts.push([c.pos[0], c.pos[1], c.pos[2]]);
        pairs.push([names[c.geom1] ?? '', names[c.geom2] ?? '', c.dist]);
      }
      return { geoms: out, ncon: data.ncon, contacts, pairs };
    },
    dispose() {
      // ⛔ 빼먹으면 모달을 여닫을 때마다 메모리가 는다 (러너에서 같은 것을 겪었다)
      scene.delete(); opt.delete(); cam.delete(); pert.delete();
      data.delete(); model.delete();
      pending = null;
    },
  };
}

/**
 * 엔진 geom 종류 → three.js 지오메트리 인자.
 * 매핑 근거는 `zalo/mujoco_wasm` 의 `src/mujocoUtils.js` (2026-08-12 조사) —
 * **캡슐·상자는 `size` 가 반값**이라 2배 해야 한다. 이걸 새로 유도할 이유가 없다.
 *
 * 0 plane · 1 hfield · 2 sphere · 3 capsule · 4 ellipsoid · 5 cylinder · 6 box · 7 mesh
 * ⚠ **메시(7)는 안 그린다** — 보기용 메시는 재생 화면이 URDF 로 이미 그린다. 여기서
 *   보고 싶은 것은 **판정이 쓰는 충돌 형상**이라, 겹쳐 그리면 그게 가려진다.
 */
export const GEOM = {
  SPHERE: 2, CAPSULE: 3, ELLIPSOID: 4, CYLINDER: 5, BOX: 6, MESH: 7, PLANE: 0,
};
