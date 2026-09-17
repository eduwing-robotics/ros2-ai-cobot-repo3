#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""고정대(흰색 지그) 메시를 만든다 — **구멍이 진짜로 뚫려 있는** 판.

**왜 메시인가.** 박스 geom 에 어두운 원반을 얹으면 구멍처럼 보이질 않는다. 원반을
조금이라도 올리면 혹처럼 튀어나오고, 내리면 박스 면에 가려 아예 안 보인다.
구멍을 눈으로 확인하려면 실제로 파인 형상이 있어야 한다.

**만드는 것** — 직육면체에서 원기둥 9개를 위에서 파낸 형상:
    바깥 116 x 104 x 29 mm  ·  구멍 Ø11 x 깊이 15mm  ·  3x3, 간격 28mm

**어떻게 파는가.** 불리언 라이브러리(trimesh/manifold3d)가 없어서 손으로 면을 깐다.
윗면을 구멍마다 28x28mm 칸으로 나누고, 각 칸을 **원과 정사각형 사이의 고리**로
삼각분할한다(원 위의 점 i 를 같은 각도의 사각형 둘레 점에 대응). 칸 바깥 테두리는
직사각형 4개로 덮는다. 나머지는 바닥면, 옆면 4개, 구멍마다 원통 벽과 바닥 원판.

⚠ **충돌은 여전히 통짜 박스다.** MuJoCo 는 메시 충돌을 볼록껍질로 계산하므로
  구멍은 충돌에 반영되지 않는다. 보이기용이고, 그게 우리에게 필요한 전부다.
  (탄피는 어차피 <exclude casing bench/> 로 접촉을 빼 놓았다)

치수 근거는 fr5_site / MJCF 주석 참조 — 두께 29mm 는 [실측 2026-09-07].
"""

import os
import struct

import numpy as np

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "share", "urdf", "meshes", "ammo")

# ── 치수 (m) ──────────────────────────────────────────────────────────────
HALF_X, HALF_Y = 0.058, 0.052      # 바깥 116 x 104 mm
THICK = 0.029                      # [실측] 두께 29mm
HOLE_R = 0.0055                    # Ø11
HOLE_DEPTH = 0.015                 # [실측 요청] 위에서 15mm 판다
PITCH = 0.028                      # 구멍 간격 28mm (참고 씬과 동일)
CELL = PITCH / 2                   # 칸 반크기 14mm
N_SEG = 48                         # 원주 분할

TOP = THICK / 2                    # +14.5mm
BOT = -THICK / 2                   # -14.5mm
FLOOR = TOP - HOLE_DEPTH           # 구멍 바닥 -0.5mm


def write_stl(path, tris):
    tris = np.asarray(tris, dtype=np.float32)
    with open(path, "wb") as f:
        f.write(b"\0" * 80)
        f.write(struct.pack("<I", len(tris)))
        for t in tris:
            n = np.cross(t[1] - t[0], t[2] - t[0])
            ln = np.linalg.norm(n)
            n = n / ln if ln > 1e-12 else np.array([0, 0, 1], dtype=np.float32)
            f.write(struct.pack("<3f", *n))
            for v in t:
                f.write(struct.pack("<3f", *v))
            f.write(b"\0\0")
    return len(tris)


def quad(a, b, c, d):
    """사각형 하나 → 삼각형 둘."""
    return [[a, b, c], [a, c, d]]


def rect_z(x0, x1, y0, y1, z, up):
    """z 평면 위의 직사각형. up=True 면 법선이 +z."""
    p = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
    return quad(*p) if up else quad(p[0], p[3], p[2], p[1])


def square_at(theta, half):
    """각도 theta 에서 반크기 half 인 정사각형 둘레 위의 점.
    원 위의 점과 1:1 로 대응시켜 고리를 삼각분할하려고 쓴다."""
    c, s = np.cos(theta), np.sin(theta)
    k = half / max(abs(c), abs(s))
    return k * c, k * s


def build():
    tris = []
    th = np.linspace(0, 2 * np.pi, N_SEG, endpoint=False)
    centers = [((i - 1) * PITCH, (j - 1) * PITCH) for i in range(3) for j in range(3)]
    BX, BY = 1.5 * PITCH, 1.5 * PITCH          # 3x3 칸 블록의 반크기 = 42mm

    # ── 바닥면 (법선 -z) ──
    tris += rect_z(-HALF_X, HALF_X, -HALF_Y, HALF_Y, BOT, up=False)

    # ── 옆면 4개 ──
    for (x0, y0), (x1, y1) in [((-HALF_X, -HALF_Y), (HALF_X, -HALF_Y)),
                               ((HALF_X, -HALF_Y), (HALF_X, HALF_Y)),
                               ((HALF_X, HALF_Y), (-HALF_X, HALF_Y)),
                               ((-HALF_X, HALF_Y), (-HALF_X, -HALF_Y))]:
        tris += quad((x0, y0, BOT), (x1, y1, BOT), (x1, y1, TOP), (x0, y0, TOP))

    # ── 윗면 테두리 (칸 블록 바깥) ──
    tris += rect_z(-HALF_X, -BX, -HALF_Y, HALF_Y, TOP, up=True)
    tris += rect_z(BX, HALF_X, -HALF_Y, HALF_Y, TOP, up=True)
    tris += rect_z(-BX, BX, -HALF_Y, -BY, TOP, up=True)
    tris += rect_z(-BX, BX, BY, HALF_Y, TOP, up=True)

    # ── 구멍마다: 윗면 고리 + 원통 벽 + 바닥 원판 ──
    for cx, cy in centers:
        for k in range(N_SEG):
            t0, t1 = th[k], th[(k + 1) % N_SEG]
            c0 = (cx + HOLE_R * np.cos(t0), cy + HOLE_R * np.sin(t0), TOP)
            c1 = (cx + HOLE_R * np.cos(t1), cy + HOLE_R * np.sin(t1), TOP)
            sx0, sy0 = square_at(t0, CELL); s0 = (cx + sx0, cy + sy0, TOP)
            sx1, sy1 = square_at(t1, CELL); s1 = (cx + sx1, cy + sy1, TOP)
            # 윗면 고리 — 법선 +z (원 -> 사각형 바깥쪽)
            tris += quad(c0, s0, s1, c1)
            # 원통 벽 — 법선이 구멍 **안쪽**을 향한다 (재료가 바깥에 있다)
            w0 = (c0[0], c0[1], FLOOR); w1 = (c1[0], c1[1], FLOOR)
            tris += quad(c0, c1, w1, w0)
            # 구멍 바닥 원판 — 법선 +z
            tris.append([(cx, cy, FLOOR), w0, w1])
    return tris


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "fixture.stl")
    n = write_stl(path, build())
    print(f"고정대 메시  {os.path.relpath(path)}  삼각형 {n}개")
    print(f"  바깥 {HALF_X*2000:.0f} x {HALF_Y*2000:.0f} x {THICK*1000:.0f} mm")
    print(f"  구멍 Ø{HOLE_R*2000:.0f} x 깊이 {HOLE_DEPTH*1000:.0f} mm · 3x3 · 간격 {PITCH*1000:.0f} mm")
    print(f"  윗면 z {TOP*1000:+.1f} · 구멍 바닥 z {FLOOR*1000:+.1f} · 아랫면 z {BOT*1000:+.1f} (메시 국소)")
    print("  ⚠ 충돌은 볼록껍질(= 통짜 박스)이다. 구멍은 보이기용이다.")


if __name__ == "__main__":
    main()
