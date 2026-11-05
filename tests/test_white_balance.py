import unittest

import numpy as np

import imaging
from detail_tools import apply_detail_tools


class WhiteBalanceTests(unittest.TestCase):
    def image(self, sample, height=21, width=21):
        return np.tile(np.asarray(sample, dtype=np.float32), (height, width, 1))

    def test_neutral_patch_returns_zero_absolute_targets(self):
        result = imaging.estimate_white_balance(self.image([0.5, 0.5, 0.5]), 0.5, 0.5)
        self.assertEqual(result, {"temperature": 0, "tint": 0})

    def test_warm_or_green_cast_returns_targets_that_reduce_channel_spread(self):
        for sample in ([0.57, 0.5, 0.43], [0.45, 0.5, 0.4]):
            with self.subTest(sample=sample):
                result = imaging.estimate_white_balance(self.image(sample), 0.5, 0.5)
                pixels = self.image(sample)
                imaging._adjust(pixels, {"temperature": result["temperature"]})
                apply_detail_tools(pixels, {"tint": result["tint"]}, False)
                balanced = np.median(pixels[8:13, 8:13], axis=(0, 1))
                original_spread = max(sample) - min(sample)
                balanced_spread = float(balanced.max() - balanced.min())
                self.assertLess(balanced_spread, original_spread * 0.2)
                self.assertTrue(-100 <= result["temperature"] <= 100)
                self.assertTrue(-100 <= result["tint"] <= 100)

    def test_coordinates_select_correct_source_preview_patch(self):
        pixels = np.empty((20, 30, 3), dtype=np.float32)
        pixels[:] = [0.35, 0.4, 0.45]
        pixels[0:6, 0:6] = [0.5, 0.5, 0.5]
        pixels[10:18, 20:29] = [0.57, 0.5, 0.43]
        self.assertEqual(imaging.estimate_white_balance(pixels, 0.08, 0.08),
                         {"temperature": 0, "tint": 0})
        warm = imaging.estimate_white_balance(pixels, 0.86, 0.7)
        self.assertLess(warm["temperature"], -80)

    def test_edge_window_clips_to_image_bounds(self):
        pixels = self.image([0.5, 0.5, 0.5], height=3, width=4)
        self.assertEqual(imaging.estimate_white_balance(pixels, 0, 0),
                         {"temperature": 0, "tint": 0})
        self.assertEqual(imaging.estimate_white_balance(pixels, 1, 1),
                         {"temperature": 0, "tint": 0})

    def test_clipped_dark_and_saturated_samples_are_rejected(self):
        for sample in ([5 / 255, 0.4, 0.45], [250 / 255, 0.8, 0.75],
                       [0.8, 0.2, 0.2], [0.019, 0.019, 0.019]):
            with self.subTest(sample=sample), self.assertRaisesRegex(ValueError, "取样区域"):
                imaging.estimate_white_balance(self.image(sample), 0.5, 0.5)

    def test_invalid_coordinates_and_empty_images_are_rejected(self):
        pixels = self.image([0.5, 0.5, 0.5])
        for point in ((-0.01, 0.5), (0.5, 1.01), (True, 0.5), (0.5, float("nan"))):
            with self.subTest(point=point), self.assertRaises(ValueError):
                imaging.estimate_white_balance(pixels, *point)
        with self.assertRaisesRegex(ValueError, "图像为空"):
            imaging.estimate_white_balance(np.empty((0, 2, 3), dtype=np.float32), 0.5, 0.5)


if __name__ == "__main__":
    unittest.main()
