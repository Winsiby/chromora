"""HTTP API regression tests for Chromora's white-balance picker.

These tests deliberately exercise the public endpoint using source-image
coordinates. They do not modify or inspect UI-only picker or clipping-overlay
behavior, which is covered by browser acceptance testing.
"""

from __future__ import annotations

from hashlib import sha256
from http.client import HTTPConnection
import json
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server as chromora_server  # noqa: E402


INVALID_SAMPLE_MESSAGE = "取样区域过亮、过暗或颜色过饱和，请点击未剪切的中性灰或白色区域。"


class WhiteBalanceApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory(prefix="chromora-white-balance-api-")
        cls.root = Path(cls.temp.name)
        cls._patchers = []
        for name in ("PHOTOS", "DECODED", "THUMBS", "LUTS", "PROJECTS", "OUTPUT", "HANDOFF"):
            path = cls.root / name
            path.mkdir(parents=True, exist_ok=True)
            patcher = patch.object(chromora_server, name, path)
            patcher.start()
            cls._patchers.append(patcher)

        cls.httpd = chromora_server.ThreadingHTTPServer(
            ("127.0.0.1", 0), chromora_server.WorkbenchHandler
        )
        cls.httpd.debug = False
        cls.thread = Thread(
            target=cls.httpd.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        cls.thread.start()
        cls.host, cls.port = cls.httpd.server_address

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)
        for patcher in reversed(cls._patchers):
            patcher.stop()
        cls.temp.cleanup()

    def request(self, method: str, path: str, payload=None):
        headers = {}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        else:
            body = None
        connection = HTTPConnection(self.host, self.port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def save_photo(self, pixels: np.ndarray, *, orientation: int | None = None) -> str:
        image = Image.fromarray(np.asarray(pixels, dtype=np.uint8))
        encoded = BytesIO()
        if orientation is None:
            image.save(encoded, format="PNG")
        else:
            exif = Image.Exif()
            exif[274] = orientation
            image.save(encoded, format="PNG", exif=exif)
        content = encoded.getvalue()
        photo_id = sha256(content).hexdigest() + ".png"
        (chromora_server.PHOTOS / photo_id).write_bytes(content)
        return photo_id

    def sample(self, photo_id: str, x: float, y: float):
        return self.request("POST", "/api/white-balance", {"id": photo_id, "x": x, "y": y})

    def assert_valid_target(self, status: int, body: bytes, expected=None) -> tuple[int, int]:
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        payload = json.loads(body)
        self.assertEqual(set(payload), {"temperature", "tint"})
        for key in ("temperature", "tint"):
            self.assertIs(type(payload[key]), int, f"{key} 应为绝对整数滑杆目标值")
            self.assertGreaterEqual(payload[key], -100)
            self.assertLessEqual(payload[key], 100)
        target = (payload["temperature"], payload["tint"])
        if expected is not None:
            self.assertEqual(target, expected)
        return target

    @staticmethod
    def set_patch(pixels: np.ndarray, x: int, y: int, color, radius: int = 4):
        height, width = pixels.shape[:2]
        pixels[max(0, y - radius):min(height, y + radius + 1),
               max(0, x - radius):min(width, x + radius + 1)] = color

    def test_source_coordinates_map_to_pixel_centers_in_landscape_and_portrait(self):
        # Landscape: 0.63 * (40 - 1) rounds to x=25, and 0.4 * (24 - 1) to y=9.
        landscape = np.zeros((24, 40, 3), dtype=np.uint8)
        self.set_patch(landscape, 25, 9, (128, 128, 128))
        landscape_id = self.save_photo(landscape)
        status, body, _ = self.sample(landscape_id, 0.63, 0.4)
        self.assert_valid_target(status, body, expected=(0, 0))

        # Portrait: dimensions must not be swapped; x=7 and y=27 after rounding.
        portrait = np.zeros((40, 24, 3), dtype=np.uint8)
        self.set_patch(portrait, 7, 27, (190, 132, 91))
        portrait_id = self.save_photo(portrait)
        status, body, _ = self.sample(portrait_id, 0.3, 0.7)
        target = self.assert_valid_target(status, body)
        self.assertNotEqual(target, (0, 0), "偏色样本应返回非中性的白平衡目标")

    def test_coordinates_refer_to_the_exif_corrected_source_image(self):
        # The displayed/oriented source is 24x40. Orientation=6 stores it rotated
        # in a 40x24 PNG; the marked patch is at displayed coordinate (7, 27).
        oriented = np.zeros((40, 24, 3), dtype=np.uint8)
        self.set_patch(oriented, 7, 27, (128, 128, 128))
        stored_pixels = np.rot90(oriented, k=1)
        photo_id = self.save_photo(stored_pixels, orientation=6)

        status, body, _ = self.sample(photo_id, 0.3, 0.7)
        self.assert_valid_target(status, body, expected=(0, 0))

    def test_nine_by_nine_sample_window_is_clipped_at_image_edges(self):
        pixels = np.zeros((11, 13, 3), dtype=np.uint8)
        # At the top-left, the clipped window is 5x5 rather than zero-padded.
        pixels[:5, :5] = (128, 128, 128)
        # At the bottom-right, the clipped window is also 5x5.
        pixels[-5:, -5:] = (128, 128, 128)
        photo_id = self.save_photo(pixels)

        for x, y in ((0.0, 0.0), (1.0, 1.0)):
            with self.subTest(x=x, y=y):
                status, body, _ = self.sample(photo_id, x, y)
                self.assert_valid_target(status, body, expected=(0, 0))

    def test_neutral_gray_white_and_threshold_edge_samples_return_slider_targets(self):
        for color in ((128, 128, 128), (6, 6, 6), (249, 249, 249), (200, 90, 90)):
            with self.subTest(color=color):
                pixels = np.empty((15, 17, 3), dtype=np.uint8)
                pixels[:] = color
                photo_id = self.save_photo(pixels)
                status, body, _ = self.sample(photo_id, 0.5, 0.5)
                self.assert_valid_target(status, body)
                if color == (128, 128, 128):
                    self.assertEqual(json.loads(body), {"temperature": 0, "tint": 0})

    def test_clipped_or_over_saturated_samples_return_exact_http_400_error(self):
        invalid_colors = (
            (5, 5, 5),           # Lower clipping threshold, without a color cast.
            (250, 250, 250),     # Upper clipping threshold, without a color cast.
            (200, 89, 90),       # (max - min) / max is greater than 0.55.
        )
        for color in invalid_colors:
            with self.subTest(color=color):
                pixels = np.empty((15, 17, 3), dtype=np.uint8)
                pixels[:] = color
                photo_id = self.save_photo(pixels)
                status, body, _ = self.sample(photo_id, 0.5, 0.5)
                self.assertEqual(status, 400, body.decode("utf-8", "replace"))
                self.assertEqual(json.loads(body), {"error": INVALID_SAMPLE_MESSAGE})


if __name__ == "__main__":
    unittest.main()
