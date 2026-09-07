// **빌드 산출물에서 내부 주석을 턴다** — `_` 로 시작하는 JSON 키 (2026-08-13 신설).
//
// 왜 필요한가 — 우리 설정 JSON 은 **값마다 출처를 붙이는** 규약이라(`workcell.js` §src)
// `_유도`·`_왜필요한가`·`_출처` 같은 칸에 저장소 내부 사정이 그대로 적혀 있다. 그런데 그 파일을
// 화면이 `import` 하면 **주석까지 통째로 번들에 실린다.** 2026-08-13 배포본 실측 —
// 공개 배포본의 번들에서 이런 것들이 그대로 읽혔다:
//
//   docs/ref/arch/DEPTH-CAM.md · STACK.md §그리퍼 · scripts/check/assets.sh ·
//   scripts/map/cam-lock.sh · Shared/data/camera/state.js · archive/evidence-2026-07/…
//   「대환 사업서 Stroke 항목」 · 「q35·q49 가 태그 검출을 깎았다」
//
// 비밀은 아니다(토큰·실제 IP·이름 0건을 같이 확인했다). **문서 구조와 결정 이력이 새는 것**이고,
// 그건 화면이 낼 정보가 아니다.
//
// ⛔ **원본 파일은 안 건드린다.** 주석은 저장소에 그대로 살아야 다음 사람이 값의 출처를 안다 —
//    터는 것은 **번들뿐**이다. 그래서 생성기(`scripts/build/config.mjs`)가 아니라 여기가 자리다.
//
// ⚠ **개발 서버에서는 안 턴다.** 화면을 만들다 값이 왜 그런지 궁금할 때 `_출처` 가 콘솔에
//    보이는 것이 이 규약의 값이다. `apply: 'build'` 가 그것을 지킨다.

/** `_` 로 시작하는 키를 재귀로 지운다. 배열 안의 객체도 본다. */
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('_')) continue;
      out[k] = strip(x);
    }
    return out;
  }
  return v;
}

/**
 * @param {object} [opts]
 * @param {RegExp} [opts.include] 어느 파일에 걸까. 기본은 우리 설정 JSON 전부
 */
export function stripNotes({ include = /\/Shared\/data\/.*\.json$/ } = {}) {
  let hit = 0;
  return {
    name: 'fr5-strip-notes',
    apply: 'build',
    // ⚠ **`json` 플러그인보다 먼저 잡는다.** 뒤에 서면 이미 JS 모듈이라 키를 못 센다
    enforce: 'pre',
    transform(code, id) {
      if (!include.test(id)) return null;
      let data;
      try { data = JSON.parse(code); } catch { return null; }   // JSON 이 아니면 손대지 않는다
      const before = JSON.stringify(data).length;
      const clean = strip(data);
      const after = JSON.stringify(clean).length;
      if (after === before) return null;
      hit += 1;
      return { code: JSON.stringify(clean), map: null };
    },
    closeBundle() {
      if (hit) console.log(`  주석 턴 설정 파일 ${hit}개 (번들에서만 · 원본은 그대로)`);
    },
  };
}
