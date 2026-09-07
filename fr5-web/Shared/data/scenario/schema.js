// 시나리오 모델 — **시간축을 담아 두는 그릇** (`SHARED-CORE.md` §1.7).
//
// §1.5 가 `stateAt(series, t)` **함수**를 정했다면 여기는 그 `series` 를 **저장하는 모양**이다.
// 2026-08-04 까지 시나리오는 `datasource/mock.js` 안 `DEMO_CYCLE` **상수**였다 — 코드지
// 데이터가 아니라서 고칠 방법도, 배치안마다 다르게 줄 방법도 없었다.
//
// **사건이 들 수 있는 것은 이름과 숫자뿐이다.** 좌표(§1.5)와 관절 각(§1.6)은 금지다 —
// 박으면 같은 시나리오를 배치안 A·B 에 못 태워 **F8 이 무너진다.** 규약만 적어 두면 다음
// 화면이 또 박으므로 `validateScenario` 가 거부하고 `scripts/check/scenario.sh` 가 지킨다.

import { POSE_AT, FEED_POSE_AT, CARRY_BY_ARM } from '../motion/poses.js';

/** 사건이 들 수 있는 칸. 여기 없는 칸은 `validateScenario` 가 이름을 대며 거부한다. */
export const EVENT_KEYS = ['tSec', 'event', 'station', 'armAt', 'amr', 'amrAt', 'stage',
  'pose', 'carry'];

/** 팔 역할 — `pose`·`carry` 의 키다. **배치안의 팔 id 가 아니다** (그러면 F8 이 무너진다). */
export const ROLES = ['process', 'feed'];

/** 시나리오 하나의 빈 골격. */
export function emptyScenario(id = 's1', name = '이름 없는 시나리오') {
  return { id, name, unit: 'mm-deg', events: [] };
}

/**
 * 옛 모양을 지금 모양으로. **읽는 길목 한 곳에서만 부른다** (하드 룰 5).
 *
 * 아직 옛 모양이 없다 — 그래도 **자리를 미리 만들어 둔다.** 배치안이 `arm`→`arms[]` 로
 * 바뀔 때 이 함수가 없었으면 브라우저에 남은 저장분을 손으로 고치게 했을 것이다.
 * **원본을 안 건드린다.** 부른 쪽 객체가 발밑에서 바뀌면 되돌리기가 어긋난다.
 */
export function migrateScenario(S) {
  if (!S || typeof S !== 'object') return S;
  // `series` 라고 적힌 판을 받는다 — 계약의 응답 필드 이름이 `series` 라 헷갈리기 쉽다
  let out = S;
  if (!Array.isArray(out.events) && Array.isArray(out.series)) {
    const { series, ...rest } = out;
    out = { ...rest, events: series };
  }
  if (!Array.isArray(out.events)) return out;
  // **사건이 자기 자세를 들게 채운다** (2026-08-04). 전에는 사건 **이름**으로 전역 표를
  // 뒤졌는데, 이름을 자유롭게 지으면 그 표가 이름을 몰라 팔이 조용히 대기 자세로 선다.
  // 옛 저장분은 여기서 한 번만 올린다 — 읽는 길목이 여기뿐이다 (하드 룰 5).
  const filled = out.events.map((e) => {
    if (!e || typeof e !== 'object' || e.pose) return e;
    const pose = {};
    if (POSE_AT[e.event]) pose.process = [...POSE_AT[e.event]];
    if (FEED_POSE_AT[e.event]) pose.feed = [...FEED_POSE_AT[e.event]];
    const carry = CARRY_BY_ARM[e.event];
    return { ...e, ...(Object.keys(pose).length ? { pose } : {}), ...(carry ? { carry } : {}) };
  });
  return { ...out, events: filled };
}

/**
 * 어긴 곳을 **전부** 돌려준다. 첫 번째에서 멈추지 않는다 — 고치는 사람이 한 번에 보게.
 *
 * **`stateAt` 은 어떤 입력에도 안 던진다**(`timeline.sh` ①). 그래서 틀린 시나리오도
 * 화면을 죽이지 않고 **조용히 아무것도 안 한다** — 그게 이 검사가 필요한 이유다.
 */
export function validateScenario(S) {
  const bad = [];
  if (!S || typeof S !== 'object') return ['시나리오가 객체가 아니다'];
  if (!S.id) bad.push('id 가 없다');
  if (!S.name) bad.push('name 이 없다');
  if (S.unit !== 'mm-deg') bad.push(`unit 이 'mm-deg' 가 아니다: ${S.unit}`);
  if (!Array.isArray(S.events)) return [...bad, 'events 가 배열이 아니다'];

  S.events.forEach((e, i) => {
    const at = `사건 ${i}`;
    if (!e || typeof e !== 'object') { bad.push(`${at}: 객체가 아니다`); return; }
    if (!Number.isFinite(Number(e.tSec))) bad.push(`${at}: tSec 이 숫자가 아니다 — ${e.tSec}`);
    else if (Number(e.tSec) < 0) bad.push(`${at}: tSec 이 음수다 — ${e.tSec}`);

    // **모르는 칸을 이름 대며 거부한다.** 여기가 좌표·관절 각을 막는 자리다 —
    // `posMm`·`j1` 같은 칸이 조용히 들어오면 그 시나리오는 배치안 하나에 묶여 버리고,
    // 그 사실이 F8 을 돌려 볼 때까지 안 드러난다.
    for (const k of Object.keys(e)) {
      if (EVENT_KEYS.includes(k)) continue;
      const why = /^(j[1-6]|joints?|jointsDeg)$/i.test(k) ? '관절 각은 자세표가 든다 (§1.6)'
        : /(Mm|pos|xyz|coord)/i.test(k) ? '좌표는 배치안이 든다 (§1.5)'
          : '계약에 없는 칸이다';
      bad.push(`${at}: '${k}' — ${why}`);
    }

    for (const k of ['event', 'station', 'armAt', 'amr', 'amrAt']) {
      if (e[k] !== undefined && typeof e[k] !== 'string') bad.push(`${at}: ${k} 가 문자열이 아니다`);
    }
    if (e.carry !== undefined && !ROLES.includes(e.carry)) {
      bad.push(`${at}: carry 가 ${ROLES.join('|')} 가 아니다 — ${e.carry}`);
    }
    // **`pose` 는 이름이지 각도가 아니다.** 각도를 넣으면 팔을 200mm 옮겼을 때 허공을
    // 가리키고, 같은 시나리오를 배치안 A·B 에 못 태운다 (F8 · §1.5). 그래서 **이름이면
    // 통과, 숫자·배열이면 거부**로 가른다 — 칸 이름만 보고 막으면 자세를 못 부르게 된다.
    if (e.pose !== undefined) {
      if (!e.pose || typeof e.pose !== 'object' || Array.isArray(e.pose)) {
        bad.push(`${at}: pose 가 역할별 객체가 아니다 — { process: '이름' | ['from','to'] }`);
      } else {
        for (const [role, v] of Object.entries(e.pose)) {
          if (!ROLES.includes(role)) { bad.push(`${at}: pose 에 모르는 역할 — ${role}`); continue; }
          const names = typeof v === 'string' ? [v] : v;
          if (!Array.isArray(names) || names.length < 1 || names.length > 2) {
            bad.push(`${at}: pose.${role} 은 이름 하나 또는 두 벌이다 — ${JSON.stringify(v)}`);
            continue;
          }
          for (const n of names) {
            if (typeof n !== 'string') {
              bad.push(`${at}: pose.${role} 에 ${typeof n} — **자세는 이름으로 부른다** (각도는 자세표가 든다 · §1.6)`);
            }
          }
        }
      }
    }
    if (e.stage !== undefined && !Number.isInteger(e.stage)) bad.push(`${at}: stage 가 정수가 아니다`);
    // AMR 은 **둘이 짝이다** — 하나만 적으면 재생기가 그 AMR 을 못 찾거나 목적지를 모른다
    if ((e.amr === undefined) !== (e.amrAt === undefined)) {
      bad.push(`${at}: amr 과 amrAt 은 같이 적는다`);
    }
  });

  // 이름이 겹치면 드롭다운에서 무엇을 고른 건지 알 수 없다 (배치안과 같은 규칙)
  return bad;
}

/** 사건을 시각순으로. **`stateAt` 도 스스로 정렬하지만** 저장분이 보기 좋아야 사람이 고친다. */
export function sortEvents(events) {
  return [...events].sort((a, b) => Number(a.tSec) - Number(b.tSec));
}
