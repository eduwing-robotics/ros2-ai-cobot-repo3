#!/usr/bin/env bash
# check/ 아래 모든 게이트를 순서대로 돌린다.
# 세션 마무리와 CI에서 이것만 부르면 된다.
#
# 종료 코드 — **셋이다** (2026-08-08 · 아래 락 설명 참조)
#   0  통과
#   1  실패 — 게이트가 무언가 잡았다
#   2  **판정 못 함** — 실렌더를 한 번도 못 돌렸다. **통과가 아니다.**
#
# 2 를 새로 판 이유: 락을 못 잡았을 때 여기가 `exit 0` 으로 빠지고 있었다. 세션이 여럿이면
# 늦게 온 판이 전부 조용히 건너뛰면서 **초록을 냈다** — 검출 실패보다 나쁘다. *검출 안 함*이
# *통과*로 보고되기 때문이다. 실측 2026-08-08: 이 기계에 claude 프로세스 40개가 떠 있었고
# `--fast` 가 설계값 9.1초 대신 271초 걸렸다. 그 조건에서 락 경합은 예외가 아니라 정상 상태다.
# `SAFETY-RULES.md` 제1원칙 그대로 — **못 읽은 값은 통과가 아니라 경고다.**

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# `--fast` — 실렌더(`*-render.sh`)와 **문서 전수 검사 둘**(`docs.sh`·`refs.sh`)을 뺀다.
# 남는 21개가 **16초** (실측 2026-08-08 · 세션 40개가 붙은 포화 상태에서). 뺀 둘을 넣으면
# 170초라 60초 훅 타임아웃에 잘린다 — 아래 §제외 참조.
# 실렌더 3개는 172초라 60초 훅 타임아웃 안에 절대 못 들어간다. 억지로 넣으면
# **중간에 잘려 판정을 못 내고**, 잘릴 때 vite·uvicorn 자식이 포트를 쥔 채 남아
# 다음 판의 포트 가드를 때린다 — 실측으로 178건 게이트가 0.3초에 죽었다.
# 그래서 실렌더는 `SessionEnd`(세션이 진짜 끝날 때) 한 번만 전량 돈다.
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1
# `--force` — 아래 §반복 방지를 건너뛴다. 평소엔 쓸 일이 없다.
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# ── 반복 방지 (2026-08-08 · 실기 담당자) ──────────────────────────────────────────
# **한 번 도는 건 필요하고, 두 번째부터가 낭비다.** 전량은 180초인데 세션 중간에 이걸
# 손으로 되풀이 부르면 개발이 그만큼 멈춘다 — 실측 2026-08-08: 한 세션에서 전량을 다섯 번
# 부르다 포트 고아까지 만들어 그다음 판을 두 번 더 죽였다.
#
# **시간만으로 막지 않는다.** 코드를 고치고 다시 부른 것을 건너뛰면 사람이 옛 결과를
# 초록으로 읽는다 — 게이트가 거짓말을 하는 셈이라 그게 훨씬 나쁘다. 그래서 **작업 트리가
# 그대로일 때만** 건너뛴다. 한 글자라도 고쳤으면 무조건 다시 돈다.
# **판정도 같이 적는다** (2026-08-08). 스탬프는 실패해도 남기는데(아래 §완주 기록) 건너뛰는
# 쪽이 `exit 0` 이면, 같은 트리에서 **빨갛게 끝난 판을 두 번째 호출이 초록으로 바꾼다.**
# 건너뛰기의 근거는 "같은 트리면 같은 결과" 이므로, 되돌려 줄 것도 **그때의 판정 그대로**다.
# **빠른 게이트도 같은 장치를 쓴다** (2026-08-08). `Stop` 훅이 **응답마다** 이걸 부르는데,
# 트리가 안 바뀐 턴(질문에 답만 한 턴, 파일을 읽기만 한 턴)이 실제로는 절반이 넘는다.
# 설계값은 9.1초지만 실측 271초였다 — 이 기계에 claude 프로세스가 40개 떠 있어 27개 게이트가
# 포화된 CPU 를 나눠 쓴다. 세션이 늘수록 이 비용은 세션 수의 제곱으로 는다(각자가 남의 부하다).
# 트리가 그대로면 결과도 그대로이므로, 다시 도는 것은 **판정을 새로 얻지 못하는 지출**이다.
# 모드마다 스탬프를 따로 둔다 — 빠른 판정으로 전량 판정을 대신하면 그게 또 가짜 초록이다.
# **스탬프는 worktree 마다 따로 둔다** (2026-08-08). 세션을 `git worktree` 로 가르면 트리가
# 서로 다르므로, 스탬프 경로가 하나면 두 worktree 가 **번갈아 서로의 스탬프를 무효화**해
# 건너뛰기가 영영 안 걸린다 — 장치를 넣고도 효과가 0 이 되는 자리다.
# 반대로 **락은 전역이 맞다** — 포트는 기계에 한 벌뿐이라 worktree 를 갈라도 여전히 하나다.
WT_KEY=$(git rev-parse --show-toplevel 2>/dev/null | shasum | cut -c1-8)
if [ "$FAST" -eq 1 ]; then
  MODEKEY=fast;   STAMP="/tmp/fr5-gate-fast.${WT_KEY:-solo}.last";   GLABEL="빠른 게이트"
else
  MODEKEY=render; STAMP="/tmp/fr5-gate-render.${WT_KEY:-solo}.last"; GLABEL="전량 게이트"
fi
# ── 증거를 남긴다 (2026-08-10 · 실기 담당자) ──────────────────────────────────────
# 여태 실패한 게이트의 **이름조차 모으지 않았다.** 끝 줄이 "실패한 게이트가 있다" 하나뿐이라
# FAIL 은 407건 출력 **중간**에 흩어져 있고 끝에는 답이 없다 — 그래서 `tail` 로 받으면
# 마지막 게이트 하나만 보이고 답은 통째로 사라진다. 실측 2026-08-10: 1회차를 `tail -40` 으로
# 파이프해 FAIL 목록을 잃고, 그것 때문에 10분짜리 전량을 **세 번** 돌렸다(30분).
# 게이트가 큰 게 아니라 **게이트가 결론을 안 적은 것**이다. 크기를 줄이면 검증이 약해지지만
# (검증은 성역), 끝에 답을 박으면 3회가 1회가 된다. 셋을 같이 고친다:
#   ① 실패한 게이트 **이름**을 모아 끝에 요약한다 — `tail` 로 잘라도 답이 남는다
#   ② 게이트마다 출력을 파일로도 받는다 — 파이프로 잘려도 전문이 디스크에 산다
#   ③ 요약을 `SUMMARY.txt` 로 남겨 **건너뛸 때도 되돌려 준다** — 스탬프가 판정(0/1)만
#      보존해서, "뭐가 빨갰나" 를 아는 길이 10분 재실행뿐이었다. 그게 2회차의 원인이다
OUTDIR="/tmp/fr5-gate-${MODEKEY}.${WT_KEY:-solo}.d"
# 경로를 파일명 한 토막으로 — 요약 루프가 같은 규칙으로 되짚는다 (`check-*.sh` 이름 충돌 방지)
outkey() { echo "${1#"$REPO"/}" | tr '/' '_'; }
# 스탬프 형식 — "epoch<공백>트리해시<공백>판정"
# **`git status --porcelain` 만으로는 못 잡는다** (2026-08-08 실측). 이미 `M` 인 파일을 또 고쳐도
# porcelain 한 줄(` M docs/<이름>.md`)은 글자 하나 안 바뀐다 — 해시가 그대로다. 이 저장소는 수정
# 파일이 100개를 넘어 **거의 모든 편집이 여기 해당**하므로, 위 주석의 "한 글자라도 고쳤으면
# 무조건 다시 돈다" 가 사실이 아니었다. 게이트가 계속 "같은 트리" 라며 건너뛴다.
# 그래서 porcelain 이 부르는 파일들의 **mtime·크기까지** 섞는다. 내용을 읽지 않으니 여전히 싸다.
tree_hash() {
  git status --porcelain 2>/dev/null | REPO="$REPO" python3 -c '
import sys, os, glob, hashlib
h = hashlib.sha1()
for line in sys.stdin:
    h.update(line.encode())
    p = line[3:].rstrip("\n")
    if " -> " in p: p = p.split(" -> ", 1)[1]        # 이름 바뀐 것은 새 경로를 본다
    p = p.strip().strip('"'"'"'"'"')
    try:
        st = os.stat(p)
        h.update(f"{st.st_mtime_ns}:{st.st_size}".encode())
    except OSError:
        pass                                          # 사라진 경로 — porcelain 줄 자체가 이미 신호다
# **gitignore 파일은 porcelain 에 안 뜬다** (감사 2026-08-13). `.env` 만 고치고 10분 안에
# 다시 부르면 해시가 그대로라 캐시가 이전 판정을 돌려준다 — consts.sh 의 `.env↔생성설정`
# 대조가 정확히 그 드리프트를 잡는 게이트인데 안 돈다. 그래서 그 파일들을 직접 섞는다.
root = os.environ.get("REPO", ".")
for p in [os.path.join(root, ".env")] + sorted(glob.glob(os.path.join(root, "Shared/data/config/*.json"))):
    try:
        st = os.stat(p)
        h.update(f"{os.path.relpath(p, root)}:{st.st_mtime_ns}:{st.st_size}".encode())
    except OSError:
        pass                                          # 없는 파일은 없다는 사실이 곧 상태다
print(h.hexdigest())
'
}
if [ "$FORCE" -eq 0 ] && [ -f "$STAMP" ]; then
  read -r WHEN WHAT VERDICT < "$STAMP" || true
  NOW=$(date +%s)
  if [ -n "${WHEN:-}" ] && [ $((NOW - WHEN)) -lt 600 ] && [ "${WHAT:-x}" = "$(tree_hash)" ]; then
    V="${VERDICT:-1}"                    # 판정이 안 적힌 옛 스탬프는 **통과로 읽지 않는다**
    [ "$V" -eq 0 ] && WORD="통과" || WORD="**실패** — 그때 잡힌 것이 그대로 남아 있다"
    echo "${GLABEL}를 $((NOW - WHEN))초 전에 **같은 트리**에서 이미 돌았다 — 건너뛴다. 그때 판정: $WORD"
    # 판정만 되돌려 주면 사람이 **뭐가 빨갰는지 알려고 다시 돌린다.** 증거도 같이 돌려준다.
    if [ "$V" -ne 0 ] && [ -f "$OUTDIR/SUMMARY.txt" ]; then cat "$OUTDIR/SUMMARY.txt"; fi
    echo "파일이 한 글자라도 바뀌면 자동으로 다시 돈다. 억지로 지금: bash scripts/check/all.sh --force"
    exit "$V"
  fi
fi

# **실렌더 판은 기계에 하나뿐이다.** Claude Code 세션을 두 개 열면 게이트도 두 판이 돌고,
# 둘 다 같은 전용 포트(5155·5157·5176·5187·5188·5189)를 잡으려 든다. 늦게 온 쪽이
# 포트 가드에 걸려 죽고, 원인은 화면 탓처럼 보인다 — 실측 2026-08-07: 세션 두 개가
# 동시에 `all.sh` 를 돌려 178건 게이트가 "포트를 이미 누가 쓴다" 로 조기실패했다.
# `mkdir` 은 원자적이라 락으로 쓴다 (macOS 에는 `flock` 이 없다).
# 빠른 게이트는 포트를 안 쓰므로 락을 걸지 않는다 — 매 턴 훅이 서로 막으면 안 된다.
LOCK=/tmp/fr5-gate-render.lock
if [ "$FAST" -eq 0 ]; then
  if ! mkdir "$LOCK" 2>/dev/null; then
    OWNER="$(cat "$LOCK/pid" 2>/dev/null || true)"
    # 주인이 죽은 뒤 **그 번호를 남이 물려받으면** 살아 있는 것으로 보여 게이트가 영영 안 돈다.
    # 그래서 두 겹으로 막는다 — 명령줄이 진짜 게이트인가, 그리고 **락이 너무 늙지 않았는가**.
    # 전량이 3분이므로 15분 넘은 락은 무슨 사연이든 죽은 것으로 본다. 어떤 오탐이든
    # 15분 안에 저절로 풀린다 — 영구히 막히는 경우가 없다는 게 이 상한의 목적이다.
    AGE=$(python3 -c "import os,time;print(int(time.time()-os.path.getmtime('$LOCK')))" 2>/dev/null || echo 0)
    if [ -n "$OWNER" ] && [ "$AGE" -lt 900 ] \
       && ps -p "$OWNER" -o command= 2>/dev/null | grep -q 'check/all\.sh'; then
      echo "판정 못 함 — 다른 게이트 판이 돌고 있다 (pid $OWNER). 포트를 뺏지 않으려고 실렌더를 건너뛴다."
      echo "**이것은 통과가 아니다.** 그 판이 끝난 뒤 다시 부른다: bash scripts/check/all.sh"
      exit 2
    fi
    # 주인이 이미 죽었다 = 앞 판이 잘리며 남긴 락이다. 뺏는다.
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { echo "판정 못 함 — 게이트 락을 못 잡았다. **통과가 아니다.**"; exit 2; }
  fi
  echo "$$" > "$LOCK/pid"
  # 정상 종료·예외·중단 어디로 빠져도 락을 놓는다. 안 놓으면 다음 판이 영영 못 돈다.
  trap 'rm -rf "$LOCK"' EXIT INT TERM
fi

FAIL=0
# **판이 실제로 돌 때만 비운다.** 위 건너뛰기는 여기 오기 전에 나가므로 지난 판의 증거가 산다.
rm -rf "$OUTDIR" && mkdir -p "$OUTDIR"
# 실패한 게이트의 **경로**를 공백으로 잇는다. macOS 의 bash 3.2 는 `set -u` 아래 빈 배열
# 전개에서 그 자리에서 죽는다 — 이 파일이 이미 한 번 밟은 함정이라 배열을 쓰지 않는다.
FAILED=""
# check/ 의 게이트 + 카테고리 폴더가 스스로 내놓은 게이트(`scripts/*/check-*.sh`).
# 후자가 없으면 도메인 게이트를 사람이 손으로 불러야 해서 결국 안 돈다.
for s in "$HERE"/*.sh "$HERE"/../*/check-*.sh; do
  [ -f "$s" ] || continue
  [ "$(basename "$s")" = "all.sh" ] && continue
  # `--fast` 에서 빼는 것 둘 (2026-08-08 실측)
  #   *-render.sh   포트·브라우저를 쓴다. 172초라 훅 타임아웃 안에 못 들어간다
  #   docs.sh·refs.sh  문서 전수를 걸어 **84초·64초** — 빠른 게이트 170초의 **87%가 이 둘**이었다.
  #     둘은 문서 링크·등재 무결성을 본다. 코드를 깨뜨리지 않고, 응답마다 답이 바뀌지도 않는다.
  #     **매 턴 볼 것이 아니라 마감 때 볼 것**이다 — `SessionEnd` 전량과 `/마감` 이 부른다.
  #     빼고 나면 빠른 게이트가 60초 훅 타임아웃 안으로 들어와 **완주한다**. 안 들어오면
  #     매 턴 잘려서 판정이 아예 안 나온다 — D90 이 겪은 바로 그것이다.
  case "$(basename "$s")" in
    *-render.sh|docs.sh|refs.sh) [ "$FAST" -eq 1 ] && continue ;;
  esac
  echo "───────── $(basename "$(dirname "$s")")/$(basename "$s") ─────────"
  # `tee` 라 **화면은 그대로 흐르면서** 전문이 파일에도 쌓인다 — 10분짜리 판의 진행이
  # 안 보이면 사람이 죽었나 싶어 또 부른다. 종료 코드는 `tee` 것이 아니라 게이트 것을 본다.
  bash "$s" 2>&1 | tee "$OUTDIR/$(outkey "$s").out"
  [ "${PIPESTATUS[0]}" -eq 0 ] || { FAIL=1; FAILED="$FAILED $s"; }
  echo
done

# 전량을 **완주했다는 사실**을 남긴다 (실패해도 남긴다 — 같은 트리로 또 돌면 같은 결과다).
# 고치면 트리 해시가 바뀌어 자동으로 다시 돈다. 위 §반복 방지가 이 파일을 읽는다.
echo "$(date +%s) $(tree_hash) $FAIL" > "$STAMP"

if [ "$FAIL" -eq 0 ]; then
  [ "$FAST" -eq 1 ] && echo "빠른 게이트 통과 (실렌더는 세션 끝에 돈다)" || echo "전체 통과"
else
  # **답을 맨 끝에 박는다.** 앞의 407건을 다 흘려보내도 마지막 스무 줄에 "무엇이 · 어떻게
  # 다시" 가 남는다. 한 번 쓰고 한 번 읽는다 — 파일이 곧 화면이라 둘이 갈라질 수 없다.
  {
    echo "═════════ 실패 요약 — 게이트 $(echo "$FAILED" | wc -w | tr -d ' ')개 ═════════"
    for f in $FAILED; do
      echo "  ✗ ${f#"$REPO"/}"
      grep -aE 'FAIL|실패' "$OUTDIR/$(outkey "$f").out" 2>/dev/null | head -5 | sed 's/^/      /'
    done
    echo
    echo "  고친 뒤 **그 게이트만** 다시 부른다 — 전량 10분을 또 돌 이유가 없다:"
    for f in $FAILED; do echo "    bash ${f#"$REPO"/}"; done
    echo "  전문(잘리지 않은 원본): $OUTDIR/"
  } > "$OUTDIR/SUMMARY.txt"
  echo "실패한 게이트가 있다"
  cat "$OUTDIR/SUMMARY.txt"
fi
exit "$FAIL"
