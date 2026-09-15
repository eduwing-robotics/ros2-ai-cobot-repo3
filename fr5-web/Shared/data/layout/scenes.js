// 씬 보관함 — **이름 붙인 배치안 여러 개**를 이 브라우저에 둔다.
//
// 전에는 예시 배치안(A/B)에 편집분을 얹는 `base + patch` 였다. 빈 방에서 팔레트로 전부
// 짓게 되면서 그 방식이 무의미해졌다 — **씬이 곧 완전한 배치안**이다. 훨씬 단순하고,
// 저장·드롭다운·(나중에) 팀 공유가 전부 같은 한 덩어리를 옮기는 일이 된다.
//
// **여기는 팩토리만 있다.** 저장은 `Shared/data/datasource/` 가 한다 —
// 화면이 출처를 모르게 하는 경계이고, 팀 공유(D46)로 갈 때 바뀌는 곳도 거기다.

import { buildPreset, DEFAULT_PRESET } from './presets.js';

/**
 * 새 씬 — **프리셋에서 꺼낸다.** 모양은 여기 없다 (`presets.js` 가 SSOT).
 *
 * 꺼낸 순간부터는 그냥 씬이다 — 프리셋을 나중에 고쳐도 이미 만든 씬은 안 따라간다.
 * 저장분이 발밑에서 바뀌는 것보다 낫다.
 */
export function newScene(name = '새 배치안', preset = DEFAULT_PRESET) {
  return buildPreset(preset, 'scene', name);
}

/** 이름이 겹치지 않게 — 같은 이름이 둘이면 드롭다운에서 무엇을 고른 건지 알 수 없다. */
export function uniqueName(scenes, base) {
  const taken = new Set(Object.values(scenes).map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

let seq = 0;
/**
 * 씬 id — 시간이 아니라 **내용과 무관한 일련번호**다. 저장분을 옮겨도 안 깨진다.
 *
 * `prefix` 는 시나리오도 같은 공장을 쓰기 위한 것이다 (`sc1`…). **접두사를 나눠 두는 이유**는
 * 충돌 때문이 아니라(둘은 다른 보관함이다) 로그·주소줄에서 `s1` 이 배치안인지 시나리오인지
 * 헷갈리지 않게 하려는 것이다.
 */
export function nextSceneId(scenes, prefix = 's') {
  for (;;) {
    seq += 1;
    const id = `${prefix}${Object.keys(scenes).length + seq}`;
    if (!scenes[id]) return id;
  }
}
