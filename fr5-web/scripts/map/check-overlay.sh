#!/usr/bin/env bash
# S3 게이트 — **사진 한 장으로 전체 사슬**을 검사한다.
#
#   합성 사진 → cv2 태그 검출 → solvePnP → global-cam.json → three.js 카메라 → 픽셀
#
# check-camera.sh 는 수학만 봤다(참값을 직접 넣었다). 여기는 **이미지에서 시작**한다 —
# 검출 오차·포즈 추정 오차까지 통과한 뒤에도 겹치는지를 본다.
# 하드웨어도 인쇄물도 필요 없다. 태그는 z=0 바닥에만 둔다 — 높이 오차가 섞이면
# 원인을 못 가르기 때문이다 (S4 에서 높이를 넣는다).

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 사진 → 카메라 → 오버레이 (전체 사슬) =="

python3 - "$TMP" "$ROOT" <<'PY' || exit 1
import json, sys
from pathlib import Path
import numpy as np, cv2

TMP, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
spec = json.loads((ROOT / "Shared/assets/tag/tags.json").read_text(encoding="utf-8"))
dic = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, spec["family"]))
TAG = spec["sheets"][0]["tagSizeMm"]

W, H, FX, FY, CX, CY = 1920, 1080, 1371.0, 1352.0, 953.0, 566.0
K = np.array([[FX, 0, CX], [0, FY, CY], [0, 0, 1]]); D = np.zeros(5)
EYE, TGT = np.array([1500., -800., 2400.]), np.array([1500., 800., 0.])
POS = {0: (300., 300.), 1: (2700., 300.), 2: (2700., 1300.), 3: (300., 1300.)}

f = TGT - EYE; f /= np.linalg.norm(f)
r = np.cross(f, [0, 0, 1.]); r /= np.linalg.norm(r)
R = np.vstack([r, -np.cross(r, f), f]); t = (-R @ EYE).reshape(3, 1)
rv = cv2.Rodrigues(R)[0]

def quad(cx, cy, s):                     # PNG 좌상·우상·우하·좌하 ↔ 바닥. 인쇄면 위쪽 = +Y
    h = s / 2
    return [(cx - h, cy + h, 0), (cx + h, cy + h, 0), (cx + h, cy - h, 0), (cx - h, cy - h, 0)]

canvas = np.full((H, W), 255, np.uint8)
for i, (cx, cy) in POS.items():
    png = cv2.aruco.generateImageMarker(dic, i, 800)
    src = np.array([[0, 0], [800, 0], [800, 800], [0, 800]], np.float32)
    dst, _ = cv2.projectPoints(np.array(quad(cx, cy, TAG), np.float64), rv, t, K, D)
    Hm = cv2.getPerspectiveTransform(src, dst.reshape(-1, 2).astype(np.float32))
    canvas = np.minimum(canvas, cv2.warpPerspective(png, Hm, (W, H), borderValue=255,
                                                    flags=cv2.INTER_AREA))
cv2.imwrite(str(TMP / "shot.png"), canvas)

# ── 여기서부터는 참값을 안 쓴다. 사진에서만 푼다.
corners, ids, _ = cv2.aruco.ArucoDetector(dic, cv2.aruco.DetectorParameters()).detectMarkers(canvas)
assert ids is not None and len(ids) == 4, f"태그 검출 {0 if ids is None else len(ids)}/4"
op, ip = [], []
for c, i in zip(corners, ids.ravel()):
    op += quad(*POS[int(i)], TAG); ip += list(map(tuple, c[0]))
ok, rv2, tv2 = cv2.solvePnP(np.array(op), np.array(ip), K, D, flags=cv2.SOLVEPNP_ITERATIVE)
assert ok, "solvePnP 실패"
cam = (-cv2.Rodrigues(rv2)[0].T @ tv2).ravel()
print(f"  태그 4/4 검출 · 사진에서 푼 카메라 ({cam[0]:.0f}, {cam[1]:.0f}, {cam[2]:.0f}) mm "
      f"· 참값 대비 {np.linalg.norm(cam - EYE):.1f}mm")

# 판정 대상 — 태그 모서리 16 점의 **검출 픽셀**(정답)과 바닥 격자 교점
grid = [(x, y, 0.) for x in (0., 750., 1500., 2250., 3000.) for y in (0., 800., 1600.)]
gpx, _ = cv2.projectPoints(np.array(grid), rv2, tv2, K, D)
(TMP / "case.json").write_text(json.dumps({
    "calib": {"intrinsics": {"widthPx": W, "heightPx": H, "fx": FX, "fy": FY,
                             "cx": CX, "cy": CY, "dist": [0] * 5},
              "labToCam": {"rvec": rv2.ravel().tolist(), "tvecMm": tv2.ravel().tolist()}},
    "labMm": op + grid, "px": [list(map(float, q)) for q in ip] + gpx.reshape(-1, 2).tolist(),
    "nTagCorners": len(ip),
}), encoding="utf-8")
PY

node --input-type=module -e "
import { readFileSync } from 'node:fs';
import * as THREE from '$ROOT/node_modules/three/build/three.module.js';
const { applyCalibToCamera, labToPixel } = await import('$ROOT/Shared/view3d/global-cam.js');
const C = JSON.parse(readFileSync('$TMP/case.json', 'utf8'));
const cam = new THREE.PerspectiveCamera();
applyCalibToCamera(cam, C.calib);
let wTag = 0, wGrid = 0;
C.labMm.forEach((p, i) => {
  const g = labToPixel(cam, C.calib, p);
  const e = Math.hypot(g[0] - C.px[i][0], g[1] - C.px[i][1]);
  if (i < C.nTagCorners) wTag = Math.max(wTag, e); else wGrid = Math.max(wGrid, e);
});
console.log('  태그 모서리 ' + C.nTagCorners + '점 (사진에서 검출한 픽셀이 정답) 최대 오차 '
  + wTag.toFixed(2) + ' px');
console.log('  바닥 격자 교점 15점 최대 오차 ' + wGrid.toFixed(3) + ' px');
if (!(wTag < 2 && wGrid < 1)) { console.error('  FAIL  태그 2px / 격자 1px 를 넘는다'); process.exit(1); }
" || exit 1

# 위 사슬은 `D = np.zeros(5)` 로 만든 합성 사진을 되푼 것이다 — **렌즈 왜곡이 없는 세계**다.
# 초록불 옆에 그 한계를 같이 찍는다 (2026-08-08 · GAP-MATRIX P1). 안 찍으면 "사진 → 카메라 →
# 오버레이 전체 사슬 통과" 라는 문장이 실기 정합까지 덮은 것처럼 읽힌다.
echo "오버레이 OK  (⚠ 왜곡 0 합성 — 실렌즈에선 모서리 82px 어긋난다 · GAP P1)"
