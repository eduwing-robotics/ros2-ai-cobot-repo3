// 기억하는 주소 — `?tb=`·`?cam=`·`?depth=` 가 **같은 규약**을 쓰게 하는 한 곳 (2026-08-28).
//
// 규약은 셋이다:
//   · `?키=값`  → 그 값을 쓰고 **기억한다**
//   · `?키=`    → 잊는다 (빈 값은 지우기다)
//   · 아무것도 없으면 → 기억해 둔 값. 그것도 없으면 `null` = **"주소를 모른다"**
//     그건 고장이 아니라 **안 켠 것**이다 — 읽는 쪽이 그렇게 말해야 한다.
//
// ## 왜 화면에 두면 안 되나
//
// `scripts/check/datasource.sh` §① 이 「화면은 출처를 모른다」를 강제한다. 2026-08-28 에
// 대시보드 배치화면이 `localStorage` 를 직접 만져 게이트가 잡았다 — 규약이 화면마다 한 벌씩
// 생기면 **`?tb=` 가 화면에 따라 다르게 동작한다.** 그 순간 사람은 「주소를 줬는데 왜 안
// 되지」를 화면별로 다시 배워야 한다.
//
// ⚠ `localStorage` 는 브라우저 밖(노드 게이트·SSR)에서는 없다 — 없으면 **기억을 포기하고
// 질의만** 쓴다. 없는 것과 비어 있는 것을 가르지 않는다(둘 다 「모른다」다).
const store = (() => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
})();

/**
 * @param key  질의 이름 (`tb` · `cam` · `depth`)
 * @param storeKey 기억 키. 관례는 `fr5.<이름>Host`
 * @returns 정규화된 `host:port` 또는 `null`
 */
export function rememberedHost(key, storeKey) {
  let q = null;
  try { q = new URLSearchParams(globalThis.location?.search ?? '').get(key); } catch { q = null; }
  if (q === null) {
    try { return store?.getItem(storeKey) || null; } catch { return null; }
  }
  // 사람이 주소창에서 복사해 붙인다 — `http://` 와 끝 슬래시를 벗긴다
  const v = q.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  try { if (v) store?.setItem(storeKey, v); else store?.removeItem(storeKey); } catch { /* 프라이빗 모드 */ }
  return v || null;
}
