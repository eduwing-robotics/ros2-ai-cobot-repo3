#!/usr/bin/env bash
# **지금 뭐가 붙어 있나** — 여섯 고리를 한 번에 재고, 빨간 줄에 처방을 같이 적는다.
#
# 왜 만드나 (2026-09-03) — 한 세션에서 「로봇이 안 붙는다 / 카메라가 안 보인다」를 손으로 캐는 데
# 왕복 20회가 넘게 들었다. 캐낸 것은 매번 같은 여섯 줄이었다:
#   호스트 · 브리지(5055) · 카메라브리지(5058) · 로봇 상태포트(20004) · 폰(8080) · 터틀봇(5056)
# 어느 줄이 빨간지에 따라 처방이 **완전히 다른데**, 그 대응표가 사람 머릿속에만 있었다.
# 그래서 판정과 처방을 같은 줄에 붙인다 — 읽는 사람이 다음 명령을 안 고르게.
#
#   bash scripts/dev/health.sh
#
# ⛔ **아무것도 안 고친다.** 읽기 전용이다 — 고치는 명령은 「처방」 칸에 글로만 적는다.
#    자동 복구를 여기 넣지 않는 이유: 브리지 재시작은 조종권을 끊는다. 사람이 고른다.
#
# 판정 규칙 둘 (여기서 틀리면 한나절이 샌다 — 실측 2026-09-03):
#   · `ping` 으로 호스트를 판정하지 않는다 — 윈도우 방화벽이 ICMP 를 막는다. `nc -z` 로 본다
#   · 호스트 주소는 **이름으로** 푼다 (`scripts/dev/host.sh` · D164). 숫자를 여기 적지 않는다

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

TB_HOST="${FR5_TB_HOST:-192.168.30.15:5056}"
BAD=0

eval "$(bash scripts/dev/host.sh 2>/dev/null)"

say() {  # 이름 · 판정 · 처방
  local mark="$1" name="$2" detail="$3" fix="$4"
  printf '  %s %-22s %s\n' "$mark" "$name" "$detail"
  [ -n "$fix" ] && printf '       └ %s\n' "$fix"
}

up() { local hp="$1"; nc -z -G 3 "${hp%%:*}" "${hp##*:}" >/dev/null 2>&1; }

# ⛔ **포트가 열렸다고 사는 게 아니다** (2026-09-04 · 한나절을 여기서 잃었다).
# 그날 5055·5058 이 둘 다 `nc -z` 초록인 동안 `/state` 는 12초 타임아웃이었다 — 프로세스가
# 포트를 문 채 굳어 있었고, 이 게이트가 **초록으로 거짓 보고**했다. 그래서 한 번은 부른다.
# ⚠ `curl | python3` 로 파이프하지 않는다 — RTK 훅이 510바이트에서 잘라 JSON 이 깨져 보인다.
answers() {  # <url> — 2xx 를 제 시간에 돌려주나
  curl -s -o /dev/null -m "${2:-6}" -w '%{http_code}' "$1" 2>/dev/null | grep -q '^2'
}

echo "== 지금 붙어 있는 것 =="

# ① 호스트
if [ -z "${FR5_HOST_IP:-}" ]; then
  BAD=1
  say "⛔" "브리지 호스트" "이름이 안 풀린다" \
    "그 PC 가 망에 없거나 꺼졌다. mDNS 는 살아 있을 때만 답한다 — 대역 스윕이 0건이면 사람이 전원·와이파이를 본다"
  echo; echo "호스트를 못 찾아 아래를 못 잰다."; exit 1
fi
say "✅" "브리지 호스트" "$FR5_HOST_IP" ""

# ② 로봇 브리지
if up "$FR5_HOST_IP:5055"; then
  if answers "http://$FR5_HOST_IP:5055/state" 8; then
    say "✅" "브리지 5055" "열림 · /state 응답" ""
  else
    BAD=1
    say "⛔" "브리지 5055" "**포트만 열리고 굳었다** — /state 무응답" \
      "프로세스를 죽인다. ⚠ 파이썬만 죽이면 부모 cmd 가 로그를 쥐고 있어 새 인스턴스가 즉사한다 — 부모까지 (skills/윈도우 §브리지가 안 뜬다)"
  fi
else
  BAD=1
  say "⛔" "브리지 5055" "무응답" \
    "작업 상태가 Ready 여도 파이썬이 포트를 물고 있을 수 있다 — PID 를 끊고 띄운다 (skills/우분투 §가짜 재시작)"
fi

# ③ 카메라 브리지
if up "$FR5_HOST_IP:5058"; then
  if answers "http://$FR5_HOST_IP:5058/api/camera/state" 8; then
    say "✅" "카메라브리지 5058" "열림 · 응답" ""
  else
    BAD=1
    say "⛔" "카메라브리지 5058" "**포트만 열리고 굳었다**" \
      "D435 유령 인스턴스부터 본다 — Get-PnpDevice *RealSense* 에 Unknown 이 쌓였으면 뽑았다 꽂는다 (skills/윈도우 §함정)"
  fi
else
  BAD=1
  say "⛔" "카메라브리지 5058" "무응답" "Start-ScheduledTask fr5-cam-bridge"
fi

# ④ 로봇 상태포트 — 여기만 닫히는 고장이 실재한다 (핑·8080·20003 은 멀쩡한 채)
ROBOT_IP="${FR5_ROBOT_IP:-192.168.57.2}"
CODE=$(rtk proxy curl -s -m 8 -o /dev/null -w '%{http_code}' "http://$FR5_HOST_IP:5055/state" 2>/dev/null || echo 000)
if [ "$CODE" = "200" ]; then
  PHASE=$(rtk proxy curl -s -m 8 "http://$FR5_HOST_IP:5055/state" 2>/dev/null \
    | python3 -c "import json,sys; s=json.load(sys.stdin); print(s.get('phase'), '· 서보', s.get('enabled'), '· mode', s.get('mode'))" 2>/dev/null || echo '?')
  case "$PHASE" in
    FAIL_CLOSED*)
      BAD=1
      say "⛔" "로봇" "$PHASE" \
        '"프리플라이트 무응답" 이면 **20004 만** 닫힌 것이다(핑·8080·20003 은 멀쩡하다). 로봇 재부팅 말고 **브리지 완전 재시작**부터 — 실측 2026-08-31·09-03 둘 다 이걸로 붙었다' ;;
    *) say "✅" "로봇" "$PHASE" "" ;;
  esac
else
  BAD=1; say "⛔" "로봇" "/state 응답 없음 (http $CODE)" "브리지부터 본다"
fi

# ⑤ 폰(글로벌캠) — 브리지가 아니라 **브라우저가 직접** 붙는다. 우리 쪽에서도 재 본다
CAM="${FR5_CAM_HOST:-}"
[ -z "$CAM" ] && CAM=$(rtk proxy curl -s -m 5 "http://$FR5_HOST_IP:5055/config/global-cam-host.json" 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('host',''))" 2>/dev/null)
if [ -n "$CAM" ] && up "$CAM"; then
  say "✅" "글로벌캠(폰)" "$CAM" ""
  DRIFT=$(rtk proxy curl -s -m 5 "http://$FR5_HOST_IP:5055/config/global-cam-drift.json" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(str(d.get('rmsPx'))+'px · 태그 '+str(d.get('tags'))+'장 · '+str(d.get('note') or ''))" 2>/dev/null || echo '?')
  case "$DRIFT" in
    *"최소"*|*"None"*)
      BAD=1
      say "⚠️" "  └ 정합" "$DRIFT" \
        '자동 재정합은 방 기준 **4장**이 필요하다. 어느 장이 빠졌는지는 프레임 한 장 받아 검출로 가른다 — 대개 **위에 뭐가 얹혀 정숙영역을 먹은 것**이다' ;;
    *) say "✅" "  └ 정합" "$DRIFT" "" ;;
  esac
else
  BAD=1
  say "⛔" "글로벌캠(폰)" "${CAM:-주소 모름} 무응답" \
    "IP Webcam 앱이 꺼졌거나 폰이 다른 망이다. 주소 정본은 윈도우 사용자 환경변수 FR5_CAM_HOST"
fi

# ⑥ 손목 뎁스 — 「안 꽂힘」과 「꽂혔는데 안 보임」은 처방이 다르다
if up "$FR5_HOST_IP:5058"; then
  D=$(rtk proxy curl -s -m 10 "http://$FR5_HOST_IP:5058/api/camera/state" 2>/dev/null \
    | python3 -c "import json,sys; s=json.load(sys.stdin); d=s.get('depth',{}); print(str(s.get('connected'))+'|'+str(s.get('usb'))+'|'+str(d.get('validReason'))+'|'+str(round(d.get('validRatio') or 0,4)))" 2>/dev/null || echo '?|?|?|?')
  IFS='|' read -r CONN USB REASON RATIO <<<"$D"
  if [ "$CONN" = "True" ]; then
    say "✅" "손목 뎁스 D435" "USB $USB · 유효율 $RATIO · $REASON" \
      "$([ "$USB" = "2.1" ] && echo '⛔ USB2 다 — 848x480@30 이 통째로 사라진다. USB3 포트로 옮긴다')"
  else
    BAD=1
    say "⛔" "손목 뎁스 D435" "$REASON" \
      "PnP 로 **허브가 Error(Problem 43)** 인지 먼저 본다 — 그러면 케이블이 아니라 허브다. Disable/Enable 로 살아난다 (skills/우분투 §D435)"
  fi
fi

# ⑦ 터틀봇 — 호스트가 다르다(파이 안에서 돈다). 여기가 빨개도 위 여섯과 무관하다
if up "$TB_HOST"; then
  say "✅" "터틀봇" "$TB_HOST" ""
else
  say "⚠️" "터틀봇" "$TB_HOST 무응답" \
    "부팅 후 ~90초를 기다린다. 그래도면 **와이파이부터** — 파이가 team_2 로 되돌아가면 30 대역에서 영영 안 보인다 (/터틀봇 §2)"
fi

echo
[ "$BAD" -eq 0 ] && echo "전부 초록." || echo "빨간 줄의 처방을 위에서부터 하나씩 — 아래 것이 위 것 때문에 빨간 경우가 많다."
exit 0
