"""Chromora P1 composition API and project round-trip acceptance tests.

These tests intentionally exercise the HTTP API and on-disk project format;
they do not inspect UI-only state or relax assertions when composition support
is not implemented yet.
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
from urllib.parse import quote

import numpy as np
from PIL import Image, ImageOps
import tifffile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server as chromora_server  # noqa: E402


DEFAULT_COMPOSITION = {
    "crop": None,
    "aspect": "free",
    "rotation": 0,
    "straighten": 0,
}


def make_direction_markers() -> np.ndarray:
    """An asymmetric 8-by-5 grid; every 40-pixel tile has a distinct color."""
    rng = np.random.default_rng(1729)
    colors = rng.integers(35, 225, size=(5 * 8, 3), dtype=np.uint8)
    pixels = np.empty((200, 320, 3), dtype=np.uint8)
    for row in range(5):
        for column in range(8):
            pixels[row * 40:(row + 1) * 40,
                   column * 40:(column + 1) * 40] = colors[row * 8 + column]
    return pixels


def encode_png(pixels: np.ndarray, *, exif: Image.Exif | None = None) -> bytes:
    stream = BytesIO()
    Image.fromarray(pixels, "RGB").save(stream, format="PNG", exif=exif)
    return stream.getvalue()


def radial_mask() -> dict:
    return {
        "id": "composition-anchor-mask",
        "name": "Source anchored",
        "type": "radial",
        "enabled": True,
        "geometry": {
            "center": {"x": 0.25, "y": 0.5},
            "radius": {"x": 0.16, "y": 0.24},
        },
        "feather": 0.08,
        "invert": False,
        "adjustments": {
            "exposure": 1.25,
            "highlights": 0,
            "shadows": 0,
            "temperature": 0,
            "saturation": 0,
        },
    }


class CompositionApiRoundTripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory(prefix="chromora-composition-api-")
        cls.root = Path(cls.temp.name)
        cls._patchers = []
        for name in ("PHOTOS", "DECODED", "THUMBS", "LUTS", "PROJECTS", "OUTPUT", "HANDOFF"):
            path = cls.root / name
            path.mkdir(parents=True, exist_ok=True)
            patcher = patch.object(chromora_server, name, path)
            patcher.start()
            cls._patchers.append(patcher)

        cls.marker_pixels = make_direction_markers()
        cls.photo_id = cls.install_photo(encode_png(cls.marker_pixels), ".png")

        # A neutral field with one off-center red marker makes straighten sign
        # measurable while also revealing any black fill at the image edges.
        straighten_pixels = np.empty((200, 320, 3), dtype=np.uint8)
        straighten_pixels[:] = (92, 112, 132)
        straighten_pixels[38:66, 144:176] = (238, 20, 24)
        cls.straighten_photo_id = cls.install_photo(encode_png(straighten_pixels), ".png")

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
    def install_photo(cls, content: bytes, suffix: str) -> str:
        photo_id = sha256(content).hexdigest() + suffix
        (chromora_server.PHOTOS / photo_id).write_bytes(content)
        return photo_id

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
        connection = HTTPConnection(self.host, self.port, timeout=15)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def photo(self, settings: dict, *, photo_id: str | None = None, name: str = "markers.png") -> dict:
        return {
            "id": photo_id or self.photo_id,
            "name": name,
            "settings": settings,
        }

    def state(self, settings: dict, *, photo_id: str | None = None) -> dict:
        selected_id = photo_id or self.photo_id
        return {
            "photos": [self.photo(settings, photo_id=selected_id)],
            "currentId": selected_id,
            "luts": [],
            "favorites": [],
        }

    def save_project(self, name: str, state: dict):
        return self.request("POST", "/api/project", {"name": name, "state": state})

    def load_project(self, name: str):
        return self.request("GET", "/api/project?name=" + quote(name, safe=""))

    def render_bytes(
        self,
        settings: dict,
        *,
        resolution: str = "full",
        photo_id: str | None = None,
    ) -> bytes:
        status, body, _ = self.request(
            "POST",
            "/api/render",
            {"id": photo_id or self.photo_id, "settings": settings, "resolution": resolution},
        )
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        return body

    def render_rgb(self, settings: dict, *, resolution: str = "full", photo_id: str | None = None):
        with Image.open(BytesIO(self.render_bytes(settings, resolution=resolution, photo_id=photo_id))) as image:
            return np.asarray(image.convert("RGB"), dtype=np.uint8)

    def export_file(self, settings: dict, output_format: str, *, photo_id: str | None = None):
        status, body, _ = self.request(
            "POST",
            "/api/export",
            {
                "id": photo_id or self.photo_id,
                "name": "composition acceptance",
                "settings": settings,
                "format": output_format,
            },
        )
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        output_path = Path(json.loads(body)["file"])
        self.assertTrue(output_path.is_file(), f"导出接口返回的文件不存在：{output_path}")
        return output_path

    @staticmethod
    def decode_tiff(path: Path) -> np.ndarray:
        pixels = tifffile.imread(path)
        if pixels.ndim == 2:
            pixels = np.repeat(pixels[:, :, None], 3, axis=2)
        if pixels.shape[-1] == 4:
            pixels = pixels[:, :, :3]
        if pixels.dtype == np.uint16:
            pixels = np.rint(pixels.astype(np.float64) / 257).astype(np.uint8)
        elif pixels.dtype != np.uint8:
            pixels = np.rint(np.clip(pixels, 0, 1) * 255).astype(np.uint8)
        return pixels

    def assert_visual_match(self, actual: np.ndarray, expected: np.ndarray, message: str):
        self.assertEqual(actual.shape, expected.shape, message + "（尺寸不一致）")
        difference = np.abs(actual.astype(np.int16) - expected.astype(np.int16))
        self.assertLess(float(difference.mean()), 8.0, message + "（平均像素差过大）")
        self.assertLess(float(np.percentile(difference, 95)), 32.0, message + "（主体像素差过大）")

    def test_rotation_and_original_aspect_follow_exif_corrected_direction_markers(self):
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                settings = {
                    "composition": {
                        "crop": None,
                        "aspect": "original",
                        "rotation": rotation,
                        "straighten": 0,
                    }
                }
                actual = self.render_rgb(settings)
                expected = np.rot90(self.marker_pixels, k=-(rotation // 90))
                self.assertEqual(actual.shape, expected.shape,
                                 f"rotation={rotation} 应在 EXIF 校正后旋转整图")
                self.assert_visual_match(actual, expected,
                                         f"rotation={rotation} 的方向标记应保持正确朝向")

        # Orientation 6 means the encoded JPEG is rotated clockwise for display.
        # Composition coordinates must be based on the EXIF-corrected 200x320 image.
        exif = Image.Exif()
        exif[274] = 6
        encoded = BytesIO()
        Image.fromarray(self.marker_pixels, "RGB").save(
            encoded, format="JPEG", quality=100, subsampling=0, exif=exif
        )
        exif_photo_id = self.install_photo(encoded.getvalue(), ".jpg")
        for rotation, expected_size in ((0, (200, 320)), (90, (320, 200))):
            with self.subTest(exif_orientation=6, rotation=rotation):
                result = self.render_rgb(
                    {"composition": {
                        "crop": None, "aspect": "original", "rotation": rotation, "straighten": 0,
                    }},
                    photo_id=exif_photo_id,
                )
                self.assertEqual((result.shape[1], result.shape[0]), expected_size,
                                 "EXIF 校正必须先于 composition.rotation")

    def test_crop_coordinates_and_supported_aspects_match_expected_pixels(self):
        cases = (
            ("1:1", {"x": 0.1875, "y": 0, "width": 0.625, "height": 1}, (60, 0, 260, 200)),
            ("4:5", {"x": 0.25, "y": 0, "width": 0.5, "height": 1}, (80, 0, 240, 200)),
            ("3:2", {"x": 0.03125, "y": 0, "width": 0.9375, "height": 1}, (10, 0, 310, 200)),
            ("16:9", {"x": 0, "y": 0.05, "width": 1, "height": 0.9}, (0, 10, 320, 190)),
        )
        for aspect, crop, (left, top, right, bottom) in cases:
            with self.subTest(aspect=aspect):
                actual = self.render_rgb({"composition": {
                    "crop": crop, "aspect": aspect, "rotation": 0, "straighten": 0,
                }})
                expected = self.marker_pixels[top:bottom, left:right]
                self.assertEqual(actual.shape, expected.shape,
                                 f"{aspect} 裁剪尺寸应与 crop 归一化坐标一致")
                target_ratio = {"1:1": 1, "4:5": 4 / 5, "3:2": 3 / 2, "16:9": 16 / 9}[aspect]
                self.assertAlmostEqual(actual.shape[1] / actual.shape[0], target_ratio, delta=0.015)
                self.assert_visual_match(actual, expected,
                                         f"{aspect} 的裁剪区域应取自 EXIF 校正后的原图坐标")

    def test_crop_rectangle_is_reused_in_the_new_rotated_coordinate_space(self):
        crop = {"x": 0.2, "y": 0.25, "width": 0.6, "height": 0.5}
        before = {"crop": crop, "aspect": "free", "rotation": 0, "straighten": 0}
        before_status, before_body, _ = self.save_project("crop before rotation", self.state({"composition": before}))
        self.assertEqual(before_status, 200, before_body.decode("utf-8", "replace"))
        before_status, before_body, _ = self.load_project("crop before rotation")
        self.assertEqual(before_status, 200, before_body.decode("utf-8", "replace"))
        saved_before = json.loads(before_body)["state"]["photos"][0]["settings"]["composition"]
        self.assertEqual(saved_before["crop"], crop)

        after = {**before, "rotation": 90}
        after_status, after_body, _ = self.save_project("crop after rotation", self.state({"composition": after}))
        self.assertEqual(after_status, 200, after_body.decode("utf-8", "replace"))
        after_status, after_body, _ = self.load_project("crop after rotation")
        self.assertEqual(after_status, 200, after_body.decode("utf-8", "replace"))
        reopened = json.loads(after_body)["state"]["photos"][0]["settings"]
        self.assertEqual(reopened["composition"]["crop"], crop,
                         "切换 rotation 不得改写归一化 crop 矩形")

        rotated = np.rot90(self.marker_pixels, k=-1)
        expected = rotated[80:240, 40:160]
        actual = self.render_rgb(reopened)
        self.assertEqual(actual.shape, expected.shape,
                         "rotation=90 后 crop 必须映射到新的 200x320 旋转后坐标系")
        self.assert_visual_match(actual, expected,
                                 "rotation 应先作用于整图，再应用保留的 crop 矩形")

    def test_straighten_sign_keeps_crop_dimensions_and_never_adds_black_borders(self):
        crop = {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}
        outputs = {}
        for angle in (-7, 7):
            with self.subTest(straighten=angle):
                outputs[angle] = self.render_rgb({"composition": {
                    "crop": crop, "aspect": "free", "rotation": 0, "straighten": angle,
                }}, photo_id=self.straighten_photo_id)
                self.assertEqual(outputs[angle].shape, (160, 256, 3),
                                 "拉直后必须保持 crop 的输出尺寸")
                luminance = outputs[angle].astype(np.float32).mean(axis=2)
                self.assertGreater(float(luminance.min()), 35,
                                   "拉直的边角不得出现黑色填充边")

        def red_marker_centroid_x(image: np.ndarray) -> float:
            marker = (image[:, :, 0] > 160) & (image[:, :, 1] < 75)
            self.assertGreater(int(marker.sum()), 80, "拉直后方向标记应仍可检测")
            return float(np.nonzero(marker)[1].mean())

        clockwise_x = red_marker_centroid_x(outputs[7])
        counterclockwise_x = red_marker_centroid_x(outputs[-7])
        self.assertGreater(clockwise_x, counterclockwise_x + 4,
                           "正拉直角度必须按顺时针方向旋转")

    def test_project_round_trip_preserves_composition_and_render_result(self):
        settings = {
            "exposure": 0.12,
            "composition": {
                "crop": {"x": 0.1, "y": 0.15, "width": 0.8, "height": 0.625},
                "aspect": "4:5",
                "rotation": 90,
                "straighten": -2.5,
            },
            "masks": [radial_mask()],
        }
        state = self.state(settings)
        status, body, _ = self.save_project("composition round trip", state)
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        status, body, _ = self.load_project("composition round trip")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        reopened = json.loads(body)["state"]
        self.assertEqual(reopened, state,
                         "工程往返必须保留 crop、aspect、rotation、straighten 和蒙版参数")
        self.assertEqual(
            self.render_bytes(reopened["photos"][0]["settings"]),
            self.render_bytes(settings),
            "工程重开后的构图渲染必须与保存前一致",
        )

    def test_rotated_fixed_ratio_survives_project_round_trip_and_exact_exports(self):
        odd_pixels = np.full((201, 321, 3), (92, 112, 132), dtype=np.uint8)
        odd_photo_id = self.install_photo(encode_png(odd_pixels), ".png")
        rotated_width, rotated_height = 201, 321
        crop_height = (rotated_width / rotated_height) / (4 / 5)
        composition = {
            "crop": {
                "x": 0,
                "y": (1 - crop_height) / 2,
                "width": 1,
                "height": crop_height,
            },
            "aspect": "4:5",
            "rotation": 90,
            "straighten": 0,
        }
        settings = {"composition": composition}
        project_name = "rotated fixed 4x5"
        status, body, _ = self.save_project(project_name, self.state(settings, photo_id=odd_photo_id))
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        status, body, _ = self.load_project(project_name)
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        reopened = json.loads(body)["state"]["photos"][0]["settings"]
        self.assertEqual(reopened["composition"]["aspect"], "4:5")
        self.assertEqual(reopened["composition"]["rotation"], 90)
        self.assertEqual(reopened["composition"]["crop"], composition["crop"],
                         "保存并重开必须保留重算后的裁剪区域")

        preview = self.render_rgb(reopened, resolution="preview", photo_id=odd_photo_id)
        jpeg_path = self.export_file(reopened, "jpeg", photo_id=odd_photo_id)
        tiff_path = self.export_file(reopened, "tiff", photo_id=odd_photo_id)
        with Image.open(jpeg_path) as image:
            jpeg_size = image.size
        tiff = self.decode_tiff(tiff_path)
        dimensions = (
            ("preview", preview.shape[1], preview.shape[0]),
            ("JPG", jpeg_size[0], jpeg_size[1]),
            ("TIFF", tiff.shape[1], tiff.shape[0]),
        )
        for label, width, height in dimensions:
            with self.subTest(output=label):
                self.assertGreater(width, 0)
                self.assertGreater(height, 0)
                self.assertEqual(width * 5, height * 4,
                                 f"{label} 必须保持精确 4:5 像素尺寸")

    def test_clear_crop_preserves_rotation_and_straighten_while_reset_clears_all(self):
        cropped = {
            "crop": {"x": 0.18, "y": 0.25, "width": 0.64, "height": 0.5},
            "aspect": "4:5",
            "rotation": 90,
            "straighten": 6,
        }
        cleared = {"crop": None, "aspect": "free", "rotation": 90, "straighten": 6}
        reset = dict(DEFAULT_COMPOSITION)

        for name, composition in (("crop active", cropped), ("crop cleared", cleared), ("composition reset", reset)):
            with self.subTest(project=name):
                status, body, _ = self.save_project(name, self.state({"composition": composition}))
                self.assertEqual(status, 200, body.decode("utf-8", "replace"))
                status, body, _ = self.load_project(name)
                self.assertEqual(status, 200, body.decode("utf-8", "replace"))
                reopened = json.loads(body)["state"]["photos"][0]["settings"]["composition"]
                self.assertEqual(reopened, composition,
                                 "清除裁剪与独立重置必须遵守不同的 composition 语义")

        cropped_size = self.render_rgb({"composition": cropped}).shape[:2]
        cleared_image = self.render_rgb({"composition": cleared})
        reset_image = self.render_rgb({"composition": reset})
        self.assertEqual(cropped_size, (160, 128), "裁剪结果应使用 rotation 后坐标系的矩形尺寸")
        self.assertEqual(cleared_image.shape[:2], (320, 200),
                         "清除裁剪仍应保留 90 度旋转，且输出完整旋转后画布")
        self.assertEqual(reset_image.shape[:2], (200, 320),
                         "独立重置构图必须恢复完整原方向画布")

    def test_preview_jpeg_and_tiff_exports_share_the_same_composition(self):
        settings = {"composition": {
            "crop": {"x": 0.125, "y": 0.1, "width": 0.75, "height": 0.8},
            "aspect": "free",
            "rotation": 90,
            "straighten": 3,
        }}
        preview = self.render_rgb(settings, resolution="preview")
        jpeg_path = self.export_file(settings, "jpeg")
        tiff_path = self.export_file(settings, "tiff")
        with Image.open(jpeg_path) as image:
            jpeg = np.asarray(image.convert("RGB"), dtype=np.uint8)
        tiff = self.decode_tiff(tiff_path)

        expected_height, expected_width = 256, 150
        for label, image in (("preview", preview), ("JPG", jpeg), ("TIFF", tiff)):
            with self.subTest(format=label):
                self.assertEqual(image.shape[:2], (expected_height, expected_width),
                                 f"{label} 必须应用 rotation → crop → straighten")
        self.assert_visual_match(jpeg, tiff, "JPG 与 TIFF 必须共享同一构图")
        self.assert_visual_match(preview, tiff, "预览与 TIFF 必须共享同一构图")

    def test_psd_export_uses_the_same_composition_and_aligned_layers(self):
        settings = {"composition": {
            "crop": {"x": 0.125, "y": 0.1, "width": 0.75, "height": 0.8},
            "aspect": "free",
            "rotation": 90,
            "straighten": 3,
        }}
        tiff_path = self.export_file(settings, "tiff")
        psd_path = self.export_file(settings, "psd")

        # Import only after export: the API itself must first prove that PSD
        # export is available, rather than silently skipping this acceptance.
        from psd_tools import PSDImage

        document = PSDImage.open(psd_path)
        expected_size = (150, 256)
        self.assertEqual((document.width, document.height), expected_size,
                         "PSD 画布尺寸必须与当前 composition 相同")
        layer_names = {layer.name for layer in document}
        self.assertTrue({"Original", "Edited"}.issubset(layer_names),
                        "PSD 必须继续包含 Original 与 Edited 图层")
        for layer in document:
            if layer.name in {"Original", "Edited"}:
                self.assertEqual(tuple(layer.bbox), (0, 0, *expected_size),
                                 f"PSD {layer.name} 图层必须与构图画布对齐")
        composite = document.composite()
        self.assertIsNotNone(composite, "PSD 必须可合成预览")
        psd_rgb = np.asarray(composite.convert("RGB"), dtype=np.uint8)
        tiff = self.decode_tiff(tiff_path)
        self.assert_visual_match(psd_rgb, tiff, "PSD 与 TIFF 必须共享同一成片构图")

    def test_clear_and_default_composition_are_backward_compatible_with_legacy_projects(self):
        legacy_settings = {"exposure": 0.2, "contrast": 8, "saturation": -4}
        legacy_state = self.state(legacy_settings)
        project_file = chromora_server.project_path("legacy composition 0.3")
        project_file.write_text(
            json.dumps({
                "name": "legacy composition 0.3",
                "state": legacy_state,
                "updated": "2026-01-01T00:00:00+00:00",
            }, ensure_ascii=False),
            encoding="utf-8",
        )

        status, body, _ = self.load_project("legacy composition 0.3")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        reopened_settings = json.loads(body)["state"]["photos"][0]["settings"]
        self.assertEqual(reopened_settings, legacy_settings,
                         "旧工程打开时不应伪造或改写 composition 参数")
        without_composition = self.render_rgb(reopened_settings)
        explicit_default = self.render_rgb({
            **reopened_settings,
            "composition": dict(DEFAULT_COMPOSITION),
        })
        np.testing.assert_array_equal(
            without_composition,
            explicit_default,
            "旧工程缺少 composition 时必须按中性默认值渲染",
        )

    def test_invalid_composition_is_rejected_by_render_and_project_apis(self):
        valid = dict(DEFAULT_COMPOSITION)
        invalid_compositions = (
            ("composition must be an object", []),
            ("crop x below zero", {**valid, "crop": {"x": -0.01, "y": 0, "width": 0.5, "height": 0.5}}),
            ("crop extends past right edge", {**valid, "crop": {"x": 0.6, "y": 0, "width": 0.5, "height": 0.5}}),
            ("zero crop width", {**valid, "crop": {"x": 0, "y": 0, "width": 0, "height": 0.5}}),
            ("incomplete crop", {**valid, "crop": {"x": 0, "y": 0, "height": 0.5}}),
            ("unsupported aspect", {**valid, "aspect": "2:1"}),
            ("unsupported rotation", {**valid, "rotation": 45}),
            ("boolean rotation", {**valid, "rotation": True}),
            ("straighten above range", {**valid, "straighten": 15.01}),
            ("boolean straighten", {**valid, "straighten": False}),
        )
        for label, composition in invalid_compositions:
            with self.subTest(composition=label):
                status, body, _ = self.request(
                    "POST",
                    "/api/render",
                    {"id": self.photo_id, "settings": {"composition": composition}, "resolution": "full"},
                )
                self.assertEqual(status, 400,
                                 f"{label} 必须被 API 拒绝；实际 HTTP {status}: {body.decode('utf-8', 'replace')}")

        invalid_state = self.state({"composition": {
            **valid,
            "crop": {"x": 0, "y": 0, "width": 0.5, "height": 1.2},
        }})
        status, body, _ = self.save_project("invalid composition", invalid_state)
        self.assertEqual(status, 400,
                         "工程 API 必须拒绝越界 composition；实际 HTTP "
                         f"{status}: {body.decode('utf-8', 'replace')}")

    def test_local_mask_remains_anchored_to_source_pixels_through_rotation_and_crop(self):
        settings_without_composition = {"masks": [radial_mask()]}
        source_render = self.render_rgb(settings_without_composition)
        rotated_source_render = np.rot90(source_render, k=-1)
        crop = {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.8}
        expected = rotated_source_render[32:288, 50:150]

        actual = self.render_rgb({
            "masks": [radial_mask()],
            "composition": {
                "crop": crop,
                "aspect": "free",
                "rotation": 90,
                "straighten": 0,
            },
        })
        self.assertEqual(actual.shape, expected.shape,
                         "蒙版随源图旋转后裁剪，输出尺寸应由旋转后的 crop 决定")
        self.assert_visual_match(actual, expected,
                                 "构图变化不得使蒙版从源图锚定位置漂移")


if __name__ == "__main__":
    unittest.main()
