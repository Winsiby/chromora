import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

import imaging
import server


def mask(kind="linear", **overrides):
    value = {
        "id": "mask-1",
        "name": "Test mask",
        "type": kind,
        "enabled": True,
        "geometry": ({
            "start": {"x": 0.5, "y": 0.25},
            "end": {"x": 0.5, "y": 0.75},
        } if kind == "linear" else {
            "center": {"x": 0.5, "y": 0.5},
            "radius": {"x": 0.25, "y": 0.25},
        }),
        "feather": 0,
        "invert": False,
        "adjustments": {
            "exposure": 0,
            "highlights": 0,
            "shadows": 0,
            "temperature": 0,
            "saturation": 0,
        },
    }
    value.update(overrides)
    return value


class MaskWeightTests(unittest.TestCase):
    def test_linear_direction_and_invert(self):
        data = imaging.validate_masks([mask()])[0]
        weights = imaging._mask_weight(data, 21, 21)
        self.assertGreater(weights[5, 10], 0.98)
        self.assertAlmostEqual(float(weights[10, 10]), 0.5, delta=0.08)
        self.assertLess(weights[15, 10], 0.02)

        inverted = imaging.validate_masks([mask(invert=True)])[0]
        inverse_weights = imaging._mask_weight(inverted, 21, 21)
        np.testing.assert_allclose(inverse_weights, 1 - weights, atol=1e-6)

    def test_radial_hard_edge_and_feather(self):
        hard = imaging.validate_masks([mask("radial")])[0]
        hard_weights = imaging._mask_weight(hard, 101, 101)
        self.assertEqual(float(hard_weights[50, 50]), 1.0)
        self.assertEqual(float(hard_weights[50, 80]), 0.0)

        soft = imaging.validate_masks([mask("radial", feather=0.1)])[0]
        soft_weights = imaging._mask_weight(soft, 101, 101)
        self.assertGreater(soft_weights[50, 68], soft_weights[50, 71])
        self.assertGreater(soft_weights[50, 71], 0)
        self.assertLess(soft_weights[50, 71], 1)
        self.assertEqual(float(soft_weights[50, 80]), 0.0)

    def test_local_adjustments_are_spatially_limited(self):
        settings = mask(
            "radial",
            adjustments={"exposure": 1, "highlights": 0, "shadows": 0,
                         "temperature": 0, "saturation": 0},
        )
        normalized = imaging.validate_masks([settings])
        image = np.full((64, 64, 3), 0.2, dtype=np.float32)
        imaging._apply_masks(image, normalized)
        self.assertGreater(float(image[32, 32, 0]), 0.2)
        np.testing.assert_allclose(image[32, 0], [0.2, 0.2, 0.2], atol=1e-6)

    def test_all_five_local_adjustments_change_the_selected_pixels(self):
        sample = np.random.default_rng(3).uniform(0.15, 0.85, (40, 40, 3)).astype(np.float32)
        for key, amount in (("exposure", 1), ("highlights", 40), ("shadows", 40),
                            ("temperature", 50), ("saturation", 50)):
            settings = mask("radial", geometry={
                "center": {"x": 0.5, "y": 0.5},
                "radius": {"x": 0.4, "y": 0.4},
            }, adjustments={key: amount})
            image = sample.copy()
            imaging._apply_masks(image, imaging.validate_masks([settings]))
            self.assertGreater(float(np.max(np.abs(image[20, 20] - sample[20, 20]))), 1e-5, key)

    def test_multiple_named_masks_apply_independently(self):
        first = mask("radial", adjustments={"exposure": 0.5})
        second = mask("linear", id="mask-2", name="Second", adjustments={"temperature": -50})
        normalized = imaging.validate_masks([first, second])
        self.assertEqual([item["name"] for item in normalized], ["Test mask", "Second"])
        image = np.full((32, 32, 3), 0.35, dtype=np.float32)
        imaging._apply_masks(image, normalized)
        self.assertFalse(np.array_equal(image, np.full((32, 32, 3), 0.35, dtype=np.float32)))

    def test_disabled_and_empty_masks_leave_pixels_unchanged(self):
        original = np.full((32, 32, 3), 0.25, dtype=np.float32)
        image = original.copy()
        normalized = imaging.validate_masks([mask(enabled=False)])
        imaging._apply_masks(image, normalized)
        np.testing.assert_array_equal(image, original)
        imaging._apply_masks(image, imaging.validate_masks([]))
        np.testing.assert_array_equal(image, original)

    def test_neutral_legacy_render_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.fromarray(np.full((24, 32, 3), 96, dtype=np.uint8)).save(source)
            old_result = imaging.render(source, {}, None, "jpeg", preview=True)
            new_result = imaging.render(source, {"masks": []}, None, "jpeg", preview=True)
        self.assertEqual(new_result, old_result)

    def test_invalid_and_degenerate_masks_are_rejected(self):
        invalid = [
            mask("linear", geometry={"start": {"x": 0.5, "y": 0.5},
                                     "end": {"x": 0.5, "y": 0.5}}),
            mask("linear", geometry={"start": {"x": 1.1, "y": 0.5},
                                     "end": {"x": 0.5, "y": 0.7}}),
            mask("radial", geometry={"center": {"x": 0.5, "y": 0.5},
                                     "radius": {"x": 0, "y": 0.2}}),
            mask("radial", feather=float("nan")),
            mask("radial", adjustments={"exposure": "bright"}),
        ]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(ValueError):
                imaging.validate_masks([item])

        with self.assertRaises(ValueError):
            imaging.validate_masks([mask(), mask()])

    def test_project_validation_accepts_legacy_empty_masks_and_rejects_bad_masks(self):
        valid_id = "a" * 64 + ".jpg"
        legacy = {"photos": [{"id": valid_id, "settings": {}}]}
        server.validate_project_state(legacy)

        invalid_mask_project = {"photos": [{
            "id": valid_id,
            "settings": {"masks": [mask("radial", geometry={
                "center": {"x": 0.5, "y": 0.5},
                "radius": {"x": 0, "y": 0},
            })]},
        }]}
        with self.assertRaises(ValueError):
            server.validate_project_state(invalid_mask_project)


if __name__ == "__main__":
    unittest.main()
