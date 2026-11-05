"""Chromora P1 tonal color-grading API and project acceptance tests.

These tests exercise the existing HTTP render/project/export APIs and on-disk
project format. They do not inspect or modify UI-only wheel gestures; those
require browser acceptance after the three-wheel control exists.
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
from urllib.parse import quote
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server as chromora_server  # noqa: E402

GRADE_KEYS = (
    "shadowHue", "shadowSat",
    "midtoneHue", "midtoneSat",
    "highlightHue", "highlightSat",
)
ZERO_GRADE = {key: 0 for key in GRADE_KEYS} | {"colorBalance": 0}


def make_three_tone_image() -> np.ndarray:
    """Three neutral source bands expose shadow, midtone, and highlight masks."""
    pixels = np.empty((96, 96, 3), dtype=np.uint8)
    for row, value in enumerate((36, 128, 220)):
        pixels[row * 32:(row + 1) * 32, :, :] = value
    return pixels


def make_regression_mask() -> dict:
    return {
        "id": "grading-roundtrip-mask",
        "name": "Grading round-trip mask",
        "type": "radial",
        "enabled": True,
        "geometry": {
            "center": {"x": 0.5, "y": 0.5},
            "radius": {"x": 0.4, "y": 0.4},
        },
        "feather": 0.1,
        "invert": False,
        "adjustments": {
            "exposure": 0.35,
            "highlights": 0,
            "shadows": 0,
            "temperature": 0,
            "saturation": 0,
        },
    }


class ColorGradingApiRoundTripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory(prefix="chromora-color-grading-api-")
        cls.root = Path(cls.temp.name)
        cls._patchers = []
        for name in ("PHOTOS", "DECODED", "THUMBS", "LUTS", "PROJECTS", "OUTPUT", "HANDOFF"):
            path = cls.root / name
            path.mkdir(parents=True, exist_ok=True)
            patcher = patch.object(chromora_server, name, path)
            patcher.start()
            cls._patchers.append(patcher)

        stream = BytesIO()
        Image.fromarray(make_three_tone_image(), "RGB").save(stream, format="PNG")
        cls.photo_bytes = stream.getvalue()
        cls.photo_id = sha256(cls.photo_bytes).hexdigest() + ".png"
        (chromora_server.PHOTOS / cls.photo_id).write_bytes(cls.photo_bytes)

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
        connection = HTTPConnection(self.host, self.port, timeout=15)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def render_bytes(self, settings: dict) -> bytes:
        status, body, _ = self.request(
            "POST",
            "/api/render",
            {"id": self.photo_id, "settings": settings, "resolution": "full"},
        )
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        return body

    def render_rgb(self, settings: dict) -> np.ndarray:
        with Image.open(BytesIO(self.render_bytes(settings))) as image:
            return np.asarray(image.convert("RGB"), dtype=np.int16)

    def state(self, settings: dict) -> dict:
        return {
            "photos": [{"id": self.photo_id, "name": "tones.png", "settings": settings}],
            "currentId": self.photo_id,
            "luts": [],
            "favorites": [],
        }

    def save_project(self, name: str, state: dict):
        return self.request("POST", "/api/project", {"name": name, "state": state})

    def load_project(self, name: str):
        return self.request("GET", "/api/project?name=" + quote(name, safe=""))

    @staticmethod
    def band_deltas(actual: np.ndarray, neutral: np.ndarray) -> list[float]:
        deltas = []
        for start in (8, 40, 72):
            actual_mean = actual[start:start + 16, 24:72].mean(axis=(0, 1))
            neutral_mean = neutral[start:start + 16, 24:72].mean(axis=(0, 1))
            deltas.append(float(np.linalg.norm(actual_mean - neutral_mean)))
        return deltas

    def test_defaults_are_neutral_and_each_tone_wheel_isolation_is_distinct(self):
        # Omitted fields are the legacy-project defaults and must match explicit zeros.
        omitted = self.render_bytes({})
        explicit = self.render_bytes(ZERO_GRADE)
        self.assertEqual(omitted, explicit)
        neutral = self.render_rgb(ZERO_GRADE)

        cases = (
            ("shadowHue", "shadowSat", 0),
            ("midtoneHue", "midtoneSat", 1),
            ("highlightHue", "highlightSat", 2),
        )
        for hue_key, sat_key, target_index in cases:
            with self.subTest(tone=hue_key):
                settings = {**ZERO_GRADE, hue_key: 0, sat_key: 100}
                deltas = self.band_deltas(self.render_rgb(settings), neutral)
                others = [delta for index, delta in enumerate(deltas) if index != target_index]
                self.assertGreater(deltas[target_index], 8, "目标明暗区应可见地受该色轮影响")
                self.assertGreater(deltas[target_index], max(others) + 5,
                                   "单个色轮应主要影响对应的阴影/中间调/高光范围")

    def test_color_balance_negative_favors_shadows_and_positive_expands_highlights(self):
        neutral = self.render_rgb(ZERO_GRADE)
        middle = slice(40, 56)
        center = (slice(None), slice(None))

        highlight_wheel = {**ZERO_GRADE, "highlightHue": 0, "highlightSat": 100}
        no_balance = self.render_rgb(highlight_wheel)
        positive = self.render_rgb({**highlight_wheel, "colorBalance": 100})
        no_balance_highlight_delta = float(np.linalg.norm(
            no_balance[middle, 24:72].mean(axis=(0, 1)) - neutral[middle, 24:72].mean(axis=(0, 1))
        ))
        positive_highlight_delta = float(np.linalg.norm(
            positive[middle, 24:72].mean(axis=(0, 1)) - neutral[middle, 24:72].mean(axis=(0, 1))
        ))
        self.assertGreater(positive_highlight_delta, no_balance_highlight_delta + 5,
                           "正平衡应把高光影响扩展到中间调")

        shadow_wheel = {**ZERO_GRADE, "shadowHue": 0, "shadowSat": 100}
        no_balance = self.render_rgb(shadow_wheel)
        negative = self.render_rgb({**shadow_wheel, "colorBalance": -100})
        no_balance_shadow_delta = float(np.linalg.norm(
            no_balance[middle, 24:72].mean(axis=(0, 1)) - neutral[middle, 24:72].mean(axis=(0, 1))
        ))
        negative_shadow_delta = float(np.linalg.norm(
            negative[middle, 24:72].mean(axis=(0, 1)) - neutral[middle, 24:72].mean(axis=(0, 1))
        ))
        self.assertGreater(negative_shadow_delta, no_balance_shadow_delta + 5,
                           "负平衡应把影响偏向阴影")

    def test_numeric_limits_render_and_out_of_range_values_are_clamped(self):
        cases = (
            ({"shadowHue": -1, "shadowSat": 100}, {"shadowHue": 0, "shadowSat": 100}),
            ({"shadowHue": 361, "shadowSat": 100}, {"shadowHue": 360, "shadowSat": 100}),
            ({"midtoneSat": 101, "midtoneHue": 35}, {"midtoneSat": 100, "midtoneHue": 35}),
            ({"highlightSat": -1, "highlightHue": 35}, {"highlightSat": 0, "highlightHue": 35}),
            ({"highlightSat": 100, "highlightHue": 35, "colorBalance": 101},
             {"highlightSat": 100, "highlightHue": 35, "colorBalance": 100}),
            ({"shadowSat": 100, "shadowHue": 35, "colorBalance": -101},
             {"shadowSat": 100, "shadowHue": 35, "colorBalance": -100}),
        )
        for supplied, boundary in cases:
            with self.subTest(supplied=supplied):
                self.assertEqual(
                    self.render_bytes({**ZERO_GRADE, **supplied}),
                    self.render_bytes({**ZERO_GRADE, **boundary}),
                    "渲染应按 Hue 0–360、Sat 0–100、colorBalance -100–100 限定数值",
                )

    def test_project_round_trip_preserves_grading_mask_and_composition_and_export(self):
        settings = {
            "shadowHue": 24,
            "shadowSat": 61,
            "midtoneHue": 147,
            "midtoneSat": 39,
            "highlightHue": 263,
            "highlightSat": 78,
            "colorBalance": 32,
            "composition": {
                "crop": {"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9},
                "aspect": "free",
                "rotation": 0,
                "straighten": 0,
            },
            "masks": [make_regression_mask()],
        }
        before = self.render_bytes(settings)
        status, body, _ = self.save_project("color grading round trip", self.state(settings))
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))

        status, body, _ = self.load_project("color grading round trip")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        reopened = json.loads(body)["state"]["photos"][0]["settings"]
        for key, value in settings.items():
            self.assertEqual(reopened[key], value, f"工程重开后 {key} 必须原值保留")

        reopened_render = self.render_bytes(reopened)
        self.assertEqual(reopened_render, before, "工程重开后的渲染必须与保存前一致")
        status, body, _ = self.request(
            "POST",
            "/api/export",
            {
                "id": self.photo_id,
                "name": "color grading acceptance",
                "settings": reopened,
                "format": "jpeg",
            },
        )
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        output = Path(json.loads(body)["file"])
        self.assertTrue(output.is_file())
        self.assertEqual(output.read_bytes(), reopened_render,
                         "重开工程后 JPG 导出应与全分辨率 API 渲染一致")


if __name__ == "__main__":
    unittest.main()
