import unittest
import io
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

import imaging


class CompositionTests(unittest.TestCase):
    def test_missing_composition_is_neutral_and_preserves_legacy_pixels(self):
        source = np.arange(6 * 8 * 3, dtype=np.float32).reshape((6, 8, 3)) / 200
        expected = source.copy()
        result = imaging._apply_composition(source.copy(), imaging.validate_composition(None))
        np.testing.assert_array_equal(result, expected)
        self.assertEqual(
            imaging.validate_composition(None),
            {"crop": None, "aspect": "free", "rotation": 0, "straighten": 0.0},
        )

    def test_crop_coordinates_apply_to_current_rotated_image(self):
        source = np.arange(4 * 6 * 3, dtype=np.float32).reshape((4, 6, 3)) / 100
        composition = imaging.validate_composition({
            "crop": {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5},
            "aspect": "1:1",
            "rotation": 0,
            "straighten": 0,
        })
        result = imaging._apply_composition(source.copy(), composition)
        np.testing.assert_array_equal(result, source[1:3, 1:5])

        rotated = np.rot90(source, k=-1).copy()
        composition["rotation"] = 90
        result_after_rotation = imaging._apply_composition(source.copy(), composition)
        height, width = rotated.shape[:2]
        left, top = int(np.floor(0.25 * width)), int(np.floor(0.25 * height))
        right, bottom = int(np.ceil(0.75 * width)), int(np.ceil(0.75 * height))
        np.testing.assert_array_equal(result_after_rotation, rotated[top:bottom, left:right])

    def test_quarter_turn_orientation(self):
        source = np.arange(3 * 5 * 3, dtype=np.float32).reshape((3, 5, 3)) / 100
        result = imaging._apply_composition(source.copy(), imaging.validate_composition({"rotation": 90}))
        np.testing.assert_array_equal(result, np.rot90(source, k=-1))
        self.assertEqual(result.shape[:2], (5, 3))

    def test_straighten_crops_interpolated_corners_without_black_edges(self):
        source = np.full((120, 160, 3), 0.5, dtype=np.float32)
        result = imaging._apply_composition(source, imaging.validate_composition({"straighten": 6}))
        self.assertEqual(result.shape, source.shape)
        self.assertGreater(float(result.min()), 0.49)
        self.assertLess(float(result.max()), 0.51)

    def test_jpeg_and_tiff_exports_use_the_same_crop_dimensions(self):
        settings = {"composition": {
            "crop": {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5},
            "aspect": "1:1",
            "rotation": 90,
            "straighten": 0,
        }}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "asymmetric.png"
            Image.fromarray(np.full((80, 100, 3), 120, dtype=np.uint8)).save(source)
            jpeg = imaging.render(source, settings, None, "jpeg")
            tiff = imaging.render(source, settings, None, "tiff")
        with Image.open(io.BytesIO(jpeg)) as output_jpeg, Image.open(io.BytesIO(tiff)) as output_tiff:
            self.assertEqual(output_jpeg.size, (40, 50))
            self.assertEqual(output_tiff.size, output_jpeg.size)

    def test_crop_clear_keeps_rotation_and_straighten_but_full_reset_is_neutral(self):
        state = {"crop": {"x": 0.2, "y": 0.2, "width": 0.6, "height": 0.6},
                 "aspect": "4:5", "rotation": 90, "straighten": -2.5}
        state["crop"] = None
        state["aspect"] = "free"
        cleared = imaging.validate_composition(state)
        self.assertIsNone(cleared["crop"])
        self.assertEqual(cleared["aspect"], "free")
        self.assertEqual(cleared["rotation"], 90)
        self.assertEqual(cleared["straighten"], -2.5)
        reset = imaging.validate_composition(None)
        self.assertEqual(reset, {"crop": None, "aspect": "free", "rotation": 0, "straighten": 0.0})

    def test_invalid_composition_is_rejected(self):
        invalid_values = [
            {"crop": {"x": 0.7, "y": 0, "width": 0.4, "height": 1}},
            {"crop": {"x": 0, "y": 0, "width": 0, "height": 1}},
            {"aspect": "2:1"},
            {"rotation": 45},
            {"rotation": True},
            {"straighten": 15.01},
            {"straighten": float("nan")},
        ]
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                imaging.validate_composition(value)


if __name__ == "__main__":
    unittest.main()
