// F7 배치안 편집 — **빈 방에서 팔레트로 짓는다.**
//
// 2026-08-04 에 모델을 바꿨다. 전에는 예시 배치안(A/B)에 편집분을 얹는 `base + patch` 였다.
// 벽만 남기고 전부 팔레트로 놓게 되면서 그 방식이 의미를 잃었다 —
// **씬이 곧 완전한 배치안**이다 (`Shared/data/layout/scenes.js`).
//
// 지킬 것:
//   · 배치안의 **모양을 여기서 새로 정의하지 않는다** — `Shared/data/layout` 이 SSOT (D17)
//   · 좌표 원점은 **실험실 바닥**이다. 로봇 베이스가 아니다 (SR_23)
//   · 부품 목록을 여기에 적지 않는다 — `catalog.js` 가 SSOT
//
// **저장은 여기가 안 한다.** `Shared/data/datasource/` 를 거친다 — 화면이 출처를 모르는
// 경계이고, 팀 공유(D46)로 갈 때 바뀌는 것은 거기 한 줄이다. **여기서 `fetch`·
// `localStorage` 를 부르면 그 경계가 무너진다** (`scripts/check/datasource.sh` 가 지킨다).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { datasource } from '@fr5/shared/data/datasource/index.js';
import { pathLengthMm } from '@fr5/shared/data/layout/schema.js';
import { mountZMm, kindOf, CATALOG, cardKey } from '@fr5/shared/data/layout/catalog.js';
import { newScene, uniqueName, nextSceneId } from '@fr5/shared/data/layout/scenes.js';
import { validateLayout, migrateLayout } from '@fr5/shared/data/layout/schema.js';
import { PRESETS } from '@fr5/shared/data/layout/presets.js';
import { clampPose } from '@fr5/shared/data/motion/limits.js';
import { pointAlong } from '@fr5/shared/data/layout/schema.js';
import { LayoutView } from './LayoutView.jsx';
import { PartsPalette } from './PartsPalette.jsx';

const UNDO_MAX = 50;
/** 출처 배지 — **목업을 실측으로 오인하는 것이 가장 비싼 사고다** (SR_24). */
const SOURCE = datasource.source;

const WALLS = [['south', '남'], ['north', '북'], ['west', '서'], ['east', '동']];

/** 받침이 있으면 `은`, 없으면 `는`. 물건 이름이 데이터에서 오므로 조사를 문장에 못 박는다. */
function eunNeun(name) {
  const c = String(name).codePointAt(String(name).length - 1);
  if (c < 0xac00 || c > 0xd7a3) return '는';
  return (c - 0xac00) % 28 ? '은' : '는';
}

/** 방 안으로 자른다 — 가장자리에서 200mm 는 띄운다 (벽에 파묻히지 않게). */
const clamp = (v, spanMm) => Math.round(Math.min(Math.max(v, 200), Math.max(200, spanMm - 200)));

/** 한 씬 안에서 안 겹치는 id. **결정적이어야** 되돌리기·저장이 안 흔들린다. */
function freshId(scene, prefix) {
  const taken = new Set([
    ...(scene.props ?? []).map((x) => x.id),
    ...(scene.doors ?? []).map((x) => x.id),
    ...(scene.windows ?? []).map((x) => x.id),
  ]);
  for (let i = 1; ; i += 1) if (!taken.has(`${prefix}-${i}`)) return `${prefix}-${i}`;
}

/**
 * 보관함을 datasource 에서 읽어 편집기가 쓰는 모양으로 만든다.
 *
 * **목록과 전문이 갈려 있는 것은 계약이 그렇게 생겼기 때문이다** (`GET /layouts` 는 목록만).
 * 배치안이 하나도 없으면 빈 방 하나를 만들어 넣는다 — 빈 화면을 보여주지 않는다.
 *
 * **지금 보던 배치안은 URL 이 든다** (`?scene=s1`). 저장소가 아니라 *이 탭이 무엇을 보고
 * 있나*라서 그렇다. 덤으로 배치안 링크가 공유 가능해진다.
 */
async function bootstrap() {
  const scenes = {};
  for (const { id } of await datasource.getLayouts()) {
    const L = await datasource.getLayout(id);
    if (L) scenes[id] = L;
  }
  if (!Object.keys(scenes).length) {
    const first = newScene('배치안 1');
    await datasource.putLayout(first);
    scenes[first.id] = first;
  }
  // 시나리오도 같이 싣는다. **배치안이 가리키는 것만 읽지 않는다** — 드롭다운이 전부를
  // 보여줘야 다른 시나리오로 갈아 끼울 수 있다. 저장분이 없으면 프리셋 1건이 온다.
  const scenarios = {};
  for (const { id } of await datasource.getScenarios()) {
    const S = await datasource.getScenario(id);
    if (S) scenarios[id] = S;
  }
  // 자세 보관함 — 시나리오와 같은 규칙. 저장분이 없으면 프리셋 1건이 온다
  const poseSets = {};
  for (const { id } of await datasource.getPoseSets()) {
    const P = await datasource.getPoseSet(id);
    if (P) poseSets[id] = P;
  }
  const want = new URLSearchParams(location.search).get('scene');
  const current = scenes[want] ? want : Object.keys(scenes)[0];
  return {
    current,
    scenes,
    scenarios,
    poseSets,
    currentPoseSet: poseSets[scenes[current]?.poseSetId] ? scenes[current].poseSetId
      : Object.keys(poseSets)[0] ?? null,
    // 지금 무엇을 돌리나 — 배치안이 가리키는 것, 없으면 첫 시나리오
    currentScenario: scenarios[scenes[current]?.scenarioId] ? scenes[current].scenarioId
      : Object.keys(scenarios)[0] ?? null,
  };
}

/** 읽어 오는 동안의 겉껍데기. **본체는 값이 있는 채로 시작한다** — 안이 널을 안 겪는다. */
export function LayoutEditor() {
  const [initial, setInitial] = useState(null);
  const [bootErr, setBootErr] = useState(false);

  useEffect(() => { bootstrap().then(setInitial, () => setBootErr(true)); }, []);

  if (bootErr) {
    return (
      <section className="pane">
        <div className="pane-head"><h2>배치안 편집</h2></div>
        <p className="todo">저장된 배치안을 읽지 못했어요. 새로고침해 보세요.</p>
      </section>
    );
  }
  if (!initial) {
    return (
      <section className="pane">
        <div className="pane-head"><h2>배치안 편집</h2></div>
        <p className="todo">불러오는 중…</p>
      </section>
    );
  }
  return <Editor initial={initial} />;
}

function Editor({ initial }) {
  const [store, setStore] = useState(initial);
  const [past, setPast] = useState([]);
  const [report, setReport] = useState(null);
  const [pickedId, setPickedId] = useState(null);
  const [saveErr, setSaveErr] = useState(false);
  const [poseMsg, setPoseMsg] = useState(null);
  // 패널에서 "그 시각으로" 를 누르면 3D 재생 막대가 감긴다. **`n` 은 같은 시각을 두 번
  // 눌러도 반응하게 하는 도장이다** — 값이 같으면 React 가 갱신을 안 낸다
  const [seekTo, setSeekTo] = useState(null);
  // 좌측 패널 탭 — **경로를 끝내면 화면이 시나리오로 데려간다** (2026-08-04)
  const [tab, setTab] = useState('part');
  const [hotEvent, setHotEvent] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const nameRef = useRef(null);

  const scene = store.scenes[store.current];
  const onReport = useCallback((r) => setReport(r), []);
  const knownRef = useRef(null);
  const knownSRef = useRef(null);

  // 저장. **실패해도 편집은 계속된다** — 대신 화면에 말한다.
  //
  // 편집은 **현재 씬만** 건드리고, 씬이 사라지는 길은 삭제뿐이다. 그래서
  // "지금 씬을 넣고 · 없어진 id 를 지운다" 두 줄이면 되돌리기(삭제 취소 포함)까지 맞는다.
  useEffect(() => {
    const ids = Object.keys(store.scenes);
    const gone = (knownRef.current ?? ids).filter((id) => !ids.includes(id));
    knownRef.current = ids;
    // 시나리오도 같은 규칙으로 — **한 이펙트 안에서** 한다. 둘로 갈라 두면
    // 한쪽만 실패했을 때 화면이 "저장됐다" 와 "안 됐다" 를 동시에 말한다.
    const sids = Object.keys(store.scenarios ?? {});
    const sgone = (knownSRef.current ?? sids).filter((id) => !sids.includes(id));
    knownSRef.current = sids;
    const cur = store.scenarios?.[store.currentScenario];
    Promise.all([
      ...gone.map((id) => datasource.deleteLayout(id)),
      datasource.putLayout(store.scenes[store.current]),
      ...sgone.map((id) => datasource.deleteScenario(id)),
      ...(cur ? [datasource.putScenario(cur)] : []),
      ...(store.poseSets?.[store.currentPoseSet]
        ? [datasource.putPoseSet(store.poseSets[store.currentPoseSet])] : []),
    ]).then(() => setSaveErr(false), () => setSaveErr(true));
  }, [store]);

  // 한 사이클의 시간축. **불러온 뒤로는 보관함이 정본이다** — 배치안이 그런 것과 같다.
  //
  // 전에는 편집할 때마다 `getSeries` 를 다시 불렀는데, 그러면 **화면이 보는 사건과 고치는
  // 사건이 갈라진다** (하나는 받아 온 것, 하나는 편집 중인 것). 시나리오도 배치안처럼
  // 진입할 때 한 번 읽어 보관함에 두고, 저장은 리컨실러가 한다.
  //
  // **정렬하지 않는다** — 화면이 사건을 **번호로** 집으므로 저장된 순서를 그대로 본다.
  // 재생 순서는 `stateAt` 이 스스로 잡는다.
  const curScenario = store.scenarios?.[store.currentScenario] ?? null;
  const series = curScenario?.events ?? [];

  // **배치안을 바꾸면 그 배치안이 가리키는 시나리오로 따라간다.**
  //
  // 빈 방은 `blank`(사건 0개), 조립 라인은 `assembly49` 를 가리킨다. 이걸 안 따라가면
  // 빈 방에서 조립 라인을 새로 만들었을 때 **사건이 0개인 채로** 재생 막대가 아예 안 뜬다
  // (2026-08-04 · 빈 방에 빈 시나리오를 붙이면서 드러났다).
  useEffect(() => {
    const want = store.scenes[store.current]?.scenarioId;
    if (!want || want === store.currentScenario) return;
    if (!store.scenarios?.[want]) return;      // 지워진 것을 가리키면 지금 것을 유지한다
    setStore((prev) => (prev.currentScenario === want ? prev : { ...prev, currentScenario: want }));
  }, [store.current, store.scenes, store.scenarios, store.currentScenario]);

  // 주소줄이 지금 씬을 든다 — 새로고침해도 보던 배치안으로 돌아온다.
  useEffect(() => {
    const u = new URL(location.href);
    if (u.searchParams.get('scene') === store.current) return;
    u.searchParams.set('scene', store.current);
    history.replaceState(null, '', u);
  }, [store.current]);

  /** 씬 하나를 바꾼다. 되돌리기 스택은 **여기 한 곳**에서만 쌓인다. */
  const edit = useCallback((fn) => {
    setStore((prev) => {
      const cur = prev.scenes[prev.current];
      const next = fn(cur);
      if (!next || next === cur) return prev;
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      return { ...prev, scenes: { ...prev.scenes, [prev.current]: next } };
    });
  }, []);

  /**
   * 시나리오 한 벌을 바꾼다. **`edit` 과 같은 문법 · 같은 스택이다** —
   * 되돌리기가 두 곳에서 쌓이면 ⌘Z 가 무엇을 되돌리는지 아무도 모른다.
   * `undo` 는 `prev` **전체**를 스택에 넣으므로 여기만 더하면 되돌리기가 그냥 따라온다.
   */
  const editScenario = useCallback((fn) => {
    setStore((prev) => {
      const cur = prev.scenarios?.[prev.currentScenario];
      if (!cur) return prev;
      const next = fn(cur);
      if (!next || next === cur) return prev;
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      return { ...prev, scenarios: { ...prev.scenarios, [prev.currentScenario]: next } };
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      setStore(p[p.length - 1]);
      return p.slice(0, -1);
    });
  }, []);

  // ── 배치 ───────────────────────────────────────────────────────────────
  /**
   * 팔레트에서 고른 것을 놓는다.
   *
   * `atMm` 을 주면 **그 자리**, 안 주면 방 가운데다 — 눌러서 놓기와 끌어다 놓기가
   * **같은 문**을 쓴다. 둘로 갈라 두면 되돌리기·저장이 두 곳에서 쌓인다.
   * 문·창은 좌표가 아니라 벽 위 위치라 `atMm` 을 안 본다.
   *
   * **방 안으로 자른다.** 바닥은 무한 평면이라 지평선 쪽에 놓으면 −39m 같은 값이 나오고
   * (실렌더가 잡았다), 물건이 어디로 갔는지 영영 모른다. 끌기가 이미 같은 규칙을 쓴다.
   */
  const place = useCallback((card, atMm) => {
    edit((s) => {
      const kind = kindOf(card);
      // **자리는 역할이라 한 배치안에 하나뿐이다.** 둘이면 시나리오가 어느 쪽을 부르는지
      // 알 수 없어진다 — 조용히 두 개 만들지 말고 **말하고 안 만든다**.
      if (kind === 'station') {
        if ((s.stations ?? []).some((x) => x.id === card.id)) {
          setPlaceMsg(`${card.label} 자리는 이미 있습니다. 옮겨서 쓰세요`);
          return s;
        }
        setPlaceMsg(null);
        const at = atMm ?? [s.floor.widthMm / 2, s.floor.depthMm / 2];
        const item = {
          id: card.id, name: card.label,
          posMm: [clamp(at[0], s.floor.widthMm), clamp(at[1], s.floor.depthMm), card.zMm ?? 0],
          ...(card.prop ? { prop: card.prop } : {}),
          ...(card.baseMm !== undefined ? { baseMm: card.baseMm } : {}),
          ...(card.rotDeg !== undefined ? { rotDeg: card.rotDeg } : {}),
          ...(card.opts ? { opts: card.opts } : {}),
        };
        return { ...s, stations: [...(s.stations ?? []), item] };
      }
      // **AMR 은 경로를 갖고 태어난다.** 점이 없으면 `[경로]` 를 켜도 끌 것이 없고,
      // 사람은 "경로 기능이 고장났다" 로 읽는다. 놓은 자리에서 1m 앞까지 두 점을 준다.
      if (kind === 'amr') {
        const at = atMm ?? [Math.round(s.floor.widthMm / 2), Math.round(s.floor.depthMm / 2)];
        const x0 = clamp(at[0], s.floor.widthMm);
        const y0 = clamp(at[1], s.floor.depthMm);
        const y1 = clamp(y0 + 1000, s.floor.depthMm);
        const item = {
          id: freshId(s, 'amr'), model: 'TurtleBot', reachMm: card.reachMm ?? 380,
          dockPosMm: [x0, y0], waypointsMm: [[x0, y0], [x0, y1]],
        };
        return { ...s, amrs: [...(s.amrs ?? []), item] };
      }
      if (kind === 'prop') {
        const item = {
          id: freshId(s, card.id), type: card.id,
          posMm: atMm
            ? [clamp(atMm[0], s.floor.widthMm), clamp(atMm[1], s.floor.depthMm), mountZMm(card)]
            : [Math.round(s.floor.widthMm / 2), Math.round(s.floor.depthMm / 2), mountZMm(card)],
          rotDeg: 0, ...(card.opts ? { opts: card.opts } : {}),
        };
        return { ...s, props: [...(s.props ?? []), item] };
      }
      // **모르는 종류는 조용히 만들지 않는다.** 전에는 마지막 분기로 흘러가 치수 없는
      // 창을 만들었고, three 가 `Computed radius is NaN` 을 쏟았다 — 화면은 안 죽고
      // 보이지 않는 깨진 물건만 남는다 (2026-08-04 · 결함 주입 중에 드러났다).
      if (kind !== 'door' && kind !== 'window') {
        setPlaceMsg(`'${card.label ?? card.id}' 은(는) 아직 놓을 수 없어요`);
        return s;
      }
      // 문·창은 벽에 구멍을 뚫는 것이라 좌표가 아니라 **벽 + 벽 위 위치**다
      const key = kind === 'door' ? 'doors' : 'windows';
      const item = {
        id: freshId(s, kind), wall: 'south',
        atMm: Math.round(s.floor.widthMm / 2), ...card.opts,
      };
      return { ...s, [key]: [...(s[key] ?? []), item] };
    });
  }, [edit]);

  /**
   * 고른 것을 **하나 더 놓는다.** 배치 작업은 같은 것을 여러 개 두는 일이 대부분이다.
   *
   * 소품은 200mm 비껴 놓는다 — 정확히 겹쳐 놓으면 새로 생긴 게 안 보여서
   * "안 눌렸나" 싶어 또 누르게 된다. 문·창은 벽 위에서 폭만큼 비킨다.
   */
  const duplicateItem = useCallback((itemId) => {
    if (!itemId) return;
    let made = null;
    edit((s) => {
      const prop = (s.props ?? []).find((x) => x.id === itemId);
      if (prop) {
        made = { ...structuredClone(prop), id: freshId(s, prop.type),
          posMm: [prop.posMm[0] + 200, prop.posMm[1] - 200, prop.posMm[2] ?? 0] };
        return { ...s, props: [...s.props, made] };
      }
      for (const [key, kind] of [['doors', 'door'], ['windows', 'window']]) {
        const o = (s[key] ?? []).find((x) => x.id === itemId);
        if (!o) continue;
        const span = ['south', 'north'].includes(o.wall) ? s.floor.widthMm : s.floor.depthMm;
        const w = o.widthMm ?? 900;
        const at = Math.min(Math.max(o.atMm + w + 200, w / 2), span - w / 2);
        made = { ...structuredClone(o), id: freshId(s, kind), atMm: at };
        return { ...s, [key]: [...s[key], made] };
      }
      const st = (s.stations ?? []).find((x) => x.id === itemId);
      if (st) {
        let n = 2; while ((s.stations ?? []).some((x) => x.id === `${st.id}${n}`)) n += 1;
        made = { ...structuredClone(st), id: `${st.id}${n}`, name: `${st.name} ${n}`,
          posMm: [st.posMm[0] + 200, st.posMm[1] - 200, st.posMm[2] ?? 0] };
        return { ...s, stations: [...s.stations, made] };
      }
      const arm = (s.arms ?? []).find((x) => x.id === itemId);
      if (arm) {
        // 팔을 하나 더. **id 는 모델 이름 + 번호** — 배치안 안에서만 안 겹치면 된다
        let n = 2; while ((s.arms ?? []).some((x) => x.id === `arm${n}`)) n += 1;
        made = { ...structuredClone(arm), id: `arm${n}`,
          basePosMm: [arm.basePosMm[0] + 600, arm.basePosMm[1], arm.basePosMm[2]] };
        return { ...s, arms: [...s.arms, made] };
      }
      const amr = (s.amrs ?? []).find((x) => x.id === itemId);
      if (amr) {
        const n = (s.amrs.length + 1);
        made = { ...structuredClone(amr), id: `amr${n}`,
          dockPosMm: [amr.dockPosMm[0] + 600, amr.dockPosMm[1]] };
        return { ...s, amrs: [...s.amrs, made] };
      }
      return s;
    });
    if (made) setPickedId(made.id);
  }, [edit]);

  /**
   * 고른 것을 치운다 — **배치안의 모든 목록을 훑는다.**
   *
   * `stations` 를 빠뜨려서 `공급 보관대` 가 안 지워졌다 (2026-08-04). 증상이 고약했다 —
   * 새 객체를 만들어 돌려주므로 **되돌리기 스택은 쌓이는데 화면은 그대로**라,
   * 누른 사람은 "안 눌렸나" 싶어 계속 누른다. **목록을 하나 늘리면 여기도 늘려야 한다.**
   */
  const removeItem = useCallback((itemId) => {
    const ids = new Set(Array.isArray(itemId) ? itemId : [itemId].filter(Boolean));
    if (!ids.size) return;
    const keep = (x) => !ids.has(x.id);
    edit((s) => ({
      ...s,
      props: (s.props ?? []).filter(keep),
      stations: (s.stations ?? []).filter(keep),
      doors: (s.doors ?? []).filter(keep),
      windows: (s.windows ?? []).filter(keep),
      amrs: (s.amrs ?? []).filter(keep),
      // **마지막 팔은 안 지운다** — 팔 없는 배치안은 스키마가 거부한다
      arms: (s.arms ?? []).filter((x) => !ids.has(x.id) || (s.arms ?? []).length <= 1),
    }));
    setPickedId(null);
  }, [edit]);

  /** 문·창 고치기 — 벽과 벽 위 위치. */
  const editOpening = useCallback((id, p) => {
    edit((s) => ({
      ...s,
      doors: (s.doors ?? []).map((x) => (x.id === id ? { ...x, ...p } : x)),
      windows: (s.windows ?? []).map((x) => (x.id === id ? { ...x, ...p } : x)),
    }));
  }, [edit]);

  /** 끌어놓기·숫자칸이 낸 값. 좌표는 mm · 바닥 원점 (SR_23). */
  const onCommit = useCallback((item) => {
    // 문·창은 벽을 따라 미끄러진 결과가 `atMm` 로 온다 (좌표가 아니다)
    if (item.atMm !== undefined && item.wall) {
      editOpening(item.id, { atMm: item.atMm });
      return;
    }
    // **여럿을 함께 옮긴 결과.** 하나씩 보내면 되돌리기가 물건 수만큼 쌓인다
    if (item.many) {
      const by = new Map(item.many.map((m) => [m.id, m.posMm]));
      const move = (x) => (by.has(x.id)
        ? { ...x, posMm: [...by.get(x.id).map(Math.round), x.posMm?.[2] ?? 0] } : x);
      edit((s) => ({
        ...s,
        props: (s.props ?? []).map(move),
        stations: (s.stations ?? []).map(move),
        amrs: (s.amrs ?? []).map((x) => (by.has(x.id)
          ? { ...x, dockPosMm: by.get(x.id).map(Math.round) } : x)),
      }));
      return;
    }
    const patch = (x) => ({
      ...x,
      // **정수 mm 로 못 박는다.** 클램프가 격자 밖 값을 내는데, 그대로 두면
      // 저장분에 9700.000047 같은 숫자가 남는다 (하드 룰 5 — 저장 단위는 mm)
      ...(item.posMm
        ? { posMm: [Math.round(item.posMm[0]), Math.round(item.posMm[1]), x.posMm?.[2] ?? 0] }
        : {}),
      ...(item.rotDeg !== undefined ? { rotDeg: item.rotDeg } : {}),
      // **크기는 `opts` 로 간다** — 부품마다 인자 이름이 다르다 (`catalog.js` 의 SIZE_MM)
      ...(item.opts ? { opts: { ...x.opts, ...item.opts } } : {}),
    });
    edit((s) => ({
      ...s,
      props: (s.props ?? []).map((x) => (x.id === item.id ? patch(x) : x)),
      stations: (s.stations ?? []).map((x) => (x.id === item.id ? patch(x) : x)),
      // **팔도 편집 단위다.** 좌표는 `basePosMm` 이고 **설치 높이(z)는 안 건드린다** —
      // 팔은 받침대 위에 서고, 그 높이는 받침대가 정한다 (하드 룰 5).
      arms: (s.arms ?? []).map((x) => (x.id === item.id
        ? { ...x,
            ...(item.posMm
              ? { basePosMm: [Math.round(item.posMm[0]), Math.round(item.posMm[1]), x.basePosMm[2]] }
              : {}),
            ...(item.rotDeg !== undefined ? { baseYawDeg: item.rotDeg } : {}) }
        : x)),
      // AMR 은 `posMm` 이 아니라 **도킹 자리**를 옮긴다 — 경유점은 그대로 둔다
      amrs: (s.amrs ?? []).map((x) => (x.id === item.id && item.posMm
        ? { ...x, dockPosMm: [Math.round(item.posMm[0]), Math.round(item.posMm[1])] } : x)),
    }));
  }, [edit, editOpening]);

  // ── 씬 관리 ────────────────────────────────────────────────────────────
  /** 프리셋에서 새 씬을 꺼낸다. **현재 씬은 안 건드린다** — 잘못 골라도 잃는 게 없다. */
  const addScene = useCallback((preset) => {
    setStore((prev) => {
      const id = nextSceneId(prev.scenes);
      const p = PRESETS.find((x) => x.id === preset);
      const s = { ...newScene(uniqueName(prev.scenes, p?.label ?? '배치안'), preset), id };
      setPast((p2) => [...p2, prev].slice(-UNDO_MAX));
      return { ...prev, current: id, scenes: { ...prev.scenes, [id]: s } };
    });
    setPickedId(null);
  }, []);

  const dupScene = useCallback(() => {
    setStore((prev) => {
      const id = nextSceneId(prev.scenes);
      const src = prev.scenes[prev.current];
      const s = { ...structuredClone(src), id, name: uniqueName(prev.scenes, `${src.name} 사본`) };
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      return { ...prev, current: id, scenes: { ...prev.scenes, [id]: s } };
    });
    setPickedId(null);
  }, []);

  const delScene = useCallback(() => {
    setStore((prev) => {
      const keys = Object.keys(prev.scenes);
      if (keys.length <= 1) return prev;            // 마지막 하나는 안 지운다
      const rest = { ...prev.scenes };
      delete rest[prev.current];
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      return { ...prev, current: Object.keys(rest)[0], scenes: rest };
    });
    setPickedId(null);
  }, []);

  /**
   * 배치안을 **파일로 내보낸다.**
   *
   * 저장이 브라우저 한 대라(D46 전까지) 팀원에게 배치안을 넘길 길이 아예 없었다.
   * 팀 공유 저장소가 붙기 전까지의 **다리**다 — 붙으면 이 버튼은 남아도 되고 없어도 된다.
   *
   * 새 형식을 만들지 않는다 — **배치안 전문 그대로**다. 그래야 가져오기가 스키마 하나만 보면 된다.
   */
  const exportScene = useCallback(() => {
    const blob = new Blob([JSON.stringify(scene, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${String(scene.name).replace(/[^가-힣a-zA-Z0-9._-]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [scene]);

  const [placeMsg, setPlaceMsg] = useState(null);
  const [importErr, setImportErr] = useState(null);
  /**
   * 파일에서 **새 씬으로** 들여온다. 열려 있는 배치안은 안 건드린다 —
   * 잘못된 파일을 골라도 잃는 게 없어야 한다.
   *
   * **스키마를 반드시 본다.** 아무 JSON 이나 받으면 화면이 그 자리에서 죽는다.
   * 옛 모양(`arm` 하나)은 읽는 길목과 같은 함수로 올린다 (하드 룰 5).
   */
  const importScene = useCallback(async (file) => {
    setImportErr(null);
    try {
      const raw = migrateLayout(JSON.parse(await file.text()));
      const errs = validateLayout(raw);
      if (errs.length) { setImportErr(errs[0]); return; }
      setStore((prev) => {
        const id = nextSceneId(prev.scenes);
        const sc = { ...structuredClone(raw), id,
          name: uniqueName(prev.scenes, raw.name || file.name.replace(/\.json$/i, '')) };
        setPast((p2) => [...p2, prev].slice(-UNDO_MAX));
        return { ...prev, current: id, scenes: { ...prev.scenes, [id]: sc } };
      });
      setPickedId(null);
    } catch (e) {
      setImportErr(`읽을 수 없는 파일입니다: ${e?.message ?? e}`);
    }
  }, []);

  const rename = useCallback((name) => {
    const n = String(name).trim();
    if (!n) return;
    setStore((prev) => ({
      ...prev,
      scenes: { ...prev.scenes, [prev.current]: { ...prev.scenes[prev.current], name: n } },
    }));
  }, []);

  // **보관함을 갈아 끼울 때는 `...prev` 를 반드시 펼친다.** 전에는 `{ current, scenes }` 만
  // 돌려줬는데, 보관함에 시나리오가 생기자 **새 배치안을 만드는 순간 시나리오가 통째로
  // 사라졌다** — 리컨실러가 "없어졌으니 지운다" 로 읽어 저장소까지 비웠다 (2026-08-04).
  // 필드가 늘 때마다 밟는 자리라 `dash-web-verify.mjs` 가 이걸 판정한다.

  // ── 시나리오 ───────────────────────────────────────────────────────────
  //
  // **사건은 번호로 집는다.** 저장된 배열 순서를 그대로 쓰므로 화면의 번호와 저장된 번호가
  // 언제나 같다 — 정렬은 `stateAt` 이 스스로 하니 재생은 영향이 없다 (datasource 주석 참조).

  /** 사건 하나의 시각. **0.5초에 붙인다** — 소품이 100mm 격자에 붙는 것과 같은 발상이다. */
  const moveEvent = useCallback((i, tSec) => {
    editScenario((S) => {
      const t = Math.max(0, Math.round(tSec * 2) / 2);
      if (!S.events[i] || S.events[i].tSec === t) return S;
      const events = S.events.map((e, k) => (k === i ? { ...e, tSec: t } : e));
      return { ...S, events };
    });
  }, [editScenario]);

  /** 사건의 이름 칸을 고친다. **빈 값이면 칸을 지운다** — `station: ''` 은 없는 자리를 부른다. */
  const setEvent = useCallback((i, patch) => {
    editScenario((S) => {
      if (!S.events[i]) return S;
      const next = { ...S.events[i], ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === '' || v == null) delete next[k];
      return { ...S, events: S.events.map((e, k) => (k === i ? next : e)) };
    });
  }, [editScenario]);

  const addEvent = useCallback((tSec) => {
    editScenario((S) => {
      const t = Math.max(0, Math.round(tSec * 2) / 2);
      // **직전 사건을 베낀다.** 빈 사건을 놓으면 그 구간에서 작업물이 사라진다 —
      // 자리를 안 든 사건은 `stateAt` 에서 `from: null` 이 되기 때문이다.
      const before = [...S.events].filter((e) => e.tSec <= t).sort((a, b) => a.tSec - b.tSec).pop();
      const seed = before ? { ...before, tSec: t } : { tSec: t, event: 'move' };
      return { ...S, events: [...S.events, seed] };
    });
  }, [editScenario]);

  const removeEvent = useCallback((i) => {
    // **마지막 하나는 안 지운다** — 사건이 0 개면 사이클이 0 초라 재생 막대가 통째로 사라지고,
    // 되돌리기를 모르는 사람은 시나리오를 잃었다고 생각한다.
    editScenario((S) => (S.events.length <= 1 ? S
      : { ...S, events: S.events.filter((_, k) => k !== i) }));
  }, [editScenario]);

  const dupEvent = useCallback((i) => {
    editScenario((S) => (S.events[i]
      ? { ...S, events: [...S.events, { ...S.events[i], tSec: S.events[i].tSec + 1 }] } : S));
  }, [editScenario]);

  /**
   * 만든 자세를 이름 붙여 보관함에 넣는다. **출처는 `hand` 로 못 박는다** —
   * 손으로 만든 자세와 실기에서 잰 자세가 같은 목록에 섞이면 안 된다 (SR_24).
   * 실기 티칭(`/points`)이 붙으면 그쪽이 `taught` 로 들어온다.
   */
  const savePose = useCallback((name, jointDeg) => {
    const n = String(name).trim();
    if (!n || !jointDeg) return;
    setStore((prev) => {
      const P = prev.poseSets?.[prev.currentPoseSet];
      if (!P) return prev;
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      // **한계 안으로 자르고 넣는다** — 슬라이더는 한계를 알지만 숫자를 직접 넣는 길도 있다
      const pose = { ...clampPose(jointDeg).pose, source: 'hand' };
      const next = { ...P, poses: { ...P.poses, [n]: pose } };
      const L = { ...prev.scenes[prev.current], poseSetId: P.id };
      return {
        ...prev,
        poseSets: { ...prev.poseSets, [P.id]: next },
        scenes: { ...prev.scenes, [prev.current]: L },
      };
    });
  }, []);

  /**
   * 자세를 지운다. **부르고 있는 사건이 있으면 그 사실을 말한다** —
   * 조용히 지우면 그 구간에서 팔이 대기 자세로 서고 아무도 이유를 모른다.
   */
  const deletePose = useCallback((name) => {
    if (!name) return;
    setStore((prev) => {
      const P = prev.poseSets?.[prev.currentPoseSet];
      if (!P?.poses?.[name]) return prev;
      const used = (prev.scenarios?.[prev.currentScenario]?.events ?? []).some((e) => Object
        .values(e.pose ?? {}).some((v) => (typeof v === 'string' ? [v] : v ?? []).includes(name)));
      if (used) { setPoseMsg(`'${name}' 은 시나리오가 쓰고 있습니다. 사건에서 먼저 떼세요`); return prev; }
      setPoseMsg(null);
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      const { [name]: _, ...rest } = P.poses;
      return { ...prev, poseSets: { ...prev.poseSets, [P.id]: { ...P, poses: rest } } };
    });
  }, []);

  /**
   * AMR 경로 점을 바꾼다. **소품 끌기와 같은 문**(`edit`)을 쓴다 —
   * 되돌리기·저장이 두 곳에서 쌓이면 ⌘Z 가 무엇을 되돌리는지 아무도 모른다.
   */
  const setWaypoints = useCallback((pts, id) => {
    edit((sc) => {
      const a = (sc.amrs ?? []).find((x) => x.id === id);
      if (!a || !Array.isArray(pts)) return sc;
      const next = pts.map((q) => [Math.round(q[0]), Math.round(q[1])]);
      if (JSON.stringify(next) === JSON.stringify(a.waypointsMm)) return sc;
      return { ...sc, amrs: sc.amrs.map((x) => (x.id === id ? { ...x, waypointsMm: next } : x)) };
    });
  }, [edit]);

  /**
   * **경로를 그린 AMR 을 시나리오에 넣는다.** 말만 하지 않고 대신 해 준다 —
   * "경로를 어떻게 시나리오에 넣나" 를 세 번 물으셨다 (2026-08-04).
   *
   * 이미 그 AMR 을 부르는 사건이 있으면 **거기로 데려가고**, 없으면 끝에 하나 만든다.
   * 목적지는 **경로 끝점에 가장 가까운 자리** — 사람이 그린 길의 끝이 곧 가려던 곳이다.
   */
  const useInScenario = useCallback((amrId) => {
    setTab('scenario');
    const S = store.scenarios?.[store.currentScenario];
    const a = (scene.amrs ?? []).find((x) => x.id === amrId);
    if (!S || !a) return;
    const at = (S.events ?? []).findIndex((e) => e.amr === amrId);
    if (at >= 0) { setHotEvent(at); return; }
    const end = pointAlong(a.waypointsMm ?? [], 1);
    const near = (scene.stations ?? [])
      .map((x) => ({ id: x.id, d: end ? Math.hypot(x.posMm[0] - end[0], x.posMm[1] - end[1]) : Infinity }))
      .sort((x, y) => x.d - y.d)[0];
    const last = Math.max(0, ...(S.events ?? []).map((e) => Number(e.tSec) || 0));
    editScenario((cur) => ({
      ...cur,
      events: [...(cur.events ?? []), {
        tSec: last + 5, event: `${amrId} 이동`,
        ...(near?.id ? { amr: amrId, amrAt: near.id, station: near.id } : {}),
      }],
    }));
    setHotEvent((S.events ?? []).length);
  }, [store, scene, editScenario]);

  /** 시나리오를 갈아 끼운다. **배치안이 그걸 기억한다** — 다음에 열어도 같은 것이 돈다. */
  const pickScenario = useCallback((id) => {
    setStore((prev) => {
      if (!prev.scenarios[id] || prev.currentScenario === id) return prev;
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      const L = { ...prev.scenes[prev.current], scenarioId: id };
      return { ...prev, currentScenario: id, scenes: { ...prev.scenes, [prev.current]: L } };
    });
  }, []);

  const dupScenario = useCallback(() => {
    setStore((prev) => {
      const cur = prev.scenarios[prev.currentScenario];
      if (!cur) return prev;
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      const id = nextSceneId(prev.scenarios, 'sc');
      const name = uniqueName(prev.scenarios, `${cur.name} 복제`);
      const copy = { ...structuredClone(cur), id, name };
      const L = { ...prev.scenes[prev.current], scenarioId: id };
      return {
        ...prev, currentScenario: id,
        scenarios: { ...prev.scenarios, [id]: copy },
        scenes: { ...prev.scenes, [prev.current]: L },
      };
    });
  }, []);

  const renameScenario = useCallback((name) => {
    const n = String(name).trim();
    if (!n) return;
    editScenario((S) => ({ ...S, name: n }));
  }, [editScenario]);

  const delScenario = useCallback(() => {
    setStore((prev) => {
      const ids = Object.keys(prev.scenarios);
      // **마지막 하나는 안 지운다** — 지우면 돌릴 것이 없어 재생 막대가 사라진다
      if (ids.length <= 1) return prev;
      setPast((p) => [...p, prev].slice(-UNDO_MAX));
      const { [prev.currentScenario]: _, ...rest } = prev.scenarios;
      const next = Object.keys(rest)[0];
      const L = { ...prev.scenes[prev.current], scenarioId: next };
      return { ...prev, scenarios: rest, currentScenario: next,
        scenes: { ...prev.scenes, [prev.current]: L } };
    });
  }, []);

  // 키보드. **입력칸에서는 가로채지 않는다** — 이름을 치다 Delete 를 누르면 배치가 사라진다
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault(); undo(); return;
      }
      if ((e.key === 'd' || e.key === 'D') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); duplicateItem(pickedId); return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && pickedId) {
        e.preventDefault(); removeItem(pickedId);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [undo, removeItem, duplicateItem, pickedId]);

  useEffect(() => { if (renaming) nameRef.current?.select(); }, [renaming]);

  const opening = useMemo(
    () => [...(scene.doors ?? []), ...(scene.windows ?? [])].find((x) => x.id === pickedId),
    [scene, pickedId],
  );
  const isDoor = !!(scene.doors ?? []).find((x) => x.id === pickedId);

  // 헤드리스 검증용 노출 — `main.jsx` 와 같은 방식이다
  useEffect(() => {
    window.__fr5edit = {
      scenes: Object.keys(store.scenes).length, current: store.current, name: scene.name,
      props: scene.props?.length ?? 0, doors: scene.doors?.length ?? 0,
      windows: scene.windows?.length ?? 0, past: past.length, saveErr, pickedId,
      presets: PRESETS.length, source: datasource.source,
      // 시나리오 — **사건 시각을 문자열로 낸다.** 배열로 내면 헤드리스에서
      // 매번 JSON 비교를 해야 하고, 어디가 달라졌는지 눈으로 못 읽는다
      scenarios: Object.keys(store.scenarios ?? {}).length,
      scenarioIds: Object.keys(store.scenarios ?? {}),
      scenarioId: store.currentScenario,
      scenarioName: curScenario?.name ?? null,
      events: series.length,
      eventSecs: series.map((e) => e.tSec).join(','),
      poseSets: Object.keys(store.poseSets ?? {}).length,
      poseSetId: store.currentPoseSet,
      poseNames: Object.keys(store.poseSets?.[store.currentPoseSet]?.poses ?? {}).join(','),
      wp: (scene.amrs ?? []).map((a) => [a.id, a.waypointsMm]),
    };
  });

  const out = report?.reach?.filter((r) => !r.inReach) ?? [];
  const total = (scene.props?.length ?? 0) + (scene.doors?.length ?? 0) + (scene.windows?.length ?? 0);

  return (
    <section className="pane">
      <div className="pane-head">
        <h2>배치안 편집</h2>

        {/* 씬 드롭다운 — 저장된 배치안을 오간다. 저장은 자동이다 */}
        {/* **드롭다운은 하나다.** 고르기와 새로 만들기를 둘로 나눴더니 똑같이 생긴 것이
            둘이라 무엇이 무엇인지 안 보였다 (실기 담당자 지적). 묶음 라벨로 가른다 */}
        <select
          className="scene-pick"
          value={store.current}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('new:')) { addScene(v.slice(4)); return; }
            setStore((p) => ({ ...p, current: v }));
            setPickedId(null);
          }}
          aria-label="배치안 고르기 · 프리셋에서 새로 만들기"
        >
          <optgroup label="저장된 배치안">
            {Object.values(store.scenes).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </optgroup>
          <optgroup label="＋ 프리셋에서 새로">
            {PRESETS.map((p) => (
              <option key={`new:${p.id}`} value={`new:${p.id}`} title={p.hint}>{p.label}</option>
            ))}
          </optgroup>
        </select>
        {renaming
          ? (
            <input
              ref={nameRef} className="scene-name" defaultValue={scene.name}
              onBlur={(e) => { rename(e.target.value); setRenaming(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { rename(e.currentTarget.value); setRenaming(false); }
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          )
          : <button type="button" className="revert" onClick={() => setRenaming(true)}>이름</button>}
        {/* **"복제" 만 쓰면 물건 복제인지 맵 복제인지 안 보인다** (실기 담당자 지적).
            물건 복제는 우클릭 메뉴와 <kbd>Ctrl+D</kbd> 에 있다 */}
        <button type="button" className="revert" onClick={dupScene}>배치안 복제</button>
        <button type="button" className="revert" onClick={exportScene}>내보내기</button>
        <label className="revert as-btn">
          가져오기
          <input
            type="file" accept="application/json,.json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importScene(f); }}
          />
        </label>
        {Object.keys(store.scenes).length > 1 && (
          <button type="button" className="revert" onClick={delScene}>배치안 삭제</button>
        )}

        {placeMsg && <span className="unsaved">{placeMsg}</span>}
        {importErr && <span className="unsaved">{importErr}</span>}
        <span className={saveErr ? 'unsaved' : 'saved'}>
          {saveErr ? '저장할 수 없어요 · 새로고침하면 사라져요' : '이 브라우저에 저장돼요'}
        </span>
        {past.length > 0 && <button type="button" className="revert" onClick={undo}>되돌리기</button>}
        {pickedId && (
          <button type="button" className="revert" onClick={() => removeItem(pickedId)}>
            삭제 <kbd>Del</kbd>
          </button>
        )}
      </div>

      <div className="editor-body">
        <PartsPalette
          onPlace={place} count={total}
          series={series} cycleSec={curScenario ? Math.max(...series.map((e) => e.tSec), 0) : 0}
          stations={scene.stations ?? []} amrs={scene.amrs ?? []}
          onSetEvent={setEvent} onRemoveEvent={removeEvent} onAddEvent={addEvent}
          onSeek={(t) => setSeekTo({ t, n: Date.now() })}
          tab={tab} onTab={setTab} highlightEvent={hotEvent}
        />
        <div className="editor-stage">
          <LayoutView
            layout={scene}
            onReport={onReport}
            onCommit={onCommit}
            onPickId={setPickedId}
            onDuplicate={duplicateItem}
            onRemove={removeItem}
            boundsMm={scene.floor}
            onUndo={undo}
            canUndo={past.length > 0}
            series={series}
            seriesSource={SOURCE}
            scenarios={Object.values(store.scenarios ?? {})}
            scenarioId={store.currentScenario}
            onPickScenario={pickScenario}
            onDupScenario={dupScenario}
            onRenameScenario={renameScenario}
            onDelScenario={delScenario}
            onMoveEvent={moveEvent}
            onSetEvent={setEvent}
            onAddEvent={addEvent}
            onRemoveEvent={removeEvent}
            onDupEvent={dupEvent}
            onSavePose={savePose}
            onDeletePose={deletePose}
            onSetWaypoints={setWaypoints}
            onUseInScenario={useInScenario}
            seekTo={seekTo}
            poseMsg={poseMsg}
            poses={store.poseSets?.[store.currentPoseSet]?.poses ?? null}
            onDropCard={(key, posMm) => {
              const card = CATALOG.find((c) => cardKey(c) === key);
              if (card) place(card, posMm);
            }}
          />
          {/* 문·창은 끌 수 없다 — 벽에 뚫린 구멍이라 **어느 벽 · 벽 위 위치**로 고친다 */}
          {opening && (
            <div className="opening-edit">
              <b>{isDoor ? '문' : '창'}</b>
              <label>
                벽
                <select
                  value={opening.wall}
                  onChange={(e) => editOpening(opening.id, { wall: e.target.value })}
                >
                  {WALLS.map(([w, l]) => <option key={w} value={w}>{l}</option>)}
                </select>
              </label>
              <label>
                위치
                <input
                  type="number" step="100" value={opening.atMm}
                  onChange={(e) => editOpening(opening.id, { atMm: Number(e.target.value) })}
                />
                mm
              </label>
              <label>
                폭
                <input
                  type="number" step="100" min="400" value={opening.widthMm}
                  onChange={(e) => editOpening(opening.id, { widthMm: Number(e.target.value) })}
                />
                mm
              </label>
            </div>
          )}
        </div>
      </div>

      {/* 숫자줄. **해요체로 쓴다** — 읽는 사람은 개발자가 아니라 배치를 정하는 사람이다 */}
      <div className="facts">
        <div>
          <b>팔</b> {scene.arms.map((a) => `${a.id} ${a.reachMm}mm`).join(' · ')}
          {(scene.stations?.length ?? 0) === 0
            ? <span className="mute"> · 스테이션이 아직 없어요</span>
            : out.length === 0
              ? <span className="ok"> · 스테이션에 팔이 전부 닿아요</span>
              : (
                <span className="danger">
                  {' · '}{out.map((r) => r.name).join(', ')}
                  {eunNeun(out[out.length - 1].name)} 팔이 안 닿아요
                </span>
              )}
        </div>
        <div>
          {/* **`경로`** 지 `이동거리` 가 아니다 — 이건 그려 둔 폴리라인의 길이이고, 시나리오가
              그 AMR 을 안 부르면 로봇은 한 발짝도 안 간다. 전에는 `이동거리` 라고 적어
              **안 움직이는 로봇의 6.1m** 를 보여줬다 (2026-08-04). 부르는 AMR 은 재생이
              이 경로를 그대로 따라가므로 두 값이 같다 (`timeline.sh` 가 지킨다). */}
          <b>AMR 경로</b> {scene.amrs?.length ?? 0}대
          {(scene.amrs ?? []).length > 0 && ` · ${scene.amrs
            .map((a) => `${a.id} ${(pathLengthMm(a.waypointsMm) / 1000).toFixed(1)}m`).join(' · ')}`}
        </div>
        <div>
          <b>놓인 것</b> 소품 {scene.props?.length ?? 0} · 문 {scene.doors?.length ?? 0}
          {' · '}창 {scene.windows?.length ?? 0}
        </div>
      </div>
    </section>
  );
}
