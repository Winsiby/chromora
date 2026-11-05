"""Chromora P1 mask API and project round-trip acceptance tests.

These tests intentionally exercise only the HTTP API and on-disk project format;
they do not replace the separate mask unit tests or inspect UI-only state.
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


LOCAL_ADJUSTMENTS = ("exposure", "highlights", "shadows", "temperature", "saturation")


def make_mask(
    mask_id: str,
    name: str,
    kind: str,
    *,
    geometry: dict,
    feather: float = 0,
    invert: bool = False,
    enabled: bool = True,
    adjustments: dict | None = None,
) -> dict:
    values = {key: 0 for key in LOCAL_ADJUSTMENTS}
    values.update(adjustments or {})
    return {
        "id": mask_id,
        "name": name,
        "type": kind,
        "enabled": enabled,
        "geometry": geometry,
        "feather": feather,
        "invert": invert,
        "adjustments": values,
    }


def linear_mask(*, invert: bool = False, exposure: float = 3) -> dict:
    return make_mask(
        "linear-sky",
        "Sky",
        "linear",
        geometry={"start": {"x": 0.5, "y": 0.1}, "end": {"x": 0.5, "y": 0.9}},
        invert=invert,
        adjustments={"exposure": exposure},
    )


def radial_mask(*, feather: float = 0, invert: bool = False, adjustments: dict | None = None) -> dict:
    return make_mask(
        "radial-subject",
        "Subject",
        "radial",
        geometry={"center": {"x": 0.5, "y": 0.5}, "radius": {"x": 0.35, "y": 0.35}},
        feather=feather,
        invert=invert,
        adjustments=adjustments,
    )


class MaskApiRoundTripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory(prefix="chromora-mask-api-")
        cls.root = Path(cls.temp.name)
        cls._patchers = []
        for name in ("PHOTOS", "DECODED", "THUMBS", "LUTS", "PROJECTS", "OUTPUT", "HANDOFF"):
            path = cls.root / name
            path.mkdir(parents=True, exist_ok=True)
            patcher = patch.object(chromora_server, name, path)
            patcher.start()
            cls._patchers.append(patcher)

        # A small, constant-color image makes spatial mask behavior easy to compare.
        pixels = np.empty((96, 96, 3), dtype=np.uint8)
        pixels[:, :] = (52, 66, 78)
        encoded = BytesIO()
        Image.fromarray(pixels, "RGB").save(encoded, format="PNG")
        cls.photo_bytes = encoded.getvalue()
        cls.photo_id = sha256(cls.photo_bytes).hexdigest() + ".png"
        (chromora_server.PHOTOS / cls.photo_id).write_bytes(cls.photo_bytes)

        cls.httpd = chromora_server.ThreadingHTTPServer(("127.0.0.1", 0), chromora_server.WorkbenchHandler)
        cls.httpd.debug = False
        cls.thread = Thread(target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
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
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif payload is None:
            body = None
        else:
            body = payload
        connection = HTTPConnection(self.host, self.port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def photo(self, settings: dict, *, name: str = "sample.png") -> dict:
        return {"id": self.photo_id, "name": name, "settings": settings}

    def state(self, settings: dict) -> dict:
        return {
            "photos": [self.photo(settings)],
            "currentId": self.photo_id,
            "luts": [],
            "favorites": [],
        }

    def save_project(self, name: str, state: dict):
        return self.request("POST", "/api/project", {"name": name, "state": state})

    def load_project(self, name: str):
        return self.request("GET", "/api/project?name=" + quote(name, safe=""))

    def render(self, settings: dict):
        status, body, _ = self.request(
            "POST",
            "/api/render",
            {"id": self.photo_id, "settings": settings, "resolution": "full"},
        )
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        with Image.open(BytesIO(body)) as image:
            return np.asarray(image.convert("RGB"), dtype=np.int16)

    def test_linear_direction_and_invert_and_radial_feather_are_visible_in_render(self):
        normal = self.render({"masks": [linear_mask()]})
        inverted = self.render({"masks": [linear_mask(invert=True)]})
        normal_top = int(normal[8, 48].mean())
        normal_bottom = int(normal[87, 48].mean())
        inverted_top = int(inverted[8, 48].mean())
        inverted_bottom = int(inverted[87, 48].mean())
        self.assertGreater(normal_top, normal_bottom + 30, "线性蒙版应从 start 的全强度向 end 衰减")
        self.assertGreater(inverted_bottom, inverted_top + 30, "反选应交换线性蒙版的作用方向")

        hard_edge = self.render({"masks": [radial_mask(adjustments={"exposure": 2})]})
        feathered = self.render({"masks": [radial_mask(feather=0.2, adjustments={"exposure": 2})]})
        # x=72 is inside the ellipse but close enough to its edge to show feathering.
        hard_value = int(hard_edge[48, 72].mean())
        feather_value = int(feathered[48, 72].mean())
        self.assertGreater(hard_value, feather_value + 8, "径向羽化应在椭圆边缘形成可见过渡")
        self.assertGreater(feather_value, int(feathered[48, 48].mean()) - 60)

    def test_one_photo_round_trips_multiple_masks_and_keeps_each_local_adjustment(self):
        masks = [
            linear_mask(exposure=1.25),
            radial_mask(feather=0.12, invert=True, adjustments={"temperature": 32, "saturation": -18}),
        ]
        settings = {"exposure": 0.1, "masks": masks}
        state = self.state(settings)
        status, body, _ = self.save_project("two masks", state)
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))

        status, body, _ = self.load_project("two masks")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        reopened = json.loads(body)
        saved_photo = reopened["state"]["photos"][0]
        self.assertEqual(len(saved_photo["settings"]["masks"]), 2)
        self.assertEqual(saved_photo["settings"]["masks"], masks)
        self.assertEqual(set(saved_photo["settings"]["masks"][0]["adjustments"]), set(LOCAL_ADJUSTMENTS))
        self.assertEqual(set(saved_photo["settings"]["masks"][1]["adjustments"]), set(LOCAL_ADJUSTMENTS))

        without_masks = self.render({"exposure": 0.1})
        with_masks = self.render(saved_photo["settings"])
        self.assertGreater(int(np.abs(with_masks.astype(np.int32) - without_masks).max()), 5,
                           "单张照片上的两枚蒙版应参与渲染")

    def test_saved_reopened_mask_render_matches_jpeg_export_exactly(self):
        settings = {
            "exposure": -0.15,
            "masks": [
                linear_mask(exposure=0.8),
                radial_mask(feather=0.16, adjustments={"highlights": -42, "shadows": 24}),
            ],
        }
        status, body, _ = self.save_project("export consistency", self.state(settings))
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        status, body, _ = self.load_project("export consistency")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        reopened_photo = json.loads(body)["state"]["photos"][0]

        render_status, rendered, _ = self.request(
            "POST",
            "/api/render",
            {"id": self.photo_id, "settings": reopened_photo["settings"], "resolution": "full"},
        )
        self.assertEqual(render_status, 200, rendered.decode("utf-8", "replace"))
        export_status, export_body, _ = self.request(
            "POST",
            "/api/export",
            {
                "id": self.photo_id,
                "name": reopened_photo["name"],
                "settings": reopened_photo["settings"],
                "format": "jpeg",
            },
        )
        self.assertEqual(export_status, 200, export_body.decode("utf-8", "replace"))
        export_file = Path(json.loads(export_body)["file"])
        self.assertTrue(export_file.is_file())
        self.assertEqual(rendered, export_file.read_bytes(), "重开工程后的全分辨率渲染应与 JPG 导出字节一致")

    def test_legacy_03_project_without_masks_loads_with_neutral_mask_behavior(self):
        legacy_settings = {
            "exposure": 0.35,
            "contrast": 12,
            "highlights": -8,
            "shadows": 10,
            "temperature": 5,
            "saturation": 8,
        }
        legacy_state = self.state(legacy_settings)
        path = chromora_server.project_path("legacy 0.3")
        path.write_text(
            json.dumps(
                {"name": "legacy 0.3", "state": legacy_state, "updated": "2026-01-01T00:00:00+00:00"},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        status, body, _ = self.load_project("legacy 0.3")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        reopened_settings = json.loads(body)["state"]["photos"][0]["settings"]
        self.assertEqual(reopened_settings, legacy_settings)
        self.assertNotIn("masks", reopened_settings, "打开旧工程不应伪造或改写其参数")
        legacy_render = self.render(reopened_settings)
        explicit_neutral_render = self.render({**reopened_settings, "masks": []})
        np.testing.assert_array_equal(legacy_render, explicit_neutral_render)

    def test_missing_original_open_is_rejected_without_changing_another_project(self):
        current_state = self.state({"exposure": 0.25, "masks": [linear_mask(exposure=0.5)]})
        status, body, _ = self.save_project("current project", current_state)
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        current_path = chromora_server.project_path("current project")
        original_current_bytes = current_path.read_bytes()

        missing_id = "f" * 64 + ".png"
        broken_state = {
            "photos": [{"id": missing_id, "name": "missing.png", "settings": {"exposure": 0}}],
            "currentId": missing_id,
            "luts": [],
            "favorites": [],
        }
        broken_path = chromora_server.project_path("project with missing original")
        broken_path.write_text(
            json.dumps(
                {"name": "project with missing original", "state": broken_state,
                 "updated": "2026-01-01T00:00:00+00:00"},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        missing_status, missing_body, _ = self.load_project("project with missing original")
        # GET is read-only; the unrelated current project must stay byte-for-byte intact.
        self.assertEqual(current_path.read_bytes(), original_current_bytes)
        current_status, current_body, _ = self.load_project("current project")
        self.assertEqual(current_status, 200, current_body.decode("utf-8", "replace"))
        self.assertEqual(json.loads(current_body)["state"], current_state)
        self.assertIn(missing_status, (400, 404),
                      "打开含缺失原片的工程必须失败；当前 server.py 只校验工程结构，未检查原片存在性。 "
                      f"实际 HTTP {missing_status}: {missing_body.decode('utf-8', 'replace')}")


if __name__ == "__main__":
    unittest.main()
