# 관문이 내는 본문(`GET /api/camera/state`) 단위 — **카메라 없이 돈다.**
# `pyrealsense2` 는 `Camera._session` 안에서만 import 되므로 `start()` 를 안 부르면
# 이 파일은 하드웨어 없는 기계에서 그대로 돈다. 여기서 보는 것은 **계약 준수**다.
import unittest
from io import BytesIO
import json
import time
import zipfile

import numpy as np
from PIL import Image

from camera import Camera

CFG = {
    "camera_id": "wrist-d435",
    "clock_peer": None,
    "depth": {"resolution": "848x480", "fps": 30, "valid_ratio_center_min": None},
    "color": {"resolution": "848x480", "fps": 30},
    "min_z_mm": {"848x480": 195},
}


def cam(**over):
    c = Camera({**CFG, **over})
    return c


class FailClosed(unittest.TestCase):
    def test_아무것도_못_본_상태는_통과가_아니다(self):
        s = cam().snapshot()
        self.assertFalse(s["connected"])
        self.assertFalse(s["depth"]["valid"])
        self.assertEqual(s["depth"]["validReason"], "noCamera")

    def test_카메라가_빠지면_옛_비율을_안_싣는다(self):
        # 2026-08-07 실기 — 케이블을 뽑았는데 `validRatioCenter 0.945` 가 그대로 남아 있었다.
        # `valid:false` 를 안 보고 비율만 읽는 소비자에게 죽은 카메라가 "94.5% 좋음" 이 된다
        c = cam()
        c.ratios = (0.93, 0.945)      # 마지막으로 봤던 좋은 프레임
        c.info = None                 # 그러고 나서 빠졌다
        s = c.snapshot()
        self.assertEqual(s["depth"]["validRatio"], 0.0)
        self.assertEqual(s["depth"]["validRatioCenter"], 0.0)
        self.assertEqual(s["depth"]["validReason"], "noCamera")

    def test_붙어는_있는데_프레임이_안_오면_noFrame_이다(self):
        c = cam()
        c.info = {"usb": "3.2"}
        c.min_z = 195
        c.ratios = (0.9, 0.9)
        c.frame_at = None
        s = c.snapshot()
        self.assertTrue(s["connected"])
        self.assertEqual(s["depth"]["validReason"], "noFrame")
        self.assertEqual(s["depth"]["validRatioCenter"], 0.0)

    def test_Min_Z_를_모르는_해상도면_프레임이_있어도_판정하지_않는다(self):
        # 표에 없는 해상도로 돌면 비율의 기준선이 없다 — "다 유효" 로 통과시키면 안 된다
        import time
        c = cam(depth={"resolution": "1920x1080", "fps": 30, "valid_ratio_center_min": 0.5})
        c.info = {"usb": "3.2"}
        c.min_z = None
        c.frame_at = time.time()
        c.ratios = (1.0, 1.0)
        s = c.snapshot()
        self.assertFalse(s["depth"]["valid"])
        self.assertEqual(s["depth"]["validReason"], "noFrame")


class 미리보기(unittest.TestCase):
    """**컬러는 깊이와 따로 늙는다.** 둘은 같은 USB 를 나눠 쓰는 다른 센서라 대역이 빡빡하면
    컬러가 먼저 떨어지는데, 그동안 깊이는 계속 와서 화면은 "다 정상" 이라고 말한다."""

    def test_컬러만_멎으면_옛_사진을_안_준다(self):
        import time
        c = cam()
        c.jpeg = b'\xff\xd8old'
        c.jpeg_at = time.time() - 5      # 5초 전 사진
        c.frame_at = time.time()         # 그런데 깊이는 지금도 온다
        self.assertIsNone(c.preview_jpeg())

    def test_방금_사진은_준다(self):
        c = cam()
        c.jpeg = b'\xff\xd8new'
        c.jpeg_at = time.time()
        self.assertEqual(c.preview_jpeg(), b'\xff\xd8new')

    def test_시각이_없으면_안_준다(self):
        # 시각을 안 달고 사진만 넣는 경로가 생기면 낡음을 못 잰다 — 그때는 안 주는 쪽이다
        c = cam()
        c.jpeg = b'\xff\xd8x'
        c.jpeg_at = None
        self.assertIsNone(c.preview_jpeg())


class RGBD묶음(unittest.TestCase):
    def test_같은_모양의_최신_컬러와_깊이를_한_zip으로_낸다(self):
        c = cam()
        c.info = {"serial": "123", "firmware": "5.0", "usb": "3.2",
                  "colorIntrinsics": {"fx": 8.0, "fy": 8.0, "ppx": 4.0, "ppy": 3.0},
                  "colorToDepth": {"rotationRowMajor": [1, 0, 0, 0, 1, 0, 0, 0, 1],
                                   "translationMm": [15, 0, 0]}}
        c.rgbd_color = np.full((6, 8, 3), [180, 90, 40], dtype=np.uint8)
        c.rgbd_depth_mm = np.full((6, 8), 321, dtype=np.uint16)
        c.rgbd_at = time.time()
        blob = c.rgbd_zip()
        self.assertIsNotNone(blob)
        with zipfile.ZipFile(BytesIO(blob)) as zf:
            self.assertEqual(set(zf.namelist()), {"manifest.json", "color.jpg", "depth.png"})
            meta = json.loads(zf.read("manifest.json"))
            self.assertEqual((meta["alignment"], meta["widthPx"], meta["heightPx"]),
                             ("depthToColor", 8, 6))
            self.assertEqual(meta["intrinsics"]["fx"], 8.0)
            self.assertEqual(meta["colorToDepth"]["translationMm"], [15, 0, 0])
            depth = np.asarray(Image.open(BytesIO(zf.read("depth.png"))))
            color = np.asarray(Image.open(BytesIO(zf.read("color.jpg"))))
            self.assertEqual(depth.shape, (6, 8))
            self.assertEqual(color.shape, (6, 8, 3))
            self.assertEqual(depth.dtype, np.uint16)

    def test_낡거나_모양이_다르면_안_낸다(self):
        c = cam()
        c.rgbd_color = np.zeros((6, 8, 3), np.uint8)
        c.rgbd_depth_mm = np.zeros((6, 7), np.uint16)
        c.rgbd_at = time.time()
        self.assertIsNone(c.rgbd_zip())
        c.rgbd_depth_mm = np.zeros((6, 8), np.uint16)
        c.rgbd_at = time.time() - 5
        self.assertIsNone(c.rgbd_zip())

class Contract(unittest.TestCase):
    def test_계약_필드가_전부_있다(self):
        s = cam().snapshot()
        for k in ("t", "cameraId", "connected", "usb", "depth", "lastFrameAt",
                  "clock", "clockSkewMs", "tempC"):
            self.assertIn(k, s, k)
        for k in ("resolution", "fps", "minZmm", "valid",
                  "validRatio", "validRatioCenter", "validReason"):
            self.assertIn(k, s["depth"], k)

    def test_같은_기계면_시계_차이가_0_이다(self):
        self.assertEqual(cam().snapshot()["clockSkewMs"], 0)

    def test_다른_기계로_옮기면_안_잰_시계는_None_이다(self):
        # 계약 §clockSkewMs — 못 재면 통과가 아니다. 위에서 fail-closed 로 읽을 수 있게 남긴다
        self.assertIsNone(cam(clock_peer="192.168.30.240:5055").snapshot()["clockSkewMs"])


if __name__ == "__main__":
    unittest.main()
