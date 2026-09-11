#!/usr/bin/env bash
# FR5 배포 — **윈도우 호스트**. 화면 빌드본(`FR5/dist`)과 접촉 장면을 밀어 넣는다.
#
# 2026-08-11 에 로봇 랜선이 윈도우 PC 로 옮겨가 호스트가 둘이 됐다 (`docs/ref/runbook/FR5-BRINGUP.md`).
# `fr5-ubuntu.sh` 를 그대로 쓸 수 없는 이유 셋 — 전부 실측이다:
#   ① `--delete` 로 레포를 통째로 밀어 **다른 세션의 미커밋까지 나간다**
#   ② `systemctl --user` 가 윈도우엔 없다 (여긴 **작업 스케줄러**다)
#   ③ 기본 셸이 PowerShell 이라 bash 관용구가 안 통한다 (`$HOME\...` · `~` 확장 없음)
#
# ⛔ **브리지를 재시작하지 않는다.** 화면은 브리지가 `FR5/dist` 를 정적 마운트해서 내는데
#    (`FR5/bridge/main.py` §정적 서빙), Starlette `StaticFiles` 는 **요청마다 디스크를 보므로**
#    파일만 갈면 즉시 반영된다. 재시작하면 **로봇 세션이 끊긴다** — 화면 배포 때문에 ARMED 를
#    떨어뜨릴 이유가 없다. 2026-08-11 실측: 그 호스트의 `fr5-bridge` 작업 상태가 `Ready`(=안 돌고
#    있음)인데 `:5055` 는 응답한다 — **스케줄러로 뜬 게 아니라서** 작업을 다시 돌리는 것이
#    지금 도는 프로세스를 살리는 길인지도 확실하지 않다. 건드리지 않는 쪽이 안전하다.
#
# ⚠ **브리지 코드(`FR5/bridge/*.py`)는 기본 모드로 반영되지 않는다.** `--bridge` 를 줘야 하고,
#    그건 **재시작 = 로봇 세션 끊김**을 뜻한다 (아래 §브리지 모드).
# ponytail: 오래된 해시 자산이 원격에 남는다(덮어쓰기만 한다). 천장 — `dist` 를 지우고 붓는
#    방식은 붓다 실패하면 화면이 빈다. 디스크 몇 MB 가 그 위험보다 싸다.
set -euo pipefail
cd "$(dirname "$0")/../.."

# 사용자 이름에 공백이 있다 — 통째로 따옴표에 넣는다 (2026-08-11 실측: ssh·scp 둘 다 된다)
# ⛔ **낡은 숫자를 기본값으로 두지 않는다** (2026-08-31 · D164). 호스트가 DHCP 라
# 오늘 하루에 `.18 → .6` 으로 바뀌었고, 그 순간 이 줄이 **조용히 틀린 기계**를 가리켰다.
# 주소는 `scripts/dev/host.sh` 한 곳이 이름으로 푼다 — 없으면 **못 찾았다고 말하고 멈춘다.**
eval "$(bash "$(dirname "${BASH_SOURCE[0]}")/../dev/host.sh")"
HOST=${FR5_WIN_HOST:-"$FR5_HOST_SSH"}
[ -z "${HOST#*@}" ] && { echo "  ⛔ 브리지 호스트를 못 찾았다 — FR5_WIN_HOST 로 준다"; exit 1; }
IP="${HOST#*@}"
# **`~` 를 쓰지 않는다** — 원격 셸이 PowerShell 이라 확장이 안 된다. scp 는 SFTP 로 붙어
# 상대 경로를 홈 기준으로 푼다.
REMOTE=${FR5_WIN_DIR:-"FR5Web/FR5/dist"}

command -v npm >/dev/null || { echo "  npm 이 없다"; exit 1; }

# ── §브리지 모드 (`--bridge`) ───────────────────────────────────────────────
# 화면과 달리 **재시작이 필요하다** — 파이썬은 임포트한 모듈을 다시 안 읽는다.
# 재시작하면 **로봇 세션이 끊긴다**: 조종권과 `ARMED` 가 풀리고 `OBSERVE_ONLY` 로 돌아온다.
# 그래서 **사람이 로봇 옆에 있을 때만** 쓴다 — 끝나고 다시 ARM 하는 건 사람 몫이다 (하드 룰 3).
#
# 재시작 경로는 실측으로 확인했다 (2026-08-11):
#   작업 스케줄러 `fr5-bridge` 가 **로그온 트리거**로 `%USERPROFILE%\fr5-bridge.cmd` 를 돌리고,
#   그 배치가 `uv run … uvicorn main:app --host 0.0.0.0 --port 5055` 를 띄운다.
#   작업의 마지막 실행(19:08:41)이 도는 프로세스 시작(19:08:42)과 일치했다 — **이 경로가 정본이다.**
#   ⚠ 작업 상태가 `Ready` 로 보여도 프로세스는 돌고 있다. 상태만 보고 "안 뜬 것" 으로 읽지 마라.
#
# ⛔ **`config.yaml` 을 보내지 않는다.** 호스트별 값(로봇 endpoint·기대 모델)이 들어 있어
#    덮어쓰면 로봇 연결이 조용히 깨진다. 벤더 SDK 폴더도 안 보낸다 — 크고 안 바뀐다.
BRIDGE=0
AR=0
for arg in "$@"; do
  case "$arg" in
    --bridge) BRIDGE=1 ;;
    --calib)  CALIB=1 ;;      # `global-cam.json` 을 **강제로** 덮어쓴다 (호스트 자동 보정을 되돌린다)
    --ar)     AR=1 ;;          # 글로벌캠 겹치기 화면 — 아래 §AR
    *) echo "  모르는 인자: $arg (쓸 수 있는 것: --bridge · --ar · --calib)"; exit 1 ;;
  esac
done

echo "== 빌드 =="
npm run build:fr5
[ -f FR5/dist/index.html ] || { echo "  빌드본이 없다 — FR5/dist/index.html"; exit 1; }

# 시뮬 탭의 접촉 층은 `/sim/scene/<robotId>.xml` 을 브리지에서 읽는다. `FR5/dist` 만 보내면
# 화면은 새것이어도 이 안전 입력은 404라 S3R이 시작 전에 멈춘다(2026-09-10 실기).
# 생성기는 config·URDF·툴 hull을 다시 읽고 자체 되읽기 검사까지 하므로, 옛 산출물을 그대로
# 복사하지 않고 배포 때마다 굽는다. 산출물은 D14대로 git에 넣지 않는다.
echo "== 접촉 장면 =="
node Sim/scene/build-scene.mjs
[ -f Sim/out/scene/fr5-lab-a.xml ] || { echo "  장면이 없다 — Sim/out/scene/fr5-lab-a.xml"; exit 1; }

# 배포 전 원격이 무엇을 내고 있었나 (되돌릴 때 대조할 값)
BEFORE=$(curl -s -m 5 "http://$IP:5055/" | grep -oE '(index|main)-[A-Za-z0-9_-]+\.js' | head -1 || true)
LOCAL=$(grep -oE '(index|main)-[A-Za-z0-9_-]+\.js' FR5/dist/index.html | head -1 || true)
echo "== 번들 =="
echo "  지금 원격: ${BEFORE:-알 수 없음}"
echo "  보낼 것  : ${LOCAL:-알 수 없음}"

echo "== 전송 (화면 + 접촉 장면) =="
scp -q -o ConnectTimeout=10 -r FR5/dist/. "$HOST:$REMOTE/"

# StaticFiles는 요청마다 디스크를 읽으므로 장면도 재시작 없이 반영된다.
ssh -o ConnectTimeout=10 "$HOST" 'New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\FR5Web\Sim\out\scene" | Out-Null' >/dev/null
scp -q -o ConnectTimeout=10 Sim/out/scene/fr5-lab-a.xml "$HOST:FR5Web/Sim/out/scene/fr5-lab-a.xml"
echo "  보냄 Sim/out/scene/fr5-lab-a.xml"

# 터틀봇 브리지 주소 — **조건 없이 보낸다** (2026-08-28).
# ⛔ 한때 이걸 보정값 블록에 넣었는데 그 블록은 `AR=1` 일 때만 돈다 — 그래서 안 갔고,
# 원격 화면이 터틀봇 주소를 못 물어 **반투명(가정)** 으로만 그렸다. AR 과 무관한 파일이다.
# 생성물이고 주인이 하나(.env → config.mjs)라 다른 보정값들과 달리 경주가 없다.
if [ -f "Shared/data/config/tb-host.json" ]; then
  ssh -o ConnectTimeout=10 "$HOST" 'New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\FR5Web\Shared\data\config" | Out-Null' >/dev/null 2>&1 || true
  scp -q -o ConnectTimeout=10 "Shared/data/config/tb-host.json" "$HOST:FR5Web/Shared/data/config/tb-host.json" \
    && echo "  보냄 tb-host.json" || echo "  ⚠ tb-host.json 못 보냈다"
fi

# **번들 해시가 바뀌었는지로 판정한다.** 파일이 갔는지가 아니라 화면이 새것을 내는지가 목표다
AFTER=""
for i in $(seq 1 10); do
  AFTER=$(curl -s -m 5 "http://$IP:5055/" | grep -oE '(index|main)-[A-Za-z0-9_-]+\.js' | head -1 || true)
  [ -n "$AFTER" ] && [ "$AFTER" = "$LOCAL" ] && break
  sleep 1
done
echo "== 판정 =="
if [ -n "$LOCAL" ] && [ "$AFTER" = "$LOCAL" ]; then
  echo "  OK — 원격이 $AFTER 를 낸다"
  echo "  화면: http://$IP:5055/"
else
  echo "  실패 — 원격이 여전히 '${AFTER:-무응답}' 를 낸다 (보낸 것: ${LOCAL:-?})"
  echo "  ① 경로 확인: ssh \"${HOST%@*}\"@$IP 'Get-ChildItem \"\$HOME\\FR5Web\\FR5\\dist\" | Select-Object -First 3 Name,LastWriteTime'"
  echo "  ② 브리지가 다른 폴더를 마운트하는지 본다 (main.py §정적 서빙)"
  exit 1
fi

# ── §AR (`--ar`) — 글로벌캠 겹치기 화면 ──────────────────────────────────────
#
# **왜 브리지가 내야 하나** — AR 은 Vercel 에도 있지만 그 공개본은 **랜의 `/state`·`/config`
# 에 못 닿는다**(같은 출처가 아니다). 그래서 판정면 겹치기가 거기서는 영영
# "브리지가 작업영역을 안 준다" 로 남는다. `main.py` §AR 정적 서빙이 같은 이유를 적어 뒀다.
#
# ⚠ **첫 배포는 재시작이 필요하다.** `/ar` 마운트는 기동 때 `AR/dist` 가 **있어야** 걸린다
# (`main.py`: `if AR_DIST.exists()`). 폴더가 없던 기계에 처음 부으면 파일은 갔는데 404 다 —
# 2026-08-13 에 실제로 그 상태였다(전송 경로 자체가 없어서 AR 이 한 번도 안 올라갔다).
# 두 번째부터는 `StaticFiles` 가 요청마다 디스크를 보므로 **재시작 0회**다.
if [ "${AR:-0}" = "1" ]; then
  echo
  echo "== AR 빌드 =="
  npm run build:ar
  [ -f AR/dist/cam.html ] || { echo "  빌드본이 없다 — AR/dist/cam.html"; exit 1; }
  AR_LOCAL=$(grep -oE 'assets/cam-[A-Za-z0-9_-]+\.js' AR/dist/cam.html | head -1 || true)
  AR_BEFORE=$(curl -s -m 5 "http://$IP:5055/ar/cam.html" | grep -oE 'assets/cam-[A-Za-z0-9_-]+\.js' | head -1 || true)
  echo "  지금 원격: ${AR_BEFORE:-없음(404)}"
  echo "  보낼 것  : ${AR_LOCAL:-알 수 없음}"

  # 폴더가 없으면 scp 가 실패한다 — 원격 셸이 PowerShell 이라 `mkdir -p` 가 아니다
  echo "== AR 전송 =="
  ssh -o ConnectTimeout=10 "${HOST%@*}@$IP" \
    'New-Item -ItemType Directory -Force -Path "$HOME\FR5Web\AR\dist","$HOME\FR5Web\Shared\data\config" | Out-Null' >/dev/null
  scp -q -o ConnectTimeout=10 -r AR/dist/. "$HOST:FR5Web/AR/dist/"

  # ── 보정값도 같이 보낸다. **화면만 새것이고 보정이 옛것이면 더 나쁘다** —
  # 그럴듯하게 틀린 자리에 선을 긋고, 사람은 새 기능이 부정확하다고 읽는다.
  # 2026-08-13 실측: 호스트가 `remount6`(08-10) 를 내는 동안 레포는 `remount9` 였다.
  # 폰이 그 사이 **두 번 기울어져** 재투영 175px 이었다 — 그 값으로 그리면 통째로 어긋난다.
  #
  # ⛔ **`global-cam-drift.json` 은 안 보낸다.** 그건 감시기가 **그 기계에서** 재는 산출물이다.
  #    내 맥의 값을 부으면 호스트 화면이 **여기서 잰 정합**을 자기 것인 양 말한다 —
  #    감시기가 죽었는데 초록으로 보이는 것과 같은 종류의 거짓말이다.
  # ⛔ `config.yaml` 도 안 보낸다 (위 §브리지와 같은 이유 — 호스트별 값이다).
  echo "== 보정값 전송 (drift 제외) =="
  # ⛔ **`global-cam.json` 은 2026-08-19 부터 «그 기계가 잴 값» 이다.** 감시기에 `--auto` 를 켜서
  # 호스트가 카메라 이동을 스스로 다시 푼다(그날 16:33 에 실제로 걸렸다: RMS 30.4 → 0.42px).
  # 여기서 부어 넣으면 **그 자동 보정을 조용히 옛 값으로 되돌린다** — 화면은 초록인 채 틀린다.
  # 아래 `global-cam-drift.json`·`fixture-pose.json` 을 막아 둔 것과 **같은 이유**다.
  # 처음 세울 때나 호스트 값이 깨졌을 때만 `--calib` 로 강제한다.
  # ⛔ **`scene-anchors.json` 도 안 보낸다** (2026-08-19 저녁) — 이 파일의 주인은 앵커 워처
  # (`anchor-pose.py --watch --push`) **하나**다. 배포도 밀면 같은 파일에 손이 둘이 되어
  # 나중 것이 이기는 경주가 난다. 부트스트랩(워처를 안 켠 새 호스트)은
  # `python3 scripts/map/anchor-pose.py --host <폰> --push <호스트경로>` 1회로 한다.
  _cfg="robot-base-in-tag.json"
  echo "  건너뜀 scene-anchors.json — 주인은 앵커 워처다 (--push)"
  [ "${CALIB:-0}" = 1 ] && _cfg="global-cam.json $_cfg" || echo "  건너뜀 global-cam.json — 호스트가 스스로 푼다 (강제: --calib)"
  for f in $_cfg; do
    if [ -f "Shared/data/config/$f" ]; then
      scp -q -o ConnectTimeout=10 "Shared/data/config/$f" "$HOST:FR5Web/Shared/data/config/$f"
      echo "  보냄 $f"
    else
      echo "  없음 $f — 건너뛴다 (캘리브레이션 전이면 정상)"
    fi
  done
  CAL_LOCAL=$(python3 -c "import json;print(json.load(open('Shared/data/config/global-cam.json'))['labToCam'].get('shot',''))" 2>/dev/null || true)
  CAL_REMOTE=$(curl -s -m 5 "http://$IP:5055/config/global-cam.json" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['labToCam'].get('shot',''))" 2>/dev/null || true)
  # ⚠ `--calib` 없이 왔으면 **원격이 더 새것인 게 정상**이다 — 호스트가 스스로 다시 푼다.
  # 그때 「불일치」라고 외치면 사람이 진짜 불일치를 무시하는 법을 배운다.
  if [ "${CALIB:-0}" != 1 ] && [ -n "$CAL_REMOTE" ] && [ "$CAL_LOCAL" != "$CAL_REMOTE" ]; then
    echo "  OK — 원격이 스스로 푼 $CAL_REMOTE 를 쓴다 (저장소본 ${CAL_LOCAL:-?} 은 안 보냈다)"
  elif [ -n "$CAL_LOCAL" ] && [ "$CAL_LOCAL" = "$CAL_REMOTE" ]; then
    echo "  OK — 원격 보정 기준 $CAL_REMOTE"
  else
    echo "  ⚠ 보정 불일치 — 원격 '${CAL_REMOTE:-읽기 실패}' / 보낸 것 '${CAL_LOCAL:-?}'"
    echo "     ('/config' 마운트도 기동 때 걸린다 — 폴더가 없던 기계면 아래 재시작이 같이 푼다)"
  fi

  AR_AFTER=""
  for i in $(seq 1 10); do
    AR_AFTER=$(curl -s -m 5 "http://$IP:5055/ar/cam.html" | grep -oE 'assets/cam-[A-Za-z0-9_-]+\.js' | head -1 || true)
    [ -n "$AR_AFTER" ] && [ "$AR_AFTER" = "$AR_LOCAL" ] && break
    sleep 1
  done
  if [ -n "$AR_LOCAL" ] && [ "$AR_AFTER" = "$AR_LOCAL" ]; then
    echo "  OK — 원격이 $AR_AFTER 를 낸다"
    echo "  글로벌캠: http://$IP:5055/ar/cam.html?feed=http://<폰>:8080/video&anchors=1&only=__none"
    echo "            (anchors=1 이 태그 앵커 층이다 — 빼고 열면 컨베이어가 안 보인다)"
  else
    # **404 와 「옛 번들」을 가른다** — 처방이 다르다
    echo "  ⚠ 아직 안 뜬다 — 원격 '${AR_AFTER:-404}'"
    echo "  '/ar' 마운트는 **기동 때** 걸린다. 폴더가 없던 기계면 **브리지를 한 번 재시작**해야 한다."
    echo "  ⛔ 재시작하면 조종권·ARMED 가 풀린다 — **사람이 로봇 옆에 있을 때만** 한다 (하드 룰 3)."
    echo "  재시작: ssh \"${HOST%@*}\"@$IP 'schtasks /End /TN fr5-bridge; schtasks /Run /TN fr5-bridge'"
  fi
fi

# ── §추적기 — 움직이는 장애물 산출기 (계약 §움직이는 장애물 · D130)
#
# 브리지는 `fixture-pose.json` 을 **읽기만** 한다. 그 파일을 **만드는 쪽**이 없으면 받침이
# 게이트에 영영 안 들어간다 — `config.yaml` 에서 고정 받침을 뺐기 때문에 **아무도 안 막는다.**
# 그래서 브리지 코드와 **같이** 보낸다. 따로 보내면 순서가 틀려 보호에 구멍이 난다.
#
# ⚠ **호스트에 python 이 없다** (2026-08-13 실측: `Python was not found`). `uv` 는 있다 —
# 브리지가 그걸로 돌기 때문이다. 그래서 실행은 `uv run --with opencv-python --with numpy` 다.
if [ "$BRIDGE" = "1" ] || [ "${AR:-0}" = "1" ]; then
  echo
  echo "== 추적기 =="
  ssh -o ConnectTimeout=10 "${HOST%@*}@$IP" \
    'New-Item -ItemType Directory -Force -Path "$HOME\FR5Web\scripts\map","$HOME\FR5Web\scripts\robot","$HOME\FR5Web\Shared\assets\tag","$HOME\FR5Web\calib-shots" | Out-Null' >/dev/null
  # ⚠ **`Shared/data/props.js` 도 같이 간다** — 색 상주가 거치대 키(`CARRIER.hMm`)를 거기서
  #    읽는다(정본을 안 베끼는 대가다 · 하드 룰 5). 안 보내면 상주가 `FileNotFoundError` 로
  #    조용히 죽는다 — 오늘 실측. `tags.json` 이 같은 이유로 이 목록에 있다.
  # ⚠ **`color-find.py` 도 같은 이유로 여기 있다** (2026-09-04). 색 상주가 브리지 안에서
  #    그걸 늦게 임포트하므로, 안 보내면 브리지는 멀쩡히 뜨고 **추종만 조용히 표적을 잃는다**
  #    (오늘 실측: `표적 파일 carrier-pose.json 이 없다`). 배포 목록이 곧 기능 목록이다.
  # ⚠ **`marker_follow.py` 를 빠뜨리면 앵커 상주가 조용히 안 돈다** (2026-08-27).
  #    브리지의 `anchors.py` 가 그 뼈대를 **늦게 임포트**하므로, 없으면 브리지는 멀쩡히 뜨고
  #    앵커만 안 돈다 — 화면은 초록인 채 소품이 옛 자리에 선다. 그날 실제로 그 상태였다
  #    (앵커가 7일 낡은 기준샷 · 컨베이어 844mm 어긋남). `anchor-pose.py` 는 손 1회용 CLI 다.
  # ⚠ **`wrist-find.py`·`amr-pair.py` 는 손목 상주의 뼈대다** (2026-09-04 · D177).
  #    `anchors.start_wrist_tracker` 가 둘을 늦게 임포트하므로, 없으면 브리지는 멀쩡히 뜨고
  #    **손목 표적만 조용히 안 나온다.** 위 두 상주와 같은 이유·같은 자리다.
  # ⚠ **`Shared/data/workcell.js` 는 재획득이 읽는다** (2026-09-04 · D180).
  #    `follow_reacquire` 가 `AMR_HOME`·`AMR_TAG` 를 **실행해서** 받는다(정본을 안 베낀다) —
  #    안 보내면 재획득이 「workcell.js 를 못 읽었다」로 영영 안 돈다.
  for f in scripts/map/fixture-pose.py scripts/map/watch-calib.py \
           scripts/map/marker_follow.py scripts/map/anchor-pose.py \
           scripts/map/color-find.py scripts/map/wrist-find.py \
           scripts/robot/amr-pair.py \
           Shared/data/props.js Shared/data/workcell.js \
           Shared/assets/tag/tags.json calib-shots/tag-layout.json; do
    if [ -f "$f" ]; then
      scp -q -o ConnectTimeout=10 "$f" "$HOST:FR5Web/$f"
      echo "  보냄 $f"
    else
      echo "  ⛔ 없다 $f — 추적기가 호스트에서 안 돈다"
    fi
  done
  echo "  기동(사람이 한 번): ssh \"${HOST%@*}\"@$IP 'cd \$HOME\\FR5Web; uv run --with opencv-python --with numpy python scripts\\map\\fixture-pose.py --host <폰>:8080 --bridge 127.0.0.1:5055 --watch'"
  echo "  ⭐ 앵커는 **기동이 필요 없다** — 브리지 안에서 뜬다 (계약 §앵커 상주 · D146)"
fi

[ "$BRIDGE" = "1" ] || exit 0

echo
echo "== 브리지 코드 (⚠ 재시작 — 조종권·ARMED 가 풀린다) =="

# ── ① 브리지가 **읽는 것**을 다 보낸다 — 목록을 코드에서 뽑는다 ────────────────
# 2026-08-11 사고: `.py` 만 보내고 `Shared/data/config/*.json`(생성물)을 빼먹어 게이트가
# `제1원칙: 결측=차단` 으로 **모든 이동을 거부**했다. 그 기계엔 `Shared/` 폴더 자체가 없었다.
# 경로를 손으로 적으면 또 빠진다 — **코드가 읽는 경로를 세서 새로 생기면 멈춘다.**
# ⚠ **주석은 뺀다.** 2026-08-12 에 이 가드가 오탐으로 배포를 멈췄다 — `commands.py` 주석의
# 문서 참조(`Shared/data/workcell.js`)를 「브리지가 읽는 경로」로 읽었다. 코드가 실제로 여는
# 경로만 세야 한다: 전체 주석 줄을 버리고, 줄 안의 `#` 뒤도 잘라낸다.
# 놓치는 방향으로 틀리면 ②(호스트 임포트 검사)가 받는다 — 그게 이 가드의 뒷배다.
NEED=$(cat FR5/bridge/*.py FR5/bridge/robot_adapter/*.py \
       | grep -vE '^[[:space:]]*#' | sed 's/#.*//' \
       | grep -ohE '"Shared[^"]*"|Shared/[A-Za-z0-9_./-]+' \
       | tr -d '"' | sort -u)
# 허용 목록 — **여기 늘릴 때 아래 전송도 같이 늘린다.** 하나만 늘리면 그 기계에서 조용히 없다.
#   `Shared/data/config`  보정값(생성물)
#   `Shared/assets/tag`   태그 정의 + **받침 기하**(2026-08-13 · D130) — 브리지 안 추적기가 읽는다
#   `Shared/data/workcell.js`  `AMR_HOME`·`AMR_TAG` — **재획득**이 실행해서 받는다 (2026-09-04 · D180)
#   `Shared/data/props.js`     거치대 키 — 색 상주가 읽는다 (위 §자산 전송에 이미 있다)
UNKNOWN=$(printf '%s\n' "$NEED" | grep -vE '^Shared(/data/config(/.*)?|/assets/tag(/.*)?|/data/workcell\.js|/data/props\.js)?$' || true)
if [ -n "$UNKNOWN" ]; then
  echo "  ⛔ 브리지가 **처음 보는 Shared 경로**를 읽는다 — 보낼 목록을 늘리기 전에 멈춘다:"
  printf '     %s\n' $UNKNOWN
  echo "     (이 스크립트의 ① 절을 고치고 다시 돌려라. 그냥 보내면 그 기계에서 조용히 없다)"
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
REV=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# ── ③ 덮어쓰기 전 백업 — 그 기계는 git 저장소가 아니라 되돌릴 길이 없다 ──────
ssh -o ConnectTimeout=10 "$HOST" "
New-Item -ItemType Directory -Force -Path \"\$HOME\FR5Web\FR5\bridge.bak-$STAMP\" | Out-Null
Copy-Item \"\$HOME\FR5Web\FR5\bridge\*.py\" \"\$HOME\FR5Web\FR5\bridge.bak-$STAMP\" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path \"\$HOME\FR5Web\Shared\data\config\" | Out-Null" >/dev/null
echo "  백업: FR5/bridge.bak-$STAMP (되돌리려면 그 폴더의 *.py 를 되복사한다)"

scp -q -o ConnectTimeout=10 FR5/bridge/*.py "$HOST:FR5Web/FR5/bridge/"
scp -q -o ConnectTimeout=10 FR5/bridge/robot_adapter/*.py "$HOST:FR5Web/FR5/bridge/robot_adapter/"
# ── 계기 둘 — **브리지가 import 할 것들이라 같이 보낸다** (2026-08-18 · 핸드오프 §비전 파지 3)
#
# `handeye-probe.py` 의 `cam_point()`(core 중심 + 깊이 중앙값)를 추종 루프가 쓰기로 돼 있고,
# 그 파일은 다시 `depth-probe.py` 를 **importlib 로** 연다(파일명에 `-` 가 있어서다).
# 둘 중 하나만 없어도 브리지가 그 줄에 닿는 순간 호스트에서 `ModuleNotFoundError` 로 죽는다.
# ⚠ **여기 있다고 호스트에서 도는 것은 아니다** — 사람 기계에서 HTTP 로 붙어 쓰는 용법
# (`scripts/README.md` §robot)은 그대로다. 없어서 나는 사고만 먼저 막는다.
ssh -o ConnectTimeout=10 "${HOST%@*}@$IP" \
  'New-Item -ItemType Directory -Force -Path "$HOME\FR5Web\scripts\robot" | Out-Null' >/dev/null
ssh -o ConnectTimeout=10 "${HOST%@*}@$IP" \
  'New-Item -ItemType Directory -Force -Path "$HOME\FR5Web\scripts\dev" | Out-Null' >/dev/null
# 2026-09-07 — `/scan`(계약 §손목 스캔)이 `carrier-find.py` 를 부르고, 그것이 `scripts/dev/host.py` 를 import 한다
for _p in scripts/robot/depth-probe.py scripts/robot/handeye-probe.py scripts/robot/carrier-find.py scripts/dev/host.py; do
  if [ -f "$_p" ]; then scp -q -o ConnectTimeout=10 "$_p" "$HOST:FR5Web/$_p"
  else echo "  ⛔ 없다 $_p — 추종 루프가 호스트에서 import 하는 순간 죽는다"; fi
done
# ⛔ **감시기·추적기 산출물은 빼고 보낸다** (2026-08-13 실측 사고).
# 이 줄이 `*.json` 을 통째로 밀어서 **내 맥에서 돌던 추적기의 `fixture-pose.json` 이 실기로
# 갔다.** 그 순간 호스트는 **여기서 잰 받침 자리**를 자기 것인 양 말한다 — drift 파일에서
# 일부러 막았던 것과 **같은 종류의 거짓말**인데, 이쪽이 더 나쁘다: 게이트가 그 값으로 **막는다.**
# 규칙 — **그 기계에서 재는 값은 그 기계가 만든다.** 여기서 부어 넣지 않는다.
for _f in Shared/data/config/*.json; do
  case "$(basename "$_f")" in
    global-cam-drift.json|fixture-pose.json) echo "  건너뜀 $(basename "$_f") — 그 기계가 잴 값이다"; continue ;;
    # 2026-08-19 — 감시기 `--auto` 가 켜지면서 여기도 «그 기계가 잴 값» 이 됐다 (위 §화면 경로와 같은 이유)
    global-cam.json) [ "${CALIB:-0}" = 1 ] || { echo "  건너뜀 global-cam.json — 호스트가 스스로 푼다 (강제: --calib)"; continue; } ;;
  esac
  scp -q -o ConnectTimeout=10 "$_f" "$HOST:FR5Web/Shared/data/config/$(basename "$_f")"
done
# 받침 기하 — **브리지 안 추적기가 읽는다.** 없으면 추적기가 「기하가 없다」로 멈춘다(D130).
# ⚠ 이건 산출물이 아니라 **사람이 자로 재서 적는 값**이라 여기서 보내는 것이 맞다
ssh -o ConnectTimeout=10 "${HOST%@*}@$IP" \
  'New-Item -ItemType Directory -Force -Path "$HOME\FR5Web\Shared\assets\tag" | Out-Null' >/dev/null
scp -q -o ConnectTimeout=10 Shared/assets/tag/tags.json "$HOST:FR5Web/Shared/assets/tag/tags.json"
# 백틱을 쓰지 않는다 — bash 가 명령 치환으로 읽는다 (2026-08-11 에 두 번 걸렸다)
echo '  보냈다 — 브리지 *.py + robot_adapter + 계기(depth/handeye/carrier-find + dev/host.py) + 보정값 + 태그/받침 기하 (config.yaml·벤더 SDK·감시기 산출물 제외)'

# ── ④ 무엇을 올렸는지 그 기계에 각인한다 ────────────────────────────────────
ssh -o ConnectTimeout=10 "$HOST" "Set-Content -Path \"\$HOME\FR5Web\DEPLOYED.txt\" -Encoding UTF8 -Value @(
'배포: $STAMP',
'커밋: $REV',
'미커밋 파일 수(맥): $DIRTY   ← 0 이 아니면 커밋 안 된 코드가 올라간 것이다',
'모드: --bridge (화면 + 브리지 + Shared/data/config)'
)" >/dev/null
echo "  각인: DEPLOYED.txt (커밋 $REV · 맥 미커밋 $DIRTY 개)"
[ "$DIRTY" != "0" ] && echo "  ⚠ 맥에 미커밋 $DIRTY 개가 있다 — **그 코드가 실기로 올라갔다**"

echo "== 재시작 =="
# 프로세스 나무를 죽이고 **작업으로** 다시 띄운다 — 손으로 띄우면 다음 로그온과 방식이 갈린다
ssh -o ConnectTimeout=10 "$HOST" '
$c = Get-NetTCPConnection -LocalPort 5055 -State Listen -ErrorAction SilentlyContinue
foreach ($x in $c) {
  $w = Get-WmiObject Win32_Process -Filter ("ProcessId=" + $x.OwningProcess)
  Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $w.ParentProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "fr5-bridge"
Write-Output "작업 시작 요청"' >/dev/null

for i in $(seq 1 30); do
  curl -sf -m 2 "http://$IP:5055/robots" >/dev/null && break
  sleep 1
  [ "$i" = 30 ] && { echo "  브리지가 안 뜬다 — 로그를 본다:"
                     echo "    ssh \"${HOST%@*}\"@$IP 'Get-Content \"\$HOME\\fr5-bridge.log\" -Tail 30'"; exit 1; }
done
echo "  떴다"

# 재연결은 **observe-only** 다. ARM 은 사람이 화면에서 한다 (하드 룰 3)
RESP=$(curl -s -m 20 -X POST "http://$IP:5055/connect" -H 'Content-Type: application/json' \
  -d '{"robotId":"fr5-lab-a","observeOnly":true}' || true)
# ── ② **그 기계에서 실제로 임포트되나** — 여기가 오늘 사고를 막는 자리다 ──────
#
# 「보냈다」로 판정하면 안 된다. 2026-08-11 에 파일은 다 갔는데 그 기계에 `Shared/` 가 없어
# 게이트가 모든 이동을 거부했고, **로봇이 막힌 뒤에야** 알았다. 배포가 스스로 확인해야 한다.
# 검사는 **ASCII 만** 쓴다 — 그 기계 콘솔이 cp949 라 한글을 넣으면 인용이 깨진다(실측).
echo "== 그 기계에서 임포트 검사 =="
PROBE="$(mktemp -d)/_deploy_probe.py"
cat > "$PROBE" <<'PY'
import safety
t = safety.TOOL_CORNERS_MM
a = safety.ARM_HULL
ok = not isinstance(t, Exception) and not isinstance(a, Exception)
print("TOOL:", "FAIL " + repr(t) if isinstance(t, Exception) else "OK corners=%d" % len(t))
print("ARM :", "FAIL " + repr(a) if isinstance(a, Exception) else "OK chain=%d" % len(a["chain"]))
print("VERDICT:", "OK" if ok else "FAIL")
PY
scp -q -o ConnectTimeout=10 "$PROBE" "$HOST:FR5Web/FR5/bridge/_deploy_probe.py"
rm -f "$PROBE"
OUT=$(ssh -o ConnectTimeout=25 "$HOST" 'cd "$HOME\FR5Web\FR5\bridge"; & "$HOME\.local\bin\uv.exe" run --with pyyaml python _deploy_probe.py; Remove-Item "_deploy_probe.py" -ErrorAction SilentlyContinue' 2>&1 || true)
echo "$OUT" | grep -E '^(TOOL|ARM |VERDICT)' || echo "$OUT" | tail -3
if ! echo "$OUT" | grep -q 'VERDICT: OK'; then
  echo "  ⛔ 그 기계가 게이트 형상을 못 읽는다 — **이 상태로는 모든 이동이 거부된다.**"
  echo "     되돌리기: ssh \"${HOST%@*}\"@$IP 'Copy-Item \"\$HOME\\FR5Web\\FR5\\bridge.bak-$STAMP\\*.py\" \"\$HOME\\FR5Web\\FR5\\bridge\" -Force'"
  echo "     그 뒤 재시작: 위 §재시작 절차와 같다"
  exit 1
fi

case "$RESP" in
  *'"ok":true'*) echo "  로봇 재연결 OK (OBSERVE_ONLY) — **ARM 은 사람이 화면에서**" ;;
  *) echo "  로봇 재연결 실패 — 화면은 살아 있다"
     echo "    응답: $RESP"
     echo "    한 번 더: curl -s -X POST http://$IP:5055/connect -H 'Content-Type: application/json' -d '{\"robotId\":\"fr5-lab-a\",\"observeOnly\":true}'" ;;
esac
