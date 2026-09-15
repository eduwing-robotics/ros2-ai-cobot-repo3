// 추종 시뮬레이션 — **표적을 따라가는 팔을 화면에서만 움직인다** (2026-08-28).
//
// 실기는 안 움직인다. 브리지 `/ik` 는 컨트롤러에 **묻기만** 하고(조종권·ARMED 를 안 본다),
// 같은 `dry_run` 게이트를 태워 「갈 수 있나 · 가는 길이 통과하나」까지 돌려준다.
// 그래서 이건 그림이 아니라 **실기 기구학으로 푼 시뮬레이션**이다.
//
// ⛔ **실기 손끝 각도에 안 걸린다.** 브리지의 진짜 목표(`follow.goal`)는 손끝 기울기 상한
// (20°)을 넘으면 `null` 을 낸다 — 깊이 검출이 무너지는 자세라 옳은 거부다. 그런데 그건
// **실기가 움직일 때** 지켜야 할 규칙이지, 시뮬레이션이 지킬 규칙이 아니다. 여기서는
// 자세를 **수직 하향으로 고정**해 「팔이 저기까지 닿나」만 본다.
//
// **왜 웹에서 IK 를 부르나** — 브리지 안에서 매 틱 풀면 상태 스트림이 그만큼 느려진다.
// 시뮬레이션은 사람이 볼 때만 필요하므로, 보는 쪽이 부른다.
import { useEffect, useRef, useState } from 'react';
import { datasource } from '../../data/datasource/http.js';
import { maxJointDelta } from '@fr5/shared/data/sim/motion-chunks.js';

// ⭐ **2026-09-04 — 브리지 목표를 그대로 쓴다.** 여기서 자리를 다시 만들지 않는다.
// 그 전에는 높이(165)와 자세(`[180, 0, 0]`)를 **여기서 따로 지어냈고**, 그 탓에 둘이 났다:
//   ① 높이가 프로필과 55mm 갈렸다 (프로필이 220 이 된 뒤로 · D166)
//   ② **`rz` 를 0 으로 박아 IK 가 「해가 없다」를 냈다** — 실기 목표는 지금 손목 각
//      (162.8°)을 쓰고 그건 풀리는데, 0 은 그 자리에서 안 풀린다. **고스트가 영영 안 떴다.**
//      주인님이 *"고스트가 안 움직이는데"* 라고 한 것이 정확히 이 자리다.
// 브리지 `follow.goal` 은 프로필 높이·현재 자세로 이미 풀린 값이다 — **정본을 베끼지 않는다**
// (하드 룰 5). 사본을 두면 화면과 팔이 다른 데를 말하고, 그건 그림이 틀린 것보다 나쁘다.
//
// ⛔ **그래도 대비가 필요하다** — 브리지는 손끝이 20° 넘게 기울면 `goal` 을 `null` 로 낸다.
// 옳은 거부지만 **실기가 움직일 때** 지킬 규칙이지 그림이 지킬 규칙이 아니다. 그때만
// 여기서 자리를 만든다 — 높이는 아래 사본, **자세는 지금 손목 각을 그대로 빌린다.**
const SIM_STANDOFF_MM = 220;      // ⚠ 대비용 사본. 정본은 `config.yaml` 의 `follow.standoffMm`
// 수직 하향 — `rz` 는 **박지 않는다**(위 ②). 지금 손목 각을 쓰고, 못 읽으면 안 그린다
const DOWN_RX_RY = [180, 0];
// 이만큼 안 움직이면 다시 안 푼다. `follow.releaseMm`(25) 와 같은 취지 — 잡음에 팔이 떤다
const MIN_STEP_MM = 25;
// 아무리 빨라도 이 간격 — `/ik` 는 컨트롤러 왕복이라 공짜가 아니다
const MIN_GAP_MS = 500;
const wrapDeg = (d) => ((d % 360) + 540) % 360 - 180;
export const followPoseCandidates = (tcp) => [tcp, [...tcp.slice(0, 5), wrapDeg(tcp[5] + 180)]];

/**
 * `state.follow.target` 을 따라가는 **시뮬레이션 관절각**.
 *
 * @returns `{ jointsDeg, tcpMmDeg, reachable, gate, why }` — 못 풀면 `jointsDeg` 가 null 이고
 *          `why` 가 이유를 든다. **조용히 비지 않는다** (오늘 `goal: null` 로 한 번 데었다).
 */
export function useFollowSim(state, on) {
  const [sim, setSim] = useState(null);
  const [retry, setRetry] = useState(0);
  const lastRef = useRef({ at: 0, tcp: null, gateKey: null, busy: false });

  const target = state?.follow?.target?.user1Mm ?? null;
  const key = target ? target.map((v) => Math.round(v)).join(',') : null;
  // 목표가 그대로여도 안전 전제는 나중에 준비될 수 있다. 연결 직후 조건 26 실패를
  // 영구 캐시하지 않도록, 실제 /ik 게이트에 영향을 주는 상태만 작은 지문으로 묶는다.
  const gateKey = JSON.stringify([
    state?.appliedSettings?.appliedAt ?? null, state?.enabled ?? null, state?.mode ?? null,
    state?.phase ?? null, state?.safety?.code ?? null, state?.safety?.mainErrorCode ?? null,
    state?.safety?.subErrorCode ?? null, state?.safety?.emergencyStop ?? null,
    state?.safety?.safetyStop ?? null, state?.safety?.collisionDetected ?? null,
    state?.motionTarget?.doneAt ?? null, state?.amr?.moving ?? null,
  ]);

  useEffect(() => {
    if (!on || !state?.connected) { setSim(null); return; }
    // ⛔ **표적을 놓쳤다고 그림을 지우지 않는다** (2026-09-04). 앵커 추적기는 2.0초마다
    // 도는데 표적 나이 상한은 2.5초라, 한 판만 늦어도 `target` 이 잠깐 `null` 이 된다.
    // 그때 시뮬을 통째로 비우면 고스트가 **깜빡이며 사라지고**, 사람 눈에는 「안 움직인다」로
    // 보인다 — 주인님이 오늘 그렇게 보셨다.
    // ⚠ **「가는 것은 멈춘다」와 안 부딪힌다** (`VISION-CONTRACT` §못 보면). 그 규칙은
    //    **팔을 보내는 쪽**의 것이다. 여기는 그림이고, 아무것도 안 움직인다 — 지우는 대신
    //    **낡았다고 말한다.** 조용히 옛 자리를 보여주는 것만 아니면 된다.
    if (!target) { setSim((v) => (v ? { ...v, stale: true } : null)); return; }
    // ① 브리지가 낸 목표가 있으면 **그것이 정본이다**
    const fromBridge = state?.follow?.goal?.tcpMmDeg;
    // ② 없으면(기울기 거부 등) 여기서 만든다 — 손목 각은 지금 것을 빌린다
    const rz = state?.tcpMmDeg?.[5];
    const goal = fromBridge
      ?? (Number.isFinite(rz)
        ? [target[0], target[1], target[2] + SIM_STANDOFF_MM, ...DOWN_RX_RY, rz]
        : null);
    if (!goal) { setSim({ tcpMmDeg: null, jointsDeg: null, reachable: false, gate: null,
                          why: '손끝 자세를 못 읽었다 — 손목 각을 빌릴 데가 없다' }); return; }
    const r = lastRef.current;
    const moved = !r.tcp
      || Math.hypot(goal[0] - r.tcp[0], goal[1] - r.tcp[1], goal[2] - r.tcp[2]) > MIN_STEP_MM;
    const gateChanged = r.gateKey !== gateKey;
    if (!moved && !gateChanged) {
      // ⛔ **다시 풀지 않아도 「낡음」은 걷는다** (2026-09-04). 표적이 잠깐 사라졌다 돌아오면
      // 깃발만 남는데, 데드밴드(25mm) 때문에 다시 풀 일이 없어 **영영 낡은 걸로 보인다.**
      // 「표적이 보인다」와 「그림을 다시 그렸다」는 다른 사실이다 — 깃발은 앞엣것을 말한다.
      // 같은 값이면 **같은 객체를 돌려준다** — 안 그러면 매 틱 새 객체라 화면이 계속 다시 그린다.
      setSim((v) => (v && v.stale ? { ...v, stale: false } : v));
      return;
    }
    if (r.busy || Date.now() - r.at < MIN_GAP_MS) {
      // 앞 요청이 끝나는 순간 안전 지문 변경을 놓치지 않게 한 번만 뒤에서 다시 깨운다.
      const wait = Math.max(50, MIN_GAP_MS - (Date.now() - r.at));
      const timer = setTimeout(() => setRetry((v) => v + 1), wait);
      return () => clearTimeout(timer);
    }
    r.busy = true;
    let dead = false;
    Promise.all(followPoseCandidates(goal).map(async (tcp) => ({ tcp, res: await datasource.ik(tcp) }))).then((tries) => {
      if (dead) return;
      const picked = tries.sort((a, b) => {
        const aBad = a.res?.gate?.ok === false || !a.res?.jointsDeg;
        const bBad = b.res?.gate?.ok === false || !b.res?.jointsDeg;
        return Number(aBad) - Number(bBad)
          || maxJointDelta(state?.jointsDeg, a.res?.jointsDeg) - maxJointDelta(state?.jointsDeg, b.res?.jointsDeg);
      })[0];
      const res = picked?.res;
      r.at = Date.now();
      r.tcp = goal;
      r.gateKey = gateKey;
      setSim({
        stale: false,
        tcpMmDeg: picked?.tcp ?? goal,
        jointsDeg: res?.jointsDeg ?? null,
        reachable: res?.reachable !== false && Boolean(res?.jointsDeg),
        gate: res?.gate ?? null,
        why: res?.jointsDeg ? null : (res?.reason ?? '컨트롤러가 답을 안 줬다'),
      });
    }).catch((e) => {
      if (!dead) setSim({ tcpMmDeg: goal, jointsDeg: null, reachable: false, gate: null,
                          why: `IK 실패 — ${String(e).slice(0, 60)}` });
    }).finally(() => { r.busy = false; });
    return () => { dead = true; };
    // ⚠ 브리지 목표도 의존성이다 — 빼면 목표가 바뀌어도 다시 안 푼다
  }, [on, key, gateKey, retry, state?.connected, state?.follow?.goal?.tcpMmDeg?.join(',')]);

  return sim;
}
