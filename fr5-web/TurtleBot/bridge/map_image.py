# live.png — 매핑 중 점유격자 스냅샷 (TB-CONTRACT §맵 · 1s 폴링).
# 의존성 없이 stdlib(zlib·struct)로 그레이스케일 PNG 를 만든다. mock 은 SLAM 처럼
# "로봇이 지나간 곳만 밝아지는" 그림을 낸다 — 실기(P4)는 real 어댑터의 OccupancyGrid 로 교체.
import math
import struct
import zlib

W, H = 240, 160                    # 12000×8000mm ÷ 50mm/px
MM_PER_PX = 50
UNKNOWN, FREE, ROBOT = 110, 235, 20
EXPLORE_RADIUS_PX = 10             # 500mm — LiDAR 가 비추는 반경 흉내


def _chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def _encode(rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)   # 행마다 필터 0
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 0, 0, 0, 0)    # 8bit grayscale
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(raw)) + _chunk(b"IEND", b""))


def render(trail_mm, pose_mm):
    """trail_mm: [(xMm,yMm)...] · pose_mm: {xMm,yMm}. y 는 아래가 0 이라 뒤집는다."""
    grid = [[UNKNOWN] * W for _ in range(H)]

    def px(x_mm, y_mm):
        return int(x_mm / MM_PER_PX), H - 1 - int(y_mm / MM_PER_PX)

    for x_mm, y_mm in trail_mm:
        cx, cy = px(x_mm, y_mm)
        for dy in range(-EXPLORE_RADIUS_PX, EXPLORE_RADIUS_PX + 1):
            for dx in range(-EXPLORE_RADIUS_PX, EXPLORE_RADIUS_PX + 1):
                if dx * dx + dy * dy > EXPLORE_RADIUS_PX ** 2:
                    continue
                x, y = cx + dx, cy + dy
                if 0 <= x < W and 0 <= y < H:
                    grid[y][x] = FREE

    if pose_mm:
        cx, cy = px(pose_mm["xMm"], pose_mm["yMm"])
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                x, y = cx + dx, cy + dy
                if 0 <= x < W and 0 <= y < H:
                    grid[y][x] = ROBOT

    return _encode(grid)
