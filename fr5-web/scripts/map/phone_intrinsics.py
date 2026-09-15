#!/usr/bin/env python3
"""브라우저에서 모은 기존 AprilTag 4장 모서리 → 휴대폰 내부 파라미터.

새 보정판을 쓰지 않는다. `tag-cv-track.html?calibrate=1`에서 서로 다른 거리·각도의
12시점을 저장한 뒤 그 JSON을 입력한다. 움직이는 폰의 자세는 저장하지 않으며 글로벌
카메라 설정도 건드리지 않는다.

    python3 scripts/map/phone_intrinsics.py ~/Downloads/phone-tags-....json
    python3 scripts/map/phone_intrinsics.py --self-test
"""
import argparse
import json
import math
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.map.extrinsics import corners_3d  # noqa: E402 — 직접 실행에서도 공용 모서리 순서를 재사용한다


DEFAULT_INPUT = ROOT / "calib-shots/phone-tags.json"
DEFAULT_LAYOUT = ROOT / "calib-shots/tag-layout.json"
DEFAULT_OUTPUT = ROOT / "Shared/data/config/phone-cam.json"
MIN_SHOTS = 12
MIN_TAGS = 3
MAX_RMS_PX = 2.0
MAX_FOCAL_SUBSET_SPREAD = 0.05
MIN_COVERAGE_X = 0.50
MIN_COVERAGE_Y = 0.40

CALIBRATION_FLAGS = (
    cv2.CALIB_USE_INTRINSIC_GUESS |
    cv2.CALIB_FIX_ASPECT_RATIO |
    cv2.CALIB_FIX_PRINCIPAL_POINT |
    cv2.CALIB_ZERO_TANGENT_DIST |
    cv2.CALIB_FIX_K1 | cv2.CALIB_FIX_K2 | cv2.CALIB_FIX_K3 |
    cv2.CALIB_FIX_K4 | cv2.CALIB_FIX_K5 | cv2.CALIB_FIX_K6
)


def _points(doc, layout):
    if doc.get("version") != 1 or doc.get("kind") != "phone-tag-intrinsics":
        raise ValueError("입력 형식이 아니다 — version 1 · kind phone-tag-intrinsics 필요")
    image = doc.get("image", {})
    width, height = image.get("widthPx"), image.get("heightPx")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise ValueError("image.widthPx · heightPx가 양의 정수여야 한다")
    shots = doc.get("shots", [])
    if len(shots) < MIN_SHOTS:
        raise ValueError(f"보정 샷 {len(shots)}장 — 최소 {MIN_SHOTS}장 필요")

    size = float(layout["tagSizeMm"])
    if not math.isclose(float(doc.get("tagSizeMm", -1)), size, rel_tol=0, abs_tol=1e-6):
        raise ValueError(f"입력 태그 크기 {doc.get('tagSizeMm')}mm와 배치도 {size}mm가 다르다")
    default_yaw = float(layout.get("defaultYawDeg", 0))
    object_points, image_points, all_image = [], [], []
    used_ids = set()
    for shot_no, shot in enumerate(shots, 1):
        seen, op, ip = set(), [], []
        for marker in shot.get("markers", []):
            try:
                marker_id = int(marker["id"])
            except (KeyError, TypeError, ValueError):
                raise ValueError(f"{shot_no}번 샷에 올바르지 않은 태그 ID") from None
            tag = layout.get("tags", {}).get(str(marker_id))
            if tag is None or marker_id in seen:
                continue
            corners = np.asarray(marker.get("corners"), dtype=np.float64)
            if corners.shape != (4, 2) or not np.isfinite(corners).all():
                raise ValueError(f"{shot_no}번 샷 id{marker_id} 모서리가 4×2 유한수 배열이 아니다")
            if (corners[:, 0].min() < 0 or corners[:, 0].max() > width or
                    corners[:, 1].min() < 0 or corners[:, 1].max() > height):
                raise ValueError(f"{shot_no}번 샷 id{marker_id} 모서리가 {width}×{height} 화면 밖이다")
            seen.add(marker_id)
            used_ids.add(marker_id)
            op.extend(corners_3d(tag, size, default_yaw))
            ip.extend(corners.tolist())
        if len(seen) < MIN_TAGS:
            raise ValueError(f"{shot_no}번 샷은 배치에 있는 서로 다른 태그 {len(seen)}장 — 최소 {MIN_TAGS}장 필요")
        object_points.append(np.asarray(op, dtype=np.float32))
        image_points.append(np.asarray(ip, dtype=np.float32))
        all_image.extend(ip)
    return width, height, shots, sorted(used_ids), object_points, image_points, np.asarray(all_image)


def _calibrate(object_points, image_points, width, height):
    # ponytail: 브라우저의 보정 후 영상만 지원한다. RAW/비중앙 크롭이 필요해지면 자유 모델을
    # 별도 경로로 되살린다. 지금 자유도는 실폰 표본 분할에서 초점값을 8~16% 흔들었다(D225).
    focal_guess = max(width, height) * 0.6
    initial = np.array([
        [focal_guess, 0, width / 2],
        [0, focal_guess, height / 2],
        [0, 0, 1],
    ], dtype=np.float64)
    rms, matrix, dist, _, _ = cv2.calibrateCamera(
        object_points, image_points, (width, height), initial, np.zeros(5),
        flags=CALIBRATION_FLAGS)
    if not np.isfinite(matrix).all() or not np.isfinite(dist).all() or not math.isfinite(rms):
        raise ValueError("보정 결과가 유한수가 아니다 — 촬영 각도를 더 벌려 다시 담아라")
    return float(rms), matrix, dist.reshape(-1)


def solve(doc, layout):
    width, height, shots, tag_ids, op, ip, all_image = _points(doc, layout)
    coverage_x = float(np.ptp(all_image[:, 0]) / width)
    coverage_y = float(np.ptp(all_image[:, 1]) / height)
    if coverage_x < MIN_COVERAGE_X or coverage_y < MIN_COVERAGE_Y:
        raise ValueError(
            f"화면 덮음 x {coverage_x:.0%} · y {coverage_y:.0%} — "
            f"각각 {MIN_COVERAGE_X:.0%} · {MIN_COVERAGE_Y:.0%} 이상 필요")

    rms, matrix, dist = _calibrate(op, ip, width, height)
    if rms > MAX_RMS_PX:
        raise ValueError(f"재투영 RMS {rms:.3f}px — 상한 {MAX_RMS_PX:.1f}px 초과")
    split = len(op) // 2
    subsets = (op[:split], op[split:], op[::2], op[1::2])
    image_subsets = (ip[:split], ip[split:], ip[::2], ip[1::2])
    subset_results = [_calibrate(a, b, width, height) for a, b in zip(subsets, image_subsets)]
    subset_rms = [result[0] for result in subset_results]
    if max(subset_rms) > MAX_RMS_PX:
        raise ValueError(f"부분 재투영 RMS 최대 {max(subset_rms):.3f}px — 상한 {MAX_RMS_PX:.1f}px 초과")
    subset_focals = [float(result[1][0, 0]) for result in subset_results]
    focal_spread = float(np.ptp(subset_focals) / np.mean(subset_focals))
    if focal_spread > MAX_FOCAL_SUBSET_SPREAD:
        raise ValueError(
            f"앞/뒤·홀짝 초점값 범위 {focal_spread:.1%} — 상한 {MAX_FOCAL_SUBSET_SPREAD:.0%} 초과")

    fx, fy, cx, cy = map(float, (matrix[0, 0], matrix[1, 1], matrix[0, 2], matrix[1, 2]))
    if fx <= 0 or fy <= 0 or not (0 <= cx <= width and 0 <= cy <= height):
        raise ValueError("초점거리 또는 주점이 물리 범위를 벗어났다")
    captured = [shot.get("capturedAt") for shot in shots if shot.get("capturedAt")]
    return {
        "_생성됨": "python3 scripts/map/phone_intrinsics.py <브라우저에서 저장한 JSON>",
        "_단위": "pixel",
        "intrinsics": {
            "widthPx": width, "heightPx": height,
            "fx": fx, "fy": fy, "cx": cx, "cy": cy,
            "dist": [float(value) for value in dist],
            "rmsPx": rms, "shots": len(shots),
        },
        "source": {
            "kind": "tag-layout-corners", "tagIds": tag_ids,
            "model": "centered-square-zero-distortion",
            "capturedAt": [min(captured), max(captured)] if captured else [],
            "layout": "calib-shots/tag-layout.json",
            "coverageX": coverage_x, "coverageY": coverage_y,
            "focalSubsetSpread": focal_spread, "subsetRmsMax": max(subset_rms),
        },
    }


def _synthetic_document(layout):
    width, height = 720, 1280
    matrix = np.array([[930.0, 0, 360.0], [0, 930.0, 640.0], [0, 0, 1.0]])
    translations = [
        (-360, -450, 1550), (-260, 600, 1650), (-380, -300, 1450), (-240, 500, 1500),
        (-340, -150, 1800), (-280, 350, 1350), (-350, -450, 1700), (-250, 600, 1750),
        (-370, -250, 1500), (-240, 500, 1600), (-330, -100, 1400), (-270, 250, 1550),
    ]
    rotations = [(-.10, .08, -.06), (.08, -.10, .04), (-.06, -.11, .08), (.11, .06, -.03),
                 (-.09, .10, .02), (.07, -.08, -.08), (-.12, -.04, .05), (.10, .09, -.02),
                 (-.07, .12, .07), (.11, -.08, -.06), (-.05, .07, .09), (.08, -.11, -.04)]
    shots = []
    for index, (translation, rotation) in enumerate(zip(translations, rotations)):
        markers = []
        for marker_id in (0, 1, 2, 4):
            points = np.asarray(corners_3d(layout["tags"][str(marker_id)], layout["tagSizeMm"], 0), np.float64)
            projected, _ = cv2.projectPoints(points, np.asarray(rotation), np.asarray(translation, np.float64), matrix, None)
            corners = projected.reshape(-1, 2)
            if (corners[:, 0].min() >= 0 and corners[:, 0].max() <= width and
                    corners[:, 1].min() >= 0 and corners[:, 1].max() <= height):
                markers.append({"id": marker_id, "corners": corners.tolist(), "hammingDistance": 0})
        shots.append({"capturedAt": f"2026-09-11T04:{index:02d}:00.000Z", "markers": markers})
    return {"version": 1, "kind": "phone-tag-intrinsics", "image": {"widthPx": width, "heightPx": height},
            "tagIds": [0, 1, 2, 4], "tagSizeMm": 145, "shots": shots}, matrix


def self_test(layout):
    doc, expected = _synthetic_document(layout)
    got = solve(doc, layout)
    intrinsics = got["intrinsics"]
    assert abs(intrinsics["fx"] - expected[0, 0]) / expected[0, 0] < 0.01
    assert abs(intrinsics["fy"] - expected[1, 1]) / expected[1, 1] < 0.01
    assert abs(intrinsics["cx"] - expected[0, 2]) < 3
    assert abs(intrinsics["cy"] - expected[1, 2]) < 3
    assert intrinsics["dist"] == [0.0] * 5
    assert got["source"]["focalSubsetSpread"] < MAX_FOCAL_SUBSET_SPREAD
    try:
        solve({**doc, "shots": doc["shots"][:11]}, layout)
    except ValueError as error:
        assert "최소 12장" in str(error)
    else:
        raise AssertionError("11장 입력을 거부하지 않았다")
    print(f"폰 태그 내부 파라미터 자체 검사 OK · RMS {intrinsics['rmsPx']:.4f}px")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--layout", type=Path, default=DEFAULT_LAYOUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        layout = json.loads(args.layout.read_text(encoding="utf-8"))
        if args.self_test:
            self_test(layout)
            return 0
        doc = json.loads(args.input.read_text(encoding="utf-8"))
        result = solve(doc, layout)
        result["source"]["layout"] = str(args.layout.relative_to(ROOT) if args.layout.is_relative_to(ROOT) else args.layout)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.output.parent, delete=False) as handle:
            json.dump(result, handle, ensure_ascii=False, indent=1)
            handle.write("\n")
            temporary = Path(handle.name)
        temporary.replace(args.output)
        intrinsics = result["intrinsics"]
        source = result["source"]
        output_name = args.output.relative_to(ROOT) if args.output.is_relative_to(ROOT) else args.output
        print(f"{output_name} 저장 · {intrinsics['widthPx']}×{intrinsics['heightPx']} · "
              f"RMS {intrinsics['rmsPx']:.3f}px · 부분 초점 범위 {source['focalSubsetSpread']:.1%}")
        return 0
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError, cv2.error) as error:
        print(f"실패 — {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
