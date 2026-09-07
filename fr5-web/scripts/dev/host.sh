#!/usr/bin/env bash
# **호스트 주소는 한 곳에서만 정한다** (2026-08-31 · D164).
#
# 왜 만드나 — 브리지 호스트가 **DHCP** 라 숫자가 바뀐다. 오늘 하루에 `.18 → .6` 으로
# 바뀌었고, 그 순간 **12곳에 박힌 기본값이 통째로 낡았다**(스크립트 9개 · 배포 1개 · 예시 2개).
# 사람이 매번 `--host` 를 손으로 넣게 두면 **어느 것이 최신인지 아무도 모른다.**
#
# 규약은 셋 — 화면의 `remembered-host.js` 와 같은 태도다:
#   · `FR5_WIN_HOST` 가 있으면 그것 (사람이 이번 한 번만 다르게 쓸 때)
#   · 없으면 **이름으로 찾는다** — `DESKTOP-EAADSGE.local` (DHCP 라 이름이 숫자보다 오래 산다)
#   · 그것도 없으면 **빈 문자열** = 「모른다」. ⛔ 낡은 숫자를 폴백으로 두지 않는다 —
#     조용히 틀린 기계에 붙는 것이 못 붙는 것보다 나쁘다 (D144 에서 겪었다)
#
# 쓰는 법:  eval "$(bash scripts/dev/host.sh)"   →  $FR5_HOST_IP · $FR5_HOST_SSH
set -uo pipefail
NAME="${FR5_WIN_NAME:-DESKTOP-EAADSGE.local}"
USER_AT="${FR5_WIN_USER:-heeyoung park}"

ip=""
if [ -n "${FR5_WIN_HOST:-}" ]; then
  ip="${FR5_WIN_HOST#*@}"
else
  ip="$(dscacheutil -q host -a name "$NAME" 2>/dev/null | awk '/ip_address/{print $2; exit}')"
  # ⛔ 이름이 풀려도 **살아 있는지 확인한다** — 캐시가 죽은 주소를 오래 들고 있다
  if [ -n "$ip" ] && ! nc -z -G 3 "$ip" 22 >/dev/null 2>&1; then ip=""; fi
fi
echo "export FR5_HOST_IP='${ip}'"
echo "export FR5_HOST_SSH='${USER_AT}@${ip}'"
[ -z "$ip" ] && echo "echo '⛔ 브리지 호스트를 못 찾았다 — FR5_WIN_HOST 로 직접 준다' >&2"
exit 0
