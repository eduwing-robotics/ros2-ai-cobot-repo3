#!/usr/bin/env bash
# S1 게이트 — OpenCV 카메라 → three.js 카메라 변환이 맞나.
#
# **정답은 cv2.projectPoints 다.** 같은 3D 점을 두 경로로 투영해 픽셀을 대조한다.
# 하드웨어도 사진도 필요 없다 — 좌표 규약과 주점 처리만 검사한다.
# 여기서 통과해야 합성 사진 위 격자(S3)가 의미를 갖는다.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 카메라 변환 (OpenCV → three.js) =="

python3 - "$TMP" <<'PY' || exit 1
import json, sys
from pathlib import Path
import numpy as np, cv2

# 주점을 일부러 중앙에서 어긋나게 둔다 — fov 만으로는 표현 못 하는 경우를 검사한다
W, H, FX, FY, CX, CY = 1920, 1080, 1371.0, 1352.0, 953.0, 566.0
K = np.array([[FX, 0, CX], [0, FY, CY], [0, 0, 1]])
eye, target = np.array([1500., -800., 2400.]), np.array([1500., 800., 0.])

f = target - eye; f /= np.linalg.norm(f)
r = np.cross(f, [0, 0, 1.]); r /= np.linalg.norm(r)
R = np.vstack([r, -np.cross(r, f), f])
t = (-R @ eye).reshape(3, 1)

pts = np.array([[300., 300., 0.], [2700., 300., 0.], [2700., 1300., 0.], [300., 1300., 0.],
                [1500., 800., 900.], [300., 300., 1500.], [2700., 1300., 400.]])
px, _ = cv2.projectPoints(pts, cv2.Rodrigues(R)[0], t, K, np.zeros(5))

Path(sys.argv[1], "truth.json").write_text(json.dumps({
    "calib": {"intrinsics": {"widthPx": W, "heightPx": H, "fx": FX, "fy": FY,
                             "cx": CX, "cy": CY, "dist": [0] * 5},
              "labToCam": {"rvec": cv2.Rodrigues(R)[0].ravel().tolist(),
                           "tvecMm": t.ravel().tolist()}},
    "labMm": pts.tolist(), "px": px.reshape(-1, 2).tolist(),
}), encoding="utf-8")
print(f"  cv2 정답 {len(pts)} 점 생성 (주점 중앙에서 {abs(CX-W/2):.0f},{abs(CY-H/2):.0f}px 어긋남)")
PY

node --input-type=module -e "
import { readFileSync } from 'node:fs';
import * as THREE from '$ROOT/node_modules/three/build/three.module.js';
const { applyCalibToCamera, labToPixel } = await import('$ROOT/Shared/view3d/global-cam.js');
const T = JSON.parse(readFileSync('$TMP/truth.json', 'utf8'));
const cam = new THREE.PerspectiveCamera();
applyCalibToCamera(cam, T.calib);
let worst = 0;
T.labMm.forEach((p, i) => {
  const got = labToPixel(cam, T.calib, p);
  const e = Math.hypot(got[0] - T.px[i][0], got[1] - T.px[i][1]);
  worst = Math.max(worst, e);
  console.log('  [' + p.map(v=>v.toFixed(0)).join(',') + '] cv2 ('
    + T.px[i].map(v=>v.toFixed(1)).join(', ') + ')  three (' + got.map(v=>v.toFixed(1)).join(', ')
    + ')  오차 ' + e.toFixed(3) + 'px');
});
console.log('  최대 오차 ' + worst.toFixed(3) + ' px');
if (!(worst < 1)) { console.error('  FAIL  1px 를 넘는다'); process.exit(1); }
" || exit 1

# **이 초록불이 증명하지 않는 것을 같이 찍는다** (2026-08-08 · GAP-MATRIX P1).
# 위 투영은 `np.zeros(5)` — 어긋나게 만드는 왜곡 항을 0 으로 두고 잰 값이다. 그래서 이 검사가
# 증명하는 건 "OpenCV 와 three.js 의 핀홀 수식이 같다" 이지 "실제 렌즈 위에 겹쳐도 맞는다" 가
# 아니다. 안 적으면 사람이 이 초록을 정합 검증으로 오인한다 — 실측 왜곡은 모서리 82px 다.
echo "카메라 변환 OK  (⚠ 왜곡 0 가정 — 실렌즈 정합은 이 게이트 밖. 모서리 82px · GAP P1)"
