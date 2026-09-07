#!/usr/bin/env bash
# FR5 실기 시험 — **배포하지 않고** 지금 코드를 우분투에서 한 번 돌려 본다.
#
# 왜 배포가 아닌가. 타이밍·게이트 변경을 실기에 처음 댈 때는 **되돌리기가 한 줄**이어야 한다.
# 이 스크립트는 배포 트리(`~/FR5Web/`)를 안 건드리고 `~/fr5-trial/` 에서 띄운다 —
# 뭐가 잘못되면 Ctrl-C 한 번이면 원래 브리지가 그대로 돌아온다 (아래 `복구` 가 자동으로 한다).
# 정식 배포는 `scripts/deploy/fr5-ubuntu.sh` 다. 이건 그 자리를 대신하지 않는다.
#
# ⚠ **이 스크립트는 로봇을 안 움직인다.** 관문만 띄운다. ARM·조그는 사람이 화면에서 한다 —
#    `confirm: "현장확인"` 은 **현장에 사람이 있다**는 주장이라, 아무도 없는 방에서 보내면
#    안전 게이트 전체가 거짓이 된다 (하드 룰 3).
#
# 쓰는 법:
#   bash scripts/dev/fr5-trial.sh              시험 시작 (Ctrl-C 로 끝내면 자동 복구)
#   bash scripts/dev/fr5-trial.sh --detach     띄우고 빠진다 — 로그는 호스트의 ~/fr5-trial.log
#                                              **자동 복구가 없다.** 끝나면 --restore 를 부른다
#   bash scripts/dev/fr5-trial.sh --restore    복구만 (비정상 종료했거나 --detach 뒤)
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${FR5_HOST:-ej@192.168.30.240}
IP=${HOST#*@}
PORT=${FR5_PORT:-5055}
# **작은따옴표가 중요하다.** `~` 를 맥에서 펼치면 `/Users/…` 가 원격으로 가서 `mkdir: cannot
# create directory '/Users'` 로 죽는다 (실측 2026-08-08). 원격 셸이 펼치게 문자 그대로 넘긴다.
TRIAL='~/fr5-trial'        # 배포 트리 **밖** — `fr5-ubuntu.sh` 의 `rsync --delete` 가 여기 못 닿는다
TRIAL_DATA='~/fr5-trial-data'

# systemd 는 **사용자 서비스**다 — `--user` 와 `XDG_RUNTIME_DIR` 이 둘 다 있어야 ssh 로 먹는다
SC="export XDG_RUNTIME_DIR=/run/user/\$(id -u); systemctl --user"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

restore() {
  say "복구 — 원래 브리지를 되살린다"
  # **`reset-failed` 가 먼저다.** `systemctl stop` 이 SIGTERM(143)으로 끝나면 유닛이
  # `failed` 로 남고, 그 상태에서는 `start` 가 조용히 안 먹는다 (실측 2026-08-08 —
  # 복구했다고 믿었는데 포트가 죽어 있었다). 실패 표시를 지우고 띄운다.
  ssh "$HOST" "$SC reset-failed fr5-bridge 2>/dev/null; $SC start fr5-bridge" || {
    echo "  ⚠ 자동 복구 실패. 직접: ssh $HOST '$SC reset-failed fr5-bridge; $SC start fr5-bridge'"; return 1; }
  for i in $(seq 1 20); do
    curl -sf -m 2 "http://$IP:$PORT/robots" >/dev/null && { echo "  원래 브리지 살아났다 — http://$IP:$PORT"; return 0; }
    sleep 1
  done
  echo "  ⚠ 서비스는 켰는데 응답이 없다 — ssh $HOST 'journalctl --user -u fr5-bridge -n 30'"
}

if [ "${1:-}" = "--restore" ]; then
  # 떠 있는 시험 브리지부터 죽인다 — 안 죽이면 원래 서비스가 포트를 못 잡는다
  # `[u]vicorn` — **대괄호가 없으면 pkill 이 자기를 죽인다.** 원격 셸의 명령줄에 패턴이
  # 그대로 들어 있어 스스로 매치된다 (실측 2026-08-08: ssh 가 비정상 종료해 스크립트가 멈췄다)
  ssh "$HOST" "pkill -f '[u]vicorn main:app.*--port $PORT' || true" 2>/dev/null
  sleep 1
  restore; exit $?
fi
DETACH=0
[ "${1:-}" = "--detach" ] && DETACH=1

# ── 0. 닿나 ────────────────────────────────────────────────────────────────
ping -c1 -W2 "$IP" >/dev/null 2>&1 || {
  echo "우분투($IP)에 안 닿는다 — PC 가 켜져 있고 같은 망인지 본다"; exit 1; }

# ── 1. 무엇으로 도는 서비스인지 먼저 본다 ──────────────────────────────────
# 추측해서 띄우면 배포본과 다른 환경으로 시험하게 된다 — 그러면 무엇을 검증한 건지 모른다
say "지금 서비스가 무엇으로 도나 (시험도 같은 것으로 띄운다)"
ssh "$HOST" "$SC cat fr5-bridge 2>/dev/null | grep -E 'ExecStart|WorkingDirectory|Environment'" \
  || echo "  (유닛을 못 읽었다 — 아래 기본 경로로 진행한다)"
# ⚠ **`command -v uv` 로 찾으면 안 된다.** 비대화형 ssh 는 로그인 셸이 아니라
# `~/.local/bin` 이 PATH 에 없다 — 실측 2026-08-08: `command -v uv` 는 빈손인데
# 서비스는 `%h/.local/bin/uv` 로 멀쩡히 돈다. 유닛이 쓰는 **절대경로를 그대로 쓴다.**
UV=${FR5_UV:-'$HOME/.local/bin/uv'}
ssh "$HOST" "test -x $UV" || {
  echo "  ⚠ $UV 가 없다. 위 ExecStart 의 경로를 FR5_UV 로 넘겨라 — 멈춘다"
  exit 1; }

# ── 2. 코드를 스크래치 트리로 ──────────────────────────────────────────────
say "빌드 + 스크래치 트리로 보낸다 (~/fr5-trial · 배포 트리는 안 건드린다)"
npm run build:fr5
# **중간 폴더까지 미리 만든다.** rsync 는 목적지의 상위 폴더를 안 만든다 —
# `--mkpath` 는 rsync 3.2.3+ 인데 맥 기본 rsync 가 그보다 낮을 수 있어 기대지 않는다
ssh "$HOST" "mkdir -p $TRIAL/FR5/bridge $TRIAL/FR5/dist"
# 브리지와 빌드된 화면 둘만 보낸다 — 나머지는 시험에 안 쓴다
rsync -az --delete --exclude '__pycache__' ./FR5/bridge/ "$HOST":"$TRIAL/FR5/bridge/"
rsync -az --delete ./FR5/dist/ "$HOST":"$TRIAL/FR5/dist/"

# ── 3. 데이터는 **복사본**을 쓴다 ──────────────────────────────────────────
# 시험이 진짜 지점·슬롯을 고치면 안 된다. 특히 이번 변경은 **재교시가 승인을 푼다** —
# 실기에서 캡처 한 번 눌렀다가 진짜 프로그램의 승인이 풀리면 그건 시험이 아니라 사고다.
say "데이터 복사본을 만든다 (진짜 ~/fr5-data 는 안 건드린다)"
ssh "$HOST" "rm -rf $TRIAL_DATA && cp -a ~/fr5-data $TRIAL_DATA 2>/dev/null || mkdir -p $TRIAL_DATA/trajectories $TRIAL_DATA/slots $TRIAL_DATA/history"
ssh "$HOST" "ls $TRIAL_DATA | tr '\n' ' '; echo"

# ── 4. 원래 브리지를 **반드시** 멈춘다 ─────────────────────────────────────
# 관문이 둘이면 컨트롤러 xmlrpc 세션을 동시에 물어 **재부팅으로만 풀리는 점유**가 난다
# (GAP-MATRIX · "브리지 비정상 종료 시 컨트롤러 세션 점유"). 하드 룰 4 의 물리적 형태다.
say "원래 브리지를 멈춘다 (관문은 한 번에 하나여야 한다)"
ssh "$HOST" "$SC stop fr5-bridge"
# **앞선 시험 브리지가 살아 있으면 죽인다.** 안 죽이면 새로 띄운 것이 포트를 못 잡고 죽는데,
# 아래 기동 확인은 "5055 가 응답한다" 만 보므로 **옛 프로세스를 보고 떴다고 오판한다** —
# 그러면 방금 고친 설정이 아니라 **옛 설정으로 시험**하게 된다 (실측 2026-08-08: zMm 이 안 실렸다)
# `[u]vicorn` — 대괄호가 없으면 **pkill 이 자기를 죽인다** (위 --restore 주석 참조)
ssh "$HOST" "pkill -f '[u]vicorn main:app.*--port $PORT' || true"
sleep 2
# `--detach` 는 **일부러 trap 을 안 건다** — 스크립트가 끝나도 시험 브리지는 살아 있어야 한다.
# 대신 복구를 사람이(또는 부른 쪽이) `--restore` 로 명시한다. 자동과 수동을 섞으면
# "끝났는데 왜 원래 걸로 안 돌아왔지" 가 난다
[ "$DETACH" = 1 ] || trap restore EXIT INT TERM
sleep 1

# ── 5. 시험 브리지 기동 (포그라운드 · 로그가 여기로 흐른다) ────────────────
cat <<'GUIDE'

────────────────────────────────────────────────────────────
 시험 순서 — 화면(http://…:5055)에서 사람이 누른다
────────────────────────────────────────────────────────────
 1. 연결 → observe-only 로 /state          좌표계가 아직 user1 인가 (D87)
 2. ARM → 1° 조그                          되던 게 그대로 되나 (회귀)
 3. 5° 조그          ★핵심               거부가 뜨나 · 뜨면 조건 6 인가 조건 8 인가
 4. 5° 연타 3번                            유도 대기가 실기 가감속을 견디나
 5. 지점이동 3%                            느린 게 보이나 · 6초 상한에 걸리나

 아래 로그의 `moveJ-settle` 이 **실제 대기 시간**을 찍는다 — 유도값과 실측을 그 자리에서
 대조한다. 거부가 뜨면 그 문장을 그대로 남긴다 (조건 6/8 중 무엇인지가 판정이다).

 ⚠ STOP 에 손을 두고 시작한다. 끝나면 Ctrl-C — 원래 브리지가 자동으로 돌아온다.
────────────────────────────────────────────────────────────

GUIDE

RUN="cd $TRIAL/FR5/bridge && FR5_DATA_DIR=$TRIAL_DATA \
  $UV run --with fastapi --with 'uvicorn[standard]' --with pyyaml \
  uvicorn main:app --host 0.0.0.0 --port $PORT"

if [ "$DETACH" = 1 ]; then
  say "시험 브리지 기동 (detach) — http://$IP:$PORT"
  ssh "$HOST" "nohup bash -lc \"$RUN\" > ~/fr5-trial.log 2>&1 & echo \$!"
  for i in $(seq 1 30); do
    curl -sf -m 2 "http://$IP:$PORT/robots" >/dev/null && break
    sleep 1
    [ "$i" = 30 ] && { echo "  ⚠ 안 뜬다 — ssh $HOST 'tail -30 ~/fr5-trial.log'"; restore; exit 1; }
  done
  echo "  떴다. 로그: ssh $HOST 'tail -f ~/fr5-trial.log'"
  echo "  ⚠ 끝나면 반드시: bash scripts/dev/fr5-trial.sh --restore"
  exit 0
fi

say "시험 브리지 기동 — http://$IP:$PORT  (Ctrl-C 로 끝낸다)"
ssh -t "$HOST" "$RUN"
