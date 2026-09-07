// 「주행」 탭 — **터틀봇이 실제로 지나간 자취를 되감는다.**
//
// 시뮬레이션이 아니다. 터틀봇 브리지가 주행하는 동안 1초마다 적어 둔 **실측 기록**이고,
// 로봇이 꺼져 있어도 파일로 남아 있어 **실기 없이 본다** (`runs.py` §sample_pose).
//
// ⛔ **읽기만 한다.** 이 탭에는 로봇을 움직이는 버튼이 없다 — 쓰기는 터틀봇 웹앱 하나뿐이다
// (`TB-CONTRACT.md` §미래 접점 ④ · 하드룰 4).
//
// 되감는 동안 3D 는 **실물이 아니다** — 화면이 그렇게 말한다 (`main.jsx` §view 와 같은 태도).
import { useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/index.js';
import { toFrame } from '@fr5/shared/data/frames.js';
import { AMR_MM } from '@fr5/shared/data/layout/catalog.js';
import { Section } from '../Section.jsx';

// 미리보기 안전 높이 — 터틀봇 **윗면에서** 이만큼 떠서 내려다본다.
// ⚠ **정본은 브리지 `config.yaml` 의 `follow.standoffMm`** 이다(지금 165). 화면이 그 값을
// 못 읽어 여기 적어 둔다 — 그리기만 하는 미리보기라 어긋나도 실기엔 영향이 없다.
const STANDOFF_MM = 165;

/**
 * **관찰 자세** — `scripts/dev/observe-map.py` 가 이 경로(`cycle`)에 대해 고른 값이다.
 * 후보 576개를 로봇 IK 로 풀고 실기 게이트로 걸러, **경로 5점을 전부 보면서 판·벽에서
 * 715mm 떨어진** 자세가 이것이다.
 * ⚠ **경로가 바뀌면 다시 뽑아야 한다** — 이 숫자는 그 경로에 딸린 값이지 보편값이 아니다.
 * 손끝은 user1 mm·도, 관절은 도.
 */
const OBSERVE = {
  tcpMmDeg: [128, -654, 369, 180, 0, 0],
  jointsDeg: [10.9, -80.1, 8.3, -18.2, -90.0, 100.9],
};

export function RunPanel({ state, onReplay }) {
  const obsRef = useRef(false);
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState(null);
  const [pick, setPick] = useState(null);
  const [trail, setTrail] = useState(null);
  const [at, setAt] = useState(0);
  const [obs, setObs] = useState(false);   // 관찰 자세로 두고 볼까

  useEffect(() => {
    // **셋을 가른다** — 주소를 모르는 것 · 못 닿는 것(꺼짐) · 그 밖의 오류.
    // 브라우저가 주는 `Failed to fetch` 를 그대로 보이면 사람이 원인을 못 찾는다.
    if (!datasource.tbHost()) {
      setErr('터틀봇 주소를 몰라요 — 안 켠 것이지 고장이 아니에요. 이 페이지를 ?tb=192.168.30.15:5056 으로 한 번 열면 기억해요 (목업은 ?tb=mock).');
      return;
    }
    datasource.tbRuns().then((r) => setRuns(Array.isArray(r) ? r : []))
      .catch((e) => {
        const m = String(e?.message || e);
        setErr(/failed to fetch|networkerror|timeout|aborted/i.test(m)
          ? `터틀봇(${datasource.tbHost()})에 못 닿아요 — 꺼져 있거나 다른 망이에요.`
          : m);
      });
  }, []);

  // 고른 기록의 자취를 받아 3D 로 올린다. **자취가 없는 기록도 있다** — 옛 주행이거나
  // 브리지가 죽어 샘플이 안 남은 경우다. 그때는 「없다」고 말하고 끝낸다(0으로 안 채운다).
  useEffect(() => {
    if (!pick) { setTrail(null); onReplay?.(null); return; }
    let dead = false;
    datasource.tbRunPath(pick).then((s) => {
      if (dead) return;
      setTrail(s);
      setAt(s.length ? s.length - 1 : 0);
      onReplay?.(s.length ? { trail: s, pose: s[s.length - 1] } : null);
      if (s.length) scrubFor(s, s.length - 1);
    }).catch((e) => { if (!dead) { setErr(String(e.message || e)); setTrail([]); } });
    // 탭을 떠나면 유령도 걷는다 — 되감기가 패널보다 오래 살면 3D 가 「실물 아님」을 말할 주인이 없다 (2026-09-06 · 터틀봇 탭으로 이사)
    return () => { dead = true; onReplay?.(null); };
  }, [pick]);

  // 되감으며 **팔이 그때 어디 있었을까**도 같이 푼다.
  //
  // ⛔ **판정은 여기서 안 한다.** 이건 모양을 보는 미리보기이고, 「따라갈 수 있나」는
  // `scripts/dev/follow-run.py` 가 실기 함수(`follow.target_pose`·`safety.check_workspace`)로
  // 이미 판정했다(52/53 통과). 화면이 그 판정을 흉내 내면 둘이 갈린다.
  //
  // 목표는 **터틀봇 윗면 + 안전높이를 똑바로 내려다보는 자세**다. 관절은 **컨트롤러가 푼다**
  // — 화면이 역기구학을 새로 짜지 않는다 (`/ik` · 로봇은 안 움직인다).
  const scrubFor = async (t, i) => {
    if (!t?.length) return;
    const p = t[i];
    const trail = t;
    if (obsRef.current) {
      // **관찰 모드** — 팔을 고정한 채 터틀봇만 지나간다. 팔이 안 움직이니 팔 오차가 안 섞인다.
      onReplay?.({ trail, pose: p, armJoints: OBSERVE.jointsDeg });
      return;
    }
    onReplay?.({ trail, pose: p });                 // 터틀봇은 먼저 옮긴다 (팔은 늦게 와도 된다)
    const u = toFrame({ xMm: p.xMm, yMm: p.yMm, zMm: 0 }, 'odom', 'user1');
    if (!u) return;
    const tcp = [u.xMm, u.yMm, u.zMm + AMR_MM.heightMm + STANDOFF_MM, 180, 0, 0];
    try {
      // ⚠ `datasource.ik` 는 **본문을 통째로** 준다 (2026-08-31 정정 — 예전엔 배열만 줘서
      // 게이트 사유가 화면에 닿기 전에 버려졌다). 여기는 관절만 쓴다.
      const r = await datasource.ik(tcp);
      onReplay?.({ trail, pose: p, armJoints: r?.jointsDeg ?? null });  // 못 풀면 팔을 안 그린다
    } catch { /* 못 물어본 것과 해가 없는 것은 화면에서 같다 */ }
  };
  const scrub = (i) => { setAt(i); scrubFor(trail, i); };

  return (
    <>
      <Section id="amr-runs" title="주행 기록"
        note={datasource.tbHost() === 'mock' ? '⚠ 목업 브리지의 가짜 기록 — 실측 아님' : `터틀봇이 실제로 지나간 자취 — 실기 없이 본다${datasource.tbHost() ? ` · ${datasource.tbHost()}` : ''}`}>
        {err && <p className="hint">{err}</p>}
        {!runs && !err && <p className="hint">불러오는 중…</p>}
        {runs?.length === 0 && <p className="hint">기록이 없어요.</p>}
        {runs?.length > 0 && (
          <select value={pick ?? ''} onChange={(e) => setPick(e.target.value || null)}>
            <option value="">기록을 고르세요</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id.slice(0, 16)} · {r.params?.path ?? r.scriptSlot} · {r.result}
              </option>
            ))}
          </select>
        )}
      </Section>

      {trail && (
        <Section id="amr-replay" title="되감기"
          note={trail.length ? `${trail.length}샘플 · ${trail[trail.length - 1].tSec}초` : '자취 없음'}>
          {trail.length === 0 ? (
            // **「없다」와 「0」을 가른다** — 0으로 채우면 안 달린 주행이 달린 것처럼 보인다
            <p className="hint">이 기록엔 자취가 없어요 — 옛 주행이거나 브리지가 중간에 죽었어요.</p>
          ) : (
            <>
              <label className="row">
                <input type="checkbox" checked={obs}
                  onChange={(e) => { setObs(e.target.checked); obsRef.current = e.target.checked; scrubFor(trail, at); }} />
                <span>관찰 자세로 두고 보기 <b>(팔 고정)</b></span>
              </label>
              <input type="range" min={0} max={trail.length - 1} value={at}
                onChange={(e) => scrub(Number(e.target.value))} style={{ width: '100%' }} />
              <dl className="kv">
                <dt>시각</dt><dd>{trail[at].tSec.toFixed(0)}초</dd>
                <dt>자리 (홈 기준)</dt>
                <dd>x {trail[at].xMm.toFixed(0)} · y {trail[at].yMm.toFixed(0)} mm</dd>
                <dt>방향</dt><dd>{trail[at].thetaDeg.toFixed(1)}°</dd>
              </dl>
              <p className="hint">
                3D 의 터틀봇이 그때 자리로 갑니다. <b>실물이 아니라 기록이에요.</b>
              </p>
            </>
          )}
        </Section>
      )}
    </>
  );
}
