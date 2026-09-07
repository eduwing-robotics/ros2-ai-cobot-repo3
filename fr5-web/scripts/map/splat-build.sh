#!/usr/bin/env bash
# 폰 영상 한 편 → 가우시안 스플랫 `.ply`.
#
#   bash scripts/map/splat-build.sh ~/Downloads/lab.mp4
#   bash scripts/map/splat-build.sh ~/Downloads/lab.mp4 --gpu ej@192.168.30.240   # 학습만 원격 GPU
#
# 근거·실측은 `docs/evidence/2026-08-07/splat-pipeline-dryrun.md`.
#
# ## 왜 단계가 넷인가
# Brush 는 **SfM 을 안 한다** — 카메라 위치를 COLMAP 이 먼저 풀어 줘야 한다.
# 그래서 프레임 뽑기 → 선명한 것 고르기 → COLMAP → Brush 순이고, 중간에 끊어도
# 다음 실행이 있는 단계를 건너뛴다.
#
# ## 함정 (전부 "에러 없이 조용히 실패" 계열이다)
# - **COLMAP 4.x 에서 옵션이 개명됐다**: `SiftExtraction`→`FeatureExtraction`,
#   `SiftMatching`→`FeatureMatching`. 3.x 예제를 그대로 쓰면 그 단계만 건너뛰고
#   두 단계 뒤에서 `No images with matches` 로 죽는다
# - brew COLMAP 은 `without CUDA` 라 GPU SIFT 가 OpenGL 로 가고 헤드리스에서 불안정하다 → CPU 고정
# - **steps 를 줄이면 화질이 조금 나빠지는 게 아니라 다른 물건이 나온다.**
#   실측: 8,000 = 84,137개(바늘 모양·못 씀) / 30,000 = 592,746개(사진 수준)
set -euo pipefail
cd "$(dirname "$0")/../.."

VIDEO=${1:?"영상 경로를 주세요 — bash scripts/map/splat-build.sh <video.mp4>"}
shift || true
OUT=${SPLAT_OUT:-.splat-work}          # gitignore 대상. 수백 MB 가 쌓인다
STEPS=30000
GPU_HOST=""
WINDOW=2                               # 몇 프레임마다 선명한 1장을 고를지

while [ $# -gt 0 ]; do
  case "$1" in
    --out)    OUT="$2"; shift 2 ;;
    --steps)  STEPS="$2"; shift 2 ;;
    --gpu)    GPU_HOST="$2"; shift 2 ;;
    --window) WINDOW="$2"; shift 2 ;;
    *) echo "모르는 인자: $1"; exit 2 ;;
  esac
done

[ -f "$VIDEO" ] || { echo "영상이 없다: $VIDEO"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg 이 없다"; exit 1; }
command -v colmap >/dev/null || { echo "colmap 이 없다 — brew install colmap"; exit 1; }

mkdir -p "$OUT"
echo "== 영상 =="
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_frames \
  -show_entries format=duration,bit_rate -of default=noprint_wrappers=1 "$VIDEO"

# ── 1. 프레임 전량 추출 ────────────────────────────────────────────────────
# **회전 메타데이터는 ffmpeg 이 알아서 적용한다** — 세로로 찍은 영상은 세로로 나온다.
# 이걸 손으로 돌리면 COLMAP 이 카메라를 두 종류로 보고 복원이 갈라진다.
if [ ! -d "$OUT/allframes" ]; then
  mkdir -p "$OUT/allframes"
  echo "== 1/4 프레임 추출 =="
  ffmpeg -y -v error -i "$VIDEO" -q:v 2 "$OUT/allframes/%04d.jpg"
fi
echo "   프레임 $(ls "$OUT/allframes" | wc -l | tr -d ' ')장"

# ── 2. 선명한 것만 고른다 ──────────────────────────────────────────────────
# 라플라시안 분산(초점이 맞은 정도)으로 재서 창마다 1장. 흐린 컷이 섞이면 SfM 이 흔들린다.
if [ ! -d "$OUT/images" ]; then
  echo "== 2/4 선명도 선별 (창 ${WINDOW}프레임) =="
  OUT="$OUT" WINDOW="$WINDOW" python3 - <<'PY'
import cv2, glob, os, shutil, numpy as np
out, w = os.environ['OUT'], int(os.environ['WINDOW'])
fs = sorted(glob.glob(f'{out}/allframes/*.jpg'))
sharp = []
for f in fs:
    g = cv2.imread(f, 0)
    g = cv2.resize(g, (g.shape[1] // 3, g.shape[0] // 3))     # 1/3 로 줄여도 순위는 안 바뀐다
    sharp.append(cv2.Laplacian(g, cv2.CV_64F).var())
sharp = np.array(sharp)
os.makedirs(f'{out}/images', exist_ok=True)
kept = [i + int(np.argmax(sharp[i:i + w])) for i in range(0, len(fs), w)]
for n, j in enumerate(kept, 1):
    shutil.copy(fs[j], f'{out}/images/%04d.jpg' % n)
k = sharp[kept]
print(f'   선택 {len(kept)}/{len(fs)}장 · 선명도 중앙 {np.median(k):.0f} '
      f'(전체 {np.median(sharp):.0f}) · 최저 {k.min():.0f}')
print(f'   흐린 컷(중앙값 60%% 미만) {100 * (sharp < np.median(sharp) * 0.6).mean():.0f}%%')
PY
fi

# ── 3. SfM ────────────────────────────────────────────────────────────────
if [ ! -d "$OUT/sparse/0" ]; then
  echo "== 3/4 COLMAP SfM =="
  mkdir -p "$OUT/sparse"
  rm -f "$OUT/db.db"
  colmap feature_extractor --database_path "$OUT/db.db" --image_path "$OUT/images" \
    --ImageReader.single_camera 1 --ImageReader.camera_model OPENCV \
    --FeatureExtraction.use_gpu 0 >/dev/null
  # 영상이라 sequential 이 맞다. exhaustive 는 프레임 수의 제곱이라 CPU 에서 못 쓴다.
  colmap sequential_matcher --database_path "$OUT/db.db" \
    --FeatureMatching.use_gpu 0 --SequentialMatching.overlap 20 >/dev/null
  colmap mapper --database_path "$OUT/db.db" --image_path "$OUT/images" \
    --output_path "$OUT/sparse" >/dev/null
fi
[ -d "$OUT/sparse/0" ] || { echo "복원 모델이 안 나왔다 — 영상이 너무 짧거나 끊겼다"; exit 1; }
colmap model_analyzer --path "$OUT/sparse/0" 2>&1 | grep -E "Registered images|Points:|reprojection" | sed 's/^/   /'

# 뷰어의 시작 자세로 쓸 실제 촬영 카메라 하나를 뽑아 둔다 (합성 궤도는 피사체 안에서 시작한다)
rm -rf "$OUT/sparse_txt"; mkdir -p "$OUT/sparse_txt"
colmap model_converter --input_path "$OUT/sparse/0" --output_path "$OUT/sparse_txt" --output_type TXT >/dev/null 2>&1 || true
OUT="$OUT" python3 - <<'PY' || true
import os, numpy as np
out = os.environ['OUT']
rows = [l.split() for l in open(f'{out}/sparse_txt/images.txt')
        if not l.startswith('#') and l.strip().endswith('.jpg')]
rows.sort(key=lambda r: r[9])
r = rows[len(rows) // 2]
q = np.array(list(map(float, r[1:5]))); t = np.array(list(map(float, r[5:8])))
w, x, y, z = q
R = np.array([[1-2*(y*y+z*z), 2*(x*y-w*z), 2*(x*z+w*y)],
              [2*(x*y+w*z), 1-2*(x*x+z*z), 2*(y*z-w*x)],
              [2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y)]])
C = -R.T @ t
tgt = C + (R.T @ np.array([0, 0, 1])) * 3.0    # COLMAP 카메라는 +Z 를 본다
# COLMAP 세계는 Y 가 아래다 → 뷰어에서 스플랫을 Z축 180° 돌리므로 (x,y,z)→(−x,−y,z)
open(f'{out}/start-pose.json', 'w').write(
    '{"start":[%.3f,%.3f,%.3f],"target":[%.3f,%.3f,%.3f],"from":"%s"}\n'
    % (-C[0], -C[1], C[2], -tgt[0], -tgt[1], tgt[2], r[9]))
print(f'   시작 자세 → {out}/start-pose.json ({r[9]})')
PY

# ── 4. 학습 ───────────────────────────────────────────────────────────────
echo "== 4/4 Brush 학습 (${STEPS} steps) =="
if [ -n "$GPU_HOST" ]; then
  # 원격 GPU. **이 호스트는 로봇 브리지가 사는 기계다** — 규칙 셋을 지킨다:
  #   ① 로봇 세션이 비었을 때만 시작 ② 작업 폴더는 ~/FR5Web/ 밖 ③ nice
  IP=${GPU_HOST#*@}
  BUSY=$(ssh "$GPU_HOST" 'curl -s -m 3 http://localhost:5055/robots' \
         | python3 -c 'import sys,json;print(sum(1 for r in json.load(sys.stdin) if r.get("lastObserved")))' 2>/dev/null || echo 0)
  [ "$BUSY" = "0" ] || { echo "로봇 세션이 $BUSY 건 살아 있다 — 학습을 시작하지 않는다"; exit 1; }
  ssh "$GPU_HOST" 'mkdir -p ~/splat-work/dataset'
  rsync -az "$OUT/images" "$OUT/sparse" "$GPU_HOST":~/splat-work/dataset/
  ssh "$GPU_HOST" "cd ~/splat-work && mkdir -p out && nice -n 5 ./brush-app-x86_64-unknown-linux-gnu/brush_app dataset \
    --total-steps $STEPS --export-path out --export-every 10000 --export-name 'lab_{iter}.ply' \
    --eval-split-every 20 --eval-save-to-disk --eval-every 5000"
  ssh "$GPU_HOST" 'P=$(pgrep -x brush_app|head -1); [ -n "$P" ] && kill "$P"'   # 다 돌고도 GPU 를 물고 있는다
  rsync -az "$GPU_HOST":'~/splat-work/out/' "$OUT/out/"
else
  BRUSH=${BRUSH_BIN:-./brush-app-aarch64-apple-darwin/brush_app}
  [ -x "$BRUSH" ] || { echo "Brush 바이너리가 없다 ($BRUSH) — github.com/ArthurBrussee/brush 릴리스에서 받는다"; exit 1; }
  "$BRUSH" "$OUT" --total-steps "$STEPS" --export-path "$OUT/out" \
    --export-every 10000 --export-name "lab_{iter}.ply" \
    --eval-split-every 20 --eval-save-to-disk --eval-every 5000
fi

echo "== 산출 =="
ls -la "$OUT/out"/*.ply 2>/dev/null || echo "   .ply 가 없다"
echo "   보려면: bash scripts/map/splat-view/serve.sh $OUT/out"
