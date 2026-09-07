// 슬라이더 + 숫자칸 한 쌍을 묶는다.
//
// **타이핑 중인 칸에 값을 되쓰지 않는다.** 이 파일이 존재하는 유일한 이유다.
// 되쓰면 세 가지가 한꺼번에 깨진다 —
//   ① 커서가 매 글자 끝으로 튄다
//   ② `parseFloat('0.')` 이 `0` 이라 방금 친 소수점이 지워진다 → 소수를 못 친다
//   ③ 하한이 걸린 칸은 하한보다 작은 수를 **접두사로도** 못 친다.
//      `80` 을 치려고 `8` 을 누르면 그 순간 하한(40)으로 튀어 `8` 이 사라진다.
//
// ③ 이 제일 고약한 이유는 `Number('')` 가 **NaN 이 아니라 0** 이기 때문이다.
// `if (!Number.isFinite(n)) return` 로는 안 걸러져서, 칸을 비우는 순간
// 0 → 클램프 → 하한이 박힌다. 결국 **아무것도 지울 수 없는 칸**이 된다.
//
// 그래서 규칙을 나눈다 — **타이핑 중(`input`)에는 읽기만, 정리(`change`)에서만 되쓴다.**

/**
 * @param range   `<input type="range">` — min·max 의 출처다
 * @param number  `<input type="number">`
 * @param round   표시값 다듬기 (예: 정수만 쓰는 칸은 `Math.round`)
 * @param onValue 값이 확정될 때마다 부른다
 * @returns {{ set: (n:number)=>number, get: ()=>number }}
 */
export function bindNumberPair({ range, number, round = (n) => n, onValue }) {
  const min = Number(range.min);
  const max = Number(range.max);
  const clamp = (n) => round(Math.min(max, Math.max(min, n)));

  let last = clamp(Number(range.value || number.value || 0));

  const apply = (n) => { last = n; onValue(n); };

  // 슬라이더는 타이핑이 아니다 — 숫자칸에 되써도 안전하다.
  range.addEventListener('input', () => {
    const n = clamp(Number(range.value));
    number.value = n;
    apply(n);
  });

  // 타이핑 중. **`number.value` 를 절대 건드리지 않는다.**
  number.addEventListener('input', () => {
    const raw = number.value.trim();
    if (raw === '') return;                    // 지우는 중이다
    const n = Number(raw);
    if (!Number.isFinite(n)) return;           // '-' '.' '1e' 같은 중간 상태
    if (n < min || n > max) return;            // 아직 다 안 친 것일 수 있다 (8 → 80)
    range.value = n;
    apply(round(n));
  });

  // 다 치고 난 뒤(엔터·포커스 이탈). 클램프와 되쓰기는 **여기서만** 한다.
  number.addEventListener('change', () => {
    const raw = number.value.trim();
    const n = Number(raw);
    // 빈 칸으로 떠나면 마지막 성한 값으로 되돌린다 — 빈 칸을 0 으로 읽지 않는다.
    const v = raw !== '' && Number.isFinite(n) ? clamp(n) : last;
    number.value = v;
    range.value = v;
    apply(v);
  });

  const set = (n) => {
    const v = clamp(Number(n));
    number.value = v;
    range.value = v;
    apply(v);
    return v;
  };

  return { set, get: () => last };
}
