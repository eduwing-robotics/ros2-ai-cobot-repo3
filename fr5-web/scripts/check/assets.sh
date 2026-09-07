#!/usr/bin/env bash
# 웹 자산 무결성 검증 — 유니티에서 가져온 URDF·메시가 온전한지.
# 삼각형 수까지 확인한다. 파일만 있고 내용이 바뀌면 3D가 조용히 깨지기 때문이다.
# 실패하면 exit 1.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FAIL=0
note() { printf '  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=1; }

ARM=Shared/assets/FAIRINO_FR5
GRIP=Shared/assets/PGEA_100_40

# 기준값 — 2026-07-29 유니티 원본 실측. 원본이 바뀌면 여기도 같이 고친다.
WANT_ARM_TRIS=58482
WANT_GRIP_TRIS=70102

echo "== 팔 =="
[ -f "$ARM/fairino5_v6.urdf" ] && note "URDF" || bad "없음: $ARM/fairino5_v6.urdf"

n=$(find "$ARM/meshes" -maxdepth 1 -iname '*.stl' 2>/dev/null | wc -l | tr -d ' ')
[ "$n" -eq 7 ] && note "메시 $n/7" || bad "메시 $n/7"

# URDF가 참조하는 메시가 실제로 있는지
if [ -f "$ARM/fairino5_v6.urdf" ]; then
  miss=0
  while IFS= read -r m; do
    [ -f "$ARM/$m" ] || { bad "URDF가 참조하는 메시 없음: $m"; miss=1; }
  done < <(grep -oE 'filename="[^"]+"' "$ARM/fairino5_v6.urdf" | sed 's/filename="//; s/"$//' | sort -u)
  [ "$miss" -eq 0 ] && note "URDF 참조 메시 전부 존재"
fi

echo
echo "== 그리퍼 =="
for f in PGEA-100-40_body PGEA-100-40_finger_left PGEA-100-40_finger_right; do
  [ -f "$GRIP/$f.stl" ] && note "$f" || bad "없음: $GRIP/$f.stl"
done

echo
echo "== 삼각형 수 =="
count_tris() {
  python3 - "$1" <<'PY'
import struct, sys, glob, os
total = 0
for path in sorted(glob.glob(os.path.join(sys.argv[1], '**', '*.[sS][tT][lL]'), recursive=True)):
    with open(path, 'rb') as f:
        if f.read(5) == b'solid':
            f.seek(0)
            total += f.read().count(b'facet normal')
        else:
            f.seek(80)
            total += struct.unpack('<I', f.read(4))[0]
print(total)
PY
}

a=$(count_tris "$ARM" 2>/dev/null || echo 0)
g=$(count_tris "$GRIP" 2>/dev/null || echo 0)
[ "$a" = "$WANT_ARM_TRIS" ]  && note "팔 $a" || bad "팔 $a (기대 $WANT_ARM_TRIS)"
[ "$g" = "$WANT_GRIP_TRIS" ] && note "그리퍼 $g" || bad "그리퍼 $g (기대 $WANT_GRIP_TRIS)"

echo
echo "== 그리퍼 길이 (STL ↔ 설정) =="
# **삼각형 수로는 길이를 못 잡는다.** 핑거 STL 을 같은 밀도로 다시 뽑으면 개수가 그대로일 수
# 있고, 정점을 옮기기만 한 변형(gripper-trim.mjs 가 하는 일)은 개수가 반드시 그대로다.
# 그런데 길이는 컨트롤러 툴 Z·카메라 렌즈 높이·작업영역 판정이 전부 올라탄 값이다 —
# 여기서 STL 이 스스로 말하는 길이와 `.env` 가 말하는 길이를 대조한다 (runbook/FINGER-SWAP.md).
python3 - "$GRIP" Shared/data/config/gripper-mount.json <<'PY' || FAIL=1
import json, os, struct, sys

TOL = 0.05          # gripper-trim.mjs 가 쓰는 것과 같은 허용치


def y_range(path):
    """바이너리 STL 의 Y 최소·최대. 조립좌표계에서 Y 가 공구축이다."""
    with open(path, 'rb') as f:
        head = f.read(84)
        n = struct.unpack('<I', head[80:84])[0]
        body = f.read()
    if len(body) != n * 50:
        raise ValueError(f'{os.path.basename(path)}: 바이너리 STL 이 아니다')
    lo, hi = float('inf'), float('-inf')
    for i in range(n):
        base = i * 50 + 12
        for v in range(3):
            y = struct.unpack_from('<f', body, base + v * 12 + 4)[0]
            lo = min(lo, y)
            hi = max(hi, y)
    return lo, hi


grip_dir, cfg_path = sys.argv[1], sys.argv[2]
try:
    b_lo, b_hi = y_range(os.path.join(grip_dir, 'PGEA-100-40_body.stl'))
    tip = max(y_range(os.path.join(grip_dir, f'PGEA-100-40_finger_{s}.stl'))[1]
              for s in ('left', 'right'))
except (OSError, ValueError) as e:
    print(f'  FAIL  STL 을 못 읽었다 — {e}')
    sys.exit(1)

stl = {'fingerProtrusionMm': tip - b_hi, 'toolLengthMm': tip - b_lo}
try:
    cfg = json.load(open(cfg_path))
except (OSError, ValueError):
    # 산출물이라 gitignore 다. 없으면 **판정 못 함**이지 통과가 아니다 (제1원칙)
    print(f'  FAIL  {cfg_path} 가 없다 — node scripts/build/config.mjs 를 먼저 돌려라')
    sys.exit(1)

bad = 0
for key, got in stl.items():
    want = cfg.get(key)
    if not isinstance(want, (int, float)):
        print(f'  FAIL  설정에 {key} 가 없다 — config.mjs 가 옛 버전이다')
        bad = 1
        continue
    mark = 'OK' if abs(got - want) <= TOL else 'FAIL'
    print(f'  {mark}  {key}  STL {got:.2f} · 설정 {want:.2f}')
    if mark == 'FAIL':
        bad = 1
if bad:
    print('  → 핑거를 갈았으면 .env 의 FR5_GRIPPER_FINGER_MM 도 같이 간다 '
          '(docs/ref/runbook/FINGER-SWAP.md)')
sys.exit(bad)
PY

echo
echo "== 유니티 부산물 혼입 =="
n=$(find Shared/assets \( -name '*.meta' -o -name '*.asset' -o -name '*.prefab' \) 2>/dev/null | wc -l | tr -d ' ')
[ "$n" -eq 0 ] && note "없음" || bad "$n개 섞임 — scripts/assets/sync-from-unity.sh 로 다시 받아라"

echo
[ "$FAIL" -eq 0 ] && echo "자산 OK" || echo "자산 실패"
exit "$FAIL"
