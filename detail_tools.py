"""Luminance and detail controls shared by preview and full renders."""

import math

import numpy as np


LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
MAGENTA = np.array([1, -(LUMA[0] + LUMA[2]) / LUMA[1], 1], dtype=np.float32)
STRIPE_ROWS = 192


def _amount(settings, key, minimum=-100):
    try:
        value = float(settings.get(key, 0))
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return min(100, max(minimum, value)) / 100 if math.isfinite(value) else 0.0


def _shift_luma(pixels, luminance, shift):
    """Reach a new luminance by mixing toward black or white, retaining hue."""
    positive = shift >= 0
    headroom = np.where(positive, 1 - luminance, luminance)
    mix = np.minimum(np.abs(shift) / np.maximum(headroom, 1e-6), 1)
    pixels += mix[..., None] * (positive[..., None] - pixels)


def _point_edits(rgb, tint, whites, blacks, vibrance, dehaze):
    if dehaze:
        # Sample across the frame so a few bright specular pixels cannot set the white point.
        step = max(1, math.ceil(max(rgb.shape[:2]) / 256))
        sample = rgb[::step, ::step]
        airlight = max(.85, float(np.quantile(sample @ LUMA, .96)))
        veil = float(np.clip(np.quantile(np.min(sample, axis=-1), .12) * .9 + .04, .05, .36))
        if dehaze > 0:
            attenuation = veil * dehaze
            haze_shift = -attenuation / (1 - attenuation)
        else:
            haze_shift = -.20 * dehaze

    for start in range(0, len(rgb), STRIPE_ROWS):
        pixels = rgb[start:start + STRIPE_ROWS]
        luminance = pixels @ LUMA
        if tint:
            weight = luminance * (1 - luminance)
            pixels += (tint * .58 * weight[..., None]) * MAGENTA
            np.clip(pixels, 0, 1, out=pixels)
            luminance = pixels @ LUMA

        if whites or blacks or dehaze:
            shift = np.zeros_like(luminance)
            if whites:
                upper = np.maximum((luminance - .46) / .54, 0)
                shift += whites * upper ** 2 * ((1 - luminance) * .8 if whites > 0 else .23)
            if blacks:
                lower = np.maximum((.54 - luminance) / .54, 0)
                shift += blacks * lower ** 2 * (.23 if blacks > 0 else luminance * .8)
            if dehaze:
                shift += haze_shift * np.maximum(airlight - luminance, 0)
            _shift_luma(pixels, luminance, shift)
            luminance = pixels @ LUMA

        if vibrance:
            high = np.max(pixels, axis=-1)
            low = np.min(pixels, axis=-1)
            saturation = (high - low) / np.maximum(high, 1e-6)
            weighting = (1 - saturation) ** 1.5 if vibrance > 0 else .5 + .5 * saturation
            change = vibrance * .86 * weighting
            if vibrance > 0:
                room_up = (1 - luminance) / np.maximum(high - luminance, 1e-6)
                room_down = luminance / np.maximum(luminance - low, 1e-6)
                change = np.minimum(change, np.maximum(np.minimum(room_up, room_down) - 1, 0))
            pixels += change[..., None] * (pixels - luminance[..., None])


def _detail_edits(rgb, sharpening, denoise):
    luminance = rgb @ LUMA
    height, width = luminance.shape
    # Scale the radius with image dimensions to keep preview and full effects comparable.
    sigma = max(.65, min(3.4, max(height, width) / 1800))
    radius = math.ceil(2.4 * sigma)
    offsets = np.arange(-radius, radius + 1, dtype=np.float32)
    weights = np.exp(-.5 * (offsets / sigma) ** 2)
    weights /= weights.sum()

    for start in range(0, height, STRIPE_ROWS):
        stop = min(start + STRIPE_ROWS, height)
        rows = np.clip(np.arange(start - radius, stop + radius), 0, height - 1)
        padded = np.pad(luminance[rows], ((0, 0), (radius, radius)), mode="edge")
        horizontal = np.zeros((len(rows), width), dtype=np.float32)
        for offset, weight in enumerate(weights):
            horizontal += padded[:, offset:offset + width] * weight
        smoothed = np.zeros((stop - start, width), dtype=np.float32)
        for offset, weight in enumerate(weights):
            smoothed += horizontal[offset:offset + stop - start] * weight

        original = luminance[start:stop]
        detail = original - smoothed
        magnitude = np.abs(detail)
        # Reduce faint detail preferentially, while protecting high-contrast edges.
        suppression = denoise * .91 * (1 - np.clip((magnitude - .025) / .075, 0, 1)) ** 2
        emphasis = sharpening * np.clip((magnitude - .003) / .03, 0, 1) * (1 - suppression)
        sharpened = np.clip(detail * emphasis, -.075 * sharpening, .075 * sharpening)
        _shift_luma(rgb[start:stop], original, sharpened - detail * suppression)


def apply_detail_tools(rgb, settings, preview: bool = False) -> None:
    """Adjust a float32 sRGB image in place; radius follows size in either render mode."""
    tint, whites, blacks, vibrance, dehaze = (
        _amount(settings, key) for key in ("tint", "whites", "blacks", "vibrance", "dehaze")
    )
    sharpening = _amount(settings, "sharpening", 0)
    denoise = _amount(settings, "denoise", 0)
    if any((tint, whites, blacks, vibrance, dehaze)):
        _point_edits(rgb, tint, whites, blacks, vibrance, dehaze)
    if sharpening or denoise:
        _detail_edits(rgb, sharpening, denoise)
    if any((tint, whites, blacks, vibrance, dehaze, sharpening, denoise)):
        np.clip(rgb, 0, 1, out=rgb)

