#
# 🔧 탄두/탄피 3D 메시 생성
#
# MuJoCo 기본 도형에는 원뿔이 없어(sphere/capsule/ellipsoid/cylinder/box 뿐),
# 탄두의 오지브 곡면을 원통 6개로 계단식 근사하고 있었다. 실물과 달라 보인다.
# 실측 치수 그대로 회전체(surface of revolution)를 만들어 STL 로 내보낸다.
#
# 치수는 전부 IMG_4636 / IMG_4643 / IMG_4644 실측값이며
# fr5_screw_assembly.py 의 상수와 동일하다.
#
import os
import struct

import numpy as np

import fr5_screw_assembly as E

# 이 파일 위치 기준 상대경로 — 절대경로면 저장소를 받은 다른 사람 기계에서 안 맞는다
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "share", "urdf", "meshes", "ammo")
N_SEG = 96          # 원주 분할 (클수록 매끄럽다)
N_OGIVE = 48        # 오지브 곡선 분할


def write_stl(path, tris):
    """이진 STL 저장. tris: (N,3,3) 삼각형 정점 배열."""
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


def revolve(profile, n_seg=N_SEG):
    """
    (z, r) 프로파일을 z축 둘레로 회전시켜 닫힌 solid 를 만든다.
    프로파일은 아래에서 위로 순서대로 주며, r=0 인 점이 축 위의 끝점이다.
    """
    prof = np.asarray(profile, dtype=float)
    ang = np.linspace(0.0, 2.0 * np.pi, n_seg, endpoint=False)
    cos, sin = np.cos(ang), np.sin(ang)
    tris = []

    for k in range(len(prof) - 1):
        z0, r0 = prof[k]
        z1, r1 = prof[k + 1]
        for i in range(n_seg):
            j = (i + 1) % n_seg
            a0 = np.array([r0 * cos[i], r0 * sin[i], z0])
            b0 = np.array([r0 * cos[j], r0 * sin[j], z0])
            a1 = np.array([r1 * cos[i], r1 * sin[i], z1])
            b1 = np.array([r1 * cos[j], r1 * sin[j], z1])
            if r0 < 1e-9:                      # 아래쪽이 축 위의 점 -> 삼각형 하나
                tris.append([a1, b1, a0])
            elif r1 < 1e-9:                    # 위쪽이 축 위의 점
                tris.append([a0, b0, a1])
            else:                              # 사각형 -> 삼각형 둘
                tris.append([a0, b0, b1])
                tris.append([a0, b1, a1])
    return tris


def bullet_profile():
    """
    탄두: 나사부(Ø4.8×7) -> 직선 몸통(Ø9×7) -> tangent ogive(16mm)
    z=0 이 나사 선단, z=30mm 가 오지브 끝(뾰족한 쪽).
    """
    R = E.BULLET_OD / 2
    thread_r = 0.0048 / 2
    shank_len = 0.007
    ogive_len = E.BULLET_LEN - E.THREAD_DEPTH - shank_len      # 16mm
    rho = (R ** 2 + ogive_len ** 2) / (2 * R)                  # 곡률반경 30.7mm

    p = [(0.0, 0.0),                       # 나사 선단 중심 (평평한 끝)
         (0.0, thread_r),
         (E.THREAD_DEPTH, thread_r),       # 나사부 끝
         (E.THREAD_DEPTH, R),              # 어깨 (탄피 입구에 얹히는 면)
         (E.THREAD_DEPTH + shank_len, R)]  # 직선 몸통 끝 = 오지브 시작

    z0 = E.THREAD_DEPTH + shank_len
    for k in range(1, N_OGIVE + 1):
        x = ogive_len * k / N_OGIVE            # 오지브 밑면(base)에서부터의 거리
        # tangent ogive 반경. base(x=0)에서 R, 팁(x=L)에서 0 이 되어야 한다.
        #   r(x) = sqrt(rho^2 - x^2) + R - rho
        # (sqrt 안을 (L-x) 로 쓰면 위아래가 뒤집혀 깔때기 모양이 된다)
        r = np.sqrt(max(rho ** 2 - x ** 2, 0.0)) + R - rho
        p.append((z0 + x, max(r, 0.0)))
    p.append((E.BULLET_LEN, 0.0))                              # 팁
    return p


def casing_profile():
    """
    탄피: 외경 Ø10 × 전장 57mm, 위쪽 THREAD_DEPTH(=6mm) 는 Ø5.2 로 뚫린 결합부(암나사).
    z=0 이 바닥, z=57mm 가 결합면.
    """
    r_out = E.CASE_OD / 2
    r_in = 0.0052 / 2                       # 삽입 clearance 포함
    z_top = E.CASE_LEN
    z_bore = z_top - E.THREAD_DEPTH

    return [(0.0, 0.0),                     # 바닥 중심
            (0.0, r_out),                   # 바닥 가장자리
            (z_top, r_out),                 # 외벽 -> 결합면 가장자리
            (z_top, r_in),                  # 결합면(도넛)
            (z_bore, r_in),                 # 구멍 벽
            (z_bore, 0.0)]                  # 구멍 바닥


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, prof in (("bullet", bullet_profile()), ("casing", casing_profile())):
        path = os.path.join(OUT_DIR, f"{name}.stl")
        n = write_stl(path, revolve(prof))
        zs = [p[0] for p in prof]
        rs = [p[1] for p in prof]
        print(f"💾 {path}")
        print(f"   삼각형 {n:,}개 | 길이 {max(zs)*1000:.1f}mm | 최대 외경 "
              f"{max(rs)*2000:.1f}mm")
