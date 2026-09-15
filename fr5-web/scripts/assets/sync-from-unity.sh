#!/usr/bin/env bash
# 유니티 프로젝트에서 URDF와 메시를 Shared/assets/ 로 가져온다.
# 유니티 쪽 모델이 바뀌었을 때만 돌리면 된다. 부산물(.meta/.asset/.prefab)은 가져오지 않는다.
# 원본 경로가 없으면 exit 1.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SRC="${FR5UNITY_ROOT:-$HOME/FR5UNITY/robotapp/Assets/Runtime}"
ARM_SRC="$SRC/Robots/FAIRINO_FR5"
GRIP_SRC="$SRC/EndEffectors/PGEA_100_40/Source"
ARM_DST=Shared/assets/FAIRINO_FR5
GRIP_DST=Shared/assets/PGEA_100_40

if [ ! -d "$ARM_SRC" ]; then
  echo "FAIL  원본이 없다: $ARM_SRC"
  echo "      다른 위치면 FR5UNITY_ROOT 를 지정해서 실행하라."
  exit 1
fi

mkdir -p "$ARM_DST/meshes" "$GRIP_DST"

cp "$ARM_SRC/fairino5_v6.urdf" "$ARM_DST/"
cp "$ARM_SRC"/meshes/*.STL "$ARM_DST/meshes/"
echo "  팔 URDF + 메시 $(find "$ARM_DST/meshes" -iname '*.stl' | wc -l | tr -d ' ')개"

# 그리퍼는 손가락이 따로 움직여야 하므로 분리형 3개만 가져온다.
# 통합본 PGEA-100-40.stl 은 저폴리지만 손가락이 붙어 있어 쓰지 않는다.
for f in PGEA-100-40_body PGEA-100-40_finger_left PGEA-100-40_finger_right; do
  cp "$GRIP_SRC/$f.stl" "$GRIP_DST/"
done
echo "  그리퍼 메시 $(find "$GRIP_DST" -iname '*.stl' | wc -l | tr -d ' ')개"

# 유니티 부산물이 딸려오면 지운다
find Shared/assets \( -name '*.meta' -o -name '*.asset' -o -name '*.prefab' \) -delete 2>/dev/null

echo
echo "동기화 완료. 검증:  bash scripts/check/assets.sh"
