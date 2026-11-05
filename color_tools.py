from __future__ import annotations

from colorsys import hsv_to_rgb
import math

import numpy as np


LUMA = np.array((0.2126, 0.7152, 0.0722), dtype=np.float32)
BANDS = ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")
HUE_CENTERS = (0, 30, 60, 120, 180, 240, 270, 300, 360)
HUE_CHANNEL_OFFSETS = np.array((0, 4, 2), dtype=np.float32)


def _number(settings: dict, key: str, lower: int, upper: int) -> float:
    value = settings.get(key, 0)
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        raise ValueError(f"{key} 的数值无效")
    return min(upper, max(lower, value))


def _curves(settings: dict) -> list[tuple[int | None, list[float], list[float]]]:
    controls = settings.get("curves", {})
    if not isinstance(controls, dict):
        raise ValueError("曲线设置格式无效")
    active = []
    for channel, name in enumerate(("rgb", "red", "green", "blue"), start=-1):
        if name not in controls:
            continue
        points = controls[name]
        if not isinstance(points, list) or not 2 <= len(points) <= 12:
            raise ValueError(f"{name} 曲线需要 2 到 12 个控制点")
        xs, ys = [], []
        for point in points:
            if (not isinstance(point, list) or len(point) != 2 or
                    any(type(value) not in (int, float) or not 0 <= value <= 1 for value in point)):
                raise ValueError(f"{name} 曲线控制点应位于 0 到 1 之间")
            x, y = point
            if xs and x <= xs[-1]:
                raise ValueError(f"{name} 曲线控制点横坐标应依次增大")
            xs.append(x)
            ys.append(y)
        if xs[0] != 0 or xs[-1] != 1:
            raise ValueError(f"{name} 曲线的横坐标应从 0 到 1")
        if xs != ys:
            active.append((None if channel == -1 else channel, xs, ys))
    return active


def _hsl(pixels: np.ndarray, sliders: np.ndarray) -> None:
    low = pixels.min(axis=-1)
    high = pixels.max(axis=-1)
    chroma = high - low
    chromatic = chroma > 1e-6
    if not np.any(chromatic):
        return
    colors = pixels[chromatic]
    chroma = chroma[chromatic]
    lightness = (high[chromatic] + low[chromatic]) * .5

    red, green, blue = colors.T
    lead = np.argmax(colors, axis=1)
    hue = np.where(lead == 0, (green - blue) / chroma,
                   np.where(lead == 1, 2 + (blue - red) / chroma,
                            4 + (red - green) / chroma))
    hue = np.mod(hue * 60, 360)
    hue_delta, sat_delta, lum_delta = (
        np.interp(hue, HUE_CENTERS, channel).astype(np.float32) for channel in sliders
    )
    changed = (hue_delta != 0) | (sat_delta != 0) | (lum_delta != 0)
    if not np.any(changed):
        return
    saturation = np.clip(chroma / np.maximum(1 - np.abs(2 * lightness - 1), 1e-7), 0, 1)
    saturation += sat_delta * np.where(sat_delta > 0, 1 - saturation, saturation)
    lightness += .5 * lum_delta * np.where(lum_delta > 0, 1 - lightness, lightness)
    hue = np.mod(hue + 30 * hue_delta, 360) / 60

    chroma = (1 - np.abs(2 * lightness - 1)) * saturation
    phases = np.mod(hue[:, None] + HUE_CHANNEL_OFFSETS, 6)
    unit_rgb = np.clip(np.abs(phases - 3) - 1, 0, 1)
    colors[changed] = (unit_rgb * chroma[:, None] + (lightness - .5 * chroma)[:, None])[changed]
    pixels[chromatic] = colors


def _grade(pixels: np.ndarray, wheels: np.ndarray, balance: float) -> None:
    luminance = np.clip(pixels @ LUMA, 0, 1)
    amount = 4 * luminance * (1 - luminance)
    # Positive balance expands highlights into the midtones.
    tone = np.clip(luminance + .22 * balance * amount, 0, 1)
    shadows = np.maximum(1 - 2 * tone, 0)
    highlights = np.maximum(2 * tone - 1, 0)
    shadows *= shadows * (3 - 2 * shadows)
    highlights *= highlights * (3 - 2 * highlights)
    midtones = 1 - shadows - highlights
    pixels += amount[..., None] * (
        shadows[..., None] * wheels[0] + midtones[..., None] * wheels[1] + highlights[..., None] * wheels[2]
    )


def apply_color_tools(rgb: np.ndarray, settings: dict) -> None:
    """Apply composite and RGB curves, HSL, and tonal grading to float sRGB pixels in place."""
    curves = _curves(settings)
    sliders = np.array([
        [_number(settings, band + suffix, -100, 100) / 100 for band in (*BANDS, BANDS[0])]
        for suffix in ("Hue", "Sat", "Lum")
    ], dtype=np.float32)
    wheels = []
    for tone in ("shadow", "midtone", "highlight"):
        hue = _number(settings, tone + "Hue", 0, 360) / 360
        saturation = _number(settings, tone + "Sat", 0, 100) / 100
        color = np.array(hsv_to_rgb(hue, 1, 1), dtype=np.float32)
        wheels.append((color - color @ LUMA) * (.24 * saturation))
    wheels = np.asarray(wheels)
    balance = _number(settings, "colorBalance", -100, 100) / 100
    has_hsl = np.any(sliders)
    has_grading = np.any(wheels)
    if not (curves or has_hsl or has_grading):
        return

    rows = max(1, 120_000 // rgb.shape[1])
    for start in range(0, len(rgb), rows):
        pixels = rgb[start:start + rows]
        for channel, xs, ys in curves:
            target = pixels if channel is None else pixels[..., channel]
            target[:] = np.interp(target, xs, ys)
        if has_hsl:
            _hsl(pixels, sliders)
        if has_grading:
            _grade(pixels, wheels, balance)
        np.clip(pixels, 0, 1, out=pixels)

